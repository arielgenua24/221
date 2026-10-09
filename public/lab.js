import { el, streamEvents } from './shared.js';
import { createStudio } from './intuition.js';
import { loadPhoto } from './media.js';
import { newRun, runMetrics, modelStats, experimentStatus, money, secs, IDENTITY, isAdjusted } from './lab-stats.js';
import * as store from './lab-store.js';

// Pestaña Laboratorio · Motion Design.
// Dos modelos hacen el mismo trabajo (mismo video, zonas, contexto, referencias e instrucciones) con el mismo harness
// de Remotion; cada uno corre por separado y su resultado se reproduce en un iframe aislado. El humano compara,
// evalúa y todo queda en el historial local (ver lab-store.js).

const $ = (id) => document.getElementById(id);
const MAX_RUNTIME_FIXES = 2; // correcciones automáticas seguidas por errores al reproducir
const SIDES = ['A', 'B'];
const REASON = { initial: 'Primera ejecución', compile: 'Corrección (no compilaba)', runtime: 'Corrección (error al reproducir)', feedback: 'Revisión pedida por vos', tools: 'Usando herramientas' };
// El código v1 renderizaba el video él mismo (antes de que el entorno lo pusiera debajo): no se puede escalar aparte.
const isLegacy = (code) => /\bvideoSrc\b/.test(code || '');

let info = { mock: false, models: [], harness: {} };
let started = false;
let exp = null; // experimento abierto (se guarda en localStorage)
let frozen = null; // { brief, payload, file }: lo que recibieron los agentes en este experimento (las revisiones usan esto)
let briefRefs = []; // { key, name, url, thumb, status }
let seq = 0;
const error = (msg) => { const e = $('lab-error'); e.textContent = msg || ''; e.hidden = !msg; };

// ---------- Estructura ----------
const root = $('lab-experiment');
const toolbar = el('div', 'lab-toolbar');
const nameInput = el('input', 'lab-name');
nameInput.type = 'text'; nameInput.maxLength = 80; nameInput.placeholder = 'Nombre del experimento'; nameInput.setAttribute('aria-label', 'Nombre del experimento');
nameInput.oninput = () => { if (exp) { exp.name = nameInput.value.trim() || exp.name; persist(); } };
const runBtn = el('button', 'primary lab-run', 'Ejecutar experimento');
runBtn.type = 'button';
const newBtn = el('button', 'small-btn', 'Nuevo experimento');
newBtn.type = 'button';
newBtn.title = 'Empezar de cero (el experimento actual queda en el historial)';
const harnessPill = el('span', 'pill lab-harness');
toolbar.append(nameInput, harnessPill, newBtn, runBtn);
const hint = el('p', 'muted small lab-hint');
const setupNote = el('p', 'notice lab-setup');
setupNote.hidden = true;

const grid = el('div', 'lab-grid');
const center = el('div', 'lab-center');
const studioBox = el('section', 'studio lab-studio');
studioBox.append(el('div', 'decision-label', '1 · Clip y zonas'), el('p', 'muted small', 'Subí un clip y marcá las zonas donde va el motion design (el mismo marcador de ✨ Intuition).'));
const pickVideo = el('label', 'primary lab-pick');
const videoInput = el('input');
videoInput.type = 'file'; videoInput.accept = 'video/*'; videoInput.hidden = true;
videoInput.onchange = () => { if (videoInput.files[0]) studio.setVideo(videoInput.files[0]); videoInput.value = ''; };
pickVideo.append(videoInput, document.createTextNode('Subir clip de video'));
studioBox.append(pickVideo);

const brief = el('section', 'lab-card lab-brief');
const field = (label, help, node) => {
  const w = el('label', 'lab-field');
  w.append(el('span', 'lab-field-label', label), ...(help ? [el('span', 'muted small', help)] : []), node);
  return w;
};
const contextInput = el('textarea');
contextInput.rows = 4;
contextInput.placeholder = 'De qué trata el video, para quién es, qué tiene que lograr, marca, tono…';
const instructionsInput = el('textarea');
instructionsInput.rows = 5;
instructionsInput.placeholder = 'Movimientos, efectos, transiciones, tipografía, colores, ritmo… Ej. "títulos grandes en Syne que entran palabra por palabra con un resorte suave; acento naranja; nada encima de la cara"';
const refsBox = el('div', 'thumbs lab-refs');
brief.append(
  el('div', 'decision-label', '2 · Brief compartido'),
  el('p', 'muted small', 'Se escribe una vez y los dos agentes reciben exactamente lo mismo.'),
  field('Contexto', null, contextInput),
  el('span', 'lab-field-label', 'Referencias visuales'),
  el('span', 'muted small', 'Imágenes del estilo o las animaciones que querés conseguir.'),
  refsBox,
  field('Instrucciones', null, instructionsInput),
);
contextInput.oninput = refresh;
instructionsInput.oninput = refresh;

const compare = el('section', 'lab-card lab-compare');
compare.hidden = true;
center.append(studioBox, brief, compare);

const sides = Object.fromEntries(SIDES.map((k) => [k, createSide(k)]));
grid.append(sides.A.node, center, sides.B.node);
root.append(toolbar, hint, setupNote, grid);

const studio = createStudio({
  mount: studioBox,
  label: '1 · Clip y zonas',
  onError: error,
  onChange: () => refresh(),
});

const datalist = el('datalist');
datalist.id = 'lab-model-list';
document.body.append(datalist);

