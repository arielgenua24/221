// JEV construye · el idioma de las piezas. Módulo puro (sin DOM ni three.js): lo usan el servidor y el navegador.
// El LLM planifica un paso = una pieza de un objeto ("el tronco del pino") y le hace a JEV de 1 a 4 preguntas.
// Cada opción es un parche sobre la pieza; JEV elige una opción por pregunta y los parches se suman en orden.
// La pieza final se expande en nodos (primitivas con tamaño, posición, rotación y color) que dibuja three.js.
//
// Coordenadas: metros, Y hacia arriba, el suelo en Y = 0. X a la derecha y Z hacia la cámara.
// `position` es el CENTRO de la primitiva, relativo al origen del objeto (su punto en el suelo).
// `size` es la caja que ocupa [ancho X, alto Y, fondo Z] antes de rotar. `rotation` en grados [X, Y, Z].

export const PRIMITIVES = ['sphere', 'box', 'cylinder', 'cone', 'capsule', 'torus', 'ellipsoid', 'prism'];
export const PATTERNS = ['single', 'cluster', 'ring', 'line'];
export const LIMITS = { questions: 4, optionsMin: 2, optionsMax: 6, repeat: 40, nodes: 1500, parts: 200, label: 160, question: 600, coord: 50, size: 30 };

const fail = (message) => Object.assign(new Error(message), { status: 400 });
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const slug = (v) => text(String(v ?? ''), 40).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function vec(v, lo, hi, name) {
  if (typeof v === 'number') v = [v, v, v];
  if (!Array.isArray(v) || v.length !== 3) throw fail(`${name} tiene que ser [x, y, z].`);
  return v.map((n) => {
    const x = Number(n);
    if (!Number.isFinite(x)) throw fail(`${name} tiene un número inválido.`);
    return +clamp(x, lo, hi).toFixed(3);
  });
}

