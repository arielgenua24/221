import { $, el, streamEvents } from './shared.js';

// Raw: la pestaña principal. Carpetas (proyectos) con subcarpetas; adentro, una conversación POR VOZ con el agente:
// la persona habla (reconocimiento de voz del navegador), el agente razona, contesta con voz (TTS) y genera imágenes.
// Las personas y referencias quedan guardadas en el proyecto y el agente las categoriza.

const ASPECTS = ['1:1', '3:4', '4:3', '9:16', '16:9'];
const TRIES = ['Golden hour photo', 'Hazme a esta persona estilo PES 13', 'Retrato con luz de estadio', 'Póster minimalista con esta paleta'];
const MAX_SIDE = 2048;
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* sin almacenamiento: no pasa nada */ } },
};

let cfg = { mock: false, raw: { voice: false, images: false, greeting: 'Hola, dime qué quieres trabajar hoy.' } };
let folders = [];
let current = null; // { id, lineage, assets, history, children }
let micOn = store.get('raw-mic', '1') === '1';
let aspect = ASPECTS.includes(store.get('raw-aspect')) ? store.get('raw-aspect') : '1:1';
let thinking = false;
let selected = new Set(); // imágenes que la persona tocó: viajan con el próximo mensaje
const streams = new Set();

fetch('/api/config').then((r) => r.json()).then((c) => { cfg = { ...cfg, ...c, raw: { ...cfg.raw, ...(c.raw || {}) } }; }).catch(() => {});

function showError(msg) { const e = $('raw-error'); e.textContent = msg || ''; e.hidden = !msg; }
async function api(url, body) {
  const res = await fetch(url, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}
const fileUrl = (a) => `/raw-files/${a.file}`;

// ---------- Pestañas ----------
function setTab(tab) {
  document.body.dataset.tab = tab;
  document.querySelectorAll('.tab').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
  $('view-raw').hidden = tab !== 'raw';
  $('view-studio').hidden = tab !== 'studio';
  if (tab !== 'raw') { stopListening(); stopSpeaking(); } else if (current) resumeListening();
}
document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => {
  setTab(b.dataset.tab);
  if (b.dataset.tab === 'studio') history.replaceState(null, '', '#estudio');
  else history.replaceState(null, '', current ? `#raw/${current.id}` : '#raw');
}));

// ---------- Carpetas ----------
async function loadFolders() {
  folders = (await api('/api/raw/folders')).folders;
  renderHome();
}

function renderHome() {
  const box = $('raw-folders');
  box.replaceChildren();
  const roots = folders.filter((f) => !f.parentId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (!roots.length) box.append(el('p', 'muted raw-empty', 'Todavía no hay proyectos. Creá el primero arriba.'));
  roots.forEach((f) => {
    const b = el('button', 'raw-folder');
    b.type = 'button';
    b.append(el('span', 'raw-folder-icon', '📁'), el('strong', null, f.name),
      el('span', 'muted small', [`${f.assets} imágenes`, f.children && `${f.children} subcarpeta${f.children > 1 ? 's' : ''}`].filter(Boolean).join(' · ')));
    b.onclick = () => openFolder(f.id, { greet: true });
    box.append(b);
  });
}

$('raw-new-folder').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('raw-new-name').value.trim();
  if (!name) return $('raw-new-name').focus();
  try {
    const { folder } = await api('/api/raw/folders', { name });
    $('raw-new-name').value = '';
    await loadFolders();
    openFolder(folder.id, { greet: true });
  } catch (err) { alert(err.message); }
});

