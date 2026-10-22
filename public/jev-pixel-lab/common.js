// Piezas comunes del Laboratorio · JEV a píxel (traducción de los componentes React/Tailwind de jev-to-pix).
import { el } from '../shared.js';

export { el };
export const pct = (value) => `${Math.round(value * 100)}%`;
export const ms = (value) => `${Math.round(value)} ms`;
export const num = (n) => Number(n).toLocaleString('en-US');
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Config del servidor (modelo, demo, límites). La pide el módulo principal antes de montar.
export const config = { mock: false, available: true, model: 'jev-1.14.0', limits: {} };

export function button(cls, text, onClick, type = 'button') {
  const b = el('button', cls, text);
  b.type = type;
  if (onClick) b.addEventListener('click', onClick);
  return b;
}

// Grupo de botones excluyentes (los "toggle" de Tailwind del original). Devuelve { node, value, set, setLabel }.
export function segmented(options, initial, onChange, cls = 'jp-seg') {
  const node = el('div', cls);
  const buttons = new Map();
  const api = {
    node,
    value: initial,
    set(v) {
      api.value = v;
      for (const [key, b] of buttons) { b.classList.toggle('on', key === v); b.setAttribute('aria-pressed', String(key === v)); }
    },
    setLabel(key, text) { const b = buttons.get(key); if (b) b.textContent = text; },
  };
  for (const [value, label] of options) {
    const b = button(null, label, () => { if (api.value === value) return; api.set(value); onChange?.(value); });
    buttons.set(value, b);
    node.append(b);
  }
  api.set(initial);
  return api;
}

// Celda de métricas (<dt>/<dd>).
export function stat(label, value = '—') {
  const node = el('div', 'jp-stat');
  const dd = el('dd', null, value);
  node.append(el('dt', null, label), dd);
  return { node, set: (v) => { dd.textContent = v; } };
}

export function statGrid(cls, entries) {
  const dl = el('dl', `jp-stats ${cls || ''}`);
  const stats = {};
  for (const [key, label] of entries) { stats[key] = stat(label); dl.append(stats[key].node); }
  return { node: dl, stats };
}

// Rango con etiqueta. label(v) devuelve el texto según el valor.
export function range({ min, max, step, value, label, cls, onInput }) {
  const wrap = el('label', cls || 'jp-range');
  const text = el('span', 'jp-mono-label');
  const input = el('input');
  input.type = 'range'; input.min = min; input.max = max; input.step = step; input.value = value;
  const sync = () => { text.textContent = label(Number(input.value)); };
  input.addEventListener('input', () => { sync(); onInput?.(Number(input.value)); });
  wrap.append(text, input);
  sync();
  return { node: wrap, input, text, sync, get value() { return Number(input.value); } };
}

export function fileInput(accept, onFile) {
  const input = el('input', 'jp-sr-only');
  input.type = 'file'; input.accept = accept;
  input.addEventListener('change', () => { const f = input.files?.[0] ?? null; input.value = ''; onFile(f); });
  return input;
}

// Zona para soltar/abrir una imagen.
export function makeDropTarget(node, input, onFile) {
  node.addEventListener('click', () => input.click());
  node.addEventListener('dragover', (e) => { e.preventDefault(); node.classList.add('drag'); });
  node.addEventListener('dragleave', () => node.classList.remove('drag'));
  node.addEventListener('drop', (e) => {
    e.preventDefault(); e.stopPropagation(); node.classList.remove('drag');
    onFile(e.dataTransfer?.files?.[0] ?? null);
  });
}

export function placeBox(node, box) {
  node.style.left = `${box.left * 100}%`;
  node.style.top = `${box.top * 100}%`;
  node.style.width = `${(box.right - box.left) * 100}%`;
  node.style.height = `${(box.bottom - box.top) * 100}%`;
  return node;
}

export function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('No se pudo leer la imagen.'));
    reader.readAsDataURL(blob);
  });
}

