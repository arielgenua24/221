// Laboratorio Experimento 4 (experiment-four.tsx): segmentación a nivel píxel.
// Ciclo 1 box() → recorte + SLIC con IDs impresos → ciclo 2 un noul por superpíxel + 4 box → (ciclo 3 opcional:
// tiles inciertos ampliados con retícula 4×4) → random walker en cliente (λ en vivo, 0 ciclos extra).
import {
  K_OPTIONS, PRESENT_THRESHOLD, TILE_GRID, UNCERTAINTY_BAND, TILE_UPSCALE,
  prepareFullImage, cropToCanvas, buildUnaryField,
} from '../jev-pixel/exp4.js';
import { computeSlic } from '../jev-pixel/slic.js';
import { renderLabeledCrop } from '../jev-pixel/label-render.js';
import { solveGraphCut } from '../jev-pixel/graph-cut.js';
import { mergeRefinement, renderTileForRefinement, selectUncertainTiles } from '../jev-pixel/hierarchical.js';
import { refinementCache, tileHash } from '../jev-pixel/cache.js';
import { boundaryF1, decodeMaskFile, iou } from '../jev-pixel/metrics.js';
import { el, pct, ms, num, esc, button, segmented, statGrid, range, fileInput, blobToDataUrl, post, samples, textInput, revoke, placeBox, brief, config } from './common.js';

const SAMPLES = ["Woody's hat", "the person's face", 'the main subject', 'any text'];
const V4_MAX_REFINE_TILES = 40;
const V4_TILE_SUBGRID = 4;

async function readJson(step, body, signal, stageName) {
  const { ok, status, data } = await post(step, body, signal);
  if (!ok) throw new Error(`${stageName}: ${data.error ?? `HTTP ${status}`}`);
  return data;
}

function methodologyBrief() {
  return brief({
    title: 'Brief Metodológico · Experimento 4',
    summary: '<strong>Tesis:</strong> la definición a nivel píxel no puede provenir del modelo, cuya resolución perceptual es finita y cuyo costo crece como O(N²) en una grilla uniforme; debe provenir de la imagen misma. El Experimento 4 reemplaza la grilla regular por <em>supervisión semántica dispersa</em> (un <code>noul()</code> por superpíxel SLIC, identificado visualmente por su ID impreso) más <em>inferencia densa en cliente</em> (random walker sobre el grafo de píxeles) y un <em>refinamiento jerárquico</em> opcional restringido a la banda de incertidumbre. El presupuesto de red queda en <strong>2 ciclos</strong> (modo base) o <strong>3 ciclos</strong> (modo refinado), y la salida es una máscara binaria y un mapa de probabilidad a <strong>píxel exacto</strong> sobre el recorte (hasta 768 px de lado). Toda ganancia debe medirse con IoU contra máscara manual: no se estima.',
    cards: [
      ['Método 1 · SLIC + Visual Prompting por IDs', 'Antes del ciclo 2 el navegador segmenta el recorte en K ∈ {256, 400, 600} superpíxeles SLIC en espacio CIELAB (compacidad 10, 10 iteraciones, conectividad forzada). Sobre el canvas se imprimen contornos de doble contraste y el ID numérico de cada región en su centroide. El modelo responde por región que ve, no por coordenadas ciegas. Las regiones ya respetan los bordes físicos, así que la frontera de la máscara hereda precisión de píxel sin aumentar el número de preguntas respecto al Experimento 3.'],
      ['Método 2 · Tomografía Morfológica en el mismo ciclo', 'En la misma llamada <code>systemOne()</code> viajan las 4 primitivas <code>box()</code> morfológicas (núcleo, tercio superior, cuerpo, tercio inferior). La caja núcleo, expandida 10%, actúa como prior de forma: fuera de ella la probabilidad unaria se atenúa a la mitad.'],
      ['Método 3 · Refinamiento jerárquico en la banda incierta (ciclo 3)', 'Solo los tiles 16×16 con P̄ ∈ [0.25, 0.75] se recortan, se amplían ×4 para llevarlos a la resolución nativa del modelo, reciben una retícula 4×4 impresa y se envían todos en <strong>una única</strong> llamada con múltiples <code>image()</code> (16 <code>noul()</code> por tile, máx. 40 tiles = 640 preguntas). La banda es un perímetro: crece O(N), no O(N²).'],
      ['Método 4 · Inferencia densa: Random Walker (0 ciclos extra)', 'Energía: E(L) = Σᵢ Uᵢ(Lᵢ) + λ Σ₍ᵢ,ⱼ₎ [Lᵢ ≠ Lⱼ] · exp(−‖Iᵢ − Iⱼ‖² / 2σ²), con Uᵢ(1) = −log(Pᵢ + ε), Uᵢ(0) = −log(1 − Pᵢ + ε), vecindad 4-conectada en CIELAB y σ estimado como la media de las diferencias en aristas (heurística GrabCut). Se resuelve la relajación cuadrática por Gauss-Seidel rojo-negro con semillas duras en P &gt; 0.9 y P &lt; 0.1. Elegimos random walker sobre max-flow porque entrega probabilidad continua (necesaria para visualizar incertidumbre) y no requiere estructura de grafo dinámica. λ es ajustable en vivo.'],
      ['Método 5 · Caché perceptual de tiles', 'Cada tile refinado se indexa por un aHash 8×8 de 64 bits. Tiles visualmente equivalentes dentro de la misma sesión no se vuelven a consultar; los aciertos se reportan como <code>cacheHits</code>. El caché se vacía al cambiar la imagen fuente.'],
      ['Riesgos declarados', 'Ruido posicional del modelo entre regiones adyacentes (el término par lo mitiga, no lo elimina); superpíxeles que cruzan la frontera objeto/fondo cuando no hay contraste local (el ciclo 3 es la red de seguridad); IDs ilegibles en regiones pequeñas (si <code>unlabeledCount</code> supera 15% de K, bajar K).'],
    ],
  });
}

