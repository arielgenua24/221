import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseObjectsBody, buildState, buildQuestions, chunkQuestions, buildScene, boxCells, depthMeters, cellName, MAX_PER_REQUEST } from '../src/objects3d/scene.js';
import { decide, mockDecide, withImages } from '../src/objects3d/jev.js';
import { createObjectsRoutes, parseSegmentBody } from '../src/objects3d/routes.js';
import { Image } from '@typesafe-ai/sdk';

const IMG = 'data:image/jpeg;base64,/9j/AA==';
const body = (extra = {}) => ({ image: IMG, objects: ['mesa', 'brazo', 'escritorio'], ...extra });

test('parseObjectsBody valida la imagen, limpia objetos y acota la cuadrícula', () => {
  assert.throws(() => parseObjectsBody({ objects: ['mesa'] }), /Falta el cuadro/);
  assert.throws(() => parseObjectsBody({ image: IMG, objects: [' '] }), /al menos un objeto/);
  assert.throws(() => parseObjectsBody({ image: IMG, objects: Array.from({ length: 9 }, (_, k) => `o${k}`) }), /Hasta 8/);
  const p = parseObjectsBody({ image: IMG, objects: 'mesa\nMesa\n brazo \n', grid: { cols: 99, rows: 1 }, freeSpace: true });
  assert.deepEqual(p.objects, ['mesa', 'brazo']);
  assert.deepEqual(p.grid, { cols: 26, rows: 2 });
  assert.equal(p.freeSpace, true);
  assert.equal(p.model, 'jev-1.14.0');
  // Sin la cuadrícula dibujada no hay preguntas por celda.
  assert.equal(parseObjectsBody({ ...body(), gridOnImage: false, freeSpace: true }).freeSpace, false);
  assert.equal(parseObjectsBody({ image: IMG, objects: ['mesa'] }).pairs, false);
});

