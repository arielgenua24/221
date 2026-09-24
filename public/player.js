import { el, fmt } from './shared.js';

// Reproductor del montaje: dibuja en un canvas la toma que corresponde a cada instante de la música,
// con efectos y transiciones, y exporta el resultado (canvas + audio) con MediaRecorder.

const SIZES = { '9:16': [720, 1280], '1:1': [960, 960], '16:9': [1280, 720] };
const FADE = 0.35;
const FLASH = 0.18;
const BLACK = 0.3;

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

function lastBefore(sorted, t) {
  let lo = 0; let hi = sorted.length - 1; let ans = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (sorted[mid] <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
  return ans >= 0 ? sorted[ans] : null;
}

// media: Map id -> { kind: 'video' | 'photo', url, name }
export function createPlayer({ timeline, analysis, audioUrl, media, audioName }) {
  const segs = timeline.segmentos;
  const duration = timeline.duracion;
  const beats = analysis?.beats || [];

  const root = el('div', 'player');
  const stage = el('div', 'stage');
  const canvas = el('canvas');
  const ctx = canvas.getContext('2d');
  stage.append(canvas);
  const audio = el('audio');
  audio.src = audioUrl;
  audio.preload = 'auto';

  // Dos elementos por video (A/B): mientras uno se ve, el otro ya se posiciona en la próxima toma.
  const images = new Map();
  const pools = new Map();
  for (const [id, m] of media) {
    if (m.kind === 'photo') {
      const img = new Image(); img.src = m.url; images.set(id, img);
    } else {
      pools.set(id, [0, 1].map(() => {
        const v = document.createElement('video');
        v.src = m.url; v.muted = true; v.playsInline = true; v.preload = 'auto';
        return v;
      }));
    }
  }
  const uses = new Map();
  segs.forEach((s) => {
    if (!pools.has(s.media)) return;
    const k = uses.get(s.media) || 0;
    s.el = pools.get(s.media)[k % 2];
    uses.set(s.media, k + 1);
  });

  // ---------- Controles ----------
  const controls = el('div', 'player-controls');
  const play = el('button', 'play-btn', '▶');
  play.type = 'button'; play.setAttribute('aria-label', 'Reproducir');
  const time = el('span', 'time', `0:00.0 / ${fmt(duration)}`);
  const aspect = el('select', 'aspect');
  aspect.setAttribute('aria-label', 'Formato');
  Object.keys(SIZES).forEach((k) => aspect.append(new Option(k === '9:16' ? '9:16 vertical' : k === '1:1' ? '1:1 cuadrado' : '16:9 horizontal', k)));
  controls.append(play, time, aspect);

  // ---------- Línea de tiempo ----------
  const tl = el('div', 'tl');
  const pct = (t) => `${(t / duration) * 100}%`;
  const secRow = el('div', 'tl-row tl-sections');
  (timeline.secciones || []).forEach((s) => {
    const b = el('div', 'tl-sec', s.nombre);
    b.style.left = pct(Number(s.inicio) || 0);
    b.style.width = pct(Math.max(0, (Number(s.fin) || 0) - (Number(s.inicio) || 0)));
    b.style.setProperty('--e', clamp(Number(s.energia) || 1, 1, 5) / 5);
    b.title = `${s.nombre} · energía ${s.energia}/5 · ${s.ritmo_de_corte || ''}`;
    secRow.append(b);
  });
  const segRow = el('div', 'tl-row tl-segs');
  segs.forEach((s, i) => {
    const b = el('div', `tl-seg ${media.get(s.media)?.kind || ''}`, s.media);
    b.style.left = pct(s.inicio);
    b.style.width = pct(s.fin - s.inicio);
    b.title = `${fmt(s.inicio)} · ${s.media} · ${s.motivo || ''}`;
    b.dataset.i = i;
    segRow.append(b);
  });
  const marks = el('div', 'tl-row tl-marks');
  (timeline.momentos || []).forEach((m) => {
    const d = el('span', 'tl-mark', '◆');
    d.style.left = pct(Number(m.t) || 0);
    d.title = `${fmt(Number(m.t) || 0)} · ${m.tipo}: ${m.que_pasa || ''}`;
    marks.append(d);
  });
  const head = el('div', 'tl-head');
  tl.append(marks, secRow, segRow, head);

  // ---------- Exportar ----------
  const actions = el('div', 'actions');
  const exportBtn = el('button', 'primary', 'Exportar video');
  exportBtn.type = 'button';
  const edlBtn = el('button', 'ghost', 'Descargar montaje (JSON)');
  edlBtn.type = 'button';
  actions.append(exportBtn, edlBtn);
  const exportNote = el('p', 'muted small export-note');
  exportNote.hidden = true;

  // ---------- Lista de cortes ----------
  const list = el('details', 'seg-list');
  list.append(el('summary', null, `Ver el montaje corte por corte (${segs.length})`));
  const ol = el('ol');
  segs.forEach((s) => {
    const li = el('li');
    const extra = [s.desde !== undefined ? `desde ${s.desde.toFixed(1)} s` : null, s.efecto !== 'ninguno' ? s.efecto : null, s.transicion !== 'corte' ? s.transicion : null].filter(Boolean).join(' · ');
    li.append(el('span', 'seg-time', `${fmt(s.inicio)}–${fmt(s.fin)}`), el('strong', null, ` ${s.media}`), document.createTextNode(extra ? ` · ${extra}` : ''));
    if (s.motivo) li.append(el('span', 'seg-why', s.motivo));
    ol.append(li);
  });
  list.append(ol);

  root.append(stage, controls, tl, actions, exportNote, list);

  // ---------- Dibujo ----------
  let W = 0; let H = 0;
  function setAspect(k) {
    [W, H] = SIZES[k];
    canvas.width = W; canvas.height = H;
    stage.style.aspectRatio = `${W} / ${H}`;
    draw(audio.currentTime || 0);
  }

  let cur = 0;
  function segAt(t) {
    if (segs[cur] && t >= segs[cur].inicio && t < segs[cur].fin) return cur;
    const i = segs.findIndex((s) => t >= s.inicio && t < s.fin);
    cur = i >= 0 ? i : segs.length - 1;
    return cur;
  }

  function transform(s, t) {
    const p = clamp((t - s.inicio) / Math.max(0.01, s.fin - s.inicio), 0, 1);
    const photo = !s.el;
    switch (s.efecto) {
      case 'zoom_in': return { s: 1 + 0.12 * p, dx: 0 };
      case 'zoom_out': return { s: 1.12 - 0.12 * p, dx: 0 };
      case 'paneo_izq': return { s: 1.15, dx: (0.5 - p) * 2 };
      case 'paneo_der': return { s: 1.15, dx: (p - 0.5) * 2 };
      case 'pulso': {
        const b = lastBefore(beats, t);
        const since = b === null ? 9 : t - b;
        return { s: 1.03 + 0.07 * Math.exp(-since * 9), dx: 0 };
      }
      default: return { s: photo ? 1 + 0.05 * p : 1, dx: 0 }; // una foto nunca queda quieta
    }
  }

  // Dibuja la fuente cubriendo todo el cuadro. dx en [-1, 1] recorre el sobrante horizontal.
  function drawSeg(s, t, alpha = 1) {
    const src = s.el || images.get(s.media);
    if (!src) return false;
    const sw = src.videoWidth || src.naturalWidth;
    const sh = src.videoHeight || src.naturalHeight;
    if (!sw || !sh || (s.el && s.el.readyState < 2)) return false;
    const { s: k, dx } = transform(s, t);
    const base = Math.max(W / sw, H / sh) * k;
    const dw = sw * base; const dh = sh * base;
    const room = (dw - W) / 2;
    ctx.globalAlpha = alpha;
    ctx.drawImage(src, (W - dw) / 2 + dx * room, (H - dh) / 2, dw, dh);
    ctx.globalAlpha = 1;
    return true;
  }

  function syncVideos(i, t, playing) {
    const s = segs[i];
    const active = new Set();
    if (s?.el) {
      active.add(s.el);
      const want = s.desde + (t - s.inicio);
      if (want < s.el.duration - 0.05) {
        if (Math.abs(s.el.currentTime - want) > 0.25 && !s.el.seeking) s.el.currentTime = want;
        if (playing && s.el.paused) s.el.play().catch(() => {});
        if (!playing && !s.el.paused) s.el.pause();
      } else if (!s.el.paused) s.el.pause(); // el video es más corto que la toma: se congela
    }
    const prev = segs[i - 1];
    if (prev?.el && s?.transicion === 'fundido' && t - s.inicio < FADE) active.add(prev.el);
    // Preposicionar la próxima toma para que el corte sea limpio.
    const next = segs[i + 1];
    if (next?.el && next.el !== s?.el) {
      active.add(next.el);
      if (!next.el.seeking && Math.abs(next.el.currentTime - next.desde) > 0.05) next.el.currentTime = next.desde;
      if (!next.el.paused) next.el.pause();
    }
    for (const pool of pools.values()) for (const v of pool) if (!active.has(v) && !v.paused) v.pause();
  }

  function draw(t) {
    if (!W || !segs.length) return;
    const i = segAt(t);
    const s = segs[i];
    const since = t - s.inicio;
    if (s.transicion === 'negro' && since < BLACK) {
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
      drawSeg(s, t, since / BLACK);
    } else if (s.transicion === 'fundido' && i > 0 && since < FADE) {
      drawSeg(segs[i - 1], t);
      drawSeg(s, t, since / FADE);
    } else {
      drawSeg(s, t);
    }
    if (s.transicion === 'flash' && since < FLASH) {
      ctx.fillStyle = `rgba(255,255,255,${0.85 * (1 - since / FLASH)})`;
      ctx.fillRect(0, 0, W, H);
    }
    time.textContent = `${fmt(t)} / ${fmt(duration)}`;
    head.style.left = pct(Math.min(t, duration));
    segRow.querySelector('.now')?.classList.remove('now');
    segRow.children[i]?.classList.add('now');
  }

  let raf = 0;
  function loop() {
    const t = audio.currentTime;
    syncVideos(segAt(t), t, !audio.paused);
    draw(t);
    raf = audio.paused ? 0 : requestAnimationFrame(loop);
  }
  const kick = () => { if (!raf) raf = requestAnimationFrame(loop); };

  audio.addEventListener('play', () => { play.textContent = '❚❚'; play.setAttribute('aria-label', 'Pausar'); kick(); });
  audio.addEventListener('pause', () => { play.textContent = '▶'; play.setAttribute('aria-label', 'Reproducir'); loop(); });
  audio.addEventListener('seeked', () => loop());
  play.onclick = () => { if (audio.paused) audio.play(); else audio.pause(); };
  aspect.onchange = () => setAspect(aspect.value);
  tl.addEventListener('click', (e) => {
    const r = tl.getBoundingClientRect();
    audio.currentTime = clamp((e.clientX - r.left) / r.width, 0, 1) * duration;
  });
  // Redibuja cuando termina de cargar/posicionar cualquier fuente (con el audio en pausa).
  for (const pool of pools.values()) for (const v of pool) v.addEventListener('seeked', () => { if (audio.paused) draw(audio.currentTime); });
  for (const img of images.values()) img.addEventListener('load', () => { if (audio.paused) draw(audio.currentTime); });

  // ---------- Exportación ----------
  let graph = null;
  function audioGraph() {
    if (graph) return graph;
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    const source = ac.createMediaElementSource(audio);
    const dest = ac.createMediaStreamDestination();
    source.connect(ac.destination);
    source.connect(dest);
    graph = { ac, dest };
    return graph;
  }

  let recorder = null;
  exportBtn.onclick = async () => {
    if (recorder) { recorder.stop(); return; }
    if (!window.MediaRecorder || !canvas.captureStream) {
      exportNote.hidden = false;
      exportNote.textContent = 'Este navegador no puede exportar video. Probá con Chrome, Edge o Safari actualizados.';
      return;
    }
    const { ac, dest } = audioGraph();
    await ac.resume();
    const mime = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
      .find((m) => MediaRecorder.isTypeSupported(m)) || '';
    const stream = new MediaStream([...canvas.captureStream(30).getVideoTracks(), ...dest.stream.getAudioTracks()]);
    const chunks = [];
    recorder = new MediaRecorder(stream, { mimeType: mime || undefined, videoBitsPerSecond: 8_000_000 });
    recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    const onTime = () => { exportBtn.textContent = `Grabando… ${Math.round((audio.currentTime / duration) * 100)}% · detener`; };
    const onEnd = () => recorder?.state === 'recording' && recorder.stop();
    recorder.onstop = () => {
      audio.removeEventListener('timeupdate', onTime);
      audio.removeEventListener('ended', onEnd);
      audio.pause();
      const type = recorder.mimeType || mime || 'video/webm';
      recorder = null;
      exportBtn.textContent = 'Exportar video';
      [aspect, play].forEach((b) => { b.disabled = false; });
      const blob = new Blob(chunks, { type });
      const ext = type.includes('mp4') ? 'mp4' : 'webm';
      const a = el('a', 'download', `Descargar video (${ext.toUpperCase()}, ${(blob.size / 1024 / 1024).toFixed(1)} MB)`);
      a.href = URL.createObjectURL(blob);
      a.download = `${(audioName || 'edicion').replace(/\.[^.]+$/, '')}-221.${ext}`;
      exportNote.hidden = false;
      exportNote.replaceChildren(a);
      a.click();
    };
    audio.pause();
    audio.currentTime = 0;
    await new Promise((r) => setTimeout(r, 400)); // que los videos lleguen a su primer cuadro
    [aspect, play].forEach((b) => { b.disabled = true; });
    exportNote.hidden = false;
    exportNote.textContent = 'Se graba en tiempo real: dejá esta pestaña visible hasta que termine.';
    audio.addEventListener('timeupdate', onTime);
    audio.addEventListener('ended', onEnd);
    recorder.start(500);
    audio.play();
  };

  edlBtn.onclick = () => {
    const clean = { ...timeline, segmentos: segs.map(({ el: _el, ...s }) => s) };
    const a = el('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(clean, null, 2)], { type: 'application/json' }));
    a.download = 'montaje-221.json';
    a.click();
  };

  setAspect('9:16');
  return root;
}