async function openFolder(id, { greet = false } = {}) {
  unlockAudio();
  stopListening(); stopSpeaking();
  showError('');
  let data;
  try { data = await api(`/api/raw/folder?id=${encodeURIComponent(id)}`); } catch (err) {
    current = null; showHome(); return showError(err.message);
  }
  current = { id, ...data };
  selected = new Set();
  history.replaceState(null, '', `#raw/${id}`);
  $('raw-home').hidden = true;
  $('raw-work').hidden = false;
  $('raw-choice').hidden = true;
  $('raw-log').replaceChildren();
  current.history.slice(-12).forEach((h) => logLine(h.role === 'user' ? 'user' : 'agent', h.role === 'user' ? h.text : (/^Dije: "([\s\S]*?)"(?=\s\[|$)/.exec(h.text)?.[1] || h.text)));
  renderWork();
  if (greet) say(cfg.raw.greeting);
  else resumeListening();
}

function showHome() {
  stopListening(); stopSpeaking();
  current = null;
  $('raw-work').hidden = true;
  $('raw-home').hidden = false;
  history.replaceState(null, '', '#raw');
  setPhase('idle');
  loadFolders().catch((err) => showError(err.message));
}

// X: sube un nivel (de una subcarpeta a su carpeta; de una carpeta, a la lista).
$('raw-close').addEventListener('click', () => {
  const parent = current?.lineage.at(-2);
  if (parent) openFolder(parent.id); else showHome();
});

$('raw-folder-menu').addEventListener('click', async () => {
  if (!current) return;
  const f = current.lineage.at(-1);
  const choice = prompt(`Carpeta "${f.name}"\n\nEscribí un nombre nuevo para renombrarla, o BORRAR para eliminarla con todo lo que tiene.`, f.name);
  if (choice === null || choice.trim() === f.name) return;
  try {
    if (choice.trim().toUpperCase() === 'BORRAR') {
      if (!confirm(`¿Borrar "${f.name}", sus subcarpetas y todas sus imágenes? No se puede deshacer.`)) return;
      await api('/api/raw/folders/delete', { id: f.id });
      const parent = current.lineage.at(-2);
      if (parent) openFolder(parent.id); else showHome();
    } else {
      await api('/api/raw/folders/rename', { id: f.id, name: choice });
      openFolder(f.id);
    }
  } catch (err) { showError(err.message); }
});

function renderWork() {
  const crumbs = $('raw-crumbs');
  crumbs.replaceChildren();
  const home = el('button', 'raw-crumb', 'Raw');
  home.type = 'button'; home.onclick = showHome;
  crumbs.append(home);
  current.lineage.forEach((f, i) => {
    crumbs.append(el('span', 'raw-crumb-sep', '/'));
    const last = i === current.lineage.length - 1;
    const c = el(last ? 'strong' : 'button', 'raw-crumb', f.name);
    if (!last) { c.type = 'button'; c.onclick = () => openFolder(f.id); }
    crumbs.append(c);
  });

  const subs = $('raw-subfolders');
  subs.replaceChildren();
  current.children.forEach((f) => {
    const b = el('button', 'raw-chip', `📁 ${f.name}`);
    b.type = 'button'; b.onclick = () => openFolder(f.id, { greet: true });
    subs.append(b);
  });
  const add = el('button', 'raw-chip ghost-chip', '+ Subcarpeta');
  add.type = 'button';
  add.onclick = async () => {
    const name = prompt('Nombre de la subcarpeta');
    if (!name?.trim()) return;
    try {
      const { folder } = await api('/api/raw/folders', { name, parentId: current.id });
      openFolder(folder.id, { greet: true });
    } catch (err) { showError(err.message); }
  };
  subs.append(add);

  renderAspects();
  renderMic();
  renderLibrary();
  renderGrid();
}

// ---------- Biblioteca del proyecto: personas y referencias, siempre a mano ----------
function thumb(a, { onTap, small } = {}) {
  const t = el('div', `raw-thumb${selected.has(a.code) ? ' selected' : ''}${small ? ' small' : ''}`);
  const img = el('img');
  img.src = fileUrl(a); img.alt = a.name || a.code; img.loading = 'lazy';
  const btn = el('button', 'raw-thumb-hit');
  btn.type = 'button';
  btn.setAttribute('aria-label', `${a.code}${a.name ? ` · ${a.name}` : ''}`);
  btn.setAttribute('aria-pressed', String(selected.has(a.code)));
  btn.append(img);
  btn.onclick = onTap || (() => toggleSelected(a.code));
  t.append(btn, el('span', 'raw-badge', a.category ? `${a.code} · ${a.category}` : a.code));
  if (a.name) t.title = [a.name, a.description].filter(Boolean).join(' — ');
  return t;
}

function toggleSelected(code) {
  if (selected.has(code)) selected.delete(code); else selected.add(code);
  renderLibrary(); renderGrid();
}

function renderLibrary() {
  const box = $('raw-library');
  box.replaceChildren();
  const here = current.lineage.at(-1).id;
  for (const [kind, label] of [['persona', 'Personas'], ['referencia', 'Referencias']]) {
    const list = current.assets.filter((a) => a.kind === kind).reverse();
    const row = el('div', 'raw-row');
    const head = el('div', 'raw-row-head');
    head.append(el('h2', 'raw-section', label), el('span', 'muted small', list.length ? 'Tocá para señalarla' : kind === 'persona' ? 'Subí fotos de personas con 👤' : 'Subí referencias con 🖼'));
    const strip = el('div', 'raw-strip');
    list.forEach((a) => {
      const t = thumb(a);
      if (a.folderId !== here) t.classList.add('inherited');
      const menu = el('button', 'raw-thumb-menu', '⋯');
      menu.type = 'button';
      menu.setAttribute('aria-label', `Opciones de ${a.code}`);
      menu.onclick = () => assetMenu(a);
      t.append(menu);
      strip.append(t);
    });
    row.append(head, strip);
    box.append(row);
  }
}

async function assetMenu(a) {
  const other = a.kind === 'persona' ? 'referencia' : 'persona';
  const choice = prompt(`${a.code}${a.name ? ` · ${a.name}` : ''}\n${a.description || ''}\n\nEscribí:\n1 = pasarla a ${other}\n2 = borrarla`, '');
  try {
    if (choice?.trim() === '1') await api('/api/raw/assets/update', { code: a.code, kind: other });
    else if (choice?.trim() === '2' && confirm(`¿Borrar ${a.code}?`)) await api('/api/raw/assets/delete', { code: a.code });
    else return;
    await refreshFolder();
  } catch (err) { showError(err.message); }
}

async function refreshFolder() {
  if (!current) return;
  const data = await api(`/api/raw/folder?id=${encodeURIComponent(current.id)}`);
  Object.assign(current, data);
  renderWork();
}

function renderGrid() {
  const grid = $('raw-grid');
  [...grid.querySelectorAll('.raw-tile:not(.pending)')].forEach((n) => n.remove());
  const here = current.lineage.at(-1).id;
  const gen = current.assets.filter((a) => a.kind === 'generada' && a.folderId === here).reverse();
  gen.forEach((a) => grid.append(tile(a)));
  if (!gen.length && !grid.querySelector('.pending')) grid.append(el('p', 'muted small raw-tile raw-empty', 'Todavía nada. Pedile algo a Raw.'));
}

function tile(a) {
  const t = el('div', `raw-tile${selected.has(a.code) ? ' selected' : ''}`);
  const b = el('button');
  b.type = 'button';
  const img = el('img');
  img.src = fileUrl(a); img.alt = a.code; img.loading = 'lazy';
  b.append(img);
  b.onclick = () => lightbox(a);
  t.append(b, el('span', 'raw-badge', a.code));
  return t;
}

function lightbox(a) {
  const box = $('raw-lightbox');
  box.replaceChildren();
  const inner = el('div', 'raw-lightbox-inner');
  const img = el('img');
  img.src = fileUrl(a); img.alt = a.code;
  const actions = el('div', 'actions');
  const use = el('button', 'primary', selected.has(a.code) ? 'Quitar señal' : 'Señalarla para Raw');
  use.type = 'button';
  use.onclick = () => { toggleSelected(a.code); box.hidden = true; };
  const dl = el('a', 'ghost', 'Descargar');
  dl.href = fileUrl(a); dl.download = `${a.code}.jpg`;
  const close = el('button', 'ghost', 'Cerrar');
  close.type = 'button'; close.onclick = () => { box.hidden = true; };
  actions.append(use, dl, close);
  inner.append(img, el('p', 'muted small', `${a.code}${a.inputs?.length ? ` · hecha con ${a.inputs.join(' + ')}` : ''}`), actions);
  box.append(inner);
  box.hidden = false;
  box.onclick = (e) => { if (e.target === box) box.hidden = true; };
}

// ---------- Subir imágenes (botones, arrastrar y soltar, pegar) ----------
async function toDataUrl(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * scale); c.height = Math.round(img.naturalHeight * scale);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.9);
  } finally { URL.revokeObjectURL(url); }
}

