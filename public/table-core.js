// Mesa de agentes: reglas puras (sin DOM) que comparten el navegador, el servidor y los tests.
// Cuatro asientos (A, B, C, D) alrededor de una mesa. Empieza uno sorteado y siguen en sentido horario.
export const SEATS = ['A', 'B', 'C', 'D'];
export const MAX_ROUNDS = 10;
export const PASS = '[PASO]';
export const DONE = '[LISTO]';

// Orden de una ronda: el sorteado primero y el resto en sentido horario.
export function speakingOrder(starter) {
  const i = SEATS.indexOf(starter);
  if (i < 0) throw new Error('Asiento inválido.');
  return [...SEATS.slice(i), ...SEATS.slice(0, i)];
}

export const drawStarter = (random = Math.random) => SEATS[Math.min(SEATS.length - 1, Math.floor(random() * SEATS.length))];

// Qué ve cada agente: todo lo de la mesa y lo que el usuario le dijo solo a él.
// seat = null es el relator de la entrega final: ve la mesa, no los mensajes privados.
export const visibleTo = (entry, seat) => entry.type !== 'user' || entry.to === 'table' || (!!seat && entry.to === seat);
export const fileVisibleTo = (file, seat) => file.to === 'table' || (!!seat && file.to === seat);

// Respuesta de un agente: [PASO] = no suma nada en este turno; [LISTO] = cree que la misión final ya está resuelta.
export function parseReply(raw) {
  let text = String(raw || '').trim();
  const done = /\[LISTO\]/i.test(text);
  const pass = /\[PASO\]/i.test(text);
  text = text.replace(/\[(LISTO|PASO)\]/gi, '').replace(/^[\s:—–-]+/, '').trim();
  return { action: pass || !text ? 'pass' : 'speak', done, text };
}

// La ronda cerró la conversación: los cuatro pasaron o dijeron [LISTO] y el usuario no sumó nada desde que empezó.
export function consensus(log, round) {
  const first = log.findIndex((e) => e.type === 'agent' && e.round === round);
  if (first < 0) return false;
  const turns = log.filter((e) => e.type === 'agent' && e.round === round);
  if (turns.length < SEATS.length) return false;
  if (log.slice(first).some((e) => e.type === 'user')) return false;
  return turns.every((t) => t.action === 'pass' || t.done);
}

// Qué sigue según el cursor { round, turn } de la sesión.
export function nextStep(session) {
  const { round, turn } = session.cursor;
  const max = session.maxRounds || MAX_ROUNDS;
  if (session.final) return { kind: 'done' };
  if (turn === 0 && round > 1 && consensus(session.log, round - 1)) return { kind: 'synthesis', reason: 'consensus' };
  if (round > max) return { kind: 'synthesis', reason: 'rounds' };
  return { kind: 'turn', round, seat: session.order[turn], last: round === max };
}

// Avanza el cursor después de un turno. Devuelve true si empezó una ronda nueva.
export function advance(session) {
  session.cursor.turn += 1;
  if (session.cursor.turn < SEATS.length) return false;
  session.cursor = { round: session.cursor.round + 1, turn: 0 };
  return true;
}

// Códigos de archivo: M1, M2… los de la mesa; A1, B2… los privados de cada asiento.
export function nextFileCode(files, to) {
  const prefix = to === 'table' ? 'M' : to;
  return `${prefix}${files.filter((f) => f.to === to).length + 1}`;
}

// Conversación (turnos, relator y revisiones de partes) + lo generado en la mesa + lo producido con RUN.
export function totalCost(session) {
  const talk = [...session.log.filter((e) => e.type === 'agent'), session.final].reduce((sum, e) => sum + (Number(e?.usage?.cost) || 0), 0);
  const prod = session.final?.production;
  const revisions = prod ? eachPart(prod).reduce((s, { part }) => s + part.thread.reduce((t, m) => t + (Number(m.usage?.cost) || 0), 0), 0) : 0;
  return talk + revisions + assetsCost(session) + (prod ? productionCost(prod) : 0);
}

// ---------- Lo que la mesa genera (G1, G2…) y la entrega de producción ----------
const KIND_LABEL = { image: 'imagen', voice: 'voz', sound: 'sonido' };
const quote = (s, n = 400) => `«${String(s || '').length > n ? `${String(s).slice(0, n - 1)}…` : s}»`;

