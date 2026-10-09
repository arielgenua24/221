// Laboratorio · Motion Design: una ejecución de UN agente (el navegador lanza dos, una por modelo, en paralelo).
// Cada ejecución es independiente: su propia conversación, sin ver nada del otro agente.
// El servidor no guarda estado: para corregir o revisar, el navegador reenvía el brief, los turnos previos
// y las imágenes que el agente ya generó.
import { parseIntuitionBody } from '../intuition-pipeline.js';
import { nearestRatio } from '../wavespeed.js';
import { labSystem, harnessVersion, briefContent, imageRegistry, zonesFor, compileFix, runtimeFix, feedbackFix, searchFirst, generateFirst, useImages } from './harness.js';
import { compileMotionLayer, extractCode } from './runtime.js';
import { toolDefs, MAX_GENERATED_IMAGES } from './tools.js';

export const MAX_COMPILE_RETRIES = 2; // correcciones automáticas por ejecución si el código no compila
export const MAX_TOOL_ROUNDS = 4; // vueltas de herramientas por ejecución (después tiene que escribir el componente)
export const MAX_BRIEF_REFS = 6;
export const MAX_ZONE_SECONDS = 11; // el Laboratorio permite zonas más largas que Intuition (5 s)
const MAX_TURNS = 12;
const MODEL_ID = /^[\w.-]+\/[\w.:@-]+$/;
const isImage = (u) => typeof u === 'string' && u.startsWith('data:image/');

const str = (x, max) => String(x ?? '').slice(0, max).trim();

export function parseLabBody(body) {
  const model = str(body?.model, 120);
  if (!MODEL_ID.test(model)) throw new Error('Elegí un modelo válido (ID de OpenRouter, ej. anthropic/claude-opus-5.5).');
  // Las zonas y el video usan la misma validación que Intuition (es el mismo marcador de clips), con zonas de hasta 11 s.
  const { video, clips } = parseIntuitionBody(
    { video: body?.video, clips: (body?.clips || []).map((c) => ({ ...c, mode: 'motion' })) },
    { maxClipSeconds: MAX_ZONE_SECONDS },
  );
  const refs = (Array.isArray(body?.brief?.refs) ? body.brief.refs : [])
    .filter((r) => isImage(r?.url))
    .slice(0, MAX_BRIEF_REFS)
    .map((r) => ({ name: str(r.name, 120), url: r.url }));
  const brief = { context: str(body?.brief?.context, 6000), instructions: str(body?.brief?.instructions, 6000), refs };
  // Turnos previos de ESTE agente: su código y lo que se le pidió después (error de ejecución o revisión del humano).
  const turns = (Array.isArray(body?.turns) ? body.turns : []).slice(-MAX_TURNS).map((t) => ({
    code: str(t?.code, 80000),
    kind: ['runtime', 'feedback', 'compile'].includes(t?.kind) ? t.kind : 'feedback',
    message: str(t?.message, 2000),
  })).filter((t) => t.code && t.message);
  // Imágenes que este agente ya generó en ejecuciones anteriores (siguen disponibles y cuentan para el máximo).
  const assets = (Array.isArray(body?.assets) ? body.assets : [])
    .filter((a) => /^gen\d$/.test(a?.id) && isImage(a?.url))
    .slice(0, MAX_GENERATED_IMAGES)
    .map((a) => ({ id: a.id, url: a.url, prompt: str(a.prompt, 2000) }));
  return { model, video, clips, brief, turns, assets };
}

const FIX = { compile: compileFix, runtime: runtimeFix, feedback: feedbackFix };
const FORCE_SEARCH = { type: 'function', function: { name: 'buscar_referencias' } };

