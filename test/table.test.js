import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { SEATS, speakingOrder, drawStarter, parseReply, consensus, nextStep, advance, nextFileCode, totalCost } from '../public/table-core.js';
import { parseTableRequest, buildTurnMessages, buildSynthesisMessages } from '../src/table/prompts.js';
import { createTableRoutes } from '../src/table/routes.js';

const IMG = 'data:image/png;base64,AAAA';
const agents = SEATS.map((seat) => ({ seat, name: `Agente ${seat}`, model: `model/${seat.toLowerCase()}`, mission: `Misión de ${seat}`, notes: seat === 'B' ? 'Hablá corto' : '' }));
const body = (extra = {}) => ({ kind: 'turn', seat: 'B', round: 1, goal: 'Un guion de 30 s', agents, log: [], files: [], ...extra });
const turn = (seat, round, extra = {}) => ({ type: 'agent', seat, round, action: 'speak', done: false, text: `Habla ${seat}`, ...extra });
const textOf = (messages) => messages.map((m) => (typeof m.content === 'string' ? m.content : m.content.map((p) => p.text || '').join('\n'))).join('\n');

test('Mesa: orden en sentido horario desde el sorteado y sorteo dentro de los asientos', () => {
  assert.deepEqual(speakingOrder('C'), ['C', 'D', 'A', 'B']);
  assert.deepEqual(speakingOrder('A'), SEATS);
  assert.throws(() => speakingOrder('E'), /inválido/);
  assert.equal(drawStarter(() => 0), 'A');
  assert.equal(drawStarter(() => 0.999999), 'D');
  assert.equal(drawStarter(() => 1), 'D');
});

test('Mesa: [PASO] y [LISTO] se interpretan y se quitan del texto', () => {
  assert.deepEqual(parseReply('[PASO] Ya está cubierto.'), { action: 'pass', done: false, text: 'Ya está cubierto.' });
  assert.deepEqual(parseReply('Propongo el plano 3. [LISTO]'), { action: 'speak', done: true, text: 'Propongo el plano 3.' });
  assert.deepEqual(parseReply('[PASO] [LISTO]'), { action: 'pass', done: true, text: '' });
  assert.equal(parseReply('').action, 'pass');
});

test('Mesa: 10 rondas de 4 turnos, cierre por consenso salvo que el usuario haya sumado algo', () => {
  const s = { order: speakingOrder('B'), cursor: { round: 1, turn: 0 }, maxRounds: 10, log: [], final: null };
  assert.deepEqual(nextStep(s), { kind: 'turn', round: 1, seat: 'B', last: false });
  let turns = 0;
  while (nextStep(s).kind === 'turn') { const st = nextStep(s); s.log.push(turn(st.seat, st.round)); advance(s); turns++; }
  assert.equal(turns, 40);
  assert.deepEqual(nextStep(s), { kind: 'synthesis', reason: 'rounds' });

  const log = [turn('A', 1, { done: true }), turn('B', 1, { action: 'pass' }), turn('C', 1, { done: true }), turn('D', 1, { action: 'pass' })];
  assert.equal(consensus(log, 1), true);
  assert.equal(consensus([...log.slice(0, 2), { type: 'user', to: 'C', text: 'ojo', round: 1 }, ...log.slice(2)], 1), false);
  assert.equal(consensus([...log, { type: 'user', to: 'table', text: 'seguimos', round: 2 }], 1), false);
  assert.equal(consensus([...log.slice(0, 3), turn('D', 1)], 1), false);
  const early = { order: SEATS, cursor: { round: 2, turn: 0 }, maxRounds: 10, log, final: null };
  assert.deepEqual(nextStep(early), { kind: 'synthesis', reason: 'consensus' });
  assert.equal(nextStep({ ...early, final: { text: 'x' } }).kind, 'done');
  assert.equal(nextStep({ order: SEATS, cursor: { round: 10, turn: 3 }, maxRounds: 10, log: [], final: null }).last, true);
});

test('Mesa: códigos de archivos y costo total', () => {
  const files = [{ to: 'table' }, { to: 'A' }, { to: 'table' }];
  assert.equal(nextFileCode(files, 'table'), 'M3');
  assert.equal(nextFileCode(files, 'A'), 'A2');
  assert.equal(nextFileCode(files, 'D'), 'D1');
  assert.equal(totalCost({ log: [turn('A', 1, { usage: { cost: 0.01 } }), turn('B', 1, { usage: { cost: 0.02 } })], final: { usage: { cost: 0.5 } } }), 0.53);
});

