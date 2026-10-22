import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  locateSubjectBox, reconstruct, reconstructGrid, reconstructHybridV3, reconstructSuperpixelsV4, refineUncertainTilesV4,
  V4_MAX_REFINE_TILES,
} from '../src/jev-pixel/experiments.js';
import { createJevPixelRoutes, parsers, LIMITS } from '../src/jev-pixel/routes.js';

const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const JPG = 'data:image/jpeg;base64,/9j/AA==';

// Fake ask: guarda lo que se le pidió y responde con lo que devuelva `answer(key, q)`.
function fakeAsk(answer) {
  const calls = [];
  const ask = async (opts) => {
    calls.push(opts);
    const answers = {};
    for (const [key, q] of Object.entries(opts.questions)) {
      const a = answer(key, q);
      if (a !== undefined) answers[key] = a;
    }
    return { model: 'jev-test', answers, usage: { input_tokens: 100, output_tokens: 7 } };
  };
  return { ask, calls };
}

test('Exp 1 · reconstruct pregunta 8×8 noul y lee cobertura y decisión', async () => {
  const { ask, calls } = fakeAsk((key) => ({ type: 'noul', noul: key === 'r0c0' ? 1 : 0 }));
  const r = await reconstruct({ ask, model: 'm', image: JPG, subject: 'the sky' });
  assert.equal(Object.keys(calls[0].questions).length, 64);
  assert.equal(calls[0].state.photo, JPG);
  assert.equal(calls[0].state.subject, 'the sky');
  const q = calls[0].questions.r7c7;
  assert.equal(q.type, 'noul');
  assert.deepEqual(q.instructions.cell, { row: 8, column: 8, rows: 8, columns: 8, top: 0.875, bottom: 1, left: 0.875, right: 1 });
  assert.equal(r.grid, 8);
  assert.equal(r.cells.length, 64);
  assert.equal(r.cells[0].probability, 1);
  assert.equal(r.coverage, 1 / 64);
  assert.equal(r.decisiveness, 1);
  assert.deepEqual(r.usage, { input: 100, output: 7 });
});

test('Exp 2 · locateSubjectBox acota la caja y reconstructGrid usa N×N', async () => {
  const { ask, calls } = fakeAsk((key) => (key === 'present' ? { type: 'noul', noul: 0.9 }
    : key === 'region' ? { type: 'box', box: { top: 0.99, bottom: 0.2, left: -0.5, right: 0.4 }, confidence: 0.8 } : undefined));
  const loc = await locateSubjectBox({ ask, model: 'm', image: PNG, subject: "Woody's hat" });
  assert.equal(calls[0].questions.region.type, 'box');
  assert.equal(loc.present, 0.9);
  assert.equal(loc.confidence, 0.8);
  assert.equal(loc.box.top, 0.95);
  assert.ok(Math.abs(loc.box.bottom - 1) < 1e-9); // top + 0.05 como mínimo
  assert.equal(loc.box.left, 0);
  assert.equal(loc.box.right, 0.4);

  const g = fakeAsk(() => ({ type: 'noul', noul: 0.5 }));
  const r = await reconstructGrid({ ask: g.ask, model: 'm', image: JPG, subject: 'x', grid: 20 });
  assert.equal(Object.keys(g.calls[0].questions).length, 400);
  assert.equal(r.decisiveness, 0);
  // Sin respuesta, la celda vale 0.
  const empty = fakeAsk(() => undefined);
  const e = await reconstructGrid({ ask: empty.ask, model: 'm', image: JPG, subject: 'x', grid: 12 });
  assert.equal(e.cells.length, 144);
  assert.equal(e.coverage, 0);
});

test('Exp 3 · reconstructHybridV3 junta 256 noul + 4 box en una llamada', async () => {
  const { ask, calls } = fakeAsk((key, q) => (q.type === 'box'
    ? { type: 'box', box: { top: 0.1, bottom: 0.5, left: 0.2, right: 1.4 }, confidence: 0.7 }
    : { type: 'noul', noul: 0.8 }));
  const r = await reconstructHybridV3({ ask, model: 'm', image: JPG, subject: 'the hat', baseGrid: 16 });
  assert.equal(calls.length, 1);
  assert.equal(Object.keys(calls[0].questions).length, 256 + 4);
  assert.match(calls[0].questions.sub_core.instructions, /tight silhouette of the hat/);
  assert.equal(r.baseGrid, 16);
  assert.equal(r.subBoxes.length, 4);
  assert.deepEqual(r.subBoxes.map((b) => b.id), ['sub_core', 'sub_top', 'sub_mid', 'sub_bot']);
  assert.equal(r.subBoxes[0].box.right, 1); // recortado a [0, 1]
  assert.equal(r.question, 'the hat');
  assert.ok(Math.abs(r.coverage - 0.8) < 1e-9);
  assert.equal(typeof r.elapsedMs, 'number');
});

