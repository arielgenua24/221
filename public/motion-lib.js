// Runtime del motion design generado por IA (modo ✨ Intuition).
// Lo usan: el worker que dibuja (public/motion-worker.js), el servidor (para validar el código
// y documentarle al modelo qué helpers existen) y los tests. Es la ÚNICA fuente de verdad del contrato.

// ---------- Tipografías permitidas (Google Fonts; si no cargan, se usa la del sistema) ----------
// `weights`: los pesos que se descargan. El modelo solo puede usar estas familias y estos pesos.
export const FONTS = {
  'Inter': { weights: [400, 600, 800], feel: 'neutra, precisa, suiza; texto y UI' },
  'Space Grotesk': { weights: [400, 700], feel: 'geométrica con carácter, tech editorial' },
  'Manrope': { weights: [400, 800], feel: 'moderna, amable, redondeada' },
  'Syne': { weights: [500, 800], feel: 'experimental, ancha, de estudio de diseño' },
  'Unbounded': { weights: [400, 800], feel: 'display ancha y redonda, pop, Y2K' },
  'Archivo Black': { weights: [400], feel: 'grotesca pesadísima, impacto, deportiva' },
  'Anton': { weights: [400], feel: 'condensada alta, titulares de afiche' },
  'Bebas Neue': { weights: [400], feel: 'condensada en mayúsculas, cartelería' },
  'Playfair Display': { weights: [400, 700], italic: true, feel: 'serif de alto contraste, moda, editorial' },
  'Instrument Serif': { weights: [400], italic: true, feel: 'serif fina y elegante, editorial contemporánea' },
  'DM Serif Display': { weights: [400], feel: 'serif display cálida, clásica' },
  'Fraunces': { weights: [400, 700], feel: 'serif "wonky" con personalidad, cálida' },
  'JetBrains Mono': { weights: [400, 700], feel: 'monoespaciada, datos, código, HUD' },
  'Caveat': { weights: [400, 700], feel: 'manuscrita rápida, anotaciones a mano' },
};

// Pila CSS de una familia con respaldo del sistema.
export function fontStack(family) {
  const f = FONTS[family];
  const fallback = !f ? 'system-ui, sans-serif'
    : /Mono/.test(family) ? 'ui-monospace, monospace'
      : /Serif|Playfair|Fraunces/.test(family) ? 'Georgia, serif'
        : family === 'Caveat' ? 'cursive' : 'system-ui, sans-serif';
  return f ? `"${family}", ${fallback}` : fallback;
}

// URL de Google Fonts (CSS2) para una familia permitida.
export function googleFontsUrl(family) {
  const f = FONTS[family];
  if (!f) return null;
  const name = family.replace(/ /g, '+');
  const axis = f.italic
    ? `ital,wght@${[0, 1].flatMap((i) => f.weights.map((w) => `${i},${w}`)).join(';')}`
    : `wght@${f.weights.join(';')}`;
  return `https://fonts.googleapis.com/css2?family=${name}:${axis}&display=block`;
}

// ---------- Helpers matemáticos ----------
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const lerp = (a, b, t) => a + (b - a) * t;
const invLerp = (a, b, x) => (b === a ? 0 : clamp((x - a) / (b - a)));
const remap = (x, a, b, c, d) => lerp(c, d, invLerp(a, b, x));
// Progreso 0→1 de `t` entre `a` y `b` (en segundos), ya recortado.
const seg = (t, a, b) => invLerp(a, b, t);

