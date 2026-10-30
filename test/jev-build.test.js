import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseStep, mergePatches, expandPiece, applyPiece, describeScene, parseIdeas, parseBlueprint, combos, parseRelPatch, parseRelBlueprint, resolveObject, checkScene, placeObject } from '../public/jev-build/spec.js';
import { createJevBuildRoutes, extractJson, parseChooseBody, groupPicks, hedged, parseModel, LLM_MODEL, mustReason, parseFixes, createModalities, parseSketch, MAX_IMAGES_PER_CALL } from '../src/jev-build/routes.js';
import { mockPlan, mockIdeas, mockBlueprint, mockRelBlueprint } from '../src/jev-build/mock.js';
import { choiceQuestion, REL_BLUEPRINT_SYSTEM } from '../src/jev-build/prompts.js';

const STEP = {
  thought: 'Primero el tronco.',
  object: { id: 'Pino', label: 'un pino' },
  part: { id: 'Tronco', label: 'el tronco' },
  base: { color: '#7a4a28', objectPosition: [-2, 0, 0] },
  questions: [
    { key: 'forma', question: '¿Cómo harías el tronco?', options: [
      { label: 'cilindro', patch: { primitive: 'cylinder', size: [0.4, 3, 0.4], position: [0, 1.5, 0] } },
      { label: 'caja', patch: { primitive: 'box', size: [0.4, 3, 0.4], position: [0, 1.5, 0] } },
    ] },
    { key: 'grosor', question: '¿Qué tan grueso?', options: [
      { label: 'fino', patch: { size: [0.2, 3, 0.2] } },
      { label: 'grueso', patch: { size: [0.6, 3, 0.6] } },
    ] },
  ],
};

test('parseStep valida y normaliza un paso del LLM', () => {
  const s = parseStep(STEP);
  assert.equal(s.object.id, 'pino');
  assert.equal(s.part.id, 'tronco');
  assert.equal(s.questions.length, 2);
  assert.deepEqual(s.questions[1].options[1].patch.size, [0.6, 3, 0.6]);
  assert.equal(parseStep({ done: true, summary: 'listo' }).done, true);
});

test('parseStep rechaza pasos incompletos o con valores inválidos', () => {
  assert.throws(() => parseStep({ ...STEP, questions: [] }), /questions/);
  assert.throws(() => parseStep({ ...STEP, questions: [{ question: 'x', options: [{ label: 'a', patch: {} }] }] }), /opciones/);
  const noPosition = structuredClone(STEP);
  noPosition.questions[0].options.forEach((o) => delete o.patch.position);
  assert.throws(() => parseStep(noPosition), /position/);
  const bad = structuredClone(STEP);
  bad.questions[0].options[0].patch.primitive = 'dodecaedro';
  assert.throws(() => parseStep(bad), /Primitiva/);
  bad.questions[0].options[0].patch = { primitive: 'box', size: [1, 'x', 1], position: [0, 0, 0] };
  assert.throws(() => parseStep(bad), /size/);
});

test('mergePatches suma en orden y expandPiece es determinista', () => {
  const s = parseStep(STEP);
  const spec = mergePatches(s.base, s.questions[0].options[0].patch, s.questions[1].options[1].patch);
  assert.equal(spec.primitive, 'cylinder');
  assert.deepEqual(spec.size, [0.6, 3, 0.6]);
  const cluster = { primitive: 'sphere', size: [0.5, 0.5, 0.5], position: [0, 3, 0], repeat: { pattern: 'cluster', count: 10, spread: [1, 0.5, 1], jitter: 0.3 } };
  const a = expandPiece(cluster, 'arbol/hojas'), b = expandPiece(cluster, 'arbol/hojas');
  assert.equal(a.length, 10);
  assert.deepEqual(a, b);
  for (const n of a) assert.ok(Math.abs(n.position[0]) <= 1 && Math.abs(n.position[1] - 3) <= 0.5);
  const ring = expandPiece({ ...cluster, repeat: { pattern: 'ring', count: 4, spread: [1, 0, 1], jitter: 0 } });
  assert.deepEqual(ring.map((n) => n.rotation[1]), [0, -90, -180, -270]);
  assert.ok(Math.abs(ring[1].position[2] - 1) < 1e-9);
});

