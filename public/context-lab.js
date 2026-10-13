import { el, streamEvents } from './shared.js';
import { createStudio } from './intuition.js';
import { loadPhoto } from './media.js';
import { money, secs, IDENTITY } from './lab-stats.js';
import { createLabStore } from './lab-store.js';
import { compositeOverlay } from './lab-composite.js';
import {
  TOOL_KEYS, TOOL_LABEL, MODE_LABEL, policySignature, approxTokens, newVariantRun, variantMetrics, configSummary, configStats, experimentStatus, differing,
} from './context-lab-stats.js';

// Pestaña Laboratorio · Context Lab.
// La idea inversa de Motion Design: UN modelo, el mismo video y las mismas zonas, y de 2 a 4 VARIANTES de contexto.
// Cada variante elige su prompt de sistema, sus skills, sus herramientas (apagada / opcional / obligatoria) y sus límites,
// su pedido (contexto, instrucciones, referencias), ejemplos, cuántos cuadros ve, temperatura y razonamiento.
// Corren por separado (ninguna ve a las otras) con el mismo harness de Remotion; el humano compara y evalúa.
// Capas en el Player: video original → tomas de IA (cada una en su capa) → animación del agente.

const $ = (id) => document.getElementById(id);
const store = createLabStore({ key: 'lab.context.experiments.v1', prefsKey: 'lab.context.prefs.v1', db: 'lab-context' });
const MAX_RUNTIME_FIXES = 2;
const REASON = { initial: 'Primera ejecución', compile: 'Corrección (no compilaba)', runtime: 'Corrección (error al reproducir)', feedback: 'Revisión pedida por vos', tools: 'Usando herramientas' };
const TOOL_EVENT = { buscar_referencias: 'Buscando referencias en Google…', generar_imagen: 'Generando una imagen…', generar_sonido: 'Generando un efecto de sonido…', generar_video: 'Generando una toma de video con IA (tarda unos minutos)…' };
const LIMIT_KEY = { search: 'searches', images: 'images', sound: 'sounds', video: 'videos' };
const LIMIT_LABEL = { searches: 'búsquedas', images: 'imágenes', sounds: 'sonidos', videos: 'tomas' };

let info = null;
let started = false;
let exp = null; // experimento abierto (localStorage)
let frozen = null; // { payload: { video, clips }, file, variants: { [key]: { cfg, brief, variant } } }
let baseRefs = []; // { key, name, url, thumb, status }
let drafts = []; // configuración de cada variante (la que se usa en el próximo experimento)
let seq = 0;
const cards = new Map(); // id de la variante → tarjeta
const error = (msg) => { const e = $('ctx-error'); e.textContent = msg || ''; e.hidden = !msg; };
const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const shortModel = (id) => String(id || '').split('/').pop();
const fps = () => info?.harness?.fps || 30;

// ---------- Estructura ----------
const root = $('ctx-experiment');
const toolbar = el('div', 'lab-toolbar');
const nameInput = el('input', 'lab-name');
nameInput.type = 'text'; nameInput.maxLength = 80; nameInput.placeholder = 'Nombre del experimento'; nameInput.setAttribute('aria-label', 'Nombre del experimento');
nameInput.oninput = () => { if (exp) { exp.name = nameInput.value.trim() || exp.name; persist(); } };
const modelInput = el('input', 'lab-model ctx-model');
modelInput.type = 'text'; modelInput.setAttribute('list', 'ctx-model-list'); modelInput.spellcheck = false; modelInput.autocomplete = 'off';
modelInput.placeholder = 'proveedor/modelo (OpenRouter)';
modelInput.setAttribute('aria-label', 'Modelo (el mismo para todas las variantes)');
modelInput.oninput = () => { store.setPrefs({ model: modelInput.value.trim() }); showPrice(); refresh(); };
const modelList = el('datalist');
modelList.id = 'ctx-model-list';
const modelWrap = el('label', 'ctx-model-wrap');
modelWrap.append(el('span', 'lab-field-label', 'Modelo · el mismo para todas'), modelInput, modelList);
const runBtn = el('button', 'primary lab-run', 'Ejecutar variantes');
runBtn.type = 'button';
const newBtn = el('button', 'small-btn', 'Nuevo experimento');
newBtn.type = 'button';
newBtn.title = 'Empezar de cero con las mismas variantes (el experimento actual queda en el historial)';
const harnessPill = el('span', 'pill lab-harness');
toolbar.append(modelWrap, nameInput, harnessPill, newBtn, runBtn);
const price = el('p', 'muted small lab-price');
const hint = el('p', 'muted small lab-hint');
const setupNote = el('p', 'notice lab-setup');
setupNote.hidden = true;

const top = el('div', 'ctx-top');
const studioBox = el('section', 'studio lab-studio');
studioBox.append(el('div', 'decision-label', '1 · Clip y zonas'), el('p', 'muted small', 'Subí un video y marcá las zonas (el mismo marcador de ✨ Intuition). Es igual para todas las variantes.'));
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
contextInput.rows = 3;
contextInput.placeholder = 'De qué trata el video, para quién es, qué tiene que lograr, marca, tono…';
const instructionsInput = el('textarea');
instructionsInput.rows = 4;
instructionsInput.placeholder = 'Qué animación querés. Cada variante lo hereda salvo que lo reemplace.';
const refsBox = el('div', 'thumbs lab-refs');
brief.append(
  el('div', 'decision-label', '2 · Pedido base'),
  el('p', 'muted small', 'Lo heredan todas las variantes. En cada variante podés reemplazarlo, usar otras referencias o ninguna.'),
  field('Contexto', null, contextInput),
  field('Instrucciones', null, instructionsInput),
  el('span', 'lab-field-label', 'Referencias visuales base'),
  refsBox,
);
const saveBase = () => { store.setPrefs({ baseContext: contextInput.value, baseInstructions: instructionsInput.value }); refresh(); cards.forEach((c) => c.renderSummary()); };
contextInput.oninput = saveBase;
instructionsInput.oninput = saveBase;
top.append(studioBox, brief);

const variantsHead = el('div', 'ctx-variants-head');
const addBtn = el('button', 'small-btn', '+ Variante');
addBtn.type = 'button';
variantsHead.append(el('div', 'decision-label', '3 · Variantes de contexto'), el('span', 'muted small', 'Cambiá una cosa por vez (duplicá y tocá una sola perilla) para saber qué la hizo mejor o peor.'), addBtn);
const grid = el('div', 'ctx-grid');
const compare = el('section', 'lab-card lab-compare ctx-compare');
compare.hidden = true;
root.append(toolbar, price, hint, setupNote, top, variantsHead, grid, compare);

const studio = createStudio({ mount: studioBox, label: '1 · Clip y zonas', onError: error, onChange: () => refresh() });

// ---------- Configuración de una variante ----------
function defaultConfig(label) {
  return {
    id: uid(),
    label,
    policy: { ...(info?.defaultPolicy || { search: 'optional', images: 'optional', sound: 'off', video: 'off' }) },
    limits: { ...(info?.limits?.defaults || { searches: 3, images: 2, sounds: 3, videos: 1 }) },
    skills: [...(info?.defaultSkills || [])],
    skillsTouched: false,
    frames: info?.maxFrames ?? 6,
    temperature: null,
    reasoning: null,
    videoModel: info?.tools?.defaultVideoModel || 'seedance',
    template: '', // '' = la plantilla por defecto
    examples: '',
    context: null, // null = hereda el pedido base
    instructions: null,
    refsMode: 'base', // base | own | none
    refs: [],
  };
}
const clone = (cfg) => ({ ...JSON.parse(JSON.stringify({ ...cfg, refs: [] })), id: uid(), refs: cfg.refs.map((r) => ({ ...r, key: ++seq })) });
// Lo que viaja al servidor como `variant` (ver src/lab/context.js → parseVariant).
const serverVariant = (cfg) => ({
  template: cfg.template, examples: cfg.examples, policy: cfg.policy, limits: cfg.limits, skills: cfg.skills,
  frames: cfg.frames, temperature: cfg.temperature, reasoning: cfg.reasoning, videoModel: cfg.videoModel,
});
const readyRefs = (list) => list.filter((r) => r.status === 'ready').map((r) => ({ name: r.name, url: r.url }));
function briefOf(cfg) {
  return {
    context: (cfg.context ?? contextInput.value).trim(),
    instructions: (cfg.instructions ?? instructionsInput.value).trim(),
    refs: cfg.refsMode === 'none' ? [] : readyRefs(cfg.refsMode === 'own' ? cfg.refs : baseRefs),
  };
}
const skillsChars = (files) => files.reduce((n, f) => n + (info?.skills?.find((s) => s.file === f)?.chars || 0), 0);

let draftTimer = 0;
function saveDrafts() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => {
    store.setPrefs({ drafts: drafts.map((d) => ({ ...d, refs: [] })) });
    drafts.forEach((d) => store.putBlob(`draft:${d.id}:refs`, d.refs.filter((r) => r.status === 'ready').map(({ name, url, thumb }) => ({ name, url, thumb }))));
  }, 300);
}

