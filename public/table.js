import { $, el, streamEvents } from './shared.js';
import * as store from './table-store.js';
import { SEATS, MAX_ROUNDS, speakingOrder, drawStarter, nextStep, advance, parseReply, nextFileCode, totalCost, assetsCost, toProduction, describeAsset, assetKindLabel } from './table-core.js';
import { createScene } from './table-scene.js';
import { createDelivery } from './table-delivery.js';

// Laboratorio · Mesa de agentes. El navegador orquesta las rondas: cada turno es un POST a
// /api/lab/table/turn con el registro completo, así el usuario puede intervenir entre dos turnos cualquiera.
const MAX_FILES = 40;
const MAX_IMAGE_SIDE = 1280;
const MAX_TEXT = 60000;
const MAX_PDF = 12 * 1024 * 1024;
const TEXT_FILE = /\.(md|txt|csv|json|srt|vtt|ya?ml|xml|html?)$/i;

let started = false, scene = null, session = null, fileData = {}, controller = null, looping = false, pauseRequested = false, streaming = null, historyVisible = false;
let config = null, delivery = null; // config: lo que ofrece el servidor (GET /api/lab/table/config)
const seats = {}; // seat → { card, inputs, status, files, whisper }

const error = (text = '') => { $('table-error').textContent = text; $('table-error').hidden = !text; };
const money = (v) => `US$ ${(Number(v) || 0).toFixed(4)}`;
const agentOf = (seat) => session.agents.find((a) => a.seat === seat);
const labelOf = (seat) => `${seat} · ${agentOf(seat).name || `Agente ${seat}`}`;
const button = (text, action, cls = 'small-btn') => { const b = el('button', cls, text); b.type = 'button'; b.onclick = action; return b; };
const random = () => crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32;

function fresh(template) {
  return {
    id: crypto.randomUUID(), createdAt: Date.now(), name: '', goal: '', synthesisModel: template?.synthesisModel || '', maxRounds: MAX_ROUNDS, autoPause: template?.autoPause ?? true,
    aspect: template?.aspect || '9:16', budget: template?.budget ?? config?.defaultBudget ?? 1.5, tools: template?.tools ?? true, assets: [],
    agents: SEATS.map((seat) => { const a = template?.agents.find((x) => x.seat === seat); return { seat, name: a?.name || '', model: a?.model || '', mission: a?.mission || '', notes: a?.notes || '' }; }),
    files: [], log: [], order: null, cursor: { round: 1, turn: 0 }, status: 'setup', final: null, forceClose: false,
  };
}

function save() {
  try { session.updatedAt = Date.now(); store.saveSession(session); store.setCurrent(session.id); }
  catch (e) { error(`No se pudo guardar la mesa: ${e.message}`); }
}
// Guarda una sesión que puede no ser la abierta (un RUN que termina después de cambiar de mesa).
function persist(s) {
  try { s.updatedAt = Date.now(); store.saveSession(s); } catch (e) { error(`No se pudo guardar la mesa: ${e.message}`); }
}
// Mesas guardadas antes de que la mesa generara piezas.
function migrate(s) {
  s.assets ??= []; s.aspect ??= '9:16'; s.budget ??= config?.defaultBudget ?? 1.5; s.tools ??= true;
  return s;
}

// ---------- Archivos ----------
const asDataUrl = (blob) => new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = () => reject(r.error); r.readAsDataURL(blob); });

async function downscale(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale); canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas.toDataURL('image/jpeg', 0.85);
}

async function readFile(file) {
  const type = file.type || '';
  if (type.startsWith('image/')) {
    try { return { kind: 'image', data: await downscale(file) }; } catch { throw new Error(`${file.name}: no pude leer la imagen.`); }
  }
  if (type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
    if (file.size > MAX_PDF) throw new Error(`${file.name}: el PDF supera 12 MB.`);
    return { kind: 'pdf', data: (await asDataUrl(file)).replace(/^data:[^;]*;/, 'data:application/pdf;') };
  }
  if (type.startsWith('text/') || type === 'application/json' || TEXT_FILE.test(file.name)) {
    const text = await file.text();
    if (text.length > MAX_TEXT) error(`${file.name}: usé los primeros ${MAX_TEXT.toLocaleString('es')} caracteres.`);
    return { kind: 'text', data: text.slice(0, MAX_TEXT) };
  }
  throw new Error(`${file.name}: la mesa recibe imágenes, texto y PDF.`);
}

// Los archivos entran al registro en el momento: el próximo agente que hable ya los ve (si le corresponden).
async function addFiles(list, to) {
  if (!session || session.status === 'done') return;
  error('');
  const room = MAX_FILES - session.files.length;
  if (list.length > room) error(`Máximo ${MAX_FILES} archivos por mesa: dejé afuera ${list.length - Math.max(0, room)}.`);
  const codes = [];
  for (const file of list.slice(0, Math.max(0, room))) {
    try {
      const { kind, data } = await readFile(file);
      const code = nextFileCode(session.files, to);
      session.files.push({ code, name: file.name, kind, to, round: currentRound(), size: file.size });
      fileData[code] = data; codes.push(code);
    } catch (e) { error(e.message); }
  }
  if (!codes.length) return;
  session.log.push({ type: 'user', to, text: '', files: codes, round: currentRound(), at: Date.now() });
  try { await store.putFiles(session.id, fileData); } catch (e) { error(`No se pudieron guardar los archivos en este navegador: ${e.message}`); }
  save(); render();
}

