import { decide, mockDecide, JEV_MODEL } from '../objects3d/jev.js';
import { loadCorpus } from './corpus.js';
import { MAX_OPTIONS, FRAMINGS } from './generate.js';
import { nextWordPlus } from './experimentos/index.js';

// Laboratorio · JEV habla: una palabra por pedido, el bucle lo maneja el cliente para mostrar cada paso.
//   GET  /api/lab/jev-lm/config → { mock, available, model, limits }
//   POST /api/lab/jev-lm/next   { text, generated, words, corpus, keep, order, framing, punct, penalty, seed,
//                                 sample, temperature, exclude, ngram, rerank, target } → paso
export const LIMITS = { textMax: 600, wordsMin: MAX_OPTIONS, wordsMax: 39_000, keepMax: 20, excludeMax: 200, generatedMax: 60 };

const fail = (message) => Object.assign(new Error(message), { status: 400 });
const intIn = (v, min, max, fallback) => {
  const n = v === undefined ? fallback : Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw fail(`El valor ${v} está fuera de rango (${min}–${max}).`);
  return n;
};

export function parseNext(body) {
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text) throw fail('Escribí el comienzo de la oración.');
  if (text.length > LIMITS.textMax) throw fail(`El texto supera ${LIMITS.textMax} caracteres.`);
  const exclude = Array.isArray(body.exclude) ? body.exclude.filter((w) => typeof w === 'string').map((w) => w.trim().toLowerCase()).filter(Boolean) : [];
  if (exclude.length > LIMITS.excludeMax) throw fail(`Máximo ${LIMITS.excludeMax} palabras excluidas.`);
  const temperature = body.temperature === undefined ? 1 : Number(body.temperature);
  if (!(temperature >= 0.1 && temperature <= 3)) throw fail('La temperatura va de 0.1 a 3.');
  const generated = Array.isArray(body.generated) ? body.generated.filter((w) => typeof w === 'string').slice(-LIMITS.generatedMax) : [];
  const penalty = body.penalty === undefined ? 1.5 : Number(body.penalty);
  if (!(penalty >= 0 && penalty <= 5)) throw fail('La penalización va de 0 a 5.');
  return {
    text,
    generated,
    size: intIn(body.words, LIMITS.wordsMin, LIMITS.wordsMax, 30_000),
    corpus: body.corpus === 'crudo' ? 'crudo' : 'limpio',
    keep: body.keep === undefined || body.keep === 'auto' ? 'auto' : intIn(body.keep, 1, LIMITS.keepMax, 1),
    seed: intIn(body.seed, 1, 2 ** 31, 1),
    order: body.order === 'frecuencia' ? 'frecuencia' : 'mezcla',
    framing: Object.hasOwn(FRAMINGS, body.framing) ? body.framing : 'hueco',
    punct: body.punct !== false,
    penalty,
    ngram: body.ngram === true,
    rerankTop: intIn(body.rerank, 0, 20, 0),
    target: intIn(body.target, 0, 40, 10),
    sample: body.sample === 'temp' ? 'temp' : 'greedy',
    temperature,
    exclude,
  };
}

export function createJevLmRoutes({ mock, apiKey, readBody, sendJson, badRequest, decideImpl }) {
  const base = decideImpl || (mock ? mockDecide : (opts) => decide({ apiKey, ...opts }));
  const available = !!(mock || apiKey || decideImpl);

  async function next(req, res) {
    let args;
    try {
      args = parseNext(await readBody(req, 64 * 1024) || {});
    } catch (err) {
      return badRequest(res, err instanceof SyntaxError ? 'El cuerpo no es JSON válido.' : err.message);
    }
    if (!available) return sendJson(res, 500, { error: 'Falta TYPESAFE_API_KEY en el proyecto.' });
    const controller = new AbortController();
    res.on('close', () => { if (!res.writableFinished) controller.abort(); });
    const ask = (opts) => base({ model: JEV_MODEL, signal: controller.signal, ...opts });
    const banned = new Set(args.exclude);
    const words = loadCorpus(args.size, { source: args.corpus }).filter((w) => !banned.has(w));
    const t0 = Date.now();
    try {
      const step = await nextWordPlus({ ask, words, ...args });
      return sendJson(res, 200, { text: args.text, corpus: words.length, ...step, ms: Date.now() - t0 });
    } catch (err) {
      if (controller.signal.aborted) return undefined;
      return sendJson(res, err.status === 400 ? 400 : 502, { error: err.message || 'JEV no pudo responder.' });
    }
  }

  return (req, res, url) => {
    if (!url.pathname.startsWith('/api/lab/jev-lm/')) return false;
    const step = url.pathname.slice('/api/lab/jev-lm/'.length);
    if (req.method === 'GET' && step === 'config') {
      sendJson(res, 200, { mock: !!mock, available, model: JEV_MODEL, limits: LIMITS });
      return true;
    }
    if (req.method === 'POST' && step === 'next') { next(req, res); return true; }
    return false;
  };
}
