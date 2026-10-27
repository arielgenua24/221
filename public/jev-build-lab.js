// Pestaña Laboratorio · JEV construye.
// Un LLM planifica (DeepSeek por OpenRouter) y JEV decide. En cada paso el LLM piensa UNA pieza ("el tronco del pino")
// y le pregunta a JEV cómo hacerla, con opciones concretas. Acá se dibuja cada opción puesta en la escena, JEV mira
// las imágenes y elige; la pieza queda y el paso siguiente arranca desde ahí. El bucle corre en el navegador:
// POST /api/lab/jev-build/plan (LLM) y un POST /api/lab/jev-build/choose (JEV) por pregunta.
// Fase 2 · time reducing: ideas en palabras (LLM corto) → JEV elige el concepto → plano entero por objeto (LLM, en
// paralelo) → JEV elige todas las piezas en una sola llamada, mirando las combinaciones → una verificación al final.
// Fase 3 · idioma por relaciones: el mismo camino que la 2, pero el plano dice qué va dónde respecto de qué
// ("encima del tronco", "de acá hasta allá", "en espejo") y las cuentas las hace spec.js.
// Fase 2 y 3 terminan con una revisión: el motor busca piezas que flotan o se esconden, el modelo (viendo la foto si
// puede) propone arreglos, y JEV elige entre la versión de antes y la corregida.
// Las tres fases muestran un cronómetro por etapa para compararlas.
import { el } from './shared.js';
import { applyPiece, describeScene, mergePatches, combos, parsePatch, resolveObject, checkScene } from './jev-build/spec.js';

const $ = (id) => document.getElementById(id);
const TAB = 'lab-jevbuild';
const pct = (p) => `${Math.round((Number(p) || 0) * 100)}%`;
const EMPTY = () => ({ objects: {}, parts: [] });
// El modelo elegido y los últimos usados, en este navegador (si el almacenamiento falla, se usa el del servidor).
const MODEL_KEY = 'jev-build:model', RECENT_KEY = 'jev-build:models';
const readModel = () => { try { return localStorage.getItem(MODEL_KEY) || ''; } catch { return ''; } };
const readRecent = () => { try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); } catch { return []; } };
function saveModel(id) {
  try {
    if (!id) return localStorage.removeItem(MODEL_KEY);
    localStorage.setItem(MODEL_KEY, id);
    localStorage.setItem(RECENT_KEY, JSON.stringify([id, ...readRecent().filter((m) => m !== id)].slice(0, 8)));
  } catch { /* sin almacenamiento: el campo sigue funcionando en esta visita */ }
}
// Preferencias chicas de la caja (fase, ver la escena), en este navegador.
const pref = (key, fallback) => { try { return localStorage.getItem(`jev-build:${key}`) ?? fallback; } catch { return fallback; } };
const setPref = (key, value) => { try { localStorage.setItem(`jev-build:${key}`, value); } catch { /* sin almacenamiento */ } };

// La escena se guarda en este navegador después de cada pieza, así recargar la página no la pierde.
const SCENE_KEY = 'jev-build:scene';
function persist() {
  try { localStorage.setItem(SCENE_KEY, JSON.stringify({ scene: lean(scene), history })); } catch { /* sin almacenamiento: queda Descargar JSON */ }
}

// Escena guardada o descargada → escena válida: cada pieza se vuelve a validar y a expandir con applyPiece.
function rebuild(saved) {
  const objects = saved?.scene?.objects, parts = saved?.scene?.parts;
  if (!objects || typeof objects !== 'object' || !Array.isArray(parts)) throw new Error('El archivo no tiene una escena de JEV construye.');
  let out = EMPTY();
  for (const p of parts) {
    const o = objects[p.object];
    if (!o) throw new Error(`La pieza "${p.id}" apunta a un objeto que no existe.`);
    out = applyPiece(out, { object: { id: o.id, label: o.label }, part: { id: p.id, label: p.label }, spec: { ...parsePatch(p.spec), objectPosition: o.position } });
  }
  return { scene: out, history: Array.isArray(saved.history) ? saved.history : [] };
}

