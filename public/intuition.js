import { el, fmt, append, addChips, showError, createSteps, handleCommon, streamEvents, decide, decisionShell } from './shared.js';
import { openVideo, framesAt, loadReference, recordSegment } from './media.js';
import { createMotionPlayer } from './intuition-player.js';

// Flujo 3: ✨ Intuition. Un video + hasta 3 clips (≤ 5 s) con pedido y referencias →
// el Director de Arte arma un sistema visual y, por clip: un Motion Designer escribe el motion como código,
// el Director de Video IA dirige una toma generada, o el Director de Fotografía lleva el clip real a nivel cine (Cinematic Pro).

const COLORS = ['#ff5a1f', '#3b82f6', '#10b981'];
const FILMSTRIP = 10;

// ---------- Estudio: elegir el video, marcar los clips y escribir el pedido de cada uno ----------
// `mount` (opcional): contenedor propio donde dibujarlo (el Laboratorio lo reutiliza); sin él, va al feed del Estudio.
// `onError` (opcional): dónde mostrar los errores; `label`: el rótulo de la tarjeta.
export function createStudio({ limits, onChange, mount = null, onError = showError, label = '✨ Intuition' }) {
  const lim = { maxClips: 3, maxClipSeconds: 5, minClipSeconds: 0.5, minCineSeconds: 1.2, clipFrames: 6, maxRefs: 4, aiVideo: false, videoModels: [], defaultVideoModel: 'seedance', cine: false, refilm: false, refilmModels: ['Wan 3.0 Prime', 'Seedance 2.5'], refilmResolution: '480p', ...limits };
  let video = null; // { file, url, name, duration, width, height, el }
  let loading = false;
  let clips = []; // { key, id, start, end, prompt, notes, mode: 'motion' | 'ai' | 'cine', videoModel, refs: [{ key, kind, name, frames, thumb, status }] }
  let seq = 0;
  let card = null;

  const setLimits = (l) => Object.assign(lim, l);
  // Cinematic Pro re-filma el clip: el modelo pide al menos 1 s de video de referencia.
  const minLen = (c) => (c.mode === 'cine' ? lim.minCineSeconds : lim.minClipSeconds);

  async function setVideo(file) {
    loading = true;
    onChange();
    try {
      const url = URL.createObjectURL(file);
      const v = await openVideo(url).catch((err) => { URL.revokeObjectURL(url); throw err; });
      if (v.duration < lim.minClipSeconds) throw new Error('el video es demasiado corto');
      const strip = await framesAt(v, Array.from({ length: FILMSTRIP }, (_, i) => ((i + 0.5) / FILMSTRIP) * v.duration), 160, 0.6);
      video = { file, url, name: file.name, duration: v.duration, width: v.videoWidth, height: v.videoHeight, reader: v, strip };
      clips = [];
      render();
    } catch (err) {
      onError(`${file.name}: ${err.message}`);
    } finally {
      loading = false;
      onChange();
    }
  }

  // Siempre ordenados en el tiempo: C1 es el primero que aparece en el video.
  function renumber() {
    clips.sort((a, b) => a.start - b.start);
    clips.forEach((c, i) => { c.id = `C${i + 1}`; c.color = COLORS[i % COLORS.length]; });
  }

  // Límites de un clip para no pisar a sus vecinos.
  function room(c) {
    const i = clips.indexOf(c);
    return { lo: i > 0 ? clips[i - 1].end : 0, hi: i < clips.length - 1 ? clips[i + 1].start : video.duration };
  }

  function addClipAt(t) {
    if (clips.length >= lim.maxClips) return onError(`Máximo ${lim.maxClips} clips.`);
    if (clips.some((c) => t >= c.start && t < c.end)) return onError('Ya hay un clip en ese momento: mové el cursor a otra parte del video.');
    const next = clips.filter((c) => c.start > t).sort((a, b) => a.start - b.start)[0];
    const hi = Math.min(video.duration, next ? next.start : video.duration);
    let start = t;
    let end = Math.min(hi, t + 3);
    if (end - start < lim.minClipSeconds) { start = Math.max(0, end - 3); end = hi; }
    const prev = clips.filter((c) => c.end <= t).sort((a, b) => b.end - a.end)[0];
    start = Math.max(start, prev ? prev.end : 0);
    if (end - start < lim.minClipSeconds) return onError('No queda lugar para un clip ahí.');
    onError('');
    clips.push({ key: ++seq, start, end, prompt: '', notes: '', mode: 'motion', videoModel: lim.defaultVideoModel, refs: [] });
    renumber();
    refreshClips();
    onChange();
  }

  function missing() {
    if (loading) return 'Leyendo el video…';
    if (!video) return 'Soltá un video; se conserva su formato original.';
    if (!clips.length) return `Marcá al menos un clip en el video (máximo ${lim.maxClips}, de hasta ${lim.maxClipSeconds} s).`;
    if (clips.some((c) => c.refs.some((r) => r.status === 'loading'))) return 'Preparando las referencias…';
    const short = clips.find((c) => c.end - c.start < minLen(c) - 0.01);
    if (short) return `El clip ${short.id.replace('C', '')} es de Cinematic Pro: tiene que durar al menos ${lim.minCineSeconds} s (estiralo en la línea de tiempo).`;
    return null;
  }

  function hint() {
    const why = missing();
    if (why) return why;
    return `Listo: ${clips.length} clip${clips.length > 1 ? 's' : ''} en ${video.name}. Escribí abajo la dirección general (opcional) y enviá.`;
  }

  // ---------- Interfaz ----------
  let preview; let track; let playhead; let cardsBox; let addBtn;

  function render() {
    if (!video) return;
    if (!card && mount) card = mount;
    if (!card) {
      document.getElementById('welcome')?.remove();
      card = append(el('section', 'studio msg'));
    }
    card.replaceChildren();

    const headRow = el('div', 'studio-head');
    const title = el('div');
    title.append(el('div', 'decision-label', label), el('h3', null, 'Marcá dónde va el motion design'));
    const change = el('label', 'ghost small studio-change');
    const input = el('input');
    input.type = 'file'; input.accept = 'video/*'; input.hidden = true;
    input.onchange = () => { if (input.files[0]) setVideo(input.files[0]); input.value = ''; };
    change.append(input, document.createTextNode('Cambiar video'));
    headRow.append(title, change);

    const meta = el('p', 'muted small', `${video.name} · ${fmt(video.duration)} · ${video.width}×${video.height} · formato original`);

    preview = el('video', 'studio-video');
    preview.style.aspectRatio = `${video.width} / ${video.height}`;
    preview.style.setProperty('--video-aspect', video.width / video.height);
    preview.src = video.url; preview.controls = true; preview.playsInline = true; preview.preload = 'auto';

    // Línea de tiempo con cuadros de fondo, los clips marcados y el cursor.
    const tl = el('div', 'studio-tl');
    const strip = el('div', 'studio-strip');
    video.strip.forEach((f) => { const i = el('img'); i.src = f.url; i.alt = ''; strip.append(i); });
    track = el('div', 'studio-track');
    playhead = el('div', 'studio-playhead');
    tl.append(strip, track, playhead);
    tl.addEventListener('pointerdown', (e) => {
      if (e.target !== track && e.target !== tl && !strip.contains(e.target)) return;
      const r = tl.getBoundingClientRect();
      preview.currentTime = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * video.duration;
    });
    preview.addEventListener('timeupdate', movePlayhead);
    preview.addEventListener('seeked', movePlayhead);

    addBtn = el('button', 'primary', '+ Marcar clip acá');
    addBtn.type = 'button';
    addBtn.onclick = () => addClipAt(preview.currentTime || 0);
    const addRow = el('div', 'actions');
    addRow.append(addBtn);

    cardsBox = el('div', 'clip-cards');
    card.append(headRow, meta, preview, tl, el('p', 'muted small studio-help', `Poné el video en el momento donde querés el motion y tocá "Marcar clip acá". Arrastrá el clip o sus bordes para ajustarlo (máx. ${lim.maxClipSeconds} s cada uno, hasta ${lim.maxClips}).`), addRow, cardsBox);
    refreshClips();
  }

  // Solo lo que depende de los clips (el video y su línea de tiempo no se rehacen).
  function refreshClips() {
    addBtn.disabled = clips.length >= lim.maxClips;
    addBtn.textContent = clips.length >= lim.maxClips ? `Ya marcaste ${lim.maxClips} clips` : '+ Marcar clip acá';
    renderRanges();
    renderCards();
  }

  function movePlayhead() { if (playhead) playhead.style.left = `${((preview.currentTime || 0) / video.duration) * 100}%`; }

  function renderRanges() {
    track.replaceChildren();
    clips.forEach((c) => {
      const r = el('div', 'studio-range');
      r.style.left = `${(c.start / video.duration) * 100}%`;
      r.style.width = `${((c.end - c.start) / video.duration) * 100}%`;
      r.style.setProperty('--c', c.color);
      const l = el('span', 'studio-grip l'); l.dataset.edge = 'l';
      const rr = el('span', 'studio-grip r'); rr.dataset.edge = 'r';
      r.append(l, el('span', 'studio-range-label', c.id.replace('C', '')), rr);
      r.addEventListener('pointerdown', (e) => dragRange(e, c, r));
      track.append(r);
    });
  }

  // Arrastrar el clip entero o uno de sus bordes; el preview muestra el cuadro del borde que se mueve.
  function dragRange(e, c, node) {
    e.preventDefault();
    e.stopPropagation();
    const edge = e.target.dataset?.edge || 'move';
    const rect = track.getBoundingClientRect();
    const x0 = e.clientX;
    const s0 = c.start; const e0 = c.end;
    const { lo, hi } = room(c);
    node.setPointerCapture(e.pointerId);
    preview.pause();
    const onMove = (ev) => {
      const dt = ((ev.clientX - x0) / rect.width) * video.duration;
      if (edge === 'move') {
        const len = e0 - s0;
        c.start = Math.max(lo, Math.min(hi - len, s0 + dt));
        c.end = c.start + len;
        preview.currentTime = c.start;
      } else if (edge === 'l') {
        c.start = Math.max(lo, e0 - lim.maxClipSeconds, Math.min(e0 - minLen(c), s0 + dt));
        preview.currentTime = c.start;
      } else {
        c.end = Math.min(hi, s0 + lim.maxClipSeconds, Math.max(s0 + minLen(c), e0 + dt));
        preview.currentTime = Math.max(c.start, c.end - 0.05);
      }
      node.style.left = `${(c.start / video.duration) * 100}%`;
      node.style.width = `${((c.end - c.start) / video.duration) * 100}%`;
      const span = cardsBox.querySelector(`[data-key="${c.key}"] .clip-time`);
      if (span) span.textContent = clipTime(c);
    };
    const onUp = () => {
      onChange();
      node.removeEventListener('pointermove', onMove);
      node.removeEventListener('pointerup', onUp);
      node.removeEventListener('pointercancel', onUp);
    };
    node.addEventListener('pointermove', onMove);
    node.addEventListener('pointerup', onUp);
    node.addEventListener('pointercancel', onUp);
  }

  const clipTime = (c) => `${fmt(c.start)} → ${fmt(c.end)} · ${(c.end - c.start).toFixed(1)} s`;

  function renderCards() {
    cardsBox.replaceChildren();
    clips.forEach((c) => {
      const box = el('div', 'clip-card');
      box.dataset.key = c.key;
      box.style.setProperty('--c', c.color);
      const head = el('div', 'clip-card-head');
      const go = el('button', 'clip-play', '▶');
      go.type = 'button'; go.title = 'Ver este clip'; go.setAttribute('aria-label', `Ver el clip ${c.id}`);
      go.onclick = () => {
        preview.currentTime = c.start;
        preview.play();
        const stop = () => { if (preview.currentTime >= c.end) { preview.pause(); preview.removeEventListener('timeupdate', stop); } };
        preview.addEventListener('timeupdate', stop);
      };
      const x = el('button', 'clip-remove', '×');
      x.type = 'button'; x.setAttribute('aria-label', `Quitar el clip ${c.id}`);
      x.onclick = () => { clips = clips.filter((k) => k !== c); renumber(); refreshClips(); onChange(); };
      head.append(el('span', 'motion-dot', c.id.replace('C', '')), el('strong', null, `Clip ${c.id.replace('C', '')}`), el('span', 'muted small clip-time', clipTime(c)), go, x);

      // Técnica del clip: motion como código, una toma generada por IA con palabras encima,
      // o Cinematic Pro (el clip real llevado a nivel cine por el Director de Fotografía).
      const modeRow = el('div', 'clip-mode');
      const modes = modeOptions();
      if (modes.length > 1) {
        modes.forEach(([m, label, title]) => {
          const b = el('button', `option${m === 'cine' ? ' cine-option' : ''}`, label);
          b.type = 'button';
          b.title = title;
          b.setAttribute('aria-pressed', String(c.mode === m));
          b.onclick = () => {
            c.mode = m;
            // Si queda corto para re-filmar, se estira hasta donde deja el clip siguiente.
            if (c.end - c.start < minLen(c)) { c.end = Math.min(room(c).hi, c.start + minLen(c)); renderRanges(); }
            renderCards(); onChange();
          };
          modeRow.append(b);
        });
        if (c.mode === 'ai') {
          const sel = el('select', 'clip-model');
          sel.setAttribute('aria-label', 'Modelo de video');
          lim.videoModels.forEach((m) => { const o = el('option', null, m.label); o.value = m.id; sel.append(o); });
          sel.value = c.videoModel;
          sel.onchange = () => { c.videoModel = sel.value; };
          modeRow.append(sel);
        }
      }

      const prompt = el('textarea');
      prompt.rows = 2; prompt.value = c.prompt;
      prompt.placeholder = {
        ai: 'Qué tiene que pasar en la toma y qué palabras van encima. Ej. "la taza gira lento hacia la luz; texto: Nuevo blend"',
        cine: `Qué tiene que sentirse (opcional). Ej. "más íntimo, luz de atardecer", "que parezca una película de los 70"${lim.refilm ? ', "que afuera llueva"' : ''}`,
      }[c.mode] || '¿Qué pasa en este clip? Ej. "que aparezca el precio: $12.900"';
      prompt.oninput = () => { c.prompt = prompt.value; };
      const notes = el('textarea');
      notes.rows = 1; notes.value = c.notes;
      notes.placeholder = 'Estilo en palabras (opcional): "editorial tipo Apple"';
      notes.oninput = () => { c.notes = notes.value; };

      const refs = el('div', 'thumbs clip-refs');
      c.refs.forEach((r) => {
        const t = el('div', `thumb${r.status === 'loading' ? ' loading' : ''}`);
        if (r.status === 'loading') t.append(el('span', 'thumb-kind', '🖼️'));
        else {
          const img = el('img'); img.src = r.thumb; img.alt = r.name;
          t.append(img);
          if (r.kind === 'video') t.append(el('span', 'badge', `${r.frames.length} cuadros`));
        }
        const rm = el('button', 'remove', '×');
        rm.type = 'button'; rm.setAttribute('aria-label', `Quitar referencia ${r.name}`);
        rm.onclick = () => { c.refs = c.refs.filter((k) => k !== r); renderCards(); onChange(); };
        t.append(rm);
        refs.append(t);
      });
      if (c.refs.length < lim.maxRefs) {
        const addRef = el('label', 'add-ref');
        const inp = el('input');
        inp.type = 'file'; inp.accept = 'image/*,video/*,.gif'; inp.multiple = true; inp.hidden = true;
        inp.onchange = () => { addRefs(c, [...inp.files]); inp.value = ''; };
        addRef.append(inp, el('span', null, '+ Referencia'), el('span', 'muted small', 'imagen, video o GIF'));
        refs.append(addRef);
      }
      const cineHint = c.mode === 'cine' ? [el('p', 'muted small cine-hint', `🎞️ El Director de Fotografía mira el clip con la biblioteca de cine (luz, color, cámara, encuadre) y escribe el tratamiento (grade, luz motivada, cámara virtual y textura) y el plan para re-filmarlo.${lim.refilm ? ` Después re-filma el clip con IA (${lim.refilmModels.join(' o ')}, ${lim.refilmResolution}: elegís el modelo al aprobar): vos aprobás antes de gastar. Mínimo ${lim.minCineSeconds} s.` : ''}`)] : [];
      box.append(head, ...(modes.length > 1 ? [modeRow] : []), ...cineHint, prompt, notes, refs);
      cardsBox.append(box);
    });
  }

  function modeOptions() {
    return [
      ['motion', 'Motion en código', 'Motion design generado como código encima del video'],
      ...(lim.aiVideo ? [['ai', 'Video IA + texto', 'Una toma generada por IA a partir de un cuadro del clip, con palabras encima']] : []),
      ...(lim.cine ? [['cine', '🎞️ Cinematic Pro', 'El Director de Fotografía lleva tu clip real a nivel cine']] : []),
    ];
  }

  async function addRefs(c, files) {
    const room = lim.maxRefs - c.refs.length;
    if (files.length > room) onError(`Máximo ${lim.maxRefs} referencias por clip.`);
    const added = files.slice(0, Math.max(0, room)).map((file) => ({ key: ++seq, name: file.name, status: 'loading', file }));
    c.refs.push(...added);
    renderCards(); onChange();
    await Promise.all(added.map(async (r) => {
      try {
        Object.assign(r, await loadReference(r.file), { status: 'ready' });
      } catch (err) {
        onError(`${r.name}: ${err.message}`);
        c.refs = c.refs.filter((k) => k !== r);
      }
      delete r.file;
      if (clips.includes(c)) renderCards();
      onChange();
    }));
  }

  // Arma el pedido: los cuadros de cada clip se sacan recién ahora (con los rangos ya definitivos).
  async function request(text) {
    const n = lim.clipFrames;
    const snap = [];
    for (const c of clips) {
      const len = c.end - c.start;
      const frames = await framesAt(video.reader, Array.from({ length: n }, (_, k) => c.start + ((k + 0.5) / n) * len));
      snap.push({
        id: c.id, start: +c.start.toFixed(3), end: +c.end.toFixed(3), prompt: c.prompt.trim(), notes: c.notes.trim(),
        mode: modeOptions().some(([m]) => m === c.mode) ? c.mode : 'motion', videoModel: c.videoModel,
        frames: frames.map((f) => ({ t: +(f.t - c.start).toFixed(2), url: f.url })),
        refs: c.refs.filter((r) => r.status === 'ready').map((r) => ({ kind: r.kind, name: r.name, frames: r.frames })),
      });
    }
    const vmeta = { name: video.name, duration: video.duration, width: video.width, height: video.height };
    return {
      body: JSON.stringify({ text, video: vmeta, clips: snap }),
      ctx: { video: { ...vmeta, url: video.url }, clips: snap, text },
    };
  }

  const summary = () => (video ? `✨ Intuition · ${video.name} · ${clips.map((c) => `${c.id} ${fmt(c.start)}–${fmt(c.end)}${{ ai: ' (video IA)', cine: ' (Cinematic Pro)' }[c.mode] || ''}`).join(' · ')}` : '');
  const thumbs = () => clips.map((c) => video.strip[Math.min(FILMSTRIP - 1, Math.floor((c.start / video.duration) * FILMSTRIP))].url);

  // Vuelve a poner clips ya marcados (el Laboratorio reabre experimentos del historial).
  function setClips(list) {
    if (!video) return;
    clips = list.slice(0, lim.maxClips).map((c) => ({
      key: ++seq, start: Math.max(0, c.start), end: Math.min(video.duration, c.end), prompt: c.prompt || '', notes: c.notes || '',
      mode: 'motion', videoModel: lim.defaultVideoModel, refs: (c.refs || []).map((r) => ({ ...r, key: ++seq, status: 'ready' })),
    })).filter((c) => c.end - c.start >= lim.minClipSeconds - 0.01);
    renumber();
    refreshClips();
    onChange();
  }

  const current = () => (video ? { file: video.file, url: video.url, name: video.name, duration: video.duration, width: video.width, height: video.height } : null);

  return { setVideo, setLimits, setClips, missing, hint, request, summary, thumbs, current, busy: () => loading, hasVideo: () => !!video };
}