function removeFile(code) {
  if (session.status !== 'setup') return;
  session.files = session.files.filter((f) => f.code !== code);
  delete fileData[code];
  session.log = session.log.filter((e) => !(e.type === 'user' && !e.text && e.files?.length === 1 && e.files[0] === code))
    .map((e) => (e.type === 'user' && e.files?.includes(code) ? { ...e, files: e.files.filter((c) => c !== code) } : e));
  store.putFiles(session.id, fileData).catch(() => {});
  save(); render();
}

// Antes de empezar los mensajes quedan en la "ronda 0"; durante la mesa, en la ronda en curso.
const currentRound = () => (session.status === 'setup' ? 0 : Math.min(session.cursor.round, session.maxRounds));

function say(to, text) {
  if (!text.trim() || !session || session.status === 'done') return false;
  session.log.push({ type: 'user', to, text: text.trim(), files: [], round: currentRound(), at: Date.now() });
  save(); render();
  return true;
}

// ---------- Turnos ----------
function payload(extra) {
  return {
    name: session.name, goal: session.goal, maxRounds: session.maxRounds, synthesisModel: session.synthesisModel,
    aspect: session.aspect, budget: session.budget, tools: session.tools,
    agents: session.agents.map(({ seat, name, model, mission, notes }) => ({ seat, name, model, mission, notes })),
    log: session.log,
    assets: session.assets.map(({ code, kind, seat, round, url, spec, cost, model }) => ({ code, kind, seat, round, url, spec, cost, model })),
    files: session.files.filter((f) => fileData[f.code]).map((f) => ({ ...f, data: fileData[f.code] })),
    ...extra,
  };
}

async function call(body) {
  let done = null, failure = null;
  controller = new AbortController();
  await streamEvents('/api/lab/table/turn', JSON.stringify(body), controller.signal, (ev) => {
    if (ev.type === 'delta') { streaming.text += ev.text; streaming.note = ''; updateLive(); }
    else if (ev.type === 'retry') { streaming.note = `El proveedor está ocupado: reintento ${ev.attempt} de ${ev.retries} en ${Math.round(ev.waitMs / 1000)} s…`; updateLive(); }
    else if (ev.type === 'tool') { streaming.note = `Generando ${assetKindLabel(ev.kind)}…`; updateLive(); }
    else if (ev.type === 'tool_error') { streaming.note = `No se pudo generar: ${ev.error}`; updateLive(); }
    else if (ev.type === 'notice') { streaming.note = ev.text; updateLive(); }
    else if (ev.type === 'asset') {
      // La pieza ya se pagó: queda en la mesa aunque el turno después falle.
      session.assets.push({ ...ev.asset, at: Date.now() });
      streaming.assets = [...(streaming.assets || []), ev.asset.code];
      streaming.note = `${ev.asset.code} sobre la mesa`;
      save(); render();
    }
    else if (ev.type === 'done') done = ev;
    else if (ev.type === 'error') failure = ev.error;
  });
  if (failure) throw new Error(failure);
  if (!done) throw new Error('La respuesta se cortó antes de terminar.');
  return done;
}

async function runTurn(step) {
  if (step.round !== session.announced) {
    session.log.push({ type: 'system', round: step.round, text: `Ronda ${step.round} de ${session.maxRounds}${step.last ? ' · última' : ''}` });
    session.announced = step.round;
  }
  streaming = { seat: step.seat, text: '', note: '' };
  render();
  const done = await call(payload({ kind: 'turn', seat: step.seat, round: step.round }));
  const reply = parseReply(done.text);
  const made = (done.assets || []).map((a) => a.code);
  if (made.length) reply.action = 'speak'; // generar es aportar, aunque no haya escrito nada
  session.log.push({ type: 'agent', round: step.round, seat: step.seat, ...reply, assets: made, model: done.model, usage: done.usage, ms: done.ms, at: Date.now() });
}

async function synthesize(reason) {
  session.status = 'synthesis';
  streaming = { seat: 'final', text: '', note: '' };
  render();
  const done = await call(payload({ kind: 'synthesis', reason }));
  session.final = { text: done.text, production: done.delivery ? toProduction(done.delivery) : null, error: done.error || null, model: done.model, usage: done.usage, ms: done.ms, reason, at: Date.now() };
  session.status = 'done';
}

async function loop() {
  if (looping) return;
  looping = true; error('');
  try {
    while (session.status === 'running') {
      const step = session.forceClose ? { kind: 'synthesis', reason: 'forced' } : nextStep(session);
      if (step.kind === 'done') { session.status = 'done'; break; }
      if (step.kind === 'synthesis') { await synthesize(step.reason); break; }
      await runTurn(step);
      const newRound = advance(session);
      streaming = null; save(); render();
      if (pauseRequested || (newRound && session.autoPause && !session.forceClose)) { session.status = 'paused'; pauseRequested = false; }
    }
  } catch (e) {
    const who = streaming?.seat === 'final' ? 'La entrega final' : streaming ? `El turno de ${labelOf(streaming.seat)}` : 'La mesa';
    if (session.status === 'synthesis') session.status = 'paused';
    if (session.status === 'running') session.status = 'paused';
    if (e.name === 'AbortError') error(`Cortaste ${who.charAt(0).toLowerCase()}${who.slice(1)}: al continuar vuelve a empezar.`);
    else error(`${who} falló: ${e.message}. Tocá Continuar para reintentar.`);
  } finally {
    streaming = null; controller = null; looping = false; pauseRequested = false;
    save(); render();
  }
}

