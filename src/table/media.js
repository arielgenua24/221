import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createWaveSpeed } from '../wavespeed.js';

// Mesa de agentes · lo que los agentes producen de verdad (WaveSpeed):
//   imagen → Nano Banana 2.1 (text-to-image, o edit si parte de imágenes de la mesa)
//   voz    → ElevenLabs v4 (la línea de un personaje)
//   sonido → ElevenLabs Sound Effects v2 (efecto, ambiente o base musical, hasta 22 s)
// Las mismas especificaciones (spec) sirven para las herramientas de los turnos, para las partes de la entrega
// y para RUN: lo que un agente generó en la mesa se puede volver a correr igual.
// El video no está acá: lo aprueba el humano al final (src/cinematic/jobs.js, en src/table/routes.js).

export const ASPECTS = ['9:16', '16:9', '1:1', '3:4', '4:3'];
export const SOUND_KINDS = ['efecto', 'ambiente', 'musica'];
export const LIMITS = { prompt: 3000, voiceText: 2500, refs: 6, soundMin: 0.5, soundMax: 22, perTurn: 2 };
export const DEFAULT_VOICE = 'Alice';
// Voces sugeridas de ElevenLabs (también acepta cualquier voice_id de tu cuenta). Hablan el idioma del texto.
export const VOICES = [
  ['Alice', 'mujer, adulta, británica, clara y segura'], ['Aria', 'mujer, adulta, expresiva'], ['Sarah', 'mujer, joven, suave'],
  ['Laura', 'mujer, joven, enérgica'], ['Jessica', 'mujer, joven, cálida y expresiva'], ['Lily', 'mujer, adulta, británica, cálida'],
  ['Matilda', 'mujer, adulta, amable'], ['Charlotte', 'mujer, joven, seductora'], ['River', 'voz neutra, calma'],
  ['Roger', 'hombre, adulto, seguro'], ['George', 'hombre, adulto, británico, cálido narrador'], ['Brian', 'hombre, adulto, grave'],
  ['Daniel', 'hombre, adulto, británico, autoridad'], ['Eric', 'hombre, adulto, amable'], ['Chris', 'hombre, adulto, casual'],
  ['Charlie', 'hombre, adulto, australiano, natural'], ['Callum', 'hombre, intenso, áspero'], ['Liam', 'hombre, joven, articulado'],
  ['Will', 'hombre, joven, amistoso'], ['Bill', 'hombre, mayor, confiable'],
].map(([id, label]) => ({ id, label }));

const num = (v, d) => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? d : Number(v));
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const oneLine = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

// Costos orientativos en US$ (WaveSpeed cobra según su tabla; se ajustan por entorno).
export const mediaCosts = () => ({
  image: num(process.env.TABLE_IMAGE_COST, 0.04),
  imageReference: num(process.env.TABLE_IMAGE_REFERENCE_COST, 0.002),
  voicePer1k: num(process.env.TABLE_VOICE_COST_PER_1K, 0.1),
  sound: num(process.env.TABLE_SOUND_COST, 0.03),
  videoPerSecond: num(process.env.TABLE_VIDEO_COST_PER_SECOND, 0.075),
});
export const mediaModels = () => ({
  image: process.env.TABLE_IMAGE_MODEL || 'google/nano-banana-2.1/text-to-image',
  imageEdit: process.env.TABLE_IMAGE_EDIT_MODEL || 'google/nano-banana-2.1/edit',
  voice: process.env.TABLE_VOICE_MODEL || 'elevenlabs/eleven-v4',
  sound: process.env.TABLE_SOUND_MODEL || 'elevenlabs/sound-effects-v2',
});

// ---------- Especificaciones: validan y completan lo que piden un agente, el relator o el humano ----------
export const codeList = (v) => [...new Set((Array.isArray(v) ? v : v ? [v] : []).map((c) => String(c).trim().toUpperCase()))]
  .filter((c) => /^[A-DMG]\d{1,3}$/.test(c));

export function imageSpec(raw, aspect = '9:16') {
  const prompt = oneLine(raw?.prompt, LIMITS.prompt);
  if (!prompt) throw new Error('falta el prompt de la imagen');
  return { prompt, referencias: codeList(raw?.referencias).slice(0, LIMITS.refs), proporcion: ASPECTS.includes(raw?.proporcion) ? raw.proporcion : ASPECTS.includes(aspect) ? aspect : '9:16' };
}

export function voiceSpec(raw) {
  const texto = String(raw?.texto ?? '').replace(/[ \t]+/g, ' ').trim().slice(0, LIMITS.voiceText);
  if (!texto) throw new Error('falta el texto de la voz');
  const est = num(raw?.estabilidad, 0.5);
  return { personaje: oneLine(raw?.personaje, 60) || 'Narrador', texto, voz: oneLine(raw?.voz, 80) || DEFAULT_VOICE, estabilidad: Math.round(clamp(est, 0, 1) * 100) / 100 };
}

