// Laboratorio · habla del video: Whisper (WaveSpeed) pasa lo que dice el narrador a texto con tiempos, y acá se parte en
// CABEZALES de un segundo: una línea por segundo del video con las palabras que empiezan a decirse en ese segundo.
// Los agentes de Motion Design y de Context Lab la reciben en el pedido para decidir EN QUÉ MOMENTO entra cada animación.
//
// Formato real de la salida de wavespeed-ai/openai-whisper-with-video con enable_timestamps (medido con una llamada de prueba):
//   outputs[0] = { duration, language, language_probability, text, srt,
//                  text_details: [{ start, end, text, words: [{ word, start, end, probability }] }] }   (tiempos en segundos)
import { FPS } from './runtime.js';

export const WHISPER_MODEL = process.env.LAB_WHISPER_MODEL || 'wavespeed-ai/openai-whisper-with-video';
// US$ por segundo de video con tiempos por palabra (orientativo: WaveSpeed lista $0.002/s; sin tiempos $0.001/s).
export const WHISPER_COST_PER_SECOND = Number(process.env.LAB_WHISPER_COST_PER_SECOND ?? 0.002);
export const MAX_TRANSCRIBE_SECONDS = 600; // Whisper en WaveSpeed recorta lo que pase de 10 minutos
export const MAX_VIDEO_BYTES = 300 * 1024 * 1024;
const MAX_HEADS = MAX_TRANSCRIBE_SECONDS + 1;
const MAX_HEAD_CHARS = 400;
const MAX_BLOCK_CHARS = 24000;
// Una pausa de al menos este tiempo (en cuadros) entre el inicio del segundo y la primera palabra se anota aparte.
const OFFSET_FRAMES = 6;

const num = (x, fallback = 0) => (Number.isFinite(Number(x)) ? Number(x) : fallback);
const clean = (w) => String(w ?? '').replace(/\s+/g, ' ').trim();

// Las palabras con su tiempo, de la salida de Whisper. Si el modelo no trajo palabras (solo tramos),
// reparte las palabras de cada tramo en partes iguales dentro de él.
export function wordsOf(output) {
  const out = [];
  for (const seg of Array.isArray(output?.text_details) ? output.text_details : []) {
    const words = Array.isArray(seg?.words) ? seg.words : [];
    if (words.length) {
      for (const w of words) {
        const word = clean(w.word);
        if (word) out.push({ word, start: num(w.start), end: num(w.end, num(w.start)) });
      }
      continue;
    }
    const list = clean(seg?.text).split(' ').filter(Boolean);
    const start = num(seg?.start);
    const span = Math.max(0, num(seg?.end, start) - start);
    list.forEach((word, i) => out.push({ word, start: start + (span * i) / list.length, end: start + (span * (i + 1)) / list.length }));
  }
  return out.sort((a, b) => a.start - b.start);
}

// Un cabezal por segundo: { t, text, at } — `at` es el segundo exacto (con decimales) en que arranca la primera palabra.
// Cada palabra va al segundo en que EMPIEZA a decirse. Los segundos sin habla quedan con text ''.
export function buildHeads(words, duration) {
  const seconds = Math.min(MAX_HEADS, Math.max(1, Math.ceil(num(duration, words.at(-1)?.end ?? 1) - 1e-6)));
  const heads = Array.from({ length: seconds }, (_, t) => ({ t, words: [], at: null }));
  for (const w of words) {
    const head = heads[Math.min(seconds - 1, Math.max(0, Math.floor(w.start + 1e-6)))];
    head.words.push(w.word);
    head.at ??= w.start;
  }
  return heads.map((h) => ({ t: h.t, text: h.words.join(' '), at: h.at === null ? null : Math.round(h.at * 100) / 100 }));
}

// Lo que el navegador guarda y reenvía en cada ejecución (el servidor no guarda estado): solo los cabezales.
export function parseTranscript(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.heads)) return null;
  const heads = raw.heads.slice(0, MAX_HEADS).map((h, i) => ({
    t: Number.isInteger(h?.t) && h.t >= 0 ? h.t : i,
    text: clean(h?.text).slice(0, MAX_HEAD_CHARS),
    at: h?.at === null || h?.at === undefined || !Number.isFinite(Number(h.at)) ? null : Math.max(0, Number(h.at)),
  }));
  if (!heads.some((h) => h.text)) return null;
  return { heads, language: clean(raw.language).slice(0, 12), duration: Math.max(0, num(raw.duration)) };
}

const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

