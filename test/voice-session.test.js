import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createVoiceSessions, parseVoiceBody } from '../src/voice-session.js';
import { wavBase64 } from '../public/voice-audio.js';

const input = (extra = {}) => parseVoiceBody({ kind: 'raw', id: 'project-123', text: 'hola', ...extra });
const tool = (name, args, id = name) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
function speak(opts, text = 'Hola.') { opts.onTranscript(text); opts.onAudio('AAAAAA=='); return { toolCalls: [], content: '', transcript: text }; }
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
async function fixture(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'voice-test-'));
  const histories = new Map();
  const idOf = ({ kind, id }) => `${kind}-${id}`;
  const options = { dir, context: async (i) => ({ info: { kind: i.kind, id: i.id }, history: histories.get(idOf(i)) || [] }),
    remember: async (i, entry) => { const h = histories.get(idOf(i)) || []; h.push(entry); histories.set(idOf(i), h); },
    work: async () => 'Resultado real del especialista.', chat: async (opts) => speak(opts),
  };
  try { await fn(options, histories); } finally { await rm(dir, { recursive: true, force: true }); }
}
test('recibe audio nativo, registra al usuario y sólo confirma la respuesta tras reproducirse', () => fixture(async (options, history) => {
  let n = 0;
  const data = wavBase64([new Float32Array(1000)], 24000);
  const service = createVoiceSessions({ ...options, chat: async (opts) => {
    assert.equal(opts.messages.at(2).content[0].type, 'input_audio');
    if (n++ === 0) return { toolCalls: [tool('record_user', { text: 'Quiero un retrato.' })], content: '' };
    assert.equal(opts.messages.at(-1).role, 'tool'); return speak(opts, 'Contame el estilo.');
  } });
  const events = [], i = input({ text: undefined, audio: { data, format: 'wav' } });
  await service.turn(i, (ev) => events.push(ev), new AbortController().signal);
  assert.deepEqual(history.get('raw-project-123').map((h) => h.text), ['Quiero un retrato.']);
  await service.played(i, events.at(-1).turnId, true);
  assert.deepEqual(history.get('raw-project-123').map((h) => h.text), ['Quiero un retrato.', 'Contame el estilo.']);
  await service.played(i, events.at(-1).turnId, true);
  assert.equal(history.get('raw-project-123').length, 2);
}));
test('interrupción conserva el turno del usuario sin asumir que oyó una respuesta completa', () => fixture(async (options, history) => {
  const messages = [];
  const service = createVoiceSessions({ ...options, chat: async (opts) => { messages.push(structuredClone(opts.messages)); return speak(opts, 'Una respuesta que no se oyó.'); } });
  const events = [];
  await service.turn(input(), (ev) => events.push(ev), new AbortController().signal);
  await service.played(input(), events.at(-1).turnId, false);
  await service.turn(input({ text: 'Repetilo.' }), () => {}, new AbortController().signal);
  const h = history.get('raw-project-123');
  assert.equal(h[1].interrupted, true); assert.ok(!h[1].text.includes('Una respuesta'));
  assert.equal(messages[1].filter((m) => m.content === 'Repetilo.').length, 1);
  await service.turn(input({ id: 'different-123' }), () => {}, new AbortController().signal);
  assert.equal(messages[2].length, 3); // no history from the other project
}));
test('trabajo visual sobrevive al corte de audio, no se duplica por dos tool calls y notifica su resultado', () => fixture(async (options) => {
  const started = deferred(), finish = deferred(), spoken = deferred(); let jobs = 0, calls = 0;
  const service = createVoiceSessions({ ...options, work: async (i, emit, signal) => {
    jobs++; assert.equal(i.id, 'project-123'); started.resolve(signal); await finish.promise;
    assert.equal(signal.aborted, false); emit({ type: 'raw_generated', id: 'gen1', asset: { code: 'G1' } }); return 'La imagen G1 quedó lista.';
  }, chat: async (opts) => {
    if (calls++ === 0) return { content: '', toolCalls: [tool('work_on_project', { request: 'Generá un retrato.', id: 'other-project' }, 'one'), tool('work_on_project', { request: 'otra' }, 'two')] };
    spoken.resolve(); await new Promise((resolve, reject) => opts.signal.addEventListener('abort', () => reject(opts.signal.reason), { once: true }));
  } });
  const controller = new AbortController(), events = [];
  const turn = service.turn(input(), (ev) => events.push(ev), controller.signal);
  const signal = await started.promise; await spoken.promise; controller.abort(); await assert.rejects(turn);
  assert.equal(signal.aborted, false); assert.equal(jobs, 1); finish.resolve();
  let job;
  for (let j = 0; j < 100; j++) {
    [job] = await service.jobs(input());
    const saved = JSON.parse(await readFile(path.join(options.dir, 'raw-project-123.json')));
    if (job.status === 'done' && saved.jobs[0].status === 'done') break;
    await new Promise(setImmediate);
  }
  assert.equal(job.status, 'done'); assert.equal(job.events[0].asset.code, 'G1');
  assert.equal(events.filter((e) => e.type === 'voice_job')[0].jobId, job.id);
  const announce = createVoiceSessions({ ...options, chat: async (opts) => { assert.equal(opts.tools, undefined); assert.match(opts.messages.at(-1).content, /G1/); return speak(opts, 'Ya está la imagen.'); } });
  const notification = input({ text: undefined, notification: job.id }), notificationEvents = [];
  await announce.turn(notification, (e) => notificationEvents.push(e), new AbortController().signal);
  assert.equal((await announce.jobs(input()))[0].notified, false);
  await announce.played(notification, notificationEvents.at(-1).turnId, true);
  assert.equal((await announce.jobs(input()))[0].notified, true);
  await assert.rejects(announce.turn(notification, () => {}, new AbortController().signal), /ya fue anunciado/);
}));
test('un reinicio marca trabajos incompletos sin volver a ejecutar ni pagar', () => fixture(async (options) => {
  await writeFile(path.join(options.dir, 'raw-project-123.json'), JSON.stringify({ jobs: [{ id: 'job1', status: 'running', events: [] }], pending: null }));
  const service = createVoiceSessions({ ...options, work: () => { throw new Error('No debe ejecutarse'); } });
  assert.equal((await service.jobs(input()))[0].status, 'error');
  assert.equal(JSON.parse(await readFile(path.join(options.dir, 'raw-project-123.json'))).jobs[0].status, 'error');
}));
test('herramientas desconocidas no operan en el proyecto y ausencia de audio es un error visible', () => fixture(async (options) => {
  let count = 0;
  const service = createVoiceSessions({ ...options, work: () => { throw new Error('No debe ejecutarse'); }, chat: async (opts) => {
    if (count++ === 0) return { content: '', toolCalls: [tool('delete_project', { id: 'project-123' })] };
    assert.match(opts.messages.at(-1).content, /no permitida/); return { toolCalls: [], content: 'Sólo texto' };
  } });
  await assert.rejects(service.turn(input(), () => {}, new AbortController().signal), /no devolvió voz/);
}));

