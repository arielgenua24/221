// Motor canvas · dentro del iframe aislado: el reproductor propio (sin React ni Remotion).
// Habla EXACTAMENTE el mismo protocolo que el iframe de Remotion (src/lab/frame.js), así las páginas no distinguen motores:
//   ← boot · → load · ← loaded | error { phase } · ← checked · → transform | layers | segments | music · → play | pause | seek
//   ← frame { frame, playing } · → render · ← render_progress | rendered { blob, ext, muted } | render_error
// Capas: video original → tomas de IA (Context Lab) → <canvas> con la animación del agente (transformación del humano encima).
// El reloj es el <video> de base; la animación se dibuja con CanvasKit.drawAt(t): función pura del tiempo.
// Renderizar: se recorre el video en tiempo real componiendo todo en un canvas y se graba con MediaRecorder.
(() => {
  const post = (msg) => parent.postMessage({ source: 'lab-frame', ...msg }, '*');
  const K = window.CanvasKit;
  if (!K) { post({ type: 'error', phase: 'eval', message: 'no cargó el motor canvas' }); return; }

  const rootEl = document.getElementById('root');
  rootEl.innerHTML = `
    <div class="cv-wrap"><div class="cv-stage">
      <video class="cv-video" playsinline muted preload="auto"></video>
      <div class="cv-ai"></div>
      <div class="cv-motion"><canvas class="cv-layer"></canvas></div>
      <div class="lab-frame-error" hidden></div>
    </div></div>
    <div class="cv-bar">
      <button class="cv-play" type="button" aria-label="Reproducir">▶</button>
      <input class="cv-seek" type="range" min="0" value="0" step="1" aria-label="Posición">
      <span class="cv-time">0:00 / 0:00</span>
      <button class="cv-mute" type="button" aria-label="Activar sonido">🔇</button>
    </div>`;
  const $ = (s) => rootEl.querySelector(s);
  const stage = $('.cv-stage'), video = $('.cv-video'), aiBox = $('.cv-ai'), motion = $('.cv-motion'), canvas = $('.cv-layer'), errorBox = $('.lab-frame-error');
  const playBtn = $('.cv-play'), seekBar = $('.cv-seek'), timeLabel = $('.cv-time'), muteBtn = $('.cv-mute');
  const g = canvas.getContext('2d');

  let cur = null; // { meta, fps, total, layer, transform, segments, motionHidden, cues, aiLayers }
  let lastError = null, checking = false, broken = false, rendering = false;
  let urls = [];
  let lastT = 0, lastPosted = -1, raf = 0;

  const describe = (err) => {
    const e = err instanceof Error ? err : new Error(String(err?.message || err));
    return `${e.name}: ${e.message}`.slice(0, 900);
  };
  const fail = (phase, err) => {
    if (rendering) return;
    const message = describe(err);
    if (lastError === message) return;
    lastError = message;
    if (checking) return;
    errorBox.textContent = `Error al reproducir\n\n${message}`;
    errorBox.hidden = false;
    post({ type: 'error', phase, message });
  };
  const blobUrl = (b) => { const u = URL.createObjectURL(b); urls.push(u); return u; };
  const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

  // ---------- Tamaño: el escenario entra entero en el iframe (como el <Player>) ----------
  function fit() {
    if (!cur) return;
    const { width: W, height: H } = cur.meta;
    const s = Math.min(rootEl.clientWidth / W, rootEl.clientHeight / H) || 1;
    stage.style.width = `${W * s}px`;
    stage.style.height = `${H * s}px`;
  }
  new ResizeObserver(fit).observe(rootEl);

  // ---------- Tiempo ----------
  const playing = () => !video.paused && !video.ended;
  const frameOf = (t) => Math.min(cur.total - 1, Math.max(0, Math.floor(t * cur.fps + 1e-6)));
  // Segundo de la animación que se ve en el segundo t del video (con los cortes del humano), o null si no se ve nada.
  function layerTime(t) {
    if (!Array.isArray(cur.segments)) return t;
    const f = t * cur.fps;
    const s = cur.segments.find((x) => f >= x.to && f < x.to + Math.max(1, x.len));
    return s ? (s.from + (f - s.to)) / cur.fps : null;
  }
  const placed = (tr) => ({ scale: String(tr?.scale ?? 1), translate: `${tr?.x || 0}% ${tr?.y || 0}%` });
  // La misma transformación, en un contexto 2D (para componer el render).
  function applyPlaced(o, tr, W, H) {
    o.translate(W / 2 + ((tr?.x || 0) / 100) * W, H / 2 + ((tr?.y || 0) / 100) * H);
    o.scale(tr?.scale ?? 1, tr?.scale ?? 1);
    o.translate(-W / 2, -H / 2);
  }

  // ---------- Dibujo ----------
  function drawLayer(T) {
    if (broken || T === null || cur.motionHidden) { g.clearRect(0, 0, canvas.width, canvas.height); return; }
    try { K.drawAt(cur.layer, g, T); } catch (err) {
      broken = true; // no repetir el mismo error en cada cuadro
      g.clearRect(0, 0, canvas.width, canvas.height);
      fail('runtime', err);
    }
  }

  // Tomas de IA: visibles solo en su tramo, sincronizadas con el reloj del video.
  function syncAi(f, isPlaying) {
    for (const l of cur.aiLayers) {
      const active = !l.hidden && l.el && f >= l.from && f < l.from + Math.max(1, l.durationInFrames);
      l.el.style.display = active ? '' : 'none';
      Object.assign(l.el.style, placed(l.transform));
      if (l.kind !== 'video') continue;
      if (!active) { if (!l.el.paused) l.el.pause(); continue; }
      l.el.muted = video.muted || l.muted !== false;
      const target = (f - l.from) / cur.fps;
      if (isPlaying) {
        if (Math.abs(l.el.currentTime - target) > 0.25) l.el.currentTime = target;
        if (l.el.paused) l.el.play().catch(() => {});
      } else {
        if (!l.el.paused) l.el.pause();
        if (Math.abs(l.el.currentTime - target) > 1 / cur.fps) l.el.currentTime = target;
      }
    }
  }

  // ---------- Música de fondo (los dos laboratorios) ----------
  // { master, cues: [{ id, start, end, volume, loop, src, el, blob }] } en segundos del video. Vive aparte de lo montado:
  // los mismos archivos se reusan aunque se vuelva a montar o cambien los volúmenes.
  const FADE_S = 1;
  let music = { master: 1, cues: [] };
  function setMusic(next) {
    const old = new Map(music.cues.map((c) => [c.blob, c]));
    const cues = (next?.cues || []).filter((c) => c.blob instanceof Blob).map((c) => {
      const prev = old.get(c.blob);
      old.delete(c.blob);
      if (prev) return { ...prev, ...c, el: prev.el, src: prev.src };
      const src = URL.createObjectURL(c.blob);
      const el = new Audio(src);
      el.preload = 'auto';
      return { ...c, src, el };
    });
    old.forEach((c) => { c.el.pause(); URL.revokeObjectURL(c.src); });
    music = { master: next?.master ?? 1, cues };
    if (cur) paint();
  }
  const levelOf = (c) => Math.max(0, Math.min(1, (c.muted ? 0 : c.volume ?? 0.25) * music.master));
  const fadeOf = (c, t) => { const f = Math.min(FADE_S, (c.end - c.start) / 3); return Math.max(0, Math.min(1, (t - c.start) / f, (c.end - t) / f)); };
  function syncMusic(t, isPlaying) {
    for (const c of music.cues) {
      const active = isPlaying && !rendering && !video.muted && t >= c.start && t < c.end && levelOf(c) > 0;
      if (!active) { if (!c.el.paused) c.el.pause(); continue; }
      c.el.loop = !!c.loop;
      c.el.volume = levelOf(c) * fadeOf(c, t);
      let target = t - c.start;
      if (c.el.duration > 0) target = c.loop ? target % c.el.duration : Math.min(target, c.el.duration);
      if (Math.abs(c.el.currentTime - target) > 0.3) c.el.currentTime = target;
      if (c.el.paused && (c.loop || target < c.el.duration - 0.05 || !(c.el.duration > 0))) c.el.play().catch(() => {});
    }
  }
  // La música en un contexto de audio: cada tramo programado en su segundo, con su loop y sus fundidos.
  async function scheduleMusic(ctx, dest, offset, end, decode) {
    let any = false;
    for (const c of music.cues) {
      const level = levelOf(c);
      if (level <= 0 || c.start >= end) continue;
      const buffer = await decode(c).catch(() => null);
      if (!buffer) continue;
      const stop = Math.min(c.end, end);
      const f = Math.min(FADE_S, (c.end - c.start) / 3);
      const src = ctx.createBufferSource();
      const gain = ctx.createGain();
      src.buffer = buffer; src.loop = !!c.loop;
      gain.gain.setValueAtTime(0, offset + c.start);
      gain.gain.linearRampToValueAtTime(level, offset + c.start + f);
      gain.gain.setValueAtTime(level, offset + Math.max(c.start + f, c.end - f));
      gain.gain.linearRampToValueAtTime(0, offset + c.end);
      src.connect(gain).connect(dest);
      src.start(offset + c.start);
      src.stop(offset + stop);
      any = true;
    }
    return any;
  }
  const decodeIn = (ctx) => (c) => c.blob.arrayBuffer().then((b) => ctx.decodeAudioData(b));

  // Efectos de sonido (AUDIO del agente): suenan cuando la animación cruza su segundo reproduciendo de corrido.
  function cuesBetween(a, b, play) {
    if (a === null || b === null || b <= a || b - a > 0.5) return;
    for (const c of cur.cues) if (c.at > a && c.at <= b) play(c);
  }
  const playCue = (c) => {
    if (video.muted) return;
    c.el.currentTime = 0;
    c.el.volume = c.volume;
    c.el.play().catch(() => {});
  };

  function paint() {
    if (!cur) return;
    const t = video.currentTime;
    const f = frameOf(t);
    const T = layerTime(t);
    drawLayer(T);
    const isPlaying = playing();
    syncAi(f, isPlaying);
    if (isPlaying) cuesBetween(lastT, T, playCue);
    syncMusic(t, isPlaying);
    lastT = T;
    if (document.activeElement !== seekBar) seekBar.value = String(f);
    timeLabel.textContent = `${fmt(t)} / ${fmt(cur.meta.duration)}`;
    if (Math.abs(f - lastPosted) >= 3 || !isPlaying) { lastPosted = f; post({ type: 'frame', frame: f, playing: isPlaying }); }
  }
  function loop() {
    paint();
    raf = playing() && !rendering ? requestAnimationFrame(loop) : 0;
  }

  // ---------- Controles ----------
  const play = () => { if (cur && !rendering) video.play().catch(() => {}); };
  const pause = () => { if (cur && !rendering) video.pause(); };
  const seek = (f) => { if (cur && !rendering) video.currentTime = Math.max(0, Math.min(cur.total - 1, f)) / cur.fps; };
  video.addEventListener('play', () => { playBtn.textContent = '❚❚'; rootEl.classList.add('cv-playing'); cancelAnimationFrame(raf); loop(); post({ type: 'frame', frame: frameOf(video.currentTime), playing: true }); });
  video.addEventListener('pause', () => { playBtn.textContent = '▶'; rootEl.classList.remove('cv-playing'); cur?.cues.forEach((c) => c.el.pause()); music.cues.forEach((c) => c.el.pause()); paint(); });
  video.addEventListener('seeked', () => { if (!playing()) paint(); });
  playBtn.onclick = () => (playing() ? pause() : play());
  stage.onclick = () => (playing() ? pause() : play());
  seekBar.oninput = () => seek(Number(seekBar.value));
  muteBtn.onclick = () => { video.muted = !video.muted; muteBtn.textContent = video.muted ? '🔇' : '🔊'; muteBtn.setAttribute('aria-label', video.muted ? 'Activar sonido' : 'Silenciar'); };
  window.addEventListener('keydown', (e) => { if (e.code === 'Space' && e.target === document.body) { e.preventDefault(); playBtn.click(); } });

  // ---------- Montar ----------
  const fontLinks = new Map();
  function linkCss(href) {
    return new Promise((resolve, reject) => {
      const l = document.createElement('link');
      l.rel = 'stylesheet'; l.href = href; l.onload = resolve; l.onerror = () => { l.remove(); reject(new Error(href)); };
      document.head.append(l);
    });
  }
  // Google Fonts: si la familia no tiene uno de los pesos pedidos, la API responde 400; se reintenta sin pesos.
  function loadFont({ family, weights }) {
    const key = `${family}:${weights.join(',')}`;
    if (!fontLinks.has(key)) {
      const name = family.replace(/ /g, '+');
      const wanted = [...weights].sort((a, b) => a - b).join(';');
      fontLinks.set(key, linkCss(`https://fonts.googleapis.com/css2?family=${name}:wght@${wanted}&display=block`)
        .catch(() => linkCss(`https://fonts.googleapis.com/css2?family=${name}&display=block`))
        .then(() => Promise.all(weights.map((w) => document.fonts.load(`${w} 48px "${family}"`))))
        .catch(() => {})); // sin red: queda la fuente del sistema
    }
    return fontLinks.get(key);
  }
  const within = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(r, ms))]);
  // (img.decode() puede no resolverse nunca en un iframe con sandbox: se espera load/error, con tope.)
  async function loadImage(src) {
    const img = new Image();
    await within(new Promise((r) => { img.onload = r; img.onerror = r; img.src = src; }), 5000);
    return img;
  }

  // Prueba de humo: comienzo, medio y final de cada zona (y de cada escena), sin mirar la pantalla.
  function smokeTest(zones) {
    checking = true;
    lastError = null;
    const times = [...new Set([
      ...zones.flatMap((z) => [z.from, z.from + Math.floor(z.durationInFrames / 2), z.from + z.durationInFrames - 1]).map((f) => f / cur.fps),
      ...K.sampleTimes(cur.layer),
    ])].filter((t) => t >= 0 && t <= cur.meta.duration);
    for (const t of times) {
      try { K.drawAt(cur.layer, g, t); } catch (err) { lastError = describe(err); break; }
    }
    checking = false;
    if (lastError) { broken = true; errorBox.textContent = `Error al reproducir\n\n${lastError}`; errorBox.hidden = false; }
    paint();
    post({ type: 'checked', ok: !lastError, message: lastError || undefined });
  }

  async function mount({ js, video: file, meta, zones = [], images = {}, transform, segments = null, sounds = null, videoLayers = [], motionHidden = false, music: musicIn = null }) {
    setMusic(musicIn);
    video.pause();
    urls.forEach((u) => URL.revokeObjectURL(u));
    urls = [];
    aiBox.replaceChildren();
    errorBox.hidden = true;
    lastError = null; broken = false; lastT = 0;
    const fps = meta.fps || 30;
    const total = Math.max(1, Math.ceil(meta.duration * fps));
    canvas.width = meta.width; canvas.height = meta.height;
    const soundUrls = Object.fromEntries(Object.entries(sounds || {}).filter(([, b]) => b instanceof Blob).map(([id, b]) => [id, blobUrl(b)]));
    const imgs = Object.fromEntries(await Promise.all(Object.entries(images || {}).map(async ([id, src]) => [id, await loadImage(src)])));
    const env = {
      g, W: meta.width, H: meta.height, FPS: fps, DUR: meta.duration,
      zones: zones.map((z) => ({ id: z.id, from: z.from / fps, to: (z.from + z.durationInFrames) / fps, prompt: z.prompt, notes: z.notes })),
      images: imgs,
      sounds: Object.fromEntries(Object.entries(soundUrls).map(([id, url]) => [id, { url }])),
    };
    let layer;
    try { layer = K.evaluate(js, env); } catch (err) { post({ type: 'error', phase: 'eval', message: describe(err) }); return; }
    await within(Promise.all(layer.fonts.map(loadFont)), 4000);
    const aiLayers = videoLayers.map(({ blob, url, ...l }) => {
      const src = blob instanceof Blob ? blobUrl(blob) : url || null;
      const el = src ? document.createElement(l.kind === 'video' ? 'video' : 'img') : null;
      if (el) {
        el.className = 'cv-fill'; el.src = src;
        if (l.kind === 'video') { el.muted = true; el.playsInline = true; el.preload = 'auto'; }
        aiBox.append(el);
      }
      return { ...l, el, blob: blob instanceof Blob ? blob : null };
    });
    const cues = layer.audio.map((a) => ({ ...a, el: new Audio(soundUrls[a.sound]) }));
    cur = { meta, fps, total, layer, transform, segments, motionHidden, cues, aiLayers, file };
    Object.assign(motion.style, placed(transform));
    motion.style.display = motionHidden ? 'none' : '';
    seekBar.max = String(total - 1);
    fit();
    video.loop = true;
    video.muted = true; muteBtn.textContent = '🔇';
    video.src = blobUrl(file);
    await new Promise((r) => { video.onloadeddata = r; video.onerror = r; setTimeout(r, 5000); });
    post({ type: 'loaded' });
    smokeTest(zones);
  }

  // ---------- Renderizar a un archivo ----------
  // 1) Cuadro a cuadro con WebCodecs (mediabunny, window.CanvasMedia): se decodifica cada cuadro del video, se compone
  //    con las tomas de IA y la animación en su t exacto, y se codifica. Determinista, no depende de que la pestaña
  //    esté visible ni del ritmo de reproducción. El audio (original + efectos) se mezcla offline.
  // 2) Si no se puede (sin WebCodecs, códec no soportado), se graba en tiempo real con MediaRecorder.
  async function renderVideo() {
    if (!cur || rendering) { post({ type: 'render_error', message: 'no hay nada montado para renderizar' }); return; }
    rendering = true;
    video.pause();
    let offlineError = null;
    try {
      const out = await renderOffline();
      rendering = false;
      paint();
      post({ type: 'rendered', ...out });
      return;
    } catch (err) {
      offlineError = err;
    }
    rendering = false;
    renderRealtime(offlineError);
  }

  // Los segundos del video en los que suena un efecto (el `at` está en tiempo de la animación: con cortes, puede ser otro).
  function cueTimes(c) {
    if (!Array.isArray(cur.segments)) return [c.at];
    const f = c.at * cur.fps;
    return cur.segments.filter((s) => f >= s.from && f < s.from + Math.max(1, s.len)).map((s) => (s.to + (f - s.from)) / cur.fps);
  }

  async function mixAudio(M, track, t0, end) {
    const rate = 48000;
    const ctx = new OfflineAudioContext(2, Math.max(1, Math.ceil(end * rate)), rate);
    let any = false;
    if (track && (await track.canDecode())) {
      for await (const { buffer, timestamp } of new M.AudioBufferSink(track).buffers(t0, t0 + end)) {
        const src = ctx.createBufferSource();
        src.buffer = buffer;
        src.connect(ctx.destination);
        const at = timestamp - t0;
        if (at >= 0) src.start(at); else src.start(0, -at);
        any = true;
      }
    }
    const decoded = new Map();
    for (const c of cur.cues) {
      if (!decoded.has(c.sound)) decoded.set(c.sound, await fetch(c.el.src).then((r) => r.arrayBuffer()).then((b) => ctx.decodeAudioData(b)).catch(() => null));
      const buffer = decoded.get(c.sound);
      if (!buffer) continue;
      for (const at of cueTimes(c)) {
        if (at >= end) continue;
        const src = ctx.createBufferSource();
        const gain = ctx.createGain();
        src.buffer = buffer; gain.gain.value = c.volume;
        src.connect(gain).connect(ctx.destination);
        src.start(at);
        any = true;
      }
    }
    if (await scheduleMusic(ctx, ctx.destination, 0, end, decodeIn(ctx))) any = true;
    return any ? ctx.startRendering() : null;
  }

  async function renderOffline() {
    const M = window.CanvasMedia;
    if (!M || typeof VideoEncoder === 'undefined') throw new Error('sin WebCodecs');
    const fps = cur.fps;
    // H.264 pide medidas pares.
    const W = cur.meta.width - (cur.meta.width % 2), H = cur.meta.height - (cur.meta.height % 2);
    const input = new M.Input({ source: new M.BlobSource(cur.file), formats: M.ALL_FORMATS });
    const track = await input.getPrimaryVideoTrack();
    if (!track || !(await track.canDecode())) throw new Error('este navegador no puede decodificar el video de base');
    const t0 = await track.getFirstTimestamp();
    const end = Math.min(cur.meta.duration, (await input.computeDuration()) - t0 || cur.meta.duration);
    const mp4 = await M.canEncodeVideo('avc', { width: W, height: H });
    const vcodec = mp4 ? 'avc' : (await M.canEncodeVideo('vp9', { width: W, height: H })) ? 'vp9' : 'vp8';
    const acodec = mp4 && (await M.canEncodeAudio('aac')) ? 'aac' : (await M.canEncodeAudio('opus')) ? 'opus' : null;
    const output = new M.Output({ format: mp4 ? new M.Mp4OutputFormat({ fastStart: 'in-memory' }) : new M.WebMOutputFormat(), target: new M.BufferTarget() });
    const out = document.createElement('canvas');
    out.width = W; out.height = H;
    const o = out.getContext('2d');
    const vsource = new M.CanvasSource(out, { codec: vcodec, quality: M.QUALITY_HIGH });
    output.addVideoTrack(vsource, { frameRate: fps });
    const mix = acodec ? await mixAudio(M, await input.getPrimaryAudioTrack(), t0, end).catch(() => null) : null;
    const asource = mix ? new M.AudioBufferSource({ codec: acodec, quality: M.QUALITY_HIGH }) : null;
    if (asource) output.addAudioTrack(asource);
    await output.start();
    if (asource) { await asource.add(mix); asource.close(); }
    // Tomas de IA en video: cada una con su propio decodificador (se piden por segundo local de la toma).
    const sinks = new Map();
    for (const l of cur.aiLayers) {
      if (l.kind !== 'video' || !l.blob) continue;
      try {
        const lt = await new M.Input({ source: new M.BlobSource(l.blob), formats: M.ALL_FORMATS }).getPrimaryVideoTrack();
        if (lt && (await lt.canDecode())) sinks.set(l.id, { sink: new M.CanvasSink(lt, { poolSize: 2 }), t0: await lt.getFirstTimestamp() });
      } catch { /* esa toma no entra */ }
    }
    const total = Math.max(1, Math.floor(end * fps));
    const times = Array.from({ length: total }, (_, i) => t0 + i / fps);
    const base = new M.CanvasSink(track, { width: W, height: H, fit: 'cover', poolSize: 2 });
    let i = 0, lastProgress = -1;
    for await (const frame of base.canvasesAtTimestamps(times)) {
      const t = i / fps;
      const f = frameOf(t);
      o.clearRect(0, 0, W, H);
      if (frame) o.drawImage(frame.canvas, 0, 0, W, H);
      for (const l of cur.aiLayers) {
        if (l.hidden || f < l.from || f >= l.from + Math.max(1, l.durationInFrames)) continue;
        let src = null;
        if (l.kind === 'video') {
          const s = sinks.get(l.id);
          src = s ? (await s.sink.getCanvas(s.t0 + (f - l.from) / fps))?.canvas : null;
        } else src = l.el;
        if (!src) continue;
        o.save(); applyPlaced(o, l.transform, W, H); K.HELPERS.drawFit(o, src, 0, 0, W, H, 'cover'); o.restore();
      }
      const T = layerTime(t);
      if (!cur.motionHidden && T !== null && !broken) {
        try { K.drawAt(cur.layer, g, T); } catch { broken = true; }
        o.save(); applyPlaced(o, cur.transform, W, H); o.drawImage(canvas, 0, 0, W, H); o.restore();
      }
      await vsource.add(t, 1 / fps);
      i += 1;
      const p = i / total;
      if (p - lastProgress >= 0.01) { lastProgress = p; post({ type: 'render_progress', progress: p }); }
    }
    vsource.close();
    await output.finalize();
    return { blob: new Blob([output.target.buffer], { type: mp4 ? 'video/mp4' : 'video/webm' }), ext: mp4 ? 'mp4' : 'webm', muted: !mix };
  }

  // Respaldo: grabar en tiempo real (la pestaña tiene que quedar visible mientras tanto).
  const MIME = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  async function renderRealtime(previous) {
    if (typeof MediaRecorder === 'undefined' || !HTMLCanvasElement.prototype.captureStream) { post({ type: 'render_error', message: previous ? describe(previous) : 'este navegador no puede grabar video (MediaRecorder)' }); return; }
    const { width: W, height: H } = cur.meta;
    const out = document.createElement('canvas');
    out.width = W; out.height = H;
    const o = out.getContext('2d');
    // captureStream(0) + requestFrame(): cada cuadro compuesto entra al archivo (sin depender del muestreo del navegador).
    const stream = out.captureStream(0);
    const vtrack = stream.getVideoTracks()[0];
    // Audio: el del video original (captureStream no depende de que esté silenciado) + los efectos, mezclados con WebAudio.
    // Sin un AudioContext activo (el navegador no lo deja arrancar) queda solo el audio del video.
    let actx = null, dest = null;
    const buffers = new Map();
    try {
      actx = new AudioContext();
      await within(actx.resume(), 1000);
      if (actx.state === 'running') {
        dest = actx.createMediaStreamDestination();
        for (const c of cur.cues) {
          if (buffers.has(c.sound)) continue;
          try { buffers.set(c.sound, await actx.decodeAudioData(await (await fetch(c.el.src)).arrayBuffer())); } catch { /* sin ese efecto */ }
        }
      }
    } catch { actx = null; dest = null; }
    rendering = true;
    video.pause();
    video.loop = false;
    video.currentTime = 0;
    await new Promise((r) => { video.onseeked = () => { video.onseeked = null; r(); }; setTimeout(r, 2000); });
    const captured = (video.captureStream || video.mozCaptureStream)?.call(video);
    const mime = MIME.find((m) => MediaRecorder.isTypeSupported(m)) || '';
    const chunks = [];
    let recorder = null;
    let lastProgress = -1;
    const finish = (err) => {
      rendering = false;
      video.pause();
      video.loop = true;
      video.onended = null;
      actx?.close().catch(() => {});
      if (err) post({ type: 'render_error', message: describe(err) });
      seek(0);
    };
    try {
      await video.play();
      const audio = captured?.getAudioTracks() || [];
      if (dest && audio.length) actx.createMediaStreamSource(new MediaStream(audio)).connect(dest);
      const tracks = [...stream.getVideoTracks(), ...(dest ? dest.stream.getAudioTracks() : audio)];
      const withMusic = dest ? await scheduleMusic(actx, dest, actx.currentTime, Math.min(cur.meta.duration, Number.isFinite(video.duration) ? video.duration : Infinity), decodeIn(actx)) : false;
      const muted = !(dest ? audio.length || buffers.size || withMusic : audio.length);
      recorder = new MediaRecorder(new MediaStream(tracks), { ...(mime ? { mimeType: mime } : {}), videoBitsPerSecond: Math.min(16e6, Math.max(4e6, W * H * 6)) });
      recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      recorder.onstop = () => {
        const type = recorder.mimeType || mime || 'video/webm';
        post({ type: 'rendered', blob: new Blob(chunks, { type }), ext: /mp4/.test(type) ? 'mp4' : 'webm', muted });
        finish();
      };
      recorder.start(250);
      // El final: la duración del video (si el archivo no la declara —webm de MediaRecorder—, la de meta).
      const end = Math.min(cur.meta.duration, Number.isFinite(video.duration) ? video.duration : Infinity);
      let stopping = false;
      const stop = () => {
        if (stopping) return;
        stopping = true;
        setTimeout(() => recorder.state !== 'inactive' && recorder.stop(), 120);
      };
      let prevT = 0;
      const compose = () => {
        if (!rendering) return;
        const t = video.currentTime;
        const f = frameOf(t);
        const T = layerTime(t);
        o.clearRect(0, 0, W, H);
        o.drawImage(video, 0, 0, W, H);
        syncAi(f, true);
        for (const l of cur.aiLayers) {
          if (!l.el || l.el.style.display === 'none') continue;
          o.save(); applyPlaced(o, l.transform, W, H); K.HELPERS.drawFit(o, l.el, 0, 0, W, H, 'cover'); o.restore();
        }
        if (!cur.motionHidden && T !== null && !broken) {
          try { K.drawAt(cur.layer, g, T); } catch { broken = true; }
          o.save(); applyPlaced(o, cur.transform, W, H); o.drawImage(canvas, 0, 0, W, H); o.restore();
        }
        vtrack.requestFrame?.();
        if (dest) cuesBetween(prevT, T, (c) => {
          const b = buffers.get(c.sound);
          if (!b) return;
          const src = actx.createBufferSource();
          const gain = actx.createGain();
          src.buffer = b; gain.gain.value = c.volume;
          src.connect(gain).connect(dest);
          src.start();
        });
        prevT = T;
        const p = Math.min(1, t / end);
        if (p - lastProgress >= 0.01) { lastProgress = p; post({ type: 'render_progress', progress: p }); }
        if (t >= end - 0.5 / cur.fps) { stop(); return; }
        if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(compose); else requestAnimationFrame(compose);
      };
      // Un 'ended' antes de tiempo (archivos sin duración) no corta la grabación: sigue reproduciendo.
      video.onended = () => { if (video.currentTime >= end - 0.3) stop(); else video.play().catch(() => {}); };
      compose();
    } catch (err) {
      if (recorder) { recorder.onstop = null; if (recorder.state !== 'inactive') recorder.stop(); }
      finish(err);
    }
  }

  window.addEventListener('error', (e) => fail('runtime', e.error || e.message));
  window.addEventListener('unhandledrejection', (e) => fail('runtime', e.reason));
  window.addEventListener('message', ({ data: msg }) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'load') { mount(msg).catch((err) => post({ type: 'error', phase: 'eval', message: describe(err) })); return; }
    if (msg.type === 'music') { setMusic(msg.music); return; }
    if (!cur) return;
    if (msg.type === 'transform') { cur.transform = msg.transform; Object.assign(motion.style, placed(msg.transform)); return; }
    if (msg.type === 'layers') {
      const byId = new Map((msg.videoLayers || []).map((l) => [l.id, l]));
      cur.aiLayers = cur.aiLayers.map((l) => ({ ...l, ...(byId.get(l.id) || {}), el: l.el }));
      cur.motionHidden = !!msg.motionHidden;
      motion.style.display = cur.motionHidden ? 'none' : '';
      paint();
      return;
    }
    if (msg.type === 'segments') { cur.segments = msg.segments; paint(); return; }
    if (msg.type === 'render') { renderVideo(); return; }
    if (msg.type === 'play') play();
    if (msg.type === 'pause') pause();
    if (msg.type === 'seek') seek(Math.round(msg.frame || 0));
  });
  post({ type: 'boot' });
})();
