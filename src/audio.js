// Análisis de audio determinista (sin dependencias): tempo, beats, compases, golpes y energía.
// Los modelos escuchan y razonan sobre la música; este análisis les da una grilla precisa
// en la que apoyarse, y el código la usa para "enganchar" cada corte al golpe real más cercano.

// Lee un WAV PCM (8/16/24/32 bits o float32) y lo devuelve como mono Float32.
export function parseWav(buf) {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const tag = (o) => String.fromCharCode(buf[o], buf[o + 1], buf[o + 2], buf[o + 3]);
  if (buf.length < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('El audio no es un WAV válido.');
  let fmt = null;
  let data = null;
  for (let o = 12; o + 8 <= buf.length;) {
    const id = tag(o);
    const size = view.getUint32(o + 4, true);
    const body = o + 8;
    if (id === 'fmt ') {
      fmt = { format: view.getUint16(body, true), channels: view.getUint16(body + 2, true), sampleRate: view.getUint32(body + 4, true), bits: view.getUint16(body + 14, true) };
    } else if (id === 'data') {
      data = { offset: body, size: Math.min(size, buf.length - body) };
    }
    o = body + size + (size % 2);
  }
  if (!fmt || !data) throw new Error('WAV sin bloques fmt/data.');
  const { format, channels, sampleRate, bits } = fmt;
  const bytes = bits / 8;
  const isFloat = format === 3 || (format === 0xfffe && bits === 32);
  const frames = Math.floor(data.size / (bytes * channels));
  const samples = new Float32Array(frames);
  const read = (o) => {
    if (isFloat) return view.getFloat32(o, true);
    if (bits === 16) return view.getInt16(o, true) / 32768;
    if (bits === 8) return (view.getUint8(o) - 128) / 128;
    if (bits === 24) { const v = view.getUint8(o) | (view.getUint8(o + 1) << 8) | (view.getInt8(o + 2) << 16); return v / 8388608; }
    return view.getInt32(o, true) / 2147483648;
  };
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) sum += read(data.offset + (i * channels + c) * bytes);
    samples[i] = sum / channels;
  }
  return { sampleRate, samples };
}

// FFT radix-2 in situ.
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang); const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1; let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k; const b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
        const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
}

const round = (x, d = 2) => Math.round(x * 10 ** d) / 10 ** d;

function movingAverage(x, radius) {
  const out = new Float64Array(x.length);
  let sum = 0; let count = 0;
  for (let i = 0; i < x.length + radius; i++) {
    if (i < x.length) { sum += x[i]; count++; }
    if (i - 2 * radius - 1 >= 0) { sum -= x[i - 2 * radius - 1]; count--; }
    const c = i - radius;
    if (c >= 0) out[c] = sum / count;
  }
  return out;
}

// Envolvente de "novedad" (flujo espectral): sube cuando aparece un sonido nuevo (golpe, nota, sílaba).
function onsetEnvelope(samples, sampleRate) {
  const n = 2 ** Math.round(Math.log2(sampleRate * 0.064)); // ventana de ~64 ms
  const hop = n / 4;
  const frames = Math.max(0, Math.floor((samples.length - n) / hop) + 1);
  const win = Float64Array.from({ length: n }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n));
  const bins = n / 2;
  let prev = new Float64Array(bins);
  const flux = new Float64Array(frames);
  const re = new Float64Array(n); const im = new Float64Array(n);
  for (let f = 0; f < frames; f++) {
    const off = f * hop;
    for (let i = 0; i < n; i++) { re[i] = samples[off + i] * win[i]; im[i] = 0; }
    fft(re, im);
    const mag = new Float64Array(bins);
    let sum = 0;
    for (let k = 1; k < bins; k++) {
      mag[k] = Math.log1p(100 * Math.hypot(re[k], im[k]));
      const d = mag[k] - prev[k];
      if (d > 0) sum += d;
    }
    flux[f] = sum;
    prev = mag;
  }
  // Resta la media local y normaliza: queda lo que sobresale.
  const local = movingAverage(flux, Math.round(0.25 * sampleRate / hop));
  const env = flux.map((v, i) => Math.max(0, v - local[i]));
  const max = env.reduce((a, b) => Math.max(a, b), 0) || 1;
  return { env: env.map((v) => v / max), fps: sampleRate / hop, offset: n / 2 / sampleRate };
}

// Tempo por autocorrelación de la envolvente, con preferencia suave alrededor de 120 BPM.
function estimateTempo(env, fps) {
  const minLag = Math.round((60 / 200) * fps);
  const maxLag = Math.round((60 / 55) * fps);
  let best = { lag: Math.round(0.5 * fps), score: -Infinity };
  const scores = [];
  for (let lag = minLag; lag <= maxLag && lag < env.length; lag++) {
    let ac = 0;
    for (let i = lag; i < env.length; i++) ac += env[i] * env[i - lag];
    ac /= env.length - lag;
    const bpm = (60 * fps) / lag;
    const weight = Math.exp(-0.5 * (Math.log2(bpm / 120) / 1) ** 2);
    const score = ac * weight;
    scores.push(score);
    if (score > best.score) best = { lag, score };
  }
  const mean = scores.reduce((a, b) => a + b, 0) / (scores.length || 1);
  // Qué tan marcado es el pico respecto del promedio: grabaciones sin percusión dan valores bajos.
  const confidence = mean > 0 ? Math.max(0, Math.min(1, (best.score / mean - 1) / 3)) : 0;
  return { period: best.lag, bpm: (60 * fps) / best.lag, confidence };
}