async function upload(files, kind) {
  if (!current) return;
  const images = [...files].filter((f) => f.type.startsWith('image/'));
  if (!images.length) return showError('Solo imágenes (JPG, PNG, WEBP…).');
  showError('');
  setPhase('uploading');
  try {
    for (const f of images) {
      await api('/api/raw/assets', { folderId: current.id, kind, name: f.name.replace(/\.[^.]+$/, ''), dataUrl: await toDataUrl(f) });
    }
    await refreshFolder();
  } catch (err) { showError(err.message); }
  setPhase(thinking ? 'thinking' : 'idle');
  resumeListening();
}
$('raw-add-ref').addEventListener('change', (e) => { upload(e.target.files, 'referencia'); e.target.value = ''; });
$('raw-add-person').addEventListener('change', (e) => { upload(e.target.files, 'persona'); e.target.value = ''; });
const rawActive = () => document.body.dataset.tab === 'raw' && !!current;
window.addEventListener('dragover', (e) => { if (rawActive()) e.preventDefault(); });
window.addEventListener('drop', (e) => {
  if (!rawActive()) return;
  e.preventDefault();
  if (e.dataTransfer?.files?.length) upload(e.dataTransfer.files, 'referencia');
});
$('raw-text').addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) { e.preventDefault(); upload(files, 'referencia'); }
});

