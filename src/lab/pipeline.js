// Laboratorio · Motion Design: una ejecución de UN agente (el navegador lanza dos, una por modelo, en paralelo).
// Cada ejecución es independiente: su propia conversación, sin ver nada del otro agente.
// El servidor no guarda estado: para corregir o revisar, el navegador reenvía el brief, los turnos previos
// y las imágenes que el agente ya generó.
import { parseIntuitionBody } from '../intuition-pipeline.js';
import { nearestRatio } from '../wavespeed.js';
import { labSystem, harnessVersion, briefContent, imageRegistry, zonesFor, compileFix, runtimeFix, feedbackFix, searchFirst, generateFirst, useImages, soundFirst, videoFirst, useSounds } from './harness.js';
import { compileMotionLayer, extractCode, FPS } from './runtime.js';
import { toolDefs, MAX_GENERATED_IMAGES, LIMIT_CAPS } from './tools.js';

export const MAX_COMPILE_RETRIES = 2; // correcciones automáticas por ejecución si el código no compila
export const MAX_TOOL_ROUNDS = 4; // vueltas de herramientas por ejecución (después tiene que escribir el componente)
export const MAX_BRIEF_REFS = 6;
export const MAX_ZONE_SECONDS = 11; // el Laboratorio permite zonas más largas que Intuition (5 s)
const MAX_TURNS = 12;
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
  // Context Lab: sonidos y tomas de video que esta variante ya generó (siguen disponibles y cuentan para el máximo).
  const sounds = (Array.isArray(body?.sounds) ? body.sounds : [])
    .filter((a) => /^sfx\d$/.test(a?.id) && isAudio(a?.url))
    .slice(0, LIMIT_CAPS.sounds)
    .map((a) => ({ id: a.id, url: a.url, prompt: str(a.prompt, 600), duration: Number(a.duration) || 0 }));
  const videos = (Array.isArray(body?.videos) ? body.videos : [])
    .filter((a) => /^vid\d$/.test(a?.id))
    .slice(0, LIMIT_CAPS.videos)
    .map((a) => ({ id: a.id, zone: str(a.zone, 8), prompt: str(a.prompt, 3000), source: str(a.source, 20) }));
  return { model, video, clips, brief, turns, assets, sounds, videos };
}

// Modos por herramienta: 'off' | 'optional' | 'required'.
export const TOOL_KEYS = ['search', 'images', 'sound', 'video'];
export const TOOL_MODES = ['off', 'optional', 'required'];
// Motion Design: búsqueda e imagen obligatorias (si hay clave), sonido y video apagados.
export const MOTION_POLICY = { search: 'required', images: 'required', sound: 'off', video: 'off' };

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
// Lo mismo con los sonidos (sounds.sfx1…).
export const usesSounds = (code) => /\bsounds\s*(?:\?\.|\.|\[)/.test(code) || /\{[^}]*\bsfx\d\b[^}]*\}\s*=\s*sounds\b/.test(code);

// La línea "Referencias usadas: S2, S5" de las notas → los ids que el agente dice haber usado (solo los que existen).
export function usedReferences(notes, registry) {
  const line = /referencias usadas\s*:\s*([^\n]*)/i.exec(String(notes || ''));
  if (!line) return null;
  return [...new Set(line[1].match(/\b(?:S\d+|R\d+|C\d-R\d+(?:\.\d+)?|C\d-\d+|gen\d)\b/g) || [])].filter((id) => registry.has(id));
}

