import { el, fmt } from './shared.js';
import { googleFontsUrl } from './motion-lib.js';

// Reproductor de Intuition: dibuja el video en un canvas y, encima, el motion design de cada clip
// (lo calcula un worker aislado). Cada clip tiene su "ventana", que el humano mueve y redimensiona.
// Al exportar, el motion queda "quemado" en el video, en la ventana elegida.

const MAX_SIDE = 1920; // lado largo del video exportado
const HANG_MS = 2000; // si un cuadro tarda más, el código se colgó (bucle infinito): se reinicia el worker
const MIN_W = 0.1;
const MIN_H = 0.05;
const COLORS = ['#ff5a1f', '#3b82f6', '#10b981'];
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

// ---------- Tipografías: se bajan en la página y se le pasan al worker (que no tiene red) ----------
const fontCache = new Map(); // familia -> Promise<[{ family, weight, style, unicodeRange, buffer }]>
function fontFaces(family) {
  if (fontCache.has(family)) return fontCache.get(family);
  const job = (async () => {
    const url = googleFontsUrl(family);
    if (!url) return [];
    const css = await (await fetch(url)).text();
    const blocks = [...css.matchAll(/\/\*\s*([\w-]+)\s*\*\/\s*@font-face\s*\{([^}]*)\}/g)]
      .filter(([, subset]) => subset === 'latin' || subset === 'latin-ext');
    return Promise.all(blocks.map(async ([, , body]) => {
      const prop = (k) => (new RegExp(`${k}:\\s*([^;]+);`).exec(body) || [])[1]?.trim();
      const src = /url\(([^)]+)\)/.exec(body)?.[1];
      const buffer = await (await fetch(src)).arrayBuffer();
      return { family, weight: prop('font-weight') || '400', style: prop('font-style') || 'normal', unicodeRange: prop('unicode-range'), buffer };
    }));
  })().catch(() => []);
  fontCache.set(family, job);
  return job;
}

