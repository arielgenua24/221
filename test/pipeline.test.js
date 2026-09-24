import test from 'node:test';
import assert from 'node:assert/strict';
import { runPipeline, extractJson } from '../src/pipeline.js';
import { mockLLM } from '../src/mock.js';

const config = { orchestratorModel: 'o', researcherModel: 'r', criticModel: 'c', researchWeb: true, researcherVision: false };

test('extractJson toma el último bloque json', () => {
  assert.deepEqual(extractJson('notas\n```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('sin bloque {"b":2} fin'), { b: 2 });
});

test('el pipeline completo entrega 4 ideas y oculta el JSON de las notas', async () => {
  const events = [];
  const log = await runPipeline({ text: 'Vendo jeans', photos: [], emit: (e) => events.push(e), llm: mockLLM, config });
  assert.equal(log.result.ideas.length, 4);
  const types = new Set(events.map((e) => e.type));
  for (const t of ['step_start', 'delta', 'step_end', 'brief', 'concepts', 'critique', 'ideas']) assert.ok(types.has(t), t);
  const notes = events.filter((e) => e.type === 'delta').map((e) => e.text).join('');
  assert.ok(!notes.includes('```'), 'las notas no deben incluir el bloque JSON');
  assert.equal(events.filter((e) => e.type === 'step_start' && e.step.startsWith('research-')).length, 3);
});

test('si falla el plugin web, reintenta sin web', async () => {
  const events = [];
  const llm = (opts) => (opts.plugins ? Promise.reject(new Error('web no soportado')) : mockLLM(opts));
  const log = await runPipeline({ text: 'Fletes', photos: [], emit: (e) => events.push(e), llm, config });
  assert.equal(log.result.ideas.length, 4);
  assert.ok(events.some((e) => e.type === 'notice' && /web/i.test(e.text)));
});

test('repara un JSON mal formado con una segunda llamada', async () => {
  let broke = false;
  const llm = async (opts) => {
    if (opts.step === 'critique' && !broke) { broke = true; return { text: 'notas\n```json\n{roto\n```', usage: null }; }
    return mockLLM(opts);
  };
  const log = await runPipeline({ text: 'Fotografía de eventos', photos: [], emit: () => {}, llm, config });
  assert.equal(log.result.ideas.length, 4);
});