// ---------- Eventos del flujo ----------
// ctx: { video, clips, text, player }
export function handleIntuition(ev, steps, ctx) {
  switch (ev.type) {
    case 'direction': {
      const s = ev.data.sistema;
      addChips(steps.get('direction'), [
        `${s.tipografias.display}${s.tipografias.texto !== s.tipografias.display ? ` + ${s.tipografias.texto}` : ''}`,
        ...s.paleta.map((p) => p.hex),
        ...(ev.data.concepto ? [ev.data.concepto] : []),
      ]);
      paintSwatches(steps.get('direction'), s.paleta);
      ctx.direction = ev.data;
      ctx.player = createMotionPlayer({ video: ctx.video, clips: ctx.clips, direction: ev.data, onRevise: (id, req) => revise(ctx, id, req) });
      const box = el('section', 'result msg');
      const allCine = ctx.clips.every((c) => c.mode === 'cine');
      box.append(el('h3', 'result-title', allCine ? 'Tu video, nivel cine' : 'Tu video con motion design'));
      if (ev.data.nota_para_el_humano) box.append(el('p', 'muted', ev.data.nota_para_el_humano));
      box.append(ctx.player.root);
      append(box);
      return;
    }
    case 'motion': return ctx.player?.setMotion(ev.data);
    case 'cine': return ctx.player?.setCine(ev.data);
    case 'cine_video': return ctx.player?.setCineVideo(ev.data);
    case 'ai_plan': return ctx.player?.setPlan(ev.data);
    case 'ai_video': return ctx.player?.setAiVideo(ev.data);
    case 'media_status':
      mediaStatus(steps.get(ev.step), ev);
      if (ev.step.startsWith('video-')) ctx.player?.aiStatus(ev.step.split('-')[1], 'generating', ev.elapsed);
      if (ev.step.startsWith('refilm-')) ctx.player?.cineStatus(ev.step.split('-')[1], 'generating', ev.elapsed);
      return;
    case 'decision':
      if (ev.kind === 'storyboard') append(storyboardCard(ev));
      if (ev.kind === 'refilm') append(refilmCard(ev, ctx));
      if (ev.kind === 'refilm_retry') append(refilmRetryCard(ev, ctx));
      if (ev.kind === 'intent') append(intentCard(ev));
      return;
    case 'step_error': {
      const [kind, id] = ev.step.split('-');
      if (kind === 'video' || kind === 'storyboard') return ctx.player?.failVideo(id, ev.text, kind);
      if (kind === 'refilm') return ctx.player?.failCineVideo(id, ev.text);
      return ctx.player?.failClip(id, ev.text);
    }
    default:
  }
}