const secs = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`);

// Cronómetro de una etapa: devuelve el resultado y suma { label, ms } a la lista.
async function timed(list, label, fn) {
  const t0 = performance.now();
  const out = await fn();
  list.push({ label, ms: performance.now() - t0 });
  return out;
}

let started = false;
let config = { mock: false, available: true, llmModel: '', jevModel: '' };
let viewport = null;
let scene = EMPTY();
let history = [];
let log = [];
let controller = null;
let sketch = null; // boceto adjunto (data URL JPEG), queda puesto entre pedidos hasta que se saca
let runSketch = null; // el boceto del pedido en curso: viaja en todos los POST de esa corrida

// Un dibujo (archivo o pegado) → JPEG con fondo blanco, de 280 a 1280 px por lado (lo que acepta JEV).
async function prepareSketch(file) {
  if (!/^image\//.test(file.type)) throw new Error('El boceto tiene que ser una imagen.');
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1280 / Math.max(bitmap.width, bitmap.height), 1);
  let w = Math.round(bitmap.width * scale), h = Math.round(bitmap.height * scale);
  const up = Math.max(1, 280 / Math.min(w, h)); // los muy chicos se agrandan
  w = Math.round(w * up); h = Math.round(h * up);
  const W = Math.min(1568, Math.max(280, w)), H = Math.min(1568, Math.max(280, h)); // lo muy alargado se rellena de blanco
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);
  const fit = Math.min(W / w, H / h, 1);
  ctx.drawImage(bitmap, (W - w * fit) / 2, (H - h * fit) / 2, w * fit, h * fit);
  bitmap.close?.();
  return canvas.toDataURL('image/jpeg', 0.9);
}

const error = (msg) => { const e = $('jevbuild-error'); if (!e) return; e.textContent = msg || ''; e.hidden = !msg; };

async function post(path, body, signal) {
  const payload = runSketch ? { ...body, sketch: runSketch } : body;
  const res = await fetch(`/api/lab/jev-build/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Error ${res.status}`), { raw: data.raw });
  return data;
}

// La escena sin los nodos expandidos: el servidor solo necesita objetos y piezas.
const lean = (s) => ({ objects: s.objects, parts: s.parts.map(({ nodes, ...p }) => p) });

// Para la vista previa, lo que todavía no se eligió sale de la primera opción de las preguntas que faltan.
function complete(spec, later) {
  const out = { ...spec };
  for (const field of ['primitive', 'size', 'position']) {
    if (out[field] !== undefined) continue;
    const q = later.find((x) => x.options[0].patch[field] !== undefined);
    if (q) out[field] = q.options[0].patch[field];
  }
  return out;
}

function mount(root) {
  const page = el('div', 'jb-root');
  const meta = el('p', 'jb-meta');
  const planner = el('span', null, readModel() || config.llmModel);
  meta.append('Planifica ', planner, ` · elige ${config.jevModel}`);
  if (config.mock) meta.append(' · ', el('span', 'jb-demo', 'demo: recetas fijas y respuestas simuladas'));
  const modeHint = el('p', 'jb-hint');

  // La caja de pedidos: flotante, abajo, siempre a mano para seguir iterando.
  const form = el('form', 'jb-composer');
  form.setAttribute('aria-label', 'Pedir una construcción');
  const prompt = el('textarea', 'jb-prompt');
  prompt.rows = 2;
  prompt.value = 'Un árbol grande con tronco grueso y flores rosas a la izquierda, y una persona parada al lado';
  prompt.maxLength = 600;
  prompt.placeholder = '¿Qué construimos? (Enter envía · Shift+Enter nueva línea)';
  prompt.setAttribute('aria-label', 'Qué construir');
  prompt.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); } });
  const go = el('button', 'jb-send', 'Construir');
  go.type = 'submit';
  const stop = el('button', 'jb-ghost', 'Detener');
  stop.type = 'button';
  stop.disabled = true;
  // Boceto: botón, pegar (Cmd+V) o arrastrar una imagen sobre la caja.
  const attachBtn = el('button', 'jb-ghost jb-attach', '+ Boceto');
  attachBtn.type = 'button';
  attachBtn.title = 'Subí un dibujo: el modelo lo mira para construir y JEV compara cada opción con él. También podés pegarlo o arrastrarlo.';
  const sketchFile = el('input');
  Object.assign(sketchFile, { type: 'file', accept: 'image/*', hidden: true });
  const chip = el('div', 'jb-sketch');
  chip.hidden = true;
  const thumb = el('img');
  thumb.alt = 'Boceto adjunto';
  const removeSketch = el('button', 'jb-sketch-x', '×');
  removeSketch.type = 'button';
  removeSketch.setAttribute('aria-label', 'Sacar el boceto');
  chip.append(thumb, el('span', null, 'Boceto: el modelo lo mira y JEV compara cada opción con él'), removeSketch);
  const setSketch = (url) => {
    sketch = url;
    chip.hidden = !url;
    if (url) thumb.src = url;
    prompt.placeholder = url ? 'Opcional: contá qué dibujaste (Enter construye)' : '¿Qué construimos? (Enter envía · Shift+Enter nueva línea)';
  };
  const takeSketch = async (file) => {
    try { setSketch(await prepareSketch(file)); error(''); } catch (err) { error(`No se pudo usar el boceto: ${err.message}`); }
  };
  attachBtn.onclick = () => sketchFile.click();
  sketchFile.onchange = () => { const f = sketchFile.files?.[0]; sketchFile.value = ''; if (f) takeSketch(f); };
  removeSketch.onclick = () => setSketch(null);
  prompt.addEventListener('paste', (e) => {
    const f = [...(e.clipboardData?.files || [])].find((x) => x.type.startsWith('image/'));
    if (f) { e.preventDefault(); takeSketch(f); }
  });
  form.addEventListener('dragover', (e) => { if ([...(e.dataTransfer?.items || [])].some((i) => i.type.startsWith('image/'))) { e.preventDefault(); form.classList.add('dragging'); } });
  form.addEventListener('dragleave', () => form.classList.remove('dragging'));
  form.addEventListener('drop', (e) => {
    form.classList.remove('dragging');
    const f = [...(e.dataTransfer?.files || [])].find((x) => x.type.startsWith('image/'));
    if (f) { e.preventDefault(); takeSketch(f); }
  });

  const main = el('div', 'jb-composer-main');
  main.append(attachBtn, sketchFile, prompt, stop, go);

  const steps = el('input');
  Object.assign(steps, { type: 'number', min: 1, max: 30, value: 14 });
  const look = el('input');
  Object.assign(look, { type: 'checkbox', checked: true });
  const see = el('input');
  Object.assign(see, { type: 'checkbox', checked: pref('see', '1') === '1' });
  see.addEventListener('change', () => setPref('see', see.checked ? '1' : '0'));
  const mode = el('select', 'jb-mode');
  for (const [v, label] of [['rel', 'Fase 3 · relaciones'], ['fast', 'Fase 2 · time reducing'], ['steps', 'Fase 1 · pieza por pieza']]) { const o = el('option', null, label); o.value = v; mode.append(o); }
  mode.value = ['rel', 'fast', 'steps'].includes(pref('mode', 'rel')) ? pref('mode', 'rel') : 'rel';
  mode.setAttribute('aria-label', 'Fase del experimento');
  const reset = el('button', 'jb-ghost', 'Nueva escena');
  reset.type = 'button';
  const download = el('button', 'jb-ghost', 'Descargar JSON');
  download.type = 'button';
  const upload = el('button', 'jb-ghost', 'Cargar JSON');
  upload.type = 'button';
  const file = el('input');
  Object.assign(file, { type: 'file', accept: 'application/json,.json', hidden: true });
  const stepsField = el('label', 'jb-inline');
  stepsField.append(el('span', null, 'Pasos'), steps);
  const HINTS = {
    rel: 'Fase 3 · ideas en palabras → JEV elige el concepto → plano por relaciones (encima de, de acá hasta allá, espejo) → JEV elige las piezas mirando → revisión.',
    fast: 'Fase 2 · ideas en palabras → JEV elige el concepto → plano entero por objeto → JEV elige todas las piezas de una vez mirando las combinaciones → revisión.',
    steps: 'Fase 1 · una pieza por turno: el LLM pregunta, JEV elige mirando cada opción, y la pieza siguiente parte de ahí.',
  };
  const syncMode = () => { stepsField.hidden = mode.value !== 'steps'; modeHint.textContent = HINTS[mode.value]; setPref('mode', mode.value); };
  mode.addEventListener('change', syncMode);
  syncMode();
  const lookField = el('label', 'jb-inline');
  lookField.append(look, el('span', null, 'JEV mira las opciones'));
  const seeField = el('label', 'jb-inline');
  seeField.title = 'Le manda la foto de la escena al modelo que planifica (si el modelo acepta imágenes).';
  seeField.append(see, el('span', null, 'El modelo ve la escena'));
  // Modelo de OpenRouter que planifica: cualquier id ("proveedor/modelo"). Vacío = el del servidor. Se recuerda en este navegador.
  const model = el('input', 'jb-model');
  Object.assign(model, { type: 'text', value: readModel(), placeholder: config.llmModel, spellcheck: false, autocomplete: 'off' });
  model.setAttribute('aria-label', 'Modelo de OpenRouter que planifica');
  model.setAttribute('list', 'jb-models');
  const models = el('datalist');
  models.id = 'jb-models';
  for (const id of [...new Set([config.llmModel, ...readRecent()])].filter(Boolean)) { const o = el('option'); o.value = id; models.append(o); }
  model.addEventListener('change', () => { saveModel(model.value.trim()); planner.textContent = model.value.trim() || config.llmModel; });
  const settings = el('div', 'jb-composer-settings');
  settings.append(mode, model, models, seeField, lookField, stepsField, reset, download, upload, file);
  // Minimizar: la caja se achica a una pastilla en la esquina para ver la escena entera; se recuerda.
  const minBtn = el('button', 'jb-min', '–');
  minBtn.type = 'button';
  const pill = el('button', 'jb-pill');
  pill.type = 'button';
  pill.append(el('span', 'jb-pill-dot'), el('span', null, 'Pedir'));
  const setMin = (on, focus = true) => {
    form.classList.toggle('min', on);
    minBtn.setAttribute('aria-label', 'Minimizar la caja');
    minBtn.title = 'Minimizar (la caja queda como un botón en la esquina)';
    pill.setAttribute('aria-label', 'Abrir la caja de pedidos');
    minBtn.setAttribute('aria-expanded', String(!on));
    setPref('min', on ? '1' : '0');
    if (!on && focus) prompt.focus({ preventScroll: true });
  };
  minBtn.onclick = () => setMin(true);
  pill.onclick = () => setMin(false);
  form.append(minBtn, pill, chip, main, settings);

  const work = el('div', 'jb-work');
  const view = el('div', 'jb-view');
  const viewBar = el('div', 'jb-view-bar');
  const status = el('p', 'jb-status', 'Escena vacía. Pedí algo abajo y el planificador va a construirlo con JEV.');
  status.setAttribute('aria-live', 'polite');
  const fitBtn = el('button', 'jb-btn small', 'Encuadrar');
  fitBtn.type = 'button';
  viewBar.append(status, fitBtn);
  const canvasBox = el('div', 'jb-canvas');
  const keysHint = el('p', 'jb-keys', 'Clic en la vista y: W/S adelante · A/D costados · E/Espacio sube · Q/C baja · flechas giran · Shift rápido · F encuadra · K marca un punto de la toma. Mouse: arrastrar gira · rueda acerca · clic derecho desplaza.');
  const cam = cameraBar(canvasBox);
  view.append(canvasBox, viewBar, cam.node, keysHint);
  const side = el('section', 'jb-log');
  const list = el('ol', 'jb-steps');
  side.append(list);
  work.append(view, side);

  page.append(meta, modeHint, work, form);
  root.replaceChildren(page);
  setMin(pref('min', '0') === '1', false);

  import('./jev-build/engine.js').then(({ createViewport }) => {
    viewport = createViewport(canvasBox);
    try {
      const saved = JSON.parse(localStorage.getItem(SCENE_KEY) || 'null');
      if (saved && !scene.parts.length) ({ scene, history } = rebuild(saved));
      if (scene.parts.length) status.textContent = `Escena recuperada: ${Object.keys(scene.objects).length} objetos, ${scene.parts.length} piezas. Podés seguir pidiendo sobre ella.`;
    } catch { /* nada guardado o ilegible: escena vacía */ }
    viewport.show(scene, { refit: true });
    cam.attach(viewport);
  }).catch((err) => error(`No se pudo cargar three.js: ${err.message}`));
  fitBtn.onclick = () => viewport?.fit();

  const setRunning = (on) => {
    for (const c of [go, reset, upload, prompt, mode, model, attachBtn, removeSketch]) c.disabled = on;
    stop.disabled = !on;
    form.classList.toggle('running', on);
  };
  stop.onclick = () => controller?.abort();
  reset.onclick = () => {
    scene = EMPTY(); history = []; log = [];
    list.replaceChildren();
    viewport?.show(scene, { refit: true });
    persist();
    status.textContent = 'Escena vacía.';
  };
  upload.onclick = () => file.click();
  file.onchange = async () => {
    const f = file.files?.[0];
    file.value = '';
    if (!f) return;
    try {
      ({ scene, history } = rebuild(JSON.parse(await f.text())));
      log = [];
      list.replaceChildren();
      viewport?.show(scene, { refit: true });
      persist();
      error('');
      status.textContent = `Escena cargada de ${f.name}: ${Object.keys(scene.objects).length} objetos, ${scene.parts.length} piezas.`;
    } catch (err) {
      error(`No se pudo cargar ${f.name}: ${err.message}`);
    }
  };
  download.onclick = () => {
    const blob = new Blob([JSON.stringify({ scene, history, log }, null, 2)], { type: 'application/json' });
    const a = el('a');
    a.href = URL.createObjectURL(blob);
    a.download = `jev-construye-${Date.now()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  form.onsubmit = async (e) => {
    e.preventDefault();
    const text = prompt.value.trim() || (sketch ? 'Lo que dibujé en el boceto.' : '');
    if (!text || !viewport || controller) return;
    error('');
    setRunning(true);
    controller = new AbortController();
    runSketch = sketch;
    if (runSketch) list.append(sketchCard(runSketch, text));
    const t0 = performance.now();
    try {
      const args = { prompt: text, model: model.value.trim() || undefined, withImages: look.checked, see: see.checked, signal: controller.signal, status, list };
      if (mode.value === 'steps') await build({ ...args, max: Math.max(1, Math.min(30, Number(steps.value) || 14)) });
      else await buildFast({ ...args, relations: mode.value === 'rel' });
      status.textContent += ` · tiempo total ${secs(performance.now() - t0)}`;
    } catch (err) {
      if (err.name !== 'AbortError') {
        error(err.message);
        if (err.raw) console.warn('Respuesta del planificador:', err.raw);
      }
      status.textContent = err.name === 'AbortError' ? 'Detenido.' : 'Se cortó por un error.';
    } finally {
      setRunning(false);
      controller = null;
      runSketch = null;
    }
  };
}