const c1 = 1.70158;
const c2 = c1 * 1.525;
const c3 = c1 + 1;
const pow = Math.pow;
const ease = {
  linear: (x) => x,
  inSine: (x) => 1 - Math.cos((x * Math.PI) / 2),
  outSine: (x) => Math.sin((x * Math.PI) / 2),
  inOutSine: (x) => -(Math.cos(Math.PI * x) - 1) / 2,
  inQuad: (x) => x * x,
  outQuad: (x) => 1 - (1 - x) * (1 - x),
  inOutQuad: (x) => (x < 0.5 ? 2 * x * x : 1 - pow(-2 * x + 2, 2) / 2),
  inCubic: (x) => x * x * x,
  outCubic: (x) => 1 - pow(1 - x, 3),
  inOutCubic: (x) => (x < 0.5 ? 4 * x * x * x : 1 - pow(-2 * x + 2, 3) / 2),
  inQuart: (x) => x ** 4,
  outQuart: (x) => 1 - pow(1 - x, 4),
  inOutQuart: (x) => (x < 0.5 ? 8 * x ** 4 : 1 - pow(-2 * x + 2, 4) / 2),
  inQuint: (x) => x ** 5,
  outQuint: (x) => 1 - pow(1 - x, 5),
  inOutQuint: (x) => (x < 0.5 ? 16 * x ** 5 : 1 - pow(-2 * x + 2, 5) / 2),
  inExpo: (x) => (x === 0 ? 0 : pow(2, 10 * x - 10)),
  outExpo: (x) => (x === 1 ? 1 : 1 - pow(2, -10 * x)),
  inOutExpo: (x) => (x === 0 ? 0 : x === 1 ? 1 : x < 0.5 ? pow(2, 20 * x - 10) / 2 : (2 - pow(2, -20 * x + 10)) / 2),
  inCirc: (x) => 1 - Math.sqrt(1 - x * x),
  outCirc: (x) => Math.sqrt(1 - pow(x - 1, 2)),
  inOutCirc: (x) => (x < 0.5 ? (1 - Math.sqrt(1 - pow(2 * x, 2))) / 2 : (Math.sqrt(1 - pow(-2 * x + 2, 2)) + 1) / 2),
  inBack: (x) => c3 * x ** 3 - c1 * x * x,
  outBack: (x) => 1 + c3 * pow(x - 1, 3) + c1 * pow(x - 1, 2),
  inOutBack: (x) => (x < 0.5
    ? (pow(2 * x, 2) * ((c2 + 1) * 2 * x - c2)) / 2
    : (pow(2 * x - 2, 2) * ((c2 + 1) * (x * 2 - 2) + c2) + 2) / 2),
  outElastic: (x) => (x === 0 ? 0 : x === 1 ? 1 : pow(2, -10 * x) * Math.sin((x * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1),
};

// Curva cúbica de Bézier como en CSS/After Effects: bezier(.2,.8,.2,1)(x).
function bezier(x1, y1, x2, y2) {
  const A = (a, b) => 1 - 3 * b + 3 * a;
  const B = (a, b) => 3 * b - 6 * a;
  const C = (a) => 3 * a;
  const calc = (t, a, b) => ((A(a, b) * t + B(a, b)) * t + C(a)) * t;
  const slope = (t, a, b) => 3 * A(a, b) * t * t + 2 * B(a, b) * t + C(a);
  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 8; i++) {
      const s = slope(t, x1, x2);
      if (Math.abs(s) < 1e-6) break;
      t -= (calc(t, x1, x2) - x) / s;
    }
    t = clamp(t);
    return calc(t, y1, y2);
  };
}

// Resorte amortiguado analítico (determinista): 0 → 1 con rebote. `t` en segundos desde que arranca.
function spring(t, { freq = 2.2, damping = 0.55 } = {}) {
  if (t <= 0) return 0;
  const w = 2 * Math.PI * freq;
  const z = clamp(damping, 0.05, 0.999);
  const wd = w * Math.sqrt(1 - z * z);
  return 1 - Math.exp(-z * w * t) * (Math.cos(wd * t) + ((z * w) / wd) * Math.sin(wd * t));
}