test('applyPiece agrega, reemplaza la misma pieza y describe la escena', () => {
  const s = parseStep(STEP);
  const spec = mergePatches(s.base, s.questions[0].options[0].patch);
  let scene = applyPiece({ objects: {}, parts: [] }, { object: s.object, part: s.part, spec });
  assert.deepEqual(scene.objects.pino.position, [-2, 0, 0]);
  assert.equal(scene.parts.length, 1);
  assert.equal(scene.parts[0].spec.objectPosition, undefined);
  scene = applyPiece(scene, { object: s.object, part: s.part, spec: { ...spec, primitive: 'box' } });
  assert.equal(scene.parts.length, 1);
  assert.equal(scene.parts[0].nodes[0].primitive, 'box');
  assert.match(describeScene(scene), /"tronco".*box/);
});

test('el planificador de demo arma un árbol y una persona hasta terminar', async () => {
  let scene = { objects: {}, parts: [] };
  const seen = [];
  for (let i = 0; i < 20; i++) {
    const step = parseStep(await mockPlan({ prompt: 'un árbol con flores a la izquierda y una persona', scene }));
    if (step.done) break;
    let spec = { ...step.base };
    for (const q of step.questions) spec = mergePatches(spec, q.options[0].patch);
    scene = applyPiece(scene, { object: step.object, part: step.part, spec });
    seen.push(`${step.object.id}/${step.part.id}`);
  }
  assert.deepEqual(seen, ['arbol/tronco', 'arbol/ramas', 'arbol/hojas', 'arbol/flores', 'persona/piernas', 'persona/torso', 'persona/cuello', 'persona/cabeza', 'persona/brazos']);
  assert.ok(scene.objects.arbol.position[0] < 0);
});

test('extractJson y choiceQuestion', () => {
  assert.deepEqual(extractJson('Acá va:\n```json\n{"done": true}\n```'), { done: true });
  assert.throws(() => extractJson('sin json'), /JSON/);
  const q = choiceQuestion({ question: '¿Cuál?', options: ['uno', 'dos'], withImages: true });
  assert.equal(q.type, 'choice');
  assert.deepEqual(Object.keys(q.criteria), ['A', 'B']);
  assert.match(q.criteria.B, /`opcion_B`/);
  assert.throws(() => parseChooseBody({ prompt: 'x', object: 'o', part: 'p', question: 'q', options: ['a', 'b'], images: ['data:image/png;base64,AA'] }), /una por opción/);
});

function harness(opts) {
  const sent = [];
  const handle = createJevBuildRoutes({
    mock: false,
    apiKey: 'k',
    readBody: async (req) => req.body,
    sendJson: (res, status, body) => { sent.push({ status, body }); res.writableFinished = true; },
    badRequest: (res, msg) => sent.push({ status: 400, body: { error: msg } }),
    ...opts,
  });
  const call = async (path, body) => {
    const res = { on() {}, writableFinished: false };
    handle({ method: 'POST', body }, res, new URL(`http://x/api/lab/jev-build/${path}`));
    for (let i = 0; i < 50 && !sent.length; i++) await new Promise((r) => setTimeout(r, 5));
    return sent.pop();
  };
  return call;
}

test('plan: reintenta si el LLM devuelve algo inválido y pasa lo que ve JEV', async () => {
  const calls = [];
  const replies = ['no es json', JSON.stringify(STEP)];
  const call = harness({
    llm: async ({ messages }) => { calls.push(messages[1].content); return { text: replies.shift(), usage: {} }; },
    decideImpl: async () => ({ answers: { visto: { type: 'noul', noul: 0.42 } } }),
  });
  const scene = { objects: { pino: { id: 'pino', label: 'un pino', position: [0, 0, 0] } }, parts: [{ object: 'pino', id: 'base', label: 'base', spec: { primitive: 'box', size: [1, 1, 1], position: [0, 0.5, 0] } }] };
  const out = await call('plan', { prompt: 'un pino', scene, history: [], render: 'data:image/jpeg;base64,AA' });
  assert.equal(out.status, 200);
  assert.equal(out.body.step.part.id, 'tronco');
  assert.equal(out.body.verify.noul, 0.42);
  assert.equal(calls.length, 2);
  assert.match(calls[0], /se ve "un pino"\? sí 42%/);
  assert.match(calls[1], /NO SE PUDO USAR/);
});

