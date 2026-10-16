import test from 'node:test';
import assert from 'node:assert/strict';
import { createLabTools, toolDefs, TOOL_COSTS, MAX_SEARCHES, SEARCH_GUIDANCE } from '../src/lab/tools.js';
import { labSystem } from '../src/lab/harness.js';
import { parseVariant, contextConfig } from '../src/lab/context.js';
import { parseLabBody, runLabAgent, MAX_TOOL_ROUNDS } from '../src/lab/pipeline.js';

const IMG = 'data:image/jpeg;base64,/9j/AA==';
const call = (query, id = query) => ({ id, function: { name: 'buscar_referencias', arguments: JSON.stringify({ consulta: query }) } });
const context = (events, signal, limits) => ({
  signal, limits, emit: (e) => events.push(e), registry: new Map(),
  state: { searches: 0, searchSeq: 0, toolCost: 0 },
});
// Exercise the actual deadline signal without waiting 20 seconds or using the network.
function shortDeadline(t) {
  const original = AbortSignal.timeout;
  t.mock.method(AbortSignal, 'timeout', (ms) => {
    assert.equal(ms, 20000);
    return original(5);
  });
}
function untilAbort(signal) {
  return new Promise((resolve, reject) => {
    const guard = setTimeout(() => reject(new Error('deadline did not abort the request')), 1000);
    const stop = () => { clearTimeout(guard); reject(signal.reason); };
    if (signal.aborted) stop();
    else signal.addEventListener('abort', stop, { once: true });
  });
}

for (const stage of ['headers', 'body']) {
  test(`el timeout de búsqueda en ${stage} vuelve como error recuperable con costo y cupo`, async (t) => {
    shortDeadline(t);
    const events = [];
    const parent = new AbortController();
    const ctx = context(events, parent.signal, { searches: 2 });
    const tools = createLabTools({ serpKey: 'fake', fetchImpl: async (_url, { signal }) => {
      if (stage === 'headers') return untilAbort(signal);
      return { ok: true, json: () => untilAbort(signal) };
    } });
    const out = await tools.run(call('Pixar desk lamp'), ctx);
    assert.match(out.text, /^Error de la búsqueda:.*20 s/);
    assert.match(out.text, /Búsquedas restantes: 1/);
    assert.equal(parent.signal.aborted, false);
    assert.equal(ctx.state.searches, 1);
    assert.equal(ctx.state.toolCost, TOOL_COSTS.search);
    assert.deepEqual(events.map((e) => e.type), ['tool', 'tool_done']);
    const done = events.at(-1);
    assert.equal(done.ok, false);
    assert.equal(done.cost, TOOL_COSTS.search);
    assert.ok(done.ms > 0);
    assert.equal(done.error, out.text);
  });
}

for (const stage of ['headers', 'body', 'thumbnail']) {
  test(`la cancelación manual en ${stage} sigue siendo fatal`, async () => {
    const events = [];
    const parent = new AbortController();
    const reason = new Error('usuario detuvo la ejecución');
    const cancel = () => { parent.abort(reason); throw reason; };
    const tools = createLabTools({ serpKey: 'fake', fetchImpl: async (url) => {
      if (stage === 'headers') return cancel();
      if (stage === 'body') return { ok: true, json: async () => cancel() };
      if (url.includes('serpapi.com')) return Response.json({ images_results: [{ thumbnail: 'https://example.invalid/thumb' }] });
      return cancel();
    } });
    await assert.rejects(tools.run(call('lamp'), context(events, parent.signal)), (err) => err === reason);
    assert.equal(events.at(-1).ok, false);
    assert.equal(events.some((e) => e.type === 'search'), false);
  });
}

test('una ejecución ya cancelada no inicia la búsqueda y los errores ajenos al timeout se propagan', async () => {
  const parent = new AbortController();
  parent.abort(new Error('detenido'));
  let requests = 0;
  const fatal = new TypeError('fallo no clasificado');
  const tools = createLabTools({ serpKey: 'fake', fetchImpl: async () => { requests++; throw fatal; } });
  const ctx = context([], parent.signal);
  await assert.rejects(tools.run(call('lamp'), ctx), /detenido/);
  assert.equal(requests, 0);
  assert.equal(ctx.state.searches, 0);
  await assert.rejects(tools.run(call('lamp'), context([])), (err) => err === fatal);
});

test('el timeout no oculta una cancelación manual simultánea', async () => {
  const parent = new AbortController();
  const tools = createLabTools({ serpKey: 'fake', fetchImpl: async () => {
    parent.abort();
    throw new DOMException('timeout', 'TimeoutError');
  } });
  await assert.rejects(tools.run(call('lamp'), context([], parent.signal)), { name: 'TimeoutError' });
});

