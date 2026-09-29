// Runtime de "Cinematic Pro": el tratamiento que escribe el Director de Fotografía (grade, luz motivada,
// cámara virtual, textura) y cómo se dibuja encima del video real con WebGL.
// Lo comparten el servidor (valida y normaliza lo que devuelve el modelo, y documenta los rangos en su prompt)
// y el reproductor (lo evalúa cuadro a cuadro). Lo que se le documenta al modelo es lo que existe.

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const num = (x, fallback = 0) => (Number.isFinite(Number(x)) ? Number(x) : fallback);
const hexOk = (h) => /^#[0-9a-f]{6}$/i.test(String(h || '').trim());

// Rangos de cada parámetro: [mín, máx, por defecto, descripción para el modelo].
export const GRADE_PARAMS = {
  exposicion: [-1, 1, 0, 'pasos de diafragma (−1 = un stop menos, +1 = un stop más)'],
  contraste: [-0.6, 0.8, 0, 'curva alrededor de los medios tonos (0 = sin cambio)'],
  saturacion: [-1, 0.8, 0, '−1 = blanco y negro, 0 = sin cambio'],
  temperatura: [-1, 1, 0, '−1 = frío (azul), +1 = cálido (ámbar)'],
  tinte: [-1, 1, 0, '−1 = verde, +1 = magenta'],
  negros: [0, 0.25, 0, 'levanta los negros (look fílmico/lavado); 0 = negros puros'],
  halation: [0, 1, 0, 'resplandor rojizo alrededor de las altas luces (película)'],
  vineta: [0, 1, 0, 'oscurece los bordes para llevar la mirada al centro'],
  grano: [0, 1, 0, 'grano de película, distinto en cada cuadro'],
};
export const SPLIT_PARAMS = ['sombras', 'luces']; // { hex, fuerza 0–1 }: color que tiñe sombras / altas luces

export const LIGHT_TYPES = ['ninguna', 'key', 'ventana', 'contra', 'practica', 'barrido', 'sombra'];
export const EASINGS = ['linear', 'inOutSine', 'inOutCubic', 'outCubic', 'outExpo', 'inCubic'];
export const CAMERA_LIMITS = { zoom: [1, 1.4], x: [-1, 1], y: [-1, 1], rot: [-5, 5], handheld: [0, 1] };
export const SOBRE_TOMA = ['textura', 'completo', 'nada']; // qué del tratamiento va encima de una toma re-filmada por IA

const EASE = {
  linear: (p) => p,
  inOutSine: (p) => (1 - Math.cos(Math.PI * p)) / 2,
  inOutCubic: (p) => (p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2),
  outCubic: (p) => 1 - (1 - p) ** 3,
  outExpo: (p) => (p >= 1 ? 1 : 1 - 2 ** (-10 * p)),
  inCubic: (p) => p * p * p,
};

// Documentación de los rangos, para el prompt del Director de Fotografía.
export const CINE_DOCS = `- grade (números; 0 = no tocar):
${Object.entries(GRADE_PARAMS).map(([k, [a, b, , d]]) => `  - "${k}": ${a} a ${b} — ${d}`).join('\n')}
  - "sombras" y "luces": { "hex": "#RRGGBB", "fuerza": 0 a 1 } — split toning: el color que tiñe las sombras / las altas luces (fuerza 0 = nada; 0.2–0.4 ya se nota)
- luz (una luz motivada que se suma a la escena; se dibuja como una fuente suave, en pantalla o como sombra):
  - "tipo": ${LIGHT_TYPES.map((t) => `"${t}"`).join(' | ')} ("sombra" oscurece una zona: negative fill; "ninguna" = sin luz agregada)
  - "hex": color de la fuente · "radio": 0.1 a 1.2 (fracción del alto del cuadro) · "motivacion": de dónde viene esa luz en la escena
  - "keyframes": [{ "t": s del clip, "x": 0–1, "y": 0–1 (posición del centro, puede estar fuera de cuadro: −0.3 a 1.3), "fuerza": 0 a 1 }]
- camara (cámara virtual sobre el cuadro real: reencuadra con zoom y desplazamiento, sin inventar imagen):
  - "movimiento": nombre (static, push-in, pull-out, drift lateral, tilt, handheld…) · "easing": ${EASINGS.map((e) => `"${e}"`).join(' | ')}
  - "keyframes": [{ "t": s, "zoom": ${CAMERA_LIMITS.zoom.join(' a ')} (1 = cuadro completo; más de 1.15 pierde definición), "x": −1 a 1, "y": −1 a 1 (hacia dónde se corre el encuadre dentro del margen que deja el zoom), "rot": −5 a 5 grados }]
  - "handheld": 0 a 1 (temblor de cámara en mano, orgánico; 0.15–0.3 es sutil)
- transicion: { "entrada": 0 a 1 s, "salida": 0 a 1 s } — cuánto tarda el tratamiento en aparecer y desaparecer en los bordes del clip (0 = corte seco)`;