// El bucle: el LLM propone la pieza → JEV elige en cada pregunta → la pieza entra a la escena → otra vez.
async function build({ prompt, model, max, withImages, see, signal, status, list }) {
  for (let i = 0; i < max; i++) {
    const n = history.length + 1;
    status.textContent = `Paso ${n}: ${scene.parts.length ? 'JEV mira la escena y ' : ''}el planificador piensa la próxima pieza…`;
    const times = [];
    const render = scene.parts.length ? await timed(times, 'foto', async () => viewport.snapshot()) : undefined;
    const issues = checkScene(scene);
    const plan = await timed(times, render ? 'JEV mira + LLM' : 'LLM', () => post('plan', { prompt, model, scene: lean(scene), history, render, see, issues }, signal));
    const { step, verify } = plan;
    if (step.done) {
      list.append(doneCard(step, verify));
      log.push({ prompt, done: step, verify });
      status.textContent = `Listo: ${step.summary || 'el planificador dio la construcción por terminada'}.`;
      return;
    }
    const card = stepCard(n, step, verify, plan.ms);
    if (issues.length || plan.sees) card.note(`${plan.sees ? 'El modelo vio la escena. ' : ''}${issues.length ? `Revisión del motor: ${issues.join(' ')}` : ''}`);
    list.append(card.node);
    card.node.scrollIntoView({ block: 'nearest', behavior: 'smooth' });

    let spec = { ...step.base };
    const chosen = [];
    for (const [k, q] of step.questions.entries()) {
      const candidates = q.options.map((o) => mergePatches(spec, o.patch));
      const scenes = candidates.map((c) => applyPiece(scene, { object: step.object, part: step.part, spec: complete(c, step.questions.slice(k + 1)) }));
      const images = withImages ? await timed(times, 'fotos', async () => viewport.previews(scenes, step.object.id)) : [];
      const row = card.question(q, images);
      status.textContent = `Paso ${n}: JEV elige — ${q.question}`;
      const r = await timed(times, 'JEV elige', () => post('choose', {
        prompt,
        object: step.object.label,
        part: step.part.label,
        sceneText: describeScene(scene),
        chosen,
        question: q.question,
        options: q.options.map((o) => o.label),
        images,
      }, signal));
      row.answer(r);
      spec = candidates[r.index];
      chosen.push({ question: q.question, label: r.choice, confidence: r.confidence });
    }
    scene = applyPiece(scene, { object: step.object, part: step.part, spec });
    const key = `${step.object.id}/${step.part.id}`;
    viewport.show(scene, { pop: [key], refit: true });
    history.push({ n, object: step.object.id, part: step.part.id, thought: step.thought, choices: chosen });
    persist();
    log.push({ prompt, step, verify, choices: chosen, spec, times });
    card.done(spec);
    card.timing(times);
  }
  status.textContent = `Se alcanzó el máximo de ${max} pasos. Podés seguir con otro pedido sobre la misma escena.`;
}

