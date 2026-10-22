// JEV a píxel · los cuatro experimentos de reconstrucción (portados de jev-to-pix/lib/jev.ts).
// Cada función arma las preguntas de UNA llamada a JEV y lee sus respuestas. `ask` es la función que
// habla con JEV ({ model, state, questions, signal } → { model, answers, usage }): decide() de
// src/objects3d/jev.js en vivo o mockDecide() en demo. Las imágenes llegan como data URL PNG/JPEG.
//
//   Exp 1  reconstruct            8×8 noul sobre la imagen entera.
//   Exp 2  locateSubjectBox       box + noul de presencia → recorte; reconstructGrid N×N sobre el recorte.
//   Exp 3  reconstructHybridV3    16×16 noul + 4 box morfológicos en la misma llamada (el cliente sintetiza 48–80²).
//   Exp 4  reconstructSuperpixelsV4  un noul por superpíxel SLIC con su ID impreso + 4 box morfológicos.
//          refineUncertainTilesV4    tiles inciertos ampliados con retícula 4×4, todos en una llamada.

export const GRID = 8;
export const HIGH_RES_GRID = 16;
export const V4_MAX_K = 600;
export const V4_MIN_K = 64;
export const V4_MAX_REFINE_TILES = 40;
export const V4_TILE_SUBGRID = 4;

const clip01 = (v) => Math.max(0, Math.min(1, Number(v) || 0));
const cellKey = (row, col) => `r${row}c${col}`;
const usageOf = (r) => ({ input: r.usage?.input_tokens ?? 0, output: r.usage?.output_tokens ?? 0 });

export const MORPHOLOGICAL_SUB_BOX_DEFS = [
  { id: 'sub_core', label: 'Silueta núcleo (core)' },
  { id: 'sub_top', label: 'Tercio superior / copa' },
  { id: 'sub_mid', label: 'Sección media / cuerpo' },
  { id: 'sub_bot', label: 'Tercio inferior / ala-base' },
];

function morphologicalBoxQuestions(subject) {
  return {
    sub_core: { type: 'box', instructions: `the exact tight silhouette of ${subject} inside \`photo\`` },
    sub_top: { type: 'box', instructions: `the upper third or crown/top section of ${subject} inside \`photo\`` },
    sub_mid: { type: 'box', instructions: `the middle body section of ${subject} inside \`photo\`` },
    sub_bot: { type: 'box', instructions: `the lower third, base, or brim section of ${subject} inside \`photo\`` },
  };
}

export function readMorphologicalBoxes(answers) {
  const out = [];
  for (const def of MORPHOLOGICAL_SUB_BOX_DEFS) {
    const ans = answers[def.id];
    if (ans?.type === 'box' && ans.box) {
      out.push({
        id: def.id, label: def.label,
        box: { top: clip01(ans.box.top), bottom: clip01(ans.box.bottom), left: clip01(ans.box.left), right: clip01(ans.box.right) },
        confidence: ans.confidence ?? 0,
      });
    }
  }
  return out;
}

function gridQuestions(grid, question, labels) {
  const q = {};
  for (let row = 0; row < grid; row++) {
    for (let col = 0; col < grid; col++) {
      q[cellKey(row, col)] = {
        type: 'noul',
        instructions: {
          question,
          cell: {
            row: row + 1, column: col + 1, rows: grid, columns: grid,
            top: +(row / grid).toFixed(4), bottom: +((row + 1) / grid).toFixed(4),
            left: +(col / grid).toFixed(4), right: +((col + 1) / grid).toFixed(4),
          },
        },
        criteria: labels,
      };
    }
  }
  return q;
}

function readGrid(answers, grid) {
  const cells = [];
  let sum = 0, edge = 0;
  for (let row = 0; row < grid; row++) {
    for (let col = 0; col < grid; col++) {
      const a = answers[cellKey(row, col)];
      const probability = a?.type === 'noul' ? a.noul : 0;
      cells.push({ row, col, probability });
      sum += probability;
      edge += Math.abs(probability - 0.5) * 2;
    }
  }
  const total = grid * grid;
  return { cells, coverage: sum / total, decisiveness: edge / total };
}

// Exp 2 · paso 1 (y ciclo 1 de Exp 3 y 4): ¿está? + dónde.
export async function locateSubjectBox({ ask, model, image, subject, signal }) {
  const result = await ask({
    model, signal,
    state: { photo: image, subject },
    questions: {
      present: { type: 'noul', instructions: 'Is `subject` visibly present anywhere in `photo`?', criteria: { true: 'The subject is visible in the image.', false: 'The subject is not visible in the image.' } },
      region: { type: 'box', instructions: 'Locate `subject` in `photo`.' },
    },
  });
  const region = result.answers.region;
  const raw = region?.type === 'box' ? region.box : { top: 0, bottom: 1, left: 0, right: 1 };
  const top = Math.max(0, Math.min(0.95, raw.top));
  const left = Math.max(0, Math.min(0.95, raw.left));
  return {
    model: result.model,
    present: result.answers.present?.type === 'noul' ? result.answers.present.noul : 0,
    box: { top, left, bottom: Math.max(top + 0.05, Math.min(1, raw.bottom)), right: Math.max(left + 0.05, Math.min(1, raw.right)) },
    confidence: region?.type === 'box' ? region.confidence ?? null : null,
    usage: usageOf(result),
  };
}

