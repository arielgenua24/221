const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = text;
  return n;
};

const MAX_SIDE = 1280;
const FORMAT_LABEL = { reel_ia: 'Reel (video IA)', carrusel: 'Carrusel', imagen: 'Imagen' };
const feed = $('feed');
const input = $('text');
let maxPhotos = 8;
let photos = [];
let controller = null;
let steps = new Map();
let group = null;

// ---------- Configuración ----------
fetch('/api/config').then((r) => r.json()).then((cfg) => {
  maxPhotos = cfg.maxPhotos;
  const mode = $('mode');
  mode.textContent = cfg.mock ? 'Demo' : 'En vivo';
  mode.title = `Orquestador: ${cfg.orchestratorModel}\nInvestigador: ${cfg.researcherModel}\nCrítico: ${cfg.criticModel}`;
  if (cfg.mock) mode.classList.add('demo');
});

// ---------- Scroll: seguir al final solo si el usuario ya está abajo ----------
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
document.querySelectorAll('.example').forEach((b) => b.addEventListener('click', () => {
  input.value = b.dataset.text; autosize(); updateSend(); input.focus();
}));

function updateSend() {
  const running = !!controller;
  $('send-icon').toggleAttribute('hidden', running);
  $('stop-icon').toggleAttribute('hidden', !running);
  $('send').title = running ? 'Detener' : 'Enviar';
  $('send').disabled = !running && !input.value.trim() && !photos.length;
}
updateSend();

function showError(msg) { const e = $('error'); e.textContent = msg || ''; e.hidden = !msg; }

// ---------- Fotos ----------
function resize(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, MAX_SIDE / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(img.src);
      resolve(canvas.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = () => reject(new Error(`No pude leer ${file.name}`));
    img.src = URL.createObjectURL(file);
  });
}

$('file').addEventListener('change', async (e) => {
  for (const file of [...e.target.files].filter((f) => f.type.startsWith('image/'))) {
    if (photos.length >= maxPhotos) { showError(`Máximo ${maxPhotos} fotos.`); break; }
    try { photos.push(await resize(file)); } catch (err) { showError(err.message); }
  }
  e.target.value = '';
  renderThumbs();
});

function renderThumbs() {
  const box = $('thumbs');
  box.replaceChildren();
  photos.forEach((src, i) => {
    const t = el('div', 'thumb');
    const img = el('img');
    img.src = src; img.alt = `Foto ${i + 1}`;
    const x = el('button', null, '×');
    x.type = 'button'; x.setAttribute('aria-label', 'Quitar foto');
    x.onclick = () => { photos.splice(i, 1); renderThumbs(); };
    t.append(img, x);
    box.append(t);
  });
  updateSend();
}

// ---------- Enviar / detener ----------
$('form').addEventListener('submit', (e) => {
  e.preventDefault();
  if (controller) { controller.abort(); return; }
  const text = input.value.trim();
  if (!text && !photos.length) return;
  run(text, photos);
});

async function run(text, sentPhotos) {
  $('welcome')?.remove();
  showError('');
  steps = new Map();
  group = null;

  const msg = append(el('div', 'msg user-msg'));
  if (sentPhotos.length) {
    const ph = el('div', 'user-photos');
    sentPhotos.forEach((src) => { const i = el('img'); i.src = src; i.alt = ''; ph.append(i); });
    msg.append(ph);
  }
  if (text) msg.append(el('div', 'bubble', text));

  input.value = ''; autosize();
  photos = []; renderThumbs();
  controller = new AbortController();
  updateSend();

  try {
    const res = await fetch('/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, photos: sentPhotos }),
      signal: controller.signal,
    });
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
        if (line.trim()) handle(JSON.parse(line));
      }
    }
  } catch (e) {
    if (e.name === 'AbortError') append(el('div', 'msg note', 'Detuviste el trabajo del equipo.'));
    else showError(e.message);
  } finally {
    steps.forEach((s) => { if (s.status.classList.contains('running')) setStatus(s, 'fail'); });
    feed.querySelectorAll('.decision:not(.done)').forEach(lockDecision);
    controller = null;
    updateSend();
  }
}

