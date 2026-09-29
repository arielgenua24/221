import http from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPipeline } from './pipeline.js';
import { runEditPipeline, parseEditBody, MAX_MEDIA, MAX_FRAMES } from './edit-pipeline.js';
import { runIntuitionPipeline, runIntuitionRevision, parseIntuitionBody, parseRevisionBody, MAX_CLIPS, MAX_CLIP_SECONDS, MIN_CLIP_SECONDS, CLIP_FRAMES, MAX_REFS } from './intuition-pipeline.js';
import { streamChat } from './openrouter.js';
import { mockLLM } from './mock.js';
import { createWaveSpeed, createMockWaveSpeed, VIDEO_MODELS, DEFAULT_VIDEO_MODEL, EDIT_MODEL } from './wavespeed.js';
import { FILM_GUIDES, FILM_RULES } from './film-knowledge.js';
import { createRawStore, KINDS } from './raw-store.js';
import { runRawTurn, parseRawTurnBody } from './raw-agent.js';
import { createSpeaker } from './raw-voice.js';
import { GREETING } from './raw-prompts.js';
import { createStoryStore, ASPECTS as STORY_ASPECTS, SHOT_SECONDS, MAX_SHOTS, MAX_ASSETS as STORY_MAX_ASSETS } from './story-store.js';
import { createStoryJobs, runStoryTurn, parseStoryTurnBody } from './story-pipeline.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const RUNS = path.join(ROOT, 'runs');
const MEDIA = path.join(RUNS, 'media'); // storyboards y videos generados (se sirven en /media/…)
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const MAX_BODY = 40 * 1024 * 1024;
const MAX_EDIT_BODY = 90 * 1024 * 1024; // audio WAV + cuadros de cada video
const MAX_DECIDE_BODY = 60 * 1024 * 1024; // una decisión puede traer el clip grabado para re-filmar (Cinematic Pro)
const MAX_PHOTOS = 8;

const apiKey = process.env.OPENROUTER_API_KEY;
const mock = process.env.MOCK === '1' || !apiKey;
const researcherModel = process.env.RESEARCHER_MODEL || 'meta/muse-spark-1.3-contributor';
const config = {
  orchestratorModel: process.env.ORCHESTRATOR_MODEL || 'anthropic/claude-opus-5.5',
  researcherModel,
  criticModel: process.env.CRITIC_MODEL || researcherModel,
  researchWeb: process.env.RESEARCH_WEB !== '0',
  researcherVision: process.env.RESEARCHER_VISION === '1',
};
const editConfig = {
  earModel: process.env.EAR_MODEL || 'google/gemini-3.8-flash,google/gemini-3.7-flash,qwen/qwen3.8-omni-flash',
  directorModel: process.env.DIRECTOR_MODEL || config.orchestratorModel,
};

// Intuition: el Director de Arte y los Motion Designers (tienen que aceptar imágenes).
// Los clips de "Video IA + texto" usan WaveSpeed: GPT Image para el storyboard y Seedance / Wan para la toma.
const wavespeedKey = process.env.WAVESPEED_API_KEY;
const intuitionConfig = {
  motionModel: process.env.MOTION_MODEL || config.orchestratorModel,
  storyboardModel: process.env.STORYBOARD_MODEL || 'openai/gpt-image-2.5-flare/edit',
  storyboardQuality: process.env.STORYBOARD_QUALITY || 'high',
  videoResolution: process.env.VIDEO_RESOLUTION || '720p',
  mediaDir: MEDIA,
};
const ws = mock ? createMockWaveSpeed({ mediaDir: MEDIA }) : wavespeedKey ? createWaveSpeed({ apiKey: wavespeedKey, mediaDir: MEDIA }) : null;

