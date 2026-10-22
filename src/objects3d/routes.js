import { parseObjectsBody, buildState, buildQuestions, chunkQuestions, buildScene, DEFAULT_MODEL, MAX_OBJECTS, MAX_COLS, MAX_ROWS, MAX_PER_REQUEST, ROLES, DEPTH } from './scene.js';
import { decide, mockDecide } from './jev.js';
import { reconstructHybridV3, reconstructSuperpixelsV4, refineUncertainTilesV4, V4_MIN_K, V4_MAX_K, V4_MAX_REFINE_TILES } from '../jev-pixel/experiments.js';

// Laboratorio · Objetos 3D.
//   GET  /api/lab/objects/config  → modelo, límites, roles y niveles de profundidad.
//   POST /api/lab/objects/analyze → { image, objects, grid, gridOnImage, freeSpace, pairs, context, model }
//                                   → { scene, calls: [{ questions, answers }], usage, ms }
//   POST /api/lab/objects/segment → silueta de UN objeto dentro de su recorte, con los experimentos de JEV a píxel:
//        { method: 'hybrid', image, subject, baseGrid }                     → Exp 3 (16×16 noul + 4 box)
//        { method: 'superpixels', image (con IDs impresos), subject, k, centroids } → Exp 4, ciclo 2
//        { method: 'refine', tiles: [{ tileId, image }], subject }          → Exp 4, ciclo 3
// JEV corre en la API de TypeSafe (TYPESAFE_API_KEY). Las preguntas se reparten en llamadas de hasta 600 que corren en paralelo.
const MAX_BODY = 24 * 1024 * 1024;
const MAX_SEGMENT_BODY = 64 * 1024 * 1024;
const IMAGE = /^data:image\/(png|jpeg);base64,/;

export function parseSegmentBody(body = {}) {
  const method = String(body.method || '');
  const subject = String(body.subject || '').trim();
  if (subject.length < 2 || subject.length > 240) throw new Error('Falta qué objeto segmentar (2 a 240 caracteres).');
  const model = String(body.model || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
  if (method === 'refine') {
    const tiles = Array.isArray(body.tiles) ? body.tiles : [];
    if (!tiles.length) throw new Error('No hay tiles para refinar.');
    if (tiles.length > V4_MAX_REFINE_TILES) throw new Error(`Máximo ${V4_MAX_REFINE_TILES} tiles por ciclo.`);
    if (!tiles.every((t) => typeof t?.tileId === 'string' && IMAGE.test(String(t.image || '')))) throw new Error('Cada tile necesita tileId y una imagen PNG o JPEG.');
    return { method, subject, model, tiles: tiles.map((t) => ({ tileId: t.tileId, image: t.image })) };
  }
  const image = String(body.image || '');
  if (!IMAGE.test(image)) throw new Error('Falta el recorte: una imagen PNG o JPEG en base64.');
  if (method === 'hybrid') return { method, subject, model, image, baseGrid: Math.min(20, Math.max(8, Math.round(Number(body.baseGrid) || 16))) };
  if (method === 'superpixels') {
    const k = Math.floor(Number(body.k));
    if (!Number.isFinite(k) || k < V4_MIN_K || k > V4_MAX_K) throw new Error(`k debe estar entre ${V4_MIN_K} y ${V4_MAX_K}.`);
    const centroids = Array.isArray(body.centroids) ? body.centroids : undefined;
    return { method, subject, model, image, k, centroids };
  }
  throw new Error('method tiene que ser hybrid, superpixels o refine.');
}

export function createObjectsRoutes({ mock, apiKey, readBody, sendJson, badRequest, decideImpl }) {
  const ask = decideImpl || (mock ? mockDecide : (opts) => decide({ apiKey, ...opts }));

  async function analyze(req, res) {
    let input;
    try { input = parseObjectsBody(await readBody(req, MAX_BODY)); } catch (err) { return badRequest(res, err.message); }
    const controller = new AbortController();
    res.on('close', () => { if (!res.writableFinished) controller.abort(); });
    const started = Date.now();
    try {
      const state = buildState(input);
      const batches = chunkQuestions(buildQuestions(input));
      const results = await Promise.all(batches.map((questions) => ask({ model: input.model, state, questions, signal: controller.signal })));
      const answers = Object.assign({}, ...results.map((r) => r.answers || {}));
      const usage = results.reduce((u, r) => ({ input_tokens: u.input_tokens + (Number(r.usage?.input_tokens) || 0), cost: u.cost + (Number(r.usage?.cost) || 0) }), { input_tokens: 0, cost: 0 });
      return sendJson(res, 200, {
        model: results[0]?.model || input.model,
        scene: buildScene(input, answers),
        calls: batches.map((questions, k) => ({ questions, answers: results[k].answers })),
        usage,
        ms: Date.now() - started,
      });
    } catch (err) {
      if (!controller.signal.aborted) sendJson(res, err.status === 400 ? 400 : 502, { error: err.message });
    }
  }

  async function segment(req, res) {
    let input;
    try { input = parseSegmentBody(await readBody(req, MAX_SEGMENT_BODY)); } catch (err) { return badRequest(res, err.message); }
    const controller = new AbortController();
    res.on('close', () => { if (!res.writableFinished) controller.abort(); });
    const common = { ask, model: input.model, subject: input.subject, signal: controller.signal };
    try {
      const out = input.method === 'hybrid' ? await reconstructHybridV3({ ...common, image: input.image, baseGrid: input.baseGrid })
        : input.method === 'superpixels' ? await reconstructSuperpixelsV4({ ...common, labeledImage: input.image, k: input.k, centroids: input.centroids })
          : await refineUncertainTilesV4({ ...common, tiles: input.tiles });
      return sendJson(res, 200, out);
    } catch (err) {
      if (!controller.signal.aborted) sendJson(res, err.status === 400 ? 400 : 502, { error: err.message });
    }
  }

  return (req, res, url) => {
    if (req.method === 'GET' && url.pathname === '/api/lab/objects/config') {
      sendJson(res, 200, { mock, available: mock || !!apiKey, model: DEFAULT_MODEL, maxPerRequest: MAX_PER_REQUEST, maxObjects: MAX_OBJECTS, maxCols: MAX_COLS, maxRows: MAX_ROWS, roles: Object.keys(ROLES), depth: DEPTH });
      return true;
    }
    if (req.method === 'POST' && url.pathname === '/api/lab/objects/analyze') { analyze(req, res); return true; }
    if (req.method === 'POST' && url.pathname === '/api/lab/objects/segment') { segment(req, res); return true; }
    return false;
  };
}
