// Laboratorio · modo Automático: el agente elige los momentos del video donde conviene una animación.
// Recibe la transcripción por segundo (ver transcript.js) y la cantidad de animaciones que pidió el humano, y devuelve:
//   zonas { start, end, said, frames: [segundos exactos] }
// El planificador solo elige DÓNDE: no propone qué mostrar (eso lo decide el diseñador, o el humano en el pedido de cada clip).
// «said» es lo que se dice en la zona, copiado tal cual de la transcripción (no lo escribe el modelo).
// «frames» son los instantes de los que el agente quiere VER el cuadro: el navegador los recorta del video con el mismo
// mecanismo del marcador manual (el servidor nunca tiene el video) y esos cuadros, junto con la transcripción, son lo que
// después ve el agente que diseña la animación. Las zonas resultantes se pueden mover y ajustar a mano.
import { FPS } from './runtime.js';

export const MIN_PLAN_SECONDS = 1.5; // zona más corta que pide el planificador
export const MAX_PLAN_SECONDS = 8; // zona más larga (lo normal: 2 a 6 s)
export const MIN_PLAN_FRAMES = 2;
export const MAX_PLAN_FRAMES = 4;
const MAX_SAID = 600;

const num = (x, fallback = NaN) => (x === null || x === '' || !Number.isFinite(Number(x)) ? fallback : Number(x));
const r2 = (x) => Math.round(x * 100) / 100;
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

// La transcripción para el planificador: una línea por segundo con habla, con el segundo exacto en que arranca.
export function planTranscript(heads) {
  const lines = [];
  let quiet = null;
  const flush = () => { if (quiet) lines.push(`${mmss(quiet[0])}${quiet[0] === quiet[1] ? '' : `–${mmss(quiet[1])}`} · (sin habla)`); quiet = null; };
  for (const h of heads) {
    if (!h.text) { quiet = quiet ? [quiet[0], h.t] : [h.t, h.t]; continue; }
    flush();
    lines.push(`${mmss(h.t)} · desde ${r2(h.at ?? h.t)} s · ${h.text}`);
  }
  flush();
  return lines.join('\n');
}

// Lo que se dice entre start y end (segundos), tal cual la transcripción: los segundos con habla que tocan la zona.
export function saidBetween(heads, start, end) {
  return (heads || []).filter((h) => h.text && h.t < end && h.t + 1 > start).map((h) => h.text.trim()).join(' ').replace(/\s+/g, ' ').trim().slice(0, MAX_SAID);
}

