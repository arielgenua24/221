// Motor canvas (propio): el agente escribe JavaScript plano que dibuja en un <canvas> 2D en función del tiempo.
//   const FONTS = ['Anton', 'Inter:400,800'];                      // opcional
//   const AUDIO = [{ sound: 'sfx1', at: 1.2, volume: 0.6 }];       // opcional
//   const SCENES = [{ from: 0.5, to: 3, draw(t, p) { … } }];       // segundos del video; t local, p de 0 a 1
// Sin React, sin bundle de 2 MB, sin decodificar el video dos veces: arranca al instante y cada cuadro es una función pura de t.
// - compile(): quita tipos (esbuild), valida el contrato y PRUEBA el código en un sandbox (node:vm) con un contexto 2D falso
//   que falla donde falla el de verdad (radios negativos, addColorStop fuera de [0, 1], imágenes que no existen, bucles infinitos).
// - frameDocument(): el iframe del Player (mismo protocolo que el de Remotion).
// - standaloneDocument(): una página suelta con window.seek(t), para renderizar headless (render.js).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { build, transform } from 'esbuild';
import { frameDocument, inline } from '../frame-doc.js';

export const KIT_SOURCE = readFileSync(new URL('./kit.js', import.meta.url), 'utf8');
const FRAME_SOURCE = readFileSync(new URL('./frame.js', import.meta.url), 'utf8');
const kit = (() => { const ctx = vm.createContext({}); vm.runInContext(KIT_SOURCE, ctx); return ctx.CanvasKit; })();
export const FONT_FAMILIES = [...kit.FONT_FAMILIES];
export const HELPER_NAMES = Object.keys(kit.HELPERS);

export const CANVAS_VERSION = 'canvas v1';
const FPS = 30;
const SMOKE_MS = 2000;

// ---------- Código del agente ----------
const FENCE = /```(?:js|javascript|ts|typescript|jsx|tsx)?[ \t]*\r?\n([\s\S]*?)```/g;
const HAS_SCENES = /\b(?:const|let|var)\s+SCENES\b/;

