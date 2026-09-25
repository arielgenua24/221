import { fmt } from './shared.js';

// Todo se procesa en el navegador: al servidor solo viajan el audio (WAV mono 16 kHz), cuadros y fotos reducidas.
const AUDIO_RATE = 16000; // lo que usa el modelo para escuchar; la reproducción usa el archivo original
export const MAX_AUDIO_SECONDS = 8 * 60;
const FRAME_SIDE = 640; // lo que ve el Director
const PHOTO_SIDE = 1280; // lo que ve el orquestador de ideas

export function kindOf(file) {
  const type = file.type || '';
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  if (type.startsWith('image/')) return 'photo';
  if (type.startsWith('audio/') || ['m4a', 'mp3', 'wav', 'aac', 'ogg', 'opus', 'flac', 'amr', '3gp'].includes(ext)) return 'audio';
  if (type.startsWith('video/') || ['mp4', 'mov', 'webm', 'mkv', 'm4v'].includes(ext)) return 'video';
  return null;
}

function encodeWav(samples, rate) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, samples[i])) * 32767, true);
  return new Blob([buf], { type: 'audio/wav' });
}

const toDataUrl = (blob) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(r.result);
  r.onerror = () => reject(r.error);
  r.readAsDataURL(blob);
});

// Sirve para archivos de audio y también para usar el sonido de un video como música.
export async function loadAudio(file) {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx();
  let decoded;
  try {
    decoded = await ctx.decodeAudioData(await file.arrayBuffer());
  } catch {
    throw new Error(`No pude leer el sonido de "${file.name}". Probá con MP3, M4A o WAV.`);
  } finally {
    ctx.close?.();
  }
  if (decoded.duration > MAX_AUDIO_SECONDS) throw new Error(`La música dura ${fmt(decoded.duration)}; el máximo es ${MAX_AUDIO_SECONDS / 60} minutos.`);
  if (decoded.duration < 2) throw new Error(`"${file.name}" dura menos de 2 segundos.`);
  const off = new OfflineAudioContext(1, Math.ceil(decoded.duration * AUDIO_RATE), AUDIO_RATE);
  const src = off.createBufferSource();
  src.buffer = decoded;
  src.connect(off.destination);
  src.start();
  const mono = await off.startRendering();
  return { name: file.name, url: URL.createObjectURL(file), duration: decoded.duration, wav: await toDataUrl(encodeWav(mono.getChannelData(0), AUDIO_RATE)) };
}

function toJpeg(source, w, h, side, quality) {
  const scale = Math.min(1, side / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.round(w * scale); c.height = Math.round(h * scale);
  c.getContext('2d').drawImage(source, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', quality);
}

const once = (node, ev, ms = 10000) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('tardó demasiado en cargar')), ms);
  node.addEventListener(ev, () => { clearTimeout(t); resolve(); }, { once: true });
  node.addEventListener('error', () => { clearTimeout(t); reject(new Error('el navegador no puede leerlo')); }, { once: true });
});

export async function loadVideo(file) {
  const url = URL.createObjectURL(file);
  const v = await openVideo(url);
  const d = v.duration;
  const frames = [];
  for (const t of [0.12, 0.37, 0.62, 0.87].map((f) => +(d * f).toFixed(2))) {
    v.currentTime = t;
    await once(v, 'seeked');
    frames.push({ t, url: toJpeg(v, v.videoWidth, v.videoHeight, FRAME_SIDE, 0.72) });
  }
  return { kind: 'video', file, name: file.name, url, duration: d, frames, thumb: frames[1].url };
}

export async function loadPhoto(file) {
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.src = url;
  await once(img, 'load');
  const frame = toJpeg(img, img.naturalWidth, img.naturalHeight, FRAME_SIDE, 0.72);
  return {
    kind: 'photo', file, name: file.name, url, duration: 0,
    frames: [{ t: 0, url: frame }], thumb: frame,
    full: toJpeg(img, img.naturalWidth, img.naturalHeight, PHOTO_SIDE, 0.85),
  };
}

// ---------- Intuition ----------

// Abre un video y devuelve un elemento listo para posicionar (sin sonido: solo para leer cuadros).
export async function openVideo(url) {
  const v = document.createElement('video');
  v.muted = true; v.playsInline = true; v.preload = 'auto'; v.src = url;
  await once(v, 'loadeddata');
  // Los WebM grabados en el navegador no traen la duración: ir al final obliga a calcularla.
  if (v.duration === Infinity) {
    v.currentTime = 1e7;
    await once(v, 'seeked', 20000);
    v.currentTime = 0;
    await once(v, 'seeked');
  }
  if (!Number.isFinite(v.duration) || !v.duration) throw new Error('no pude leer su duración');
  return v;
}

// Cuadros JPEG de un video en los segundos pedidos (en orden). `v` es un elemento de openVideo.
export async function framesAt(v, times, side = FRAME_SIDE, quality = 0.72) {
  const out = [];
  for (const t of times) {
    v.currentTime = Math.min(Math.max(0, t), v.duration - 0.05);
    await once(v, 'seeked');
    out.push({ t, url: toJpeg(v, v.videoWidth, v.videoHeight, side, quality) });
  }
  return out;
}

// Referencia visual de un clip: imagen (1 cuadro), video o GIF animado (hasta 4 cuadros).
export async function loadReference(file) {
  const name = file.name;
  const type = file.type || '';
  if (type === 'image/gif' || /\.gif$/i.test(name)) {
    const frames = await gifFrames(file).catch(() => null);
    if (frames?.length > 1) return { kind: 'video', name, frames, thumb: frames[0] };
  }
  if (kindOf(file) === 'photo') {
    const { frames, thumb } = await loadPhoto(file);
    return { kind: 'image', name, frames: frames.map((f) => f.url), thumb };
  }
  if (kindOf(file) === 'video') {
    const url = URL.createObjectURL(file);
    try {
      const v = await openVideo(url);
      const frames = (await framesAt(v, [0.15, 0.4, 0.65, 0.9].map((f) => v.duration * f))).map((f) => f.url);
      return { kind: 'video', name, frames, thumb: frames[1] };
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  throw new Error('solo imágenes, videos o GIFs');
}

// Cuadros repartidos de un GIF animado (donde el navegador tiene ImageDecoder).
async function gifFrames(file) {
  if (typeof ImageDecoder === 'undefined') return null;
  const dec = new ImageDecoder({ data: await file.arrayBuffer(), type: 'image/gif' });
  await dec.tracks.ready;
  const n = dec.tracks.selectedTrack?.frameCount || 1;
  const picks = [...new Set([0.1, 0.37, 0.63, 0.9].map((f) => Math.min(n - 1, Math.floor(n * f))))];
  const frames = [];
  for (const frameIndex of picks) {
    const { image } = await dec.decode({ frameIndex });
    frames.push(toJpeg(image, image.displayWidth, image.displayHeight, FRAME_SIDE, 0.72));
    image.close();
  }
  dec.close();
  return frames;
}
