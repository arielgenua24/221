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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const RUNS = path.join(ROOT, 'runs');
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const MAX_BODY = 40 * 1024 * 1024;
const MAX_EDIT_BODY = 90 * 1024 * 1024; // audio WAV + cuadros de cada video
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
const intuitionConfig = {
  motionModel: process.env.MOTION_MODEL || config.orchestratorModel,
};

const llm = mock ? mockLLM : (opts) => streamChat({ apiKey, ...opts });

// Decisiones esperando respuesta del humano: id -> resolve.
const pending = new Map();

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

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
  return streamFlow(res, { prefix: 'intuition-', runConfig: intuitionConfig, run: (ctx) => runIntuitionPipeline({ ...input, config: intuitionConfig, ...ctx }) });
}

async function handleIntuitionRevise(req, res) {
  let input;
  try {
    input = parseRevisionBody(await readBody(req));
  } catch (err) {
    return badRequest(res, err.message);
  }
  return streamFlow(res, { prefix: 'intuition-rev-', runConfig: intuitionConfig, run: (ctx) => runIntuitionRevision({ ...input, config: intuitionConfig, ...ctx }) });
}

async function handleDecide(req, res) {
  let body;
  try { body = await readBody(req); } catch { body = {}; }
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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'POST' && url.pathname === '/api/run') return handleRun(req, res);
  if (req.method === 'POST' && url.pathname === '/api/edit') return handleEdit(req, res);
  if (req.method === 'POST' && url.pathname === '/api/intuition') return handleIntuition(req, res);
  if (req.method === 'POST' && url.pathname === '/api/intuition/revise') return handleIntuitionRevise(req, res);
  if (req.method === 'POST' && url.pathname === '/api/decide') return handleDecide(req, res);
  if (req.method === 'GET' && url.pathname === '/api/config') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      mock, ...config, ...editConfig, ...intuitionConfig, maxPhotos: MAX_PHOTOS, maxMedia: MAX_MEDIA, maxFrames: MAX_FRAMES,
      intuition: { maxClips: MAX_CLIPS, maxClipSeconds: MAX_CLIP_SECONDS, minClipSeconds: MIN_CLIP_SECONDS, clipFrames: CLIP_FRAMES, maxRefs: MAX_REFS },
    }));
  }
  if (req.method !== 'GET') { res.writeHead(405); return res.end(); }
  if (url.pathname === '/edicion') { res.writeHead(302, { Location: '/?modo=edicion' }); return res.end(); }
  if (url.pathname === '/intuition') { res.writeHead(302, { Location: '/?modo=intuition' }); return res.end(); }

  const file = path.normalize(path.join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  try {
    const content = await readFile(file);
    const headers = { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' };
    // El worker ejecuta código escrito por la IA: sin red y sin nada más que sus propios módulos.
    if (path.basename(file) === 'motion-worker.js') headers['Content-Security-Policy'] = "default-src 'none'; script-src 'self' 'unsafe-eval'";
    res.writeHead(200, headers);
    res.end(content);
  } catch {
    res.writeHead(404); res.end('No encontrado');
  }
});

server.listen(PORT, HOST, () => {
  console.log(`221 — arnés de contenido en http://${HOST}:${PORT}`);
  console.log(mock
    ? 'MODO DEMO: sin OPENROUTER_API_KEY (o MOCK=1). Las respuestas son simuladas.'
    : `Orquestador: ${config.orchestratorModel} · Investigador: ${config.researcherModel} · Crítico: ${config.criticModel} · Web: ${config.researchWeb ? 'sí' : 'no'}`);
  console.log(`Edición con música (mismo chat, modo 🎬) · Oído: ${editConfig.earModel} · Director: ${editConfig.directorModel}`);
  console.log(`Intuition (motion design, modo ✨) · Director de Arte y Motion Designers: ${intuitionConfig.motionModel}`);
});