// Exp 1 y Exp 2 · paso 2: una grilla N×N de noul.
export async function reconstructGrid({ ask, model, image, subject, grid = HIGH_RES_GRID, signal }) {
  const g = Math.max(4, Math.min(20, Math.round(grid)));
  const result = await ask({
    model, signal,
    state: { photo: image, subject },
    questions: gridQuestions(g, 'Does this cell of `photo` contain any part of `subject`?', {
      true: 'This cell visibly contains part of the subject.',
      false: 'This cell only contains background or other objects, not the subject.',
    }),
  });
  return { model: result.model, grid: g, ...readGrid(result.answers, g), usage: usageOf(result) };
}

export const reconstruct = (opts) => reconstructGrid({ ...opts, grid: GRID });

// Exp 3: grilla 16×16 + tomografía morfológica (4 box) en un solo ciclo.
export async function reconstructHybridV3({ ask, model, image, subject, baseGrid = 16, signal }) {
  const g = Math.min(20, Math.max(8, Math.round(baseGrid)));
  const questions = {
    ...morphologicalBoxQuestions(subject),
    ...gridQuestions(g, 'Does this grid cell of `photo` contain any visible part of `subject`?', {
      true: 'This cell visibly contains part of the target subject.',
      false: 'This cell only contains background or unrelated regions.',
    }),
  };
  const started = Date.now();
  const result = await ask({ model, signal, state: { photo: image, subject }, questions });
  return {
    model: result.model, baseGrid: g, ...readGrid(result.answers, g),
    subBoxes: readMorphologicalBoxes(result.answers),
    elapsedMs: Date.now() - started, question: subject, usage: usageOf(result),
  };
}

// Exp 4 · ciclo 2: un noul por superpíxel (ID impreso en la imagen) + 4 box morfológicos.
export async function reconstructSuperpixelsV4({ ask, model, labeledImage, k, subject, centroids, signal }) {
  const n = Math.min(V4_MAX_K, Math.max(V4_MIN_K, Math.floor(k)));
  const questions = morphologicalBoxQuestions(subject);
  // Preguntas cortas: con k hasta 600 el presupuesto de tokens manda; lo común va una vez en el state.
  for (let i = 0; i < n; i++) {
    const c = centroids?.[i];
    questions[`sp_${i}`] = c && Number.isFinite(c[0]) && Number.isFinite(c[1])
      ? { type: 'noul', instructions: `Region #${i} (${c[0].toFixed(2)},${c[1].toFixed(2)}) is \`subject\`?` }
      : { type: 'noul', instructions: `Region #${i} contains part of \`subject\`?` };
  }
  const started = Date.now();
  const result = await ask({
    model, signal, questions,
    state: {
      photo: labeledImage, subject,
      instructions: `\`photo\` is partitioned into outlined regions; each shows its numeric ID (#0..#${n - 1}) near its center. Answer per region whether any visible part of \`subject\` lies inside it.`,
    },
  });
  const probabilities = new Array(n);
  let missingAnswers = 0;
  for (let i = 0; i < n; i++) {
    const a = result.answers[`sp_${i}`];
    if (a?.type === 'noul') probabilities[i] = clip01(a.noul);
    else { probabilities[i] = 0.5; missingAnswers++; }
  }
  return { model: result.model, k: n, probabilities, missingAnswers, subBoxes: readMorphologicalBoxes(result.answers), elapsedMs: Date.now() - started, usage: usageOf(result) };
}

// Exp 4 · ciclo 3: cada tile incierto (recortado, ampliado y con retícula 4×4) es su propia imagen.
export async function refineUncertainTilesV4({ ask, model, tiles: all, subject, signal }) {
  const truncated = all.length > V4_MAX_REFINE_TILES;
  const tiles = all.slice(0, V4_MAX_REFINE_TILES);
  if (!tiles.length) return { model, tiles: [], truncated, missingAnswers: 0, elapsedMs: 0, usage: { input: 0, output: 0 } };
  const n = V4_TILE_SUBGRID;
  const state = {
    subject,
    instructions: `Each \`tile_*\` image is a zoomed-in crop with a printed ${n}x${n} reticle. Cells are addressed as r<row>c<col>, 1-based, top-left is r1c1. Answer per cell whether any visible part of \`subject\` lies inside it.`,
  };
  const questions = {};
  for (const tile of tiles) {
    const asset = `tile_${tile.tileId}`;
    state[asset] = tile.image;
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) questions[`${tile.tileId}_r${r}_c${c}`] = { type: 'noul', instructions: `\`${asset}\` cell r${r + 1}c${c + 1} contains \`subject\`?` };
  }
  const started = Date.now();
  const result = await ask({ model, signal, state, questions });
  let missingAnswers = 0;
  const out = tiles.map((tile) => {
    const sub = new Array(n * n);
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        const a = result.answers[`${tile.tileId}_r${r}_c${c}`];
        if (a?.type === 'noul') sub[r * n + c] = clip01(a.noul);
        else { sub[r * n + c] = 0.5; missingAnswers++; }
      }
    }
    return { tileId: tile.tileId, sub };
  });
  return { model: result.model, tiles: out, truncated, missingAnswers, elapsedMs: Date.now() - started, usage: usageOf(result) };
}
