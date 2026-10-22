// Experimentos sobre el torneo base (../generate.js), activables por separado:
//   ngram   filtro de n-gramas de Tatoeba antes del torneo (ngram.js).
//   rerank  reclasificar las N más probables como oraciones completas (rerank.js); 0 = apagado.
import { nextWord, COMMON } from '../generate.js';
import { ngramPool } from './ngram.js';
import { rerank } from './rerank.js';

export async function nextWordPlus({ ngram = false, rerankTop = 0, ...args }) {
  const pool = ngram ? ngramPool(args.text, args.words) : null;
  let step = await nextWord({ ...args, words: pool ? pool.words : args.words });
  if (rerankTop > 0) {
    step = await rerank({
      ask: args.ask, text: args.text, step, top: rerankTop, generated: args.generated,
      penalty: args.penalty, common: new Set(args.words.slice(0, COMMON)),
    });
  }
  return pool ? { ...step, ngram: { source: pool.source, size: pool.words.length } } : step;
}