test('choose: manda las imágenes como opcion_A… y devuelve la elegida', async () => {
  let seen;
  const call = harness({
    llm: async () => ({ text: '{}' }),
    decideImpl: async ({ state, questions }) => { seen = { state, questions }; return { model: 'jev', answers: { opcion: { type: 'choice', choice: 'B', confidence: 0.7, probabilities: { A: 0.3, B: 0.7 } } } }; },
  });
  const img = 'data:image/jpeg;base64,AA';
  const out = await call('choose', { prompt: 'un pino', object: 'un pino', part: 'el tronco', question: '¿Cómo?', options: ['cilindro', 'caja'], images: [img, img], chosen: [] });
  assert.equal(out.status, 200);
  assert.equal(out.body.choice, 'caja');
  assert.equal(out.body.index, 1);
  assert.deepEqual(out.body.probabilities, { cilindro: 0.3, caja: 0.7 });
  assert.equal(seen.state.opcion_A, img);
  assert.match(seen.questions.opcion.instructions, /Mirá cómo queda/);
});

// ---------- Fase 2 · time reducing ----------

test('parseIdeas valida objetos, ubicación y conceptos', () => {
  const ideas = parseIdeas({ objects: [{ id: 'Pino Alto', label: 'un pino', position: [-3, 0, 0], concepts: ['conos apilados', { label: 'un cono' }] }] });
  assert.equal(ideas.objects[0].id, 'pino-alto');
  assert.deepEqual(ideas.objects[0].concepts, ['conos apilados', 'un cono']);
  assert.equal(parseIdeas({ done: true }).done, true);
  assert.throws(() => parseIdeas({ objects: [{ id: 'a', concepts: ['uno'] }] }), /conceptos/);
  assert.throws(() => parseIdeas({ objects: [{ id: 'a', concepts: ['x', 'y'] }, { id: 'a', concepts: ['x', 'y'] }] }), /repetido/);
});

test('parseBlueprint acepta piezas fijas y limita las preguntas; combos arma el producto', () => {
  const bp = parseBlueprint({ pieces: [
    { part: { id: 'tronco' }, base: { primitive: 'cylinder', size: [0.3, 2, 0.3], position: [0, 1, 0] } },
    { part: { id: 'copa' }, base: { primitive: 'cone', position: [0, 3, 0] }, questions: [
      { question: '¿Proporción?', options: [{ label: 'alta', patch: { size: [1, 3, 1] } }, { label: 'ancha', patch: { size: [2, 2, 2] } }] },
      { question: '¿Color?', options: [{ label: 'oscuro', patch: { color: '#1f4d2b' } }, { label: 'claro', patch: { color: '#62b14f' } }, { label: 'azulado', patch: { color: '#2f5d5a' } }] },
    ] },
  ] });
  assert.equal(combos(bp.pieces[0]).length, 1);
  const cs = combos(bp.pieces[1]);
  assert.equal(cs.length, 6);
  assert.equal(cs[5].label, 'ancha + azulado');
  assert.deepEqual(cs[5].patch, { primitive: 'cone', position: [0, 3, 0], size: [2, 2, 2], color: '#2f5d5a' });
  const four = { question: 'q', options: [1, 2, 3, 4].map((n) => ({ label: `o${n}`, patch: {} })) };
  assert.throws(() => parseBlueprint({ pieces: [{ part: { id: 'x' }, base: { primitive: 'box', size: 1, position: [0, 0, 0] }, questions: [four] }] }), /2 a 3 opciones/);
  assert.throws(() => parseBlueprint({ pieces: [{ part: { id: 'x' }, base: { primitive: 'box', size: 1 } }] }), /position.*pieza 1/);
});

test('demo de la fase 2: ideas para cada objeto y planos válidos', async () => {
  const ideas = parseIdeas(await mockIdeas({ prompt: 'un árbol con flores y una persona', scene: {} }));
  assert.deepEqual(ideas.objects.map((o) => o.id), ['arbol', 'persona']);
  for (const o of ideas.objects) {
    const bp = parseBlueprint(await mockBlueprint({ prompt: 'flores', object: o, concept: o.concepts[0] }));
    assert.ok(bp.pieces.length >= 4);
    assert.ok(bp.pieces.some((p) => p.questions.length === 0), 'hay piezas fijas');
  }
  assert.equal(parseIdeas(await mockIdeas({ prompt: 'un árbol', scene: { objects: { arbol: {} } } })).done, true);
});

test('groupPicks reparte por imágenes y saltea las de una sola opción', () => {
  const img = 'data:image/jpeg;base64,AA';
  const pick = (key, n) => ({ key, options: Array.from({ length: n }, (_, i) => `o${i}`), images: Array(n).fill(img) });
  const groups = groupPicks([pick('a', 9), pick('b', 1), pick('c', 9), pick('d', 9), pick('e', 9), pick('f', 9)]);
  assert.ok(groups.every((g) => g.reduce((n, p) => n + p.images.length, 0) <= MAX_IMAGES_PER_CALL));
  assert.deepEqual(groups.flat().map((p) => p.key), ['a', 'c', 'd', 'e', 'f']);
  assert.equal(groups.length, 2);
});

