import { createAgentRunner } from './agent.js';
import { FONTS } from '../public/motion-lib.js';
import { ART_DIRECTOR_SYSTEM, MOTION_SYSTEM, directionPrompt, motionPrompt, revisionPrompt, parseMotion, motionFix } from './intuition-prompts.js';

export const MAX_CLIPS = 3;
export const MAX_CLIP_SECONDS = 5;
export const MIN_CLIP_SECONDS = 0.5;
export const CLIP_FRAMES = 6; // cuadros por clip que ve el Motion Designer
const DIRECTOR_FRAMES = 3; // cuadros por clip que ve el Director de Arte
export const MAX_REFS = 4; // referencias visuales por clip
const REF_FRAMES = 4; // cuadros por referencia de video/GIF
const DEFAULT_BOX = { x: 0.08, y: 0.14, w: 0.84, h: 0.3 };

const num = (x, fallback = 0) => (Number.isFinite(Number(x)) ? Number(x) : fallback);
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const isImage = (u) => typeof u === 'string' && u.startsWith('data:image/');

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
  if (!code.trim()) throw new Error('Falta el código anterior.');
  const feedback = String(body?.feedback || '').slice(0, 1500).trim();
  const error = String(body?.error || '').slice(0, 800).trim();
  if (!feedback && !error) throw new Error('Contá qué querés cambiar.');
  const direction = body?.direction && typeof body.direction === 'object' ? body.direction : null;
  if (!direction?.sistema) throw new Error('Falta el sistema visual.');
  return {
    video, clip, feedback, error, direction,
    box: sanitizeBox(body?.box),
    index: Math.max(0, Math.round(num(body?.index))),
    total: clamp(Math.round(num(body?.total, 1)), 1, MAX_CLIPS),
    previous: { code: code.slice(0, 60000), meta: body.previous.meta && typeof body.previous.meta === 'object' ? body.previous.meta : {} },
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
function clipParts(clip, maxFrames) {
  const step = clip.frames.length / Math.min(maxFrames, clip.frames.length);
  const frames = Array.from({ length: Math.min(maxFrames, clip.frames.length) }, (_, k) => clip.frames[Math.floor(k * step)]);
  return [
    ...frames.flatMap((f) => [
      { type: 'text', text: `${clip.id} — cuadro del video en ${f.t.toFixed(2)} s del clip` },
      { type: 'image_url', image_url: { url: f.url } },
    ]),
    ...clip.refs.flatMap((r) => r.frames.flatMap((url, k) => [
      { type: 'text', text: `${clip.id} · referencia ${r.id}${r.name ? ` "${r.name}"` : ''}${r.kind === 'video' ? ` — cuadro ${k + 1} de ${r.frames.length}` : ''}` },
      { type: 'image_url', image_url: { url } },
    ])),
  ];
}

const motionView = (id, data) => ({
  id,
  idea: String(data.idea || ''),
  linea_de_tiempo: Array.isArray(data.linea_de_tiempo) ? data.linea_de_tiempo : [],
  nota: String(data.nota_para_el_humano || ''),
  code: data.code,
});

function motionAgent(agent, config, { step, clip, content, history = [], title, temperature = 0.7, meta }) {
  return agent({
    step: step || `motion-${clip.id}`, role: 'Motion Designer', title, model: config.motionModel,
    system: MOTION_SYSTEM, temperature, maxTokens: 16000, history, content,
    parse: parseMotion, fix: motionFix, meta,
  });
}

// Motion design guiado por intuición:
//   [1] el Director de Arte mira los clips y define UN sistema visual + la idea y la ventana de cada clip
//   [2] un Motion Designer por clip (en paralelo) escribe el código Canvas 2D de su clip, dentro del sistema
// El render, el ajuste de la ventana y la exportación (el overlay "quemado" en el video) pasan en el navegador.
export async function runIntuitionPipeline({ text, video, clips, emit, llm, config, signal }) {
  const log = {
    startedAt: new Date().toISOString(),
    flow: 'intuition',
    config,
    input: { text, video, clips: clips.map(({ frames, refs, ...c }) => ({ ...c, frames: frames.length, refs: refs.map((r) => ({ ...r, frames: r.frames.length })) })) },
    steps: {},
  };
  const { agent, totals } = createAgentRunner({ emit, llm, signal, log });

  // 1. Sistema visual
  const raw = await agent({
    step: 'direction', role: 'Director de Arte', title: 'Mirando tu video y armando el sistema visual', model: config.motionModel,
    system: ART_DIRECTOR_SYSTEM, temperature: 0.6, maxTokens: 8000,
    content: [{ type: 'text', text: directionPrompt({ text, video, clips }) }, ...clips.flatMap((c) => clipParts(c, DIRECTOR_FRAMES))],
    meta: { clips, text },
  });
  const direction = normalizeDirection(raw, clips);
  emit({ type: 'direction', data: direction });

  // 2. Un Motion Designer por clip, en paralelo
  const settled = await Promise.allSettled(clips.map(async (clip, index) => {
    const plan = direction.clips.find((c) => c.id === clip.id);
    const data = await motionAgent(agent, config, {
      clip,
      title: `${clip.id} · ${String(plan.idea || clip.prompt || 'motion design').slice(0, 70)}`,
      content: [{ type: 'text', text: motionPrompt({ direction, clip, index, total: clips.length, box: plan.ventana, video }) }, ...clipParts(clip, CLIP_FRAMES)],
      meta: { clip, direction, index, total: clips.length },
    });
    const view = motionView(clip.id, data);
    emit({ type: 'motion', data: view });
    return view;
  }));
  settled.forEach((r, i) => {
    if (r.status === 'rejected') emit({ type: 'step_error', step: `motion-${clips[i].id}`, text: r.reason.message });
  });
  const motions = settled.filter((r) => r.status === 'fulfilled').map((r) => r.value);
  if (!motions.length) throw new Error('Fallaron todos los clips: ' + settled.map((r) => r.reason?.message).join(' | '));

  log.finishedAt = new Date().toISOString();
  log.totals = totals;
  log.result = { direction, motions };
  return log;
}

// Rehace UN clip con el pedido del humano (o con el error que dio al ejecutarse), sin salirse del sistema visual.
export async function runIntuitionRevision({ video, clip, direction, box, index, total, previous, feedback, error, emit, llm, config, signal }) {
  const log = {
    startedAt: new Date().toISOString(),
    flow: 'intuition-revision',
    config,
    input: { video, clip: clip.id, feedback, error },
    steps: {},
  };
  const { agent, totals } = createAgentRunner({ emit, llm, signal, log });
  const first = [{ type: 'text', text: motionPrompt({ direction, clip, index, total, box, video }) }, ...clipParts(clip, CLIP_FRAMES)];
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
  const view = motionView(clip.id, data);
  emit({ type: 'motion', data: { ...view, revision: true } });
  log.finishedAt = new Date().toISOString();
  log.totals = totals;
  log.result = { motion: view };
  return log;
}