// Las líneas "Paleta: #…" y "Objetos: …" de las notas. hex en mayúsculas, sin repetir; null si no escribió la línea.
export function paletteAndObjects(notes) {
  const text = String(notes || '');
  const pal = /paleta\s*:\s*([^\n]*)/i.exec(text);
  const obj = /objetos\s*:\s*([^\n]*)/i.exec(text);
  const palette = pal ? [...new Set((pal[1].match(/#(?:[0-9a-f]{6}|[0-9a-f]{3})\b/gi) || []).map((h) => (h.length === 4 ? `#${[...h.slice(1)].map((c) => c + c).join('')}` : h).toUpperCase()))].slice(0, 8) : null;
  const objects = obj ? obj[1].replace(/[`.]/g, '').split(/,|;| y /).map((o) => o.trim()).filter((o) => o && !/^ningun[oa]s?$/i.test(o)).slice(0, 8) : null;
  return { palette, objects };
}

// ¿El código lee alguna imagen generada? (images.gen1, images?.gen1, images["gen1"], o desestructura gen1)
export const usesImages = (code) => /\bimages\s*(?:\?\.|\.|\[)/.test(code) || /\{[^}]*\bgen\d\b[^}]*\}\s*=\s*images\b/.test(code);

// La línea "Referencias usadas: S2, S5" de las notas → los ids que el agente dice haber usado (solo los que existen).
export function usedReferences(notes, registry) {
  const line = /referencias usadas\s*:\s*([^\n]*)/i.exec(String(notes || ''));
  if (!line) return null;
  return [...new Set(line[1].match(/\b(?:S\d+|R\d+|C\d-R\d+(?:\.\d+)?|C\d-\d+|gen\d)\b/g) || [])].filter((id) => registry.has(id));
}

// Corre el agente hasta tener un componente que compila (o agotar las correcciones automáticas).
// Eventos: run, attempt, delta, reasoning, notice, tool, search, asset, usage, compile_error, result, done | error.
// `tools`: lo que devuelve createLabTools (o null: sin herramientas).
export async function runLabAgent({ input, emit, llm, signal, tools = null }) {
  const { model, video, clips, brief, turns, assets } = input;
  const startedAt = Date.now();
  const available = tools?.available || { search: false, images: false };
  const defs = toolDefs(available);
  const harness = harnessVersion(available);
  const totals = { cost: 0, llmCost: 0, toolCost: 0, tokens: 0, promptTokens: 0, completionTokens: 0, calls: 0, searches: 0, images: 0 };
  const ctx = {
    emit, signal,
    registry: imageRegistry({ brief, clips }),
    aspect: nearestRatio(video.width, video.height),
    state: { searches: 0, searchSeq: 0, generated: assets.length, toolCost: 0 },
  };
  assets.forEach((a) => ctx.registry.set(a.id, a.url));
  const assetNote = assets.length ? [{ role: 'user', content: [
    { type: 'text', text: `Imágenes que ya generaste y siguen disponibles en la prop images: ${assets.map((a) => a.id).join(', ')}.` },
    ...assets.flatMap((a) => [{ type: 'text', text: `${a.id}: ${a.prompt}` }, { type: 'image_url', image_url: { url: a.url } }]),
  ] }] : [];
  const messages = [
    { role: 'system', content: labSystem(available) },
    { role: 'user', content: briefContent({ brief, video, clips }) },
    ...turns.flatMap((t, i) => [
      { role: 'assistant', content: `\`\`\`tsx\n${t.code}\n\`\`\`` },
      // Las imágenes generadas se recuerdan justo antes del último pedido.
      ...(i === turns.length - 1 ? assetNote : []),
      { role: 'user', content: FIX[t.kind](t.message) },
    ]),
  ];
  emit({ type: 'run', model, harness, tools: available, zones: zonesFor(clips) });

  const track = (usage) => {
    const u = usage || {};
    totals.calls += 1;
    totals.llmCost += u.cost || 0;
    totals.tokens += u.total_tokens || 0;
    totals.promptTokens += u.prompt_tokens || 0;
    totals.completionTokens += u.completion_tokens || 0;
    sync();
  };
  const sync = () => {
    totals.toolCost = ctx.state.toolCost;
    totals.searches = ctx.state.searches;
    totals.images = ctx.state.generated - assets.length;
    totals.cost = totals.llmCost + totals.toolCost;
    emit({ type: 'usage', ...totals });
  };

  let compileErrors = 0;
  let toolRounds = 0;
  let toolsOff = false; // el modelo no soporta tool calling en OpenRouter: sigue sin herramientas
  // La búsqueda de referencias es obligatoria al diseñar (primera ejecución y revisiones del humano);
  // al corregir un error técnico no hace falta volver a buscar.
  const mustSearch = available.search && (turns.at(-1)?.kind || 'initial') !== 'runtime';
  let forceSearch = mustSearch; // la próxima llamada obliga a buscar (tool_choice)
  let nudged = false; // ya se le pidió una vez que busque antes de escribir el componente
  // También tiene que generar al menos una imagen propia (si no tiene ninguna de antes) y usarla.
  const mustGenerate = available.images && (turns.at(-1)?.kind || 'initial') !== 'runtime' && assets.length === 0;
  let nudgedImage = false;
  let nudgedUse = false;
  for (let k = 0; ; k++) {
    const withTools = defs.length && !toolsOff && toolRounds < MAX_TOOL_ROUNDS;
    emit({ type: 'attempt', call: k + 1, reason: compileErrors ? 'compile' : toolRounds ? 'tools' : turns.at(-1)?.kind || 'initial' });
    let chars = 0;
    const ask = (useTools, toolChoice) => llm({
      step: 'lab', model, messages, signal, meta: { lab: true, model, turn: turns.length + k },
      ...(useTools ? { tools: defs, ...(toolChoice ? { toolChoice } : {}) } : {}),
      onDelta: (t) => { chars += t.length; emit({ type: 'delta', text: t, chars }); },
      onReasoning: (t) => emit({ type: 'reasoning', text: t }),
      onRetry: ({ status, attempt, retries, waitMs }) => emit({ type: 'notice', text: `${model} no da abasto (${status}). Reintento ${attempt}/${retries} en ${Math.max(1, Math.round(waitMs / 1000))} s…` }),
    });
    const choice = withTools && forceSearch ? FORCE_SEARCH : undefined;
    forceSearch = false;
    let res;
    try {
      res = await ask(withTools, choice);
    } catch (err) {
      const rejected = withTools && !err.streamed && !signal?.aborted && [400, 404].includes(Number(err.status)) && /tool/i.test(err.message);
      if (!rejected) throw err;
      if (choice) {
        // Algunos proveedores no dejan forzar una herramienta (ej. con razonamiento extendido): sigue en automático y el prompt lo exige.
        emit({ type: 'notice', text: `${model} no acepta que se le fuerce la búsqueda: se la pido por instrucción.` });
        try {
          res = await ask(true);
        } catch (err2) {
          if (err2.streamed || signal?.aborted || ![400, 404].includes(Number(err2.status)) || !/tool/i.test(err2.message)) throw err2;
          toolsOff = true;
          emit({ type: 'notice', text: `${model} no acepta herramientas en OpenRouter: sigue sin búsqueda ni generación de imágenes.` });
          res = await ask(false);
        }
      } else {
        toolsOff = true;
        emit({ type: 'notice', text: `${model} no acepta herramientas en OpenRouter: sigue sin búsqueda ni generación de imágenes.` });
        res = await ask(false);
      }
    }
    track(res.usage);

    // El modelo pidió herramientas: se ejecutan y se le devuelven los resultados (no cuenta como intento fallido).
    if (res.toolCalls?.length) {
      messages.push({ role: 'assistant', content: res.text || '', tool_calls: res.toolCalls, ...(res.reasoningDetails ? { reasoning_details: res.reasoningDetails } : {}) });
      const shown = [];
      for (const call of res.toolCalls) {
        const out = withTools ? await tools.run(call, ctx) : { text: 'Ya no hay más herramientas disponibles: escribí el componente.' };
        messages.push({ role: 'tool', tool_call_id: call.id, content: out.text });
        if (out.parts?.length) shown.push(...out.parts);
        sync();
      }
      // Las imágenes van en un mensaje aparte: no todos los proveedores aceptan imágenes dentro del resultado de una herramienta.
      if (shown.length) messages.push({ role: 'user', content: [{ type: 'text', text: 'Resultados de las herramientas:' }, ...shown] });
      toolRounds += 1;
      if (k >= MAX_TOOL_ROUNDS + MAX_COMPILE_RETRIES + 2 || signal?.aborted) {
        throw Object.assign(new Error(`${model} siguió llamando herramientas sin escribir el componente.`), { totals, compileErrors, ms: Date.now() - startedAt });
      }
      continue;
    }

    // Entregó código sin haber buscado: no se compila; se le pide (una sola vez) que busque primero.
    if (mustSearch && !toolsOff && !nudged && ctx.state.searches === 0 && toolRounds < MAX_TOOL_ROUNDS) {
      nudged = true;
      forceSearch = true;
      emit({ type: 'notice', text: 'Escribió el componente sin buscar referencias: le pido que busque primero.' });
      messages.push(
        { role: 'assistant', content: res.text?.trim() ? res.text : '(respuesta vacía)' },
        { role: 'user', content: searchFirst() },
      );
      continue;
    }

    if (mustGenerate && !toolsOff && !nudgedImage && ctx.state.generated === 0 && toolRounds < MAX_TOOL_ROUNDS) {
      nudgedImage = true;
      emit({ type: 'notice', text: 'Escribió el componente sin generar ninguna imagen propia: le pido que genere al menos una y la use.' });
      messages.push(
        { role: 'assistant', content: res.text?.trim() ? res.text : '(respuesta vacía)' },
        { role: 'user', content: generateFirst() },
      );
      continue;
    }

    let message;
    try {
      const code = extractCode(res.text);
      // Si hay imágenes generadas y el código no las usa, se le marca una vez (no es un error de compilación).
      const genIds = [...ctx.registry.keys()].filter((id) => /^gen\d$/.test(id));
      if (genIds.length && !nudgedUse && !usesImages(code) && toolRounds < MAX_TOOL_ROUNDS + 1) {
        nudgedUse = true;
        emit({ type: 'notice', text: `No usa ${genIds.join(' ni ')} en la animación: le pido que las integre.` });
        messages.push(
          { role: 'assistant', content: res.text },
          { role: 'user', content: useImages(genIds) },
        );
        continue;
      }
      const { js } = await compileMotionLayer(code);
      // Las notas son lo que el modelo escribió antes del bloque de código.
      const cut = res.text.search(/```[a-z]*[ \t]*\r?\n[\s\S]*?export\s+default/i);
      const notes = (cut > 0 ? res.text.slice(0, cut) : '').trim().slice(0, 1500);
      emit({ type: 'result', code, js, notes, usedRefs: usedReferences(notes, ctx.registry), ...paletteAndObjects(notes) });
      emit({ type: 'done', ...totals, ms: Date.now() - startedAt, compileErrors, toolRounds, toolsOff, searchRequired: mustSearch, nudged, imageRequired: mustGenerate, nudgedImage, nudgedUse, harness });
      return;
    } catch (err) {
      message = err.message;
    }
    compileErrors += 1;
    emit({ type: 'compile_error', text: message, call: k + 1 });
    if (compileErrors > MAX_COMPILE_RETRIES || signal?.aborted) {
      throw Object.assign(new Error(`${model} no entregó un componente válido tras ${compileErrors} intento${compileErrors > 1 ? 's' : ''}: ${message}`), { totals, compileErrors, ms: Date.now() - startedAt });
    }
    messages.push(
      { role: 'assistant', content: res.text?.trim() ? res.text : '(respuesta vacía)' },
      { role: 'user', content: compileFix(message) },
    );
  }
}