const STATUS = { created: 'En cola', queued: 'En cola', processing: 'Generando', completed: 'Bajando el resultado' };
function mediaStatus(s, ev) {
  if (!s) return;
  s.live.textContent = `${STATUS[ev.status] || ev.status || 'Esperando'}… ${Math.round(ev.elapsed || 0)} s`;
}

// El storyboard de un clip de video IA: el humano lo aprueba (se genera la toma) o pide cambios (Opus rehace la dirección).
function storyboardCard(ev) {
  const p = ev.plan;
  const card = decisionShell(ev, `Storyboard · ${p.modelLabel}${p.round > 1 ? ` · versión ${p.round}` : ''}`);
  const media = el('div', 'storyboard');
  const img = el('img', 'storyboard-img');
  img.src = p.storyboard || p.frame;
  img.alt = p.storyboard ? `Storyboard del clip ${p.id}` : `Cuadro base del clip ${p.id}`;
  media.append(img);
  if (!p.storyboard) media.append(el('p', 'muted small', p.demo ? 'Modo demo: se muestra el cuadro base en lugar del storyboard.' : 'No se pudo dibujar el storyboard: se muestra el cuadro base.'));
  card.append(media);

  const facts = el('div', 'facts');
  const fact = (label, value) => {
    if (!value || (Array.isArray(value) && !value.length)) return;
    const f = el('div', 'fact');
    f.append(el('strong', null, label), document.createTextNode(Array.isArray(value) ? value.join(' · ') : value));
    facts.append(f);
  };
  fact('Toma', p.toma);
  fact('Cámara', p.camara);
  fact('Luz y color', p.luz_y_color);
  fact('Tiempos', p.beats.map((b) => `${Number(b.desde || 0).toFixed(1)}–${Number(b.hasta || 0).toFixed(1)} s: ${b.accion || ''}`));
  fact('No cambia', p.continuidad);
  fact('Palabras encima', p.textos);
  fact('Lugar del texto', p.espacio_para_texto);
  card.append(facts);
  if (p.nota) card.append(el('p', 'motion-note', p.nota));

  const det = el('details', 'motion-code');
  det.append(el('summary', null, 'Ver y editar el prompt de video'));
  const prompt = el('textarea', 'prompt-edit');
  prompt.rows = 7;
  prompt.value = p.prompt_video;
  det.append(prompt);
  if (p.evitar.length) det.append(el('p', 'muted small', `Además se evita: ${p.evitar.join(', ')}`));
  card.append(det);

  const ask = el('textarea');
  ask.rows = 2;
  ask.placeholder = p.lastRound ? 'Es la última versión: al tocar el botón se genera la toma.' : '¿Qué cambiarías? Ej. "que la cámara no se mueva", "más luz de atardecer", "que termine en la mano"';
  ask.disabled = p.lastRound;
  card.append(ask);
  const edited = () => (prompt.value.trim() !== p.prompt_video.trim() ? prompt.value.trim() : '');

  const actions = el('div', 'actions');
  const go = el('button', 'primary', 'Generar el video');
  go.type = 'button';
  go.onclick = () => decide(card, ev.id, { aprobar: true, prompt: edited() }, `Clip ${p.id.replace('C', '')}: aprobado${edited() ? ' (con el prompt editado)' : ''}, a generar con ${p.modelLabel}.`);
  const redo = el('button', 'ghost', 'Pedir cambios');
  redo.type = 'button';
  redo.hidden = p.lastRound;
  redo.onclick = () => {
    const cambios = ask.value.trim();
    if (!cambios && !edited()) { ask.focus(); ask.placeholder = 'Contá qué querés cambiar (o editá el prompt).'; return; }
    decide(card, ev.id, { cambios, prompt: edited() }, `Clip ${p.id.replace('C', '')}: ${cambios || 'prompt editado'}`);
  };
  actions.append(go, redo);
  card.append(el('p', 'muted small', 'Generar la toma cuesta y tarda (1 a 5 min). Revisá el storyboard antes de aprobar.'), actions);
  return card;
}