test('Exp 4 · superpíxeles: un noul por región con centroide y faltantes a 0.5', async () => {
  const { ask, calls } = fakeAsk((key, q) => {
    if (q.type === 'box') return undefined;
    if (key === 'sp_3') return undefined;
    return { type: 'noul', noul: key === 'sp_0' ? 1.7 : 0.25 };
  });
  const centroids = Array.from({ length: 64 }, (_, i) => [i / 64, 0.5]);
  const r = await reconstructSuperpixelsV4({ ask, model: 'm', labeledImage: PNG, k: 64, subject: 'the dog', centroids });
  const q = calls[0].questions;
  assert.equal(Object.keys(q).length, 64 + 4);
  assert.equal(q.sp_1.instructions, 'Region #1 (0.02,0.50) is `subject`?');
  assert.match(calls[0].state.instructions, /#0\.\.#63/);
  assert.equal(r.k, 64);
  assert.equal(r.probabilities[0], 1);
  assert.equal(r.probabilities[1], 0.25);
  assert.equal(r.probabilities[3], 0.5);
  assert.equal(r.missingAnswers, 1);
  assert.equal(r.subBoxes.length, 0);
});

test('Exp 4 · refine: 16 noul por tile, tiles como imágenes del state, tope de 40', async () => {
  const { ask, calls } = fakeAsk((key) => ({ type: 'noul', noul: key.endsWith('_r0_c0') ? 0.9 : 0.1 }));
  const tiles = Array.from({ length: V4_MAX_REFINE_TILES + 2 }, (_, i) => ({ tileId: `t${i}_0`, image: PNG }));
  const r = await refineUncertainTilesV4({ ask, model: 'm', tiles, subject: 'x' });
  assert.equal(r.truncated, true);
  assert.equal(r.tiles.length, V4_MAX_REFINE_TILES);
  assert.equal(Object.keys(calls[0].questions).length, V4_MAX_REFINE_TILES * 16);
  assert.equal(calls[0].state.tile_t0_0, PNG);
  assert.equal(calls[0].questions.t0_0_r1_c2.instructions, '`tile_t0_0` cell r2c3 contains `subject`?');
  assert.equal(r.tiles[0].sub[0], 0.9);
  assert.equal(r.tiles[0].sub[15], 0.1);
  // Sin tiles no hay llamada.
  const none = fakeAsk(() => undefined);
  const e = await refineUncertainTilesV4({ ask: none.ask, model: 'm', tiles: [], subject: 'x' });
  assert.equal(none.calls.length, 0);
  assert.deepEqual(e.tiles, []);
});

test('parsers validan como los route.ts originales', () => {
  assert.throws(() => parsers.grid({ question: 'el cielo' }), /Falta la imagen/);
  assert.throws(() => parsers.grid({ image: 'data:image/gif;base64,R0lG', question: 'el cielo' }), /solo acepta PNG o JPEG/);
  assert.throws(() => parsers.grid({ image: JPG, question: 'x' }), /Escribí qué querés que JEV marque/);
  assert.throws(() => parsers.grid({ image: JPG, question: 'x'.repeat(281) }), /demasiado larga/);
  const big = `data:image/jpeg;base64,${'A'.repeat(Math.ceil((LIMITS.smallImageBytes + 10) / 3) * 4)}`;
  assert.throws(() => parsers.grid({ image: big, question: 'el cielo' }), /menos de 4 MB/);
  assert.equal(parsers.grid({ image: JPG, question: ' el cielo ', grid: 99 }).grid, 20);
  assert.equal(parsers.grid({ image: JPG, question: 'el cielo', grid: 2 }).grid, 8);
  assert.equal(parsers.grid({ image: JPG, question: 'el cielo' }).grid, 16);
  assert.equal(parsers.grid({ image: JPG, question: ' el cielo ' }).subject, 'el cielo');

  assert.throws(() => parsers.hybrid({ image: JPG, question: 'x'.repeat(241) }), /localizar y reconstruir/);
  assert.throws(() => parsers.hybrid({ question: 'el sombrero' }), /Subí una imagen/);
  assert.equal(parsers.hybrid({ image: JPG, question: 'el sombrero', baseGrid: 'nope' }).baseGrid, 16);

  assert.throws(() => parsers.superpixels({ image: PNG, question: 'el perro', k: 10 }), /k debe estar entre 64 y 600/);
  assert.throws(() => parsers.superpixels({ image: PNG, question: 'el perro', k: 601 }), /k debe estar entre 64 y 600/);
  assert.throws(() => parsers.superpixels({ question: 'el perro', k: 400 }), /recorte etiquetado/);
  assert.equal(parsers.superpixels({ image: PNG, question: 'el perro', centroids: 'mal' }).centroids, undefined);
  assert.equal(parsers.superpixels({ image: PNG, question: 'el perro' }).k, 400);

  assert.throws(() => parsers.refine({ question: 'el perro', tiles: [] }), /No hay tiles/);
  assert.throws(() => parsers.refine({ question: 'el perro' }), /tileIds inválido/);
  assert.throws(() => parsers.refine({ question: 'el perro', tiles: [{ tileId: 3, image: PNG }] }), /tileIds inválido/);
  assert.throws(() => parsers.refine({ question: 'el perro', tiles: Array.from({ length: 41 }, (_, i) => ({ tileId: `t${i}`, image: PNG })) }), /Máximo 40 tiles/);
  assert.throws(() => parsers.refine({ question: 'el perro', tiles: [{ tileId: 't0_1', image: 'hola' }] }), /Falta la imagen: tile t0_1/);
  assert.equal(parsers.refine({ question: 'el perro', tiles: [{ tileId: 't0_1', image: PNG }] }).tiles.length, 1);
});

// ---------- Rutas ----------
function harness(body, opts = {}) {
  const handle = createJevPixelRoutes({
    mock: true,
    readBody: async () => { if (body instanceof Error) throw body; return body; },
    sendJson: (res, status, data) => { res.status = status; res.data = data; },
    badRequest: (res, error) => { res.status = 400; res.data = { error }; },
    ...opts,
  });
  return async (method, path) => {
    const res = { on() {}, writableFinished: false };
    const handled = handle({ method }, res, new URL(`http://x/api/lab/jev-pixel/${path}`));
    await new Promise((r) => setTimeout(r, 20));
    return { handled, ...res };
  };
}

test('ruta config y rutas desconocidas', async () => {
  const call = harness({});
  const r = await call('GET', 'config');
  assert.equal(r.handled, true);
  assert.equal(r.data.mock, true);
  assert.equal(r.data.available, true);
  assert.equal(r.data.limits.kMax, 600);
  assert.equal(r.data.limits.maxRefineTiles, 40);
  assert.equal((await call('GET', 'nada')).handled, false);
  assert.equal((await call('POST', 'config')).handled, false);
});

test('rutas · errores de validación responden 400 en español', async () => {
  let r = await harness({ question: 'el cielo' })('POST', 'grid');
  assert.equal(r.status, 400);
  assert.match(r.data.error, /Falta la imagen/);
  r = await harness({ image: PNG, question: 'el perro', k: 5 })('POST', 'superpixels');
  assert.equal(r.status, 400);
  assert.match(r.data.error, /k debe estar entre/);
  r = await harness(new SyntaxError('bad'))('POST', 'locate');
  assert.equal(r.status, 400);
  assert.match(r.data.error, /JSON/);
  r = await harness(new Error('El envío supera 64 MB.'))('POST', 'refine');
  assert.equal(r.status, 400);
  assert.match(r.data.error, /64 MB/);
});

test('rutas · sin clave de TypeSafe responde 500', async () => {
  const r = await harness({ image: JPG, question: 'el cielo' }, { mock: false, apiKey: '' })('POST', 'locate');
  assert.equal(r.status, 500);
  assert.match(r.data.error, /TYPESAFE_API_KEY/);
});

test('rutas · caminos felices con mockDecide', async () => {
  let r = await harness({ image: JPG, question: 'the main subject' })('POST', 'locate');
  assert.equal(r.status, 200);
  assert.ok(r.data.present >= 0.75, 'en demo el sujeto siempre está');
  assert.ok(r.data.box.right > r.data.box.left);

  r = await harness({ image: JPG, question: 'the main subject', grid: 8 })('POST', 'grid');
  assert.equal(r.status, 200);
  assert.equal(r.data.grid, 8);
  assert.equal(r.data.cells.length, 64);

  r = await harness({ image: JPG, question: "Woody's hat", baseGrid: 16 })('POST', 'hybrid');
  assert.equal(r.status, 200);
  assert.equal(r.data.cells.length, 256);
  assert.equal(r.data.subBoxes.length, 4);

  r = await harness({ image: PNG, question: "Woody's hat", k: 256, centroids: [[0.1, 0.2]] })('POST', 'superpixels');
  assert.equal(r.status, 200);
  assert.equal(r.data.probabilities.length, 256);
  assert.equal(r.data.missingAnswers, 0);

  r = await harness({ question: "Woody's hat", tiles: [{ tileId: 't1_2', image: PNG }, { tileId: 't3_4', image: PNG }] })('POST', 'refine');
  assert.equal(r.status, 200);
  assert.equal(r.data.tiles.length, 2);
  assert.equal(r.data.tiles[1].sub.length, 16);
});

test('rutas · un fallo de JEV responde 502 y uno de pedido 400', async () => {
  const boom = (status) => async () => { throw Object.assign(new Error(`JEV ${status}: falló`), { status }); };
  let r = await harness({ image: JPG, question: 'el cielo' }, { decideImpl: boom(502) })('POST', 'grid');
  assert.equal(r.status, 502);
  assert.match(r.data.error, /falló/);
  r = await harness({ image: JPG, question: 'el cielo' }, { decideImpl: boom(400) })('POST', 'grid');
  assert.equal(r.status, 400);
});

