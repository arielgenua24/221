// Rutas HTTP del Laboratorio (las monta src/server.js).
//   POST /api/lab/run         → NDJSON: una ejecución de un agente (ver pipeline.js)
//   GET  /api/lab/models      → modelos con visión de OpenRouter (con precios) + datos del harness
//   GET  /api/lab/frame.html?engine=remotion|canvas → el documento del iframe aislado del motor (CSP + runtime + reproductor, en línea)
// Context Lab (mismo modelo, distinto contexto por variante; ver context.js):
//   GET  /api/lab/context/info    → skills disponibles, plantilla por defecto, herramientas, límites y modelos
//   POST /api/lab/context/preview → el prompt de sistema final de una variante (con skills y herramientas expandidas)
//   POST /api/lab/context/run     → NDJSON: una ejecución de una variante
// Habla del video (los dos laboratorios; ver transcript.js):
//   POST /api/lab/plan → modo Automático: { model, count, video, brief, transcript } → { zones: [{ start, end, said, frames }], cost, note } (said: lo que se dice, de la transcripción)
//   POST /api/lab/music → música de fondo: { model, video, brief, transcript, frames: [{ t, url }] } → { cues: [{ id, start, end, mood,
//        prompt, volume, seconds, loop, url }], tone, note, cost } (ver music.js: el modelo planea, ElevenLabs genera cada tramo)
//   POST /api/lab/transcribe?duration=<s>&language=<auto|es|en…> → el cuerpo es el archivo de video tal cual (video/*);
//        responde { language, duration, text, heads: [{ t, text, at }], words, cost, truncated, model }
import { parseLabBody, runLabAgent, MAX_COMPILE_RETRIES, MAX_BRIEF_REFS, MAX_ZONE_SECONDS, MAX_LAB_CLIPS, MAX_TOOL_ROUNDS } from './pipeline.js';
import { runtimeInfo, GOOGLE_FONTS } from './runtime.js';
import { harnessVersion, SKILL_FILES, SKILLS_COMMIT } from './harness.js';
import { createLabTools, TOOL_COSTS, IMAGE_MODEL, IMAGE_EDIT_MODEL, MAX_GENERATED_IMAGES, MAX_SEARCHES, DEFAULT_LIMITS, LIMIT_CAPS, SFX_MODEL, videoResolution } from './tools.js';
import { parseContextBody, parseVariant, contextConfig, defaultTemplate, ALL_SKILLS, DEFAULT_SKILLS, SOUND_SKILLS, DEFAULT_POLICY, CONTEXT_HARNESS, MAX_VARIANTS, MAX_FRAMES } from './context.js';
import { VIDEO_MODELS, DEFAULT_VIDEO_MODEL, createWaveSpeed } from '../wavespeed.js';
import { mockLabLLM } from './mock.js';
import { getEngine, engineList, DEFAULT_ENGINE } from '../engines/index.js';
import { frameDocument } from '../engines/frame-doc.js';
import { reasoningMeta } from './reasoning.js';
import { MAX_DOCS, MAX_DOC_CHARS, MAX_DOCS_CHARS } from './docs.js';
import { planZones, heuristicPlan, MIN_PLAN_SECONDS, MAX_PLAN_SECONDS, MAX_PLAN_FRAMES } from './plan.js';
import { planMusic, generateMusic, MUSIC_MODEL, MUSIC_COST_PER_SECOND, MUSIC_MAX_SECONDS, MAX_MUSIC_CUES, MAX_MUSIC_FRAMES } from './music.js';
import { parseTranscript, transcribeVideo, MAX_VIDEO_BYTES, WHISPER_MODEL, WHISPER_COST_PER_SECOND, MAX_TRANSCRIBE_SECONDS } from './transcript.js';


const MAX_LAB_BODY = 40 * 1024 * 1024;

// Sugeridos si no se puede leer el catálogo de OpenRouter (sin red o modo demo).
const FALLBACK_MODELS = [
  'anthropic/claude-opus-5.5', 'anthropic/claude-sonnet-5.5', 'anthropic/claude-haiku-5.5', 'openai/gpt-6.1-sol', 'openai/gpt-6-luna',
  'google/gemini-3.8-flash', 'qwen/qwen3.8-max-prime', 'qwen/qwen3.8-flash', 'x-ai/grok-4.7', 'z-ai/glm-5.3-flash', 'deepseek/deepseek-v4-flash-vision-exp',
].map((id) => ({ id, name: id, prompt: null, completion: null }));