test('pick: varias elecciones en una llamada, imágenes por clave y verificación', async () => {
  const seen = [];
  const call = harness({
    llm: async () => ({ text: '{}' }),
    decideImpl: async ({ state, questions }) => {
      seen.push({ state, questions });
      return { answers: { c0: { choice: 'B', confidence: 0.8, probabilities: { A: 0.2, B: 0.8 } }, p0_1: { choice: 'A', probabilities: { A: 0.6, B: 0.4 } }, visto: { noul: 0.9 } } };
    },
  });
  const img = 'data:image/jpeg;base64,AA';
  const out = await call('pick', { prompt: 'un pino', sceneText: 'vacía', render: img, picks: [
    { key: 'c0', context: 'Objeto: un pino.', question: '¿Qué idea?', options: ['conos', 'esferas'] },
    { key: 'p0_1', question: '¿Qué copa?', options: ['alta', 'ancha'], images: [img, img] },
    { key: 'p0_2', question: 'fija', options: ['única'] },
  ] });
  assert.equal(out.status, 200);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].state.p0_1_B, img);
  assert.equal(seen[0].state.vista, img);
  assert.deepEqual(Object.keys(seen[0].questions), ['c0', 'p0_1', 'visto']);
  assert.equal(out.body.answers.c0.choice, 'esferas');
  assert.equal(out.body.answers.p0_1.choice, 'alta');
  assert.equal(out.body.answers.p0_2.confidence, 1);
  assert.equal(out.body.verify.noul, 0.9);
});

test('ideas y blueprint: el LLM corre sin razonamiento y se reintenta si falla', async () => {
  const sent = [];
  const replies = ['nada', JSON.stringify({ objects: [{ id: 'pino', label: 'un pino', position: [-3, 0, 0], concepts: ['a', 'b'] }] }),
    JSON.stringify({ pieces: [{ part: { id: 'tronco' }, base: { primitive: 'cylinder', size: [0.3, 2, 0.3], position: [0, 1, 0] } }] })];
  const call = harness({ llm: async (opts) => { sent.push(opts); return { text: replies.shift() }; }, decideImpl: async () => ({ answers: {} }) });
  const ideas = await call('ideas', { prompt: 'un pino', scene: { objects: {}, parts: [] } });
  assert.equal(ideas.status, 200);
  assert.equal(ideas.body.attempts, 2);
  assert.deepEqual(sent[0].reasoning, { enabled: false });
  assert.deepEqual(sent[0].provider, { sort: 'throughput' });
  const bp = await call('blueprint', { prompt: 'un pino', object: ideas.body.ideas.objects[0], concept: 'a' });
  assert.equal(bp.status, 200);
  assert.equal(bp.body.blueprint.pieces[0].part.id, 'tronco');
  assert.match(sent[2].messages[1].content, /CONCEPTO QUE ELIGIÓ JEV: a/);
});

test('hedged: si la primera llamada se traba, gana la copia y la lenta se cancela', async () => {
  const aborted = [];
  let n = 0;
  const run = (signal) => {
    const me = n++;
    signal.addEventListener('abort', () => aborted.push(me));
    return new Promise((resolve) => setTimeout(() => resolve({ text: `llamada ${me}` }), me === 0 ? 200 : 10));
  };
  const out = await hedged(run, { delayMs: 20 });
  assert.equal(out.text, 'llamada 1');
  assert.equal(out.hedged, true);
  assert.deepEqual(aborted, [0, 1]);
  const fast = await hedged(async () => ({ text: 'rápida' }), { delayMs: 20 });
  assert.equal(fast.hedged, false);
  await assert.rejects(hedged(async () => { throw new Error('falló'); }, { delayMs: 20 }), /falló/);
});