// ---------- Un lado del experimento (Modelo A o B) ----------
function createSide(key) {
  const node = el('section', 'lab-side');
  node.dataset.side = key;
  const head = el('div', 'lab-side-head');
  const badge = el('span', 'lab-badge', key);
  const model = el('input', 'lab-model');
  model.type = 'text'; model.setAttribute('list', 'lab-model-list'); model.spellcheck = false; model.autocomplete = 'off';
  model.placeholder = 'proveedor/modelo (OpenRouter)';
  model.setAttribute('aria-label', `Modelo ${key}`);
  head.append(badge, model);
  const price = el('p', 'muted small lab-price');
  model.oninput = () => { showPrice(); store.setPrefs({ [`model${key}`]: model.value.trim() }); side.render(); refresh(); };

  const resultOf = el('p', 'small lab-result-of');
  const stage = el('div', 'lab-stage');
  const status = el('div', 'lab-status');
  const live = el('details', 'lab-live');
  live.append(el('summary', null, 'Respuesta del modelo'));
  const out = el('pre', 'lab-out');
  live.append(out);
  const metrics = el('dl', 'lab-metrics');
  const evalBox = el('div', 'lab-eval');
  // Arriba del video: qué buscó, con qué referencias se quedó y qué imágenes generó.
  const refsBar = el('div', 'lab-refsbar');
  // Feedback continuo: una conversación con el agente; lo que escribís mientras trabaja queda en cola.
  const feedback = el('div', 'lab-feedback');
  const thread = el('div', 'lab-thread');
  const fbText = el('textarea');
  fbText.rows = 2;
  fbText.placeholder = 'Qué mejorar o agregar. Ej. "el título más grande y que entre desde abajo", "sumá el precio al final". ⌘/Ctrl + Enter para enviar.';
  const momentBtn = el('button', 'small-btn', '+ Momento actual');
  momentBtn.type = 'button';
  momentBtn.title = 'Agrega al mensaje el segundo donde está el reproductor, para que el agente sepa de qué parte hablás';
  const fbSend = el('button', 'small-btn lab-fb-send', `Enviar a ${key}`);
  fbSend.type = 'button';
  const fbRow = el('div', 'actions compact');
  fbRow.append(momentBtn, fbSend);
  const fbQueue = el('p', 'muted small');
  feedback.append(el('span', 'lab-field-label', `Feedback para ${key}`), thread, fbText, fbRow, fbQueue);
  // Cortar y mover la animación en el tiempo (no el video).
  const cuts = el('div', 'lab-cuts');
  const codeBox = el('details', 'lab-code');
  codeBox.append(el('summary', null, 'Ver código (TSX)'));
  const codePre = el('pre', 'lab-out');
  codeBox.append(codePre);
  const actions = el('div', 'actions compact');
  const adjust = el('div', 'lab-adjust');
  const legacyNote = el('p', 'muted small', 'Este resultado es del harness v1 (el video va dentro del componente): no se puede ajustar el tamaño por separado. Los experimentos nuevos sí.');
  const toolsBox = el('details', 'lab-tools');
  node.append(head, price, resultOf, refsBar, stage, status, actions, feedback, adjust, cuts, legacyNote, metrics, evalBox, toolsBox, live, codeBox);

  const side = {
    key, node, model, stage, frame: null, controller: null, code: '', js: '', turns: [], runtimeFixes: 0, pending: null,
    assets: [], // imágenes que generó: { id, url, prompt }
    found: [], // búsquedas: { query, results: [{ id, title, source, link, thumb }] }
    dragging: false,
    queue: [], // feedback escrito mientras el agente trabaja: se manda junto al terminar
    frameNow: 0, // cuadro donde está su reproductor
    selected: null, // corte seleccionado en el editor
    rendering: null, // progreso de la descarga (0..1) o null
    run: () => exp?.sides[key],
  };

  // ---------- Tamaño y posición de la capa sobre el video ----------
  const transformOf = () => ({ ...IDENTITY, ...(side.run()?.transform || {}) });
  side.sendTransform = () => side.frame?.contentWindow?.postMessage({ type: 'transform', transform: transformOf() }, '*');
  function setTransform(t, { save = true } = {}) {
    const run = side.run();
    if (!run) return;
    run.transform = {
      scale: Math.round(Math.min(2.5, Math.max(0.2, t.scale)) * 1000) / 1000,
      x: Math.round(Math.min(60, Math.max(-60, t.x)) * 10) / 10,
      y: Math.round(Math.min(60, Math.max(-60, t.y)) * 10) / 10,
    };
    side.sendTransform();
    syncSliders();
    if (save) { persistSoon(); renderMetrics(run); renderCompare(); }
  }
  const slider = (label, min, max, step, get, set, unit) => {
    const w = el('label', 'lab-slider');
    const input = el('input');
    input.type = 'range'; input.min = String(min); input.max = String(max); input.step = String(step);
    const value = el('span', 'small lab-slider-value');
    input.oninput = () => setTransform(set(Number(input.value)), { save: false });
    input.onchange = () => setTransform(set(Number(input.value)));
    w.append(el('span', 'small', label), input, value);
    return { node: w, sync: () => { const v = get(); input.value = String(v); value.textContent = `${Math.round(v)}${unit}`; } };
  };
  const sliders = [
    slider('Tamaño', 20, 250, 1, () => transformOf().scale * 100, (v) => ({ ...transformOf(), scale: v / 100 }), '%'),
    slider('Horizontal', -60, 60, 0.5, () => transformOf().x, (v) => ({ ...transformOf(), x: v }), '%'),
    slider('Vertical', -60, 60, 0.5, () => transformOf().y, (v) => ({ ...transformOf(), y: v }), '%'),
  ];
  function syncSliders() { sliders.forEach((s) => s.sync()); }
  const dragBtn = el('button', 'small-btn', 'Mover con el mouse');
  dragBtn.type = 'button';
  dragBtn.onclick = () => { side.dragging = !side.dragging; renderDrag(); };
  const resetBtn = el('button', 'small-btn', 'Restablecer');
  resetBtn.type = 'button';
  resetBtn.onclick = () => setTransform({ ...IDENTITY });
  const adjustActions = el('div', 'actions compact');
  adjustActions.append(dragBtn, resetBtn);
  adjust.append(el('span', 'lab-field-label', 'Tamaño y posición sobre el video'), ...sliders.map((s) => s.node), adjustActions);

  // Capa transparente encima del Player para arrastrar (mover) y usar la rueda (escalar).
  const drag = el('div', 'lab-drag');
  drag.append(el('span', 'lab-drag-hint', 'Arrastrá para mover · rueda o pellizco para escalar'));
  function videoBox() {
    const r = stage.getBoundingClientRect();
    const v = frozen?.payload.video;
    if (!v) return { w: r.width, h: r.height };
    const k = Math.min(r.width / v.width, r.height / v.height);
    return { w: v.width * k, h: v.height * k };
  }
  drag.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    drag.setPointerCapture(e.pointerId);
    const start = { x: e.clientX, y: e.clientY, t: transformOf() };
    const box = videoBox();
    const move = (ev) => setTransform({ ...start.t, x: start.t.x + ((ev.clientX - start.x) / box.w) * 100, y: start.t.y + ((ev.clientY - start.y) / box.h) * 100 }, { save: false });
    const up = () => { drag.removeEventListener('pointermove', move); drag.removeEventListener('pointerup', up); drag.removeEventListener('pointercancel', up); setTransform(transformOf()); };
    drag.addEventListener('pointermove', move);
    drag.addEventListener('pointerup', up);
    drag.addEventListener('pointercancel', up);
  });
  let wheelSave = 0;
  drag.addEventListener('wheel', (e) => {
    e.preventDefault();
    const t = transformOf();
    setTransform({ ...t, scale: t.scale * Math.exp(-e.deltaY * 0.0015) }, { save: false });
    clearTimeout(wheelSave);
    wheelSave = setTimeout(() => setTransform(transformOf()), 300);
  }, { passive: false });
  function renderDrag() {
    dragBtn.setAttribute('aria-pressed', String(side.dragging));
    dragBtn.textContent = side.dragging ? 'Listo (volver a los controles)' : 'Mover con el mouse';
    if (side.dragging && side.frame) stage.append(drag); else drag.remove();
  }
  side.renderDrag = renderDrag;

  // ---------- Lo que buscó y generó ----------
  function renderTools() {
    toolsBox.replaceChildren();
    if (!side.assets.length && !side.found.length) { toolsBox.hidden = true; return; }
    toolsBox.hidden = false;
    toolsBox.append(el('summary', null, `Herramientas · ${side.found.length} búsqueda${side.found.length === 1 ? '' : 's'} · ${side.assets.length} ${side.assets.length === 1 ? 'imagen generada' : 'imágenes generadas'}`));
    side.assets.forEach((a) => {
      const fig = el('figure', 'lab-asset');
      const img = el('img'); img.src = a.url; img.alt = a.prompt;
      fig.append(img, el('figcaption', 'small', `${a.id} · ${a.prompt}`));
      toolsBox.append(fig);
    });
    side.found.forEach((f) => {
      toolsBox.append(el('p', 'small lab-query', `Buscó: «${f.query}»`));
      const strip = el('div', 'thumbs');
      f.results.forEach((r) => {
        const t = el(r.link ? 'a' : 'div', 'thumb');
        if (r.link) { t.href = r.link; t.target = '_blank'; t.rel = 'noopener noreferrer'; }
        t.title = `${r.id} · ${r.title}${r.source ? ` (${r.source})` : ''}`;
        const img = el('img'); img.src = r.thumb; img.alt = r.title;
        t.append(img);
        strip.append(t);
      });
      toolsBox.append(strip);
    });
  }
  side.renderTools = renderTools;

  // ---------- Cortar y mover la animación ----------
  // Un corte = un tramo de la capa del agente ([from, from+len) en cuadros) que se ve desde `to`.
  // Sin cortes, la capa se ve tal cual la escribió el agente.
  const total = () => Math.max(1, Math.ceil((frozen?.payload.video.duration || 1) * fps()));
  const MIN_LEN = 6;
  const defaultSegments = () => zonesOf().map((z) => ({ id: z.id, from: z.from, len: z.durationInFrames, to: z.from }));
  const segmentsOf = () => side.run()?.segments || defaultSegments();
  side.sendSegments = () => side.frame?.contentWindow?.postMessage({ type: 'segments', segments: side.run()?.segments || null }, '*');
  function setSegments(segs, { save = true, redraw = true } = {}) {
    const run = side.run();
    if (!run) return;
    run.segments = segs;
    run.segmentsEdited = !!segs;
    side.sendSegments();
    if (redraw) drawCuts();
    if (save) { persistSoon(); renderMetrics(run); renderCompare(); }
  }
  const clampSeg = (g) => {
    const T = total();
    const len = Math.max(MIN_LEN, Math.min(g.len, T));
    return { ...g, len, from: Math.min(Math.max(0, g.from), T - len), to: Math.min(Math.max(0, g.to), T - len) };
  };
  const track = el('div', 'lab-cuts-track');
  const cursor = el('div', 'lab-cuts-cursor');
  const cutInfo = el('p', 'muted small');
  const btn = (label, fn, title) => { const b = el('button', 'small-btn', label); b.type = 'button'; b.onclick = fn; if (title) b.title = title; return b; };
  const selectedSeg = () => segmentsOf().find((g) => g.id === side.selected);
  const cutActions = el('div', 'actions compact');
  cutActions.append(
    btn('Dividir en el cursor', () => {
      const segs = segmentsOf();
      const p = side.frameNow;
      const g = segs.find((x) => x.id === side.selected && p > x.to + MIN_LEN - 1 && p < x.to + x.len - MIN_LEN + 1) || segs.find((x) => p > x.to + MIN_LEN - 1 && p < x.to + x.len - MIN_LEN + 1);
      if (!g) { cutInfo.textContent = 'Poné el cursor del reproductor adentro de un tramo (no en el borde) para dividirlo.'; return; }
      const k = p - g.to;
      const n = segs.filter((x) => x.id.startsWith(g.id.split('·')[0])).length + 1;
      const b = { id: `${g.id.split('·')[0]}·${n}`, from: g.from + k, len: g.len - k, to: p };
      side.selected = b.id;
      setSegments(segs.flatMap((x) => (x === g ? [{ ...g, len: k }, b] : [x])));
    }, 'Corta el tramo donde está el reproductor: queda en dos tramos que podés mover por separado'),
    btn('Duplicar', () => {
      const g = selectedSeg();
      if (!g) { cutInfo.textContent = 'Elegí un tramo tocándolo.'; return; }
      const segs = segmentsOf();
      const copy = clampSeg({ ...g, id: `${g.id.split('·')[0]}·${segs.length + 1}`, to: g.to + g.len });
      side.selected = copy.id;
      setSegments([...segs, copy]);
    }),
    btn('Quitar', () => {
      const g = selectedSeg();
      if (!g) { cutInfo.textContent = 'Elegí un tramo tocándolo.'; return; }
      side.selected = null;
      setSegments(segmentsOf().filter((x) => x !== g));
    }),
    btn('Restablecer', () => { side.selected = null; setSegments(null); }),
  );
  cuts.append(el('span', 'lab-field-label', 'Cortar y mover la animación'),
    el('span', 'muted small', 'Cada tramo es un pedazo de la animación (no del video). Arrastralo a otro momento, recortá sus bordes, dividilo o duplicalo.'),
    track, cutInfo, cutActions);

  function drawCuts() {
    const T = total();
    track.replaceChildren(cursor);
    cursor.style.left = `${(side.frameNow / T) * 100}%`;
    segmentsOf().forEach((g) => {
      const b = el('div', `lab-cut${g.id === side.selected ? ' on' : ''}`);
      b.style.left = `${(g.to / T) * 100}%`;
      b.style.width = `${(g.len / T) * 100}%`;
      const l = el('span', 'lab-cut-grip l'); l.dataset.edge = 'l';
      const r = el('span', 'lab-cut-grip r'); r.dataset.edge = 'r';
      b.append(l, el('span', 'lab-cut-label', g.id), r);
      b.addEventListener('pointerdown', (e) => dragCut(e, g, b));
      track.append(b);
    });
    const g = selectedSeg();
    if (g) cutInfo.textContent = `${g.id}: muestra ${secOf(g.from)}–${secOf(g.from + g.len)} s de la animación, desde el segundo ${secOf(g.to)} del video.`;
    else if (!cutInfo.textContent.startsWith('Poné') && !cutInfo.textContent.startsWith('Elegí')) cutInfo.textContent = side.run()?.segmentsEdited ? 'Tocá un tramo para elegirlo.' : 'Sin cortes: la animación se ve tal cual la hizo el agente.';
  }
  side.drawCursor = () => { cursor.style.left = `${(side.frameNow / total()) * 100}%`; };

  function dragCut(e, g, node) {
    e.preventDefault();
    const edge = e.target.dataset?.edge || 'move';
    side.selected = g.id;
    const rect = track.getBoundingClientRect();
    if (!rect.width) return;
    const T = total();
    const x0 = e.clientX;
    const start = { ...g };
    let moved = false;
    try { node.setPointerCapture(e.pointerId); } catch { /* sin captura */ }
    const move = (ev) => {
      const d = Math.round(((ev.clientX - x0) / rect.width) * T);
      if (!d && !moved) return;
      moved = true;
      let next;
      if (edge === 'move') next = { ...start, to: start.to + d };
      else if (edge === 'l') { const k = Math.min(start.len - MIN_LEN, Math.max(-start.from, -start.to, d)); next = { ...start, from: start.from + k, to: start.to + k, len: start.len - k }; }
      else next = { ...start, len: Math.max(MIN_LEN, Math.min(start.len + d, T - start.from, T - start.to)) };
      const fixed = clampSeg(next);
      // Durante el arrastre no se redibuja la pista (se perdería el elemento que se está arrastrando): solo se mueve el bloque.
      setSegments(segmentsOf().map((x) => (x.id === g.id ? fixed : x)), { save: false, redraw: false });
      node.style.left = `${(fixed.to / T) * 100}%`;
      node.style.width = `${(fixed.len / T) * 100}%`;
      side.frame?.contentWindow?.postMessage({ type: 'seek', frame: edge === 'r' ? fixed.to + fixed.len - 1 : fixed.to }, '*');
    };
    const up = () => {
      node.removeEventListener('pointermove', move); node.removeEventListener('pointerup', up); node.removeEventListener('pointercancel', up);
      if (moved) setSegments(segmentsOf()); else drawCuts();
    };
    node.addEventListener('pointermove', move);
    node.addEventListener('pointerup', up);
    node.addEventListener('pointercancel', up);
  }

  function renderCuts(run, st) {
    cuts.hidden = !(run && side.code && side.frame && st === 'done' && !isLegacy(side.code) && zonesOf().length);
    if (!cuts.hidden) drawCuts();
  }

  // ---------- Descargar el video ----------
  side.download = () => {
    if (!side.frame || side.rendering !== null) return;
    error('');
    if (document.hidden) error('Dejá esta pestaña visible mientras se renderiza: el navegador frena el render en pestañas ocultas.');
    side.rendering = 0;
    side.render();
    side.frame.contentWindow.postMessage({ type: 'render' }, '*');
  };

  function showPrice() {
    const m = info.models.find((x) => x.id === model.value.trim());
    price.textContent = m?.prompt !== null && m?.prompt !== undefined ? `${m.name} · US$ ${fmtPrice(m.prompt)} entrada / ${fmtPrice(m.completion)} salida por millón de tokens` : model.value.trim() ? 'Modelo fuera del catálogo con visión (se usa igual si OpenRouter lo tiene).' : '';
  }
  side.showPrice = showPrice;

  const busyNow = () => ['running', 'checking'].includes(side.run()?.status);
  const secOf = (f) => (f / fps()).toFixed(1);
  side.updateMoment = () => { momentBtn.textContent = `+ Momento actual (${secOf(side.frameNow)} s)`; };
  momentBtn.onclick = () => {
    const tag = `[en ${secOf(side.frameNow)} s] `;
    const at = fbText.selectionStart ?? fbText.value.length;
    fbText.value = fbText.value.slice(0, at) + tag + fbText.value.slice(at);
    fbText.focus();
    fbText.selectionStart = fbText.selectionEnd = at + tag.length;
  };
  // Manda el feedback ya (o lo encola si el agente está trabajando).
  function sendFeedback() {
    const text = fbText.value.trim();
    const run = side.run();
    if (!text || !run) { fbText.focus(); return; }
    fbText.value = '';
    run.thread = [...(run.thread || []), { role: 'user', text, queued: busyNow() || !side.code }];
    if (busyNow() || !side.code) { side.queue.push(text); persist(); side.render(); return; }
    revise(text);
  }
  function revise(text) {
    const run = side.run();
    (run.thread || []).forEach((m) => { if (m.role === 'user') m.queued = false; });
    side.turns.push({ code: side.code, kind: 'feedback', message: text });
    side.runtimeFixes = 0;
    // La aprobación era de la versión anterior: la nueva se vuelve a evaluar.
    run.eval.approved = null;
    execute(side, 'feedback', text);
  }
  // Al terminar una versión, lo que quedó en cola se manda junto, como un solo pedido.
  side.flushQueue = () => {
    if (!side.queue.length || busyNow() || !side.code) return;
    const text = side.queue.length === 1 ? side.queue[0] : side.queue.map((t, i) => `${i + 1}. ${t}`).join('\n');
    side.queue = [];
    revise(text);
  };
  fbSend.onclick = sendFeedback;
  fbText.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); sendFeedback(); } });

  function renderFeedback(run) {
    feedback.hidden = !run;
    if (!run) return;
    thread.replaceChildren(...(run.thread || []).map((m) => {
      const b = el('div', `lab-msg ${m.role === 'user' ? 'me' : 'agent'}`);
      b.append(el('span', 'lab-msg-who', m.role === 'user' ? `Vos${m.queued ? ' · en cola' : ''}` : `${key} · versión ${m.version || ''}`), el('span', null, m.text));
      return b;
    }));
    thread.hidden = !(run.thread || []).length;
    fbSend.textContent = busyNow() ? `Encolar para ${key}` : `Enviar a ${key}`;
    fbQueue.textContent = side.queue.length ? `${side.queue.length} pedido${side.queue.length > 1 ? 's' : ''} en cola: se mandan juntos cuando termine esta versión.` : 'Cada envío es una versión nueva (cuenta como intervención manual y como un intento).';
    side.updateMoment();
  }

  // ---------- Arriba del video: búsquedas, referencias elegidas e imágenes generadas ----------
  function thumbWithId(id, src, title, link) {
    const t = el(link ? 'a' : 'figure', 'lab-ref');
    if (link) { t.href = link; t.target = '_blank'; t.rel = 'noopener noreferrer'; }
    t.title = title || id;
    const img = el('img'); img.src = src; img.alt = title || id;
    t.append(img, el('span', 'lab-ref-id', id));
    return t;
  }
  // Los ids S1, S2… se reinician en cada versión: se buscan de la última búsqueda hacia atrás.
  function refThumb(id) {
    for (const f of [...side.found].reverse()) { const r = f.results.find((x) => x.id === id); if (r) return thumbWithId(id, r.thumb, `${r.title}${r.source ? ` (${r.source})` : ''}`, r.link); }
    const a = side.assets.find((x) => x.id === id);
    if (a) return thumbWithId(id, a.url, a.prompt);
    const g = /^R(\d+)$/.exec(id);
    if (g && frozen?.brief.refs[g[1] - 1]) return thumbWithId(id, frozen.brief.refs[g[1] - 1].url, frozen.brief.refs[g[1] - 1].name);
    return null;
  }
  function renderRefsBar(run) {
    refsBar.replaceChildren();
    // Las búsquedas de la versión que se está viendo (cada versión vuelve a buscar).
    const lastExec = Math.max(0, ...side.found.map((f) => f.exec || 0));
    const queries = side.found.filter((f) => (f.exec || 0) === lastExec).map((f) => `«${f.query}»`);
    const before = side.found.filter((f) => (f.exec || 0) !== lastExec).length;
    if (!run || (!queries.length && !side.assets.length)) { refsBar.hidden = true; return; }
    refsBar.hidden = false;
    if (queries.length) refsBar.append(el('p', 'small lab-refs-q', `Buscó: ${queries.join(' · ')}${before ? ` (y ${before} búsqueda${before > 1 ? 's' : ''} en versiones anteriores)` : ''}`));
    const used = run.usedRefs;
    const row = el('div', 'lab-refs-row');
    if (used?.length) {
      row.append(el('span', 'small muted', 'Se quedó con'));
      used.map(refThumb).filter(Boolean).forEach((t) => row.append(t));
    } else if (side.code) {
      row.append(el('span', 'small muted', used ? 'Dice que no tomó ninguna referencia.' : 'No indicó qué referencias usó.'));
    }
    if (side.assets.length) {
      row.append(el('span', 'small muted lab-refs-gen', 'Generó'));
      side.assets.forEach((a) => row.append(thumbWithId(a.id, a.url, a.prompt)));
    }
    if (row.childElementCount) refsBar.append(row);
    // La paleta que dice haber sacado de las referencias, y si esos colores están de verdad en el código.
    if (side.code && run.palette) {
      const pal = el('div', 'lab-refs-row');
      if (run.palette.length) {
        const code = side.code.toUpperCase();
        const inCode = run.palette.filter((h) => code.includes(h));
        pal.append(el('span', 'small muted', 'Paleta'));
        run.palette.forEach((h) => {
          const sw = el('span', `lab-swatch${code.includes(h) ? '' : ' off'}`);
          sw.style.setProperty('--sw', h);
          sw.title = `${h}${code.includes(h) ? '' : ' · no aparece en el código'}`;
          pal.append(sw);
        });
        pal.append(el('span', 'small muted', `${inCode.length} de ${run.palette.length} en el código`));
      } else pal.append(el('span', 'small muted', 'No sacó paleta de las referencias.'));
      refsBar.append(pal);
    } else if (side.code) refsBar.append(el('p', 'small muted lab-refs-q', 'No indicó la paleta que usó.'));
    if (side.code && run.objects) {
      const obj = el('div', 'lab-refs-row');
      obj.append(el('span', 'small muted', 'Objetos'));
      if (run.objects.length) run.objects.forEach((o) => obj.append(el('span', 'chip', o)));
      else obj.append(el('span', 'small muted', 'ninguno de las referencias'));
      refsBar.append(obj);
    }
  }

  side.render = () => {
    const run = side.run();
    const st = run?.status || 'idle';
    // El selector vale para el próximo experimento; mientras trabaja, queda fijo.
    model.disabled = st === 'running' || st === 'checking';
    resultOf.textContent = run ? `Resultado de ${run.model}` : '';
    resultOf.hidden = !run || run.model === model.value.trim();
    node.dataset.status = st;
    if (!run) {
      status.textContent = '';
      if (!side.frame) stage.replaceChildren(el('div', 'lab-empty', `Acá va la animación del modelo ${key}`));
    } else {
      const last = run.attempts.at(-1);
      status.textContent = {
        running: side.pending || 'Trabajando…',
        checking: 'Probando la animación en el Player…',
        done: `Listo · ${run.attempts.length} ${run.attempts.length === 1 ? 'ejecución' : 'ejecuciones'}`,
        error: `Falló: ${run.error || last?.error || 'error desconocido'}`,
        idle: '',
      }[st];
    }
    // Acciones según el estado.
    actions.replaceChildren();
    if (st === 'running' || st === 'checking') {
      const stop = el('button', 'small-btn', 'Detener');
      stop.type = 'button';
      stop.onclick = () => side.controller?.abort();
      actions.append(stop);
    }
    if (st === 'error' && run) {
      const retry = el('button', 'small-btn', side.code && run.runtimeError ? 'Corregir el error' : 'Reintentar');
      retry.type = 'button';
      retry.onclick = () => {
        if (side.code && run.runtimeError) {
          side.turns.push({ code: side.code, kind: 'runtime', message: run.runtimeError });
          side.runtimeFixes = 0;
          execute(side, 'runtime');
        } else execute(side, side.turns.at(-1)?.kind || 'initial');
      };
      actions.append(retry);
    }
    if (st === 'done' && run && side.frame && !isLegacy(side.code)) {
      const dl = el('button', 'small-btn', side.rendering !== null ? `${side.renderPhase || 'Renderizando'}… ${Math.round(side.rendering * 100)} %` : 'Descargar video');
      dl.type = 'button';
      dl.disabled = side.rendering !== null;
      dl.title = 'Renderiza en tu navegador el video con la animación tal cual se ve (tamaño, posición y cortes incluidos). Dejá la pestaña visible mientras tanto.';
      dl.onclick = () => side.download();
      actions.append(dl);
    }
    renderFeedback(run);
    renderRefsBar(run);
    renderCuts(run, st);
    const canAdjust = !!(run && side.code && side.frame && st === 'done' && !isLegacy(side.code));
    adjust.hidden = !canAdjust;
    legacyNote.hidden = !(run && side.code && isLegacy(side.code));
    if (!canAdjust) side.dragging = false;
    if (canAdjust) syncSliders();
    renderDrag();
    renderTools();
    codeBox.hidden = !side.code;
    codePre.textContent = side.code;
    renderMetrics(run);
    renderEval(run);
  };

  function renderMetrics(run) {
    metrics.replaceChildren();
    if (!run || !run.attempts.length) { metrics.hidden = true; return; }
    metrics.hidden = false;
    const m = runMetrics(run);
    const row = (label, value, title) => { const d = el('div'); if (title) d.title = title; d.append(el('dt', null, label), el('dd', null, value)); metrics.append(d); };
    row('Costo', money(m.cost), `Todo lo gastado, incluidas correcciones, revisiones y herramientas${m.toolCost ? ` (herramientas: ${money(m.toolCost)})` : ''}`);
    row('Tiempo', secs(m.ms), 'Tiempo total generando (todas las ejecuciones, con herramientas)');
    row('Intentos', String(m.attempts), `Componentes que tuvo que escribir: cada ejecución + cada recompilación. Llamadas al modelo: ${m.calls}`);
    row('Correcciones auto.', String(m.autoFixes), 'Recompilaciones y arreglos por errores al reproducir');
    row('Intervención manual', [`${m.revisions} ${m.revisions === 1 ? 'revisión' : 'revisiones'}`, m.adjusted && 'ajuste de tamaño', m.cut && 'cortes', m.manualMinutes && `${m.manualMinutes} min`].filter(Boolean).join(' + '));
    row('Herramientas', m.searches || m.images ? `${m.searches} búsq. · ${m.images} img. · ${money(m.toolCost)}` : 'no usó');
    row('Tokens', m.tokens.toLocaleString('es'));
  }

  function renderEval(run) {
    evalBox.replaceChildren();
    if (!run || !side.code) { evalBox.hidden = true; return; }
    evalBox.hidden = false;
    const ev = run.eval;
    const verdict = el('div', 'options lab-verdict');
    [[true, '✓ Aprobar'], [false, '✕ Rechazar']].forEach(([v, label]) => {
      const b = el('button', `option ${v ? 'ok' : 'ko'}`, label);
      b.type = 'button';
      b.setAttribute('aria-pressed', String(ev.approved === v));
      b.onclick = () => { ev.approved = ev.approved === v ? null : v; persist(); side.render(); renderCompare(); };
      verdict.append(b);
    });
    evalBox.append(verdict, stars('Calidad', 'quality', ev), stars('Fidelidad', 'fidelity', ev));
    const manual = el('input');
    manual.type = 'number'; manual.min = '0'; manual.max = '600'; manual.step = '1'; manual.value = ev.manualMinutes || '';
    manual.placeholder = '0';
    manual.onchange = () => { ev.manualMinutes = Math.max(0, Math.min(600, Number(manual.value) || 0)); persist(); renderMetrics(run); };
    const mw = el('label', 'lab-inline');
    mw.append(el('span', 'small', 'Retoque manual (min)'), manual);
    const notes = el('textarea');
    notes.rows = 2; notes.placeholder = 'Observaciones sobre este resultado'; notes.value = ev.notes || '';
    notes.oninput = () => { ev.notes = notes.value; persistSoon(); };
    evalBox.append(mw, notes);
  }

  function stars(label, k, ev) {
    const row = el('div', 'lab-stars');
    row.append(el('span', 'small', label));
    for (let i = 1; i <= 5; i++) {
      const s = el('button', 'lab-star', '★');
      s.type = 'button';
      s.setAttribute('aria-label', `${label}: ${i} de 5`);
      s.setAttribute('aria-pressed', String(ev[k] >= i));
      s.onclick = () => { ev[k] = ev[k] === i ? 0 : i; persist(); side.render(); };
      row.append(s);
    }
    return row;
  }

  side.write = (text) => { out.textContent = (out.textContent + text).slice(-6000); };
  side.clearOut = () => { out.textContent = ''; };
  return side;
}

