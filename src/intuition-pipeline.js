import { createAgentRunner } from './agent.js';
import { FONTS } from '../public/motion-lib.js';
import { SOUNDS, normalizeScore } from '../public/sound-lib.js';
import {
  ART_DIRECTOR_SYSTEM, MOTION_SYSTEM, directionPrompt, motionPrompt, revisionPrompt, parseMotion, motionFix,
  VIDEO_DIRECTOR_SYSTEM, videoDirectorPrompt, videoRevisionPrompt, storyboardImagePrompt, finalVideoPrompt, TEXT_LAYER_SYSTEM, textLayerPrompt,
} from './intuition-prompts.js';
import { VIDEO_MODELS, DEFAULT_VIDEO_MODEL, EDIT_MODEL, videoSeconds, nearestRatio, storyboardLayout, mediaDataUrl } from './wavespeed.js';
import { CINE_SYSTEM, cinePrompt, cineRevisionPrompt, refilmPrompt } from './cine-prompts.js';
import { normalizeTreatment } from '../public/cine-lib.js';

export const MAX_CLIPS = 3;
export const MAX_CLIP_SECONDS = 5;
export const MIN_CLIP_SECONDS = 0.5;
export const CLIP_FRAMES = 6; // cuadros por clip que ve el Motion Designer
const DIRECTOR_FRAMES = 3; // cuadros por clip que ve el Director de Arte
export const MAX_REFS = 4; // referencias visuales por clip
const REF_FRAMES = 4; // cuadros por referencia de video/GIF
const DEFAULT_BOX = { x: 0.08, y: 0.14, w: 0.84, h: 0.3 };
export const MAX_STORYBOARD_ROUNDS = 6; // storyboards por clip antes de pedir que se genere igual

const num = (x, fallback = 0) => (Number.isFinite(Number(x)) ? Number(x) : fallback);
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const isImage = (u) => typeof u === 'string' && u.startsWith('data:image/');
const MODES = ['motion', 'ai', 'cine'];
export const MAX_CLIP_VIDEO_BYTES = 30 * 1024 * 1024; // el clip grabado en el navegador para re-filmar (data URL)

// Ventana del overlay en fracciones del cuadro, siempre dentro del cuadro y con un tamaño mínimo.
export function sanitizeBox(b, fallback = DEFAULT_BOX) {
  if (!b || typeof b !== 'object') return { ...fallback };
  const w = clamp(num(b.w, fallback.w), 0.1, 1);
  const h = clamp(num(b.h, fallback.h), 0.05, 1);
  return { x: clamp(num(b.x, fallback.x), 0, 1 - w), y: clamp(num(b.y, fallback.y), 0, 1 - h), w, h };
}

function parseFrames(list, max) {
  return (Array.isArray(list) ? list : [])
    .filter((f) => isImage(f?.url))
    .slice(0, max)
    .map((f) => ({ t: Math.max(0, num(f.t)), url: f.url }));
}

function parseClip(c, video) {
  const start = num(c?.start, NaN);
  const end = num(c?.end, NaN);
  if (!Number.isFinite(start) || !Number.isFinite(end)) throw new Error('Cada clip necesita inicio y fin.');
  if (start < 0 || end > video.duration + 0.05) throw new Error('Un clip se sale del video.');
  const len = end - start;
  if (len < MIN_CLIP_SECONDS - 0.01) throw new Error(`Cada clip tiene que durar al menos ${MIN_CLIP_SECONDS} s.`);
  if (len > MAX_CLIP_SECONDS + 0.05) throw new Error(`Cada clip dura como máximo ${MAX_CLIP_SECONDS} s.`);
  const frames = parseFrames(c.frames, CLIP_FRAMES);
  if (!frames.length) throw new Error('Faltan los cuadros de un clip.');
  const refs = (Array.isArray(c.refs) ? c.refs : []).slice(0, MAX_REFS).flatMap((r, i) => {
    const kind = r?.kind === 'video' ? 'video' : 'image';
    const fr = (Array.isArray(r?.frames) ? r.frames : []).filter(isImage).slice(0, kind === 'video' ? REF_FRAMES : 1);
    return fr.length ? [{ id: `R${i + 1}`, kind, name: String(r.name || '').slice(0, 80), frames: fr }] : [];
  });
  return {
    id: String(c.id),
    start,
    end: Math.min(end, video.duration),
    prompt: String(c.prompt || '').slice(0, 1500),
    notes: String(c.notes || '').slice(0, 800),
    mode: MODES.includes(c.mode) ? c.mode : 'motion',
    videoModel: VIDEO_MODELS[c.videoModel] ? c.videoModel : DEFAULT_VIDEO_MODEL,
    frames,
    refs,
  };
}

