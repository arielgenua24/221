// Objetos 3D · siluetas con los experimentos de JEV a píxel.
// El recuadro de cada objeto (paso "Destripar") hace de ciclo 1: ya sabemos dónde está, así que cada
// silueta cuesta una llamada (Exp 3 o Exp 4 base) o dos (Exp 4 con refinamiento de bordes).
//   Exp 3: recorte con retícula 16×16 → 256 noul + 4 box → súper-resolución 48–80² en el cliente.
//   Exp 4: recorte → SLIC con IDs impresos → un noul por superpíxel + 4 box → campo unario
//          (→ tiles inciertos ×4 con retícula 4×4) → random walker a píxel exacto (λ ajustable, 0 llamadas).
// Las dos devuelven lo mismo: un campo de probabilidad w×h sobre el recorte `paddedBox` (fracciones del cuadro).
import { prepareCropWithVisualGrid, synthesizeSuperResolution } from './jev-pixel/exp3.js';
import { cropToCanvas, buildUnaryField, TILE_GRID, UNCERTAINTY_BAND, TILE_UPSCALE } from './jev-pixel/exp4.js';
import { computeSlic } from './jev-pixel/slic.js';
import { renderLabeledCrop } from './jev-pixel/label-render.js';
import { solveGraphCut } from './jev-pixel/graph-cut.js';
import { selectUncertainTiles, renderTileForRefinement, mergeRefinement } from './jev-pixel/hierarchical.js';
import { refinementCache, tileHash } from './jev-pixel/cache.js';

const V4_TILE_SUBGRID = 4;
const V4_MAX_REFINE_TILES = 40;

const toDataUrl = (blob) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(r.result); r.onerror = () => reject(new Error('No se pudo leer el recorte.'));
  r.readAsDataURL(blob);
});

