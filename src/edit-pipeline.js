import { createAgentRunner } from './agent.js';
import { parseWav, analyzeAudio, analysisForPrompt } from './audio.js';
import { EAR_SYSTEM, DIRECTOR_SYSTEM, DEFAULT_VERSIONS, planPrompt, earPrompt, montagePrompt } from './edit-prompts.js';
import { normalizeTimeline } from './timeline.js';

export const MAX_MEDIA = 24;
export const MAX_FRAMES = 60; // imágenes que ve el Director en total

// Valida el pedido de edición: audio WAV (ya decodificado en el navegador) + cuadros del material.
export function parseEditBody(body) {
  const text = String(body?.text || '').slice(0, 3000);
  const wavUrl = String(body?.audio?.wav || '');
  const m = /^data:audio\/(?:wav|x-wav|wave);base64,/.exec(wavUrl);
  if (!m) throw new Error('Falta la música (WAV).');
  const audio = { name: String(body.audio.name || 'audio').slice(0, 120), wav: Buffer.from(wavUrl.slice(m[0].length), 'base64') };
  let frames = 0;
  const media = (Array.isArray(body?.media) ? body.media : []).slice(0, MAX_MEDIA).flatMap((item) => {
    const kind = item?.kind === 'video' ? 'video' : item?.kind === 'photo' ? 'photo' : null;
    if (!kind || !/^[VF]\d{1,2}$/.test(item.id)) return [];
    const fr = (Array.isArray(item.frames) ? item.frames : [])
      .filter((f) => typeof f?.url === 'string' && f.url.startsWith('data:image/'))
      .slice(0, kind === 'video' ? 4 : 1)
      .map((f) => ({ t: Number(f.t) || 0, url: f.url }));
    if (!fr.length || frames + fr.length > MAX_FRAMES) return [];
    frames += fr.length;
    return [{ id: item.id, kind, name: String(item.name || '').slice(0, 80), duration: kind === 'video' ? Math.max(0, Number(item.duration) || 0) : 0, frames: fr }];
  });
  if (!media.length) throw new Error('Subí al menos un video o una foto.');
  return { text, audio, media };
}

