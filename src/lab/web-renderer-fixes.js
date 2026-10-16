// Arreglos a @remotion/web-renderer (el que convierte la animación a video en el navegador).
// Ese renderizador no usa el motor del navegador: recorre el DOM y redibuja cada elemento en un canvas
// con su propio intérprete de CSS, y le faltan cosas que los agentes usan todo el tiempo en HUDs y tarjetas.
// Lo que se veía bien en el Player salía distinto en el video descargado:
//   · background-color + gradiente en el mismo elemento → solo dibujaba el gradiente: el panel salía transparente.
//   · varias capas de fondo, repeating-linear-gradient, background-size/repeat (scanlines, grillas) → una sola capa estirada.
//   · clip-path con calc() (polygon(0 0, calc(100% - 14px) 0, …)) → puntos NaN: la forma y su texto salían recortados.
//   · box-shadow inset → no se dibujaba; los glows salían cortados y sin spread (y backdrop-filter no existía).
// Se parchea el código fuente del paquete al empaquetar el runtime del iframe (src/lab/runtime.js).
// Cada reemplazo exige encontrar su texto exacto: si una versión nueva de Remotion lo cambia, el build falla
// con el nombre del parche en vez de dejar un render roto sin avisar.

const FILE = /@remotion[\\/]web-renderer[\\/]dist[\\/]esm[\\/]index\.mjs$/;