async function segment(body, signal) {
  const res = await fetch('/api/lab/objects/segment', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}

const sumUsage = (...us) => us.filter(Boolean).reduce((a, u) => ({ input: a.input + (u.input || 0), output: a.output + (u.output || 0) }), { input: 0, output: 0 });

// Exp 3 dentro del recuadro `box` del cuadro `frame` (canvas).
export async function silhouetteExp3({ frame, box, subject, model, superGrid = 64, edgeAlpha = 0.68, subBoxWeight = 0.55, signal }) {
  const t0 = performance.now();
  const crop = await prepareCropWithVisualGrid(frame, box, 16, true, 0.08);
  const hybrid = await segment({ method: 'hybrid', image: await toDataUrl(crop.apiFile), subject, baseGrid: 16, model }, signal);
  const synthesis = synthesizeSuperResolution({ hybrid, imageData: crop.cleanImageData, superGrid, edgeAlpha, subBoxWeight });
  const prob = new Float32Array(superGrid * superGrid);
  for (const c of synthesis.microCells) prob[c.row * superGrid + c.col] = c.probability;
  URL.revokeObjectURL(crop.cleanPreviewUrl); URL.revokeObjectURL(crop.gridPreviewUrl);
  return {
    method: 'exp3', paddedBox: crop.paddedBox, w: superGrid, h: superGrid, prob,
    subBoxes: hybrid.subBoxes, calls: 1, questions: 16 * 16 + 4, usage: sumUsage(hybrid.usage), ms: performance.now() - t0,
    stats: { superGrid, fgSeeds: synthesis.fgCount, bgSeeds: synthesis.bgCount, refinedBand: synthesis.refinedBandCount },
  };
}

// Exp 4 dentro del recuadro. `resolve(lambda)` vuelve a correr el random walker sin llamar a JEV.
export async function silhouetteExp4({ frame, box, subject, model, k = 400, refine = false, lambda = 50, signal }) {
  const t0 = performance.now();
  const crop = await cropToCanvas(frame, box);
  URL.revokeObjectURL(crop.cleanUrl);
  const slic = computeSlic(crop.imageData, { k, compactness: 10, iterations: 10 });
  const labeled = await renderLabeledCrop(crop.canvas, slic);
  URL.revokeObjectURL(labeled.previewUrl);
  const W = crop.canvas.width, H = crop.canvas.height;
  const centroids = Array.from({ length: slic.k }, (_, i) => [+(slic.centroids[i * 2] / W).toFixed(2), +(slic.centroids[i * 2 + 1] / H).toFixed(2)]);
  const sp = await segment({ method: 'superpixels', image: await toDataUrl(labeled.blob), subject, k: slic.k, centroids, model }, signal);

  // Prior de forma: la caja núcleo de JEV si es confiable; si no, el recuadro original dentro del recorte.
  const pw = Math.max(1e-4, crop.paddedBox.right - crop.paddedBox.left), ph = Math.max(1e-4, crop.paddedBox.bottom - crop.paddedBox.top);
  const inner = {
    left: Math.max(0, (box.left - crop.paddedBox.left) / pw), right: Math.min(1, (box.right - crop.paddedBox.left) / pw),
    top: Math.max(0, (box.top - crop.paddedBox.top) / ph), bottom: Math.min(1, (box.bottom - crop.paddedBox.top) / ph),
  };
  const core = sp.subBoxes.find((b) => b.id === 'sub_core');
  const unaryBase = buildUnaryField(slic, sp.probabilities, crop.imageData, core && core.confidence >= 0.55 ? core.box : inner);

  let unary = unaryBase, refined = null, tiles = [], candidates = 0, cacheHits = 0, calls = 1, questions = slic.k + 4;
  if (refine) {
    const sel = selectUncertainTiles(unaryBase, W, H, { tileGrid: TILE_GRID, band: UNCERTAINTY_BAND, maxTiles: V4_MAX_REFINE_TILES });
    tiles = sel.tiles; candidates = sel.candidateCount;
    const done = [], toSend = [], hashes = new Map();
    for (const t of tiles) {
      const h = tileHash(crop.canvas, t.x, t.y, t.w, t.h);
      hashes.set(t.tileId, h);
      const hit = refinementCache.get(h);
      if (hit) { done.push({ tileId: t.tileId, sub: hit }); cacheHits++; } else toSend.push(t);
    }
    if (toSend.length) {
      const images = await Promise.all(toSend.map(async (t) => ({ tileId: t.tileId, image: await toDataUrl(await renderTileForRefinement(crop.canvas, t, { upscale: TILE_UPSCALE, subGrid: V4_TILE_SUBGRID })) })));
      refined = await segment({ method: 'refine', tiles: images, subject, model }, signal);
      for (const r of refined.tiles) { const h = hashes.get(r.tileId); if (h) refinementCache.set(h, r.sub); }
      done.push(...refined.tiles);
      calls++; questions += toSend.length * V4_TILE_SUBGRID * V4_TILE_SUBGRID;
    }
    unary = mergeRefinement(unaryBase, W, tiles, done, V4_TILE_SUBGRID);
  }

  const out = {
    method: 'exp4', paddedBox: crop.paddedBox, w: W, h: H, prob: null, lambda,
    subBoxes: sp.subBoxes, calls, questions, usage: sumUsage(sp.usage, refined?.usage), ms: 0,
    stats: { k: slic.k, unlabeled: labeled.unlabeledCount, missing: sp.missingAnswers, tiles: tiles.length, candidates, cacheHits },
    // Se guardan para re-resolver con otro λ.
    _imageData: crop.imageData, _unary: unary,
  };
  out.resolve = (l) => { const g = solveGraphCut(out._imageData, out._unary, { lambda: l }); out.prob = g.probability; out.lambda = l; return out; };
  out.resolve(lambda);
  out.ms = performance.now() - t0;
  return out;
}

// ---------- Utilidades sobre el campo de probabilidad ----------

// Máscara binaria (p ≥ umbral) en un canvas w×h del color pedido, lista para dibujar estirada sobre paddedBox.
export function maskCanvas(sil, color, alpha = 0.45, threshold = 0.5) {
  const c = document.createElement('canvas');
  c.width = sil.w; c.height = sil.h;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(sil.w, sil.h);
  const [r, g, b] = hexRgb(color);
  for (let i = 0; i < sil.prob.length; i++) {
    if (sil.prob[i] < threshold) continue;
    img.data[i * 4] = r; img.data[i * 4 + 1] = g; img.data[i * 4 + 2] = b; img.data[i * 4 + 3] = Math.round(255 * alpha);
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

// Borde de la máscara (píxeles dentro con algún vecino fuera): para una superficie pisable, es por donde un personaje se cae.
export function edgeCanvas(sil, color, threshold = 0.5) {
  const { w, h, prob } = sil;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(w, h);
  const [r, g, b] = hexRgb(color);
  let n = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (prob[p] < threshold) continue;
      const out = (q) => prob[q] < threshold;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1 || out(p - 1) || out(p + 1) || out(p - w) || out(p + w)) {
        img.data[p * 4] = r; img.data[p * 4 + 1] = g; img.data[p * 4 + 2] = b; img.data[p * 4 + 3] = 255; n++;
      }
    }
  }
  ctx.putImageData(img, 0, 0);
  return { canvas: c, edgePixels: n };
}

// Área de la silueta como fracción del cuadro entero.
export function frameArea(sil, threshold = 0.5) {
  let on = 0;
  for (const p of sil.prob) if (p >= threshold) on++;
  const boxArea = (sil.paddedBox.right - sil.paddedBox.left) * (sil.paddedBox.bottom - sil.paddedBox.top);
  return (on / sil.prob.length) * boxArea;
}

// Máscara en RLE por filas ([valor inicial, largo, largo, …]) para el mapa de escena exportable.
export function maskRle(sil, threshold = 0.5) {
  const runs = [];
  let cur = sil.prob[0] >= threshold ? 1 : 0, len = 0;
  const first = cur;
  for (const p of sil.prob) {
    const v = p >= threshold ? 1 : 0;
    if (v === cur) len++; else { runs.push(len); cur = v; len = 1; }
  }
  runs.push(len);
  return { start: first, runs };
}

function hexRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
