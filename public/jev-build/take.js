// JEV construye · la actuación. Mientras volás no se graba video sino datos: en cada cuadro, dónde está tu cámara y
// dónde el objeto pegado (Tools · Attach). Después esa actuación se reproduce y se filma con la cámara que quieras
// (tu POV o la cámara B), cuadro a cuadro y con tiempos exactos. Módulo puro (sin three.js ni DOM).
// Una pose es [x, y, z, qx, qy, qz, qw]: posición en metros y rotación como cuaternión.
// Cámara B: "fixed" queda clavada donde la pusiste, con el mismo encuadre: no gira, el objeto pasa por el cuadro.
// "follow" lo persigue manteniendo la distancia con la que arrancó (con un poco de retraso, como un dron) y lo mira.

export const TAKE = { maxSeconds: 120, fps: 30, width: 1920, height: 1080, follow: 2.5 };
export const CAM_B_MODES = ['fixed', 'follow'];

const fail = (message) => Object.assign(new Error(message), { status: 400 });
const r4 = (v) => +v.toFixed(4) + 0;
const isPose = (p) => Array.isArray(p) && p.length === 7 && p.every((v) => Number.isFinite(v));
const isVec = (p) => Array.isArray(p) && p.length === 3 && p.every((v) => Number.isFinite(v));

// Graba muestras a medida que pasan los cuadros. `now` en milisegundos (performance.now()).
export function createTakeRecorder({ subject = null, fov = 45 } = {}) {
  const samples = [];
  let t0 = null;
  return {
    get seconds() { return samples.length ? samples.at(-1).t : 0; },
    add(now, camera, object) {
      if (t0 === null) t0 = now;
      const t = r4((now - t0) / 1000);
      if (samples.length && t <= samples.at(-1).t) return this.seconds;
      samples.push({ t, camera: camera.map(r4), ...(object ? { object: object.map(r4) } : {}) });
      return t;
    },
    finish() { return { version: 1, subject, fov, duration: this.seconds, samples: samples.slice() }; },
  };
}

// Una actuación guardada → validada (para leerla de localStorage o de un archivo).
export function parseTake(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.samples) || raw.samples.length < 2) throw fail('La actuación necesita al menos 2 muestras.');
  let last = -Infinity;
  const samples = raw.samples.map((s, i) => {
    if (!Number.isFinite(s?.t) || s.t <= last || !isPose(s.camera) || (s.object !== undefined && !isPose(s.object))) throw fail(`La muestra ${i + 1} de la actuación es inválida.`);
    last = s.t;
    return { t: s.t, camera: s.camera, ...(s.object ? { object: s.object } : {}) };
  });
  return { version: 1, subject: typeof raw.subject === 'string' ? raw.subject : null, fov: Number(raw.fov) || 45, duration: samples.at(-1).t, samples };
}

function slerp(a, b, u) {
  let [bx, by, bz, bw] = b;
  let dot = a[0] * bx + a[1] * by + a[2] * bz + a[3] * bw;
  if (dot < 0) { dot = -dot; bx = -bx; by = -by; bz = -bz; bw = -bw; } // el camino corto
  let wa = 1 - u, wb = u;
  if (dot < 0.9995) {
    const th = Math.acos(Math.min(1, dot)), s = Math.sin(th);
    wa = Math.sin((1 - u) * th) / s;
    wb = Math.sin(u * th) / s;
  }
  const q = [a[0] * wa + bx * wb, a[1] * wa + by * wb, a[2] * wa + bz * wb, a[3] * wa + bw * wb];
  const len = Math.hypot(...q) || 1;
  return q.map((v) => v / len);
}

export function lerpPose(a, b, u) {
  return [...[0, 1, 2].map((i) => a[i] + (b[i] - a[i]) * u), ...slerp(a.slice(3), b.slice(3), u)];
}

// La actuación en el instante t (segundos): poses interpoladas de la cámara y del objeto (o null si no había).
export function poseAt(take, t) {
  const s = take.samples;
  if (t <= s[0].t) return { camera: s[0].camera, object: s[0].object || null };
  if (t >= s.at(-1).t) return { camera: s.at(-1).camera, object: s.at(-1).object || null };
  let lo = 0, hi = s.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (s[mid].t <= t) lo = mid; else hi = mid; }
  const a = s[lo], b = s[hi], u = (t - a.t) / (b.t - a.t);
  return { camera: lerpPose(a.camera, b.camera, u), object: a.object && b.object ? lerpPose(a.object, b.object, u) : a.object || b.object || null };
}

export const frameCount = (take, fps = TAKE.fps) => Math.max(1, Math.round(take.duration * fps) + 1);

// Cámara B guardada → validada.
export function parseCamB(raw) {
  if (!raw || !isVec(raw.position) || !isVec(raw.target)) return null;
  return { position: raw.position, target: raw.target, mode: CAM_B_MODES.includes(raw.mode) ? raw.mode : 'fixed' };
}

// Dónde está y adónde mira la cámara B en cada cuadro. Fija (o sin objeto en la actuación): siempre igual.
export function cameraBPath(take, camB, fps = TAKE.fps) {
  const n = frameCount(take, fps);
  const at = (i) => poseAt(take, i / fps).object?.slice(0, 3) || null;
  const start = at(0);
  const offset = start ? camB.position.map((v, k) => v - start[k]) : null;
  const k = 1 - Math.exp(-TAKE.follow / fps); // cuánto alcanza por cuadro a donde quiere estar
  let pos = [...camB.position];
  const out = [];
  for (let i = 0; i < n; i++) {
    const s = at(i);
    if (camB.mode === 'follow' && s) {
      const want = s.map((v, j) => v + offset[j]);
      pos = i === 0 ? want : pos.map((v, j) => v + (want[j] - v) * k);
    }
    const follow = camB.mode === 'follow' && s;
    out.push({ position: pos.map(r4), target: (follow ? s : camB.target).map(r4) });
  }
  return out;
}
