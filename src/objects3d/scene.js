// Laboratorio · Objetos 3D (motor de objetos 3D decisional).
// Un cuadro del video + la lista de objetos que nos importan → preguntas cerradas para JEV
// (Box, Noul, Choice, Score) → un mapa de escena: dónde está cada cosa (X/Y), qué es (pisable,
// obstáculo…), qué tan lejos está (Z aproximado), qué tapa a qué (delante y detrás) y qué celdas
// de la cuadrícula son espacio libre.

import { JEV_MODEL } from './jev.js';

export const DEFAULT_MODEL = JEV_MODEL;
export const MAX_OBJECTS = 8;
export const MAX_COLS = 26; // columnas A…Z
export const MAX_ROWS = 20;
export const MAX_PER_REQUEST = 600; // preguntas por llamada a JEV en TypeSafe (el resto va en llamadas paralelas)
export const MAX_IMAGE_BYTES = 16 * 1024 * 1024;

// Qué es un objeto para la animación (localization).
export const ROLES = {
  pisable: 'Una superficie horizontal donde un personaje pequeño podría pararse o caminar (mesa, escritorio, piso, estante).',
  obstaculo: 'Un objeto con volumen que se interpone en el camino: un personaje tendría que saltarlo, pasarlo un pie y luego el otro, o rodearlo (un brazo, una taza, una caja).',
  persona: 'Una persona o una parte de su cuerpo que no es un obstáculo en el camino (cara, torso).',
  fondo: 'Pared, ventana, cielo o fondo lejano: no se pisa ni se choca.',
  otro: 'Ninguna de las anteriores.',
};

// Profundidad: de cerca a lejos. `m` es la distancia aproximada a la cámara de cada nivel.
export const DEPTH = [
  { label: 'Muy cerca de la cámara (menos de 1 m)', m: 0.6 },
  { label: 'Cerca (1 a 2 m)', m: 1.5 },
  { label: 'Media distancia (2 a 3 m)', m: 2.5 },
  { label: 'Lejos (3 a 5 m)', m: 4 },
  { label: 'Muy lejos o fondo (más de 5 m)', m: 6.5 },
];

export const colLabel = (c) => String.fromCharCode(65 + c);
export const cellName = (c, r) => `${colLabel(c)}${r + 1}`;
const clampInt = (v, lo, hi, def) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def; };
const clip01 = (v) => Math.min(1, Math.max(0, Number(v) || 0));

export function parseObjectsBody(body = {}) {
  const image = String(body.image || '');
  if (!/^data:image\/(png|jpeg);base64,/.test(image)) throw new Error('Falta el cuadro: una imagen PNG o JPEG en base64.');
  if (image.length * 0.75 > MAX_IMAGE_BYTES) throw new Error('La imagen supera 16 MB.');
  const seen = new Set();
  const objects = (Array.isArray(body.objects) ? body.objects : String(body.objects || '').split('\n'))
    .map((o) => String(o).trim().slice(0, 60))
    .filter((o) => o && !seen.has(o.toLowerCase()) && seen.add(o.toLowerCase()));
  if (!objects.length) throw new Error('Escribí al menos un objeto para buscar en la escena.');
  if (objects.length > MAX_OBJECTS) throw new Error(`Hasta ${MAX_OBJECTS} objetos por cuadro.`);
  const gridOnImage = body.gridOnImage !== false;
  return {
    image,
    objects,
    grid: { cols: clampInt(body.grid?.cols, 2, MAX_COLS, 16), rows: clampInt(body.grid?.rows, 2, MAX_ROWS, 9) },
    gridOnImage,
    // Sin la cuadrícula dibujada, JEV no puede saber cuál es la celda "F4".
    freeSpace: gridOnImage && !!body.freeSpace,
    pairs: body.pairs !== false && objects.length > 1,
    context: String(body.context || '').trim().slice(0, 2000),
    model: String(body.model || DEFAULT_MODEL).trim() || DEFAULT_MODEL,
  };
}

