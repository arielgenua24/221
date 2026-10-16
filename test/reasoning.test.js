import test from 'node:test';
import assert from 'node:assert/strict';
import { EFFORTS, reasoningMeta, resolveReasoning } from '../src/lab/reasoning.js';
import { parseLabBody, runLabAgent } from '../src/lab/pipeline.js';
import { parseVariant, contextConfig } from '../src/lab/context.js';

// Entradas reales del catálogo de OpenRouter (/models).
const OPUS = { id: 'anthropic/claude-opus-5.5', reasoning: { mandatory: true, supported_efforts: ['max', 'xhigh', 'high', 'medium', 'low'], default_effort: 'high' } };
const GEMINI = { id: 'google/gemini-3.8-flash', reasoning: { mandatory: true, default_enabled: true, supported_efforts: ['high', 'medium', 'low'], default_effort: 'medium' } };
const DEEPSEEK = { id: 'deepseek/deepseek-v4-flash-vision-exp', reasoning: { mandatory: false, default_enabled: true, supported_efforts: ['max', 'high', 'low'], default_effort: 'high' } };
const OPUS48 = { id: 'anthropic/claude-opus-4.8', reasoning: { mandatory: false, default_enabled: false, supported_efforts: ['max', 'xhigh', 'high', 'medium', 'low'], default_effort: 'high' } };
const NO_LEVELS = { id: 'liquid/lfm-2.5-24b-a2b', reasoning: { mandatory: true } };
const PLAIN = { id: 'anthropic/claude-opus-4.5' };

test('reasoningMeta normaliza el catálogo: niveles de menor a mayor, por defecto, obligatorio', () => {
  assert.deepEqual(reasoningMeta(OPUS), { efforts: ['low', 'medium', 'high', 'xhigh', 'max'], default: 'high', defaultEnabled: true, mandatory: true, maxTokens: false });
  assert.deepEqual(reasoningMeta(GEMINI).efforts, ['low', 'medium', 'high']);
  assert.equal(reasoningMeta(OPUS48).defaultEnabled, false);
  assert.equal(reasoningMeta(OPUS48).mandatory, false);
  assert.deepEqual(reasoningMeta(NO_LEVELS).efforts, []); // razona, pero no deja elegir el nivel
  assert.equal(reasoningMeta(PLAIN), null); // no razona
  assert.deepEqual(reasoningMeta({ reasoning: { supported_efforts: null } }).efforts, EFFORTS.filter((e) => e !== 'none')); // null = todos
});

test('resolveReasoning: pasa el nivel si el modelo lo acepta', () => {
  assert.deepEqual(resolveReasoning('xhigh', reasoningMeta(OPUS)), { param: { effort: 'xhigh' }, effective: 'xhigh', note: null });
  assert.deepEqual(resolveReasoning('', reasoningMeta(OPUS)), { param: undefined, effective: null, note: null }); // el del modelo
  assert.deepEqual(resolveReasoning(null, reasoningMeta(OPUS)).param, undefined);
});

test('resolveReasoning: un nivel que el modelo no acepta va al más cercano que sí (y avisa)', () => {
  const up = resolveReasoning('max', reasoningMeta(GEMINI));
  assert.equal(up.effective, 'high');
  assert.match(up.note, /no acepta «max».*uso «high»/);
  assert.equal(resolveReasoning('minimal', reasoningMeta(GEMINI)).effective, 'low');
  // DeepSeek acepta max, high, low: «medium» está a la misma distancia de low y high → el más bajo.
  assert.equal(resolveReasoning('medium', reasoningMeta(DEEPSEEK)).effective, 'low');
  // «xhigh» queda a la misma distancia de high y max: de nuevo, el más bajo.
  assert.equal(resolveReasoning('xhigh', reasoningMeta(DEEPSEEK)).effective, 'high');
});

