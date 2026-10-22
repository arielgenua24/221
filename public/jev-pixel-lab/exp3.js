// Laboratorio Experimento 3 (experiment-three.tsx): super-resolución 10X–25X a costo constante de 2 ciclos.
// Ciclo 1: box(). Ciclo 2: 256 noul + 4 sub-cajas morfológicas. El cliente sintetiza 48²–80² micro-mosaicos.
import { SUPER_RES_OPTIONS, prepareFullImage, prepareCropWithVisualGrid, synthesizeSuperResolution } from '../jev-pixel/exp3.js';
import { el, pct, num, esc, button, segmented, stat, range, fileInput, makeDropTarget, blobToDataUrl, post, samples, textInput, revoke, placeBox, brief, config } from './common.js';

const SAMPLES = ["Woody's hat", "the person's face", 'the main subject', 'any text'];
const BASE_GRID = 16;
const SUB_BOX_WEIGHT = 0.55;

function methodologyBrief() {
  const model = esc(config.model);
  return brief({
    tag: 'Brief Metodológico',
    title: 'Arquitectura de Super-Resolución 10X–25X a Costo Constante de Ciclos',
    summary: '<strong>Problema fundamental de escalabilidad espacial:</strong> Incrementar la resolución por fuerza bruta en una grilla uniforme tiene complejidad cuadrática O(N²). Pasar de 16×16 (256 celdas) a 64×64 u 80×80 requeriría entre 4,096 y 6,400 preguntas <code>noul()</code> por imagen, degradando además la precisión posicional del modelo porque las fracciones numéricas (Δ = 0.0125) caen por debajo del umbral de atención espacial directa. En este <strong>Laboratorio Experimento 3</strong> desacoplamos la <em>inferencia semántica global</em> (qué es el objeto y dónde está) de la <em>geometría local de alta frecuencia</em> (dónde corta exactamente el borde físico cada píxel), manteniendo el presupuesto de red en exactamente <strong>los mismos 2 ciclos de API que el Experimento 2</strong> pero elevando la densidad de salida hasta <strong>6,400 micro-mosaicos (100X respecto al Experimento 1 y 16X–25X respecto al Experimento 2)</strong>.',
    cards: [
      ['Método 1 · Retícula Visual Impresa (Visual Prompting)', `Antes de despachar el recorte a <code>image()</code>, el navegador imprime sobre el canvas una retícula ortogonal semitransparente de doble contraste alineada con las divisiones 16×16. En lugar de obligar a <code>${model}</code> a estimar coordenadas ciegas en punto flotante, el modelo observa físicamente los tabiques de cada celda sobre el sombrero u objeto, reduciendo la dispersión espacial en los bordes sin consumir ni un solo token adicional.`],
      ['Método 2 · Tomografía Morfológica Simultánea (noul + 4 box en 1 ciclo)', 'En la misma llamada <code>systemOne()</code> que evalúa las 256 celdas <code>noul()</code>, inyectamos en paralelo 4 primitivas continuas <code>box()</code> por sub-partes morfológicas del objeto (<em>silueta núcleo, tercio superior/copa, cuerpo medio y tercio inferior/ala</em>). Cada <code>box()</code> aporta 4 coordenadas continuas en punto flotante que actúan como prior estructural sin añadir latencia ni viajes de red.'],
      ['Método 3 · Extracción Automática de Semillas Cromáticas (Priors FG / BG)', 'Usamos las celdas donde JEV tiene certeza alta (P ≥ 0.76) como semillas positivas para muestrear los píxeles reales del objeto en el recorte y extraer 5 prototipos cromáticos por cuantiles de luminancia (capturando luces, tonos medios y sombras del sombrero). Las celdas con P ≤ 0.22 parametrizan la distribución cromática del fondo local inmediato.'],
      ['Método 4 · Super-Resolución Guiada por Sobel en Banda de Frontera (0 ciclos extra)', 'Subdividimos el recorte en <strong>48×48 (2,304)</strong>, <strong>64×64 (4,096)</strong> u <strong>80×80 (6,400)</strong> micro-mosaicos. En cada micro-celda interpolamos bilinealmente el campo semántico P_sem(u,v) y lo fusionamos con la verosimilitud cromática L_color(u,v) y el operador de gradiente de Sobel |∇I(u,v)|, modulados por la envolvente de incertidumbre <strong>w(P) = 4·P·(1 − P)</strong>. Así, el juicio semántico de JEV manda en el interior y en el fondo, mientras los bordes físicos se ajustan con precisión sub-celda en ~6 ms en cliente.'],
    ],
    footer: 'Mostrando vista resumida de 3 renglones · Incluye 4 métodos experimentales detallados.',
  });
}

