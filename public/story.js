import { $, el, streamEvents } from './shared.js';
import { kindOf, loadVideo } from './media.js';
import { createStoryEditor } from './story-timeline.js';

// Historia: el humano sube su material y conversa con el Guionista, que arma la historia en tomas de 5 s.
// Se dibuja el storyboard (el primer cuadro de cada toma); cada toma que el humano aprueba la dirige el
// Director de Fotografía y la genera Wan 3.0, en paralelo. Las tomas listas se montan sobre la música.
// Todo lo largo corre en el servidor: la pestaña consulta el proyecto mientras haya algo generándose.

const MAX_SIDE = 1280;
const POLL_MS = 2500;

let cfg = { mock: false, story: { generate: false, shotSeconds: 5, maxAssets: 16, aspects: ['9:16', '16:9', '1:1'] } };
let project = null;
let turn = null; // AbortController del turno en curso
let pollTimer = 0;
let editor = null;
const drafts = new Map(); // textos que el humano está escribiendo en cada toma (sobreviven a los redibujos)
const cards = new Map(); // id → { node, sig }

fetch('/api/config').then((r) => r.json()).then((c) => { cfg = { ...cfg, ...c, story: { ...cfg.story, ...(c.story || {}) } }; }).catch(() => {});

function showError(msg) { const e = $('story-error'); e.textContent = msg || ''; e.hidden = !msg; }
async function api(url, body) {
  const res = await fetch(url, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}
const fileUrl = (f) => `/story-files/${f}`;
const busyStatus = (j) => j?.status === 'queued' || j?.status === 'running';

// ---------- Inicio: lista de historias ----------
async function loadHome() {
  const { projects } = await api('/api/story/projects');
  const box = $('story-projects');
  box.replaceChildren();
  if (!projects.length) box.append(el('p', 'muted small', 'Todavía no hay historias. Creá la primera.'));
  projects.forEach((p) => {
    const b = el('button', 'story-project');
    b.type = 'button';
    const cover = el('span', 'story-cover');
    if (p.cover) cover.style.backgroundImage = `url("${fileUrl(p.cover)}")`;
    const [w, h] = p.aspect.split(':').map(Number);
    cover.style.aspectRatio = `${w} / ${h}`;
    const info = el('span', 'story-project-info');
    info.append(el('strong', null, p.title), el('span', 'muted small', `${p.aspect} · ${p.shots} toma${p.shots === 1 ? '' : 's'} · ${p.clips} video${p.clips === 1 ? '' : 's'}`));
    b.append(cover, info);
    b.onclick = () => openProject(p.id);
    box.append(b);
  });
}

$('story-new').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const { project: p } = await api('/api/story/projects', { title: $('story-new-name').value, aspect: $('story-new-aspect').value });
    $('story-new-name').value = '';
    openProject(p.id);
  } catch (err) { alert(err.message); }
});

async function openProject(id) {
  try {
    const { project: p } = await api(`/api/story/project?id=${encodeURIComponent(id)}`);
    project = p;
    cards.clear();
    $('story-board').replaceChildren();
    editor?.destroy();
    editor = null;
    $('story-editor').replaceChildren();
    $('story-home').hidden = true;
    $('story-work').hidden = false;
    history.replaceState(null, '', `#historia/${id}`);
    showError('');
    render();
  } catch (err) {
    alert(err.message);
    goHome();
  }
}

function goHome() {
  stopPolling();
  turn?.abort();
  editor?.destroy();
  editor = null;
  project = null;
  $('story-work').hidden = true;
  $('story-home').hidden = false;
  history.replaceState(null, '', '#historia');
  loadHome().catch(() => {});
}
$('story-back').onclick = goHome;
$('story-delete').onclick = async () => {
  if (!project || !confirm(`¿Borrar "${project.title}"? Se pierden la conversación, el storyboard y los videos.`)) return;
  await api('/api/story/projects/delete', { id: project.id }).catch((e) => alert(e.message));
  goHome();
};
$('story-title').addEventListener('change', async () => {
  if (!project) return;
  try { project = (await api('/api/story/projects/update', { id: project.id, title: $('story-title').value })).project; } catch (e) { showError(e.message); }
});