// El último bloque de código con SCENES (los modelos a veces escriben un borrador antes); tolera una respuesta cortada.
export function extractCode(text) {
  const raw = String(text || '');
  const blocks = [...raw.matchAll(FENCE)].map((m) => m[1]).filter((b) => HAS_SCENES.test(b));
  if (blocks.length) return blocks.at(-1).trim();
  const open = raw.lastIndexOf('```');
  if (open >= 0) {
    const tail = raw.slice(open).replace(/^```[a-z]*[ \t]*\r?\n?/, '');
    if (HAS_SCENES.test(tail)) return tail.trim();
  }
  throw new Error('la respuesta no trae un bloque ```js con `const SCENES = [...]`');
}

const FORBIDDEN = [
  [/^\s*import\s|\brequire\s*\(|^\s*export\s/m, 'usa import/export/require: acá no hay módulos. Es un solo archivo de JavaScript plano; los helpers (spring, rng, ease, clamp…) ya están definidos'],
  [/\b(?:document|window|navigator|localStorage|globalThis)\b/, 'toca el DOM o la ventana: el entorno ya te da el contexto `g` del canvas, `W` y `H`. No busques elementos ni crees canvas propios'],
  [/\b(?:requestAnimationFrame|setTimeout|setInterval)\s*\(/, 'maneja su propio reloj: el entorno llama a draw(t) con el tiempo; no programes cuadros ni timers'],
  [/\b(?:fetch|XMLHttpRequest|WebSocket|importScripts)\b/, 'usa la red: no hay red. Las imágenes generadas llegan en `images`'],
  [/\bMath\.random\s*\(/, 'usa Math.random(): cada cuadro tiene que ser determinista; usá rng(semilla) (const r = rng(7); r())'],
  [/\b(?:Date\.now|performance\.now|new Date)\b/, 'usa el reloj del sistema: el tiempo tiene que salir de t (el argumento de draw)'],
];

// Contexto 2D falso para el sandbox: acepta todo, pero falla como el de verdad en lo que el navegador rechaza.
const FAKE_CONTEXT = `
function domError(name, msg) { const e = new Error(msg); e.name = name; return e; }
function gradient() { return { addColorStop(o, c) { if (!(o >= 0 && o <= 1)) throw domError('IndexSizeError', 'addColorStop: el offset ' + o + ' tiene que estar entre 0 y 1'); if (c === undefined || c === null || c === '') throw domError('SyntaxError', 'addColorStop: color inválido (' + c + ')'); } }; }
const noop = () => {};
function fakeContext(W, H) {
  const state = { font: '10px sans-serif', globalAlpha: 1, globalCompositeOperation: 'source-over', fillStyle: '#000000', strokeStyle: '#000000',
    lineWidth: 1, lineCap: 'butt', lineJoin: 'miter', miterLimit: 10, lineDashOffset: 0, textAlign: 'start', textBaseline: 'alphabetic',
    filter: 'none', shadowBlur: 0, shadowColor: 'rgba(0, 0, 0, 0)', shadowOffsetX: 0, shadowOffsetY: 0, imageSmoothingEnabled: true,
    imageSmoothingQuality: 'low', direction: 'ltr', letterSpacing: '0px', wordSpacing: '0px', fontKerning: 'auto' };
  const px = () => Number((/(\\d+(?:\\.\\d+)?)px/.exec(state.font) || [])[1] || 10);
  const data = (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(Math.max(0, Math.min(4e6, Math.round(w) * Math.round(h) * 4))) });
  const api = {
    canvas: { width: W, height: H },
    measureText(text) { const s = px(); const w = String(text).length * s * 0.55; return { width: w, actualBoundingBoxAscent: s * 0.75, actualBoundingBoxDescent: s * 0.2, actualBoundingBoxLeft: 0, actualBoundingBoxRight: w, fontBoundingBoxAscent: s * 0.9, fontBoundingBoxDescent: s * 0.25 }; },
    createLinearGradient: gradient, createConicGradient: gradient,
    createRadialGradient(x0, y0, r0, x1, y1, r1) { if (r0 < 0 || r1 < 0) throw domError('IndexSizeError', 'createRadialGradient: radio negativo (' + r0 + ', ' + r1 + ')'); return gradient(); },
    createPattern(img) { if (img == null) throw new TypeError('createPattern: la imagen es ' + img); return {}; },
    getImageData(x, y, w, h) { if (!w || !h) throw domError('IndexSizeError', 'getImageData: ancho o alto 0'); return data(Math.abs(w), Math.abs(h)); },
    createImageData(w, h) { return typeof w === 'object' ? data(w.width, w.height) : data(Math.abs(w), Math.abs(h)); },
    getTransform() { return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }; },
    getLineDash() { return []; }, isPointInPath() { return false; }, isPointInStroke() { return false; },
    arc(x, y, r) { if (r < 0) throw domError('IndexSizeError', 'arc: radio negativo (' + r + ')'); },
    arcTo(x1, y1, x2, y2, r) { if (r < 0) throw domError('IndexSizeError', 'arcTo: radio negativo (' + r + ')'); },
    ellipse(x, y, rx, ry) { if (rx < 0 || ry < 0) throw domError('IndexSizeError', 'ellipse: radio negativo (' + rx + ', ' + ry + ')'); },
    roundRect(x, y, w, h, r) { const rs = Array.isArray(r) ? r : [r]; if (rs.some((v) => typeof v === 'number' && v < 0)) throw new RangeError('roundRect: radio negativo (' + r + ')'); },
    drawImage(img) { if (img == null) throw new TypeError('drawImage: la imagen es ' + img + ' (¿usás un images.genN que no existe?)'); },
  };
  return new Proxy(api, {
    get(t, k) { return k in state ? state[k] : k in t ? t[k] : noop; },
    set(t, k, v) { state[k] = v; return true; },
  });
}
function Path2D() { return new Proxy({}, { get: (t, k) => (k in t ? t[k] : noop) }); }
`;
// APIs del navegador que el sandbox no tiene: si el código las usa, la prueba no puede opinar (lo prueba el iframe).
const BROWSER_ONLY = /\b(?:OffscreenCanvas|DOMMatrix|ImageData|createImageBitmap|Image|HTMLCanvasElement|CanvasRenderingContext2D|FontFace)\b is not defined/;

// Corre el código contra el contexto falso en cada escena (comienzo, medio, final) y en cada zona. Devuelve null o el error.
export function smokeTest(js, { width = 1080, height = 1920, duration = 15, fps = FPS, zones = [], images = [], sounds = [] } = {}) {
  const ctx = vm.createContext({ console: { log: () => {}, info: () => {}, warn: () => {}, error: () => {} } });
  vm.runInContext(KIT_SOURCE + FAKE_CONTEXT, ctx);
  ctx.__input = JSON.parse(JSON.stringify({ js, W: width, H: height, FPS: fps, DUR: duration, zones, images, sounds }));
  try {
    return vm.runInContext(`(() => {
      const i = __input;
      const g = fakeContext(i.W, i.H);
      const env = {
        g, W: i.W, H: i.H, FPS: i.FPS, DUR: i.DUR,
        zones: i.zones.map((z) => ({ id: z.id, from: z.from / i.FPS, to: (z.from + z.durationInFrames) / i.FPS, prompt: z.prompt, notes: z.notes })),
        images: Object.fromEntries(i.images.map((id) => [id, { width: 1024, height: 1024, naturalWidth: 1024, naturalHeight: 1024 }])),
        sounds: Object.fromEntries(i.sounds.map((id) => [id, { url: 'blob:' + id }])),
      };
      const msg = (e) => (e && e.message ? (e.name && e.name !== 'Error' ? e.name + ': ' : '') + e.message : String(e));
      let layer;
      try { layer = CanvasKit.evaluate(i.js, env); } catch (e) { return 'al cargar el archivo: ' + msg(e); }
      const times = [...new Set([...CanvasKit.sampleTimes(layer), ...env.zones.flatMap((z) => [z.from, (z.from + z.to) / 2, z.to - 1e-3])])];
      for (const t of times) {
        try { CanvasKit.drawAt(layer, g, t); } catch (e) { return 'al dibujar: ' + msg(e); }
      }
      return null;
    })()`, ctx, { timeout: SMOKE_MS });
  } catch (err) {
    if (/timed out/i.test(err.message)) return `al dibujar: un cuadro tarda más de ${SMOKE_MS / 1000} s (¿un bucle infinito o un bucle enorme por cuadro?)`;
    return `al probarlo: ${err.message}`;
  }
}

// Transpila (quita tipos si los hay), valida y prueba. Devuelve { js } o lanza un Error con un mensaje pensado para el modelo.
// `env` (opcional): { width, height, duration, fps, zones (en cuadros), images: ['gen1'], sounds: ['sfx1'] } para la prueba.
export async function compile(source, env = {}) {
  const code = String(source || '');
  if (!code.trim()) throw new Error('no hay código');
  if (code.length > 80000) throw new Error('el código es demasiado largo (máx. 80.000 caracteres)');
  let js;
  try {
    js = (await transform(code, { loader: 'ts', target: 'es2022', sourcefile: 'scenes.js', logLevel: 'silent' })).code;
  } catch (err) {
    const first = err.errors?.[0];
    const where = first?.location ? ` (línea ${first.location.line}, columna ${first.location.column + 1}: \`${first.location.lineText.trim().slice(0, 120)}\`)` : '';
    throw new Error(`error de sintaxis: ${first?.text || err.message}${where}`);
  }
  // Sobre el JS ya transpilado: sin comentarios (un "// window" en un comentario no cuenta). Los import/export, sobre el
  // original: esbuild borra los imports que no se usan y el modelo tiene que enterarse igual de que no hay módulos.
  for (const [re, why] of FORBIDDEN) if (re.test(re === FORBIDDEN[0][0] ? code : js)) throw new Error(why);
  if (!HAS_SCENES.test(js)) throw new Error('falta `const SCENES = [{ from, to, draw(t, p) { … } }]` (from y to en segundos del video)');
  const failure = smokeTest(js, env);
  if (failure && !BROWSER_ONLY.test(failure)) throw new Error(`el código compila pero falla ${failure}`);
  return { js };
}

// mediabunny (WebCodecs: decodificar el video y codificar el render cuadro a cuadro), empaquetado para el iframe
// como window.CanvasMedia. Se arma una vez (esbuild) y queda en memoria; si falla, el iframe graba en tiempo real.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MEDIA_EXPORTS = ['Input', 'BlobSource', 'ALL_FORMATS', 'Output', 'BufferTarget', 'Mp4OutputFormat', 'WebMOutputFormat', 'CanvasSource', 'CanvasSink', 'AudioBufferSink', 'AudioBufferSource', 'canEncodeVideo', 'canEncodeAudio', 'QUALITY_HIGH'];
let media = null;
export function buildMedia() {
  media ??= build({
    stdin: { contents: `export { ${MEDIA_EXPORTS.join(', ')} } from 'mediabunny';`, resolveDir: ROOT, loader: 'js', sourcefile: 'canvas-media-entry.js' },
    bundle: true, format: 'iife', globalName: 'CanvasMedia', platform: 'browser', target: 'es2022', minify: true, write: false, legalComments: 'none', logLevel: 'silent',
  }).then((r) => r.outputFiles[0].text).catch((err) => { media = null; throw err; });
  return media;
}

let doc = null;
export const canvasEngine = {
  id: 'canvas',
  label: 'Motor propio (canvas)',
  version: CANVAS_VERSION,
  fps: FPS,
  fence: 'js',
  marker: /\bSCENES\b/,
  words: {
    player: 'the Canvas player',
    shapes: '(shapes, strokes, and Path2D on the canvas)',
    imageWith: 'with `g.drawImage(images.gen1, …)` or `drawFit(g, images.gen1, x, y, w, h)`',
    imageTag: 'g.drawImage(images.gen1, …)',
    imageUse: (id) => `g.drawImage(images.${id}, …) (or drawFit(g, images.${id}, x, y, w, h))`,
    imageReady: (id) => `g.drawImage(images.${id}, …) or drawFit(g, images.${id}, x, y, w, h) (already available in images)`,
    imageCtx: '`images.gen1` with `g.drawImage` or `drawFit`',
    soundTag: "const AUDIO = [{ sound: 'sfx1', at: <video second>, volume: 0.6 }]",
    soundUse: (id) => `const AUDIO = [{ sound: '${id}', at: <segundo del golpe>, volume: 0.6 }] en el segundo del movimiento que acompañan`,
    soundTool: "const AUDIO = [{ sound: 'sfx1', at: <video second>, volume: … }] at the exact time of the movement it accompanies",
    soundReady: (id) => `const AUDIO = [{ sound: '${id}', at: <video second>, volume: 0.6 }] at the time of the movement it accompanies`,
    soundCtx: "`const AUDIO = [{ sound: 'sfx1', at: <video second>, volume: 0.6 }]` at the exact time of the movement it accompanies",
  },
  extractCode,
  compile,
  frameDocument() {
    doc ??= buildMedia().catch(() => '').then((m) => frameDocument([m, KIT_SOURCE, FRAME_SOURCE].filter(Boolean), { style: FRAME_STYLE }));
    return doc;
  },
};

// (.lab-frame-error trae display: grid, que le gana al atributo hidden: sin esta regla tapa el escenario.)
const FRAME_STYLE = `
  .lab-frame-error[hidden] { display: none; }
  .cv-wrap { position: absolute; inset: 0; display: grid; place-items: center; }
  .cv-stage { position: relative; overflow: hidden; background: #000; cursor: pointer; }
  .cv-video, .cv-fill, .cv-layer { position: absolute; inset: 0; width: 100%; height: 100%; }
  .cv-video, .cv-fill { object-fit: cover; }
  .cv-ai, .cv-motion { position: absolute; inset: 0; pointer-events: none; }
  .cv-bar { position: absolute; left: 0; right: 0; bottom: 0; display: flex; gap: 8px; align-items: center; padding: 8px 10px;
    background: linear-gradient(transparent, rgba(0, 0, 0, .7)); opacity: 1; transition: opacity .2s; }
  .cv-playing .cv-bar { opacity: 0; }
  body:hover .cv-bar { opacity: 1; }
  .cv-bar button { background: none; border: 0; color: inherit; font: inherit; font-size: 15px; cursor: pointer; padding: 2px 4px; }
  .cv-seek { flex: 1; accent-color: #f4f1ea; }
  .cv-time { font-variant-numeric: tabular-nums; font-size: 12px; opacity: .85; }`;

// ---------- Página suelta (headless) ----------
// La misma animación como página propia: <canvas> + window.seek(t) (+ window.ready, que espera fuentes e imágenes).
// background: color de fondo (por defecto transparente: la capa se compone después sobre el video con ffmpeg).
export function standaloneDocument({ js, width, height, duration, fps = FPS, zones = [], images = {}, background = null }) {
  const input = { js, W: width, H: height, FPS: fps, DUR: duration, zones, images, background };
  return `<!doctype html>
<html lang="es">
<head><meta charset="utf-8"><style>html,body{margin:0;background:${background || 'transparent'}}canvas{display:block}</style></head>
<body>
<canvas id="c" width="${width}" height="${height}"></canvas>
<script>${inline(KIT_SOURCE)}</script>
<script>
(() => {
  const i = ${inline(JSON.stringify(input))};
  const g = document.getElementById('c').getContext('2d');
  window.ready = (async () => {
    const images = {};
    for (const [id, src] of Object.entries(i.images)) { const img = new Image(); await new Promise((r) => { img.onload = r; img.onerror = r; img.src = src; }); images[id] = img; }
    const zones = i.zones.map((z) => ({ id: z.id, from: z.from / i.FPS, to: (z.from + z.durationInFrames) / i.FPS, prompt: z.prompt, notes: z.notes }));
    const layer = CanvasKit.evaluate(i.js, { g, W: i.W, H: i.H, FPS: i.FPS, DUR: i.DUR, zones, images, sounds: {} });
    for (const f of layer.fonts) {
      const l = document.createElement('link');
      l.rel = 'stylesheet';
      l.href = 'https://fonts.googleapis.com/css2?family=' + f.family.replace(/ /g, '+') + ':wght@' + [...f.weights].sort((a, b) => a - b).join(';') + '&display=block';
      document.head.append(l);
      await new Promise((r) => { l.onload = r; l.onerror = r; });
      await Promise.all(f.weights.map((w) => document.fonts.load(w + ' 48px "' + f.family + '"').catch(() => {})));
    }
    const draw = (t) => {
      CanvasKit.drawAt(layer, g, t);
      if (i.background) { g.save(); g.globalCompositeOperation = 'destination-over'; g.fillStyle = i.background; g.fillRect(0, 0, i.W, i.H); g.restore(); }
    };
    window.seek = (t) => { draw(t); return true; };
    // Vista previa en un navegador normal; apagada en el render headless.
    if (!navigator.webdriver) {
      const t0 = performance.now();
      (function loop() { draw(((performance.now() - t0) / 1000) % i.DUR); requestAnimationFrame(loop); })();
    }
    return { scenes: layer.scenes.length, audio: layer.audio };
  })();
})();
</script>
</body>
</html>`;
}
