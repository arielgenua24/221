// Laboratorio · descarga: compone una capa transparente (WebM con alfa que renderizó Remotion) encima del video original
// en un canvas y lo graba en tiempo real con MediaRecorder. Lo usan Motion Design y Context Lab cuando el renderizador
// web de Remotion no puede decodificar el video de base.
// file: el video original (Blob) · meta: { duration, width, height } · onProgress(0..1).
export async function compositeOverlay(file, meta, overlayBlob, onProgress = () => {}) {
  if (!window.MediaRecorder || !HTMLCanvasElement.prototype.captureStream) throw new Error('este navegador no puede grabar video');
  const k = Math.min(1, 1920 / Math.max(meta.width, meta.height));
  const W = Math.round((meta.width * k) / 2) * 2;
  const H = Math.round((meta.height * k) / 2) * 2;
  const make = (src, muted) => { const v = document.createElement('video'); v.src = src; v.muted = muted; v.playsInline = true; v.preload = 'auto'; return v; };
  const baseUrl = URL.createObjectURL(file);
  const ovUrl = URL.createObjectURL(overlayBlob);
  const base = make(baseUrl, false);
  const ov = make(ovUrl, true);
  const ready = (v) => new Promise((res, rej) => { v.addEventListener('loadeddata', res, { once: true }); v.addEventListener('error', () => rej(new Error('no se pudo leer un video')), { once: true }); });
  try {
    await Promise.all([ready(base), ready(ov)]);
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');
    // El sonido del original va a la grabación (no a los parlantes).
    const ac = new AudioContext();
    const dest = ac.createMediaStreamDestination();
    ac.createMediaElementSource(base).connect(dest);
    await ac.resume();
    const mime = ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
      .find((m) => MediaRecorder.isTypeSupported(m)) || '';
    const stream = new MediaStream([...canvas.captureStream(30).getVideoTracks(), ...dest.stream.getAudioTracks()]);
    const rec = new MediaRecorder(stream, { mimeType: mime || undefined, videoBitsPerSecond: W * H > 1e6 ? 12_000_000 : 8_000_000 });
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    const stopped = new Promise((r) => { rec.onstop = r; });
    const draw = () => {
      ctx.drawImage(base, 0, 0, W, H);
      // La capa sigue al original: si se desfasa, se resincroniza.
      if (Math.abs(ov.currentTime - base.currentTime) > 0.08) ov.currentTime = base.currentTime;
      ctx.drawImage(ov, 0, 0, W, H);
    };
    let raf = 0;
    // rAF no corre con la pestaña oculta: ahí se dibuja con un timer (sigue siendo mejor dejarla visible).
    const next = (fn) => (document.hidden ? setTimeout(fn, 33) : requestAnimationFrame(fn));
    const loop = () => {
      draw();
      onProgress(Math.min(1, base.currentTime / meta.duration));
      if (base.ended || base.currentTime >= meta.duration - 0.02) { if (rec.state === 'recording') rec.stop(); return; }
      raf = next(loop);
    };
    base.currentTime = 0; ov.currentTime = 0;
    draw();
    rec.start(500);
    await Promise.all([base.play(), ov.play()]);
    raf = next(loop);
    base.addEventListener('ended', () => rec.state === 'recording' && rec.stop(), { once: true });
    await stopped;
    cancelAnimationFrame(raf); clearTimeout(raf);
    ac.close();
    const type = rec.mimeType || mime || 'video/webm';
    return { blob: new Blob(chunks, { type }), ext: type.includes('mp4') ? 'mp4' : 'webm' };
  } finally {
    base.pause(); ov.pause();
    URL.revokeObjectURL(baseUrl); URL.revokeObjectURL(ovUrl);
  }
}