// Raw: proyectos (carpetas) con personas y referencias, un agente que habla y genera imágenes.
const rawStore = createRawStore(path.join(RUNS, 'raw'));
const rawConfig = {
  rawModel: process.env.RAW_MODEL || config.orchestratorModel,
  rawReasoning: process.env.RAW_REASONING ?? 'low', // la conversación es por voz: mejor rápido
  imageModel: process.env.RAW_IMAGE_MODEL || 'openai/gpt-image-2.5-flare/edit',
  imageQuality: process.env.RAW_IMAGE_QUALITY || 'high',
  ttsModel: process.env.RAW_TTS_MODEL || 'google/gemini-3.8-flash/text-to-speech',
  ttsVoice: process.env.RAW_TTS_VOICE || 'Kore',
  ttsStyle: process.env.RAW_TTS_STYLE || '',
};
const rawWs = mock ? createMockWaveSpeed({ mediaDir: rawStore.filesDir }) : wavespeedKey ? createWaveSpeed({ apiKey: wavespeedKey, mediaDir: rawStore.filesDir }) : null;
// La voz consulta más seguido: una frase tarda segundos.
const ttsWs = mock ? rawWs : wavespeedKey ? createWaveSpeed({ apiKey: wavespeedKey, mediaDir: rawStore.filesDir, pollMs: 400 }) : null;
const speak = createSpeaker({ ws: ttsWs, filesDir: rawStore.filesDir, publicPrefix: '/raw-files/', model: rawConfig.ttsModel, voice: rawConfig.ttsVoice, style: rawConfig.ttsStyle });

// Historia: el Guionista conversa y arma las tomas; cada toma aprobada la dirige el DP y la genera Wan 3.0.
const storyStore = createStoryStore(path.join(RUNS, 'story'));
const storyConfig = {
  storyModel: process.env.STORY_MODEL || config.orchestratorModel,
  dpModel: process.env.STORY_DP_MODEL || process.env.STORY_MODEL || config.orchestratorModel,
  frameModel: process.env.STORY_FRAME_MODEL || 'openai/gpt-image-2.5-flare/text-to-image',
  frameEditModel: process.env.STORY_FRAME_EDIT_MODEL || 'openai/gpt-image-2.5-flare/edit',
  frameQuality: process.env.STORY_FRAME_QUALITY || 'high',
  videoModel: process.env.STORY_VIDEO_MODEL || VIDEO_MODELS.wan.path(),
  videoResolution: process.env.STORY_VIDEO_RESOLUTION || '480p',
};
const storyWs = mock ? createMockWaveSpeed({ mediaDir: storyStore.filesDir }) : wavespeedKey ? createWaveSpeed({ apiKey: wavespeedKey, mediaDir: storyStore.filesDir }) : null;

const llm = mock ? mockLLM : (opts) => streamChat({ apiKey, ...opts });

// Decisiones esperando respuesta del humano: id -> resolve.
const pending = new Map();

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.flac': 'audio/flac', '.gif': 'image/gif',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
};

async function readBody(req, max = MAX_BODY) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw new Error(`El envío supera ${Math.round(max / 1024 / 1024)} MB.`);
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function badRequest(res, error) {
  res.writeHead(400, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error }));
}

// Corre un flujo con streaming de eventos (NDJSON) y decisiones humanas; guarda el registro en runs/.
async function streamFlow(res, { prefix, runConfig, run }) {
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
  const controller = new AbortController();
  res.on('close', () => { if (!res.writableFinished) controller.abort(); });
  const emit = (event) => { if (!res.writableEnded) res.write(JSON.stringify(event) + '\n'); };

  // El flujo se pausa acá hasta que llega POST /api/decide con este id.
  const ask = (decision) => new Promise((resolve, reject) => {
    const id = randomUUID();
    pending.set(id, (answer) => { emit({ type: 'decision_done', id, answer }); resolve(answer); });
    controller.signal.addEventListener('abort', () => { pending.delete(id); reject(new Error('cancelado')); }, { once: true });
    emit({ type: 'decision', id, ...decision });
  });
  // Señal periódica para que redes móviles y proxies no corten la conexión mientras el humano piensa.
  const ping = setInterval(() => emit({ type: 'ping' }), 15000);

  emit({ type: 'run', mock, config: runConfig });
  try {
    const log = await run({ emit, llm, signal: controller.signal, ask });
    await mkdir(RUNS, { recursive: true });
    const file = path.join(RUNS, `${prefix}${log.startedAt.replace(/[:.]/g, '-')}.json`);
    await writeFile(file, JSON.stringify({ ...log, mock }, null, 2));
    emit({ type: 'done', totals: log.totals, saved: path.relative(ROOT, file) });
  } catch (err) {
    if (!controller.signal.aborted) emit({ type: 'error', text: err.message });
  } finally {
    clearInterval(ping);
  }
  res.end();
}