function normKeys(list, dur, map) {
  const keys = (Array.isArray(list) ? list : [])
    .filter((k) => k && typeof k === 'object')
    .map((k) => ({ ...map(k), t: clamp(num(k.t), 0, dur) }))
    .sort((a, b) => a.t - b.t)
    .slice(0, 8);
  return keys;
}

// Deja el tratamiento en un estado que el reproductor puede usar sí o sí (rangos, colores, keyframes).
export function normalizeTreatment(raw, dur) {
  const d = raw && typeof raw === 'object' ? raw : {};
  const g = d.grade && typeof d.grade === 'object' ? d.grade : {};
  const grade = Object.fromEntries(Object.entries(GRADE_PARAMS).map(([k, [a, b, def]]) => [k, clamp(num(g[k], def), a, b)]));
  SPLIT_PARAMS.forEach((k) => {
    const s = g[k] && typeof g[k] === 'object' ? g[k] : {};
    grade[k] = { hex: hexOk(s.hex) ? s.hex.trim().toUpperCase() : '#808080', fuerza: hexOk(s.hex) ? clamp(num(s.fuerza), 0, 1) : 0 };
  });

  const l = d.luz && typeof d.luz === 'object' ? d.luz : {};
  const tipo = LIGHT_TYPES.includes(l.tipo) ? l.tipo : 'ninguna';
  const luz = {
    tipo,
    hex: hexOk(l.hex) ? l.hex.trim().toUpperCase() : '#FFD8A8',
    radio: clamp(num(l.radio, 0.6), 0.1, 1.2),
    motivacion: String(l.motivacion || '').slice(0, 300),
    keyframes: tipo === 'ninguna' ? [] : normKeys(l.keyframes, dur, (k) => ({ x: clamp(num(k.x, 0.5), -0.3, 1.3), y: clamp(num(k.y, 0.3), -0.3, 1.3), fuerza: clamp(num(k.fuerza, 0.3), 0, 1) })),
  };
  if (tipo !== 'ninguna' && !luz.keyframes.length) luz.keyframes = [{ t: 0, x: 0.5, y: 0.2, fuerza: 0.3 }];

  const c = d.camara && typeof d.camara === 'object' ? d.camara : {};
  const [zl, zh] = CAMERA_LIMITS.zoom;
  const camara = {
    movimiento: String(c.movimiento || 'static').slice(0, 60),
    easing: EASINGS.includes(c.easing) ? c.easing : 'inOutCubic',
    handheld: clamp(num(c.handheld), 0, 1),
    keyframes: normKeys(c.keyframes, dur, (k) => ({ zoom: clamp(num(k.zoom, 1), zl, zh), x: clamp(num(k.x), -1, 1), y: clamp(num(k.y), -1, 1), rot: clamp(num(k.rot), -5, 5) })),
  };
  if (!camara.keyframes.length) camara.keyframes = [{ t: 0, zoom: 1, x: 0, y: 0, rot: 0 }];

  const tr = d.transicion && typeof d.transicion === 'object' ? d.transicion : {};
  const transicion = { entrada: clamp(num(tr.entrada, 0.25), 0, 1), salida: clamp(num(tr.salida, 0.25), 0, 1) };

  const r = d.refilmar && typeof d.refilmar === 'object' ? d.refilmar : {};
  const list = (x, n, len = 200) => (Array.isArray(x) ? x : []).map((s) => String(s).slice(0, len)).filter(Boolean).slice(0, n);
  const refilmar = {
    recomendado: r.recomendado === true && String(r.prompt || '').trim().length > 20,
    por_que: String(r.por_que || '').slice(0, 600),
    prompt: String(r.prompt || '').slice(0, 4000),
    preservar: list(r.preservar, 10),
    evitar: list(r.evitar, 16, 80),
    sobre_toma: SOBRE_TOMA.includes(r.sobre_toma) ? r.sobre_toma : 'textura',
  };

  return {
    lectura: String(d.lectura || '').slice(0, 1200),
    diagnostico: (Array.isArray(d.diagnostico) ? d.diagnostico : []).filter((x) => x && typeof x === 'object').slice(0, 8)
      .map((x) => ({ componente: String(x.componente || '').slice(0, 40), observacion: String(x.observacion || '').slice(0, 300), decision: String(x.decision || '').slice(0, 300) })),
    intencion: String(d.intencion || '').slice(0, 400),
    reglas: list(d.reglas_aplicadas?.map?.((x) => (typeof x === 'string' ? x : x?.id)), 12, 80),
    por_que_reglas: (Array.isArray(d.reglas_aplicadas) ? d.reglas_aplicadas : []).filter((x) => x && typeof x === 'object' && x.id).slice(0, 12)
      .map((x) => ({ id: String(x.id).slice(0, 80), por_que: String(x.por_que || '').slice(0, 300) })),
    grade, luz, camara, transicion, refilmar,
    nota: String(d.nota_para_el_humano || '').slice(0, 600),
  };
}