// SuperResCanvas: 10 px por micro-celda; modo super (umbral) o boundary (w(P)).
function superResCanvas(microCells, superGrid, threshold, mode) {
  const canvas = el('canvas', 'jp-canvas-contain');
  const cellPx = 10;
  const size = superGrid * cellPx;
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#141413';
  ctx.fillRect(0, 0, size, size);
  for (const cell of microCells) {
    const x = cell.col * cellPx;
    const y = cell.row * cellPx;
    if (mode === 'boundary') {
      const w = cell.boundaryWeight;
      ctx.fillStyle = `rgb(${Math.round(28 + w * 215)}, ${Math.round(28 + w * 95)}, ${Math.round(26 + w * 45)})`;
    } else {
      const hit = cell.probability >= threshold;
      const shade = hit ? Math.round(145 + cell.probability * 110) : Math.round(cell.probability * 75);
      ctx.fillStyle = `rgb(${shade}, ${shade}, ${shade})`;
    }
    ctx.fillRect(x, y, cellPx - 0.6, cellPx - 0.6);
  }
  return canvas;
}

// CoarseMosaicGrid: la grilla 16×16 bruta de JEV.
function coarseMosaic(cells, grid, threshold) {
  const node = el('div', 'jp-coarse');
  node.style.gridTemplateColumns = `repeat(${grid}, minmax(0, 1fr))`;
  node.style.gridTemplateRows = `repeat(${grid}, minmax(0, 1fr))`;
  for (const cell of cells) {
    const hit = cell.probability >= threshold;
    const shade = hit ? Math.round(140 + cell.probability * 115) : Math.round(cell.probability * 80);
    const d = el('div');
    d.title = `(${cell.row + 1}, ${cell.col + 1}) → ${pct(cell.probability)}`;
    d.style.backgroundColor = `rgb(${shade}, ${shade}, ${shade})`;
    node.append(d);
  }
  return node;
}

