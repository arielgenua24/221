import { el, fmt } from './shared.js';
import { googleFontsUrl } from './motion-lib.js';
import { playSound } from './sound-lib.js';
import { createCineRenderer, evalTreatment } from './cine-lib.js';

// Reproductor de Intuition: dibuja el video en un canvas y, encima, el motion design de cada clip
// (lo calcula un worker aislado). Cada clip tiene su "ventana", que el humano mueve y redimensiona.
// Cada clip trae además una partitura de efectos (sintetizados en la página), que suena encima del audio original.
// Al exportar, el motion queda "quemado" en el video, en la ventana elegida, con sus sonidos.
// En los clips de "Video IA + texto", durante el clip se ve la toma generada (muda: sigue el audio original) y encima, las palabras.
// En los clips de "Cinematic Pro", el video real (o su toma re-filmada por IA) pasa por el tratamiento del Director de Fotografía
// (grade, luz motivada, cámara virtual, textura) en WebGL, cuadro a cuadro: se ve igual en la vista previa y en el archivo.

const MAX_SIDE = 1920; // lado largo del video exportado
const SFX_AHEAD = 0.25; // segundos de efectos que se programan por adelantado
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
      // Video IA: plan del Director de Video IA y la toma generada ({ status, url, el, error }).
      vplan: null, ai: c.mode === 'ai' ? { status: 'planning', url: null, el: null, error: null, lastSeek: null } : null,
      // Cinematic Pro: tratamiento, intensidad elegida por el humano y la toma re-filmada (misma forma que `ai`).
      cine: c.mode === 'cine' ? { tr: null, intensity: 1, take: { status: 'none', url: null, el: null, error: null, lastSeek: null } } : null,
      bitmap: null, bitmapT: -1, inflight: false, wantT: null, lastKey: null, req: 0, timer: 0,
    };
  });
  const byId = new Map(clips.map((c) => [c.id, c]));
  let recording = false; // exportando: se oculta la ventana y no se puede editar
  let compare = false; // "ver el original": mientras se mantiene apretado, sin tratamiento
  let cineGL; // renderer WebGL de Cinematic Pro (se crea con el primer tratamiento; null si no hay WebGL)
  const takeOf = (c) => (c?.ai?.status === 'ready' ? c.ai : c?.cine?.take?.status === 'ready' ? c.cine.take : null);

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
  const sfxBox = el('label', 'box-toggle small');
  const sfxOn = el('input');
  sfxOn.type = 'checkbox'; sfxOn.checked = true;
  const sfxVol = el('input', 'sfx-vol');
  sfxVol.type = 'range'; sfxVol.min = '0'; sfxVol.max = '1.5'; sfxVol.step = '0.05'; sfxVol.value = '1';
  sfxVol.setAttribute('aria-label', 'Volumen de los efectos');
  sfxBox.append(sfxOn, document.createTextNode(' Efectos de sonido '), sfxVol);
  controls.append(play, time, showBox, sfxBox);

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
    if (c.status !== 'ready' || !c.code) return;
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

  // Durante un clip de video IA (o re-filmado) con la toma lista, se dibuja la toma en lugar del video original.
  // En Cinematic Pro, la imagen pasa además por el tratamiento (WebGL).
  function drawVideo(c, t) {
    const a = takeOf(c);
    const src = a && a.el.readyState >= 2 ? a.el : vid;
    const sw = src.videoWidth; const sh = src.videoHeight;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    if (!sw || !sh || src.readyState < 2) return;
    if (c?.cine?.tr && c.status === 'ready' && cineGL && !(compare && !recording)) {
      const parts = src === vid ? 'completo' : c.cine.tr.refilmar.sobre_toma;
      try {
        if (cineGL.render(src, evalTreatment(c.cine.tr, t - c.start, c.dur, { intensity: c.cine.intensity, parts }))) {
          ctx.drawImage(cineGL.canvas, 0, 0, W, H);
          return;
        }
      } catch { /* si WebGL falla en un cuadro, se ve el original */ }
    }
    const k = Math.max(W / sw, H / sh);
    ctx.drawImage(src, (W - sw * k) / 2, (H - sh * k) / 2, sw * k, sh * k);
  }

  // La toma generada sigue al reloj del video original (que es el que lleva el audio).
  function syncAi(active, t) {
    for (const c of clips) {
      const a = takeOf(c);
      if (!a) continue;
      const e = a.el;
      const local = t - c.start;
      if (c === active) {
        e.playbackRate = vid.playbackRate;
        if (vid.paused && !recording) {
          if (!e.paused) e.pause();
          if (Math.abs(e.currentTime - local) > 0.03 && a.lastSeek !== local) { a.lastSeek = local; e.currentTime = local; }
        } else {
          if (Math.abs(e.currentTime - local) > 0.25) e.currentTime = local;
          if (e.paused) e.play().catch(() => {});
        }
      } else {
        if (!e.paused) e.pause();
        // Se acerca el clip: la toma espera en su primer cuadro.
        if (local < 0 && local > -1.5 && e.currentTime > 0.05) e.currentTime = 0;
      }
    }
  }

  function draw() {
    const t = vid.currentTime || 0;
    const c = activeAt(t);
    syncAi(c, t);
    drawVideo(c, t);
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

  // ---------- Efectos de sonido ----------
  // Se programan de a poco, SFX_AHEAD segundos por delante del video: así siguen al video aunque su reloj se desvíe.
  let sfxCursor = null; // hasta qué segundo del video ya están programados
  const sfxLive = new Set(); // funciones que cortan los efectos que están sonando
  const sfxLevel = () => (sfxOn.checked ? Number(sfxVol.value) : 0);

  function stopSfx() {
    sfxCursor = null;
    sfxLive.forEach((stop) => stop());
    sfxLive.clear();
  }

  function scheduleSfx() {
    if (!graph || vid.paused || vid.playbackRate !== 1 || !sfxLevel()) return;
    const { ac, sfx } = graph;
    if (ac.state !== 'running') return;
    const now = vid.currentTime;
    const from = sfxCursor ?? now - 0.03; // al arrancar, suena lo que empezaba justo ahora
    const to = now + SFX_AHEAD;
    if (to <= from) return;
    for (const c of clips) {
      if (c.status !== 'ready' || !c.meta?.sonido?.length || c.end <= from || c.start >= to) continue;
      for (const ev of c.meta.sonido) {
        const at = c.start + ev.t;
        if (at < from || at >= to || at >= c.end) continue;
        const stop = playSound(ac, sfx, ev, ac.currentTime + Math.max(0, at - now));
        sfxLive.add(stop);
        setTimeout(() => sfxLive.delete(stop), (at - now + ev.dur + 1) * 1000);
      }
    }
    sfxCursor = to;
  }

  function applySfxLevel() {
    if (!graph) return;
    graph.sfx.gain.setTargetAtTime(sfxLevel(), graph.ac.currentTime, 0.02);
  }
  sfxOn.onchange = applySfxLevel;
  sfxVol.oninput = () => { if (!sfxOn.checked) sfxOn.checked = true; applySfxLevel(); };

  let raf = 0;
  function loop() {
    draw();
    scheduleSfx();
    raf = vid.paused && !recording ? 0 : requestAnimationFrame(loop);
  }
  const kick = () => { if (!raf) raf = requestAnimationFrame(loop); };

  vid.addEventListener('play', () => {
    play.textContent = '❚❚'; play.setAttribute('aria-label', 'Pausar');
    audioGraph().ac.resume();
    stopSfx();
    kick();
  });
  vid.addEventListener('pause', () => { play.textContent = '▶'; play.setAttribute('aria-label', 'Reproducir'); stopSfx(); draw(); });
  vid.addEventListener('seeking', () => stopSfx());
  vid.addEventListener('ratechange', () => stopSfx());
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
    const show = c && !c.cine && showBoxInput.checked && !recording;
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
    if (c.cine) return renderCinePanel(c, p);
    p.style.setProperty('--c', c.color);
    p.replaceChildren();
    const headRow = el('div', 'motion-panel-head');
    const status = { waiting: c.ai ? 'Esperando la toma…' : 'Diseñando…', loading: 'Cargando…', ready: 'Listo', error: 'Con error', revising: 'Rehaciendo…' }[c.status];
    headRow.append(el('span', 'motion-dot', `${c.index + 1}`), el('strong', null, c.plan.idea || c.meta?.idea || `Clip ${c.index + 1}`), el('span', `motion-status ${c.status}`, status));
    p.append(headRow, el('div', 'muted small', `${fmt(c.start)} → ${fmt(c.end)} · ${c.dur.toFixed(1)} s · ventana ${Math.round(c.box.w * 100)}×${Math.round(c.box.h * 100)} %`));
    if (c.ai) {
      const label = { planning: 'dirigiendo la toma…', storyboard: 'esperando tu aprobación del storyboard', generating: `generando la toma…${c.ai.elapsed ? ` ${Math.round(c.ai.elapsed)} s` : ''}`, loading: 'cargando la toma…', ready: 'toma lista', demo: 'modo demo: se ve el video original', error: 'la toma falló: se ve el video original' }[c.ai.status];
      p.append(el('div', `ai-line ${c.ai.status}`, `🎥 Video IA${c.vplan ? ` · ${c.vplan.modelLabel}` : ''} · ${label}`));
      if (c.ai.status === 'error' && c.ai.error) p.append(el('div', 'notice', c.ai.error));
      if (c.vplan) {
        const det = el('details', 'motion-code');
        det.append(el('summary', null, 'Ver la dirección de la toma'));
        if (c.vplan.storyboard) { const img = el('img', 'storyboard-img'); img.src = c.vplan.storyboard; img.alt = 'Storyboard'; det.append(img); }
        det.append(el('pre', null, [c.vplan.toma, c.vplan.camara, c.vplan.prompt_video].filter(Boolean).join('\n\n')));
        p.append(det);
      }
    }
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
    if (c.meta?.sonido?.length) {
      const chips = el('div', 'chips flush');
      c.meta.sonido.slice(0, 8).forEach((k) => chips.append(el('span', 'chip sound-chip', `♪ ${k.t.toFixed(2)} s · ${k.efecto}`)));
      if (c.meta.sonido.length > 8) chips.append(el('span', 'chip sound-chip', `+${c.meta.sonido.length - 8}`));
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
      ask.placeholder = c.status === 'error' ? '(Opcional) algo más que quieras cambiar' : c.ai ? '¿Qué cambiarías del texto? Ej. "más chico", "otra palabra", "que entre más tarde"' : '¿Qué cambiarías? Ej. "más lento", "el texto más chico", "que entre desde la derecha"';
      const go = el('button', 'primary', c.status === 'error' ? 'Pedir que lo arregle' : c.ai ? 'Rehacer el texto' : 'Rehacer este clip');
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
  // ---------- Panel de Cinematic Pro: diagnóstico, reglas de la biblioteca, intensidad, antes/después, re-filmado ----------
  function renderCinePanel(c, p) {
    p.style.setProperty('--c', c.color);
    p.classList.add('cine-panel');
    p.replaceChildren();
    const tr = c.cine.tr;
    const headRow = el('div', 'motion-panel-head');
    const status = { waiting: 'Mirando el clip…', ready: 'Listo', error: 'Con error', revising: 'Rehaciendo…' }[c.status] || 'Listo';
    headRow.append(el('span', 'motion-dot', `${c.index + 1}`), el('strong', null, `🎞️ ${tr?.intencion || c.plan.idea || 'Cinematic Pro'}`), el('span', `motion-status ${c.status}`, status));
    p.append(headRow, el('div', 'muted small', `${fmt(c.start)} → ${fmt(c.end)} · ${c.dur.toFixed(1)} s · Director de Fotografía`));
    if (c.status === 'error') p.append(el('div', 'notice', c.error));
    if (!tr) return;
    if (!cineGL) p.append(el('div', 'notice', 'Este navegador no tiene WebGL: el tratamiento no se puede mostrar ni exportar.'));

    // Re-filmado con IA
    const take = c.cine.take;
    if (tr.refilmar.recomendado || take.status !== 'none') {
      const label = { none: 'propuesto: esperando tu decisión', uploading: 'enviando el clip…', generating: `re-filmando…${take.elapsed ? ` ${Math.round(take.elapsed)} s` : ''}`, loading: 'cargando la toma…', ready: `toma lista · encima: ${tr.refilmar.sobre_toma}`, demo: 'modo demo: se ve tu video con el tratamiento', skipped: 'no re-filmado: se ve tu video con el tratamiento', error: 'falló: se ve tu video con el tratamiento' }[take.status];
      p.append(el('div', `ai-line ${take.status}`, `🎥 Re-filmar con IA · ${label}`));
      if (take.status === 'error' && take.error) p.append(el('div', 'notice', take.error));
    }
    if (tr.nota) p.append(el('p', 'motion-note', tr.nota));

    // Intensidad + antes/después
    const row = el('div', 'cine-controls');
    const lab = el('label', 'small cine-intensity');
    const range = el('input');
    range.type = 'range'; range.min = '0'; range.max = '1.5'; range.step = '0.05'; range.value = String(c.cine.intensity);
    range.setAttribute('aria-label', 'Intensidad del tratamiento');
    const val = el('span', 'muted', `${Math.round(c.cine.intensity * 100)} %`);
    range.oninput = () => { c.cine.intensity = Number(range.value); val.textContent = `${Math.round(c.cine.intensity * 100)} %`; if (vid.paused) draw(); };
    lab.append(document.createTextNode('Intensidad '), range, val);
    const hold = el('button', 'ghost', 'Mantener: ver original');
    hold.type = 'button';
    const on = (e) => { e.preventDefault(); compare = true; if (vid.paused) draw(); };
    const off = () => { if (!compare) return; compare = false; if (vid.paused) draw(); };
    hold.addEventListener('pointerdown', on);
    ['pointerup', 'pointerleave', 'pointercancel'].forEach((k) => hold.addEventListener(k, off));
    const see = el('button', 'ghost', 'Ver el clip');
    see.type = 'button'; see.onclick = () => focusClip(c);
    row.append(lab, hold, see);
    p.append(row);

    const facts = el('div', 'facts');
    const fact = (label, value) => {
      if (!value || (Array.isArray(value) && !value.length)) return;
      const f = el('div', 'fact');
      f.append(el('strong', null, label), document.createTextNode(Array.isArray(value) ? value.join(' · ') : value));
      facts.append(f);
    };
    tr.diagnostico.forEach((d) => fact(d.componente || 'Diagnóstico', `${d.observacion}${d.decision ? ` → ${d.decision}` : ''}`));
    fact('Luz', tr.luz.tipo !== 'ninguna' ? `${tr.luz.tipo}${tr.luz.motivacion ? ` · ${tr.luz.motivacion}` : ''}` : '');
    fact('Cámara', `${tr.camara.movimiento}${tr.camara.handheld ? ` · en mano ${Math.round(tr.camara.handheld * 100)} %` : ''}`);
    p.append(facts);

    if (tr.reglas.length) {
      const chips = el('div', 'chips flush');
      tr.reglas.forEach((id) => {
        const chip = el('span', 'chip rule-chip', id);
        chip.title = tr.por_que_reglas.find((r) => r.id === id)?.por_que || '';
        chips.append(chip);
      });
      p.append(chips);
    }
    const det = el('details', 'motion-code');
    det.append(el('summary', null, 'Ver el tratamiento (JSON)'), el('pre', null, JSON.stringify({ grade: tr.grade, luz: tr.luz, camara: tr.camara, transicion: tr.transicion, refilmar: tr.refilmar }, null, 2)));
    p.append(det);

    const ask = el('textarea');
    ask.rows = 2;
    ask.placeholder = '¿Qué cambiarías? Ej. "menos naranja en la piel", "sin zoom", "más contraste", "luz más fría"';
    const go = el('button', 'primary', 'Rehacer el tratamiento');
    go.type = 'button';
    go.disabled = c.status === 'revising';
    go.onclick = async () => {
      const feedback = ask.value.trim();
      if (!feedback) { ask.focus(); ask.placeholder = 'Contá qué querés cambiar.'; return; }
      c.status = 'revising';
      renderPanel(c);
      try {
        await onRevise(c.id, { feedback, previous: { treatment: tr } });
        if (c.status === 'revising') { c.status = 'ready'; renderPanel(c); }
      } catch (err) {
        c.status = 'ready';
        renderPanel(c);
        p.append(el('div', 'notice', err.message));
      }
    };
    const goRow = el('div', 'actions');
    goRow.append(go);
    p.append(ask, goRow);
  }

  function ensureCineGL() {
    if (cineGL !== undefined) return;
    try { cineGL = createCineRenderer(W, H); } catch { cineGL = null; }
  }

  clips.forEach(renderPanel);

  function note(text) { exportNote.hidden = false; exportNote.textContent = text; }

  // ---------- Exportación: el motion queda quemado en el video ----------
  let recorder = null;
  let graph = null;
  // El audio original y los efectos pasan por el mismo grafo: se oyen igual en la vista previa y en el archivo.
  function audioGraph() {
    if (graph) return graph;
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    const source = ac.createMediaElementSource(vid);
    const dest = ac.createMediaStreamDestination();
    source.connect(ac.destination);
    source.connect(dest);
    const sfx = ac.createGain();
    sfx.gain.value = sfxLevel();
    sfx.connect(ac.destination);
    sfx.connect(dest);
    graph = { ac, dest, sfx };
    return graph;
  }

  exportBtn.onclick = async () => {
    if (recorder) { recorder.stop(); return; }
    if (!window.MediaRecorder || !canvas.captureStream) return note('Este navegador no puede exportar video. Probá con Chrome, Edge o Safari actualizados.');
    const aiPending = clips.filter((c) => (c.ai && ['planning', 'storyboard', 'generating', 'loading'].includes(c.ai.status)) || (c.cine && ['uploading', 'generating', 'loading'].includes(c.cine.take.status)));
    if (aiPending.length && !confirm(`La toma de ${aiPending.map((c) => `Clip ${c.index + 1}`).join(', ')} todavía no está: se exporta con el video original en ese tramo. ¿Seguir?`)) return;
    const pending = clips.filter((c) => c.status !== 'ready');
    if (pending.length && !confirm(`${pending.map((c) => `Clip ${c.index + 1}`).join(', ')} todavía no está${pending.length > 1 ? 'n' : ''} listo${pending.length > 1 ? 's' : ''}: se exporta${pending.length > 1 ? 'n' : ''} sin motion. ¿Seguir?`)) return;
    const { ac, dest } = audioGraph();
    await ac.resume();
    stopSfx();
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
      [play, showBoxInput, sfxOn, sfxVol].forEach((b) => { b.disabled = false; });
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
    [play, showBoxInput, sfxOn, sfxVol].forEach((b) => { b.disabled = true; });
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
      clips: clips.map((c) => ({
        id: c.id, inicio: c.start, fin: c.end, ventana: c.box, idea: c.meta?.idea || c.plan.idea, sonido: c.meta?.sonido || [], codigo: c.code,
        ...(c.cine?.tr ? { cinematic_pro: { intensidad: c.cine.intensity, tratamiento: c.cine.tr, toma_refilmada: c.cine.take.file || null } } : {}),
        ...(c.ai ? { video_ia: { modelo: c.vplan?.modelLabel, toma: c.vplan?.toma, prompt: c.ai.prompt || c.vplan?.prompt_video, storyboard: c.vplan?.storyboard, archivo: c.ai.file } } : {}),
      })),
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
    failClip(id, text) { const c = byId.get(id); if (c && !c.code && !c.cine?.tr) fail(c, text); },
    // Video IA: llega el plan (storyboard para aprobar), cambia el estado de la generación, o llega la toma.
    setPlan(plan) {
      const c = byId.get(plan.id);
      if (!c?.ai) return;
      c.vplan = plan;
      if (c.ai.status === 'planning' || c.ai.status === 'storyboard') c.ai.status = 'storyboard';
      renderPanel(c);
    },
    aiStatus(id, status, elapsed) {
      const c = byId.get(id);
      if (!c?.ai || ['ready', 'loading', 'error', 'demo'].includes(c.ai.status)) return;
      c.ai.status = status; c.ai.elapsed = elapsed;
      renderPanel(c);
    },
    async setAiVideo({ id, url, demo, prompt }) {
      const c = byId.get(id);
      if (!c?.ai) return;
      c.ai.prompt = prompt;
      if (!url) { c.ai.status = demo ? 'demo' : 'error'; renderPanel(c); return; }
      c.ai.status = 'loading'; c.ai.file = url;
      renderPanel(c);
      try {
        // Se baja entero: así se puede adelantar y retroceder sin depender del servidor.
        const res = await fetch(url);
        if (!res.ok) throw new Error(`No pude bajar la toma (${res.status}).`);
        const blobUrl = URL.createObjectURL(await res.blob());
        const e = el('video');
        e.muted = true; e.playsInline = true; e.preload = 'auto'; e.src = blobUrl;
        await new Promise((resolve, reject) => {
          e.addEventListener('loadeddata', resolve, { once: true });
          e.addEventListener('error', () => reject(new Error('El navegador no pudo leer la toma generada.')), { once: true });
        });
        e.addEventListener('seeked', () => { if (vid.paused && !recording) draw(); });
        Object.assign(c.ai, { status: 'ready', url: blobUrl, el: e, lastSeek: null });
      } catch (err) {
        Object.assign(c.ai, { status: 'error', error: err.message });
      }
      renderPanel(c);
      if (vid.paused) draw();
    },
    failVideo(id, text, kind) {
      const c = byId.get(id);
      if (!c?.ai || kind !== 'video') return; // un storyboard que falla no frena nada: se aprueba sobre el cuadro base
      Object.assign(c.ai, { status: 'error', error: text });
      renderPanel(c);
    },
    // Cinematic Pro: llega (o se rehace) el tratamiento del Director de Fotografía.
    setCine(view) {
      const c = byId.get(view.id);
      if (!c?.cine) return;
      ensureCineGL();
      const { id, revision, ...tr } = view;
      // En una revisión se conserva lo que ya se decidió sobre el re-filmado.
      if (revision && c.cine.tr) tr.refilmar = { ...c.cine.tr.refilmar, sobre_toma: tr.refilmar?.sobre_toma || c.cine.tr.refilmar.sobre_toma };
      c.cine.tr = tr;
      c.status = 'ready'; c.error = null;
      renderPanel(c);
      if (vid.paused) draw();
    },
    cineStatus(id, status, elapsed) {
      const c = byId.get(id);
      // Un error no es final: el humano puede reintentar el re-filmado.
      if (!c?.cine || ['ready', 'loading', 'demo', 'skipped'].includes(c.cine.take.status)) return;
      Object.assign(c.cine.take, { status, elapsed, error: status === 'error' ? c.cine.take.error : null });
      renderPanel(c);
    },
    async setCineVideo({ id, url, demo, skipped }) {
      const c = byId.get(id);
      if (!c?.cine) return;
      const take = c.cine.take;
      if (!url) { take.status = skipped ? 'skipped' : demo ? 'demo' : 'error'; renderPanel(c); return; }
      Object.assign(take, { status: 'loading', file: url });
      renderPanel(c);
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`No pude bajar la toma (${res.status}).`);
        const blobUrl = URL.createObjectURL(await res.blob());
        const e = el('video');
        e.muted = true; e.playsInline = true; e.preload = 'auto'; e.src = blobUrl;
        await new Promise((resolve, reject) => {
          e.addEventListener('loadeddata', resolve, { once: true });
          e.addEventListener('error', () => reject(new Error('El navegador no pudo leer la toma re-filmada.')), { once: true });
        });
        e.addEventListener('seeked', () => { if (vid.paused && !recording) draw(); });
        Object.assign(take, { status: 'ready', url: blobUrl, el: e, lastSeek: null });
      } catch (err) {
        Object.assign(take, { status: 'error', error: err.message });
      }
      renderPanel(c);
      if (vid.paused) draw();
    },
    failCineVideo(id, text) {
      const c = byId.get(id);
      if (!c?.cine) return;
      Object.assign(c.cine.take, { status: 'error', error: text });
      renderPanel(c);
    },
    // Estado actual de un clip para pedir una revisión.
    clip: (id) => byId.get(id),
  };
}
