// Banco de pruebas de JEV habla: oraciones incompletas con respuestas aceptables (bench.json).
//   node --env-file-if-exists=.env src/jev-lm/bench.js [--words 5000] [--corpus limpio|crudo] [--order mezcla|frecuencia]
//     [--keep auto|N] [--framing hueco|continuar] [--no-punct] [--ngram] [--rerank 10] [--limit N] [--label nombre] [--mock]
// Métricas:
//   top-1      la elegida es aceptable (después de reclasificar, si --rerank).
//   torneo     la ganadora de la ronda final (antes de reclasificar) es aceptable.
//   top-5      alguna aceptable está entre las 5 más probables de la ronda final.
//   llegó      alguna aceptable llegó a la ronda final (mide cuánto pierde el torneo por el camino).
//   alcanzable alguna aceptable está en el corpus (el techo del experimento con ese corpus).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { decide, mockDecide, JEV_MODEL } from '../objects3d/jev.js';
import { loadCorpus, PUNCT } from './corpus.js';
import { nextWordPlus } from './experimentos/index.js';

const { values } = parseArgs({
  options: {
    words: { type: 'string', default: '5000' },
    corpus: { type: 'string', default: 'limpio' },
    order: { type: 'string', default: 'mezcla' },
    keep: { type: 'string', default: 'auto' },
    framing: { type: 'string', default: 'hueco' },
    'no-punct': { type: 'boolean', default: false },
    ngram: { type: 'boolean', default: false },
    rerank: { type: 'string', default: '0' },
    limit: { type: 'string', default: '0' },
    parallel: { type: 'string', default: '3' },
    label: { type: 'string', default: '' },
    mock: { type: 'boolean', default: false },
  },
});

const mock = values.mock || !process.env.TYPESAFE_API_KEY;
const ask = ({ state, questions }) => (mock
  ? mockDecide({ model: JEV_MODEL, questions })
  : decide({ apiKey: process.env.TYPESAFE_API_KEY, state, questions }));

const items = JSON.parse(readFileSync(new URL('./bench.json', import.meta.url), 'utf8'))
  .slice(0, Number(values.limit) || undefined);
const words = loadCorpus(Number(values.words), { source: values.corpus });
const punct = !values['no-punct'];
const vocab = new Set(punct ? [...PUNCT, ...words] : words);
const keep = values.keep === 'auto' ? 'auto' : Number(values.keep);
const label = values.label || `${values.corpus}·${values.words}·${values.order}·keep ${values.keep}·${values.framing}${punct ? '' : '·sin signos'}${values.ngram ? '·ngram' : ''}${Number(values.rerank) ? `·rerank ${values.rerank}` : ''}`;
console.log(`Banco JEV habla · ${mock ? 'MOCK' : JEV_MODEL} · ${label} · ${items.length} oraciones`);

const results = new Array(items.length);
let next = 0;
let tokens = 0;
const t0 = Date.now();
await Promise.all(Array.from({ length: Number(values.parallel) }, async () => {
  while (next < items.length) {
    const i = next++;
    const { prefix, accept, kind } = items[i];
    const ok = new Set(accept);
    try {
      const r = await nextWordPlus({
        ask, text: prefix, words, keep, order: values.order, framing: values.framing, punct, seed: i + 1, penalty: 0, target: 0,
        ngram: values.ngram, rerankTop: Number(values.rerank),
      });
      const top5 = r.distribution.slice(0, 5).map(([w]) => w);
      results[i] = {
        prefix, kind, accept, word: r.word,
        top1: ok.has(r.word), tournament: ok.has(r.choice), top5: top5.some((w) => ok.has(w)),
        reached: r.finalists.some((w) => ok.has(w)), reachable: accept.some((w) => vocab.has(w)),
        top: r.distribution.slice(0, 5), finalists: r.finalists.length,
        tokens: r.rounds.reduce((n, x) => n + x.usage.input_tokens, 0), pool: r.ngram?.size ?? words.length,
        rerank: r.rerank ? r.rerank.distribution.slice(0, 5) : undefined,
      };
      tokens += results[i].tokens;
      const mark = results[i].top1 ? '✓' : results[i].top5 ? '~' : '✗';
      const changed = r.rerank && r.rerank.before !== r.word ? ` (torneo: ${r.rerank.before})` : '';
      console.log(`  ${mark} ${prefix} → ${r.word}${changed}   [${top5.join(' · ')}]${results[i].reached ? '' : '  (ninguna aceptable llegó a la final)'}`);
    } catch (err) {
      results[i] = { prefix, kind, accept, error: err.message };
      console.log(`  ! ${prefix} → ${err.message}`);
    }
  }
}));

const done = results.filter((r) => !r.error);
const rate = (list, key) => (list.length ? `${Math.round((100 * list.filter((r) => r[key]).length) / list.length)}%` : '—');
const summary = { top1: rate(done, 'top1'), tournament: rate(done, 'tournament'), top5: rate(done, 'top5'), reached: rate(done, 'reached'), reachable: rate(done, 'reachable') };
const byKind = Object.fromEntries([...new Set(done.map((r) => r.kind))].map((k) => {
  const list = done.filter((r) => r.kind === k);
  return [k, { n: list.length, top1: rate(list, 'top1'), top5: rate(list, 'top5') }];
}));
console.log(`\n= top-1 ${summary.top1} · torneo ${summary.tournament} · top-5 ${summary.top5} · llegó a la final ${summary.reached} · alcanzable ${summary.reachable}`);
for (const [k, v] of Object.entries(byKind)) console.log(`  ${k.padEnd(12)} n=${v.n}  top-1 ${v.top1}  top-5 ${v.top5}`);
console.log(`  ${done.length}/${items.length} sin error · ${tokens.toLocaleString('es-AR')} tokens · ${((Date.now() - t0) / 1000).toFixed(0)} s`);

const dir = new URL('../../runs/jev-lm/', import.meta.url);
mkdirSync(dir, { recursive: true });
const file = new URL(`bench-${new Date().toISOString().replace(/[:.]/g, '-')}.json`, dir);
writeFileSync(file, JSON.stringify({ label, config: { ...values, mock, model: JEV_MODEL }, summary, byKind, tokens, results }, null, 2));
console.log(`Guardado: ${file.pathname}`);