export function createExperimentThree() {
  let fullFile = null;
  let fullPreview = null;
  let imageAspect = 1;
  let superGrid = 64;
  let viewMode = 'full';
  let layerMode = 'super';
  let showSubBoxes = true;
  let pendingStep = 'idle';
  let localization = null;
  let paddedBox = null;
  let cleanCropUrl = null;
  let gridCropUrl = null;
  let cropImageData = null;
  let hybridResult = null;
  let synthesis = null;

  const root = el('div', 'jp-stack');
  root.append(methodologyBrief());

  // ---- Controles ----
  const form = el('form', 'jp-controls');
  const c1 = el('div', 'jp-ctl span-5');
  const qLabel = el('label', 'jp-mono-label', 'Objeto a reconstruir en super-resolución 10X+');
  qLabel.htmlFor = 'exp3-subject-input';
  const question = textInput("Woody's hat", "Woody's hat", 'jp-input tall');
  question.id = 'exp3-subject-input';
  c1.append(qLabel, question, samples(SAMPLES, (s) => { question.value = s; sync(); }, 'Probar:'));

  const c2 = el('div', 'jp-ctl span-4');
  const superSeg = segmented(SUPER_RES_OPTIONS.map((o) => [o.size, o.label]), superGrid, (v) => { superGrid = v; resynth(); render(); }, 'jp-seg grid-3');
  const visual = el('label', 'jp-check');
  const visualInput = el('input'); visualInput.type = 'checkbox'; visualInput.checked = true;
  visualInput.addEventListener('change', () => renderCropCard());
  visual.append(visualInput, ' Imprimir retícula visual 16×16 en el recorte enviado a JEV');
  c2.append(el('span', 'jp-mono-label', 'Densidad de micro-mosaicos (0 ciclos extra)'), superSeg.node, visual);

  const c3 = el('div', 'jp-ctl span-3 row');
  const input = fileInput('image/*', (f) => onFile(f));
  const pickBtn = button('jp-btn tall grow', 'Elegir imagen', () => input.click());
  const submit = button('jp-submit tall grow', 'Ejecutar 10X', null, 'submit');
  c3.append(pickBtn, submit, input);
  form.append(c1, c2, c3);
  form.addEventListener('submit', onSubmit);
  question.addEventListener('input', sync);
  root.append(form);

  const alert = el('div', 'jp-alert'); alert.setAttribute('role', 'alert'); alert.hidden = true;
  root.append(alert);

  // ---- Comparación ----
  const compare = el('section', 'jp-two-col');
  compare.setAttribute('aria-label', 'Comparación de super-resolución 10X');

  const left = el('div', 'jp-col tight');
  const lhead = el('div', 'jp-col-head');
  const lheadRight = el('div', 'jp-inline');
  const subToggle = button('jp-chip-btn tiny', '', () => { showSubBoxes = !showSubBoxes; renderSource(); });
  const locInfo = el('span', 'jp-mono-small');
  lheadRight.append(subToggle, locInfo);
  lhead.append(el('h3', 'jp-mono-label', 'Source + Localización y Tomografía de Sub-Cajas'), lheadRight);
  const source = el('div', 'jp-source');
  source.setAttribute('role', 'button'); source.tabIndex = 0;
  makeDropTarget(source, input, (f) => onFile(f));
  source.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
  const cropCard = el('div', 'jp-crop-card'); cropCard.hidden = true;
  left.append(lhead, source, cropCard);

  const right = el('div', 'jp-col tight');
  const rhead = el('div', 'jp-col-head');
  const rtitle = el('h3', 'jp-mono-label');
  const viewSeg = segmented([['full', 'Lienzo completo'], ['crop', '']], viewMode, (v) => { viewMode = v; render(); }, 'jp-seg tiny');
  rhead.append(rtitle, viewSeg.node);
  const layerBar = el('div', 'jp-layerbar');
  const layerSeg = segmented([['super', ''], ['jev-raw', 'Solo JEV 16×16 bruto (256)'], ['boundary', 'Banda de frontera w(P)']], layerMode, (v) => { layerMode = v; render(); }, 'jp-seg accent');
  layerBar.append(el('span', 'jp-mono-small upper', 'Capa de visualización:'), layerSeg.node);
  const out = el('div', 'jp-stage');
  const sliders = el('div', 'jp-sliders');
  const threshold = range({ min: 0.1, max: 0.9, step: 0.05, value: 0.5, label: () => 'Umbral de decisión', cls: 'jp-range stacked', onInput: () => { thVal.textContent = pct(threshold.value); render(); } });
  const thVal = el('span', 'jp-strong-val', pct(0.5));
  threshold.text.after(thVal);
  const alpha = range({ min: 0, max: 1, step: 0.04, value: 0.68, label: () => 'Peso de borde cromático/Sobel (α)', cls: 'jp-range stacked', onInput: () => { aVal.textContent = pct(alpha.value); resynth(); render(); } });
  const aVal = el('span', 'jp-strong-val', pct(0.68));
  alpha.text.after(aVal);
  sliders.append(threshold.node, alpha.node);
  right.append(rhead, layerBar, out, sliders);
  compare.append(left, right);
  root.append(compare);

  // ---- Métricas ----
  const metrics = el('section', 'jp-metrics');
  metrics.setAttribute('aria-label', 'Métricas del Experimento 3');
  const m = {
    marked: stat('Micro-mosaicos'), gain: stat('Ganancia de definición'), cycles: stat('Ciclos de API', '2 ciclos (0 extra)'),
    sub: stat('Sub-cajas en paralelo'), time: stat('Tiempo total API'), tokens: stat('Tokens (in / out)'),
  };
  metrics.append(...Object.values(m).map((s) => s.node));
  metrics.hidden = true;
  root.append(metrics);

  const setError = (msg) => { alert.textContent = msg || ''; alert.hidden = !msg; };

  function resynth() {
    synthesis = hybridResult && cropImageData
      ? synthesizeSuperResolution({ hybrid: hybridResult, imageData: cropImageData, superGrid, edgeAlpha: alpha.value, subBoxWeight: SUB_BOX_WEIGHT })
      : null;
  }

  function renderSource() {
    subToggle.hidden = !(hybridResult && hybridResult.subBoxes.length > 0);
    subToggle.textContent = showSubBoxes ? 'Ocultar 4 sub-cajas' : 'Ver 4 sub-cajas';
    locInfo.textContent = localization
      ? `Presencia ${pct(localization.present)} · Conf. Box ${pct(localization.confidence ?? 0)}`
      : fullFile ? fullFile.name : 'Sin archivo';
    source.style.aspectRatio = fullPreview ? String(imageAspect) : '1 / 1';
    if (!fullPreview) {
      const empty = el('div', 'jp-source-empty');
      const hint = el('p', 'jp-mono-small');
      hint.append('Ciclo 1: ', el('code', null, 'box()'), ' localiza el objeto · Ciclo 2: 256 ', el('code', null, 'noul()'), ' + 4 sub-cajas + super-resolución guiada por bordes hasta ', el('code', null, '80×80 (6,400 mosaicos)'), '.');
      empty.append(el('p', 'jp-serif-mid', 'Soltá una imagen acá'), hint);
      source.replaceChildren(empty);
      return;
    }
    const img = el('img', 'jp-cover-contain'); img.src = fullPreview; img.alt = 'Imagen original para Experimento 3';
    source.replaceChildren(img);
    if (localization) {
      const b = placeBox(el('div', 'jp-box-overlay'), localization.box);
      b.append(el('span', 'jp-box-tag up', `box() · ${pct(localization.confidence ?? 0)}`));
      source.append(b);
    }
    if (paddedBox) {
      const p = placeBox(el('div', 'jp-padded-overlay'), paddedBox);
      if (showSubBoxes && hybridResult) {
        for (const sb of hybridResult.subBoxes) {
          const s = placeBox(el('div', 'jp-subbox'), sb.box);
          s.title = `${sb.label} (${pct(sb.confidence)})`;
          p.append(s);
        }
      }
      source.append(p);
    }
  }

  function renderCropCard() {
    cropCard.hidden = !(gridCropUrl && paddedBox);
    if (cropCard.hidden) return;
    const useGrid = visualInput.checked;
    const leftPart = el('div', 'jp-crop-card-main');
    const thumb = el('img', 'jp-thumb'); thumb.src = useGrid ? gridCropUrl : (cleanCropUrl ?? gridCropUrl); thumb.alt = 'Recorte con retícula visual enviado a JEV';
    const info = el('div', 'jp-crop-info');
    info.append(
      el('span', 'strong upper', `Recorte activo (${useGrid ? 'Con retícula visual 16×16' : 'Recorte limpio'})`),
      el('span', null, `Semillas FG: ${synthesis?.fgCount ?? 0} · Semillas BG: ${synthesis?.bgCount ?? 0}`),
      el('span', null, `Micro-mosaicos refinados en frontera: ${synthesis?.refinedBandCount ?? 0}`),
    );
    leftPart.append(thumb, info);
    const chips = el('div', 'jp-chips-right');
    for (const sb of hybridResult?.subBoxes ?? []) chips.append(el('span', 'jp-chip', `${sb.label}: ${pct(sb.confidence)}`));
    cropCard.replaceChildren(leftPart, chips);
  }

  function render() {
    const total = superGrid * superGrid;
    const gainVsExp1 = Math.round(total / 64);
    const gainVsExp2 = Math.round(total / (BASE_GRID * BASE_GRID));
    rtitle.textContent = `Reconstruction 10X+ (${superGrid}×${superGrid} = ${num(total)} micro-mosaicos)`;
    viewSeg.setLabel('crop', `Zoom recorte (${superGrid}×${superGrid})`);
    layerSeg.setLabel('super', `Super-Resolución 10X+ (${num(total)})`);
    out.style.aspectRatio = viewMode === 'full' && fullPreview ? String(imageAspect) : '1 / 1';
    const th = threshold.value;
    if (synthesis && hybridResult && paddedBox) {
      const layer = layerMode === 'jev-raw'
        ? coarseMosaic(hybridResult.cells, hybridResult.baseGrid, th)
        : superResCanvas(synthesis.microCells, superGrid, th, layerMode);
      if (viewMode === 'full') {
        const wrap = el('div', 'jp-full');
        const box = placeBox(el('div', 'jp-proj'), paddedBox);
        box.append(layer);
        wrap.append(box);
        out.replaceChildren(wrap);
      } else {
        out.replaceChildren(layer);
      }
    } else {
      const empty = el('div', 'jp-stage-empty');
      empty.append(el('p', 'jp-mono-small light', pendingStep === 'locating'
        ? 'Ciclo 1/2: JEV está localizando el box() exacto del objeto…'
        : pendingStep === 'reconstructing'
          ? `Ciclo 2/2: JEV evalúa 256 noul() + 4 sub-cajas y sintetiza ${num(total)} micro-mosaicos…`
          : `Acá se proyectarán los ${num(total)} micro-mosaicos (${gainVsExp1}X más definición que el Experimento 1).`));
      out.replaceChildren(empty);
    }

    metrics.hidden = !(hybridResult && localization && synthesis);
    if (!metrics.hidden) {
      const marked = synthesis.microCells.filter((c) => c.probability >= th).length;
      m.marked.set(`${num(marked)} / ${num(total)}`);
      m.gain.set(`${gainVsExp2}X vs Exp2 · ${gainVsExp1}X vs Exp1`);
      m.sub.set(`${hybridResult.subBoxes.length} box()`);
      m.time.set(`${((hybridResult.elapsedMs ?? 0) / 1000).toFixed(2)}s`);
      m.tokens.set(`${(localization.usage.input ?? 0) + hybridResult.usage.input} / ${(localization.usage.output ?? 0) + hybridResult.usage.output}`);
    }
    renderCropCard();
  }

  function sync() {
    pickBtn.textContent = fullFile ? 'Cambiar imagen' : 'Elegir imagen';
    submit.disabled = !fullFile || question.value.trim().length < 2 || pendingStep !== 'idle';
    submit.textContent = pendingStep === 'locating' ? '1/2 Box…' : pendingStep === 'reconstructing' ? '2/2 JEV+SR…' : 'Ejecutar 10X';
  }

  function renderAll() { renderSource(); render(); sync(); }

  async function onFile(next) {
    if (!next) return;
    setError('');
    localization = null; paddedBox = null; hybridResult = null; cropImageData = null; synthesis = null;
    revoke(cleanCropUrl); cleanCropUrl = null;
    revoke(gridCropUrl); gridCropUrl = null;
    try {
      const prepared = await prepareFullImage(next);
      fullFile = prepared.file;
      imageAspect = prepared.width / prepared.height;
      revoke(fullPreview); fullPreview = URL.createObjectURL(prepared.file);
    } catch {
      fullFile = null;
      setError('No se pudo leer esa imagen. Probá con otra.');
    }
    renderAll();
  }

  async function onSubmit(event) {
    event.preventDefault();
    if (!fullFile || question.value.trim().length < 2 || pendingStep !== 'idle') return;
    const subject = question.value.trim();
    setError('');
    localization = null; hybridResult = null; synthesis = null;
    pendingStep = 'locating'; renderAll();
    try {
      const loc = await post('locate', { image: await blobToDataUrl(fullFile), question: subject });
      if (!loc.ok) { setError(loc.data.error ?? 'Falló la localización del objeto.'); return; }
      localization = loc.data;

      const cropped = await prepareCropWithVisualGrid(fullFile, localization.box, BASE_GRID, visualInput.checked, 0.08);
      paddedBox = cropped.paddedBox;
      cropImageData = cropped.cleanImageData;
      revoke(cleanCropUrl); cleanCropUrl = cropped.cleanPreviewUrl;
      revoke(gridCropUrl); gridCropUrl = cropped.gridPreviewUrl;

      pendingStep = 'reconstructing'; renderAll();
      const recon = await post('hybrid', { image: await blobToDataUrl(cropped.apiFile), question: subject, baseGrid: BASE_GRID });
      if (!recon.ok) { setError(recon.data.error ?? 'Falló la reconstrucción híbrida.'); return; }
      hybridResult = recon.data;
      resynth();
    } catch {
      setError('La petición falló antes de que JEV pudiera responder.');
    } finally {
      pendingStep = 'idle'; renderAll();
    }
  }

  renderAll();
  return root;
}
