import { el } from './shared.js';
import { SEATS, nextStep } from './table-core.js';

// Mesa de agentes · la escena. Una sala isométrica (SVG) donde cada lámpara es un agente.
// Nada es decorado: la luz dice quién habla, la cabeza de cada lámpara mira a quien escucha,
// la nube muestra lo que piensa, los papeles sobre la mesa son los archivos (en el centro, de todos;
// bajo una lámpara, solo de ese agente) y la pila junto a cada lámpara cuenta sus aportes.
// El estado vive en table.js: esto solo lo dibuja y avisa de los toques.
const NS = 'http://www.w3.org/2000/svg';
const W = 1200, H = 610, CX = 600, CY = 350, RX = 330, RY = 165, THICK = 26;
const ANGLE = { A: 215, B: 325, C: 35, D: 145 };       // en el plano de la mesa; A → B → C → D es sentido horario
const MIRROR = { A: 1, B: -1, C: -1, D: 1 };           // las lámparas de la derecha miran hacia la izquierda
// Codos de la lámpara, con la base en (0, 0). Las de adelante son más bajas: así no tapan lo que está sobre la mesa.
const ARMS = { back: { J1: [-14, -86], J2: [52, -128] }, front: { J1: [-10, -58], J2: [44, -92] } };
const arms = (seat) => (['A', 'B'].includes(seat) ? ARMS.back : ARMS.front);
const MOUTH = 40, MOUTH_R = 22;
const PUBLIC_SLOTS = [95, 265, 245, 120, 290, 70, 180, 0, 162, 18];   // ángulos lejos de los cuatro asientos

const rad = (d) => (d * Math.PI) / 180;
const plane = (deg, r) => [CX + r * Math.cos(rad(deg)), CY + r * Math.sin(rad(deg)) * (RY / RX)];
const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
const base = (seat) => plane(ANGLE[seat], RX * 0.9);
const pool = (seat) => lerp(base(seat), [CX, CY], 0.42);
const hash = (s) => [...String(s)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7);
const clip = (text, n) => (text.length > n ? `${text.slice(0, n - 1).trimEnd()}…` : text);
const tail = (text, n) => (text.length > n ? `…${text.slice(-n).trimStart()}` : text);

function svg(tag, attrs = {}, parent) {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  parent?.append(n);
  return n;
}
const titled = (node, text) => { (node.querySelector(':scope > title') || svg('title', {}, node)).textContent = text; };
const pos = (node, [x, y]) => { node.style.left = `${(x / W) * 100}%`; node.style.top = `${(y / H) * 100}%`; };

// Envolvente convexa (para el cono de luz: boca de la lámpara + charco en la mesa).
function hull(points) {
  const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const half = (list) => list.reduce((h, q) => { while (h.length > 1 && cross(h.at(-2), h.at(-1), q) <= 0) h.pop(); h.push(q); return h; }, []);
  return [...half(p).slice(0, -1), ...half([...p].reverse()).slice(0, -1)];
}