function color(v) {
  const s = text(v, 9);
  if (/^#[0-9a-f]{6}$/i.test(s)) return s.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(s)) return `#${[...s.slice(1)].map((c) => c + c).join('')}`.toLowerCase();
  throw fail(`Color inválido: ${v} (usar #rrggbb).`);
}

// Un parche: solo los campos presentes, ya validados.
export function parsePatch(p = {}) {
  if (!isObj(p)) throw fail('Cada parche tiene que ser un objeto.');
  const out = {};
  if (p.primitive !== undefined) {
    if (!PRIMITIVES.includes(p.primitive)) throw fail(`Primitiva desconocida: ${p.primitive}.`);
    out.primitive = p.primitive;
  }
  if (p.size !== undefined) out.size = vec(p.size, 0.01, LIMITS.size, 'size');
  if (p.position !== undefined) out.position = vec(p.position, -LIMITS.coord, LIMITS.coord, 'position');
  if (p.rotation !== undefined) out.rotation = vec(p.rotation, -360, 360, 'rotation');
  if (p.color !== undefined) out.color = color(p.color);
  if (p.objectPosition !== undefined) out.objectPosition = vec(p.objectPosition, -LIMITS.coord, LIMITS.coord, 'objectPosition');
  if (p.repeat !== undefined) {
    const r = p.repeat;
    if (!isObj(r)) throw fail('repeat tiene que ser un objeto.');
    const pattern = r.pattern ?? 'cluster';
    if (!PATTERNS.includes(pattern)) throw fail(`Patrón desconocido: ${pattern}.`);
    const count = Math.round(Number(r.count ?? 1));
    if (!Number.isFinite(count) || count < 1) throw fail('repeat.count tiene que ser un número ≥ 1.');
    out.repeat = {
      pattern,
      count: clamp(count, 1, LIMITS.repeat),
      spread: vec(r.spread ?? [0.5, 0.5, 0.5], 0, LIMITS.size, 'repeat.spread'),
      jitter: +clamp(Number(r.jitter ?? 0.15) || 0, 0, 0.8).toFixed(2),
    };
  }
  return out;
}

// La respuesta del LLM para un paso → paso validado. Lanza un error legible para devolvérselo al LLM.
export function parseStep(raw) {
  if (!isObj(raw)) throw fail('La respuesta tiene que ser un objeto JSON.');
  const thought = text(raw.thought, 400);
  if (raw.done === true) return { done: true, thought, summary: text(raw.summary, 400) };
  const object = isObj(raw.object) ? raw.object : {};
  const objectId = slug(object.id || object.label);
  if (!objectId) throw fail('Falta object.id (el objeto que se está construyendo, por ejemplo "pino").');
  return { done: false, thought, object: { id: objectId, label: text(object.label, LIMITS.label) || objectId }, ...parsePiece(raw) };
}

// Una pieza: part + base + preguntas. La fase 1 exige al menos una pregunta; en el plano de la fase 2 una pieza
// obvia puede venir sin preguntas (se construye directo, sin consultar a JEV).
function parsePiece(raw, { minQuestions = 1, maxQuestions = LIMITS.questions, maxOptions = LIMITS.optionsMax, where = '' } = {}) {
  const part = isObj(raw.part) ? raw.part : {};
  const partId = slug(part.id || part.label);
  if (!partId) throw fail(`Falta part.id${where} (la pieza, por ejemplo "tronco").`);
  const questions = Array.isArray(raw.questions) ? raw.questions : [];
  if (questions.length < minQuestions) throw fail(`Falta questions${where}: al menos una pregunta con opciones para JEV.`);
  if (questions.length > maxQuestions) throw fail(`Máximo ${maxQuestions} preguntas por pieza${where}.`);
  const base = parsePatch(raw.base ?? {});
  const parsed = questions.map((q, i) => {
    if (!isObj(q)) throw fail(`La pregunta ${i + 1}${where} no es un objeto.`);
    const question = text(q.question, LIMITS.question);
    if (!question) throw fail(`La pregunta ${i + 1}${where} no tiene texto.`);
    const options = Array.isArray(q.options) ? q.options : [];
    if (options.length < LIMITS.optionsMin || options.length > maxOptions) throw fail(`La pregunta ${i + 1}${where} necesita de ${LIMITS.optionsMin} a ${maxOptions} opciones.`);
    return {
      key: slug(q.key) || `q${i + 1}`,
      question,
      options: options.map((o, j) => {
        if (!isObj(o)) throw fail(`La opción ${j + 1} de la pregunta ${i + 1}${where} no es un objeto.`);
        const label = text(o.label, LIMITS.label);
        if (!label) throw fail(`La opción ${j + 1} de la pregunta ${i + 1}${where} no tiene label.`);
        return { label, patch: parsePatch(o.patch ?? {}) };
      }),
    };
  });
  // La pieza tiene que quedar completa con cualquier combinación de opciones.
  for (const field of ['primitive', 'size', 'position']) {
    const everywhere = base[field] !== undefined || parsed.some((q) => q.options.every((o) => o.patch[field] !== undefined));
    if (!everywhere) throw fail(`El campo "${field}"${where} no queda definido: ponelo en base o en todas las opciones de una pregunta.`);
  }
  return { part: { id: partId, label: text(part.label, LIMITS.label) || partId }, base, questions: parsed };
}

// ---------- Fase 2 · time reducing ----------
// 1) Ideas: el LLM nombra los objetos que faltan, los ubica y propone conceptos EN PALABRAS (pocos tokens).
// 2) JEV elige un concepto por objeto leyendo el texto (una sola llamada para todos los objetos).
// 3) Plano: el LLM escribe con números SOLO el concepto elegido, todas sus piezas de una vez (un pedido por objeto,
//    en paralelo). Las preguntas que quedan son de detalle visual y se resuelven con fotos.
// 4) JEV elige, para todas las piezas a la vez, entre las combinaciones de opciones dibujadas.
export const FAST = { objects: 10, conceptsMin: 2, conceptsMax: 4, pieces: 12, questions: 2, options: 3 };

export function parseIdeas(raw) {
  if (!isObj(raw)) throw fail('La respuesta tiene que ser un objeto JSON.');
  if (raw.done === true) return { done: true, summary: text(raw.summary, 400) };
  const objects = Array.isArray(raw.objects) ? raw.objects : [];
  if (!objects.length) throw fail('Falta objects: los objetos del pedido que todavía no están en la escena (o done).');
  // Si el modelo nombra más objetos que el tope, se construyen los primeros y se avisa cuántos quedaron afuera
  // (un dibujo con muchas cosas no tiene que cortar toda la corrida).
  const dropped = Math.max(0, objects.length - FAST.objects);
  const seen = new Set();
  return {
    done: false,
    ...(dropped ? { dropped } : {}),
    objects: objects.slice(0, FAST.objects).map((o, i) => {
      if (!isObj(o)) throw fail(`El objeto ${i + 1} no es un objeto.`);
      const id = slug(o.id || o.label);
      if (!id) throw fail(`Falta id en el objeto ${i + 1}.`);
      if (seen.has(id)) throw fail(`El id "${id}" está repetido.`);
      seen.add(id);
      const concepts = (Array.isArray(o.concepts) ? o.concepts : []).map((c) => text(typeof c === 'string' ? c : c?.label, LIMITS.label)).filter(Boolean);
      if (concepts.length < FAST.conceptsMin || concepts.length > FAST.conceptsMax) throw fail(`El objeto "${id}" necesita de ${FAST.conceptsMin} a ${FAST.conceptsMax} conceptos.`);
      return { id, label: text(o.label, LIMITS.label) || id, position: vec(o.position ?? [0, 0, 0], -LIMITS.coord, LIMITS.coord, 'position'), concepts };
    }),
  };
}

export function parseBlueprint(raw) {
  if (!isObj(raw)) throw fail('La respuesta tiene que ser un objeto JSON.');
  const pieces = Array.isArray(raw.pieces) ? raw.pieces : [];
  if (!pieces.length) throw fail('Falta pieces: las piezas del objeto, en orden de construcción.');
  if (pieces.length > FAST.pieces) throw fail(`Máximo ${FAST.pieces} piezas por objeto.`);
  const parsed = pieces.map((p, i) => {
    if (!isObj(p)) throw fail(`La pieza ${i + 1} no es un objeto.`);
    return parsePiece(p, { minQuestions: 0, maxQuestions: FAST.questions, maxOptions: FAST.options, where: ` (pieza ${i + 1})` });
  });
  const ids = parsed.map((p) => p.part.id);
  const dup = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dup) throw fail(`La pieza "${dup}" está repetida.`);
  return { pieces: parsed };
}

