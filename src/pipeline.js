import {
  ORCHESTRATOR_SYSTEM, RESEARCHER_SYSTEM, CRITIC_SYSTEM,
  briefPrompt, researchPrompt, ideationPrompt, critiquePrompt, finalPrompt,
} from './prompts.js';
import { createAgentRunner, extractJson } from './agent.js';

export { extractJson };

const DEFAULT_TASKS = [
  { id: 'A', titulo: 'Público', objetivo: 'Entender deseos, dolores, lenguaje y momentos de compra del público.', preguntas: ['¿Qué desea y qué le frustra?', '¿Cómo habla?', '¿En qué momentos piensa en esta categoría?'], limites: 'No proponer ideas de contenido ni hooks.' },
  { id: 'B', titulo: 'Rubro y formatos', objetivo: 'Qué ángulos y formatos funcionan en este rubro y qué está saturado.', preguntas: ['¿Qué publican las cuentas que funcionan en el rubro?', '¿Qué está trillado?'], limites: 'No analizar al público en profundidad.' },
  { id: 'C', titulo: 'Hooks y tendencias', objetivo: 'Hooks, recursos y tendencias aplicables a este negocio.', preguntas: ['¿Qué hooks detienen el scroll en este rubro?', '¿Qué tendencias o formatos virales se pueden adaptar?'], limites: 'No analizar formatos de catálogo.' },
];

// `ask` pausa el flujo hasta que el humano decide. Devuelve null si el humano delega la decisión.
export async function runPipeline({ text, photos, emit, llm, config, signal, ask = async () => null }) {
  const log = { startedAt: new Date().toISOString(), config, input: { text, photoCount: photos.length }, steps: {}, decisions: {} };
  const { agent, totals } = createAgentRunner({ emit, llm, signal, log });

  const { orchestratorModel, researcherModel, criticModel, researchWeb, researcherVision } = config;
  const imageParts = photos.map((url) => ({ type: 'image_url', image_url: { url } }));

  // 1. Brief + plan (orquestador, con visión)
  const brief = await agent({
    step: 'brief', role: 'Orquestador', title: 'Leyendo tu negocio y armando el brief', model: orchestratorModel,
    system: ORCHESTRATOR_SYSTEM, temperature: 0.4,
    content: [{ type: 'text', text: briefPrompt(text, photos.length) }, ...imageParts],
  });
  emit({ type: 'brief', data: brief });

  // Decisión humana 1: confirmar el brief y responder las dudas del orquestador.
  const questions = (Array.isArray(brief.preguntas_al_humano) ? brief.preguntas_al_humano : []).slice(0, 3);
  const briefAnswer = await ask({ kind: 'brief', title: '¿Entendí bien tu negocio?', brief, questions });
  if (briefAnswer) {
    brief.respuestas_del_humano = briefAnswer;
    log.decisions.brief = briefAnswer;
  }

  // 2. Investigación en paralelo (investigador)
  let tasks = Array.isArray(brief.plan_investigacion) ? brief.plan_investigacion.slice(0, 3) : [];
  if (!tasks.length) tasks = DEFAULT_TASKS;
  const settled = await Promise.allSettled(tasks.map((task) => agent({
    step: `research-${task.id}`, role: 'Investigador', title: `Investigando: ${task.titulo}`, model: researcherModel,
    system: RESEARCHER_SYSTEM, temperature: 0.6,
    plugins: researchWeb ? [{ id: 'web', max_results: 5 }] : undefined,
    content: researcherVision
      ? [{ type: 'text', text: researchPrompt(brief, task) }, ...imageParts]
      : researchPrompt(brief, task),
  })));
  const research = settled.filter((s) => s.status === 'fulfilled').map((s) => s.value);
  settled.forEach((s, i) => {
    if (s.status === 'rejected') emit({ type: 'step_error', step: `research-${tasks[i].id}`, text: s.reason.message });
  });
  if (!research.length) throw new Error('Fallaron todas las investigaciones: ' + settled.map((s) => s.reason?.message).join(' | '));

  // 3. Ideación divergente (orquestador)
  const ideation = await agent({
    step: 'ideation', role: 'Orquestador', title: 'Generando 8 conceptos distintos', model: orchestratorModel,
    system: ORCHESTRATOR_SYSTEM, temperature: 1, maxTokens: 10000,
    content: ideationPrompt(brief, research),
  });
  const concepts = ideation.conceptos || [];
  emit({ type: 'concepts', data: concepts });

  // 4. Crítica independiente (otro modelo)
  const critique = await agent({
    step: 'critique', role: 'Crítico', title: 'Evaluando los conceptos con rúbrica', model: criticModel,
    system: CRITIC_SYSTEM, temperature: 0.3,
    content: critiquePrompt(brief, concepts),
  });
  emit({ type: 'critique', data: critique });

  // Decisión humana 2: elegir los conceptos que le gustan.
  const ranked = rankConcepts(concepts, critique);
  const pick = await ask({
    kind: 'pick', title: '¿Qué conceptos te gustan?', concepts: ranked,
    suggested: ranked.slice(0, 4).map((c) => c.id),
  });
  if (pick) log.decisions.pick = pick;

  // 5. Selección y mejora final (orquestador = único escritor)
  const final = await agent({
    step: 'final', role: 'Orquestador', title: 'Eligiendo y puliendo las 4 mejores', model: orchestratorModel,
    system: ORCHESTRATOR_SYSTEM, temperature: 0.5, maxTokens: 10000,
    content: finalPrompt(brief, concepts, critique, pick),
  });
  const ideas = (final.ideas || []).slice(0, 4);
  emit({ type: 'ideas', ideas, note: final.nota_para_el_humano });

  log.finishedAt = new Date().toISOString();
  log.totals = totals;
  log.result = { ideas, note: final.nota_para_el_humano };
  return log;
}

// Une cada concepto con su evaluación y los ordena por puntaje total.
export function rankConcepts(concepts, critique) {
  const evals = new Map((critique?.evaluaciones || []).map((e) => [e.id, e]));
  return concepts
    .map((c) => {
      const e = evals.get(c.id) || {};
      const total = Object.values(e.puntajes || {}).reduce((a, n) => a + (Number(n) || 0), 0);
      return { ...c, total, max: Object.keys(e.puntajes || {}).length * 5, veredicto: e.veredicto, mejora: e.mejora };
    })
    .sort((a, b) => b.total - a.total);
}