// Fase 2 · time reducing, y Fase 3 · relaciones (relations = true).
const applyAll = (base, object, pieces) => pieces.reduce((sc, p) => applyPiece(sc, { object, part: p.part, spec: { ...p.spec, objectPosition: object.position } }), base);

async function buildFast({ prompt, model, withImages, see, relations, signal, status, list }) {
  const times = [];
  status.textContent = 'El LLM propone ideas en palabras…';
  const { ideas } = await timed(times, 'LLM ideas', () => post('ideas', { prompt, model, scene: lean(scene) }, signal));
  if (ideas.done) {
    list.append(doneCard({ summary: ideas.summary }, null));
    status.textContent = `Listo: ${ideas.summary || 'todo lo pedido ya está en la escena'}.`;
    return;
  }
  const objects = ideas.objects;
  const ideasCard = stepCard('Ideas', { object: { label: objects.map((o) => o.label).join(' + ') }, part: { label: 'conceptos' } });
  if (ideas.dropped) ideasCard.note(`El modelo nombró ${objects.length + ideas.dropped} objetos; se construyen los primeros ${objects.length}. Pedí el resto en otra vuelta (se suma a la misma escena).`);
  list.append(ideasCard.node);

  // JEV elige un concepto por objeto, todos en una llamada y por texto.
  status.textContent = 'JEV elige un concepto para cada objeto…';
  const rows = objects.map((o) => ideasCard.question({ question: `¿Cómo armarías ${o.label}?`, options: o.concepts.map((label) => ({ label })) }, []));
  const conceptPick = await timed(times, 'JEV concepto', () => post('pick', {
    prompt,
    sceneText: describeScene(scene),
    picks: objects.map((o, i) => ({ key: `c${i}`, context: `Objeto: ${o.label}.`, question: `¿Cuál de estas ideas usarías para construir ${o.label} con esferas, cajas, cilindros y conos?`, options: o.concepts })),
  }, signal));
  const concepts = objects.map((o, i) => { rows[i].answer(conceptPick.answers[`c${i}`]); return conceptPick.answers[`c${i}`].choice; });
  ideasCard.timing(times.slice());

  // Un plano por objeto, todos en paralelo.
  status.textContent = `El LLM escribe ${objects.length > 1 ? `${objects.length} planos en paralelo` : 'el plano'}${relations ? ' por relaciones' : ''}…`;
  const blueprints = await timed(times, `LLM plano${objects.length > 1 ? ` ×${objects.length}` : ''}`, () => Promise.all(objects.map((o, i) => post('blueprint', { prompt, model, scene: lean(scene), object: o, concept: concepts[i], ...(relations ? { language: 'relations' } : {}) }, signal))));

  // Piezas elegidas → piezas absolutas (en relaciones, spec.js resuelve "encima de", "desde/hasta" y espejos).
  const place = (pieces) => (relations ? resolveObject(pieces) : pieces);

  // Fotos de cada combinación. El contexto de cada pieza es el objeto armado con la primera combinación de las anteriores.
  const plans = await timed(times, 'fotos', async () => objects.map((o, oi) => {
    const first = [];
    return blueprints[oi].blueprint.pieces.map((piece, pi) => {
      const cs = combos(piece);
      const images = withImages && cs.length > 1
        ? viewport.previews(cs.map((c) => applyAll(scene, o, place([...first, { part: piece.part, spec: c.patch }]))), o.id)
        : [];
      first.push({ part: piece.part, spec: cs[0].patch });
      return { key: `p${oi}_${pi}`, object: o, piece, combos: cs, images };
    });
  }));

  const cards = objects.map((o, oi) => {
    const card = stepCard('Plano', { object: o, part: { label: concepts[oi] } });
    list.append(card.node);
    for (const p of plans[oi]) {
      const mirror = p.piece.base.mirror ? ' · con espejo' : '';
      if (p.combos.length === 1) card.note(`${p.piece.part.label} · fija, sin preguntar${mirror}`);
      else p.row = card.question({ question: `${p.piece.part.label}${mirror}: ${p.piece.questions.map((q) => q.question).join(' / ')}`, options: p.combos.map((c) => ({ label: c.label })) }, p.images);
    }
    return card;
  });
  cards.at(-1).node.scrollIntoView({ block: 'nearest', behavior: 'smooth' });

  // JEV elige todas las piezas a la vez.
  const asked = plans.flat().filter((p) => p.combos.length > 1);
  status.textContent = asked.length ? `JEV elige ${asked.length} pieza${asked.length > 1 ? 's' : ''} de una vez…` : 'Ninguna pieza necesita preguntas.';
  const piecePick = asked.length ? await timed(times, 'JEV piezas', () => post('pick', {
    prompt,
    sceneText: describeScene(scene),
    picks: asked.map((p) => ({ key: p.key, context: `Objeto: ${p.object.label} (${concepts[objects.indexOf(p.object)]}). Pieza: ${p.piece.part.label}.`, question: p.piece.questions.map((q) => q.question).join(' / '), options: p.combos.map((c) => c.label), images: p.images })),
  }, signal)) : { answers: {} };

  // Todas las piezas a la escena, objeto por objeto, con lo que eligió JEV.
  const keys = [];
  objects.forEach((o, oi) => {
    const chosen = plans[oi].map((p) => {
      const a = piecePick.answers[p.key];
      if (a) p.row?.answer(a);
      log.push({ prompt, mode: relations ? 'relations' : 'fast', object: o.id, part: p.piece.part, choice: a || null });
      return { part: p.piece.part, spec: p.combos[a ? a.index : 0].patch };
    });
    const placed = place(chosen);
    scene = applyAll(scene, o, placed);
    keys.push(...placed.map((p) => `${o.id}/${p.part.id}`));
  });
  viewport.show(scene, { pop: keys, refit: true });
  persist();

  await review({ prompt, model, see, signal, status, list, times });

  // Una sola verificación, al final.
  status.textContent = 'JEV mira el resultado…';
  const check = await timed(times, 'JEV verifica', () => post('pick', { prompt, sceneText: describeScene(scene), picks: [], render: viewport.snapshot() }, signal));
  const done = doneCard({ summary: `${objects.length} objeto${objects.length > 1 ? 's' : ''}, ${keys.length} piezas, ${asked.length} elegidas por JEV mirando.` }, check.verify);
  list.append(done);
  const timing = el('p', 'jb-times');
  timing.textContent = times.map((t) => `${t.label} ${secs(t.ms)}`).join(' · ');
  done.append(timing);
  log.push({ prompt, mode: relations ? 'relations' : 'fast', ideas, concepts, verify: check.verify, times });
  status.textContent = `Listo: JEV reconoce el pedido ${pct(check.verify?.noul)}`;
}