const fmtPrice = (x) => (x >= 1 ? x.toFixed(2).replace(/\.00$/, '') : x.toFixed(3).replace(/0+$/, ''));

// ---------- Ejecutar ----------
function missing() {
  const m = studio.missing();
  if (!studio.hasVideo() && !studio.busy()) return 'Subí un clip de video para empezar.';
  if (m) return m;
  for (const k of SIDES) if (!/^[\w.-]+\/[\w.:@-]+$/.test(sides[k].model.value.trim())) return `Elegí el modelo ${k}.`;
  if (briefRefs.some((r) => r.status === 'loading')) return 'Preparando las referencias…';
  return null;
}

function busy() { return SIDES.some((k) => ['running', 'checking'].includes(exp?.sides[k]?.status)); }

function refresh() {
  const v = studio.current();
  if (v) SIDES.forEach((k) => { if (!sides[k].frame) sides[k].stage.style.setProperty('--ar', `${v.width} / ${v.height}`); });
  const why = missing();
  const running = busy();
  runBtn.disabled = !!why || running;
  runBtn.textContent = exp?.sides.A.attempts.length ? 'Ejecutar como experimento nuevo' : 'Ejecutar experimento';
  hint.textContent = running ? 'Los dos agentes trabajan por separado: ninguno ve lo que hace el otro.'
    : why || (exp?.sides.A.attempts.length ? 'Los cambios en el brief o los modelos se usan en un experimento nuevo; las revisiones de cada lado siguen con el brief original.' : 'Listo para ejecutar: los dos modelos reciben el mismo clip, zonas, contexto, referencias e instrucciones.');
  newBtn.hidden = !exp;
}

