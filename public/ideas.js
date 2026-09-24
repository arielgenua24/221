import { el, append, addChips, decide, decisionShell, factList, renderQuestions, answerActions } from './shared.js';

// Flujo 1: ideas de contenido a partir de fotos + texto.
const FORMAT_LABEL = { reel_ia: 'Reel (video IA)', carrusel: 'Carrusel', imagen: 'Imagen' };

export function handleIdeas(ev, steps) {
  switch (ev.type) {
    case 'concepts': return addChips(steps.get('ideation'), (ev.data || []).map((c) => `${c.id} · ${c.titulo}`));
    case 'decision':
      if (ev.kind === 'brief') return renderBriefDecision(ev);
      if (ev.kind === 'pick') return renderPickDecision(ev);
      return;
    case 'ideas': return renderIdeas(ev.ideas, ev.note);
    default:
  }
}

function renderBriefDecision(ev) {
  const b = ev.brief || {};
  const card = decisionShell(ev, 'Tu decisión · 1 de 2');
  const { facts, add } = factList();
  add('Negocio', [b.negocio?.rubro, b.negocio?.que_ofrece].filter(Boolean).join(' — '));
  add('Público', b.publico?.quien);
  add('Nivel de consciencia', b.nivel_consciencia);
  add('Tono', b.personalidad_marca?.tono);
  add('Supuestos', b.supuestos);
  card.append(facts);
  const answers = renderQuestions(card, ev.questions);
  answerActions(card, ev, answers, { placeholder: '¿Algo que corregir o agregar? (opcional)', label: 'Continuar', okEcho: 'Está bien así, sigan.' });
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
