import { createAgentRunner } from './agent.js';
import { RAW_SYSTEM, ASPECTS, DONE_LINES, rawTurnContent, assistantMemory, imagePrompt } from './raw-prompts.js';

export const MAX_TEXT = 2000;
export const MAX_VISION = 20; // imágenes que el agente ve por turno (las demás, solo como texto)
const MAX_GENERATED_VISION = 4;
const HISTORY_MESSAGES = 24;

export function parseRawTurnBody(body) {
  const folderId = String(body?.folderId || '');
  if (!folderId) throw new Error('Falta la carpeta.');
  const text = String(body.text || '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
  const selected = (Array.isArray(body.selected) ? body.selected : []).map(String).filter((c) => /^[PRG]\d{1,6}$/.test(c)).slice(0, 8);
  if (!text && !selected.length) throw new Error('Decí o escribí algo (o tocá una imagen).');
  return {
    folderId, text, selected,
    style: String(body.style || 'Any Style').slice(0, 60),
    aspect: ASPECTS.includes(body.aspect) ? body.aspect : '1:1',
  };
}

// Qué imágenes ve el modelo: todas las personas y referencias más recientes, las últimas generadas,
// y siempre las que la persona tocó o las que el agente mostró en el turno anterior.
export function pickVision(assets, { must = [] } = {}) {
  const need = new Set(must);
  const gen = assets.filter((a) => a.kind === 'generada').slice(-MAX_GENERATED_VISION);
  const base = assets.filter((a) => a.kind !== 'generada');
  const chosen = new Set([...assets.filter((a) => need.has(a.code)), ...gen]);
  for (let i = base.length - 1; i >= 0 && chosen.size < MAX_VISION; i--) chosen.add(base[i]);
  return assets.filter((a) => chosen.has(a)).slice(-MAX_VISION);
}

// El historial guardado, como mensajes (los turnos seguidos del mismo rol se juntan).
export function historyMessages(history) {
  const out = [];
  for (const h of history.slice(-HISTORY_MESSAGES)) {
    const role = h.role === 'user' ? 'user' : 'assistant';
    if (out.at(-1)?.role === role) out.at(-1).content += `\n${h.text}`;
    else out.push({ role, content: h.text });
  }
  if (out[0]?.role === 'assistant') out.unshift({ role: 'user', content: '(Entré al proyecto.)' });
  return out;
}

// Valida lo que devolvió el agente contra las imágenes reales del proyecto.
export function sanitizeReply(data, assets) {
  const byCode = new Map(assets.map((a) => [a.code, a]));
  const codes = (list) => [...new Set((Array.isArray(list) ? list : []).map((c) => String(c).trim().toUpperCase()).filter((c) => byCode.has(c)))];
  const decir = String(data?.decir || '').trim().slice(0, 600);
  const etiquetas = (Array.isArray(data?.etiquetas) ? data.etiquetas : [])
    .filter((e) => byCode.has(String(e?.codigo || '').toUpperCase()))
    .map((e) => ({
      codigo: String(e.codigo).toUpperCase(),
      tipo: ['persona', 'referencia'].includes(e.tipo) ? e.tipo : undefined,
      categoria: e.categoria, nombre: e.nombre, descripcion: e.descripcion,
    }));
  let mostrar = null;
  const shown = codes(data?.mostrar?.codigos).slice(0, 4);
  if (shown.length) mostrar = { codigos: shown, pregunta: String(data.mostrar.pregunta || '').slice(0, 200) };
  let generar = null;
  const inputs = codes(data?.generar?.entradas).slice(0, 8);
  if (!mostrar && inputs.length && String(data?.generar?.prompt || '').trim()) {
    generar = {
      entradas: inputs,
      prompt: String(data.generar.prompt).trim().slice(0, 4000),
      proporcion: ASPECTS.includes(data.generar.proporcion) ? data.generar.proporcion : null,
      resumen: String(data.generar.resumen || '').slice(0, 200),
    };
  }
  return { decir, etiquetas, mostrar, generar, pidioGenerarSinImagenes: !mostrar && !inputs.length && !!data?.generar };
}

// Un turno de conversación. `speak(text)` devuelve la URL del audio (o null); `ws` genera la imagen.
export async function runRawTurn({ store, input, config, ws, speak, emit, llm, signal }) {
  const log = { startedAt: new Date().toISOString(), input: { ...input }, steps: {} };
  const { agent, totals } = createAgentRunner({ emit, llm, signal, log });
  const { folderId, text, selected, style, aspect } = input;

  const [lineage, assets, history] = await Promise.all([store.lineage(folderId), store.assetsFor(folderId), store.history(folderId)]);
  const lastAssistant = [...history].reverse().find((h) => h.role === 'assistant' && !h.note);
  const lastShown = lastAssistant?.shown || null;
  const since = history.at(-1)?.at;
  const freshCodes = assets.filter((a) => a.kind !== 'generada' && (!since || a.createdAt > since)).map((a) => a.code);
  const vision = pickVision(assets, { must: [...selected, ...(lastShown?.codigos || [])] });
  const images = await Promise.all(vision.map(async (asset) => ({ asset, url: await store.dataUrl(asset) })));

  const said = (t) => {
    const id = `say-${Math.random().toString(36).slice(2, 9)}`;
    emit({ type: 'raw_say', id, text: t });
    // El audio llega aparte: el texto se muestra enseguida y la voz cuando está lista.
    return Promise.resolve(speak ? speak(t, signal) : null)
      .then((url) => emit({ type: 'raw_audio', id, url }))
      .catch((err) => emit({ type: 'raw_audio', id, url: null, error: err.message }));
  };

  const data = await agent({
    step: 'raw',
    role: 'Raw',
    title: 'Raw piensa',
    model: config.rawModel,
    system: RAW_SYSTEM,
    history: historyMessages(history),
    content: rawTurnContent({ lineage, assets, images, freshCodes, text, selected, style, aspect, lastShown }),
    reasoning: config.rawReasoning ? { effort: config.rawReasoning } : undefined,
    meta: { text, selected, assets, freshCodes, lastShown, aspect },
  });
  const reply = sanitizeReply(data, assets);
  log.reply = reply;

  // Categorías: se guardan en el proyecto (la próxima vez el agente ya sabe qué es cada imagen).
  for (const e of reply.etiquetas) {
    const a = await store.updateAsset(e.codigo, { kind: e.tipo, category: e.categoria, name: e.nombre, description: e.descripcion });
    emit({ type: 'raw_asset', asset: a });
  }

  let decir = reply.decir;
  if (reply.pidioGenerarSinImagenes) decir ||= 'Para generar necesito al menos una imagen del proyecto. ¿Me subes una?';
  if (!decir) decir = reply.mostrar ? '¿Cuál de estas?' : 'Te escucho.';

  const userText = [text, selected.length ? `(tocó ${selected.join(', ')})` : ''].filter(Boolean).join(' ');
  await store.appendHistory(folderId, [
    { role: 'user', text: userText },
    { role: 'assistant', text: assistantMemory({ ...reply, decir }), shown: reply.mostrar },
  ]);

  const speech = said(decir);
  if (reply.mostrar) emit({ type: 'raw_show', codes: reply.mostrar.codigos, question: reply.mostrar.pregunta });
  // A partir de acá la persona ya puede volver a hablar: la generación sigue sola.
  emit({ type: 'raw_listen' });

  if (reply.generar) {
    const gen = reply.generar;
    const inputs = gen.entradas.map((c) => assets.find((a) => a.code === c));
    const ratio = gen.proporcion || aspect;
    const jobId = `gen-${Date.now().toString(36)}`;
    emit({ type: 'raw_generating', id: jobId, inputs: gen.entradas, summary: gen.resumen, aspect: ratio });
    try {
      if (!ws) throw new Error('Para generar imágenes falta WAVESPEED_API_KEY en el .env del servidor.');
      const urls = await Promise.all(inputs.map(async (a) => ws.upload(await store.dataUrl(a), signal)));
      const prompt = imagePrompt({ prompt: gen.prompt, inputs, style });
      log.generation = { model: config.imageModel, prompt, inputs: gen.entradas, aspect: ratio };
      const out = await ws.image({
        model: config.imageModel,
        body: { prompt, images: urls, aspect_ratio: ratio, quality: config.imageQuality, output_format: 'jpeg' },
        signal,
        onStatus: ({ status, elapsed }) => emit({ type: 'raw_gen_status', id: jobId, status, elapsed }),
      });
      if (!out.file) throw new Error('El modelo no devolvió ninguna imagen.');
      const asset = await store.addAsset({ folderId, kind: 'generada', file: out.file, prompt, inputs: gen.entradas });
      log.generation.result = asset.code;
      emit({ type: 'raw_generated', id: jobId, asset });
      await store.appendHistory(folderId, [{ role: 'assistant', note: true, text: `[La imagen ${asset.code} quedó lista (${gen.resumen || 'generada'}).]` }]);
      await speech;
      await said(DONE_LINES[asset.seq % DONE_LINES.length]);
    } catch (err) {
      if (signal?.aborted) throw err;
      emit({ type: 'raw_gen_error', id: jobId, text: err.message });
      await speech;
      await said('Uy, la generación falló. Te dejo el detalle en pantalla.');
    }
  } else {
    await speech;
  }

  return { ...log, totals };
}
