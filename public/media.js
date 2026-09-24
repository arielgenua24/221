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
  const v = document.createElement('video');
  v.muted = true; v.playsInline = true; v.preload = 'auto'; v.src = url;
  await once(v, 'loadeddata');
  const d = v.duration;
  if (!Number.isFinite(d) || !d) throw new Error('no pude leer su duración');
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
