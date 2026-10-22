import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadCorpus, chunk, END } from '../src/jev-lm/corpus.js';
import { nextWord, generate, MAX_OPTIONS } from '../src/jev-lm/generate.js';

// JEV falso que prefiere `favorite` cuando está entre las opciones y si no la primera.
const fakeAsk = (favorite) => {
  const sizes = [];
  const ask = async ({ questions }) => {
    const answers = {};
    for (const [k, q] of Object.entries(questions)) {
      const labels = Object.keys(q.criteria);
      sizes.push(labels.length);
      const pick = labels.includes(favorite) ? favorite : labels[0];
      const probabilities = Object.fromEntries(labels.map((l) => [l, l === pick ? 0.9 : 0.1 / (labels.length - 1)]));
      answers[k] = { type: 'choice', choice: pick, confidence: 0.9, probabilities };
    }
    return { answers, usage: { input_tokens: 10, output_tokens: 0 } };
  };
  return { ask, sizes };
};

test('el corpus filtra ruido y llega a 30.000 palabras', () => {
  const words = loadCorpus(30_000);
  assert.equal(words.length, 30_000);
  assert.ok(words.includes('perro') && words.includes('ladra'));
  assert.ok(words.every((w) => /^[a-záéíóúüñ]+$/.test(w)));
});

test('chunk respeta el máximo y mezcla de forma determinista', () => {
  const words = loadCorpus(1000);
  const a = chunk(words, MAX_OPTIONS, { order: 'mezcla', seed: 7 });
  assert.ok(a.every((b) => b.length <= MAX_OPTIONS));
  assert.deepEqual(a, chunk(words, MAX_OPTIONS, { order: 'mezcla', seed: 7 }));
  assert.equal(a.flat().length, 1000);
});

test('el torneo encuentra la palabra aunque esté en un bloque tardío', async () => {
  const { ask, sizes } = fakeAsk('ladra');
  const words = loadCorpus(30_000);
  const r = await nextWord({ ask, text: 'El perro', words });
  assert.equal(r.word, 'ladra');
  assert.ok(sizes.every((n) => n <= MAX_OPTIONS));
  assert.equal(r.rounds.length, 2); // 118 bloques → 118 ganadoras → una ronda final
});

test('keep > 1 agrega rondas intermedias cuando las sobrevivientes pasan de 255', async () => {
  const { ask, sizes } = fakeAsk('ladra');
  const r = await nextWord({ ask, text: 'El perro', words: loadCorpus(30_000), keep: 3 });
  assert.equal(r.word, 'ladra');
  assert.equal(r.rounds.length, 3);
  assert.ok(sizes.every((n) => n <= MAX_OPTIONS));
});

test('generate encadena el contexto y corta en fin de oración', async () => {
  let n = 0;
  const seq = ['ladra', 'fuerte', END];
  const ask = async ({ questions }) => {
    const answers = {};
    for (const [k, q] of Object.entries(questions)) {
      const labels = Object.keys(q.criteria);
      const want = seq[Math.min(n, seq.length - 1)];
      const pick = labels.includes(want) ? want : labels[0];
      answers[k] = { type: 'choice', choice: pick, confidence: 1, probabilities: { [pick]: 1 } };
      if (k === 'final') n++;
    }
    return { answers, usage: {} };
  };
  const run = await generate({ ask, prompt: 'El perro', words: loadCorpus(30_000), steps: 10 });
  assert.equal(run.text, 'El perro ladra fuerte.');
  assert.deepEqual(run.history.map((h) => h.text), ['El perro', 'El perro ladra', 'El perro ladra fuerte']);
});

test('parseNext valida y completa los valores por defecto', async () => {
  const { parseNext } = await import('../src/jev-lm/routes.js');
  const a = parseNext({ text: '  El perro ' });
  assert.equal(a.text, 'El perro');
  assert.equal(a.size, 30_000);
  assert.equal(a.framing, 'hueco');
  assert.equal(a.keep, 'auto');
  assert.equal(a.rerankTop, 0);
  assert.throws(() => parseNext({ text: '' }), /Escribí/);
  assert.throws(() => parseNext({ text: 'x', words: 10 }), /fuera de rango/);
  assert.throws(() => parseNext({ text: 'x', temperature: 9 }), /temperatura/);
});

test('join pega los signos y pone mayúscula después de un cierre', async () => {
  const { join } = await import('../src/jev-lm/corpus.js');
  assert.equal(join('El perro', 'ladra'), 'El perro ladra');
  assert.equal(join('El perro ladra', '.'), 'El perro ladra.');
  assert.equal(join('El perro ladra.', 'después'), 'El perro ladra. Después');
});

test('el corpus limpio no trae inglés ni faltas, y el torneo incluye los signos', async () => {
  const words = loadCorpus(39_000);
  for (const w of ['nothing', 'other', 'nan', 'bién', 'qúe', 'john']) assert.ok(!words.includes(w), w);
  for (const w of ['día', 'cállate', 'ladra', 'frío']) assert.ok(words.includes(w), w);
  const seen = new Set();
  const ask = async ({ questions }) => {
    const answers = {};
    for (const [k, q] of Object.entries(questions)) {
      const labels = Object.keys(q.criteria);
      labels.forEach((l) => seen.add(l));
      const pick = labels.includes('.') ? '.' : labels[0];
      answers[k] = { type: 'choice', choice: pick, confidence: 1, probabilities: { [pick]: 1 } };
    }
    return { answers, usage: {} };
  };
  const r = await nextWord({ ask, text: 'Te quiero mucho', words: loadCorpus(5000) });
  assert.equal(r.word, '.');
  assert.ok(seen.has(',') && seen.has('?'));
});