// La sección del pedido. `zones`: las de zonesFor() (en cuadros) para marcar qué segundos caen dentro de cada una.
export function transcriptBlock(transcript, zones = []) {
  if (!transcript?.heads?.length) return '';
  const inZone = (t) => zones.filter((z) => z.from < (t + 1) * FPS && z.from + z.durationInFrames > t * FPS).map((z) => z.id);
  const lines = [];
  let silence = null; // { from, to, tags }
  const flush = () => {
    if (!silence) return;
    lines.push(`${silence.from === silence.to ? mmss(silence.from) : `${mmss(silence.from)}–${mmss(silence.to)}`} · frame ${silence.from * FPS}${silence.tags.length ? ` · [${silence.tags.join(' ')}]` : ''} · (no speech)`);
    silence = null;
  };
  for (const h of transcript.heads) {
    const tags = inZone(h.t);
    if (!h.text) {
      // Los segundos de silencio seguidos y de la misma zona se juntan en una línea.
      if (silence && silence.tags.join() === tags.join()) silence.to = h.t;
      else { flush(); silence = { from: h.t, to: h.t, tags }; }
      continue;
    }
    flush();
    const frame = h.t * FPS;
    const late = h.at !== null && Math.round(h.at * FPS) - frame >= OFFSET_FRAMES ? ` (speech starts at frame ${Math.round(h.at * FPS)})` : '';
    lines.push(`${mmss(h.t)} · frame ${frame}${late}${tags.length ? ` · [${tags.join(' ')}]` : ''} · ${h.text}`);
  }
  flush();
  let body = lines.join('\n');
  if (body.length > MAX_BLOCK_CHARS) body = `${body.slice(0, MAX_BLOCK_CHARS).replace(/\n[^\n]*$/, '')}\n(… transcript continues; truncated due to length)`;
  return `# Video speech (Whisper transcript, one entry per second${transcript.language ? `, language: ${transcript.language}` : ''})
Each line represents one second of the video: “m:ss · frame N · [intersecting zones] · words starting during that second”. Frame numbers use the same ${FPS} fps as the zones and component. Use the person's speech to decide WHEN an animation should enter: a title, object, or effect should appear when its subject is mentioned or explained, not too early or late. If a line says “speech starts at frame N”, the word begins there, not at the start of the second. Draw nothing outside the zones; use the transcript for context and synchronization.
${body}`;
}

// Modo demo: un guion de ejemplo repartido por el video (determinista, con algún silencio).
const DEMO_PHRASES = ['hoy', 'les', 'quiero', 'contar', 'cómo', 'armamos', 'este', 'proyecto', 'desde', 'cero', 'primero', 'elegimos', 'el', 'color', 'y', 'después', 'el', 'logo', 'al', 'final', 'todo', 'cobra', 'vida'];
export function demoOutput(duration) {
  const seconds = Math.max(1, Math.ceil(duration));
  const words = [];
  let n = 0;
  for (let s = 0; s < seconds; s++) {
    if (s % 5 === 4) continue; // un segundo de silencio cada cinco
    for (let i = 0; i < 3; i++) {
      const start = s + i * 0.3;
      words.push({ word: DEMO_PHRASES[n++ % DEMO_PHRASES.length], start, end: start + 0.25, probability: 0.99 });
    }
  }
  const text = words.map((w) => w.word).join(' ');
  return { duration, language: 'es', language_probability: 1, text, text_details: [{ start: words[0]?.start ?? 0, end: words.at(-1)?.end ?? 0, text, words }] };
}

// Del resultado de Whisper a lo que usa la app.
export function transcriptFrom(output, duration) {
  const words = wordsOf(output);
  const seconds = Math.min(MAX_TRANSCRIBE_SECONDS, num(duration, num(output?.duration)));
  const heads = buildHeads(words.filter((w) => w.start < MAX_TRANSCRIBE_SECONDS), seconds);
  return { language: clean(output?.language), duration: seconds, text: clean(output?.text), heads, words: words.length };
}

// Sube el video, corre Whisper y devuelve los cabezales + el costo. `ws`: createWaveSpeed (o el de demo).
export async function transcribeVideo({ ws, mock = false, buffer, type, name, duration, language = 'auto', signal }) {
  const seconds = Math.min(MAX_TRANSCRIBE_SECONDS, Math.max(0.1, num(duration, 1)));
  let output;
  if (mock) output = demoOutput(seconds);
  else {
    const video = await ws.uploadBuffer(buffer, type, name || 'clip.mp4', signal);
    const res = await ws.transcribe({ model: WHISPER_MODEL, body: { video, language, task: 'transcribe', enable_timestamps: true }, signal });
    output = res.output;
    if (!output || typeof output !== 'object') throw new Error('Whisper no devolvió la transcripción con tiempos.');
  }
  const transcript = transcriptFrom(output, duration);
  return { ...transcript, truncated: num(duration) > MAX_TRANSCRIBE_SECONDS, cost: mock ? 0 : Math.round(seconds * WHISPER_COST_PER_SECOND * 1e4) / 1e4, model: mock ? 'demo' : WHISPER_MODEL };
}
