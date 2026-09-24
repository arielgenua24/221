import { createPlayer, fmt } from './player.js';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = text;
  return n;
};

const AUDIO_RATE = 16000; // lo que usa el modelo para escuchar; la reproducción usa el archivo original
const MAX_AUDIO_SECONDS = 8 * 60;
const FRAME_SIDE = 640;
const feed = $('feed');
const input = $('text');
let maxMedia = 24;
let maxFrames = 60;
let audio = null; // { name, url, wav, duration }
let items = []; // { id, kind, name, url, duration, frames: [{ t, url }], thumb }
let controller = null;
let steps = new Map();
let analysis = null;
let busy = 0;

// ---------- Configuración ----------
fetch('/api/config').then((r) => r.json()).then((cfg) => {
  maxMedia = cfg.maxMedia || maxMedia;
  maxFrames = cfg.maxFrames || maxFrames;
  const mode = $('mode');
  mode.textContent = cfg.mock ? 'Demo' : 'En vivo';
  mode.title = `Oído: ${cfg.earModel}\nEditor: ${cfg.editorModel}`;
  if (cfg.mock) mode.classList.add('demo');
});

// ---------- Scroll ----------
let stick = true;
feed.addEventListener('scroll', () => { stick = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 120; });
const follow = () => { if (stick) feed.scrollTop = feed.scrollHeight; };
function append(node) { feed.append(node); stick = true; follow(); return node; }

