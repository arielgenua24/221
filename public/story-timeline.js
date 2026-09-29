import { el, fmt } from './shared.js';

// Montaje de Historia: las tomas en orden (cada una ~5 s) sobre una pista de música con su volumen.
// Se dibuja en un canvas con un reloj propio (la música puede ser más corta o no estar), la música pasa por
// WebAudio (volumen + fundido al final) y se exporta en tiempo real con MediaRecorder (canvas + audio).
// Las tomas que todavía no tienen video se ven como su cuadro (con un zoom lento), para ver la historia entera.

const SIZES = { '9:16': [540, 960], '16:9': [960, 540], '1:1': [720, 720] };
const FADE_OUT = 1.2; // fundido de la música al final
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const fileUrl = (f) => `/story-files/${f}`;

export function createStoryEditor({ onOrder, onMusic, onMix, onRemoveMusic, shotSeconds = 5 }) {
  const root = el('div', 'st-editor');
  const stage = el('div', 'stage st-stage');
  const canvas = el('canvas');
  const ctx = canvas.getContext('2d');
  stage.append(canvas);

  const controls = el('div', 'player-controls');
  const play = el('button', 'play-btn', '▶');
  play.type = 'button'; play.setAttribute('aria-label', 'Reproducir');
  const time = el('span', 'time', '0:00.0');
  const scrub = el('input', 'st-scrub');
  scrub.type = 'range'; scrub.min = 0; scrub.step = 0.01; scrub.value = 0; scrub.setAttribute('aria-label', 'Posición');
  controls.append(play, time, scrub);

  // Pista de video
  const clipsLabel = el('div', 'st-label', 'Tomas');
  const track = el('div', 'st-track');
  const playhead = el('div', 'st-head');
  const trackWrap = el('div', 'st-track-wrap');
  trackWrap.append(track, playhead);

  // Pista de música
  const musicLabel = el('div', 'st-label', 'Música');
  const music = el('div', 'st-music');

  const actions = el('div', 'actions');
  const exportBtn = el('button', 'primary', 'Exportar video');
  exportBtn.type = 'button';
  actions.append(exportBtn);
  const note = el('p', 'muted small export-note');
  note.hidden = true;
  root.append(stage, controls, clipsLabel, trackWrap, musicLabel, music, actions, note);

  let project = null;
  let clips = []; // { id, kind, url, poster, dur, node, img, pending }
  let total = 0;
  let mix = { volume: 0.8, offset: 0 };
  let audio = null;
  let audioKey = '';
  let graph = null; // { ac, gain, dest }
  let t = 0;
  let playing = false;
  let clock = 0; // performance.now() cuando t = 0
  let current = -1;
  let recorder = null;
  let raf = 0;
  let lastClips = '';
  let lastMusic = '';

  // ---------- Armar desde el proyecto ----------
  function build(p) {
    const order = p.timeline.order.length ? p.timeline.order : p.shots.map((s) => s.id);
    const byId = new Map(p.shots.map((s) => [s.id, s]));
    const old = new Map(clips.map((c) => [c.id + c.url, c]));
    clips = order.map((id) => byId.get(id)).filter((s) => s && (s.video?.file || s.frame?.file)).map((s) => {
      const kind = s.video?.file ? 'video' : 'still';
      const url = fileUrl(kind === 'video' ? s.video.file : s.frame.file);
      const prev = old.get(s.id + url);
      if (prev) return { ...prev, titulo: s.titulo, pending: kind === 'still' };
      const c = { id: s.id, titulo: s.titulo, kind, url, poster: s.frame?.file ? fileUrl(s.frame.file) : url, dur: shotSeconds, pending: kind === 'still' };
      if (kind === 'video') {
        const v = document.createElement('video');
        v.src = url; v.muted = true; v.playsInline = true; v.preload = 'auto';
        v.addEventListener('loadedmetadata', () => { if (Number.isFinite(v.duration) && v.duration > 0.5) { c.dur = Math.min(v.duration, shotSeconds + 1); layout(); } });
        // En pausa, el cuadro se redibuja cuando el video termina de cargar o de posicionarse.
        ['loadeddata', 'seeked'].forEach((ev) => v.addEventListener(ev, () => { if (!playing) loop(); }));
        c.node = v;
      } else {
        c.img = new Image();
        c.img.onload = () => { if (!playing) loop(); };
        c.img.src = url;
      }
      return c;
    });
    [...old.values()].forEach((c) => { if (!clips.includes(c) && !clips.some((x) => x.node === c.node)) c.node?.removeAttribute('src'); });
  }

  const starts = () => { let acc = 0; return clips.map((c) => { const s = acc; acc += c.dur; return s; }); };

  function layout() {
    total = clips.reduce((a, c) => a + c.dur, 0);
    scrub.max = String(total || 0);
    t = clamp(t, 0, total);
    renderTrack();
    renderTime();
  }

  function renderTrack() {
    track.replaceChildren();
    if (!clips.length) { track.append(el('div', 'st-empty muted small', 'Todavía no hay tomas dibujadas.')); return; }
    clips.forEach((c, i) => {
      const b = el('div', `st-clip${c.pending ? ' pending' : ''}`);
      b.style.flexGrow = String(c.dur);
      b.style.backgroundImage = `url("${c.poster}")`;
      b.draggable = true;
      b.title = `${c.id} · ${c.titulo}${c.pending ? ' · todavía sin video (se ve el cuadro)' : ''}`;
      const tag = el('span', 'st-clip-tag', c.id);
      const moves = el('span', 'st-moves');
      const left = el('button', 'st-move', '‹'); left.type = 'button'; left.disabled = i === 0; left.setAttribute('aria-label', `Mover ${c.id} antes`);
      const right = el('button', 'st-move', '›'); right.type = 'button'; right.disabled = i === clips.length - 1; right.setAttribute('aria-label', `Mover ${c.id} después`);
      left.onclick = (e) => { e.stopPropagation(); move(i, i - 1); };
      right.onclick = (e) => { e.stopPropagation(); move(i, i + 1); };
      moves.append(left, right);
      b.append(tag, moves);
      b.onclick = () => seek(starts()[i] + 0.01);
      b.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', String(i)); b.classList.add('dragging'); });
      b.addEventListener('dragend', () => b.classList.remove('dragging'));
      b.addEventListener('dragover', (e) => { e.preventDefault(); b.classList.add('over'); });
      b.addEventListener('dragleave', () => b.classList.remove('over'));
      b.addEventListener('drop', (e) => { e.preventDefault(); b.classList.remove('over'); move(Number(e.dataTransfer.getData('text/plain')), i); });
      track.append(b);
    });
  }

  function move(from, to) {
    if (recorder || from === to || to < 0 || to >= clips.length || !Number.isInteger(from)) return;
    const [c] = clips.splice(from, 1);
    clips.splice(to, 0, c);
    current = -1;
    layout();
    // El orden guardado incluye también las tomas que todavía no se ven en el montaje.
    const shown = clips.map((x) => x.id);
    const rest = (project.timeline.order.length ? project.timeline.order : project.shots.map((s) => s.id)).filter((id) => !shown.includes(id));
    onOrder([...shown, ...rest]);
  }

  function renderMusic(p) {
    music.replaceChildren();
    const m = p.timeline.music;
    if (!m) {
      const pick = el('label', 'st-add-music');
      const input = el('input');
      input.type = 'file'; input.accept = 'audio/*,.mp3,.m4a,.wav,.aac,.ogg,.flac'; input.hidden = true;
      input.onchange = () => { if (input.files[0]) onMusic(input.files[0]); input.value = ''; };
      pick.append(input, document.createTextNode('♪ Agregar música'));
      const hint = p.story?.musica ? el('span', 'muted small', `El Guionista sugiere: ${p.story.musica}`) : null;
      music.append(pick, ...(hint ? [hint] : []));
      return;
    }
    const name = el('div', 'st-music-name', `♪ ${m.name}`);
    const vol = el('label', 'st-field');
    const volIn = el('input');
    volIn.type = 'range'; volIn.min = 0; volIn.max = 100; volIn.value = String(Math.round(mix.volume * 100));
    const volOut = el('span', 'st-val', `${volIn.value}%`);
    volIn.oninput = () => { mix.volume = volIn.value / 100; volOut.textContent = `${volIn.value}%`; applyGain(); };
    volIn.onchange = () => onMix({ ...mix });
    vol.append(el('span', null, 'Volumen'), volIn, volOut);
    const off = el('label', 'st-field');
    const offIn = el('input');
    offIn.type = 'number'; offIn.min = 0; offIn.step = 0.5; offIn.value = String(mix.offset);
    offIn.onchange = () => { mix.offset = clamp(Number(offIn.value) || 0, 0, 600); offIn.value = String(mix.offset); syncAudio(true); onMix({ ...mix }); };
    off.append(el('span', null, 'Empieza en (s)'), offIn);
    const remove = el('button', 'st-remove', 'Quitar');
    remove.type = 'button';
    remove.onclick = () => { if (!recorder) onRemoveMusic(); };
    const row = el('div', 'st-music-row');
    row.append(vol, off, remove);
    music.append(name, row);
  }

  function setAudio(p) {
    const m = p.timeline.music;
    const k = m ? m.file : '';
    if (k === audioKey) return;
    audioKey = k;
    if (audio) { audio.pause(); audio.removeAttribute('src'); audio.load(); }
    audio = null;
    graph?.source?.disconnect();
    if (graph) graph.source = null;
    if (!m) return;
    audio = el('audio');
    audio.src = fileUrl(m.file);
    audio.preload = 'auto';
    if (graph) connectAudio();
  }

  // ---------- Audio (WebAudio: volumen, fundido y salida para exportar) ----------
  function ensureGraph() {
    if (graph) return graph;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ac = new Ctx();
    const gain = ac.createGain();
    const dest = ac.createMediaStreamDestination();
    gain.connect(ac.destination);
    gain.connect(dest);
    graph = { ac, gain, dest, source: null };
    connectAudio();
    return graph;
  }
  function connectAudio() {
    if (!graph || !audio || audio._connected) return;
    graph.source = graph.ac.createMediaElementSource(audio);
    graph.source.connect(graph.gain);
    audio._connected = true;
  }
  function applyGain() {
    if (!graph) return;
    const tail = clamp((total - t) / FADE_OUT, 0, 1);
    graph.gain.gain.setTargetAtTime(mix.volume * tail, graph.ac.currentTime, 0.03);
  }
  function syncAudio(force = false) {
    if (!audio) return;
    const want = mix.offset + t;
    const inside = Number.isFinite(audio.duration) ? want < audio.duration : true;
    if (!playing || !inside) { if (!audio.paused) audio.pause(); if (force && inside) audio.currentTime = want; return; }
    if (force || Math.abs(audio.currentTime - want) > 0.25) audio.currentTime = want;
    if (audio.paused) audio.play().catch(() => {});
  }

  // ---------- Dibujo ----------
  function cover(src, w, h, zoom = 1) {
    const sw = src.videoWidth || src.naturalWidth;
    const sh = src.videoHeight || src.naturalHeight;
    if (!sw || !sh) return;
    const s = Math.max(w / sw, h / sh) * zoom;
    ctx.drawImage(src, (w - sw * s) / 2, (h - sh * s) / 2, sw * s, sh * s);
  }

  function frame() {
    const { width: w, height: h } = canvas;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
    if (!clips.length) return;
    const st = starts();
    let i = st.findIndex((s, k) => t < s + clips[k].dur);
    if (i < 0) i = clips.length - 1;
    const c = clips[i];
    const local = clamp(t - st[i], 0, c.dur);
    if (i !== current) {
      clips.forEach((x, k) => { if (k !== i && x.node && !x.node.paused) x.node.pause(); });
      current = i;
      if (c.node) { c.node.currentTime = Math.min(local, (c.node.duration || c.dur) - 0.05); }
    }
    if (c.node) {
      if (playing && c.node.paused) c.node.play().catch(() => {});
      if (!playing && !c.node.paused) c.node.pause();
      if (Math.abs(c.node.currentTime - local) > 0.3) c.node.currentTime = local;
      if (c.node.readyState >= 2) cover(c.node, w, h);
    } else if (c.img?.complete) {
      cover(c.img, w, h, 1 + 0.05 * (local / c.dur));
    }
    if (c.pending) {
      ctx.fillStyle = 'rgba(0,0,0,.55)';
      ctx.fillRect(0, h - 34, w, 34);
      ctx.fillStyle = '#fff';
      ctx.font = '600 15px system-ui, sans-serif';
      ctx.fillText(`${c.id} · cuadro (el video todavía no está)`, 12, h - 12);
    }
    // Fundido desde y hacia negro en los extremos (solo reproduciendo: en pausa se ve el cuadro).
    if (!playing) return;
    const edge = Math.min(clamp(t / 0.35, 0, 1), clamp((total - t) / 0.35, 0, 1));
    if (edge < 1) { ctx.fillStyle = `rgba(0,0,0,${1 - edge})`; ctx.fillRect(0, 0, w, h); }
  }

  function renderTime() {
    time.textContent = `${fmt(t)} / ${fmt(total)}`;
    if (document.activeElement !== scrub) scrub.value = String(t);
    playhead.style.left = total ? `${(t / total) * 100}%` : '0';
  }

  function loop() {
    cancelAnimationFrame(raf);
    const tick = () => {
      if (playing) {
        t = (performance.now() - clock) / 1000;
        if (t >= total) { t = total; stop(); }
        syncAudio();
        applyGain();
      }
      frame();
      renderTime();
      if (playing) raf = requestAnimationFrame(tick);
    };
    tick();
  }

  function start() {
    if (!clips.length) return;
    if (t >= total - 0.05) t = 0;
    ensureGraph();
    graph.ac.resume();
    playing = true;
    clock = performance.now() - t * 1000;
    current = -1;
    play.textContent = '❚❚'; play.setAttribute('aria-label', 'Pausar');
    syncAudio(true);
    loop();
  }
  function stop() {
    playing = false;
    play.textContent = '▶'; play.setAttribute('aria-label', 'Reproducir');
    audio?.pause();
    clips.forEach((c) => c.node?.pause());
    if (recorder?.state === 'recording') recorder.stop();
  }
  function seek(x) {
    t = clamp(x, 0, total);
    clock = performance.now() - t * 1000;
    current = -1;
    syncAudio(true);
    applyGain();
    if (!playing) loop();
  }

  play.onclick = () => { if (recorder) return; if (playing) { stop(); loop(); } else start(); };
  scrub.oninput = () => seek(Number(scrub.value));

  // ---------- Exportar ----------
  exportBtn.onclick = async () => {
    if (recorder) { recorder.stop(); return; }
    if (!window.MediaRecorder || !canvas.captureStream) {
      note.hidden = false;
      note.textContent = 'Este navegador no puede exportar video. Probá con Chrome, Edge o Safari actualizados.';
      return;
    }
    if (!clips.length) return;
    const pending = clips.filter((c) => c.pending).map((c) => c.id);
    if (pending.length && !confirm(`${pending.join(', ')} todavía no tiene${pending.length > 1 ? 'n' : ''} video: se exporta${pending.length > 1 ? 'n' : ''} como cuadro fijo. ¿Exportar igual?`)) return;
    const { ac, dest } = ensureGraph();
    await ac.resume();
    const mime = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
      .find((m) => MediaRecorder.isTypeSupported(m)) || '';
    const tracks = [...canvas.captureStream(30).getVideoTracks(), ...(audio ? dest.stream.getAudioTracks() : [])];
    const chunks = [];
    recorder = new MediaRecorder(new MediaStream(tracks), { mimeType: mime || undefined, videoBitsPerSecond: 6_000_000 });
    recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    const progress = setInterval(() => { exportBtn.textContent = `Grabando… ${Math.round((t / total) * 100)}% · detener`; }, 250);
    recorder.onstop = () => {
      clearInterval(progress);
      const type = recorder.mimeType || mime || 'video/webm';
      recorder = null;
      stop();
      exportBtn.textContent = 'Exportar video';
      play.disabled = false; scrub.disabled = false;
      const blob = new Blob(chunks, { type });
      const ext = type.includes('mp4') ? 'mp4' : 'webm';
      const a = el('a', 'download', `Descargar video (${ext.toUpperCase()}, ${(blob.size / 1024 / 1024).toFixed(1)} MB)`);
      a.href = URL.createObjectURL(blob);
      a.download = `${(project?.title || 'historia').replace(/[^\w\- áéíóúñÁÉÍÓÚÑ]+/g, '').trim() || 'historia'}-221.${ext}`;
      note.hidden = false;
      note.replaceChildren(a);
      a.click();
    };
    if (playing) stop();
    t = 0; current = -1;
    loop();
    await new Promise((r) => setTimeout(r, 400)); // que la primera toma llegue a su primer cuadro
    play.disabled = true; scrub.disabled = true;
    note.hidden = false;
    note.textContent = 'Se graba en tiempo real: dejá esta pestaña visible hasta que termine.';
    recorder.start(500);
    start();
  };

  return {
    root,
    busy: () => !!recorder,
    update(p) {
      project = p;
      // La interfaz consulta el proyecto seguido: solo se rearma lo que cambió.
      const order = p.timeline.order.length ? p.timeline.order : p.shots.map((s) => s.id);
      const clipSig = [p.aspect, ...order.map((id) => { const s = p.shots.find((x) => x.id === id); return `${id}:${s?.video?.file || ''}:${s?.frame?.file || ''}`; })].join('|');
      const m = p.timeline.music;
      const musicSig = m ? `${m.file}:${m.volume}:${m.offset}` : '';
      const same = clipSig === lastClips && musicSig === lastMusic;
      lastClips = clipSig; lastMusic = musicSig;
      if (same) return;
      if (!recorder) {
        const [w, h] = SIZES[p.aspect] || SIZES['9:16'];
        if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; stage.style.aspectRatio = `${w} / ${h}`; }
        build(p);
        current = -1;
        layout();
      }
      if (m) mix = { volume: m.volume ?? 0.8, offset: m.offset ?? 0 };
      setAudio(p);
      renderMusic(p);
      applyGain();
      if (!playing) loop();
    },
    pause() { if (playing) { stop(); loop(); } },
    dropMusic(file) { if (!recorder) onMusic(file); },
    destroy() { stop(); cancelAnimationFrame(raf); audio?.pause(); graph?.ac.close?.(); },
  };
}
