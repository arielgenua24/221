import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createStorySelection, referenceSelectors } from '../public/story-selection.js';
import { createStoryStore } from '../src/story-store.js';
import { parseStoryReferences } from '../src/story-references.js';
import { parseStoryTurnBody, runStoryTurn } from '../src/story-pipeline.js';
import { parseVoiceBody } from '../src/voice-session.js';

const PNG = 'data:image/png;base64,aGVsbG8=';
const A = { rawCode: 'P1', file: 'raw:one.png', name: 'Ana' };
const B = { rawCode: 'R1', file: 'raw:two.png', name: 'Lugar' };
async function fixture(run) {
  const dir = await mkdtemp(path.join(tmpdir(), 'story-refs-'));
  try { await run(createStoryStore(dir), dir); } finally { await rm(dir, { recursive: true, force: true }); }
}
const jobs = (store) => ({ view: store.get, cancel() {} });
const reply = { decir: 'Entendido.', preguntas: [], historia: null, tomas: null };
const llmReply = async () => ({ text: JSON.stringify(reply), usage: {} });

test('tocar alterna referencias, tomar el turno limpia el borrador y aísla historias y selecciones posteriores', () => {
  const selection = createStorySelection();
  selection.toggle('one', A);
  assert.equal(selection.has('one', A), true);
  selection.toggle('one', A);
  assert.deepEqual(selection.list('one'), []);
  selection.toggle('one', A);
  const snapshot = selection.take('one');
  selection.toggle('one', B);
  selection.toggle('two', A);
  assert.deepEqual(referenceSelectors(snapshot.references), [{ rawCode: 'P1' }]);
  assert.deepEqual(referenceSelectors(selection.list('one')), [{ rawCode: 'R1' }]);
  assert.deepEqual(referenceSelectors(selection.list('two')), [{ rawCode: 'P1' }]);
  A.name = 'Otro nombre';
  assert.equal(snapshot.references[0].name, 'Ana');
  A.name = 'Ana';
  selection.restore(snapshot);
  assert.equal(selection.list('one').length, 2);
  assert.deepEqual(selection.take('one').references.map((a) => a.rawCode), ['R1', 'P1']);
  assert.deepEqual(selection.take('one').references, []);
});

test('texto y GPT Audio aceptan sólo ids, rechazan adjuntos inválidos y no aceptan rutas del cliente', () => {
  const refs = [{ code: 'M1', file: '/etc/passwd', name: 'Falso' }];
  assert.deepEqual(parseStoryTurnBody({ projectId: 'project-123', text: 'Hola', references: refs }).references, [{ code: 'M1' }]);
  assert.deepEqual(parseVoiceBody({ kind: 'story', id: 'project-123', text: 'Hola', references: refs }).references, [{ code: 'M1' }]);
  assert.throws(() => parseStoryReferences([{ code: 'M1/../x' }]), /inválida/);
  assert.throws(() => parseStoryReferences('M1'), /hasta 16/);
  assert.throws(() => parseStoryReferences(Array(17).fill({ code: 'M1' })), /hasta 16/);
  assert.deepEqual(parseStoryReferences([{ rawCode: 'P1' }, { rawCode: 'P1' }]), [{ rawCode: 'P1' }]);
});

test('adjuntar valida la carpeta completa sin mutaciones parciales y mantiene material previo', () => fixture(async (store, dir) => {
  const p = await store.create({ title: 'Una', rawFolderId: 'folder-one' });
  const other = await store.create({ title: 'Otra', rawFolderId: 'folder-two' });
  const own = await store.addAsset(p.id, { dataUrl: PNG, name: 'Vieja' });
  const raw = { code: 'P1', folderId: 'folder-one', file: 'ana.png', kind: 'persona', name: 'Ana' };
  await assert.rejects(store.attachReferences(other.id, [{ rawCode: 'P1' }], [raw]), /carpeta/);
  await assert.rejects(store.attachReferences(p.id, [{ rawCode: 'P1' }, { code: 'M999' }], [raw]), /no está/);
  assert.equal((await store.get(p.id)).assets.length, 1);
  const attached = await store.attachReferences(p.id, [{ rawCode: 'P1' }], [raw]);
  assert.equal(attached[0].code, 'M2');
  assert.equal(attached[0].file, 'raw:ana.png');
  assert.equal((await store.get(p.id)).assets[0].file, own.file);
  assert.equal((await store.get(other.id)).assets.length, 0);
  assert.equal((await store.attachReferences(p.id, [{ rawCode: 'P1' }, { code: 'M2' }], [raw])).length, 1);
  attached[0].name = 'Modificado';
  assert.equal((await createStoryStore(dir).get(p.id)).assets[1].name, 'Ana');
}));