// El contexto que ve JEV: la descripción y el cuadro `photo` (con o sin la cuadrícula dibujada).
export function buildState(input) {
  const { cols, rows } = input.grid;
  const lines = ['Un cuadro de un video filmado con una cámara real. Queremos entender la escena en 3D para animar encima un personaje pequeño (como un muñeco de juguete) que camine, salte y se esconda detrás de las cosas.'];
  if (input.gridOnImage) lines.push(`Sobre la imagen hay una cuadrícula dibujada de ${cols} columnas (A a ${colLabel(cols - 1)}, de izquierda a derecha) y ${rows} filas (1 a ${rows}, de arriba abajo). Cada celda lleva su nombre escrito en la esquina superior izquierda, por ejemplo "A1" o "${cellName(Math.min(5, cols - 1), Math.min(3, rows - 1))}". Las líneas y los nombres de la cuadrícula no son parte de la escena.`);
  if (input.context) lines.push(`Contexto: ${input.context}`);
  return { escena: lines.join('\n'), photo: input.image };
}

// Todas las preguntas, con nombres estables para leer las respuestas.
export function buildQuestions(input) {
  const q = {};
  input.objects.forEach((name, i) => {
    q[`o${i}_present`] = { type: 'noul', instructions: `¿Se ve "${name}" en la imagen?`, criteria: { true: `Sí, hay ${name} visible en el cuadro.`, false: `No, no hay ${name} en el cuadro.` } };
    q[`o${i}_box`] = { type: 'box', instructions: `${name}` };
    q[`o${i}_role`] = { type: 'choice', instructions: `Para un personaje pequeño animado dentro de la escena, ¿qué es "${name}"?`, criteria: ROLES };
    q[`o${i}_depth`] = { type: 'score', instructions: `¿A qué distancia de la cámara está "${name}"?`, criteria: DEPTH.map((d) => d.label) };
  });
  if (input.pairs) {
    for (let i = 0; i < input.objects.length; i++) {
      for (let j = i + 1; j < input.objects.length; j++) {
        const [a, b] = [input.objects[i], input.objects[j]];
        q[`p${i}_${j}_closer`] = { type: 'noul', instructions: `¿"${a}" está más cerca de la cámara que "${b}"?`, criteria: { true: `${a} está delante (más cerca de la cámara) que ${b}.`, false: `${b} está delante (más cerca de la cámara) que ${a}.` } };
      }
    }
  }
  if (input.freeSpace) {
    for (let r = 0; r < input.grid.rows; r++) {
      for (let c = 0; c < input.grid.cols; c++) {
        const cell = cellName(c, r);
        q[`c_${cell}_free`] = { type: 'noul', instructions: `¿La celda ${cell} de la cuadrícula es espacio libre, donde se podría poner un cartel o una animación sin tapar nada importante?`, criteria: { true: `La celda ${cell} muestra fondo liso, aire o una zona sin información relevante.`, false: `La celda ${cell} tiene una cara, una persona, un objeto importante o texto.` } };
      }
    }
  }
  return q;
}

export function chunkQuestions(questions, size = MAX_PER_REQUEST) {
  const entries = Object.entries(questions);
  const out = [];
  for (let k = 0; k < entries.length; k += size) out.push(Object.fromEntries(entries.slice(k, k + size)));
  return out;
}

// Celdas que toca un recuadro (fracciones 0–1 de la imagen).
export function boxCells(box, { cols, rows }) {
  const c0 = Math.min(cols - 1, Math.floor(clip01(box.left) * cols));
  const c1 = Math.min(cols - 1, Math.max(c0, Math.ceil(clip01(box.right) * cols) - 1));
  const r0 = Math.min(rows - 1, Math.floor(clip01(box.top) * rows));
  const r1 = Math.min(rows - 1, Math.max(r0, Math.ceil(clip01(box.bottom) * rows) - 1));
  return { from: cellName(c0, r0), to: cellName(c1, r1), cols: [c0, c1], rows: [r0, r1] };
}

