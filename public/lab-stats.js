// Laboratorio · métricas de cada ejecución y resumen del historial por modelo.
// Funciones puras (sin DOM ni storage): las usa lab.js y las prueban los tests.

// Una ejecución nueva para un lado (A o B).
export function newRun(model) {
  return {
    model,
    status: 'idle', // idle | running | checking | done | error
    attempts: [], // { reason, calls, compileErrors, cost, llmCost, toolCost, searches, images, tokens, ms, ok, error?, feedback? }
    transform: { scale: 1, x: 0, y: 0 }, // tamaño y posición de la capa sobre el video, ajustados por el humano
    segments: null, // cortes de la animación hechos por el humano: [{ id, from, len, to }] en cuadros (null = sin cortes)
    segmentsEdited: false,
    thread: [], // conversación de feedback: { role: 'user' | 'agent', text, version?, queued? }
    usedRefs: null, // ids de las referencias que el agente dice haber usado (null = no lo dijo)
    palette: null, // hex que dice haber sacado de las referencias (null = no lo dijo)
    objects: null, // objetos o motivos de las referencias que llevó a la animación (null = no lo dijo)
    error: null,
    notes: '',
    hasCode: false,
    eval: { approved: null, quality: 0, fidelity: 0, notes: '', manualMinutes: 0 },
  };
}

export const IDENTITY = { scale: 1, x: 0, y: 0 };
export const isAdjusted = (t) => !!t && (Math.abs((t.scale ?? 1) - 1) > 0.005 || Math.abs(t.x || 0) > 0.05 || Math.abs(t.y || 0) > 0.05);

// Correcciones de compilación de un registro (los registros viejos no las guardaban: cada llamada extra era una).
const compileFixesOf = (x) => (Number.isFinite(x.compileErrors) ? x.compileErrors : Math.max(0, (x.calls || 0) - 1));

// Métricas derivadas de las ejecuciones.
// "Intentos" = componentes que tuvo que escribir el modelo: cada ejecución + cada recompilación
// (las vueltas en las que solo usó herramientas no cuentan como intento, pero sí como llamada y costo).
export function runMetrics(run) {
  const a = run?.attempts || [];
  const sum = (k) => a.reduce((s, x) => s + (Number(x[k]) || 0), 0);
  const revisions = a.filter((x) => x.reason === 'feedback').length;
  const adjusted = isAdjusted(run?.transform);
  return {
    cost: sum('cost'),
    toolCost: sum('toolCost'),
    tokens: sum('tokens'),
    ms: sum('ms'),
    calls: sum('calls'),
    attempts: a.reduce((s, x) => s + 1 + compileFixesOf(x), 0),
    // Correcciones automáticas: recompilaciones + ejecuciones por error al reproducir.
    autoFixes: a.reduce((s, x) => s + compileFixesOf(x) + (x.reason === 'runtime' ? 1 : 0), 0),
    searches: sum('searches'),
    images: sum('images'),
    revisions,
    adjusted,
    cut: !!run?.segmentsEdited,
    // Intervención manual: revisiones pedidas + haber tenido que ajustar tamaño/posición + cortar o mover la animación
    // + minutos de retoque anotados.
    interventions: revisions + (adjusted ? 1 : 0) + (run?.segmentsEdited ? 1 : 0),
    manualMinutes: Number(run?.eval?.manualMinutes) || 0,
    failed: a.filter((x) => !x.ok).length,
  };
}

const avg = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);

// Resumen por modelo de todos los experimentos (cada lado de cada experimento es una ejecución).
// costPerApproved = todo lo que gastó el modelo (incluidas las ejecuciones rechazadas) / animaciones aprobadas.
export function modelStats(experiments) {
  const by = new Map();
  for (const ex of experiments || []) {
    for (const side of ['A', 'B']) {
      const run = ex.sides?.[side];
      if (!run?.model || !run.attempts?.length) continue;
      const m = runMetrics(run);
      const s = by.get(run.model) || { model: run.model, runs: 0, approved: 0, rejected: 0, wins: 0, losses: 0, ties: 0, cost: 0, ms: [], attempts: [], interventions: [], quality: [], fidelity: [], harness: new Set() };
      s.runs += 1;
      if (run.eval?.approved === true) s.approved += 1;
      if (run.eval?.approved === false) s.rejected += 1;
      if (ex.preference === side) s.wins += 1;
      else if (ex.preference === 'tie') s.ties += 1;
      else if (ex.preference === 'A' || ex.preference === 'B') s.losses += 1;
      s.cost += m.cost;
      s.ms.push(m.ms);
      s.attempts.push(m.attempts);
      s.interventions.push(m.interventions);
      if (run.eval?.quality) s.quality.push(run.eval.quality);
      if (run.eval?.fidelity) s.fidelity.push(run.eval.fidelity);
      if (ex.harness) s.harness.add(ex.harness);
      by.set(run.model, s);
    }
  }
  return [...by.values()].map((s) => ({
    model: s.model,
    runs: s.runs,
    approved: s.approved,
    rejected: s.rejected,
    approvalRate: s.runs ? s.approved / s.runs : 0,
    wins: s.wins,
    losses: s.losses,
    ties: s.ties,
    totalCost: s.cost,
    avgCost: s.runs ? s.cost / s.runs : 0,
    costPerApproved: s.approved ? s.cost / s.approved : null,
    avgMs: avg(s.ms),
    avgAttempts: avg(s.attempts),
    avgInterventions: avg(s.interventions),
    avgQuality: avg(s.quality),
    avgFidelity: avg(s.fidelity),
    harness: [...s.harness],
  })).sort((a, b) => b.approved - a.approved || b.approvalRate - a.approvalRate || (a.costPerApproved ?? Infinity) - (b.costPerApproved ?? Infinity));
}

// Estado del experimento para mostrar en el historial.
export function experimentStatus(ex) {
  const runs = ['A', 'B'].map((k) => ex.sides?.[k]).filter(Boolean);
  if (runs.some((r) => r.status === 'running' || r.status === 'checking')) return 'en curso';
  if (ex.preference) return 'evaluado';
  if (runs.some((r) => r.eval?.approved !== null && r.eval?.approved !== undefined)) return 'evaluado en parte';
  if (runs.some((r) => r.hasCode)) return 'sin evaluar';
  return runs.some((r) => r.status === 'error') ? 'con errores' : 'borrador';
}

export const money = (x) => (x === null || x === undefined ? '—' : x === 0 ? 'US$ 0' : x < 0.01 ? `US$ ${x.toFixed(4)}` : `US$ ${x.toFixed(3)}`);
export const secs = (ms) => (ms === null || ms === undefined ? '—' : ms < 60000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60000)} min ${Math.round((ms % 60000) / 1000)} s`);