export function soundSpec(raw) {
  const prompt = oneLine(raw?.prompt, 1000);
  if (!prompt) throw new Error('falta la descripción del sonido');
  const tipo = SOUND_KINDS.includes(raw?.tipo) ? raw.tipo : 'efecto';
  const duracion = Math.round(clamp(num(raw?.duracion, tipo === 'musica' ? 20 : 5), LIMITS.soundMin, LIMITS.soundMax) * 10) / 10;
  return { prompt, tipo, duracion, loop: typeof raw?.loop === 'boolean' ? raw.loop : tipo !== 'efecto' };
}

export const SPECS = { image: imageSpec, voice: voiceSpec, sound: soundSpec };

export function estimate(kind, spec, costs = mediaCosts()) {
  const r = (x) => Math.round(x * 10000) / 10000;
  if (kind === 'image') return r(costs.image + (spec.referencias?.length || 0) * costs.imageReference);
  if (kind === 'voice') return r(Math.max(0.005, (spec.texto.length / 1000) * costs.voicePer1k));
  if (kind === 'sound') return r(costs.sound);
  throw new Error(`tipo de medio inválido: ${kind}`);
}

// Archivos generados: se sirven en /media/<archivo> y se leen de disco para mostrárselos a un modelo.
export const MEDIA_URL = /^\/media\/[\w-]+\.(png|jpe?g|webp|svg|mp3|wav|ogg|m4a|mp4|webm)$/;
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', svg: 'image/svg+xml', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', mp4: 'video/mp4', webm: 'video/webm' };
export async function mediaUrlToData(mediaDir, url) {
  if (!MEDIA_URL.test(url || '')) throw new Error('archivo generado inválido');
  const file = path.basename(url);
  const ext = path.extname(file).slice(1).toLowerCase();
  return `data:${MIME[ext]};base64,${(await readFile(path.join(mediaDir, file))).toString('base64')}`;
}

// El schema publicado de cada modelo (GET /api/v3/models), para mandar los campos con el nombre que espera.
// Si no se puede leer, se usan los nombres documentados.
function schemaLookup({ apiKey, fetchImpl }) {
  let cache = null;
  const base = () => (process.env.WAVESPEED_BASE_URL || 'https://api.wavespeed.ai').replace(/\/+$/, '');
  return async (model) => {
    if (!cache || Date.now() - cache.at > 3600000) {
      cache = {
        at: Date.now(),
        list: fetchImpl(`${base()}/api/v3/models`, { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(12000) })
          .then((r) => (r.ok ? r.json() : null)).then((j) => (Array.isArray(j?.data) ? j.data : [])).catch(() => []),
      };
    }
    const list = await cache.list;
    if (!list.length) cache.at = 0; // falló: se vuelve a intentar la próxima vez
    const m = list.find((x) => x.model_id === model);
    return m?.api_schema?.api_schemas?.find((s) => s.type === 'model_run')?.request_schema?.properties || null;
  };
}

// Cuerpos de cada modelo (puros, para poder probarlos).
export function voiceBody(spec, props) {
  const body = { text: spec.texto, voice_id: spec.voz, stability: spec.estabilidad };
  if (props && !props.voice_id && props.voice) { body.voice = body.voice_id; delete body.voice_id; }
  if (props?.similarity_boost && !props.similarity) body.similarity_boost = 0.75; else body.similarity = 0.75;
  return body;
}
export function soundBody(spec, props) {
  const field = props && !props.text && props.prompt ? 'prompt' : 'text';
  const min = num(props?.duration?.minimum, LIMITS.soundMin), max = num(props?.duration?.maximum, LIMITS.soundMax);
  const body = { [field]: spec.prompt, duration: clamp(spec.duracion, min, max), loop: spec.loop, prompt_influence: 0.3 };
  if (props && !props.loop) delete body.loop;
  if (props && !props.prompt_influence) delete body.prompt_influence;
  return body;
}

// ---------- Modo demo: piezas de mentira, pero reales (se ven y se escuchan) ----------
const hash = (s) => [...String(s)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
const SIZES = { '9:16': [576, 1024], '16:9': [1024, 576], '1:1': [800, 800], '3:4': [660, 880], '4:3': [880, 660] };
const xml = (s) => String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

export function demoSvg(spec) {
  const [w, h] = SIZES[spec.proporcion] || SIZES['9:16'];
  const hue = hash(spec.prompt) % 360;
  const words = spec.prompt.split(' ');
  const lines = [];
  for (const word of words) {
    if (lines.length && `${lines.at(-1)} ${word}`.length <= 26) lines[lines.length - 1] += ` ${word}`;
    else if (lines.length < 7) lines.push(word);
  }
  const size = Math.round(w / 19);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue} 55% 32%)"/><stop offset="1" stop-color="hsl(${(hue + 50) % 360} 60% 14%)"/></linearGradient></defs>