// ---------- Render ----------
function render() {
  if (!project) return;
  if (document.activeElement !== $('story-title')) $('story-title').value = project.title;
  $('story-aspect').textContent = project.aspect;
  $('story-cost').textContent = project.cost ? `US$ ${project.cost.toFixed(3)}` : '';
  renderSteps();
  renderMaterial();
  renderChat();
  renderBoard();
  renderEditor();
  if (project.busy) startPolling(); else stopPolling();
}

function renderSteps() {
  const s = project.shots;
  const step = s.some((x) => x.video?.file) ? 'edit' : s.some((x) => x.approved) ? 'clips' : s.some((x) => x.frame?.file) || project.ready ? 'board' : 'talk';
  const order = ['talk', 'board', 'clips', 'edit'];
  document.querySelectorAll('.story-steps li').forEach((li) => {
    const k = order.indexOf(li.dataset.step);
    li.dataset.state = k < order.indexOf(step) ? 'done' : k === order.indexOf(step) ? 'now' : '';
  });
}

function renderMaterial() {
  const box = $('story-material');
  box.replaceChildren();
  if (!project.assets.length) {
    box.append(el('p', 'muted small', 'Tu material: soltá o elegí con + fotos de personas, productos o lugares, o videos (tomo cuadros). El Guionista los ve y los usa como referencia.'));
    return;
  }
  project.assets.forEach((a) => {
    const t = el('figure', 'story-asset');
    const img = el('img'); img.src = fileUrl(a.file); img.alt = a.name || a.code; img.loading = 'lazy';
    const cap = el('figcaption', null, a.code);
    const x = el('button', 'story-asset-x', '×'); x.type = 'button'; x.title = `Quitar ${a.code}`; x.setAttribute('aria-label', `Quitar ${a.code}`);
    x.onclick = async () => {
      if (!confirm(`¿Quitar ${a.code} del proyecto?`)) return;
      try { await api('/api/story/assets/delete', { projectId: project.id, code: a.code }); await refreshProject(); } catch (e) { showError(e.message); }
    };
    t.title = a.note ? `${a.code}: ${a.note}` : a.code;
    t.append(img, cap, x);
    box.append(t);
  });
}

function renderChat() {
  const box = $('story-chat');
  if (turn) return; // durante el turno el chat se escribe en vivo
  box.replaceChildren();
  if (!project.chat.length) greet();
  project.chat.forEach((m, i) => {
    const msg = el('div', `story-msg ${m.role === 'user' ? 'me' : 'bot'}`);
    msg.append(el('div', 'bubble', m.text));
    box.append(msg);
    // Las preguntas del último mensaje se pueden responder tocando.
    if (m.role !== 'user' && i === project.chat.length - 1 && m.preguntas?.length) box.append(questionCard(m.preguntas));
  });
  box.scrollTop = box.scrollHeight;
}

function greet() {
  const box = $('story-chat');
  const msg = el('div', 'story-msg bot');
  msg.append(el('div', 'bubble', 'Hola. Contame qué historia querés contar —para quién, qué tiene que sentir— y subí tu material (personas, producto, lugar). La armamos en tomas de 5 segundos.'));
  box.append(msg);
}

function questionCard(questions) {
  const card = el('div', 'story-questions');
  const answers = new Map();
  questions.forEach((q) => {
    const row = el('div', 'question');
    row.append(el('p', null, q.pregunta));
    const opts = el('div', 'options');
    q.opciones.forEach((o) => {
      const b = el('button', 'option', o); b.type = 'button'; b.setAttribute('aria-pressed', 'false');
      b.onclick = () => {
        opts.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', 'false'));
        b.setAttribute('aria-pressed', 'true');
        answers.set(q.pregunta, o);
        if (answers.size === questions.length) send({ answers: [...answers].map(([pregunta, respuesta]) => ({ pregunta, respuesta })) });
      };
      opts.append(b);
    });
    row.append(opts);
    card.append(row);
  });
  if (questions.length > 1) {
    const go = el('button', 'small-btn', 'Responder');
    go.type = 'button';
    go.onclick = () => answers.size && send({ answers: [...answers].map(([pregunta, respuesta]) => ({ pregunta, respuesta })) });
    card.append(go);
  }
  return card;
}