// POST JSON a /api/lab/jev-pixel/<step>. Devuelve { ok, status, data }.
export async function post(step, body, signal) {
  const res = await fetch(`/api/lab/jev-pixel/${step}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal,
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

export function revoke(url) { if (url) URL.revokeObjectURL(url); }

// Mosaico N×N de divs (Exp 1 y 2): blanco es sí, negro es no.
export function mosaic(cells, grid, threshold, { zoom = false } = {}) {
  const node = el('div', `jp-mosaic${zoom ? ' zoom' : ''}`);
  node.style.gridTemplateColumns = `repeat(${grid}, minmax(0, 1fr))`;
  node.style.gridTemplateRows = `repeat(${grid}, minmax(0, 1fr))`;
  for (const cell of cells) {
    const on = cell.probability >= threshold;
    const d = el('div', on ? 'on' : 'off');
    d.title = `${pct(cell.probability)} · r${cell.row + 1} c${cell.col + 1}`;
    if (on) d.style.opacity = String(zoom ? 0.4 + cell.probability * 0.6 : 0.35 + cell.probability * 0.65);
    node.append(d);
  }
  return node;
}

// Subtítulo editable (Exp 2 y 3). Enter guarda, Escape cancela; vacío vuelve al anterior.
export function editableSubtitle(initial, ariaLabel) {
  let value = initial;
  const node = el('div', 'jp-subtitle');
  const show = () => {
    const p = el('p', 'jp-serif-sub', value);
    const edit = button('jp-chip-btn', 'Editar subtítulo', () => editMode());
    node.replaceChildren(p, edit);
  };
  const editMode = () => {
    const input = el('input', 'jp-subtitle-input');
    input.value = value; input.setAttribute('aria-label', ariaLabel);
    const save = () => { const next = input.value.trim(); if (next) value = next; show(); };
    input.addEventListener('keydown', (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Enter') { e.preventDefault(); save(); } else if (e.key === 'Escape') show();
    });
    node.replaceChildren(input, button('jp-btn primary-sm', 'Guardar', save), button('jp-btn', 'Cancelar', show));
    input.focus();
  };
  show();
  return node;
}

// Sección plegable de un experimento (cabecera + botón Abrir/Ocultar).
export function experimentSection({ n, kicker, badge, title, subtitle, active, open, body }) {
  const section = el('section', `jp-exp${active ? ' active' : ''}`);
  section.setAttribute('aria-label', title);
  const head = el('div', 'jp-exp-head');
  const left = el('div', 'jp-exp-title');
  if (kicker) left.append(el('span', 'jp-kicker', kicker));
  const row = el('div', 'jp-exp-row');
  if (badge) row.append(el('span', 'jp-badge', badge));
  row.append(el('h2', 'jp-h2', title));
  left.append(row);
  if (subtitle) left.append(typeof subtitle === 'string' ? el('p', 'jp-serif-sub', subtitle) : subtitle);
  const toggle = button('jp-btn jp-toggle');
  const content = el('div', 'jp-exp-body');
  content.append(body);
  const sync = () => {
    toggle.textContent = open ? `Ocultar Experimento ${n}` : `Abrir Experimento ${n}`;
    toggle.setAttribute('aria-expanded', String(open));
    content.hidden = !open;
  };
  toggle.addEventListener('click', () => { open = !open; sync(); });
  head.append(left, toggle);
  section.append(head, content);
  sync();
  return section;
}

// Nota técnica plegable (Brief Metodológico de Exp 3 y 4). summary/cards llevan HTML estático propio.
export function brief({ tag, title, summary, cards, footer }) {
  const aside = el('aside', 'jp-brief');
  const head = el('div', 'jp-brief-head');
  const titleWrap = el('div', 'jp-brief-title');
  if (tag) titleWrap.append(el('span', 'jp-tag', tag));
  titleWrap.append(el('h3', 'jp-mono-label strong', title));
  const toggle = button('jp-btn');
  head.append(titleWrap, toggle);
  const body = el('div', 'jp-brief-body');
  const p = el('p'); p.innerHTML = summary;
  const grid = el('div', 'jp-brief-cards');
  for (const [cardTitle, html] of cards) {
    const c = el('div', 'jp-brief-card');
    const t = el('p', 'jp-brief-card-title', cardTitle);
    const d = el('p'); d.innerHTML = html;
    c.append(t, d);
    grid.append(c);
  }
  body.append(p, grid);
  const foot = footer ? el('div', 'jp-brief-foot') : null;
  let expanded = false;
  const sync = () => {
    toggle.textContent = expanded ? 'Achicar nota técnica' : 'Expandir nota técnica completa';
    toggle.setAttribute('aria-expanded', String(expanded));
    p.classList.toggle('clamp', !expanded);
    grid.hidden = !expanded;
    if (foot) foot.hidden = expanded;
  };
  toggle.addEventListener('click', () => { expanded = !expanded; sync(); });
  aside.append(head, body);
  if (foot) {
    foot.append(el('span', 'jp-mono-small', footer), button('jp-link', 'Ver explicación técnica completa →', () => { expanded = true; sync(); }));
    aside.append(foot);
  }
  sync();
  return aside;
}

// Muestras de sujeto ("Probar:").
export function samples(list, onPick, prefix) {
  const wrap = el('div', 'jp-samples');
  if (prefix) wrap.append(el('span', 'jp-mono-small', prefix));
  for (const s of list) wrap.append(button('jp-chip-btn', s, () => onPick(s)));
  return wrap;
}

export function textInput(value, placeholder, cls = 'jp-input', maxLength) {
  const input = el('input', cls);
  input.type = 'text'; input.value = value; input.placeholder = placeholder;
  if (maxLength) input.maxLength = maxLength;
  // Enter durante composición IME no envía (como el original).
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.isComposing || e.keyCode === 229)) e.preventDefault(); });
  return input;
}