function comparisonTable(exp4) {
  const rows = [
    { name: 'Exp 1', regions: '64', resolution: '8×8', cycles: '1', tokens: '—', iou: '—' },
    { name: 'Exp 2', regions: '256 + box', resolution: '16×16', cycles: '2', tokens: '—', iou: '—' },
    { name: 'Exp 3', regions: '256 + 4 box', resolution: 'hasta 80×80 (sintético)', cycles: '2', tokens: '—', iou: '—' },
    { name: 'Exp 4', regions: String(exp4.regions), resolution: exp4.resolution, cycles: String(exp4.cycles), tokens: String(exp4.tokens), iou: exp4.iou },
  ];
  const wrap = el('div', 'jp-table-wrap');
  const table = el('table', 'jp-table');
  const cap = el('caption', 'jp-sr-only', 'Comparación entre experimentos');
  const thead = el('thead');
  const hr = el('tr');
  for (const h of ['Experimento', 'Regiones consultadas', 'Resolución efectiva', 'Ciclos', 'Tokens', 'IoU']) hr.append(el('th', null, h));
  thead.append(hr);
  const tbody = el('tbody');
  for (const r of rows) {
    const tr = el('tr', r.name === 'Exp 4' ? 'current' : null);
    for (const v of [r.name, r.regions, r.resolution, r.cycles, r.tokens, r.iou]) tr.append(el('td', null, v));
    tbody.append(tr);
  }
  table.append(cap, thead, tbody);
  wrap.append(table, el('p', 'jp-table-note', 'Los valores de tokens e IoU de Exp 1–3 solo se completan si se corren sobre la misma imagen en esta sesión; no se estiman.'));
  return wrap;
}