// Interpola keyframes en t (con easing entre cada par).
function sample(keys, t, ease, fields) {
  if (!keys.length) return null;
  if (t <= keys[0].t) return keys[0];
  const last = keys[keys.length - 1];
  if (t >= last.t) return last;
  let i = 0;
  while (keys[i + 1].t < t) i++;
  const a = keys[i]; const b = keys[i + 1];
  const p = ease(b.t > a.t ? (t - a.t) / (b.t - a.t) : 1);
  return Object.fromEntries(fields.map((f) => [f, a[f] + (b[f] - a[f]) * p]));
}

// Temblor de cámara en mano: suma de senos (determinista: el mismo t da el mismo cuadro).
function shake(t, amount) {
  if (!amount) return { x: 0, y: 0, rot: 0 };
  const s = (f, ph) => Math.sin(t * f + ph);
  return {
    x: amount * 0.006 * (s(2.1, 0.3) + 0.5 * s(4.7, 1.9) + 0.25 * s(11.3, 4.1)),
    y: amount * 0.006 * (s(1.7, 2.2) + 0.5 * s(5.3, 0.7) + 0.25 * s(9.1, 3.3)),
    rot: amount * 0.35 * (s(1.3, 1.1) + 0.4 * s(3.9, 2.8)),
  };
}

// Cuánto del tratamiento se ve en t: entra y sale suave en los bordes del clip.
export function envelope(tr, t, dur) {
  const { entrada, salida } = tr.transicion;
  const a = entrada > 0 ? clamp(t / entrada, 0, 1) : 1;
  const b = salida > 0 ? clamp((dur - t) / salida, 0, 1) : 1;
  return EASE.inOutSine(Math.min(a, b));
}

const hexRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);

