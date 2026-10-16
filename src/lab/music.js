// Laboratorio · música de fondo. El mismo modelo que recorta los clips escucha el video (transcripción) y lo mira (cuadros
// repartidos a lo largo del video) y decide qué música va debajo: uno o varios tramos («cues»), cada uno con el clima de
// lo que pasa ahí. Después cada tramo se genera con ElevenLabs Sound Effects v2 en WaveSpeed.
//   cues { id, start, end, mood, prompt (inglés, ≤ 450 caracteres), volume, seconds, loop, url }
// ElevenLabs genera hasta 22 s por pedido: un tramo más largo se pide como loop sin cortes y se repite en la mezcla.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { planTranscript } from './plan.js';

export const MUSIC_MODEL = process.env.LAB_MUSIC_MODEL || 'elevenlabs/sound-effects-v2';
export const MUSIC_PROMPT_MAX = 450; // límite del modelo
export const MUSIC_MAX_SECONDS = 22; // lo más largo que genera por pedido
export const MIN_CUE_SECONDS = 4;
export const MAX_MUSIC_CUES = 6;
export const MAX_MUSIC_FRAMES = 10;
export const MUSIC_COST_PER_SECOND = Number(process.env.LAB_MUSIC_COST ?? 0.0022);
export const DEFAULT_MUSIC_VOLUME = 0.25; // debajo de la voz

const num = (x, fallback = NaN) => (x === null || x === '' || !Number.isFinite(Number(x)) ? fallback : Number(x));
const r2 = (x) => Math.round(x * 100) / 100;
const clean = (s, max) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

// El prompt que va a ElevenLabs: siempre instrumental y de fondo, cortado al límite del modelo sin partir palabras.
export function musicPrompt(text) {
  let p = clean(text, 2000);
  if (!/instrumental/i.test(p)) p = `Instrumental background music, ${p}`;
  if (!/no vocals/i.test(p)) p = `${p.replace(/[.,;\s]+$/, '')}. No vocals.`;
  if (p.length <= MUSIC_PROMPT_MAX) return p;
  const cut = p.slice(0, MUSIC_PROMPT_MAX - ' No vocals.'.length);
  return `${cut.slice(0, cut.lastIndexOf(' ')).replace(/[.,;\s]+$/, '')}. No vocals.`;
}

