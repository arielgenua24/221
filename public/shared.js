// Piezas de la interfaz compartidas por los dos flujos (ideas y edición).
export const $ = (id) => document.getElementById(id);
export const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = text;
  return n;
};
export const fmt = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;

// ---------- Feed: seguir al final solo si el usuario ya está abajo ----------
const feed = $('feed');
let stick = true;
feed.addEventListener('scroll', () => { stick = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 120; });
export const follow = () => { if (stick) feed.scrollTop = feed.scrollHeight; };
export function append(node) { feed.append(node); stick = true; follow(); return node; }

export function showError(msg) { const e = $('error'); e.textContent = msg || ''; e.hidden = !msg; }

// ---------- Tarjetas de agentes ----------
const INITIAL = { Orquestador: 'O', Investigador: 'I', Crítico: 'C', Director: 'D', 'Oído': '♪', 'Análisis': '∿' };

// Pasos que corren en paralelo: van juntos en un grupo.
const GROUPS = [
  { prefix: 'research-', role: 'Investigador', title: 'Investigadores trabajando en paralelo' },
  { prefix: 'montage-', role: 'Director', title: 'El Director monta 3 versiones en paralelo' },
];

export function createSteps() {
  const steps = new Map();
  const groups = new Map();
  return {
    get: (step) => steps.get(step),
    all: () => [...steps.values()],
    start({ step, role, title, model }) {
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
      const g = GROUPS.find((x) => step.startsWith(x.prefix));
      if (g) {
        if (!groups.has(g.prefix)) {
          const box = append(el('div', 'group msg'));
          const head = el('div', 'group-head');
          head.append(el('span', `dot ${g.role}`, INITIAL[g.role]), el('div', 'agent-title', g.title));
          box.append(head);
          groups.set(g.prefix, box);
        }
        groups.get(g.prefix).append(node);
        follow();
      } else {
        append(node);
      }
      steps.set(step, { node, body, live, status, sub, thought: '' });
    },
  };
}

export function setStatus(s, state) {
  s.status.className = `status ${state}`;
  s.status.textContent = state === 'ok' ? '✓' : state === 'fail' ? '✕' : '';
}

export function addChips(s, labels) {
  if (!s || !labels.length) return;
  const chips = el('div', 'chips');
  labels.forEach((l) => chips.append(el('span', 'chip', l)));
  s.node.append(chips);
}

// Eventos comunes a todos los flujos. Devuelve true si lo manejó.
export function handleCommon(ev, steps) {
  const s = steps.get(ev.step);
  switch (ev.type) {
    case 'step_start': steps.start(ev); return true;
    case 'delta': if (s) { s.body.textContent += ev.text; follow(); } return true;
    case 'reasoning':
      if (s) { s.thought = (s.thought + ev.text).slice(-300); s.live.textContent = s.thought.replace(/\s+/g, ' ').trim(); }
      return true;
    case 'progress': if (s) s.live.textContent = `Redactando… ${ev.chars.toLocaleString('es')} caracteres`; return true;
    case 'notice': if (s) s.node.append(el('div', 'notice', ev.text)); return true;
    case 'step_end':
      if (s) { setStatus(s, 'ok'); s.live.textContent = ''; s.node.open = false; s.sub.textContent = 'Listo · tocá para ver sus notas'; }
      return true;
    case 'step_error': if (s) { setStatus(s, 'fail'); s.node.append(el('div', 'notice', ev.text)); } return true;
    case 'decision_done': { const d = document.querySelector(`[data-decision="${ev.id}"]`); if (d) lockDecision(d); return true; }
    case 'usage': $('usage').textContent = ev.cost ? `US$ ${ev.cost.toFixed(3)}` : `${ev.tokens.toLocaleString('es')} tokens`; return true;
    case 'error': showError(ev.text); append(el('div', 'msg note', `Se cortó el trabajo: ${ev.text}`)); return true;
    case 'ping': case 'run': case 'done': return true;
    default: return false;
  }
}

// Lee la respuesta NDJSON del servidor y pasa cada evento a `onEvent`.
export async function streamEvents(url, body, signal, onEvent) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Error ${res.status}`);
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
      if (line.trim()) onEvent(JSON.parse(line));
    }
  }
}

// ---------- Decisiones del humano ----------
export async function decide(card, id, answer, echo) {
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

export function lockDecision(card) {
  card.classList.add('done');
  card.querySelectorAll('button, textarea, input').forEach((b) => { b.disabled = true; });
}

export function decisionShell(ev, label) {
  const card = el('section', 'decision msg');
  card.dataset.decision = ev.id;
  const head = el('div');
  head.append(el('div', 'decision-label', label), el('h3', null, ev.title));
  card.append(head);
  return card;
}

export function factList() {
  const facts = el('div', 'facts');
  const add = (label, value) => {
    if (!value || (Array.isArray(value) && !value.length)) return;
    const f = el('div', 'fact');
    f.append(el('strong', null, label), document.createTextNode(Array.isArray(value) ? value.join(' · ') : value));
    facts.append(f);
  };
  return { facts, add };
}

// Preguntas con opciones para tocar (una respuesta por pregunta). Devuelve el mapa de respuestas.
export function renderQuestions(card, questions) {
  const answers = new Map();
  (questions || []).forEach((q) => {
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
  return answers;
}

// Botón principal + comentario libre; arma la respuesta { respuestas, comentario } o null si no tocó nada.
export function answerActions(card, ev, answers, { placeholder, label, okEcho }) {
  const comment = el('textarea');
  comment.rows = 2;
  comment.placeholder = placeholder;
  card.append(comment);
  const actions = el('div', 'actions');
  const go = el('button', 'primary', label);
  go.type = 'button';
  go.onclick = () => {
    const respuestas = [...answers].map(([pregunta, respuesta]) => ({ pregunta, respuesta }));
    const comentario = comment.value.trim();
    const empty = !respuestas.length && !comentario;
    const echo = empty ? okEcho : [...respuestas.map((r) => r.respuesta), comentario].filter(Boolean).join(' · ');
    decide(card, ev.id, empty ? null : { respuestas, comentario }, echo);
  };
  actions.append(go);
  card.append(actions);
}
