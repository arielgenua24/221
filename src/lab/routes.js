// Rutas HTTP del Laboratorio (las monta src/server.js).
//   POST /api/lab/run         → NDJSON: una ejecución de un agente (ver pipeline.js)
//   GET  /api/lab/models      → modelos con visión de OpenRouter (con precios) + datos del harness
//   GET  /api/lab/frame.html  → el documento del iframe aislado: CSP + bundle de React/Remotion + frame.js, todo en línea
import { parseLabBody, runLabAgent, MAX_COMPILE_RETRIES, MAX_BRIEF_REFS, MAX_ZONE_SECONDS, MAX_TOOL_ROUNDS } from './pipeline.js';
import { buildRuntime, runtimeInfo, GOOGLE_FONTS } from './runtime.js';
import { harnessVersion, SKILL_FILES, SKILLS_COMMIT } from './harness.js';
import { createLabTools, TOOL_COSTS, IMAGE_MODEL, IMAGE_EDIT_MODEL, MAX_GENERATED_IMAGES, MAX_SEARCHES } from './tools.js';
import { mockLabLLM } from './mock.js';
import { readFile } from 'node:fs/promises';

const FRAME_SCRIPT = new URL('./frame.js', import.meta.url);

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
      .map((m) => ({ id: m.id, name: m.name || m.id, prompt: Number(m.pricing?.prompt) * 1e6 || 0, completion: Number(m.pricing?.completion) * 1e6 || 0, created: m.created || 0 }))
      .sort((a, b) => b.created - a.created);
    catalog = { at: Date.now(), models };
    return models;
  } catch {
    return FALLBACK_MODELS;
  }
}

// wavespeedKey: imágenes; serpKey: búsqueda de referencias. Los modelos de los agentes siguen en OpenRouter.
export function createLabRoutes({ mock, llm, readBody, sendJson, badRequest, wavespeedKey, mediaDir, serpKey = process.env.SERPAPI_API_KEY }) {
  const labLlm = mock ? mockLabLLM : llm;
  const tools = createLabTools({ serpKey, wavespeedKey, mediaDir, mock });

  async function run(req, res) {
    let input;
    try {
      input = parseLabBody(await readBody(req, MAX_LAB_BODY));
    } catch (err) {
      return badRequest(res, err.message);
    }
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
    const controller = new AbortController();
    res.on('close', () => { if (!res.writableFinished) controller.abort(); });
    const emit = (event) => { if (!res.writableEnded) res.write(JSON.stringify(event) + '\n'); };
    const ping = setInterval(() => emit({ type: 'ping' }), 15000);
    try {
      await runLabAgent({ input, emit, llm: labLlm, signal: controller.signal, tools });
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
      models: await visionModels(),
      harness: {
        version: harnessVersion(tools.available), skillsCommit: SKILLS_COMMIT, skills: SKILL_FILES, maxCompileRetries: MAX_COMPILE_RETRIES, maxBriefRefs: MAX_BRIEF_REFS,
        maxZoneSeconds: MAX_ZONE_SECONDS, fonts: GOOGLE_FONTS, ...runtimeInfo(),
        tools: { ...tools.available, imageProvider: 'wavespeed', imageModel: IMAGE_MODEL, imageEditModel: IMAGE_EDIT_MODEL, maxImages: MAX_GENERATED_IMAGES, maxSearches: MAX_SEARCHES, maxRounds: MAX_TOOL_ROUNDS, costs: TOOL_COSTS },
      },
    });
  }

  // El documento entero va en línea: la página lo carga como srcdoc con sandbox="allow-scripts"
  // (origen opaco, sin acceso a la app) y la CSP del <meta> le corta la red.
  let frameDoc = null;
  async function frame(res) {
    try {
      frameDoc ??= Promise.all([buildRuntime(), readFile(FRAME_SCRIPT, 'utf8')]).then(([runtime, script]) => frameHtml(runtime, script)).catch((err) => { frameDoc = null; throw err; });
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(await frameDoc);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`No pude armar el runtime de Remotion: ${err.message}`);
    }
  }

  // Devuelve true si la ruta era del Laboratorio.
  return function handle(req, res, url) {
    if (req.method === 'POST' && url.pathname === '/api/lab/run') { run(req, res); return true; }
    if (req.method === 'GET' && url.pathname === '/api/lab/models') { models(res); return true; }
    if (req.method === 'GET' && url.pathname === '/api/lab/frame.html') { frame(res); return true; }
    return false;
  };
}

// CSP del iframe donde corre el código de los agentes: sin red salvo las fuentes de Google,
// el video llega como Blob (blob:) y el código se evalúa con new Function ('unsafe-eval').
export const FRAME_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval'",
  "style-src 'unsafe-inline' https://fonts.googleapis.com",
  'font-src https://fonts.gstatic.com data: blob:',
  'img-src data: blob:',
  'media-src blob:',
  'connect-src blob: data: https://fonts.googleapis.com https://fonts.gstatic.com',
  'worker-src blob:',
].join('; ');

// Un "</script" dentro del código cerraría la etiqueta antes de tiempo.
const inline = (js) => js.replace(/<\/(script)/gi, '<\\/$1');

export function frameHtml(runtime, script) {
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  html, body { margin: 0; height: 100%; background: #000; overflow: hidden; color: #f4f1ea; font: 13px/1.4 system-ui, sans-serif; }
  #root { width: 100%; height: 100%; }
  .lab-frame-error { position: absolute; inset: 0; display: grid; place-items: center; padding: 16px; text-align: center; background: #1b0f0c; color: #ffb4a1; white-space: pre-wrap; overflow: auto; }
</style>
</head>
<body>
<div id="root"></div>
<script>${inline(runtime)}</script>
<script>${inline(script)}</script>
</body>
</html>`;
}