// ---------- Conversación ----------
const input = $('story-text');
function autosize() { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 160)}px`; }
input.addEventListener('input', autosize);
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && matchMedia('(pointer: fine)').matches) { e.preventDefault(); $('story-form').requestSubmit(); }
});
$('story-form').addEventListener('submit', (e) => {
  e.preventDefault();
  if (turn) { turn.abort(); return; }
  const text = input.value.trim();
  if (!text) return;
  send({ text });
});

async function send({ text = '', answers = [] }) {
  if (!project || turn) return;
  showError('');
  const box = $('story-chat');
  box.querySelectorAll('.story-questions button').forEach((b) => { b.disabled = true; });
  const echo = [text, ...answers.map((a) => a.respuesta)].filter(Boolean).join(' · ');
  const mine = el('div', 'story-msg me'); mine.append(el('div', 'bubble', echo)); box.append(mine);
  const reply = el('div', 'story-msg bot thinking');
  const bubble = el('div', 'bubble', '…');
  const notes = el('div', 'story-notes');
  reply.append(notes, bubble);
  box.append(reply);
  box.scrollTop = box.scrollHeight;
  input.value = ''; autosize();
  turn = new AbortController();
  $('story-send').classList.add('stop');
  const live = $('story-live');
  live.hidden = false; live.textContent = 'El Guionista lee tu mensaje y mira el material…';
  let noteText = '';
  try {
    await streamEvents('/api/story/turn', JSON.stringify({ projectId: project.id, text, answers }), turn.signal, (ev) => {
      if (ev.type === 'delta') { noteText += ev.text; notes.textContent = noteText.trim(); box.scrollTop = box.scrollHeight; }
      else if (ev.type === 'reasoning') live.textContent = `Pensando… ${ev.text.replace(/\s+/g, ' ').slice(-120)}`;
      else if (ev.type === 'progress') live.textContent = `Escribiendo las tomas… ${ev.chars.toLocaleString('es')} caracteres`;
      else if (ev.type === 'notice') live.textContent = ev.text;
      else if (ev.type === 'story_reply') { bubble.textContent = ev.decir; reply.classList.remove('thinking'); }
      else if (ev.type === 'project') project = ev.project;
      else if (ev.type === 'error') showError(ev.text);
    });
  } catch (err) {
    if (err.name !== 'AbortError') showError(err.message);
  } finally {
    turn = null;
    live.hidden = true;
    $('story-send').classList.remove('stop');
    render();
  }
}

// ---------- Material: fotos y cuadros de videos ----------
async function toJpeg(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const s = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * s); c.height = Math.round(img.naturalHeight * s);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.88);
  } finally { URL.revokeObjectURL(url); }
}

async function addFiles(files) {
  if (!project) return;
  showError('');
  const list = [...files].filter((f) => ['photo', 'video'].includes(kindOf(f)));
  if (!list.length) return showError('Soltá fotos o videos (la música se agrega en el montaje).');
  const live = $('story-live');
  live.hidden = false;
  try {
    for (const f of list) {
      live.textContent = `Subiendo ${f.name}…`;
      if (kindOf(f) === 'photo') {
        await api('/api/story/assets', { projectId: project.id, dataUrl: await toJpeg(f), name: f.name, source: 'foto' });
      } else {
        // De un video, tres cuadros representativos.
        const v = await loadVideo(f);
        URL.revokeObjectURL(v.url);
        for (const [i, fr] of v.frames.slice(1, 4).entries()) {
          await api('/api/story/assets', { projectId: project.id, dataUrl: fr.url, name: `${f.name} · ${fr.t.toFixed(1)} s`, source: 'video' });
          live.textContent = `Subiendo ${f.name} (${i + 1}/3)…`;
        }
      }
    }
  } catch (err) {
    showError(err.message);
  } finally {
    live.hidden = true;
    await refreshProject();
  }
}
$('story-file').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
// Soltar archivos en cualquier parte de la historia abierta (la música se suelta en su pista, en el montaje).
const storyActive = () => document.body.dataset.tab === 'story' && !!project;
window.addEventListener('dragover', (e) => { if (storyActive()) e.preventDefault(); });
window.addEventListener('drop', (e) => {
  if (!storyActive()) return;
  e.preventDefault();
  const files = [...(e.dataTransfer?.files || [])];
  if (!files.length) return;
  if (files.every((f) => kindOf(f) === 'audio')) return editor ? editor.dropMusic(files[0]) : showError('La música se agrega en el montaje, cuando haya tomas.');
  addFiles(files);
});

// ---------- Storyboard ----------
function renderBoard() {
  const wrap = $('story-board-wrap');
  const shots = project.shots;
  wrap.hidden = !shots.length;
  if (!shots.length) return;
  const drawBtn = $('story-draw');
  const missing = shots.filter((s) => !s.frame?.file && !busyStatus(s.frame));
  drawBtn.hidden = !missing.length;
  drawBtn.textContent = shots.some((s) => s.frame?.file) ? `Dibujar las que faltan (${missing.length})` : `Dibujar storyboard (${shots.length} cuadros)`;
  drawBtn.disabled = !cfg.story.generate;
  const approvable = shots.filter((s) => s.frame?.file && s.frame.status === 'done' && !s.approved);
  $('story-approve-all').hidden = approvable.length < 2;
  $('story-approve-all').textContent = `Aprobar las ${approvable.length} y generar`;
  const secs = shots.length * cfg.story.shotSeconds;
  $('story-board-hint').textContent = !cfg.story.generate
    ? 'Falta WAVESPEED_API_KEY en el servidor: no se pueden dibujar cuadros ni generar video.'
    : `${shots.length} tomas · ${secs} s. Cada cuadro es el primer cuadro exacto de su toma. Al aprobar una, el Director de Fotografía la dirige y Wan 3.0 la genera (${cfg.story.resolution || '480p'}, ${cfg.story.shotSeconds} s)${cfg.mock ? ' — en demo no se genera video' : ''}.`;

  const board = $('story-board');
  const ids = shots.map((s) => s.id);
  for (const [id, c] of cards) if (!ids.includes(id)) { c.node.remove(); cards.delete(id); }
  shots.forEach((s, i) => {
    const sig = JSON.stringify([s, project.aspect, cfg.story.generate]);
    let c = cards.get(s.id);
    if (!c || c.sig !== sig) {
      const node = shotCard(s, i);
      if (c) c.node.replaceWith(node);
      c = { node, sig };
      cards.set(s.id, c);
    }
    if (board.children[i] !== c.node) board.insertBefore(c.node, board.children[i] || null);
  });
}

function shotCard(s, i) {
  const card = el('article', 'shot');
  card.dataset.state = s.video?.file ? 'video' : busyStatus(s.video) ? 'generating' : s.approved ? 'approved' : s.frame?.file ? 'frame' : 'empty';
  const head = el('header', 'shot-head');
  head.append(el('span', 'shot-id', s.id), el('strong', 'shot-title', s.titulo));
  const dots = el('span', 'shot-int');
  dots.title = `Intensidad ${s.intensidad}/5`;
  dots.textContent = '●'.repeat(s.intensidad) + '○'.repeat(5 - s.intensidad);
  head.append(dots);

  const media = el('div', 'shot-media');
  const [w, h] = project.aspect.split(':').map(Number);
  media.style.aspectRatio = `${w} / ${h}`;
  if (s.video?.file) {
    const v = el('video');
    v.src = fileUrl(s.video.file); v.muted = true; v.loop = true; v.playsInline = true; v.controls = true; v.preload = 'metadata';
    if (s.frame?.file) v.poster = fileUrl(s.frame.file);
    media.append(v);
  } else if (s.frame?.file) {
    const img = el('img'); img.src = fileUrl(s.frame.file); img.alt = `Cuadro de ${s.id}`; img.loading = 'lazy';
    media.append(img);
  } else {
    media.append(el('span', 'shot-empty', busyStatus(s.frame) ? 'Dibujando…' : 'Sin cuadro'));
  }
  const liveText = s.live?.video || s.live?.frame;
  if (busyStatus(s.frame) || busyStatus(s.video)) {
    const badge = el('div', 'shot-live');
    badge.append(el('span', 'spinner'), el('span', null, liveText || (busyStatus(s.video) ? 'En cola para generar…' : 'En cola…')));
    media.append(badge);
  }

  const body = el('div', 'shot-body');
  body.append(el('p', 'shot-action', s.accion));
  const meta = [s.encuadre, s.camara, s.luz].filter(Boolean).join(' · ');
  if (meta) body.append(el('p', 'muted small', meta));
  if (s.refs?.length || s.reglas?.length) {
    const chips = el('div', 'chips');
    s.refs.forEach((r) => chips.append(el('span', 'chip', r)));
    (s.reglas || []).slice(0, 3).forEach((r) => chips.append(el('span', 'chip rule', r)));
    body.append(chips);
  }
  if (s.lastChange) body.append(el('p', 'muted small', `Cambio: ${s.lastChange}`));
  if (s.video?.plan?.nota) body.append(el('p', 'muted small', `DP: ${s.video.plan.nota}`));
  const err = s.video?.status === 'error' ? s.video.error : s.frame?.status === 'error' ? s.frame.error : null;
  if (err) body.append(el('p', 'error', err));

  const actions = el('div', 'actions');
  const btn = (label, cls, fn) => {
    const b = el('button', cls, label); b.type = 'button';
    b.disabled = !cfg.story.generate;
    b.onclick = async () => {
      b.disabled = true;
      try { await fn(); await refreshProject(); } catch (e) { showError(e.message); b.disabled = false; }
    };
    actions.append(b);
    return b;
  };
  const call = (url, extra = {}) => api(url, { projectId: project.id, shotId: s.id, ...extra });

  const frameBusy = busyStatus(s.frame);
  const videoBusy = busyStatus(s.video);
  if (!s.frame?.file && !frameBusy) btn('Dibujar cuadro', 'primary', () => api('/api/story/frames', { projectId: project.id, shotIds: [s.id] }));
  if (s.frame?.file && !frameBusy && !s.approved && !videoBusy) btn('Aprobar y generar', 'primary', () => call('/api/story/shots/approve'));
  if (videoBusy || frameBusy) btn('Cancelar', 'small-btn', () => call('/api/story/shots/cancel'));
  if (s.video?.status === 'error' && s.frame?.file) btn('Reintentar video', 'primary', () => call('/api/story/shots/approve'));

  body.append(actions);

  // Pedir cambios sobre el cuadro, editar el prompt a mano, o rehacer el video con una indicación.
  if (s.frame?.file && !frameBusy && !videoBusy) {
    const more = el('details', 'shot-more');
    const key = `${s.id}`;
    const d = drafts.get(key) || {};
    more.open = !!(d.feedback || d.prompt || d.video);
    more.append(el('summary', null, s.video?.file ? 'Cambiar esta toma' : 'Pedir cambios'));
    const fb = el('textarea'); fb.rows = 2; fb.placeholder = 'Qué cambiar del cuadro (ej. "más cerca", "que mire a la ventana", "luz de atardecer")';
    fb.value = d.feedback || '';
    fb.oninput = () => drafts.set(key, { ...drafts.get(key), feedback: fb.value });
    const redo = el('button', 'small-btn', 'Redibujar el cuadro'); redo.type = 'button';
    redo.onclick = async () => {
      if (!fb.value.trim()) return fb.focus();
      redo.disabled = true;
      try { await call('/api/story/shots/revise', { feedback: fb.value }); drafts.delete(key); await refreshProject(); } catch (e) { showError(e.message); redo.disabled = false; }
    };
    more.append(fb, redo);
    const pr = el('details', 'shot-prompt');
    pr.open = !!d.prompt;
    pr.append(el('summary', 'muted small', 'Editar el prompt del cuadro a mano'));
    const pt = el('textarea'); pt.rows = 5; pt.value = d.prompt ?? s.prompt_cuadro ?? '';
    pt.oninput = () => drafts.set(key, { ...drafts.get(key), prompt: pt.value });
    const use = el('button', 'small-btn', 'Redibujar con este prompt'); use.type = 'button';
    use.onclick = async () => {
      use.disabled = true;
      try { await call('/api/story/shots/revise', { prompt: pt.value }); drafts.delete(key); await refreshProject(); } catch (e) { showError(e.message); use.disabled = false; }
    };
    pr.append(pt, use);
    more.append(pr);
    if (s.video?.file) {
      const vt = el('textarea'); vt.rows = 2; vt.placeholder = 'Indicación para rehacer el video con el mismo cuadro (ej. "cámara fija", "más lento")';
      vt.value = d.video || '';
      vt.oninput = () => drafts.set(key, { ...drafts.get(key), video: vt.value });
      const again = el('button', 'small-btn', 'Rehacer el video'); again.type = 'button';
      again.onclick = async () => {
        again.disabled = true;
        try { await call('/api/story/shots/approve', { feedback: vt.value }); drafts.delete(key); await refreshProject(); } catch (e) { showError(e.message); again.disabled = false; }
      };
      more.append(vt, again);
      if (s.video.prompt) {
        const p = el('details', 'shot-prompt');
        p.append(el('summary', 'muted small', 'Prompt del video'), el('pre', 'small', s.video.prompt));
        more.append(p);
      }
    }
    [fb, pt, redo, use].forEach((x) => { x.disabled = !cfg.story.generate; });
    body.append(more);
  }
  card.append(head, media, body);
  card.style.setProperty('--i', i);
  return card;
}

$('story-draw').onclick = async () => {
  try { await api('/api/story/frames', { projectId: project.id }); await refreshProject(); } catch (e) { showError(e.message); }
};
$('story-approve-all').onclick = async () => {
  const list = project.shots.filter((s) => s.frame?.file && s.frame.status === 'done' && !s.approved);
  if (!confirm(`Se generan ${list.length} tomas con Wan 3.0 (${cfg.story.shotSeconds} s cada una). ¿Seguimos?`)) return;
  try {
    await Promise.all(list.map((s) => api('/api/story/shots/approve', { projectId: project.id, shotId: s.id })));
    await refreshProject();
  } catch (e) { showError(e.message); }
};

// ---------- Montaje ----------
function renderEditor() {
  const wrap = $('story-edit-wrap');
  const any = project.shots.some((s) => s.video?.file) || (project.shots.some((s) => s.frame?.file) && project.timeline.music);
  wrap.hidden = !any && !project.shots.some((s) => s.approved);
  if (wrap.hidden) return;
  if (!editor) {
    editor = createStoryEditor({
      shotSeconds: cfg.story.shotSeconds,
      onOrder: (order) => api('/api/story/timeline', { projectId: project.id, order }).then((r) => { project = r.project; }).catch((e) => showError(e.message)),
      onMix: (music) => api('/api/story/timeline', { projectId: project.id, music }).then((r) => { project = r.project; }).catch((e) => showError(e.message)),
      onRemoveMusic: () => api('/api/story/timeline', { projectId: project.id, music: null }).then((r) => { project = r.project; render(); }).catch((e) => showError(e.message)),
      onMusic: async (file) => {
        if (file.size > 18 * 1024 * 1024) return showError('La música pesa más de 18 MB: probá con un MP3.');
        showError('');
        const dataUrl = await new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = () => reject(r.error); r.readAsDataURL(file); });
        // Algunos navegadores no ponen tipo a .m4a / .flac: se lo damos por la extensión.
        const ext = file.name.split('.').pop().toLowerCase();
        const fixed = dataUrl.replace(/^data:(application\/octet-stream|)?;base64,/, `data:${{ m4a: 'audio/mp4', mp3: 'audio/mpeg', wav: 'audio/wav', aac: 'audio/aac', ogg: 'audio/ogg', flac: 'audio/flac' }[ext] || 'audio/mpeg'};base64,`);
        try { project = (await api('/api/story/music', { projectId: project.id, dataUrl: fixed, name: file.name })).project; render(); } catch (e) { showError(e.message); }
      },
    });
    $('story-editor').append(editor.root);
  }
  editor.update(project);
}

// ---------- Consultas mientras algo se genera ----------
async function refreshProject() {
  if (!project) return;
  try {
    const { project: p } = await api(`/api/story/project?id=${encodeURIComponent(project.id)}`);
    if (project && p.id === project.id) { project = p; render(); }
  } catch (e) { showError(e.message); }
}
function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(() => { if (!document.hidden && document.body.dataset.tab === 'story') refreshProject(); }, POLL_MS);
}
function stopPolling() { clearInterval(pollTimer); pollTimer = 0; }
// Al volver a la pestaña (después de minutos generando), se actualiza enseguida.
document.addEventListener('visibilitychange', () => { if (!document.hidden && project && document.body.dataset.tab === 'story') refreshProject(); });

// ---------- Pestaña ----------
function onTab(tab) {
  if (tab !== 'story') { if (!editor?.busy()) editor?.pause(); return; }
  const m = /^historia\/(.+)$/.exec(location.hash.slice(1));
  if (m && (!project || project.id !== m[1])) openProject(m[1]);
  else if (!project) loadHome().catch((err) => alert(err.message));
  else refreshProject();
}
window.addEventListener('tab', (e) => onTab(e.detail));
// raw.js elige la pestaña al cargar, antes de que este módulo escuche.
if (document.body.dataset.tab === 'story') onTab('story');