test('GPT Audio confirma el modal por herramienta con la transcripción real y el id visible', () => fixture(async (options) => {
  const decisions = [], events = []; let round = 0;
  const service = createVoiceSessions({ ...options,
    decide: async (i, d) => { decisions.push({ i, d }); return { id: i.proposalId, status: 'generating' }; },
    chat: async (opts) => {
      assert.ok(opts.tools.some((t) => t.function.name === 'decide_image'));
      if (round++ === 0) return { content: '', toolCalls: [tool('record_user', { text: 'Sí, dale, generá.' }), tool('decide_image', { proposal_id: 'proposal-123', action: 'approve' })] };
      return speak(opts, 'Perfecto, estoy generando la imagen.');
    },
  });
  await service.turn(input({ text: undefined, audio: { format: 'wav', data: wavBase64([new Float32Array(1000)], 24000) }, proposalId: 'proposal-123', viewerId: 'viewer-123' }), (e) => events.push(e), new AbortController().signal);
  assert.equal(decisions.length, 1); assert.equal(decisions[0].d.text, 'Sí, dale, generá.');
  assert.equal(decisions[0].i.viewerId, 'viewer-123');
  assert.ok(events.some((e) => e.type === 'raw_proposal_decision'));
}));

test('GPT Audio no puede aprobar otra revisión ni aprobar a partir de un resultado automático', () => fixture(async (options) => {
  let decisions = 0, round = 0;
  const service = createVoiceSessions({ ...options, decide: async () => { decisions++; }, chat: async (opts) => {
    if (round++ === 0) return { content: '', toolCalls: [tool('decide_image', { proposal_id: 'old-proposal', action: 'approve' })] };
    assert.match(opts.messages.at(-1).content, /propuesta actual/); return speak(opts, 'Revisá el modal actual.');
  } });
  await service.turn(input({ proposalId: 'current-proposal', viewerId: 'viewer-123' }), () => {}, new AbortController().signal);
  assert.equal(decisions, 0);
  await service.publish(input(), 'Nuevo plan listo para revisar.');
  const job = (await service.jobs(input())).at(-1); round = 0;
  await service.turn(input({ text: undefined, notification: job.id, proposalId: 'current-proposal' }), () => {}, new AbortController().signal);
  assert.equal(decisions, 0);
}));