runBtn.onclick = async () => {
  if (missing() || busy()) return;
  error('');
  runBtn.disabled = true;
  try {
    const { body } = await studio.request('');
    const parsed = JSON.parse(body);
    const v = studio.current();
    const briefData = { context: contextInput.value.trim(), instructions: instructionsInput.value.trim(), refs: briefRefs.filter((r) => r.status === 'ready').map((r) => ({ name: r.name, url: r.url })) };
    frozen = { brief: briefData, payload: { video: parsed.video, clips: parsed.clips } };
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    const count = store.listExperiments().length + 1;
    exp = {
      id,
      createdAt: new Date().toISOString(),
      name: nameInput.value.trim() || `Experimento ${count} · ${v.name}`,
      section: 'motion-design',
      harness: info.harness.version || '',
      video: { name: v.name, duration: v.duration, width: v.width, height: v.height },
      zones: parsed.clips.map((c) => ({ id: c.id, start: c.start, end: c.end, prompt: c.prompt, notes: c.notes, refs: c.refs.length })),
      brief: { context: briefData.context, instructions: briefData.instructions, refs: briefData.refs.map((r) => r.name) },
      sides: Object.fromEntries(SIDES.map((k) => [k, newRun(sides[k].model.value.trim())])),
      preference: null,
      notes: '',
    };
    nameInput.value = exp.name;
    // Lo pesado va a IndexedDB por referencia (el video entero, cuadros, referencias).
    await store.putBlob(`${id}:video`, v.file);
    await store.putBlob(`${id}:inputs`, frozen);
    frozen.file = v.file; // el video de ESTE experimento, aunque después se cambie el del marcador
    persist();
    SIDES.forEach((k) => {
      const s = sides[k];
      Object.assign(s, { code: '', js: '', turns: [], assets: [], found: [], queue: [], selected: null, rendering: null, runtimeFixes: 0 }); s.clearOut();
      unmount(s);
      execute(s, 'initial');
    });
    renderCompare();
  } catch (err) {
    error(err.message);
  } finally {
    refresh();
  }
};

