// JEV construye · el lenguaje de las luces (el "look" de la escena). Módulo puro (sin three.js ni DOM), compartido
// por el servidor (valida lo que escribe el LLM) y el navegador (lo convierte en luces de verdad).
// El LLM habla como un iluminador, en ángulos respecto de la cámara del director: "la principal desde la izquierda
// del cuadro, 45° arriba". resolveLook lo pasa a posiciones en metros mirando al sujeto. Ya resuelto (un "rig") cada
// luz tiene position y target; si sigue al sujeto (la luz héroe), son relativos a su origen y viajan con él.
// La intensidad es la luz que llega al sujeto (0-10), no depende de la distancia: alejar una luz no la apaga.

export const LOOK = { minOptions: 2, maxOptions: 4, maxLights: 4, label: 80 };
export const ROLES = ['key', 'fill', 'rim', 'hero', 'practical'];
export const KINDS = ['spot', 'sun'];
// Colores con que se pinta cada luz en el mapa de luces (Tools → Luces → Mapa).
export const ROLE_COLORS = { key: '#ff3b30', fill: '#34c759', rim: '#2f7dff', hero: '#ffd60a', practical: '#ff7ad9' };
export const ROLE_LABELS = { key: 'Principal', fill: 'Relleno', rim: 'Contraluz', hero: 'Héroe', practical: 'Práctica' };

const fail = (message) => Object.assign(new Error(message), { status: 400 });
const HEX = /^#[0-9a-f]{6}$/i;
const r3 = (v) => +v.toFixed(3) + 0;
const num = (v, min, max, name, fallback) => {
  if (v === undefined && fallback !== undefined) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw fail(`${name} tiene que ser un número.`);
  return Math.min(max, Math.max(min, n));
};
const color = (v, name, fallback) => {
  if (v === undefined && fallback) return fallback;
  if (typeof v !== 'string' || !HEX.test(v.trim())) throw fail(`${name} tiene que ser un color "#rrggbb".`);
  return v.trim().toLowerCase();
};
const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

// Una luz como la escribe el LLM → validada.
function parseLight(l, i) {
  const at = `La luz ${i + 1}`;
  if (!l || typeof l !== 'object') throw fail(`${at} tiene que ser un objeto.`);
  const role = ROLES.includes(l.role) ? l.role : 'key';
  const kind = KINDS.includes(l.kind) ? l.kind : 'spot';
  const from = l.from && typeof l.from === 'object' ? l.from : {};
  return {
    role,
    kind,
    color: color(l.color, `${at}: color`, '#ffffff'),
    intensity: num(l.intensity, 0, 10, `${at}: intensity`, 3),
    from: { side: num(from.side, -180, 180, `${at}: from.side`, 0), height: num(from.height, -30, 90, `${at}: from.height`, 30), distance: num(from.distance, 1, 30, `${at}: from.distance`, 5) },
    softness: num(l.softness, 0, 1, `${at}: softness`, 0.5),
    shadow: l.shadow !== false && (l.shadow === true || role === 'key' || kind === 'sun'),
    follow: l.follow === true || role === 'hero',
  };
}

// Un look entero (como lo escribe el LLM) → validado.
export function parseLook(raw, i = 0) {
  if (!raw || typeof raw !== 'object') throw fail(`El look ${i + 1} tiene que ser un objeto.`);
  const label = text(raw.label, LOOK.label);
  if (!label) throw fail(`El look ${i + 1} necesita un "label" que diga cómo es.`);
  const lights = Array.isArray(raw.lights) ? raw.lights : [];
  if (!lights.length || lights.length > LOOK.maxLights) throw fail(`El look "${label}" necesita de 1 a ${LOOK.maxLights} luces.`);
  const sky = raw.sky && typeof raw.sky === 'object' ? raw.sky : {};
  return {
    label,
    idea: text(raw.idea, 300),
    exposure: num(raw.exposure, 0.3, 2.5, `"${label}": exposure`, 1),
    background: color(raw.background, `"${label}": background`, '#dfe6ea'),
    haze: num(raw.haze, 0, 1, `"${label}": haze`, 0),
    sky: { color: color(sky.color, `"${label}": sky.color`, '#ffffff'), ground: color(sky.ground, `"${label}": sky.ground`, '#8a7a5a'), intensity: num(sky.intensity, 0, 3, `"${label}": sky.intensity`, 0.6) },
    lights: lights.map(parseLight),
  };
}

// La respuesta del LLM: { looks: [...] } con 2 a 4 opciones para que elija JEV.
export function parseLooks(raw) {
  const list = Array.isArray(raw?.looks) ? raw.looks : [];
  if (list.length < LOOK.minOptions || list.length > LOOK.maxOptions) throw fail(`Hacen falta de ${LOOK.minOptions} a ${LOOK.maxOptions} looks.`);
  return list.map(parseLook);
}