function missingConfig() {
  const missing = [];
  if (!session.goal.trim()) missing.push('la misión final de la mesa');
  session.agents.forEach((a) => {
    if (!a.name.trim()) missing.push(`el nombre de ${a.seat}`);
    if (!a.model.trim()) missing.push(`el modelo de ${a.seat}`);
  });
  return missing;
}

function startTable() {
  const missing = missingConfig();
  if (missing.length) return error(`Falta ${missing.join(', ')}.`);
  const starter = drawStarter(random);
  session.order = speakingOrder(starter);
  session.log.push({ type: 'system', round: 1, text: `🎲 Sorteo: empieza ${labelOf(starter)}. Orden: ${session.order.join(' → ')}` });
  session.status = 'running'; session.startedAt = Date.now();
  save(); loop();
}

// ---------- Interfaz ----------
function filesRow(to) {
  const row = el('div', 'table-file-chips');
  session.files.filter((f) => f.to === to).forEach((f) => {
    const chip = el('figure', `table-file kind-${f.kind}`);
    if (f.kind === 'image' && fileData[f.code]) { const img = el('img'); img.src = fileData[f.code]; img.alt = f.name; chip.append(img); }
    else chip.append(el('span', 'table-file-icon', f.kind === 'pdf' ? 'PDF' : 'TXT'));
    chip.append(el('figcaption', 'small', `${f.code} · ${f.name}`));
    if (session.status === 'setup') { const x = button('×', () => removeFile(f.code)); x.setAttribute('aria-label', `Quitar ${f.code}`); chip.append(x); }
    if (!fileData[f.code]) chip.title = 'El contenido no está en este navegador: no se envía.';
    row.append(chip);
  });
  return row;
}

function buildSeat(seat) {
  const card = el('section', `lab-card table-seat seat-${seat.toLowerCase()}`);
  card.dataset.drop = seat; card.dataset.seat = seat; card.setAttribute('aria-label', `Asiento ${seat}`);
  const head = el('div', 'lab-side-head');
  const name = el('input', 'table-agent-name'); name.maxLength = 80; name.placeholder = `Nombre del agente ${seat}`; name.setAttribute('aria-label', `Nombre del agente ${seat}`);
  const status = el('span', 'table-seat-status small');
  head.append(el('span', 'lab-badge', seat), name, status);
  const modelLabel = el('label', 'lab-field small', 'Modelo (OpenRouter)');
  const model = el('input', 'lab-model'); model.setAttribute('list', 'table-llms'); model.placeholder = 'Ej. anthropic/claude-sonnet-5.5'; model.autocomplete = 'off';
  modelLabel.append(model);
  const all = seat === 'A' ? button('Usar este modelo en los 4', () => { session.agents.forEach((a) => { a.model = model.value.trim(); }); fillForm(); save(); }) : null;
  const missionLabel = el('label', 'lab-field small', 'Misión / rol');
  const mission = el('textarea'); mission.rows = 3; mission.maxLength = 4000; mission.placeholder = 'Ej. Directora de fotografía: cuida la luz, los planos y que cada toma se pueda generar.';
  missionLabel.append(mission);
  const notesLabel = el('label', 'lab-field small', 'Lo que quieras sumarle (tono, límites, conocimiento…)');
  const notes = el('textarea'); notes.rows = 2; notes.maxLength = 4000;
  notesLabel.append(notes);
  const files = el('div', 'table-files');
  const whisper = el('form', 'table-say');
  const text = el('textarea'); text.rows = 1; text.maxLength = 20000; text.setAttribute('aria-label', `Mensaje privado para ${seat}`);
  const fileLabel = el('label', 'small-btn cinematic-file', '+ Archivo');
  const file = el('input'); file.type = 'file'; file.multiple = true; file.hidden = true; file.accept = $('table-file').accept;
  file.onchange = () => { addFiles([...file.files], seat); file.value = ''; };
  fileLabel.append(file);
  const send = el('button', 'small-btn', 'Decírselo solo a este'); send.type = 'submit';
  const actions = el('div', 'actions compact'); actions.append(fileLabel, send);
  whisper.append(text, actions);
  whisper.onsubmit = (e) => { e.preventDefault(); if (say(seat, text.value)) text.value = ''; };
  text.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && matchMedia('(pointer: fine)').matches) { e.preventDefault(); whisper.requestSubmit(); } });
  const bind = (input, key) => input.addEventListener('input', () => { if (session.status !== 'setup') return; agentOf(seat)[key] = input.value; save(); updateHeader(); });
  bind(name, 'name'); bind(model, 'model'); bind(mission, 'mission'); bind(notes, 'notes');
  card.append(head, modelLabel, ...(all ? [all] : []), missionLabel, notesLabel, files, whisper);
  seats[seat] = { card, name, model, mission, notes, all, status, files, whisper, text };
  return card;
}