newBtn.onclick = () => {
  if (busy() && !confirm('Hay agentes trabajando. ¿Detenerlos y empezar de cero?')) return;
  SIDES.forEach((k) => { sides[k].controller?.abort(); unmount(sides[k]); Object.assign(sides[k], { code: '', js: '', turns: [], assets: [], found: [], queue: [], selected: null, rendering: null }); sides[k].clearOut(); });
  exp = null; frozen = null;
  nameInput.value = '';
  compare.hidden = true;
  SIDES.forEach((k) => sides[k].render());
  refresh();
};

// Una ejecución de un lado: stream del servidor → código compilado → Player aislado → prueba de humo.
async function execute(side, reason, feedback) {
  const run = side.run();
  if (!run || !frozen) return;
  side.controller?.abort();
  const controller = new AbortController();
  side.controller = controller;
  run.status = 'running';
  run.error = null;
  run.runtimeError = null;
  side.pending = REASON[reason] ? `${REASON[reason]}…` : 'Trabajando…';
  side.write(`\n\n— ${REASON[reason] || reason} —\n`);
  persist(); side.render(); refresh();
  const attempt = { reason, calls: 0, compileErrors: 0, cost: 0, llmCost: 0, toolCost: 0, searches: 0, images: 0, tokens: 0, ms: 0, ok: false, at: new Date().toISOString(), ...(feedback ? { feedback } : {}) };
  const counters = (ev) => ({
    calls: ev.calls ?? attempt.calls, cost: ev.cost ?? attempt.cost, llmCost: ev.llmCost ?? attempt.llmCost, toolCost: ev.toolCost ?? attempt.toolCost,
    searches: ev.searches ?? attempt.searches, images: ev.images ?? attempt.images, tokens: ev.tokens ?? attempt.tokens,
  });
  run.attempts.push(attempt);
  const t0 = performance.now();
  let result = null;
  let failed = null;
  try {
    const body = JSON.stringify({ model: run.model, brief: frozen.brief, video: frozen.payload.video, clips: frozen.payload.clips, turns: side.turns, assets: side.assets });
    await streamEvents('/api/lab/run', body, controller.signal, (ev) => {
      switch (ev.type) {
        case 'attempt': side.pending = `${REASON[ev.reason] || 'Trabajando'} · llamada ${ev.call}…`; side.render(); return;
        case 'delta': side.write(ev.text); if (ev.chars % 600 < ev.text.length) { side.pending = `Escribiendo… ${ev.chars.toLocaleString('es')} caracteres`; side.render(); } return;
        case 'reasoning': if (!side.pending?.startsWith('Pensando')) { side.pending = 'Pensando…'; side.render(); } return;
        case 'notice': side.write(`\n[${ev.text}]\n`); return;
        case 'compile_error': attempt.compileErrors += 1; side.write(`\n[No compila: ${ev.text}]\n`); side.pending = 'No compiló: corrigiendo…'; side.render(); return;
        case 'tool':
          side.write(`\n[${ev.name === 'buscar_referencias' ? `Busca referencias: «${ev.args?.consulta || ''}»` : `Genera una imagen: ${ev.args?.prompt || ''}`}]\n`);
          side.pending = ev.name === 'buscar_referencias' ? 'Buscando referencias en Google…' : 'Generando una imagen con nano-banana…';
          side.render();
          return;
        case 'search': side.found.push({ query: ev.query, results: ev.results, exec: run.attempts.length }); side.render(); return;
        case 'asset': side.assets.push({ id: ev.id, url: ev.url, prompt: ev.prompt }); side.render(); return;
        case 'usage': Object.assign(attempt, counters(ev)); side.render(); return;
        case 'result': result = ev; return;
        case 'done': Object.assign(attempt, counters(ev), { ms: ev.ms, compileErrors: ev.compileErrors ?? attempt.compileErrors }); return;
        case 'error': failed = ev.text; Object.assign(attempt, counters(ev), { ms: ev.ms ?? 0, compileErrors: ev.compileErrors ?? attempt.compileErrors }); return;
        default:
      }
    });
  } catch (err) {
    failed = controller.signal.aborted ? 'detenido' : err.message;
  }
  if (!attempt.ms) attempt.ms = Math.round(performance.now() - t0);
  if (side.controller === controller) side.controller = null;
  if (failed || !result) {
    attempt.ok = false;
    attempt.error = failed || 'el servidor no devolvió un componente';
    run.status = 'error';
    run.error = attempt.error;
    side.pending = null;
    if (side.assets.length || side.found.length) await saveCode(side);
    persist(); side.render(); refresh(); renderCompare();
    return;
  }
  attempt.ok = true;
  side.code = result.code;
  side.js = result.js;
  run.notes = result.notes;
  run.usedRefs = result.usedRefs ?? null;
  run.palette = result.palette ?? null;
  run.objects = result.objects ?? null;
  run.hasCode = true;
  // Lo que respondió el agente queda en la conversación de feedback, como una versión más.
  run.thread = [...(run.thread || []), { role: 'agent', text: result.notes || '(sin notas)', version: run.attempts.filter((a) => a.ok).length }];
  run.status = 'checking';
  side.pending = null;
  await saveCode(side);
  persist(); side.render(); refresh();
  mount(side);
}