// Corre el agente hasta tener un componente que compila (o agotar las correcciones automáticas).
// Eventos: run, attempt, delta, reasoning, notice, tool, search, asset, sound, video, usage, compile_error, result, done | error.
// `tools`: lo que devuelve createLabTools (o null: sin herramientas).
// `config` (Context Lab; sin config se comporta como Motion Design):
//   { system, policy: { search, images, sound, video } (off|optional|required), limits, temperature, reasoning,
//     harness, videoModel, maxToolRounds, frames }
export async function runLabAgent({ input, emit, llm, signal, tools = null, config = {} }) {
  const { model, video, clips, brief, turns, assets } = input;
  const sounds = input.sounds || [];
  const videos = input.videos || [];
  const startedAt = Date.now();
  const available = tools?.available || { search: false, images: false };
  const policy = { ...MOTION_POLICY, ...(config.policy || {}) };
  // Lo que ve el agente: la herramienta existe en el entorno Y la variante no la apagó.
  const enabled = Object.fromEntries(TOOL_KEYS.map((k) => [k, !!available[k] && policy[k] !== 'off']));
  const defs = toolDefs(enabled, { modes: policy, limits: config.limits });
  const harness = config.harness || harnessVersion(available);
  const maxToolRounds = config.maxToolRounds || MAX_TOOL_ROUNDS;
  const totals = { cost: 0, llmCost: 0, toolCost: 0, tokens: 0, promptTokens: 0, completionTokens: 0, calls: 0, searches: 0, images: 0, sounds: 0, videos: 0 };
  const ctx = {
    emit, signal,
    registry: imageRegistry({ brief, clips }),
    sounds: new Map(sounds.map((a) => [a.id, a.url])),
    zones: zonesFor(clips),
    fps: FPS,
    aspect: nearestRatio(video.width, video.height),
    limits: config.limits,
    videoModel: config.videoModel,
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
  const system = config.system || labSystem(available);
  const firstUser = briefContent({ brief, video, clips }, { frames: config.frames });
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: firstUser },
    ...turns.flatMap((t, i) => [
      { role: 'assistant', content: `\`\`\`tsx\n${t.code}\n\`\`\`` },
      // Las imágenes generadas se recuerdan justo antes del último pedido.
      ...(i === turns.length - 1 ? assetNote : []),
      { role: 'user', content: FIX[t.kind](t.message) },
    ]),
  ];
  // Cuánto contexto recibe el agente de entrada (para comparar variantes: tokens ≈ caracteres / 4).
  const briefChars = firstUser.filter((p) => p.type === 'text').reduce((n, p) => n + p.text.length, 0);
  const context = { systemChars: system.length, briefChars, images: firstUser.filter((p) => p.type === 'image_url').length, tools: defs.map((d) => d.function.name) };
  emit({ type: 'run', model, harness, tools: available, policy, enabled, context, zones: zonesFor(clips) });

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
  const designing = (turns.at(-1)?.kind || 'initial') !== 'runtime';
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
    ...(config.reasoning ? { reasoning: { effort: config.reasoning } } : {}),
  };
  for (let k = 0; ; k++) {
    const withTools = defs.length && !toolsOff && toolRounds < maxToolRounds;
    emit({ type: 'attempt', call: k + 1, reason: compileErrors ? 'compile' : toolRounds ? 'tools' : turns.at(-1)?.kind || 'initial' });
    let chars = 0;
    const ask = (useTools, toolChoice) => llm({
      step: 'lab', model, messages, signal, meta: { lab: true, model, turn: turns.length + k }, ...sampling,
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
      nudge('Escribió el componente sin buscar referencias: le pido que busque primero.', searchFirst());
      continue;
    }

    if (mustGenerate && canNudge && !nudgedImage && ctx.state.generated === 0) {
      nudgedImage = true;
      nudge('Escribió el componente sin generar ninguna imagen propia: le pido que genere al menos una y la use.', generateFirst());
      continue;
    }

    if (mustVideo && canNudge && !nudgedVideo && ctx.state.videos === 0) {
      nudgedVideo = true;
      nudge('Escribió el componente sin generar la toma de video obligatoria: se la pido.', videoFirst());
      continue;
    }

    if (mustSound && canNudge && !nudgedSound && ctx.state.sounds === 0) {
      nudgedSound = true;
      nudge('Escribió el componente sin generar ningún sonido: le pido al menos uno.', soundFirst());
      continue;
    }

    let message;
    try {
      const code = extractCode(res.text);
      // Si hay imágenes generadas y el código no las usa, se le marca una vez (no es un error de compilación).
      const genIds = [...ctx.registry.keys()].filter((id) => /^gen\d$/.test(id));
      if (genIds.length && !nudgedUse && !usesImages(code) && toolRounds < maxToolRounds + 1) {
        nudgedUse = true;
        emit({ type: 'notice', text: `No usa ${genIds.join(' ni ')} en la animación: le pido que las integre.` });
        messages.push(
          { role: 'assistant', content: res.text },
          { role: 'user', content: useImages(genIds) },
        );
        continue;
      }
      const sfxIds = [...ctx.sounds.keys()];
      if (sfxIds.length && !nudgedSoundUse && !usesSounds(code) && toolRounds < maxToolRounds + 1) {
        nudgedSoundUse = true;
        emit({ type: 'notice', text: `No usa ${sfxIds.join(' ni ')} en la animación: le pido que los ponga.` });
        messages.push(
          { role: 'assistant', content: res.text },
          { role: 'user', content: useSounds(sfxIds) },
        );
        continue;
      }
      const { js } = await compileMotionLayer(code);
      // Las notas son lo que el modelo escribió antes del bloque de código.
      const cut = res.text.search(/```[a-z]*[ \t]*\r?\n[\s\S]*?export\s+default/i);
      const notes = (cut > 0 ? res.text.slice(0, cut) : '').trim().slice(0, 1500);
      emit({ type: 'result', code, js, notes, usedRefs: usedReferences(notes, ctx.registry), ...paletteAndObjects(notes) });
      emit({
        type: 'done', ...totals, ms: Date.now() - startedAt, compileErrors, toolRounds, toolsOff, harness,
        searchRequired: mustSearch, nudged, imageRequired: mustGenerate, nudgedImage, nudgedUse,
        soundRequired: mustSound, nudgedSound, nudgedSoundUse, videoRequired: mustVideo, nudgedVideo,
      });
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