let catalog = null; // { at, models }
async function visionModels() {
  if (catalog && Date.now() - catalog.at < 3600_000) return catalog.models;
  try {
    const r = await fetch(`${process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1'}/models`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(String(r.status));
    const models = (await r.json()).data
      // Los agentes miran cuadros y referencias: solo modelos que aceptan imágenes. Sin variantes :batch (no responden en vivo).
      .filter((m) => (m.architecture?.input_modalities || []).includes('image') && (m.architecture?.output_modalities || ['text']).includes('text') && !(m.architecture?.output_modalities || []).includes('image') && !m.id.endsWith(':batch'))
      // reasoning: los niveles que acepta cada modelo (null = no razona), para el selector de la pantalla.
      .map((m) => ({ id: m.id, name: m.name || m.id, prompt: Number(m.pricing?.prompt) * 1e6 || 0, completion: Number(m.pricing?.completion) * 1e6 || 0, created: m.created || 0, reasoning: reasoningMeta(m), maxOutput: Number(m.top_provider?.max_completion_tokens) || null }))
      .sort((a, b) => b.created - a.created);
    catalog = { at: Date.now(), models };
    return models;
  } catch {
    return FALLBACK_MODELS;
  }
}

// Lo que acepta un modelo según el catálogo: reasoningMeta(), null si no razona, undefined si no hay catálogo (ej. sin red).
async function modelReasoning(id) {
  const list = await visionModels();
  if (list === FALLBACK_MODELS) return undefined;
  const m = list.find((x) => x.id === id);
  return m ? m.reasoning : undefined;
}

// Tope de salida del modelo según el catálogo (null si no se sabe).
async function modelMaxOutput(id) {
  const list = await visionModels();
  if (list === FALLBACK_MODELS) return null;
  return list.find((x) => x.id === id)?.maxOutput || null;
}

// wavespeedKey: imágenes; serpKey: búsqueda de referencias. Los modelos de los agentes siguen en OpenRouter.
export function createLabRoutes({ mock, llm, readBody, sendJson, badRequest, wavespeedKey, mediaDir, serpKey = process.env.SERPAPI_API_KEY }) {
  const labLlm = mock ? mockLabLLM : llm;
  const tools = createLabTools({ serpKey, wavespeedKey, mediaDir, mock });
  const speechWs = !mock && wavespeedKey ? createWaveSpeed({ apiKey: wavespeedKey, mediaDir, pollMs: 2000 }) : null;

  const docsLimits = { max: MAX_DOCS, maxChars: MAX_DOC_CHARS, maxTotalChars: MAX_DOCS_CHARS };
  const zonesInfo = { max: MAX_LAB_CLIPS, minPlanSeconds: MIN_PLAN_SECONDS, maxPlanSeconds: Math.min(MAX_PLAN_SECONDS, MAX_ZONE_SECONDS), maxPlanFrames: MAX_PLAN_FRAMES };
  const musicInfo = () => ({ available: mock || !!wavespeedKey, model: mock ? 'demo' : MUSIC_MODEL, costPerSecond: mock ? 0 : MUSIC_COST_PER_SECOND, maxSeconds: MUSIC_MAX_SECONDS, maxCues: MAX_MUSIC_CUES });
  const speechInfo = () => ({ available: mock || !!wavespeedKey, model: mock ? 'demo' : WHISPER_MODEL, costPerSecond: mock ? 0 : WHISPER_COST_PER_SECOND, maxSeconds: MAX_TRANSCRIBE_SECONDS });

  async function readVideo(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_VIDEO_BYTES) throw new Error(`El video supera ${Math.round(MAX_VIDEO_BYTES / 1024 / 1024)} MB: recortalo o bajale la calidad para transcribirlo.`);
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }

  // Modo Automático: el agente elige los momentos (zonas + segundos de los cuadros) a partir de la transcripción.
  async function plan(req, res) {
    let body;
    try { body = await readBody(req, 4 * 1024 * 1024); } catch (err) { return badRequest(res, err.message); }
    const model = String(body?.model || '').trim().slice(0, 120);
    if (!/^[\w.-]+\/[\w.:@-]+$/.test(model)) return badRequest(res, 'Elegí un modelo válido (ID de OpenRouter) para que elija los momentos.');
    const count = Math.round(Number(body?.count));
    if (!Number.isFinite(count) || count < 1 || count > MAX_LAB_CLIPS) return badRequest(res, `La cantidad de animaciones va de 1 a ${MAX_LAB_CLIPS}.`);
    const video = { name: String(body?.video?.name || 'video').slice(0, 120), duration: Number(body?.video?.duration) };
    if (!(video.duration > 0)) return badRequest(res, 'Falta la duración del video.');
    const transcript = parseTranscript(body?.transcript);
    if (!transcript) return badRequest(res, 'Falta la transcripción del habla: sin ella no hay de dónde elegir los momentos.');
    const brief = { context: String(body?.brief?.context || '').slice(0, 3000).trim(), instructions: String(body?.brief?.instructions || '').slice(0, 3000).trim() };
    const maxSeconds = Math.min(MAX_PLAN_SECONDS, MAX_ZONE_SECONDS);
    const controller = new AbortController();
    res.on('close', () => { if (!res.writableFinished) controller.abort(); });
    try {
      const out = mock
        ? heuristicPlan({ count, video, transcript, minSeconds: MIN_PLAN_SECONDS, maxSeconds })
        : await planZones({ llm, model, signal: controller.signal, count, video, brief, transcript, minSeconds: MIN_PLAN_SECONDS, maxSeconds });
      sendJson(res, 200, out);
    } catch (err) {
      if (!controller.signal.aborted && !res.headersSent) sendJson(res, 502, { error: err.message });
    }
  }

  // Música de fondo: el modelo escucha (transcripción) y mira (cuadros) el video, planea los tramos y ElevenLabs los genera.
  async function music(req, res) {
    if (!mock && !speechWs) return badRequest(res, 'Falta WAVESPEED_API_KEY: sin ella no puedo generar la música.');
    let body;
    try { body = await readBody(req, 12 * 1024 * 1024); } catch (err) { return badRequest(res, err.message); }
    const model = String(body?.model || '').trim().slice(0, 120);
    if (!/^[\w.-]+\/[\w.:@-]+$/.test(model)) return badRequest(res, 'Elegí un modelo válido (ID de OpenRouter) para que componga la música.');
    const video = { name: String(body?.video?.name || 'video').slice(0, 120), duration: Number(body?.video?.duration) };
    if (!(video.duration > 0)) return badRequest(res, 'Falta la duración del video.');
    const transcript = parseTranscript(body?.transcript);
    const frames = (Array.isArray(body?.frames) ? body.frames : [])
      .filter((f) => typeof f?.url === 'string' && /^data:image\/(jpeg|png|webp);base64,/.test(f.url) && Number.isFinite(Number(f.t)))
      .slice(0, MAX_MUSIC_FRAMES).map((f) => ({ t: Number(f.t), url: f.url }));
    if (!transcript && !frames.length) return badRequest(res, 'Sin transcripción ni cuadros no hay de dónde entender el tono del video.');
    const brief = { context: String(body?.brief?.context || '').slice(0, 3000).trim(), instructions: String(body?.brief?.instructions || '').slice(0, 3000).trim() };
    const controller = new AbortController();
    res.on('close', () => { if (!res.writableFinished) controller.abort(); });
    try {
      const planned = await planMusic({ llm: mock ? mockMusicLLM : llm, model, signal: controller.signal, video, brief, transcript, frames });
      const cues = await generateMusic({ ws: speechWs, cues: planned.cues, signal: controller.signal, mock, mediaDir });
      if (!cues.some((c) => c.url)) throw new Error(`no se pudo generar ningún tramo: ${cues[0]?.error || 'error desconocido'}`);
      const audioCost = cues.reduce((n, c) => n + (c.cost || 0), 0);
      sendJson(res, 200, { cues, tone: planned.tone, note: planned.note, model: mock ? 'demo' : model, musicModel: mock ? 'demo' : MUSIC_MODEL, cost: planned.cost + audioCost, llmCost: planned.cost, audioCost, tokens: planned.tokens });
    } catch (err) {
      if (!controller.signal.aborted && !res.headersSent) sendJson(res, 502, { error: err.message });
    }
  }

  // Whisper: el navegador manda el video tal cual; devolvemos la transcripción partida en cabezales de un segundo.
  async function transcribe(req, res, url) {
    if (!mock && !speechWs) return badRequest(res, 'Falta WAVESPEED_API_KEY: sin ella no puedo transcribir el habla del video.');
    const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (!/^(video|audio)\//.test(type)) return badRequest(res, 'Mandá el archivo de video tal cual (Content-Type video/*).');
    const duration = Number(url.searchParams.get('duration'));
    if (!Number.isFinite(duration) || duration <= 0) return badRequest(res, 'Falta la duración del video (duration, en segundos).');
    const language = /^(auto|[a-z]{2,3})$/.test(url.searchParams.get('language') || '') ? url.searchParams.get('language') : 'auto';
    const controller = new AbortController();
    res.on('close', () => { if (!res.writableFinished) controller.abort(); });
    try {
      const buffer = await readVideo(req);
      if (!buffer.length) return badRequest(res, 'El video llegó vacío.');
      const name = `clip.${type.split('/')[1]?.replace(/[^a-z0-9]/g, '') || 'mp4'}`;
      sendJson(res, 200, await transcribeVideo({ ws: speechWs, mock, buffer, type, name, duration, language, signal: controller.signal }));
    } catch (err) {
      if (!controller.signal.aborted && !res.headersSent) sendJson(res, 502, { error: err.message });
    }
  }

  // Motion Design: el harness fijo. Context Lab: la config de la variante.
  async function run(req, res, { context = false } = {}) {
    let input;
    let config;
    try {
      const body = await readBody(req, MAX_LAB_BODY);
      if (context) {
        const parsed = parseContextBody(body);
        input = parsed.input;
        config = contextConfig(parsed.variant, tools.available);
      } else input = parseLabBody(body);
      // Si pidió un nivel de razonamiento, se lee qué niveles acepta este modelo (undefined = no se pudo leer el catálogo).
      const wanted = config?.reasoning ?? input.reasoning;
      if (wanted) {
        config ??= {};
        config.reasoningMeta = mock ? undefined : await modelReasoning(input.model);
      }
      // Sin max_tokens, OpenRouter usa un tope chico y el razonamiento obligatorio (ej. Claude) se come casi todo:
      // el bloque de código queda cortado. Se manda el tope real del modelo.
      if (!mock) {
        const maxOutput = await modelMaxOutput(input.model);
        if (maxOutput) { config ??= {}; config.maxOutput = maxOutput; }
      }
    } catch (err) {
      return badRequest(res, err.message);
    }
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
    const controller = new AbortController();
    res.on('close', () => { if (!res.writableFinished) controller.abort(); });
    const emit = (event) => { if (!res.writableEnded) res.write(JSON.stringify(event) + '\n'); };
    const ping = setInterval(() => emit({ type: 'ping' }), 15000);
    try {
      await runLabAgent({ input, emit, llm: labLlm, signal: controller.signal, tools, config });
    } catch (err) {
      // El costo de una ejecución fallida también cuenta (principio 4: se registra todo lo gastado).
      if (!controller.signal.aborted) emit({ type: 'error', text: err.message, ...(err.totals || {}), ms: err.ms, compileErrors: err.compileErrors });
    } finally {
      clearInterval(ping);
      res.end();
    }
  }

  async function models(res) {
    sendJson(res, 200, {
      mock,
      speech: speechInfo(),
      music: musicInfo(),
      docs: docsLimits,
      zones: zonesInfo,
      models: await visionModels(),
      harness: {
        version: harnessVersion(tools.available), versions: Object.fromEntries(engineList().map((e) => [e.id, harnessVersion(tools.available, e.id)])), skillsCommit: SKILLS_COMMIT, skills: SKILL_FILES, maxCompileRetries: MAX_COMPILE_RETRIES, maxBriefRefs: MAX_BRIEF_REFS,
        maxZoneSeconds: MAX_ZONE_SECONDS, fonts: GOOGLE_FONTS, ...runtimeInfo(), engines: engineList(), defaultEngine: DEFAULT_ENGINE,
        tools: { ...tools.available, imageProvider: 'wavespeed', imageModel: IMAGE_MODEL, imageEditModel: IMAGE_EDIT_MODEL, maxImages: MAX_GENERATED_IMAGES, maxSearches: MAX_SEARCHES, maxRounds: MAX_TOOL_ROUNDS, costs: TOOL_COSTS },
      },
    });
  }

  async function contextInfo(res) {
    sendJson(res, 200, {
      mock,
      models: await visionModels(),
      harness: { version: CONTEXT_HARNESS, skillsCommit: SKILLS_COMMIT, maxBriefRefs: MAX_BRIEF_REFS, maxZoneSeconds: MAX_ZONE_SECONDS, maxCompileRetries: MAX_COMPILE_RETRIES, ...runtimeInfo() },
      maxVariants: MAX_VARIANTS,
      maxFrames: MAX_FRAMES,
      template: defaultTemplate(),
      // Cada motor tiene su plantilla por defecto ('' en la variante = la de su motor).
      engines: engineList(),
      defaultEngine: DEFAULT_ENGINE,
      templates: Object.fromEntries(engineList().map((e) => [e.id, defaultTemplate(e.id)])),
      skills: ALL_SKILLS.map(({ file, title, chars }) => ({ file, title, chars })),
      defaultSkills: DEFAULT_SKILLS,
      soundSkills: SOUND_SKILLS,
      defaultPolicy: DEFAULT_POLICY,
      limits: { defaults: DEFAULT_LIMITS, caps: LIMIT_CAPS },
      speech: speechInfo(),
      music: musicInfo(),
      docs: docsLimits,
      zones: zonesInfo,
      tools: {
        ...tools.available, costs: TOOL_COSTS, imageModel: IMAGE_MODEL, imageEditModel: IMAGE_EDIT_MODEL, sfxModel: SFX_MODEL, videoResolution: videoResolution(),
        videoModels: Object.entries(VIDEO_MODELS).map(([id, m]) => ({ id, label: m.label })), defaultVideoModel: DEFAULT_VIDEO_MODEL,
      },
    });
  }

  async function contextPreview(req, res) {
    try {
      const body = await readBody(req, 1024 * 1024);
      const variant = parseVariant(body?.variant);
      const { system, harness, maxToolRounds } = contextConfig(variant, tools.available);
      sendJson(res, 200, { system, chars: system.length, harness, maxToolRounds });
    } catch (err) {
      badRequest(res, err.message);
    }
  }

  // El documento del iframe de cada motor (va entero en línea: la página lo carga como srcdoc con sandbox="allow-scripts",
  // origen opaco, y la CSP del <meta> le corta la red). ?engine=remotion|canvas; sin parámetro, Remotion.
  async function frame(res, url) {
    const engine = getEngine(url.searchParams.get('engine'));
    try {
      const html = await engine.frameDocument();
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(html);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`No pude armar el runtime de ${engine.label}: ${err.message}`);
    }
  }

  // Devuelve true si la ruta era del Laboratorio.
  return function handle(req, res, url) {
    if (req.method === 'POST' && url.pathname === '/api/lab/run') { run(req, res); return true; }
    if (req.method === 'GET' && url.pathname === '/api/lab/models') { models(res); return true; }
    if (req.method === 'GET' && url.pathname === '/api/lab/frame.html') { frame(res, url); return true; }
    if (req.method === 'POST' && url.pathname === '/api/lab/context/run') { run(req, res, { context: true }); return true; }
    if (req.method === 'GET' && url.pathname === '/api/lab/context/info') { contextInfo(res); return true; }
    if (req.method === 'POST' && url.pathname === '/api/lab/plan') { plan(req, res); return true; }
    if (req.method === 'POST' && url.pathname === '/api/lab/music') { music(req, res); return true; }
    if (req.method === 'POST' && url.pathname === '/api/lab/transcribe') { transcribe(req, res, url); return true; }
    if (req.method === 'POST' && url.pathname === '/api/lab/context/preview') { contextPreview(req, res); return true; }
    return false;
  };
}

// Demo: un plan de música fijo (un tramo serio y otro que levanta), sin llamar a ningún modelo.
const mockMusicLLM = async ({ messages }) => {
  const d = Number(/· ([\d.]+) s de duración/.exec(messages[1].content[0].text)?.[1]) || 20;
  const mid = Math.round((d / 2) * 100) / 100;
  const cues = d >= 10
    ? [{ start: 0, end: mid, mood: '(demo) sobrio', prompt: 'calm ambient pads, soft piano, 80 BPM', volume: 0.25 }, { start: mid, end: d, mood: '(demo) esperanzador', prompt: 'warm uplifting strings, light percussion, 95 BPM', volume: 0.25 }]
    : [{ start: 0, end: d, mood: '(demo) sobrio', prompt: 'calm ambient pads, soft piano, 80 BPM', volume: 0.25 }];
  return { text: JSON.stringify({ tono: '(demo) tono del video', cues, nota: '' }), usage: { cost: 0, total_tokens: 0 } };
};

// El documento del iframe (CSP incluida) lo arma cada motor: ver src/engines/.
export { FRAME_CSP } from '../engines/frame-doc.js';
export const frameHtml = (runtime, script) => frameDocument([runtime, script]);
