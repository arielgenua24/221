import { el } from './shared.js';
import { silhouetteExp3, silhouetteExp4, maskCanvas, edgeCanvas, frameArea, maskRle } from './objects-masks.js';
import { create3dView, buildBlocks } from './objects-3d-view.js';

// Pestaña Laboratorio · Objetos 3D (motor de objetos 3D decisional).
// 1. Elegís un cuadro (de un video o una foto). 2. Se le dibuja una cuadrícula con el nombre de cada celda.
// 3. JEV responde preguntas cerradas sobre cada objeto: ¿está?, ¿dónde? (Box), ¿qué es para la animación?
//    (Choice), ¿qué tan lejos? (Score), ¿quién está delante de quién? (Noul por pares) y, si querés,
//    ¿qué celdas son espacio libre? (Noul por celda). 4. El mapa de escena se dibuja encima del cuadro.
// 5. Siluetas (JEV a píxel): dentro del recuadro de cada objeto, el Experimento 3 (grilla + súper-resolución)
//    y/o el 4 (superpíxeles + random walker) sacan su forma real; en lo pisable, también la superficie de
//    arriba y sus bordes (por donde un personaje se cae).

const $ = (id) => document.getElementById(id);
const JEV_MAX_SIDE = 1568, JEV_MIN_SIDE = 256;
const COLORS = ['#ff6a3d', '#3fd1a8', '#8ea2ff', '#ffb45c', '#f783ac', '#66d9e8', '#b197fc', '#ffe066'];
const ROLE_LABEL = { pisable: 'Pisable', obstaculo: 'Obstáculo', persona: 'Persona', fondo: 'Fondo', otro: 'Otro' };
const PREFS = 'lab.objects.prefs.v1';
const colLabel = (c) => String.fromCharCode(65 + c);
const pct = (p) => (p === null || p === undefined ? '—' : `${Math.round(p * 100)}%`);
const tokens = (n) => `${Math.round(n || 0).toLocaleString('es-AR')} tokens`;
const METHOD_LABEL = { exp3: 'Exp 3 · grilla + súper-resolución', exp4: 'Exp 4 · superpíxeles + random walker' };
const TOP_COLOR = '#ffffff', EDGE_COLOR = '#ff2d55';

let info = null;
let started = false;
let base = null; // canvas con el cuadro limpio, ya en el tamaño que acepta JEV
let sent = null; // data URL de lo que vio JEV (con o sin cuadrícula)
let result = null; // respuesta del servidor
let busy = false;
let sils = null; // { [objId]: { exp3?: { mask, top? }, exp4?: { mask, top? } } }
let silBusy = false;

const prefs = (() => { try { return JSON.parse(localStorage.getItem(PREFS)) || {}; } catch { return {}; } })();
const savePrefs = () => { try { localStorage.setItem(PREFS, JSON.stringify(readForm())); } catch { /* sin almacenamiento */ } };
const error = (msg) => { const e = $('obj-error'); e.textContent = msg || ''; e.hidden = !msg; };

// ---------- Estructura ----------
const root = $('obj-experiment');
const layout = el('div', 'obj-layout');
const side = el('section', 'lab-card obj-side');
const stage = el('section', 'lab-card obj-stage');
layout.append(side, stage);
const results = el('section', 'obj-results');
results.hidden = true;
root.append(layout, results);

const field = (label, input, hint) => {
  const f = el('label', 'obj-field');
  f.append(el('span', 'decision-label', label), input);
  if (hint) f.append(el('span', 'muted small', hint));
  return f;
};
const check = (label, checked) => {
  const l = el('label', 'obj-check');
  const i = el('input'); i.type = 'checkbox'; i.checked = checked;
  l.append(i, el('span', null, label));
  return [l, i];
};
const select = (options, value) => {
  const s = el('select', 'obj-input');
  for (const [v, l] of options) { const o = el('option', null, l); o.value = String(v); s.append(o); }
  s.value = String(value);
  return s;
};
const number = (value, min, max) => { const i = el('input', 'obj-num'); i.type = 'number'; i.min = min; i.max = max; i.value = value; return i; };

const pick = el('label', 'ghost lab-pick', 'Elegir video o imagen');
const fileInput = el('input'); fileInput.type = 'file'; fileInput.accept = 'video/*,image/png,image/jpeg,image/webp'; fileInput.hidden = true;
pick.append(fileInput);