// Dirección (unitaria) hacia una luz que está a `side` grados del eje de la cámara y `height` grados de alto.
// yaw: hacia dónde está la cámara vista desde el sujeto (atan2(x, z)). side 0 = desde la cámara, 90 = desde la
// derecha del cuadro, -90 = desde la izquierda, 180 = desde atrás del sujeto (contraluz).
function direction(yaw, side, height) {
  const d = [Math.sin(yaw), 0, Math.cos(yaw)]; // del sujeto hacia la cámara
  const right = [Math.cos(yaw), 0, -Math.sin(yaw)]; // la derecha del cuadro
  const s = side * Math.PI / 180, e = height * Math.PI / 180;
  const h = [0, 1, 2].map((k) => d[k] * Math.cos(s) + right[k] * Math.sin(s));
  return [h[0] * Math.cos(e), Math.sin(e), h[2] * Math.cos(e)];
}

// Look (en ángulos) → rig (en metros). subject: { id?, origin: [x,y,z] (su punto en el suelo), center, radius }.
// camera: posición de la cámara del director (de ahí sale el "lado" de cada luz).
export function resolveLook(look, { subject, camera }) {
  const { center, radius } = subject;
  const yaw = Math.atan2(camera[0] - center[0], camera[2] - center[2]);
  const lights = look.lights.map((l, i) => {
    const dir = direction(yaw, l.from.side, l.from.height);
    // El sol está lejos (solo importa la dirección); el resto, a la distancia pedida pero nunca adentro del sujeto.
    const dist = l.kind === 'sun' ? 20 : Math.max(l.from.distance, radius * 1.5);
    let position = center.map((c, k) => c + dir[k] * dist), target = [...center];
    const anchor = l.follow && subject.id ? subject.id : null;
    if (anchor) { position = position.map((v, k) => v - subject.origin[k]); target = target.map((v, k) => v - subject.origin[k]); }
    return { id: `${l.role}${i}`, role: l.role, kind: l.kind, color: l.color, intensity: l.intensity, softness: l.softness, shadow: l.shadow, radius: r3(radius), anchor, position: position.map(r3), target: target.map(r3) };
  });
  const { label, idea, exposure, background, haze, sky } = look;
  return { label, idea, exposure, background, haze, sky, lights };
}

// Al revés: dónde está cada luz del rig, en ángulos respecto de la cámara. Para que el LLM sepa qué hay (también
// después de que el director movió una luz a mano). origin: dónde está el origen del sujeto (para las que lo siguen).
export function describeRig(rig, { camera, center, origin = [0, 0, 0] }) {
  if (!rig) return 'Luz base del motor: un sol blanco arriba a la derecha y cielo claro. Sin look elegido todavía.';
  const yaw = Math.atan2(camera[0] - center[0], camera[2] - center[2]);
  const deg = (v) => Math.round(v * 180 / Math.PI);
  const lights = rig.lights.map((l) => {
    const p = l.anchor ? l.position.map((v, k) => v + origin[k]) : l.position;
    const t = l.anchor ? l.target.map((v, k) => v + origin[k]) : l.target;
    const v = p.map((x, k) => x - t[k]);
    const dist = Math.hypot(...v) || 1;
    const height = deg(Math.asin(v[1] / dist));
    let side = deg(Math.atan2(v[0], v[2]) - yaw);
    side = ((side + 540) % 360) - 180;
    return `- ${l.role} (${l.kind}${l.anchor ? ', sigue al sujeto' : ''}): color ${l.color}, intensity ${l.intensity}, from { side: ${side}, height: ${height}, distance: ${r3(dist)} }, softness ${l.softness}${l.shadow ? ', con sombra' : ''}`;
  });
  return [`Look actual: "${rig.label}". exposure ${rig.exposure}, background ${rig.background}, haze ${rig.haze}, sky ${JSON.stringify(rig.sky)}.`, ...lights].join('\n');
}

// Un rig guardado (localStorage o JSON) → validado, o null.
export function parseRig(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.lights) || !raw.lights.length) return null;
  const vec = (v) => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);
  const lights = raw.lights.slice(0, LOOK.maxLights).filter((l) => vec(l?.position) && vec(l?.target)).map((l, i) => ({
    id: typeof l.id === 'string' ? l.id.slice(0, 20) : `luz${i}`,
    role: ROLES.includes(l.role) ? l.role : 'key',
    kind: KINDS.includes(l.kind) ? l.kind : 'spot',
    color: HEX.test(l.color) ? l.color : '#ffffff',
    intensity: num(l.intensity, 0, 10, 'intensity', 3),
    softness: num(l.softness, 0, 1, 'softness', 0.5),
    shadow: !!l.shadow,
    radius: num(l.radius, 0.2, 30, 'radius', 1),
    anchor: typeof l.anchor === 'string' ? l.anchor : null,
    position: l.position,
    target: l.target,
  }));
  if (!lights.length) return null;
  try {
    const base = parseLook({ ...raw, lights: [{}] });
    return { label: base.label, idea: base.idea, exposure: base.exposure, background: base.background, haze: base.haze, sky: base.sky, lights };
  } catch { return null; }
}