test('penalize frena la repetición y prohíbe repetir la palabra anterior', async () => {
  const { penalize } = await import('../src/jev-lm/generate.js');
  const dist = [['cansa', 0.45], ['molesta', 0.05], ['y', 0.04], ['.', 0.03]];
  const once = penalize(dist, { generated: ['cansa', 'mucho'], last: 'mucho', penalty: 1.5 });
  assert.equal(once[0][0], 'cansa'); // una vez sola todavía gana (0.45·e^-1.5 ≈ 0.10)
  const twice = penalize(dist, { generated: ['cansa', 'x', 'cansa'], last: 'x', penalty: 1.5 });
  assert.notEqual(twice[0][0], 'cansa');
  const immediate = penalize(dist, { generated: ['cansa'], last: 'cansa', penalty: 0 });
  assert.equal(immediate.find(([w]) => w === 'cansa')[1], 0);
  const common = penalize([['de', 0.5], ['casa', 0.5]], { generated: ['de', 'de', 'casa'], last: 'casa', penalty: 1.5, common: new Set(['de']) });
  assert.equal(common[0][0], 'de');
});

test('el filtro de n-gramas deja pocas candidatas y conserva las buenas', async () => {
  const { ngramPool } = await import('../src/jev-lm/experimentos/ngram.js');
  const words = loadCorpus(30_000);
  const a = ngramPool('Me llamo Ana y tengo veinte', words);
  assert.ok(a.words.length < 1000 && a.words.includes('años'));
  const b = ngramPool('El perro ladra mucho', words);
  assert.ok(b.words.includes('y') && b.words.includes('cuando') && !b.words.includes('cansa'));
  assert.equal(ngramPool('Xyzzy qwerty', words).source, 'sin filtro');
});

test('rerank pregunta por oraciones completas y elige la mejor', async () => {
  const { nextWordPlus } = await import('../src/jev-lm/experimentos/index.js');
  let sentences = null;
  const ask = async ({ questions }) => {
    const answers = {};
    for (const [k, q] of Object.entries(questions)) {
      const labels = Object.keys(q.criteria);
      if (k === 'mejor') {
        sentences = labels;
        const best = labels.find((l) => l.endsWith(' ladra')) ?? labels[0];
        answers[k] = { type: 'choice', choice: best, confidence: 0.8, probabilities: Object.fromEntries(labels.map((l) => [l, l === best ? 0.8 : 0.2 / (labels.length - 1)])) };
      } else {
        const order = ['es', 'ladra', 'corre'].filter((w) => labels.includes(w));
        const probabilities = Object.fromEntries(labels.map((l) => [l, order.includes(l) ? 0.3 - order.indexOf(l) * 0.1 : 0.001]));
        answers[k] = { type: 'choice', choice: order[0] ?? labels[0], confidence: 0.3, probabilities };
      }
    }
    return { answers, usage: {} };
  };
  const r = await nextWordPlus({ ask, text: 'El perro', words: loadCorpus(30_000), rerankTop: 5, ngram: true });
  assert.equal(r.choice, 'es');
  assert.equal(r.word, 'ladra');
  assert.ok(sentences.includes('El perro ladra') && sentences.includes('El perro es'));
  assert.ok(r.ngram.size < 1000);
});

test('el largo objetivo frena los cierres tempranos y la reclasificación no decide el final', async () => {
  const { penalize, sentenceWords, endFactor } = await import('../src/jev-lm/generate.js');
  assert.equal(sentenceWords('Había una vez. Una princesa hermosa'), 3);
  assert.equal(endFactor(5, 10), 0.25);
  assert.equal(endFactor(12, 10), 1);
  const dist = [['.', 0.4], [',', 0.35], ['que', 0.25]];
  assert.equal(penalize(dist, { sentence: 6, target: 10, penalty: 0 })[0][0], ',');
  assert.equal(penalize(dist, { sentence: 12, target: 10, penalty: 0 })[0][0], '.');

  const { nextWordPlus } = await import('../src/jev-lm/experimentos/index.js');
  let sentences = null;
  const ask = async ({ questions }) => {
    const answers = {};
    for (const [k, q] of Object.entries(questions)) {
      const labels = Object.keys(q.criteria);
      if (k === 'mejor') {
        sentences = labels;
        // Un juez que prefiere lo terminado elegiría el punto si estuviera entre las opciones.
        const best = labels.find((l) => l.endsWith('.')) ?? labels.find((l) => l.endsWith(' que')) ?? labels[0];
        answers[k] = { type: 'choice', choice: best, confidence: 0.9, probabilities: Object.fromEntries(labels.map((l) => [l, l === best ? 0.9 : 0.1 / (labels.length - 1)])) };
      } else {
        const want = { ',': 0.39, '.': 0.1, que: 0.09 };
        const probabilities = Object.fromEntries(labels.map((l) => [l, want[l] ?? 0.0001]));
        answers[k] = { type: 'choice', choice: labels.includes(',') ? ',' : labels[0], confidence: 0.39, probabilities };
      }
    }
    return { answers, usage: {} };
  };
  const r = await nextWordPlus({ ask, text: 'Había una vez una princesa hermosa', words: loadCorpus(2000), rerankTop: 10 });
  assert.ok(!sentences.some((s) => s.endsWith('.')));
  assert.notEqual(r.word, '.');
});
