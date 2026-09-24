// Convierte lo que propone el Director en una línea de tiempo válida y enganchada al ritmo:
// cubre la canción de 0 al final sin huecos, cada corte cae en el golpe más cercano,
// y cada toma de video usa un fragmento que existe.

export const EFFECTS = ['ninguno', 'zoom_in', 'zoom_out', 'paneo_izq', 'paneo_der', 'pulso'];
export const TRANSITIONS = ['corte', 'fundido', 'flash', 'negro'];

const SNAP_WINDOW = 0.15; // s: más allá de esto, el corte se respeta tal cual (ej. música sin pulso)
const MIN_SEGMENT = 0.2; // s
const round = (x) => Math.round(x * 1000) / 1000;

// Anclas de corte: compases > beats > golpes fuertes. Ante empate de distancia gana la de mayor rango.
export function buildAnchors(analysis, extra = []) {
  const anchors = [];
  const add = (t, rank) => { if (Number.isFinite(t)) anchors.push({ t, rank }); };
  (analysis.downbeats || []).forEach((t) => add(t, 3));
  (analysis.beats || []).forEach((t) => add(t, 2));
  (analysis.onsets || []).filter((o) => o.fuerza >= 0.3).forEach((o) => add(o.t, 1));
  extra.forEach((t) => add(t, 2));
  return anchors.sort((a, b) => a.t - b.t);
}

export function snap(t, anchors, window = SNAP_WINDOW) {
  let best = null;
  for (const a of anchors) {
    const d = Math.abs(a.t - t);
    if (d > window) continue;
    // Prioriza el rango, salvo que otra ancla esté claramente más cerca.
    const score = d - a.rank * 0.02;
    if (!best || score < best.score) best = { t: a.t, score };
  }
  return best ? best.t : t;
}

// raw: { segmentos: [{ inicio, media, desde, efecto, transicion, seccion, motivo }] }
// media: [{ id, kind: 'video' | 'photo', duration }]
export function normalizeTimeline(raw, { analysis, media, extraAnchors = [] }) {
  const duration = analysis.duration;
  const byId = new Map(media.map((m) => [m.id, m]));
  const warnings = [];
  const anchors = buildAnchors(analysis, extraAnchors);

  let segs = (Array.isArray(raw?.segmentos) ? raw.segmentos : [])
    .map((s) => ({ ...s, inicio: Number(s.inicio) }))
    .filter((s) => {
      if (!byId.has(s.media)) { warnings.push(`Descarté un segmento con material inexistente (${s.media}).`); return false; }
      return Number.isFinite(s.inicio) && s.inicio < duration;
    })
    .sort((a, b) => a.inicio - b.inicio);

  if (!segs.length) {
    warnings.push('El Director no devolvió segmentos utilizables; armé un montaje automático sobre la grilla.');
    segs = autoTimeline({ analysis, media }).segmentos;
  }

  // Enganchar cada inicio al golpe más cercano y descartar los que quedan demasiado juntos.
  const kept = [];
  for (const s of segs) {
    const start = kept.length ? snap(s.inicio, anchors) : 0;
    const prev = kept[kept.length - 1];
    if (prev && start - prev.inicio < MIN_SEGMENT) continue;
    if (duration - start < MIN_SEGMENT) continue;
    kept.push({ ...s, inicio: start });
  }

  const out = kept.map((s, i) => {
    const inicio = round(s.inicio);
    const fin = round(i + 1 < kept.length ? kept[i + 1].inicio : duration);
    const m = byId.get(s.media);
    const len = fin - inicio;
    const seg = {
      n: i + 1,
      inicio,
      fin,
      media: s.media,
      efecto: EFFECTS.includes(s.efecto) ? s.efecto : 'ninguno',
      transicion: i === 0 ? 'corte' : (TRANSITIONS.includes(s.transicion) ? s.transicion : 'corte'),
      seccion: s.seccion || null,
      motivo: typeof s.motivo === 'string' ? s.motivo.slice(0, 160) : '',
    };
    if (m.kind === 'video') {
      const dur = Number(m.duration) || 0;
      const maxStart = Math.max(0, dur - len);
      const wanted = Number(s.desde) || 0;
      seg.desde = round(Math.min(Math.max(0, wanted), maxStart));
      if (dur && dur < len) warnings.push(`El video ${m.id} dura ${dur.toFixed(1)} s y el segmento ${i + 1} pide ${len.toFixed(1)} s: se congela el último cuadro.`);
    }
    return seg;
  });

  return { segmentos: out, warnings };
}

// Montaje de respaldo (y del modo demo): cambia de toma cada compás en partes tranquilas
// y cada 2 beats en partes con más energía, rotando el material.
export function autoTimeline({ analysis, media }) {
  const beats = analysis.beats?.length ? analysis.beats : Array.from({ length: Math.floor(analysis.duration / 0.5) }, (_, i) => i * 0.5);
  const energyAt = (t) => analysis.energy?.[Math.min(analysis.energy.length - 1, Math.floor(t / 0.5))]?.e ?? 0.5;
  const segmentos = [];
  let k = 0;
  let i = 0;
  while (i < beats.length) {
    const t = segmentos.length ? beats[i] : 0;
    const high = energyAt(t) > 0.6;
    const m = media[k % media.length];
    segmentos.push({
      inicio: t,
      media: m.id,
      desde: m.kind === 'video' ? Math.min(1, (m.duration || 0) / 3) : 0,
      efecto: m.kind === 'photo' ? (k % 2 ? 'zoom_out' : 'zoom_in') : (high ? 'pulso' : 'ninguno'),
      transicion: high ? 'corte' : (k % 3 === 0 ? 'fundido' : 'corte'),
      motivo: high ? 'Energía alta: corte cada 2 beats' : 'Parte tranquila: una toma por compás',
    });
    k++;
    i += high ? 2 : 4;
  }
  return { segmentos };
}