// ---------- Proporción y estilo ----------
function renderAspects() {
  const box = $('raw-aspects');
  box.replaceChildren();
  ASPECTS.forEach((r) => {
    const [w, h] = r.split(':').map(Number);
    const b = el('button', 'raw-aspect-opt');
    b.type = 'button';
    b.setAttribute('aria-pressed', String(r === aspect));
    const shape = el('span', 'raw-shape');
    const k = 18 / Math.max(w, h);
    shape.style.width = `${w * k}px`; shape.style.height = `${h * k}px`;
    b.append(shape, el('span', null, r));
    b.onclick = () => { aspect = r; store.set('raw-aspect', r); box.hidden = true; $('raw-aspect').setAttribute('aria-expanded', 'false'); renderAspects(); };
    box.append(b);
  });
  $('raw-aspect').title = `Proporción: ${aspect}`;
}
$('raw-aspect').addEventListener('click', () => {
  const box = $('raw-aspects');
  box.hidden = !box.hidden;
  $('raw-aspect').setAttribute('aria-expanded', String(!box.hidden));
});
const styleSel = $('raw-style');
styleSel.value = store.get('raw-style', 'Any Style');
if (!styleSel.value) styleSel.value = 'Any Style';
styleSel.addEventListener('change', () => store.set('raw-style', styleSel.value));

let tryIdx = 0;
setInterval(() => { tryIdx = (tryIdx + 1) % TRIES.length; $('raw-try').textContent = `Try “${TRIES[tryIdx]}”`; }, 5000);