// ---------- Una tarjeta de variante ----------
function createCard(cfg) {
  const node = el('section', 'lab-side ctx-card');
  const head = el('div', 'lab-side-head');
  const badge = el('span', 'lab-badge');
  const label = el('input', 'lab-model ctx-label');
  label.type = 'text'; label.maxLength = 40; label.placeholder = 'Nombre de la variante (ej. "sin búsqueda")';
  label.value = cfg.label;
  label.oninput = () => { cfg.label = label.value; saveDrafts(); renderCompare(); };
  const dup = el('button', 'small-btn', 'Duplicar');
  dup.type = 'button';
  dup.title = 'Copia esta variante con toda su configuración';
  const del = el('button', 'small-btn', 'Quitar');
  del.type = 'button';
  head.append(badge, label, dup, del);
  dup.onclick = () => addVariant(clone({ ...cfg, label: `${cfg.label || 'Variante'} (copia)` }), cfg.id);
  del.onclick = () => removeVariant(cfg.id);

  const summary = el('p', 'small ctx-summary');
  const config = el('details', 'ctx-config');
  config.open = true;
  config.append(el('summary', null, 'Configuración del contexto'));

  // Herramientas: modo + límite.
  const toolsBox = el('div', 'ctx-tools');
  toolsBox.append(el('span', 'lab-field-label', 'Herramientas'));
  const toolRows = TOOL_KEYS.map((k) => {
    const row = el('div', 'ctx-tool');
    const name = el('span', 'small ctx-tool-name', TOOL_LABEL[k]);
    const seg = el('div', 'ctx-seg');
    seg.setAttribute('role', 'radiogroup');
    seg.setAttribute('aria-label', TOOL_LABEL[k]);
    const buttons = ['off', 'optional', 'required'].map((m) => {
      const b = el('button', 'ctx-seg-btn', MODE_LABEL[m]);
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.onclick = () => {
        cfg.policy[k] = m;
        // Con sonido, conviene sumar las skills de audio (si no tocaste las skills a mano).
        if (k === 'sound' && !cfg.skillsTouched) {
          const extra = info?.soundSkills || [];
          cfg.skills = m === 'off' ? cfg.skills.filter((f) => !extra.includes(f)) : [...new Set([...cfg.skills, ...extra])];
        }
        saveDrafts(); renderConfig(); renderCompare();
      };
      seg.append(b);
      return [m, b];
    });
    const lk = LIMIT_KEY[k];
    const lim = el('input', 'ctx-num');
    lim.type = 'number'; lim.min = '1'; lim.step = '1';
    lim.setAttribute('aria-label', `Máximo de ${LIMIT_LABEL[lk]}`);
    lim.onchange = () => { cfg.limits[lk] = Math.max(1, Math.min(info?.limits?.caps?.[lk] || 6, Math.round(Number(lim.value) || 1))); saveDrafts(); renderConfig(); };
    const limWrap = el('label', 'ctx-lim small');
    limWrap.append(document.createTextNode('máx.'), lim);
    const note = el('span', 'muted small ctx-tool-note');
    row.append(name, seg, limWrap, note);
    let modelSel = null;
    if (k === 'video') {
      modelSel = el('select', 'ctx-video-model');
      modelSel.setAttribute('aria-label', 'Modelo de video');
      modelSel.onchange = () => { cfg.videoModel = modelSel.value; saveDrafts(); };
      row.append(modelSel);
    }
    toolsBox.append(row);
    return { k, buttons, lim, note, modelSel, row };
  });

  // Pedido de la variante.
  const ctxText = el('textarea');
  ctxText.rows = 2;
  const insText = el('textarea');
  insText.rows = 3;
  const override = (k, input) => {
    input.oninput = () => { cfg[k] = input.value; saveDrafts(); renderSummary(); };
  };
  override('context', ctxText);
  override('instructions', insText);
  const inherit = (k, input) => {
    const b = el('button', 'small-btn');
    b.type = 'button';
    b.onclick = () => { cfg[k] = cfg[k] === null ? (k === 'context' ? contextInput.value : instructionsInput.value) : null; saveDrafts(); renderConfig(); input.focus(); };
    return b;
  };
  const ctxBtn = inherit('context', ctxText);
  const insBtn = inherit('instructions', insText);
  const refsMode = el('select');
  refsMode.setAttribute('aria-label', 'Referencias de la variante');
  [['base', 'Las del pedido base'], ['own', 'Propias de esta variante'], ['none', 'Ninguna']].forEach(([v, t]) => { const o = el('option', null, t); o.value = v; refsMode.append(o); });
  refsMode.onchange = () => { cfg.refsMode = refsMode.value; saveDrafts(); renderConfig(); refresh(); };
  const ownRefs = el('div', 'thumbs lab-refs');
  const askBox = el('div', 'ctx-block');
  askBox.append(
    el('span', 'lab-field-label', 'Pedido'),
    rowOf(el('span', 'small', 'Contexto'), ctxBtn), ctxText,
    rowOf(el('span', 'small', 'Instrucciones'), insBtn), insText,
    rowOf(el('span', 'small', 'Referencias visuales'), refsMode), ownRefs,
  );

  // Lo que ve y cómo piensa.
  const frames = el('input');
  frames.type = 'range'; frames.min = '0'; frames.step = '1';
  const framesVal = el('span', 'small lab-slider-value');
  frames.oninput = () => { cfg.frames = Number(frames.value); framesVal.textContent = String(cfg.frames); saveDrafts(); renderSummary(); };
  const temp = el('input', 'ctx-num');
  temp.type = 'number'; temp.min = '0'; temp.max = '2'; temp.step = '0.1'; temp.placeholder = 'auto';
  temp.title = 'Vacío = la del proveedor';
  temp.onchange = () => { cfg.temperature = temp.value === '' ? null : Math.min(2, Math.max(0, Number(temp.value))); saveDrafts(); renderSummary(); };
  const reasoning = el('select');
  [['', 'por defecto'], ['low', 'bajo'], ['medium', 'medio'], ['high', 'alto']].forEach(([v, t]) => { const o = el('option', null, t); o.value = v; reasoning.append(o); });
  reasoning.onchange = () => { cfg.reasoning = reasoning.value || null; saveDrafts(); renderSummary(); };
  const seeBox = el('div', 'ctx-block');
  const framesRow = el('label', 'lab-slider');
  framesRow.append(el('span', 'small', 'Cuadros por zona'), frames, framesVal);
  const sampling = el('div', 'ctx-row');
  const tw = el('label', 'lab-inline'); tw.append(el('span', 'small', 'Temperatura'), temp);
  const rw = el('label', 'lab-inline'); rw.append(el('span', 'small', 'Razonamiento'), reasoning);
  sampling.append(tw, rw);
  seeBox.append(el('span', 'lab-field-label', 'Qué ve y cómo piensa'), framesRow, sampling);

  // Skills.
  const skillsBox = el('details', 'ctx-skills');
  const skillsSum = el('summary');
  skillsBox.append(skillsSum);
  const skillsActions = el('div', 'actions compact');
  const skillBtn = (t, fn) => { const b = el('button', 'small-btn', t); b.type = 'button'; b.onclick = () => { fn(); cfg.skillsTouched = true; saveDrafts(); renderConfig(); }; return b; };
  skillsActions.append(
    skillBtn('Por defecto', () => { cfg.skills = [...(info?.defaultSkills || [])]; cfg.skillsTouched = false; }),
    skillBtn('Ninguna', () => { cfg.skills = []; }),
    skillBtn('Todas', () => { cfg.skills = (info?.skills || []).map((s) => s.file); }),
  );
  const skillsList = el('div', 'ctx-skill-list');
  skillsBox.append(skillsActions, skillsList);

  // Ejemplos y prompt de sistema.
  const examples = el('textarea');
  examples.rows = 3;
  examples.placeholder = 'Opcional: un componente de ejemplo, un fragmento de código o notas de estilo que querés que imite. Entra donde está {{ejemplos}}.';
  examples.oninput = () => { cfg.examples = examples.value; saveDrafts(); renderSummary(); };
  const template = el('textarea', 'ctx-template');
  template.rows = 10;
  template.spellcheck = false;
  template.oninput = () => { cfg.template = template.value.trim() === (info?.template || '').trim() ? '' : template.value; saveDrafts(); renderSystemStats(); renderSummary(); };
  const sysStats = el('p', 'muted small');
  const restore = el('button', 'small-btn', 'Restaurar por defecto');
  restore.type = 'button';
  restore.onclick = () => { cfg.template = ''; saveDrafts(); renderConfig(); };
  const previewBtn = el('button', 'small-btn', 'Ver el prompt final');
  previewBtn.type = 'button';
  const preview = el('pre', 'lab-out ctx-preview');
  preview.hidden = true;
  previewBtn.onclick = async () => {
    if (!preview.hidden) { preview.hidden = true; previewBtn.textContent = 'Ver el prompt final'; return; }
    previewBtn.disabled = true;
    try {
      const r = await fetch('/api/lab/context/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ variant: serverVariant(cfg) }) }).then((x) => x.json());
      if (r.error) throw new Error(r.error);
      preview.textContent = `≈ ${approxTokens(r.chars).toLocaleString('es')} tokens · ${r.chars.toLocaleString('es')} caracteres · ${r.harness}\n\n${r.system}`;
      preview.hidden = false;
      previewBtn.textContent = 'Ocultar el prompt final';
    } catch (err) { error(err.message); } finally { previewBtn.disabled = false; }
  };
  const sysActions = el('div', 'actions compact');
  sysActions.append(restore, previewBtn);
  const sysBox = el('div', 'ctx-block');
  sysBox.append(
    el('span', 'lab-field-label', 'Ejemplos (few-shot)'), examples,
    el('span', 'lab-field-label', 'Prompt de sistema'),
    el('span', 'muted small', 'Marcadores: {{herramientas}} (según los modos de arriba), {{ejemplos}} y {{skills}}. Si borrás uno, esa parte no entra.'),
    template, sysStats, sysActions, preview,
  );
  config.append(toolsBox, askBox, seeBox, skillsBox, sysBox);

  // ---------- Resultado ----------
  const status = el('div', 'lab-status');
  const stage = el('div', 'lab-stage');
  const actions = el('div', 'actions compact');
  const layers = el('div', 'lab-adjust ctx-layers');
  const toolsOut = el('details', 'lab-tools');
  const feedback = el('div', 'lab-feedback');
  const thread = el('div', 'lab-thread');
  const fbText = el('textarea');
  fbText.rows = 2;
  fbText.placeholder = 'Qué cambiar en esta variante. ⌘/Ctrl + Enter para enviar.';
  const fbSend = el('button', 'small-btn lab-fb-send', 'Enviar');
  fbSend.type = 'button';
  const fbQueue = el('p', 'muted small');
  const fbRow = el('div', 'actions compact');
  fbRow.append(fbSend);
  feedback.append(el('span', 'lab-field-label', 'Feedback para esta variante'), thread, fbText, fbRow, fbQueue);
  const metrics = el('dl', 'lab-metrics');
  const evalBox = el('div', 'lab-eval');
  const live = el('details', 'lab-live');
  live.append(el('summary', null, 'Respuesta del modelo'));
  const out = el('pre', 'lab-out');
  live.append(out);
  const codeBox = el('details', 'lab-code');
  codeBox.append(el('summary', null, 'Ver código (TSX)'));
  const codePre = el('pre', 'lab-out');
  codeBox.append(codePre);
  node.append(head, summary, config, status, stage, actions, layers, toolsOut, feedback, metrics, evalBox, live, codeBox);

  const card = {
    cfg, node, stage, frame: null, controller: null, code: '', js: '', turns: [], runtimeFixes: 0, pending: null,
    assets: [], found: [], sounds: [], videos: [], queue: [], rendering: null, renderPhase: null, frameNow: 0,
    entry: () => exp?.variants.find((v) => v.slot === cfg.id) || null,
    run: () => card.entry()?.run || null,
    key: () => card.entry()?.key || null,
  };

  function rowOf(...nodes) { const r = el('div', 'ctx-row'); r.append(...nodes); return r; }

  function renderSkills() {
    const total = skillsChars(cfg.skills);
    skillsSum.textContent = `Remotion Agent Skills · ${cfg.skills.length} de ${info?.skills?.length || 0} · ≈ ${approxTokens(total).toLocaleString('es')} tokens`;
    skillsList.replaceChildren(...(info?.skills || []).map((s) => {
      const w = el('label', 'ctx-skill small');
      const c = el('input');
      c.type = 'checkbox';
      c.checked = cfg.skills.includes(s.file);
      c.onchange = () => {
        cfg.skills = c.checked ? [...new Set([...cfg.skills, s.file])] : cfg.skills.filter((f) => f !== s.file);
        cfg.skillsTouched = true;
        saveDrafts(); renderSkills(); renderSummary();
      };
      w.title = s.title;
      w.append(c, el('span', null, s.file.replace('remotion-markup/', '')), el('span', 'muted', `≈ ${approxTokens(s.chars).toLocaleString('es')}`));
      return w;
    }));
  }

  function renderSystemStats() {
    const text = cfg.template || info?.template || '';
    const marks = ['herramientas', 'ejemplos', 'skills'].filter((m) => new RegExp(`\\{\\{\\s*${m}\\s*\\}\\}`, 'i').test(text));
    sysStats.textContent = `${cfg.template ? 'Editado' : 'Por defecto'} · plantilla ≈ ${approxTokens(text.length).toLocaleString('es')} tokens · + skills ≈ ${marks.includes('skills') ? approxTokens(skillsChars(cfg.skills)).toLocaleString('es') : 0} · marcadores: ${marks.join(', ') || 'ninguno'}`;
  }

  function renderOwnRefs() {
    ownRefs.hidden = cfg.refsMode !== 'own';
    if (ownRefs.hidden) return;
    ownRefs.replaceChildren();
    cfg.refs.forEach((r) => ownRefs.append(refThumb(r, () => { cfg.refs = cfg.refs.filter((x) => x !== r); saveDrafts(); renderOwnRefs(); refresh(); })));
    const max = info?.harness?.maxBriefRefs || 6;
    if (cfg.refs.length < max) ownRefs.append(addRefButton((files) => addRefsTo(cfg.refs, files, () => { saveDrafts(); renderOwnRefs(); refresh(); })));
  }

  function renderConfig() {
    const t = info?.tools || {};
    toolRows.forEach(({ k, buttons, lim, note, modelSel, row }) => {
      const avail = !!t[k];
      buttons.forEach(([m, b]) => { b.setAttribute('aria-checked', String(cfg.policy[k] === m)); b.disabled = !avail && m !== 'off'; });
      const lk = LIMIT_KEY[k];
      lim.max = String(info?.limits?.caps?.[lk] || 6);
      lim.value = String(cfg.limits[lk]);
      lim.disabled = cfg.policy[k] === 'off';
      row.dataset.mode = cfg.policy[k];
      note.textContent = avail ? '' : { search: 'falta SERPAPI_API_KEY', images: 'falta WAVESPEED_API_KEY', sound: 'falta WAVESPEED_API_KEY', video: 'falta WAVESPEED_API_KEY' }[k];
      if (modelSel) {
        modelSel.replaceChildren(...(t.videoModels || []).map((m) => { const o = el('option', null, m.label); o.value = m.id; return o; }));
        modelSel.value = cfg.videoModel;
        modelSel.disabled = cfg.policy.video === 'off';
      }
    });
    ctxText.value = cfg.context ?? '';
    ctxText.placeholder = cfg.context === null ? `(hereda) ${contextInput.value.slice(0, 120)}` : 'Contexto de esta variante';
    ctxText.disabled = cfg.context === null;
    ctxBtn.textContent = cfg.context === null ? 'Reemplazar' : 'Volver a heredar';
    insText.value = cfg.instructions ?? '';
    insText.placeholder = cfg.instructions === null ? `(hereda) ${instructionsInput.value.slice(0, 120)}` : 'Instrucciones de esta variante';
    insText.disabled = cfg.instructions === null;
    insBtn.textContent = cfg.instructions === null ? 'Reemplazar' : 'Volver a heredar';
    refsMode.value = cfg.refsMode;
    frames.max = String(info?.maxFrames ?? 6);
    frames.value = String(cfg.frames);
    framesVal.textContent = String(cfg.frames);
    temp.value = cfg.temperature === null ? '' : String(cfg.temperature);
    reasoning.value = cfg.reasoning || '';
    examples.value = cfg.examples;
    if (document.activeElement !== template) template.value = cfg.template || info?.template || '';
    renderOwnRefs();
    renderSkills();
    renderSystemStats();
    renderSummary();
  }
  card.renderConfig = renderConfig;

  function renderSummary() {
    const b = briefOf(cfg);
    const parts = [
      policySignature(cfg.policy),
      `${cfg.frames} cuadro${cfg.frames === 1 ? '' : 's'}/zona`,
      `${cfg.skills.length} skills`,
      cfg.template ? 'prompt editado' : 'prompt por defecto',
      cfg.examples.trim() ? 'con ejemplos' : null,
      `${b.refs.length} ref.`,
      cfg.context !== null || cfg.instructions !== null ? 'pedido propio' : null,
      cfg.temperature !== null ? `temp. ${cfg.temperature}` : null,
      cfg.reasoning ? `razonamiento ${cfg.reasoning}` : null,
    ].filter(Boolean);
    summary.textContent = parts.join(' · ');
  }
  card.renderSummary = () => { renderSummary(); if (cfg.context === null || cfg.instructions === null) renderConfig(); };

  // ---------- Capas: animación y tomas de IA ----------
  const layerState = () => card.run()?.layers || { motionHidden: false, videos: {} };
  const motionTransform = () => ({ ...IDENTITY, ...(card.run()?.transform || {}) });
  card.sendLayers = () => {
    const st = layerState();
    card.frame?.contentWindow?.postMessage({ type: 'transform', transform: motionTransform() }, '*');
    card.frame?.contentWindow?.postMessage({ type: 'layers', motionHidden: !!st.motionHidden, videoLayers: videoLayersMeta() }, '*');
  };
  function videoLayersMeta() {
    const st = layerState();
    return card.videos.map((v) => ({ id: v.id, kind: v.kind, from: v.from, durationInFrames: v.durationInFrames, transform: { ...IDENTITY, ...(st.videos[v.id]?.transform || {}) }, hidden: !!st.videos[v.id]?.hidden, muted: st.videos[v.id]?.muted !== false }));
  }
  card.videoLayersMeta = videoLayersMeta;
  const clampT = (t) => ({ scale: Math.round(Math.min(2.5, Math.max(0.2, t.scale)) * 1000) / 1000, x: Math.round(Math.min(60, Math.max(-60, t.x)) * 10) / 10, y: Math.round(Math.min(60, Math.max(-60, t.y)) * 10) / 10 });
  function layerControls(title, getT, setT, extras = []) {
    const box = el('div', 'ctx-layer');
    box.append(el('span', 'small ctx-layer-title', title), ...extras);
    const sl = (name, min, max, step, read, write, unit) => {
      const w = el('label', 'lab-slider');
      const input = el('input');
      input.type = 'range'; input.min = String(min); input.max = String(max); input.step = String(step);
      const value = el('span', 'small lab-slider-value');
      const sync = () => { const v = read(getT()); input.value = String(v); value.textContent = `${Math.round(v)}${unit}`; };
      input.oninput = () => { setT(clampT(write(getT(), Number(input.value))), false); sync(); };
      input.onchange = () => { setT(clampT(write(getT(), Number(input.value))), true); sync(); };
      sync();
      w.append(el('span', 'small', name), input, value);
      return w;
    };
    const reset = el('button', 'small-btn', 'Restablecer');
    reset.type = 'button';
    reset.onclick = () => { setT({ ...IDENTITY }, true); renderLayers(); };
    box.append(
      sl('Tamaño', 20, 250, 1, (t) => t.scale * 100, (t, v) => ({ ...t, scale: v / 100 }), '%'),
      sl('Horizontal', -60, 60, 0.5, (t) => t.x, (t, v) => ({ ...t, x: v }), '%'),
      sl('Vertical', -60, 60, 0.5, (t) => t.y, (t, v) => ({ ...t, y: v }), '%'),
      reset,
    );
    return box;
  }
  const check = (text, value, onChange) => {
    const w = el('label', 'lab-inline ctx-check');
    const c = el('input');
    c.type = 'checkbox'; c.checked = value;
    c.onchange = () => onChange(c.checked);
    w.append(c, el('span', 'small', text));
    return w;
  };
  function renderLayers() {
    const run = card.run();
    layers.replaceChildren();
    layers.hidden = !(run && card.frame && run.status === 'done');
    if (layers.hidden) return;
    run.layers ??= { motionHidden: false, videos: {} };
    layers.append(el('span', 'lab-field-label', 'Capas'));
    layers.append(layerControls('Animación del agente', motionTransform, (t, save) => { run.transform = t; card.sendLayers(); if (save) persistSoon(); }, [
      check('Visible', !run.layers.motionHidden, (v) => { run.layers.motionHidden = !v; card.sendLayers(); persistSoon(); }),
    ]));
    card.videos.forEach((v) => {
      run.layers.videos[v.id] ??= { hidden: false, muted: true, transform: { ...IDENTITY } };
      const st = run.layers.videos[v.id];
      layers.append(layerControls(`${v.id} · toma de IA en ${v.zone}${v.kind === 'image' ? ' (demo: cuadro quieto)' : ''}`, () => ({ ...IDENTITY, ...st.transform }), (t, save) => { st.transform = t; card.sendLayers(); if (save) persistSoon(); }, [
        check('Visible', !st.hidden, (x) => { st.hidden = !x; card.sendLayers(); persistSoon(); }),
        ...(v.kind === 'video' ? [check('Con su sonido', st.muted === false, (x) => { st.muted = !x; card.sendLayers(); persistSoon(); })] : []),
      ]));
    });
  }

  // ---------- Lo que usó de las herramientas ----------
  function renderTools() {
    toolsOut.replaceChildren();
    const n = card.found.length + card.assets.length + card.sounds.length + card.videos.length;
    toolsOut.hidden = !n;
    if (!n) return;
    toolsOut.append(el('summary', null, `Herramientas · ${card.found.length} búsq. · ${card.assets.length} img. · ${card.sounds.length} sonido${card.sounds.length === 1 ? '' : 's'} · ${card.videos.length} toma${card.videos.length === 1 ? '' : 's'}`));
    card.videos.forEach((v) => toolsOut.append(el('p', 'small', `${v.id} · ${v.model || ''} · ${v.zone} desde ${v.source}: ${v.prompt}`)));
    card.sounds.forEach((s) => {
      const fig = el('figure', 'lab-asset ctx-sound');
      const a = el('audio');
      a.controls = true; a.preload = 'none'; a.src = s.url;
      fig.append(a, el('figcaption', 'small', `${s.id} · ${s.duration} s · ${s.prompt}`));
      toolsOut.append(fig);
    });
    card.assets.forEach((a) => {
      const fig = el('figure', 'lab-asset');
      const img = el('img'); img.src = a.url; img.alt = a.prompt;
      fig.append(img, el('figcaption', 'small', `${a.id} · ${a.prompt}`));
      toolsOut.append(fig);
    });
    card.found.forEach((f) => {
      toolsOut.append(el('p', 'small lab-query', `Buscó: «${f.query}»`));
      const strip = el('div', 'thumbs');
      f.results.forEach((r) => {
        const t = el(r.link ? 'a' : 'div', 'thumb');
        if (r.link) { t.href = r.link; t.target = '_blank'; t.rel = 'noopener noreferrer'; }
        t.title = `${r.id} · ${r.title}`;
        const img = el('img'); img.src = r.thumb; img.alt = r.title;
        t.append(img);
        strip.append(t);
      });
      toolsOut.append(strip);
    });
  }

  // ---------- Feedback ----------
  const busyNow = () => ['running', 'checking'].includes(card.run()?.status);
  function sendFeedback() {
    const text = fbText.value.trim();
    const run = card.run();
    if (!text || !run) { fbText.focus(); return; }
    fbText.value = '';
    run.thread = [...(run.thread || []), { role: 'user', text, queued: busyNow() || !card.code }];
    if (busyNow() || !card.code) { card.queue.push(text); persist(); card.render(); return; }
    revise(text);
  }
  function revise(text) {
    const run = card.run();
    (run.thread || []).forEach((m) => { if (m.role === 'user') m.queued = false; });
    card.turns.push({ code: card.code, kind: 'feedback', message: text });
    card.runtimeFixes = 0;
    run.eval.approved = null;
    execute(card, 'feedback', text);
  }
  card.flushQueue = () => {
    if (!card.queue.length || busyNow() || !card.code) return;
    const text = card.queue.length === 1 ? card.queue[0] : card.queue.map((t, i) => `${i + 1}. ${t}`).join('\n');
    card.queue = [];
    revise(text);
  };
  fbSend.onclick = sendFeedback;
  fbText.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); sendFeedback(); } });

  // ---------- Pintar el estado ----------
  card.render = () => {
    const run = card.run();
    const st = run?.status || 'idle';
    const key = card.key();
    const index = drafts.findIndex((d) => d.id === cfg.id);
    badge.textContent = key || `V${index + 1}`;
    node.dataset.status = st;
    const locked = !!exp;
    dup.disabled = locked || drafts.length >= (info?.maxVariants || 4);
    del.disabled = locked || drafts.length <= 2;
    dup.title = locked ? 'Empezá un experimento nuevo para cambiar las variantes' : 'Copia esta variante con toda su configuración';
    if (run && !card.frame) stage.replaceChildren(el('div', 'lab-empty', st === 'running' ? 'Trabajando…' : 'Acá va la animación de esta variante'));
    else if (!run) stage.replaceChildren(el('div', 'lab-empty', 'Acá va la animación de esta variante'));
    stage.hidden = !run;
    status.textContent = !run ? '' : {
      running: card.pending || 'Trabajando…',
      checking: 'Probando la animación en el Player…',
      done: `Listo · ${run.attempts.length} ${run.attempts.length === 1 ? 'ejecución' : 'ejecuciones'}`,
      error: `Falló: ${run.error || 'error desconocido'}`,
      idle: '',
    }[st];
    actions.replaceChildren();
    if (st === 'running' || st === 'checking') actions.append(button('Detener', () => card.controller?.abort()));
    if (st === 'error' && run) {
      actions.append(button(card.code && run.runtimeError ? 'Corregir el error' : 'Reintentar', () => {
        if (card.code && run.runtimeError) { card.turns.push({ code: card.code, kind: 'runtime', message: run.runtimeError }); card.runtimeFixes = 0; execute(card, 'runtime'); } else execute(card, card.turns.at(-1)?.kind || 'initial');
      }));
    }
    if (st === 'done' && card.frame) {
      const dl = button(card.rendering !== null ? `${card.renderPhase || 'Renderizando'}… ${Math.round(card.rendering * 100)} %` : 'Descargar video', () => card.download());
      dl.disabled = card.rendering !== null;
      dl.title = 'Renderiza en tu navegador el video con todas las capas tal cual se ven. Dejá la pestaña visible mientras tanto.';
      actions.append(dl);
    }
    feedback.hidden = !run;
    if (run) {
      thread.replaceChildren(...(run.thread || []).map((m) => {
        const b = el('div', `lab-msg ${m.role === 'user' ? 'me' : 'agent'}`);
        b.append(el('span', 'lab-msg-who', m.role === 'user' ? `Vos${m.queued ? ' · en cola' : ''}` : `${key} · versión ${m.version || ''}`), el('span', null, m.text));
        return b;
      }));
      thread.hidden = !(run.thread || []).length;
      fbSend.textContent = busyNow() ? 'Encolar' : 'Enviar';
      fbQueue.textContent = card.queue.length ? `${card.queue.length} pedido${card.queue.length > 1 ? 's' : ''} en cola: se mandan juntos cuando termine.` : 'La revisión usa la configuración con la que corrió esta variante.';
    }
    renderLayers();
    renderTools();
    codeBox.hidden = !card.code;
    codePre.textContent = card.code;
    renderMetrics(run);
    renderEval(run);
  };

  function renderMetrics(run) {
    metrics.replaceChildren();
    if (!run || !run.attempts.length) { metrics.hidden = true; return; }
    metrics.hidden = false;
    const m = variantMetrics(run);
    const row = (labelText, value, title) => { const d = el('div'); if (title) d.title = title; d.append(el('dt', null, labelText), el('dd', null, value)); metrics.append(d); };
    row('Costo', money(m.cost), `Todo lo gastado, con correcciones, revisiones y herramientas (herramientas: ${money(m.toolCost)})`);
    row('Tiempo', secs(m.ms));
    row('Intentos', String(m.attempts), `Componentes que escribió. Llamadas al modelo: ${m.calls}`);
    row('Contexto inicial', m.firstPrompt ? `${m.firstPrompt.toLocaleString('es')} tok.` : '—', 'Tokens de entrada de la primera llamada (lo que el proveedor contó del prompt de sistema + pedido + imágenes)');
    row('Herramientas', `${m.searches} búsq. · ${m.images} img. · ${m.sounds} son. · ${m.videos} tomas`);
    row('Correcciones auto.', String(m.autoFixes));
    row('Intervención', [`${m.revisions} rev.`, m.adjusted && 'ajuste', m.manualMinutes && `${m.manualMinutes} min`].filter(Boolean).join(' + '));
    row('Tokens', m.tokens.toLocaleString('es'));
  }

  function renderEval(run) {
    evalBox.replaceChildren();
    if (!run || !card.code) { evalBox.hidden = true; return; }
    evalBox.hidden = false;
    const ev = run.eval;
    const verdict = el('div', 'options lab-verdict');
    [[true, '✓ Aprobar'], [false, '✕ Rechazar']].forEach(([v, t]) => {
      const b = el('button', `option ${v ? 'ok' : 'ko'}`, t);
      b.type = 'button';
      b.setAttribute('aria-pressed', String(ev.approved === v));
      b.onclick = () => { ev.approved = ev.approved === v ? null : v; persist(); card.render(); renderCompare(); };
      verdict.append(b);
    });
    const stars = (t, k) => {
      const r = el('div', 'lab-stars');
      r.append(el('span', 'small', t));
      for (let i = 1; i <= 5; i++) {
        const s = el('button', 'lab-star', '★');
        s.type = 'button';
        s.setAttribute('aria-label', `${t}: ${i} de 5`);
        s.setAttribute('aria-pressed', String(ev[k] >= i));
        s.onclick = () => { ev[k] = ev[k] === i ? 0 : i; persist(); card.render(); renderCompare(); };
        r.append(s);
      }
      return r;
    };
    const manual = el('input');
    manual.type = 'number'; manual.min = '0'; manual.max = '600'; manual.value = ev.manualMinutes || ''; manual.placeholder = '0';
    manual.onchange = () => { ev.manualMinutes = Math.max(0, Math.min(600, Number(manual.value) || 0)); persist(); renderMetrics(run); };
    const mw = el('label', 'lab-inline');
    mw.append(el('span', 'small', 'Retoque manual (min)'), manual);
    const notes = el('textarea');
    notes.rows = 2; notes.placeholder = 'Qué funcionó o no de este contexto'; notes.value = ev.notes || '';
    notes.oninput = () => { ev.notes = notes.value; persistSoon(); };
    evalBox.append(verdict, stars('Calidad', 'quality'), stars('Fidelidad', 'fidelity'), mw, notes);
  }

  card.download = () => {
    if (!card.frame || card.rendering !== null) return;
    error(document.hidden ? 'Dejá esta pestaña visible mientras se renderiza.' : '');
    card.rendering = 0;
    card.render();
    card.frame.contentWindow.postMessage({ type: 'render' }, '*');
  };
  card.write = (text) => { out.textContent = (out.textContent + text).slice(-6000); };
  card.clearOut = () => { out.textContent = ''; };
  card.reset = () => {
    card.controller?.abort();
    Object.assign(card, { code: '', js: '', turns: [], assets: [], found: [], sounds: [], videos: [], queue: [], rendering: null, runtimeFixes: 0, pending: null });
    card.clearOut();
    unmount(card);
  };
  renderConfig();
  return card;
}

