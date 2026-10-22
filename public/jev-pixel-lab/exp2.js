// Laboratorio Experimento 2 (experiment-two.tsx): box() localiza el sujeto y una grilla densa N×N corre solo dentro del recorte.
import { prepareFullImage, cropBoxForJev } from '../jev-pixel/exp2.js';
import { el, pct, button, segmented, statGrid, range, fileInput, makeDropTarget, blobToDataUrl, post, mosaic, samples, textInput, revoke, placeBox } from './common.js';

const SAMPLES = ["Woody's hat", "the person's face", 'the main subject', 'any text'];
const HIGH_RES_GRID = 16;
const GRID_OPTIONS = [
  { size: 12, label: '12×12 (144)' },
  { size: 16, label: '16×16 (256)' },
  { size: 20, label: '20×20 (400)' },
];

export function createExperimentTwo() {
  let preview = null;
  let croppedPreview = null;
  let file = null;
  let dimensions = null;
  let located = null;
  let activeBox = null;
  let result = null;
  let stage = 'idle'; // idle | locating | reconstructing
  let gridSize = HIGH_RES_GRID;
  let viewMode = 'projected';

  const form = el('form', 'jp-two-col');

  // ---- Source + Box Locator ----
  const left = el('section', 'jp-col');
  const lhead = el('div', 'jp-col-head');
  const boxInfo = el('span', 'jp-mono-small');
  lhead.append(el('h3', 'jp-mono-label', 'Source + Box Locator'), boxInfo);
  const drop = el('button', 'jp-drop jp-fixed-h');
  drop.type = 'button';
  const input = fileInput('image/*', (f) => onFile(f));
  makeDropTarget(drop, input, (f) => onFile(f));
  const question = textInput("Woody's hat", "Woody's hat", 'jp-input serif', 280);
  const qLabel = el('label', 'jp-field');
  qLabel.append(el('span', 'jp-mono-label', 'What should be white'), question);
  const gridSeg = segmented(GRID_OPTIONS.map((o) => [o.size, o.label]), gridSize, (v) => { gridSize = v; renderAll(); }, 'jp-seg tight');
  const controls = el('div', 'jp-row-between');
  controls.append(samples(SAMPLES, (s) => { question.value = s; sync(); }), gridSeg.node);
  const submit = button('jp-submit', '', null, 'submit');
  const error = el('p', 'jp-error-text'); error.hidden = true;
  left.append(lhead, drop, input, qLabel, controls, submit, error);

  // ---- High-Res Reconstruction ----
  const right = el('section', 'jp-col');
  const rhead = el('div', 'jp-col-head center');
  const viewSeg = segmented([['projected', 'En lienzo completo'], ['zoom', `Zoom al recorte (${gridSize}×${gridSize})`]], viewMode, (v) => { viewMode = v; render(); }, 'jp-seg tight');
  rhead.append(el('h3', 'jp-mono-label', 'High-Res Reconstruction'), viewSeg.node);
  const stageBox = el('div', 'jp-stage jp-fixed-h');
  const threshold = range({ min: 0.05, max: 0.95, step: 0.05, value: 0.5, label: (v) => `Threshold ${pct(v)}`, cls: 'jp-range row', onInput: () => render() });
  const { node: statsNode, stats } = statGrid('cols-4', [['box', 'Box Conf.'], ['marked', 'Marked'], ['cov', 'In-Box Cov.'], ['decisive', 'Decisive']]);
  const caption = el('p', 'jp-caption');
  right.append(rhead, stageBox, threshold.node, statsNode, caption);

  form.append(left, right);
  question.addEventListener('input', sync);
  form.addEventListener('submit', onSubmit);

  const pending = () => stage !== 'idle';
  function setError(msg) { error.textContent = msg || ''; error.hidden = !msg; }

  function renderDrop() {
    boxInfo.textContent = activeBox
      ? `box ${Math.round((activeBox.right - activeBox.left) * 100)}% × ${Math.round((activeBox.bottom - activeBox.top) * 100)}%`
      : 'step 1: box() · step 2: crop';
    if (preview) {
      const outer = el('div', 'jp-drop-fit');
      const inner = el('div', 'jp-rel');
      if (dimensions) inner.style.aspectRatio = `${dimensions.width} / ${dimensions.height}`;
      const img = el('img', 'jp-fit-img'); img.src = preview; img.alt = 'Imagen a reconstruir en alta resolución';
      inner.append(img);
      if (activeBox) {
        const b = placeBox(el('div', 'jp-box-overlay'), activeBox);
        b.append(el('span', 'jp-box-tag', `${gridSize}×${gridSize} foco`));
        inner.append(b);
      }
      outer.append(inner);
      drop.replaceChildren(outer);
    } else {
      const s = el('span', 'jp-drop-empty');
      const hint = el('span', 'jp-drop-hint');
      hint.append('Primero JEV localiza el objeto con ', el('code', null, 'box()'), ` y luego concentra los ${gridSize * gridSize} mosaicos solo dentro de ese recorte.`);
      s.append(el('span', 'jp-serif-big', 'Drop an image'), hint);
      drop.replaceChildren(s);
    }
  }

  function render() {
    const t = threshold.value;
    if (result && activeBox) {
      if (viewMode === 'projected') {
        const wrap = el('div', 'jp-full');
        const inner = placeBox(mosaic(result.cells, result.grid, t), activeBox);
        inner.classList.add('jp-abs', 'jp-faint-border');
        wrap.append(inner);
        stageBox.replaceChildren(wrap);
      } else {
        const wrap = el('div', 'jp-full');
        if (croppedPreview) {
          const img = el('img', 'jp-ghost-img'); img.src = croppedPreview; img.alt = 'Recorte del objeto';
          wrap.append(img);
        }
        const m = mosaic(result.cells, result.grid, t, { zoom: true });
        m.classList.add('jp-rel');
        wrap.append(m);
        stageBox.replaceChildren(wrap);
      }
    } else {
      const p = el('div', 'jp-stage-empty');
      p.append(el('p', 'jp-serif-big light', stage === 'locating' ? 'Finding subject bounding box…'
        : stage === 'reconstructing' ? `${gridSize * gridSize} focused decisions in flight` : 'Waiting for a question'));
      stageBox.replaceChildren(p);
    }
    if (pending()) stageBox.append(el('div', 'jp-pulse'));
    const marked = result ? result.cells.filter((c) => c.probability >= t).length : 0;
    stats.box.set(located ? pct(located.confidence ?? located.present) : '—');
    stats.marked.set(result ? `${marked}/${result.cells.length}` : '—');
    stats.cov.set(result ? pct(result.coverage) : '—');
    stats.decisive.set(result ? pct(result.decisiveness) : '—');
    caption.replaceChildren('Paso 1: ', el('code', null, 'box()'), ` recorta solo la región del objeto. Paso 2: ${gridSize}×${gridSize} (${gridSize * gridSize} preguntas `, el('code', null, 'noul'), ') se concentran dentro de esa caja en lugar de desperdiciar mosaicos en el fondo.');
  }

  function sync() {
    submit.disabled = !file || question.value.trim().length < 2 || pending();
    submit.textContent = stage === 'locating' ? 'Step 1/2 · Locating box()…'
      : stage === 'reconstructing' ? `Step 2/2 · ${gridSize * gridSize} focused decisions…`
        : `Locate & Reconstruct (${gridSize * gridSize} cells)`;
  }

  function renderAll() {
    viewSeg.setLabel('zoom', `Zoom al recorte (${gridSize}×${gridSize})`);
    renderDrop(); render(); sync();
  }

  async function onFile(next) {
    if (!next) return;
    result = null; located = null; activeBox = null;
    setError('');
    try {
      const prepared = await prepareFullImage(next);
      file = prepared.file;
      dimensions = { width: prepared.width, height: prepared.height };
      revoke(preview); preview = URL.createObjectURL(prepared.file);
      revoke(croppedPreview); croppedPreview = null;
    } catch {
      file = null;
      setError('No se pudo leer esa imagen. Probá con otra.');
    }
    renderAll();
  }

  async function onSubmit(event) {
    event.preventDefault();
    if (!file || question.value.trim().length < 2 || pending()) return;
    const subject = question.value.trim();
    stage = 'locating'; setError(''); result = null; renderAll();
    try {
      // Step 1: Locate bounding box with JEV box() primitive
      const loc = await post('locate', { image: await blobToDataUrl(file), question: subject });
      if (!loc.ok) { setError(typeof loc.data.error === 'string' ? loc.data.error : 'JEV no pudo localizar el objeto.'); return; }
      located = loc.data;

      // Step 2: Crop image to that bounding box and run dense N×N grid inside it
      stage = 'reconstructing'; renderAll();
      const { croppedFile, croppedPreviewUrl, paddedBox } = await cropBoxForJev(file, located.box);
      activeBox = paddedBox;
      revoke(croppedPreview); croppedPreview = croppedPreviewUrl;
      renderAll();

      const grid = await post('grid', { image: await blobToDataUrl(croppedFile), question: subject, grid: gridSize });
      if (!grid.ok) { setError(typeof grid.data.error === 'string' ? grid.data.error : 'JEV no pudo reconstruir el mosaico de alta resolución.'); return; }
      result = grid.data;
    } catch {
      setError('No se pudo hablar con JEV. Probá de nuevo.');
    } finally {
      stage = 'idle'; renderAll();
    }
  }

  renderAll();
  return form;
}