// ---------- Composer ----------
function autosize() { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 160)}px`; }
input.addEventListener('input', () => { autosize(); updateSend(); });
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && matchMedia('(pointer: fine)').matches) { e.preventDefault(); $('form').requestSubmit(); }
});

function updateSend() {
  const running = !!controller;
  $('send-icon').toggleAttribute('hidden', running);
  $('stop-icon').toggleAttribute('hidden', !running);
  $('send').title = running ? 'Detener' : 'Editar';
  $('send').disabled = !running && (busy > 0 || !audio || !items.length);
}
updateSend();

function showError(msg) { const e = $('error'); e.textContent = msg || ''; e.hidden = !msg; }

// ---------- Música: decodificar y pasar a WAV mono 16 kHz ----------
function encodeWav(samples, rate) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, samples[i])) * 32767, true);
  return new Blob([buf], { type: 'audio/wav' });
}

const toDataUrl = (blob) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(r.result);
  r.onerror = () => reject(r.error);
  r.readAsDataURL(blob);
});

async function loadAudio(file) {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx();
  let decoded;
  try {
    decoded = await ctx.decodeAudioData(await file.arrayBuffer());
  } catch {
    throw new Error(`No pude leer el audio de "${file.name}". Probá con MP3, M4A o WAV.`);
  } finally {
    ctx.close?.();
  }
  if (decoded.duration > MAX_AUDIO_SECONDS) throw new Error(`La música dura ${fmt(decoded.duration)}; el máximo es ${MAX_AUDIO_SECONDS / 60} minutos.`);
  const off = new OfflineAudioContext(1, Math.ceil(decoded.duration * AUDIO_RATE), AUDIO_RATE);
  const src = off.createBufferSource();
  src.buffer = decoded;
  src.connect(off.destination);
  src.start();
  const mono = await off.startRendering();
  return { name: file.name, url: URL.createObjectURL(file), duration: decoded.duration, wav: await toDataUrl(encodeWav(mono.getChannelData(0), AUDIO_RATE)) };
}

// ---------- Material: cuadros de cada video y fotos reducidas ----------
function toJpeg(source, w, h) {
  const scale = Math.min(1, FRAME_SIDE / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.round(w * scale); c.height = Math.round(h * scale);
  c.getContext('2d').drawImage(source, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.72);
}

const once = (node, ev, ms = 8000) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('tiempo agotado')), ms);
  node.addEventListener(ev, () => { clearTimeout(t); resolve(); }, { once: true });
  node.addEventListener('error', () => { clearTimeout(t); reject(new Error('no se pudo leer')); }, { once: true });
});

async function loadVideo(file) {
  const url = URL.createObjectURL(file);
  const v = document.createElement('video');
  v.muted = true; v.playsInline = true; v.preload = 'auto'; v.src = url;
  await once(v, 'loadeddata');
  const d = v.duration;
  if (!Number.isFinite(d) || !d) throw new Error(`No pude leer la duración de "${file.name}".`);
  const frames = [];
  for (const t of [0.12, 0.37, 0.62, 0.87].map((f) => +(d * f).toFixed(2))) {
    v.currentTime = t;
    await once(v, 'seeked');
    frames.push({ t, url: toJpeg(v, v.videoWidth, v.videoHeight) });
  }
  return { kind: 'video', name: file.name, url, duration: d, frames, thumb: frames[1].url };
}

async function loadPhoto(file) {
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.src = url;
  await once(img, 'load');
  const frame = toJpeg(img, img.naturalWidth, img.naturalHeight);
  return { kind: 'photo', name: file.name, url, duration: 0, frames: [{ t: 0, url: frame }], thumb: frame };
}

function renumber() {
  let v = 0; let f = 0;
  items.forEach((m) => { m.id = m.kind === 'video' ? `V${++v}` : `F${++f}`; });
}

async function withBusy(fn) {
  busy++; updateSend(); renderThumbs();
  try { await fn(); } catch (err) { showError(err.message); } finally { busy--; updateSend(); renderThumbs(); }
}

$('audio-file').addEventListener('change', (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  showError('');
  withBusy(async () => { audio = await loadAudio(file); });
});

$('media-file').addEventListener('change', (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  showError('');
  withBusy(async () => {
    for (const file of files) {
      if (items.length >= maxMedia) { showError(`Máximo ${maxMedia} videos y fotos.`); break; }
      try {
        if (file.type.startsWith('video/')) items.push(await loadVideo(file));
        else if (file.type.startsWith('image/')) items.push(await loadPhoto(file));
      } catch (err) {
        showError(`${file.name}: ${err.message}`);
      }
      renumber();
      renderThumbs();
    }
  });
});

function renderThumbs() {
  const box = $('thumbs');
  box.replaceChildren();
  if (audio) {
    const chip = el('div', 'audio-chip');
    chip.append(el('span', null, '🎵'), el('span', 'audio-name', audio.name), el('span', 'muted', fmt(audio.duration)));
    const x = el('button', null, '×');
    x.type = 'button'; x.setAttribute('aria-label', 'Quitar música');
    x.onclick = () => { URL.revokeObjectURL(audio.url); audio = null; renderThumbs(); updateSend(); };
    chip.append(x);
    box.append(chip);
  }
  items.forEach((m, i) => {
    const t = el('div', 'thumb');
    const img = el('img');
    img.src = m.thumb; img.alt = m.name;
    const badge = el('span', 'badge', m.kind === 'video' ? `${m.id} · ${Math.round(m.duration)}s` : m.id);
    const x = el('button', null, '×');
    x.type = 'button'; x.setAttribute('aria-label', `Quitar ${m.id}`);
    x.onclick = () => { URL.revokeObjectURL(m.url); items.splice(i, 1); renumber(); renderThumbs(); updateSend(); };
    t.append(img, badge, x);
    box.append(t);
  });
  if (busy) box.append(el('div', 'thumb loading', '…'));
}

// Cuántos cuadros por video entran en el presupuesto de imágenes del editor.
function framesForRequest() {
  const photos = items.filter((m) => m.kind === 'photo').length;
  const videos = items.length - photos;
  const per = videos ? Math.max(1, Math.min(4, Math.floor((maxFrames - photos) / videos))) : 0;
  const pick = { 1: [1], 2: [0, 2], 3: [0, 1, 3], 4: [0, 1, 2, 3] }[per];
  return items.map((m) => ({
    id: m.id, kind: m.kind, name: m.name, duration: m.duration,
    frames: m.kind === 'video' ? pick.map((k) => m.frames[k]) : m.frames,
  }));
}

// ---------- Enviar / detener ----------
$('form').addEventListener('submit', (e) => {
  e.preventDefault();
  if (controller) { controller.abort(); return; }
  if (!audio) return showError('Elegí primero la música (🎵).');
  if (!items.length) return showError('Agregá al menos un video o una foto (🎞️).');
  run(input.value.trim());
});

async function run(text) {
  $('welcome')?.remove();
  showError('');
  steps = new Map();
  analysis = null;
  const sentAudio = audio;
  const sentItems = items;
  const mediaMap = new Map(sentItems.map((m) => [m.id, m]));

  const msg = append(el('div', 'msg user-msg'));
  const strip = el('div', 'user-photos');
  sentItems.slice(0, 12).forEach((m) => { const i = el('img'); i.src = m.thumb; i.alt = m.id; strip.append(i); });
  msg.append(el('div', 'bubble', `🎵 ${sentAudio.name} (${fmt(sentAudio.duration)}) · ${sentItems.length} tomas${text ? `\n${text}` : ''}`), strip);

  const body = JSON.stringify({ text, audio: { name: sentAudio.name, wav: sentAudio.wav }, media: framesForRequest() });
  input.value = ''; autosize();
  audio = null; items = []; renderThumbs();
  controller = new AbortController();
  updateSend();

  try {
    const res = await fetch('/api/edit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: controller.signal });
    if (!res.ok) throw new Error((await res.json()).error || `Error ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.trim()) handle(JSON.parse(line), { audio: sentAudio, media: mediaMap });
      }
    }
  } catch (e) {
    if (e.name === 'AbortError') append(el('div', 'msg note', 'Detuviste la edición.'));
    else showError(e.message);
  } finally {
    steps.forEach((s) => { if (s.status.classList.contains('running')) setStatus(s, 'fail'); });
    feed.querySelectorAll('.decision:not(.done)').forEach(lockDecision);
    controller = null;
    updateSend();
  }
}

