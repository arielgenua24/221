// Experimento: reclasificar por oraciones. JEV adivina palabras regular pero juzga oraciones bien, así que después
// del torneo se toman las ~10 palabras más probables, se escriben las 10 oraciones que formarían y se le pregunta
// cuál se lee mejor. La elección final sale de esa segunda pregunta.
// Los cierres (". ? !") no se reclasifican: al comparar oraciones enteras JEV prefiere siempre la que se ve
// terminada ("Había una vez una princesa hermosa." le ganaba a la versión con coma 40 % a 5 %). Cuándo terminar lo
// decide el torneo, que juzga el hueco: su probabilidad de cierre se conserva y la reclasificación solo reparte
// el resto entre las palabras.
import { join, ENDS } from '../corpus.js';
import { penalize, lastToken } from '../generate.js';

const INSTRUCTIONS = 'Estas opciones son comienzos de una misma oración en español, que difieren solo en la última palabra, '
  + 'y la oración todavía va a seguir. ¿Cuál es el comienzo más correcto y natural, el que escribiría un hablante nativo?';

// step: resultado de nextWord. Devuelve el paso con la palabra reelegida y el detalle de la reclasificación.
export async function rerank({ ask, text, step, top = 10, generated = [], penalty = 1.5, common = new Set() }) {
  const options = step.adjusted.filter(([w, p]) => p > 0 && !ENDS.has(w)).slice(0, top);
  if (options.length < 2) return step;
  const sentences = new Map(options.map(([w]) => [join(text, w), w]));
  const res = await ask({
    state: {},
    questions: { mejor: { type: 'choice', instructions: INSTRUCTIONS, criteria: Object.fromEntries([...sentences.keys()].map((s) => [s, null])) } },
  });
  const a = res.answers.mejor;
  // Probabilidades por palabra, con la misma penalización de repetición que la ronda final (sin largo: acá no hay cierres).
  const byWord = Object.entries(a.probabilities).map(([s, p]) => [sentences.get(s), p]).filter(([w]) => w);
  const words = penalize(byWord.sort((x, y) => y[1] - x[1]), { generated, last: generated.at(-1) ?? lastToken(text), penalty, common });
  // Mezcla: cierres con la probabilidad del torneo (ya ajustada por largo), palabras con el resto.
  const ends = step.adjusted.filter(([w]) => ENDS.has(w));
  const endMass = ends.reduce((s, [, p]) => s + p, 0);
  const distribution = [...ends, ...words.map(([w, p]) => [w, p * (1 - endMass)])].sort((x, y) => y[1] - x[1]);
  const [word, probability] = distribution[0];
  step.rounds.push({ candidates: options.length, rerank: true, usage: res.usage ?? { input_tokens: 0 } });
  return {
    ...step,
    word,
    probability,
    rerank: { before: step.word, sentences: [...sentences.keys()], distribution },
  };
}