// Los uniforms del shader para el instante t. mix: 0 = original, 1 = tratamiento completo (intensidad × transición).
// parts: qué partes se aplican ('completo' | 'textura' | 'nada').
export function evalTreatment(tr, t, dur, { intensity = 1, parts = 'completo' } = {}) {
  const m = clamp(intensity, 0, 1.5) * envelope(tr, t, dur);
  const full = parts === 'completo';
  const tex = parts !== 'nada';
  const g = tr.grade;
  const k = (v, on = full) => (on ? v * m : 0);

  const cam = sample(tr.camara.keyframes, t, EASE[tr.camara.easing] || EASE.inOutCubic, ['zoom', 'x', 'y', 'rot']);
  const hh = shake(t, full ? tr.camara.handheld * m : 0);
  const rotDeg = full ? cam.rot * m + hh.rot : 0;
  const rot = (rotDeg * Math.PI) / 180;
  // El zoom crece un poco con la rotación y el temblor, para que nunca se vean los bordes.
  const zoom = (full ? 1 + (cam.zoom - 1) * m : 1) * (1 + Math.abs(rot) * 1.2 + (full && tr.camara.handheld ? 0.014 * tr.camara.handheld * m : 0));
  const slack = (1 - 1 / zoom) / 2;
  const ox = clamp((full ? cam.x * m : 0) * slack + hh.x, -slack, slack);
  const oy = clamp((full ? cam.y * m : 0) * slack + hh.y, -slack, slack);

  const light = tr.luz.tipo !== 'ninguna' && full ? sample(tr.luz.keyframes, t, EASE.inOutSine, ['x', 'y', 'fuerza']) : null;
  return {
    cam: [zoom, ox, oy, rot],
    exp: k(g.exposicion), con: k(g.contraste), sat: k(g.saturacion), temp: k(g.temperatura), tint: k(g.tinte),
    black: k(g.negros, tex), hal: k(g.halation, tex), vig: k(g.vineta, tex), grain: k(g.grano, tex),
    shadow: [...hexRgb(g.sombras.hex), k(g.sombras.fuerza)],
    high: [...hexRgb(g.luces.hex), k(g.luces.fuerza)],
    light: light ? [light.x, light.y, tr.luz.radio, light.fuerza * m] : [0.5, 0.5, 0.5, 0],
    lightCol: hexRgb(tr.luz.hex),
    lightMode: tr.luz.tipo === 'sombra' ? -1 : 1,
    time: t,
  };
}

// ---------- WebGL ----------
const VERT = `attribute vec2 a;
varying vec2 p;
void main() { p = vec2(a.x * 0.5 + 0.5, 0.5 - a.y * 0.5); gl_Position = vec4(a, 0.0, 1.0); }`;