const EJE_LABEL = { punto_de_vista: 'Punto de vista', elementos: 'Elementos', accion: 'Acción', lugar: 'Lugar', luz: 'Luz', look: 'Look' };

// Cinematic Pro: el pedido admite dos lecturas → el humano elige antes de que se dibuje nada (no cuesta).
function intentCard(ev) {
  const p = ev.plan;
  const n = p.id.replace('C', '');
  const card = decisionShell(ev, 'Antes de dibujar');
  const picks = p.preguntas.map((q) => {
    const box = el('fieldset', 'intent-q');
    box.append(el('legend', null, `"${q.pedido}"`));
    const name = `intent-${ev.id}-${q.i}`;
    const opt = (value, label, checked) => {
      const l = el('label', 'intent-opt');
      const r = el('input');
      r.type = 'radio'; r.name = name; r.value = value; r.checked = checked;
      l.append(r, document.createTextNode(` ${label}`));
      return l;
    };
    const other = el('textarea');
    other.rows = 2; other.placeholder = 'O contá con tus palabras qué querés.';
    other.oninput = () => { if (other.value.trim()) box.querySelector('input[value="otra"]').checked = true; };
    box.append(opt('a', q.a, true), opt('b', q.b, false), opt('otra', 'Otra cosa:', false), other);
    card.append(box);
    return { q, box, other };
  });
  const actions = el('div', 'actions');
  const go = el('button', 'primary', 'Seguir con esto');
  go.type = 'button';
  go.onclick = () => {
    const elecciones = picks.map(({ q, box, other }) => ({ i: q.i, opcion: box.querySelector('input:checked')?.value || 'a', texto: other.value.trim() }));
    const said = picks.map(({ q }, k) => { const e = elecciones[k]; return e.opcion === 'b' ? q.b : e.opcion === 'otra' && e.texto ? e.texto : q.a; });
    decide(card, ev.id, { elecciones }, `Clip ${n}: ${said.join(' · ')}`);
  };
  actions.append(go);
  card.append(actions);
  return card;
}