test('el modelo de OpenRouter se elige por pedido y se valida', async () => {
  assert.equal(parseModel(''), LLM_MODEL);
  assert.equal(parseModel(' anthropic/claude-sonnet-5.5 '), 'anthropic/claude-sonnet-5.5');
  assert.equal(parseModel('meta-llama/llama-4-scout:free'), 'meta-llama/llama-4-scout:free');
  assert.throws(() => parseModel('sin barra'), /no parece un modelo/);
  assert.throws(() => parseModel('a/b c'), /no parece un modelo/);
  const used = [];
  const call = harness({
    llm: async (opts) => { used.push(opts.model); return { text: used.length === 1 ? JSON.stringify(STEP) : JSON.stringify({ objects: [{ id: 'pino', label: 'un pino', position: [0, 0, 0], concepts: ['a', 'b'] }] }) }; },
    decideImpl: async () => ({ answers: {} }),
  });
  const plan = await call('plan', { prompt: 'un pino', model: 'google/gemini-3-flash' });
  assert.equal(plan.status, 200);
  assert.equal(plan.body.model, 'google/gemini-3-flash');
  const ideas = await call('ideas', { prompt: 'un pino', model: 'openai/gpt-5-mini' });
  assert.equal(ideas.body.model, 'openai/gpt-5-mini');
  assert.deepEqual(used, ['google/gemini-3-flash', 'openai/gpt-5-mini']);
  const bad = await call('plan', { prompt: 'un pino', model: 'nada' });
  assert.equal(bad.status, 400);
});

test('modo rápido: si el modelo exige razonar, se reintenta con razonamiento bajo y se recuerda', async () => {
  const sent = [];
  const ideasJson = JSON.stringify({ objects: [{ id: 'pino', label: 'un pino', position: [0, 0, 0], concepts: ['a', 'b'] }] });
  const call = harness({
    llm: async (opts) => {
      sent.push(opts);
      if (opts.reasoning?.enabled === false) throw Object.assign(new Error('OpenRouter 400 (openai/gpt-6.1-sol): Reasoning is mandatory for this endpoint and cannot be disabled.'), { status: 400 });
      return { text: ideasJson };
    },
    decideImpl: async () => ({ answers: {} }),
  });
  mustReason.delete('openai/gpt-6.1-sol');
  const first = await call('ideas', { prompt: 'un pino', model: 'openai/gpt-6.1-sol' });
  assert.equal(first.status, 200);
  assert.deepEqual(sent.map((o) => o.reasoning), [{ enabled: false }, { effort: 'low' }]);
  assert.equal(sent[1].maxTokens, 4800);
  await call('ideas', { prompt: 'un pino', model: 'openai/gpt-6.1-sol' });
  assert.deepEqual(sent[2].reasoning, { effort: 'low' }, 'la segunda vez ya no prueba sin razonar');
  mustReason.delete('openai/gpt-6.1-sol');
});

// ---------- Fase 3 · idioma por relaciones ----------

const rel = (id, spec) => ({ part: { id, label: id }, spec: parseRelPatch(spec) });
const near = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 1e-6);

test('relaciones: apoyar encima, de acá hasta allá y espejo, sin cuentas del LLM', () => {
  const out = resolveObject([
    rel('tronco', { primitive: 'cylinder', size: [0.4, 2, 0.4], on: { piece: 'suelo', side: 'top' } }),
    rel('copa', { primitive: 'cone', size: [2, 3, 2], on: { piece: 'tronco', side: 'top' } }),
    rel('brazo', { primitive: 'cylinder', from: 'tronco.right', to: { anchor: 'tronco.right', offset: [1, 0, 0] }, thickness: 0.1, mirror: 'x' }),
    rel('pata', { primitive: 'cylinder', from: [0.5, 0, 0.5], to: [0.5, 1, 0.5], thickness: 0.1 }),
  ]);
  const by = Object.fromEntries(out.map((p) => [p.part.id, p.spec]));
  assert.deepEqual(by.tronco.position, [0, 1, 0]);
  assert.deepEqual(by.copa.position, [0, 3.5, 0], 'la copa empieza donde termina el tronco');
  assert.ok(near(by.brazo.position, [0.7, 1, 0]));
  assert.deepEqual(by.brazo.size, [0.1, 1, 0.1]);
  assert.deepEqual(by.brazo.rotation, [0, 0, -90], 'el largo (Y) queda apuntando a +X');
  assert.ok(near(by['brazo-espejo'].position, [-0.7, 1, 0]));
  assert.deepEqual(by['brazo-espejo'].rotation, [0, 0, 90]);
  assert.deepEqual(by.pata.rotation, [0, 0, 0]);
  assert.throws(() => resolveObject([rel('copa', { primitive: 'cone', size: [1, 1, 1], on: { piece: 'tronco', side: 'top' } })]), /todavía no existe/);
  assert.throws(() => parseRelPatch({ on: { piece: 'x', side: 'arriba' } }), /Cara desconocida/);
  assert.throws(() => resolveObject([rel('a', { primitive: 'cylinder', from: [0, 0, 0], to: [0, 1, 0] })]), /thickness/);
});