// frames: [{ t, url }] cuadros repartidos en el video (data URLs que saca el navegador).
export function musicMessages({ video, brief = {}, transcript, frames = [], maxCues = MAX_MUSIC_CUES }) {
  const system = `Sos director musical de video. Te dan lo que se dice en un video (transcripción con el segundo en que arranca cada tramo) y cuadros del video, y decidís la MÚSICA DE FONDO que va debajo de la voz.

Cómo trabajar:
1. Primero entendé el video: de qué habla, quién habla, en qué tono (serio, triste, tenso, aterrador, inspirador, divertido, íntimo, enérgico…) y qué se ve (lugar, luz, colores, ritmo de la imagen). El tono lo dan el diálogo Y las imágenes juntos.
2. La música tiene que acompañar ese tono. Nunca contradigas el contenido: si el video es aterrador, triste o serio, nada alegre ni gracioso; si es divertido, nada solemne ni oscuro. Ante la duda, sobria y neutra.
3. Dividí el video en tramos de música ("cues") solo donde el tono cambia de verdad (por ejemplo: arranca tenso y termina esperanzador). Un video de un solo tono lleva UN tramo que lo cubre entero. Máximo ${maxCues} tramos. Cada tramo dura al menos ${MIN_CUE_SECONDS} s, no se superponen y entre los dos cubren lo que necesita música (podés dejar sin música un tramo si queda mejor en silencio).
4. Para cada tramo escribí "prompt": la descripción para un generador de audio, EN INGLÉS, de hasta ${MUSIC_PROMPT_MAX} caracteres: género, instrumentos, tempo (BPM), clima y energía. Siempre instrumental, sin voces, como música de fondo que no tape a quien habla. No nombres artistas ni canciones.
5. "volume" de 0.05 a 0.6: qué tan fuerte va debajo de la voz (con mucho habla, bajo: 0.15–0.3; sin habla, puede subir).

Respondé SOLO con un objeto JSON, sin texto antes ni después ni bloques de código:
{"tono":"una frase con el tono del video","cues":[{"start":0,"end":18.5,"mood":"tenso, oscuro","prompt":"Instrumental background music, dark ambient tension, low drones, slow pulsing synth bass, sparse piano notes, 70 BPM, ominous and suspenseful, no vocals","volume":0.25}],"nota":""}`;
  const parts = [
    { type: 'text', text: [
      `# Video\n${video.name || 'video'} · ${r2(video.duration)} s de duración.`,
      brief.context ? `# Contexto del video\n${brief.context}` : '',
      brief.instructions ? `# Qué busca el humano\n${brief.instructions}` : '',
      `# Transcripción (segundo del video · desde qué segundo exacto se dice · lo que se dice)\n${transcript?.heads?.length ? planTranscript(transcript.heads) : '(sin habla)'}`,
      frames.length ? `# Cuadros del video (${frames.length}, en orden)` : '',
    ].filter(Boolean).join('\n\n') },
  ];
  for (const f of frames.slice(0, MAX_MUSIC_FRAMES)) parts.push({ type: 'text', text: `${mmss(f.t)} (${r2(f.t)} s)` }, { type: 'image_url', image_url: { url: f.url } });
  return [{ role: 'system', content: system }, { role: 'user', content: parts }];
}

// Ordena y limpia: tramos dentro del video, de al menos MIN_CUE_SECONDS, sin superponerse, con prompt válido.
export function parseMusic(text, { duration, maxCues = MAX_MUSIC_CUES }) {
  const raw = String(text || '');
  let data;
  try { data = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)); } catch { throw new Error('la respuesta no es un JSON válido (se esperaba {"cues":[…]})'); }
  const list = Array.isArray(data?.cues) ? data.cues : null;
  if (!list) throw new Error('falta la lista "cues" en el JSON');
  const cues = [];
  for (const c of list) {
    let start = Math.min(Math.max(0, num(c?.start, 0)), duration);
    let end = Math.min(Math.max(0, num(c?.end, duration)), duration);
    if (end - start < MIN_CUE_SECONDS) { end = Math.min(duration, start + MIN_CUE_SECONDS); start = Math.max(0, end - MIN_CUE_SECONDS); }
    if (end - start < Math.min(MIN_CUE_SECONDS, duration) - 0.01) continue;
    const prompt = clean(c?.prompt, 2000);
    if (!prompt) continue;
    const volume = Math.min(0.6, Math.max(0.05, num(c?.volume, DEFAULT_MUSIC_VOLUME)));
    cues.push({ start: r2(start), end: r2(end), mood: clean(c?.mood, 80), prompt: musicPrompt(prompt), volume: r2(volume) });
  }
  cues.sort((a, b) => a.start - b.start);
  // Sin superposiciones: si uno pisa al anterior, empieza donde termina el anterior (si le queda largo); si no, se descarta.
  const out = [];
  for (const c of cues) {
    const prev = out.at(-1);
    if (prev && c.start < prev.end) {
      if (c.end - prev.end < MIN_CUE_SECONDS) continue;
      c.start = prev.end;
    }
    out.push(c);
  }
  return {
    cues: out.slice(0, maxCues).map((c, i) => ({ id: `M${i + 1}`, ...c })),
    tone: clean(data?.tono ?? data?.tone, 200),
    note: clean(data?.nota ?? data?.note, 400),
  };
}