test('historias antiguas con 16 imágenes heredadas pueden adjuntar otras sin borrar material previo', () => fixture(async (store) => {
  const p = await store.create({ rawFolderId: 'folder-one' });
  for (let i = 0; i < 16; i++) await store.addAsset(p.id, { dataUrl: PNG, name: `Material ${i}` });
  const refs = await store.attachReferences(p.id, [{ rawCode: 'P1' }], [{ code: 'P1', folderId: 'folder-one', file: 'a.png' }]);
  assert.equal(refs[0].code, 'M17');
  assert.equal((await store.get(p.id)).assets.length, 17);
  assert.equal((await store.attachReferences(p.id, [{ code: 'M16' }])).length, 1);
}));

test('persisten miniaturas por mensaje, el siguiente turno no hereda selección y el Guionista recibe los scopes correctos', () => fixture(async (store, dir) => {
  const p = await store.create({ title: 'Historia' });
  const a = await store.addAsset(p.id, { dataUrl: PNG, name: 'Ana' });
  const b = await store.addAsset(p.id, { dataUrl: PNG, name: 'Bosque' });
  await store.mutate(p.id, (d) => { d.story = { titulo: 'Previa' }; d.shots = [{ id: 'S1', refs: [b.code], frame: { file: 'frame.png' }, approved: true, video: { file: 'video.mp4' } }]; });
  const requests = [], events = [];
  const llm = async (opts) => { requests.push(structuredClone(opts.messages)); return llmReply(); };
  const run = (references, text) => runStoryTurn({ store, jobs: jobs(store), input: { projectId: p.id, text, answers: [], references }, config: { storyModel: 'test' }, emit: (e) => events.push(e), llm });
  const refs = await store.attachReferences(p.id, [{ code: a.code }]);
  await run(refs, 'Esta persona');
  await store.renameAsset(p.id, a.code, 'Ana nueva');
  await run([], 'Otro turno');
  const fresh = await createStoryStore(dir).get(p.id);
  assert.equal(fresh.chat[0].references[0].name, 'Ana');
  assert.equal(fresh.chat[0].references[0].file, a.file);
  assert.deepEqual(fresh.chat[2].references, []);
  assert.equal(fresh.shots[0].video.file, 'video.mp4');
  assert.equal(fresh.shots[0].approved, true);
  const textParts = requests[0].at(-1).content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  assert.match(textParts, /Referencias explícitas de ESTE mensaje\n- M1: foto "Ana"/);
  assert.match(textParts, /Material previo.*NO selección actual/);
  assert.equal(requests[0].at(-1).content.filter((c) => c.type === 'image_url').length, 2);
  assert.match(requests[1].at(-1).content[0].text, /Este mensaje no adjunta imágenes/);
  assert.match(requests[1].find((m) => m.role === 'user' && typeof m.content === 'string').content, /M1 \(Ana\)/);
  assert.equal(events.filter((e) => e.type === 'story_user').length, 2);
  await store.deleteAsset(p.id, a.code);
  assert.equal((await createStoryStore(dir).get(p.id)).chat[0].references[0].file, a.file);
  assert.match(await store.dataUrl(a.file), /^data:image\/png/);
}));

test('el mensaje y sus referencias sobreviven a un error del Guionista', () => fixture(async (store, dir) => {
  const p = await store.create({});
  const a = await store.addAsset(p.id, { dataUrl: PNG });
  await assert.rejects(runStoryTurn({ store, jobs: jobs(store), input: { projectId: p.id, text: 'Hola', answers: [], references: [{ code: a.code }] },
    config: { storyModel: 'test' }, emit() {}, llm: async () => { throw new Error('Proveedor no disponible'); } }), /Proveedor/);
  const fresh = await createStoryStore(dir).get(p.id);
  assert.equal(fresh.chat.length, 1);
  assert.equal(fresh.chat[0].references[0].file, a.file);
}));

test('un archivo previo ausente no borra sus asociaciones ni bloquea un nuevo mensaje', () => fixture(async (store) => {
  const p = await store.create({});
  const a = await store.addAsset(p.id, { dataUrl: PNG, name: 'Anterior' });
  await rm(path.join(store.filesDir, a.file));
  const events = [];
  await runStoryTurn({ store, jobs: jobs(store), input: { projectId: p.id, text: 'Continuá', answers: [], references: [] },
    config: { storyModel: 'test' }, emit: (e) => events.push(e), llm: llmReply });
  assert.equal((await store.get(p.id)).assets[0].code, a.code);
  assert.match(events.find((e) => e.type === 'notice').text, /ya no está disponible/);
}));

test('el material Raw heredado no ocupa el cupo de nuevas fotos o cuadros de video subidos', () => fixture(async (store) => {
  const p = await store.create({ rawFolderId: 'folder-one' });
  const raws = Array.from({ length: 16 }, (_, i) => ({ code: `P${i + 1}`, folderId: 'folder-one', file: `${i}.png` }));
  await store.attachReferences(p.id, raws.map((a) => ({ rawCode: a.code })), raws);
  const frame = await store.addAsset(p.id, { dataUrl: PNG, source: 'video' });
  assert.equal(frame.code, 'M17');
  assert.equal((await store.get(p.id)).assets.length, 17);
}));