function buildRoom(root) {
  const defs = svg('defs', {}, root);
  defs.innerHTML = `
    <pattern id="ts-tiles" width="120" height="60" patternUnits="userSpaceOnUse"><path d="M0 30 L60 0 L120 30 L60 60 Z" fill="none" class="ts-tile-line"/></pattern>
    <radialGradient id="ts-shadow"><stop offset="0" stop-color="#000" stop-opacity=".32"/><stop offset="1" stop-color="#000" stop-opacity="0"/></radialGradient>
    <radialGradient id="ts-wood" cx=".45" cy=".35" r=".75"><stop offset="0" class="ts-wood-hi"/><stop offset="1" class="ts-wood-lo"/></radialGradient>
    <radialGradient id="ts-bulb"><stop offset="0" stop-color="#fffbe8"/><stop offset=".35" stop-color="#ffe9a8" stop-opacity=".75"/><stop offset="1" stop-color="#ffd37a" stop-opacity="0"/></radialGradient>
    ${SEATS.map((s) => `
      <radialGradient id="ts-pool-${s}"><stop offset="0" stop-color="#fff6d6" stop-opacity=".95"/><stop offset=".55" style="stop-color: var(--seat-${s.toLowerCase()})" stop-opacity=".28"/><stop offset="1" style="stop-color: var(--seat-${s.toLowerCase()})" stop-opacity="0"/></radialGradient>
      <linearGradient id="ts-cone-${s}" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#fff4cc" stop-opacity=".7"/><stop offset="1" style="stop-color: var(--seat-${s.toLowerCase()})" stop-opacity=".08"/></linearGradient>`).join('')}`;
  svg('rect', { width: W, height: H, class: 'ts-floor' }, root);
  svg('rect', { width: W, height: H, fill: 'url(#ts-tiles)' }, root);
  svg('ellipse', { cx: CX, cy: CY + 40, rx: 520, ry: 260, class: 'ts-rug' }, root);
  svg('ellipse', { cx: CX, cy: CY + 40, rx: 490, ry: 245, class: 'ts-rug-line' }, root);
  svg('ellipse', { cx: CX, cy: CY + 70, rx: RX + 40, ry: RY + 30, fill: 'url(#ts-shadow)' }, root);
}

// La mesa: tocarla agrega archivos para los cuatro; también es donde se sueltan.
function buildTable(root) {
  const g = svg('g', { class: 'ts-table', 'data-drop': 'table', role: 'button', tabindex: '0', 'aria-label': 'Mesa: agregar archivos que ven los cuatro' }, root);
  svg('path', { class: 'ts-table-side', d: `M ${CX - RX} ${CY} A ${RX} ${RY} 0 0 0 ${CX + RX} ${CY} L ${CX + RX} ${CY + THICK} A ${RX} ${RY} 0 0 1 ${CX - RX} ${CY + THICK} Z` }, g);
  svg('ellipse', { class: 'ts-table-top', cx: CX, cy: CY, rx: RX, ry: RY, fill: 'url(#ts-wood)' }, g);
  for (const k of [0.82, 0.6, 0.36]) svg('ellipse', { class: 'ts-grain', cx: CX + 8 * k, cy: CY - 3 * k, rx: RX * k, ry: RY * k }, g);
  svg('ellipse', { class: 'ts-table-rim', cx: CX, cy: CY, rx: RX - 2, ry: RY - 1 }, g);
  svg('ellipse', { class: 'ts-table-drop', cx: CX, cy: CY, rx: RX - 10, ry: RY - 6 }, g);
  titled(g, 'Tocá la mesa o soltá archivos: los ven los cuatro');
  return g;
}