// Todas las combinaciones de opciones de una pieza (como mucho 3 × 3 = 9). Sin preguntas, una sola: la base.
export function combos(piece) {
  let out = [{ labels: [], picks: [], patch: { ...piece.base } }];
  for (const q of piece.questions) {
    out = out.flatMap((c) => q.options.map((o, j) => ({ labels: [...c.labels, o.label], picks: [...c.picks, j], patch: mergePatches(c.patch, o.patch) })));
  }
  return out.map((c) => ({ label: c.labels.join(' + ') || piece.part.label, picks: c.picks, patch: c.patch }));
}

// base + parches elegidos, en orden.
export function mergePatches(...patches) {
  const out = {};
  for (const p of patches) {
    for (const [k, v] of Object.entries(p || {})) out[k] = k === 'repeat' && out.repeat ? { ...out.repeat, ...v } : v;
  }
  return out;
}

export const DEFAULTS = { rotation: [0, 0, 0], color: '#9a9a9a' };

// Generador determinista a partir de un texto (la misma pieza siempre se expande igual).
function rng(seed) {
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return () => {
    h += 0x6d2b79f5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Pieza → nodos. Con repeat: cluster (al azar dentro de un elipsoide de radios spread), ring (en círculo
// horizontal de radios spread[0] (X) y spread[2] (Z), cada copia girada en Y para que su +X local apunte hacia afuera) o line (de position
// a position + spread). jitter varía el tamaño de cada copia.
export function expandPiece(spec, seed = 'pieza') {
  const s = { ...DEFAULTS, ...spec };
  if (!s.primitive || !s.size || !s.position) throw fail('La pieza está incompleta (primitive, size y position).');
  const r = s.repeat || { pattern: 'single', count: 1, spread: [0, 0, 0], jitter: 0 };
  const count = r.pattern === 'single' ? 1 : r.count;
  const rand = rng(seed);
  const nodes = [];
  for (let i = 0; i < count; i++) {
    let offset = [0, 0, 0], spin = 0;
    if (r.pattern === 'cluster' && count > 1) {
      // Punto uniforme dentro de la esfera unidad, estirado a los radios spread.
      let p;
      do p = [rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1]; while (Math.hypot(...p) > 1);
      offset = p.map((v, k) => v * r.spread[k]);
    } else if (r.pattern === 'ring') {
      const a = (i / count) * Math.PI * 2;
      offset = [Math.cos(a) * r.spread[0], 0, Math.sin(a) * (r.spread[2] || r.spread[0])];
      spin = -(a * 180) / Math.PI;
    } else if (r.pattern === 'line') {
      const t = count === 1 ? 0 : i / (count - 1);
      offset = r.spread.map((v) => v * t);
    }
    const k = 1 + (rand() * 2 - 1) * r.jitter;
    nodes.push({
      primitive: s.primitive,
      size: s.size.map((v) => +(v * k).toFixed(3)),
      position: s.position.map((v, j) => +(v + offset[j]).toFixed(3)),
      rotation: [s.rotation[0], +(s.rotation[1] + spin).toFixed(2), s.rotation[2]],
      color: s.color,
    });
  }
  return nodes;
}

// Resumen de texto de la escena para el LLM: qué hay, dónde y de qué tamaño.
export function describeScene(scene) {
  const objects = Object.values(scene?.objects || {});
  if (!objects.length) return 'La escena está vacía: solo el suelo (Y = 0).';
  const lines = [];
  for (const o of objects) {
    const parts = (scene.parts || []).filter((p) => p.object === o.id);
    lines.push(`Objeto "${o.id}" (${o.label}) con origen en [${o.position.join(', ')}]:`);
    for (const p of parts) {
      const s = p.spec;
      const rep = s.repeat && s.repeat.pattern !== 'single' ? ` · ${s.repeat.count} copias en ${s.repeat.pattern}, spread [${s.repeat.spread.join(', ')}]` : '';
      lines.push(`  - "${p.id}" (${p.label}): ${s.primitive}, size [${s.size.join(', ')}], position [${s.position.join(', ')}], rotation [${(s.rotation || DEFAULTS.rotation).join(', ')}], color ${s.color || DEFAULTS.color}${rep}`);
    }
  }
  return lines.join('\n');
}

// Aplica una pieza terminada a la escena (devuelve una escena nueva). La misma part.id reemplaza a la anterior.
export function applyPiece(scene, { object, part, spec }) {
  const objects = { ...(scene.objects || {}) };
  const prev = objects[object.id];
  objects[object.id] = { id: object.id, label: object.label, position: spec.objectPosition || prev?.position || [0, 0, 0] };
  const { objectPosition, ...pieceSpec } = spec;
  const nodes = expandPiece(pieceSpec, `${object.id}/${part.id}`);
  const parts = (scene.parts || []).filter((p) => !(p.object === object.id && p.id === part.id));
  parts.push({ object: object.id, id: part.id, label: part.label, spec: pieceSpec, nodes });
  if (parts.length > LIMITS.parts) throw fail(`La escena ya tiene ${LIMITS.parts} piezas.`);
  if (parts.reduce((n, p) => n + p.nodes.length, 0) > LIMITS.nodes) throw fail(`La escena superaría ${LIMITS.nodes} primitivas.`);
  return { objects, parts };
}

// ---------- Fase 3 · idioma por relaciones ----------
// El LLM dice QUÉ va DÓNDE respecto de qué, y las cuentas las hace el motor:
//   "on":   { "piece": "tronco" | "suelo", "side": "top"|"bottom"|"left"|"right"|"front"|"back", "offset"?: [x,y,z] }
//           apoya la pieza contra esa cara de la caja de otra pieza, centrada en ella.
//   "from" / "to" + "thickness": para lo alargado (brazos, patas, ramas): el motor saca largo, centro y rotación.
//   "at":   un punto. Un punto es [x,y,z] (relativo al origen del objeto), "pieza.ancla" o { "anchor": "pieza.ancla", "offset": [x,y,z] }.
//           Anclas: top, bottom, left, right, front, back, center (el centro de cada cara de la caja de la pieza).
//   "mirror": "x" crea además la copia reflejada del otro lado (X → −X), con id "<id>-espejo".
// Solo se puede referir a piezas anteriores del mismo objeto o al "suelo".
export const SIDES = ['top', 'bottom', 'left', 'right', 'front', 'back'];
export const ANCHORS = [...SIDES, 'center'];
const D2R = Math.PI / 180, R2D = 180 / Math.PI;

// Matriz de rotación de un Euler XYZ en grados (la misma convención que three.js).
function rotMatrix([rx, ry, rz]) {
  const a = Math.cos(rx * D2R), b = Math.sin(rx * D2R), c = Math.cos(ry * D2R), d = Math.sin(ry * D2R), e = Math.cos(rz * D2R), f = Math.sin(rz * D2R);
  return [[c * e, -c * f, d], [a * f + b * e * d, a * e - b * f * d, -b * c], [b * f - a * e * d, b * e + a * f * d, a * c]];
}

function matToEuler(m) {
  const y = Math.asin(Math.max(-1, Math.min(1, m[0][2])));
  const [x, z] = Math.abs(m[0][2]) < 0.9999999 ? [Math.atan2(-m[1][2], m[2][2]), Math.atan2(-m[0][1], m[0][0])] : [Math.atan2(m[2][1], m[1][1]), 0];
  return [x, y, z].map((v) => +(v * R2D).toFixed(2) + 0);
}

// Rotación que lleva el eje Y local (el largo de cilindros, conos y cápsulas) a la dirección d.
function eulerFromY(d) {
  const len = Math.hypot(...d);
  const [x, y, z] = d.map((v) => v / len);
  if (y > 0.999999) return [0, 0, 0];
  if (y < -0.999999) return [180, 0, 0];
  const k = [z, 0, -x].map((v) => v / Math.hypot(z, x)); // eje = Y × d
  const cos = y, sin = Math.sqrt(1 - y * y), t = 1 - cos;
  const [kx, ky, kz] = k;
  return matToEuler([
    [cos + kx * kx * t, kx * ky * t - kz * sin, kx * kz * t + ky * sin],
    [ky * kx * t + kz * sin, cos + ky * ky * t, ky * kz * t - kx * sin],
    [kz * kx * t - ky * sin, kz * ky * t + kx * sin, cos + kz * kz * t],
  ]);
}

// Reflejo respecto del plano X = 0: R' = M·R·M con M = diag(−1, 1, 1).
function mirrorEuler(rotation) {
  const m = rotMatrix(rotation);
  return matToEuler(m.map((row, i) => row.map((v, j) => v * (i === 0 ? -1 : 1) * (j === 0 ? -1 : 1))));
}

// Medias medidas de la caja alineada a los ejes que ocupa una primitiva rotada.
function halfExtents(size, rotation = [0, 0, 0]) {
  const m = rotMatrix(rotation);
  return m.map((row) => row.reduce((s, v, j) => s + Math.abs(v) * size[j] / 2, 0));
}

export function nodesBox(nodes) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const n of nodes) {
    const h = halfExtents(n.size, n.rotation);
    for (let i = 0; i < 3; i++) { min[i] = Math.min(min[i], n.position[i] - h[i]); max[i] = Math.max(max[i], n.position[i] + h[i]); }
  }
  return { min, max };
}

function anchorPoint(box, anchor) {
  const c = box.min.map((v, i) => (v + box.max[i]) / 2);
  const at = { top: [c[0], box.max[1], c[2]], bottom: [c[0], box.min[1], c[2]], left: [box.min[0], c[1], c[2]], right: [box.max[0], c[1], c[2]], front: [c[0], c[1], box.max[2]], back: [c[0], c[1], box.min[2]], center: c };
  return at[anchor];
}

const GROUND = { min: [-1e6, -1e6, -1e6], max: [1e6, 0, 1e6] };
function boxOf(ctx, piece) {
  if (piece === 'suelo') return GROUND;
  const box = ctx.get(piece);
  if (!box) throw fail(`"${piece}" todavía no existe: solo podés referirte a piezas anteriores del mismo objeto o a "suelo".`);
  return box;
}

const add3 = (a, b) => a.map((v, i) => +(v + (b?.[i] ?? 0)).toFixed(3));

// Un punto: [x,y,z], "pieza.ancla" o { anchor, offset }.
function parsePoint(v, name) {
  if (Array.isArray(v) || typeof v === 'number') return { xyz: vec(v, -LIMITS.coord, LIMITS.coord, name) };
  const raw = typeof v === 'string' ? { anchor: v } : isObj(v) ? v : null;
  if (!raw || typeof raw.anchor !== 'string') throw fail(`${name} tiene que ser [x,y,z], "pieza.ancla" o { "anchor": "pieza.ancla", "offset": [x,y,z] }.`);
  const [piece, anchor = 'center'] = raw.anchor.trim().split('.');
  if (!ANCHORS.includes(anchor)) throw fail(`Ancla desconocida en ${name}: "${anchor}" (usar ${ANCHORS.join(', ')}).`);
  return { piece: slug(piece) || piece, anchor, offset: raw.offset === undefined ? undefined : vec(raw.offset, -LIMITS.coord, LIMITS.coord, `${name}.offset`) };
}

const pointXYZ = (p, ctx) => (p.xyz ? p.xyz : add3(p.piece === 'suelo' ? [0, 0, 0] : anchorPoint(boxOf(ctx, p.piece), p.anchor), p.offset));

// Parche relacional: los campos de parsePatch más on / from / to / at / thickness / mirror.
export function parseRelPatch(p = {}) {
  if (!isObj(p)) throw fail('Cada parche tiene que ser un objeto.');
  const { on, from, to, at, thickness, mirror, ...rest } = p;
  const out = parsePatch(rest);
  if (on !== undefined) {
    if (!isObj(on) || typeof on.piece !== 'string') throw fail('"on" tiene que ser { "piece": "tronco" | "suelo", "side": "top" }.');
    const side = on.side ?? 'top';
    if (!SIDES.includes(side)) throw fail(`Cara desconocida en "on": "${side}" (usar ${SIDES.join(', ')}).`);
    out.on = { piece: on.piece === 'suelo' ? 'suelo' : slug(on.piece), side, ...(on.offset !== undefined ? { offset: vec(on.offset, -LIMITS.coord, LIMITS.coord, 'on.offset') } : {}) };
  }
  if (from !== undefined) out.from = parsePoint(from, 'from');
  if (to !== undefined) out.to = parsePoint(to, 'to');
  if (at !== undefined) out.at = parsePoint(at, 'at');
  if (thickness !== undefined) {
    const t = Number(thickness);
    if (!Number.isFinite(t) || t <= 0) throw fail('"thickness" tiene que ser un número mayor que 0.');
    out.thickness = +clamp(t, 0.005, LIMITS.size).toFixed(3);
  }
  if (mirror !== undefined && mirror !== false) {
    if (mirror !== 'x' && mirror !== true) throw fail('"mirror" solo puede ser "x".');
    out.mirror = 'x';
  }
  return out;
}

// Relaciones → pieza absoluta { primitive, size, position, rotation, color, repeat }.
export function resolvePiece(spec, ctx) {
  if (!spec.primitive) throw fail('Falta primitive.');
  let size = spec.size, rotation = spec.rotation || [0, 0, 0], position;
  if (spec.from || spec.to) {
    if (!spec.from || !spec.to) throw fail('"from" y "to" van juntos.');
    const a = pointXYZ(spec.from, ctx), b = pointXYZ(spec.to, ctx);
    const d = b.map((v, i) => v - a[i]);
    const len = Math.hypot(...d);
    if (len < 0.01) throw fail('"from" y "to" son el mismo punto.');
    const t = spec.thickness ?? size?.[0];
    if (!t) throw fail('Con "from"/"to" hace falta "thickness" (el grosor).');
    size = [t, +len.toFixed(3), size?.[2] ?? t];
    position = a.map((v, i) => +((v + b[i]) / 2).toFixed(3));
    rotation = eulerFromY(d);
  } else {
    if (!size) throw fail('Falta size (o "from"/"to" con "thickness").');
    if (spec.on) {
      const box = boxOf(ctx, spec.on.piece), h = halfExtents(size, rotation);
      const c = box === GROUND ? [0, 0, 0] : box.min.map((v, i) => (v + box.max[i]) / 2);
      const p = [...c];
      if (spec.on.side === 'top') p[1] = box.max[1] + h[1];
      if (spec.on.side === 'bottom') p[1] = box.min[1] - h[1];
      if (spec.on.side === 'right') p[0] = box.max[0] + h[0];
      if (spec.on.side === 'left') p[0] = box.min[0] - h[0];
      if (spec.on.side === 'front') p[2] = box.max[2] + h[2];
      if (spec.on.side === 'back') p[2] = box.min[2] - h[2];
      position = add3(p, spec.on.offset);
    } else if (spec.at) position = pointXYZ(spec.at, ctx);
    else if (spec.position) position = spec.position;
    else throw fail('Falta dónde va: "on", "at", "from"/"to" o position.');
  }
  return { primitive: spec.primitive, size, position, rotation, ...(spec.color ? { color: spec.color } : {}), ...(spec.repeat ? { repeat: spec.repeat } : {}) };
}

// Un objeto entero, en orden: cada pieza se resuelve con las cajas de las anteriores. Devuelve piezas absolutas,
// con las copias en espejo agregadas justo después de su original.
export function resolveObject(pieces) {
  const ctx = new Map(), out = [];
  for (const { part, spec } of pieces) {
    let abs;
    try { abs = resolvePiece(spec, ctx); } catch (err) { throw fail(`Pieza "${part.id}": ${err.message}`); }
    const copies = [{ part, spec: abs }];
    if (spec.mirror === 'x') {
      copies.push({ part: { id: `${part.id}-espejo`, label: `${part.label} (espejo)` }, spec: { ...abs, position: [-abs.position[0], abs.position[1], abs.position[2]].map((v) => v + 0), rotation: mirrorEuler(abs.rotation) } });
    }
    for (const c of copies) {
      ctx.set(c.part.id, nodesBox(expandPiece(c.spec, c.part.id)));
      out.push(c);
    }
  }
  return out;
}

// Plano relacional: como parseBlueprint, pero con parches relacionales, y se prueba resolver cada combinación
// (con la primera de las demás) para devolverle al LLM un error claro si algo no cierra.
export function parseRelBlueprint(raw) {
  if (!isObj(raw)) throw fail('La respuesta tiene que ser un objeto JSON.');
  const pieces = Array.isArray(raw.pieces) ? raw.pieces : [];
  if (!pieces.length) throw fail('Falta pieces: las piezas del objeto, en orden de construcción.');
  if (pieces.length > FAST.pieces) throw fail(`Máximo ${FAST.pieces} piezas por objeto.`);
  const parsed = pieces.map((p, i) => {
    const where = ` (pieza ${i + 1})`;
    if (!isObj(p)) throw fail(`La pieza ${i + 1} no es un objeto.`);
    const part = isObj(p.part) ? p.part : {};
    const id = slug(part.id || part.label);
    if (!id) throw fail(`Falta part.id${where}.`);
    const questions = Array.isArray(p.questions) ? p.questions : [];
    if (questions.length > FAST.questions) throw fail(`Máximo ${FAST.questions} preguntas por pieza${where}.`);
    return {
      part: { id, label: text(part.label, LIMITS.label) || id },
      base: parseRelPatch(p.base ?? {}),
      questions: questions.map((q, k) => {
        if (!isObj(q)) throw fail(`La pregunta ${k + 1}${where} no es un objeto.`);
        const question = text(q.question, LIMITS.question);
        if (!question) throw fail(`La pregunta ${k + 1}${where} no tiene texto.`);
        const options = Array.isArray(q.options) ? q.options : [];
        if (options.length < LIMITS.optionsMin || options.length > FAST.options) throw fail(`La pregunta ${k + 1}${where} necesita de ${LIMITS.optionsMin} a ${FAST.options} opciones.`);
        return { key: slug(q.key) || `q${k + 1}`, question, options: options.map((o, j) => {
          const label = text(o?.label, LIMITS.label);
          if (!label) throw fail(`La opción ${j + 1} de la pregunta ${k + 1}${where} no tiene label.`);
          return { label, patch: parseRelPatch(o.patch ?? {}) };
        }) };
      }),
    };
  });
  const ids = parsed.flatMap((p) => [p.part.id, ...(p.base.mirror ? [`${p.part.id}-espejo`] : [])]);
  const dup = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dup) throw fail(`La pieza "${dup}" está repetida.`);
  const first = parsed.map((p) => ({ part: p.part, spec: combos(p)[0].patch }));
  parsed.forEach((p, i) => {
    for (const c of combos(p)) resolveObject([...first.slice(0, i), { part: p.part, spec: c.patch }]);
  });
  return { pieces: parsed, language: 'relations' };
}