// Funciones que se agregan al módulo (usan las suyas: getBackgroundFill, parseDirection, drawRoundedRectPath…).
const HELPERS = String.raw`
// ---- arreglos del Laboratorio (src/lab/web-renderer-fixes.js) ----
var __labSplit = (value, sep) => {
  const out = [];
  let depth = 0, cur = "";
  for (const ch of String(value)) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (depth === 0 && (sep === " " ? /\s/.test(ch) : ch === sep)) {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
};
// calc() con px y % (lo que devuelve getComputedStyle): se reemplaza cada término y se evalúa la aritmética.
var __labCalc = (value, reference) => {
  const expr = value.replace(/^calc/i, "").replace(/(-?\d*\.?\d+(?:e[+-]?\d+)?)(%|px)?/gi, (_, n, unit) => unit === "%" ? "(" + n + "*" + reference + "/100)" : "(" + n + ")");
  if (!/^[\d\s.+\-*/()e]+$/i.test(expr)) return NaN;
  try { return Number(Function("return " + expr)()); } catch { return NaN; }
};
var __labLength = (token, reference) => {
  if (/^calc\(/i.test(token)) return __labCalc(token, reference);
  if (token.endsWith("%")) return parseFloat(token) / 100 * reference;
  return parseFloat(token);
};
// repeating-linear-gradient: un gradiente de canvas con las paradas repetidas a lo largo de toda la línea.
var __labRepeatingGradient = (ctx, image, rect, offsetLeft, offsetTop) => {
  const m = /^repeating-linear-gradient\((.*)\)$/is.exec(image.trim());
  if (!m) return null;
  const parts = __labSplit(m[1], ",");
  let angle = 180;
  if (parts.length && (parts[0].startsWith("to ") || /^-?\d+\.?\d*(deg|rad|grad|turn)$/.test(parts[0]))) angle = parseDirection(parts.shift());
  const angleRad = (angle - 90) * Math.PI / 180;
  const cos = Math.cos(angleRad), sin = Math.sin(angleRad);
  const L = Math.abs(cos) * rect.width + Math.abs(sin) * rect.height || Math.hypot(rect.width, rect.height);
  const stops = [];
  for (const part of parts) {
    const tokens = __labSplit(part, " ");
    const lengths = tokens.filter((t) => /^(-?\d*\.?\d+(px|%)?|calc\(.*\))$/i.test(t));
    const color = tokens.filter((t) => !lengths.includes(t)).join(" ");
    if (!color) continue;
    if (!lengths.length) stops.push({ color, pos: null });
    for (const l of lengths) stops.push({ color, pos: __labLength(l, L) });
  }
  if (stops.length < 2) return null;
  if (stops[0].pos === null) stops[0].pos = 0;
  if (stops.at(-1).pos === null) stops.at(-1).pos = L;
  for (let i = 1, last = 0; i < stops.length; i++) {
    if (stops[i].pos === null) continue;
    const gap = i - last;
    for (let j = last + 1; j < i; j++) stops[j].pos = stops[last].pos + (stops[i].pos - stops[last].pos) * (j - last) / gap;
    last = i;
  }
  for (let i = 1; i < stops.length; i++) stops[i].pos = Math.max(stops[i].pos, stops[i - 1].pos);
  const first = stops[0].pos, period = stops.at(-1).pos - first;
  if (!(period > 0.01)) return null;
  const kFrom = Math.floor(-first / period), kTo = Math.ceil((L - first) / period);
  if ((kTo - kFrom) * stops.length > 20000) return null;
  const sA = first + kFrom * period, sB = first + kTo * period;
  const cx = rect.left - offsetLeft + rect.width / 2, cy = rect.top - offsetTop + rect.height / 2;
  const at = (s) => [cx + cos * (s - L / 2), cy + sin * (s - L / 2)];
  const gradient = ctx.createLinearGradient(...at(sA), ...at(sB));
  for (let k = kFrom; k < kTo; k++) {
    for (const s of stops) gradient.addColorStop(Math.min(1, Math.max(0, (s.pos + (k - kFrom) * period) / (sB - sA))), s.color);
  }
  return gradient;
};
var __labRepeat = (value) => {
  const [x, y = x] = String(value || "repeat").trim().split(/\s+/);
  if (value === "repeat-x") return "repeat-x";
  if (value === "repeat-y") return "repeat-y";
  const rx = x !== "no-repeat", ry = y !== "no-repeat";
  return rx && ry ? "repeat" : rx ? "repeat-x" : ry ? "repeat-y" : "no-repeat";
};
// Todas las capas de un fondo, de abajo hacia arriba: el color primero y después cada imagen (la primera de la lista va arriba).
var __labBackgroundFills = ({ backgroundImage, backgroundColor, computedStyle, contextToDraw, boundingRect, offsetLeft, offsetTop }) => {
  const fills = [];
  if (backgroundColor && backgroundColor !== "transparent" && !isColorTransparent(backgroundColor)) fills.push(backgroundColor);
  if (!backgroundImage || backgroundImage === "none") return fills;
  const images = __labSplit(backgroundImage, ",");
  const sizes = __labSplit(computedStyle.backgroundSize || "auto", ",");
  const positions = __labSplit(computedStyle.backgroundPosition || "0% 0%", ",");
  const repeats = __labSplit(computedStyle.backgroundRepeat || "repeat", ",");
  for (let i = images.length - 1; i >= 0; i--) {
    const image = images[i];
    const size = sizes[i % sizes.length], position = positions[i % positions.length], repeat = __labRepeat(repeats[i % repeats.length]);
    const rect = getBackgroundImageRect({ backgroundPosition: position, backgroundSize: size, positioningArea: boundingRect });
    if (rect.width < 0.5 || rect.height < 0.5) continue;
    const tiled = Math.abs(rect.width - boundingRect.width) > 0.5 || Math.abs(rect.height - boundingRect.height) > 0.5;
    const paint = (ctx, area, ox, oy) => /^repeating-linear-gradient\(/i.test(image)
      ? __labRepeatingGradient(ctx, image, area, ox, oy)
      : getBackgroundFill({ backgroundImage: image, backgroundColor: null, backgroundPosition: "0% 0%", backgroundSize: "100% 100%", contextToDraw: ctx, boundingRect: area, offsetLeft: ox, offsetTop: oy });
    if (!tiled) {
      const fill = paint(contextToDraw, rect, offsetLeft, offsetTop);
      if (fill) fills.push(fill);
      continue;
    }
    // Una baldosa del tamaño de background-size, repetida como diga background-repeat.
    const tile = new OffscreenCanvas(Math.max(1, Math.ceil(rect.width)), Math.max(1, Math.ceil(rect.height)));
    const tctx = tile.getContext("2d");
    const area = new DOMRect(0, 0, rect.width, rect.height);
    const fill = paint(tctx, area, 0, 0);
    if (!fill) continue;
    tctx.fillStyle = fill;
    tctx.fillRect(0, 0, rect.width, rect.height);
    const pattern = contextToDraw.createPattern(tile, repeat);
    if (!pattern) continue;
    pattern.setTransform(new DOMMatrix().translate(rect.left - offsetLeft, rect.top - offsetTop).scale(rect.width / tile.width, rect.height / tile.height));
    fills.push(pattern);
  }
  return fills;
};
// box-shadow de afuera (glows): con el spread y el blur completo (el original cortaba la sombra en el radio del blur).
var __labOuterShadows = ({ ctx, rect, borderRadius, computedStyle }) => {
  const value = computedStyle.boxShadow;
  if (!value || value === "none") return;
  for (const raw of __labSplit(value, ",").reverse()) {
    if (/\binset\b/i.test(raw)) continue;
    const { color, x, y, blur, spread } = __labShadow(raw);
    const pad = Math.ceil(blur * 2 + Math.max(0, spread) + 2);
    const W = Math.ceil(rect.width + pad * 2 + Math.abs(x)), H = Math.ceil(rect.height + pad * 2 + Math.abs(y));
    const ox = pad + Math.max(0, -x), oy = pad + Math.max(0, -y);
    const layer = new OffscreenCanvas(W, H);
    const l = layer.getContext("2d");
    const FAR = 100000;
    const r = (c) => Math.max(0, Math.min(c.horizontal, c.vertical) + spread);
    l.shadowColor = color;
    l.shadowBlur = blur;
    l.shadowOffsetX = x + FAR;
    l.shadowOffsetY = y;
    l.fillStyle = "#000";
    l.beginPath();
    l.roundRect(ox - spread - FAR, oy - spread, Math.max(0, rect.width + spread * 2), Math.max(0, rect.height + spread * 2), [r(borderRadius.topLeft), r(borderRadius.topRight), r(borderRadius.bottomRight), r(borderRadius.bottomLeft)]);
    l.fill();
    l.shadowColor = "transparent";
    l.globalCompositeOperation = "destination-out";
    drawRoundedRectPath({ ctx: l, x: ox, y: oy, width: rect.width, height: rect.height, borderRadius });
    l.fill();
    ctx.drawImage(layer, rect.left - ox, rect.top - oy);
  }
};
var __labShadow = (raw) => {
  const color = (raw.match(/(rgba?\([^)]+\)|hsla?\([^)]+\)|#[0-9a-f]{3,8})/i) || [])[0] || "rgba(0, 0, 0, 0.5)";
  const [x = 0, y = 0, blur = 0, spread = 0] = (raw.replace(color, "").replace(/\binset\b/i, "").match(/-?\d*\.?\d+/g) || []).map(Number);
  return { color, x, y, blur: Math.max(0, blur), spread };
};
// box-shadow inset: la sombra de un marco por fuera del borde, recortada al interior del elemento (va encima del fondo).
var __labInsetShadows = ({ ctx, rect, borderRadius, computedStyle }) => {
  const value = computedStyle.boxShadow;
  if (!value || value === "none" || !/\binset\b/i.test(value)) return;
  for (const raw of __labSplit(value, ",").reverse()) {
    if (!/\binset\b/i.test(raw)) continue;
    const { color, x, y, blur, spread } = __labShadow(raw);
    const pad = Math.abs(x) + Math.abs(y) + blur * 2 + Math.abs(spread) + 20;
    const inner = new Path2D();
    const r = (c) => Math.max(0, Math.min(c.horizontal, c.vertical) - spread);
    inner.roundRect(rect.left + x + spread, rect.top + y + spread, Math.max(0, rect.width - spread * 2), Math.max(0, rect.height - spread * 2),
      [r(borderRadius.topLeft), r(borderRadius.topRight), r(borderRadius.bottomRight), r(borderRadius.bottomLeft)]);
    const frame = new Path2D();
    frame.rect(rect.left - pad, rect.top - pad, rect.width + pad * 2, rect.height + pad * 2);
    frame.addPath(inner);
    ctx.save();
    drawRoundedRectPath({ ctx, x: rect.left, y: rect.top, width: rect.width, height: rect.height, borderRadius });
    ctx.clip();
    const scale = Math.hypot(ctx.getTransform().a, ctx.getTransform().b) || 1;
    ctx.shadowColor = color;
    ctx.shadowBlur = blur * scale;
    ctx.fillStyle = color;
    ctx.fill(frame, "evenodd");
    ctx.restore();
  }
};
// backdrop-filter: lo ya dibujado detrás del elemento, filtrado (blur, brightness…) y recortado a su forma.
var __labBackdrop = ({ ctx, rect, borderRadius, computedStyle }) => {
  const filter = computedStyle.backdropFilter || computedStyle.webkitBackdropFilter;
  if (!filter || filter === "none" || !ctx.canvas) return;
  const snapshot = new OffscreenCanvas(ctx.canvas.width, ctx.canvas.height);
  snapshot.getContext("2d").drawImage(ctx.canvas, 0, 0);
  ctx.save();
  drawRoundedRectPath({ ctx, x: rect.left, y: rect.top, width: rect.width, height: rect.height, borderRadius });
  ctx.clip();
  ctx.setTransform(new DOMMatrix());
  ctx.filter = filter;
  ctx.drawImage(snapshot, 0, 0);
  ctx.restore();
};
`;