function button(text, fn) { const b = el('button', 'small-btn', text); b.type = 'button'; b.onclick = fn; return b; }

// ---------- Referencias (base y propias) ----------
function refThumb(r, onRemove) {
  const t = el('div', `thumb${r.status === 'loading' ? ' loading' : ''}`);
  if (r.status === 'loading') t.append(el('span', 'thumb-kind', '🖼️'));
  else { const img = el('img'); img.src = r.thumb; img.alt = r.name; t.append(img); }
  const x = el('button', 'remove', '×');
  x.type = 'button'; x.setAttribute('aria-label', `Quitar referencia ${r.name}`);
  x.onclick = onRemove;
  t.append(x);
  return t;
}
function addRefButton(onFiles) {
  const add = el('label', 'add-ref');
  const inp = el('input');
  inp.type = 'file'; inp.accept = 'image/*'; inp.multiple = true; inp.hidden = true;
  inp.onchange = () => { onFiles([...inp.files]); inp.value = ''; };
  add.append(inp, el('span', null, '+ Referencia'), el('span', 'muted small', 'imágenes'));
  return add;
}
async function addRefsTo(list, files, onUpdate) {
  const max = info?.harness?.maxBriefRefs || 6;
  const room = max - list.length;
  if (files.length > room) error(`Máximo ${max} referencias visuales.`);
  const added = files.slice(0, Math.max(0, room)).map((file) => ({ key: ++seq, name: file.name, status: 'loading', file }));
  list.push(...added);
  onUpdate();
  await Promise.all(added.map(async (r) => {
    try {
      const p = await loadPhoto(r.file);
      URL.revokeObjectURL(p.url);
      Object.assign(r, { url: p.frames[0].url, thumb: p.thumb, status: 'ready' });
    } catch (err) {
      error(`${r.name}: ${err.message}`);
      list.splice(list.indexOf(r), 1);
    }
    delete r.file;
    onUpdate();
  }));
}
function renderBaseRefs() {
  refsBox.replaceChildren();
  baseRefs.forEach((r) => refsBox.append(refThumb(r, () => { baseRefs = baseRefs.filter((x) => x !== r); saveBaseRefs(); })));
  if (baseRefs.length < (info?.harness?.maxBriefRefs || 6)) refsBox.append(addRefButton((files) => addRefsTo(baseRefs, files, saveBaseRefs)));
}
function saveBaseRefs() {
  renderBaseRefs(); refresh(); cards.forEach((c) => c.renderSummary());
  store.putBlob('draft:base:refs', baseRefs.filter((r) => r.status === 'ready').map(({ name, url, thumb }) => ({ name, url, thumb })));
}

