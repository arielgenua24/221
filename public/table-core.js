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

export function totalCost(session) {
  return [...session.log.filter((e) => e.type === 'agent'), session.final].reduce((sum, e) => sum + (Number(e?.usage?.cost) || 0), 0);
}
