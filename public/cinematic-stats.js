import { newRun, runMetrics } from './lab-stats.js';

// Reutiliza el registro y las métricas del laboratorio sin alterar su arquitectura A/B.
export function resultRun(result, previous) {
  const run = previous || newRun(`${result.provider}:${result.model}`);
  Object.assign(run, result);
  run.attempts = result.status === 'skipped' || result.status === 'queued' ? [] : [{ reason: 'initial', calls: 1, compileErrors: 0,
    cost: result.cost, tokens: 0, ms: result.ms, ok: result.status === 'done', error: result.error }];
  return run;
}
export function cinematicStats(experiments) {
  const by = new Map();
  for (const ex of experiments) for (const r of ex.results || []) {
    const key = `${r.provider}:${r.model}`;
    const s = by.get(key) || { model: r.model, provider: r.provider, runs: 0, skipped: 0, approved: 0, wins: 0, failed: 0, cost: 0, unknownCosts: 0, quality: [], fidelity: [], times: [] };
    if (r.status === 'skipped') s.skipped++;
    else {
      s.runs++; if (r.eval?.approved === true) s.approved++;
      if (ex.preference === r.key) s.wins++;
      if (['error', 'recoverable'].includes(r.status)) s.failed++;
      if (r.cost === null || r.cost === undefined) s.unknownCosts++; else s.cost += runMetrics(r).cost;
      if (r.ms) s.times.push(r.ms);
      if (r.eval?.quality) s.quality.push(r.eval.quality);
      if (r.eval?.fidelity) s.fidelity.push(r.eval.fidelity);
    }
    by.set(key, s);
  }
  const avg = (xs) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
  return [...by.values()].map((s) => ({ ...s, avgQuality: avg(s.quality), avgFidelity: avg(s.fidelity), avgMs: avg(s.times) }))
    .sort((a, b) => b.wins - a.wins || b.approved - a.approved);
}