// ---------- Estado de la voz ----------
const PHASES = { idle: 'Listo', listening: 'Te escucho…', thinking: 'Pensando…', speaking: 'Hablando', uploading: 'Guardando imágenes…', muted: 'Micrófono apagado' };
function setPhase(p) {
  const phase = p === 'idle' && current && !micOn ? 'muted' : p;
  $('raw-orb').dataset.phase = phase;
  $('raw-phase').textContent = PHASES[phase] || '';
}
function caption(text) { $('raw-caption').textContent = text || ''; }

function logLine(who, text, imgs = []) {
  if (!text && !imgs.length) return;
  const line = el('div', `raw-line ${who}`);
  if (text) line.append(el('span', null, text));
  imgs.forEach((a) => { const i = el('img'); i.src = fileUrl(a); i.alt = a.code; line.append(i); });
  $('raw-log').append(line);
}

// ---------- Hablar: una cola de frases; cada una con su audio (TTS) o, si no hay, la voz del navegador ----------
const player = new Audio();
player.preload = 'auto';
let unlocked = false;
// iOS/Safari solo deja reproducir audio si antes hubo un toque: "desbloqueamos" el reproductor en el primer toque.
function unlockAudio() {
  if (unlocked) return;
  unlocked = true;
  player.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';
  player.play().then(() => player.pause()).catch(() => {});
  try { speechSynthesis.speak(new SpeechSynthesisUtterance('')); } catch { /* sin síntesis */ }
}
window.addEventListener('pointerdown', unlockAudio, { once: true });

const queue = [];
const waiting = new Map(); // id -> resolve(url)
let speaking = false;
let speakGen = 0;

function enqueue(text, urlPromise) {
  queue.push({ text, urlPromise });
  if (!speaking) drain();
}

async function drain() {
  const gen = speakGen;
  speaking = true;
  stopListening();
  while (queue.length && gen === speakGen) {
    const { text, urlPromise } = queue.shift();
    setPhase('speaking');
    caption(text);
    const url = await Promise.race([urlPromise, new Promise((r) => setTimeout(() => r(null), 20000))]).catch(() => null);
    if (gen !== speakGen) break;
    if (url) await playUrl(url).catch(() => speakLocal(text));
    else await speakLocal(text);
  }
  if (gen === speakGen) {
    speaking = false;
    setPhase(thinking ? 'thinking' : 'idle');
    resumeListening();
  }
}

function playUrl(url) {
  return new Promise((resolve, reject) => {
    player.onended = () => resolve();
    player.onerror = () => reject(new Error('audio'));
    player.src = url;
    player.play().catch(reject);
  });
}

function speakLocal(text) {
  return new Promise((resolve) => {
    if (!('speechSynthesis' in window)) return resolve();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'es-ES';
    const es = speechSynthesis.getVoices().find((v) => v.lang?.toLowerCase().startsWith('es'));
    if (es) u.voice = es;
    const done = () => { clearTimeout(t); resolve(); };
    const t = setTimeout(done, 4000 + text.length * 120); // algunos navegadores nunca avisan "end"
    u.onend = done; u.onerror = done;
    speechSynthesis.speak(u);
  });
}

function stopSpeaking() {
  speakGen++;
  queue.length = 0;
  waiting.clear();
  speaking = false;
  player.pause();
  try { speechSynthesis.cancel(); } catch { /* nada */ }
}

// Una frase dicha por el agente: aparece en pantalla y suena.
function sayWithId(id, text) {
  logLine('agent', text);
  const urlPromise = new Promise((resolve) => waiting.set(id, resolve));
  enqueue(text, urlPromise);
}
function say(text) {
  logLine('agent', text);
  enqueue(text, api('/api/raw/speak', { text }).then((r) => r.url).catch(() => null));
}

// ---------- Escuchar: reconocimiento de voz continuo (encendido por defecto) ----------
let rec = null;
let recOn = false;
let heard = '';
let sendTimer = null;