export function planMessages({ count, video, brief = {}, transcript, minSeconds = MIN_PLAN_SECONDS, maxSeconds = MAX_PLAN_SECONDS }) {
  const system = `Sos editor de video. Te dan la transcripción de lo que se dice en un video (con el segundo en que arranca cada tramo) y tenés que elegir EN QUÉ MOMENTOS del video va una animación de motion design. Solo recortás: elegís dónde. Qué se anima ahí lo decide después otra persona; vos no proponés ideas, títulos, objetos ni qué mostrar.

Reglas:
- Elegí EXACTAMENTE ${count} momento${count > 1 ? 's' : ''}: el humano decidió cuántas animaciones quiere. Solo devolvé menos si de verdad no hay tantos momentos que valgan la pena, y decilo en "nota".
- Elegí los más útiles: ideas clave, nombres propios, cifras, giros ("y entonces…"), promesas, cierres o llamados a la acción. Evitá muletillas y silencios. Repartilos a lo largo del video; no los amontones.
- Cada momento es una zona [start, end] en segundos del video, de ${minSeconds} a ${maxSeconds} s (lo normal: 2 a 6 s), dentro de la duración total y sin superponerse con las otras. Arrancala cuando empieza a decirse la frase (usá el «desde N s» de la transcripción) y cerrala cuando la frase termina: no cortes una frase por la mitad.
- Para cada zona elegí de ${MIN_PLAN_FRAMES} a ${MAX_PLAN_FRAMES} segundos EXACTOS del video de los que hay que ver el cuadro ("frames"): donde se dice lo más importante de la zona o donde cambia lo que hay en pantalla. Tienen que caer dentro de la zona.
- No escribas ideas ni descripciones de animación: el JSON lleva solo start, end y frames.

Respondé SOLO con un objeto JSON, sin texto antes ni después ni bloques de código:
{"zones":[{"start":12.4,"end":16,"frames":[12.6,14.2,15.8]}],"nota":""}`;
  const user = [
    `# Video\n${video.name || 'video'} · ${r2(video.duration)} s de duración (${Math.ceil(video.duration * FPS)} cuadros a ${FPS} fps).`,
    `# Cuántas animaciones\n${count}`,
    brief.context ? `# Contexto del video\n${brief.context}` : '',
    brief.instructions ? `# Qué busca el humano (para elegir los momentos, no para proponer animaciones)\n${brief.instructions}` : '',
    `# Transcripción (segundo del video · desde qué segundo exacto se dice · lo que se dice)\n${planTranscript(transcript.heads)}`,
  ].filter(Boolean).join('\n\n');
  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

// Ordena y limpia la respuesta del modelo: zonas dentro del video, entre el mínimo y el máximo, sin superponerse, con 2 a 4 cuadros
// dentro de cada una. Lo que no se puede arreglar se descarta. Devuelve { zones, note }.
export function parsePlan(text, { count, duration, minSeconds = MIN_PLAN_SECONDS, maxSeconds = MAX_PLAN_SECONDS }) {
  const raw = String(text || '');
  const a = raw.indexOf('{');
  const b = raw.lastIndexOf('}');
  let data;
  try { data = JSON.parse(raw.slice(a, b + 1)); } catch { throw new Error('la respuesta no es un JSON válido (se esperaba {"zones":[…]})'); }
  const list = Array.isArray(data?.zones) ? data.zones : Array.isArray(data) ? data : null;
  if (!list) throw new Error('falta la lista "zones" en el JSON');
  const zones = [];
  for (const z of list) {
    let start = num(z?.start);
    let end = num(z?.end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    start = Math.min(Math.max(0, start), duration);
    end = Math.min(Math.max(0, end), duration);
    if (end - start > maxSeconds) end = start + maxSeconds;
    if (end - start < minSeconds) { // se estira hacia adelante y, si no alcanza el video, hacia atrás
      end = Math.min(duration, start + minSeconds);
      start = Math.max(0, end - minSeconds);
    }
    if (end - start < minSeconds - 0.01) continue;
    const len = end - start;
    let frames = [...new Set((Array.isArray(z?.frames) ? z.frames : []).map((t) => num(t)).filter((t) => Number.isFinite(t) && t >= start - 0.01 && t <= end + 0.01).map((t) => r2(Math.min(end, Math.max(start, t)))))].sort((x, y) => x - y);
    if (frames.length > MAX_PLAN_FRAMES) frames = Array.from({ length: MAX_PLAN_FRAMES }, (_, i) => frames[Math.round((i * (frames.length - 1)) / (MAX_PLAN_FRAMES - 1))]);
    // Si pidió menos de 2, se completan con instantes repartidos dentro de la zona (los más lejanos de los que ya eligió).
    for (const f of [0.15, 0.85, 0.5]) {
      if (frames.length >= MIN_PLAN_FRAMES) break;
      const t = r2(start + f * len);
      if (!frames.some((x) => Math.abs(x - t) < 0.3)) frames.push(t);
    }
    frames.sort((x, y) => x - y);
    zones.push({ start: r2(start), end: r2(end), frames });
  }
  zones.sort((x, y) => x.start - y.start);
  // Sin superposiciones: si una pisa a la anterior, se descarta (queda la que empieza antes).
  const clean = [];
  for (const z of zones) if (!clean.length || z.start >= clean.at(-1).end - 0.01) clean.push(z);
  return { zones: clean.slice(0, count), note: String(data?.nota ?? data?.note ?? '').replace(/\s+/g, ' ').trim().slice(0, 400) };
}

// Una llamada al modelo (con una sola corrección si no devolvió algo usable). llm: la de OpenRouter (streamChat).
export async function planZones({ llm, model, signal, count, video, brief, transcript, minSeconds, maxSeconds, onRetry }) {
  const messages = planMessages({ count, video, brief, transcript, minSeconds, maxSeconds });
  let cost = 0;
  let tokens = 0;
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await llm({ step: 'lab-plan', model, messages, signal, meta: { lab: true, plan: true, model }, temperature: 0.3, onRetry });
    cost += res.usage?.cost || 0;
    tokens += res.usage?.total_tokens || 0;
    try {
      const { zones, note } = parsePlan(res.text, { count, duration: video.duration, minSeconds, maxSeconds });
      if (zones.length) return { zones: zones.map((z) => ({ ...z, said: saidBetween(transcript.heads, z.start, z.end) })), note, cost, tokens, model, requested: count };
      lastError = new Error('no devolvió ninguna zona utilizable');
    } catch (err) { lastError = err; }
    messages.push({ role: 'assistant', content: res.text?.trim() ? res.text : '(respuesta vacía)' }, { role: 'user', content: `Tu respuesta no sirve: ${lastError.message}. Devolvé SOLO el objeto JSON con ${count} zona${count > 1 ? 's' : ''} válida${count > 1 ? 's' : ''} (start y end en segundos, dentro de 0–${r2(video.duration)}, de ${minSeconds} a ${maxSeconds} s cada una, sin superponerse).` });
  }
  throw new Error(`${model} no devolvió un plan válido: ${lastError.message}`);
}

// Modo demo y respaldo de pruebas: elige a mano alzada (sin modelo) los segundos con más habla, bien repartidos.
export function heuristicPlan({ count, video, transcript, minSeconds = MIN_PLAN_SECONDS, maxSeconds = MAX_PLAN_SECONDS }) {
  const len = Math.min(maxSeconds, Math.max(minSeconds, 3));
  const ranked = transcript.heads.filter((h) => h.text).map((h) => ({ h, score: h.text.split(' ').length })).sort((a, b) => b.score - a.score || a.h.t - b.h.t);
  const picked = [];
  for (const { h } of ranked) {
    const start = Math.max(0, Math.min(video.duration - len, h.at ?? h.t));
    if (picked.every((p) => start >= p.end + 0.5 || start + len <= p.start - 0.5)) picked.push({ start, end: Math.min(video.duration, start + len) });
    if (picked.length >= count) break;
  }
  const zones = picked.sort((a, b) => a.start - b.start).map((z) => ({
    start: r2(z.start), end: r2(z.end),
    frames: [0.15, 0.5, 0.85].map((f) => r2(z.start + f * (z.end - z.start))),
    said: saidBetween(transcript.heads, z.start, z.end),
  }));
  return { zones, note: zones.length < count ? 'En el video no hay tantos momentos con habla.' : '', cost: 0, tokens: 0, model: 'demo', requested: count };
}