// Score de JEV (0 = muy cerca … 4 = muy lejos) → metros aproximados, interpolando entre niveles.
export function depthMeters(score) {
  const s = Math.min(DEPTH.length - 1, Math.max(0, Number(score) || 0));
  const lo = Math.floor(s), hi = Math.min(DEPTH.length - 1, lo + 1);
  return +(DEPTH[lo].m + (DEPTH[hi].m - DEPTH[lo].m) * (s - lo)).toFixed(2);
}

// Respuestas de JEV → mapa de escena.
export function buildScene(input, answers) {
  const n = input.objects.length;
  const objects = input.objects.map((name, i) => {
    const box = answers[`o${i}_box`]?.box || null;
    const role = answers[`o${i}_role`];
    const depth = answers[`o${i}_depth`];
    const nb = box && { top: clip01(box.top), bottom: clip01(box.bottom), left: clip01(box.left), right: clip01(box.right) };
    return {
      id: `o${i}`,
      name,
      present: answers[`o${i}_present`]?.noul ?? null,
      box: nb,
      boxConfidence: answers[`o${i}_box`]?.confidence ?? null,
      // Centro y "pie" del recuadro: el pie es donde un personaje se apoyaría.
      center: nb && { x: +((nb.left + nb.right) / 2).toFixed(4), y: +((nb.top + nb.bottom) / 2).toFixed(4) },
      cells: nb && boxCells(nb, input.grid),
      role: role ? { choice: role.choice, confidence: role.confidence, probabilities: role.probabilities } : null,
      depth: depth ? { score: depth.score, meters: depthMeters(depth.score), confidence: depth.confidence, probabilities: depth.probabilities } : null,
    };
  });

  // Delante y detrás: cada objeto suma la probabilidad de estar más cerca que cada otro.
  // Sin comparaciones (o con un solo objeto) se ordena por la distancia estimada.
  const closer = Array.from({ length: n }, () => Array(n).fill(null));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const p = answers[`p${i}_${j}_closer`]?.noul;
      if (p === undefined || p === null) continue;
      closer[i][j] = p; closer[j][i] = 1 - p;
    }
  }
  const visible = objects.filter((o) => o.present === null || o.present >= 0.5);
  const front = (o) => {
    const i = Number(o.id.slice(1));
    const row = closer[i].filter((p, j) => p !== null && visible.some((v) => v.id === `o${j}`));
    return row.length ? row.reduce((s, p) => s + p, 0) / row.length : null;
  };
  const order = [...visible].sort((a, b) => {
    const fa = front(a), fb = front(b);
    if (fa !== null && fb !== null && fa !== fb) return fb - fa;
    return (a.depth?.meters ?? 99) - (b.depth?.meters ?? 99);
  });
  order.forEach((o, k) => { o.zIndex = order.length - k; o.frontness = front(o); }); // zIndex alto = más cerca de la cámara

  // Escala relativa: lo que mide 1 a la distancia del objeto más cercano se ve 1/d más chico más lejos.
  const nearest = Math.min(...visible.map((o) => o.depth?.meters ?? Infinity));
  for (const o of objects) o.scale = Number.isFinite(nearest) && o.depth ? +(nearest / o.depth.meters).toFixed(3) : null;

  const free = [];
  if (input.freeSpace) {
    for (let r = 0; r < input.grid.rows; r++) {
      for (let c = 0; c < input.grid.cols; c++) {
        const cell = cellName(c, r);
        const p = answers[`c_${cell}_free`]?.noul;
        if (p !== undefined && p !== null) free.push({ cell, col: c, row: r, p });
      }
    }
  }
  return { grid: input.grid, gridOnImage: input.gridOnImage, objects, order: order.map((o) => o.id), closer, free };
}