function buildLamp(seat, layer) {
  const [bx, by] = base(seat);
  const { J1, J2 } = arms(seat);
  const g = svg('g', { class: 'ts-lamp', 'data-seat': seat, 'data-drop': seat, role: 'button', tabindex: '0', style: `--seat: var(--seat-${seat.toLowerCase()})` }, layer);
  svg('ellipse', { class: 'ts-lamp-shadow', cx: bx + 6, cy: by + 4, rx: 38, ry: 13 }, g);
  const body = svg('g', { transform: `translate(${bx} ${by}) scale(${MIRROR[seat]} 1)` }, g);
  svg('ellipse', { class: 'ts-focus-ring', cx: 0, cy: -2, rx: 42, ry: 16 }, body);
  svg('path', { class: 'ts-dark', d: 'M -30 -6 L -30 0 A 30 11 0 0 0 30 0 L 30 -6 Z' }, body);
  svg('ellipse', { class: 'ts-tone', cx: 0, cy: -6, rx: 30, ry: 11 }, body);
  svg('ellipse', { class: 'ts-hi', cx: -6, cy: -8, rx: 16, ry: 5 }, body);
  svg('line', { class: 'ts-arm', x1: 0, y1: -10, x2: J1[0], y2: J1[1] }, body);
  svg('line', { class: 'ts-spring', x1: 6, y1: -16, x2: J1[0] + 8, y2: J1[1] + 10 }, body);
  svg('line', { class: 'ts-arm', x1: J1[0], y1: J1[1], x2: J2[0], y2: J2[1] }, body);
  svg('line', { class: 'ts-spring', x1: J1[0] + 6, y1: J1[1] + 6, x2: J2[0] - 4, y2: J2[1] + 10 }, body);
  svg('circle', { class: 'ts-joint', cx: J1[0], cy: J1[1], r: 6 }, body);
  // La cabeza gira hacia donde mira el agente (CSS transform: así la transición es suave).
  const head = svg('g', { class: 'ts-head' }, body);
  const bob = svg('g', { class: 'ts-bob' }, head);
  svg('circle', { class: 'ts-glow', cx: MOUTH + 4, cy: 0, r: 46, fill: 'url(#ts-bulb)' }, bob);
  svg('circle', { class: 'ts-dark', cx: 0, cy: 0, r: 10 }, bob);
  svg('path', { class: 'ts-tone', d: `M 2 -11 L ${MOUTH} -${MOUTH_R + 3} Q ${MOUTH + 5} 0 ${MOUTH} ${MOUTH_R + 3} L 2 11 Z` }, bob);
  svg('path', { class: 'ts-hi', d: `M 6 -9 L ${MOUTH - 4} -${MOUTH_R}`, fill: 'none' }, bob);
  svg('ellipse', { class: 'ts-bulb', cx: MOUTH, cy: 0, rx: 5, ry: MOUTH_R }, bob);
  svg('circle', { class: 'ts-joint', cx: 0, cy: 0, r: 5 }, bob);
  return { g, head, bx, by };
}

// Un papel en el plano de la mesa: se ve achatado como la mesa y se levanta al pasarle el mouse.
function paperNode(item) {
  const g = svg('g', { class: `ts-paper kind-${item.kind}${item.to !== 'table' ? ' private' : ''}`, role: 'button', tabindex: '0', style: `--seat: var(--seat-${item.to === 'table' ? 'a' : item.to.toLowerCase()})` });
  const lift = svg('g', { class: 'ts-lift' }, g);
  const flat = svg('g', { transform: `scale(1 ${RY / RX}) rotate(${item.rot})` }, lift);
  const box = (w, h, cls) => { svg('rect', { class: 'ts-paper-shadow', x: -w / 2 + 3, y: -h / 2 + 4, width: w, height: h, rx: 2 }, flat); return svg('rect', { class: cls, x: -w / 2, y: -h / 2, width: w, height: h, rx: 2 }, flat); };
  const lines = (x, y, w, n, gap = 7) => { for (let i = 0; i < n; i++) svg('line', { class: 'ts-ink', x1: x, y1: y + i * gap, x2: x + w * (i === n - 1 ? 0.6 : 1), y2: y + i * gap }, flat); };
  if (item.kind === 'note') {
    box(58, 58, 'ts-note');
    lines(-21, -14, 42, 4, 9);
  } else if (item.kind === 'image') {
    box(84, 70, 'ts-sheet');
    if (item.data) svg('image', { href: item.data, x: -38, y: -31, width: 76, height: 52, preserveAspectRatio: 'xMidYMid slice' }, flat);
    else svg('rect', { class: 'ts-missing', x: -38, y: -31, width: 76, height: 52 }, flat);
    svg('text', { class: 'ts-code', x: -38, y: 31 }, flat).textContent = item.code;
  } else {
    box(58, 74, 'ts-sheet');
    svg('path', { class: 'ts-fold', d: 'M 17 -37 L 29 -25 L 17 -25 Z' }, flat);
    svg('rect', { class: item.kind === 'pdf' ? 'ts-pdf-band' : 'ts-txt-band', x: -24, y: -30, width: 26, height: 12, rx: 2 }, flat);
    svg('text', { class: 'ts-band-text', x: -11, y: -21 }, flat).textContent = item.kind === 'pdf' ? 'PDF' : 'TXT';
    lines(-22, -6, 44, 4);
    svg('text', { class: 'ts-code', x: -24, y: 33 }, flat).textContent = item.code;
  }
  if (item.to !== 'table') svg('circle', { class: 'ts-lock', cx: 0, cy: 0, r: 6, transform: `translate(${item.kind === 'note' ? 24 : 30} -${item.kind === 'note' ? 24 : 28})` }, flat);
  titled(g, item.title);
  return g;
}

