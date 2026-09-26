// Sonido del motion design (modo ✨ Intuition): efectos sintetizados con Web Audio.
// El modelo NO escribe código de audio: escribe una "partitura" (qué efecto, en qué segundo del clip, cómo),
// igual que elige tipografías de una lista. Lo usan: el reproductor (para sonar y exportar), el servidor
// (para validar la partitura y documentarle al modelo el catálogo) y los tests.
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const num = (x, fallback) => (Number.isFinite(Number(x)) ? Number(x) : fallback);

export const MAX_SOUND_EVENTS = 24; // por clip, ya expandidas las repeticiones
const MAX_SOUND_DUR = 4;

// Catálogo. `dur`: duración por defecto (s) y rango permitido. `sustain`: si la duración la decide el diseñador.
export const SOUNDS = {
  whoosh: { dur: [0.45, 0.15, 2], sustain: true, feel: 'aire que pasa: entradas, salidas y barridos de elementos' },
  riser: { dur: [1.2, 0.3, 4], sustain: true, feel: 'tensión que sube hasta un momento clave; termina justo donde empieza el remate' },
  impacto: { dur: [0.9, 0.3, 2.5], feel: 'golpe grave con cuerpo: el remate, un título que cae, un corte fuerte' },
  sub: { dur: [0.8, 0.3, 2], feel: 'caída sub-grave, se siente más de lo que se oye: peso sin estridencia' },
  pop: { dur: [0.12, 0.05, 0.4], feel: 'burbuja corta: aparece un elemento chico, un ícono, una etiqueta' },
  click: { dur: [0.03, 0.01, 0.1], feel: 'clic seco de interfaz: seleccionar, marcar, encajar' },
  tick: { dur: [0.05, 0.02, 0.2], feel: 'blip agudo y limpio: contadores, letras que aparecen, pasos de una cascada' },
  tecla: { dur: [0.06, 0.03, 0.15], feel: 'tecla de máquina de escribir: texto que se escribe letra por letra' },
  ding: { dur: [1.2, 0.3, 3], feel: 'campana brillante: un logro, un precio, una revelación' },
  shimmer: { dur: [1.2, 0.3, 3], sustain: true, feel: 'brillo que titila: destellos, algo mágico o premium' },
  glitch: { dur: [0.3, 0.08, 1], sustain: true, feel: 'interferencia digital entrecortada: transiciones tech, errores a propósito' },
  swell: { dur: [1.5, 0.4, 4], sustain: true, feel: 'colchón suave que crece y se va: un fondo emotivo, una pausa' },
};

// Tono: nombre o semitonos (-24..24) respecto del tono base del efecto.
const TONOS = { grave: -7, medio: 0, agudo: 7 };

// Para documentárselo al modelo (los tests verifican que coincidan con SOUNDS).
export const SOUND_DOCS = Object.entries(SOUNDS)
  .map(([name, s]) => `- "${name}" — ${s.feel} (dura ${s.dur[0]} s por defecto${s.sustain ? `; "dur" entre ${s.dur[1]} y ${s.dur[2]}` : ''})`)
  .join('\n');

// Deja la partitura de un clip en un estado que el reproductor puede sonar sí o sí:
// efectos del catálogo, tiempos dentro del clip, volúmenes razonables, repeticiones expandidas.
export function normalizeScore(list, clipDur = Infinity) {
  const out = [];
  for (const ev of Array.isArray(list) ? list : []) {
    if (!ev || typeof ev !== 'object') continue;
    const efecto = String(ev.efecto || '').trim().toLowerCase();
    const def = SOUNDS[efecto];
    if (!def) continue;
    const t0 = num(ev.t, NaN);
    if (!Number.isFinite(t0) || t0 < 0 || t0 >= clipDur) continue;
    const dur = def.sustain ? clamp(num(ev.dur, def.dur[0]), def.dur[1], Math.min(def.dur[2], MAX_SOUND_DUR)) : def.dur[0];
    const tono = typeof ev.tono === 'string' && ev.tono.trim().toLowerCase() in TONOS
      ? TONOS[ev.tono.trim().toLowerCase()]
      : clamp(Math.round(num(ev.tono, 0)), -24, 24);
    const base = { efecto, dur, tono, vol: clamp(num(ev.vol, 0.6)), pan: clamp(num(ev.pan, 0), -1, 1) };
    const n = clamp(Math.round(num(ev.repetir, 1)), 1, 16);
    const cada = clamp(num(ev.cada, 0.1), 0.03, 2);
    for (let i = 0; i < n; i++) {
      const t = t0 + i * cada;
      if (t >= clipDur) break;
      out.push({ t: Math.round(t * 1000) / 1000, ...base });
    }
  }
  return out.sort((a, b) => a.t - b.t).slice(0, MAX_SOUND_EVENTS);
}