// Valores de los campos: solo al abrir una mesa (no en cada render, para no mover el cursor).
function fillForm() {
  $('table-name').value = session.name; $('table-goal').value = session.goal; $('table-synthesis-model').value = session.synthesisModel; $('table-autopause').checked = session.autoPause;
  $('table-aspect').value = session.aspect; $('table-budget').value = session.budget; $('table-tools').checked = session.tools;
  for (const a of session.agents) { const s = seats[a.seat]; s.name.value = a.name; s.model.value = a.model; s.mission.value = a.mission; s.notes.value = a.notes; }
  render();
}

function lastOf(seat) { return [...session.log].reverse().find((e) => e.type === 'agent' && e.seat === seat); }

function renderMediaNote() {
  const note = $('table-media-note');
  if (!config) { note.textContent = ''; return; }
  const c = config.costs;
  const video = config.video?.engines?.filter((e) => e.ok).map((e) => e.label.split(' · ')[0]).join(' o ');
  note.textContent = !config.media
    ? 'Sin WAVESPEED_API_KEY: los agentes no generan y las partes no se pueden correr. La entrega igual sale por tomas.'
    : `${config.mock ? 'Demo: piezas simuladas. ' : ''}Imagen ≈ US$ ${c.image.toFixed(2)} · voz ≈ US$ ${c.voicePer1k.toFixed(2)} cada 1000 caracteres · sonido ≈ US$ ${c.sound.toFixed(2)} (estimados). Máximo ${config.limits.perTurn} por turno. El video no se genera en la mesa: lo aprobás al final${video ? ` (${video}, 480p, hasta ${config.limits.shotMax} s)` : ''}.`;
}

function updateHeader() {
  for (const seat of SEATS) {
    const s = seats[seat];
    s.text.placeholder = `Decile algo solo a ${agentOf(seat).name || `el agente ${seat}`} (los demás no lo ven)…`;
    s.whisper.querySelector('button[type="submit"]').textContent = `Decírselo solo a ${agentOf(seat).name || seat}`;
  }
}

function seatState(seat) {
  if (streaming?.seat === seat) return ['speaking', streaming.note || 'Hablando…'];
  const last = lastOf(seat);
  if (!session.order) return ['idle', ''];
  const pos = session.order.indexOf(seat) + 1;
  if (!last) return ['idle', `Habla ${pos}º`];
  if (last.done) return ['done', `Listo ✓ · ronda ${last.round}`];
  if (last.action === 'pass') return ['pass', `Pasó · ronda ${last.round}`];
  return ['spoke', `Habló · ronda ${last.round}`];
}

function renderSeats() {
  const locked = session.status !== 'setup';
  const closed = session.status === 'done';
  for (const seat of SEATS) {
    const s = seats[seat];
    [s.name, s.model, s.mission, s.notes].forEach((n) => { n.disabled = locked; });
    if (s.all) s.all.hidden = locked;
    s.whisper.querySelectorAll('textarea, button, input').forEach((n) => { n.disabled = closed; });
    const [state, text] = seatState(seat);
    s.card.dataset.state = state; s.status.textContent = text;
    s.files.replaceChildren(filesRow(seat));
  }
  updateHeader();
}

function renderProgress() {
  const box = $('table-progress');
  box.replaceChildren();
  if (session.status === 'setup') { box.append(el('p', 'muted small', `${session.maxRounds} rondas · empieza un agente al azar y siguen en sentido horario (A → B → C → D).`)); return; }
  const dots = el('div', 'table-rounds');
  const round = Math.min(session.cursor.round, session.maxRounds);
  const used = Math.max(0, ...session.log.filter((e) => e.type === 'agent').map((e) => e.round));
  for (let r = 1; r <= session.maxRounds; r++) {
    const d = el('span', 'table-round'); d.title = `Ronda ${r}`;
    if (session.status === 'done' ? r <= used : r < session.cursor.round) d.dataset.state = 'done';
    else if (r === round && session.status !== 'done') d.dataset.state = 'current';
    dots.append(d);
  }
  const step = session.status === 'done' ? null : nextStep(session);
  let text;
  if (session.status === 'done') text = `Mesa cerrada · ${used} de ${session.maxRounds} rondas · ${session.log.filter((e) => e.type === 'agent').length} turnos`;
  else if (session.status === 'synthesis') text = 'El relator está redactando la entrega final…';
  else if (streaming) text = `Ronda ${round} de ${session.maxRounds} · habla ${labelOf(streaming.seat)}`;
  else if (session.forceClose || step?.kind === 'synthesis') {
    text = step?.reason === 'consensus' && !session.forceClose ? 'La mesa está de acuerdo: al continuar se redacta la entrega. Si sumás algo, siguen conversando.' : 'Al continuar se redacta la entrega final.';
  } else text = `Ronda ${step.round} de ${session.maxRounds} · sigue ${labelOf(step.seat)}${session.status === 'paused' ? ' · en pausa' : ''}`;
  box.append(dots, el('p', 'small', text));
}