const objectsInput = el('textarea'); objectsInput.rows = 5; objectsInput.spellcheck = false;
objectsInput.value = prefs.objects ?? 'mesa\nbrazo\nescritorio del fondo\npersona';
const colsInput = number(prefs.cols ?? 16, 2, 26), rowsInput = number(prefs.rows ?? 9, 2, 20);
const gridRow = el('div', 'obj-grid-row');
gridRow.append(field('Columnas', colsInput), el('span', 'muted', '×'), field('Filas', rowsInput));
const [gridCheckL, gridCheck] = check('Dibujar la cuadrícula en la imagen que ve JEV', prefs.gridOnImage ?? true);
const [pairsCheckL, pairsCheck] = check('Delante y detrás: comparar cada par de objetos', prefs.pairs ?? true);
const [freeCheckL, freeCheck] = check('Espacio libre: una pregunta por celda', prefs.freeSpace ?? false);
const contextInput = el('textarea'); contextInput.rows = 2; contextInput.placeholder = 'Opcional: "una persona habla a cámara en su habitación…"'; contextInput.value = prefs.context ?? '';
const modelInput = el('input', 'obj-input'); modelInput.type = 'text'; modelInput.spellcheck = false; modelInput.value = prefs.model ?? '';
const estimate = el('p', 'muted small obj-estimate');
const run = el('button', 'primary', 'Destripar escena'); run.type = 'button'; run.disabled = true;
const status = el('p', 'muted small'); status.setAttribute('aria-live', 'polite');

const silMethod = select([['both', 'Exp 3 y Exp 4 (comparar)'], ['exp3', METHOD_LABEL.exp3], ['exp4', METHOD_LABEL.exp4]], prefs.silMethod ?? 'both');
const superSelect = select([[48, '48×48 (2.304 micro-celdas)'], [64, '64×64 (4.096)'], [80, '80×80 (6.400)']], prefs.superGrid ?? 64);
const kSelect = select([[256, '256 superpíxeles'], [400, '400'], [600, '600']], prefs.k ?? 400);
const [topCheckL, topCheck] = check('Lo pisable: superficie de arriba y sus bordes', prefs.top ?? true);
const [refineCheckL, refineCheck] = check('Exp 4: refinar los bordes inciertos (un ciclo más)', prefs.refine ?? false);
const [absentCheckL, absentCheck] = check('Incluir también los objetos que JEV no vio (presencia menor a 50%)', false);
const silEstimate = el('p', 'muted small obj-estimate');
const silRun = el('button', 'primary', 'Sacar siluetas'); silRun.type = 'button'; silRun.disabled = true;
const silStatus = el('p', 'muted small'); silStatus.setAttribute('aria-live', 'polite');
const silHead = el('div', 'lab-side-head obj-sil-head');
silHead.append(el('strong', null, 'Siluetas · JEV a píxel'));

side.append(
  el('div', 'lab-side-head'), pick,
  field('Objetos a mapear', objectsInput, 'Uno por línea, hasta 8. JEV no inventa nombres: le decimos qué buscar.'),
  gridRow, gridCheckL, pairsCheckL, freeCheckL,
  field('Contexto', contextInput),
  field('Modelo', modelInput),
  estimate, run, status,
  silHead,
  el('p', 'muted small', 'Después de destripar: la forma real de cada objeto dentro de su recuadro, con los Experimentos 3 y 4.'),
  field('Método', silMethod),
  field('Exp 3 · súper-resolución', superSelect),
  field('Exp 4 · superpíxeles', kSelect),
  topCheckL, refineCheckL, absentCheckL, silEstimate, silRun, silStatus,
);
side.firstChild.append(el('strong', null, 'Cuadro y preguntas'));

const video = el('video', 'obj-video'); video.controls = true; video.muted = true; video.playsInline = true; video.hidden = true;
const capture = el('button', 'small-btn', 'Usar este cuadro'); capture.type = 'button'; capture.hidden = true;
const canvas = el('canvas', 'obj-canvas'); canvas.hidden = true;
const empty = el('div', 'obj-empty muted', 'Soltá un video o una foto acá. Del video elegís el cuadro a destripar.');
const layers = el('div', 'obj-layers'); layers.hidden = true;
const layer = {};
for (const [key, label, on] of [['grid', 'Cuadrícula', true], ['boxes', 'Recuadros', true], ['free', 'Espacio libre', true], ['sent', 'Lo que vio JEV', false]]) {
  const [l, i] = check(label, on); layer[key] = i; i.onchange = draw; layers.append(l);
}
for (const [key, label] of [['masks', 'Siluetas'], ['top', 'Superficie y bordes']]) {
  const [l, i] = check(label, true); layer[key] = i; i.onchange = draw; layers.append(l);
}
const silView = select([['exp3', 'Ver Exp 3'], ['exp4', 'Ver Exp 4']], 'exp4'); silView.hidden = true; silView.onchange = () => { draw(); update3d(); };
const lambdaWrap = el('label', 'obj-lambda'); lambdaWrap.hidden = true;
const lambdaInput = el('input'); lambdaInput.type = 'range'; lambdaInput.min = 5; lambdaInput.max = 150; lambdaInput.step = 5; lambdaInput.value = 50;
const lambdaLabel = el('span', 'small', 'λ suavidad · 50');
lambdaWrap.append(lambdaLabel, lambdaInput);
layers.append(silView, lambdaWrap);
stage.append(empty, video, capture, canvas, layers);
stage.dataset.drop = 'objects';

