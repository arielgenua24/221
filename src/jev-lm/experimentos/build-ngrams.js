// Genera ../data/ngrams.json.gz: bigramas y trigramas del español a partir de las oraciones de Tatoeba (CC-BY 2.0 FR).
//   curl -LO https://downloads.tatoeba.org/exports/per_language/spa/spa_sentences.tsv.bz2 && bunzip2 spa_sentences.tsv.bz2
//   node src/jev-lm/experimentos/build-ngrams.js spa_sentences.tsv
// Solo se guardan sucesores que existen en el corpus limpio (o signos), así el filtro nunca propone basura.
import { readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { loadCorpus, PUNCT } from '../corpus.js';
import { tokenize, START } from './ngram.js';

const SRC = process.argv[2];
if (!SRC) throw new Error('Uso: node src/jev-lm/experimentos/build-ngrams.js <spa_sentences.tsv>');

const vocab = new Set([...loadCorpus(Infinity), ...PUNCT]);
const bi = new Map();
const tri = new Map();
const bump = (map, ctx, next) => {
  let m = map.get(ctx);
  if (!m) map.set(ctx, (m = new Map()));
  m.set(next, (m.get(next) ?? 0) + 1);
};

let sentences = 0;
for (const line of readFileSync(SRC, 'utf8').split('\n')) {
  const text = line.split('\t')[2];
  if (!text) continue;
  sentences += 1;
  const toks = [START, START, ...tokenize(text)];
  for (let i = 2; i < toks.length; i++) {
    if (!vocab.has(toks[i])) continue;
    bump(bi, toks[i - 1], toks[i]);
    bump(tri, `${toks[i - 2]} ${toks[i - 1]}`, toks[i]);
  }
}

// Sucesores ordenados por frecuencia; los trigramas vistos una sola vez son casi todos ruido.
const pack = (map, min) => Object.fromEntries([...map]
  .map(([ctx, m]) => [ctx, [...m].filter(([, c]) => c >= min).sort((a, b) => b[1] - a[1]).map(([w]) => w)])
  .filter(([, list]) => list.length));
const data = { source: 'Tatoeba spa_sentences', sentences, bigrams: pack(bi, 1), trigrams: pack(tri, 2) };
const out = gzipSync(JSON.stringify(data));
writeFileSync(new URL('../data/ngrams.json.gz', import.meta.url), out);
console.log(`${sentences} oraciones · ${Object.keys(data.bigrams).length} contextos de 1 · ${Object.keys(data.trigrams).length} de 2 · ${(out.length / 1e6).toFixed(1)} MB`);