// Seguimiento de beats por programación dinámica (Ellis, 2007).
function trackBeats(env, period, tightness = 100) {
  const n = env.length;
  const score = new Float64Array(n);
  const back = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    let best = 0; let arg = -1;
    const lo = Math.max(0, i - Math.round(2 * period));
    const hi = i - Math.round(period / 2);
    for (let j = lo; j <= hi; j++) {
      const s = score[j] - tightness * Math.log((i - j) / period) ** 2;
      if (s > best) { best = s; arg = j; }
    }
    score[i] = env[i] + best;
    back[i] = arg;
  }
  // El último beat: el mejor puntaje dentro del último período.
  let end = n - 1;
  for (let i = Math.max(0, n - Math.round(period)); i < n; i++) if (score[i] > score[end]) end = i;
  const beats = [];
  for (let i = end; i >= 0; i = back[i]) beats.push(i);
  return beats.reverse();
}

// Picos de la envolvente: los "golpes" audibles (transientes), con su fuerza.
function pickOnsets(env, fps, offset) {
  const wait = Math.round(0.1 * fps);
  const mean = movingAverage(env, Math.round(0.75 * fps));
  const out = [];
  let last = -Infinity;
  for (let i = 1; i < env.length - 1; i++) {
    if (env[i] < env[i - 1] || env[i] < env[i + 1]) continue;
    if (env[i] < mean[i] + 0.08 || env[i] < 0.12) continue;
    let isMax = true;
    for (let j = Math.max(0, i - wait); j <= Math.min(env.length - 1, i + wait); j++) if (env[j] > env[i]) { isMax = false; break; }
    if (!isMax) continue;
    if (i - last < wait) continue;
    out.push({ t: round(i / fps + offset), fuerza: round(env[i]) });
    last = i;
  }
  return out;
}

// Energía (RMS) en ventanas de `step` segundos, normalizada 0..1.
function energyCurve(samples, sampleRate, step = 0.5) {
  const size = Math.round(step * sampleRate);
  const vals = [];
  for (let o = 0; o < samples.length; o += size) {
    let sum = 0; const end = Math.min(samples.length, o + size);
    for (let i = o; i < end; i++) sum += samples[i] * samples[i];
    vals.push(Math.sqrt(sum / Math.max(1, end - o)));
  }
  const max = Math.max(...vals, 1e-9);
  return vals.map((v, i) => ({ t: round(i * step, 1), e: round(v / max) }));
}

// Donde la energía cambia más (candidatos a cambio de sección): media de ~4 s antes vs después.
function energyChanges(energy, top = 8) {
  const w = 8;
  const cand = [];
  for (let i = w; i < energy.length - w; i++) {
    let a = 0; let b = 0;
    for (let k = 1; k <= w; k++) { a += energy[i - k].e; b += energy[i + k - 1].e; }
    cand.push({ t: energy[i].t, delta: round((b - a) / w) });
  }
  cand.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
  const picked = [];
  for (const c of cand) {
    if (picked.length >= top || Math.abs(c.delta) < 0.08) break;
    if (picked.every((p) => Math.abs(p.t - c.t) >= 4)) picked.push(c);
  }
  return picked.sort((x, y) => x.t - y.t);
}

export function analyzeAudio(samples, sampleRate) {
  const duration = samples.length / sampleRate;
  if (duration < 2) throw new Error('El audio es demasiado corto (mínimo 2 segundos).');
  const { env, fps, offset } = onsetEnvelope(samples, sampleRate);
  const tempo = estimateTempo(env, fps);
  const beatFrames = trackBeats(env, tempo.period);
  const beats = beatFrames.map((i) => round(i / fps + offset)).filter((t) => t >= 0 && t <= duration);

  // Fase del compás (4/4 supuesto): la que acumula más fuerza de ataque en sus "1".
  let phase = 0; let bestSum = -1;
  for (let p = 0; p < 4; p++) {
    let sum = 0;
    for (let k = p; k < beatFrames.length; k += 4) sum += env[beatFrames[k]];
    if (sum > bestSum) { bestSum = sum; phase = p; }
  }
  const downbeats = beats.filter((_, k) => k % 4 === phase);
  const energy = energyCurve(samples, sampleRate);

  return {
    duration: round(duration, 3),
    bpm: round(tempo.bpm, 1),
    beatConfidence: round(tempo.confidence),
    beats,
    downbeats,
    onsets: pickOnsets(env, fps, offset),
    energy,
    energyChanges: energyChanges(energy),
  };
}

// Resumen compacto para los prompts (los modelos no necesitan cada muestra).
export function analysisForPrompt(a, { maxOnsets = 60 } = {}) {
  const strongest = [...a.onsets].sort((x, y) => y.fuerza - x.fuerza).slice(0, maxOnsets).sort((x, y) => x.t - y.t);
  return {
    duracion_s: a.duration,
    bpm_estimado: a.bpm,
    confianza_grilla: a.beatConfidence,
    lectura_confianza: a.beatConfidence >= 0.5 ? 'alta: hay pulso claro' : a.beatConfidence >= 0.25 ? 'media: pulso irregular' : 'baja: probablemente sin percusión o tempo libre; guiarse por frases y acentos',
    compases_inicio_s: a.downbeats,
    beats_s: a.beats,
    golpes_mas_fuertes: strongest,
    energia_cada_0_5s: a.energy.map((x) => x.e),
    cambios_de_energia: a.energyChanges,
  };
}
