// Laboratorio · Motion Design: una ejecución de UN agente (el navegador lanza dos, una por modelo, en paralelo).
// Cada ejecución es independiente: su propia conversación, sin ver nada del otro agente.
// El servidor no guarda estado: para corregir o revisar, el navegador reenvía el brief, los turnos previos
// y las imágenes que el agente ya generó.
import { parseIntuitionBody } from '../intuition-pipeline.js';
import { nearestRatio } from '../wavespeed.js';
import { labSystem, harnessVersion, briefContent, imageRegistry, zonesFor, compileFix, truncatedFix, continueCode, runtimeFix, feedbackFix, reviewFix, REVIEW_APPROVED, searchFirst, generateFirst, useImages, soundFirst, videoFirst, useSounds } from './harness.js';
import { FPS } from './runtime.js';
import { getEngine, engineId } from '../engines/index.js';
import { toolDefs, MAX_GENERATED_IMAGES, LIMIT_CAPS } from './tools.js';
import { parseTranscript } from './transcript.js';
import { EFFORTS, resolveReasoning } from './reasoning.js';
import { parseDocs } from './docs.js';

export const MAX_COMPILE_RETRIES = 2; // correcciones automáticas por ejecución si el código no compila
export const MAX_CONTINUATIONS = 3; // veces que se le pide seguir un componente cortado por el tope de salida
export const MAX_TOOL_ROUNDS = 4; // vueltas de herramientas por ejecución (después tiene que escribir el componente)
export const MAX_BRIEF_REFS = 6;
export const MAX_ZONE_SECONDS = 11; // el Laboratorio permite zonas más largas que Intuition (5 s)
export const MAX_LAB_CLIPS = 6; // y más zonas que Intuition (3): en modo Automático el humano elige cuántas animaciones quiere
export const MAX_STORYBOARD = 12; // cuadros repartidos en todo el video que ve el agente antes de las zonas
export const MAX_REVIEW_SHOTS = 12; // capturas de su propia animación que ve en cada revisión visual
const MAX_TURNS = 12;
const MAX_NOTES = 6000; // la bitácora con sus revisiones + las notas
const MODEL_ID = /^[\w.-]+\/[\w.:@-]+$/;
const isImage = (u) => typeof u === 'string' && u.startsWith('data:image/');
const isAudio = (u) => typeof u === 'string' && u.startsWith('data:audio/');

const str = (x, max) => String(x ?? '').slice(0, max).trim();