// ---------- Variantes ----------
function addVariant(cfg, after = null) {
  if (exp || drafts.length >= (info?.maxVariants || 4)) return;
  const at = after ? drafts.findIndex((d) => d.id === after) + 1 : drafts.length;
  drafts.splice(at, 0, cfg);
  renderVariants();
  saveDrafts();
}
function removeVariant(id) {
  if (exp || drafts.length <= 2) return;
  drafts = drafts.filter((d) => d.id !== id);
  cards.get(id)?.reset();
  cards.delete(id);
  store.putBlob(`draft:${id}:refs`, []);
  renderVariants();
  saveDrafts();
}
function renderVariants() {
  drafts.forEach((d) => { if (!cards.has(d.id)) cards.set(d.id, createCard(d)); });
  grid.replaceChildren(...drafts.map((d) => cards.get(d.id).node));
  grid.dataset.count = String(drafts.length);
  addBtn.disabled = !!exp || drafts.length >= (info?.maxVariants || 4);
  addBtn.title = exp ? 'Empezá un experimento nuevo para cambiar las variantes' : '';
  cards.forEach((c) => c.render());
  refresh();
}
addBtn.onclick = () => addVariant(defaultConfig(`Variante ${drafts.length + 1}`));

// ---------- Ejecutar ----------
const MODEL_ID = /^[\w.-]+\/[\w.:@-]+$/;
function missing() {
  const m = studio.missing();
  if (!studio.hasVideo() && !studio.busy()) return 'Subí un clip de video para empezar.';
  if (m) return m;
  if (!MODEL_ID.test(modelInput.value.trim())) return 'Elegí el modelo (el mismo para todas las variantes).';
  if (drafts.length < 2) return 'Hacen falta al menos dos variantes.';
  if (baseRefs.some((r) => r.status === 'loading') || drafts.some((d) => d.refs.some((r) => r.status === 'loading'))) return 'Preparando las referencias…';
  return null;
}
const busy = () => !!exp?.variants.some((v) => ['running', 'checking'].includes(v.run.status));

