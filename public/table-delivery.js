import { el, streamEvents } from './shared.js';
import { SHOT_PARTS, version, specOf, resultOf, eachPart, findPart, snapshot, productionCost } from './table-core.js';
import { createPlayer } from './table-player.js';

// Mesa de agentes · la entrega de producción. Cada toma (S1, S2…) trae sus partes y cada parte es una tarjeta:
//   ▶ RUN: ejecuta exactamente esa especificación (imagen, voz o sonido al instante; el video, después de aprobarlo)
//   💬 feedback: el humano le habla al dueño de la parte, aunque la mesa ya haya terminado; si cambia algo, es una versión nueva
//   ‹ › versiones: cada una guarda su resultado.
// El estado vive en la sesión (table.js la guarda); acá solo se dibuja y se llama al servidor.
const LABEL = { cuadro: 'Cuadro', voz: 'Voz', sonido: 'Sonido', video: 'Video', musica: 'Música' };
const ICON = { cuadro: '▦', voz: '“”', sonido: '♪', video: '▶', musica: '♫' };
const MEDIA = { cuadro: 'image', voz: 'voice', sonido: 'sound', musica: 'sound' };
const ENGINE_LABEL = { wan: 'Wan 3.0 Prime', heygen: 'HeyGen Video 1' };
const money = (v) => `US$ ${(Number(v) || 0).toFixed(v > 0 && v < 0.1 ? 3 : 2)}`;
const keyOf = (shot, kind) => `${shot?.id || 'M'}:${kind}`;
const button = (text, action, cls = 'small-btn') => { const b = el('button', cls, text); b.type = 'button'; b.onclick = action; return b; };
const plain = (t) => String(t || '').replace(/\[[^\]]{1,30}\]\s*/g, '').trim();

export function pickDuration(durations, want, max = 6) {
  const allowed = [...new Set(durations || [])].filter((d) => d >= 1 && d <= max).sort((a, b) => a - b);
  if (!allowed.length) return want;
  return allowed.find((d) => d >= want) ?? allowed.at(-1);
}