// ---------- Eventos del arnés ----------
function handle(ev) {
  const s = steps.get(ev.step);
  switch (ev.type) {
    case 'step_start': return startStep(ev);
    case 'delta': if (s) { s.body.textContent += ev.text; follow(); } return;
    case 'reasoning':
      if (s) { s.thought = (s.thought + ev.text).slice(-300); s.live.textContent = s.thought.replace(/\s+/g, ' ').trim(); }
      return;
    case 'progress': if (s) s.live.textContent = `Redactando… ${ev.chars.toLocaleString('es')} caracteres`; return;
    case 'notice': if (s) s.node.append(el('div', 'notice', ev.text)); return;
    case 'step_end':
      if (s) { setStatus(s, 'ok'); s.live.textContent = ''; s.node.open = false; s.sub.textContent = 'Listo · tocá para ver sus notas'; }
      return;
    case 'step_error': if (s) { setStatus(s, 'fail'); s.node.append(el('div', 'notice', ev.text)); } return;
    case 'concepts': return addChips('ideation', (ev.data || []).map((c) => `${c.id} · ${c.titulo}`));
    case 'decision': return renderDecision(ev);
    case 'decision_done': { const d = feed.querySelector(`[data-decision="${ev.id}"]`); if (d) lockDecision(d); return; }
    case 'ideas': return renderIdeas(ev.ideas, ev.note);
    case 'usage': $('usage').textContent = ev.cost ? `US$ ${ev.cost.toFixed(3)}` : `${ev.tokens.toLocaleString('es')} tokens`; return;
    case 'error': showError(ev.text); append(el('div', 'msg note', `Se cortó el trabajo: ${ev.text}`)); return;
    default:
  }
}

const INITIAL = { Orquestador: 'O', Investigador: 'I', Crítico: 'C' };

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

  if (step.startsWith('research-')) {
    if (!group) {
      group = append(el('div', 'group msg'));
      const head = el('div', 'group-head');
      head.append(el('span', 'dot Investigador', 'I'), el('div', 'agent-title', 'Investigadores trabajando en paralelo'));
      group.append(head);
    }
    group.append(node);
    follow();
  } else {
    append(node);
  }
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

// ---------- Decisiones del humano ----------
async function decide(card, id, answer, echo) {
  card.querySelectorAll('button, textarea, input').forEach((b) => { b.disabled = true; });
  try {
    const res = await fetch('/api/decide', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, answer }) });
    if (!res.ok) throw new Error((await res.json()).error);
    lockDecision(card);
    const msg = append(el('div', 'msg user-msg'));
    msg.append(el('div', 'bubble', echo));
  } catch (e) {
    showError(e.message);
    card.querySelectorAll('button, textarea, input').forEach((b) => { b.disabled = false; });
  }
}

function lockDecision(card) {
  card.classList.add('done');
  card.querySelectorAll('button, textarea, input').forEach((b) => { b.disabled = true; });
}

function decisionShell(ev, label) {
  const card = el('section', 'decision msg');
  card.dataset.decision = ev.id;
  const head = el('div');
  head.append(el('div', 'decision-label', label), el('h3', null, ev.title));
  card.append(head);
  return card;
}

function toggleGroup(buttons, pressed) {
  buttons.forEach((b) => b.setAttribute('aria-pressed', String(b === pressed && b.getAttribute('aria-pressed') !== 'true')));
}

function renderDecision(ev) {
  if (ev.kind === 'brief') return renderBriefDecision(ev);
  if (ev.kind === 'pick') return renderPickDecision(ev);
}

function renderBriefDecision(ev) {
  const b = ev.brief || {};
  const card = decisionShell(ev, 'Tu decisión · 1 de 2');
  const facts = el('div', 'facts');
  const fact = (label, value) => {
    if (!value || (Array.isArray(value) && !value.length)) return;
    const f = el('div', 'fact');
    f.append(el('strong', null, label), document.createTextNode(Array.isArray(value) ? value.join(' · ') : value));
    facts.append(f);
  };
  fact('Negocio', [b.negocio?.rubro, b.negocio?.que_ofrece].filter(Boolean).join(' — '));
  fact('Público', b.publico?.quien);
  fact('Nivel de consciencia', b.nivel_consciencia);
  fact('Tono', b.personalidad_marca?.tono);
  fact('Supuestos', b.supuestos);
  card.append(facts);

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
        toggleGroup(buttons, btn);
        if (btn.getAttribute('aria-pressed') === 'true') answers.set(q.pregunta, o); else answers.delete(q.pregunta);
      };
      return btn;
    });
    opts.append(...buttons);
    box.append(opts);
    card.append(box);
  });

  const comment = el('textarea');
  comment.rows = 2;
  comment.placeholder = '¿Algo que corregir o agregar? (opcional)';
  card.append(comment);

  const actions = el('div', 'actions');
  const go = el('button', 'primary', 'Continuar');
  go.type = 'button';
  go.onclick = () => {
    const respuestas = [...answers].map(([pregunta, respuesta]) => ({ pregunta, respuesta }));
    const comentario = comment.value.trim();
    const empty = !respuestas.length && !comentario;
    const echo = empty ? 'Está bien así, sigan.' : [...respuestas.map((r) => r.respuesta), comentario].filter(Boolean).join(' · ');
    decide(card, ev.id, empty ? null : { respuestas, comentario }, echo);
  };
  actions.append(go);
  card.append(actions);
  append(card);
}