export function createScene(mount, on) {
  mount.replaceChildren();
  const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'ts-svg', role: 'group', 'aria-label': 'Sala de la mesa de agentes' }, mount);
  buildRoom(root);
  const table = buildTable(root);
  const mission = svg('g', { class: 'ts-mission', role: 'button', tabindex: '0' }, root);
  const papers = svg('g', { class: 'ts-papers' }, root);
  const stacks = svg('g', { class: 'ts-stacks' }, root);
  const dim = svg('rect', { class: 'ts-dim', width: W, height: H }, root);
  const light = svg('g', { class: 'ts-light' }, root);
  const token = svg('g', { class: 'ts-token', hidden: '' }, root);
  const back = svg('g', {}, root), front = svg('g', {}, root);
  const overlay = el('div', 'ts-overlay');
  mount.append(overlay);

  // Hoja de la misión, en el centro: lo que la mesa tiene que entregar (y después, la entrega).
  const flat = svg('g', { transform: `translate(${CX} ${CY}) scale(1 ${RY / RX}) rotate(-4)` }, mission);
  svg('rect', { class: 'ts-mission-glow', x: -112, y: -78, width: 224, height: 156, rx: 14 }, flat);
  svg('rect', { class: 'ts-paper-shadow', x: -86, y: -54, width: 178, height: 116, rx: 3 }, flat);
  svg('rect', { class: 'ts-sheet ts-mission-sheet', x: -90, y: -60, width: 180, height: 120, rx: 3 }, flat);
  const missionTitle = svg('text', { class: 'ts-mission-title', x: -74, y: -32 }, flat);
  const missionText = svg('text', { class: 'ts-mission-text', x: -74, y: -10 }, flat);
  for (let i = 0; i < 3; i++) svg('line', { class: 'ts-ink', x1: -74, y1: 10 + i * 14, x2: i === 2 ? 20 : 74, y2: 10 + i * 14 }, flat);
  const seal = svg('g', { class: 'ts-seal', transform: 'translate(62 34)' }, flat);
  svg('circle', { r: 17 }, seal);
  svg('path', { d: 'M -7 0 L -2 5 L 8 -6', fill: 'none' }, seal);

  // Ficha de turno: se desliza hasta quien habla (o habla después).
  svg('ellipse', { class: 'ts-token-side', cx: 0, cy: 4, rx: 17, ry: 8 }, token);
  svg('ellipse', { class: 'ts-token-top', cx: 0, cy: 0, rx: 17, ry: 8 }, token);
  svg('path', { class: 'ts-token-mark', d: 'M -3 -3.5 L 5 0 L -3 3.5 Z' }, token);

  const lamps = {};
  for (const seat of SEATS) {
    const lamp = buildLamp(seat, ['A', 'B'].includes(seat) ? back : front);
    const cone = svg('polygon', { class: 'ts-cone', fill: `url(#ts-cone-${seat})`, 'data-seat': seat }, light);
    const spot = svg('ellipse', { class: 'ts-pool', fill: `url(#ts-pool-${seat})`, 'data-seat': seat }, light);
    const stack = svg('g', { class: 'ts-stack', role: 'button', tabindex: '0', style: `--seat: var(--seat-${seat.toLowerCase()})` }, stacks);
    const plate = el('button', 'ts-plate'); plate.type = 'button'; plate.style.setProperty('--seat', `var(--seat-${seat.toLowerCase()})`);
    pos(plate, [lamp.bx, lamp.by + 18]);
    const cloud = el('button', `ts-cloud seat-${seat.toLowerCase()}`); cloud.type = 'button'; cloud.style.setProperty('--seat', `var(--seat-${seat.toLowerCase()})`);
    plate.dataset.drop = seat; cloud.dataset.drop = seat; // soltar sobre su cartel o su nube también es privado
    overlay.append(plate, cloud);
    lamps[seat] = { ...lamp, cone, spot, stack, plate, cloud };
    const pick = () => on.seat(seat);
    lamp.g.addEventListener('click', pick); plate.onclick = pick;
    cloud.onclick = () => on.cloud(seat);
    stack.addEventListener('click', () => on.cloud(seat));
  }
  const finalCloud = el('button', 'ts-cloud final'); finalCloud.type = 'button';
  finalCloud.onclick = () => on.mission();
  const hint = el('p', 'ts-hint', 'Tocá la mesa o soltá PDFs e imágenes: los ven los cuatro.');
  pos(hint, [CX, CY + RY + THICK + 26]);
  const dropHint = el('p', 'ts-drop-hint'); dropHint.hidden = true;
  overlay.append(finalCloud, hint, dropHint);

  table.addEventListener('click', () => on.table());
  mission.addEventListener('click', () => on.mission());
  papers.addEventListener('click', (e) => { const p = e.target.closest('.ts-paper'); if (p) on.paper(p.dataset.key); });
  // Teclado: Enter o espacio sobre cualquier objeto tocable de la sala.
  root.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const n = e.target.closest('[role="button"]');
    if (!n) return;
    e.preventDefault(); n.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });

  const nodes = new Map(); // key → papel ya dibujado (para no repetir la animación de "caer en la mesa")
  let tokenSeat = null, current = null;

  function lampState(seat, view) {
    const { session, streaming } = view;
    const agent = session.agents.find((a) => a.seat === seat);
    if (session.status === 'setup') return agent.name.trim() && agent.model.trim() ? 'ready' : 'off';
    if (streaming?.seat === 'final' || session.status === 'synthesis' || session.final) return 'focus';
    if (streaming?.seat === seat) return streaming.text ? 'speaking' : 'thinking';
    const last = view.last(seat);
    if (!last) return 'waiting';
    if (last.done) return 'done';
    return last.action === 'pass' ? 'pass' : 'listening';
  }

  function aimOf(seat, state, speaker) {
    if (state === 'focus') return [CX, CY];
    if (state === 'off' || state === 'pass') return lerp(base(seat), [CX, CY], 0.2);
    if (speaker && speaker !== seat) return pool(speaker);
    return pool(seat);
  }

  function placeLamp(seat, state, target) {
    const L = lamps[seat], s = MIRROR[seat], { J2 } = arms(seat);
    const local = [(target[0] - L.bx) * s, target[1] - L.by];
    const angle = Math.atan2(local[1] - J2[1], local[0] - J2[0]);
    L.head.style.transform = `translate(${J2[0]}px, ${J2[1]}px) rotate(${(angle * 180) / Math.PI}deg)`;
    const mouth = (side) => {
      const x = J2[0] + Math.cos(angle) * MOUTH - Math.sin(angle) * MOUTH_R * side;
      const y = J2[1] + Math.sin(angle) * MOUTH + Math.cos(angle) * MOUTH_R * side;
      return [L.bx + x * s, L.by + y];
    };
    const [rx, ry] = state === 'focus' ? [128, 62] : [96, 46];
    const m1 = mouth(1), m2 = mouth(-1);
    L.cone.setAttribute('points', hull([m1, m2, [target[0] - rx * 0.86, target[1]], [target[0] + rx * 0.86, target[1]], [target[0], target[1] + ry * 0.9]]).map((p) => p.map((v) => v.toFixed(1)).join(',')).join(' '));
    const grad = root.getElementById(`ts-cone-${seat}`);
    const mid = lerp(m1, m2, 0.5);
    grad.setAttribute('x1', mid[0]); grad.setAttribute('y1', mid[1]); grad.setAttribute('x2', target[0]); grad.setAttribute('y2', target[1]);
    Object.entries({ cx: target[0], cy: target[1], rx, ry }).forEach(([k, v]) => L.spot.setAttribute(k, v));
    for (const n of [L.g, L.cone, L.spot]) n.dataset.state = state;
  }

  function cloudFor(seat, state, view) {
    const { session, streaming } = view;
    const agent = session.agents.find((a) => a.seat === seat);
    const last = view.last(seat);
    if (state === 'off') return { cls: 'hint', text: 'Tocame para darme nombre, modelo y misión.' };
    if (state === 'ready') return { cls: 'hint', text: agent.mission.trim() ? `«${clip(agent.mission.trim(), 110)}»` : 'Listo para sentarme a la mesa.' };
    if (state === 'thinking') return { cls: 'active thinking', text: streaming.note || '' };
    if (state === 'speaking') return { cls: 'active', text: tail(streaming.text, 260) };
    if (state === 'focus' || !last) return null;
    if (last.action === 'pass') return { cls: 'past pass', text: last.text ? `Paso. ${clip(last.text, 80)}` : 'Paso esta vez.' };
    return { cls: `past${last.done ? ' done' : ''}`, text: clip(last.text, 120) };
  }

  function setCloud(node, data, label) {
    node.hidden = !data;
    if (!data) return;
    node.className = `${node.className.split(' ').filter((c) => c === 'ts-cloud' || c.startsWith('seat-') || c === 'final').join(' ')} ${data.cls}`;
    node.setAttribute('aria-label', label);
    if (data.cls.includes('thinking')) {
      node.replaceChildren(el('span', 'ts-dots'));
      node.firstChild.append(el('i'), el('i'), el('i'));
      if (data.text) node.append(el('small', null, data.text));
    } else node.replaceChildren(el('span', 'ts-cloud-text', data.text));
  }

  function plateFor(seat, state, view) {
    const agent = view.session.agents.find((a) => a.seat === seat);
    const order = view.session.order;
    const words = {
      off: 'Sin configurar', ready: 'Listo', thinking: 'Pensando…', speaking: 'Hablando…', listening: 'Escuchando',
      pass: 'Pasó', done: 'Listo ✓', waiting: order ? `Habla ${order.indexOf(seat) + 1}º` : 'Esperando', focus: 'Escucha al relator',
    };
    const L = lamps[seat];
    L.plate.dataset.state = state;
    L.plate.replaceChildren(el('b', null, seat), el('span', 'ts-plate-name', agent.name.trim() || `Agente ${seat}`), el('span', 'ts-plate-state', words[state]));
    L.plate.setAttribute('aria-label', `Agente ${seat}, ${agent.name || 'sin nombre'}: ${words[state]}. Ver su asiento`);
    L.g.setAttribute('aria-label', `Lámpara de ${agent.name || `el agente ${seat}`}: ${words[state]}. Soltá un archivo acá para que lo vea solo este agente`);
    titled(L.g, `${seat} · ${agent.name || 'sin nombre'} — soltá acá un archivo que vea solo este agente`);
  }

  function renderStacks(view) {
    for (const seat of SEATS) {
      const L = lamps[seat];
      const count = view.session.log.filter((e) => e.type === 'agent' && e.seat === seat && e.action === 'speak').length;
      L.stack.replaceChildren();
      L.stack.toggleAttribute('hidden', !count);
      if (!count) continue;
      const [x, y] = plane(ANGLE[seat] + (MIRROR[seat] === 1 ? 14 : -14), RX * 0.74);
      for (let i = 0; i < Math.min(count, 7); i++) {
        const sheet = svg('g', { transform: `translate(${x} ${y - i * 2.6}) scale(1 ${RY / RX}) rotate(${(hash(seat + i) % 9) - 4 + ANGLE[seat] / 10})` }, L.stack);
        svg('rect', { class: i ? 'ts-sheet' : 'ts-paper-shadow', x: -15, y: -19, width: 30, height: 38, rx: 1.5 }, sheet);
        if (i === Math.min(count, 7) - 1) for (let k = 0; k < 3; k++) svg('line', { class: 'ts-ink', x1: -10, y1: -10 + k * 7, x2: 10, y2: -10 + k * 7 }, sheet);
      }
      svg('rect', { class: 'ts-sheet', x: x - 15, y: y - 10, width: 30, height: 19, opacity: 0 }, L.stack);
      titled(L.stack, `${count} ${count === 1 ? 'aporte' : 'aportes'} de ${seat}: tocá para leer el último`);
      L.stack.setAttribute('aria-label', `${count} aportes de ${seat}`);
    }
  }

  // Archivos y mensajes tuyos: los de la mesa alrededor de la misión; los privados, en la luz de su lámpara.
  function renderPapers(view) {
    const { session, fileData } = view;
    const items = session.files.map((f) => ({ key: `f:${f.code}`, kind: f.kind, to: f.to, code: f.code, data: fileData[f.code], title: `${f.code} · ${f.name} — ${f.to === 'table' ? 'lo ven los cuatro' : `solo lo ve ${f.to}`}` }));
    const notes = session.log.map((e, i) => ({ e, i })).filter(({ e }) => e.type === 'user' && e.text);
    const keep = (list, to, n) => list.filter(({ e }) => e.to === to).slice(-n);
    for (const { e, i } of [...keep(notes, 'table', 4), ...SEATS.flatMap((s) => keep(notes, s, 2))]) {
      items.push({ key: `n:${i}`, kind: 'note', to: e.to, code: '', title: `Vos → ${e.to === 'table' ? 'toda la mesa' : `solo ${e.to}`}: ${clip(e.text, 160)}` });
    }
    const slots = {};
    const seen = new Set();
    for (const item of items) {
      const n = (slots[item.to] = (slots[item.to] ?? -1) + 1);
      // Los de la mesa van entre lámpara y lámpara (adelante, atrás, a los costados de la misión); los privados, en la luz de su dueño.
      const at = item.to === 'table'
        ? plane(PUBLIC_SLOTS[n % PUBLIC_SLOTS.length] + Math.floor(n / PUBLIC_SLOTS.length) * 9, RX * (n % 2 ? 0.44 : 0.52))
        : plane(ANGLE[item.to] + [-12, 12, 0, -24, 24][n % 5], RX * (0.66 - Math.floor(n / 5) * 0.1));
      item.rot = (Math.abs(hash(item.key)) % 30) - 15;
      let node = nodes.get(item.key);
      if (!node) {
        node = paperNode(item);
        node.dataset.key = item.key;
        node.classList.add('dropped');
        nodes.set(item.key, node);
        setTimeout(() => node.classList.remove('dropped'), 700);
      } else if (item.kind === 'image' && item.data && !node.querySelector('image')) {
        const fresh = paperNode(item); fresh.dataset.key = item.key; node.replaceWith(fresh); nodes.set(item.key, fresh); node = fresh;
      }
      node.style.transform = `translate(${at[0].toFixed(1)}px, ${at[1].toFixed(1)}px)`;
      node.setAttribute('aria-label', item.title);
      seen.add(item.key);
    }
    for (const [key, node] of nodes) if (!seen.has(key)) { node.remove(); nodes.delete(key); }
    // Más atrás en la sala = se dibuja primero.
    papers.replaceChildren(...[...nodes.values()].sort((a, b) => parseFloat(a.style.transform.split(',')[1]) - parseFloat(b.style.transform.split(',')[1])));
    hint.hidden = session.status === 'done' || items.some((it) => it.to === 'table');
  }

  function renderToken(view) {
    const { session, streaming } = view;
    let seat = streaming && streaming.seat !== 'final' ? streaming.seat : null;
    if (!seat && session.order && !['done', 'synthesis'].includes(session.status) && !session.forceClose) {
      const step = nextStep(session);
      if (step.kind === 'turn') seat = step.seat;
    }
    if (!seat) { token.setAttribute('hidden', ''); tokenSeat = null; return; }
    const [x, y] = plane(ANGLE[seat], RX * 0.48);
    token.style.setProperty('--seat', `var(--seat-${seat.toLowerCase()})`);
    if (token.hasAttribute('hidden')) {
      // Primera vez (el sorteo): la ficha nace en el centro y viaja hasta quien empieza.
      token.style.transition = 'none'; token.style.transform = `translate(${CX}px, ${CY}px) scale(.2)`;
      token.removeAttribute('hidden'); token.getBoundingClientRect(); token.style.transition = '';
    }
    token.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
    titled(token, `Turno de ${seat}`);
    tokenSeat = seat;
  }

  function renderMission(view) {
    const { session, streaming } = view;
    const done = !!session.final;
    mission.dataset.state = done ? 'done' : streaming?.seat === 'final' || session.status === 'synthesis' ? 'writing' : session.goal.trim() ? 'set' : 'empty';
    missionTitle.textContent = done ? 'ENTREGA FINAL' : 'MISIÓN';
    missionText.textContent = clip(session.goal.trim() || 'Escribí qué tiene que entregar la mesa', 34);
    const label = done ? 'Hoja de la entrega final: abrirla' : session.status === 'setup' ? `Misión final: ${session.goal.trim() || 'sin escribir'}. Editarla` : `Misión final: ${session.goal}`;
    mission.setAttribute('aria-label', label); titled(mission, label);
  }

  return {
    render(view) {
      current = view;
      const { session, streaming } = view;
      mount.dataset.phase = session.status;
      const speaker = streaming && streaming.seat !== 'final' ? streaming.seat : null;
      for (const seat of SEATS) {
        const state = lampState(seat, view);
        placeLamp(seat, state, aimOf(seat, state, speaker));
        plateFor(seat, state, view);
        const agent = session.agents.find((a) => a.seat === seat);
        setCloud(lamps[seat].cloud, cloudFor(seat, state, view), `Lo último de ${agent.name || seat}: ir a la conversación`);
      }
      const writing = streaming?.seat === 'final';
      setCloud(finalCloud, writing ? { cls: 'active', text: tail(streaming.text || streaming.note || 'Leyendo toda la mesa…', 220) } : session.final ? { cls: 'past done', text: 'La entrega final está lista. Tocá la hoja para leerla.' } : null, 'Entrega final');
      renderMission(view); renderPapers(view); renderStacks(view); renderToken(view);
    },
    // Mientras llega el texto, solo se tocan las nubes (sin redibujar la sala).
    live(streaming) {
      if (!current || !streaming) return;
      current = { ...current, streaming };
      if (streaming.seat === 'final') return setCloud(finalCloud, { cls: 'active', text: tail(streaming.text || streaming.note || 'Leyendo toda la mesa…', 220) }, 'Entrega final');
      const seat = streaming.seat;
      const state = streaming.text ? 'speaking' : 'thinking';
      if (lamps[seat].g.dataset.state !== state) return this.render(current);
      setCloud(lamps[seat].cloud, cloudFor(seat, state, current), 'Lo que está diciendo');
    },
    // Al arrastrar un archivo: se ilumina dónde va a caer y se dice quién lo va a ver.
    drag(target, names) {
      mount.dataset.drag = target || '';
      table.classList.toggle('drop-over', target === 'table');
      for (const seat of SEATS) lamps[seat].g.classList.toggle('drop-over', target === seat);
      dropHint.hidden = !target;
      if (target) dropHint.textContent = target === 'table' ? 'Soltalo en la mesa: lo ven los cuatro' : `Soltalo en la lámpara: solo lo ve ${names[target] || target}`;
    },
    seatOfToken: () => tokenSeat,
  };
}