function renderControls() {
  const st = session.status;
  $('table-start').hidden = st !== 'setup';
  $('table-pause').hidden = !['running', 'synthesis'].includes(st);
  $('table-pause').textContent = st === 'synthesis' ? 'Cortar' : pauseRequested ? 'Cortar ya' : 'Pausar';
  $('table-pause').title = pauseRequested ? 'Corta el turno en curso (se pierde lo que lleva escrito)' : 'Pausa al terminar el turno en curso';
  $('table-continue').hidden = st !== 'paused';
  $('table-close').hidden = !['running', 'paused'].includes(st) || session.forceClose;
  ['table-name', 'table-goal', 'table-synthesis-model', 'table-aspect'].forEach((id) => { $(id).disabled = st !== 'setup'; });
  ['table-budget', 'table-tools'].forEach((id) => { $(id).disabled = st === 'done' || !config?.media; });
  renderMediaNote();
  $('table-say').querySelectorAll('textarea, button, input').forEach((n) => { n.disabled = st === 'done'; });
  $('table-files-table').replaceChildren(filesRow('table'));
  const status = { setup: 'Mesa lista para empezar', running: 'Los agentes están conversando…', paused: 'En pausa', synthesis: 'Escribiendo la entrega…', done: 'Entrega lista' };
  $('table-status').dataset.phase = st;
  $('table-status-text').textContent = st === 'running' && pauseRequested ? 'Pausa al terminar el turno…' : status[st];
  const cost = totalCost(session);
  const generated = assetsCost(session);
  $('table-cost').textContent = session.log.some((e) => e.type === 'agent') ? `Costo total: ${money(cost)}${session.assets.length ? ` · generado en la mesa: ${money(generated)} de ${money(session.budget)}` : ''}` : '';
}

function entryNode(e) {
  if (e.type === 'system') return el('p', 'table-system muted small', e.text);
  const node = el('article', 'table-entry');
  const head = el('div', 'table-entry-head small');
  if (e.type === 'user') {
    node.classList.add('user');
    head.append(el('strong', null, e.to === 'table' ? 'Vos → toda la mesa' : `Vos → ${labelOf(e.to)} (privado)`), el('span', 'muted', e.round ? `ronda ${e.round}` : 'antes de empezar'));
    node.append(head);
    if (e.text) node.append(el('p', null, e.text));
    if (e.files?.length) node.append(el('p', 'muted small', `Compartió ${e.files.join(', ')}`));
    return node;
  }
  node.classList.add(`seat-${e.seat.toLowerCase()}`);
  node.dataset.seat = e.seat;
  if (e.action === 'pass') node.classList.add('pass');
  head.append(el('span', 'lab-badge', e.seat), el('strong', null, agentOf(e.seat).name), el('span', 'muted', `ronda ${e.round}`));
  if (e.action === 'pass') head.append(el('span', 'table-tag', 'pasó'));
  if (e.done) head.append(el('span', 'table-tag done', 'listo ✓'));
  head.append(el('span', 'muted table-entry-meta', [e.model, e.usage?.cost !== undefined ? money(e.usage.cost) : null, e.ms ? `${(e.ms / 1000).toFixed(1)} s` : null].filter(Boolean).join(' · ')));
  node.append(head);
  if (e.text) node.append(el('p', null, e.text));
  if (e.assets?.length) node.append(assetsRow(e.assets));
  return node;
}

// Las piezas generadas (G1, G2…): miniatura o reproductor, con su código. Tocar una imagen la abre.
function assetsRow(codes) {
  const row = el('div', 'table-assets');
  for (const code of codes) {
    const a = session.assets.find((x) => x.code === code);
    if (!a) continue;
    const fig = el('figure', `table-asset kind-${a.kind}`);
    fig.title = describeAsset(a, session.agents);
    if (a.kind === 'image') {
      const img = el('img'); img.src = a.url; img.alt = a.spec.prompt; img.loading = 'lazy';
      img.onclick = () => preview(`g:${a.code}`);
      fig.append(img);
    } else {
      const audio = el('audio'); audio.src = a.url; audio.controls = true; audio.preload = 'none';
      fig.append(el('span', 'small', a.kind === 'voice' ? `${a.spec.personaje} · ${a.spec.voz}` : `${a.spec.tipo} · ${a.spec.duracion} s`), audio);
    }
    fig.append(el('figcaption', 'small', `${a.code} · ${assetKindLabel(a.kind)}${a.demo ? ' (demo)' : ''}`));
    row.append(fig);
  }
  return row;
}

let liveNode = null;
function renderLog() {
  const box = $('table-log');
  const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  box.replaceChildren(...session.log.map(entryNode));
  liveNode = null;
  if (streaming && streaming.seat !== 'final') {
    liveNode = entryNode({ type: 'agent', seat: streaming.seat, round: Math.min(session.cursor.round, session.maxRounds), action: 'speak', text: streaming.text || streaming.note || '…', assets: streaming.assets });
    liveNode.classList.add('live');
    box.append(liveNode);
  }
  if (!session.log.length && !streaming) box.append(el('p', 'muted small', 'Todavía no habló nadie. Configurá los asientos y la misión final, y tocá "Sentarse y empezar".'));
  if (stick) box.scrollTop = box.scrollHeight;
}