// video: { url, name, duration, width, height }
// clips: [{ id, start, end }]  · direction: sistema visual normalizado (con ventana por clip)
// onRevise(id, { feedback, error }) → Promise: pide al servidor rehacer un clip
export function createMotionPlayer({ video, clips: clipList, direction, onRevise }) {
  const scale = Math.min(1, MAX_SIDE / Math.max(video.width, video.height));
  const W = Math.round((video.width * scale) / 2) * 2;
  const H = Math.round((video.height * scale) / 2) * 2;
  const fonts = { display: direction.sistema.tipografias.display, text: direction.sistema.tipografias.texto };
  const palette = direction.sistema.paleta;

  const clips = clipList.map((c, i) => {
    const plan = direction.clips.find((p) => p.id === c.id) || {};
    return {
      ...c, index: i, color: COLORS[i % COLORS.length], plan,
      dur: c.end - c.start,
      box: { ...plan.ventana }, defaultBox: { ...plan.ventana },
      status: 'waiting', code: null, meta: null, error: null,
      bitmap: null, bitmapT: -1, inflight: false, wantT: null, lastKey: null, req: 0, timer: 0,
    };
  });
  const byId = new Map(clips.map((c) => [c.id, c]));
  let recording = false; // exportando: se oculta la ventana y no se puede editar

  // ---------- Estructura ----------
  const root = el('div', 'player intuition-player');
  const stage = el('div', 'stage motion-stage');
  stage.style.aspectRatio = `${W} / ${H}`;
  const canvas = el('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  const boxEl = el('div', 'motion-box');
  boxEl.hidden = true;
  const boxLabel = el('span', 'motion-box-label');
  boxEl.append(boxLabel, ...['nw', 'ne', 'sw', 'se'].map((k) => { const hnd = el('span', `motion-handle ${k}`); hnd.dataset.handle = k; return hnd; }));
  stage.append(canvas, boxEl);

  const vid = el('video');
  vid.src = video.url; vid.playsInline = true; vid.preload = 'auto';

  const controls = el('div', 'player-controls');
  const play = el('button', 'play-btn', '▶');
  play.type = 'button'; play.setAttribute('aria-label', 'Reproducir');
  const time = el('span', 'time', `0:00.0 / ${fmt(video.duration)}`);
  const showBox = el('label', 'box-toggle small');
  const showBoxInput = el('input');
  showBoxInput.type = 'checkbox'; showBoxInput.checked = true;
  showBox.append(showBoxInput, document.createTextNode(' Ver ventanas'));
  controls.append(play, time, showBox);

  const tl = el('div', 'tl motion-tl');
  const track = el('div', 'tl-row motion-track');
  const pct = (t) => `${(t / video.duration) * 100}%`;
  clips.forEach((c) => {
    const b = el('div', 'motion-range', `${c.index + 1}`);
    b.style.left = pct(c.start); b.style.width = pct(c.dur); b.style.setProperty('--c', c.color);
    b.title = `Clip ${c.index + 1} · ${fmt(c.start)}–${fmt(c.end)}`;
    track.append(b);
  });
  const head = el('div', 'tl-head');
  tl.append(track, head);

  const actions = el('div', 'actions');
  const exportBtn = el('button', 'primary', 'Exportar video con motion');
  exportBtn.type = 'button';
  const jsonBtn = el('button', 'ghost', 'Descargar código (JSON)');
  jsonBtn.type = 'button';
  actions.append(exportBtn, jsonBtn);
  const exportNote = el('p', 'muted small export-note');
  exportNote.hidden = true;

  const panels = el('div', 'motion-panels');
  root.append(stage, controls, tl, actions, exportNote, panels);

  // ---------- Worker (con protección contra cuelgues) ----------
  let worker = null;
  let fontList = [];
  const fontsReady = Promise.all([...new Set([fonts.display, fonts.text])].map(fontFaces)).then((lists) => {
    fontList = lists.flat();
    fontList.forEach((f) => worker.postMessage({ type: 'font', ...f })); // copia: se reusa si hay que reiniciar
    if (!fontList.length) note('No pude bajar las tipografías del sistema visual: se usan las del sistema.');
  });

  function startWorker() {
    worker = new Worker(new URL('./motion-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data }) => onWorker(data);
    worker.onerror = (e) => { e.preventDefault?.(); };
    fontList.forEach((f) => worker.postMessage({ type: 'font', ...f }));
    clips.filter((c) => c.code && c.status !== 'error').forEach(loadClip);
  }

  function loadClip(c) {
    c.status = 'loading';
    c.inflight = false; c.wantT = null; c.lastKey = null;
    worker.postMessage({ type: 'load', id: c.id, code: c.code, dur: c.dur, fonts, palette });
  }

  function onWorker(msg) {
    const c = byId.get(msg.id);
    if (!c) return;
    if (msg.type === 'loaded') {
      if (msg.error) fail(c, msg.error);
      else { c.status = 'ready'; renderPanel(c); probe(c); }
      return;
    }
    if (msg.type === 'frame' && msg.req === c.req) {
      clearTimeout(c.timer);
      c.inflight = false;
      if (msg.error) { if (c.status === 'ready') fail(c, msg.error); return; }
      c.bitmap?.close?.();
      c.bitmap = msg.bitmap; c.bitmapT = msg.t;
      if (vid.paused && !recording) draw();
      if (c.wantT !== null) { const t = c.wantT; c.wantT = null; request(c, t); }
    }
  }

  function fail(c, error) {
    c.status = 'error'; c.error = error;
    c.bitmap?.close?.(); c.bitmap = null;
    renderPanel(c);
    if (vid.paused) draw();
  }

  const boxPx = (c) => ({ x: c.box.x * W, y: c.box.y * H, w: Math.max(2, Math.round(c.box.w * W)), h: Math.max(2, Math.round(c.box.h * H)) });

  function request(c, t) {
    if (c.status !== 'ready') return;
    const { w, h } = boxPx(c);
    // Ese mismo cuadro ya se pidió (evita un bucle de redibujos con el video en pausa).
    const key = `${t.toFixed(4)}|${w}x${h}`;
    if (key === c.lastKey) return;
    if (c.inflight) { c.wantT = t; return; }
    c.lastKey = key;
    c.inflight = true;
    c.req++;
    worker.postMessage({ type: 'frame', id: c.id, req: c.req, t, w, h });
    clearTimeout(c.timer);
    c.timer = setTimeout(() => {
      // Se colgó (probablemente un bucle infinito): reiniciamos el worker sin este clip.
      worker.terminate();
      c.status = 'error';
      c.error = 'El código tardó demasiado en dibujar un cuadro (¿un bucle infinito?).';
      clips.forEach((k) => { k.inflight = false; k.wantT = null; k.lastKey = null; clearTimeout(k.timer); });
      renderPanel(c);
      startWorker();
    }, HANG_MS);
  }

  // Un cuadro de prueba apenas carga, para detectar errores sin esperar a que el humano le dé play.
  function probe(c) { request(c, c.dur * 0.5); }

  // ---------- Dibujo ----------
  const activeAt = (t) => clips.find((c) => t >= c.start && t < c.end) || null;

  function drawVideo() {
    const sw = vid.videoWidth; const sh = vid.videoHeight;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    if (!sw || !sh || vid.readyState < 2) return;
    const k = Math.max(W / sw, H / sh);
    ctx.drawImage(vid, (W - sw * k) / 2, (H - sh * k) / 2, sw * k, sh * k);
  }

  function draw() {
    const t = vid.currentTime || 0;
    drawVideo();
    const c = activeAt(t);
    if (c && c.status === 'ready') {
      const local = t - c.start;
      request(c, local);
      // El cuadro que llega del worker corresponde a un instante muy cercano (≤ 1 cuadro de desfase).
      if (c.bitmap && Math.abs(c.bitmapT - local) < 0.25) {
        const b = boxPx(c);
        ctx.drawImage(c.bitmap, b.x, b.y, b.w, b.h);
      }
    }
    time.textContent = `${fmt(t)} / ${fmt(video.duration)}`;
    head.style.left = pct(Math.min(t, video.duration));
    [...track.children].forEach((n, i) => n.classList.toggle('now', clips[i] === c));
    placeBox(c);
  }

  let raf = 0;
  function loop() {
    draw();
    raf = vid.paused && !recording ? 0 : requestAnimationFrame(loop);
  }
  const kick = () => { if (!raf) raf = requestAnimationFrame(loop); };

  vid.addEventListener('play', () => { play.textContent = '❚❚'; play.setAttribute('aria-label', 'Pausar'); kick(); });
  vid.addEventListener('pause', () => { play.textContent = '▶'; play.setAttribute('aria-label', 'Reproducir'); draw(); });
  vid.addEventListener('seeked', () => draw());
  vid.addEventListener('loadeddata', () => draw());
  play.onclick = () => { if (vid.paused) vid.play(); else vid.pause(); };
  tl.addEventListener('click', (e) => {
    if (recording) return;
    const r = tl.getBoundingClientRect();
    vid.currentTime = clamp((e.clientX - r.left) / r.width, 0, 1) * video.duration;
  });

  // ---------- Ventana: mover y redimensionar ----------
  let editing = null; // clip cuya ventana se muestra
  function placeBox(c) {
    const show = c && showBoxInput.checked && !recording;
    boxEl.hidden = !show;
    editing = show ? c : null;
    if (!show) return;
    boxEl.style.left = `${c.box.x * 100}%`;
    boxEl.style.top = `${c.box.y * 100}%`;
    boxEl.style.width = `${c.box.w * 100}%`;
    boxEl.style.height = `${c.box.h * 100}%`;
    boxEl.style.setProperty('--c', c.color);
    boxEl.classList.toggle('label-in', c.box.y < 0.04); // pegada arriba: la etiqueta va adentro
    boxLabel.textContent = `Clip ${c.index + 1}`;
  }
  showBoxInput.onchange = () => draw();

  boxEl.addEventListener('pointerdown', (e) => {
    if (!editing) return;
    e.preventDefault();
    e.stopPropagation();
    if (!vid.paused) vid.pause();
    const c = editing;
    const handle = e.target.dataset?.handle || 'move';
    const r = stage.getBoundingClientRect();
    const start = { ...c.box };
    const x0 = e.clientX; const y0 = e.clientY;
    boxEl.setPointerCapture(e.pointerId);
    boxEl.classList.add('dragging');
    const onMove = (ev) => {
      const dx = (ev.clientX - x0) / r.width;
      const dy = (ev.clientY - y0) / r.height;
      const b = { ...start };
      if (handle === 'move') {
        b.x = clamp(start.x + dx, 0, 1 - start.w);
        b.y = clamp(start.y + dy, 0, 1 - start.h);
      } else {
        if (handle.includes('w')) { b.x = clamp(start.x + dx, 0, start.x + start.w - MIN_W); b.w = start.x + start.w - b.x; }
        if (handle.includes('e')) b.w = clamp(start.w + dx, MIN_W, 1 - start.x);
        if (handle.includes('n')) { b.y = clamp(start.y + dy, 0, start.y + start.h - MIN_H); b.h = start.y + start.h - b.y; }
        if (handle.includes('s')) b.h = clamp(start.h + dy, MIN_H, 1 - start.y);
      }
      c.box = b;
      draw();
    };
    const onUp = () => {
      boxEl.removeEventListener('pointermove', onMove);
      boxEl.removeEventListener('pointerup', onUp);
      boxEl.removeEventListener('pointercancel', onUp);
      boxEl.classList.remove('dragging');
      renderPanel(c);
    };
    boxEl.addEventListener('pointermove', onMove);
    boxEl.addEventListener('pointerup', onUp);
    boxEl.addEventListener('pointercancel', onUp);
  });

  function focusClip(c) {
    vid.pause();
    vid.currentTime = c.start + Math.min(c.dur * 0.5, Math.max(0, c.dur - 0.7));
    showBoxInput.checked = true;
    stage.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  // ---------- Paneles por clip: estado, nota, ventana, código y pedido de cambios ----------
  const panelOf = new Map();
  function renderPanel(c) {
    let p = panelOf.get(c.id);
    if (!p) { p = el('section', 'motion-panel'); panelOf.set(c.id, p); panels.append(p); }
    p.style.setProperty('--c', c.color);
    p.replaceChildren();
    const headRow = el('div', 'motion-panel-head');
    const status = { waiting: 'Diseñando…', loading: 'Cargando…', ready: 'Listo', error: 'Con error', revising: 'Rehaciendo…' }[c.status];
    headRow.append(el('span', 'motion-dot', `${c.index + 1}`), el('strong', null, c.plan.idea || c.meta?.idea || `Clip ${c.index + 1}`), el('span', `motion-status ${c.status}`, status));
    p.append(headRow, el('div', 'muted small', `${fmt(c.start)} → ${fmt(c.end)} · ${c.dur.toFixed(1)} s · ventana ${Math.round(c.box.w * 100)}×${Math.round(c.box.h * 100)} %`));
    if (c.meta?.nota) p.append(el('p', 'motion-note', c.meta.nota));
    if (c.status === 'error') p.append(el('div', 'notice', c.error));

    const row = el('div', 'actions compact');
    const see = el('button', 'ghost', 'Ajustar ventana');
    see.type = 'button'; see.onclick = () => focusClip(c);
    const full = el('button', 'ghost', 'Pantalla completa');
    full.type = 'button'; full.onclick = () => { c.box = { x: 0, y: 0, w: 1, h: 1 }; focusClip(c); renderPanel(c); };
    const reset = el('button', 'ghost', 'Restablecer');
    reset.type = 'button'; reset.onclick = () => { c.box = { ...c.defaultBox }; focusClip(c); renderPanel(c); };
    row.append(see, full, reset);
    p.append(row);

    if (c.meta?.linea_de_tiempo?.length) {
      const chips = el('div', 'chips flush');
      c.meta.linea_de_tiempo.slice(0, 6).forEach((k) => chips.append(el('span', 'chip', `${Number(k.t || 0).toFixed(1)} s · ${k.que_pasa || ''}`)));
      p.append(chips);
    }
    if (c.code) {
      const det = el('details', 'motion-code');
      det.append(el('summary', null, 'Ver el código'), el('pre', null, c.code));
      p.append(det);
    }

    if (c.code || c.status === 'error') {
      const ask = el('textarea');
      ask.rows = 2;
      ask.placeholder = c.status === 'error' ? '(Opcional) algo más que quieras cambiar' : '¿Qué cambiarías? Ej. "más lento", "el texto más chico", "que entre desde la derecha"';
      const go = el('button', 'primary', c.status === 'error' ? 'Pedir que lo arregle' : 'Rehacer este clip');
      go.type = 'button';
      go.disabled = c.status === 'revising' || c.status === 'waiting';
      go.onclick = async () => {
        const feedback = ask.value.trim();
        const error = c.status === 'error' ? c.error : '';
        if (!feedback && !error) { ask.focus(); ask.placeholder = 'Contá qué querés cambiar.'; return; }
        const before = c.status;
        c.status = 'revising';
        renderPanel(c);
        try {
          await onRevise(c.id, { feedback, error, box: c.box, previous: { code: c.code, meta: c.meta } });
          if (c.status === 'revising') { c.status = before; renderPanel(c); }
        } catch (err) {
          c.status = before;
          renderPanel(c);
          p.append(el('div', 'notice', err.message));
        }
      };
      const goRow = el('div', 'actions');
      goRow.append(go);
      p.append(ask, goRow);
    }
  }
  clips.forEach(renderPanel);

  function note(text) { exportNote.hidden = false; exportNote.textContent = text; }

  // ---------- Exportación: el motion queda quemado en el video ----------
  let recorder = null;
  let graph = null;
  function audioGraph() {
    if (graph) return graph;
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    const source = ac.createMediaElementSource(vid);
    const dest = ac.createMediaStreamDestination();
    source.connect(ac.destination);
    source.connect(dest);
    graph = { ac, dest };
    return graph;
  }

  exportBtn.onclick = async () => {
    if (recorder) { recorder.stop(); return; }
    if (!window.MediaRecorder || !canvas.captureStream) return note('Este navegador no puede exportar video. Probá con Chrome, Edge o Safari actualizados.');
    const pending = clips.filter((c) => c.status !== 'ready');
    if (pending.length && !confirm(`${pending.map((c) => `Clip ${c.index + 1}`).join(', ')} todavía no está${pending.length > 1 ? 'n' : ''} listo${pending.length > 1 ? 's' : ''}: se exporta${pending.length > 1 ? 'n' : ''} sin motion. ¿Seguir?`)) return;
    const { ac, dest } = audioGraph();
    await ac.resume();
    const mime = ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
      .find((m) => MediaRecorder.isTypeSupported(m)) || '';
    const stream = new MediaStream([...canvas.captureStream(30).getVideoTracks(), ...dest.stream.getAudioTracks()]);
    const chunks = [];
    recorder = new MediaRecorder(stream, { mimeType: mime || undefined, videoBitsPerSecond: W * H > 1e6 ? 12_000_000 : 8_000_000 });
    recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    const onTime = () => { exportBtn.textContent = `Grabando… ${Math.round((vid.currentTime / video.duration) * 100)}% · detener`; };
    const onEnd = () => recorder?.state === 'recording' && recorder.stop();
    recorder.onstop = () => {
      vid.removeEventListener('timeupdate', onTime);
      vid.removeEventListener('ended', onEnd);
      vid.pause();
      recording = false;
      const type = recorder.mimeType || mime || 'video/webm';
      recorder = null;
      exportBtn.textContent = 'Exportar video con motion';
      [play, showBoxInput].forEach((b) => { b.disabled = false; });
      const blob = new Blob(chunks, { type });
      const ext = type.includes('mp4') ? 'mp4' : 'webm';
      const a = el('a', 'download', `Descargar video (${ext.toUpperCase()}, ${(blob.size / 1024 / 1024).toFixed(1)} MB)`);
      a.href = URL.createObjectURL(blob);
      a.download = `${video.name.replace(/\.[^.]+$/, '')}-intuition.${ext}`;
      exportNote.hidden = false;
      exportNote.replaceChildren(a);
      a.click();
      draw();
    };
    vid.pause();
    vid.currentTime = 0;
    await new Promise((r) => vid.addEventListener('seeked', r, { once: true }));
    // Que cada clip tenga listo su primer cuadro antes de arrancar.
    clips.forEach((c) => request(c, 0));
    await new Promise((r) => setTimeout(r, 300));
    recording = true;
    [play, showBoxInput].forEach((b) => { b.disabled = true; });
    note('Se graba en tiempo real: dejá esta pestaña visible hasta que termine.');
    vid.addEventListener('timeupdate', onTime);
    vid.addEventListener('ended', onEnd);
    recorder.start(500);
    await vid.play();
    kick();
  };

  jsonBtn.onclick = () => {
    const data = {
      video: { name: video.name, duration: video.duration, width: video.width, height: video.height },
      sistema: direction.sistema,
      clips: clips.map((c) => ({ id: c.id, inicio: c.start, fin: c.end, ventana: c.box, idea: c.meta?.idea || c.plan.idea, codigo: c.code })),
    };
    const a = el('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    a.download = `${video.name.replace(/\.[^.]+$/, '')}-motion.json`;
    a.click();
  };

  startWorker();
  vid.load();

  return {
    root,
    // Llega (o se rehace) el código de un clip.
    async setMotion(view) {
      const c = byId.get(view.id);
      if (!c) return;
      c.code = view.code;
      c.meta = view;
      c.error = null;
      c.bitmap?.close?.(); c.bitmap = null;
      c.status = 'loading';
      renderPanel(c);
      await fontsReady;
      loadClip(c);
    },
    failClip(id, text) { const c = byId.get(id); if (c && !c.code) fail(c, text); },
    // Estado actual de un clip para pedir una revisión.
    clip: (id) => byId.get(id),
  };
}