// ---------- Eventos del arnés ----------
function handle(ev, ctx) {
  const s = steps.get(ev.step);
  switch (ev.type) {
    case 'step_start': return startStep(ev);
    case 'delta': if (s) { s.body.textContent += ev.text; follow(); } return;
    case 'reasoning':
      if (s) { s.thought = (s.thought + ev.text).slice(-300); s.live.textContent = s.thought.replace(/\s+/g, ' ').trim(); }
      return;
    case 'progress': if (s) s.live.textContent = `Escribiendo… ${ev.chars.toLocaleString('es')} caracteres`; return;
    case 'notice': if (s) s.node.append(el('div', 'notice', ev.text)); return;
    case 'step_end':
      if (s) { setStatus(s, 'ok'); s.live.textContent = ''; s.node.open = false; s.sub.textContent = 'Listo · tocá para ver sus notas'; }
      return;
    case 'analysis': analysis = ev.data; return;
    case 'map': return addChips('ear', (ev.data?.secciones || []).map((x) => `${x.nombre} ${fmt(Number(x.inicio) || 0)}`));
    case 'decision': return renderMapDecision(ev);
    case 'decision_done': { const d = feed.querySelector(`[data-decision="${ev.id}"]`); if (d) lockDecision(d); return; }
    case 'timeline': return renderResult(ev.data, ctx);
    case 'usage': $('usage').textContent = ev.cost ? `US$ ${ev.cost.toFixed(3)}` : `${ev.tokens.toLocaleString('es')} tokens`; return;
    case 'error': showError(ev.text); append(el('div', 'msg note', `Se cortó la edición: ${ev.text}`)); return;
    default:
  }
}

const INITIAL = { 'Análisis': '∿', 'Oído': 'O', Editor: 'E' };

function startStep({ step, role, title, model }) {
  const node = el('details', 'agent msg');
  node.open = true;
  const summary = el('summary');
  const t = el('div', 'agent-title', title);
  const sub = el('span', 'agent-sub', model);
  t.append(sub);
  const status = el('span', 'status running');
  summary.append(el('span', `dot ${role}`, INITIAL[role] || '•'), t, status);
  const body = el('div', 'agent-body');
  const live = el('div', 'live');
  node.append(summary, body, live);
  append(node);
  steps.set(step, { node, body, live, status, sub, thought: '' });
}

function setStatus(s, state) {
  s.status.className = `status ${state}`;
  s.status.textContent = state === 'ok' ? '✓' : state === 'fail' ? '✕' : '';
}

function addChips(step, labels) {
  const s = steps.get(step);
  if (!s || !labels.length) return;
  const chips = el('div', 'chips');
  labels.forEach((l) => chips.append(el('span', 'chip', l)));
  s.node.append(chips);
}

// ---------- Decisión: ¿escuché bien? ----------
async function decide(card, id, answer, echo) {
  card.querySelectorAll('button, textarea, input').forEach((b) => { b.disabled = true; });
  try {
    const res = await fetch('/api/decide', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, answer }) });
    if (!res.ok) throw new Error((await res.json()).error);
    lockDecision(card);
    append(el('div', 'msg user-msg')).append(el('div', 'bubble', echo));
  } catch (e) {
    showError(e.message);
    card.querySelectorAll('button, textarea, input').forEach((b) => { b.disabled = false; });
  }
}

