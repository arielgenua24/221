// Objetos 3D · recreación 3D mínima del mapa de escena, en un cubo que se puede girar.
// Sin librerías: canvas 2D con proyección en perspectiva y orden del pintor.
// Cada objeto se "desproyecta" con una cámara estenopeica: un punto (u, v) del cuadro a la distancia d
// que estimó JEV queda en x = (u − ½)·d·FOV, y = (½ − v)·d·FOV·alto/ancho, z = d. Así lo lejano recupera
// su tamaño real (un escritorio al fondo se ve chico en el cuadro, pero en el cubo es grande).
// La forma sale de la silueta (Exp 3 o Exp 4) en bloques de una grilla; sin silueta, del recuadro.
// En lo pisable, los bloques de la superficie de arriba van en blanco y sus bordes en rojo.

const FOV = 1; // ancho visible a 1 m de la cámara, en metros (~53° horizontales)
const CELLS = 28; // bloques por lado de cada silueta
const TOP = [255, 255, 255], EDGE = [255, 45, 85];

const rgb = (hex) => { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const inside = (b, u, v) => u >= b.left && u <= b.right && v >= b.top && v <= b.bottom;

// Probabilidad de la silueta en un punto (u, v) del cuadro entero.
function sample(sil, u, v) {
  const b = sil.paddedBox;
  if (!inside(b, u, v)) return 0;
  const x = Math.min(sil.w - 1, Math.floor(((u - b.left) / (b.right - b.left)) * sil.w));
  const y = Math.min(sil.h - 1, Math.floor(((v - b.top) / (b.bottom - b.top)) * sil.h));
  return sil.prob[y * sil.w + x];
}

// Mapa de escena (+ siluetas) → bloques { x, y, z, sx, sy, sz, color } en metros.
export function buildBlocks({ scene, sils, method, aspect, colors }) {
  const blocks = [];
  scene.objects.forEach((o, k) => {
    if (!o.box || (o.present !== null && o.present < 0.5)) return;
    const d = o.depth?.meters ?? 3;
    const entry = sils?.[o.id]?.[method] || sils?.[o.id]?.exp4 || sils?.[o.id]?.exp3;
    const mask = entry?.mask, top = entry?.top;
    const area = mask ? mask.paddedBox : o.box;
    const cw = (area.right - area.left) / CELLS, ch = (area.bottom - area.top) / CELLS;
    const sx = cw * d * FOV, sy = ch * d * FOV * aspect;
    // Grosor: un cuarto del ancho real del objeto, entre 5 cm y 60 cm (JEV todavía no mide el fondo de las cosas).
    const sz = Math.min(0.6, Math.max(0.05, (o.box.right - o.box.left) * d * FOV * 0.25));
    const on = [], isTop = [];
    for (let j = 0; j < CELLS; j++) {
      for (let i = 0; i < CELLS; i++) {
        const u = area.left + (i + 0.5) * cw, v = area.top + (j + 0.5) * ch;
        on.push(mask ? sample(mask, u, v) >= 0.5 : true);
        isTop.push(!!top && sample(top, u, v) >= 0.5);
      }
    }
    const at = (a, i, j) => i >= 0 && j >= 0 && i < CELLS && j < CELLS && a[j * CELLS + i];
    const color = rgb(colors[k % colors.length]);
    for (let j = 0; j < CELLS; j++) {
      for (let i = 0; i < CELLS; i++) {
        if (!at(on, i, j) && !at(isTop, i, j)) continue;
        const u = area.left + (i + 0.5) * cw, v = area.top + (j + 0.5) * ch;
        const t = at(isTop, i, j);
        const edge = t && !(at(isTop, i - 1, j) && at(isTop, i + 1, j) && at(isTop, i, j - 1) && at(isTop, i, j + 1));
        blocks.push({
          x: (u - 0.5) * d * FOV, y: (0.5 - v) * d * FOV * aspect, z: d + sz / 2, sx, sy, sz,
          color: edge ? EDGE : t ? TOP : color,
          // Caras compartidas con un vecino no se dibujan.
          open: { l: !at(on, i - 1, j), r: !at(on, i + 1, j), u: !at(on, i, j - 1), d: !at(on, i, j + 1) },
        });
      }
    }
  });
  return blocks;
}

const FACES = [
  { n: [0, 0, -1], c: [[-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1]] }, // frente (hacia la cámara)
  { n: [0, 0, 1], c: [[-1, -1, 1], [-1, 1, 1], [1, 1, 1], [1, -1, 1]] },
  { n: [-1, 0, 0], c: [[-1, -1, -1], [-1, 1, -1], [-1, 1, 1], [-1, -1, 1]], open: 'l' },
  { n: [1, 0, 0], c: [[1, -1, -1], [1, -1, 1], [1, 1, 1], [1, 1, -1]], open: 'r' },
  { n: [0, 1, 0], c: [[-1, 1, -1], [1, 1, -1], [1, 1, 1], [-1, 1, 1]], open: 'u' },
  { n: [0, -1, 0], c: [[-1, -1, -1], [-1, -1, 1], [1, -1, 1], [1, -1, -1]], open: 'd' },
];
const LIGHT = (() => { const v = [-0.4, 0.7, -0.6]; const m = Math.hypot(...v); return v.map((x) => x / m); })();

// Vista interactiva: arrastrar gira, la rueda acerca. "Vista de cámara" vuelve al punto de vista del video.
export function create3dView() {
  const wrap = document.createElement('div');
  wrap.className = 'obj-3d';
  const canvas = document.createElement('canvas');
  canvas.className = 'obj-3d-canvas';
  const bar = document.createElement('div');
  bar.className = 'obj-3d-bar';
  const btn = (label, fn) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'small-btn'; b.textContent = label; b.onclick = fn; bar.append(b); return b; };
  wrap.append(canvas, bar);

  // back: cuánto se aleja la cámara del punto del video, en diagonales de la escena (0 = cámara del video).
  let blocks = [], box = null, cam = { yaw: 0.55, pitch: 0.35, zoom: 1, back: 0.6 };
  btn('Vista de cámara', () => { cam = { yaw: 0, pitch: 0, zoom: 1, back: 0 }; draw(); });
  btn('Vista 3D', () => { cam = { yaw: 0.55, pitch: 0.35, zoom: 1, back: 0.6 }; draw(); });
  btn('Desde arriba', () => { cam = { yaw: 0, pitch: 1.35, zoom: 1, back: 0.6 }; draw(); });

  let drag = null;
  canvas.onpointerdown = (e) => { if (!cam.back) cam.back = 0.6; drag = { x: e.clientX, y: e.clientY, ...cam }; canvas.setPointerCapture(e.pointerId); };
  canvas.onpointermove = (e) => {
    if (!drag) return;
    cam.yaw = drag.yaw + (e.clientX - drag.x) * 0.01;
    cam.pitch = Math.max(-1.5, Math.min(1.5, drag.pitch + (e.clientY - drag.y) * 0.01));
    draw();
  };
  canvas.onpointerup = () => { drag = null; };
  canvas.onwheel = (e) => { e.preventDefault(); cam.zoom = Math.max(0.3, Math.min(4, cam.zoom * (e.deltaY > 0 ? 0.9 : 1.1))); draw(); };

  function draw() {
    const W = canvas.clientWidth || 640, H = Math.round(W * 0.62), dpr = window.devicePixelRatio || 1;
    canvas.width = W * dpr; canvas.height = H * dpr; canvas.style.height = `${H}px`;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#14161a'; ctx.fillRect(0, 0, W, H);
    if (!box) return;
    // La cámara orbita alrededor de un punto del eje óptico, a la profundidad media de la escena.
    // Con giro 0 queda exactamente donde estaba la cámara del video.
    const zc = (box.min[2] + box.max[2]) / 2;
    const diag = Math.hypot(box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]);
    const dist = (zc + cam.back * diag) / cam.zoom;
    const cy = Math.cos(cam.yaw), sy = Math.sin(cam.yaw), cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
    const rot = ([x, y, z]) => { const x1 = cy * x - sy * z, z1 = sy * x + cy * z; return [x1, cp * y - sp * z1, sp * y + cp * z1]; };
    const view = ([x, y, z]) => { const [a, b, c] = rot([x, y, z - zc]); return [a, b, c + dist]; };
    const f = W * 0.9 / FOV;
    const proj = ([x, y, z]) => [W / 2 + (x * f) / Math.max(0.05, z), H / 2 - (y * f) / Math.max(0.05, z)];

    // El cubo: la caja que contiene la escena, con piso y paredes en alambre.
    const [x0, y0, z0] = box.min, [x1, y1, z1] = box.max;
    const corners = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]].map(view);
    ctx.strokeStyle = 'rgba(255,255,255,.25)'; ctx.lineWidth = 1;
    for (const [a, b] of [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]]) {
      if (corners[a][2] < 0.05 || corners[b][2] < 0.05) continue;
      const p = proj(corners[a]), q = proj(corners[b]);
      ctx.beginPath(); ctx.moveTo(...p); ctx.lineTo(...q); ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(255,255,255,.08)';
    for (let k = 1; k < 8; k++) {
      const z = z0 + ((z1 - z0) * k) / 8, x = x0 + ((x1 - x0) * k) / 8;
      for (const [a, b] of [[[x0, y0, z], [x1, y0, z]], [[x, y0, z0], [x, y0, z1]]]) {
        const va = view(a), vb = view(b);
        if (va[2] < 0.05 || vb[2] < 0.05) continue;
        ctx.beginPath(); ctx.moveTo(...proj(va)); ctx.lineTo(...proj(vb)); ctx.stroke();
      }
    }

    // Caras visibles, de la más lejana a la más cercana.
    const faces = [];
    for (const bl of blocks) {
      for (const face of FACES) {
        if (face.open && !bl.open[face.open]) continue;
        const n = rot(face.n);
        const pts = face.c.map(([a, b, c]) => view([bl.x + (a * bl.sx) / 2, bl.y + (b * bl.sy) / 2, bl.z + (c * bl.sz) / 2]));
        if (pts.some((p) => p[2] < 0.05)) continue;
        const cx = (pts[0][0] + pts[2][0]) / 2, cyy = (pts[0][1] + pts[2][1]) / 2, cz = (pts[0][2] + pts[2][2]) / 2;
        if (n[0] * cx + n[1] * cyy + n[2] * cz >= 0) continue; // de espaldas a la cámara
        const light = 0.5 + 0.5 * Math.max(0, -(n[0] * LIGHT[0] + n[1] * LIGHT[1] + n[2] * LIGHT[2]));
        faces.push({ pts, depth: cx * cx + cyy * cyy + cz * cz, color: bl.color, light });
      }
    }
    faces.sort((a, b) => b.depth - a.depth);
    for (const fc of faces) {
      ctx.fillStyle = `rgb(${fc.color.map((c) => Math.round(c * fc.light)).join(',')})`;
      ctx.beginPath();
      fc.pts.forEach((p, k) => { const [px, py] = proj(p); if (k) ctx.lineTo(px, py); else ctx.moveTo(px, py); });
      ctx.closePath(); ctx.fill();
    }
  }

  function update(next) {
    blocks = next;
    if (!blocks.length) { box = null; draw(); return; }
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (const b of blocks) {
      for (const [k, v, s] of [[0, b.x, b.sx], [1, b.y, b.sy], [2, b.z, b.sz]]) { min[k] = Math.min(min[k], v - s / 2); max[k] = Math.max(max[k], v + s / 2); }
    }
    const pad = 0.1 * Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
    box = { min: [min[0] - pad, min[1] - pad, Math.max(0.1, min[2] - pad)], max: [max[0] + pad, max[1] + pad, max[2] + pad] };
    draw();
  }

  window.addEventListener('resize', () => { if (wrap.isConnected) draw(); });
  return { el: wrap, update, draw };
}
