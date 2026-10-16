// Laboratorio · la música de fondo del estudio, lista para los reproductores (iframes de los dos motores).
// El iframe no puede pedir nada por red (su CSP solo deja blob:): cada tramo (/media/…) se baja una vez y viaja como Blob.
const blobs = new Map(); // url → Promise<Blob>

function blobOf(url) {
  if (!blobs.has(url)) {
    const p = fetch(url).then((r) => { if (!r.ok) throw new Error(`no se pudo bajar la música (${r.status})`); return r.blob(); });
    p.catch(() => blobs.delete(url));
    blobs.set(url, p);
  }
  return blobs.get(url);
}

// music: studio.music() → { master, cues: [{ id, start, end, volume, loop, url, muted }] }. Devuelve lo que entiende el iframe.
export async function musicForFrame(music) {
  if (!music?.cues?.length) return null;
  const cues = await Promise.all(music.cues.map(async (c) => {
    try { return { id: c.id, start: c.start, end: c.end, volume: c.volume, loop: !!c.loop, muted: !!c.muted, blob: await blobOf(c.url) }; } catch { return null; }
  }));
  return { master: music.master ?? 1, cues: cues.filter(Boolean) };
}

// Manda la música (o sus volúmenes nuevos) a todos los reproductores abiertos. frames: [Window].
let pending = 0;
export async function broadcastMusic(music, frames) {
  const ticket = ++pending;
  const payload = await musicForFrame(music);
  if (ticket !== pending) return; // llegó un cambio más nuevo mientras se bajaban los archivos
  frames.filter(Boolean).forEach((w) => w.postMessage({ type: 'music', music: payload }, '*'));
}
