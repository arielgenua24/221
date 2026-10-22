// "JEV como LLM": JEV no genera texto, pero elige entre opciones con probabilidades.
// Para predecir la próxima palabra hacemos un torneo sobre el corpus (+ signos de puntuación):
//   1. el corpus se baraja y se parte en bloques de ≤255 opciones (el máximo de un choice);
//   2. cada bloque es una pregunta choice → pasan las más probables de cada uno. Con keep 'auto' pasan
//      floor(255 / bloques), así la ronda siguiente se llena hasta 255 sin desperdiciar lugares;
//   3. las sobrevivientes vuelven a competir hasta quedar en un solo choice final, cuya distribución es la
//      "distribución de la próxima palabra";
//   4. sobre esa distribución se aplica la penalización de repetición y se elige (la más probable o sorteo).
// Ojo: las probabilidades de cada bloque están normalizadas dentro del bloque, no son comparables entre
// bloques; por eso la ronda final vuelve a preguntar en vez de ordenar por probabilidad.
import { chunk, join, PUNCT, ENDS, isPunct } from './corpus.js';

export const MAX_OPTIONS = 255;
// Palabras que se repiten de forma natural ("de", "la", "que"…) y no se penalizan: las más frecuentes.
export const COMMON = 150;

// Dos formas de preguntar. 'hueco' muestra la oración con el hueco y pide gramática; 'continuar' es la original.
export const FRAMINGS = {
  hueco: {
    state: (text) => ({ oracion: `${text} ___` }),
    instructions: 'La `oracion` está incompleta y termina en un hueco (___). ¿Qué palabra o signo de puntuación va en el hueco, '
      + 'inmediatamente después del texto, para que siga siendo español correcto y natural? No hace falta que termine la '
      + 'oración: elegí solo lo que va justo ahí. Si la oración ya está completa, elegí el signo que la cierra.',
  },
  continuar: {
    state: (text) => ({ texto: text }),
    instructions: 'En `texto` está el comienzo de una oración en español. ¿Qué palabra la continúa de forma más natural? '
      + 'Elegí exactamente una de las opciones. Si la oración ya está completa, elegí el signo que la cierra.',
  },
};

const sortDesc = (probabilities) => Object.entries(probabilities).sort((a, b) => b[1] - a[1]);

// Corre todas las preguntas en llamadas de `batch` preguntas, con `concurrency` llamadas en vuelo.
async function askAll(ask, state, questions, { batch, concurrency }) {
  const entries = Object.entries(questions);
  const groups = [];
  for (let i = 0; i < entries.length; i += batch) groups.push(Object.fromEntries(entries.slice(i, i + batch)));
  const answers = {};
  const usage = { input_tokens: 0, output_tokens: 0, calls: 0 };
  let next = 0;
  const worker = async () => {
    while (next < groups.length) {
      const res = await ask({ state, questions: groups[next++] });
      Object.assign(answers, res.answers);
      usage.input_tokens += res.usage?.input_tokens ?? 0;
      usage.output_tokens += res.usage?.output_tokens ?? 0;
      usage.calls += 1;
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, groups.length) }, worker));
  return { answers, usage };
}

const choiceQuestion = (words, framing) => ({
  type: 'choice',
  instructions: FRAMINGS[framing].instructions,
  criteria: Object.fromEntries(words.map((w) => [w, null])),
});

// Una ronda del torneo: devuelve las palabras que sobreviven y el detalle por bloque.
async function round(ask, state, words, opts, { order, seed }) {
  const blocks = chunk(words, MAX_OPTIONS, { order, seed });
  const keep = opts.keep === 'auto' ? Math.max(1, Math.floor(MAX_OPTIONS / blocks.length)) : opts.keep;
  const questions = Object.fromEntries(blocks.map((b, i) => [`b${i}`, choiceQuestion(b, opts.framing)]));
  const { answers, usage } = await askAll(ask, state, questions, opts);
  const detail = blocks.map((b, i) => {
    const a = answers[`b${i}`];
    return { block: i, size: b.length, choice: a?.choice, confidence: a?.confidence, top: sortDesc(a?.probabilities ?? {}).slice(0, keep) };
  });
  const survivors = detail.flatMap((d) => d.top.map(([w]) => w));
  return { blocks: detail, survivors, keep, usage };
}

// Palabras de la oración en curso (desde el último cierre).
export function sentenceWords(text) {
  const tail = text.split(/[.?!]/).at(-1);
  return (tail.match(/[\p{L}]+/gu) ?? []).length;
}

// Factor de largo para los cierres (". ? !"): (palabras / objetivo)², hasta 1. Es la versión suave del
// min_new_tokens de los LLMs: con objetivo 10, cerrar una oración de 5 palabras vale un 25 % de lo que dijo JEV.
export const endFactor = (words, target) => (target > 0 ? Math.min(1, (words / target) ** 2) : 1);

