// Experimento: filtro de n-gramas. Antes del torneo, el corpus se reduce a las palabras que alguna vez aparecieron
// después de las dos últimas (trigrama) o de la última (bigrama) en 442.000 oraciones reales de Tatoeba.
// Saca las palabras gramaticalmente imposibles ("El perro de cansa") y, de paso, abarata: en vez de 118 bloques
// suele quedar un pool de cientos de palabras.
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

export const START = '<s>';
const TOKEN = /[a-záéíóúüñ]+|[,.?!;:¿¡]/g;
export const tokenize = (text) => text.toLowerCase().match(TOKEN) ?? [];

let data = null;
const load = () => (data ??= JSON.parse(gunzipSync(readFileSync(new URL('../data/ngrams.json.gz', import.meta.url))).toString('utf8')));

// Contexto de las dos últimas posiciones. Después de un cierre empieza una oración nueva.
function context(text) {
  const toks = [START, START, ...tokenize(text)];
  const ends = ['.', '?', '!'];
  const last = toks.at(-1);
  if (ends.includes(last)) return [START, START];
  return toks.slice(-2);
}

// Devuelve { words, source } con las candidatas permitidas, en el orden de frecuencia del corpus.
//   min: si el trigrama deja menos que esto se suma el bigrama; si aun así no alcanza, se suman las `common`
//   palabras más frecuentes (contexto con pocos datos, como "tengo veinte"). Sin ningún dato no se filtra.
export function ngramPool(text, words, { min = 100, common = 300 } = {}) {
  const { bigrams, trigrams } = load();
  const [a, b] = context(text);
  const allowed = new Set(trigrams[`${a} ${b}`] ?? []);
  let source = 'trigrama';
  if (allowed.size < min) {
    for (const w of bigrams[b] ?? []) allowed.add(w);
    source = 'bigrama';
  }
  if (!allowed.size) return { words, source: 'sin filtro' };
  let pool = words.filter((w) => allowed.has(w));
  if (pool.length < min) {
    const top = new Set(words.slice(0, common));
    pool = words.filter((w) => allowed.has(w) || top.has(w));
    source += ' + comunes';
  }
  return { words: pool, source };
}
