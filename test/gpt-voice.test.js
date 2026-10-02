import test from 'node:test';
import assert from 'node:assert/strict';
import { createGptVoice } from '../public/gpt-voice.js';

const tick = () => new Promise(setImmediate);
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
async function browserFixture(run) {
  const originals = new Map(['window', 'document', 'navigator', 'fetch'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const sources = [], calls = [], errors = [], streams = [], contexts = [];
  class AudioContext {
    constructor() { this.state = 'running'; this.currentTime = 0; this.sampleRate = 24000; this.destination = {}; contexts.push(this); }
    async resume() { this.state = 'running'; }
    async close() { this.state = 'closed'; }
    createBuffer(channels, count, rate) { return { duration: count / rate, copyToChannel() {} }; }
    createBufferSource() {
      const source = { stopped: false, connect() {}, disconnect() {}, start() { sources.push(source); }, stop() { source.stopped = true; } };
      return source;
    }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createScriptProcessor() { return { connect() {}, disconnect() {} }; }
    createGain() { return { gain: {}, connect() {}, disconnect() {} }; }
  }
  let available = true, mic = false, getMic = async () => { const track = { stopped: false, stop() { this.stopped = true; } }; const stream = { getTracks: () => [track] }; streams.push(stream); return stream; };
  const response = () => new Response(['voice_start', 'voice_audio', 'voice_transcript', 'voice_done'].map((type) => JSON.stringify({ type, turnId: 'turn1', data: 'AAAAAA==', text: type === 'voice_transcript' ? 'Hola.' : undefined })).join('\n') + '\n');
  let fetcher = async (url) => url === '/api/voice/turn' ? response() : new Response('{}');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { AudioContext, addEventListener() {} } });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { hidden: false } });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia: (...args) => getMic(...args) } } });
  globalThis.fetch = async (url, opts) => { calls.push({ url, body: opts?.body && JSON.parse(opts.body), signal: opts?.signal }); return fetcher(url, opts); };
  const controller = createGptVoice({ context: () => ({ kind: 'raw', id: 'project-123' }), enabled: () => available, mic: () => mic, inputAllowed: () => true,
    phase() {}, user: () => ({}), reply: () => ({}), event() {}, error: (e) => errors.push(e), refresh: async () => {},
  });
  try { await run({ controller, sources, calls, errors, streams, contexts, setEnabled: (v) => { available = v; }, setMic: (v) => { mic = v; }, setGetMic: (f) => { getMic = f; }, setFetch: (f) => { fetcher = f; } }); }
  finally {
    controller.stop();
    for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
  }
}
test('historial sólo confirma la voz cuando terminó la reproducción, no al terminar HTTP', () => browserFixture(async ({ controller, calls, sources }) => {
  const sent = controller.send({ text: 'hola' });
  for (let i = 0; i < 20 && !sources.length; i++) await tick();
  await tick();
  assert.equal(calls.filter((c) => c.url === '/api/voice/played').length, 0);
  assert.equal(controller.busy(), true);
  sources.forEach((source) => source.onended());
  await sent;
  assert.equal(calls.find((c) => c.url === '/api/voice/played').body.played, true);
  assert.equal(controller.busy(), false);
}));
test('cambiar de modo detiene el audio pendiente y registra interrupción', () => browserFixture(async ({ controller, calls, sources, contexts, setEnabled }) => {
  const sent = controller.send({ text: 'hola' });
  for (let i = 0; i < 20 && !sources.length; i++) await tick();
  await tick(); setEnabled(false); controller.stop(); await sent;
  assert.ok(sources.every((source) => source.stopped));
  assert.equal(contexts[0].state, 'closed');
  assert.equal(calls.find((c) => c.url === '/api/voice/played').body.played, false);
  assert.equal(controller.busy(), false);
}));
test('permisos de micrófono tardíos liberan las pistas después de cambiar de modo', () => browserFixture(async ({ controller, setEnabled, setMic, setGetMic }) => {
  const permission = deferred(); let stopped = false;
  setMic(true); setGetMic(() => permission.promise);
  const opening = controller.resume(); await tick();
  setEnabled(false); controller.stop();
  permission.resolve({ getTracks: () => [{ stop() { stopped = true; } }] });
  await opening;
  assert.equal(stopped, true);
}));
test('una respuesta que llega después de cancelar no se reproduce ni confirma', () => browserFixture(async ({ controller, sources, calls, setFetch, setEnabled }) => {
  const late = deferred();
  setFetch((url) => url === '/api/voice/turn' ? late.promise : new Response('{}'));
  const sent = controller.send({ text: 'hola' }); await tick();
  setEnabled(false); controller.stop();
  late.resolve(new Response('{"type":"voice_audio","data":"AAAAAA=="}\n{"type":"voice_done","turnId":"late"}\n'));
  await sent;
  assert.equal(sources.length, 0); assert.equal(calls.filter((c) => c.url === '/api/voice/played').length, 0);
}));