// ---------- Síntesis (solo en el navegador) ----------
// Ruido blanco determinista (mismo buffer siempre): la exportación suena igual que la vista previa.
const noiseCache = new WeakMap();
function noiseBuffer(ac) {
  if (noiseCache.has(ac)) return noiseCache.get(ac);
  const len = ac.sampleRate * 2;
  const buf = ac.createBuffer(1, len, ac.sampleRate);
  const data = buf.getChannelData(0);
  let s = 12345;
  for (let i = 0; i < len; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    data[i] = (s / 0x3fffffff) - 1;
  }
  noiseCache.set(ac, buf);
  return buf;
}

// Envolvente: sube en `a` segundos hasta `peak`, cae exponencialmente hasta el final.
function env(param, at, dur, peak, a = 0.005) {
  param.setValueAtTime(0.0001, at);
  param.linearRampToValueAtTime(peak, at + a);
  param.exponentialRampToValueAtTime(0.0001, at + Math.max(a + 0.01, dur));
}

// Cada efecto recibe (ac, out, at, ev, st) y devuelve las fuentes que arrancó (para poder cortarlas).
// `st`: factor de afinación (2^(tono/12)).
const SYNTHS = {
  whoosh(ac, out, at, { dur }, st) {
    const src = ac.createBufferSource();
    src.buffer = noiseBuffer(ac); src.loop = true;
    const bp = ac.createBiquadFilter();
    bp.type = 'bandpass'; bp.Q.value = 1.2;
    bp.frequency.setValueAtTime(300 * st, at);
    bp.frequency.exponentialRampToValueAtTime(2400 * st, at + dur * 0.55);
    bp.frequency.exponentialRampToValueAtTime(700 * st, at + dur);
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.linearRampToValueAtTime(0.9, at + dur * 0.5);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    src.connect(bp).connect(g).connect(out);
    src.start(at); src.stop(at + dur + 0.05);
    return [src];
  },
  riser(ac, out, at, { dur }, st) {
    const src = ac.createBufferSource();
    src.buffer = noiseBuffer(ac); src.loop = true;
    const bp = ac.createBiquadFilter();
    bp.type = 'bandpass'; bp.Q.value = 3;
    bp.frequency.setValueAtTime(200 * st, at);
    bp.frequency.exponentialRampToValueAtTime(5000 * st, at + dur);
    const osc = ac.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(110 * st, at);
    osc.frequency.exponentialRampToValueAtTime(440 * st, at + dur);
    const lp = ac.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.setValueAtTime(600, at); lp.frequency.exponentialRampToValueAtTime(4000, at + dur);
    const og = ac.createGain(); og.gain.value = 0.18;
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(0.8, at + dur * 0.97);
    g.gain.linearRampToValueAtTime(0.0001, at + dur);
    src.connect(bp).connect(g);
    osc.connect(lp).connect(og).connect(g);
    g.connect(out);
    src.start(at); src.stop(at + dur + 0.05);
    osc.start(at); osc.stop(at + dur + 0.05);
    return [src, osc];
  },
  impacto(ac, out, at, { dur }, st) {
    const osc = ac.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(120 * st, at);
    osc.frequency.exponentialRampToValueAtTime(38 * st, at + dur * 0.6);
    const g = ac.createGain();
    env(g.gain, at, dur, 1, 0.003);
    osc.connect(g).connect(out);
    const n = ac.createBufferSource();
    n.buffer = noiseBuffer(ac);
    const lp = ac.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.setValueAtTime(3000, at); lp.frequency.exponentialRampToValueAtTime(200, at + 0.25);
    const ng = ac.createGain();
    env(ng.gain, at, 0.3, 0.6, 0.002);
    n.connect(lp).connect(ng).connect(out);
    osc.start(at); osc.stop(at + dur + 0.05);
    n.start(at); n.stop(at + 0.35);
    return [osc, n];
  },
  sub(ac, out, at, { dur }, st) {
    const osc = ac.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(70 * st, at);
    osc.frequency.exponentialRampToValueAtTime(30 * st, at + dur);
    const g = ac.createGain();
    env(g.gain, at, dur, 1, 0.02);
    osc.connect(g).connect(out);
    osc.start(at); osc.stop(at + dur + 0.05);
    return [osc];
  },
  pop(ac, out, at, { dur }, st) {
    const osc = ac.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(900 * st, at);
    osc.frequency.exponentialRampToValueAtTime(260 * st, at + dur);
    const g = ac.createGain();
    env(g.gain, at, dur, 0.8, 0.002);
    osc.connect(g).connect(out);
    osc.start(at); osc.stop(at + dur + 0.05);
    return [osc];
  },
  click(ac, out, at, { dur }, st) {
    const n = ac.createBufferSource();
    n.buffer = noiseBuffer(ac);
    const hp = ac.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 2000 * st;
    const g = ac.createGain();
    env(g.gain, at, dur, 0.9, 0.0005);
    n.connect(hp).connect(g).connect(out);
    n.start(at); n.stop(at + dur + 0.02);
    return [n];
  },
  tick(ac, out, at, { dur }, st) {
    const osc = ac.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = 2200 * st;
    const g = ac.createGain();
    env(g.gain, at, dur, 0.5, 0.001);
    osc.connect(g).connect(out);
    osc.start(at); osc.stop(at + dur + 0.02);
    return [osc];
  },
  tecla(ac, out, at, { dur }, st) {
    const n = ac.createBufferSource();
    n.buffer = noiseBuffer(ac);
    const bp = ac.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 3200 * st; bp.Q.value = 2;
    const g = ac.createGain();
    env(g.gain, at, dur, 0.9, 0.0008);
    n.connect(bp).connect(g).connect(out);
    const osc = ac.createOscillator();
    osc.type = 'square'; osc.frequency.value = 180 * st;
    const og = ac.createGain();
    env(og.gain, at, dur * 0.6, 0.12, 0.0008);
    osc.connect(og).connect(out);
    n.start(at); n.stop(at + dur + 0.02);
    osc.start(at); osc.stop(at + dur + 0.02);
    return [n, osc];
  },
  ding(ac, out, at, { dur }, st) {
    // FM: campana inarmónica.
    const car = ac.createOscillator();
    car.frequency.value = 1320 * st;
    const mod = ac.createOscillator();
    mod.frequency.value = 1320 * st * 1.4;
    const mg = ac.createGain();
    mg.gain.setValueAtTime(900 * st, at);
    mg.gain.exponentialRampToValueAtTime(1, at + dur);
    mod.connect(mg).connect(car.frequency);
    const g = ac.createGain();
    env(g.gain, at, dur, 0.45, 0.002);
    car.connect(g).connect(out);
    car.start(at); car.stop(at + dur + 0.05);
    mod.start(at); mod.stop(at + dur + 0.05);
    return [car, mod];
  },
  shimmer(ac, out, at, { dur }, st) {
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.linearRampToValueAtTime(0.35, at + Math.min(0.25, dur * 0.3));
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    const trem = ac.createGain();
    trem.gain.value = 0.6;
    const lfo = ac.createOscillator();
    lfo.frequency.value = 11;
    const lg = ac.createGain(); lg.gain.value = 0.4;
    lfo.connect(lg).connect(trem.gain);
    trem.connect(g).connect(out);
    const srcs = [lfo];
    [2637, 3136, 3951, 5274].forEach((f, i) => {
      const o = ac.createOscillator();
      o.type = 'sine'; o.frequency.value = f * st;
      o.detune.value = (i - 1.5) * 6;
      o.connect(trem);
      o.start(at); o.stop(at + dur + 0.05);
      srcs.push(o);
    });
    lfo.start(at); lfo.stop(at + dur + 0.05);
    return srcs;
  },
  glitch(ac, out, at, { dur }, st) {
    const n = ac.createBufferSource();
    n.buffer = noiseBuffer(ac); n.loop = true;
    const bp = ac.createBiquadFilter();
    bp.type = 'bandpass'; bp.Q.value = 6; bp.frequency.value = 1800 * st;
    const g = ac.createGain();
    g.gain.setValueAtTime(0, at);
    // Compuertas entrecortadas con un patrón fijo (determinista).
    const slice = 0.035;
    for (let k = 0, x = at; x < at + dur; k++, x += slice) {
      const on = ((k * 7 + 3) % 5) < 3;
      g.gain.setValueAtTime(on ? 0.7 : 0, x);
      bp.frequency.setValueAtTime((800 + ((k * 389) % 3000)) * st, x);
    }
    g.gain.setValueAtTime(0, at + dur);
    n.connect(bp).connect(g).connect(out);
    n.start(at); n.stop(at + dur + 0.02);
    return [n];
  },
  swell(ac, out, at, { dur }, st) {
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.linearRampToValueAtTime(0.3, at + dur * 0.6);
    g.gain.linearRampToValueAtTime(0.0001, at + dur);
    const lp = ac.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(400, at);
    lp.frequency.linearRampToValueAtTime(2200, at + dur * 0.6);
    lp.frequency.linearRampToValueAtTime(500, at + dur);
    lp.connect(g).connect(out);
    // Acorde abierto (quinta + octava) levemente desafinado: suena a pad.
    return [220, 330, 440, 660].map((f, i) => {
      const o = ac.createOscillator();
      o.type = 'sawtooth'; o.frequency.value = f * st; o.detune.value = i % 2 ? 7 : -7;
      const og = ac.createGain(); og.gain.value = 0.25;
      o.connect(og).connect(lp);
      o.start(at); o.stop(at + dur + 0.05);
      return o;
    });
  },
};

// Suena un evento de la partitura en `at` (tiempo del AudioContext). Devuelve una función que lo corta.
export function playSound(ac, destination, ev, at) {
  const synth = SYNTHS[ev.efecto];
  if (!synth) return () => {};
  const vol = ac.createGain();
  vol.gain.value = ev.vol;
  let out = vol;
  if (ev.pan && ac.createStereoPanner) {
    const p = ac.createStereoPanner();
    p.pan.value = ev.pan;
    vol.connect(p);
    out = p;
  }
  out.connect(destination);
  const srcs = synth(ac, vol, Math.max(ac.currentTime, at), ev, 2 ** (ev.tono / 12));
  return () => {
    srcs.forEach((s) => { try { s.stop(); } catch { /* ya terminó */ } });
    out.disconnect();
  };
}