test('relaciones: un plano inclinado en diagonal termina exactamente en los dos puntos', () => {
  const [p] = resolveObject([rel('rama', { primitive: 'cylinder', from: [0, 1, 0], to: [1, 2, 1], thickness: 0.1 })]);
  const tip = expandPiece(p.spec)[0];
  // El extremo superior del cilindro: centro + R·(0, largo/2, 0).
  const [rx, ry, rz] = tip.rotation.map((d) => (d * Math.PI) / 180);
  const v = [0, tip.size[1] / 2, 0];
  const Rz = [v[0] * Math.cos(rz) - v[1] * Math.sin(rz), v[0] * Math.sin(rz) + v[1] * Math.cos(rz), v[2]];
  const Ry = [Rz[0] * Math.cos(ry) + Rz[2] * Math.sin(ry), Rz[1], -Rz[0] * Math.sin(ry) + Rz[2] * Math.cos(ry)];
  const Rx = [Ry[0], Ry[1] * Math.cos(rx) - Ry[2] * Math.sin(rx), Ry[1] * Math.sin(rx) + Ry[2] * Math.cos(rx)];
  const end = tip.position.map((c, i) => c + Rx[i]);
  assert.ok(end.every((e, i) => Math.abs(e - [1, 2, 1][i]) < 0.01), `termina en ${end}`);
});

test('parseRelBlueprint: valida referencias y el ejemplo del prompt resuelve', async () => {
  const example = JSON.parse(REL_BLUEPRINT_SYSTEM.slice(REL_BLUEPRINT_SYSTEM.indexOf('{"pieces"')));
  const bp = parseRelBlueprint(example);
  const placed = resolveObject(bp.pieces.map((p) => ({ part: p.part, spec: combos(p)[0].patch })));
  assert.deepEqual(placed.map((p) => p.part.id), ['base', 'poste', 'brazo', 'brazo-espejo', 'luz', 'luz-espejo']);
  assert.throws(() => parseRelBlueprint({ pieces: [{ part: { id: 'a' }, base: { primitive: 'box', size: 1, on: { piece: 'b' } } }] }), /todavía no existe/);
  for (const id of ['arbol', 'persona']) {
    const mock = parseRelBlueprint(await mockRelBlueprint({ prompt: 'flores', object: { id } }));
    let sc = { objects: {}, parts: [] };
    for (const p of resolveObject(mock.pieces.map((x) => ({ part: x.part, spec: combos(x)[0].patch })))) sc = applyPiece(sc, { object: { id, label: id }, part: p.part, spec: p.spec });
    assert.deepEqual(checkScene(sc).filter((i) => i.includes('flota')), [], `${id} no tiene piezas flotando`);
  }
});

test('checkScene: detecta piezas que flotan y escondidas', () => {
  let sc = { objects: {}, parts: [] };
  const o = { id: 'mesa', label: 'mesa' };
  sc = applyPiece(sc, { object: o, part: { id: 'tabla', label: 't' }, spec: { primitive: 'box', size: [2, 0.1, 1], position: [0, 1, 0] } });
  sc = applyPiece(sc, { object: o, part: { id: 'pata', label: 'p' }, spec: { primitive: 'box', size: [0.1, 0.95, 0.1], position: [0.9, 0.475, 0.4] } });
  sc = applyPiece(sc, { object: o, part: { id: 'florero', label: 'f' }, spec: { primitive: 'cylinder', size: [0.2, 0.3, 0.2], position: [0, 1.6, 0] } });
  sc = applyPiece(sc, { object: o, part: { id: 'tornillo', label: 'x' }, spec: { primitive: 'box', size: [0.05, 0.05, 0.05], position: [0.1, 1, 0] } });
  const issues = checkScene(sc);
  assert.equal(issues.length, 2);
  assert.match(issues[0], /"mesa\/florero" flota/);
  assert.match(issues[1], /"mesa\/tornillo" queda casi entera dentro de "tabla"/);
});

test('parseFixes valida que cada arreglo apunte a una pieza real', () => {
  const scene = { objects: { pino: { id: 'pino' } }, parts: [{ object: 'pino', id: 'copa' }] };
  assert.deepEqual(parseFixes({ ok: true, note: 'bien' }, scene), { ok: true, fixes: [], note: 'bien' });
  const r = parseFixes({ fixes: [{ object: 'pino', part: 'copa', patch: { position: [0, 3, 0] } }], note: 'bajé la copa' }, scene);
  assert.deepEqual(r.fixes[0].patch, { position: [0, 3, 0] });
  assert.throws(() => parseFixes({ fixes: [{ object: 'pino', part: 'rama', remove: true }] }, scene), /no existe/);
  assert.throws(() => parseFixes({ fixes: [{ object: 'pino', part: 'copa', patch: {} }] }, scene), /no cambia nada/);
});

