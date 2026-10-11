import { el } from './shared.js';
import { resultOf, specOf } from './table-core.js';

// Mesa de agentes · la película: las tomas en orden con lo que ya se produjo. Si la toma tiene video, se ve el video;
// si solo tiene cuadro, el cuadro con un movimiento lento; si no, su descripción. La voz y el sonido de cada toma
// suenan encima, la música de fondo corre toda la pieza y la línea de la voz va como subtítulo.
// Es una vista previa en el navegador (no exporta un archivo): sirve para decidir qué corregir.
const plain = (t) => String(t || '').replace(/\[[^\]]{1,30}\]\s*/g, '').trim();
const clock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

export function createPlayer(mount, prod) {
  const [w, h] = prod.proporcion.split(':').map(Number);
  const root = el('div', 'prod-player');
  const stage = el('div', 'prod-stage');
  stage.style.aspectRatio = `${w} / ${h}`;
  stage.classList.add(w < h ? 'tall' : 'wide');
  const img = el('img', 'prod-stage-img'); img.alt = '';
  const video = el('video', 'prod-stage-video'); video.muted = true; video.playsInline = true; video.preload = 'auto';
  const blank = el('div', 'prod-stage-blank');
  const badge = el('div', 'prod-stage-badge');
  const caption = el('div', 'prod-caption');
  stage.append(img, video, blank, badge, caption);
  const timeline = el('div', 'prod-timeline');
  const controls = el('div', 'actions compact prod-player-controls');
  const play = el('button', 'small-btn', '▶ Reproducir'); play.type = 'button';
  const again = el('button', 'small-btn', '⟲ Desde el principio'); again.type = 'button';
  const time = el('span', 'muted small');
  const note = el('span', 'muted small');
  controls.append(play, again, time, note);
  root.append(stage, timeline, controls);
  mount.replaceChildren(root);

  const audio = (url, volume = 1) => { if (!url) return null; const a = new Audio(url); a.preload = 'auto'; a.volume = volume; return a; };
  const shots = prod.shots.map((s) => ({
    s, frame: resultOf(s.parts.cuadro)?.url || null, clip: resultOf(s.parts.video)?.url || null,
    voice: audio(resultOf(s.parts.voz)?.url), sound: audio(resultOf(s.parts.sonido)?.url, 0.8),
    text: plain(specOf(s.parts.voz)?.texto),
  }));
  const music = audio(resultOf(prod.musica)?.url, 0.35);
  if (music) music.loop = true;
  const missing = shots.filter((x) => !x.frame && !x.clip).length;
  note.textContent = missing ? `${missing} toma${missing > 1 ? 's' : ''} sin cuadro ni video todavía` : '';

  // Cada toma dura lo que dice la entrega, o lo que dure su voz si es más larga (no se corta a nadie).
  const length = (x) => Math.max(x.s.duracion, Number.isFinite(x.voice?.duration) ? x.voice.duration + 0.25 : 0);
  const total = () => shots.reduce((s, x) => s + length(x), 0);

  const segs = shots.map((x, i) => {
    const seg = el('button', 'prod-seg'); seg.type = 'button';
    seg.title = `${x.s.id} · ${x.s.titulo}`;
    seg.append(el('span', 'prod-seg-fill'), el('span', 'prod-seg-label', x.s.id));
    seg.onclick = () => go(i, 0);
    timeline.append(seg);
    return seg;
  });
  const layout = () => { shots.forEach((x, i) => { segs[i].style.flexGrow = String(length(x)); }); };
  shots.forEach((x) => x.voice?.addEventListener('loadedmetadata', layout));
  layout();

  let current = 0, playing = false, t0 = 0, elapsed = 0, raf = 0;
  const shotMedia = (x) => [x.voice, x.sound].filter(Boolean);

  function show(i, offset) {
    const x = shots[i];
    current = i;
    badge.textContent = `${x.s.id} · ${x.s.titulo}`;
    caption.textContent = x.text;
    caption.hidden = !x.text;
    img.hidden = video.hidden = blank.hidden = true;
    if (x.clip) {
      if (video.getAttribute('src') !== x.clip) video.src = x.clip;
      video.currentTime = offset;
      video.hidden = false;
    } else if (x.frame) {
      img.src = x.frame;
      img.style.animation = 'none'; void img.offsetWidth;
      img.style.animation = `prod-kenburns ${length(x)}s linear forwards`;
      img.style.animationDelay = `-${offset}s`;
      img.style.animationPlayState = playing ? 'running' : 'paused';
      img.hidden = false;
    } else {
      blank.textContent = x.s.descripcion || x.s.titulo;
      blank.hidden = false;
    }
    segs.forEach((seg, k) => seg.classList.toggle('current', k === i));
  }

  function startMedia(offset) {
    const x = shots[current];
    for (const a of shotMedia(x)) {
      if (!Number.isFinite(a.duration) || offset < a.duration) { try { a.currentTime = offset; } catch { /* todavía sin datos */ } a.play().catch(() => {}); }
    }
    if (x.clip) video.play().catch(() => {});
    img.style.animationPlayState = 'running';
  }
  function pauseShot(x) { for (const a of shotMedia(x)) a.pause(); }

  function paint(now) {
    const t = playing ? (now - t0) / 1000 : elapsed;
    const before = shots.slice(0, current).reduce((s, x) => s + length(x), 0);
    time.textContent = `${clock(before + Math.min(t, length(shots[current])))} / ${clock(total())}`;
    segs.forEach((seg, k) => { seg.firstChild.style.width = `${k < current ? 100 : k > current ? 0 : Math.min(100, (t / length(shots[k])) * 100)}%`; });
    return t;
  }

  function tick(now) {
    const t = paint(now);
    if (t >= length(shots[current])) {
      if (current + 1 < shots.length) { pauseShot(shots[current]); show(current + 1, 0); t0 = now; startMedia(0); }
      else { finish(); return; }
    }
    raf = requestAnimationFrame(tick);
  }

  function go(i, offset) {
    pauseShot(shots[current]);
    video.pause();
    show(i, offset);
    elapsed = offset;
    t0 = performance.now() - offset * 1000;
    if (playing) startMedia(offset);
    paint(performance.now());
  }

  function resume() {
    playing = true;
    play.textContent = '❚❚ Pausa';
    t0 = performance.now() - elapsed * 1000;
    startMedia(elapsed);
    music?.play().catch(() => {});
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(tick);
  }
  function pause() {
    if (!playing) return;
    elapsed = (performance.now() - t0) / 1000;
    playing = false;
    play.textContent = '▶ Reproducir';
    cancelAnimationFrame(raf);
    pauseShot(shots[current]); video.pause(); music?.pause();
    img.style.animationPlayState = 'paused';
  }
  function finish() {
    pause();
    elapsed = 0;
    if (music) music.currentTime = 0;
    play.textContent = '▶ Otra vez';
    paint(performance.now());
  }

  play.onclick = () => {
    if (playing) return pause();
    if (play.textContent.includes('Otra vez')) { go(0, 0); }
    resume();
  };
  again.onclick = () => { if (music) music.currentTime = 0; go(0, 0); if (!playing) resume(); };

  show(0, 0);
  paint(performance.now());
  resume(); // se abrió con un toque: el navegador deja sonar

  return {
    stop() {
      pause();
      for (const x of shots) pauseShot(x);
      video.removeAttribute('src'); video.load();
    },
  };
}
