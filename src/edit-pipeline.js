import { createAgentRunner } from './agent.js';
import { parseWav, analyzeAudio, analysisForPrompt } from './audio.js';
import { EAR_SYSTEM, EDITOR_SYSTEM, earPrompt, editorPrompt } from './edit-prompts.js';
import { normalizeTimeline } from './timeline.js';

export const MAX_MEDIA = 24;
export const MAX_FRAMES = 60; // imágenes que ve el editor en total

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
//   [1] el Oído (modelo que escucha audio) → mapa musical: secciones, hit points, ritmo de corte
//   ✋ el humano confirma o corrige el mapa
//   [2] el Editor (modelo con visión) → qué toma va en cada segundo
//   [3] el código engancha cada corte al golpe más cercano y valida el montaje
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

  // 1. El Oído escucha el tema completo
  const map = await agent({
    step: 'ear', role: 'Oído', title: 'Escuchando tu música', model: config.earModel,
    system: EAR_SYSTEM, temperature: 0.3, maxTokens: 12000,
    content: [
      { type: 'input_audio', input_audio: { data: audio.wav.toString('base64'), format: 'wav' } },
      { type: 'text', text: earPrompt({ text, audioName: audio.name, analysis: forPrompt }) },
    ],
    meta: { analysis },
  });
  emit({ type: 'map', data: map });

  // Decisión humana: confirmar o corregir el mapa musical.
  const questions = (Array.isArray(map.preguntas_al_humano) ? map.preguntas_al_humano : []).slice(0, 2);
  const answer = await ask({ kind: 'map', title: '¿Escuché bien tu música?', map, questions });
  if (answer) log.decisions.map = answer;

  // 2. El Editor arma el montaje mirando el material
  const catalog = media.map((m) => ({ ...m, duration: Number(m.duration) || 0 }));
  const mediaParts = catalog.flatMap((m) => m.frames.flatMap((f) => [
    { type: 'text', text: m.kind === 'video' ? `${m.id} — cuadro en ${f.t.toFixed(1)} s` : `${m.id} — foto` },
    { type: 'image_url', image_url: { url: f.url } },
  ]));
  const edit = await agent({
    step: 'editor', role: 'Editor', title: 'Montando cada segundo sobre la música', model: config.editorModel,
    system: EDITOR_SYSTEM, temperature: 0.5, maxTokens: 20000,
    content: [{ type: 'text', text: editorPrompt({ text, map, analysis: forPrompt, catalog, answer }) }, ...mediaParts],
    meta: { analysis, media: catalog },
  });

  // 3. Enganchar al ritmo y validar
  const extraAnchors = [
    ...(map.momentos_clave || []).map((m) => Number(m.t)),
    ...(map.puntos_de_corte_libres || []).map((p) => Number(p.t)),
    ...(map.secciones || []).map((s) => Number(s.inicio)),
  ].filter(Number.isFinite);
  const { segmentos, warnings } = normalizeTimeline(edit, { analysis, media: catalog, extraAnchors });
  warnings.forEach((w) => emit({ type: 'notice', step: 'editor', text: w }));

  const result = {
    concepto: edit.concepto,
    nota: edit.nota_para_el_humano,
    duracion: analysis.duration,
    secciones: map.secciones || [],
    momentos: map.momentos_clave || [],
    segmentos,
  };
  emit({ type: 'timeline', data: result });

  log.finishedAt = new Date().toISOString();
  log.totals = totals;
  log.result = { ...result, warnings };
  return log;
}