// Una línea por pieza generada: es todo lo que un agente sabe de un audio (no lo puede escuchar).
export function describeAsset(a, agents = []) {
  const who = agents.find((x) => x.seat === a.seat);
  const by = `${a.seat}${who?.name ? ` · ${who.name}` : ''}`;
  const s = a.spec || {};
  if (a.kind === 'image') return `${a.code} · imagen de ${by} (ronda ${a.round}, ${s.proporcion})${s.referencias?.length ? ` a partir de ${s.referencias.join(', ')}` : ''}: ${quote(s.prompt)}`;
  if (a.kind === 'voice') return `${a.code} · voz de ${by} (ronda ${a.round}): ${s.personaje}, voz ${s.voz}, estabilidad ${s.estabilidad} — ${quote(s.texto)}`;
  return `${a.code} · ${s.tipo === 'musica' ? 'música' : s.tipo || 'sonido'} de ${by} (ronda ${a.round}, ${s.duracion} s${s.loop ? ', loop' : ''}): ${quote(s.prompt)}`;
}
export const assetKindLabel = (kind) => KIND_LABEL[kind] || kind;

// La entrega que devuelve el servidor (partes con su especificación) → la producción que el humano trabaja:
// cada parte guarda sus versiones (cada feedback del dueño es una versión nueva), su resultado y su conversación.
export const SHOT_PARTS = ['cuadro', 'voz', 'sonido', 'video'];
function partFrom(p) {
  if (!p) return null;
  const result = p.base ? { url: p.base.url, model: p.base.model, cost: 0, from: p.base.code, at: Date.now() } : null;
  return { kind: p.kind, owner: p.owner, versions: [{ spec: p.spec, result, job: null, at: Date.now(), by: 'mesa' }], current: 0, thread: [] };
}
export function toProduction(delivery) {
  return {
    titulo: delivery.titulo, resumen: delivery.resumen, estilo: delivery.estilo, proporcion: delivery.proporcion,
    personajes: delivery.personajes || [], pendientes: delivery.pendientes || [],
    shots: delivery.shots.map((s) => ({ id: s.id, titulo: s.titulo, duracion: s.duracion, descripcion: s.descripcion, parts: Object.fromEntries(SHOT_PARTS.map((k) => [k, partFrom(s.parts[k])])) })),
    musica: partFrom(delivery.musica),
  };
}
export const version = (part) => part?.versions[part.current] || null;
export const specOf = (part) => version(part)?.spec || null;
export const resultOf = (part) => version(part)?.result || null;

// Recorre todas las partes: [{ shot, kind, part }] (shot = null para la música).
export function eachPart(prod) {
  const out = [];
  for (const shot of prod?.shots || []) for (const kind of SHOT_PARTS) if (shot.parts[kind]) out.push({ shot, kind, part: shot.parts[kind] });
  if (prod?.musica) out.push({ shot: null, kind: 'musica', part: prod.musica });
  return out;
}
export const findPart = (prod, shotId, kind) => (kind === 'musica' ? prod.musica : prod.shots.find((s) => s.id === shotId)?.parts[kind]) || null;

// Lo que ve un modelo de la producción: las especificaciones vigentes (sin resultados ni historial).
export function snapshot(prod) {
  const part = (p) => (p ? { dueno: p.owner, ...specOf(p) } : null);
  return {
    titulo: prod.titulo, resumen: prod.resumen, estilo: prod.estilo, proporcion: prod.proporcion, personajes: prod.personajes,
    tomas: prod.shots.map((s) => ({ id: s.id, titulo: s.titulo, duracion: s.duracion, descripcion: s.descripcion, ...Object.fromEntries(SHOT_PARTS.map((k) => [k, part(s.parts[k])])) })),
    musica: part(prod.musica), pendientes: prod.pendientes,
  };
}

// Lo que costó producir (cada versión corrida). Las piezas que vienen de la mesa ya se contaron allá (cost 0).
export function productionCost(prod) {
  return eachPart(prod).reduce((sum, { part }) => sum + part.versions.reduce((s, v) => s + (Number(v.result?.cost) || 0), 0), 0);
}
export const assetsCost = (session) => (session.assets || []).reduce((s, a) => s + (Number(a.cost) || 0), 0);