test('visión: la foto va al planificador solo si se pide y el modelo acepta imágenes', async () => {
  const sent = [];
  const call = harness({
    llm: async (opts) => { sent.push(opts); return { text: sent.length <= 2 ? JSON.stringify(STEP) : JSON.stringify({ ok: true, note: 'bien' }) }; },
    decideImpl: async () => ({ answers: { visto: { noul: 0.5 } } }),
    modalitiesImpl: async (model) => model === 'vision/si',
  });
  const scene = { objects: { pino: { id: 'pino', label: 'un pino', position: [0, 0, 0] } }, parts: [{ object: 'pino', id: 'base', label: 'base', spec: { primitive: 'box', size: [1, 1, 1], position: [0, 0.5, 0] } }] };
  const img = 'data:image/jpeg;base64,AA';
  const a = await call('plan', { prompt: 'un pino', model: 'vision/si', scene, render: img, see: true, issues: ['"pino/copa" flota.'] });
  assert.equal(a.body.sees, true);
  const content = sent[0].messages[1].content;
  assert.ok(Array.isArray(content));
  assert.equal(content[1].image_url.url, img);
  assert.match(content[0].text, /REVISIÓN DEL MOTOR[\s\S]*flota/);
  const b = await call('plan', { prompt: 'un pino', model: 'texto/solo', scene, render: img, see: true });
  assert.equal(b.body.sees, false);
  assert.equal(typeof sent[1].messages[1].content, 'string');
  const c = await call('fix', { prompt: 'un pino', model: 'vision/si', scene, render: img, see: true, issues: [] });
  assert.equal(c.status, 200);
  assert.equal(c.body.ok, true);
  assert.equal(c.body.sees, true);
  assert.ok(Array.isArray(sent[2].messages[1].content));
});

test('createModalities lee input_modalities de OpenRouter y, si falla, asume solo texto', async () => {
  const ok = createModalities(async () => ({ json: async () => ({ data: [{ id: 'a/v', architecture: { input_modalities: ['text', 'image'] } }, { id: 'a/t', architecture: { input_modalities: ['text'] } }] }) }));
  assert.equal(await ok('a/v'), true);
  assert.equal(await ok('a/t'), false);
  assert.equal(await ok('a/desconocido'), false);
  const down = createModalities(async () => { throw new Error('sin red'); });
  assert.equal(await down('a/v'), false);
});

// ---------- Boceto del usuario ----------

test('boceto: sin texto el pedido es el dibujo; con texto, lo complementa', () => {
  const img = 'data:image/jpeg;base64,AA';
  assert.deepEqual(parseSketch({ sketch: img }), { sketch: img, prompt: 'Lo que dibujé en el boceto.' });
  assert.deepEqual(parseSketch({ sketch: img, prompt: ' un perro ' }), { sketch: img, prompt: 'un perro' });
  assert.equal(parseSketch({ sketch: 'no-es-imagen', prompt: 'x' }).sketch, null);
  assert.throws(() => parseSketch({}), /pedido/);
});

test('boceto: el planificador lo recibe primero y JEV lo compara con cada opción', async () => {
  const sent = [], jev = [];
  const ideasJson = JSON.stringify({ objects: [{ id: 'casa', label: 'una casa', position: [0, 0, 0], concepts: ['a', 'b'] }] });
  const call = harness({
    llm: async (opts) => { sent.push(opts); return { text: ideasJson }; },
    decideImpl: async ({ state, questions }) => { jev.push({ state, questions }); return { answers: { p0: { choice: 'A', probabilities: { A: 1, B: 0 } }, visto: { noul: 0.7 } } }; },
    modalitiesImpl: async (model) => model !== 'texto/solo',
  });
  const sketch = 'data:image/png;base64,BB', render = 'data:image/jpeg;base64,CC';
  const ideas = await call('ideas', { sketch, model: 'vision/si' });
  assert.equal(ideas.status, 200);
  const content = sent[0].messages[1].content;
  assert.equal(content[1].image_url.url, sketch);
  assert.match(content[0].text, /PEDIDO: Lo que dibujé en el boceto\.[\s\S]*1\. BOCETO DEL USUARIO/);
  const fix = await call('fix', { sketch, model: 'vision/si', see: true, render, scene: { objects: {}, parts: [] }, issues: [] });
  assert.equal(fix.status, 200);
  assert.deepEqual(sent[1].messages[1].content.slice(1).map((c) => c.image_url.url), [sketch, render]);
  const blind = await call('ideas', { sketch, model: 'texto/solo' });
  assert.equal(blind.status, 400);
  assert.match(blind.body.error, /no acepta imágenes/);
  const pick = await call('pick', { sketch, render, picks: [{ key: 'p0', question: '¿Cuál techo?', options: ['a dos aguas', 'plano'], images: [render, render] }] });
  assert.equal(pick.status, 200);
  assert.equal(jev[0].state.boceto, sketch);
  assert.match(jev[0].questions.p0.instructions, /boceto/);
  assert.match(jev[0].questions.visto.instructions, /`boceto`/);
});