async function handleRun(req, res) {
  let body;
  try {
    body = await readBody(req);
  } catch (err) {
    return badRequest(res, err.message);
  }
  const text = String(body.text || '').slice(0, 5000);
  const photos = (Array.isArray(body.photos) ? body.photos : [])
    .filter((p) => typeof p === 'string' && p.startsWith('data:image/'))
    .slice(0, MAX_PHOTOS);
  if (!text.trim() && !photos.length) return badRequest(res, 'Subí al menos una foto o escribí qué hace el negocio.');
  return streamFlow(res, { prefix: '', runConfig: config, run: (ctx) => runPipeline({ text, photos, config, ...ctx }) });
}

async function handleEdit(req, res) {
  let input;
  try {
    input = parseEditBody(await readBody(req, MAX_EDIT_BODY));
  } catch (err) {
    return badRequest(res, err.message);
  }
  return streamFlow(res, { prefix: 'edicion-', runConfig: editConfig, run: (ctx) => runEditPipeline({ ...input, config: editConfig, ...ctx }) });
}

async function handleIntuition(req, res) {
  let input;
  try {
    input = parseIntuitionBody(await readBody(req));
  } catch (err) {
    return badRequest(res, err.message);
  }
  if (input.clips.some((c) => c.mode === 'ai') && !ws) return badRequest(res, 'Los clips de "Video IA + texto" necesitan WAVESPEED_API_KEY en el .env del servidor.');
  const { mediaDir, ...runConfig } = intuitionConfig;
  return streamFlow(res, { prefix: 'intuition-', runConfig, run: (ctx) => runIntuitionPipeline({ ...input, config: intuitionConfig, ws, ...ctx }) });
}

async function handleIntuitionRevise(req, res) {
  let input;
  try {
    input = parseRevisionBody(await readBody(req));
  } catch (err) {
    return badRequest(res, err.message);
  }
  const { mediaDir, ...runConfig } = intuitionConfig;
  return streamFlow(res, { prefix: 'intuition-rev-', runConfig, run: (ctx) => runIntuitionRevision({ ...input, config: intuitionConfig, ...ctx }) });
}

async function handleDecide(req, res) {
  let body;
  try { body = await readBody(req, MAX_DECIDE_BODY); } catch { body = {}; }
  const resolve = pending.get(body.id);
  if (!resolve) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Esa decisión ya no está pendiente.' }));
  }
  pending.delete(body.id);
  resolve(body.answer ?? null);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end('{"ok":true}');
}

// ---------- Raw ----------
function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// Operaciones cortas de Raw (carpetas e imágenes): JSON de ida y vuelta.
const RAW_ACTIONS = {
  '/api/raw/folders': async (b) => ({ folder: await rawStore.createFolder({ name: b.name, parentId: b.parentId }) }),
  '/api/raw/folders/rename': async (b) => ({ folder: await rawStore.renameFolder(String(b.id), b.name) }),
  '/api/raw/folders/delete': async (b) => rawStore.deleteFolder(String(b.id)),
  '/api/raw/assets': async (b) => {
    if (!KINDS[b.kind] || b.kind === 'generada') throw new Error('Tipo inválido: persona o referencia.');
    return { asset: await rawStore.addAsset({ folderId: String(b.folderId), kind: b.kind, dataUrl: b.dataUrl, name: b.name }) };
  },
  '/api/raw/assets/update': async (b) => ({ asset: await rawStore.updateAsset(String(b.code), { kind: b.kind, name: b.name, category: b.category }) }),
  '/api/raw/assets/delete': async (b) => ({ asset: await rawStore.deleteAsset(String(b.code)) }),
  '/api/raw/speak': async (b) => {
    try { return { url: await speak(String(b.text || '').slice(0, 800)) }; } catch (err) { return { url: null, error: err.message }; }
  },
};