function renderFinal() {
  const box = $('table-final');
  const live = streaming?.seat === 'final';
  box.hidden = !session.final && !live;
  if (box.hidden) { box.replaceChildren(); return; }
  if (live) {
    box.replaceChildren(el('div', 'lab-side-head', 'Entrega de producción'), el('p', 'table-final-text', finalProgress()));
    return;
  }
  const f = session.final;
  if (f.production) return delivery.mount(box);
  const head = el('div', 'lab-side-head');
  head.append(el('strong', null, 'Entrega'), el('span', 'muted small', `Relator: ${f.model} · ${money(f.usage?.cost)}`));
  const actions = el('div', 'actions compact');
  actions.append(button('Volver a pedir la entrega', () => {
    if (busy()) return;
    session.final = null; session.forceClose = true; session.status = 'running'; save(); loop();
  }, 'primary'), button('Copiar texto', () => navigator.clipboard?.writeText(f.text)), button('Descargar mesa (.md)', () => download()));
  // Mesas cerradas antes de la entrega por tomas: su entrega era un texto; se puede pedir la nueva con la misma conversación.
  const why = !('production' in f) ? 'Esta mesa se cerró con la entrega en texto (antes de la entrega por tomas). Podés pedirla de nuevo, por tomas, con la misma conversación.'
    : `El relator no devolvió una entrega por tomas${f.error ? ` (${f.error})` : ''}. Su texto quedó abajo.`;
  box.replaceChildren(head, el('p', !('production' in f) ? 'muted' : 'error', why), actions, el('div', 'table-final-text', f.text));
}

// Mientras el relator escribe JSON, se cuenta lo que lleva en vez de mostrar el código.
function finalProgress() {
  if (streaming.note && !streaming.text) return streaming.note;
  const shots = (streaming.text.match(/"id"\s*:\s*"S\d+"/g) || []).length;
  return streaming.text ? `Armando la entrega por tomas… ${shots ? `${shots} toma${shots > 1 ? 's' : ''}` : 'leyendo toda la mesa'} (${streaming.text.length.toLocaleString('es')} caracteres)` : 'Leyendo toda la mesa…';
}

function updateLive() {
  if (!streaming) return;
  if (streaming.seat === 'final') { scene?.live({ ...streaming, text: finalProgress() }); const t = $('table-final').querySelector('.table-final-text'); if (t) t.textContent = finalProgress(); return; }
  scene?.live(streaming);
  seats[streaming.seat].status.textContent = streaming.note || 'Hablando…';
  if (liveNode) {
    const p = liveNode.querySelector('p') || liveNode.appendChild(el('p'));
    p.textContent = streaming.text || streaming.note || '…';
    const box = $('table-log');
    if (box.scrollHeight - box.scrollTop - box.clientHeight < 120) box.scrollTop = box.scrollHeight;
  }
}

function render() {
  if (!session) return;
  renderSeats(); renderProgress(); renderControls(); renderLog(); renderFinal();
  scene?.render({ session, streaming, fileData, last: lastOf });
}