function lockDecision(card) {
  card.classList.add('done');
  card.querySelectorAll('button, textarea, input').forEach((b) => { b.disabled = true; });
}

function renderMapDecision(ev) {
  const map = ev.map || {};
  const card = el('section', 'decision msg');
  card.dataset.decision = ev.id;
  const head = el('div');
  head.append(el('div', 'decision-label', 'Tu decisión'), el('h3', null, ev.title));
  card.append(head);

  const facts = el('div', 'facts');
  const fact = (label, value) => {
    if (!value) return;
    const f = el('div', 'fact');
    f.append(el('strong', null, label), document.createTextNode(value));
    facts.append(f);
  };
  fact('Qué escuché', [map.resumen?.estilo, map.resumen?.animo].filter(Boolean).join(' — '));
  fact('Tempo', map.grilla ? `${map.grilla.bpm} BPM · ${map.grilla.confiable ? 'pulso claro' : 'pulso libre'}${map.grilla.nota ? ` · ${map.grilla.nota}` : ''}` : null);
  fact('Arco del video', map.arco);
  card.append(facts);

  const secs = el('div', 'map-sections');
  (map.secciones || []).forEach((s) => {
    const row = el('div', 'map-sec');
    const bar = el('span', 'energy');
    bar.style.setProperty('--e', Math.min(5, Math.max(1, Number(s.energia) || 1)) / 5);
    row.append(
      el('span', 'map-time', `${fmt(Number(s.inicio) || 0)}–${fmt(Number(s.fin) || 0)}`),
      bar,
      el('span', 'map-name', s.nombre),
      el('span', 'map-cut muted', s.ritmo_de_corte || ''),
    );
    if (s.que_pasa) row.append(el('span', 'map-what', s.que_pasa));
    secs.append(row);
  });
  card.append(secs);

  if ((map.momentos_clave || []).length) {
    const moments = el('div', 'chips flush');
    map.momentos_clave.forEach((m) => moments.append(el('span', 'chip', `◆ ${fmt(Number(m.t) || 0)} ${m.tipo}`)));
    card.append(moments);
  }

  const answers = new Map();
  (ev.questions || []).forEach((q) => {
    const box = el('div', 'question');
    box.append(el('p', null, q.pregunta));
    const opts = el('div', 'options');
    const buttons = (q.opciones || []).map((o) => {
      const btn = el('button', 'option', o);
      btn.type = 'button';
      btn.setAttribute('aria-pressed', 'false');
      btn.onclick = () => {
        const on = btn.getAttribute('aria-pressed') !== 'true';
        buttons.forEach((b) => b.setAttribute('aria-pressed', 'false'));
        btn.setAttribute('aria-pressed', String(on));
        if (on) answers.set(q.pregunta, o); else answers.delete(q.pregunta);
      };
      return btn;
    });
    opts.append(...buttons);
    box.append(opts);
    card.append(box);
  });

  const comment = el('textarea');
  comment.rows = 2;
  comment.placeholder = '¿Algo mal? Ej.: "el estribillo arranca en 0:45", "que la última parte sea lenta" (opcional)';
  card.append(comment);

  const actions = el('div', 'actions');
  const go = el('button', 'primary', 'Montar el video');
  go.type = 'button';
  go.onclick = () => {
    const respuestas = [...answers].map(([pregunta, respuesta]) => ({ pregunta, respuesta }));
    const comentario = comment.value.trim();
    const empty = !respuestas.length && !comentario;
    const echo = empty ? 'Escuchaste bien, seguí.' : [...respuestas.map((r) => r.respuesta), comentario].filter(Boolean).join(' · ');
    decide(card, ev.id, empty ? null : { respuestas, comentario }, echo);
  };
  actions.append(go);
  card.append(actions);
  append(card);
}

// ---------- Resultado ----------
function renderResult(timeline, ctx) {
  const wrap = append(el('section', 'msg result'));
  wrap.append(el('h2', 'results-title', timeline.concepto || 'Tu video, cortado sobre la música'));
  wrap.append(el('p', 'muted small', `${timeline.segmentos.length} cortes en ${fmt(timeline.duracion)} · tocá ▶ para verlo con la música`));
  wrap.append(createPlayer({ timeline, analysis, audioUrl: ctx.audio.url, audioName: ctx.audio.name, media: ctx.media }));
  if (timeline.nota) append(el('div', 'msg note', timeline.nota));
}
