import { $, el, fmt, append, showError, createSteps, setStatus, handleCommon, streamEvents, lockDecision } from './shared.js';
import { kindOf, loadAudio, loadVideo, loadPhoto } from './media.js';
import { handleIdeas } from './ideas.js';
import { handleEdit, editRequestMedia } from './edit.js';
import { createStudio, handleIntuition } from './intuition.js';

// Una sola caja de chat: se sueltan (o pegan, o eligen) videos, audios, fotos y texto.
// Tres modos: "ideas" (fotos + texto → ideas de contenido), "edicion" (música + tomas → video montado)
// e "intuition" (un video + 3 clips → motion design generado como código, encima del video).
const input = $('text');
const cfg = { maxPhotos: 8, maxMedia: 24, maxFrames: 60 };
let music = null; // { name, url, duration, wav, from }
let items = []; // tomas: { key, kind, status: 'loading' | 'ready', id, name, url, duration, frames, thumb, full, file }
let loadingMusic = false;
let mode = 'ideas';
let modeChosen = false; // el humano eligió el modo a mano: no lo cambiamos solos
let controller = null;
let seq = 0;
const studio = createStudio({ onChange: () => refresh() });

// ---------- Configuración ----------
fetch('/api/config').then((r) => r.json()).then((c) => {
  Object.assign(cfg, c);
  if (c.intuition) studio.setLimits(c.intuition);
  const m = $('mode');
  m.textContent = c.mock ? 'Demo' : 'En vivo';
  m.title = `Ideas → orquestador: ${c.orchestratorModel} · investigador: ${c.researcherModel} · crítico: ${c.criticModel}\nEdición → Director: ${c.directorModel} · Oído: ${c.earModel}\nIntuition → Director de Arte y Motion Designers: ${c.motionModel}`;
  if (c.mock) m.classList.add('demo');
});

// ---------- Modo ----------
function setMode(next, chosen = false) {
  mode = next;
  if (chosen) modeChosen = true;
  document.querySelectorAll('.mode').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.mode === mode)));
  input.placeholder = { edicion: '¿Qué querés transmitir con el video?', intuition: 'Dirección general del motion (opcional): marca, estilo, qué querés contar…' }[mode] || 'Contá qué hacés…';
  // Si ya había un video cargado en la caja, es el video de Intuition.
  if (mode === 'intuition' && !studio.hasVideo() && !studio.busy()) {
    const v = items.find((m) => m.kind === 'video' && m.status === 'ready');
    if (v) studio.setVideo(v.file);
  }
  refresh();
}
document.querySelectorAll('.mode').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode, true)));

// Sin elección manual: si hay música o videos, o el texto habla de editar, es edición.
function autoMode() {
  if (modeChosen || mode === 'intuition') return;
  const wantsEdit = !!music || loadingMusic || items.some((m) => m.kind === 'video') || /\bedici[oó]n|\bedit(a|á|ar|en)\b|\bmont(a|á|ar|aje)\b/i.test(input.value);
  if ((mode === 'edicion') !== wantsEdit) setMode(wantsEdit ? 'edicion' : 'ideas');
}