function download(production = null) {
  const lines = [`# ${session.name || 'Mesa de agentes'}`, '', `**Misión final:** ${session.goal}`, '', '## Agentes', ''];
  session.agents.forEach((a) => lines.push(`- **${a.seat} · ${a.name}** (${a.model})${a.mission ? `: ${a.mission}` : ''}`));
  lines.push('', '## Conversación', '');
  session.log.forEach((e) => {
    if (e.type === 'system') lines.push(`*${e.text}*`, '');
    else if (e.type === 'user') lines.push(`**Vos → ${e.to === 'table' ? 'mesa' : `${labelOf(e.to)} (privado)`}:** ${e.text}${e.files?.length ? ` _(compartió ${e.files.join(', ')})_` : ''}`, '');
    else lines.push(`**${labelOf(e.seat)} · ronda ${e.round}${e.action === 'pass' ? ' · pasó' : ''}${e.done ? ' · listo' : ''}:** ${e.text}${e.assets?.length ? ` _(generó ${e.assets.join(', ')})_` : ''}`, '');
  });
  if (session.assets.length) lines.push('## Generado en la mesa', '', ...session.assets.map((a) => `- ${describeAsset(a, session.agents)} — ${new URL(a.url, location.href).href}`), '');
  if (production) lines.push('## Entrega de producción', '', production);
  else if (session.final) lines.push('## Entrega final', '', session.final.text, '');
  const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/markdown' }));
  const a = el('a'); a.href = url; a.download = `${(session.name || 'mesa-de-agentes').replace(/[^\w\-áéíóúñ ]+/gi, '').trim().replace(/\s+/g, '-') || 'mesa'}.md`; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------- La sala: lo que pasa al tocar cada objeto ----------
const flash = (node) => { node.classList.remove('flash'); void node.offsetWidth; node.classList.add('flash'); };

// Lámpara o cartel: el asiento de ese agente (para configurarlo antes, o para hablarle en privado después).
function focusSeat(seat) {
  const s = seats[seat];
  s.card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  flash(s.card);
  const target = session.status === 'setup' ? (s.name.value.trim() ? s.mission : s.name) : session.status !== 'done' ? s.text : null;
  target?.focus({ preventScroll: true });
}

// Nube o pila de aportes: lo último que dijo ese agente, en la conversación.
function showLast(seat) {
  const node = streaming?.seat === seat ? liveNode : [...$('table-log').querySelectorAll(`.table-entry[data-seat="${seat}"]`)].at(-1);
  if (!node) return focusSeat(seat);
  node.scrollIntoView({ behavior: 'smooth', block: 'center' });
  flash(node);
}

// Hoja del centro: la misión (se edita antes de empezar) o, al final, la entrega.
function showMission() {
  const target = session.final || streaming?.seat === 'final' ? $('table-final') : $('table-center');
  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  flash(target);
  if (session.status === 'setup') $('table-goal').focus({ preventScroll: true });
}

function openTable() {
  if (session.status === 'done') return showMission();
  $('table-file').click();
}

// Papeles sobre la mesa: un archivo (f:M1) o un mensaje tuyo (n:índice del registro).
async function preview(key) {
  const box = $('table-preview');
  const [type, id] = typeof key === 'string' ? [key.slice(0, 1), key.slice(2)] : ['o', null];
  const audience = (to) => (to === 'table' ? 'Lo ven los cuatro' : `Solo lo ve ${labelOf(to)}`);
  const head = el('div', 'lab-side-head');
  const body = el('div', 'table-preview-body');
  const actions = el('div', 'actions compact');
  let url = null;
  if (typeof key === 'object') {
    head.append(el('strong', null, key.title));
    const img = el('img'); img.src = key.url; img.alt = key.title; body.append(img);
  } else if (type === 'g') {
    const a = session.assets.find((x) => x.code === id);
    if (!a) return;
    head.append(el('strong', null, `${a.code} · ${assetKindLabel(a.kind)} de ${labelOf(a.seat)}`), el('span', 'muted small', `Ronda ${a.round} · ${a.model}${a.cost ? ` · ${money(a.cost)}` : ''} · lo ven los cuatro`));
    if (a.kind === 'image') { const img = el('img'); img.src = a.url; img.alt = a.spec.prompt; body.append(img); }
    else { const audio = el('audio'); audio.src = a.url; audio.controls = true; body.append(audio); }
    body.append(el('p', 'table-preview-text', describeAsset(a, session.agents).replace(/^G\d+ · /, '')));
  } else if (type === 'n') {
    const entry = session.log[Number(id)];
    if (!entry) return;
    head.append(el('strong', null, entry.to === 'table' ? 'Tu mensaje a la mesa' : 'Tu mensaje privado'), el('span', 'muted small', `${audience(entry.to)} · ${entry.round ? `ronda ${entry.round}` : 'antes de empezar'}`));
    body.append(el('p', 'table-preview-text', entry.text));
  } else {
    const file = session.files.find((f) => f.code === id);
    if (!file) return;
    head.append(el('strong', null, `${file.code} · ${file.name}`), el('span', 'muted small', audience(file.to)));
    const data = fileData[file.code];
    if (!data) body.append(el('p', 'muted', 'El contenido no está en este navegador: no se envía a los agentes.'));
    else if (file.kind === 'image') { const img = el('img'); img.src = data; img.alt = file.name; body.append(img); }
    else if (file.kind === 'pdf') { url = URL.createObjectURL(await (await fetch(data)).blob()); const frame = el('iframe'); frame.src = url; frame.title = file.name; body.append(frame); }
    else body.append(el('pre', 'table-preview-text', data));
    if (session.status === 'setup') actions.append(button('Sacar de la mesa', () => { box.close(); removeFile(file.code); }));
  }
  head.querySelector('strong').id = 'table-preview-title';
  actions.append(button('Cerrar', () => box.close()));
  box.replaceChildren(head, body, actions);
  box.onclose = () => { if (url) URL.revokeObjectURL(url); };
  box.onclick = (e) => { if (e.target === box) box.close(); };
  box.showModal();
}

// ---------- Historial ----------
function renderHistory() {
  const box = $('table-history');
  const list = store.listSessions();
  const labels = { setup: 'Sin empezar', running: 'En pausa', paused: 'En pausa', synthesis: 'En pausa', done: 'Cerrada' };
  if (!list.length) { box.replaceChildren(el('p', 'muted', 'Todavía no hay mesas guardadas en este navegador.')); return; }
  box.replaceChildren(...list.map((s) => {
    const card = el('article', 'lab-card');
    const rounds = Math.max(0, ...s.log.filter((e) => e.type === 'agent').map((e) => e.round));
    card.append(el('strong', null, s.name || s.goal.slice(0, 80) || 'Mesa sin nombre'),
      el('p', 'muted small', `${new Date(s.updatedAt || s.createdAt).toLocaleString('es')} · ${labels[s.status] || s.status} · ${rounds} de ${s.maxRounds} rondas · ${money(totalCost(s))}`),
      el('p', 'small', s.agents.map((a) => `${a.seat} · ${a.name || '—'}`).join('   ')));
    const actions = el('div', 'actions compact');
    actions.append(button('Abrir', () => { if (!busy()) open(s.id); toggleHistory(false); }),
      button('Usar sus agentes en una mesa nueva', () => { if (busy()) return; newTable(s); toggleHistory(false); }),
      button('Borrar', async () => { if (busy() && s.id === session.id) return; if (!confirm('¿Borrar esta mesa?')) return; await store.deleteSession(s.id); if (s.id === session.id) newTable(session); renderHistory(); }));
    card.append(actions);
    return card;
  }));
}

function toggleHistory(show) {
  historyVisible = show;
  $('table-history').hidden = !show; $('table-main').hidden = show;
  $('table-history-toggle').setAttribute('aria-pressed', String(show));
  if (show) renderHistory();
}

const busy = () => looping;

async function open(id) {
  const s = store.getSession(id);
  if (!s) return newTable();
  // Un turno que estaba en curso al cerrar la página queda en pausa: al continuar se repite.
  if (['running', 'synthesis'].includes(s.status)) s.status = 'paused';
  delivery?.stop();
  session = migrate(s); fileData = {};
  store.setCurrent(id);
  fillForm();
  try { fileData = await store.getFiles(id); } catch (e) { error(`No pude leer los archivos guardados: ${e.message}`); }
  render();
}

function newTable(template = session) {
  if (busy()) return;
  delivery?.stop();
  session = fresh(template); fileData = {}; error('');
  save(); fillForm();
}

// ---------- Eventos ----------
function start() {
  if (started) return;
  started = true;
  const board = $('table-board');
  SEATS.forEach((seat) => board.append(buildSeat(seat)));
  scene = createScene($('table-scene'), { seat: focusSeat, cloud: showLast, mission: showMission, table: openTable, paper: preview });
  delivery = createDelivery({
    session: () => session, persist: (s) => { persist(s); if (s === session) store.setCurrent(s.id); }, refreshCost: () => renderControls(), error,
    agentOf, labelOf, payload, fileData: () => fileData, config: () => config, preview, download: (md) => download(md),
  });
  fetch('/api/lab/table/config').then((r) => r.json()).then((d) => { config = d; if (session) { fillForm(); } }).catch(() => { config = { media: false, video: { available: false, engines: [] } }; if (session) render(); });
  fetch('/api/lab/models').then((r) => r.json()).then((d) => {
    $('table-llms').replaceChildren(...(d.models || []).map((m) => { const o = el('option'); o.value = m.id; o.label = m.prompt || m.completion ? `${m.name} · US$ ${m.prompt.toFixed(2)} / ${m.completion.toFixed(2)} por 1M` : m.name; return o; }));
  }).catch(() => {});
  const id = store.currentId();
  if (id && store.getSession(id)) open(id); else newTable(null);
}

$('table-name').addEventListener('input', (e) => { session.name = e.target.value; save(); });
$('table-goal').addEventListener('input', (e) => { session.goal = e.target.value; save(); });
$('table-synthesis-model').addEventListener('input', (e) => { session.synthesisModel = e.target.value.trim(); save(); });
$('table-autopause').addEventListener('change', (e) => { session.autoPause = e.target.checked; save(); });
$('table-aspect').addEventListener('change', (e) => { session.aspect = e.target.value; save(); });
$('table-budget').addEventListener('input', (e) => { const v = Number(e.target.value); if (Number.isFinite(v) && v >= 0 && v <= 50) { session.budget = v; save(); renderControls(); } });
$('table-tools').addEventListener('change', (e) => { session.tools = e.target.checked; save(); });
$('table-start').onclick = startTable;
$('table-continue').onclick = () => { if (session.status !== 'paused') return; session.status = 'running'; save(); loop(); };
$('table-pause').onclick = () => {
  if (session.status === 'synthesis' || pauseRequested) { controller?.abort(); return; }
  pauseRequested = true; renderControls();
};
$('table-close').onclick = () => {
  if (!confirm('¿Cerrar la mesa y pedir la entrega final con lo que hay?')) return;
  session.forceClose = true; save();
  if (session.status === 'paused') { session.status = 'running'; loop(); } else render();
};
$('table-new').onclick = () => { if (busy()) return error('Pausá la mesa antes de empezar otra.'); newTable(); toggleHistory(false); };
$('table-history-toggle').onclick = () => toggleHistory(!historyVisible);
$('table-say').onsubmit = (e) => { e.preventDefault(); if (say('table', $('table-say-text').value)) $('table-say-text').value = ''; };
$('table-say-text').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && matchMedia('(pointer: fine)').matches) { e.preventDefault(); $('table-say').requestSubmit(); } });
$('table-file').onchange = (e) => { addFiles([...e.target.files], 'table'); e.target.value = ''; };