function renderPickDecision(ev) {
  const card = decisionShell(ev, 'Tu decisión · 2 de 2');
  card.append(el('p', 'muted small', 'Marcamos las 4 mejor puntuadas por el crítico. Tocá para cambiar la selección.'));
  const selected = new Set(ev.suggested || []);
  const list = el('div', 'concepts');
  const go = el('button', 'primary');
  go.type = 'button';
  const refresh = () => {
    go.textContent = selected.size ? `Continuar con ${selected.size}` : 'Elegí al menos una';
    go.disabled = !selected.size;
  };

  (ev.concepts || []).forEach((c) => {
    const item = el('button', 'concept');
    item.type = 'button';
    item.setAttribute('aria-pressed', String(selected.has(c.id)));
    const score = el('span', 'score', c.max ? `${c.total}/${c.max}` : '');
    item.append(el('span', 'check', '✓'), el('span', 'concept-title', `${c.id} · ${c.titulo}`), score);
    if (c.subtitulo) item.append(el('span', 'concept-sub', c.subtitulo));
    const tags = el('span', 'tags');
    [c.funcion, FORMAT_LABEL[c.formato] || c.formato].filter(Boolean).forEach((t) => tags.append(el('span', 'tag', t)));
    item.append(tags);
    if (c.veredicto) item.append(el('span', 'concept-verdict', `Crítico: ${c.veredicto}`));
    item.onclick = () => {
      if (selected.has(c.id)) selected.delete(c.id); else selected.add(c.id);
      item.setAttribute('aria-pressed', String(selected.has(c.id)));
      refresh();
    };
    list.append(item);
  });
  card.append(list);

  const comment = el('textarea');
  comment.rows = 2;
  comment.placeholder = 'Indicaciones para la versión final (opcional)';
  card.append(comment);

  const actions = el('div', 'actions');
  go.onclick = () => {
    const ids = [...selected];
    const comentario = comment.value.trim();
    decide(card, ev.id, { ids, comment: comentario }, `Me quedo con ${ids.join(', ')}${comentario ? ` · ${comentario}` : ''}`);
  };
  const auto = el('button', 'ghost', 'Que decida el equipo');
  auto.type = 'button';
  auto.onclick = () => decide(card, ev.id, null, 'Decidan ustedes.');
  actions.append(go, auto);
  card.append(actions);
  refresh();
  append(card);
}

// ---------- Resultado ----------
function renderIdeas(ideas, note) {
  const wrap = append(el('section', 'msg'));
  wrap.append(el('h2', 'results-title', `Listo: ${ideas?.length || 0} ideas de contenido`));
  const box = el('div', 'ideas');
  (ideas || []).forEach((idea, i) => {
    const card = el('article', 'idea');
    card.style.animationDelay = `${i * 80}ms`;
    card.append(el('span', 'idea-num', `Idea ${i + 1}`), el('h3', null, idea.titulo), el('p', 'sub', idea.subtitulo));
    const tags = el('div', 'tags');
    [idea.funcion, FORMAT_LABEL[idea.formato] || idea.formato, idea.nivel_consciencia && `Consciencia ${idea.nivel_consciencia}`, idea.emocion]
      .filter(Boolean).forEach((t) => tags.append(el('span', 'tag', t)));
    card.append(tags);

    const det = el('details');
    det.append(el('summary', null, 'Ver detalle'));
    const dl = el('dl');
    const row = (k, v) => {
      if (!v || (Array.isArray(v) && !v.length)) return;
      dl.append(el('dt', null, k), el('dd', null, Array.isArray(v) ? v.map((x, j) => `${j + 1}. ${x}`).join('\n') : v));
    };
    row('Ángulo', idea.angulo);
    if (idea.hook) row('Hook', [idea.hook.visual && `Visual: ${idea.hook.visual}`, idea.hook.texto && `Texto: ${idea.hook.texto}`, idea.hook.verbal && `Voz: ${idea.hook.verbal}`].filter(Boolean).join('\n'));
    row('Desarrollo', idea.desarrollo);
    row('Caption', idea.caption);
    row('Por qué funciona', idea.por_que);
    row('Producción', idea.produccion);
    det.append(dl);
    card.append(det);
    box.append(card);
  });
  wrap.append(box);
  if (note) append(el('div', 'msg note', note));
}
