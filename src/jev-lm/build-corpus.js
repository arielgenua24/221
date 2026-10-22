// Genera data/es_clean.txt: la lista de frecuencias de subtítulos (es_50k) filtrada contra un diccionario español,
// para sacar nombres propios, inglés y faltas de ortografía ("nothing", "john", "bién", "qúe").
//   npm pack an-array-of-spanish-words@2.0.0 && tar xzf an-array-of-spanish-words-2.0.0.tgz
//   node src/jev-lm/build-corpus.js package/index.json
// El diccionario (636.000 formas, MIT) no trae tildes (salvo la ñ) ni pronombres enclíticos, por eso se compara
// sin tildes, se despegan hasta dos pronombres ("dígaselo" → "diga") y se descartan tildes imposibles.
import { readFileSync, writeFileSync } from 'node:fs';

const DICT = process.argv[2];
if (!DICT) throw new Error('Uso: node src/jev-lm/build-corpus.js <an-array-of-spanish-words/index.json>');

const dict = new Set(JSON.parse(readFileSync(DICT, 'utf8')));
const WORD = /^[a-záéíóúüñ]+$/;
const SINGLE = new Set(['a', 'e', 'o', 'u', 'y']);
const CLITIC = /(me|te|se|lo|la|le|los|las|les|nos|os)$/;
// Monosílabos que sí llevan tilde (diacrítica).
const MONO = new Set(['sí', 'tú', 'él', 'mí', 'té', 'sé', 'dé', 'más', 'qué', 'cuál', 'quién', 'cuán', 'aún']);
const strip = (w) => w.replace(/[áéíóúü]/g, (c) => ({ á: 'a', é: 'e', í: 'i', ó: 'o', ú: 'u', ü: 'u' }[c]));
// Sílabas aproximadas: í/ú con tilde rompen el diptongo ("dí-a"), el resto de vocales seguidas cuenta como una.
const syllables = (w) => (w.match(/[íú]|[aeiouáéóü]+/g) || []).length;

export function isSpanish(w) {
  if (!WORD.test(w)) return false;
  if (w.length === 1) return SINGLE.has(w);
  const accents = (w.replace(/mente$/, '').match(/[áéíóú]/g) || []).length;
  if (accents > 1) return false;
  if (accents && syllables(w) <= 1 && !MONO.has(w)) return false; // "bién", "tí"
  if (/[qg]ú[ei]/.test(w)) return false; // "qúe"
  let base = strip(w);
  if (dict.has(base)) return true;
  for (let i = 0; i < 2; i++) {
    const m = CLITIC.exec(base);
    if (!m || base.length - m[0].length < 2) break;
    base = base.slice(0, -m[0].length);
    if (dict.has(base)) return true;
  }
  return false;
}

const src = new URL('./data/es_50k.txt', import.meta.url);
const lines = readFileSync(src, 'utf8').split('\n').filter((l) => isSpanish(l.split(' ')[0]));
writeFileSync(new URL('./data/es_clean.txt', import.meta.url), `${lines.join('\n')}\n`);
console.log(`es_clean.txt: ${lines.length} palabras`);