test('groupPicks deja lugar para el boceto en cada llamada', () => {
  const img = 'data:image/jpeg;base64,AA';
  const pick = (key, n) => ({ key, options: Array.from({ length: n }, (_, i) => `o${i}`), images: Array(n).fill(img) });
  const groups = groupPicks([pick('a', 9), pick('b', 9), pick('c', 9), pick('d', 9), pick('e', 4)], 1);
  assert.ok(groups.every((g) => g.reduce((n, p) => n + p.images.length, 0) <= MAX_IMAGES_PER_CALL - 1));
});

test('parseIdeas: con más objetos que el tope construye los primeros y avisa', () => {
  const objects = Array.from({ length: 13 }, (_, i) => ({ id: `cosa${i}`, concepts: ['a', 'b'] }));
  const ideas = parseIdeas({ objects });
  assert.equal(ideas.objects.length, 10);
  assert.equal(ideas.dropped, 3);
  assert.equal(parseIdeas({ objects: objects.slice(0, 3) }).dropped, undefined);
});

test('placeObject mueve y gira el objeto entero (Tools · Attach) y una pieza nueva no lo pierde', () => {
  const s = parseStep(STEP);
  const spec = mergePatches(s.base, s.questions[0].options[0].patch);
  let scene = applyPiece({ objects: {}, parts: [] }, { object: s.object, part: s.part, spec });
  scene = placeObject(scene, 'pino', { position: [1, 2.5, -3], rotation: [0, 45, 10] });
  assert.deepEqual(scene.objects.pino.position, [1, 2.5, -3]);
  assert.deepEqual(scene.objects.pino.rotation, [0, 45, 10]);
  assert.deepEqual(scene.parts[0].spec.position, spec.position);
  assert.match(describeScene(scene), /girado \[0, 45, 10\]/);
  scene = applyPiece(scene, { object: s.object, part: { id: 'copa', label: 'la copa' }, spec: { primitive: 'cone', size: [1, 2, 1], position: [0, 4, 0] } });
  assert.deepEqual(scene.objects.pino.rotation, [0, 45, 10]);
  assert.equal(placeObject(scene, 'pino', { rotation: [0, 0, 0] }).objects.pino.rotation, undefined);
  assert.throws(() => placeObject(scene, 'nada', { position: [0, 0, 0] }), /no existe/);
});

test('looks: el LLM propone looks con la foto del plano y JEV los elige como iluminación', async () => {
  const sent = [];
  const look = (label) => ({ label, lights: [{ role: 'key', from: { side: -45, height: 40, distance: 5 } }] });
  const call = harness({
    llm: async ({ messages }) => { sent.push(messages); return { text: JSON.stringify({ looks: [look('cálido'), look('noir')] }), usage: {} }; },
    modalitiesImpl: async () => true,
    decideImpl: async ({ questions }) => { sent.push(questions); return { answers: { luz: { choice: 'B', probabilities: { A: 0.3, B: 0.7 } } } }; },
  });
  const img = 'data:image/jpeg;base64,AA';
  const out = await call('looks', { prompt: 'dramática', scene: { objects: {}, parts: [] }, subject: 'un avión de papel', current: 'Luz base.', render: img, see: true });
  assert.equal(out.status, 200);
  assert.deepEqual(out.body.looks.map((l) => l.label), ['cálido', 'noir']);
  assert.equal(out.body.sees, true);
  const user = sent[0][1].content;
  assert.match(user[0].text, /SUJETO: un avión de papel/);
  assert.match(user[0].text, /plano del director/);
  assert.equal(user[1].image_url.url, img);
  const pick = await call('pick', { prompt: 'dramática', picks: [{ key: 'luz', topic: 'light', question: '¿Cuál?', options: ['cálido', 'noir'], images: [img, img] }] });
  assert.equal(pick.body.answers.luz.choice, 'noir');
  assert.match(sent[1].luz.instructions, /director de fotografía/);
});