// Lo pesado de un lado (código, turnos, imágenes generadas y búsquedas) va a IndexedDB.
const saveCode = (side) => store.putBlob(`${exp.id}:code:${side.key}`, { code: side.code, js: side.js, notes: side.run()?.notes || '', turns: side.turns, assets: side.assets, found: side.found });

// ---------- Player aislado ----------
function unmount(side) {
  side.frame?.remove();
  side.frame = null;
  side.stage.replaceChildren(el('div', 'lab-empty', `Acá va la animación del modelo ${side.key}`));
}

// El documento del iframe (CSP + React/Remotion + frame.js en línea), se baja una vez.
let frameDoc = null;
const frameHtml = () => {
  frameDoc ??= fetch('/api/lab/frame.html').then((r) => (r.ok ? r.text() : r.text().then((t) => { throw new Error(t); }))).catch((err) => { frameDoc = null; throw err; });
  return frameDoc;
};

async function mount(side) {
  const v = frozen?.payload.video;
  if (!v || !frozen.file || !side.js) return;
  let html;
  try {
    html = await frameHtml();
  } catch (err) {
    // No es culpa del agente: no se le pide corrección.
    const run = side.run();
    if (run) { run.status = 'error'; run.error = `no cargó el Player de Remotion: ${err.message}`; persist(); side.render(); refresh(); }
    return;
  }
  side.frame?.remove();
  const frame = el('iframe', 'lab-frame');
  // srcdoc + sandbox sin allow-same-origin: origen opaco, el código del agente no puede tocar esta página ni su almacenamiento.
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.title = `Animación del modelo ${side.key}`;
  frame.srcdoc = html;
  side.frame = frame;
  side.stage.style.setProperty('--ar', `${v.width} / ${v.height}`);
  side.stage.replaceChildren(frame);
}

// Las zonas en cuadros, igual que las calcula el servidor (src/lab/harness.js → zonesFor).
const fps = () => info.harness?.fps || 30;
const zonesOf = () => (frozen?.payload.clips || []).map((c) => ({ id: c.id, from: Math.round(c.start * fps()), durationInFrames: Math.max(1, Math.round(c.end * fps()) - Math.round(c.start * fps())), prompt: c.prompt, notes: c.notes }));

window.addEventListener('message', (e) => {
  const side = SIDES.map((k) => sides[k]).find((s) => s.frame && e.source === s.frame.contentWindow);
  const msg = e.data;
  if (!side || msg?.source !== 'lab-frame') return;
  const run = side.run();
  if (msg.type === 'boot') {
    const v = frozen.payload.video;
    side.frame.contentWindow.postMessage({
      type: 'load', js: side.js, video: frozen.file, meta: { duration: v.duration, width: v.width, height: v.height, fps: fps() }, zones: zonesOf(),
      images: Object.fromEntries(side.assets.map((a) => [a.id, a.url])), transform: { ...IDENTITY, ...(run?.transform || {}) }, legacy: isLegacy(side.code),
      segments: run?.segments || null,
    }, '*');
    return;
  }
  if (msg.type === 'frame') { side.frameNow = msg.frame; side.updateMoment(); side.drawCursor(); return; }
  if (msg.type === 'render_progress') {
    const p = Math.round((msg.progress || 0) * 100);
    const phase = msg.overlay ? 'Renderizando la capa' : 'Renderizando';
    if (p !== Math.round((side.rendering || 0) * 100) || phase !== side.renderPhase) { side.rendering = msg.progress || 0; side.renderPhase = phase; side.render(); }
    return;
  }
  if (msg.type === 'rendered') {
    if (msg.overlay) {
      // Remotion no pudo leer el video de base: llegó solo la capa (transparente) y se compone acá sobre el original.
      compositeOverlay(side, msg.blob)
        .then(({ blob, ext }) => saveVideo(side, blob, ext))
        .catch((err) => error(`No se pudo armar el video de ${side.key}: ${err.message}`))
        .finally(() => { side.rendering = null; side.renderPhase = null; side.render(); });
      return;
    }
    side.rendering = null;
    saveVideo(side, msg.blob, msg.ext);
    if (msg.muted) error('El video se descargó sin sonido: este navegador no pudo codificar el audio.');
    side.render();
    return;
  }
  if (msg.type === 'render_error') { side.rendering = null; error(`No se pudo renderizar el video de ${side.key}: ${msg.message}`); side.render(); return; }
  if (!run) return;
  if (msg.type === 'checked') {
    if (msg.ok) {
      run.status = 'done';
      side.runtimeFixes = 0;
      persist(); side.render(); refresh(); renderCompare();
      side.flushQueue();
    } else runtimeFailure(side, msg.message);
  }
  if (msg.type === 'error') runtimeFailure(side, msg.message);
});