// Edición guiada por la música:
//   [0] análisis automático del audio (tempo, beats, golpes, energía)
//   [1] el Director (orquestador, ve el material) → intención, historia, catálogo, 3 versiones y encargo para el Oído
//   [2] el Oído (escucha el audio UNA vez) → mapa musical: secciones, energía, hit points, ritmo de corte, respuestas
//   ✋ el humano confirma o corrige lo que escuchó el Oído
//   [3] el Director, 3 llamadas en paralelo (cada una continúa la conversación de [1]) → un montaje por versión
//   [4] el código engancha cada corte al golpe más cercano y valida cada montaje
//
// audio: { name, wav: Buffer (WAV mono) }
// media: [{ id, kind: 'video' | 'photo', name, duration, frames: [{ t, url }] }]
export async function runEditPipeline({ text, audio, media, emit, llm, config, signal, ask = async () => null }) {
  const log = {
    startedAt: new Date().toISOString(),
    flow: 'edicion',
    config,
    input: { text, audio: audio.name, media: media.map(({ frames, ...m }) => ({ ...m, frames: frames.length })) },
    steps: {},
    decisions: {},
  };
  const { agent, totals } = createAgentRunner({ emit, llm, signal, log });

  // 0. Análisis automático
  emit({ type: 'step_start', step: 'analysis', role: 'Análisis', title: 'Midiendo tempo, beats y energía', model: 'análisis local' });
  const { samples, sampleRate } = parseWav(audio.wav);
  const analysis = analyzeAudio(samples, sampleRate);
  const forPrompt = analysisForPrompt(analysis);
  emit({
    type: 'delta', step: 'analysis',
    text: [
      `Duración: ${analysis.duration.toFixed(1)} s`,
      `Tempo estimado: ${analysis.bpm} BPM · grilla ${forPrompt.lectura_confianza}`,
      `${analysis.beats.length} beats, ${analysis.downbeats.length} compases, ${analysis.onsets.length} golpes detectados`,
      analysis.energyChanges.length ? `Cambios fuertes de energía en: ${analysis.energyChanges.map((c) => `${c.t} s (${c.delta > 0 ? 'sube' : 'baja'})`).join(', ')}` : 'Energía pareja, sin cambios bruscos',
    ].map((l) => `- ${l}`).join('\n'),
  });
  emit({ type: 'step_end', step: 'analysis' });
  emit({ type: 'analysis', data: { duration: analysis.duration, bpm: analysis.bpm, beats: analysis.beats, downbeats: analysis.downbeats, energy: analysis.energy } });
  log.analysis = { ...analysis, energy: undefined };

  // 1. El Director mira el material y planifica
  const catalog = media.map((m) => ({ ...m, duration: Number(m.duration) || 0 }));
  const mediaParts = catalog.flatMap((m) => m.frames.flatMap((f) => [
    { type: 'text', text: m.kind === 'video' ? `${m.id} — cuadro en ${f.t.toFixed(1)} s` : `${m.id} — foto` },
    { type: 'image_url', image_url: { url: f.url } },
  ]));
  const planContent = [{ type: 'text', text: planPrompt({ text, audioName: audio.name, analysis: forPrompt, catalog }) }, ...mediaParts];
  const plan = await agent({
    step: 'plan', role: 'Director', title: 'Mirando tu material y armando la historia', model: config.directorModel,
    system: DIRECTOR_SYSTEM, temperature: 0.5, maxTokens: 8000,
    content: planContent,
    meta: { analysis, media: catalog },
  });
  emit({ type: 'plan', data: plan });

  // 2. El Oído escucha el tema completo con el encargo del Director
  const map = await agent({
    step: 'ear', role: 'Oído', title: 'Escuchando tu música', model: config.earModel,
    system: EAR_SYSTEM, temperature: 0.3, maxTokens: 12000,
    content: [
      { type: 'input_audio', input_audio: { data: audio.wav.toString('base64'), format: 'wav' } },
      { type: 'text', text: earPrompt({ text, audioName: audio.name, analysis: forPrompt, plan }) },
    ],
    meta: { analysis },
  });
  emit({ type: 'map', data: map });

  // Decisión humana: confirmar o corregir lo que escuchó el Oído.
  const versions = pickVersions(plan.versiones);
  const questions = (Array.isArray(map.preguntas_al_humano) ? map.preguntas_al_humano : []).slice(0, 2);
  const answer = await ask({ kind: 'map', title: '¿Escuché bien tu música?', map, plan, versions, questions });
  if (answer) log.decisions.map = answer;

  // 3. El Director monta cada versión en una llamada distinta (en paralelo), sobre el mismo mapa.
  const extraAnchors = [
    ...(map.momentos_clave || []).map((m) => Number(m.t)),
    ...(map.puntos_de_corte_libres || []).map((p) => Number(p.t)),
    ...(map.secciones || []).map((sec) => Number(sec.inicio)),
  ].filter(Number.isFinite);
  const history = [{ role: 'user', content: planContent }, { role: 'assistant', content: log.steps.plan.raw }];
  const temperatures = { A: 0.5, B: 0.7, C: 0.9 };

  const settled = await Promise.allSettled(versions.map(async (version) => {
    const step = `montage-${version.id}`;
    const edit = await agent({
      step, role: 'Director', title: `Versión ${version.id} · ${version.nombre}`, model: config.directorModel,
      system: DIRECTOR_SYSTEM, temperature: temperatures[version.id] ?? 0.7, maxTokens: 20000,
      history,
      content: montagePrompt({ map, analysis: forPrompt, answer, version, versions }),
      meta: { analysis, media: catalog, version },
    });
    // 4. Enganchar al ritmo y validar
    const { segmentos, warnings } = normalizeTimeline(edit, { analysis, media: catalog, extraAnchors });
    warnings.forEach((w) => emit({ type: 'notice', step, text: w }));
    const video = {
      version,
      concepto: edit.concepto,
      nota: edit.nota_para_el_humano,
      duracion: analysis.duration,
      secciones: map.secciones || [],
      momentos: map.momentos_clave || [],
      segmentos,
    };
    emit({ type: 'timeline', data: video });
    return { ...video, warnings };
  }));
  settled.forEach((r, i) => {
    if (r.status === 'rejected') emit({ type: 'step_error', step: `montage-${versions[i].id}`, text: r.reason.message });
  });
  const videos = settled.filter((r) => r.status === 'fulfilled').map((r) => r.value);
  if (!videos.length) throw new Error('Fallaron las tres versiones: ' + settled.map((r) => r.reason?.message).join(' | '));

  log.finishedAt = new Date().toISOString();
  log.totals = totals;
  log.result = { videos };
  return log;
}

// Tres versiones con id A, B y C: las del Director si son válidas, completadas con las de respaldo.
export function pickVersions(proposed) {
  const valid = (Array.isArray(proposed) ? proposed : []).filter((v) => v && typeof v.nombre === 'string' && typeof v.enfoque === 'string');
  return DEFAULT_VERSIONS.map((fallback, i) => {
    const v = valid[i];
    return v ? { id: fallback.id, nombre: v.nombre.slice(0, 60), enfoque: v.enfoque.slice(0, 400), ritmo: String(v.ritmo || '').slice(0, 300), apertura: String(v.apertura || '').slice(0, 300) } : fallback;
  });
}