// [nombre, texto original, reemplazo]
const PATCHES = [
  ['clip-path: calc() en las longitudes',
    'function resolveLength(value, reference) {\n  value = value.trim();\n',
    'function resolveLength(value, reference) {\n  value = value.trim();\n  if (/^calc\\(/i.test(value)) {\n    return __labCalc(value, reference);\n  }\n'],
  ['fondo: color + todas las capas',
    `    const backgroundFill = getBackgroundFill({
      backgroundImage,
      backgroundPosition: computedStyle.backgroundPosition,
      backgroundSize: computedStyle.backgroundSize,
      backgroundColor,
      contextToDraw,
      boundingRect,
      offsetLeft,
      offsetTop
    });
    if (!backgroundFill) {
      return;
    }
    const originalFillStyle = contextToDraw.fillStyle;
    contextToDraw.fillStyle = backgroundFill;
    contextToDraw.fillRect(boundingRect.left - offsetLeft, boundingRect.top - offsetTop, boundingRect.width, boundingRect.height);
    contextToDraw.fillStyle = originalFillStyle;`,
    `    const backgroundFills = backgroundClip.includes("text") ? [getBackgroundFill({
      backgroundImage,
      backgroundPosition: computedStyle.backgroundPosition,
      backgroundSize: computedStyle.backgroundSize,
      backgroundColor,
      contextToDraw,
      boundingRect,
      offsetLeft,
      offsetTop
    })].filter(Boolean) : __labBackgroundFills({ backgroundImage, backgroundColor, computedStyle, contextToDraw, boundingRect, offsetLeft, offsetTop });
    const originalFillStyle = contextToDraw.fillStyle;
    for (const backgroundFill of backgroundFills) {
      contextToDraw.fillStyle = backgroundFill;
      contextToDraw.fillRect(boundingRect.left - offsetLeft, boundingRect.top - offsetTop, boundingRect.width, boundingRect.height);
    }
    contextToDraw.fillStyle = originalFillStyle;`],
  ['box-shadow: glows completos y con spread (los inset se dibujan después del fondo)',
    `  const shadows = parseBoxShadow(computedStyle.boxShadow);
  if (shadows.length === 0) {
    return;
  }`,
    `  __labOuterShadows({ ctx, rect, borderRadius, computedStyle });
  const shadows = [];
  if (shadows.length === 0) {
    return;
  }`],
  ['backdrop-filter + box-shadow inset en drawElement',
    `  await drawBackground({
    backgroundImage,
    context,
    rect,
    backgroundColor,
    backgroundClip,
    element,
    logLevel,
    internalState,
    computedStyle,
    offsetLeft: parentRect.left,
    offsetTop: parentRect.top,
    scale
  });
  await draw(`,
    `  __labBackdrop({ ctx: context, rect, borderRadius, computedStyle });
  await drawBackground({
    backgroundImage,
    context,
    rect,
    backgroundColor,
    backgroundClip,
    element,
    logLevel,
    internalState,
    computedStyle,
    offsetLeft: parentRect.left,
    offsetTop: parentRect.top,
    scale
  });
  __labInsetShadows({ ctx: context, rect, borderRadius, computedStyle });
  await draw(`],
];