// ---------- Descarga ----------
function saveVideo(side, blob, ext) {
  const a = el('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${(exp?.name || 'laboratorio').replace(/[^\w\-áéíóúñ ]+/gi, '').trim().replace(/\s+/g, '-')}-${side.key}-${shortModel(side.run()?.model)}.${ext}`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}

// Compone la capa transparente encima del video original en un canvas y lo graba en tiempo real
// (como el export de Intuition): sirve para videos que el renderizador de Remotion no puede decodificar.
async function compositeOverlay(side, overlayBlob) {
  if (!window.MediaRecorder || !HTMLCanvasElement.prototype.captureStream) throw new Error('este navegador no puede grabar video');
  const meta = frozen.payload.video;
  const k = Math.min(1, 1920 / Math.max(meta.width, meta.height));
  const W = Math.round((meta.width * k) / 2) * 2;
  const H = Math.round((meta.height * k) / 2) * 2;
  const make = (src, muted) => { const v = document.createElement('video'); v.src = src; v.muted = muted; v.playsInline = true; v.preload = 'auto'; return v; };
  const baseUrl = URL.createObjectURL(frozen.file);
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
      side.rendering = Math.min(1, base.currentTime / meta.duration);
      side.renderPhase = 'Grabando';
      side.render();
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

// Un error al reproducir: se corrige solo (hasta MAX_RUNTIME_FIXES seguidas) y si no, queda el botón.
function runtimeFailure(side, message) {
  const run = side.run();
  if (!run || run.status === 'running') return;
  const last = run.attempts.at(-1);
  if (last) { last.ok = false; last.error = `error al reproducir: ${message}`; }
  run.runtimeError = message;
  side.write(`\n[Error al reproducir: ${message}]\n`);
  if (side.runtimeFixes < MAX_RUNTIME_FIXES && run.status === 'checking') {
    side.runtimeFixes += 1;
    side.turns.push({ code: side.code, kind: 'runtime', message });
    execute(side, 'runtime');
    return;
  }
  run.status = 'error';
  run.error = `error al reproducir: ${message}`;
  persist(); side.render(); refresh(); renderCompare();
}

// ---------- Comparación: reproducción sincronizada y preferencia ----------
function renderCompare() {
  if (!exp) { compare.hidden = true; return; }
  compare.hidden = false;
  compare.replaceChildren(el('div', 'decision-label', '3 · Comparar'));
  const sync = el('div', 'actions compact lab-sync');
  const send = (msg) => SIDES.forEach((k) => sides[k].frame?.contentWindow?.postMessage(msg, '*'));
  const both = el('button', 'small-btn', '▶ Reproducir los dos');
  both.type = 'button';
  both.onclick = () => { send({ type: 'seek', frame: 0 }); send({ type: 'play' }); };
  const pause = el('button', 'small-btn', '❚❚ Pausar');
  pause.type = 'button';
  pause.onclick = () => send({ type: 'pause' });
  const dlBoth = el('button', 'small-btn', 'Descargar los dos');
  dlBoth.type = 'button';
  dlBoth.title = 'Renderiza en tu navegador los dos videos con sus animaciones';
  dlBoth.disabled = !SIDES.every((k) => sides[k].frame && exp.sides[k].status === 'done');
  dlBoth.onclick = () => SIDES.forEach((k) => sides[k].download());
  sync.append(both, pause, dlBoth);
  zonesOf().forEach((z) => {
    const b = el('button', 'small-btn', z.id);
    b.type = 'button';
    b.title = `Reproducir los dos desde la zona ${z.id}`;
    b.onclick = () => { send({ type: 'seek', frame: Math.max(0, z.from - 15) }); send({ type: 'play' }); };
    sync.append(b);
  });
  compare.append(sync);

  // Tabla lado a lado.
  const ma = runMetrics(exp.sides.A);
  const mb = runMetrics(exp.sides.B);
  const table = el('table', 'lab-table');
  const tr = (cells, tag = 'td') => { const r = el('tr'); cells.forEach((c) => r.append(el(tag, null, c))); return r; };
  const best = (a, b, lower = true) => (a === b ? ['', ''] : (lower ? a < b : a > b) ? ['●', ''] : ['', '●']);
  const q = (r) => (r.eval.quality ? `${r.eval.quality}/5` : '—');
  const f = (r) => (r.eval.fidelity ? `${r.eval.fidelity}/5` : '—');
  const ap = (r) => (r.eval.approved === true ? 'Aprobada' : r.eval.approved === false ? 'Rechazada' : '—');
  const [cA, cB] = best(ma.cost, mb.cost);
  const [tA, tB] = best(ma.ms, mb.ms);
  const [iA, iB] = best(ma.attempts, mb.attempts);
  table.append(
    tr(['', `A · ${shortModel(exp.sides.A.model)}`, `B · ${shortModel(exp.sides.B.model)}`], 'th'),
    tr(['Estado', ap(exp.sides.A), ap(exp.sides.B)]),
    tr(['Calidad', q(exp.sides.A), q(exp.sides.B)]),
    tr(['Fidelidad', f(exp.sides.A), f(exp.sides.B)]),
    tr(['Costo', `${money(ma.cost)} ${cA}`, `${money(mb.cost)} ${cB}`]),
    tr(['Tiempo', `${secs(ma.ms)} ${tA}`, `${secs(mb.ms)} ${tB}`]),
    tr(['Intentos', `${ma.attempts} ${iA}`, `${mb.attempts} ${iB}`]),
    tr(['Herramientas', toolsCell(ma), toolsCell(mb)]),
    tr(['Intervención', String(ma.interventions + (ma.manualMinutes ? ` + ${ma.manualMinutes} min` : '')), String(mb.interventions + (mb.manualMinutes ? ` + ${mb.manualMinutes} min` : ''))]),
  );
  compare.append(table, el('p', 'muted small', '● = mejor en esa métrica.'));

  const pref = el('div', 'options lab-pref');
  [['A', `Prefiero A`], ['tie', 'Empate'], ['B', `Prefiero B`]].forEach(([v, label]) => {
    const b = el('button', 'option', label);
    b.type = 'button';
    b.setAttribute('aria-pressed', String(exp.preference === v));
    b.disabled = !SIDES.some((k) => sides[k].code);
    b.onclick = () => { exp.preference = exp.preference === v ? null : v; persist(); renderCompare(); };
    pref.append(b);
  });
  const notes = el('textarea');
  notes.rows = 2; notes.placeholder = 'Observaciones del experimento (qué aprendiste, qué cambiarías del harness…)'; notes.value = exp.notes || '';
  notes.oninput = () => { exp.notes = notes.value; persistSoon(); };
  compare.append(el('span', 'lab-field-label', '¿Cuál de las dos preferís?'), pref, notes);
}

const shortModel = (id) => String(id || '').split('/').pop();
const toolsCell = (m) => (m.searches || m.images ? `${m.searches} búsq. · ${m.images} img.` : '—');

// ---------- Referencias visuales del brief ----------
function renderRefs() {
  refsBox.replaceChildren();
  briefRefs.forEach((r) => {
    const t = el('div', `thumb${r.status === 'loading' ? ' loading' : ''}`);
    if (r.status === 'loading') t.append(el('span', 'thumb-kind', '🖼️'));
    else { const img = el('img'); img.src = r.thumb; img.alt = r.name; t.append(img); }
    const x = el('button', 'remove', '×');
    x.type = 'button'; x.setAttribute('aria-label', `Quitar referencia ${r.name}`);
    x.onclick = () => { briefRefs = briefRefs.filter((k) => k !== r); renderRefs(); refresh(); };
    t.append(x);
    refsBox.append(t);
  });
  const max = info.harness.maxBriefRefs || 6;
  if (briefRefs.length < max) {
    const add = el('label', 'add-ref');
    const inp = el('input');
    inp.type = 'file'; inp.accept = 'image/*'; inp.multiple = true; inp.hidden = true;
    inp.onchange = () => { addRefs([...inp.files]); inp.value = ''; };
    add.append(inp, el('span', null, '+ Referencia'), el('span', 'muted small', 'imágenes'));
    refsBox.append(add);
  }
}

async function addRefs(files) {
  const max = info.harness.maxBriefRefs || 6;
  const room = max - briefRefs.length;
  if (files.length > room) error(`Máximo ${max} referencias visuales.`);
  const added = files.slice(0, Math.max(0, room)).map((file) => ({ key: ++seq, name: file.name, status: 'loading', file }));
  briefRefs.push(...added);
  renderRefs(); refresh();
  await Promise.all(added.map(async (r) => {
    try {
      const p = await loadPhoto(r.file);
      URL.revokeObjectURL(p.url);
      Object.assign(r, { url: p.frames[0].url, thumb: p.thumb, status: 'ready' });
    } catch (err) {
      error(`${r.name}: ${err.message}`);
      briefRefs = briefRefs.filter((k) => k !== r);
    }
    delete r.file;
    renderRefs(); refresh();
  }));
}

// ---------- Guardado ----------
function persist() {
  if (!exp) return;
  try { store.saveExperiment(exp); } catch (err) { error(err.message); }
}
let saveTimer = 0;
function persistSoon() { clearTimeout(saveTimer); saveTimer = setTimeout(persist, 400); }

// ---------- Historial ----------
const historyBox = $('lab-history');

function renderHistory() {
  const list = store.listExperiments();
  historyBox.replaceChildren();
  const head = el('div', 'lab-history-head');
  head.append(el('h2', 'raw-section', 'Modelos'));
  const exportBtn = el('button', 'small-btn', 'Exportar JSON');
  exportBtn.type = 'button';
  exportBtn.disabled = !list.length;
  exportBtn.onclick = () => {
    const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), experiments: list, stats: modelStats(list) }, null, 2)], { type: 'application/json' });
    const a = el('a');
    a.href = URL.createObjectURL(blob);
    a.download = `laboratorio-motion-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  head.append(exportBtn);
  historyBox.append(head);

  if (!list.length) {
    historyBox.append(el('p', 'muted', 'Todavía no hay experimentos. Cuando ejecutes uno, acá vas a ver qué modelos se aprueban más y cuánto cuesta cada animación aprobada.'));
    return;
  }

  const stats = modelStats(list);
  const wrap = el('div', 'lab-table-wrap');
  const table = el('table', 'lab-table lab-stats');
  const tr = (cells, tag = 'td') => { const r = el('tr'); cells.forEach((c) => r.append(el(tag, null, c))); return r; };
  const pct = (x) => `${Math.round(x * 100)}%`;
  const n1 = (x) => (x === null ? '—' : x.toFixed(1));
  table.append(tr(['Modelo', 'Ejecuciones', 'Aprobadas', 'Preferido', 'Calidad', 'Fidelidad', 'Costo medio', 'Costo por aprobada', 'Tiempo medio', 'Intentos medios', 'Intervención media'], 'th'));
  stats.forEach((s) => table.append(tr([
    s.model, String(s.runs), `${s.approved} (${pct(s.approvalRate)})`, `${s.wins} de ${s.wins + s.losses + s.ties}`,
    n1(s.avgQuality), n1(s.avgFidelity), money(s.avgCost), money(s.costPerApproved), secs(s.avgMs), n1(s.avgAttempts), n1(s.avgInterventions),
  ])));
  wrap.append(table);
  historyBox.append(wrap, el('p', 'muted small', 'Costo por aprobada = todo lo que gastó el modelo (también en ejecuciones rechazadas, correcciones y revisiones) ÷ animaciones aprobadas.'));

  historyBox.append(el('h2', 'raw-section', 'Experimentos'));
  const cards = el('div', 'lab-history-list');
  list.forEach((ex) => {
    const c = el('article', 'lab-card lab-history-item');
    const top = el('div', 'lab-history-top');
    const title = el('div');
    title.append(el('strong', null, ex.name), el('div', 'muted small', `${new Date(ex.createdAt).toLocaleString('es')} · ${ex.video?.name || ''} · ${ex.zones?.length || 0} zona${ex.zones?.length === 1 ? '' : 's'}`));
    top.append(title, el('span', 'pill', experimentStatus(ex)));
    const vs = el('div', 'lab-vs');
    SIDES.forEach((k) => {
      const r = ex.sides[k];
      const m = runMetrics(r);
      const box = el('div', `lab-vs-side${ex.preference === k ? ' win' : ''}`);
      box.append(
        el('span', 'lab-badge', k),
        el('span', 'lab-vs-model', shortModel(r.model)),
        el('span', 'small', [r.eval?.approved === true ? '✓' : r.eval?.approved === false ? '✕' : '', r.eval?.quality ? `${r.eval.quality}★` : '', money(m.cost), `${m.attempts} int.`].filter(Boolean).join(' · ')),
      );
      vs.append(box);
    });
    if (ex.preference === 'tie') vs.append(el('span', 'small muted', 'empate'));
    const actions = el('div', 'actions compact');
    const open = el('button', 'small-btn', 'Abrir');
    open.type = 'button';
    open.onclick = () => openExperiment(ex.id);
    const del = el('button', 'small-btn', 'Borrar');
    del.type = 'button';
    del.onclick = async () => {
      if (!confirm(`¿Borrar "${ex.name}" del historial? También se borran su video y su código guardados en este navegador.`)) return;
      await store.deleteExperiment(ex.id);
      if (exp?.id === ex.id) newBtn.onclick();
      renderHistory();
    };
    actions.append(open, del);
    c.append(top, vs);
    if (ex.notes) c.append(el('p', 'small', ex.notes));
    c.append(el('p', 'muted small', ex.harness || ''), actions);
    cards.append(c);
  });
  historyBox.append(cards);
}

// Reabre un experimento: video y zonas al marcador, brief, código de cada agente y sus evaluaciones.
async function openExperiment(id) {
  const ex = store.listExperiments().find((x) => x.id === id);
  if (!ex) return;
  if (busy()) return error('Esperá a que terminen los agentes (o detenelos) antes de abrir otro experimento.');
  error('');
  const [video, inputs] = await Promise.all([store.getBlob(`${id}:video`), store.getBlob(`${id}:inputs`)]);
  if (!video || !inputs) {
    error('El video o el material de este experimento ya no están en este navegador: solo quedan sus métricas en el historial.');
    return;
  }
  setView('experiment');
  await studio.setVideo(video);
  studio.setClips(inputs.payload.clips.map((c) => ({ ...c, refs: c.refs.map((r) => ({ ...r, thumb: r.frames[0] })) })));
  contextInput.value = inputs.brief.context;
  instructionsInput.value = inputs.brief.instructions;
  briefRefs = inputs.brief.refs.map((r) => ({ key: ++seq, name: r.name, url: r.url, thumb: r.url, status: 'ready' }));
  renderRefs();
  exp = ex;
  frozen = { ...inputs, file: video };
  nameInput.value = ex.name;
  for (const k of SIDES) {
    const s = sides[k];
    const run = ex.sides[k];
    // Una ejecución que quedó a medias (se cerró la página) ya no sigue.
    if (run.status === 'running' || run.status === 'checking') { run.status = 'error'; run.error = 'se interrumpió (se cerró o recargó la página)'; }
    const saved = await store.getBlob(`${id}:code:${k}`);
    s.code = saved?.code || ''; s.js = saved?.js || ''; s.turns = saved?.turns || []; s.assets = saved?.assets || []; s.found = saved?.found || []; s.runtimeFixes = MAX_RUNTIME_FIXES;
    s.model.value = run.model;
    s.showPrice();
    s.clearOut();
    unmount(s);
    s.render();
    if (s.js) mount(s);
  }
  persist();
  renderCompare();
  refresh();
}

// ---------- Vistas y arranque ----------
function setView(view) {
  document.querySelectorAll('[data-lab-view]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.labView === view)));
  $('lab-experiment').hidden = view !== 'experiment';
  historyBox.hidden = view !== 'history';
  if (view === 'history') renderHistory();
}
document.querySelectorAll('[data-lab-view]').forEach((b) => b.addEventListener('click', () => setView(b.dataset.labView)));

async function start() {
  started = true;
  renderRefs();
  SIDES.forEach((k) => sides[k].render());
  const p = store.prefs();
  sides.A.model.value = p.modelA || 'anthropic/claude-opus-5.5';
  sides.B.model.value = p.modelB || 'qwen/qwen3.8-max-prime';
  refresh();
  try {
    info = await fetch('/api/lab/models').then((r) => r.json());
  } catch {
    error('No pude leer la lista de modelos; podés escribir el ID de OpenRouter a mano.');
  }
  datalist.replaceChildren(...(info.models || []).map((m) => {
    const o = el('option');
    o.value = m.id;
    o.label = m.prompt !== null && m.prompt !== undefined ? `${m.name} · $${fmtPrice(m.prompt)}/$${fmtPrice(m.completion)} por M` : m.name;
    return o;
  }));
  // El Laboratorio permite zonas más largas que Intuition.
  studio.setLimits({ maxClipSeconds: info.harness?.maxZoneSeconds || 11 });
  harnessPill.textContent = `Harness ${info.harness?.version || ''}${info.mock ? ' · demo' : ''}`;
  const t = info.harness?.tools || {};
  harnessPill.title = `Mismo harness para los dos modelos.\nRemotion ${info.harness?.remotion} · ${info.harness?.fps} fps · zonas de hasta ${info.harness?.maxZoneSeconds} s\nHerramientas: ${t.search ? `búsqueda de referencias obligatoria (Google Images vía SerpAPI, máx. ${t.maxSearches} por ejecución)` : 'búsqueda desactivada (falta SERPAPI_API_KEY)'} · ${t.images ? `${t.imageModel} (máx. ${t.maxImages} imágenes)` : 'imágenes desactivadas (falta WAVESPEED_API_KEY)'}\nRemotion Agent Skills (remotion-dev/skills @ ${info.harness?.skillsCommit?.slice(0, 7)}):\n${(info.harness?.skills || []).join('\n')}`;
  // Buscar referencias es obligatorio: sin la clave de SerpAPI, los agentes diseñan sin buscar (y queda en la versión del harness).
  setupNote.hidden = !!t.search;
  setupNote.textContent = 'La búsqueda de referencias en internet está desactivada: agregá SERPAPI_API_KEY en .env y reiniciá el servidor. Mientras tanto, los agentes diseñan sin buscar.';
  SIDES.forEach((k) => { sides[k].showPrice(); sides[k].render(); });
  renderRefs();
  refresh();
}

// Soltar archivos en la pestaña: un video es el clip; las imágenes, referencias visuales.
const labTab = () => document.body.dataset.tab === 'lab';
window.addEventListener('dragover', (e) => { if (labTab()) e.preventDefault(); });
window.addEventListener('drop', (e) => {
  if (!labTab()) return;
  e.preventDefault();
  const files = [...(e.dataTransfer?.files || [])];
  const video = files.find((f) => f.type.startsWith('video/'));
  if (video && !busy()) { setView('experiment'); studio.setVideo(video); }
  const images = files.filter((f) => f.type.startsWith('image/'));
  if (images.length) addRefs(images);
});

window.addEventListener('tab', ({ detail }) => {
  if (detail === 'lab' && !started) start();
  // Al salir de la pestaña, los players se pausan.
  if (detail !== 'lab') SIDES.forEach((k) => sides[k].frame?.contentWindow?.postMessage({ type: 'pause' }, '*'));
});
if (document.body.dataset.tab === 'lab' && !started) start();