test('buildState describe la cuadrícula solo si está dibujada y manda la imagen', () => {
  const s = buildState(parseObjectsBody(body()));
  assert.match(s.escena, /16 columnas \(A a P/);
  assert.equal(s.photo, IMG);
  assert.doesNotMatch(buildState(parseObjectsBody(body({ gridOnImage: false }))).escena, /cuadrícula/);
});

test('buildQuestions arma 4 preguntas por objeto, pares y celdas', () => {
  const q = buildQuestions(parseObjectsBody(body({ grid: { cols: 4, rows: 3 }, freeSpace: true })));
  assert.equal(Object.keys(q).length, 3 * 4 + 3 + 12);
  assert.equal(q.o0_box.type, 'box');
  assert.equal(q.o0_present.type, 'noul');
  assert.deepEqual(Object.keys(q.o0_present.criteria), ['true', 'false']);
  assert.ok(q.o1_role.criteria.obstaculo);
  assert.equal(q.o2_depth.criteria.length, 5);
  assert.match(q.p0_2_closer.instructions, /"mesa" está más cerca de la cámara que "escritorio"/);
  assert.match(q.c_D3_free.instructions, /celda D3/);
  const chunks = chunkQuestions({ ...q, ...Object.fromEntries(Array.from({ length: 60 }, (_, k) => [`x${k}`, {}])) });
  assert.ok(chunks.every((c) => Object.keys(c).length <= MAX_PER_REQUEST));
  assert.equal(chunks.reduce((s, c) => s + Object.keys(c).length, 0), 27 + 60);
});

test('boxCells, cellName y depthMeters', () => {
  assert.equal(cellName(0, 0), 'A1');
  assert.equal(cellName(15, 8), 'P9');
  assert.deepEqual(boxCells({ left: 0, right: 0.5, top: 0.5, bottom: 1 }, { cols: 16, rows: 9 }), { from: 'A5', to: 'H9', cols: [0, 7], rows: [4, 8] });
  assert.equal(depthMeters(0), 0.6);
  assert.equal(depthMeters(1.5), 2);
  assert.equal(depthMeters(9), 6.5);
});

test('buildScene ordena delante y detrás con los pares y calcula la escala', () => {
  const input = parseObjectsBody(body({ freeSpace: true, grid: { cols: 2, rows: 2 } }));
  const box = (l, r) => ({ type: 'box', box: { top: 0.2, bottom: 0.8, left: l, right: r }, confidence: 0.9 });
  const answers = {
    o0_present: { noul: 0.97 }, o1_present: { noul: 0.9 }, o2_present: { noul: 0.8 },
    o0_box: box(0, 0.6), o1_box: box(0.2, 0.4), o2_box: box(0.6, 1),
    o0_role: { choice: 'pisable', confidence: 0.8, probabilities: { pisable: 0.8, otro: 0.2 } },
    o0_depth: { score: 1, confidence: 0.7 }, o1_depth: { score: 0.5, confidence: 0.6 }, o2_depth: { score: 2, confidence: 0.6 },
    // El brazo está delante de la mesa; los dos, delante del escritorio.
    p0_1_closer: { noul: 0.2 }, p0_2_closer: { noul: 0.9 }, p1_2_closer: { noul: 0.95 },
    c_A1_free: { noul: 0.9 }, c_B1_free: { noul: 0.1 },
  };
  const s = buildScene(input, answers);
  assert.deepEqual(s.order, ['o1', 'o0', 'o2']);
  assert.equal(s.objects[1].zIndex, 3);
  assert.equal(s.objects[2].zIndex, 1);
  assert.equal(s.closer[1][0], 0.8);
  assert.equal(s.objects[0].role.choice, 'pisable');
  assert.equal(s.objects[0].depth.meters, 1.5);
  assert.equal(s.objects[1].scale, 1);
  assert.equal(s.objects[2].scale, +(1.05 / 2.5).toFixed(3));
  assert.deepEqual(s.free.map((f) => f.cell), ['A1', 'B1']);
});

test('buildScene deja fuera del orden lo que JEV dice que no está', () => {
  const input = parseObjectsBody(body());
  const s = buildScene(input, { o0_present: { noul: 0.9 }, o1_present: { noul: 0.1 }, o2_present: { noul: 0.7 }, o0_depth: { score: 2 }, o2_depth: { score: 0 } });
  assert.deepEqual(s.order, ['o2', 'o0']);
  assert.equal(s.objects[1].zIndex, undefined);
});

test('mockDecide responde con la forma de JEV', async () => {
  const q = buildQuestions(parseObjectsBody(body()));
  const r = await mockDecide({ model: 'typesafe/jev-1.14', questions: q });
  assert.equal(Object.keys(r.answers).length, Object.keys(q).length);
  const role = r.answers.o0_role;
  assert.ok(Math.abs(Object.values(role.probabilities).reduce((a, b) => a + b, 0) - 1) < 0.01);
  assert.ok(r.answers.o0_box.box.right <= 1 && r.answers.o0_box.box.left >= 0);
  assert.equal(typeof r.answers.o0_depth.score, 'number');
});

test('decide habla con la API de TypeSafe, manda la imagen como asset y reintenta errores transitorios', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    if (calls.length === 1) return new Response('{"error":{"message":"ocupado"}}', { status: 503, headers: { 'content-type': 'application/json', 'retry-after': '0' } });
    return new Response(JSON.stringify({ model: 'jev-1.14.0', answers: { a: { type: 'noul', noul: 0.4 } }, usage: { input_tokens: 10, output_tokens: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const out = await decide({ apiKey: 'k', model: 'jev-1.14.0', state: { photo: IMG }, questions: { a: { type: 'noul', instructions: '¿hay algo en `photo`?' } }, fetchImpl });
  assert.equal(out.answers.a.noul, 0.4);
  assert.deepEqual(out.usage, { input_tokens: 10, output_tokens: 1 });
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /\/v1\/systemone$/);
  const headers = new Headers(calls[0].init.headers);
  assert.match(headers.get('authorization'), /k$/);
  assert.equal(headers.get('typesafe-danger-zone-images'), 'true');
  await assert.rejects(decide({ apiKey: '', model: 'm', state: {}, questions: {} }), /Falta TYPESAFE_API_KEY/);
  await assert.rejects(decide({ apiKey: 'k', model: 'm', state: { a: 1 }, questions: { a: { type: 'noul', instructions: 'x' } }, fetchImpl: async () => new Response('{"error":{"message":"box no soportado"}}', { status: 400, headers: { 'content-type': 'application/json' } }) }), /JEV 400 \(m\)/);
});

test('withImages convierte las data URL del state en imágenes del SDK', () => {
  const s = withImages({ photo: IMG, subject: 'mesa', tiles: [IMG, 'texto'] });
  assert.ok(s.photo instanceof Image);
  assert.ok(s.tiles[0] instanceof Image);
  assert.equal(s.subject, 'mesa');
  assert.equal(s.tiles[1], 'texto');
});

test('la ruta reparte las preguntas en llamadas y devuelve el mapa', async () => {
  const seen = [];
  const handle = createObjectsRoutes({
    mock: false,
    readBody: async () => body({ freeSpace: true, grid: { cols: 8, rows: 6 } }),
    sendJson: (res, status, data) => { res.status = status; res.data = data; },
    badRequest: (res, error) => { res.status = 400; res.data = { error }; },
    decideImpl: async (opts) => { seen.push(opts); return mockDecide(opts); },
  });
  const res = { on() {}, writableFinished: false };
  assert.equal(handle({ method: 'POST' }, res, new URL('http://x/api/lab/objects/analyze')), true);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(res.status, 200);
  const total = 3 * 4 + 3 + 48;
  assert.equal(seen.length, Math.ceil(total / MAX_PER_REQUEST));
  assert.equal(res.data.calls.reduce((s, c) => s + Object.keys(c.questions).length, 0), total);
  assert.equal(res.data.scene.objects.length, 3);
  assert.equal(res.data.scene.free.length, 48);
  assert.ok(res.data.usage.input_tokens > 0);
  assert.equal(handle({ method: 'GET' }, res, new URL('http://x/api/lab/nada')), false);
});

test('parseSegmentBody valida cada método de las siluetas', () => {
  assert.throws(() => parseSegmentBody({ method: 'hybrid', image: IMG }), /qué objeto segmentar/);
  assert.throws(() => parseSegmentBody({ method: 'hybrid', subject: 'mesa' }), /Falta el recorte/);
  assert.throws(() => parseSegmentBody({ method: 'superpixels', subject: 'mesa', image: IMG, k: 9 }), /k debe estar entre 64 y 600/);
  assert.throws(() => parseSegmentBody({ method: 'refine', subject: 'mesa', tiles: [] }), /No hay tiles/);
  assert.throws(() => parseSegmentBody({ method: 'refine', subject: 'mesa', tiles: Array.from({ length: 41 }, (_, k) => ({ tileId: `t${k}`, image: IMG })) }), /Máximo 40/);
  assert.throws(() => parseSegmentBody({ method: 'otro', subject: 'mesa', image: IMG }), /hybrid, superpixels o refine/);
  assert.equal(parseSegmentBody({ method: 'hybrid', subject: 'mesa', image: IMG, baseGrid: 99 }).baseGrid, 20);
  assert.equal(parseSegmentBody({ method: 'superpixels', subject: 'mesa', image: IMG, k: 400 }).k, 400);
});

test('la ruta de siluetas corre los Experimentos 3 y 4 sobre el recorte', async () => {
  const seen = [];
  const run = async (payload) => {
    const handle = createObjectsRoutes({
      mock: false,
      readBody: async () => payload,
      sendJson: (res, status, data) => { res.status = status; res.data = data; },
      badRequest: (res, error) => { res.status = 400; res.data = { error }; },
      decideImpl: async (opts) => { seen.push(opts); return mockDecide(opts); },
    });
    const res = { on() {}, writableFinished: false };
    assert.equal(handle({ method: 'POST' }, res, new URL('http://x/api/lab/objects/segment')), true);
    await new Promise((r) => setTimeout(r, 20));
    return res;
  };
  const h = await run({ method: 'hybrid', subject: 'mesa', image: IMG });
  assert.equal(h.status, 200);
  assert.equal(h.data.cells.length, 256);
  assert.equal(h.data.subBoxes.length, 4);
  assert.equal(Object.keys(seen[0].questions).length, 260);
  assert.equal(seen[0].state.photo, IMG);
  const sp = await run({ method: 'superpixels', subject: 'mesa', image: IMG, k: 64, centroids: [[0.1, 0.2]] });
  assert.equal(sp.data.probabilities.length, 64);
  assert.match(seen[1].questions.sp_0.instructions, /Region #0 \(0\.10,0\.20\)/);
  const rf = await run({ method: 'refine', subject: 'mesa', tiles: [{ tileId: 't1_2', image: IMG }] });
  assert.equal(rf.data.tiles[0].sub.length, 16);
  assert.equal(seen[2].state.tile_t1_2, IMG);
  assert.equal((await run({ method: 'hybrid', image: IMG })).status, 400);
});
