import test from 'node:test';
import assert from 'node:assert/strict';
import { runPipeline, extractJson } from '../src/pipeline.js';
import { modelList } from '../src/agent.js';
import { mockLLM } from '../src/mock.js';

const config = { orchestratorModel: 'o', researcherModel: 'r', criticModel: 'c', researchWeb: true, researcherVision: false };

test('extractJson toma el último bloque json', () => {
  assert.deepEqual(extractJson('notas\n```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('sin bloque {"b":2} fin'), { b: 2 });
});

test('extractJson rescata un JSON cortado a la mitad', () => {
  // bloque abierto que nunca cierra (la respuesta se quedó sin tokens)
  const cortado = 'notas\n```json\n{"negocio":{"rubro":"jeans","nota":"texto a medi';
  assert.deepEqual(extractJson(cortado), { negocio: { rubro: 'jeans' } });
  // corte justo después de una coma, dentro de un array
  assert.deepEqual(extractJson('```json\n{"ideas":["una","dos",'), { ideas: ['una', 'dos'] });
  // corte con una clave sin valor
  assert.deepEqual(extractJson('{"a":1,"b":'), { a: 1 });
});

test('extractJson avisa en castellano cuando no hay nada que leer', () => {
  assert.throws(() => extractJson(''), /no devolvió texto/);
  assert.throws(() => extractJson('   '), /no devolvió texto/);
  assert.throws(() => extractJson('perdón, no puedo'), /ningún bloque JSON/);
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

test('se pausa en 2 decisiones y las respuestas llegan a los agentes', async () => {
  const asked = [];
  const prompts = {};
  const llm = (opts) => { prompts[opts.step] = JSON.stringify(opts.messages); return mockLLM(opts); };
  const ask = async (d) => {
    asked.push(d.kind);
    if (d.kind === 'brief') {
      assert.ok(d.questions.length > 0);
      return { respuestas: [{ pregunta: d.questions[0].pregunta, respuesta: 'Vender más' }], comentario: 'Somos de Rosario' };
    }
    assert.equal(d.suggested.length, 4);
    assert.ok(d.concepts[0].total >= d.concepts.at(-1).total, 'conceptos ordenados por puntaje');
    return { ids: ['C5', 'C8'], comment: 'más humor' };
  };
  const log = await runPipeline({ text: 'Jeans', photos: [], emit: () => {}, llm, config, ask });
  assert.deepEqual(asked, ['brief', 'pick']);
  assert.match(prompts['research-A'], /Somos de Rosario/);
  assert.match(prompts.ideation, /Vender más/);
  assert.match(prompts.final, /eligió C5, C8/);
  assert.match(prompts.final, /más humor/);
  assert.doesNotMatch(prompts.ideation, /preguntas_al_humano/);
  assert.deepEqual(log.decisions.pick.ids, ['C5', 'C8']);
});

test('si la respuesta viene cortada, reintenta con más presupuesto', async () => {
  const events = [];
  let primera = true;
  const calls = [];
  const llm = async (opts) => {
    calls.push(opts.maxTokens);
    if (opts.step === 'brief' && primera) {
      primera = false;
      return { text: 'notas\n```json\n{"neg', usage: null, finishReason: 'length' };
    }
    return mockLLM(opts);
  };
  const log = await runPipeline({ text: 'Jeans', photos: [], emit: (e) => events.push(e), llm, config });
  assert.equal(log.result.ideas.length, 4);
  assert.ok(events.some((e) => e.type === 'notice' && /se cortó por largo/i.test(e.text)));
  assert.ok(calls[1] > calls[0], 'el reintento pide más tokens');
});

test('si el JSON nunca llega, el error nombra el paso', async () => {
  const llm = async (opts) => (opts.step === 'brief' ? { text: 'no puedo', usage: null } : mockLLM(opts));
  await assert.rejects(
    runPipeline({ text: 'Jeans', photos: [], emit: () => {}, llm, config }),
    /Leyendo tu negocio.*no devolvió un JSON usable/s,
  );
});

test('modelList acepta texto, lista y separadores sueltos', () => {
  assert.deepEqual(modelList('a/b, c/d ,, e/f'), ['a/b', 'c/d', 'e/f']);
  assert.deepEqual(modelList(['a/b', ' c/d ']), ['a/b', 'c/d']);
  assert.deepEqual(modelList(''), []);
});

test('si el primer modelo está saturado, el paso sigue con el siguiente', async () => {
  const usados = [];
  const events = [];
  const llm = async (opts) => {
    usados.push(opts.model);
    if (opts.model === 'saturado') {
      const err = new Error('OpenRouter 429 (saturado): Provider returned error');
      err.transient = true;
      err.streamed = false;
      throw err;
    }
    return mockLLM(opts);
  };
  const log = await runPipeline({
    text: 'Jeans', photos: [], emit: (e) => events.push(e), llm,
    config: { ...config, orchestratorModel: 'saturado,o' },
  });
  assert.equal(log.result.ideas.length, 4);
  assert.equal(usados[0], 'saturado');
  assert.equal(usados[1], 'o');
  assert.equal(log.steps.brief.model, 'o', 'el registro guarda el modelo que sí respondió');
  assert.ok(events.some((e) => e.type === 'notice' && /saturado no pudo responder.*Sigo con o/s.test(e.text)));
  assert.ok(events.some((e) => e.type === 'step_model' && e.model === 'o'));
});

test('si el modelo ya escribió, no se cambia de modelo a mitad de respuesta', async () => {
  const llm = async (opts) => {
    if (opts.step === 'brief') {
      opts.onDelta?.('empecé a escribir');
      const err = new Error('OpenRouter 429 (uno): se cayó el proveedor');
      err.transient = false;
      err.streamed = true;
      throw err;
    }
    return mockLLM(opts);
  };
  await assert.rejects(
    runPipeline({ text: 'Jeans', photos: [], emit: () => {}, llm, config: { ...config, orchestratorModel: 'uno,dos' } }),
    /OpenRouter 429 \(uno\)/,
  );
});
