import { el, fmt, append, addChips, showError, createSteps, handleCommon, streamEvents } from './shared.js';
import { openVideo, framesAt, loadReference } from './media.js';
import { createMotionPlayer } from './intuition-player.js';

// Flujo 3: ✨ Intuition. Un video + hasta 3 clips (≤ 5 s) con pedido y referencias →
// el Director de Arte arma un sistema visual y un Motion Designer por clip escribe el motion como código.

const COLORS = ['#ff5a1f', '#3b82f6', '#10b981'];
const FILMSTRIP = 10;

// ---------- Estudio: elegir el video, marcar los clips y escribir el pedido de cada uno ----------
export function createStudio({ limits, onChange }) {
  const lim = { maxClips: 3, maxClipSeconds: 5, minClipSeconds: 0.5, clipFrames: 6, maxRefs: 4, ...limits };
  let video = null; // { file, url, name, duration, width, height, el }
  let loading = false;
  let clips = []; // { key, id, start, end, prompt, notes, refs: [{ key, kind, name, frames, thumb, status }] }
  let seq = 0;
  let card = null;

  const setLimits = (l) => Object.assign(lim, l);

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
      showError(`${file.name}: ${err.message}`);
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
    if (clips.length >= lim.maxClips) return showError(`Máximo ${lim.maxClips} clips.`);
    if (clips.some((c) => t >= c.start && t < c.end)) return showError('Ya hay un clip en ese momento: mové el cursor a otra parte del video.');
    const next = clips.filter((c) => c.start > t).sort((a, b) => a.start - b.start)[0];
    const hi = Math.min(video.duration, next ? next.start : video.duration);
    let start = t;
    let end = Math.min(hi, t + 3);
    if (end - start < lim.minClipSeconds) { start = Math.max(0, end - 3); end = hi; }
    const prev = clips.filter((c) => c.end <= t).sort((a, b) => b.end - a.end)[0];
    start = Math.max(start, prev ? prev.end : 0);
    if (end - start < lim.minClipSeconds) return showError('No queda lugar para un clip ahí.');
    showError('');
    clips.push({ key: ++seq, start, end, prompt: '', notes: '', refs: [] });
    renumber();
    refreshClips();
    onChange();
  }

  function missing() {
    if (loading) return 'Leyendo el video…';
    if (!video) return 'Soltá un video (idealmente vertical 9:16).';
    if (!clips.length) return 'Marcá al menos un clip en el video (máximo 3, de hasta 5 s).';
    if (clips.some((c) => c.refs.some((r) => r.status === 'loading'))) return 'Preparando las referencias…';
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
    if (!card) {
      document.getElementById('welcome')?.remove();
      card = append(el('section', 'studio msg'));
    }
    card.replaceChildren();

    const headRow = el('div', 'studio-head');
    const title = el('div');
    title.append(el('div', 'decision-label', '✨ Intuition'), el('h3', null, 'Marcá dónde va el motion design'));
    const change = el('label', 'ghost small studio-change');
    const input = el('input');
    input.type = 'file'; input.accept = 'video/*'; input.hidden = true;
    input.onchange = () => { if (input.files[0]) setVideo(input.files[0]); input.value = ''; };
    change.append(input, document.createTextNode('Cambiar video'));
    headRow.append(title, change);

    const meta = el('p', 'muted small', `${video.name} · ${fmt(video.duration)} · ${video.width}×${video.height}${Math.abs(video.width / video.height - 9 / 16) > 0.02 ? ' · (no es 9:16: se va a recortar al centro)' : ''}`);

    preview = el('video', 'studio-video');
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
        c.start = Math.max(lo, e0 - lim.maxClipSeconds, Math.min(e0 - lim.minClipSeconds, s0 + dt));
        preview.currentTime = c.start;
      } else {
        c.end = Math.min(hi, s0 + lim.maxClipSeconds, Math.max(s0 + lim.minClipSeconds, e0 + dt));
        preview.currentTime = Math.max(c.start, c.end - 0.05);
      }
      node.style.left = `${(c.start / video.duration) * 100}%`;
      node.style.width = `${((c.end - c.start) / video.duration) * 100}%`;
      const span = cardsBox.querySelector(`[data-key="${c.key}"] .clip-time`);
      if (span) span.textContent = clipTime(c);
    };
    const onUp = () => {
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

      const prompt = el('textarea');
      prompt.rows = 2; prompt.value = c.prompt;
      prompt.placeholder = '¿Qué pasa en este clip? Ej. "que aparezca el precio: $12.900"';
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
      box.append(head, prompt, notes, refs);
      cardsBox.append(box);
    });
  }

  async function addRefs(c, files) {
    const room = lim.maxRefs - c.refs.length;
    if (files.length > room) showError(`Máximo ${lim.maxRefs} referencias por clip.`);
    const added = files.slice(0, Math.max(0, room)).map((file) => ({ key: ++seq, name: file.name, status: 'loading', file }));
    c.refs.push(...added);
    renderCards(); onChange();
    await Promise.all(added.map(async (r) => {
      try {
        Object.assign(r, await loadReference(r.file), { status: 'ready' });
      } catch (err) {
        showError(`${r.name}: ${err.message}`);
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

  const summary = () => (video ? `✨ Intuition · ${video.name} · ${clips.map((c) => `${c.id} ${fmt(c.start)}–${fmt(c.end)}`).join(' · ')}` : '');
  const thumbs = () => clips.map((c) => video.strip[Math.min(FILMSTRIP - 1, Math.floor((c.start / video.duration) * FILMSTRIP))].url);

  return { setVideo, setLimits, missing, hint, request, summary, thumbs, busy: () => loading, hasVideo: () => !!video };
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
      box.append(el('h3', 'result-title', 'Tu video con motion design'));
      if (ev.data.nota_para_el_humano) box.append(el('p', 'muted', ev.data.nota_para_el_humano));
      box.append(ctx.player.root);
      append(box);
      return;
    }
    case 'motion': return ctx.player?.setMotion(ev.data);
    case 'step_error': return ctx.player?.failClip(ev.step.replace('motion-', ''), ev.text);
    default:
  }
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
  const body = JSON.stringify({ video: ctx.video, clip, direction: ctx.direction, box, index, total: ctx.clips.length, previous, feedback, error });
  let failed = null;
  await streamEvents('/api/intuition/revise', body, undefined, (ev) => {
    if (ev.type === 'error') failed = ev.text;
    if (!handleCommon(ev, steps) && ev.type === 'motion') ctx.player.setMotion(ev.data);
  });
  if (failed) throw new Error(failed);
}
