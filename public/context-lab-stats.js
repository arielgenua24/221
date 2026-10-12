// Laboratorio · Context Lab: métricas y resumen del historial por CONFIGURACIÓN de contexto.
// Funciones puras (sin DOM ni storage): las usa context-lab.js y las prueban los tests.
import { newRun, runMetrics } from './lab-stats.js';

export const TOOL_KEYS = ['search', 'images', 'sound', 'video'];
export const TOOL_LABEL = { search: 'Buscar referencias (SerpAPI)', images: 'Generar imagen', sound: 'Generar sonido (SFX)', video: 'Generar video IA' };
const SHORT = { search: 'S', images: 'I', sound: 'A', video: 'V' };
const MODE_SHORT = { off: '—', optional: 'opc', required: 'obl' };
export const MODE_LABEL = { off: 'Apagada', optional: 'Opcional', required: 'Obligatoria' };

// Igual que src/lab/context.js → policySignature.
export const policySignature = (policy) => TOOL_KEYS.map((k) => `${SHORT[k]}·${MODE_SHORT[policy?.[k]] || '—'}`).join(' ');
export const approxTokens = (chars) => Math.round((chars || 0) / 4);

// Una ejecución nueva de una variante: la de Motion Design + el estado de las capas (motion y tomas de IA).
export function newVariantRun(model) {
  return { ...newRun(model), layers: { motionHidden: false, videos: {} } };
}

export function variantMetrics(run) {
  const a = run?.attempts || [];
  const sum = (k) => a.reduce((s, x) => s + (Number(x[k]) || 0), 0);
  const m = runMetrics(run);
  const promptTokens = sum('promptTokens');
  // Tokens de entrada de la primera llamada: cuánto contexto recibió de arranque (sin herramientas ni revisiones).
  const firstPrompt = a.find((x) => x.firstPromptTokens)?.firstPromptTokens || null;
  return { ...m, sounds: sum('sounds'), videos: sum('videos'), promptTokens, firstPrompt };
}

// Resumen de la configuración de una variante (liviano: va al historial en localStorage).
// cfg: la configuración que se mandó · system: { chars } del prompt final (si se conoce).
export function configSummary(cfg, { skillsChars = 0, systemChars = null, defaultTemplate = '' } = {}) {
  return {
    label: cfg.label || '',
    policy: { ...cfg.policy },
    signature: policySignature(cfg.policy),
    limits: { ...cfg.limits },
    skills: (cfg.skills || []).length,
    skillsChars,
    frames: cfg.frames,
    temperature: cfg.temperature ?? null,
    reasoning: cfg.reasoning || null,
    videoModel: cfg.videoModel || null,
    templateEdited: !!cfg.template && cfg.template.trim() !== defaultTemplate.trim(),
    templateChars: (cfg.template || defaultTemplate).length,
    examplesChars: (cfg.examples || '').trim().length,
    refs: cfg.refsMode || 'base',
    refsCount: cfg.refsCount ?? 0,
    briefOverride: cfg.context !== null && cfg.context !== undefined ? true : cfg.instructions !== null && cfg.instructions !== undefined,
    systemChars,
  };
}

const avg = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);

// Historial agrupado por modelo + firma de herramientas: ¿qué configuración de contexto rinde mejor?
export function configStats(experiments) {
  const by = new Map();
  for (const ex of experiments || []) {
    for (const v of ex.variants || []) {
      const run = v.run;
      if (!run?.model || !run.attempts?.length) continue;
      const m = variantMetrics(run);
      const key = `${run.model}  ${v.config?.signature || '?'}`;
      const s = by.get(key) || { model: run.model, signature: v.config?.signature || '?', runs: 0, approved: 0, wins: 0, cost: 0, ms: [], quality: [], fidelity: [], attempts: [], edited: 0 };
      s.runs += 1;
      if (run.eval?.approved === true) s.approved += 1;
      if (ex.preference === v.key) s.wins += 1;
      if (v.config?.templateEdited) s.edited += 1;
      s.cost += m.cost;
      s.ms.push(m.ms);
      s.attempts.push(m.attempts);
      if (run.eval?.quality) s.quality.push(run.eval.quality);
      if (run.eval?.fidelity) s.fidelity.push(run.eval.fidelity);
      by.set(key, s);
    }
  }
  return [...by.values()].map((s) => ({
    model: s.model,
    signature: s.signature,
    runs: s.runs,
    approved: s.approved,
    approvalRate: s.runs ? s.approved / s.runs : 0,
    wins: s.wins,
    edited: s.edited,
    avgCost: s.runs ? s.cost / s.runs : 0,
    costPerApproved: s.approved ? s.cost / s.approved : null,
    avgMs: avg(s.ms),
    avgAttempts: avg(s.attempts),
    avgQuality: avg(s.quality),
    avgFidelity: avg(s.fidelity),
  })).sort((a, b) => b.approved - a.approved || b.approvalRate - a.approvalRate || (b.avgQuality ?? 0) - (a.avgQuality ?? 0));
}

export function experimentStatus(ex) {
  const runs = (ex.variants || []).map((v) => v.run).filter(Boolean);
  if (runs.some((r) => r.status === 'running' || r.status === 'checking')) return 'en curso';
  if (ex.preference) return 'evaluado';
  if (runs.some((r) => r.eval?.approved !== null && r.eval?.approved !== undefined)) return 'evaluado en parte';
  if (runs.some((r) => r.hasCode)) return 'sin evaluar';
  return runs.some((r) => r.status === 'error') ? 'con errores' : 'borrador';
}

// Qué filas de configuración difieren entre variantes (para resaltar lo que se está probando).
export function differing(summaries, key) {
  const vals = summaries.map((s) => JSON.stringify(s?.[key] ?? null));
  return new Set(vals).size > 1;
}
