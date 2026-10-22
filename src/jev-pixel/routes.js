import { decide, mockDecide, JEV_MODEL } from '../objects3d/jev.js';
import {
  GRID, HIGH_RES_GRID, V4_MAX_K, V4_MIN_K, V4_MAX_REFINE_TILES, V4_TILE_SUBGRID,
  locateSubjectBox, reconstructGrid, reconstructHybridV3, reconstructSuperpixelsV4, refineUncertainTilesV4,
} from './experiments.js';

// Laboratorio · JEV a píxel (copia de los cuatro experimentos de jev-to-pix, app/api/reconstruct*).
//   GET  /api/lab/jev-pixel/config       → { mock, available, model, limits }
//   POST /api/lab/jev-pixel/locate       { image, question }                  → box() + presencia (ciclo 1 de Exp 2/3/4)
//   POST /api/lab/jev-pixel/grid         { image, question, grid }            → grilla N×N de noul (Exp 1: 8 · Exp 2: 8–20)
//   POST /api/lab/jev-pixel/hybrid       { image, question, baseGrid }        → 16×16 noul + 4 box (Exp 3, ciclo 2)
//   POST /api/lab/jev-pixel/superpixels  { image, question, k, centroids? }   → un noul por superpíxel + 4 box (Exp 4, ciclo 2)
//   POST /api/lab/jev-pixel/refine       { question, tiles: [{ tileId, image }] } → 4×4 noul por tile (Exp 4, ciclo 3)
// Las imágenes viajan como data URL PNG/JPEG en JSON. JEV corre en la API de TypeSafe (TYPESAFE_API_KEY).
const MAX_BODY = 64 * 1024 * 1024;
const MB = 1024 * 1024;
const DATA_URL = /^data:image\/(png|jpeg|jpg);base64,([A-Za-z0-9+/=\s]+)$/;

export const LIMITS = {
  gridMin: 8, gridMax: 20, exp1Grid: GRID, exp2Grid: HIGH_RES_GRID,
  kMin: V4_MIN_K, kMax: V4_MAX_K, maxRefineTiles: V4_MAX_REFINE_TILES, tileSubgrid: V4_TILE_SUBGRID,
  smallImageBytes: 4 * MB, imageBytes: 10 * MB, questionMax: 280, questionMaxV3: 240,
};

const fail = (message) => Object.assign(new Error(message), { status: 400 });

// Tamaño aproximado del binario a partir del base64 (sin decodificarlo).
const base64Bytes = (b64) => {
  const clean = b64.replace(/\s/g, '');
  return Math.floor((clean.length * 3) / 4) - (clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0);
};

// Mismas reglas que los route.ts originales: PNG/JPEG y peso máximo.
export function checkImage(value, { maxBytes, missing, badType, tooBig }) {
  if (typeof value !== 'string' || !value.startsWith('data:')) throw fail(missing);
  const m = DATA_URL.exec(value);
  if (!m) throw fail(badType);
  const bytes = base64Bytes(m[2]);
  if (bytes <= 0 || bytes > maxBytes) throw fail(tooBig);
  return value;
}

export function checkQuestion(value, max, message) {
  const q = typeof value === 'string' ? value.trim() : '';
  if (q.length < 2) throw fail(message);
  if (q.length > max) throw fail(max === LIMITS.questionMax ? 'La pregunta es demasiado larga.' : message);
  return q;
}