test('Mesa: cada agente ve la mesa y solo sus mensajes y archivos privados; el relator, solo lo público', () => {
  const req = parseTableRequest(body({
    log: [turn('A', 1), { type: 'user', to: 'B', text: 'secreto para B', round: 1 }, { type: 'user', to: 'C', text: 'secreto para C', round: 1 }, { type: 'user', to: 'table', text: 'para todos', round: 1, files: ['M1'] }],
    files: [{ code: 'M1', name: 'logo.png', kind: 'image', to: 'table', data: IMG }, { code: 'B1', name: 'brief.md', kind: 'text', to: 'B', data: 'Brief privado de B' }, { code: 'C1', name: 'c.md', kind: 'text', to: 'C', data: 'Brief privado de C' }],
  }));
  assert.equal(req.model, 'model/b');
  const msgs = buildTurnMessages(req);
  const all = textOf(msgs);
  assert.match(msgs[0].content, /Sos Agente B/); assert.match(msgs[0].content, /Hablá corto/); assert.match(msgs[0].content, /ronda 1 de 10/);
  assert.match(all, /secreto para B/); assert.match(all, /Brief privado de B/); assert.match(all, /para todos/);
  assert.doesNotMatch(all, /secreto para C/); assert.doesNotMatch(all, /Brief privado de C/);
  assert.equal(msgs[1].content.find((p) => p.type === 'image_url').image_url.url, IMG);

  const synth = parseTableRequest(body({ kind: 'synthesis', reason: 'consensus', synthesisModel: '', log: req.log, files: [{ code: 'M1', name: 'logo.png', kind: 'image', to: 'table', data: IMG }, { code: 'B1', name: 'b.md', kind: 'text', to: 'B', data: 'Brief privado de B' }] }));
  assert.equal(synth.model, 'model/a');
  const st = textOf(buildSynthesisMessages(synth));
  assert.match(st, /relator/); assert.match(st, /Habla A/); assert.match(st, /para todos/);
  assert.doesNotMatch(st, /secreto/); assert.doesNotMatch(st, /Brief privado/);
});

test('Mesa: la última ronda lo avisa y los PDF viajan como archivo', () => {
  const req = parseTableRequest(body({ round: 10, files: [{ code: 'M1', name: 'deck.pdf', kind: 'pdf', to: 'table', data: 'data:application/pdf;base64,AAAA' }] }));
  const msgs = buildTurnMessages(req);
  assert.match(msgs[0].content, /ÚLTIMA ronda/);
  assert.equal(msgs[1].content.find((p) => p.type === 'file').file.filename, 'deck.pdf');
});

test('Mesa: valida agentes, misión, archivos y rondas', () => {
  assert.throws(() => parseTableRequest(body({ agents: agents.slice(0, 3) })), /cuatro/);
  assert.throws(() => parseTableRequest(body({ goal: ' ' })), /misión final/);
  assert.throws(() => parseTableRequest(body({ agents: agents.map((a) => (a.seat === 'C' ? { ...a, model: '' } : a)) })), /modelo del agente C/);
  assert.throws(() => parseTableRequest(body({ agents: [...agents].reverse() })), /orden/);
  assert.throws(() => parseTableRequest(body({ round: 11 })), /Ronda/);
  assert.throws(() => parseTableRequest(body({ seat: 'E' })), /asiento/);
  assert.throws(() => parseTableRequest(body({ files: [{ code: 'M1', name: 'x', kind: 'image', to: 'table', data: 'file:///etc/passwd' }] })), /inválida/);
  assert.throws(() => parseTableRequest(body({ files: [{ code: 'M1', name: 'x', kind: 'video', to: 'table', data: 'x' }] })), /imágenes, texto y PDF/);
  assert.throws(() => parseTableRequest(body({ log: [{ type: 'system', text: 'x', round: 0 }, { type: 'hack' }] })), /Registro/);
});

function fakeRes() {
  const res = new EventEmitter();
  res.chunks = []; res.writableEnded = false; res.writableFinished = false;
  res.writeHead = (status) => { res.status = status; };
  res.write = (c) => res.chunks.push(c);
  res.end = () => { res.writableEnded = true; res.writableFinished = true; res.emit('finished'); };
  res.events = () => res.chunks.join('').trim().split('\n').map((l) => JSON.parse(l));
  return res;
}
const route = (deps) => createTableRoutes({ readBody: async (r) => r.body, badRequest: (res, error) => { res.status = 400; res.error = error; res.end(); }, ...deps });
async function post(handle, payload) {
  const res = fakeRes();
  const done = new Promise((resolve) => res.once('finished', resolve));
  assert.equal(handle({ method: 'POST', body: payload }, res, new URL('http://x/api/lab/table/turn')), true);
  await done;
  return res;
}

test('Mesa: la ruta transmite el turno del modelo del agente que habla', async () => {
  let request;
  const handle = route({ mock: false, llm: async (r) => { request = r; r.onDelta('Hola '); r.onDelta('mesa'); return { text: 'Hola mesa', usage: { cost: 0.002 } }; } });
  const res = await post(handle, body({ seat: 'C' }));
  assert.equal(res.status, 200); assert.equal(request.model, 'model/c');
  const events = res.events();
  assert.deepEqual(events.filter((e) => e.type === 'delta').map((e) => e.text), ['Hola ', 'mesa']);
  assert.equal(events.at(-1).type, 'done'); assert.equal(events.at(-1).text, 'Hola mesa'); assert.equal(events.at(-1).usage.cost, 0.002);

  const failing = route({ mock: false, llm: async () => { throw new Error('OpenRouter 500'); } });
  assert.equal((await post(failing, body())).events().at(-1).error, 'OpenRouter 500');
  const bad = await post(handle, body({ goal: '' }));
  assert.equal(bad.status, 400); assert.match(bad.error, /misión final/);
  assert.equal(handle({ method: 'GET' }, fakeRes(), new URL('http://x/api/lab/table/turn')), false);
});

test('Mesa: el modo demo responde, pasa y da por resuelta la misión', async () => {
  const handle = route({ mock: true });
  const pass = (await post(handle, body({ seat: 'D', round: 2 }))).events().at(-1);
  assert.equal(parseReply(pass.text).action, 'pass');
  const done = (await post(handle, body({ seat: 'A', round: 3 }))).events().at(-1);
  assert.equal(parseReply(done.text).done, true);
  const final = (await post(handle, body({ kind: 'synthesis', reason: 'rounds' }))).events().at(-1);
  assert.match(final.text, /Entrega final/);
});