function parseVideo(v) {
  const video = {
    name: String(v?.name || 'video').slice(0, 120),
    duration: num(v?.duration),
    width: Math.round(num(v?.width)),
    height: Math.round(num(v?.height)),
  };
  if (!(video.duration > 0) || !(video.width > 0) || !(video.height > 0)) throw new Error('Falta el video (duración y tamaño).');
  return video;
}

// Valida el pedido: el video (solo sus datos: no viaja), hasta 3 clips con sus cuadros, pedido y referencias.
export function parseIntuitionBody(body) {
  const text = String(body?.text || '').slice(0, 3000);
  const video = parseVideo(body?.video);
  const raw = Array.isArray(body?.clips) ? body.clips : [];
  if (!raw.length) throw new Error('Marcá al menos un clip en el video.');
  if (raw.length > MAX_CLIPS) throw new Error(`Máximo ${MAX_CLIPS} clips.`);
  const clips = raw.map((c) => parseClip(c, video)).sort((a, b) => a.start - b.start);
  const ids = new Set(clips.map((c) => c.id));
  if (ids.size !== clips.length || clips.some((c) => !/^C[1-9]$/.test(c.id))) throw new Error('Los clips tienen ids inválidos.');
  clips.forEach((c, i) => { if (i && c.start < clips[i - 1].end - 0.01) throw new Error('Los clips no pueden superponerse.'); });
  return { text, video, clips };
}

// Pedido de revisión de UN clip: el cliente devuelve todo lo necesario (el servidor no guarda estado).
export function parseRevisionBody(body) {
  const video = parseVideo(body?.video);
  const clip = parseClip(body?.clip, video);
  if (!/^C[1-9]$/.test(clip.id)) throw new Error('Clip inválido.');
  const code = String(body?.previous?.code || '');
  // Cinematic Pro no tiene código: se rehace el tratamiento anterior.
  const treatment = clip.mode === 'cine' && body?.previous?.treatment && typeof body.previous.treatment === 'object' ? body.previous.treatment : null;
  if (clip.mode === 'cine' ? !treatment : !code.trim()) throw new Error(clip.mode === 'cine' ? 'Falta el tratamiento anterior.' : 'Falta el código anterior.');
  const feedback = String(body?.feedback || '').slice(0, 1500).trim();
  const error = String(body?.error || '').slice(0, 800).trim();
  if (!feedback && !error) throw new Error('Contá qué querés cambiar.');
  const direction = body?.direction && typeof body.direction === 'object' ? body.direction : null;
  if (!direction?.sistema) throw new Error('Falta el sistema visual.');
  // Clips de video IA: el plan del Director de Video IA y si los cuadros son de la toma ya generada.
  const plan = body?.plan && typeof body.plan === 'object' ? body.plan : null;
  return {
    video, clip, feedback, error, direction, plan, generated: body?.generated === true,
    box: sanitizeBox(body?.box),
    index: Math.max(0, Math.round(num(body?.index))),
    total: clamp(Math.round(num(body?.total, 1)), 1, MAX_CLIPS),
    previous: { code: code.slice(0, 60000), treatment, meta: body.previous.meta && typeof body.previous.meta === 'object' ? body.previous.meta : {} },
  };
}