function refresh() {
  const v = studio.current();
  if (v) cards.forEach((c) => { if (!c.frame) c.stage.style.setProperty('--ar', `${v.width} / ${v.height}`); });
  const why = missing();
  const running = busy();
  runBtn.disabled = !!why || running;
  runBtn.textContent = exp ? 'Ejecutar como experimento nuevo' : `Ejecutar ${drafts.length} variantes`;
  modelInput.disabled = running;
  hint.textContent = running ? 'Las variantes trabajan por separado: ninguna ve lo que hacen las otras.'
    : why || (exp ? 'Los cambios de configuración se usan en un experimento nuevo; el feedback de cada variante sigue con la configuración con la que corrió.' : `Listo: el mismo modelo corre ${drafts.length} veces, una por variante, con el mismo clip y las mismas zonas.`);
  newBtn.hidden = !exp;
}

runBtn.onclick = async () => {
  if (missing() || busy()) return;
  error('');
  runBtn.disabled = true;
  try {
    // Si había un experimento abierto, se cierra (queda en el historial) y se arranca uno nuevo con las mismas variantes.
    if (exp) { cards.forEach((c) => c.reset()); exp = null; }
    const { body } = await studio.request('');
    const parsed = JSON.parse(body);
    const v = studio.current();
    const model = modelInput.value.trim();
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    const variants = {};
    const entries = drafts.map((cfg, i) => {
      const key = `V${i + 1}`;
      const b = briefOf(cfg);
      const snapshot = { ...JSON.parse(JSON.stringify({ ...cfg, refs: [] })), refs: cfg.refsMode === 'own' ? readyRefs(cfg.refs) : [] };
      variants[key] = { cfg: snapshot, brief: b, variant: serverVariant(cfg) };
      return {
        key, slot: cfg.id,
        config: configSummary({ ...cfg, refsCount: b.refs.length }, { skillsChars: skillsChars(cfg.skills), defaultTemplate: info?.template || '' }),
        run: newVariantRun(model),
      };
    });
    frozen = { payload: { video: parsed.video, clips: parsed.clips }, variants, base: { context: contextInput.value, instructions: instructionsInput.value, refs: readyRefs(baseRefs) } };
    exp = {
      id,
      createdAt: new Date().toISOString(),
      name: nameInput.value.trim() || `Contexto ${store.listExperiments().length + 1} · ${v.name}`,
      section: 'context-lab',
      harness: info?.harness?.version || '',
      model,
      video: { name: v.name, duration: v.duration, width: v.width, height: v.height },
      zones: parsed.clips.map((c) => ({ id: c.id, start: c.start, end: c.end, prompt: c.prompt, notes: c.notes, refs: c.refs.length })),
      variants: entries,
      preference: null,
      notes: '',
    };
    nameInput.value = exp.name;
    await store.putBlob(`${id}:video`, v.file);
    await store.putBlob(`${id}:inputs`, frozen);
    frozen.file = v.file;
    persist();
    renderVariants();
    cards.forEach((c) => { c.reset(); execute(c, 'initial'); });
    renderCompare();
  } catch (err) {
    error(err.message);
  } finally {
    refresh();
  }
};