test('tras un timeout se puede cambiar la consulta con el cupo restante, sin reintentos ocultos', async () => {
  const events = [];
  const ctx = context(events, undefined, { searches: 2 });
  const requests = [];
  const tools = createLabTools({ serpKey: 'fake', fetchImpl: async (url) => {
    if (!url.includes('serpapi.com')) return new Response(new Uint8Array([255, 216, 255]), { headers: { 'content-type': 'image/jpeg' } });
    const query = new URL(url).searchParams.get('q');
    requests.push(query);
    if (query === 'complex query') throw new DOMException('timeout', 'TimeoutError');
    return Response.json({ images_results: [{ title: 'lamp', thumbnail: 'https://example.invalid/thumb' }] });
  } });
  assert.match((await tools.run(call('complex query'), ctx)).text, /Búsquedas restantes: 1/);
  assert.deepEqual(requests, ['complex query']);
  assert.match((await tools.run(call('lamp'), ctx)).text, /^Búsqueda "lamp": 1 imágenes/);
  assert.match((await tools.run(call('extra'), ctx)).text, /ya hiciste 2 búsquedas/);
  assert.deepEqual(requests, ['complex query', 'lamp']);
  assert.equal(ctx.state.searches, 2);
  assert.equal(ctx.state.toolCost, 2 * TOOL_COSTS.search);
  assert.deepEqual(events.filter((e) => e.type === 'tool_done').map((e) => [e.ok, e.cost]), [
    [false, TOOL_COSTS.search], [true, TOOL_COSTS.search], [false, 0],
  ]);
});

test('el agente recibe el timeout, conserva las referencias y termina respetando búsquedas, rondas y métricas', async () => {
  const events = [];
  const requests = [];
  let llmCalls = 0;
  const input = parseLabBody({
    model: 'diagnostic/fake', engine: 'canvas', brief: { refs: [] },
    video: { name: 'test.mp4', duration: 10, width: 1280, height: 720 },
    clips: [{ id: 'C1', start: 1, end: 4, prompt: 'test', frames: [{ t: 2, url: IMG }], refs: [] }],
  });
  const searchTools = createLabTools({ serpKey: 'fake', fetchImpl: async (url) => {
    if (url.includes('serpapi.com')) {
      const q = new URL(url).searchParams.get('q');
      requests.push(q);
      if (q === 'lamp') throw new DOMException('timeout', 'TimeoutError');
      return Response.json({ images_results: [{ title: q, thumbnail: 'https://example.invalid/thumb' }] });
    }
    return new Response(new Uint8Array([255, 216, 255]), { headers: { 'content-type': 'image/jpeg' } });
  } });
  const imageTools = createLabTools({ mock: true });
  const tools = {
    available: { search: true, images: true },
    run: (call, ctx) => call.function.name === 'generar_imagen' ? imageTools.run(call, ctx) : searchTools.run(call, ctx),
  };
  await runLabAgent({ input, tools, emit: (e) => events.push(e), llm: async (opts) => {
    llmCalls++;
    if (llmCalls === 1) return { usage: { cost: 0.1, total_tokens: 10 }, toolCalls: [call('typography'), call('assembly'), call('lamp')] };
    assert.ok(opts.messages.some((m) => m.role === 'tool' && /tiempo de espera/.test(m.content)));
    assert.ok(opts.messages.some((m) => m.role === 'user' && Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url')));
    if (llmCalls === 2) return { toolCalls: [{ id: 'image', function: { name: 'generar_imagen', arguments: JSON.stringify({ prompt: 'brick lamp' }) } }] };
    if (opts.tools) return { toolCalls: [call('another query', `limit-${llmCalls}`)] };
    assert.equal(llmCalls, MAX_TOOL_ROUNDS + 1);
    assert.ok(opts.messages.some((m) => m.role === 'tool' && /ya hiciste 3 búsquedas/.test(m.content)));
    return { text: '```js\nconst SCENES = [{ from: 1, to: 4, draw(t, p) { g.drawImage(images.gen1, 0, 0); } }];\n```' };
  } });
  assert.deepEqual(requests, ['typography', 'assembly', 'lamp']);
  const timeout = events.find((e) => e.type === 'tool_done' && e.id === 'lamp');
  assert.equal(timeout.ok, false);
  assert.equal(timeout.cost, TOOL_COSTS.search);
  const done = events.find((e) => e.type === 'done');
  assert.ok(events.some((e) => e.type === 'result'));
  assert.equal(done.searches, MAX_SEARCHES);
  assert.equal(done.toolRounds, MAX_TOOL_ROUNDS);
  assert.equal(done.calls, MAX_TOOL_ROUNDS + 1);
  assert.equal(done.images, 1);
  assert.ok(events.some((e) => e.type === 'asset'));
  const imageCost = events.find((e) => e.type === 'tool_done' && e.id === 'image').cost;
  assert.ok(Math.abs(done.toolCost - (MAX_SEARCHES * TOOL_COSTS.search + imageCost)) < 1e-9);
  assert.equal(done.cost, 0.1 + done.toolCost);
  assert.equal(done.tokens, 10);
  assert.equal(events.some((e) => e.type === 'error'), false);
});

test('la guía compartida llega al sistema de ambos motores y a la definición real de la herramienta', () => {
  const definition = toolDefs({ search: true })[0].function;
  assert.ok(definition.description.includes(SEARCH_GUIDANCE));
  assert.match(definition.parameters.properties.consulta.description, /one visual need/);
  for (const engine of ['canvas', 'remotion']) {
    const motion = labSystem({ search: true, images: true }, engine);
    const variant = parseVariant({ engine, policy: { search: 'required' } });
    const context = contextConfig(variant, { search: true }).system;
    for (const prompt of [motion, context]) {
      assert.ok(prompt.includes(SEARCH_GUIDANCE));
      assert.doesNotMatch(prompt, /at least 2 searches|ALWAYS run at least 2/);
    }
  }
});