// Deja el sistema visual en un estado que el reproductor puede usar sí o sí (tipografías válidas, colores hex, ventanas).
export function normalizeDirection(raw, clips) {
  const d = raw && typeof raw === 'object' ? raw : {};
  const sistema = d.sistema && typeof d.sistema === 'object' ? { ...d.sistema } : {};
  const pickFont = (f, fallback) => (typeof f === 'string' && FONTS[f.trim()] ? f.trim() : fallback);
  const tip = sistema.tipografias && typeof sistema.tipografias === 'object' ? sistema.tipografias : {};
  const display = pickFont(tip.display, 'Inter');
  sistema.tipografias = { ...tip, display, texto: pickFont(tip.texto, display) };
  const palette = (Array.isArray(sistema.paleta) ? sistema.paleta : [])
    .filter((p) => /^#[0-9a-f]{6}$/i.test(String(p?.hex || '').trim()))
    .slice(0, 5)
    .map((p) => ({ hex: p.hex.trim().toUpperCase(), rol: String(p.rol || '').slice(0, 80) }));
  sistema.paleta = palette.length ? palette : [{ hex: '#F4F1EA', rol: 'texto' }, { hex: '#FF5A1F', rol: 'acento' }];
  const sonido = sistema.sonido && typeof sistema.sonido === 'object' ? sistema.sonido : {};
  const efectos = (Array.isArray(sonido.efectos) ? sonido.efectos : [])
    .map((e) => String(e).trim().toLowerCase())
    .filter((e) => SOUNDS[e]);
  sistema.sonido = { ...sonido, efectos: [...new Set(efectos)].slice(0, 6) };
  const byId = new Map((Array.isArray(d.clips) ? d.clips : []).filter((c) => c && typeof c === 'object').map((c) => [String(c.id), c]));
  return {
    ...d,
    sistema,
    clips: clips.map((c, i) => {
      const plan = byId.get(c.id) || (Array.isArray(d.clips) ? d.clips[i] : null) || {};
      return { ...plan, id: c.id, ventana: sanitizeBox(plan.ventana) };
    }),
  };
}

// Partes (texto + imágenes) de un clip para un mensaje multimodal.
// numbered: rotula cada cuadro con su número (el Director de Video IA elige uno por número).
function clipParts(clip, maxFrames, { numbered = false } = {}) {
  const step = clip.frames.length / Math.min(maxFrames, clip.frames.length);
  const picks = Array.from({ length: Math.min(maxFrames, clip.frames.length) }, (_, k) => Math.floor(k * step));
  return [
    ...picks.map((i) => ({ i, f: clip.frames[i] })).flatMap(({ i, f }) => [
      { type: 'text', text: `${clip.id} — ${numbered ? `cuadro ${i}, ` : 'cuadro del video '}en ${f.t.toFixed(2)} s del clip` },
      { type: 'image_url', image_url: { url: f.url } },
    ]),
    ...clip.refs.flatMap((r) => r.frames.flatMap((url, k) => [
      { type: 'text', text: `${clip.id} · referencia ${r.id}${r.name ? ` "${r.name}"` : ''}${r.kind === 'video' ? ` — cuadro ${k + 1} de ${r.frames.length}` : ''}` },
      { type: 'image_url', image_url: { url } },
    ])),
  ];
}

const motionView = (clip, data) => ({
  id: clip.id,
  idea: String(data.idea || ''),
  linea_de_tiempo: Array.isArray(data.linea_de_tiempo) ? data.linea_de_tiempo : [],
  nota: String(data.nota_para_el_humano || ''),
  // La capa de texto de un clip de video IA no lleva efectos: suena el audio original.
  sonido: clip.mode === 'ai' ? [] : normalizeScore(data.sonido, clip.end - clip.start),
  code: data.code,
});

function motionAgent(agent, config, { step, clip, content, history = [], title, temperature = 0.7, meta }) {
  const ai = clip.mode === 'ai';
  return agent({
    step: step || `motion-${clip.id}`, role: ai ? 'Tipógrafo' : 'Motion Designer', title, model: config.motionModel,
    system: ai ? TEXT_LAYER_SYSTEM : MOTION_SYSTEM, temperature, history, content,
    parse: parseMotion, fix: motionFix, meta,
  });
}

// ---------- Clips de video IA ----------
const clampIndex = (i, n) => clamp(Math.round(num(i)), 0, n - 1);

// Lo que el humano ve del plan del Director de Video IA (y lo que vuelve en las revisiones).
function planView(clip, plan, extra = {}) {
  return {
    id: clip.id,
    model: clip.videoModel,
    modelLabel: VIDEO_MODELS[clip.videoModel].label,
    cuadro_base: plan.cuadro_base,
    toma: String(plan.toma || ''),
    camara: String(plan.camara || ''),
    luz_y_color: String(plan.luz_y_color || ''),
    beats: Array.isArray(plan.beats) ? plan.beats.slice(0, 8) : [],
    continuidad: Array.isArray(plan.continuidad) ? plan.continuidad.slice(0, 10) : [],
    espacio_para_texto: String(plan.espacio_para_texto || ''),
    textos: Array.isArray(plan.textos) ? plan.textos.slice(0, 6) : [],
    vinetas: Array.isArray(plan.vinetas) ? plan.vinetas.slice(0, 6) : [],
    prompt_video: String(plan.prompt_video || ''),
    evitar: Array.isArray(plan.evitar) ? plan.evitar.slice(0, 20) : [],
    nota: String(plan.nota_para_el_humano || ''),
    ...extra,
  };
}

// Un clip de video IA:
//   [a] el Director de Video IA (Opus) elige el cuadro base y escribe la toma al detalle + las viñetas
//   [b] GPT Image dibuja el storyboard a partir del cuadro base → el humano lo aprueba o pide cambios (vuelve a [a])
//   [c] en paralelo: el modelo de video genera la toma, y el Tipógrafo escribe la capa de palabras
async function runAiClip({ clip, index, total, video, direction, agent, emit, ask, ws, config, signal, log }) {
  const plan0 = direction.clips.find((c) => c.id === clip.id);
  const layout = storyboardLayout(video.width, video.height);
  const model = VIDEO_MODELS[clip.videoModel];
  const seconds = videoSeconds(clip.videoModel, clip.end - clip.start);
  const record = (log.aiVideo[clip.id] = { model: clip.videoModel, seconds, rounds: [] });

  const first = [{ type: 'text', text: videoDirectorPrompt({ direction, clip, index, total, video, model: model.label, seconds, layout }) }, ...clipParts(clip, CLIP_FRAMES, { numbered: true })];
  const history = [];
  let content = first;
  let plan;
  let keyFrame;
  let storyboard = null; // { file, dataUrl }
  const uploads = new Map(); // cuadro → URL en WaveSpeed (no se sube dos veces)
  const uploadFrame = async (i) => {
    if (!uploads.has(i)) uploads.set(i, ws.upload(clip.frames[i].url, signal));
    return uploads.get(i);
  };

  for (let round = 1; ; round++) {
    const step = round === 1 ? `vdirector-${clip.id}` : `vdirector-${clip.id}-r${round}`;
    const raw = await agent({
      step, role: 'Director de Video IA', model: config.motionModel, system: VIDEO_DIRECTOR_SYSTEM, temperature: 0.6,
      title: round === 1 ? `${clip.id} · Dirigiendo la toma (${model.label})` : `${clip.id} · Corrigiendo la dirección`,
      history, content, meta: { clip, direction, layout, round },
    });
    history.push({ role: 'user', content }, { role: 'assistant', content: `\`\`\`json\n${JSON.stringify(raw, null, 2)}\n\`\`\`` });
    plan = raw;
    keyFrame = clampIndex(plan.cuadro_base, clip.frames.length);
    plan.cuadro_base = keyFrame;

    // Storyboard
    const sbStep = `storyboard-${clip.id}${round > 1 ? `-r${round}` : ''}`;
    emit({ type: 'step_start', step: sbStep, role: 'Storyboard', title: `${clip.id} · Dibujando el storyboard`, model: config.storyboardModel });
    try {
      const image = await uploadFrame(keyFrame);
      const out = await ws.image({
        model: config.storyboardModel,
        body: { prompt: storyboardImagePrompt(plan, layout), images: [image], aspect_ratio: layout.aspect, resolution: '2k', quality: config.storyboardQuality, output_format: 'jpeg' },
        signal,
        onStatus: ({ status, elapsed }) => emit({ type: 'media_status', step: sbStep, status, elapsed }),
      });
      storyboard = out.file ? { file: out.file, dataUrl: await mediaDataUrl(config.mediaDir, out.file) } : null;
      record.rounds.push({ plan, storyboard: out });
      emit({ type: 'step_end', step: sbStep });
    } catch (err) {
      if (signal?.aborted) throw err;
      emit({ type: 'step_error', step: sbStep, text: err.message });
      storyboard = null;
      record.rounds.push({ plan, storyboardError: err.message });
    }

    const view = planView(clip, plan, {
      frame: clip.frames[keyFrame].url,
      storyboard: storyboard ? `/media/${storyboard.file}` : null,
      demo: !!ws.mock,
      round,
      lastRound: round >= MAX_STORYBOARD_ROUNDS,
    });
    emit({ type: 'ai_plan', data: view });
    const answer = await ask({ kind: 'storyboard', title: `Clip ${index + 1}: ¿generamos esta toma?`, clip: clip.id, plan: view });
    const feedback = String(answer?.cambios || '').slice(0, 1500).trim();
    const edited = String(answer?.prompt || '').slice(0, 4000).trim();
    if (answer?.aprobar || (!feedback && !edited) || round >= MAX_STORYBOARD_ROUNDS) {
      if (edited) plan.prompt_video = edited;
      record.approved = { round, feedback, edited: !!edited };
      break;
    }
    content = [
      { type: 'text', text: videoRevisionPrompt({ feedback, prompt: edited && edited !== plan.prompt_video ? edited : '' }) },
      ...(storyboard ? [{ type: 'image_url', image_url: { url: storyboard.dataUrl } }] : [{ type: 'text', text: '(No se pudo dibujar el storyboard: corregí igual según el pedido.)' }]),
    ];
  }

  // Video y capa de texto, en paralelo.
  const prompt = finalVideoPrompt(plan);
  record.prompt = prompt;
  const videoJob = (async () => {
    const step = `video-${clip.id}`;
    emit({ type: 'step_start', step, role: 'Video IA', title: `${clip.id} · Generando la toma (${model.label}, ${seconds} s)`, model: model.path() });
    try {
      const image = await uploadFrame(keyFrame);
      const out = await ws.video({
        model: model.path(),
        body: model.body({ prompt, image, duration: seconds, aspect: nearestRatio(video.width, video.height), resolution: config.videoResolution }),
        signal,
        onStatus: ({ status, elapsed }) => emit({ type: 'media_status', step, status, elapsed }),
      });
      record.video = out;
      emit({ type: 'ai_video', data: { id: clip.id, url: out.file ? `/media/${out.file}` : null, seconds, demo: !!ws.mock, prompt } });
      emit({ type: 'step_end', step });
    } catch (err) {
      if (signal?.aborted) throw err;
      record.videoError = err.message;
      emit({ type: 'step_error', step, text: err.message });
    }
  })();

  const art = { ...plan0 };
  const textJob = (async () => {
    const images = [
      { type: 'text', text: `${clip.id} — cuadro base (primer cuadro de la toma)` },
      { type: 'image_url', image_url: { url: clip.frames[keyFrame].url } },
      ...(storyboard ? [{ type: 'text', text: `${clip.id} — storyboard aprobado` }, { type: 'image_url', image_url: { url: storyboard.dataUrl } }] : []),
    ];
    const data = await motionAgent(agent, config, {
      clip,
      title: `${clip.id} · Capa de texto · ${String(art.idea || clip.prompt || 'palabras').slice(0, 60)}`,
      content: [{ type: 'text', text: textLayerPrompt({ direction, clip, index, total, box: art.ventana, video, plan, generated: false }) }, ...images],
      meta: { clip, direction, index, total },
    });
    const view = { ...motionView(clip, data), plan: planView(clip, plan) };
    emit({ type: 'motion', data: view });
    return view;
  })();

  const [, text] = await Promise.all([videoJob, textJob]);
  return text;
}

// ---------- Clips de Cinematic Pro ----------
const cineView = (clip, t, extra = {}) => ({ id: clip.id, ...t, ...extra });

// El Director de Fotografía que ve el clip, con la biblioteca agents-film como criterio.
function cineAgent(agent, config, { step, clip, content, history = [], title, temperature = 0.5, meta }) {
  return agent({ step: step || `cine-${clip.id}`, role: 'Director de Fotografía', title, model: config.motionModel, system: CINE_SYSTEM, temperature, history, content, meta });
}

// Un clip de Cinematic Pro:
//   [a] el Director de Fotografía mira el clip, lo diagnostica con agents-film y escribe el tratamiento
//       (grade, luz motivada, cámara virtual, textura) → el reproductor lo aplica al video real, al instante
//   [b] si el clip no se salva con eso, propone re-filmarlo con IA (video→video): el humano aprueba,
//       el navegador graba el tramo y lo manda con su respuesta, y el modelo de edición genera la toma
async function runCineClip({ clip, index, total, video, direction, agent, emit, ask, ws, config, signal, log }) {
  const dur = clip.end - clip.start;
  const raw = await cineAgent(agent, config, {
    clip,
    title: `${clip.id} · Director de Fotografía · ${String(clip.prompt || 'nivel cine').slice(0, 60)}`,
    content: [{ type: 'text', text: cinePrompt({ direction, clip, index, total, video, refilm: !!ws }) }, ...clipParts(clip, CLIP_FRAMES)],
    meta: { clip, direction, index, total },
  });
  const treatment = normalizeTreatment(raw, dur);
  if (!ws) treatment.refilmar.recomendado = false;
  const record = (log.cine[clip.id] = { treatment });
  emit({ type: 'cine', data: cineView(clip, treatment) });
  if (!treatment.refilmar.recomendado) return cineView(clip, treatment);

  const prompt = refilmPrompt(treatment.refilmar);
  const answer = await ask({
    kind: 'refilm', title: `Clip ${index + 1}: ¿lo re-filmamos con IA?`, clip: clip.id,
    plan: { id: clip.id, start: clip.start, end: clip.end, model: EDIT_MODEL.label, prompt, por_que: treatment.refilmar.por_que, preservar: treatment.refilmar.preservar, sobre_toma: treatment.refilmar.sobre_toma, demo: !!ws.mock, frame: clip.frames[Math.floor(clip.frames.length / 2)].url },
  });
  const clipVideo = typeof answer?.video === 'string' && /^data:video\//.test(answer.video) && answer.video.length <= MAX_CLIP_VIDEO_BYTES * 1.4 ? answer.video : null;
  if (!answer?.aprobar || !clipVideo) {
    record.refilm = { approved: false, reason: answer?.aprobar ? 'sin video' : 'rechazado' };
    emit({ type: 'cine_video', data: { id: clip.id, url: null, skipped: true } });
    return cineView(clip, treatment);
  }
  const finalPrompt = String(answer.prompt || '').trim().slice(0, 4000) || prompt;
  record.refilm = { approved: true, prompt: finalPrompt };
  const step = `refilm-${clip.id}`;
  emit({ type: 'step_start', step, role: 'Video IA', title: `${clip.id} · Re-filmando con ${EDIT_MODEL.label}`, model: EDIT_MODEL.path() });
  try {
    const url = await ws.upload(clipVideo, signal);
    const out = await ws.video({
      model: EDIT_MODEL.path(),
      body: EDIT_MODEL.body({ prompt: finalPrompt, video: url, resolution: config.videoResolution }),
      signal,
      onStatus: ({ status, elapsed }) => emit({ type: 'media_status', step, status, elapsed }),
    });
    record.refilm.video = out;
    emit({ type: 'cine_video', data: { id: clip.id, url: out.file ? `/media/${out.file}` : null, demo: !!ws.mock, prompt: finalPrompt } });
    emit({ type: 'step_end', step });
  } catch (err) {
    if (signal?.aborted) throw err;
    record.refilm.error = err.message;
    emit({ type: 'step_error', step, text: err.message });
  }
  return cineView(clip, treatment);
}

// Motion design guiado por intuición:
//   [1] el Director de Arte mira los clips y define UN sistema visual + la idea y la ventana de cada clip
//   [2] por clip, en paralelo:
//       - "motion": un Motion Designer escribe el código Canvas 2D del clip, dentro del sistema
//       - "ai": el Director de Video IA dirige una toma generada por IA (storyboard → aprobación → video) y el Tipógrafo anima solo palabras encima
// El render, el ajuste de la ventana y la exportación (el overlay "quemado" en el video) pasan en el navegador.
export async function runIntuitionPipeline({ text, video, clips, emit, llm, config, signal, ask = async () => ({ aprobar: true }), ws }) {
  const log = {
    startedAt: new Date().toISOString(),
    flow: 'intuition',
    config,
    input: { text, video, clips: clips.map(({ frames, refs, ...c }) => ({ ...c, frames: frames.length, refs: refs.map((r) => ({ ...r, frames: r.frames.length })) })) },
    steps: {},
    aiVideo: {},
    cine: {},
  };
  const { agent, totals } = createAgentRunner({ emit, llm, signal, log });
  if (clips.some((c) => c.mode === 'ai') && !ws) throw new Error('Falta WAVESPEED_API_KEY para los clips de video IA.');

  // 1. Sistema visual
  const raw = await agent({
    step: 'direction', role: 'Director de Arte', title: 'Mirando tu video y armando el sistema visual', model: config.motionModel,
    system: ART_DIRECTOR_SYSTEM, temperature: 0.6,
    content: [{ type: 'text', text: directionPrompt({ text, video, clips }) }, ...clips.flatMap((c) => clipParts(c, DIRECTOR_FRAMES))],
    meta: { clips, text },
  });
  const direction = normalizeDirection(raw, clips);
  emit({ type: 'direction', data: direction });

  // 2. Cada clip, en paralelo
  const settled = await Promise.allSettled(clips.map(async (clip, index) => {
    if (clip.mode === 'ai') return runAiClip({ clip, index, total: clips.length, video, direction, agent, emit, ask, ws, config, signal, log });
    if (clip.mode === 'cine') return runCineClip({ clip, index, total: clips.length, video, direction, agent, emit, ask, ws, config, signal, log });
    const plan = direction.clips.find((c) => c.id === clip.id);
    const data = await motionAgent(agent, config, {
      clip,
      title: `${clip.id} · ${String(plan.idea || clip.prompt || 'motion design').slice(0, 70)}`,
      content: [{ type: 'text', text: motionPrompt({ direction, clip, index, total: clips.length, box: plan.ventana, video }) }, ...clipParts(clip, CLIP_FRAMES)],
      meta: { clip, direction, index, total: clips.length },
    });
    const view = motionView(clip, data);
    emit({ type: 'motion', data: view });
    return view;
  }));
  settled.forEach((r, i) => {
    if (r.status === 'rejected') emit({ type: 'step_error', step: `${clips[i].mode === 'cine' ? 'cine' : 'motion'}-${clips[i].id}`, text: r.reason.message });
  });
  const motions = settled.filter((r) => r.status === 'fulfilled').map((r) => r.value);
  if (!motions.length) throw new Error('Fallaron todos los clips: ' + settled.map((r) => r.reason?.message).join(' | '));

  log.finishedAt = new Date().toISOString();
  log.totals = totals;
  log.result = { direction, motions };
  return log;
}

// Rehace UN clip con el pedido del humano (o con el error que dio al ejecutarse), sin salirse del sistema visual.
// En un clip de video IA se rehace solo la capa de texto (la toma ya está generada).
export async function runIntuitionRevision({ video, clip, direction, box, index, total, previous, feedback, error, plan, generated, emit, llm, config, signal }) {
  const log = {
    startedAt: new Date().toISOString(),
    flow: 'intuition-revision',
    config,
    input: { video, clip: clip.id, mode: clip.mode, feedback, error },
    steps: {},
  };
  const { agent, totals } = createAgentRunner({ emit, llm, signal, log });
  if (clip.mode === 'cine') {
    const first = [{ type: 'text', text: cinePrompt({ direction, clip, index, total, video, refilm: false }) }, ...clipParts(clip, CLIP_FRAMES)];
    const raw = await cineAgent(agent, config, {
      step: `recine-${clip.id}`, clip, title: `${clip.id} · Rehaciendo el tratamiento con tu pedido`,
      history: [{ role: 'user', content: first }, { role: 'assistant', content: `\`\`\`json\n${JSON.stringify(previous.treatment, null, 2)}\n\`\`\`` }],
      content: cineRevisionPrompt({ feedback }),
      meta: { clip, direction, index, total, revision: true, feedback },
    });
    const treatment = normalizeTreatment(raw, clip.end - clip.start);
    treatment.refilmar.recomendado = false; // la re-filmación se decide en la primera pasada
    emit({ type: 'cine', data: cineView(clip, treatment, { revision: true }) });
    log.finishedAt = new Date().toISOString();
    log.totals = totals;
    log.result = { cine: treatment };
    return log;
  }
  const brief = clip.mode === 'ai'
    ? textLayerPrompt({ direction, clip, index, total, box, video, plan: plan || {}, generated })
    : motionPrompt({ direction, clip, index, total, box, video });
  const first = [{ type: 'text', text: brief }, ...clipParts(clip, CLIP_FRAMES)];
  const before = `\`\`\`json\n${JSON.stringify(previous.meta, null, 2)}\n\`\`\`\n\n\`\`\`js\n${previous.code}\n\`\`\``;
  const data = await motionAgent(agent, config, {
    step: `revise-${clip.id}`,
    clip,
    title: error ? `${clip.id} · Arreglando el error` : `${clip.id} · Rehaciendo con tu pedido`,
    temperature: error ? 0.3 : 0.7,
    history: [{ role: 'user', content: first }, { role: 'assistant', content: before }],
    content: revisionPrompt({ feedback, error }),
    meta: { clip, direction, index, total, revision: true, feedback },
  });
  const view = motionView(clip, data);
  emit({ type: 'motion', data: { ...view, revision: true } });
  log.finishedAt = new Date().toISOString();
  log.totals = totals;
  log.result = { motion: view };
  return log;
}