newBtn.onclick = () => {
  if (busy() && !confirm('Hay variantes trabajando. ¿Detenerlas y empezar de cero?')) return;
  cards.forEach((c) => c.reset());
  exp = null; frozen = null;
  nameInput.value = '';
  compare.hidden = true;
  renderVariants();
};

// Una ejecución de una variante: stream → código compilado → Player aislado → prueba de humo.
async function execute(card, reason, feedback) {
  const entry = card.entry();
  const run = entry?.run;
  const fz = frozen?.variants[entry?.key];
  if (!run || !fz) return;
  card.controller?.abort();
  const controller = new AbortController();
  card.controller = controller;
  run.status = 'running';
  run.error = null;
  run.runtimeError = null;
  card.pending = REASON[reason] ? `${REASON[reason]}…` : 'Trabajando…';
  card.write(`\n\n— ${REASON[reason] || reason} —\n`);
  persist(); card.render(); refresh();
  const attempt = { reason, calls: 0, compileErrors: 0, cost: 0, llmCost: 0, toolCost: 0, searches: 0, images: 0, sounds: 0, videos: 0, tokens: 0, promptTokens: 0, ms: 0, ok: false, at: new Date().toISOString(), ...(feedback ? { feedback } : {}) };
  const counters = (ev) => Object.fromEntries(['calls', 'cost', 'llmCost', 'toolCost', 'searches', 'images', 'sounds', 'videos', 'tokens', 'promptTokens'].map((k) => [k, ev[k] ?? attempt[k]]));
  run.attempts.push(attempt);
  const t0 = performance.now();
  let result = null;
  let failed = null;
  try {
    const body = JSON.stringify({
      model: run.model, brief: fz.brief, video: frozen.payload.video, clips: frozen.payload.clips, turns: card.turns,
      assets: card.assets, sounds: card.sounds.map(({ id, url, prompt, duration }) => ({ id, url, prompt, duration })), videos: card.videos.map(({ id, zone, prompt, source }) => ({ id, zone, prompt, source })),
      variant: fz.variant,
    });
    await streamEvents('/api/lab/context/run', body, controller.signal, (ev) => {
      switch (ev.type) {
        case 'run': run.context = ev.context; return;
        case 'attempt': card.pending = `${REASON[ev.reason] || 'Trabajando'} · llamada ${ev.call}…`; card.render(); return;
        case 'delta': card.write(ev.text); if (ev.chars % 600 < ev.text.length) { card.pending = `Escribiendo… ${ev.chars.toLocaleString('es')} caracteres`; card.render(); } return;
        case 'reasoning': if (!card.pending?.startsWith('Pensando')) { card.pending = 'Pensando…'; card.render(); } return;
        case 'notice': card.write(`\n[${ev.text}]\n`); return;
        case 'compile_error': attempt.compileErrors += 1; card.write(`\n[No compila: ${ev.text}]\n`); card.pending = 'No compiló: corrigiendo…'; card.render(); return;
        case 'tool': card.write(`\n[${ev.name}: ${JSON.stringify(ev.args).slice(0, 300)}]\n`); card.pending = TOOL_EVENT[ev.name] || 'Usando una herramienta…'; card.render(); return;
        case 'search': card.found.push({ query: ev.query, results: ev.results }); card.render(); return;
        case 'asset': card.assets.push({ id: ev.id, url: ev.url, prompt: ev.prompt }); card.render(); return;
        case 'sound': card.sounds.push({ id: ev.id, url: ev.url, prompt: ev.prompt, duration: ev.duration }); card.render(); return;
        case 'video': card.videos.push({ id: ev.id, kind: ev.kind, url: ev.url, zone: ev.zone, from: ev.from, durationInFrames: ev.durationInFrames, prompt: ev.prompt, source: ev.source, model: ev.model }); card.render(); return;
        case 'usage':
          // La primera llamada de la primera ejecución dice cuánto contexto recibió de arranque.
          if (reason === 'initial' && !attempt.firstPromptTokens && ev.calls === 1) attempt.firstPromptTokens = ev.promptTokens || null;
          Object.assign(attempt, counters(ev)); card.render(); return;
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
  if (card.controller === controller) card.controller = null;
  // Una ejecución detenida que termina tarde (se empezó otro experimento) no toca nada del nuevo.
  if (card.run() !== run) return;
  if (failed || !result) {
    attempt.ok = false;
    attempt.error = failed || 'el servidor no devolvió un componente';
    run.status = 'error';
    run.error = attempt.error;
    card.pending = null;
    await saveCode(card);
    persist(); card.render(); refresh(); renderCompare();
    return;
  }
  attempt.ok = true;
  card.code = result.code;
  card.js = result.js;
  run.notes = result.notes;
  run.usedRefs = result.usedRefs ?? null;
  run.palette = result.palette ?? null;
  run.objects = result.objects ?? null;
  run.hasCode = true;
  run.thread = [...(run.thread || []), { role: 'agent', text: result.notes || '(sin notas)', version: run.attempts.filter((a) => a.ok).length }];
  run.status = 'checking';
  card.pending = null;
  await saveCode(card);
  persist(); card.render(); refresh();
  mount(card);
}

const saveCode = (card) => exp && store.putBlob(`${exp.id}:code:${card.key()}`, {
  code: card.code, js: card.js, notes: card.run()?.notes || '', turns: card.turns, assets: card.assets, found: card.found, sounds: card.sounds, videos: card.videos,
});

// ---------- Player aislado ----------
function unmount(card) {
  card.frame?.remove();
  card.frame = null;
  card.stage.replaceChildren(el('div', 'lab-empty', 'Acá va la animación de esta variante'));
}
let frameDoc = null;
const frameHtml = () => {
  frameDoc ??= fetch('/api/lab/frame.html').then((r) => (r.ok ? r.text() : r.text().then((t) => { throw new Error(t); }))).catch((err) => { frameDoc = null; throw err; });
  return frameDoc;
};
async function mount(card) {
  const v = frozen?.payload.video;
  if (!v || !frozen.file || !card.js) return;
  let html;
  try {
    html = await frameHtml();
  } catch (err) {
    const run = card.run();
    if (run) { run.status = 'error'; run.error = `no cargó el Player de Remotion: ${err.message}`; persist(); card.render(); refresh(); }
    return;
  }
  card.frame?.remove();
  const frame = el('iframe', 'lab-frame');
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.title = `Animación de la variante ${card.key()}`;
  frame.srcdoc = html;
  card.frame = frame;
  card.stage.style.setProperty('--ar', `${v.width} / ${v.height}`);
  card.stage.replaceChildren(frame);
}
const zonesOf = () => (frozen?.payload.clips || []).map((c) => ({ id: c.id, from: Math.round(c.start * fps()), durationInFrames: Math.max(1, Math.round(c.end * fps()) - Math.round(c.start * fps())), prompt: c.prompt, notes: c.notes }));
const toBlob = async (url) => (await fetch(url)).blob();

async function boot(card) {
  const v = frozen.payload.video;
  const run = card.run();
  // Los sonidos (data URL) y las tomas (/media/…) entran al iframe como Blob: su CSP no le deja pedir nada.
  const sounds = Object.fromEntries(await Promise.all(card.sounds.map(async (s) => [s.id, await toBlob(s.url)])));
  const meta = card.videoLayersMeta();
  const videoLayers = await Promise.all(card.videos.map(async (x, i) => {
    if (x.kind !== 'video') return { ...meta[i], url: x.url };
    try { return { ...meta[i], blob: await toBlob(x.url) }; } catch { error(`No pude cargar la toma ${x.id}: ¿se borró de runs/media/?`); return { ...meta[i], url: null }; }
  }));
  card.frame?.contentWindow?.postMessage({
    type: 'load', js: card.js, video: frozen.file, meta: { duration: v.duration, width: v.width, height: v.height, fps: fps() }, zones: zonesOf(),
    images: Object.fromEntries(card.assets.map((a) => [a.id, a.url])), transform: { ...IDENTITY, ...(run?.transform || {}) }, legacy: false, segments: null,
    sounds, videoLayers, motionHidden: !!run?.layers?.motionHidden,
  }, '*');
}

window.addEventListener('message', (e) => {
  const card = [...cards.values()].find((c) => c.frame && e.source === c.frame.contentWindow);
  const msg = e.data;
  if (!card || msg?.source !== 'lab-frame') return;
  const run = card.run();
  if (msg.type === 'boot') { boot(card).catch((err) => error(err.message)); return; }
  if (msg.type === 'frame') { card.frameNow = msg.frame; return; }
  if (msg.type === 'render_progress') {
    const p = Math.round((msg.progress || 0) * 100);
    const phase = msg.overlay ? 'Renderizando las capas' : 'Renderizando';
    if (p !== Math.round((card.rendering || 0) * 100) || phase !== card.renderPhase) { card.rendering = msg.progress || 0; card.renderPhase = phase; card.render(); }
    return;
  }
  if (msg.type === 'rendered') {
    if (msg.overlay) {
      if (card.sounds.length) error('Este navegador no pudo decodificar el video de base: se compone en tiempo real y los efectos de sonido no quedan en el archivo.');
      compositeOverlay(frozen.file, frozen.payload.video, msg.blob, (p) => { card.rendering = p; card.renderPhase = 'Grabando'; card.render(); })
        .then(({ blob, ext }) => saveVideo(card, blob, ext))
        .catch((err) => error(`No se pudo armar el video de ${card.key()}: ${err.message}`))
        .finally(() => { card.rendering = null; card.renderPhase = null; card.render(); });
      return;
    }
    card.rendering = null;
    saveVideo(card, msg.blob, msg.ext);
    if (msg.muted) error('El video se descargó sin sonido: este navegador no pudo codificar el audio.');
    card.render();
    return;
  }
  if (msg.type === 'render_error') { card.rendering = null; error(`No se pudo renderizar el video de ${card.key()}: ${msg.message}`); card.render(); return; }
  if (!run) return;
  if (msg.type === 'checked') {
    if (msg.ok) {
      run.status = 'done';
      card.runtimeFixes = 0;
      persist(); card.render(); refresh(); renderCompare();
      card.flushQueue();
    } else runtimeFailure(card, msg.message);
  }
  if (msg.type === 'error') runtimeFailure(card, msg.message);
});

function runtimeFailure(card, message) {
  const run = card.run();
  if (!run || run.status === 'running') return;
  const last = run.attempts.at(-1);
  if (last) { last.ok = false; last.error = `error al reproducir: ${message}`; }
  run.runtimeError = message;
  card.write(`\n[Error al reproducir: ${message}]\n`);
  if (card.runtimeFixes < MAX_RUNTIME_FIXES && run.status === 'checking') {
    card.runtimeFixes += 1;
    card.turns.push({ code: card.code, kind: 'runtime', message });
    execute(card, 'runtime');
    return;
  }
  run.status = 'error';
  run.error = `error al reproducir: ${message}`;
  persist(); card.render(); refresh(); renderCompare();
}

function saveVideo(card, blob, ext) {
  const a = el('a');
  a.href = URL.createObjectURL(blob);
  const label = (card.entry()?.config?.label || '').replace(/[^\w\-áéíóúñ ]+/gi, '').trim().replace(/\s+/g, '-');
  a.download = `${(exp?.name || 'context-lab').replace(/[^\w\-áéíóúñ ]+/gi, '').trim().replace(/\s+/g, '-')}-${card.key()}${label ? `-${label}` : ''}.${ext}`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}

// ---------- Comparación ----------
function renderCompare() {
  if (!exp) { compare.hidden = true; return; }
  compare.hidden = false;
  compare.replaceChildren(el('div', 'decision-label', '4 · Comparar'));
  const list = exp.variants;
  const cardOf = (v) => cards.get(v.slot);
  const send = (msg) => list.forEach((v) => cardOf(v)?.frame?.contentWindow?.postMessage(msg, '*'));
  const sync = el('div', 'actions compact lab-sync');
  sync.append(
    button('▶ Reproducir todas', () => { send({ type: 'seek', frame: 0 }); send({ type: 'play' }); }),
    button('❚❚ Pausar', () => send({ type: 'pause' })),
  );
  const dlAll = button('Descargar todas', () => list.forEach((v) => cardOf(v)?.download()));
  dlAll.disabled = !list.every((v) => cardOf(v)?.frame && v.run.status === 'done');
  sync.append(dlAll);
  zonesOf().forEach((z) => sync.append(button(z.id, () => { send({ type: 'seek', frame: Math.max(0, z.from - 15) }); send({ type: 'play' }); })));
  compare.append(sync);

  const sums = list.map((v) => v.config);
  const mets = list.map((v) => variantMetrics(v.run));
  const wrap = el('div', 'lab-table-wrap');
  const table = el('table', 'lab-table ctx-table');
  const tr = (cells, tag = 'td', cls) => { const r = el('tr', cls); cells.forEach((c) => r.append(el(tag, null, c))); return r; };
  const cfgRow = (labelText, key, fmt) => tr([labelText, ...sums.map((s) => fmt(s))], 'td', differing(sums, key) ? 'ctx-diff' : null);
  const bestOf = (vals, lower = true) => {
    const ok = vals.filter((x) => Number.isFinite(x) && x > 0);
    if (ok.length < 2) return vals.map(() => '');
    const best = lower ? Math.min(...ok) : Math.max(...ok);
    return vals.map((x) => (x === best ? ' ●' : ''));
  };
  const cost = bestOf(mets.map((m) => m.cost));
  const time = bestOf(mets.map((m) => m.ms));
  const att = bestOf(mets.map((m) => m.attempts));
  const ctxTok = mets.map((m) => m.firstPrompt);
  const q = bestOf(list.map((v) => v.run.eval.quality || 0), false);
  table.append(
    tr(['', ...list.map((v) => `${v.key}${v.config.label ? ` · ${v.config.label}` : ''}`)], 'th'),
    tr(['Configuración', ...list.map(() => '')], 'td', 'ctx-section'),
    cfgRow('Herramientas', 'signature', (s) => s.signature),
    cfgRow('Cuadros por zona', 'frames', (s) => String(s.frames)),
    cfgRow('Skills', 'skillsChars', (s) => `${s.skills} · ≈ ${approxTokens(s.skillsChars).toLocaleString('es')} tok.`),
    cfgRow('Prompt de sistema', 'templateEdited', (s) => (s.templateEdited ? `editado (≈ ${approxTokens(s.templateChars).toLocaleString('es')} tok.)` : 'por defecto')),
    cfgRow('Ejemplos', 'examplesChars', (s) => (s.examplesChars ? `≈ ${approxTokens(s.examplesChars).toLocaleString('es')} tok.` : '—')),
    cfgRow('Pedido', 'briefOverride', (s) => (s.briefOverride ? 'propio' : 'base')),
    cfgRow('Referencias', 'refsCount', (s) => `${s.refsCount} (${{ base: 'base', own: 'propias', none: 'ninguna' }[s.refs]})`),
    cfgRow('Temperatura', 'temperature', (s) => (s.temperature === null ? 'por defecto' : String(s.temperature))),
    cfgRow('Razonamiento', 'reasoning', (s) => s.reasoning || 'por defecto'),
    tr(['Resultado', ...list.map(() => '')], 'td', 'ctx-section'),
    tr(['Estado', ...list.map((v) => (v.run.eval.approved === true ? 'Aprobada' : v.run.eval.approved === false ? 'Rechazada' : { running: 'trabajando', checking: 'probando', error: 'falló', done: 'sin evaluar' }[v.run.status] || '—'))]),
    tr(['Calidad', ...list.map((v, i) => (v.run.eval.quality ? `${v.run.eval.quality}/5${q[i]}` : '—'))]),
    tr(['Fidelidad', ...list.map((v) => (v.run.eval.fidelity ? `${v.run.eval.fidelity}/5` : '—'))]),
    tr(['Contexto inicial', ...ctxTok.map((x) => (x ? `${x.toLocaleString('es')} tok.` : '—'))]),
    tr(['Costo', ...mets.map((m, i) => `${money(m.cost)}${cost[i]}`)]),
    tr(['Tiempo', ...mets.map((m, i) => `${secs(m.ms)}${time[i]}`)]),
    tr(['Intentos', ...mets.map((m, i) => `${m.attempts}${att[i]}`)]),
    tr(['Herramientas usadas', ...mets.map((m) => `${m.searches} búsq. · ${m.images} img. · ${m.sounds} son. · ${m.videos} tomas`)]),
    tr(['Intervención', ...mets.map((m) => String(m.interventions + (m.manualMinutes ? ` + ${m.manualMinutes} min` : '')))]),
  );
  wrap.append(table);
  compare.append(wrap, el('p', 'muted small', 'Resaltadas: las perillas que cambian entre variantes. ● = mejor en esa métrica. Contexto inicial = tokens de entrada de la primera llamada, según el proveedor.'));

  const pref = el('div', 'options lab-pref');
  [...list.map((v) => [v.key, `Prefiero ${v.key}`]), ['tie', 'Empate']].forEach(([val, text]) => {
    const b = el('button', 'option', text);
    b.type = 'button';
    b.setAttribute('aria-pressed', String(exp.preference === val));
    b.disabled = !list.some((v) => v.run.hasCode);
    b.onclick = () => { exp.preference = exp.preference === val ? null : val; persist(); renderCompare(); };
    pref.append(b);
  });
  const notes = el('textarea');
  notes.rows = 2; notes.placeholder = 'Qué aprendiste de este experimento de contexto (qué perilla movió la aguja)'; notes.value = exp.notes || '';
  notes.oninput = () => { exp.notes = notes.value; persistSoon(); };
  compare.append(el('span', 'lab-field-label', '¿Qué variante preferís?'), pref, notes);
}

// ---------- Guardado ----------
function persist() {
  if (!exp) return;
  try { store.saveExperiment(exp); } catch (err) { error(err.message); }
}
let saveTimer = 0;
function persistSoon() { clearTimeout(saveTimer); saveTimer = setTimeout(persist, 400); }

// ---------- Historial ----------
const historyBox = $('ctx-history');
function renderHistory() {
  const list = store.listExperiments();
  historyBox.replaceChildren();
  const head = el('div', 'lab-history-head');
  head.append(el('h2', 'raw-section', 'Por modelo y herramientas'));
  const exportBtn = button('Exportar JSON', () => {
    const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), section: 'context-lab', experiments: list, stats: configStats(list) }, null, 2)], { type: 'application/json' });
    const a = el('a');
    a.href = URL.createObjectURL(blob);
    a.download = `laboratorio-context-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  exportBtn.disabled = !list.length;
  head.append(exportBtn);
  historyBox.append(head);
  if (!list.length) {
    historyBox.append(el('p', 'muted', 'Todavía no hay experimentos. Cuando ejecutes uno, acá vas a ver qué configuración de herramientas rinde mejor con cada modelo.'));
    return;
  }
  const stats = configStats(list);
  const wrap = el('div', 'lab-table-wrap');
  const table = el('table', 'lab-table lab-stats');
  const tr = (cells, tag = 'td') => { const r = el('tr'); cells.forEach((c) => r.append(el(tag, null, c))); return r; };
  const n1 = (x) => (x === null ? '—' : x.toFixed(1));
  table.append(tr(['Modelo', 'Herramientas', 'Ejecuciones', 'Aprobadas', 'Preferida', 'Calidad', 'Fidelidad', 'Costo medio', 'Costo por aprobada', 'Tiempo medio', 'Intentos', 'Prompt editado'], 'th'));
  stats.forEach((s) => table.append(tr([
    shortModel(s.model), s.signature, String(s.runs), `${s.approved} (${Math.round(s.approvalRate * 100)}%)`, String(s.wins),
    n1(s.avgQuality), n1(s.avgFidelity), money(s.avgCost), money(s.costPerApproved), secs(s.avgMs), n1(s.avgAttempts), `${s.edited} de ${s.runs}`,
  ])));
  wrap.append(table);
  historyBox.append(wrap, el('p', 'muted small', 'S = buscar referencias · I = imagen · A = sonido · V = video IA; opc = opcional, obl = obligatoria, — = apagada.'));

  historyBox.append(el('h2', 'raw-section', 'Experimentos'));
  const listBox = el('div', 'lab-history-list');
  list.forEach((ex) => {
    const c = el('article', 'lab-card lab-history-item');
    const topRow = el('div', 'lab-history-top');
    const title = el('div');
    title.append(el('strong', null, ex.name), el('div', 'muted small', `${new Date(ex.createdAt).toLocaleString('es')} · ${shortModel(ex.model)} · ${ex.video?.name || ''} · ${ex.zones?.length || 0} zona${ex.zones?.length === 1 ? '' : 's'}`));
    topRow.append(title, el('span', 'pill', experimentStatus(ex)));
    const vs = el('div', 'lab-vs');
    (ex.variants || []).forEach((v) => {
      const m = variantMetrics(v.run);
      const box = el('div', `lab-vs-side${ex.preference === v.key ? ' win' : ''}`);
      box.append(
        el('span', 'lab-badge', v.key),
        el('span', 'lab-vs-model', v.config?.label || v.config?.signature || ''),
        el('span', 'small', [v.config?.signature, v.run.eval?.approved === true ? '✓' : v.run.eval?.approved === false ? '✕' : '', v.run.eval?.quality ? `${v.run.eval.quality}★` : '', money(m.cost)].filter(Boolean).join(' · ')),
      );
      vs.append(box);
    });
    const acts = el('div', 'actions compact');
    acts.append(button('Abrir', () => openExperiment(ex.id)), button('Borrar', async () => {
      if (!confirm(`¿Borrar "${ex.name}" del historial? También se borran su video y su código guardados en este navegador.`)) return;
      await store.deleteExperiment(ex.id);
      if (exp?.id === ex.id) newBtn.onclick();
      renderHistory();
    }));
    c.append(topRow, vs);
    if (ex.notes) c.append(el('p', 'small', ex.notes));
    c.append(el('p', 'muted small', ex.harness || ''), acts);
    listBox.append(c);
  });
  historyBox.append(listBox);
}

// Reabre un experimento: video, zonas, pedido base, la configuración de cada variante, su código y sus evaluaciones.
// Las variantes del experimento pasan a ser las variantes de trabajo (para seguir iterando desde ahí).
async function openExperiment(id) {
  const ex = store.listExperiments().find((x) => x.id === id);
  if (!ex) return;
  if (busy()) return error('Esperá a que terminen las variantes (o detenelas) antes de abrir otro experimento.');
  error('');
  const [video, inputs] = await Promise.all([store.getBlob(`${id}:video`), store.getBlob(`${id}:inputs`)]);
  if (!video || !inputs) { error('El video o el material de este experimento ya no están en este navegador: solo quedan sus métricas en el historial.'); return; }
  setView('experiment');
  cards.forEach((c) => c.reset());
  cards.clear();
  await studio.setVideo(video);
  studio.setClips(inputs.payload.clips.map((c) => ({ ...c, refs: c.refs.map((r) => ({ ...r, thumb: r.frames[0] })) })));
  contextInput.value = inputs.base?.context || '';
  instructionsInput.value = inputs.base?.instructions || '';
  baseRefs = (inputs.base?.refs || []).map((r) => ({ key: ++seq, name: r.name, url: r.url, thumb: r.url, status: 'ready' }));
  renderBaseRefs();
  drafts = ex.variants.map((v) => {
    const snap = inputs.variants[v.key]?.cfg || defaultConfig(v.key);
    return { ...snap, id: v.slot, refs: (snap.refs || []).map((r) => ({ key: ++seq, name: r.name, url: r.url, thumb: r.url, status: 'ready' })) };
  });
  exp = ex;
  frozen = { ...inputs, file: video };
  nameInput.value = ex.name;
  modelInput.value = ex.model;
  showPrice();
  renderVariants();
  for (const v of ex.variants) {
    const card = cards.get(v.slot);
    if (v.run.status === 'running' || v.run.status === 'checking') { v.run.status = 'error'; v.run.error = 'se interrumpió (se cerró o recargó la página)'; }
    const saved = await store.getBlob(`${id}:code:${v.key}`);
    Object.assign(card, {
      code: saved?.code || '', js: saved?.js || '', turns: saved?.turns || [], assets: saved?.assets || [], found: saved?.found || [],
      sounds: saved?.sounds || [], videos: saved?.videos || [], runtimeFixes: MAX_RUNTIME_FIXES,
    });
    card.clearOut();
    unmount(card);
    card.render();
    if (card.js) mount(card);
  }
  persist();
  saveDrafts();
  renderCompare();
  refresh();
}

// ---------- Vistas y arranque ----------
function setView(view) {
  document.querySelectorAll('[data-ctx-view]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.ctxView === view)));
  root.hidden = view !== 'experiment';
  historyBox.hidden = view !== 'history';
  if (view === 'history') renderHistory();
}
document.querySelectorAll('[data-ctx-view]').forEach((b) => b.addEventListener('click', () => setView(b.dataset.ctxView)));

const fmtPrice = (x) => (x >= 1 ? x.toFixed(2).replace(/\.00$/, '') : x.toFixed(3).replace(/0+$/, ''));
function showPrice() {
  const m = info?.models?.find((x) => x.id === modelInput.value.trim());
  price.textContent = m?.prompt !== null && m?.prompt !== undefined ? `${m.name} · US$ ${fmtPrice(m.prompt)} entrada / ${fmtPrice(m.completion)} salida por millón de tokens` : '';
}

async function start() {
  started = true;
  try {
    info = await fetch('/api/lab/context/info').then((r) => r.json());
  } catch {
    error('No pude leer la configuración del Context Lab; revisá que el servidor esté corriendo.');
    info = null;
  }
  const p = store.prefs();
  modelInput.value = p.model || 'anthropic/claude-opus-5.5';
  contextInput.value = p.baseContext || '';
  instructionsInput.value = p.baseInstructions || '';
  modelList.replaceChildren(...(info?.models || []).map((m) => {
    const o = el('option');
    o.value = m.id;
    o.label = m.prompt !== null && m.prompt !== undefined ? `${m.name} · $${fmtPrice(m.prompt)}/$${fmtPrice(m.completion)} por M` : m.name;
    return o;
  }));
  studio.setLimits({ maxClipSeconds: info?.harness?.maxZoneSeconds || 11 });
  harnessPill.textContent = `Harness ${info?.harness?.version || ''}${info?.mock ? ' · demo' : ''}`;
  const t = info?.tools || {};
  harnessPill.title = `Remotion ${info?.harness?.remotion} · ${info?.harness?.fps} fps · zonas de hasta ${info?.harness?.maxZoneSeconds} s\nImagen: ${t.imageModel} · Sonido: ${t.sfxModel} · Video: ${(t.videoModels || []).map((m) => m.label).join(' / ')} a ${t.videoResolution}`;
  const missingTools = [];
  if (!t.search) missingTools.push('Buscar referencias está desactivado: agregá SERPAPI_API_KEY en .env.');
  if (!t.images) missingTools.push('Imagen, sonido y video están desactivados: agregá WAVESPEED_API_KEY en .env.');
  setupNote.hidden = !missingTools.length;
  setupNote.textContent = missingTools.length ? `${missingTools.join(' ')} Reiniciá el servidor para activarlos.` : '';
  // Las variantes de trabajo se recuerdan entre visitas (sus referencias propias, en IndexedDB).
  const saved = Array.isArray(p.drafts) && p.drafts.length >= 2 ? p.drafts : null;
  drafts = saved ? saved.map((d) => ({ ...defaultConfig(d.label), ...d, refs: [] })) : [
    { ...defaultConfig('Con herramientas') },
    { ...defaultConfig('Sin herramientas'), policy: { search: 'off', images: 'off', sound: 'off', video: 'off' } },
  ];
  await Promise.all(drafts.map(async (d) => {
    const refs = await store.getBlob(`draft:${d.id}:refs`);
    d.refs = (refs || []).map((r) => ({ key: ++seq, ...r, status: 'ready' }));
  }));
  baseRefs = ((await store.getBlob('draft:base:refs')) || []).map((r) => ({ key: ++seq, ...r, status: 'ready' }));
  renderBaseRefs();
  showPrice();
  renderVariants();
  saveDrafts();
}

// Soltar archivos en la carpeta: un video es el clip; las imágenes, referencias del pedido base.
const here = () => document.body.dataset.tab === 'lab-context';
window.addEventListener('dragover', (e) => { if (here()) e.preventDefault(); });
window.addEventListener('drop', (e) => {
  if (!here()) return;
  e.preventDefault();
  const files = [...(e.dataTransfer?.files || [])];
  const video = files.find((f) => f.type.startsWith('video/'));
  if (video && !busy()) { setView('experiment'); studio.setVideo(video); }
  const images = files.filter((f) => f.type.startsWith('image/'));
  if (images.length) addRefsTo(baseRefs, images, saveBaseRefs);
});

window.addEventListener('tab', ({ detail }) => {
  if (detail === 'lab-context' && !started) start();
  if (detail !== 'lab-context') cards.forEach((c) => c.frame?.contentWindow?.postMessage({ type: 'pause' }, '*'));
});
if (document.body.dataset.tab === 'lab-context' && !started) start();