// Arreglos del revisor sobre la escena (parches absolutos o quitar piezas).
function applyFixes(base, fixes) {
  let out = base;
  for (const f of fixes) {
    const o = out.objects[f.object];
    const part = out.parts.find((p) => p.object === f.object && p.id === f.part);
    if (!o || !part) continue;
    if (f.remove) out = { ...out, parts: out.parts.filter((p) => p !== part) };
    else out = applyPiece(out, { object: { id: o.id, label: o.label }, part: { id: part.id, label: part.label }, spec: { ...part.spec, ...f.patch, objectPosition: o.position } });
  }
  return out;
}

// Revisión (Fase 2 y 3): el motor busca problemas; si hay, o si el modelo puede ver la foto, el modelo propone
// arreglos; JEV elige mirando entre la versión de antes y la corregida.
async function review({ prompt, model, see, signal, status, list, times }) {
  const issues = checkScene(scene);
  if (!issues.length && !see) return;
  status.textContent = issues.length ? `El modelo revisa ${issues.length} problema${issues.length > 1 ? 's' : ''} que encontró el motor…` : 'El modelo mira la escena por si algo quedó mal…';
  const card = stepCard('Revisión', { object: { label: 'motor + modelo' }, part: { label: issues.length ? `${issues.length} problema${issues.length > 1 ? 's' : ''}` : 'sin problemas de geometría' } });
  list.append(card.node);
  for (const i of issues) card.note(`· ${i}`);
  const r = await timed(times, 'LLM revisa', () => post('fix', { prompt, model, scene: lean(scene), issues, render: viewport.snapshot(), see }, signal));
  card.note(`${r.sees ? 'El modelo vio la foto. ' : 'El modelo no vio la foto (solo texto). '}${r.note || ''}`);
  if (!r.fixes?.length) { card.note('Sin arreglos.'); return; }
  const fixed = applyFixes(scene, r.fixes);
  const images = viewport.previews([scene, fixed]);
  const row = card.question({ question: `${r.fixes.length} arreglo${r.fixes.length > 1 ? 's' : ''}: ¿cuál versión construye mejor lo pedido?`, options: [{ label: 'como quedó' }, { label: 'con los arreglos' }] }, images);
  status.textContent = 'JEV elige entre la versión de antes y la corregida…';
  const pick = await timed(times, 'JEV elige arreglo', () => post('pick', { prompt, sceneText: describeScene(scene), picks: [{ key: 'arreglo', context: 'Un revisor propuso corregir la escena.', question: '¿Cuál de las dos versiones construye mejor lo pedido?', options: ['como quedó', 'con los arreglos'], images }] }, signal));
  const a = pick.answers.arreglo;
  row.answer(a);
  log.push({ prompt, review: { issues, fixes: r.fixes, note: r.note, choice: a } });
  if (a.index === 1) {
    scene = fixed;
    viewport.show(scene, { pop: r.fixes.filter((f) => !f.remove).map((f) => `${f.object}/${f.part}`) });
    persist();
  }
}