// ---------- Cuadro ----------
function frameFrom(source, w, h) {
  let s = Math.min(1, JEV_MAX_SIDE / Math.max(w, h));
  if (Math.min(w, h) * s < JEV_MIN_SIDE) s = JEV_MIN_SIDE / Math.min(w, h);
  const c = document.createElement('canvas');
  c.width = Math.round(w * s); c.height = Math.round(h * s);
  c.getContext('2d').drawImage(source, 0, 0, c.width, c.height);
  return c;
}

function setFrame(c) {
  base = c; result = null; sent = null; sils = null; results.hidden = true;
  canvas.width = c.width; canvas.height = c.height;
  canvas.hidden = false; layers.hidden = false; empty.hidden = true;
  run.disabled = busy;
  draw(); updateEstimate();
}

async function loadFile(file) {
  error('');
  if (!file) return;
  if (file.type.startsWith('video/')) {
    video.src = URL.createObjectURL(file); video.hidden = false; capture.hidden = false; empty.hidden = true;
    video.onloadeddata = () => { if (!base) grabVideo(); };
    return;
  }
  if (!file.type.startsWith('image/')) return error('Elegí un video o una imagen.');
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    video.hidden = true; capture.hidden = true;
    setFrame(frameFrom(bmp, bmp.width, bmp.height));
  } catch { error('No pude leer la imagen.'); }
}
function grabVideo() {
  if (!video.videoWidth) return;
  setFrame(frameFrom(video, video.videoWidth, video.videoHeight));
  status.textContent = `Cuadro en ${video.currentTime.toFixed(2)} s · ${base.width}×${base.height} px`;
}
capture.onclick = grabVideo;
fileInput.onchange = () => { loadFile(fileInput.files[0]); fileInput.value = ''; };

// ---------- Dibujo ----------
function gridOf() {
  return { cols: Math.min(26, Math.max(2, Number(colsInput.value) || 16)), rows: Math.min(20, Math.max(2, Number(rowsInput.value) || 9)) };
}

// Cuadrícula con el nombre de cada celda (la misma que ve JEV cuando se dibuja en la imagen).
function drawGrid(ctx, w, h, { cols, rows }) {
  const cw = w / cols, ch = h / rows;
  const font = Math.max(9, Math.min(16, Math.round(Math.min(cw, ch) * 0.2)));
  ctx.save();
  ctx.lineWidth = Math.max(1, w / 900);
  ctx.strokeStyle = 'rgba(0,0,0,.55)';
  for (const off of [ctx.lineWidth, 0]) {
    ctx.beginPath();
    for (let c = 1; c < cols; c++) { ctx.moveTo(c * cw + off, 0); ctx.lineTo(c * cw + off, h); }
    for (let r = 1; r < rows; r++) { ctx.moveTo(0, r * ch + off); ctx.lineTo(w, r * ch + off); }
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,.75)';
  }
  ctx.font = `600 ${font}px ui-monospace, Menlo, monospace`;
  ctx.textBaseline = 'top';
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const name = `${colLabel(c)}${r + 1}`;
      const x = c * cw + 2, y = r * ch + 2, tw = ctx.measureText(name).width;
      ctx.fillStyle = 'rgba(0,0,0,.55)'; ctx.fillRect(x, y, tw + 4, font + 3);
      ctx.fillStyle = '#fff'; ctx.fillText(name, x + 2, y + 2);
    }
  }
  ctx.restore();
}

function imageForJev() {
  const c = document.createElement('canvas');
  c.width = base.width; c.height = base.height;
  const ctx = c.getContext('2d');
  ctx.drawImage(base, 0, 0);
  if (gridCheck.checked) drawGrid(ctx, c.width, c.height, gridOf());
  return c.toDataURL('image/jpeg', 0.9);
}