// Soltar en un asiento = privado para ese agente; en cualquier otra parte = para toda la mesa.
const dropTarget = (e) => e.target.closest?.('[data-drop]')?.dataset.drop || 'table';
window.addEventListener('dragover', (e) => {
  if (document.body.dataset.tab !== 'table') return;
  e.preventDefault();
  const to = dropTarget(e);
  document.querySelectorAll('#lab-table-folder [data-drop]').forEach((n) => n.classList.toggle('drop-over', n.dataset.drop === to));
  if (session && !historyVisible) scene?.drag(to, Object.fromEntries(session.agents.map((a) => [a.seat, a.name])));
});
const endDrag = () => { document.querySelectorAll('#lab-table-folder .drop-over').forEach((n) => n.classList.remove('drop-over')); scene?.drag(null); };
window.addEventListener('dragleave', (e) => { if (!e.relatedTarget) endDrag(); });
window.addEventListener('drop', (e) => {
  if (document.body.dataset.tab !== 'table') return;
  e.preventDefault();
  endDrag();
  if (!session || historyVisible) return;
  const to = dropTarget(e);
  const files = [...(e.dataTransfer?.files || [])];
  if (files.length) return addFiles(files, to);
  // Texto suelto: va a la caja de mensaje de ese destino, para revisarlo antes de mandarlo.
  const text = e.dataTransfer?.getData('text/plain');
  if (text) { const box = to === 'table' ? $('table-say-text') : seats[to].text; box.value = `${box.value}${box.value ? '\n' : ''}${text}`; box.focus(); }
});

window.addEventListener('tab', ({ detail }) => { if (detail === 'table') start(); });
if (document.body.dataset.tab === 'table' || /^#\/?laboratorio\/mesa-de-agentes/.test(location.hash)) start();