// ---------- Revisión del motor ----------
// Cajas alineadas a los ejes: aproximado (un cilindro inclinado ocupa más caja que cuerpo), así que avisa de lo
// evidente: piezas que flotan sin tocar nada y piezas escondidas casi enteras dentro de otra.
const boxGap = (a, b) => Math.hypot(...a.min.map((_, i) => Math.max(0, b.min[i] - a.max[i], a.min[i] - b.max[i])));
const volume = (b) => b.max.reduce((v, m, i) => v * Math.max(0, m - b.min[i]), 1);
const overlap = (a, b) => volume({ min: a.min.map((v, i) => Math.max(v, b.min[i])), max: a.max.map((v, i) => Math.min(v, b.max[i])) });

export function checkScene(scene, { gap = 0.05, max = 12 } = {}) {
  const issues = [];
  for (const o of Object.values(scene?.objects || {})) {
    const boxes = (scene.parts || []).filter((p) => p.object === o.id && p.nodes?.length).map((p) => ({ p, box: nodesBox(p.nodes) }));
    for (const a of boxes) {
      if (a.box.min[1] <= gap) continue;
      const near = boxes.filter((b) => b !== a).map((b) => ({ b, d: boxGap(a.box, b.box) })).sort((x, y) => x.d - y.d)[0];
      if (!near || near.d > gap) issues.push(`"${o.id}/${a.p.id}" flota: está a ${a.box.min[1].toFixed(2)} m del suelo${near ? ` y a ${near.d.toFixed(2)} m de "${near.b.p.id}", la pieza más cercana` : ''}.`);
    }
    for (const a of boxes) {
      if (a.p.spec?.repeat && a.p.spec.repeat.pattern !== 'single') continue;
      for (const b of boxes) {
        // Un racimo (repeat) es ralo: su caja no tapa lo que tiene adentro.
        if (a === b || volume(a.box) > volume(b.box) || (b.p.spec?.repeat && b.p.spec.repeat.pattern !== 'single')) continue;
        if (overlap(a.box, b.box) > 0.9 * volume(a.box)) { issues.push(`"${o.id}/${a.p.id}" queda casi entera dentro de "${b.p.id}" (no se va a ver).`); break; }
      }
    }
  }
  return issues.slice(0, max);
}
