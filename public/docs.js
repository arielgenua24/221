// Laboratorio · documentos adjuntos (.md): el humano suma los archivos Markdown que quiera al pedido; el agente los recibe
// enteros en el primer mensaje (ver src/lab/docs.js). Lo usan Motion Design y Context Lab.
import { el } from './shared.js';

export const isDocFile = (f) => /\.(md|markdown|txt)$/i.test(f?.name || '') || f?.type === 'text/markdown';
const tokens = (chars) => Math.round(chars / 4); // ≈ tokens = caracteres / 4 (igual que el resto del laboratorio)
const kTok = (chars) => tokens(chars).toLocaleString('es');
const uid = () => Math.random().toString(36).slice(2, 9);

// mount: dónde se agrega el panel. onChange: avisa cuando cambia la lista (agregar, quitar, restaurar).
export function createDocsPanel({ mount, onChange = () => {}, label = 'Documentos adjuntos (.md)', help = 'Archivos Markdown que el agente lee enteros: guía de marca, guion, notas de estilo… Podés adjuntar los que quieras (también soltándolos en la pestaña).' }) {
  let limits = { max: 10, maxChars: 120_000, maxTotalChars: 400_000 };
  let docs = []; // { id, name, text }

  const node = el('div', 'lab-field lab-docs');
  const input = el('input');
  input.type = 'file'; input.multiple = true; input.hidden = true;
  input.accept = '.md,.markdown,.txt,text/markdown,text/plain';
  const add = el('label', 'small-btn lab-docs-add', 'Adjuntar .md');
  add.append(input);
  const head = el('div', 'actions compact');
  head.append(add);
  const note = el('p', 'small lab-docs-note');
  note.setAttribute('role', 'status');
  const list = el('ul', 'lab-docs-list');
  const total = el('p', 'small muted lab-docs-total');
  node.append(el('span', 'lab-field-label', label), el('span', 'muted small', help), head, note, list, total);
  mount.append(node);

  const chars = () => docs.reduce((n, d) => n + d.text.length, 0);

  function render() {
    list.replaceChildren(...docs.map((d) => {
      const li = el('li', 'lab-docs-item');
      li.title = d.text.slice(0, 400) + (d.text.length > 400 ? '…' : '');
      const name = el('span', 'lab-docs-name', d.name);
      const x = el('button', 'remove', '×');
      x.type = 'button'; x.setAttribute('aria-label', `Quitar ${d.name}`);
      x.onclick = () => { docs = docs.filter((k) => k !== d); note.textContent = ''; render(); onChange(); };
      li.append(name, el('span', 'muted small', `≈ ${kTok(d.text.length)} tok.`), x);
      return li;
    }));
    total.hidden = !docs.length;
    total.textContent = docs.length ? `${docs.length} archivo${docs.length > 1 ? 's' : ''} · ≈ ${kTok(chars())} tokens de contexto (entran enteros en el pedido).` : '';
    add.hidden = docs.length >= limits.max;
  }

  // Lee y suma los archivos. Lo que no sirve (no es texto, vacío, repetido, se pasa de un límite) se avisa y se saltea.
  async function addFiles(files) {
    const problems = [];
    for (const f of [...files]) {
      if (!isDocFile(f)) { problems.push(`${f.name}: no es un archivo .md.`); continue; }
      if (docs.length >= limits.max) { problems.push(`${f.name}: ya hay ${limits.max} adjuntos (el máximo).`); continue; }
      let text;
      try { text = (await f.text()).replace(/\r\n?/g, '\n').trim(); } catch { problems.push(`${f.name}: no pude leerlo.`); continue; }
      if (!text) { problems.push(`${f.name}: está vacío.`); continue; }
      if (text.includes('\u0000')) { problems.push(`${f.name}: no parece un archivo de texto.`); continue; }
      if (text.length > limits.maxChars) { problems.push(`${f.name}: pesa ${Math.round(text.length / 1000)} mil caracteres (máximo por archivo: ${limits.maxChars / 1000} mil).`); continue; }
      if (chars() + text.length > limits.maxTotalChars) { problems.push(`${f.name}: con este, los adjuntos pasarían de ${limits.maxTotalChars / 1000} mil caracteres en total.`); continue; }
      if (docs.some((d) => d.name === f.name && d.text === text)) { problems.push(`${f.name}: ya estaba adjuntado.`); continue; }
      docs.push({ id: uid(), name: f.name, text });
    }
    note.textContent = problems.join(' ');
    render();
    onChange();
  }
  input.onchange = () => { addFiles(input.files); input.value = ''; };

  render();
  return {
    node,
    setLimits: (l) => { limits = { ...limits, ...l }; render(); },
    add: addFiles,
    // Los adjuntos con id (el id sirve para que cada variante de Context Lab elija cuáles recibe).
    get: () => docs.map((d) => ({ ...d })),
    // Reabre un experimento o recupera el borrador. Acepta [{ name, text }] (con o sin id).
    set: (list) => { docs = (list || []).map((d) => ({ id: d.id || uid(), name: d.name, text: d.text })); note.textContent = ''; render(); onChange(); },
    chars: (list = docs) => list.reduce((n, d) => n + d.text.length, 0),
  };
}
export { tokens as approxDocTokens };