// Escalonado: progreso 0→1 del elemento i de n, cuando la animación completa va de `start` a `start+total`
// y cada elemento dura `each` segundos (los arranques se reparten en el resto).
function stagger(t, i, n, { start = 0, each = 0.5, total = 1 } = {}) {
  const gap = n > 1 ? Math.max(0, total - each) / (n - 1) : 0;
  return seg(t, start + i * gap, start + i * gap + each);
}

// Azar determinista (mismo seed → mismo número). Nunca usar Math.random en el código generado.
function rand(seed) {
  let x = Math.sin(seed * 127.1 + 311.7) * 43758.5453123;
  return x - Math.floor(x);
}
// Ruido suave 1D (value noise), en [-1, 1]. Para temblores orgánicos y derivas lentas.
function noise(x, seed = 0) {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  return lerp(rand(i + seed * 57.3), rand(i + 1 + seed * 57.3), u) * 2 - 1;
}

// ---------- Color ----------
function parseHex(hex) {
  let h = String(hex).replace('#', '').trim();
  if (h.length === 3) h = [...h].map((c) => c + c).join('');
  const n = parseInt(h.slice(0, 6), 16);
  return Number.isFinite(n) ? [(n >> 16) & 255, (n >> 8) & 255, n & 255] : [255, 255, 255];
}
// "#rrggbb" + alfa → "rgba(...)".
const rgba = (hex, a = 1) => { const [r, g, b] = parseHex(hex); return `rgba(${r},${g},${b},${clamp(a)})`; };
// Mezcla dos colores hex (t en 0..1) → "rgb(...)".
function mixColor(a, b, t) {
  const A = parseHex(a); const B = parseHex(b);
  return `rgb(${A.map((v, i) => Math.round(lerp(v, B[i], clamp(t)))).join(',')})`;
}

// ---------- Texto ----------
// Fuente CSS para ctx.font: font(800, 64, 'Inter') o font('italic 400', 40, 'Instrument Serif').
const font = (weight, size, family) => `${weight} ${Math.max(1, size).toFixed(2)}px ${fontStack(family)}`;
// Tamaño máximo (px) para que `text` entre en `maxW` (y no pase de `maxSize`).
function fitText(ctx, text, maxW, weight, family, maxSize = 400) {
  ctx.save();
  ctx.font = font(weight, 100, family);
  const w = ctx.measureText(text).width || 1;
  ctx.restore();
  return Math.min(maxSize, (100 * maxW) / w);
}
// Parte un texto en líneas que entren en maxW con la fuente actual de ctx.
function wrap(ctx, text, maxW) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (line && ctx.measureText(test).width > maxW) { lines.push(line); line = w; } else line = test;
  }
  if (line) lines.push(line);
  return lines;
}
// Letras (grafemas) de un texto, respetando tildes y emojis.
const chars = (text) => (typeof Intl !== 'undefined' && Intl.Segmenter
  ? [...new Intl.Segmenter('es', { granularity: 'grapheme' }).segment(String(text))].map((s) => s.segment)
  : [...String(text)]);

export const HELPERS = {
  clamp, lerp, invLerp, remap, seg, ease, bezier, spring, stagger, rand, noise,
  rgba, mixColor, font, fitText, wrap, chars, TAU: Math.PI * 2,
};