// Lo que se le pide a ElevenLabs por tramo: hasta 22 s; si el tramo es más largo, un loop sin cortes que se repite.
export const cueRequest = (cue) => {
  const len = cue.end - cue.start;
  const loop = len > MUSIC_MAX_SECONDS;
  return { seconds: r2(Math.max(0.5, Math.min(MUSIC_MAX_SECONDS, len))), loop };
};
export const musicBody = ({ prompt, seconds, loop }) => ({ prompt, duration: seconds, loop, prompt_influence: 0.5 });

// Una llamada al modelo (con una corrección si no devolvió algo usable).
export async function planMusic({ llm, model, signal, video, brief, transcript, frames, maxCues = MAX_MUSIC_CUES, onRetry }) {
  const messages = musicMessages({ video, brief, transcript, frames, maxCues });
  let cost = 0;
  let tokens = 0;
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await llm({ step: 'lab-music', model, messages, signal, meta: { lab: true, music: true, model }, temperature: 0.4, onRetry });
    cost += res.usage?.cost || 0;
    tokens += res.usage?.total_tokens || 0;
    try {
      const out = parseMusic(res.text, { duration: video.duration, maxCues });
      if (out.cues.length) return { ...out, cost, tokens, model };
      lastError = new Error('no devolvió ningún tramo de música utilizable');
    } catch (err) { lastError = err; }
    messages.push({ role: 'assistant', content: res.text?.trim() ? res.text : '(respuesta vacía)' }, { role: 'user', content: `Tu respuesta no sirve: ${lastError.message}. Devolvé SOLO el objeto JSON con "cues" (start y end en segundos dentro de 0–${r2(video.duration)}, de al menos ${MIN_CUE_SECONDS} s, sin superponerse, con "prompt" en inglés).` });
  }
  throw new Error(`${model} no devolvió un plan de música válido: ${lastError.message}`);
}

// Genera el audio de cada tramo (en paralelo). ws: createWaveSpeed. Devuelve los tramos con url (/media/…) o error.
export async function generateMusic({ ws, cues, signal, mock = false, mediaDir }) {
  return Promise.all(cues.map(async (cue) => {
    const req = cueRequest(cue);
    try {
      let file;
      if (mock) file = await writeDemoMusic(mediaDir, req.seconds, cue.id);
      else {
        const sig = AbortSignal.any([signal, AbortSignal.timeout(180000)].filter(Boolean));
        ({ file } = await ws.audio({ model: MUSIC_MODEL, body: musicBody({ prompt: cue.prompt, ...req }), signal: sig, timeoutMs: 180000 }));
      }
      return { ...cue, ...req, url: `/media/${file}`, cost: mock ? 0 : req.seconds * MUSIC_COST_PER_SECOND };
    } catch (err) {
      return { ...cue, ...req, url: null, error: err.message.slice(0, 300), cost: 0 };
    }
  }));
}

// Demo: un colchón suave (acorde con envolvente lenta), WAV PCM 16 bits mono, distinto por tramo.
export function demoMusic(seconds, seed = 0) {
  const rate = 22050;
  const n = Math.round(rate * Math.min(MUSIC_MAX_SECONDS, Math.max(0.5, seconds)));
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  const root = 196 * 2 ** ((seed % 5) * 2 / 12);
  const freqs = [root, root * 1.25, root * 1.5];
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const env = Math.min(1, t / 0.8, (n / rate - t) / 0.8) * (0.75 + 0.25 * Math.sin(2 * Math.PI * 0.25 * t));
    const v = freqs.reduce((s, f) => s + Math.sin(2 * Math.PI * f * t), 0) / freqs.length;
    buf.writeInt16LE(Math.round(v * env * 0.3 * 32767), 44 + i * 2);
  }
  return buf;
}

async function writeDemoMusic(mediaDir, seconds, id) {
  const file = `music-demo-${randomUUID()}.wav`;
  await mkdir(mediaDir, { recursive: true });
  await writeFile(path.join(mediaDir, file), demoMusic(seconds, Number(String(id).replace(/\D/g, '')) || 0));
  return file;
}