// Cinematic Pro: el storyboard de la toma re-filmada, para aprobar o pedir cambios.
// Si la cámara no cambia, al aprobar el navegador graba el tramo y lo manda con la respuesta (el video nunca se sube entero);
// si cambia, no hace falta: el modelo recibe el storyboard y cuadros del clip.
function refilmCard(ev, ctx) {
  const p = ev.plan;
  const n = p.id.replace('C', '');
  const card = decisionShell(ev, `Re-filmar con IA${p.resolution ? ` · ${p.resolution}` : ''}${p.round > 1 ? ` · versión ${p.round}` : ''}`);
  // Modelos para re-filmar: el humano elige (cada uno con su prompt, duración y costo estimado).
  const models = p.models?.length ? p.models : [{ id: p.model, label: p.model, prompt: p.prompt }];
  let model = models.find((m) => m.id === p.model) || models[0];
  // El storyboard dibujado a mano de la toma re-filmada (o un cuadro del clip, si no se pudo dibujar).
  const media = el('div', 'storyboard');
  const img = el('img', 'storyboard-img');
  img.src = p.storyboard || p.frame;
  img.alt = p.storyboard ? `Storyboard de la toma re-filmada del clip ${p.id}` : `Cuadro del clip ${p.id}`;
  media.append(img);
  if (!p.storyboard) media.append(el('p', 'muted small', p.demo ? 'Modo demo: se muestra un cuadro del clip en lugar del storyboard.' : 'No se pudo dibujar el storyboard: se muestra un cuadro del clip.'));
  card.append(media);
  const facts = el('div', 'facts');
  const fact = (label, value) => {
    if (!value || (Array.isArray(value) && !value.length)) return;
    const f = el('div', 'fact');
    f.append(el('strong', null, label), document.createTextNode(Array.isArray(value) ? value.join(' · ') : value));
    facts.append(f);
  };
  (p.cambios || []).forEach((c) => fact(EJE_LABEL[c.eje] || c.eje, c.interpretacion || c.pedido));
  fact('Por qué', p.por_que);
  fact('Cámara', p.cambia_camara ? 'una toma nueva: otra posición, ángulo o lente (como en el storyboard)' : 'la misma de tu clip');
  fact('Tiempos', (p.vinetas || []).map((v, i) => `${i + 1} · ${Number(v.t || 0).toFixed(1)} s: ${[v.encuadre, v.accion].filter(Boolean).join(' — ')}`));
  fact('No cambia', p.preservar);
  fact('Encima de la toma', { textura: 'solo la textura (grano, halation, viñeta)', completo: 'todo el tratamiento', nada: 'nada: la toma tal cual' }[p.sobre_toma]);
  card.append(facts);
  const pick = el('div', 'refilm-models');
  const sel = el('select', 'clip-model');
  sel.setAttribute('aria-label', 'Modelo para re-filmar');
  models.forEach((m) => { const o = el('option', null, `${m.label}${m.seconds ? ` · ${m.seconds} s` : ''}${m.cost ? ` · ≈ US$${m.cost.toFixed(2)}` : ''}`); o.value = m.id; sel.append(o); });
  sel.value = model.id;
  pick.append(el('span', 'small', 'Modelo'), sel);
  card.append(pick);
  const det = el('details', 'motion-code');
  det.append(el('summary', null, 'Ver y editar el prompt'));
  const prompt = el('textarea', 'prompt-edit');
  prompt.rows = 7; prompt.value = model.prompt;
  det.append(prompt);
  card.append(det);
  // Al cambiar de modelo cambia su prompt (nombra las referencias a su manera), salvo que el humano ya lo haya editado.
  sel.onchange = () => {
    const edited = prompt.value.trim() !== model.prompt.trim();
    model = models.find((m) => m.id === sel.value) || models[0];
    if (!edited) prompt.value = model.prompt;
  };
  // Feedback sobre el storyboard: el Director de Fotografía rehace la toma y se vuelve a dibujar.
  const ask = el('textarea');
  ask.rows = 2;
  ask.placeholder = p.lastRound ? 'Es la última versión del storyboard: re-filmá o quedate con el tratamiento.' : '¿Qué cambiarías de la toma? Ej. "la cámara más alta, mirando directo al escritorio", "que la persona de la izquierda no salga", "más oscuro, de noche"';
  ask.disabled = !!p.lastRound;
  card.append(ask);
  const status = el('p', 'muted small', `Mientras tanto ya ves el tratamiento aplicado a tu clip real. Re-filmar cuesta (el costo de cada modelo es una estimación) y tarda 1 a 5 min.${p.demo ? ' Modo demo: no se genera nada.' : ''}`);
  const actions = el('div', 'actions');
  const go = el('button', 'primary', 'Re-filmar este clip');
  go.type = 'button';
  go.onclick = async () => {
    go.disabled = true; skip.disabled = true; redo.disabled = true; sel.disabled = true;
    try {
      let rec = null;
      if (p.needsVideo !== false) {
        status.textContent = 'Grabando el tramo del clip… (dejá esta pestaña visible)';
        rec = await recordSegment(ctx.video.url, p.start, p.end, { mp4: true, onProgress: (k) => { status.textContent = `Grabando el tramo del clip… ${Math.round(k * 100)}%`; } });
        status.textContent = `Enviando el clip (${(rec.size / 1024 / 1024).toFixed(1)} MB)…`;
      }
      const edited = prompt.value.trim() !== model.prompt.trim() ? prompt.value.trim() : '';
      ctx.player?.cineStatus(p.id, 'uploading');
      await decide(card, ev.id, { aprobar: true, model: model.id, prompt: edited, ...(rec ? { video: rec.dataUrl } : {}) }, `Clip ${n}: re-filmar con ${model.label}${p.storyboard ? ', siguiendo el storyboard' : ''}${edited ? ' (con el prompt editado)' : ''}.`);
    } catch (err) {
      status.textContent = err.message;
      go.disabled = false; skip.disabled = false; redo.disabled = false; sel.disabled = false;
    }
  };
  const redo = el('button', 'ghost', 'Pedir cambios al storyboard');
  redo.type = 'button';
  redo.hidden = !!p.lastRound;
  redo.onclick = () => {
    const cambios = ask.value.trim();
    if (!cambios) { ask.focus(); ask.placeholder = 'Contá qué querés cambiar de la toma.'; return; }
    const edited = prompt.value.trim() !== model.prompt.trim() ? prompt.value.trim() : '';
    decide(card, ev.id, { aprobar: false, cambios, prompt: edited }, `Clip ${n}, storyboard: ${cambios}`);
  };
  const skip = el('button', 'ghost', 'Quedarme con el tratamiento');
  skip.type = 'button';
  skip.onclick = () => decide(card, ev.id, { aprobar: false }, `Clip ${n}: sin re-filmar, me quedo con el tratamiento.`);
  actions.append(go, redo, skip);
  card.append(status, actions);
  return card;
}