// Cada parser devuelve los argumentos de la función del experimento (sin ask/model/signal).
export const parsers = {
  locate(body) {
    const subject = checkQuestion(body.question, LIMITS.questionMax, 'Escribí qué querés que JEV marque.');
    const image = checkImage(body.image, {
      maxBytes: LIMITS.imageBytes, missing: 'Falta la imagen.',
      badType: 'JEV solo acepta PNG o JPEG. Convertí la imagen y volvé a subirla.',
      tooBig: 'La imagen debe pesar menos de 10 MB.',
    });
    return { image, subject };
  },
  grid(body) {
    const image = checkImage(body.image, {
      maxBytes: LIMITS.smallImageBytes, missing: 'Falta la imagen.',
      badType: 'JEV solo acepta PNG o JPEG. Convertí la imagen y volvé a subirla.',
      tooBig: 'La imagen tiene que pesar menos de 4 MB.',
    });
    const subject = checkQuestion(body.question, LIMITS.questionMax, 'Escribí qué querés que JEV marque.');
    const parsed = Number.parseInt(body.grid, 10);
    const grid = Number.isFinite(parsed) ? Math.max(LIMITS.gridMin, Math.min(LIMITS.gridMax, parsed)) : HIGH_RES_GRID;
    return { image, subject, grid };
  },
  hybrid(body) {
    const image = checkImage(body.image, {
      maxBytes: LIMITS.imageBytes, missing: 'Subí una imagen.',
      badType: 'JEV requiere imágenes en formato PNG o JPEG.',
      tooBig: 'La imagen debe pesar menos de 10 MB.',
    });
    const subject = checkQuestion(body.question, LIMITS.questionMaxV3, 'Escribí qué objeto querés localizar y reconstruir.');
    const raw = Number(body.baseGrid ?? 16);
    return { image, subject, baseGrid: Number.isFinite(raw) ? raw : 16 };
  },
  superpixels(body) {
    const subject = checkQuestion(body.question, LIMITS.questionMaxV3, 'Escribí qué objeto querés segmentar.');
    const labeledImage = checkImage(body.image, {
      maxBytes: LIMITS.imageBytes, missing: 'Falta la imagen: recorte etiquetado.',
      badType: 'JEV requiere imágenes en formato PNG o JPEG.',
      tooBig: 'Cada imagen debe pesar menos de 10 MB.',
    });
    const k = Number(body.k ?? 400);
    if (!Number.isFinite(k) || k < V4_MIN_K || k > V4_MAX_K) throw fail(`k debe estar entre ${V4_MIN_K} y ${V4_MAX_K}.`);
    // Centroides opcionales: si vienen mal formados se ignoran, como en el original.
    const centroids = Array.isArray(body.centroids) ? body.centroids : undefined;
    return { labeledImage, subject, k, centroids };
  },
  refine(body) {
    const subject = checkQuestion(body.question, LIMITS.questionMaxV3, 'Escribí qué objeto querés segmentar.');
    const list = body.tiles;
    if (!Array.isArray(list)) throw fail('tileIds inválido.');
    if (list.length === 0) throw fail('No hay tiles para refinar.');
    if (list.length > V4_MAX_REFINE_TILES) throw fail(`Máximo ${V4_MAX_REFINE_TILES} tiles por ciclo.`);
    const tiles = list.map((t) => {
      if (!t || typeof t.tileId !== 'string' || !t.tileId) throw fail('tileIds inválido.');
      if (!/^[A-Za-z0-9_-]{1,32}$/.test(t.tileId)) throw fail('tileIds inválido.');
      const image = checkImage(t.image, {
        maxBytes: LIMITS.imageBytes, missing: `Falta la imagen: tile ${t.tileId}.`,
        badType: 'JEV requiere imágenes en formato PNG o JPEG.',
        tooBig: 'Cada imagen debe pesar menos de 10 MB.',
      });
      return { tileId: t.tileId, image };
    });
    return { subject, tiles };
  },
};

const RUN = {
  locate: locateSubjectBox,
  grid: reconstructGrid,
  hybrid: reconstructHybridV3,
  superpixels: reconstructSuperpixelsV4,
  refine: refineUncertainTilesV4,
};

export function createJevPixelRoutes({ mock, apiKey, readBody, sendJson, badRequest, decideImpl }) {
  const ask = decideImpl || (mock ? mockDecide : (opts) => decide({ apiKey, ...opts }));
  const available = !!(mock || apiKey || decideImpl);

  async function handle(step, req, res) {
    let args;
    try {
      args = parsers[step](await readBody(req, MAX_BODY) || {});
    } catch (err) {
      return badRequest(res, err instanceof SyntaxError ? 'El cuerpo no es JSON válido.' : err.message);
    }
    if (!available) return sendJson(res, 500, { error: 'Falta TYPESAFE_API_KEY en el proyecto.' });
    const controller = new AbortController();
    res.on('close', () => { if (!res.writableFinished) controller.abort(); });
    try {
      const result = await RUN[step]({ ask, model: JEV_MODEL, signal: controller.signal, ...args });
      return sendJson(res, 200, result);
    } catch (err) {
      if (controller.signal.aborted) return undefined;
      return sendJson(res, err.status === 400 ? 400 : 502, { error: err.message || 'JEV no pudo responder.' });
    }
  }

  return (req, res, url) => {
    if (!url.pathname.startsWith('/api/lab/jev-pixel/')) return false;
    const step = url.pathname.slice('/api/lab/jev-pixel/'.length);
    if (req.method === 'GET' && step === 'config') {
      sendJson(res, 200, { mock: !!mock, available, model: JEV_MODEL, limits: LIMITS });
      return true;
    }
    if (req.method === 'POST' && Object.hasOwn(RUN, step)) { handle(step, req, res); return true; }
    return false;
  };
}
