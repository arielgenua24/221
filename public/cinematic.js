import { $, el } from './shared.js';
import * as store from './cinematic-store.js';
import { resultRun, cinematicStats } from './cinematic-stats.js';

let started = false, catalog = [], turns = [], references = [], audio = null, mode = 'chat';
let generators = [], experiment = null, jobBusy = false, chatBusy = false, loadingFiles = false, historyVisible = false, pollTimer = null, preflightTimer = null, previewVersion = 0;
const error = (text = '') => { $('cinematic-error').textContent = text; $('cinematic-error').hidden = !text; };
const providerName = (p) => p === 'openrouter' ? 'OpenRouter' : 'WaveSpeed';
const money = (v) => v === null || v === undefined ? 'No informado' : `US$ ${v.toFixed(4)}`;
const button = (text, action, cls = 'small-btn') => { const b = el('button', cls, text); b.type = 'button'; b.onclick = action; return b; };
async function api(route, body) {
  const r = await fetch(`/api/lab/cinematic/${route}`, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await r.json(); if (!r.ok) throw new Error(data.error || `Error ${r.status}`); return data;
}
function save() { try { if (experiment) store.saveExperiment(experiment); else store.saveDraft(draft()); } catch (e) { error(`No se pudo guardar: ${e.message}`); } }
function draft() {
  return { name: $('cinematic-name').value, prompt: $('cinematic-prompt').value, llm: $('cinematic-llm').value, mode, generators: generators.map((g) => ({ ...g })), turns,
    duration: Number($('cinematic-duration').value), aspect: $('cinematic-aspect').value, resolution: $('cinematic-resolution').value,
    referenceMode: $('cinematic-reference-mode').value, generateAudio: $('cinematic-generate-audio').checked };
}
function payload() { return { ...draft(), references, audio }; }
function setMode(next) {
  mode = next; $('cinematic-conversation').hidden = next !== 'chat';
  $('cinematic-mode-chat').setAttribute('aria-pressed', String(next === 'chat'));
  $('cinematic-mode-prompt').setAttribute('aria-pressed', String(next === 'prompt')); save();
}
function lock() {
  const frozen = !!experiment;
  $('cinematic-editor').querySelectorAll('input, select, textarea, button').forEach((n) => { n.disabled = frozen || chatBusy || loadingFiles || jobBusy; });
  $('cinematic-add-generator').disabled ||= generators.length >= 4;
  $('cinematic-new').disabled = chatBusy || loadingFiles || jobBusy;
  $('cinematic-run').textContent = jobBusy ? 'Generando…' : frozen ? 'Pedido guardado · creá otro experimento para comparar' : 'Generar comparación';
}
function renderChat() {
  $('cinematic-chat').replaceChildren(...turns.map((t) => {
    const item = el('div', `lab-card cinematic-turn ${t.role}`);
    item.append(el('strong', 'small', t.role === 'user' ? 'Vos' : t.model || 'LLM'), el('p', null, t.text));
    if (t.role === 'assistant') item.append(el('span', 'muted small', `Conversación · ${money(t.usage?.cost)} · ${((t.ms || 0) / 1000).toFixed(1)} s`));
    if (t.role === 'assistant') item.append(button('Usar como prompt', () => { $('cinematic-prompt').value = t.text; save(); schedulePreflight(); }));
    return item;
  }));
  $('cinematic-chat').scrollTop = $('cinematic-chat').scrollHeight;
}
async function chat(final = false) {
  if (chatBusy || experiment) return;
  const text = final ? 'Prepará el prompt final para el generador de video con todas las decisiones de esta conversación. Respondé solo con el prompt final.' : $('cinematic-message').value.trim();
  if (!text) return;
  if (!$('cinematic-llm').value.trim()) return error('Elegí un LLM de OpenRouter.');
  error(); chatBusy = true;
  turns.push({ role: 'user', text }); renderChat(); save(); lock();
  try {
    const out = await api('chat', { model: $('cinematic-llm').value, turns: turns.map(({ role, text }) => ({ role, text })), references });
    turns.push({ role: 'assistant', text: out.text, model: $('cinematic-llm').value, usage: out.usage, ms: out.ms });
    $('cinematic-message').value = '';
    if (final) { $('cinematic-prompt').value = out.text; schedulePreflight(); }
    renderChat(); save();
  } catch (e) { turns.pop(); renderChat(); save(); error(e.message); }
  finally { chatBusy = false; lock(); }
}
function renderGenerators() {
  $('cinematic-generators').replaceChildren(...generators.map((g, i) => {
    const card = el('div', 'cinematic-generator');
    const row = el('div', 'lab-side-head'); row.append(el('span', 'lab-badge', 'ABCD'[i]));
    const provider = el('select'); provider.setAttribute('aria-label', `Proveedor ${'ABCD'[i]}`);
    for (const p of ['openrouter', 'wavespeed']) { const o = el('option', null, providerName(p)); o.value = p; provider.append(o); }
    provider.value = g.provider;
    const model = el('input', 'lab-model'); model.value = g.model; model.placeholder = 'Buscar modelo…';
    model.setAttribute('aria-label', `Generador ${'ABCD'[i]}`); model.setAttribute('list', `cinematic-models-${i}`);
    const list = el('datalist'); list.id = `cinematic-models-${i}`;
    list.append(...catalog.filter((m) => m.provider === g.provider).map((m) => { const o = el('option'); o.value = m.id; o.label = m.name; return o; }));
    const info = el('p', 'muted small cinematic-capabilities');
    const details = () => {
      const m = catalog.find((m) => m.provider === g.provider && m.id === g.model);
      info.textContent = m ? `${m.references ? 'Referencias' : 'Sin referencias de estilo'} · ${m.firstFrame ? 'Primer cuadro' : 'Sin primer cuadro'} · ${m.audioReference ? 'Audio de referencia' : 'Sin audio de referencia'} · ${m.generateAudio ? 'Sonido' : 'Sonido no verificado'}\n${m.resolutions.join(', ')} · ${m.aspects.join(', ')} · ${m.durations.join(', ')} s` : 'Elegí un modelo del catálogo. Se verificará antes de generar.';
    };
    provider.onchange = () => { g.provider = provider.value; g.model = ''; renderGenerators(); save(); schedulePreflight(); };
    model.oninput = () => { g.model = model.value.trim(); details(); save(); schedulePreflight(); };
    row.append(provider, button('Quitar', () => { generators.splice(i, 1); renderGenerators(); save(); schedulePreflight(); }));
    const prices = el('a', 'small', 'Ver modelo y precios'); prices.target = '_blank'; prices.rel = 'noopener noreferrer';
    const updateLink = () => { prices.href = g.provider === 'openrouter' ? `https://openrouter.ai/${g.model}` : `https://wavespeed.ai/models/${g.model}`; prices.hidden = !g.model; };
    model.addEventListener('input', updateLink); updateLink();
    card.append(row, model, list, info, prices); details(); return card;
  })); lock();
}
function renderReferences() {
  const row = $('cinematic-references'); row.replaceChildren();
  references.forEach((r, i) => {
    const card = el('figure', 'cinematic-reference'); const img = el('img'); img.src = r.url; img.alt = r.name;
    const remove = button('×', async () => { references.splice(i, 1); await saveAssets(); renderReferences(); schedulePreflight(); });
    remove.setAttribute('aria-label', `Quitar ${r.name}`); remove.disabled = !!experiment;
    card.append(img, el('figcaption', 'small', r.name), remove); row.append(card);
  });
  if (audio) {
    const card = el('div', 'cinematic-audio'); const player = el('audio'); player.controls = true; player.src = audio.url;
    const remove = button('Quitar audio', async () => { audio = null; await saveAssets(); renderReferences(); schedulePreflight(); }); remove.disabled = !!experiment;
    card.append(el('span', 'small', audio.name), player, remove); row.append(card);
  }
}
async function saveAssets() { try { await store.putAssets('draft', { references, audio }); } catch (e) { error(`No se pudieron guardar las referencias: ${e.message}`); } }
const dataUrl = (file) => new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = () => reject(new Error('No se pudo leer el archivo.')); r.readAsDataURL(file); });
async function attach(files, kind) {
  if (experiment || loadingFiles) return;
  loadingFiles = true; lock(); error();
  try {
    for (const f of files) {
      if (f.size > 15 * 1024 * 1024) throw new Error('Cada archivo puede pesar hasta 15 MB.');
      if (!f.type.startsWith(`${kind}/`)) throw new Error('El tipo de archivo no corresponde.');
      if (kind === 'image' && references.length >= 10) throw new Error('Podés agregar hasta diez imágenes.');
      const asset = { name: f.name, url: await dataUrl(f) };
      if (kind === 'audio') audio = asset; else references.push(asset);
    }
    await saveAssets(); renderReferences(); save(); schedulePreflight();
  } catch (e) { renderReferences(); error(e.message); }
  finally { loadingFiles = false; lock(); }
}
function schedulePreflight() {
  clearTimeout(preflightTimer); const version = ++previewVersion;
  if (experiment) return;
  $('cinematic-preflight').replaceChildren();
  if (!$('cinematic-prompt').value.trim() || !generators.length || generators.some((g) => !g.model)) return;
  preflightTimer = setTimeout(async () => {
    try {
      const out = await api('preflight', payload());
      if (version !== previewVersion || experiment) return;
      $('cinematic-preflight').replaceChildren(...out.results.map((r, i) => el('p', r.reason ? 'muted small' : 'small cinematic-compatible', `${'ABCD'[i]} · ${r.reason ? `Se omitirá: ${r.reason}` : 'Compatible con el pedido'}`)));
    } catch (e) { if (version === previewVersion) $('cinematic-preflight').textContent = e.message; }
  }, 400);
}
async function run() {
  if (jobBusy || chatBusy || experiment) return;
  error(); const frozen = structuredClone(payload()); jobBusy = true; lock();
  try {
    // Guardar las referencias antes de cualquier envío cobrado.
    await store.putAssets('pending', { references: frozen.references, audio: frozen.audio });
    const job = await api('run', frozen);
    experiment = { id: job.id, section: 'cinematic-videos', name: frozen.name.trim() || 'Experimento cinematográfico', createdAt: job.createdAt,
      prompt: frozen.prompt, config: { ...frozen, references: frozen.references.map(({ name }) => ({ name })), audio: frozen.audio ? { name: frozen.audio.name } : null },
      turns: structuredClone(turns), llm: frozen.llm, results: [], preference: null, notes: '', mock: job.mock };
    save(); await store.putAssets(job.id, { references: frozen.references, audio: frozen.audio }); applyJob(job);
    if (job.status === 'running') poll(job.id);
  } catch (e) { jobBusy = false; error(e.message); lock(); }
}
function applyJob(job) {
  if (experiment?.id !== job.id) return;
  const previous = JSON.stringify({ status: experiment.status, results: experiment.results });
  experiment.status = job.status; experiment.mock = job.mock;
  experiment.results = job.results.map((r) => resultRun(r, experiment.results.find((old) => old.key === r.key)));
  jobBusy = job.status === 'running'; save();
  if (previous !== JSON.stringify({ status: experiment.status, results: experiment.results })) { renderResults(); renderComparison(); }
  lock();
}
function poll(id) {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(async () => {
    if (experiment?.id !== id) return;
    try { const job = await api(`job?id=${encodeURIComponent(id)}`); applyJob(job); if (job.status === 'running') poll(id); }
    catch (e) { error(`No pude consultar el experimento: ${e.message}. Las tareas enviadas siguen en el proveedor.`); poll(id); }
  }, 2500);
}
function stars(label, key, evaluation, onChange) {
  const row = el('div', 'lab-stars'); row.append(el('span', 'small', label));
  for (let i = 1; i <= 5; i++) {
    const b = button('★', () => { evaluation[key] = evaluation[key] === i ? 0 : i; save(); onChange(); }, 'lab-star');
    b.setAttribute('aria-label', `${label}: ${i} de 5`); b.setAttribute('aria-pressed', String(i <= evaluation[key])); row.append(b);
  } return row;
}
function renderResults() {
  const root = $('cinematic-results'); root.hidden = historyVisible || !experiment;
  if (!experiment) return root.replaceChildren();
  for (const r of experiment.results) {
    let card = root.querySelector(`[data-side="${r.key}"]`);
    const signature = JSON.stringify(r);
    if (card?.dataset.signature === signature) continue;
    const oldVideo = card?.querySelector('video');
    const playback = oldVideo ? { time: oldVideo.currentTime, playing: !oldVideo.paused, muted: oldVideo.muted } : null;
    const node = el('article', 'lab-side cinematic-result'); node.dataset.side = r.key; node.dataset.status = r.status; node.dataset.signature = signature;
    const head = el('div', 'lab-side-head'); head.append(el('span', 'lab-badge', r.key), el('strong', null, r.name));
    node.append(head, el('p', 'muted small', `${providerName(r.provider)} · ${r.model}`));
    const status = { queued: 'En cola', running: 'Generando', done: 'Terminado', skipped: 'Omitido', error: 'Error', recoverable: 'Pendiente de recuperación' }[r.status];
    node.append(el('p', 'lab-status', `${status}${r.phase ? ` · ${r.phase}` : ''}`));
    if (r.error) node.append(el('p', 'small', r.error));
    if (r.file) {
      const v = oldVideo || el('video'); v.controls = true; v.playsInline = true; v.preload = 'metadata';
      if (!oldVideo) v.src = `/media/${encodeURIComponent(r.file)}`;
      if (playback) { v.muted = playback.muted; v.currentTime = playback.time; }
      node.append(v);
      const a = el('a', 'small-btn', 'Descargar video'); a.href = v.src; a.download = `${experiment.name}-${r.key}.mp4`; node.append(a);
      if (playback?.playing) v.play().catch(() => {});
    } else if (r.status === 'done' && experiment.mock) node.append(el('p', 'muted small', 'Demo: pedido simulado, sin video ni cobro.'));
    const metrics = el('dl', 'lab-metrics');
    for (const [label, value] of [['Costo real', money(r.cost)], ['Tiempo', `${(r.ms / 1000).toFixed(1)} s`], ['Tarea', r.task || '—']]) {
      const d = el('div'); d.append(el('dt', null, label), el('dd', null, value)); metrics.append(d);
    } node.append(metrics);
    if (r.status === 'recoverable' && r.task) node.append(button('Consultar tarea existente', async () => {
      try { applyJob(await api('recover', { id: experiment.id })); poll(experiment.id); } catch (e) { error(e.message); }
    }));
    if (r.status === 'done') {
      const evaluation = el('div', 'lab-eval'); const verdict = el('div', 'options lab-verdict');
      for (const [value, label] of [[true, '✓ Aprobar'], [false, '✕ Rechazar']]) {
        const b = button(label, () => { r.eval.approved = r.eval.approved === value ? null : value; save(); renderResults(); renderComparison(); }, `option ${value ? 'ok' : 'ko'}`);
        b.setAttribute('aria-pressed', String(r.eval.approved === value)); verdict.append(b);
      }
      const notes = el('textarea'); notes.rows = 2; notes.placeholder = 'Opinión sobre este resultado'; notes.setAttribute('aria-label', `Opinión ${r.key}`); notes.value = r.eval.notes;
      notes.oninput = () => { r.eval.notes = notes.value; save(); node.dataset.signature = JSON.stringify(r); };
      evaluation.append(verdict, stars('Calidad', 'quality', r.eval, renderResults), stars('Fidelidad', 'fidelity', r.eval, renderResults), notes); node.append(evaluation);
    }
    if (card) card.replaceWith(node); else root.append(node);
  }
}
function renderComparison() {
  const root = $('cinematic-comparison'); root.hidden = historyVisible || !experiment; root.replaceChildren(); if (!experiment) return;
  const outcomes = experiment.results.filter((r) => r.status === 'done');
  root.append(el('div', 'decision-label', 'Comparar y evaluar'));
  root.append(el('p', 'small', `${experiment.name} · ${experiment.config.duration} s · ${experiment.config.aspect} · ${experiment.config.resolution} · ${experiment.config.references.length} referencias`));
  const prompt = el('details'); prompt.append(el('summary', null, 'Prompt común guardado'), el('p', 'cinematic-saved-prompt', experiment.prompt)); root.append(prompt);
  const actions = el('div', 'actions compact');
  actions.append(button('Reproducir desde el inicio', () => { $('cinematic-results').querySelectorAll('video').forEach((v) => { v.currentTime = 0; v.muted = true; v.play().catch(() => {}); }); }), button('Pausar todos', () => $('cinematic-results').querySelectorAll('video').forEach((v) => v.pause())));
  if (outcomes.length) root.append(actions, el('p', 'muted small', 'La reproducción conjunta silencia los videos. Activá el sonido en un resultado para escucharlo.'));
  const options = el('div', 'options lab-pref');
  for (const [key, text] of [...outcomes.map((r) => [r.key, `Prefiero ${r.key}`]), ...(outcomes.length > 1 ? [['tie', 'Empate']] : [])]) {
    const b = button(text, () => { experiment.preference = experiment.preference === key ? null : key; save(); renderComparison(); }, 'option');
    b.setAttribute('aria-pressed', String(experiment.preference === key)); options.append(b);
  }
  if (outcomes.length) root.append(el('span', 'lab-field-label', '¿Cuál es mejor?'), options);
  const notes = el('textarea'); notes.rows = 2; notes.placeholder = 'Conclusión del experimento'; notes.setAttribute('aria-label', 'Conclusión del experimento'); notes.value = experiment.notes;
  notes.oninput = () => { experiment.notes = notes.value; save(); }; root.append(notes);
}
function renderHistory() {
  const root = $('cinematic-history'); root.replaceChildren(); const all = store.listExperiments();
  const head = el('div', 'lab-history-head'); head.append(el('h2', 'raw-section', 'Historial · Cinematic Videos'), button('Exportar evaluaciones', () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify({ section: 'cinematic-videos', experiments: all }, null, 2)], { type: 'application/json' }));
    const a = el('a'); a.href = url; a.download = 'laboratorio-cinematic-videos.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  })); root.append(head);
  if (!all.length) return root.append(el('p', 'muted', 'Todavía no hay experimentos.'));
  const wrap = el('div', 'lab-table-wrap'), table = el('table', 'lab-table');
  const header = el('tr'); ['Modelo / proveedor', 'Generaciones', 'Omitidos', 'Aprobados', 'Victorias', 'Calidad', 'Fidelidad', 'Tiempo medio', 'Costo registrado'].forEach((s) => header.append(el('th', null, s))); const thead = el('thead'); thead.append(header); table.append(thead);
  const body = el('tbody');
  for (const s of cinematicStats(all)) {
    const tr = el('tr'); [ `${providerName(s.provider)} · ${s.model}`, s.runs, s.skipped, s.approved, s.wins, s.avgQuality?.toFixed(1) || '—', s.avgFidelity?.toFixed(1) || '—', s.avgMs ? `${(s.avgMs / 1000).toFixed(1)} s` : '—', `${money(s.cost)}${s.unknownCosts ? ` + ${s.unknownCosts} sin costo informado` : ''}` ].forEach((v) => tr.append(el('td', null, v))); body.append(tr);
  } table.append(body); wrap.append(table); root.append(wrap);
  const list = el('div', 'lab-history-list');
  for (const ex of all) {
    const card = el('article', 'lab-card'); card.append(el('strong', null, ex.name), el('p', 'muted small', `${new Date(ex.createdAt).toLocaleString('es-AR')} · ${ex.results.map((r) => `${r.key}: ${providerName(r.provider)} / ${r.status}`).join(' · ')}`));
    if (ex.preference) card.append(el('p', 'small', ex.preference === 'tie' ? 'Empate' : `Ganador: ${ex.preference}`));
    const actions = el('div', 'actions compact'); actions.append(button('Abrir', () => openExperiment(ex.id)), button('Borrar evaluación local', async () => {
      if (!confirm(`¿Borrar la evaluación local de “${ex.name}”? Los videos guardados en el servidor se conservan.`)) return;
      try { await store.deleteExperiment(ex.id); if (experiment?.id === ex.id) await fresh(); renderHistory(); } catch (e) { error(e.message); }
    })); card.append(actions); list.append(card);
  } root.append(list);
}
function restore(d) {
  $('cinematic-name').value = d.name || ''; $('cinematic-prompt').value = d.prompt || ''; $('cinematic-llm').value = d.llm || 'anthropic/claude-sonnet-5.5';
  $('cinematic-duration').value = d.duration || 5; $('cinematic-aspect').value = d.aspect || '16:9'; $('cinematic-resolution').value = d.resolution || '480p';
  $('cinematic-reference-mode').value = d.referenceMode || 'references'; $('cinematic-generate-audio').checked = !!d.generateAudio;
  turns = d.turns || []; generators = d.generators?.map((g) => ({ ...g })) || [{ provider: 'openrouter', model: 'heygen/heygen-video-1' }, { provider: 'wavespeed', model: 'bytedance/seedance-2.5/text-to-video' }];
  mode = d.mode || 'chat'; renderChat(); renderGenerators(); renderReferences(); setMode(mode); lock(); schedulePreflight();
}
async function fresh() {
  clearTimeout(pollTimer); experiment = null; jobBusy = false; historyVisible = false; error(); references = []; audio = null;
  $('cinematic-results').replaceChildren(); renderResults(); renderComparison(); restore({}); await saveAssets(); save();
  $('cinematic-history').hidden = true; $('cinematic-history-toggle').setAttribute('aria-pressed', 'false'); $('cinematic-editor').hidden = false;
}
async function openExperiment(id) {
  const ex = store.listExperiments().find((x) => x.id === id); if (!ex) return;
  clearTimeout(pollTimer); experiment = ex; historyVisible = false; const assets = await store.getAssets(id).catch(() => null);
  references = assets?.references || []; audio = assets?.audio || null;
  $('cinematic-history').hidden = true; $('cinematic-history-toggle').setAttribute('aria-pressed', 'false'); $('cinematic-editor').hidden = false;
  $('cinematic-results').replaceChildren(); restore({ ...ex.config, turns: ex.turns, llm: ex.llm }); renderResults(); renderComparison();
  if (!assets && ex.config.references.length) error('Las referencias locales ya no están disponibles. El pedido original sigue guardado en el servidor.');
  try { const job = await api(`job?id=${encodeURIComponent(id)}`); applyJob(job); if (job.status === 'running') poll(id); }
  catch (e) { error(`Se muestran los datos locales: ${e.message}`); }
}
async function start() {
  if (started) return; started = true;
  const d = store.draft(); const assets = await store.getAssets('draft').catch(() => null); references = assets?.references || []; audio = assets?.audio || null; restore(d);
  try {
    const [models, llms] = await Promise.all([api('models'), fetch('/api/lab/models').then((r) => r.json())]);
    catalog = models.models;
    $('cinematic-catalog-status').textContent = `${models.mock ? 'Demo · ' : ''}${catalog.filter((m) => m.provider === 'openrouter').length} generadores de OpenRouter · ${catalog.filter((m) => m.provider === 'wavespeed').length} de WaveSpeed${models.warnings.length ? ` · ${models.warnings.join(' ')}` : ''}`;
    $('cinematic-llms').replaceChildren(...(llms.models || []).map((m) => { const o = el('option'); o.value = m.id; o.label = m.name; return o; })); renderGenerators(); schedulePreflight();
  } catch (e) { error(e.message); $('cinematic-catalog-status').textContent = 'No se pudieron cargar los catálogos.'; }
  const running = store.listExperiments().find((ex) => ex.status === 'running'); if (running) await openExperiment(running.id);
}
function routeFolder() {
  if (!/^#\/?laboratorio(?:\/|$)/.test(location.hash) && document.body.dataset.tab !== 'lab') return;
  const hash = location.hash.replace(/^#\/?/, '');
  const folder = hash.startsWith('laboratorio/') ? hash.split('/')[1] : 'home';
  const cinematic = folder === 'cinematic-videos', motion = folder === 'motion-design';
  $('lab-home').hidden = cinematic || motion; $('lab-motion-folder').hidden = !motion; $('lab-cinematic-folder').hidden = !cinematic;
  document.querySelectorAll('[data-lab-folder]').forEach((a) => { if (a.dataset.labFolder === folder) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
  // Motion Design conserva su evento y su superficie. Sus drops solo están activos en su carpeta.
  document.body.dataset.tab = motion ? 'lab' : cinematic ? 'cinematic' : 'lab-home';
  if (!motion) window.dispatchEvent(new CustomEvent('tab', { detail: cinematic ? 'cinematic' : 'lab-home' }));
  if (cinematic) start();
}
$('cinematic-mode-chat').onclick = () => setMode('chat'); $('cinematic-mode-prompt').onclick = () => setMode('prompt');
$('cinematic-chat-form').onsubmit = (e) => { e.preventDefault(); chat(); }; $('cinematic-finalize').onclick = () => chat(true);
$('cinematic-add-generator').onclick = () => { if (generators.length < 4) generators.push({ provider: 'wavespeed', model: '' }); renderGenerators(); save(); schedulePreflight(); };
$('cinematic-images').onchange = (e) => { attach([...e.target.files], 'image'); e.target.value = ''; }; $('cinematic-audio-file').onchange = (e) => { attach([...e.target.files], 'audio'); e.target.value = ''; };
$('cinematic-add-url').onclick = async () => {
  const url = prompt('URL HTTPS directa de una imagen o un audio de referencia:'); if (!url) return;
  if (!/^https:\/\/[^\s]+$/.test(url)) return error('Usá una URL HTTPS.');
  const kind = prompt('Tipo de referencia: imagen o audio', 'imagen'); if (!kind) return;
  if (kind.toLowerCase() === 'audio') audio = { name: 'Audio por URL', url };
  else if (kind.toLowerCase() === 'imagen') { if (references.length >= 10) return error('Usá hasta diez imágenes.'); references.push({ name: `Referencia ${references.length + 1}`, url }); }
  else return error('Elegí imagen o audio.');
  await saveAssets(); renderReferences(); save(); schedulePreflight();
};
for (const id of ['name', 'prompt', 'llm', 'duration', 'aspect', 'resolution', 'reference-mode', 'generate-audio']) {
  $(`cinematic-${id}`).addEventListener('input', () => { save(); schedulePreflight(); });
}
$('cinematic-run').onclick = run; $('cinematic-new').onclick = fresh;
$('cinematic-history-toggle').onclick = () => {
  const show = $('cinematic-history').hidden; historyVisible = show; $('cinematic-history').hidden = !show; $('cinematic-history-toggle').setAttribute('aria-pressed', String(show));
  $('cinematic-editor').hidden = show; $('cinematic-results').hidden = show || !experiment; $('cinematic-comparison').hidden = show || !experiment;
  if (show) renderHistory();
};
window.addEventListener('tab', ({ detail }) => { if (detail === 'lab') routeFolder(); if (!['lab', 'cinematic'].includes(detail)) $('cinematic-results').querySelectorAll('video').forEach((v) => v.pause()); });
window.addEventListener('hashchange', routeFolder);
window.addEventListener('dragover', (e) => { if (document.body.dataset.tab === 'cinematic') e.preventDefault(); });
window.addEventListener('drop', (e) => {
  if (document.body.dataset.tab !== 'cinematic') return; e.preventDefault();
  const files = [...(e.dataTransfer?.files || [])];
  const unsupported = files.some((f) => !f.type.startsWith('image/') && !f.type.startsWith('audio/'));
  if (unsupported) error('En Cinematic Videos se adjuntan imágenes y audio de referencia.');
  attach(files.filter((f) => f.type.startsWith('image/')), 'image').then(() => { const f = files.find((f) => f.type.startsWith('audio/')); if (f) attach([f], 'audio'); });
});
if (/^#\/?laboratorio(?:\/|$)/.test(location.hash)) routeFolder();