let sentImg = null;
function draw() {
  if (!base) return;
  const ctx = canvas.getContext('2d');
  const { width: w, height: h } = canvas;
  ctx.clearRect(0, 0, w, h);
  if (layer.sent.checked && sentImg?.complete) ctx.drawImage(sentImg, 0, 0, w, h);
  else ctx.drawImage(base, 0, 0);
  const scene = result?.scene;
  const grid = scene?.grid || gridOf();
  if (scene && layer.free.checked && scene.free.length) {
    const cw = w / grid.cols, ch = h / grid.rows;
    for (const f of scene.free) {
      if (f.p < 0.5) continue;
      ctx.fillStyle = `rgba(63,209,168,${(0.15 + (f.p - 0.5) * 0.8).toFixed(2)})`;
      ctx.fillRect(f.col * cw, f.row * ch, cw, ch);
    }
  }
  if (scene && sils) drawSilhouettes(ctx, w, h, scene);
  if (layer.grid.checked && !layer.sent.checked) drawGrid(ctx, w, h, grid);
  if (scene && layer.boxes.checked) {
    const lw = Math.max(2, w / 400), font = Math.max(12, Math.round(w / 60));
    // Del fondo hacia adelante: lo más cercano queda dibujado encima, como en la escena.
    const byDepth = [...scene.objects].sort((a, b) => (a.zIndex ?? 0) - (b.zIndex ?? 0));
    for (const o of byDepth) {
      if (!o.box) continue;
      const k = scene.objects.indexOf(o);
      const absent = o.present !== null && o.present < 0.5;
      const x = o.box.left * w, y = o.box.top * h, bw = (o.box.right - o.box.left) * w, bh = (o.box.bottom - o.box.top) * h;
      ctx.save();
      ctx.lineWidth = lw; ctx.strokeStyle = COLORS[k % COLORS.length];
      if (absent) { ctx.setLineDash([lw * 3, lw * 3]); ctx.globalAlpha = 0.5; }
      ctx.strokeRect(x, y, bw, bh);
      const label = `${o.zIndex ? `z${o.zIndex} · ` : ''}${o.name}${o.role ? ` · ${ROLE_LABEL[o.role.choice] || o.role.choice}` : ''}${o.depth ? ` · ~${o.depth.meters} m` : ''}`;
      ctx.font = `600 ${font}px system-ui, sans-serif`;
      const tw = ctx.measureText(label).width;
      const ly = y - font - 8 < 0 ? y + 2 : y - font - 8;
      ctx.fillStyle = COLORS[k % COLORS.length]; ctx.fillRect(x, ly, tw + 10, font + 6);
      ctx.fillStyle = '#111'; ctx.textBaseline = 'top'; ctx.fillText(label, x + 5, ly + 3);
      ctx.restore();
    }
  }
}

// Siluetas del fondo hacia adelante, y encima la superficie de arriba con sus bordes en rojo.
const viewMethod = (entry) => (entry?.[silView.value] ? silView.value : entry?.exp4 ? 'exp4' : 'exp3');
// Canvases ya pintados por silueta; se rehacen cuando λ cambia la máscara del Exp 4.
function canvasFor(sil, key, make) {
  if (sil._canvasLambda !== sil.lambda) { sil._canvas = {}; sil._canvasLambda = sil.lambda; }
  sil._canvas ||= {};
  return (sil._canvas[key] ||= make());
}
function blit(ctx, w, h, sil, c) {
  const b = sil.paddedBox;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(c, b.left * w, b.top * h, (b.right - b.left) * w, (b.bottom - b.top) * h);
  ctx.imageSmoothingEnabled = true;
}
function drawSilhouettes(ctx, w, h, scene) {
  const byDepth = [...scene.objects].sort((a, b) => (a.zIndex ?? 0) - (b.zIndex ?? 0));
  for (const o of byDepth) {
    const entry = sils[o.id]?.[viewMethod(sils[o.id])];
    if (!entry) continue;
    const color = COLORS[scene.objects.indexOf(o) % COLORS.length];
    if (layer.masks.checked && entry.mask) blit(ctx, w, h, entry.mask, canvasFor(entry.mask, 'mask', () => maskCanvas(entry.mask, color, 0.45)));
    if (layer.top.checked && entry.top) {
      blit(ctx, w, h, entry.top, canvasFor(entry.top, 'top', () => maskCanvas(entry.top, TOP_COLOR, 0.35)));
      blit(ctx, w, h, entry.top, canvasFor(entry.top, 'edge', () => edgeCanvas(entry.top, EDGE_COLOR).canvas));
    }
  }
}

// ---------- Formulario ----------
function readForm() {
  return {
    objects: objectsInput.value, cols: gridOf().cols, rows: gridOf().rows,
    gridOnImage: gridCheck.checked, pairs: pairsCheck.checked, freeSpace: freeCheck.checked && gridCheck.checked,
    context: contextInput.value, model: modelInput.value.trim(),
    silMethod: silMethod.value, superGrid: Number(superSelect.value), k: Number(kSelect.value), top: topCheck.checked, refine: refineCheck.checked,
  };
}
const objectList = () => [...new Set(objectsInput.value.split('\n').map((s) => s.trim()).filter(Boolean))];