function stepCard(n, step, verify, ms) {
  const node = el('li', 'jb-step');
  const head = el('div', 'jb-step-head');
  head.append(el('span', 'jb-n', typeof n === 'number' ? `Paso ${n}` : n), el('b', null, `${step.object.label} · ${step.part.label}`));
  if (ms) head.append(el('span', 'jb-ms', `${(ms / 1000).toFixed(1)} s`));
  node.append(head);
  if (verify) node.append(el('p', 'jb-verify', `JEV mirando la escena: se reconoce el pedido ${pct(verify.noul)}`));
  if (step.thought) node.append(el('p', 'jb-thought', step.thought));
  return {
    node,
    question(q, images) {
      const box = el('div', 'jb-q');
      box.append(el('p', 'jb-q-text', q.question));
      const opts = el('div', `jb-opts${images.length ? ' with-images' : ''}`);
      const rows = q.options.map((o, i) => {
        const opt = el('div', 'jb-opt');
        if (images[i]) { const img = el('img'); img.src = images[i]; img.alt = o.label; opt.append(img); }
        const label = el('span', 'jb-opt-label', o.label);
        const bar = el('span', 'jb-bar');
        const fill = el('span', 'jb-fill');
        bar.append(fill);
        const p = el('span', 'jb-opt-p', '…');
        opt.append(label, bar, p);
        opts.append(opt);
        return { opt, fill, p, label: o.label };
      });
      box.append(opts);
      node.append(box);
      return {
        answer(r) {
          rows.forEach((row, i) => {
            const prob = r.probabilities?.[row.label] ?? 0;
            row.fill.style.width = `${Math.max(2, prob * 100)}%`;
            row.p.textContent = pct(prob);
            row.opt.classList.toggle('chosen', i === r.index);
          });
        },
      };
    },
    note(text) { node.append(el('p', 'jb-spec', text)); },
    timing(times) {
      const p = el('p', 'jb-times');
      p.textContent = times.map((t) => `${t.label} ${secs(t.ms)}`).join(' · ');
      node.append(p);
    },
    done(spec) {
      const rep = spec.repeat && spec.repeat.pattern !== 'single' ? ` · ${spec.repeat.count}× ${spec.repeat.pattern}` : '';
      node.append(el('p', 'jb-spec', `${spec.primitive} · size [${spec.size.join(', ')}] · pos [${spec.position.join(', ')}]${spec.rotation ? ` · rot [${spec.rotation.join(', ')}]` : ''}${rep}`));
    },
  };
}