<rect width="100%" height="100%" fill="url(#g)"/>
<circle cx="${w * 0.7}" cy="${h * 0.3}" r="${Math.min(w, h) * 0.22}" fill="hsl(${(hue + 30) % 360} 80% 70%)" opacity=".25"/>
<g font-family="system-ui, sans-serif" fill="#fff" text-anchor="middle">
${lines.map((l, i) => `<text x="${w / 2}" y="${h / 2 - (lines.length / 2 - i) * size * 1.3}" font-size="${size}" font-weight="600">${xml(l)}</text>`).join('\n')}
<text x="${w / 2}" y="${h - size * 1.5}" font-size="${Math.round(size * 0.6)}" opacity=".75">DEMO · Nano Banana 2.1 · ${xml(spec.proporcion)}</text>
</g></svg>`;
}

// PCM de 16 bits, mono. `sample(t)` devuelve -1..1.
export function wav(seconds, sample, rate = 16000) {
  const n = Math.max(1, Math.round(seconds * rate));
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(clamp(sample(i / rate), -1, 1) * 16000), 44 + i * 2);
  return buf;
}

function demoAudio(kind, spec) {
  const seed = hash(kind === 'voice' ? spec.texto : spec.prompt);
  let r = seed || 1;
  const noise = () => { r = (r * 1664525 + 1013904223) >>> 0; return r / 2 ** 31 - 1; };
  if (kind === 'voice') {
    // "Sílabas": tonos cortos que suben y bajan, del largo aproximado del texto.
    const seconds = clamp(spec.texto.length / 15, 1, 8);
    return wav(seconds, (t) => {
      const syl = Math.floor(t / 0.19), phase = (t / 0.19) % 1;
      if ((seed >> (syl % 16)) % 7 === 0) return 0;
      const f = 150 + ((seed >> (syl % 11)) % 110);
      return Math.sin(2 * Math.PI * f * t) * Math.sin(Math.PI * phase) * 0.8;
    });
  }
  const seconds = Math.min(spec.duracion, 10);
  if (spec.tipo === 'musica') {
    const root = 196 + (seed % 5) * 22;
    return wav(seconds, (t) => [1, 1.26, 1.5, 2].reduce((s, k, i) => s + Math.sin(2 * Math.PI * root * k * t) * (0.25 + 0.1 * Math.sin(t * (1 + i))), 0) * 0.35 * (0.6 + 0.4 * Math.sin(Math.PI * 2 * t * 2) ** 2));
  }
  let low = 0;
  return wav(seconds, (t) => {
    low += (noise() - low) * (spec.tipo === 'ambiente' ? 0.05 : 0.4);
    const env = spec.tipo === 'ambiente' ? 0.7 : Math.exp(-((t % 1.2) * 5));
    return low * env * 1.6;
  });
}

// ---------- Generar ----------
// `resolve(code)` devuelve la imagen de la mesa (data URL, https o /media/…) que el agente usa como referencia.
export function createTableMedia({ apiKey, mediaDir, mock = false, fetchImpl = fetch, pollMs = 1500 }) {
  const ws = !mock && apiKey ? createWaveSpeed({ apiKey, mediaDir, fetchImpl, pollMs }) : null;
  const props = ws ? schemaLookup({ apiKey, fetchImpl }) : async () => null;

  async function save(ext, data) {
    const file = `${randomUUID()}.${ext}`;
    await mkdir(mediaDir, { recursive: true });
    await writeFile(path.join(mediaDir, file), data);
    return file;
  }

  async function generate(kind, spec, { resolve = async () => null, signal, onStatus } = {}) {
    const started = Date.now();
    const models = mediaModels();
    const cost = estimate(kind, spec);
    const done = (file, model, extra = {}) => ({ kind, url: `/media/${file}`, model, cost: mock ? 0 : cost, ms: Date.now() - started, ...extra });
    if (mock) {
      await new Promise((r) => setTimeout(r, 120));
      if (kind === 'image') return done(await save('svg', demoSvg(spec)), `${models.image} (demo)`, { demo: true });
      return done(await save('wav', demoAudio(kind, spec)), `${models[kind]} (demo)`, { demo: true });
    }
    if (!ws) throw new Error('Falta WAVESPEED_API_KEY para generar imágenes, voces y sonidos.');
    if (kind === 'image') {
      const images = [];
      for (const code of spec.referencias) {
        let data = await resolve(code);
        if (!data) throw new Error(`no hay ninguna imagen ${code} en la mesa`);
        if (MEDIA_URL.test(data)) data = await mediaUrlToData(mediaDir, data);
        images.push(await ws.upload(data, signal));
      }
      const model = images.length ? models.imageEdit : models.image;
      const out = await ws.image({
        model, signal, timeoutMs: 180000, onStatus,
        body: { prompt: spec.prompt, aspect_ratio: spec.proporcion, resolution: '1k', output_format: 'png', enable_web_search: false, enable_image_search: false, ...(images.length ? { images } : {}) },
      });
      return done(out.file, model);
    }
    if (kind === 'voice') {
      const out = await ws.audio({ model: models.voice, body: voiceBody(spec, await props(models.voice)), signal, timeoutMs: 120000, onStatus });
      return done(out.file, models.voice);
    }
    if (kind === 'sound') {
      const out = await ws.audio({ model: models.sound, body: soundBody(spec, await props(models.sound)), signal, timeoutMs: 180000, onStatus });
      return done(out.file, models.sound);
    }
    throw new Error(`tipo de medio inválido: ${kind}`);
  }

  return { available: mock || !!ws, mock, generate };
}