function updateEstimate() {
  const n = objectList().length, { cols, rows } = gridOf();
  freeCheck.disabled = !gridCheck.checked;
  const q = n * 4 + (pairsCheck.checked ? (n * (n - 1)) / 2 : 0) + (freeCheck.checked && gridCheck.checked ? cols * rows : 0);
  const calls = Math.ceil(q / (info?.maxPerRequest || 600)) || 0;
  estimate.textContent = `${q} preguntas · ${calls} llamada${calls === 1 ? '' : 's'} a JEV en paralelo${n > (info?.maxObjects || 8) ? ` · máximo ${info?.maxObjects || 8} objetos` : ''}`;
  run.disabled = busy || !base || !n || n > (info?.maxObjects || 8);
  updateSilEstimate();
}

const isAbsent = (o) => o.present !== null && o.present < 0.5;
function silJobs() {
  if (!result) return [];
  const methods = silMethod.value === 'both' ? ['exp3', 'exp4'] : [silMethod.value];
  const jobs = [];
  for (const o of result.scene.objects) {
    if (!o.box || (!absentCheck.checked && isAbsent(o))) continue;
    for (const m of methods) {
      jobs.push({ o, m, kind: 'mask', subject: o.name });
      if (topCheck.checked && o.role?.choice === 'pisable') jobs.push({ o, m, kind: 'top', subject: `la superficie de arriba de ${o.name}: la parte plana que mira hacia arriba, donde un muñeco pequeño podría pararse o caminar` });
    }
  }
  return jobs;
}
function updateSilEstimate() {
  const jobs = silJobs();
  if (!result) { silEstimate.textContent = 'Primero destripá la escena: las siluetas se buscan dentro de cada recuadro.'; silRun.disabled = true; return; }
  const k = Number(kSelect.value);
  const q = jobs.reduce((s, j) => s + (j.m === 'exp3' ? 260 : k + 4), 0);
  const calls = jobs.length + (refineCheck.checked ? jobs.filter((j) => j.m === 'exp4').length : 0);
  // Lo que JEV no vio queda afuera: decirlo, para que no parezca que el botón no anda.
  const skipped = absentCheck.checked ? [] : result.scene.objects.filter((o) => o.box && isAbsent(o));
  const why = skipped.length ? ` · sin ${skipped.map((o) => `${o.name} (JEV lo ve con ${pct(o.present)})`).join(', ')}` : '';
  silEstimate.textContent = jobs.length
    ? `${jobs.length} silueta${jobs.length === 1 ? '' : 's'} · ~${q} preguntas${refineCheck.checked ? ' + refinamiento (hasta 640 por silueta del Exp 4)' : ''} · hasta ${calls} llamadas a JEV${why}`
    : `Ninguna silueta: JEV no vio ninguno de los objetos de la lista${why}. Escribí lo que hay en tu imagen y destripá de nuevo, o marcá "Incluir también los objetos que JEV no vio".`;
  silRun.disabled = silBusy || busy || !jobs.length;
}
for (const i of [objectsInput, colsInput, rowsInput, contextInput, modelInput]) i.oninput = () => { updateEstimate(); if (!result) draw(); savePrefs(); };
for (const i of [gridCheck, pairsCheck, freeCheck, topCheck, refineCheck, absentCheck, silMethod, superSelect, kSelect]) i.onchange = () => { updateEstimate(); savePrefs(); };

// ---------- Destripar ----------
run.onclick = async () => {
  if (busy || !base) return;
  error(''); busy = true; run.disabled = true; run.textContent = 'JEV está mirando…';
  const f = readForm();
  sent = imageForJev();
  sentImg = new Image(); sentImg.onload = draw; sentImg.src = sent;
  const t0 = performance.now();
  try {
    const res = await fetch('/api/lab/objects/analyze', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: sent, objects: objectList(), grid: { cols: f.cols, rows: f.rows }, gridOnImage: f.gridOnImage, pairs: f.pairs, freeSpace: f.freeSpace, context: f.context, model: f.model || undefined }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
    result = data; sils = null;
    status.textContent = `${data.model} · ${data.calls.reduce((s, c) => s + Object.keys(c.questions).length, 0)} preguntas en ${data.calls.length} llamada${data.calls.length === 1 ? '' : 's'} · ${((data.ms || performance.now() - t0) / 1000).toFixed(1)} s · ${tokens(data.usage?.input_tokens)}`;
    renderResults();
    draw();
  } catch (e) {
    error(`No se pudo destripar la escena: ${e.message}`);
  } finally {
    busy = false; run.textContent = 'Destripar escena'; updateEstimate();
  }
};