function renderMic() {
  const b = $('raw-mic');
  b.setAttribute('aria-pressed', String(micOn));
  b.title = !SR ? 'Este navegador no reconoce voz: escribí en la caja' : micOn ? 'Micrófono encendido (tocá para apagarlo)' : 'Micrófono apagado (tocá para encenderlo)';
  b.classList.toggle('off', !micOn || !SR);
  if (!speaking && !thinking) setPhase('idle');
}
$('raw-mic').addEventListener('click', () => {
  unlockAudio();
  if (!SR) return showError('Este navegador no tiene reconocimiento de voz (probá Chrome o Safari). Podés escribir en la caja.');
  micOn = !micOn;
  store.set('raw-mic', micOn ? '1' : '0');
  renderMic();
  if (micOn) resumeListening(); else stopListening();
});

function resumeListening() {
  if (!SR || !micOn || !current || speaking || thinking || recOn || document.body.dataset.tab !== 'raw' || document.hidden) return;
  rec = new SR();
  rec.lang = navigator.language?.toLowerCase().startsWith('es') ? navigator.language : 'es-ES';
  rec.continuous = true;
  rec.interimResults = true;
  heard = '';
  rec.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) heard += ` ${r[0].transcript}`; else interim += r[0].transcript;
    }
    caption(`${heard} ${interim}`.trim());
    clearTimeout(sendTimer);
    // Un silencio corto después de una frase completa = terminó de hablar.
    if (heard.trim()) sendTimer = setTimeout(flushHeard, interim ? 1800 : 900);
  };
  rec.onerror = (e) => {
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      micOn = false; renderMic();
      showError('No tengo permiso para usar el micrófono. Activalo en el navegador o escribí en la caja.');
    }
  };
  rec.onend = () => {
    recOn = false;
    if (heard.trim()) flushHeard();
    else setTimeout(resumeListening, 300); // el navegador corta solo tras un rato de silencio: volvemos a escuchar
  };
  try {
    rec.start();
    recOn = true;
    setPhase('listening');
  } catch { recOn = false; }
}

function stopListening() {
  clearTimeout(sendTimer);
  if (rec) { rec.onend = null; rec.onresult = null; try { rec.abort(); } catch { /* ya estaba parado */ } }
  rec = null;
  recOn = false;
  heard = '';
}

function flushHeard() {
  const text = heard.trim();
  stopListening();
  if (text) sendTurn(text);
}
document.addEventListener('visibilitychange', () => { if (document.hidden) stopListening(); else resumeListening(); });

// ---------- Un turno con el agente ----------
$('raw-form').addEventListener('submit', (e) => {
  e.preventDefault();
  unlockAudio();
  const text = $('raw-text').value.trim();
  if (!text && !selected.size) return $('raw-text').focus();
  $('raw-text').value = '';
  sendTurn(text);
});
$('raw-text').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('raw-form').requestSubmit(); }
});
// Mientras escribe, no lo interrumpimos escuchando.
$('raw-text').addEventListener('focus', stopListening);
$('raw-text').addEventListener('blur', () => setTimeout(resumeListening, 200));

async function sendTurn(text, picked) {
  if (!current) return;
  if (thinking) return showError('Esperá a que Raw termine de pensar.');
  const folderId = current.id;
  const sel = picked || [...selected];
  const assetsSel = sel.map((c) => current.assets.find((a) => a.code === c)).filter(Boolean);
  logLine('user', text || (assetsSel.length ? 'Esta' : ''), assetsSel);
  caption(text);
  selected = new Set();
  renderLibrary(); renderGrid();
  $('raw-choice').hidden = true;
  showError('');
  thinking = true;
  stopListening();
  setPhase('thinking');
  const controller = new AbortController();
  streams.add(controller);
  const body = JSON.stringify({ folderId, text, selected: sel, style: styleSel.value, aspect });
  const here = () => current?.id === folderId;
  try {
    await streamEvents('/api/raw/turn', body, controller.signal, (ev) => onEvent(ev, here));
  } catch (err) {
    if (err.name !== 'AbortError') showError(err.message);
  } finally {
    streams.delete(controller);
    if (thinking && here()) { thinking = false; setPhase(speaking ? 'speaking' : 'idle'); resumeListening(); }
  }
}