const FRAG = `#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec2 p;
uniform sampler2D uTex;
uniform vec2 uOut, uSrc;
uniform vec4 uCam, uShadow, uHigh, uLight;
uniform vec3 uLightCol;
uniform float uExp, uCon, uSat, uTemp, uTint, uBlack, uHal, uVig, uGrain, uTime, uLightMode;

vec2 srcUv(vec2 q) {
  vec2 c = uOut * 0.5;
  vec2 d = q * uOut - c;
  float cr = cos(uCam.w), sr = sin(uCam.w);
  d = vec2(cr * d.x - sr * d.y, sr * d.x + cr * d.y) / uCam.x;
  vec2 px = c + d + uCam.yz * uOut;
  float k = max(uOut.x / uSrc.x, uOut.y / uSrc.y);
  vec2 off = (uOut - uSrc * k) * 0.5;
  return clamp((px - off) / (uSrc * k), 0.0, 1.0);
}
float hash(vec2 v) { return fract(sin(dot(v, vec2(12.9898, 78.233))) * 43758.5453); }

void main() {
  vec3 col = texture2D(uTex, srcUv(p)).rgb;
  vec3 glow = vec3(0.0);
  if (uHal > 0.001) {
    vec2 r = vec2(0.014 * uOut.y / uOut.x, 0.014);
    for (int i = 0; i < 8; i++) {
      float a = float(i) * 0.785398;
      glow += max(texture2D(uTex, srcUv(p + vec2(cos(a), sin(a)) * r)).rgb - 0.7, 0.0);
    }
    glow /= 8.0;
  }
  col *= exp2(uExp);
  col += vec3(uTemp * 0.07 + uTint * 0.025, -uTint * 0.05, -uTemp * 0.07 + uTint * 0.025);
  col = (col - 0.45) * (1.0 + uCon) + 0.45;
  float l = dot(clamp(col, 0.0, 1.0), vec3(0.2126, 0.7152, 0.0722));
  col = mix(vec3(l), col, 1.0 + uSat);
  col += (uShadow.rgb - 0.5) * uShadow.a * (1.0 - smoothstep(0.0, 0.6, l)) * 0.6;
  col += (uHigh.rgb - 0.5) * uHigh.a * smoothstep(0.4, 1.0, l) * 0.5;
  if (uLight.w > 0.001) {
    vec2 asp = vec2(uOut.x / uOut.y, 1.0);
    float g = 1.0 - smoothstep(0.0, uLight.z, length((p - uLight.xy) * asp));
    g *= g;
    if (uLightMode > 0.0) col = 1.0 - (1.0 - clamp(col, 0.0, 1.0)) * (1.0 - uLightCol * g * uLight.w);
    else col *= 1.0 - g * uLight.w * 0.6;
  }
  col += glow * vec3(1.0, 0.42, 0.24) * uHal * 1.8;
  col = uBlack + col * (1.0 - uBlack);
  vec2 vc = (p - 0.5) * vec2(uOut.x / max(uOut.x, uOut.y), uOut.y / max(uOut.x, uOut.y)) * 2.0;
  col *= 1.0 - uVig * smoothstep(0.35, 1.25, length(vc)) * 0.85;
  if (uGrain > 0.001) col += (hash(floor(p * uOut) + floor(uTime * 24.0) * 17.13) - 0.5) * uGrain * 0.14;
  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;

// Renderer: dibuja una fuente (video) con los uniforms de evalTreatment en su propio canvas.
// Devuelve null si el navegador no tiene WebGL.
export function createCineRenderer(W, H) {
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const gl = canvas.getContext('webgl', { preserveDrawingBuffer: true, premultipliedAlpha: false, antialias: false });
  if (!gl) return null;
  const shader = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'shader');
    return s;
  };
  const prog = gl.createProgram();
  gl.attachShader(prog, shader(gl.VERTEX_SHADER, VERT));
  gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) || 'programa');
  gl.useProgram(prog);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, 'a');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  [[gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE], [gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR]]
    .forEach(([k, v]) => gl.texParameteri(gl.TEXTURE_2D, k, v));
  const u = Object.fromEntries(['uTex', 'uOut', 'uSrc', 'uCam', 'uShadow', 'uHigh', 'uLight', 'uLightCol', 'uExp', 'uCon', 'uSat', 'uTemp', 'uTint', 'uBlack', 'uHal', 'uVig', 'uGrain', 'uTime', 'uLightMode']
    .map((n) => [n, gl.getUniformLocation(prog, n)]));
  gl.viewport(0, 0, W, H);

  return {
    canvas,
    render(source, v) {
      const sw = source.videoWidth || source.width; const sh = source.videoHeight || source.height;
      if (!sw || !sh) return false;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, source);
      gl.uniform1i(u.uTex, 0);
      gl.uniform2f(u.uOut, W, H);
      gl.uniform2f(u.uSrc, sw, sh);
      gl.uniform4fv(u.uCam, v.cam);
      gl.uniform4fv(u.uShadow, v.shadow);
      gl.uniform4fv(u.uHigh, v.high);
      gl.uniform4fv(u.uLight, v.light);
      gl.uniform3fv(u.uLightCol, v.lightCol);
      [['uExp', 'exp'], ['uCon', 'con'], ['uSat', 'sat'], ['uTemp', 'temp'], ['uTint', 'tint'], ['uBlack', 'black'], ['uHal', 'hal'], ['uVig', 'vig'], ['uGrain', 'grain'], ['uTime', 'time'], ['uLightMode', 'lightMode']]
        .forEach(([name, key]) => gl.uniform1f(u[name], v[key]));
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      return true;
    },
  };
}