// ---------- Siluetas ----------
async function pool(items, size, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => { while (next < items.length) await fn(items[next++]); }));
}

silRun.onclick = async () => {
  if (silBusy || !result) return;
  const jobs = silJobs();
  if (!jobs.length) return;
  error(''); silBusy = true; silRun.disabled = true; silRun.textContent = 'JEV está recortando…';
  sils = {};
  let done = 0;
  const failed = [];
  const t0 = performance.now();
  const model = modelInput.value.trim() || undefined;
  silStatus.textContent = `0 de ${jobs.length} siluetas…`;
  await pool(jobs, 3, async (j) => {
    try {
      const opts = { frame: base, box: j.o.box, subject: j.subject, model };
      const s = j.m === 'exp3' ? await silhouetteExp3({ ...opts, superGrid: Number(superSelect.value) })
        : await silhouetteExp4({ ...opts, k: Number(kSelect.value), refine: refineCheck.checked, lambda: Number(lambdaInput.value) });
      ((sils[j.o.id] ||= {})[j.m] ||= {})[j.kind] = s;
    } catch (e) {
      failed.push(`${j.o.name} (${j.m === 'exp3' ? 'Exp 3' : 'Exp 4'}${j.kind === 'top' ? ', superficie' : ''}): ${e.message}`);
    }
    done++;
    silStatus.textContent = `${done} de ${jobs.length} siluetas…`;
    showSilControls(); draw();
  });
  silBusy = false; silRun.textContent = 'Sacar siluetas';
  const all = Object.values(sils).flatMap((e) => Object.values(e).flatMap((m) => Object.values(m)));
  silStatus.textContent = `${all.length} silueta${all.length === 1 ? '' : 's'} · ${all.reduce((s, x) => s + x.calls, 0)} llamadas · ${all.reduce((s, x) => s + x.questions, 0)} preguntas · ${((performance.now() - t0) / 1000).toFixed(1)} s · ${tokens(all.reduce((s, x) => s + x.usage.input, 0))}`;
  if (failed.length) error(`Algunas siluetas fallaron: ${failed.join(' · ')}`);
  updateSilEstimate(); renderResults(); draw();
};

function showSilControls() {
  const methods = new Set(Object.values(sils || {}).flatMap((e) => Object.keys(e)));
  silView.hidden = methods.size < 2;
  lambdaWrap.hidden = !methods.has('exp4');
}

// λ re-resuelve el random walker del Exp 4 en el navegador: 0 llamadas a JEV.
lambdaInput.oninput = () => { lambdaLabel.textContent = `λ suavidad · ${lambdaInput.value}`; };
lambdaInput.onchange = () => {
  lambdaLabel.textContent = `λ suavidad · ${lambdaInput.value} · recalculando…`;
  setTimeout(() => {
    for (const e of Object.values(sils || {})) for (const part of Object.values(e.exp4 || {})) part.resolve(Number(lambdaInput.value));
    lambdaLabel.textContent = `λ suavidad · ${lambdaInput.value}`;
    draw(); if (result) renderResults();
  }, 30);
};

function silhouettesJson() {
  if (!sils) return undefined;
  const pack = (s) => s && { method: s.method, paddedBox: s.paddedBox, w: s.w, h: s.h, threshold: 0.5, ...(s.method === 'exp4' ? { lambda: s.lambda } : {}), areaOfFrame: +frameArea(s).toFixed(4), mask: maskRle(s) };
  return Object.fromEntries(Object.entries(sils).map(([id, e]) => [id, Object.fromEntries(Object.entries(e).map(([m, parts]) => [m, { silhouette: pack(parts.mask), topSurface: pack(parts.top) }]))]));
}