// ---------- Composer ----------
function autosize() { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 160)}px`; }
input.addEventListener('input', () => { autosize(); autoMode(); refresh(); });
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && matchMedia('(pointer: fine)').matches) { e.preventDefault(); $('form').requestSubmit(); }
});
document.querySelectorAll('.example').forEach((b) => b.addEventListener('click', () => {
  input.value = b.dataset.text; autosize(); autoMode(); refresh(); input.focus();
}));

const ready = () => items.filter((m) => m.status === 'ready');
const busy = () => loadingMusic || items.some((m) => m.status === 'loading');

// Qué falta para poder enviar en el modo actual (null = listo).
function missing() {
  if (mode === 'intuition') return studio.missing();
  if (busy()) return 'Preparando tus archivos…';
  if (mode === 'edicion') {
    if (!music) return items.some((m) => m.kind === 'video') ? 'Falta la música: soltá un audio o tocá ♪ en un video para usar su sonido.' : 'Soltá la música (audio) y tus videos o fotos.';
    if (!ready().length) return 'Falta el material: soltá videos o fotos.';
  }
  return null;
}

function hintText() {
  if (mode === 'intuition') return studio.hint();
  const why = missing();
  if (why) return why;
  if (mode === 'edicion') {
    const v = ready().filter((m) => m.kind === 'video').length;
    const f = ready().length - v;
    return `Listo: 🎵 ${music.name} (${fmt(music.duration)}) + ${[v && `${v} video${v > 1 ? 's' : ''}`, f && `${f} foto${f > 1 ? 's' : ''}`].filter(Boolean).join(' y ')}`;
  }
  const ignored = items.some((m) => m.kind === 'video') || music;
  return ignored ? 'En Ideas solo uso las fotos y el texto; los videos y la música son para Edición.' : '';
}

function canSend() {
  if (controller) return true;
  if (mode === 'intuition' || mode === 'edicion') return !missing();
  if (busy()) return false;
  return !!input.value.trim() || ready().some((m) => m.kind === 'photo');
}

function refresh() {
  const running = !!controller;
  $('send-icon').toggleAttribute('hidden', running);
  $('stop-icon').toggleAttribute('hidden', !running);
  $('send').title = running ? 'Detener' : { edicion: 'Editar', intuition: 'Generar motion design' }[mode] || 'Enviar';
  $('send').disabled = !canSend();
  const hint = $('hint');
  hint.textContent = running ? '' : hintText();
  hint.hidden = !hint.textContent;
  renderThumbs();
}

// ---------- Archivos: soltar, pegar o elegir ----------
async function setMusic(loader, from) {
  loadingMusic = true;
  autoMode(); refresh();
  try {
    const next = await loader();
    if (music && !music.from) URL.revokeObjectURL(music.url);
    music = { ...next, from };
  } catch (err) {
    showError(err.message);
  } finally {
    loadingMusic = false;
    autoMode(); refresh();
  }
}

function renumber() {
  let v = 0; let f = 0;
  items.forEach((m) => { m.id = m.kind === 'video' ? `V${++v}` : `F${++f}`; });
}

async function addFiles(files) {
  showError('');
  const list = [...files];
  // En Intuition la caja recibe UN video; las referencias se agregan en cada clip.
  if (mode === 'intuition') {
    const vids = list.filter((f) => kindOf(f) === 'video');
    if (!vids.length) return showError('En Intuition soltá un video. Las referencias (imágenes, videos, GIFs) se agregan en cada clip.');
    if (vids.length > 1 || vids.length < list.length) showError(`Usé "${vids[0].name}" como video. Las referencias se agregan en cada clip.`);
    return studio.setVideo(vids[0]);
  }
  const audios = list.filter((f) => kindOf(f) === 'audio');
  const visuals = list.filter((f) => ['video', 'photo'].includes(kindOf(f)));
  const unknown = list.filter((f) => !kindOf(f));
  if (unknown.length) showError(`No sé qué hacer con: ${unknown.map((f) => f.name).join(', ')}`);
  if (audios.length > 1) showError(`Usé "${audios.at(-1).name}" como música (una por video).`);
  if (audios.length) setMusic(() => loadAudio(audios.at(-1)), null);

  const room = cfg.maxMedia - items.length;
  if (visuals.length > room) showError(`Máximo ${cfg.maxMedia} videos y fotos: dejé afuera ${visuals.length - Math.max(0, room)}.`);
  const added = visuals.slice(0, Math.max(0, room)).map((file) => ({ key: ++seq, kind: kindOf(file), status: 'loading', name: file.name, file }));
  items.push(...added);
  renumber(); autoMode(); refresh();
  await Promise.all(added.map(async (item) => {
    try {
      Object.assign(item, await (item.kind === 'video' ? loadVideo(item.file) : loadPhoto(item.file)), { status: 'ready' });
    } catch (err) {
      showError(`${item.name}: ${err.message}`);
      items = items.filter((m) => m !== item);
      renumber();
    }
    refresh();
  }));
}

$('file').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });

input.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) { e.preventDefault(); addFiles(files); }
});

// Arrastrar y soltar en cualquier parte de la página.
let dragDepth = 0;
const dropZone = $('drop');
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].some((t) => t === 'Files' || t === 'text/plain');
window.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; dropZone.hidden = false; });
window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) dropZone.hidden = true; });
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0; dropZone.hidden = true;
  const files = [...(e.dataTransfer?.files || [])];
  if (files.length) return addFiles(files);
  const text = e.dataTransfer?.getData('text/plain');
  if (text) { input.value = `${input.value}${input.value ? '\n' : ''}${text}`; autosize(); autoMode(); refresh(); }
});

function renderThumbs() {
  const box = $('thumbs');
  box.replaceChildren();
  if (mode === 'intuition') return; // el video y los clips viven en el estudio (en el feed)
  if (music || loadingMusic) {
    const chip = el('div', `audio-chip${loadingMusic ? ' loading' : ''}`);
    if (loadingMusic) chip.append(el('span', null, '🎵'), el('span', 'audio-name', 'Leyendo la música…'));
    else {
      chip.append(el('span', null, '🎵'), el('span', 'audio-name', music.from ? `Sonido de ${music.from}` : music.name), el('span', 'muted', fmt(music.duration)));
      const x = el('button', null, '×');
      x.type = 'button'; x.setAttribute('aria-label', 'Quitar música');
      x.onclick = () => { if (!music.from) URL.revokeObjectURL(music.url); music = null; autoMode(); refresh(); };
      chip.append(x);
    }
    box.append(chip);
  }
  items.forEach((m) => {
    const t = el('div', `thumb${m.status === 'loading' ? ' loading' : ''}`);
    if (m.status === 'loading') t.append(el('span', 'thumb-kind', m.kind === 'video' ? '🎞️' : '🖼️'));
    else {
      const img = el('img');
      img.src = m.thumb; img.alt = m.name;
      t.append(img, el('span', 'badge', m.kind === 'video' ? `${m.id} · ${Math.round(m.duration)}s` : m.id));
      // En edición, sin música: se puede usar el sonido de un video.
      if (m.kind === 'video' && mode === 'edicion' && !music && !loadingMusic) {
        const use = el('button', 'use-sound', '♪');
        use.type = 'button'; use.title = 'Usar su sonido como música'; use.setAttribute('aria-label', `Usar el sonido de ${m.id} como música`);
        use.onclick = () => setMusic(() => loadAudio(m.file), m.id);
        t.append(use);
      }
    }
    const x = el('button', 'remove', '×');
    x.type = 'button'; x.setAttribute('aria-label', `Quitar ${m.id || m.name}`);
    x.onclick = () => {
      items = items.filter((i) => i !== m);
      if (music?.from === m.id) music = null;
      if (m.url) URL.revokeObjectURL(m.url);
      renumber(); autoMode(); refresh();
    };
    t.append(x);
    box.append(t);
  });
}

// ---------- Enviar / detener ----------
$('form').addEventListener('submit', (e) => {
  e.preventDefault();
  if (controller) { controller.abort(); return; }
  const why = missing();
  if (why) return showError(why);
  if (!canSend()) return;
  run();
});

async function run() {
  if (mode === 'intuition') return runIntuition();
  $('welcome')?.remove();
  showError('');
  const text = input.value.trim();
  const sentItems = ready();
  const sentMusic = music;
  const flow = mode;

  // Mensaje del humano en el chat.
  const msg = append(el('div', 'msg user-msg'));
  const shown = flow === 'edicion' ? sentItems : sentItems.filter((m) => m.kind === 'photo');
  if (shown.length) {
    const strip = el('div', 'user-photos');
    shown.slice(0, 12).forEach((m) => { const i = el('img'); i.src = m.thumb; i.alt = m.id; strip.append(i); });
    msg.append(strip);
  }
  const lines = [];
  if (flow === 'edicion') lines.push(`🎬 Edición · 🎵 ${sentMusic.from ? `sonido de ${sentMusic.from}` : sentMusic.name} (${fmt(sentMusic.duration)}) · ${sentItems.length} tomas`);
  if (text) lines.push(text);
  if (lines.length) msg.append(el('div', 'bubble', lines.join('\n')));

  let url; let body; let handler;
  const steps = createSteps();
  if (flow === 'edicion') {
    const ctx = { audio: sentMusic, media: new Map(sentItems.map((m) => [m.id, m])), analysis: null };
    url = '/api/edit';
    body = JSON.stringify({ text, audio: { name: sentMusic.name, wav: sentMusic.wav }, media: editRequestMedia(sentItems, cfg.maxFrames) });
    handler = (ev) => handleEdit(ev, steps, ctx);
  } else {
    const photos = sentItems.filter((m) => m.kind === 'photo').slice(0, cfg.maxPhotos).map((m) => m.full);
    url = '/api/run';
    body = JSON.stringify({ text, photos });
    handler = (ev) => handleIdeas(ev, steps);
  }

  // Se vacía la caja (sin liberar los archivos: el reproductor los sigue usando).
  input.value = ''; autosize();
  items = []; music = null;
  controller = new AbortController();
  refresh();

  try {
    await streamEvents(url, body, controller.signal, (ev) => { if (!handleCommon(ev, steps)) handler(ev); });
  } catch (e) {
    if (e.name === 'AbortError') append(el('div', 'msg note', 'Detuviste el trabajo del equipo.'));
    else showError(e.message);
  } finally {
    steps.all().forEach((s) => { if (s.status.classList.contains('running')) setStatus(s, 'fail'); });
    document.querySelectorAll('.decision:not(.done)').forEach(lockDecision);
    controller = null;
    refresh();
  }
}

// ---------- Intuition: el estudio arma el pedido (cuadros de cada clip + referencias) ----------
async function runIntuition() {
  showError('');
  const text = input.value.trim();
  controller = new AbortController();
  refresh();
  const msg = append(el('div', 'msg user-msg'));
  const strip = el('div', 'user-photos');
  studio.thumbs().forEach((u) => { const i = el('img'); i.src = u; i.alt = ''; strip.append(i); });
  msg.append(strip, el('div', 'bubble', [studio.summary(), text].filter(Boolean).join('\n')));
  const steps = createSteps();
  try {
    const { body, ctx } = await studio.request(text);
    input.value = ''; autosize();
    await streamEvents('/api/intuition', body, controller.signal, (ev) => {
      // step_error también le importa al reproductor (marca el clip que falló).
      if (!handleCommon(ev, steps) || ev.type === 'step_error') handleIntuition(ev, steps, ctx);
    });
  } catch (e) {
    if (e.name === 'AbortError') append(el('div', 'msg note', 'Detuviste el trabajo del equipo.'));
    else showError(e.message);
  } finally {
    steps.all().forEach((s) => { if (s.status.classList.contains('running')) setStatus(s, 'fail'); });
    controller = null;
    refresh();
  }
}

// /?modo=edicion o /?modo=intuition (va al final: setMode usa funciones definidas más arriba).
const modoUrl = new URLSearchParams(location.search).get('modo');
if (['edicion', 'intuition'].includes(modoUrl)) setMode(modoUrl, true);
refresh();