// Penalización de repetición sobre la distribución final (en el espacio de probabilidades, como el
// "repetition penalty" de CTRL): cada aparición previa en lo generado multiplica por e^(-penalty).
// Repetir la palabra inmediatamente anterior o poner dos signos seguidos queda prohibido.
// sentence/target: palabras de la oración en curso y largo objetivo (ver endFactor).
export function penalize(distribution, { generated = [], last, penalty = 1.5, common = new Set(), sentence = 0, target = 0 }) {
  const counts = new Map();
  for (const w of generated) counts.set(w, (counts.get(w) ?? 0) + 1);
  const ending = endFactor(sentence, target);
  const adjusted = distribution.map(([w, p]) => {
    if (w === last || (isPunct(w) && isPunct(last))) return [w, 0];
    if (ENDS.has(w)) return [w, p * ending];
    if (isPunct(w) || common.has(w)) return [w, p];
    return [w, p * Math.exp(-penalty * (counts.get(w) ?? 0))];
  });
  const total = adjusted.reduce((s, [, p]) => s + p, 0) || 1;
  return adjusted.map(([w, p]) => [w, p / total]).sort((a, b) => b[1] - a[1]);
}

export const lastToken = (text) => {
  const t = text.trim();
  return isPunct(t.at(-1)) ? t.at(-1) : t.split(/\s+/).at(-1)?.toLowerCase();
};

// Predice el próximo token para `text` sobre `words` (el corpus ordenado por frecuencia).
//   generated: tokens que ya generó el modelo (para la penalización; el prompt no cuenta).
//   target: largo objetivo de cada oración en palabras; los cierres antes de eso se penalizan (0 = apagado).
export async function nextWord({
  ask, text, words, keep = 'auto', batch = 8, concurrency = 6, order = 'mezcla', seed = 1,
  framing = 'hueco', punct = true, penalty = 1.5, generated = [], target = 10,
  sample = 'greedy', temperature = 1, rand = Math.random,
}) {
  const state = FRAMINGS[framing].state(text);
  const opts = { keep, batch, concurrency, framing };
  const pool = punct ? [...PUNCT, ...words.filter((w) => !isPunct(w))] : words;
  const rounds = [];
  let current = pool;
  let r = 0;
  while (current.length > MAX_OPTIONS) {
    // Solo la primera ronda respeta `order`; las siguientes siempre mezclan (las sobrevivientes vienen
    // agrupadas por bloque de origen).
    const res = await round(ask, state, current, opts, { order: r === 0 ? order : 'mezcla', seed: seed + r });
    rounds.push({ candidates: current.length, keep: res.keep, blocks: res.blocks, usage: res.usage });
    current = res.survivors;
    r += 1;
  }
  // Ronda final: un solo choice con todas las sobrevivientes.
  const { answers, usage } = await askAll(ask, state, { final: choiceQuestion(current, framing) }, opts);
  const final = answers.final;
  const distribution = sortDesc(final.probabilities);
  const adjusted = penalize(distribution, {
    generated, last: generated.at(-1) ?? lastToken(text), penalty, common: new Set(words.slice(0, COMMON)),
    sentence: sentenceWords(text), target,
  });
  const word = sample === 'greedy' ? adjusted[0][0] : sampleFrom(adjusted, temperature, rand);
  rounds.push({ candidates: current.length, final: true, usage });
  return {
    word, choice: final.choice, confidence: final.confidence,
    probability: adjusted.find(([w]) => w === word)?.[1] ?? 0,
    distribution, adjusted, finalists: current, rounds,
  };
}

function sampleFrom(distribution, temperature, rand) {
  const weights = distribution.filter(([, p]) => p > 0).map(([w, p]) => [w, Math.pow(p, 1 / temperature)]);
  const total = weights.reduce((s, [, p]) => s + p, 0);
  let x = rand() * total;
  for (const [w, p] of weights) if ((x -= p) <= 0) return w;
  return weights.at(-1)[0];
}

// Bucle autoregresivo: "El perro" → "El perro ladra" → … hasta `steps` tokens.
//   next: la función que elige cada token (nextWord, o nextWordPlus de experimentos/ con n-gramas y reclasificación).
//   stopAtEnd: cortar al cerrar la oración (". ? !"); si es false sigue con una oración nueva.
export async function generate({ prompt, steps = 10, stopAtEnd = true, onStep, seed = 1, next = nextWord, ...rest }) {
  let text = prompt.trim();
  const generated = [];
  const history = [];
  for (let i = 0; i < steps; i++) {
    const t0 = Date.now();
    const step = await next({ ...rest, seed: seed + i * 7919, text, generated });
    history.push({ step: i + 1, text, ...step, ms: Date.now() - t0 });
    onStep?.(history.at(-1));
    generated.push(step.word);
    text = join(text, step.word);
    if (stopAtEnd && ENDS.has(step.word)) break;
  }
  return { prompt, text, history };
}