function silCard(scene) {
  const card = el('section', 'lab-card');
  card.append(el('strong', null, 'Siluetas'));
  const t = el('table', 'obj-table');
  const head = el('tr');
  for (const h of ['', 'Objeto', 'Método', 'Silueta', 'Superficie de arriba', 'Bordes', 'Llamadas · preguntas', 'Tokens', 'Tiempo', 'Detalle']) head.append(el('th', null, h));
  t.append(head);
  scene.objects.forEach((o, k) => {
    for (const m of ['exp3', 'exp4']) {
      const e = sils[o.id]?.[m];
      if (!e) continue;
      const parts = [e.mask, e.top].filter(Boolean);
      const tr = el('tr');
      const sw = el('span', 'obj-swatch'); sw.style.background = COLORS[k % COLORS.length];
      const tdSw = el('td'); tdSw.append(sw);
      const s = e.mask || e.top;
      const detail = m === 'exp3' ? `${s.stats.superGrid}×${s.stats.superGrid} · semillas ${s.stats.fgSeeds}/${s.stats.bgSeeds} · banda ${s.stats.refinedBand}`
        : `k ${s.stats.k} · sin ID ${s.stats.unlabeled} · sin respuesta ${s.stats.missing}${s.stats.tiles ? ` · tiles ${s.stats.tiles}/${s.stats.candidates} (caché ${s.stats.cacheHits})` : ''} · λ ${s.lambda}`;
      tr.append(tdSw, el('td', null, o.name), el('td', null, METHOD_LABEL[m]),
        el('td', null, e.mask ? `${pct(frameArea(e.mask))} del cuadro` : '—'),
        el('td', null, e.top ? `${pct(frameArea(e.top))} del cuadro` : o.role?.choice === 'pisable' ? 'falló' : 'no es pisable'),
        el('td', null, e.top ? `${edgeCanvas(e.top, EDGE_COLOR).edgePixels} px de borde` : '—'),
        el('td', null, `${parts.reduce((a, p) => a + p.calls, 0)} · ${parts.reduce((a, p) => a + p.questions, 0)}`),
        el('td', null, tokens(parts.reduce((a, p) => a + p.usage.input, 0))),
        el('td', null, `${(parts.reduce((a, p) => a + p.ms, 0) / 1000).toFixed(1)} s`),
        el('td', 'small muted', detail));
      t.append(tr);
    }
  });
  const wrap = el('div', 'obj-table-wrap'); wrap.append(t);
  card.append(wrap, el('p', 'muted small', 'Silueta: el color del objeto. Superficie de arriba: en blanco; su borde en rojo es por donde un personaje se cae. El Exp 3 sale en micro-celdas; el Exp 4, a píxel del recorte (mové λ para suavizarlo sin volver a llamar a JEV).'));
  return card;
}

// ---------- Recreación 3D ----------
const view3d = create3dView();
function card3d() {
  const card = el('section', 'lab-card');
  card.append(el('strong', null, 'Recreación 3D'), el('p', 'muted small', 'El mapa de escena llevado a un cubo: cada objeto a la distancia que estimó JEV y con su tamaño real (lo lejano se agranda). La forma sale de las siluetas; sin siluetas, del recuadro. Arrastrá para girar, rueda para acercar.'), view3d.el);
  return card;
}
function update3d() {
  if (!result || !base || !view3d.el.isConnected) return;
  view3d.update(buildBlocks({ scene: result.scene, sils, method: silView.value, aspect: base.height / base.width, colors: COLORS }));
}

// ---------- Resultados ----------
function bar(p) {
  const b = el('span', 'obj-bar'); const i = el('i'); i.style.width = `${Math.round((p || 0) * 100)}%`; b.append(i); return b;
}
function probs(map, labels = {}) {
  const box = el('div', 'obj-probs');
  for (const [k, p] of Object.entries(map || {}).sort((a, b) => b[1] - a[1])) {
    const row = el('div', 'obj-prob');
    row.append(el('span', 'small', labels[k] || k), bar(p), el('span', 'small muted', pct(p)));
    box.append(row);
  }
  return box;
}

