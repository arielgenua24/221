// Laboratorio · registro de herramientas: todo lo que el agente hace con buscar, generar imagen, generar sonido y generar video,
// en orden y EN VIVO: aparece cuando la llamada empieza («en curso»), y al terminar muestra el resultado (miniaturas de la
// búsqueda, la imagen, un reproductor para el sonido, la toma de video), si falló, cuánto costó y tardó, y si el componente final
// lo usó. Si el modo Automático dejó un plan de herramientas por zona, arriba se compara con lo que de verdad hizo.
// Lo usan Motion Design y Context Lab.
import { el } from './shared.js';

const META = {
  buscar_referencias: { icon: '🔎', title: 'Buscó referencias', key: 'search', plan: 'search' },
  generar_imagen: { icon: '🖼️', title: 'Generó una imagen', key: 'images', plan: 'images' },
  generar_sonido: { icon: '🔊', title: 'Generó un efecto de sonido', key: 'sound', plan: 'sound' },
  generar_video: { icon: '🎬', title: 'Generó una toma de video', key: 'video', plan: 'video' },
};
const PLAN_LABEL = { search: 'Buscar referencias', images: 'Generar imagen', sound: 'Generar sonido', video: 'Generar video IA' };
const PLAN_ICON = { search: '🔎', images: '🖼️', sound: '🔊', video: '🎬' };
const money = (n) => (n < 0.01 ? n.toFixed(4) : n.toFixed(3));
const secs = (ms) => `${(ms / 1000).toFixed(1)} s`;