// Barra de cámara: suavidad y velocidad de la cámara libre, tomas (puntos + recorrido suave) y grabación de video.
function cameraBar(canvasBox) {
  const node = el('div', 'jb-cam');
  const range = (label, min, max, value, hint) => {
    const input = el('input');
    Object.assign(input, { type: 'range', min, max, value });
    const out = el('output');
    const wrap = el('label', 'jb-cam-range');
    wrap.title = hint;
    wrap.append(el('span', null, label), input, out);
    return { wrap, input, out };
  };
  const smooth = range('Suavidad', 0, 100, Number(pref('smooth', 60)), 'Inercia de la cámara: más alto = arranca y frena más suave');
  const speed = range('Velocidad', 10, 300, Number(pref('speed', 100)), 'Velocidad de la cámara libre (teclado)');
  const add = el('button', 'jb-btn small', '+ Punto (K)');
  const count = el('span', 'jb-cam-count', '0 puntos');
  const clear = el('button', 'jb-btn small', 'Borrar');
  const takeSecs = el('input');
  Object.assign(takeSecs, { type: 'number', min: 1, max: 120, step: 0.5, value: Number(pref('take-secs', 8)) });
  takeSecs.setAttribute('aria-label', 'Duración de la toma en segundos');
  const play = el('button', 'jb-btn small', '▶ Ver toma');
  const recTake = el('button', 'jb-btn small jb-rec', '● Grabar toma');
  const recFree = el('button', 'jb-btn small jb-rec', '● Grabar libre');
  for (const b of [add, clear, play, recTake, recFree]) b.type = 'button';
  const secsField = el('label', 'jb-cam-range');
  secsField.append(takeSecs, el('span', null, 's'));
  const rowA = el('div', 'jb-cam-row');
  rowA.append(el('b', null, 'Cámara'), smooth.wrap, speed.wrap);
  const rowB = el('div', 'jb-cam-row');
  rowB.append(el('b', null, 'Toma'), add, count, clear, secsField, play, recTake, recFree);
  node.append(rowA, rowB);
  const badge = el('div', 'jb-rec-badge');
  badge.hidden = true;
  canvasBox.append(badge);
  for (const b of [add, clear, play, recTake, recFree]) b.disabled = true;

  return {
    node,
    attach(vp) {
      const sync = () => {
        smooth.out.textContent = `${smooth.input.value}%`;
        speed.out.textContent = `${speed.input.value}%`;
        vp.setSmooth(smooth.input.value / 100);
        vp.setSpeed(speed.input.value / 100);
        setPref('smooth', smooth.input.value);
        setPref('speed', speed.input.value);
      };
      smooth.input.addEventListener('input', sync);
      speed.input.addEventListener('input', sync);
      sync();
      try { vp.rig.set(JSON.parse(localStorage.getItem('jev-build:take') || '[]')); } catch { /* sin toma guardada */ }
      const busy = () => vp.rig.playing || vp.recording.on;
      const refresh = (n = vp.rig.count) => {
        count.textContent = `${n} punto${n === 1 ? '' : 's'}`;
        add.disabled = busy();
        clear.disabled = !n || busy();
        play.disabled = recTake.disabled = n < 2 || busy();
        recFree.disabled = vp.rig.playing;
        recFree.textContent = vp.recording.on && !vp.rig.playing ? '■ Parar y guardar' : '● Grabar libre';
        play.textContent = vp.rig.playing && !vp.recording.on ? '■ Parar' : '▶ Ver toma';
        if (vp.rig.playing && !vp.recording.on) play.disabled = false;
      };
      vp.rig.onChange((n) => { refresh(n); try { localStorage.setItem('jev-build:take', JSON.stringify(vp.rig.get())); } catch { /* sin almacenamiento */ } });
      refresh();

      let ticker = 0;
      const showRec = (on) => {
        badge.hidden = !on;
        clearInterval(ticker);
        if (!on) return;
        const t0 = performance.now();
        const tick = () => { const s = Math.floor((performance.now() - t0) / 1000); badge.textContent = `REC ${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
        tick();
        ticker = setInterval(tick, 500);
      };
      const save = async () => {
        showRec(false);
        const out = await vp.recording.stop();
        refresh();
        if (!out?.blob.size) return;
        const a = el('a');
        a.href = URL.createObjectURL(out.blob);
        a.download = `jev-construye-toma-${Date.now()}.${out.mime.includes('mp4') ? 'mp4' : 'webm'}`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      };
      const seconds = () => { const v = Math.min(120, Math.max(1, Number(takeSecs.value) || 8)); setPref('take-secs', v); return v; };

      add.onclick = () => vp.rig.add();
      clear.onclick = () => vp.rig.clear();
      play.onclick = async () => {
        if (vp.rig.playing) return vp.rig.stop();
        const run = vp.rig.play(seconds());
        refresh();
        await run;
        refresh();
      };
      recTake.onclick = async () => {
        try { vp.recording.start(); } catch (err) { return error(err.message); }
        showRec(true);
        const run = vp.rig.play(seconds());
        refresh();
        await run;
        await save();
      };
      recFree.onclick = async () => {
        if (vp.recording.on) return save();
        try { vp.recording.start(); } catch (err) { return error(err.message); }
        showRec(true);
        refresh();
        vp.canvas.focus({ preventScroll: true });
      };
    },
  };
}

function sketchCard(url, text) {
  const node = el('li', 'jb-step jb-sketch-card');
  const head = el('div', 'jb-step-head');
  head.append(el('span', 'jb-n', 'Boceto'), el('b', null, text));
  const img = el('img');
  img.src = url;
  img.alt = 'Boceto del pedido';
  node.append(head, img);
  return node;
}

function doneCard(step, verify) {
  const node = el('li', 'jb-step done');
  node.append(el('b', null, 'Terminado'));
  if (verify) node.append(el('p', 'jb-verify', `JEV mirando la escena: se reconoce el pedido ${pct(verify.noul)}`));
  if (step.summary || step.thought) node.append(el('p', 'jb-thought', step.summary || step.thought));
  return node;
}

async function start() {
  if (started) return;
  started = true;
  const root = $('jevbuild-experiment');
  if (!root) return;
  try {
    config = await fetch('/api/lab/jev-build/config').then((r) => r.json());
    if (!config.available) error('Faltan OPENROUTER_API_KEY y TYPESAFE_API_KEY: el planificador y JEV no van a poder responder.');
  } catch {
    error('No se pudo leer la configuración de JEV construye.');
  }
  mount(root);
}

window.addEventListener('tab', ({ detail }) => { if (detail === TAB) start(); });
if (document.body.dataset.tab === TAB) start();