function renderResults() {
  const { scene } = result;
  results.replaceChildren();
  results.hidden = false;

  const table = el('section', 'lab-card');
  table.append(el('strong', null, 'Objetos'));
  const wrap = el('div', 'obj-table-wrap');
  const t = el('table', 'obj-table');
  const head = el('tr');
  for (const h of ['', 'Objeto', '¿Está?', 'Dónde (celdas)', 'Qué es', 'Distancia', 'Escala', 'Z']) head.append(el('th', null, h));
  t.append(head);
  scene.objects.forEach((o, k) => {
    const tr = el('tr');
    const sw = el('span', 'obj-swatch'); sw.style.background = COLORS[k % COLORS.length];
    const tdSw = el('td'); tdSw.append(sw);
    const role = el('td'); if (o.role) role.append(el('span', null, `${ROLE_LABEL[o.role.choice] || o.role.choice} (${pct(o.role.confidence)})`), probs(o.role.probabilities, ROLE_LABEL));
    const depth = el('td'); if (o.depth) depth.append(el('span', null, `~${o.depth.meters} m (${pct(o.depth.confidence)})`), probs(Object.fromEntries(Object.entries(o.depth.probabilities || {}).map(([lvl, p]) => [info?.depth?.[lvl]?.label?.split(' (')[0] || lvl, p]))));
    tr.append(tdSw, el('td', null, o.name), el('td', null, pct(o.present)),
      el('td', null, o.cells ? `${o.cells.from}–${o.cells.to} · caja ${pct(o.boxConfidence)}` : '—'),
      role, depth, el('td', null, o.scale ? `×${o.scale}` : '—'), el('td', null, o.zIndex ? String(o.zIndex) : 'no está'));
    t.append(tr);
  });
  wrap.append(t);
  table.append(wrap, el('p', 'muted small', 'Escala: cuánto se achica un personaje parado en ese objeto respecto del objeto más cercano (×1). Z: el número más alto está más cerca de la cámara y tapa a los demás.'));

  const order = el('section', 'lab-card');
  order.append(el('strong', null, 'Delante y detrás'));
  const ol = el('ol', 'obj-order');
  for (const id of scene.order) {
    const o = scene.objects.find((x) => x.id === id);
    ol.append(el('li', null, `${o.name}${o.frontness !== null && o.frontness !== undefined ? ` — delante del resto con ${pct(o.frontness)}` : ''}`));
  }
  order.append(el('p', 'muted small', 'De lo más cercano a la cámara a lo más lejano.'), ol);
  const n = scene.objects.length;
  if (scene.closer.some((row) => row.some((p) => p !== null))) {
    const m = el('table', 'obj-table obj-matrix');
    const hr = el('tr'); hr.append(el('th', null, '¿más cerca que…?'));
    scene.objects.forEach((o) => hr.append(el('th', null, o.name)));
    m.append(hr);
    for (let i = 0; i < n; i++) {
      const tr = el('tr'); tr.append(el('th', null, scene.objects[i].name));
      for (let j = 0; j < n; j++) {
        const p = scene.closer[i][j];
        const td = el('td', null, i === j ? '·' : pct(p));
        if (p !== null) td.style.background = `color-mix(in srgb, var(--accent) ${Math.round(p * 45)}%, transparent)`;
        tr.append(td);
      }
      m.append(tr);
    }
    const mw = el('div', 'obj-table-wrap'); mw.append(m); order.append(mw);
  }

  const free = el('section', 'lab-card');
  free.append(el('strong', null, 'Espacio libre'));
  if (scene.free.length) {
    const good = scene.free.filter((f) => f.p >= 0.6).sort((a, b) => b.p - a.p);
    free.append(el('p', 'muted small', `${good.length} de ${scene.free.length} celdas con 60% o más de ser espacio libre (en verde sobre el cuadro).`), el('p', 'small obj-cells', good.map((f) => `${f.cell} ${pct(f.p)}`).join(' · ') || 'Ninguna.'));
  } else free.append(el('p', 'muted small', scene.gridOnImage ? 'Activá "Espacio libre" para preguntar celda por celda.' : 'Necesita la cuadrícula dibujada en la imagen: sin ella JEV no sabe cuál es la celda "F4".'));

  const raw = el('details', 'lab-card obj-raw');
  raw.append(el('summary', null, 'Mapa de escena (JSON) y respuestas crudas de JEV'));
  const copy = el('button', 'small-btn', 'Copiar mapa de escena'); copy.type = 'button';
  copy.onclick = async () => { try { await navigator.clipboard.writeText(JSON.stringify({ ...scene, silhouettes: silhouettesJson() }, null, 2)); copy.textContent = 'Copiado'; } catch { copy.textContent = 'No se pudo copiar'; } setTimeout(() => { copy.textContent = 'Copiar mapa de escena'; }, 1500); };
  raw.append(copy, el('pre', 'obj-pre', JSON.stringify(scene, null, 2)), el('strong', 'small', 'Preguntas y respuestas'), el('pre', 'obj-pre', JSON.stringify(result.calls, null, 2)));

  const grid = el('div', 'obj-results-grid');
  grid.append(table, order, free);
  results.append(grid);
  if (sils && Object.keys(sils).length) results.append(silCard(scene));
  results.append(card3d(), raw);
  update3d();
}

// ---------- Soltar archivos y activación ----------
const here = () => document.body.dataset.tab === 'lab-objects';
window.addEventListener('dragover', (e) => { if (here()) e.preventDefault(); });
window.addEventListener('drop', (e) => {
  if (!here()) return;
  e.preventDefault();
  const file = [...(e.dataTransfer?.files || [])].find((f) => f.type.startsWith('video/') || f.type.startsWith('image/'));
  if (file && !busy) loadFile(file);
});

async function start() {
  if (started) return; started = true;
  try {
    info = await fetch('/api/lab/objects/config').then((r) => r.json());
    modelInput.placeholder = info.model;
    side.firstChild.append(el('span', 'muted small', info.mock ? 'demo: respuestas simuladas' : info.available ? 'JEV · API de TypeSafe' : 'falta TYPESAFE_API_KEY'));
  } catch { error('No se pudo leer la configuración de Objetos 3D.'); }
  updateEstimate();
}
window.addEventListener('tab', ({ detail }) => { if (detail === 'lab-objects') start(); });
if (here()) start();