export function parseLabBody(body) {
  const model = str(body?.model, 120);
  if (!MODEL_ID.test(model)) throw new Error('Elegí un modelo válido (ID de OpenRouter, ej. anthropic/claude-opus-5.5).');
  // Las zonas y el video usan la misma validación que Intuition (es el mismo marcador de clips), con zonas de hasta 11 s.
  const { video, clips } = parseIntuitionBody(
    { video: body?.video, clips: (body?.clips || []).map((c) => ({ ...c, mode: 'motion' })) },
    { maxClipSeconds: MAX_ZONE_SECONDS, maxClips: MAX_LAB_CLIPS },
  );
  const refs = (Array.isArray(body?.brief?.refs) ? body.brief.refs : [])
    .filter((r) => isImage(r?.url))
    .slice(0, MAX_BRIEF_REFS)
    .map((r) => ({ name: str(r.name, 120), url: r.url }));
  const brief = { context: str(body?.brief?.context, 6000), instructions: str(body?.brief?.instructions, 6000), refs, docs: parseDocs(body?.brief?.docs) };
  // Storyboard: cuadros de todo el video (el navegador los saca al armar el pedido), en orden.
  const duration = video.duration;
  const storyboard = (Array.isArray(body?.storyboard) ? body.storyboard : [])
    .filter((f) => isImage(f?.url) && Number.isFinite(Number(f?.t)))
    .map((f) => ({ t: Math.round(Math.min(Math.max(0, Number(f.t)), duration) * 100) / 100, url: f.url }))
    .sort((a, b) => a.t - b.t)
    .slice(0, MAX_STORYBOARD);
  // Turnos previos de ESTE agente: su código y lo que se le pidió después (error de ejecución, revisión del humano
  // o revisión visual: capturas de su animación renderizada; solo las del último turno llegan al modelo).
  const turns = (Array.isArray(body?.turns) ? body.turns : []).slice(-MAX_TURNS).map((t) => {
    const kind = ['runtime', 'feedback', 'compile', 'review'].includes(t?.kind) ? t.kind : 'feedback';
    const shots = kind === 'review' ? (Array.isArray(t?.shots) ? t.shots : []).filter((x) => isImage(x?.url)).slice(0, MAX_REVIEW_SHOTS).map((x) => ({ label: str(x.label, 160), url: x.url })) : [];
    return {
      code: str(t?.code, 80000), kind, message: str(t?.message, 2000),
      ...(kind === 'review' ? { round: Math.max(1, Math.round(Number(t?.round)) || 1), rounds: Math.max(1, Math.round(Number(t?.rounds)) || 1), shots } : {}),
    };
  }).filter((t) => t.code && t.message);
  // Imágenes que este agente ya generó en ejecuciones anteriores (siguen disponibles y cuentan para el máximo).
  const assets = (Array.isArray(body?.assets) ? body.assets : [])
    .filter((a) => /^gen\d$/.test(a?.id) && isImage(a?.url))
    .slice(0, MAX_GENERATED_IMAGES)
    .map((a) => ({ id: a.id, url: a.url, prompt: str(a.prompt, 2000) }));
  // Context Lab: sonidos y tomas de video que esta variante ya generó (siguen disponibles y cuentan para el máximo).
  const sounds = (Array.isArray(body?.sounds) ? body.sounds : [])
    .filter((a) => /^sfx\d$/.test(a?.id) && isAudio(a?.url))
    .slice(0, LIMIT_CAPS.sounds)
    .map((a) => ({ id: a.id, url: a.url, prompt: str(a.prompt, 600), duration: Number(a.duration) || 0 }));
  const videos = (Array.isArray(body?.videos) ? body.videos : [])
    .filter((a) => /^vid\d$/.test(a?.id))
    .slice(0, LIMIT_CAPS.videos)
    .map((a) => ({ id: a.id, zone: str(a.zone, 8), prompt: str(a.prompt, 3000), source: str(a.source, 20) }));
  // Habla del video (Whisper): cabezales por segundo, opcional. Si viene, entra en el pedido de los agentes.
  const transcript = parseTranscript(body?.transcript);
  // Motion Design: el nivel de razonamiento de ESTE lado ('' = el del modelo). Context Lab lo trae en la configuración de la variante.
  const reasoning = EFFORTS.includes(body?.reasoning) ? body.reasoning : null;
  // El motor de animación (src/engines/): cómo se escribe, compila y reproduce la capa. Sin motor, Remotion (como siempre).
  const engine = engineId(body?.engine);
  return { model, video, clips, brief, storyboard, turns, assets, sounds, videos, transcript, reasoning, engine };
}

// Modos por herramienta: 'off' | 'optional' | 'required'.
export const TOOL_KEYS = ['search', 'images', 'sound', 'video'];
export const TOOL_MODES = ['off', 'optional', 'required'];
// Motion Design: búsqueda e imagen obligatorias (si hay clave), sonido y video apagados.
export const MOTION_POLICY = { search: 'required', images: 'required', sound: 'off', video: 'off' };