// El re-filmado falló: reintentar con el mismo clip ya grabado (si la tarea ya se había aceptado, se retoma sin volver a pagar).
function refilmRetryCard(ev, ctx) {
  const p = ev.plan;
  const n = p.id.replace('C', '');
  const card = decisionShell(ev, 'Falló el re-filmado');
  card.append(el('div', 'notice', p.error));
  card.append(el('p', 'muted small', p.resume
    ? 'WaveSpeed ya había aceptado la tarea: reintentar la retoma, sin volver a pagar.'
    : 'Reintentar vuelve a enviar tu clip (ya está grabado: no hace falta grabarlo de nuevo).'));
  const actions = el('div', 'actions');
  const go = el('button', 'primary', 'Reintentar');
  go.type = 'button';
  go.onclick = () => { ctx.player?.cineStatus(p.id, 'uploading'); decide(card, ev.id, { aprobar: true }, `Clip ${n}: reintentar el re-filmado.`); };
  const skip = el('button', 'ghost', 'Quedarme con el tratamiento');
  skip.type = 'button';
  skip.onclick = () => decide(card, ev.id, { aprobar: false }, `Clip ${n}: sin re-filmar, me quedo con el tratamiento.`);
  actions.append(go, skip);
  card.append(actions);
  return card;
}