export function createDelivery(ctx) {
  // ctx: session(), persist(session), refreshCost(), error(text), agentOf(seat), labelOf(seat), payload(extra), fileData(), config(), preview({ url, kind, title })
  let box = null, mountedFor = null, playerBox = null, player = null, poller = null;
  const nodes = new Map();
  const drafts = new Map();
  const open = new Set();
  const approving = new Map(); // key → { engine, duration, sync }
  const busy = new Map(); // key → { kind: 'run' | 'talk', text }

  const S = () => ctx.session();
  const prod = () => S().final?.production;
  const cfg = () => ctx.config() || {};
  const shotOf = (id) => prod()?.shots.find((s) => s.id === id) || null;

  function estimateOf(kind, spec, shot) {
    const c = cfg().costs;
    if (!c || !spec) return null;
    if (kind === 'cuadro') return c.image + (spec.referencias?.length || 0) * c.imageReference;
    if (kind === 'voz') return Math.max(0.005, (spec.texto.length / 1000) * c.voicePer1k);
    if (kind === 'sonido' || kind === 'musica') return c.sound;
    if (kind === 'video') return spec.modelo === 'heygen' ? null : c.videoPerSecond * (shot?.duracion || 5);
    return null;
  }

  // Imagen de la mesa por código (para las referencias de un cuadro): archivos del humano o piezas generadas.
  function refData(code) {
    if (/^G\d+$/.test(code)) return S().assets?.find((a) => a.code === code)?.url || null;
    return ctx.fileData()[code] || null;
  }

  // ---------- Tarjetas ----------
  function specView(kind, spec, shot) {
    const wrap = el('div', 'prod-spec');
    const chips = el('div', 'prod-chips');
    const chip = (t) => chips.append(el('span', 'table-tag', t));
    let text = spec.prompt;
    if (kind === 'cuadro') { chip(spec.proporcion); if (spec.referencias?.length) chip(`parte de ${spec.referencias.join(', ')}`); }
    if (kind === 'voz') { chip(spec.personaje); chip(`voz ${spec.voz}`); chip(`estabilidad ${spec.estabilidad}`); text = spec.texto; }
    if (kind === 'sonido' || kind === 'musica') { chip(spec.tipo === 'musica' ? 'música' : spec.tipo); chip(`${spec.duracion} s`); if (spec.loop) chip('loop'); }
    if (kind === 'video') { chip(ENGINE_LABEL[spec.modelo] || spec.modelo); chip(`${shot?.duracion || 5} s · 480p`); }
    const body = el('p', `prod-prompt${kind === 'voz' ? ' quote' : ''}`, text);
    body.title = 'Tocá para ver todo';
    body.onclick = () => body.classList.toggle('open');
    wrap.append(chips, body);
    return wrap;
  }

  function resultView(kind, part, shot) {
    const v = version(part);
    const r = v.result;
    const wrap = el('div', 'prod-result');
    const b = busy.get(keyOf(shot, kind));
    if (kind === 'video' && v.job && !r) {
      const j = v.job;
      if (j.status === 'running') wrap.append(el('p', 'prod-status', `Generando el video con ${ENGINE_LABEL[j.engine] || j.engine}… ${j.phase ? `(${j.phase})` : ''}`));
      else if (j.status === 'recoverable') {
        wrap.append(el('p', 'prod-status error', `Se cortó: ${j.error || 'sin detalle'}`), button('Retomar (no se vuelve a cobrar)', () => recoverVideo(shot, part)));
      } else if (['error', 'skipped'].includes(j.status)) wrap.append(el('p', 'prod-status error', `${j.status === 'skipped' ? 'No se generó' : 'Falló'}: ${j.error || 'sin detalle'}`));
    }
    if (b?.kind === 'run') wrap.append(el('p', 'prod-status', b.text));
    if (!r) { if (!wrap.childNodes.length) wrap.append(el('p', 'muted small', kind === 'video' ? 'Sin video: se genera solo cuando lo aprobás.' : 'Todavía no se corrió.')); return wrap; }
    if (r.from) wrap.append(el('span', 'table-tag done', `de la mesa: ${r.from}`));
    if (!r.url) { wrap.append(el('p', 'muted small', r.demo ? 'Demo: no se genera el archivo (en la película se ve el cuadro animado).' : 'Sin archivo.')); return wrap; }
    if (kind === 'cuadro') {
      const img = el('img', 'prod-media'); img.src = r.url; img.alt = `Cuadro de ${shot.id}`; img.loading = 'lazy';
      img.onclick = () => ctx.preview({ kind: 'image', url: r.url, title: `${shot.id} · cuadro` });
      wrap.append(img);
    } else if (kind === 'video') {
      const video = el('video', 'prod-media'); video.src = r.url; video.controls = true; video.playsInline = true; video.preload = 'metadata';
      const frame = resultOf(shot.parts.cuadro); if (frame?.url) video.poster = frame.url;
      wrap.append(video);
    } else {
      const audio = el('audio'); audio.src = r.url; audio.controls = true; audio.preload = 'metadata';
      wrap.append(audio);
    }
    wrap.append(el('p', 'muted small prod-meta', [r.model, r.cost ? money(r.cost) : null, r.demo ? 'demo' : null].filter(Boolean).join(' · ')));
    return wrap;
  }

  function threadView(key, kind, part, shot) {
    const agent = ctx.agentOf(part.owner);
    const panel = el('div', 'prod-thread');
    for (const m of part.thread) {
      const msg = el('div', `prod-msg ${m.role}`);
      msg.append(el('strong', 'small', m.role === 'user' ? 'Vos' : agent.name || part.owner));
      msg.append(el('p', null, m.text));
      if (m.version) msg.append(el('span', 'table-tag done', `→ versión ${m.version}`));
      panel.append(msg);
    }
    const b = busy.get(key);
    if (b?.kind === 'talk') { const live = el('div', 'prod-msg agent live'); live.append(el('strong', 'small', agent.name || part.owner), el('p', null, b.text || 'Pensando…')); panel.append(live); }
    const form = el('form', 'prod-say');
    const text = el('textarea'); text.rows = 2; text.maxLength = 4000; text.value = drafts.get(key) || '';
    text.placeholder = kind === 'video' ? `Decile a ${agent.name || part.owner} cómo querés que se mueva la toma…` : `Decile a ${agent.name || part.owner} qué cambiar de esta parte…`;
    text.setAttribute('aria-label', `Mensaje para ${agent.name || part.owner} sobre ${LABEL[kind]}${shot ? ` de ${shot.id}` : ''}`);
    text.dataset.key = key;
    text.oninput = () => drafts.set(key, text.value);
    text.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && matchMedia('(pointer: fine)').matches) { e.preventDefault(); form.requestSubmit(); } });
    const send = el('button', 'small-btn', 'Enviar'); send.type = 'submit'; send.disabled = !!b;
    form.append(text, send);
    form.onsubmit = (e) => { e.preventDefault(); talk(shot, kind, part, text.value); };
    panel.append(form);
    return panel;
  }

  function approvalView(key, shot, part) {
    const engines = cfg().video?.engines || [];
    const spec = specOf(part);
    const st = approving.get(key);
    const frame = resultOf(shot.parts.cuadro);
    const voice = resultOf(shot.parts.voz);
    const panel = el('div', 'prod-approve');
    panel.append(el('strong', 'small', 'Aprobar el video de esta toma'));
    if (!engines.length) panel.append(el('p', 'error small', cfg().video?.available ? 'No se pudo leer el catálogo de video.' : 'El video no está disponible en este servidor (faltan claves).'));
    const list = el('div', 'prod-engines');
    for (const e of engines) {
      const row = el('label', `prod-engine${e.ok ? '' : ' off'}`);
      const radio = el('input'); radio.type = 'radio'; radio.name = `eng-${key}`; radio.value = e.id; radio.checked = st.engine === e.id; radio.disabled = !e.ok;
      radio.onchange = () => { st.engine = e.id; st.duration = pickDuration(e.durations, shot.duracion); refresh(key); };
      const note = !e.ok ? e.reason : e.perSecond ? `≈ ${money(e.perSecond * pickDuration(e.durations, shot.duracion))}` : 'costo según OpenRouter, al terminar';
      row.append(radio, el('span', null, e.label), el('span', 'muted small', note));
      list.append(row);
    }
    panel.append(list);
    const engine = engines.find((e) => e.id === st.engine);
    if (engine) {
      const durs = (engine.durations.length ? engine.durations : [shot.duracion]).filter((d) => d <= (cfg().limits?.shotMax || 6));
      const sel = el('select');
      for (const d of durs) { const o = el('option', null, `${d} s`); o.value = d; o.selected = d === st.duration; sel.append(o); }
      sel.onchange = () => { st.duration = Number(sel.value); };
      const dl = el('label', 'lab-field small', 'Duración'); dl.append(sel); panel.append(dl);
      if (engine.aspects.length && !engine.aspects.includes(prod().proporcion)) panel.append(el('p', 'error small', `${engine.label} no admite el formato ${prod().proporcion}.`));
      if (engine.audioReference && voice?.url) {
        const sync = el('label', 'lab-inline small'); const box = el('input'); box.type = 'checkbox'; box.checked = st.sync; box.onchange = () => { st.sync = box.checked; };
        sync.append(box, ' Sincronizar con la voz de la toma (labios)'); panel.append(sync);
      }
    }
    const start = el('div', 'prod-from');
    if (frame?.url) { const img = el('img'); img.src = frame.url; img.alt = 'Primer cuadro'; start.append(img, el('span', 'small', `Arranca de este cuadro · 480p · ${spec.modelo === st.engine ? '' : 'motor cambiado · '}prompt: ${spec.prompt.slice(0, 120)}${spec.prompt.length > 120 ? '…' : ''}`)); }
    else start.append(el('p', 'error small', 'El video arranca del cuadro de la toma: corré primero el cuadro.'));
    panel.append(start);
    const est = engine?.perSecond ? engine.perSecond * st.duration : null;
    const actions = el('div', 'actions compact');
    const go = button(`Aprobar y generar${est ? ` · ≈ ${money(est)}` : ''}`, () => startVideo(shot, part, { ...st }), 'primary');
    go.disabled = !engine?.ok || !frame?.url || busy.has(key);
    actions.append(go, button('Cancelar', () => { approving.delete(key); refresh(key); }));
    panel.append(actions);
    return panel;
  }

  function partCard(shot, kind) {
    const part = kind === 'musica' ? prod().musica : shot.parts[kind];
    const key = keyOf(shot, kind);
    const card = el('section', `prod-part kind-${kind}`);
    card.dataset.key = key;
    if (!part) {
      card.classList.add('empty');
      card.append(el('div', 'prod-part-head small', `${ICON[kind]} ${LABEL[kind]}`), el('p', 'muted small', kind === 'voz' ? 'Esta toma no lleva voz.' : 'Sin sonido propio.'));
      return card;
    }
    card.style.setProperty('--seat', `var(--seat-${part.owner.toLowerCase()})`);
    const v = version(part);
    const head = el('div', 'prod-part-head');
    head.append(el('span', 'prod-kind', `${ICON[kind]} ${LABEL[kind]}`));
    const owner = el('span', 'prod-owner small'); owner.append(el('b', null, part.owner), ` ${ctx.agentOf(part.owner).name || ''}`); owner.title = 'Dueño de esta parte: responde tu feedback';
    head.append(owner);
    if (part.versions.length > 1) {
      const nav = el('span', 'prod-versions small');
      const prev = button('‹', () => { part.current = Math.max(0, part.current - 1); ctx.persist(S()); refreshShot(shot); }); prev.disabled = part.current === 0; prev.setAttribute('aria-label', 'Versión anterior');
      const next = button('›', () => { part.current = Math.min(part.versions.length - 1, part.current + 1); ctx.persist(S()); refreshShot(shot); }); next.disabled = part.current === part.versions.length - 1; next.setAttribute('aria-label', 'Versión siguiente');
      nav.append(prev, ` v${part.current + 1}/${part.versions.length} `, next);
      head.append(nav);
    }
    card.append(head, specView(kind, v.spec, shot), resultView(kind, part, shot));
    const actions = el('div', 'actions compact prod-actions');
    const b = busy.get(key);
    const running = kind === 'video' && v.job?.status === 'running';
    if (kind === 'video') {
      const run = button(v.result ? '▶ Volver a generar' : '▶ RUN · aprobar video', () => {
        if (approving.has(key)) approving.delete(key);
        else { const engine = (cfg().video?.engines || []).find((e) => e.id === v.spec.modelo && e.ok) || (cfg().video?.engines || []).find((e) => e.ok); approving.set(key, { engine: engine?.id || v.spec.modelo, duration: pickDuration(engine?.durations, shot.duracion), sync: false }); }
        refresh(key);
      }, 'small-btn prod-run');
      run.disabled = !!b || running;
      actions.append(run);
    } else {
      const est = estimateOf(kind, v.spec, shot);
      const run = button(`${v.result ? '▶ Volver a correr' : '▶ RUN'}${est ? ` · ≈ ${money(est)}` : ''}`, () => runPart(shot, kind, part), 'small-btn prod-run');
      run.disabled = !!b || !cfg().media;
      if (!cfg().media) run.title = 'Hace falta WAVESPEED_API_KEY en el servidor.';
      actions.append(run);
    }
    const talkBtn = button(`💬 ${open.has(key) ? 'Cerrar' : `Hablar con ${ctx.agentOf(part.owner).name || part.owner}`}${part.thread.length ? ` (${part.thread.length})` : ''}`, () => { if (open.has(key)) open.delete(key); else open.add(key); refresh(key, true); });
    actions.append(talkBtn);
    card.append(actions);
    if (kind === 'video' && approving.has(key)) card.append(approvalView(key, shot, part));
    if (open.has(key)) card.append(threadView(key, kind, part, shot));
    return card;
  }

  function shotNode(shot) {
    const node = el('article', 'prod-shot');
    node.dataset.shot = shot.id;
    const head = el('div', 'prod-shot-head');
    head.append(el('span', 'lab-badge', shot.id), el('strong', null, shot.titulo), el('span', 'muted small', `${shot.duracion} s`));
    node.append(head);
    if (shot.descripcion) node.append(el('p', 'small prod-shot-desc', shot.descripcion));
    const grid = el('div', 'prod-parts');
    for (const kind of SHOT_PARTS) { const card = partCard(shot, kind); nodes.set(keyOf(shot, kind), card); grid.append(card); }
    node.append(grid);
    return node;
  }

  // Redibuja una tarjeta sin perder el borrador ni el foco del cuadro de texto.
  function refresh(key, focusThread = false) {
    const old = nodes.get(key);
    if (!old || !prod()) return;
    const [id, kind] = key.split(':');
    const shot = kind === 'musica' ? null : shotOf(id);
    const hadFocus = old.contains(document.activeElement) && document.activeElement.tagName === 'TEXTAREA';
    const card = partCard(shot, kind);
    old.replaceWith(card); nodes.set(key, card);
    if (hadFocus || (focusThread && open.has(key))) card.querySelector('.prod-say textarea')?.focus({ preventScroll: !focusThread });
    renderSummary();
  }
  const refreshShot = (shot) => SHOT_PARTS.forEach((k) => refresh(keyOf(shot, k)));

  // ---------- RUN: imagen, voz, sonido ----------
  async function runPart(shot, kind, part) {
    const key = keyOf(shot, kind);
    const session = S();
    const v = version(part);
    const refs = {};
    if (kind === 'cuadro') for (const code of v.spec.referencias || []) refs[code] = refData(code);
    busy.set(key, { kind: 'run', text: 'Enviando a WaveSpeed…' });
    refresh(key);
    try {
      let result = null, failure = null;
      await streamEvents('/api/lab/table/run', JSON.stringify({ kind: MEDIA[kind], spec: v.spec, aspect: session.final.production.proporcion, refs }), undefined, (ev) => {
        if (ev.type === 'status') { busy.get(key).text = `Generando ${LABEL[kind].toLowerCase()}… (${ev.status})`; refresh(key); }
        else if (ev.type === 'done') result = ev.result;
        else if (ev.type === 'error') failure = ev.error;
      });
      if (failure) throw new Error(failure);
      if (!result) throw new Error('la respuesta se cortó');
      v.result = { ...result, at: Date.now() };
      ctx.persist(session);
    } catch (e) {
      ctx.error(`${shot ? `${shot.id} · ` : ''}${LABEL[kind]}: ${e.message}`);
    } finally {
      busy.delete(key);
      if (S() === session) { refresh(key); if (kind === 'cuadro' && shot) refresh(keyOf(shot, 'video')); }
      ctx.refreshCost();
    }
  }

  // ---------- Video: aprobación → tarea persistente → consulta ----------
  async function startVideo(shot, part, st) {
    const key = keyOf(shot, 'video');
    const session = S();
    const v = version(part);
    const frame = resultOf(shot.parts.cuadro);
    const voice = resultOf(shot.parts.voz);
    busy.set(key, { kind: 'run', text: 'Enviando la toma…' });
    refresh(key);
    try {
      const res = await fetch('/api/lab/table/video', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ engine: st.engine, prompt: v.spec.prompt, duration: st.duration, aspect: session.final.production.proporcion, image: frame?.url, audio: voice?.url, sync: st.sync }) });
      const job = await res.json();
      if (!res.ok) throw new Error(job.error || `Error ${res.status}`);
      v.job = { id: job.id, engine: st.engine, duration: st.duration, estimate: job.estimate, status: 'running', phase: '', error: null, at: Date.now() };
      applyJob(v, job);
      approving.delete(key);
      ctx.persist(session);
      watch();
    } catch (e) {
      ctx.error(`${shot.id} · video: ${e.message}`);
    } finally {
      busy.delete(key);
      if (S() === session) refresh(key);
    }
  }

  function applyJob(v, job) {
    const r = job.results?.[0] || {};
    if (job.status === 'error') { v.job.status = 'error'; v.job.error = job.error; return; }
    v.job.status = ['done', 'error', 'skipped', 'recoverable'].includes(r.status) ? r.status : 'running';
    v.job.phase = r.phase || '';
    v.job.error = r.error || null;
    // WaveSpeed no informa el costo del video: queda el estimado (OpenRouter sí lo informa). En demo no se cobra nada.
    if (r.status === 'done') v.result = { url: r.file ? `/media/${r.file}` : null, demo: !!job.mock, model: r.name || r.model, cost: job.mock ? 0 : Number.isFinite(r.cost) && r.cost > 0 ? r.cost : v.job.estimate || 0, at: Date.now() };
  }

  async function recoverVideo(shot, part) {
    const v = version(part);
    try {
      const res = await fetch('/api/lab/table/video/recover', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: v.job.id }) });
      const job = await res.json();
      if (!res.ok) throw new Error(job.error || `Error ${res.status}`);
      v.job.status = 'running'; applyJob(v, job); ctx.persist(S()); watch();
    } catch (e) { ctx.error(`${shot.id} · video: ${e.message}`); }
    refresh(keyOf(shot, 'video'));
  }

  const pendingJobs = () => (prod() ? eachPart(prod()).filter(({ kind }) => kind === 'video').flatMap(({ shot, part }) => part.versions.filter((v) => v.job?.status === 'running').map((v) => ({ shot, v }))) : []);
  function watch() {
    if (poller || !pendingJobs().length) return;
    poller = setInterval(async () => {
      const list = pendingJobs();
      if (!list.length) { clearInterval(poller); poller = null; return; }
      const session = S();
      for (const { shot, v } of list) {
        try {
          const res = await fetch(`/api/lab/table/video?id=${encodeURIComponent(v.job.id)}`);
          const job = await res.json();
          if (!res.ok) throw new Error(job.error || `Error ${res.status}`);
          applyJob(v, job);
        } catch (e) { v.job.phase = `sin respuesta: ${e.message}`; }
        if (S() === session) refresh(keyOf(shot, 'video'));
      }
      ctx.persist(session);
      ctx.refreshCost();
    }, 4000);
  }

  // ---------- Feedback: el dueño de la parte responde y, si cambia algo, devuelve una versión nueva ----------
  async function talk(shot, kind, part, raw) {
    const text = String(raw || '').trim();
    const key = keyOf(shot, kind);
    if (!text || busy.has(key)) return;
    const session = S();
    part.thread.push({ role: 'user', text, at: Date.now() });
    drafts.delete(key);
    busy.set(key, { kind: 'talk', text: '' });
    ctx.persist(session);
    refresh(key, true);
    const see = [];
    if (kind === 'cuadro' && resultOf(part)?.url) see.push(resultOf(part).url);
    if (kind === 'video' && resultOf(shot.parts.cuadro)?.url) see.push(resultOf(shot.parts.cuadro).url);
    try {
      let done = null, failure = null;
      const body = ctx.payload({ kind: 'part', production: snapshot(session.final.production), part: { kind, shot: shot?.id, owner: part.owner, spec: specOf(part), thread: part.thread.map(({ role, text: t }) => ({ role, text: t })), see: see.filter((u) => u.startsWith('/media/')), duration: shot?.duracion } });
      await streamEvents('/api/lab/table/turn', JSON.stringify(body), undefined, (ev) => {
        if (ev.type === 'delta') { busy.get(key).text += ev.text; const live = nodes.get(key)?.querySelector('.prod-msg.live p'); if (live) live.textContent = busy.get(key).text; }
        else if (ev.type === 'done') done = ev;
        else if (ev.type === 'error') failure = ev.error;
      });
      if (failure) throw new Error(failure);
      if (!done) throw new Error('la respuesta se cortó');
      const msg = { role: 'agent', text: done.reply, usage: done.usage, model: done.model, at: Date.now() };
      if (done.spec) {
        part.versions.push({ spec: done.spec, result: null, job: null, at: Date.now(), by: 'feedback' });
        part.current = part.versions.length - 1;
        msg.version = part.versions.length;
      }
      part.thread.push(msg);
      ctx.persist(session);
    } catch (e) {
      part.thread.pop();
      drafts.set(key, text);
      ctx.error(`${ctx.labelOf(part.owner)} no pudo responder: ${e.message}`);
    } finally {
      busy.delete(key);
      if (S() === session) refresh(key, true);
      ctx.refreshCost();
    }
  }

  // ---------- Acciones de toda la entrega ----------
  async function runMany(kinds) {
    const list = eachPart(prod()).filter(({ kind, part, shot }) => kinds.includes(kind) && !resultOf(part) && !busy.has(keyOf(shot, kind)));
    if (!list.length) return ctx.error('No queda nada de eso por correr.');
    const total = list.reduce((s, { kind, part, shot }) => s + (estimateOf(kind, specOf(part), shot) || 0), 0);
    if (!confirm(`Correr ${list.length} parte${list.length > 1 ? 's' : ''} por ≈ ${money(total)}?`)) return;
    const queue = [...list];
    const worker = async () => { while (queue.length) { const { shot, kind, part } = queue.shift(); await runPart(shot, kind, part); } };
    await Promise.all([worker(), worker()]);
  }

  async function approveAll() {
    const engines = cfg().video?.engines || [];
    const list = prod().shots.filter((s) => { const v = version(s.parts.video); return !v.result && v.job?.status !== 'running' && resultOf(s.parts.cuadro)?.url; });
    const blocked = prod().shots.filter((s) => !resultOf(s.parts.cuadro)?.url).map((s) => s.id);
    if (!list.length) return ctx.error(blocked.length ? `Primero corré los cuadros (${blocked.join(', ')}): cada video arranca de su cuadro.` : 'No queda ningún video por generar.');
    const plan = list.map((s) => {
      const spec = specOf(s.parts.video);
      const engine = engines.find((e) => e.id === spec.modelo && e.ok) || engines.find((e) => e.ok);
      return { shot: s, engine, duration: pickDuration(engine?.durations, s.duracion) };
    });
    if (plan.some((p) => !p.engine)) return ctx.error('No hay ningún motor de video disponible.');
    const total = plan.reduce((sum, p) => sum + (p.engine.perSecond ? p.engine.perSecond * p.duration : 0), 0);
    const heygen = plan.filter((p) => !p.engine.perSecond).length;
    if (!confirm(`¿Aprobás ${plan.length} video${plan.length > 1 ? 's' : ''} (480p)?\n${plan.map((p) => `${p.shot.id} · ${p.engine.label} · ${p.duration} s`).join('\n')}\n\nCosto estimado: ≈ ${money(total)}${heygen ? ` + ${heygen} de HeyGen (lo informa OpenRouter)` : ''}${blocked.length ? `\n\nSin cuadro todavía (no se generan): ${blocked.join(', ')}` : ''}`)) return;
    for (const p of plan) await startVideo(p.shot, p.shot.parts.video, { engine: p.engine.id, duration: p.duration, sync: false });
  }

  function markdown() {
    const p = prod();
    const lines = [`# ${p.titulo}`, '', p.resumen, '', `**Estilo:** ${p.estilo}`, `**Formato:** ${p.proporcion}`, ''];
    if (p.personajes.length) lines.push('## Personajes', '', ...p.personajes.map((c) => `- **${c.nombre}** (voz ${c.voz || '—'}): ${c.descripcion}`), '');
    const part = (kind, x, shot) => {
      if (!x) return [];
      const s = specOf(x), r = resultOf(x);
      const body = kind === 'voz' ? `${s.personaje} · voz ${s.voz}: «${s.texto}»` : kind === 'video' ? `${ENGINE_LABEL[s.modelo]} · ${shot?.duracion} s: ${s.prompt}` : kind === 'cuadro' ? s.prompt : `${s.tipo} · ${s.duracion} s${s.loop ? ' · loop' : ''}: ${s.prompt}`;
      return [`- **${LABEL[kind]}** (${ctx.labelOf(x.owner)}${x.versions.length > 1 ? ` · v${x.current + 1}` : ''}): ${body}${r?.url ? ` — [resultado](${new URL(r.url, location.href).href})` : ''}`];
    };
    for (const s of p.shots) lines.push(`## ${s.id} · ${s.titulo} (${s.duracion} s)`, '', s.descripcion, '', ...SHOT_PARTS.flatMap((k) => part(k, s.parts[k], s)), '');
    if (p.musica) lines.push('## Música', '', ...part('musica', p.musica), '');
    if (p.pendientes.length) lines.push('## Pendientes', '', ...p.pendientes.map((x) => `- ${x}`), '');
    return lines.join('\n');
  }

  // ---------- Montaje ----------
  let summary = null;
  function renderSummary() {
    if (!summary || !prod()) return;
    const p = prod();
    const parts = eachPart(p);
    const done = parts.filter(({ part }) => resultOf(part)).length;
    summary.textContent = `${p.shots.length} toma${p.shots.length > 1 ? 's' : ''} · ${p.shots.reduce((s, x) => s + x.duracion, 0)} s · ${done} de ${parts.length} partes listas · producido: ${money(productionCost(p))}`;
  }

  function mount(target) {
    box = target;
    const session = S();
    const f = session.final;
    const id = `${session.id}:${f.at}`;
    if (mountedFor === id && box.querySelector('.prod')) { renderSummary(); return; }
    mountedFor = id;
    nodes.clear(); player?.stop(); player = null;
    const p = f.production;
    const root = el('div', 'prod');
    const head = el('div', 'lab-side-head');
    head.append(el('strong', null, 'Entrega de producción'));
    const reasons = { consensus: 'la mesa llegó a un acuerdo antes de tiempo', rounds: `se usaron las ${session.maxRounds} rondas`, forced: 'cerraste la mesa' };
    head.append(el('span', 'muted small', `Relator: ${f.model} · ${money(f.usage?.cost)} · se cerró porque ${reasons[f.reason] || 'terminó'}`));
    root.append(head);
    const intro = el('div', 'prod-intro');
    intro.append(el('h3', null, p.titulo));
    if (p.resumen) intro.append(el('p', null, p.resumen));
    if (p.estilo) intro.append(el('p', 'muted small', `Estilo: ${p.estilo}`));
    if (p.personajes.length) {
      const cast = el('div', 'prod-chips');
      p.personajes.forEach((c) => { const t = el('span', 'table-tag', `${c.nombre}${c.voz ? ` · voz ${c.voz}` : ''}`); t.title = c.descripcion; cast.append(t); });
      intro.append(cast);
    }
    summary = el('p', 'small prod-summary');
    intro.append(summary);
    root.append(intro);
    const tools = el('div', 'actions compact prod-toolbar');
    tools.append(
      button('▶ Ver la película', () => togglePlayer(), 'primary'),
      button('Correr cuadros que faltan', () => runMany(['cuadro'])),
      button('Correr voces, sonidos y música', () => runMany(['voz', 'sonido', 'musica'])),
      button('Aprobar videos que faltan', () => approveAll()),
      button('Copiar todo', () => navigator.clipboard?.writeText(markdown())),
      button('Descargar (.md)', () => ctx.download(markdown())),
    );
    root.append(tools);
    playerBox = el('div', 'prod-player-box'); playerBox.hidden = true;
    root.append(playerBox);
    const shots = el('div', 'prod-shots');
    p.shots.forEach((s) => shots.append(shotNode(s)));
    root.append(shots);
    if (p.musica) {
      const music = el('article', 'prod-shot prod-music');
      const mh = el('div', 'prod-shot-head'); mh.append(el('span', 'lab-badge', '♫'), el('strong', null, 'Música de toda la pieza'));
      const card = partCard(null, 'musica'); nodes.set(keyOf(null, 'musica'), card);
      music.append(mh, card);
      root.append(music);
    }
    if (p.pendientes.length) {
      const pend = el('div', 'prod-pending');
      pend.append(el('strong', 'small', 'Pendientes de la mesa'));
      const ul = el('ul', 'small'); p.pendientes.forEach((x) => ul.append(el('li', null, x)));
      pend.append(ul);
      root.append(pend);
    }
    box.replaceChildren(root);
    renderSummary();
    // Reabrir la página no corta los videos: se siguen consultando. Lo que estaba corriendo en el navegador (imagen, voz, sonido), sí.
    watch();
  }

  function togglePlayer() {
    if (!playerBox) return;
    if (!playerBox.hidden) { player?.stop(); player = null; playerBox.hidden = true; playerBox.replaceChildren(); return; }
    playerBox.hidden = false;
    player = createPlayer(playerBox, prod());
    playerBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  return { mount, stop: () => { player?.stop(); }, focus: (shotId, kind) => { const n = nodes.get(`${shotId || 'M'}:${kind}`); n?.scrollIntoView({ behavior: 'smooth', block: 'center' }); }, findPart: (shotId, kind) => findPart(prod(), shotId, kind) };
}