// resolve: cómo encontrar el material de cada llamada en el estado de la tarjeta (así el registro guardado es liviano):
//   { search(query) → { query, results }, image(id) → { id, url, prompt }, sound(id) → { id, url, prompt, duration }, video(id) → {…} }
// getCode(): el código actual del componente (para decir si usó la imagen o el sonido).
// getPlan(): { clips (con toolPlan), enabled } o null; running(): ¿el agente sigue trabajando?; active(): ¿ya hubo una ejecución?
// (antes de la primera no se muestra; después, aunque no haya usado ninguna herramienta, lo dice).
export function createToolFeed({ resolve, getCode = () => '', getPlan = () => null, running = () => false, active = () => false }) {
  const node = el('details', 'tool-feed');
  node.open = true;
  const summary = el('summary', 'tool-feed-summary');
  const planBox = el('div', 'tool-feed-plan');
  const list = el('ol', 'tool-feed-list');
  node.append(summary, planBox, list);
  let items = []; // { id, name, args, status: 'running' | 'done' | 'error', error?, cost, ms, ref? }

  const last = (name) => [...items].reverse().find((i) => i.status === 'running' && (!name || i.name === name));

  // Un evento del servidor (/api/lab/run o /api/lab/context/run).
  function handle(ev) {
    if (ev.type === 'tool') {
      items.push({ id: ev.id || `t${items.length}`, name: ev.name, args: ev.args || {}, status: 'running', cost: 0, ms: 0 });
    } else if (ev.type === 'search') {
      const it = last('buscar_referencias') || items.at(-1);
      if (it) it.ref = { kind: 'search', query: ev.query };
    } else if (ev.type === 'asset') {
      const it = last('generar_imagen') || items.at(-1);
      if (it) it.ref = { kind: 'image', id: ev.id };
    } else if (ev.type === 'sound') {
      const it = last('generar_sonido') || items.at(-1);
      if (it) it.ref = { kind: 'sound', id: ev.id };
    } else if (ev.type === 'video') {
      const it = last('generar_video') || items.at(-1);
      if (it) it.ref = { kind: 'video', id: ev.id };
    } else if (ev.type === 'tool_done') {
      const it = items.find((i) => i.id === ev.id && i.status === 'running') || last(ev.name);
      if (it) Object.assign(it, { status: ev.ok ? 'done' : 'error', error: ev.error || '', cost: ev.cost || 0, ms: ev.ms || 0 });
    } else return false;
    render();
    return true;
  }

  function used(it) {
    const code = getCode() || '';
    if (!code || !it.ref) return null;
    if (it.ref.kind === 'image' || it.ref.kind === 'sound') return code.includes(it.ref.id);
    return null; // buscar no entra en el código; el video va en su propia capa
  }

  function body(it) {
    const box = el('div', 'tool-feed-body');
    const a = it.args || {};
    if (it.name === 'buscar_referencias') {
      box.append(el('p', 'small', `Buscó «${a.consulta || ''}»`));
      const found = it.ref ? resolve.search?.(it.ref.query) : null;
      if (found?.results?.length) {
        const strip = el('div', 'thumbs');
        found.results.forEach((r) => {
          const t = el(r.link ? 'a' : 'div', 'thumb');
          if (r.link) { t.href = r.link; t.target = '_blank'; t.rel = 'noopener noreferrer'; }
          t.title = `${r.id} · ${r.title}`;
          const img = el('img'); img.src = r.thumb; img.alt = r.title;
          t.append(img);
          strip.append(t);
        });
        box.append(strip);
      }
    } else if (it.name === 'generar_imagen') {
      box.append(el('p', 'small', a.prompt || ''));
      if (a.imagenes?.length) box.append(el('p', 'muted small', `Partió de: ${a.imagenes.join(', ')}`));
      const img = it.ref ? resolve.image?.(it.ref.id) : null;
      if (img) { const i = el('img', 'tool-feed-img'); i.src = img.url; i.alt = img.prompt || ''; box.append(i); }
    } else if (it.name === 'generar_sonido') {
      box.append(el('p', 'small', `${a.descripcion || ''}${a.duracion ? ` · ${a.duracion} s` : ''}`));
      const snd = it.ref ? resolve.sound?.(it.ref.id) : null;
      if (snd) { const au = el('audio'); au.controls = true; au.preload = 'none'; au.src = snd.url; box.append(au); }
    } else if (it.name === 'generar_video') {
      box.append(el('p', 'small', `Zona ${a.zona || '?'}${a.imagen ? ` · partió de ${a.imagen}` : ''}: ${a.prompt || ''}`));
      const v = it.ref ? resolve.video?.(it.ref.id) : null;
      if (v) {
        if (v.kind === 'video') { const vd = el('video', 'tool-feed-img'); vd.src = v.url; vd.controls = true; vd.muted = true; vd.preload = 'metadata'; box.append(vd); }
        else { const i = el('img', 'tool-feed-img'); i.src = v.url; i.alt = 'toma (demo)'; box.append(i); }
        box.append(el('p', 'muted small', `${v.model ? `${v.model} · ` : ''}va en su propia capa, entre el video original y la animación.`));
      }
    }
    return box;
  }

  function renderPlan() {
    planBox.replaceChildren();
    const plan = getPlan();
    if (!plan?.clips) { planBox.hidden = true; return; }
    const uses = plan.clips.flatMap((c) => (c.toolPlan || []).map((u) => ({ ...u, zone: c.id }))).filter((u) => !plan.enabled || plan.enabled[u.tool]);
    if (!uses.length) { planBox.hidden = true; return; }
    planBox.hidden = false;
    const okBy = {}; // llamadas que salieron bien, por herramienta
    items.filter((i) => i.status === 'done').forEach((i) => { const k = META[i.name]?.plan; if (k) okBy[k] = (okBy[k] || 0) + 1; });
    const seen = {};
    const ul = el('ul', 'tool-feed-planlist');
    uses.forEach((u) => {
      seen[u.tool] = (seen[u.tool] || 0) + 1;
      const done = seen[u.tool] <= (okBy[u.tool] || 0);
      const li = el('li');
      const badge = done ? '✓ lo hizo' : running() ? 'pendiente' : 'no lo usó';
      li.append(el('span', null, PLAN_ICON[u.tool] || '•'), el('strong', 'small', `${u.zone} · ${PLAN_LABEL[u.tool] || u.tool}`), el('span', 'muted small', `${u.at.toFixed(1)} s`), el('span', 'small tool-feed-plannote', u.note || ''), el('span', `badge tool-feed-badge ${done ? 'ok' : ''}`, badge));
      ul.append(li);
    });
    planBox.append(el('p', 'muted small', 'Plan del editor (modo Automático) vs. lo que hizo:'), ul);
  }

  function render() {
    list.replaceChildren();
    const count = (name, st) => items.filter((i) => i.name === name && (!st || i.status === st)).length;
    const failed = items.filter((i) => i.status === 'error').length;
    const live = items.some((i) => i.status === 'running');
    const total = items.reduce((s, i) => s + (i.cost || 0), 0);
    node.hidden = !items.length && !active();
    summary.textContent = items.length
      ? `Herramientas · ${count('buscar_referencias')} búsq. · ${count('generar_imagen')} img. · ${count('generar_sonido')} sonido${count('generar_sonido') === 1 ? '' : 's'} · ${count('generar_video')} toma${count('generar_video') === 1 ? '' : 's'}${failed ? ` · ${failed} con error` : ''}${total ? ` · US$ ${money(total)}` : ''}${live ? ' · trabajando…' : ''}`
      : running() ? 'Herramientas · todavía no usó ninguna…' : 'Herramientas · no usó ninguna';
    renderPlan();
    items.forEach((it) => {
      const m = META[it.name] || { icon: '🛠️', title: it.name };
      const li = el('li', `tool-feed-item ${it.status}`);
      const head = el('div', 'tool-feed-head');
      const state = it.status === 'running' ? '⏳ en curso…' : it.status === 'error' ? '✗ falló' : '✓';
      head.append(el('span', null, m.icon), el('strong', null, m.title), el('span', `badge tool-feed-badge ${it.status}`, state));
      const u = used(it);
      if (u !== null) head.append(el('span', `badge tool-feed-badge ${u ? 'ok' : 'warn'}`, u ? 'la usó en el código' : 'no la usó en el código'));
      if (it.status !== 'running') head.append(el('span', 'muted small tool-feed-meta', [it.ms ? secs(it.ms) : '', it.cost ? `US$ ${money(it.cost)}` : ''].filter(Boolean).join(' · ')));
      li.append(head, body(it));
      if (it.status === 'error') li.append(el('p', 'small tool-feed-error', it.error || 'La herramienta devolvió un error.'));
      list.append(li);
    });
  }

  return {
    node, handle, render,
    get: () => items.map((i) => ({ ...i, args: { ...i.args } })),
    // Al reabrir un experimento: el registro guardado (lo que quedó «en curso» se interrumpió).
    set: (saved) => { items = (saved || []).map((i) => ({ ...i, status: i.status === 'running' ? 'error' : i.status, error: i.status === 'running' ? 'se interrumpió' : i.error })); render(); },
    reset: () => { items = []; render(); },
  };
}