// ¿Quedó un bloque ``` abierto? (la respuesta se cortó a mitad del código)
export const openFence = (text) => (String(text || '').match(/```/g) || []).length % 2 === 1;

// Pega la continuación al texto cortado. Los modelos a veces reabren el bloque o repiten lo último que escribieron:
// se saca la apertura del bloque y el tramo repetido (solo si tiene contenido, no un simple sangrado).
export function stitch(before, after) {
  const a = String(before || '');
  let b = String(after || '').replace(/^\s*```[a-z]*[^\n`]*\r?\n/i, '');
  for (let k = Math.min(a.length, b.length, 4000); k >= 8; k--) {
    const piece = b.slice(0, k);
    if (piece.trim().length >= 8 && a.endsWith(piece)) { b = b.slice(k); break; }
  }
  return a + b;
}

const FIX = { compile: compileFix, runtime: runtimeFix, feedback: feedbackFix };
// El pedido que sigue a un turno. La revisión visual lleva las capturas (solo en el último turno: las viejas ya no sirven y pesan).
function turnContent(t, engine, last) {
  if (t.kind !== 'review') return FIX[t.kind](t.message, engine);
  const text = reviewFix(t.round, t.rounds, engine);
  if (!last || !t.shots.length) return `${text}\n(The screenshots of this round are no longer attached.)`;
  return [{ type: 'text', text }, ...t.shots.flatMap((x, k) => [{ type: 'text', text: `V${k + 1} — ${x.label}` }, { type: 'image_url', image_url: { url: x.url } }])];
}
// ¿Aprobó su propia animación en la revisión visual? (la palabra sola en una línea y ningún bloque de código)
export const approvedReview = (text) => !/```/.test(String(text || '')) && new RegExp(`^\\W*${REVIEW_APPROVED}\\W*$`, 'm').test(String(text || ''));
const FORCE_SEARCH = { type: 'function', function: { name: 'buscar_referencias' } };

// Las líneas "Paleta: #…" y "Objetos: …" de las notas. hex en mayúsculas, sin repetir; null si no escribió la línea.
export function paletteAndObjects(notes) {
  const text = String(notes || '');
  const pal = /(?:palette|paleta)\s*:\s*([^\n]*)/i.exec(text);
  const obj = /(?:objects|objetos)\s*:\s*([^\n]*)/i.exec(text);
  const palette = pal ? [...new Set((pal[1].match(/#(?:[0-9a-f]{6}|[0-9a-f]{3})\b/gi) || []).map((h) => (h.length === 4 ? `#${[...h.slice(1)].map((c) => c + c).join('')}` : h).toUpperCase()))].slice(0, 8) : null;
  const objects = obj ? obj[1].replace(/[`.]/g, '').split(/,|;| y | and /).map((o) => o.trim()).filter((o) => o && !/^(?:none|ningun[oa]s?)$/i.test(o)).slice(0, 8) : null;
  return { palette, objects };
}

// ¿El código lee alguna imagen generada? (images.gen1, images?.gen1, images["gen1"], o desestructura gen1)
export const usesImages = (code) => /\bimages\s*(?:\?\.|\.|\[)/.test(code) || /\{[^}]*\bgen\d\b[^}]*\}\s*=\s*images\b/.test(code);
// Lo mismo con los sonidos (sounds.sfx1…; en el motor canvas, AUDIO = [{ sound: 'sfx1', … }]).
export const usesSounds = (code) => /\bsounds\s*(?:\?\.|\.|\[)/.test(code) || /\{[^}]*\bsfx\d\b[^}]*\}\s*=\s*sounds\b/.test(code) || /\bsound\s*:\s*['"`]sfx\d/.test(code);

// La línea "Referencias usadas: S2, S5" de las notas → los ids que el agente dice haber usado (solo los que existen).
export function usedReferences(notes, registry) {
  const line = /(?:references used|referencias usadas)\s*:\s*([^\n]*)/i.exec(String(notes || ''));
  if (!line) return null;
  return [...new Set(line[1].match(/\b(?:S\d+|R\d+|C\d-R\d+(?:\.\d+)?|C\d-\d+|gen\d)\b/g) || [])].filter((id) => registry.has(id));
}

// Corre el agente hasta tener un componente que compila (o agotar las correcciones automáticas).
// Eventos: run, attempt, delta, reasoning, notice, tool, search, asset, sound, video, usage, compile_error, result, done | error.
// `tools`: lo que devuelve createLabTools (o null: sin herramientas).
// `config` (Context Lab; sin config se comporta como Motion Design):
//   { system, policy: { search, images, sound, video } (off|optional|required), limits, temperature, reasoning,
//     harness, videoModel, maxToolRounds, frames, reasoningMeta, engine }
// engine: el motor de animación (config.engine en Context Lab, input.engine en Motion Design; por defecto Remotion).
// reasoning: nivel pedido (config.reasoning, o input.reasoning en Motion Design). reasoningMeta: lo que acepta el modelo según
// el catálogo (reasoning.js); con eso se pide el nivel más cercano que soporta.
export async function runLabAgent({ input, emit, llm, signal, tools = null, config = {} }) {
  const { model, video, clips, brief, turns, assets, transcript = null, storyboard = [] } = input;
  const sounds = input.sounds || [];
  const videos = input.videos || [];
  const startedAt = Date.now();
  const available = tools?.available || { search: false, images: false };
  const policy = { ...MOTION_POLICY, ...(config.policy || {}) };
  // Lo que ve el agente: la herramienta existe en el entorno Y la variante no la apagó.
  const enabled = Object.fromEntries(TOOL_KEYS.map((k) => [k, !!available[k] && policy[k] !== 'off']));
  const engine = getEngine(config.engine ?? input.engine);
  const defs = toolDefs(enabled, { modes: policy, limits: config.limits, words: engine.words });
  const harness = config.harness || harnessVersion(available, engine.id);
  const maxToolRounds = config.maxToolRounds || MAX_TOOL_ROUNDS;
  const effort = resolveReasoning(config.reasoning ?? input.reasoning, config.reasoningMeta);
  const totals = { cost: 0, llmCost: 0, toolCost: 0, tokens: 0, promptTokens: 0, completionTokens: 0, calls: 0, searches: 0, images: 0, sounds: 0, videos: 0 };
  const ctx = {
    emit, signal,
    registry: imageRegistry({ brief, clips, storyboard: config.frames === 0 ? [] : storyboard }),
    sounds: new Map(sounds.map((a) => [a.id, a.url])),
    zones: zonesFor(clips),
    fps: FPS,
    aspect: nearestRatio(video.width, video.height),
    limits: config.limits,
    videoModel: config.videoModel,
    words: engine.words,
    state: { searches: 0, searchSeq: 0, generated: assets.length, sounds: sounds.length, videos: videos.length, toolCost: 0 },
  };
  assets.forEach((a) => ctx.registry.set(a.id, a.url));
  const previous = [
    ...(assets.length ? [{ type: 'text', text: `Imágenes que ya generaste y siguen disponibles en la prop images: ${assets.map((a) => a.id).join(', ')}.` }] : []),
    ...assets.flatMap((a) => [{ type: 'text', text: `${a.id}: ${a.prompt}` }, { type: 'image_url', image_url: { url: a.url } }]),
    ...(sounds.length ? [{ type: 'text', text: `Sonidos que ya generaste y siguen disponibles en la prop sounds: ${sounds.map((a) => `${a.id} (${a.duration} s): ${a.prompt}`).join(' · ')}.` }] : []),
    ...(videos.length ? [{ type: 'text', text: `Tomas de video que ya generaste (cada una en su capa propia, debajo de tu animación): ${videos.map((a) => `${a.id} en ${a.zone}: ${a.prompt}`).join(' · ')}.` }] : []),
  ];
  const assetNote = previous.length ? [{ role: 'user', content: previous }] : [];
  const system = config.system || labSystem(available, engine.id);
  const firstUser = briefContent({ brief, video, clips, transcript, storyboard }, { frames: config.frames, enabled });
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: firstUser },
    ...turns.flatMap((t, i) => [
      { role: 'assistant', content: `\`\`\`${engine.fence}\n${t.code}\n\`\`\`` },
      // Las imágenes generadas se recuerdan justo antes del último pedido.
      ...(i === turns.length - 1 ? assetNote : []),
      { role: 'user', content: turnContent(t, engine.id, i === turns.length - 1) },
    ]),
  ];
  // Cuánto contexto recibe el agente de entrada (para comparar variantes: tokens ≈ caracteres / 4).
  const briefChars = firstUser.filter((p) => p.type === 'text').reduce((n, p) => n + p.text.length, 0);
  const context = { systemChars: system.length, briefChars, images: firstUser.filter((p) => p.type === 'image_url').length, tools: defs.map((d) => d.function.name) };
  emit({ type: 'run', model, harness, engine: engine.id, tools: available, policy, enabled, context, zones: zonesFor(clips), reasoning: effort.effective });
  if (effort.note) emit({ type: 'notice', text: effort.note });

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
    totals.sounds = ctx.state.sounds - sounds.length;
    totals.videos = ctx.state.videos - videos.length;
    totals.cost = totals.llmCost + totals.toolCost;
    emit({ type: 'usage', ...totals });
  };

  let compileErrors = 0;
  let toolRounds = 0;
  let toolsOff = false; // el modelo no soporta tool calling en OpenRouter: sigue sin herramientas
  const lastKind = turns.at(-1)?.kind || 'initial';
  // Corregir un error técnico o revisar sus capturas no es diseñar de nuevo: no se le exigen otra vez las herramientas.
  const designing = !['runtime', 'review'].includes(lastKind);
  // Una herramienta obligatoria se exige al diseñar (primera ejecución y revisiones del humano);
  // al corregir un error técnico no hace falta volver a usarla. Imagen, sonido y video: solo si todavía no hay ninguno.
  const required = (k) => enabled[k] && policy[k] === 'required' && designing;
  const mustSearch = required('search');
  const mustGenerate = required('images') && assets.length === 0;
  const mustSound = required('sound') && sounds.length === 0;
  const mustVideo = required('video') && videos.length === 0;
  let forceSearch = mustSearch; // la próxima llamada obliga a buscar (tool_choice)
  let nudged = false; // ya se le pidió una vez que busque antes de escribir el componente
  let nudgedImage = false;
  let nudgedUse = false;
  let nudgedSound = false;
  let nudgedVideo = false;
  let nudgedSoundUse = false;
  const sampling = {
    ...(Number.isFinite(config.temperature) ? { temperature: config.temperature } : {}),
    ...(effort.param ? { reasoning: effort.param } : {}),
    ...(config.maxOutput ? { maxTokens: config.maxOutput } : {}),
  };
  for (let k = 0; ; k++) {
    const withTools = defs.length && !toolsOff && toolRounds < maxToolRounds;
    emit({ type: 'attempt', call: k + 1, reason: compileErrors ? 'compile' : toolRounds ? 'tools' : turns.at(-1)?.kind || 'initial' });
    let chars = 0;
    // over: lo que cambia una llamada puntual (la continuación de un bloque cortado manda otros mensajes y piensa menos).
    const ask = (useTools, toolChoice, over = {}) => llm({
      step: 'lab', model, messages, signal, meta: { lab: true, model, turn: turns.length + k }, ...sampling,
      ...(useTools ? { tools: defs, ...(toolChoice ? { toolChoice } : {}) } : {}),
      ...over,
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
          emit({ type: 'notice', text: `${model} no acepta herramientas en OpenRouter: sigue sin herramientas.` });
          res = await ask(false);
        }
      } else {
        toolsOff = true;
        emit({ type: 'notice', text: `${model} no acepta herramientas en OpenRouter: sigue sin herramientas.` });
        res = await ask(false);
      }
    }
    track(res.usage);

    // El modelo pidió herramientas: se ejecutan y se le devuelven los resultados (no cuenta como intento fallido).
    if (res.toolCalls?.length) {
      messages.push({ role: 'assistant', content: res.text || '', tool_calls: res.toolCalls, ...(res.reasoningDetails ? { reasoning_details: res.reasoningDetails } : {}) });
      const shown = [];
      for (const call of res.toolCalls) {
        const name = call.function?.name;
        const key = { buscar_referencias: 'search', generar_imagen: 'images', generar_sonido: 'sound', generar_video: 'video' }[name];
        // Una herramienta que la variante apagó no se ejecuta aunque el modelo la invente.
        const out = withTools && (!key || enabled[key]) ? await tools.run(call, ctx) : { text: withTools ? `Error: la herramienta ${name} no está disponible en este entorno.` : 'Ya no hay más herramientas disponibles: escribí el componente.' };
        messages.push({ role: 'tool', tool_call_id: call.id, content: out.text });
        if (out.parts?.length) shown.push(...out.parts);
        sync();
      }
      // Las imágenes van en un mensaje aparte: no todos los proveedores aceptan imágenes dentro del resultado de una herramienta.
      if (shown.length) messages.push({ role: 'user', content: [{ type: 'text', text: 'Resultados de las herramientas:' }, ...shown] });
      toolRounds += 1;
      if (k >= maxToolRounds + MAX_COMPILE_RETRIES + 2 || signal?.aborted) {
        throw Object.assign(new Error(`${model} siguió llamando herramientas sin escribir el componente.`), { totals, compileErrors, ms: Date.now() - startedAt });
      }
      continue;
    }

    // Se cortó por el tope de salida a mitad del código: lo escrito ya está pago, así que en vez de regenerar todo
    // se le devuelve y se le pide que siga desde donde quedó. Piensa poco: solo tiene que terminar de escribir.
    // (Si se cortó razonando, antes de abrir el bloque, no hay nada que seguir: eso lo maneja `truncated` más abajo.)
    let continued = 0;
    const quick = resolveReasoning('low', config.reasoningMeta).param;
    while (res.finishReason === 'length' && openFence(res.text) && continued < MAX_CONTINUATIONS && !signal?.aborted) {
      continued += 1;
      emit({ type: 'notice', text: `Se cortó por largo a mitad del código: le pido que siga desde donde quedó (${continued}/${MAX_CONTINUATIONS}).` });
      const more = await ask(false, undefined, {
        messages: [...messages, { role: 'assistant', content: res.text }, { role: 'user', content: continueCode(engine.id) }],
        ...(quick ? { reasoning: quick } : {}),
      });
      track(more.usage);
      res = { ...more, text: stitch(res.text, more.text) };
    }

    // Revisión visual: miró sus capturas y le parece bien así. Queda la versión que ya se reproduce (no se recompila).
    if (lastKind === 'review' && approvedReview(res.text)) {
      emit({ type: 'approved', notes: res.text.trim().slice(0, MAX_NOTES) });
      emit({ type: 'done', ...totals, ms: Date.now() - startedAt, compileErrors, toolRounds, toolsOff, harness, engine: engine.id, approved: true });
      return;
    }

    const canNudge = !toolsOff && toolRounds < maxToolRounds;
    const nudge = (notice, ask) => {
      emit({ type: 'notice', text: notice });
      messages.push(
        { role: 'assistant', content: res.text?.trim() ? res.text : '(respuesta vacía)' },
        { role: 'user', content: ask },
      );
    };
    // Entregó código sin haber buscado: no se compila; se le pide (una sola vez) que busque primero.
    if (mustSearch && canNudge && !nudged && ctx.state.searches === 0) {
      nudged = true;
      forceSearch = true;
      nudge('Escribió el componente sin buscar referencias: le pido que busque primero.', searchFirst(engine.id));
      continue;
    }

    if (mustGenerate && canNudge && !nudgedImage && ctx.state.generated === 0) {
      nudgedImage = true;
      nudge('Escribió el componente sin generar ninguna imagen propia: le pido que genere al menos una y la use.', generateFirst(engine.id));
      continue;
    }

    if (mustVideo && canNudge && !nudgedVideo && ctx.state.videos === 0) {
      nudgedVideo = true;
      nudge('Escribió el componente sin generar la toma de video obligatoria: se la pido.', videoFirst(engine.id));
      continue;
    }

    if (mustSound && canNudge && !nudgedSound && ctx.state.sounds === 0) {
      nudgedSound = true;
      nudge('Escribió el componente sin generar ningún sonido: le pido al menos uno.', soundFirst(engine.id));
      continue;
    }

    let message;
    try {
      const code = engine.extractCode(res.text);
      // Si hay imágenes generadas y el código no las usa, se le marca una vez (no es un error de compilación).
      const genIds = [...ctx.registry.keys()].filter((id) => /^gen\d$/.test(id));
      if (genIds.length && !nudgedUse && !usesImages(code) && toolRounds < maxToolRounds + 1) {
        nudgedUse = true;
        emit({ type: 'notice', text: `No usa ${genIds.join(' ni ')} en la animación: le pido que las integre.` });
        messages.push(
          { role: 'assistant', content: res.text },
          { role: 'user', content: useImages(genIds, engine.id) },
        );
        continue;
      }
      const sfxIds = [...ctx.sounds.keys()];
      if (sfxIds.length && !nudgedSoundUse && !usesSounds(code) && toolRounds < maxToolRounds + 1) {
        nudgedSoundUse = true;
        emit({ type: 'notice', text: `No usa ${sfxIds.join(' ni ')} en la animación: le pido que los ponga.` });
        messages.push(
          { role: 'assistant', content: res.text },
          { role: 'user', content: useSounds(sfxIds, engine.id) },
        );
        continue;
      }
      const { js } = await engine.compile(code, { width: video.width, height: video.height, duration: video.duration, fps: FPS, zones: ctx.zones, images: genIds, sounds: sfxIds });
      // Las notas son lo que el modelo escribió antes del bloque de código.
      const cut = res.text.search(new RegExp(`\`\`\`[a-z]*[ \\t]*\\r?\\n[\\s\\S]*?${engine.marker.source}`, 'i'));
      const notes = (cut > 0 ? res.text.slice(0, cut) : '').trim().slice(0, MAX_NOTES);
      emit({ type: 'result', engine: engine.id, code, js, notes, usedRefs: usedReferences(notes, ctx.registry), ...paletteAndObjects(notes) });
      emit({
        type: 'done', ...totals, ms: Date.now() - startedAt, compileErrors, toolRounds, toolsOff, harness, engine: engine.id,
        searchRequired: mustSearch, nudged, imageRequired: mustGenerate, nudgedImage, nudgedUse,
        soundRequired: mustSound, nudgedSound, nudgedSoundUse, videoRequired: mustVideo, nudgedVideo,
      });
      return;
    } catch (err) {
      message = err.message;
    }
    // Se cortó por el tope de salida (el razonamiento se comió el presupuesto): el bloque quedó sin cerrar.
    // Repetir igual vuelve a cortarse; el próximo intento piensa menos y se le pide un componente más compacto.
    const truncated = res.finishReason === 'length';
    if (truncated) {
      message = `la respuesta se cortó por largo (tope de tokens de salida) antes de terminar el componente — ${message}`;
      const down = resolveReasoning('low', config.reasoningMeta);
      if (down.param && sampling.reasoning?.effort !== down.param.effort) {
        sampling.reasoning = down.param;
        emit({ type: 'notice', text: `${model} se quedó sin tokens de salida: el próximo intento razona en «${down.effective}» para dejarle lugar al código.` });
      }
    }
    compileErrors += 1;
    emit({ type: 'compile_error', text: message, call: k + 1 });
    if (compileErrors > MAX_COMPILE_RETRIES || signal?.aborted) {
      throw Object.assign(new Error(`${model} no entregó un componente válido tras ${compileErrors} intento${compileErrors > 1 ? 's' : ''}: ${message}`), { totals, compileErrors, ms: Date.now() - startedAt });
    }
    messages.push(
      { role: 'assistant', content: res.text?.trim() ? res.text : '(respuesta vacía)' },
      { role: 'user', content: truncated ? truncatedFix(engine.id) : compileFix(message, engine.id) },
    );
  }
}