function paintSwatches(s, palette) {
  const chips = s?.node.querySelector('.chips');
  if (!chips) return;
  [...chips.children].forEach((chip) => {
    const hex = palette.find((p) => p.hex === chip.textContent)?.hex;
    if (hex) { chip.classList.add('swatch'); chip.style.setProperty('--sw', hex); }
  });
}

// Pide rehacer un clip. El servidor no guarda estado: se le manda todo lo necesario.
async function revise(ctx, id, { feedback, error, box, previous }) {
  const index = ctx.clips.findIndex((c) => c.id === id);
  const clip = ctx.clips[index];
  append(el('div', 'msg user-msg')).append(el('div', 'bubble', error ? `Clip ${index + 1}: arreglá el error${feedback ? ` · ${feedback}` : ''}` : `Clip ${index + 1}: ${feedback}`));
  const steps = createSteps();
  // Clip de video IA con la toma ya generada: se mandan cuadros de ESA toma (lo que el texto tiene encima).
  const state = ctx.player.clip(id);
  let frames = null;
  if (state?.ai?.url) {
    try {
      const v = await openVideo(state.ai.url);
      const n = clip.frames.length;
      frames = (await framesAt(v, Array.from({ length: n }, (_, k) => ((k + 0.5) / n) * state.dur))).map((f) => ({ t: +f.t.toFixed(2), url: f.url }));
    } catch { frames = null; }
  }
  const body = JSON.stringify({
    video: ctx.video, clip: frames ? { ...clip, frames } : clip, direction: ctx.direction, box, index, total: ctx.clips.length, previous, feedback, error,
    plan: state?.vplan || null, generated: !!frames,
  });
  let failed = null;
  await streamEvents('/api/intuition/revise', body, undefined, (ev) => {
    if (ev.type === 'error') failed = ev.text;
    if (handleCommon(ev, steps)) return;
    if (ev.type === 'motion') ctx.player.setMotion(ev.data);
    if (ev.type === 'cine') ctx.player.setCine(ev.data);
  });
  if (failed) throw new Error(failed);
}