function onEvent(ev, here) {
  switch (ev.type) {
    case 'reasoning': if (here() && thinking) caption('…'); break;
    case 'notice': if (here()) caption(ev.text); break;
    case 'raw_asset':
      if (here()) { const i = current.assets.findIndex((a) => a.code === ev.asset.code); if (i >= 0) current.assets[i] = ev.asset; renderLibrary(); }
      break;
    case 'raw_say': if (here()) sayWithId(ev.id, ev.text); break;
    case 'raw_audio': waiting.get(ev.id)?.(ev.url); waiting.delete(ev.id); break;
    case 'raw_show': if (here()) showChoice(ev.codes, ev.question); break;
    case 'raw_listen':
      thinking = false;
      if (here()) { setPhase(speaking ? 'speaking' : 'idle'); resumeListening(); }
      break;
    case 'raw_generating': if (here()) pendingTile(ev); break;
    case 'raw_gen_status': {
      const t = document.querySelector(`[data-job="${ev.id}"] .raw-pending-label`);
      if (t) t.textContent = `Generando… ${Math.round(ev.elapsed)} s`;
      break;
    }
    case 'raw_generated':
      document.querySelector(`[data-job="${ev.id}"]`)?.remove();
      if (here()) { current.assets.push(ev.asset); renderGrid(); }
      break;
    case 'raw_gen_error': {
      const t = document.querySelector(`[data-job="${ev.id}"]`);
      if (t) { t.classList.add('failed'); t.querySelector('.raw-pending-label').textContent = 'Falló'; t.title = ev.text; setTimeout(() => t.remove(), 15000); }
      if (here()) showError(ev.text);
      break;
    }
    case 'error': thinking = false; if (here()) { showError(ev.text); setPhase('idle'); } break;
    default: break;
  }
}

// El agente tiene dudas: muestra las candidatas; la persona toca una (o la nombra en voz alta).
function showChoice(codes, question) {
  const box = $('raw-choice');
  box.replaceChildren();
  box.append(el('p', 'raw-choice-q', question || '¿Cuál?'));
  const row = el('div', 'raw-choice-row');
  codes.map((c) => current.assets.find((a) => a.code === c)).filter(Boolean).forEach((a, i) => {
    const t = thumb(a, { onTap: () => { box.hidden = true; stopSpeaking(); sendTurn('', [a.code]); } });
    t.append(el('span', 'raw-choice-n', String(i + 1)));
    row.append(t);
  });
  box.append(row);
  box.hidden = false;
  box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function pendingTile(ev) {
  const grid = $('raw-grid');
  grid.querySelector('.raw-empty')?.remove();
  const t = el('div', 'raw-tile pending');
  t.dataset.job = ev.id;
  const [w, h] = (ev.aspect || '1:1').split(':').map(Number);
  t.style.aspectRatio = `${w} / ${h}`;
  t.append(el('span', 'raw-pending-label', 'Generando…'));
  if (ev.summary) t.title = ev.summary;
  grid.prepend(t);
}

// ---------- Arranque ----------
function route() {
  const hash = location.hash.slice(1);
  if (hash === 'estudio' || new URLSearchParams(location.search).get('modo')) return setTab('studio');
  setTab('raw');
  const m = /^raw\/(.+)$/.exec(hash);
  loadFolders().then(() => { if (m && folders.some((f) => f.id === m[1])) openFolder(m[1]); }).catch((err) => showError(err.message));
}
route();
setPhase('idle');