export function createExperimentFour() {
  let abort = null;
  let fullFile = null;
  let fullPreview = null;
  let imageAspect = 1;
  let k = 400;
  let mode = 'base';
  let lambda = 50;
  let useManualMask = false;
  let maskFile = null;
  let stage = 'idle'; // idle | locating | slic | superpixels | refining | graphcut
  let notice = null;
  let result = null;
  let view = 'mask';
  let sourceView = 'full';
  let projectionMode = 'full';
  let manualMask = null;
  // Derivados (los useMemo del original).
  let dense = null;
  let activeMask = null;
  let probStats = null;
  let metrics = null;

  const root = el('div', 'jp-stack');
  root.append(methodologyBrief());

  // ---- Controles ----
  const form = el('form', 'jp-controls');
  const c1 = el('div', 'jp-ctl span-4');
  const qLabel = el('label', 'jp-mono-label', 'Objeto a segmentar a píxel'); qLabel.htmlFor = 'exp4-subject';
  const question = textInput("Woody's hat", "Woody's hat", 'jp-input tall');
  question.id = 'exp4-subject';
  c1.append(qLabel, question, samples(SAMPLES, (s) => { question.value = s; sync(); }, 'Probar:'));

  const c2 = el('div', 'jp-ctl span-3');
  const kSeg = segmented(K_OPTIONS.map((o) => [o, String(o)]), k, (v) => { k = v; if (result && dense) renderTelemetry(); }, 'jp-seg grid-3');
  kSeg.node.setAttribute('role', 'radiogroup'); kSeg.node.setAttribute('aria-label', 'Cantidad de superpíxeles');
  const modeSeg = segmented([['base', 'Base · 2 ciclos'], ['refined', 'Refinado · 3 ciclos']], mode, (v) => { mode = v; sync(); }, 'jp-seg grid-2 accent');
  modeSeg.node.setAttribute('role', 'radiogroup'); modeSeg.node.setAttribute('aria-label', 'Modo');
  c2.append(el('span', 'jp-mono-label', 'Superpíxeles K'), kSeg.node, modeSeg.node);

  const c3 = el('div', 'jp-ctl span-2');
  const lambdaRange = range({ min: 10, max: 200, step: 5, value: lambda, label: (v) => `λ suavidad · ${v}`, cls: 'jp-range stacked', onInput: (v) => { lambda = v; lambdaRange.input.setAttribute('aria-valuetext', `lambda ${v}`); scheduleSolve(); } });
  lambdaRange.input.id = 'exp4-lambda';
  const maskCheck = el('label', 'jp-check');
  const maskCheckInput = el('input'); maskCheckInput.type = 'checkbox';
  maskCheck.append(maskCheckInput, ' Máscara manual para IoU');
  const maskInput = fileInput('image/png', (f) => onMaskFile(f));
  const maskBtn = button('jp-btn mid', 'Subir máscara PNG', () => maskInput.click());
  maskBtn.hidden = true;
  maskCheckInput.addEventListener('change', () => {
    useManualMask = maskCheckInput.checked;
    if (!useManualMask) { maskFile = null; manualMask = null; recompute(); }
    sync();
  });
  c3.append(lambdaRange.node, maskCheck, maskBtn, maskInput);

  const c4 = el('div', 'jp-ctl span-3 row');
  const input = fileInput('image/*', (f) => onFile(f));
  const pickBtn = button('jp-btn tall grow', 'Elegir imagen', () => input.click());
  const submit = button('jp-submit tall grow', '', null, 'submit');
  const cancelBtn = button('jp-btn tall grow cancel', '', () => cancel());
  c4.append(pickBtn, submit, cancelBtn, input);
  form.append(c1, c2, c3, c4);
  form.addEventListener('submit', runExperiment);
  question.addEventListener('input', sync);
  root.append(form);

  const live = el('div', 'jp-live'); live.setAttribute('aria-live', 'polite');
  const alert = el('div', 'jp-alert'); alert.setAttribute('role', 'alert'); alert.hidden = true;
  const noticeBox = el('div', 'jp-notice'); noticeBox.hidden = true;
  live.append(alert, noticeBox);
  root.append(live);

  // ---- Vistas ----
  const views = el('section', 'jp-two-col');
  views.setAttribute('aria-label', 'Vistas del Experimento 4');

  const left = el('div', 'jp-col tight');
  const lhead = el('div', 'jp-col-head');
  const lheadRight = el('div', 'jp-inline');
  const sourceSeg = segmented([['full', 'Imagen + box()'], ['labeled', 'IDs vistos por JEV']], sourceView, (v) => { sourceView = v; renderSource(); }, 'jp-seg tiny');
  const fileName = el('span', 'jp-mono-small');
  lheadRight.append(sourceSeg.node, fileName);
  lhead.append(el('h3', 'jp-mono-label', 'Source + SLIC Superpíxeles'), lheadRight);
  const source = el('div', 'jp-source dashed');
  source.addEventListener('click', () => input.click());
  source.addEventListener('dragover', (e) => e.preventDefault());
  source.addEventListener('drop', (e) => { e.preventDefault(); e.stopPropagation(); onFile(e.dataTransfer?.files?.[0] ?? null); });
  const inputCard = el('div', 'jp-crop-card'); inputCard.hidden = true;
  left.append(lhead, source, inputCard);

  const right = el('div', 'jp-col tight');
  const rhead = el('div', 'jp-col-head');
  const rtitle = el('h3', 'jp-mono-label');
  const projSeg = segmented([['full', 'Lienzo completo'], ['crop', 'Zoom recorte (píxel)']], projectionMode, (v) => { projectionMode = v; renderOutput(); }, 'jp-seg tiny');
  rhead.append(rtitle, projSeg.node);
  const layerBar = el('div', 'jp-layerbar');
  const viewSeg = segmented([
    ['mask', 'P(x,y) Umbralizada'], ['continuous', 'P(x,y) Continua'],
    ['unary', 'Superpíxeles JEV U(x,y)'], ['tiles', 'Incertidumbre w(P) · Tiles'],
  ], view, (v) => { view = v; renderOutput(); }, 'jp-seg accent');
  viewSeg.node.setAttribute('role', 'tablist'); viewSeg.node.setAttribute('aria-label', 'Vista');
  layerBar.append(el('span', 'jp-mono-small upper', 'Capa de probabilidades:'), viewSeg.node);
  const out = el('div', 'jp-stage center');
  const canvas = el('canvas');
  canvas.setAttribute('role', 'img');
  const thBox = el('div', 'jp-sliders single');
  const threshold = range({ min: 0.05, max: 0.95, step: 0.05, value: 0.5, label: () => '', cls: 'jp-range row', onInput: () => { recompute(); } });
  const legend = el('p', 'jp-mono-small');
  thBox.append(threshold.node, legend);
  right.append(rhead, layerBar, out, thBox);
  views.append(left, right);
  root.append(views);

  // ---- Telemetría ----
  const telemetry = el('section', 'jp-stack tight');
  telemetry.setAttribute('aria-label', 'Telemetría del Experimento 4');
  telemetry.hidden = true;
  const t1 = statGrid('cols-6', [
    ['cycles', 'Ciclos API'], ['tokens', 'Tokens in / out'], ['k', 'K real'], ['unlabeled', 'Sin ID legible'],
    ['res', 'Resolución'], ['tiles', 'Tiles refinados'], ['cache', 'Cache hits'], ['missing', 'Sin respuesta'],
    ['sigma', 'σ auto'], ['iters', 'RW iteraciones'], ['iou', 'IoU'], ['bf1', 'Boundary-F1'],
  ]);
  const t2 = statGrid('cols-5', [['locate', 'Locate'], ['slic', 'SLIC + render'], ['sp', 'Superpíxeles'], ['refine', 'Refine'], ['gc', 'Graph-cut']]);
  const warnUnlabeled = el('p', 'jp-notice'); warnUnlabeled.hidden = true;
  const warnTruncated = el('p', 'jp-notice', `El ciclo 3 truncó tiles por el límite de ${V4_MAX_REFINE_TILES}.`); warnTruncated.hidden = true;
  const tableSlot = el('div');
  telemetry.append(t1.node, t2.node, warnUnlabeled, warnTruncated, tableSlot);
  root.append(telemetry);

  // ---------- Estado derivado ----------
  function setError(msg) { alert.textContent = msg || ''; alert.hidden = !msg; }
  function setNotice(msg) { notice = msg || null; noticeBox.textContent = notice || ''; noticeBox.hidden = !notice; }

  // El graph-cut final se re-resuelve en el cliente cuando cambia λ: 0 ciclos de API extra.
  function solve() {
    dense = result ? solveGraphCut(result.cropImageData, result.unaryFinal, { lambda }) : null;
    recompute();
  }
  let solveFrame = 0;
  function scheduleSolve() {
    if (!result) return;
    cancelAnimationFrame(solveFrame);
    solveFrame = requestAnimationFrame(solve);
  }

  // Umbral desacoplado del random walker: mover τ es instantáneo.
  function recompute() {
    const th = threshold.value;
    activeMask = null; probStats = null; metrics = null;
    if (dense) {
      const prob = dense.probability;
      activeMask = new Uint8Array(prob.length);
      let active = 0, decisive = 0, sum = 0;
      for (let p = 0; p < prob.length; p++) {
        const v = prob[p];
        activeMask[p] = v >= th ? 1 : 0;
        sum += v;
        if (activeMask[p] === 1) active++;
        if (Math.abs(v - 0.5) >= 0.35) decisive++;
      }
      const total = prob.length;
      probStats = { total, active, coverage: sum / Math.max(1, total), decisiveness: decisive / Math.max(1, total) };
    }
    if (activeMask && manualMask && result) {
      metrics = { iou: iou(activeMask, manualMask), bf1: boundaryF1(activeMask, manualMask, result.cropWidth, result.cropHeight, 2) };
    }
    renderOutput();
    renderTelemetry();
  }

  // ---------- Pintado ----------
  // Reconstrucción 100% guiada por probabilidades (nunca copia el RGB de la foto).
  function paint() {
    if (!result || !dense || !activeMask) return;
    const th = threshold.value;
    const { cropWidth: w, cropHeight: h } = result;
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(w, h);
    const od = img.data;
    if (view === 'unary') {
      const field = result.unaryFinal;
      const labels = result.slic.labels;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const p = y * w + x;
          const U = field[p];
          const hit = U >= th;
          let shade = hit ? Math.round(145 + U * 110) : Math.round(20 + U * 55);
          const lbl = labels[p];
          const isBoundary = (x + 1 < w && labels[p + 1] !== lbl) || (y + 1 < h && labels[p + w] !== lbl);
          if (isBoundary) shade = hit ? Math.max(90, shade - 35) : Math.min(120, shade + 24);
          od[p * 4] = shade; od[p * 4 + 1] = shade; od[p * 4 + 2] = shade; od[p * 4 + 3] = 255;
        }
      }
      ctx.putImageData(img, 0, 0);
      return;
    }
    if (view === 'tiles') {
      const field = result.unaryFinal;
      for (let p = 0; p < w * h; p++) {
        const U = field[p];
        const weight = Math.max(0, Math.min(1, 4 * U * (1 - U)));
        od[p * 4] = Math.round(20 + weight * 212);
        od[p * 4 + 1] = Math.round(20 + weight * 30);
        od[p * 4 + 2] = Math.round(19 + weight * 55);
        od[p * 4 + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);
      for (const t of result.tiles) {
        ctx.strokeStyle = 'rgba(255,255,255,0.85)';
        ctx.lineWidth = 1;
        ctx.strokeRect(t.x + 0.5, t.y + 0.5, t.w - 1, t.h - 1);
      }
      return;
    }
    const prob = dense.probability;
    if (view === 'continuous') {
      for (let p = 0; p < w * h; p++) {
        const shade = Math.round(20 + prob[p] * 235);
        od[p * 4] = shade; od[p * 4 + 1] = shade; od[p * 4 + 2] = shade; od[p * 4 + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);
      return;
    }
    // mask
    for (let p = 0; p < w * h; p++) {
      const P = prob[p];
      const inside = activeMask[p] === 1;
      const fp = manualMask ? inside && manualMask[p] === 0 : false;
      const fn = manualMask ? !inside && manualMask[p] === 1 : false;
      if (fp) { od[p * 4] = 232; od[p * 4 + 1] = 50; od[p * 4 + 2] = 74; } else if (fn) { od[p * 4] = 26; od[p * 4 + 1] = 58; od[p * 4 + 2] = 107; } else {
        const shade = inside ? Math.round(145 + P * 110) : Math.round(20 + P * 55);
        od[p * 4] = shade; od[p * 4 + 1] = shade; od[p * 4 + 2] = shade;
      }
      od[p * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  }

  const stageLabel = () => ({
    idle: mode === 'refined' ? 'Ejecutar (3 ciclos)' : 'Ejecutar (2 ciclos)',
    locating: '1/3 Box…',
    slic: 'SLIC…',
    superpixels: mode === 'refined' ? '2/3 Superpíxeles…' : '2/2 Superpíxeles…',
    refining: '3/3 Refinando…',
    graphcut: 'Graph-cut…',
  });

  function renderSource() {
    sourceSeg.node.hidden = !result;
    fileName.hidden = !!result;
    fileName.textContent = fullFile ? fullFile.name : 'Sin archivo';
    if (result) sourceSeg.setLabel('labeled', `IDs vistos por JEV (${result.slic.k})`);
    source.style.aspectRatio = sourceView === 'full' && fullPreview ? String(imageAspect)
      : result ? `${result.cropWidth} / ${result.cropHeight}` : '1 / 1';
    if (result && sourceView === 'labeled') {
      const img = el('img', 'jp-cover-contain'); img.src = result.labeledCropUrl;
      img.alt = `Recorte con ${result.slic.k} superpíxeles etiquetados tal como lo vio el modelo`;
      source.replaceChildren(img);
    } else if (fullPreview) {
      const img = el('img', 'jp-cover-contain'); img.src = fullPreview; img.alt = 'Imagen fuente';
      source.replaceChildren(img);
      if (result) {
        const padded = placeBox(el('div', 'jp-padded-overlay soft'), result.paddedBox); padded.setAttribute('aria-hidden', 'true');
        const box = placeBox(el('div', 'jp-box-line'), result.localization.box); box.setAttribute('aria-hidden', 'true');
        source.append(padded, box);
      }
    } else {
      source.replaceChildren(el('span', 'jp-mono-small', 'Elegí una imagen para comenzar'));
    }

    inputCard.hidden = !result;
    if (result) {
      const main = el('div', 'jp-crop-card-main wide');
      const thumb = el('img', 'jp-thumb clickable'); thumb.src = result.labeledCropUrl;
      thumb.alt = 'Miniatura del recorte con superpíxeles SLIC enviado a JEV';
      thumb.addEventListener('click', () => { sourceView = sourceView === 'labeled' ? 'full' : 'labeled'; sourceSeg.set(sourceView); renderSource(); });
      const info = el('div', 'jp-crop-info');
      info.append(
        el('span', 'strong upper', `Input a JEV: ${result.slic.k} superpíxeles SLIC + 4 box()`),
        el('span', null, `Presencia: ${pct(result.localization.present)} · Conf. box: ${pct(result.localization.confidence ?? 0)}`),
        el('span', null, `Resolución del recorte: ${result.cropWidth}×${result.cropHeight} px (${num(result.cropWidth * result.cropHeight)} píxeles)`),
      );
      main.append(thumb, info);
      const chips = el('div', 'jp-chips-right');
      for (const sb of result.superpixels.subBoxes) chips.append(el('span', 'jp-chip', `${sb.label}: ${pct(sb.confidence)}`));
      inputCard.replaceChildren(main, chips);
    }
  }

  function renderOutput() {
    const th = threshold.value;
    rtitle.textContent = `Reconstrucción por Probabilidades JEV ${result ? `(${result.cropWidth}×${result.cropHeight} = ${num(result.cropWidth * result.cropHeight)} px)` : '(Píxel a píxel)'}`;
    out.style.aspectRatio = projectionMode === 'full' && fullPreview ? String(imageAspect)
      : result ? `${result.cropWidth} / ${result.cropHeight}` : '1 / 1';
    const subject = question.value;
    if (!result) {
      out.replaceChildren(el('span', 'jp-mono-small light pad', stage === 'idle'
        ? 'Acá JEV reconstruirá cada píxel en blanco y negro exclusivamente a partir de probabilidades noul() (0% píxeles copiados de la foto).'
        : stageLabel()[stage]));
    } else if (projectionMode === 'full') {
      canvas.className = 'jp-canvas-fill';
      canvas.setAttribute('aria-label', `Reconstrucción por probabilidades del sujeto ${subject}`);
      const wrap = el('div', 'jp-full');
      const box = placeBox(el('div', 'jp-proj'), result.paddedBox);
      box.append(canvas);
      wrap.append(box);
      out.replaceChildren(wrap);
    } else {
      canvas.className = 'jp-canvas-contain';
      canvas.setAttribute('aria-label', view === 'unary' ? 'Probabilidades brutas de cada superpíxel devueltas por JEV'
        : view === 'tiles' ? 'Mapa de incertidumbre w(P) y tiles evaluados en Ciclo 3'
          : view === 'continuous' ? 'Campo continuo de probabilidad P(x,y) por píxel'
            : `Reconstrucción binaria/probabilística del sujeto ${subject}`);
      out.replaceChildren(canvas);
    }
    paint();

    threshold.text.textContent = `Umbral de decisión τ · ${pct(th)}${probStats ? ` — Encendidos: ${num(probStats.active)} / ${num(probStats.total)} px (${pct(probStats.coverage)})` : ''}`;
    legend.innerHTML = `Blanco es sí (P ≥ τ). Negro es no (P &lt; τ). Ningún píxel RGB fue copiado de la imagen original: cada píxel se dibuja únicamente con la probabilidad inferida a partir de <code>${esc(config.model)}</code>.`
      + (view === 'mask' && manualMask ? ' · Diferencias vs. máscara manual: <span class="jp-fp">FP en coral</span> · <span class="jp-fn">FN en navy</span>.' : '');
  }

  function renderTelemetry() {
    telemetry.hidden = !(result && dense);
    if (telemetry.hidden) return;
    const tokens = {
      input: (result.localization.usage.input ?? 0) + result.superpixels.usage.input + (result.refinement?.usage.input ?? 0),
      output: (result.localization.usage.output ?? 0) + result.superpixels.usage.output + (result.refinement?.usage.output ?? 0),
    };
    const unlabeledRatio = result.unlabeledCount / Math.max(1, result.slic.k);
    const s = t1.stats;
    s.cycles.set(String(result.cycles));
    s.tokens.set(`${tokens.input} / ${tokens.output}`);
    s.k.set(`${result.slic.k} / ${k}`);
    s.unlabeled.set(`${result.unlabeledCount} (${pct(unlabeledRatio)})`);
    s.res.set(`${result.cropWidth}×${result.cropHeight} px`);
    s.tiles.set(result.cycles === 3 ? `${result.tiles.length} / ${result.tileCandidates}` : '—');
    s.cache.set(String(result.cacheHits));
    s.missing.set(String(result.superpixels.missingAnswers + (result.refinement?.missingAnswers ?? 0)));
    s.sigma.set(dense.sigma.toFixed(2));
    s.iters.set(String(dense.iterations));
    s.iou.set(metrics ? metrics.iou.toFixed(3) : 'no medido');
    s.bf1.set(metrics ? metrics.bf1.toFixed(3) : 'no medido');
    const t = t2.stats;
    t.locate.set(ms(result.timings.locate));
    t.slic.set(ms(result.timings.slic));
    t.sp.set(ms(result.timings.superpixels));
    t.refine.set(result.cycles === 3 ? ms(result.timings.refine) : '—');
    t.gc.set(ms(dense.elapsedMs));
    warnUnlabeled.hidden = !(unlabeledRatio > 0.15);
    warnUnlabeled.textContent = `${pct(unlabeledRatio)} de los superpíxeles no recibieron un ID legible. Recomendación: bajar K.`;
    warnTruncated.hidden = !result.refinement?.truncated;
    tableSlot.replaceChildren(comparisonTable({
      regions: result.slic.k + (result.refinement ? result.refinement.tiles.length * 16 : 0),
      resolution: `${result.cropWidth}×${result.cropHeight} (píxel)`,
      cycles: result.cycles,
      tokens: tokens.input + tokens.output,
      iou: metrics ? metrics.iou.toFixed(3) : '—',
    }));
  }

  function sync() {
    pickBtn.textContent = fullFile ? 'Cambiar imagen' : 'Elegir imagen';
    const idle = stage === 'idle';
    submit.hidden = !idle;
    cancelBtn.hidden = idle;
    submit.textContent = stageLabel().idle;
    submit.disabled = !fullFile || question.value.trim().length < 2;
    cancelBtn.textContent = `${stageLabel()[stage]} · Cancelar`;
    maskBtn.hidden = !useManualMask;
    maskBtn.textContent = maskFile ? maskFile.name.slice(0, 18) : 'Subir máscara PNG';
  }

  function setStage(next) { stage = next; sync(); if (!result) renderOutput(); }

  // ---------- Acciones ----------
  async function onFile(next) {
    if (!next) return;
    setError(''); setNotice(null);
    clearResult();
    manualMask = null;
    refinementCache.clear();
    try {
      const prepared = await prepareFullImage(next);
      fullFile = prepared.file;
      imageAspect = prepared.width / Math.max(1, prepared.height);
      revoke(fullPreview); fullPreview = URL.createObjectURL(prepared.file);
    } catch {
      fullFile = null;
      setError('No se pudo leer esa imagen. Probá con otra.');
    }
    renderSource(); renderOutput(); sync();
  }

  async function onMaskFile(next) {
    maskFile = next;
    sync();
    if (!next || !result) { manualMask = null; recompute(); return; }
    try {
      manualMask = await decodeMaskFile(next, result.cropWidth, result.cropHeight);
    } catch {
      setError('No se pudo leer la máscara manual.');
    }
    recompute();
  }

  function cancel() {
    abort?.abort();
    abort = null;
    setStage('idle');
  }

  function clearResult() {
    if (result) { revoke(result.cleanCropUrl); revoke(result.labeledCropUrl); }
    result = null; dense = null; activeMask = null; probStats = null; metrics = null;
    telemetry.hidden = true;
  }

  async function runExperiment(event) {
    event.preventDefault();
    if (!fullFile || question.value.trim().length < 2 || stage !== 'idle') return;
    setError(''); setNotice(null);
    clearResult();
    manualMask = null;
    renderSource(); renderOutput();

    const controller = new AbortController();
    abort = controller;
    const signal = controller.signal;
    const subject = question.value.trim();
    const requestedK = k;
    const runMode = mode;
    const timings = { locate: 0, slic: 0, superpixels: 0, refine: 0, graphcut: 0 };

    try {
      // Ciclo 1 — locate
      setStage('locating');
      let t = performance.now();
      const localization = await readJson('locate', { image: await blobToDataUrl(fullFile), question: subject }, signal, 'Ciclo 1 (box)');
      timings.locate = performance.now() - t;
      if (localization.present < PRESENT_THRESHOLD) throw new Error(`Sujeto no detectado (presencia ${pct(localization.present)}).`);

      // Crop + SLIC + labeled render
      setStage('slic');
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0))); // deja pintar la etiqueta antes del cálculo
      const crop = await cropToCanvas(fullFile, localization.box);
      t = performance.now();
      const slic = computeSlic(crop.imageData, { k: requestedK, compactness: 10, iterations: 10 });
      const labeled = await renderLabeledCrop(crop.canvas, slic);
      timings.slic = performance.now() - t;
      const slicSlow = slic.elapsedMs > 1500;
      if (signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });

      // Ciclo 2 — superpixels
      setStage('superpixels');
      const normCentroids = new Array(slic.k);
      for (let i = 0; i < slic.k; i++) {
        normCentroids[i] = [
          Number((slic.centroids[i * 2] / Math.max(1, crop.canvas.width)).toFixed(2)),
          Number((slic.centroids[i * 2 + 1] / Math.max(1, crop.canvas.height)).toFixed(2)),
        ];
      }
      const superpixels = await readJson('superpixels', {
        image: await blobToDataUrl(labeled.blob), question: subject, k: slic.k, centroids: normCentroids,
      }, signal, `Ciclo 2 (${slic.k} superpíxeles)`);
      timings.superpixels = superpixels.elapsedMs;

      const subCore = superpixels.subBoxes.find((b) => b.id === 'sub_core');
      const padW = Math.max(1e-4, crop.paddedBox.right - crop.paddedBox.left);
      const padH = Math.max(1e-4, crop.paddedBox.bottom - crop.paddedBox.top);
      const innerCycle1Box = {
        left: Math.max(0, (localization.box.left - crop.paddedBox.left) / padW),
        right: Math.min(1, (localization.box.right - crop.paddedBox.left) / padW),
        top: Math.max(0, (localization.box.top - crop.paddedBox.top) / padH),
        bottom: Math.min(1, (localization.box.bottom - crop.paddedBox.top) / padH),
      };
      const core = subCore && subCore.confidence >= 0.55 ? subCore.box : innerCycle1Box;
      const unaryBase = buildUnaryField(slic, superpixels.probabilities, crop.imageData, core);
      let unaryFinal = unaryBase;
      let tiles = [];
      let tileCandidates = 0;
      let cacheHits = 0;
      let refinement = null;
      let cycles = 2;

      // Ciclo 3 — refine (opcional)
      if (runMode === 'refined') {
        setStage('refining');
        const selected = selectUncertainTiles(unaryBase, crop.canvas.width, crop.canvas.height, {
          tileGrid: TILE_GRID, band: UNCERTAINTY_BAND, maxTiles: V4_MAX_REFINE_TILES,
        });
        tiles = selected.tiles;
        tileCandidates = selected.candidateCount;

        const cached = [];
        const toSend = [];
        const hashes = new Map();
        for (const tile of tiles) {
          const hsh = tileHash(crop.canvas, tile.x, tile.y, tile.w, tile.h);
          hashes.set(tile.tileId, hsh);
          const hit = refinementCache.get(hsh);
          if (hit) { cached.push({ tileId: tile.tileId, sub: hit }); cacheHits++; } else toSend.push(tile);
        }

        let fetched = null;
        if (toSend.length > 0) {
          const payload = [];
          for (const tile of toSend) {
            const blob = await renderTileForRefinement(crop.canvas, tile, { upscale: TILE_UPSCALE, subGrid: V4_TILE_SUBGRID });
            payload.push({ tileId: tile.tileId, image: await blobToDataUrl(blob) });
          }
          fetched = await readJson('refine', { question: subject, tiles: payload }, signal, `Ciclo 3 (${toSend.length} tiles)`);
          for (const r of fetched.tiles) {
            const hsh = hashes.get(r.tileId);
            if (hsh) refinementCache.set(hsh, r.sub);
          }
          timings.refine = fetched.elapsedMs;
          cycles = 3;
        }

        refinement = {
          model: fetched?.model ?? config.model,
          tiles: [...cached, ...(fetched?.tiles ?? [])],
          truncated: fetched?.truncated ?? false,
          missingAnswers: fetched?.missingAnswers ?? 0,
          elapsedMs: fetched?.elapsedMs ?? 0,
          usage: fetched?.usage ?? { input: 0, output: 0 },
        };
        unaryFinal = mergeRefinement(unaryBase, crop.canvas.width, tiles, refinement.tiles, V4_TILE_SUBGRID);
        if (tileCandidates > tiles.length) setNotice(`Refinamiento parcial: ${tiles.length}/${tileCandidates} tiles (límite ${V4_MAX_REFINE_TILES}).`);
      }

      // El random walker corre en solve() para que el slider λ pueda re-resolver en vivo.
      setStage('graphcut');
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
      if (slicSlow) setNotice([notice, 'Segmentación lenta — considerar k menor.'].filter(Boolean).join(' · '));

      result = {
        localization, paddedBox: crop.paddedBox,
        cropWidth: crop.canvas.width, cropHeight: crop.canvas.height, cropImageData: crop.imageData,
        cleanCropUrl: crop.cleanUrl, labeledCropUrl: labeled.previewUrl,
        slic, unlabeledCount: labeled.unlabeledCount, superpixels, unaryBase, unaryFinal,
        tiles, tileCandidates, cacheHits, refinement, timings, cycles, slicSlow, requestedK,
      };
      view = 'mask'; viewSeg.set('mask');
      if (useManualMask && maskFile) manualMask = await decodeMaskFile(maskFile, result.cropWidth, result.cropHeight);
      renderSource();
      solve();
    } catch (err) {
      if (err?.name === 'AbortError') setNotice('Corrida cancelada.');
      else setError(err instanceof Error ? err.message : 'Falló el Experimento 4.');
    } finally {
      if (abort === controller) abort = null;
      stage = 'idle'; sync(); renderOutput();
    }
  }

  renderSource(); renderOutput(); sync();
  return root;
}
