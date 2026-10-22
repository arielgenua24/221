// Laboratorio Experimento 1 (studio.tsx): 8×8 = 64 noul sobre la imagen entera, un solo ciclo.
import { el, pct, button, statGrid, range, fileInput, makeDropTarget, blobToDataUrl, post, mosaic, samples, textInput, revoke, config } from './common.js';

const SAMPLES = ['the person', 'the sky', 'any text', 'the main subject'];
const GRID = 8;

/** JEV rejects images outside 280–1568 px on either side. Fit, then export JPEG. */
async function fitForJev(file) {
  const bitmap = await createImageBitmap(file);
  const maxSide = 1568;
  const minSide = 280;
  let width = bitmap.width;
  let height = bitmap.height;
  const longest = Math.max(width, height);
  if (longest > maxSide) {
    const scale = maxSide / longest;
    width = Math.round(width * scale);
    height = Math.round(height * scale);
  }
  if (Math.min(width, height) < minSide) {
    const scale = minSide / Math.min(width, height);
    width = Math.round(width * scale);
    height = Math.round(height * scale);
  }
  const canvas = document.createElement('canvas');
  canvas.width = Math.min(width, maxSide);
  canvas.height = Math.min(height, maxSide);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('No se pudo preparar la imagen.');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
  bitmap.close();
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92));
  if (!blob) throw new Error('No se pudo preparar la imagen.');
  return new File([blob], 'source.jpg', { type: 'image/jpeg' });
}

export function createExperimentOne() {
  let file = null;
  let preview = null;
  let result = null;
  let pending = false;

  const form = el('form', 'jp-two-col');

  // ---- Source (izquierda) ----
  const left = el('section', 'jp-col');
  const lhead = el('div', 'jp-col-head');
  lhead.append(el('h3', 'jp-mono-label', 'Source'), el('span', 'jp-mono-small', 'left'));
  const drop = el('button', 'jp-drop jp-fixed-h');
  drop.type = 'button';
  const input = fileInput('image/*', (f) => onFile(f));
  makeDropTarget(drop, input, (f) => onFile(f));
  const question = textInput('the main subject', 'the red car', 'jp-input serif', 280);
  const qLabel = el('label', 'jp-field');
  qLabel.append(el('span', 'jp-mono-label', 'What should be white'), question);
  const submit = button('jp-submit', 'Reconstruct', null, 'submit');
  const error = el('p', 'jp-error-text'); error.hidden = true;
  left.append(lhead, drop, input, qLabel, samples(SAMPLES, (s) => { question.value = s; sync(); }), submit, error);

  // ---- Reconstruction (derecha) ----
  const right = el('section', 'jp-col');
  const rhead = el('div', 'jp-col-head');
  rhead.append(el('h3', 'jp-mono-label', 'Reconstruction'), el('span', 'jp-mono-small', 'right · 1 / 0'));
  const stage = el('div', 'jp-stage jp-fixed-h');
  const threshold = range({ min: 0.05, max: 0.95, step: 0.05, value: 0.5, label: (v) => `Threshold ${pct(v)}`, cls: 'jp-range row', onInput: () => render() });
  const { node: statsNode, stats } = statGrid('cols-3', [['marked', 'Marked'], ['coverage', 'Coverage'], ['decisive', 'Decisive']]);
  const caption = el('p', 'jp-caption');
  right.append(rhead, stage, threshold.node, statsNode, caption);

  form.append(left, right);
  question.addEventListener('input', sync);
  form.addEventListener('submit', onSubmit);

  function setError(msg) { error.textContent = msg || ''; error.hidden = !msg; }

  function renderDrop() {
    if (preview) {
      const img = el('img', 'jp-contain'); img.src = preview; img.alt = 'Imagen a reconstruir';
      drop.replaceChildren(img);
    } else {
      const s = el('span', 'jp-drop-empty');
      s.append(el('span', 'jp-serif-big', 'Drop an image'), el('span', 'jp-drop-hint', 'Sent through the TypeSafe API. JEV will not redraw it. It only answers yes or no, cell by cell.'));
      drop.replaceChildren(s);
    }
  }

  function render() {
    const t = threshold.value;
    if (result) {
      stage.replaceChildren(mosaic(result.cells, result.grid, t));
    } else {
      const p = el('div', 'jp-stage-empty');
      p.append(el('p', 'jp-serif-big light', pending ? '64 decisions in flight' : 'Waiting for a question'));
      stage.replaceChildren(p);
    }
    if (pending) stage.append(el('div', 'jp-pulse'));
    const marked = result ? result.cells.filter((c) => c.probability >= t).length : 0;
    stats.marked.set(result ? `${marked}/${result.cells.length}` : '—');
    stats.coverage.set(result ? pct(result.coverage) : '—');
    stats.decisive.set(result ? pct(result.decisiveness) : '—');
    caption.textContent = `White is yes. Black is no. Each square is one probability from ${config.model}, not a pixel the model drew.`
      + (result?.usage?.input != null ? ` ${result.usage.input} in / ${result.usage.output ?? 0} out.` : '');
  }

  function sync() {
    submit.disabled = !file || question.value.trim().length < 2 || pending;
    submit.textContent = pending ? 'Asking JEV…' : 'Reconstruct';
  }

  async function onFile(next) {
    if (!next) return;
    result = null;
    setError('');
    try {
      const prepared = await fitForJev(next);
      file = prepared;
      revoke(preview);
      preview = URL.createObjectURL(prepared);
    } catch {
      file = null;
      setError('No se pudo leer esa imagen. Probá con otra.');
    }
    renderDrop(); render(); sync();
  }

  async function onSubmit(event) {
    event.preventDefault();
    if (!file || question.value.trim().length < 2 || pending) return;
    pending = true; setError(''); sync(); render();
    try {
      const { ok, data } = await post('grid', { image: await blobToDataUrl(file), question: question.value.trim(), grid: GRID });
      if (!ok) setError(typeof data.error === 'string' ? data.error : 'JEV no pudo responder.');
      else result = data;
    } catch {
      setError('No se pudo hablar con JEV. Probá de nuevo.');
    } finally {
      pending = false; sync(); render();
    }
  }

  renderDrop(); render(); sync();
  return form;
}