test('resolveReasoning: apagar solo si el modelo no exige razonar; sin niveles o sin razonamiento no se manda nada', () => {
  assert.deepEqual(resolveReasoning('none', reasoningMeta(DEEPSEEK)).param, { effort: 'none' });
  const forced = resolveReasoning('none', reasoningMeta(OPUS));
  assert.equal(forced.param, undefined);
  assert.match(forced.note, /no se puede apagar/);
  const flat = resolveReasoning('high', reasoningMeta(NO_LEVELS));
  assert.equal(flat.param, undefined);
  assert.match(flat.note, /no deja elegir el nivel/);
  const plain = resolveReasoning('high', reasoningMeta(PLAIN));
  assert.equal(plain.param, undefined);
  assert.match(plain.note, /no tiene razonamiento ajustable/);
  // Sin catálogo (undefined) se manda tal cual: OpenRouter decide.
  assert.deepEqual(resolveReasoning('high', undefined).param, { effort: 'high' });
});

const IMG = 'data:image/jpeg;base64,/9j/AA==';
const input = (extra = {}) => parseLabBody({
  model: 'anthropic/claude-opus-5.5', video: { name: 'v.mp4', duration: 6, width: 1080, height: 1920 },
  clips: [{ id: 'C1', start: 1, end: 3, prompt: '', notes: '', frames: [{ t: 0.5, url: IMG }], refs: [] }],
  brief: { context: '', instructions: '', refs: [] }, ...extra,
});
const CODE = '```tsx\nexport default function L() { return null; }\n```';

test('parseLabBody y parseVariant aceptan todos los niveles y descartan lo inválido', () => {
  for (const e of EFFORTS) assert.equal(input({ reasoning: e }).reasoning, e);
  assert.equal(input({ reasoning: 'ultra' }).reasoning, null);
  assert.equal(input().reasoning, null);
  assert.equal(parseVariant({ reasoning: 'xhigh' }).reasoning, 'xhigh');
  assert.equal(parseVariant({ reasoning: 'ultra' }).reasoning, null);
});

test('Motion Design: runLabAgent pide a OpenRouter el nivel resuelto para ese modelo', async () => {
  const sent = [];
  const events = [];
  const llm = async (opts) => { sent.push(opts.reasoning); return { text: CODE, usage: {} }; };
  const emit = (e) => events.push(e);
  await runLabAgent({ input: input({ reasoning: 'max' }), emit, llm, config: { reasoningMeta: reasoningMeta(GEMINI) } });
  assert.deepEqual(sent[0], { effort: 'high' });
  assert.equal(events.find((e) => e.type === 'run').reasoning, 'high');
  assert.match(events.find((e) => e.type === 'notice').text, /no acepta «max»/);
  sent.length = 0;
  await runLabAgent({ input: input(), emit, llm });
  assert.equal(sent[0], undefined); // sin pedido, no se manda nada: vale el nivel del modelo
});

test('Context Lab: el nivel de la variante también pasa por el catálogo del modelo', async () => {
  const sent = [];
  const llm = async (opts) => { sent.push(opts.reasoning); return { text: CODE, usage: {} }; };
  const config = contextConfig(parseVariant({ reasoning: 'none' }), {}, reasoningMeta(OPUS));
  await runLabAgent({ input: input(), emit: () => {}, llm, config });
  assert.equal(sent[0], undefined); // Opus siempre razona: no se apaga
  const cfg2 = contextConfig(parseVariant({ reasoning: 'none' }), {}, reasoningMeta(DEEPSEEK));
  await runLabAgent({ input: input(), emit: () => {}, llm, config: cfg2 });
  assert.deepEqual(sent[1], { effort: 'none' });
});

test('el historial separa el mismo modelo según su nivel de razonamiento (y no rompe los registros viejos)', async () => {
  const { newRun, modelStats } = await import('../public/lab-stats.js');
  const done = (model, reasoning, approved) => {
    const r = newRun(model, reasoning);
    r.attempts = [{ ok: true, cost: 0.1, calls: 1, ms: 1000 }];
    r.eval.approved = approved;
    return r;
  };
  const old = { model: 'a/b', attempts: [{ ok: true, cost: 0.1, calls: 1, ms: 1 }], eval: { approved: true } }; // sin campo reasoning
  const stats = modelStats([
    { sides: { A: done('a/b', 'high', true), B: done('a/b', 'max', false) } },
    { sides: { A: done('a/b', 'high', true), B: old } },
  ]);
  assert.equal(stats.length, 3);
  assert.deepEqual(stats.map((s) => [s.model, s.reasoning, s.runs]).sort(), [['a/b', '', 1], ['a/b', 'high', 2], ['a/b', 'max', 1]]);
  assert.equal(newRun('x').reasoning, '');
});
