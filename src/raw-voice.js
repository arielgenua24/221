import { createHash } from 'node:crypto';
import { access, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';

// La voz de Raw: texto → audio con el modelo de TTS de WaveSpeed. Cada frase se guarda en disco
// (por hash de texto + voz), así el saludo y las frases que se repiten suenan al instante y no se pagan dos veces.
// Devuelve la URL pública del audio, o null si no hay TTS (el navegador lee el texto con su propia voz).
export function createSpeaker({ ws, filesDir, publicPrefix, model, voice, style }) {
  const dir = path.join(filesDir, 'tts');
  const inflight = new Map();
  const body = (text) => ({ text, ...(voice ? { voice } : {}), ...(style ? { style_instructions: style } : {}) });

  return async function speak(text, signal) {
    const clean = String(text || '').trim().slice(0, 800);
    if (!clean || !ws || ws.mock) return null;
    const key = createHash('sha1').update(`${model}|${voice}|${style}|${clean}`).digest('hex').slice(0, 20);
    if (inflight.has(key)) return inflight.get(key);
    const job = (async () => {
      for (const ext of ['mp3', 'wav', 'ogg', 'm4a']) {
        const name = `${key}.${ext}`;
        try { await access(path.join(dir, name)); return `${publicPrefix}tts/${name}`; } catch { /* no está en caché */ }
      }
      const out = await ws.audio({ model, body: body(clean), signal });
      if (!out.file) return null;
      await mkdir(dir, { recursive: true });
      const name = `${key}${path.extname(out.file)}`;
      await rename(path.join(filesDir, out.file), path.join(dir, name));
      return `${publicPrefix}tts/${name}`;
    })();
    inflight.set(key, job);
    try { return await job; } finally { inflight.delete(key); }
  };
}
