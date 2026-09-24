import http from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPipeline } from './pipeline.js';
import { streamChat } from './openrouter.js';
import { mockLLM } from './mock.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const RUNS = path.join(ROOT, 'runs');
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const MAX_BODY = 40 * 1024 * 1024;
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

const llm = mock ? mockLLM : (opts) => streamChat({ apiKey, ...opts });

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error('El envío supera 40 MB.');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function handleRun(req, res) {
  let body;
  try {
    body = await readBody(req);
  } catch (err) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: err.message }));
  }
  const text = String(body.text || '').slice(0, 5000);
  const photos = (Array.isArray(body.photos) ? body.photos : [])
    .filter((p) => typeof p === 'string' && p.startsWith('data:image/'))
    .slice(0, MAX_PHOTOS);
  if (!text.trim() && !photos.length) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Subí al menos una foto o escribí qué hace el negocio.' }));
  }

  res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
  const controller = new AbortController();
  res.on('close', () => { if (!res.writableFinished) controller.abort(); });
  const emit = (event) => { if (!res.writableEnded) res.write(JSON.stringify(event) + '\n'); };

  emit({ type: 'run', mock, config });
  try {
    const log = await runPipeline({ text, photos, emit, llm, config, signal: controller.signal });
    await mkdir(RUNS, { recursive: true });
    const file = path.join(RUNS, `${log.startedAt.replace(/[:.]/g, '-')}.json`);
    await writeFile(file, JSON.stringify({ ...log, mock }, null, 2));
    emit({ type: 'done', totals: log.totals, saved: path.relative(ROOT, file) });
  } catch (err) {
    if (!controller.signal.aborted) emit({ type: 'error', text: err.message });
  }
  res.end();
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'POST' && url.pathname === '/api/run') return handleRun(req, res);
  if (req.method === 'GET' && url.pathname === '/api/config') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ mock, ...config, maxPhotos: MAX_PHOTOS }));
  }
  if (req.method !== 'GET') { res.writeHead(405); return res.end(); }

  const file = path.normalize(path.join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  try {
    const content = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
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
});