async function handleRawAction(req, res, action) {
  try {
    sendJson(res, 200, await action(await readBody(req, 25 * 1024 * 1024)));
  } catch (err) {
    sendJson(res, 400, { error: err.message });
  }
}

async function handleRawGet(res, url) {
  try {
    if (url.pathname === '/api/raw/folders') return sendJson(res, 200, { folders: await rawStore.tree() });
    const id = url.searchParams.get('id') || '';
    const [lineage, assets, history, tree] = await Promise.all([rawStore.lineage(id), rawStore.assetsFor(id), rawStore.history(id), rawStore.tree()]);
    return sendJson(res, 200, { lineage, assets, history: history.filter((h) => !h.note), children: tree.filter((f) => f.parentId === id) });
  } catch (err) {
    return sendJson(res, 404, { error: err.message });
  }
}

async function handleRawTurn(req, res) {
  let input;
  try {
    input = parseRawTurnBody(await readBody(req));
    await rawStore.lineage(input.folderId);
  } catch (err) {
    return badRequest(res, err.message);
  }
  const { ttsStyle, ...runConfig } = rawConfig;
  return streamFlow(res, { prefix: 'raw-', runConfig, run: (ctx) => runRawTurn({ store: rawStore, input, config: rawConfig, ws: rawWs, speak, ...ctx }) });
}

// ---------- Historia ----------
const storyJobs = storyWs ? createStoryJobs({ store: storyStore, ws: storyWs, llm, config: storyConfig }) : null;
const needWs = () => { if (!storyJobs) throw new Error('Los cuadros y los videos necesitan WAVESPEED_API_KEY en el .env del servidor.'); return storyJobs; };
const view = (id) => (storyJobs ? storyJobs.view(id) : storyStore.get(id));
const STORY_ACTIONS = {
  '/api/story/projects': async (b) => ({ project: await storyStore.create({ title: b.title, aspect: b.aspect }) }),
  '/api/story/projects/update': async (b) => { await storyStore.update(String(b.id), b); return { project: await view(String(b.id)) }; },
  '/api/story/projects/delete': async (b) => {
    const p = await storyStore.get(String(b.id));
    p.shots.forEach((s) => storyJobs?.cancel(p.id, s.id));
    return storyStore.remove(p.id);
  },
  '/api/story/assets': async (b) => ({ asset: await storyStore.addAsset(String(b.projectId), { dataUrl: b.dataUrl, name: b.name, source: b.source }) }),
  '/api/story/assets/delete': async (b) => storyStore.deleteAsset(String(b.projectId), String(b.code)),
  '/api/story/frames': async (b) => needWs().frames(String(b.projectId), Array.isArray(b.shotIds) ? b.shotIds.map(String) : null),
  '/api/story/shots/revise': async (b) => needWs().reviseFrame(String(b.projectId), String(b.shotId), { feedback: String(b.feedback || '').slice(0, 1500).trim(), prompt: String(b.prompt || '').slice(0, 2000).trim() }),
  '/api/story/shots/approve': async (b) => needWs().approve(String(b.projectId), String(b.shotId), { feedback: b.feedback }),
  '/api/story/shots/cancel': async (b) => { storyJobs?.cancel(String(b.projectId), String(b.shotId)); return { ok: true }; },
  '/api/story/music': async (b) => { await storyStore.setMusic(String(b.projectId), { dataUrl: b.dataUrl, name: b.name }); return { project: await view(String(b.projectId)) }; },
  '/api/story/timeline': async (b) => { await storyStore.setTimeline(String(b.projectId), { order: b.order, music: b.music }); return { project: await view(String(b.projectId)) }; },
};

