import { el, append, addChips, fmt, decisionShell, factList, renderQuestions, answerActions } from './shared.js';
import { createPlayer } from './player.js';

// Flujo 2: edición guiada por la música. El Director orquesta y monta; el Oído escucha.

// Cuántos cuadros por video entran en el presupuesto de imágenes del Director.
export function editRequestMedia(visuals, maxFrames) {
  const photos = visuals.filter((m) => m.kind === 'photo').length;
  const videos = visuals.length - photos;
  const per = videos ? Math.max(1, Math.min(4, Math.floor((maxFrames - photos) / videos))) : 0;
  const pick = { 1: [1], 2: [0, 2], 3: [0, 1, 3], 4: [0, 1, 2, 3] }[per];
  return visuals.map((m) => ({
    id: m.id, kind: m.kind, name: m.name, duration: m.duration,
    frames: m.kind === 'video' ? pick.map((k) => m.frames[k]) : m.frames,
  }));
}

// ctx: { audio, media: Map id -> item, analysis }
export function handleEdit(ev, steps, ctx) {
  switch (ev.type) {
    case 'analysis': ctx.analysis = ev.data; return;
    case 'plan': return addChips(steps.get('plan'), (ev.data?.material || []).filter((m) => m.rol && m.rol !== 'relleno').map((m) => `${m.id} · ${m.rol}`));
    case 'map': return addChips(steps.get('ear'), (ev.data?.secciones || []).map((x) => `${x.nombre} ${fmt(Number(x.inicio) || 0)}`));
    case 'decision': if (ev.kind === 'map') renderMapDecision(ev); return;
    case 'timeline': return renderResult(ev.data, ctx);
    default:
  }
}

function renderMapDecision(ev) {
  const map = ev.map || {};
  const card = decisionShell(ev, 'Tu decisión');
  const { facts, add } = factList();
  add('La historia (Director)', ev.plan?.historia);
  add('Qué escuché', [map.resumen?.estilo, map.resumen?.animo].filter(Boolean).join(' — '));
  add('Tempo', map.grilla ? `${map.grilla.bpm} BPM · ${map.grilla.confiable ? 'pulso claro' : 'pulso libre'}${map.grilla.nota ? ` · ${map.grilla.nota}` : ''}` : null);
  add('Cómo fluye', map.arco);
  card.append(facts);
  if ((ev.versions || []).length) {
    const vs = el('div', 'versions');
    vs.append(el('strong', 'versions-title', 'Con esto el Director va a montar 3 videos:'));
    ev.versions.forEach((v) => {
      const row = el('div', 'version');
      row.append(el('span', 'version-id', v.id), el('span', 'version-name', v.nombre), el('span', 'version-what muted', v.enfoque));
      vs.append(row);
    });
    card.append(vs);
  }

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

  const answers = renderQuestions(card, ev.questions);
  answerActions(card, ev, answers, {
    placeholder: '¿Algo mal? Ej.: "el estribillo arranca en 0:45", "que la última parte sea lenta" (opcional)',
    label: 'Montar los 3 videos',
    okEcho: 'Escuchaste bien, seguí.',
  });
  append(card);
}

// Los 3 videos terminan en cualquier orden; se muestran siempre A, B, C.
function renderResult(timeline, ctx) {
  const v = timeline.version || {};
  if (!ctx.results) {
    ctx.results = append(el('div', 'results msg'));
    ctx.results.append(el('h2', 'results-title', 'Tus videos'));
  }
  const wrap = el('section', 'result');
  wrap.dataset.version = v.id || '';
  const after = [...ctx.results.querySelectorAll('.result')].find((r) => r.dataset.version > wrap.dataset.version);
  ctx.results.insertBefore(wrap, after || null);
  if (v.id) wrap.append(el('span', 'idea-num', `Video ${v.id} · ${v.nombre}`));
  wrap.append(el('h3', 'result-title', timeline.concepto || 'Tu video, cortado sobre la música'));
  wrap.append(el('p', 'muted small', `${timeline.segmentos.length} cortes en ${fmt(timeline.duracion)}${v.enfoque ? ` · ${v.enfoque}` : ''}`));
  wrap.append(createPlayer({ timeline, analysis: ctx.analysis, audioUrl: ctx.audio.url, audioName: ctx.audio.name, media: ctx.media }));
  if (timeline.nota) wrap.append(el('div', 'note', timeline.nota));
}