export function patchWebRenderer(source) {
  let out = source;
  for (const [name, from, to] of PATCHES) {
    if (out.split(from).length !== 2) throw new Error(`web-renderer-fixes: no se encontró el código para «${name}» (¿cambió la versión de @remotion/web-renderer?)`);
    out = out.replace(from, () => to);
  }
  // clip-path: separar por espacios y comas sin cortar adentro de calc(…).
  const start = out.indexOf('function resolveLength(');
  const end = out.indexOf('function setClipPath(');
  if (start < 0 || end < start) throw new Error('web-renderer-fixes: no se encontró el parser de clip-path');
  const clip = out.slice(start, end).replaceAll('.split(/\\s+/)', '.split(/\\s+(?![^(]*\\))/)').replace('args.split(",")', 'args.split(/,(?![^(]*\\))/)');
  return out.slice(0, start) + clip + out.slice(end) + HELPERS;
}

// Plugin de esbuild: aplica los arreglos al cargar el paquete.
export const webRendererFixes = {
  name: 'lab-web-renderer-fixes',
  setup(b) {
    b.onLoad({ filter: FILE }, async ({ path }) => {
      const { readFile } = await import('node:fs/promises');
      return { contents: patchWebRenderer(await readFile(path, 'utf8')), loader: 'js' };
    });
  },
};
