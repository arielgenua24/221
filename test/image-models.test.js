import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { imageRequest, parseImageGenerator } from '../src/image-models.js';
import { createRawStore } from '../src/raw-store.js';
import { runRawTurn, runRawGeneration, parseRawTurnBody } from '../src/raw-agent.js';
import { createStoryStore } from '../src/story-store.js';
import { createStoryJobs, sanitizeShot } from '../src/story-pipeline.js';
import { parseVoiceBody, createVoiceSessions } from '../src/voice-session.js';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
async function temp(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'image-models-'));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}
const until = async (get) => {
  for (let n = 0; n < 200; n++) { const value = await get(); if (value) return value; await new Promise((r) => setTimeout(r, 5)); }
  throw new Error('El trabajo no terminó.');
};
test('Seedream usa sus rutas edit/text-to-image y resolution; GPT conserva su modelo y quality', () => {
  const options = { prompt: 'p', images: ['https://image.test/1.png'], aspect: '9:16', model: 'custom-gpt/edit', quality: 'high' };
  assert.deepEqual(imageRequest(options), { model: 'custom-gpt/edit', body: { prompt: 'p', images: options.images, aspect_ratio: '9:16', output_format: 'jpeg', quality: 'high' } });
  const seed = imageRequest({ ...options, generator: 'seedream' });
  assert.equal(seed.model, 'bytedance/seedream-v5.0-pro/edit'); assert.equal(seed.body.resolution, process.env.SEEDREAM_RESOLUTION || '1k'); assert.ok(!('quality' in seed.body));
  const text = imageRequest({ ...options, images: [], generator: 'seedream' });
  assert.equal(text.model, 'bytedance/seedream-v5.0-pro'); assert.ok(!('images' in text.body));
  assert.throws(() => parseImageGenerator('arbitrary/model'), /inválido/);
  assert.equal(parseRawTurnBody({ folderId: 'id', text: 'x', imageGenerator: 'seedream' }).imageGenerator, 'seedream');
  assert.equal(parseVoiceBody({ kind: 'raw', id: 'project-123', text: 'x', imageGenerator: 'seedream' }).imageGenerator, 'seedream');
});
test('RAW envía referencias y proporción a Seedream y guarda el resultado en la misma carpeta', () => temp(async (dir) => {
  const store = createRawStore(dir), folder = await store.createFolder({ name: 'Seedream' });
  const asset = await store.addAsset({ folderId: folder.id, kind: 'persona', dataUrl: PNG });
  let request, plan;
  const log = await runRawTurn({ store, input: parseRawTurnBody({ folderId: folder.id, text: 'Editá este retrato.', imageGenerator: 'seedream', aspect: '3:4' }),
    config: { rawModel: 'vision', imageModel: 'original/edit', imageQuality: 'high' }, emit() {},
    llm: async () => ({ text: '```json\n{"decir":"Dale.","generar":{"entradas":["P1"],"prompt":"Edit portrait"}}\n```' }),
    propose: async (p) => { plan = { ...p, id: 'proposal-123' }; return { id: plan.id }; },
  });
  assert.equal(request, undefined);
  await runRawGeneration({ store, plan, emit() {}, ws: { upload: async () => 'https://image.test/person.png', image: async (opts) => { request = opts; return { file: asset.file }; } } });
  assert.equal(request.model, 'bytedance/seedream-v5.0-pro/edit'); assert.deepEqual(request.body.images, ['https://image.test/person.png']);
  assert.equal(request.body.aspect_ratio, '3:4'); assert.ok(!('quality' in request.body));
  assert.equal(log.proposal.id, 'proposal-123'); assert.equal((await store.assetsFor(folder.id)).at(-1).kind, 'generada');
}));
test('Historia persiste el selector y un trabajo mantiene Seedream para cuadro y plancha aunque cambie la selección', () => temp(async (dir) => {
  const store = createStoryStore(dir), p = await store.create({ title: 'Seedream', aspect: '9:16', imageGenerator: 'seedream' });
  const asset = await store.addAsset(p.id, { dataUrl: PNG, name: 'Ana', source: 'foto' });
  const shot = sanitizeShot({ id: 'S1', titulo: 'Retrato', refs: [asset.code], prompt_cuadro: 'Portrait' }, new Set([asset.code]));
  await store.mutate(p.id, (d) => { d.shots = [{ ...shot, frame: { status: 'idle' }, video: { status: 'idle' } }]; });
  assert.equal((await createStoryStore(dir).get(p.id)).imageGenerator, 'seedream');
  const requests = [];
  const jobs = createStoryJobs({ store, config: { frameModel: 'original/t2i', frameEditModel: 'original/edit', frameQuality: 'high' }, llm: () => { throw new Error('No necesita un agente'); },
    ws: { upload: async () => 'https://image.test/ref.png', image: async (opts) => {
      requests.push(opts); opts.onStatus?.({ status: 'processing', elapsed: 1 });
      if (requests.length === 1) await store.update(p.id, { imageGenerator: 'gpt-image' });
      return { file: asset.file };
    } },
  });
  await jobs.frames(p.id);
  const done = await until(async () => { const project = await jobs.view(p.id); return !project.busy && project; });
  assert.equal(done.shots[0].frame.status, 'done'); assert.equal(done.shots[0].storyboard.status, 'done');
  assert.equal(requests.length, 2); assert.ok(requests.every((r) => r.model === 'bytedance/seedream-v5.0-pro/edit' && !('quality' in r.body)));
  assert.equal(requests[1].body.aspect_ratio, '16:9');
  assert.equal(done.imageGenerator, 'gpt-image'); assert.equal(done.shots[0].frame.model, 'bytedance/seedream-v5.0-pro/edit');
  await assert.rejects(store.update(p.id, { imageGenerator: 'bad/model' }), /inválido/);
}));
test('el trabajo en segundo plano de GPT Audio recibe el generador elegido en el turno', () => temp(async (dir) => {
  let calls = 0, workInput;
  const service = createVoiceSessions({ dir, context: async () => ({ info: {}, history: [] }), remember: async () => {},
    work: async (input) => { workInput = input; return 'G1 lista.'; },
    chat: async (opts) => {
      if (!calls++) return { content: '', toolCalls: [{ id: 'work1', type: 'function', function: { name: 'work_on_project', arguments: '{"request":"Generá el retrato."}' } }] };
      opts.onAudio('AAAAAA=='); opts.onTranscript('Dale.'); return { content: '', toolCalls: [] };
    },
  });
  const input = parseVoiceBody({ kind: 'raw', id: 'project-123', text: 'Generá el retrato.', imageGenerator: 'seedream' });
  await service.turn(input, () => {}, new AbortController().signal);
  await until(async () => {
    const saved = JSON.parse(await readFile(path.join(dir, 'raw-project-123.json')));
    return (await service.jobs(input))[0]?.status === 'done' && saved.jobs[0]?.status === 'done';
  });
  assert.equal(workInput.imageGenerator, 'seedream');
}));