// Firma de cada helper, para documentárselo al modelo (los tests verifican que coincidan con HELPERS).
export const HELPER_DOCS = [
  ['clamp(x, a=0, b=1)', 'recorta x entre a y b'],
  ['lerp(a, b, t)', 'interpola de a a b'],
  ['invLerp(a, b, x)', '0→1 según dónde cae x entre a y b (recortado)'],
  ['remap(x, a, b, c, d)', 'lleva x del rango [a,b] al [c,d] (recortado)'],
  ['seg(t, a, b)', 'progreso 0→1 entre los segundos a y b (recortado). La base de todo el timing'],
  ['ease.<curva>(x)', `curvas: ${Object.keys(ease).join(', ')}`],
  ['bezier(x1, y1, x2, y2)', 'devuelve una curva como la de CSS/After Effects, ej. bezier(.2,.8,.2,1)'],
  ['spring(tSeg, { freq=2.2, damping=0.55 })', '0→1 con rebote físico; tSeg = segundos desde que arranca'],
  ['stagger(t, i, n, { start, each, total })', 'progreso 0→1 del elemento i de n en una cascada'],
  ['rand(seed)', 'número 0..1 determinista (NUNCA Math.random)'],
  ['noise(x, seed=0)', 'ruido suave en [-1,1] para derivas y temblores orgánicos'],
  ['rgba(hex, a)', 'color hex con alfa → "rgba(...)"'],
  ['mixColor(hexA, hexB, t)', 'mezcla dos colores'],
  ['font(weight, sizePx, family)', 'string para ctx.font con la pila de respaldo, ej. font(800, 6*u, "Inter")'],
  ['fitText(ctx, text, maxW, weight, family, maxSize)', 'tamaño en px para que el texto entre en maxW'],
  ['wrap(ctx, text, maxW)', 'parte el texto en líneas con la fuente actual de ctx'],
  ['chars(text)', 'letras del texto (respeta tildes y emojis), para animar letra por letra'],
  ['TAU', '2π'],
];

// ---------- Compilación del código generado ----------
// El modelo escribe: `function draw(ctx, t, env) {...}` y opcionalmente `function setup(env, ctx) {...}`.
// Se evalúa con los helpers como variables sueltas (seg, ease, lerp…) y sin acceso al DOM (corre en un worker).
const PARAMS = ['M', ...Object.keys(HELPERS)];
// El bloque { } interno permite que el código declare sus propias constantes aunque se llamen como un helper.
const wrapSource = (code) => `"use strict";\n{\n${code}\n;return { draw: typeof draw === "function" ? draw : null, setup: typeof setup === "function" ? setup : null };\n}`;

// Solo compila (no ejecuta nada): sirve en el servidor para detectar errores de sintaxis.
export function checkMotionCode(code) {
  if (typeof code !== 'string' || !code.trim()) throw new Error('no hay código');
  if (code.length > 60000) throw new Error('el código es demasiado largo (máx. 60.000 caracteres)');
  try {
    // eslint-disable-next-line no-new-func
    new Function(...PARAMS, wrapSource(code));
  } catch (err) {
    throw new Error(`error de sintaxis: ${err.message}`);
  }
  if (!/\bfunction\s+draw\s*\(|\b(?:const|let|var)\s+draw\s*=/.test(code)) throw new Error('falta la función draw(ctx, t, env)');
  if (/\bMath\.random\s*\(/.test(code)) throw new Error('usa Math.random: tiene que usar rand(seed) para que cada cuadro sea siempre igual');
  if (/\b(?:Date\.now|performance\.now|new Date)\b/.test(code)) throw new Error('usa el reloj del sistema: el tiempo tiene que salir solo de t');
}

// Compila y devuelve { draw, setup }. Solo se ejecuta dentro del worker (o en tests con código propio).
export function compileMotion(code) {
  checkMotionCode(code);
  // eslint-disable-next-line no-new-func
  const factory = new Function(...PARAMS, wrapSource(code));
  const out = factory(HELPERS, ...Object.values(HELPERS));
  if (!out.draw) throw new Error('falta la función draw(ctx, t, env)');
  return out;
}

// Arma el `env` que recibe el código: medidas de la ventana, duración, tipografías y paleta del sistema visual.
export function makeEnv({ w, h, dur, fonts = {}, palette = [] }) {
  return {
    w, h, dur,
    u: Math.min(w, h) / 100, // 1u = 1% del lado corto de la ventana: la unidad de todo el diseño
    vw: w / 100, vh: h / 100,
    aspect: w / h,
    fonts: { display: fonts.display || 'Inter', text: fonts.text || fonts.display || 'Inter' },
    palette,
  };
}
