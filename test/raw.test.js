import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRawStore } from '../src/raw-store.js';
import { runRawTurn, runRawGeneration, parseRawTurnBody, sanitizeReply, pickVision, historyMessages } from '../src/raw-agent.js';
import { rawTurnContent, imagePrompt, RAW_SYSTEM } from '../src/raw-prompts.js';
import { createSpeaker } from '../src/raw-voice.js';
import { createMockWaveSpeed } from '../src/wavespeed.js';
import { mockLLM } from '../src/mock.js';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const config = { rawModel: 'test/model', imageModel: 'openai/gpt-image-2.5-flare/edit', imageQuality: 'high' };

async function withStore(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'raw-'));
  try { return await fn(createRawStore(dir), dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

async function turn(store, input, extra = {}) {
  const events = [];
  let plan;
  const log = await runRawTurn({
    store, input: parseRawTurnBody(input), config, ws: createMockWaveSpeed({ mediaDir: store.filesDir }),
    speak: async () => null, emit: (e) => events.push(e), llm: mockLLM,
    propose: async (p) => { plan = { ...p, id: 'proposal-123' }; return { id: plan.id, codes: p.inputs.map((a) => a.code), summary: p.summary }; }, ...extra,
  });
  return { events, log, plan, of: (type) => events.filter((e) => e.type === type) };
}

test('carpetas y subcarpetas: la subcarpeta hereda las imágenes del proyecto; borrar se lleva todo', () => withStore(async (store) => {
  const pes = await store.createFolder({ name: '  pes13 ' });
  assert.equal(pes.name, 'pes13');
  const sub = await store.createFolder({ name: 'jugadores', parentId: pes.id });
  await assert.rejects(store.createFolder({ name: '' }), /nombre/);
  await assert.rejects(store.createFolder({ name: 'x', parentId: 'nada' }), /no existe/);
  const p = await store.addAsset({ folderId: pes.id, kind: 'persona', dataUrl: PNG });
  const r = await store.addAsset({ folderId: sub.id, kind: 'referencia', dataUrl: PNG });
  assert.equal(p.code, 'P1');
  assert.equal(r.code, 'R1');
  assert.deepEqual((await store.assetsFor(sub.id)).map((a) => a.code), ['P1', 'R1']);
  assert.deepEqual((await store.assetsFor(pes.id)).map((a) => a.code), ['P1']);
  assert.deepEqual((await store.lineage(sub.id)).map((f) => f.name), ['pes13', 'jugadores']);
  const tree = await store.tree();
  assert.equal(tree.find((f) => f.id === pes.id).children, 1);
  await assert.rejects(store.addAsset({ folderId: pes.id, kind: 'persona', dataUrl: 'data:text/html;base64,AAAA' }), /JPG, PNG/);
  const out = await store.deleteFolder(pes.id);
  assert.deepEqual(out, { deleted: 2, assets: 2 });
  assert.equal((await store.tree()).length, 0);
  assert.deepEqual(await readdir(store.filesDir), []);
}));

test('el índice sobrevive a reabrir el almacenamiento (las imágenes quedan vivas en el proyecto)', () => withStore(async (store, dir) => {
  const f = await store.createFolder({ name: 'pes13' });
  await store.addAsset({ folderId: f.id, kind: 'referencia', dataUrl: PNG });
  await store.updateAsset('R1', { category: 'estilo', name: 'PES 13', kind: 'persona' });
  const again = createRawStore(dir);
  const [a] = await again.assetsFor(f.id);
  assert.equal(a.category, 'estilo');
  assert.equal(a.kind, 'persona');
  assert.match(await again.dataUrl(a), /^data:image\/png;base64,/);
}));

test('parseRawTurnBody y sanitizeReply validan contra las imágenes reales', () => {
  assert.throws(() => parseRawTurnBody({ folderId: 'x' }), /Decí o escribí/);
  const input = parseRawTurnBody({ folderId: 'x', text: '  hola  ', selected: ['R2', 'mal', 'G10'], aspect: '7:3' });
  assert.deepEqual(input.selected, ['R2', 'G10']);
  assert.equal(input.aspect, '1:1');
  const assets = [{ code: 'P1' }, { code: 'R1' }];
  const both = sanitizeReply({ decir: 'x', mostrar: { codigos: ['r1', 'R9'] }, generar: { entradas: ['P1'], prompt: 'p' } }, assets);
  assert.deepEqual(both.mostrar.codigos, ['R1']);
  assert.equal(both.generar, null, 'no genera mientras pregunta');
  const gen = sanitizeReply({ decir: 'x', etiquetas: [{ codigo: 'Z1' }, { codigo: 'p1', tipo: 'otro', categoria: 'c' }], generar: { entradas: ['P1', 'R1', 'P1'], prompt: 'p', proporcion: '9:16' } }, assets);
  assert.deepEqual(gen.generar.entradas, ['P1', 'R1']);
  assert.equal(gen.generar.proporcion, '9:16');
  assert.deepEqual(gen.etiquetas, [{ codigo: 'P1', tipo: undefined, categoria: 'c', nombre: undefined, descripcion: undefined }]);
  assert.equal(sanitizeReply({ generar: { entradas: ['X'], prompt: 'p' } }, assets).pidioGenerarSinImagenes, true);
});

test('lo que ve el modelo: imágenes con su código, las tocadas siempre, historial alternado', () => {
  const now = Date.parse('2026-09-29T12:00:00Z');
  const mk = (code, kind, i) => ({ code, kind, folderId: 'f', createdAt: new Date(now - (100 - i) * 60000).toISOString(), category: null });
  const assets = [...Array.from({ length: 30 }, (_, i) => mk(`R${i + 1}`, 'referencia', i)), mk('G1', 'generada', 40)];
  const vision = pickVision(assets, { must: ['R1'] });
  assert.ok(vision.length <= 20);
  assert.ok(vision.some((a) => a.code === 'R1'));
  assert.ok(vision.some((a) => a.code === 'G1'));
  assert.ok(vision.some((a) => a.code === 'R30'));
  const content = rawTurnContent({ lineage: [{ id: 'f', name: 'pes13' }], assets: assets.slice(0, 2), images: [{ asset: assets[0], url: PNG }], freshCodes: ['R2'], text: 'hola', selected: ['R1'], now, lastShown: { codigos: ['R1', 'R2'], pregunta: '¿Cuál?' } });
  const text = content.map((c) => c.text || '').join('\n');
  assert.match(text, /Proyecto: pes13/);
  assert.match(text, /R2 · referencia · SIN CATEGORÍA .* RECIÉN SUBIDA/);
  assert.match(text, /mostraste: R1, R2/);
  assert.match(text, /tocó en pantalla: R1/);
  assert.deepEqual(content.slice(1, 3).map((c) => c.type), ['text', 'image_url']);
  const msgs = historyMessages([{ role: 'assistant', text: 'a' }, { role: 'assistant', note: true, text: 'b' }, { role: 'user', text: 'c' }]);
  assert.deepEqual(msgs.map((m) => m.role), ['user', 'assistant', 'user']);
  assert.equal(msgs[1].content, 'a\nb');
  assert.match(imagePrompt({ prompt: 'Do it.', inputs: [{ kind: 'persona' }, { kind: 'referencia', category: 'estilo' }], style: 'Anime' }), /^Image 1 = the person\/subject\. Image 2 = reference, estilo\.\nDo it\. Preferred style: Anime\.$/);
  assert.match(RAW_SYSTEM, /NO generes/);
});

test('flujo completo: pregunta cuál y prepara el modal; la generación separada usa exactamente el plan', () => withStore(async (store) => {
  const f = await store.createFolder({ name: 'pes13' });
  await store.addAsset({ folderId: f.id, kind: 'persona', dataUrl: PNG });
  for (let i = 0; i < 3; i++) await store.addAsset({ folderId: f.id, kind: 'referencia', dataUrl: PNG });

  const first = await turn(store, { folderId: f.id, text: 'convierteme a esta persona en un dibujo estilo pes 13 con la última referencia' });
  assert.deepEqual(first.of('raw_show')[0].codes, ['R1', 'R2', 'R3']);
  assert.match(first.of('raw_say')[0].text, /A ver, espera/);
  assert.equal(first.of('raw_generating').length, 0);
  assert.equal(first.of('raw_asset').length, 4, 'categoriza las imágenes nuevas');
  assert.equal((await store.assetsFor(f.id))[1].category, 'estilo');

  const second = await turn(store, { folderId: f.id, text: 'a esta', selected: ['R3'] });
  assert.deepEqual(second.of('raw_proposal')[0].proposal.codes, ['P1', 'R3']);
  assert.equal(second.of('raw_generating').length, 0);
  assert.equal((await store.assetsFor(f.id)).filter((a) => a.kind === 'generada').length, 0);
  await runRawGeneration({ store, plan: second.plan, ws: createMockWaveSpeed({ mediaDir: store.filesDir }), emit: (e) => second.events.push(e) });
  const gen = second.of('raw_generated')[0].asset;
  assert.equal(gen.code, 'G1');
  assert.deepEqual(gen.inputs, ['P1', 'R3']);
  assert.equal(second.of('raw_say').length, 1, 'invita a revisar el modal sin esperar generación');
  assert.ok(second.events.findIndex((e) => e.type === 'raw_listen') < second.events.findIndex((e) => e.type === 'raw_generated'), 'se puede volver a hablar mientras genera');
  const hist = await store.history(f.id);
  assert.equal(hist.length, 5);
  assert.deepEqual(hist[1].shown.codigos, ['R1', 'R2', 'R3']);
  assert.match(hist.at(-1).text, /G1 quedó lista/);
}));

test('sin WaveSpeed la generación falla con un mensaje claro y el turno termina bien', () => withStore(async (store) => {
  const f = await store.createFolder({ name: 'x' });
  await store.addAsset({ folderId: f.id, kind: 'persona', dataUrl: PNG });
  await store.addAsset({ folderId: f.id, kind: 'referencia', dataUrl: PNG });
  const r = await turn(store, { folderId: f.id, text: 'hazme esta persona con este estilo' }, { ws: null });
  assert.equal(r.of('raw_proposal').length, 1);
  await assert.rejects(runRawGeneration({ store, plan: r.plan, ws: null, emit() {} }), /WAVESPEED_API_KEY/);
}));

test('como herramienta de GPT Audio, RAW propone conservando el historial nativo sin duplicar la respuesta hablada', () => withStore(async (store) => {
  const f = await store.createFolder({ name: 'Audio' });
  await store.addAsset({ folderId: f.id, kind: 'persona', dataUrl: PNG });
  await store.addAsset({ folderId: f.id, kind: 'referencia', dataUrl: PNG });
  await store.appendHistory(f.id, [{ role: 'user', text: 'hazme esta persona con este estilo', voice: true }]);
  const out = await turn(store, { folderId: f.id, text: 'hazme esta persona con este estilo' }, { remember: false });
  assert.equal(out.log.proposal.id, 'proposal-123');
  assert.equal(out.log.generation, undefined);
  assert.equal(out.of('raw_proposal').length, 1);
  const history = await store.history(f.id);
  assert.equal(history.filter((h) => h.role === 'user').length, 1);
  assert.ok(history.filter((h) => h.role === 'assistant').every((h) => h.note));
  assert.equal((await store.assetsFor(f.id)).filter((a) => a.kind === 'generada').length, 0);
}));

test('la voz se cachea por texto: la misma frase no se genera dos veces', () => withStore(async (store) => {
  let calls = 0;
  const { writeFile, mkdir } = await import('node:fs/promises');
  const ws = {
    async audio({ body }) {
      calls++;
      assert.deepEqual(body, { text: 'Hola', voice: 'Kore' });
      await mkdir(store.filesDir, { recursive: true });
      await writeFile(path.join(store.filesDir, 'x.mp3'), 'MP3');
      return { file: 'x.mp3' };
    },
  };
  const speak = createSpeaker({ ws, filesDir: store.filesDir, publicPrefix: '/raw-files/', model: 'm', voice: 'Kore', style: '' });
  const [a, b] = await Promise.all([speak('Hola'), speak('Hola')]);
  const c = await speak('Hola');
  assert.match(a, /^\/raw-files\/tts\/[0-9a-f]{20}\.mp3$/);
  assert.equal(a, b);
  assert.equal(a, c);
  assert.equal(calls, 1);
  assert.equal(await createSpeaker({ ws: { mock: true }, filesDir: store.filesDir, publicPrefix: '/' })('Hola'), null);
}));