async function handleStoryTurn(req, res) {
  let input;
  try {
    input = parseStoryTurnBody(await readBody(req));
    await storyStore.get(input.projectId);
  } catch (err) {
    return badRequest(res, err.message);
  }
  const jobs = storyJobs || { cancel() {}, view: (id) => storyStore.get(id) };
  return streamFlow(res, { prefix: 'story-', runConfig: storyConfig, run: (ctx) => runStoryTurn({ store: storyStore, jobs, input, config: storyConfig, ...ctx }) });
}

async function handleStoryGet(res, url) {
  try {
    if (url.pathname === '/api/story/projects') return sendJson(res, 200, { projects: await storyStore.list() });
    return sendJson(res, 200, { project: await view(url.searchParams.get('id') || '') });
  } catch (err) {
    return sendJson(res, 404, { error: err.message });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'POST' && url.pathname === '/api/story/turn') return handleStoryTurn(req, res);
  if (req.method === 'POST' && STORY_ACTIONS[url.pathname]) return handleRawAction(req, res, STORY_ACTIONS[url.pathname]);
  if (req.method === 'GET' && (url.pathname === '/api/story/projects' || url.pathname === '/api/story/project')) return handleStoryGet(res, url);
  if (req.method === 'POST' && url.pathname === '/api/raw/turn') return handleRawTurn(req, res);
  if (req.method === 'POST' && RAW_ACTIONS[url.pathname]) return handleRawAction(req, res, RAW_ACTIONS[url.pathname]);
  if (req.method === 'GET' && (url.pathname === '/api/raw/folders' || url.pathname === '/api/raw/folder')) return handleRawGet(res, url);
  if (req.method === 'POST' && url.pathname === '/api/run') return handleRun(req, res);
  if (req.method === 'POST' && url.pathname === '/api/edit') return handleEdit(req, res);
  if (req.method === 'POST' && url.pathname === '/api/intuition') return handleIntuition(req, res);
  if (req.method === 'POST' && url.pathname === '/api/intuition/revise') return handleIntuitionRevise(req, res);
  if (req.method === 'POST' && url.pathname === '/api/decide') return handleDecide(req, res);
  if (req.method === 'GET' && url.pathname === '/api/config') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      mock, ...config, ...editConfig,
      story: {
        model: storyConfig.storyModel, dpModel: storyConfig.dpModel, frameModel: storyConfig.frameModel, videoModel: storyConfig.videoModel, resolution: storyConfig.videoResolution,
        shotSeconds: SHOT_SECONDS, maxShots: MAX_SHOTS, maxAssets: STORY_MAX_ASSETS, aspects: STORY_ASPECTS, generate: !!storyJobs, filmGuides: FILM_GUIDES.length,
      },
      raw: { model: rawConfig.rawModel, imageModel: rawConfig.imageModel, ttsModel: rawConfig.ttsModel, voice: !!ttsWs && !ttsWs.mock, images: !!rawWs, greeting: GREETING }, motionModel: intuitionConfig.motionModel, storyboardModel: intuitionConfig.storyboardModel, maxPhotos: MAX_PHOTOS, maxMedia: MAX_MEDIA, maxFrames: MAX_FRAMES,
      intuition: {
        maxClips: MAX_CLIPS, maxClipSeconds: MAX_CLIP_SECONDS, minClipSeconds: MIN_CLIP_SECONDS, clipFrames: CLIP_FRAMES, maxRefs: MAX_REFS,
        cine: true, refilm: !!ws, refilmModel: EDIT_MODEL.label, filmGuides: FILM_GUIDES.length,
        aiVideo: !!ws, videoModels: Object.entries(VIDEO_MODELS).map(([id, m]) => ({ id, label: m.label })), defaultVideoModel: DEFAULT_VIDEO_MODEL,
      },
    }));
  }
  if (req.method !== 'GET') { res.writeHead(405); return res.end(); }
  if (url.pathname === '/edicion') { res.writeHead(302, { Location: '/?modo=edicion' }); return res.end(); }
  if (url.pathname === '/intuition') { res.writeHead(302, { Location: '/?modo=intuition' }); return res.end(); }

  // Storyboards y videos generados: mismo origen, para que el canvas pueda dibujarlos y exportarlos.
  // /raw-files/…: las imágenes y audios de los proyectos de Raw.
  const mount = [['/media/', MEDIA], ['/raw-files/', rawStore.filesDir], ['/story-files/', storyStore.filesDir]].find(([prefix]) => url.pathname.startsWith(prefix));
  const dir = mount ? mount[1] : PUBLIC;
  const rel = mount ? decodeURIComponent(url.pathname.slice(mount[0].length - 1)) : url.pathname === '/' ? 'index.html' : url.pathname;
  const file = path.normalize(path.join(dir, rel));
  if (!file.startsWith(dir + path.sep)) { res.writeHead(403); return res.end(); }
  try {
    const content = await readFile(file);
    const headers = { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' };
    // El worker ejecuta código escrito por la IA: sin red y sin nada más que sus propios módulos.
    if (path.basename(file) === 'motion-worker.js') headers['Content-Security-Policy'] = "default-src 'none'; script-src 'self' 'unsafe-eval'";
    // Rangos: Safari no reproduce video sin ellos, y la línea de tiempo salta a cualquier segundo.
    const range = mount && /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (range && (range[1] || range[2])) {
      const size = content.length;
      const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
      const end = range[1] && range[2] ? Math.min(size - 1, Number(range[2])) : size - 1;
      if (start >= size || start > end) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
      res.writeHead(206, { ...headers, 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
      return res.end(content.subarray(start, end + 1));
    }
    if (mount) headers['Accept-Ranges'] = 'bytes';
    res.writeHead(200, headers);
    res.end(content);
  } catch {
    res.writeHead(404); res.end('No encontrado');
  }
});

server.listen(PORT, HOST, () => {
  storyJobs?.resume().catch((err) => console.error(`Historia: no pude retomar las tomas pendientes: ${err.message}`));
  console.log(`221 — arnés de contenido en http://${HOST}:${PORT}`);
  console.log(mock
    ? 'MODO DEMO: sin OPENROUTER_API_KEY (o MOCK=1). Las respuestas son simuladas.'
    : `Orquestador: ${config.orchestratorModel} · Investigador: ${config.researcherModel} · Crítico: ${config.criticModel} · Web: ${config.researchWeb ? 'sí' : 'no'}`);
  console.log(`Edición con música (mismo chat, modo 🎬) · Oído: ${editConfig.earModel} · Director: ${editConfig.directorModel}`);
  console.log(`Intuition (motion design, modo ✨) · Director de Arte y Motion Designers: ${intuitionConfig.motionModel}`);
  console.log(ws
    ? `Video IA + texto · storyboard: ${intuitionConfig.storyboardModel} · video: ${Object.values(VIDEO_MODELS).map((m) => m.path()).join(' / ')}${ws.mock ? ' (demo: no se genera nada)' : ''}`
    : 'Video IA + texto: desactivado (falta WAVESPEED_API_KEY).');
  console.log(`Raw (pestaña principal) · agente: ${rawConfig.rawModel} · imágenes: ${rawWs ? rawConfig.imageModel : 'desactivado (falta WAVESPEED_API_KEY)'} · voz: ${ttsWs && !ttsWs.mock ? `${rawConfig.ttsModel} (${rawConfig.ttsVoice})` : 'la del navegador'}`);
  console.log(`Historia · Guionista: ${storyConfig.storyModel} · DP: ${storyConfig.dpModel} · cuadros: ${storyConfig.frameModel} / ${storyConfig.frameEditModel} · video: ${storyWs ? `${storyConfig.videoModel} (${storyConfig.videoResolution}, ${SHOT_SECONDS} s)${storyWs.mock ? ' (demo)' : ''}` : 'desactivado (falta WAVESPEED_API_KEY)'}`);
  console.log(`Cinematic Pro · Director de Fotografía con agents-film (${FILM_GUIDES.length} guías, ${FILM_RULES.size} reglas) · re-filmar: ${ws ? `${EDIT_MODEL.path()}${ws.mock ? ' (demo)' : ''}` : 'desactivado (falta WAVESPEED_API_KEY)'}`);
});
