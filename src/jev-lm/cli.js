// node --env-file-if-exists=.env src/jev-lm/cli.js "El perro" [--words 30000] [--steps 10]
//   [--corpus limpio|crudo] [--order mezcla|frecuencia] [--keep auto|N] [--framing hueco|continuar]
//   [--penalty 1.5] [--sample greedy|temp] [--temperature 0.8] [--seguir] [--no-punct] [--excluir a,b]
//   [--ngram] [--rerank 10] [--largo 10] [--seed 1] [--mock]
// --largo: largo objetivo de cada oración; cerrar antes se penaliza (0 = apagado).
// --ngram / --rerank: los experimentos de experimentos/ (filtro de n-gramas y reclasificar por oraciones).
// --seguir: no cortar al cerrar la oración, seguir con otra. Guarda el recorrido en runs/jev-lm/<fecha>.json.
import { mkdirSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { decide, mockDecide, JEV_MODEL } from '../objects3d/jev.js';
import { loadCorpus } from './corpus.js';
import { generate } from './generate.js';
import { nextWordPlus } from './experimentos/index.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    words: { type: 'string', default: '30000' },
    steps: { type: 'string', default: '10' },
    corpus: { type: 'string', default: 'limpio' },
    keep: { type: 'string', default: 'auto' },
    order: { type: 'string', default: 'mezcla' },
    framing: { type: 'string', default: 'hueco' },
    penalty: { type: 'string', default: '1.5' },
    batch: { type: 'string', default: '8' },
    concurrency: { type: 'string', default: '6' },
    sample: { type: 'string', default: 'greedy' },
    temperature: { type: 'string', default: '1' },
    seguir: { type: 'boolean', default: false },
    'no-punct': { type: 'boolean', default: false },
    excluir: { type: 'string', default: '' },
    ngram: { type: 'boolean', default: false },
    rerank: { type: 'string', default: '0' },
    largo: { type: 'string', default: '10' },
    seed: { type: 'string', default: '1' },
    mock: { type: 'boolean', default: false },
  },
});

const prompt = positionals.join(' ') || 'El perro';
const mock = values.mock || !process.env.TYPESAFE_API_KEY;
const ask = ({ state, questions }) => (mock
  ? mockDecide({ model: JEV_MODEL, questions })
  : decide({ apiKey: process.env.TYPESAFE_API_KEY, state, questions }));

const banned = new Set(values.excluir.split(',').map((w) => w.trim()).filter(Boolean));
const words = loadCorpus(Number(values.words), { source: values.corpus }).filter((w) => !banned.has(w));
const keep = values.keep === 'auto' ? 'auto' : Number(values.keep);
console.log(`JEV-LM · ${mock ? 'MOCK' : JEV_MODEL} · ${values.corpus} ${words.length} palabras · ${values.order} · keep ${values.keep} · ${values.framing} · penalización ${values.penalty}${values.ngram ? ' · ngram' : ''}${Number(values.rerank) ? ` · rerank ${values.rerank}` : ''}`);
console.log(`> ${prompt}`);

const t0 = Date.now();
const run = await generate({
  ask, prompt, words, keep, next: nextWordPlus, ngram: values.ngram, rerankTop: Number(values.rerank),
  steps: Number(values.steps), stopAtEnd: !values.seguir, punct: !values['no-punct'],
  order: values.order, framing: values.framing, penalty: Number(values.penalty), target: Number(values.largo), seed: Number(values.seed),
  batch: Number(values.batch), concurrency: Number(values.concurrency),
  sample: values.sample, temperature: Number(values.temperature),
  onStep: (s) => {
    const tokens = s.rounds.reduce((n, r) => n + r.usage.input_tokens, 0);
    const top = (s.rerank?.distribution ?? s.adjusted).slice(0, 5).map(([w, p]) => `${w} ${(p * 100).toFixed(1)}%`).join(' · ');
    const raw = s.choice !== s.word ? `  (torneo: "${s.choice}")` : '';
    const pool = s.ngram ? ` · ${s.ngram.source} ${s.ngram.size}` : '';
    console.log(`  ${s.step}. +"${s.word}"  [${top}]${raw}  ${(s.ms / 1000).toFixed(1)}s · ${tokens} tok${pool}`);
  },
});
console.log(`= ${run.text}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);

const dir = new URL('../../runs/jev-lm/', import.meta.url);
mkdirSync(dir, { recursive: true });
const file = new URL(`${new Date().toISOString().replace(/[:.]/g, '-')}.json`, dir);
writeFileSync(file, JSON.stringify({ config: { ...values, mock, model: JEV_MODEL }, ...run }, null, 2));
console.log(`Guardado: ${file.pathname}`);
