// Cliente de JEV por la API de TypeSafe (POST /v1/systemone con el SDK oficial).
// { model, state, questions } → { model, answers, usage }. Las imágenes viajan como partes binarias:
// cualquier data URL PNG/JPEG dentro de `state` se convierte en un asset `image()` del SDK, y las
// preguntas la nombran por su clave en el state (por ejemplo `photo`).
import { TypeSafeClient, Image } from '@typesafe-ai/sdk';

export const JEV_MODEL = process.env.JEV_MODEL || 'jev-1.14.0';
const DATA_URL = /^data:image\/(png|jpeg|jpg);base64,/;
const clients = new Map();

function clientFor(apiKey, fetchImpl) {
  const key = `${apiKey}|${fetchImpl ? 'custom' : 'fetch'}`;
  if (!clients.has(key) || fetchImpl) {
    clients.set(key, new TypeSafeClient({
      apiKey,
      timeout: 120_000,
      retry: { maxRetries: 2 },
      defaultHeaders: { 'TypeSafe-Danger-Zone-Images': 'true' },
      ...(fetchImpl ? { fetch: fetchImpl } : {}),
    }));
  }
  return clients.get(key);
}

// Data URLs → assets de imagen del SDK, en cualquier nivel del state.
export function withImages(value) {
  if (typeof value === 'string') return DATA_URL.test(value) ? Image.fromBase64(value.slice(value.indexOf(',') + 1)) : value;
  if (value instanceof Image) return value;
  if (Array.isArray(value)) return value.map(withImages);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, withImages(v)]));
  return value;
}

export async function decide({ apiKey, model, state, questions, signal, fetchImpl }) {
  if (!apiKey) throw Object.assign(new Error('Falta TYPESAFE_API_KEY para hablar con JEV.'), { status: 500 });
  try {
    const result = await clientFor(apiKey, fetchImpl).systemOne(
      { model: model || JEV_MODEL, state: withImages(state), questions },
      { signal },
    );
    return { model: result.model, answers: result.answers, usage: { input_tokens: result.usage?.input_tokens ?? 0, output_tokens: result.usage?.output_tokens ?? 0 } };
  } catch (err) {
    const status = err.status ?? (err.name === 'BadRequestError' ? 400 : 502);
    throw Object.assign(new Error(`JEV ${status} (${model || JEV_MODEL}): ${String(err.message || err).slice(0, 300)}`), { status });
  }
}

// Modo demo: respuestas plausibles y deterministas, con la misma forma que las de JEV.
const hash = (s) => { let h = 2166136261; for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619); return (h >>> 0) / 4294967295; };

export async function mockDecide({ model, questions }) {
  const answers = {};
  for (const [key, q] of Object.entries(questions)) {
    const r = hash(key + JSON.stringify(q.instructions));
    if (q.type === 'noul') answers[key] = { type: 'noul', noul: +(key === 'present' || key.endsWith('_present') ? 0.75 + r * 0.24 : r).toFixed(3) };
    else if (q.type === 'box') {
      const w = 0.15 + r * 0.35, h = 0.12 + hash(key) * 0.3, left = r * (1 - w), top = hash(`${key}y`) * (1 - h);
      answers[key] = { type: 'box', box: { top: +top.toFixed(3), bottom: +(top + h).toFixed(3), left: +left.toFixed(3), right: +(left + w).toFixed(3) }, confidence: +(0.6 + r * 0.35).toFixed(3) };
    } else if (q.type === 'choice') {
      const labels = Object.keys(q.criteria);
      const raw = labels.map((l) => hash(key + l) ** 3);
      const sum = raw.reduce((a, b) => a + b, 0);
      const probabilities = Object.fromEntries(labels.map((l, k) => [l, +(raw[k] / sum).toFixed(3)]));
      const choice = labels[raw.indexOf(Math.max(...raw))];
      answers[key] = { type: 'choice', choice, confidence: probabilities[choice], probabilities };
    } else if (q.type === 'score') {
      const levels = q.criteria.length;
      const peak = r * (levels - 1);
      const raw = q.criteria.map((_, k) => Math.exp(-((k - peak) ** 2)));
      const sum = raw.reduce((a, b) => a + b, 0);
      const probabilities = Object.fromEntries(raw.map((v, k) => [String(k), +(v / sum).toFixed(3)]));
      const score = +raw.reduce((s, v, k) => s + (k * v) / sum, 0).toFixed(3);
      answers[key] = { type: 'score', score, confidence: +Math.max(...raw.map((v) => v / sum)).toFixed(3), probabilities, legend: Object.fromEntries(q.criteria.map((c, k) => [String(k), c])) };
    }
  }
  const input_tokens = 1600 + Object.keys(questions).length * 45;
  return { id: `demo-${Date.now()}`, model: `${model} (demo)`, answers, usage: { input_tokens, output_tokens: 0 } };
}
