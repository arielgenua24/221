// Corpus del experimento "JEV como LLM": las N palabras más frecuentes del español.
// Fuente: hermitdave/FrequencyWords (subtítulos de OpenSubtitles 2018, es_50k, licencia MIT/CC-BY-SA).
//   'limpio' → data/es_clean.txt, filtrado contra un diccionario (ver build-corpus.js): sin nombres, inglés ni faltas.
//   'crudo'  → data/es_50k.txt, solo sin números ni letras sueltas.
import { readFileSync } from 'node:fs';

const FILES = { limpio: new URL('./data/es_clean.txt', import.meta.url), crudo: new URL('./data/es_50k.txt', import.meta.url) };
const WORD = /^[a-záéíóúüñ]+$/;
// Palabras de una letra que sí existen en español; el resto de letras sueltas es ruido de subtítulos.
const SINGLE = new Set(['a', 'e', 'o', 'u', 'y']);

// Signos que compiten como cualquier palabra. Los de cierre terminan la oración.
export const PUNCT = [',', '.', '?', '!', ';', ':'];
export const END = '.';
export const ENDS = new Set(['.', '?', '!']);
export const isPunct = (w) => PUNCT.includes(w);

const cache = {};

export function loadCorpus(size = 30_000, { source = 'limpio' } = {}) {
  if (!FILES[source]) throw new Error(`Corpus desconocido: ${source}`);
  cache[source] ??= readFileSync(FILES[source], 'utf8').split('\n')
    .map((line) => line.split(' ')[0]?.trim())
    .filter((w) => w && WORD.test(w) && (w.length > 1 || SINGLE.has(w)));
  return cache[source].slice(0, size);
}

// Une una palabra o signo al texto: los signos van pegados y después de un cierre se empieza con mayúscula.
export function join(text, token) {
  if (isPunct(token)) return text + token;
  const capital = ENDS.has(text.trimEnd().at(-1));
  return `${text} ${capital ? token[0].toUpperCase() + token.slice(1) : token}`;
}

// Bloques de `size` palabras. order 'frecuencia' deja juntas las palabras de frecuencia parecida (y todos los
// conectores en el bloque 0); 'mezcla' baraja con una semilla para que cada bloque tenga palabras comunes y raras.
export function chunk(words, size = 255, { order = 'mezcla', seed = 1 } = {}) {
  const list = order === 'mezcla' ? shuffle(words, seed) : words;
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

function shuffle(words, seed) {
  const a = [...words];
  let s = seed >>> 0;
  const rand = () => { // mulberry32
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
