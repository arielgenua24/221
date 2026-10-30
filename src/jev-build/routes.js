import { decide, mockDecide, JEV_MODEL } from '../objects3d/jev.js';
import { parseStep, parseIdeas, parseBlueprint, parseRelBlueprint, parsePatch, describeScene, LIMITS, FAST } from '../../public/jev-build/spec.js';
import { parseLooks } from '../../public/jev-build/look.js';
import { SYSTEM, turnMessage, choiceQuestion, verifyQuestion, LETTERS, IDEAS_SYSTEM, ideasMessage, BLUEPRINT_SYSTEM, blueprintMessage, pickQuestion, MANY_LETTERS, REL_BLUEPRINT_SYSTEM, FIX_SYSTEM, fixMessage, IMAGE_LABELS, SKETCH_HINT, sketchVerifyQuestion, LOOK_SYSTEM, lookMessage, lookPickQuestion } from './prompts.js';
import { mockPlan, mockIdeas, mockBlueprint, mockRelBlueprint, mockFix, mockLooks } from './mock.js';

// Laboratorio · JEV construye. El bucle lo maneja el navegador, que dibuja la escena y las vistas previas:
//   GET  /api/lab/jev-build/config
//   POST /api/lab/jev-build/plan   { prompt, scene, history, render? } → { step, verify?, usage, ms }
//        El LLM (DeepSeek por OpenRouter) piensa la próxima pieza y sus preguntas. Si llega `render`, antes JEV
//        mira la escena y dice si ya se reconoce lo pedido; eso entra en el mensaje del LLM.
//   POST /api/lab/jev-build/choose { prompt, object, part, sceneText, chosen, question, options, images? }
//        → { choice, index, confidence, probabilities }. JEV elige una opción (mirando la imagen de cada una).
// Fase 2 · time reducing (ver spec.js):
//   POST /api/lab/jev-build/ideas     { prompt, scene } → { ideas, ms }           LLM corto: objetos + conceptos en palabras
//   POST /api/lab/jev-build/blueprint { prompt, scene, object, concept } → { blueprint, ms }  LLM: plano entero de un objeto
//   POST /api/lab/jev-build/pick      { prompt, sceneText, picks: [{ key, context, question, options, images? }], render? }
//        → { answers: { key: { index, choice, confidence, probabilities } }, verify?, calls, ms }
//        Varias elecciones de JEV en una sola llamada (se parten si superan ${MAX_IMAGES_PER_CALL} imágenes).
//        Una elección con topic: 'light' es de iluminación (JEV juzga luz y clima, no construcción).
// Luces (pestaña Luces):
//   POST /api/lab/jev-build/looks { prompt, scene, subject, current, render?, see? } → { looks, ms }
//        El LLM propone de 2 a 4 looks (look.js); el navegador los dibuja y JEV elige con /pick (topic: 'light').
export const LLM_MODEL = process.env.JEV_BUILD_MODEL || 'deepseek/deepseek-v4.1-flash-1017';
const MAX_BODY = 16 * 1024 * 1024;
const IMAGE = /^data:image\/(png|jpeg);base64,/;
const MAX_HISTORY = 30;
export const MAX_IMAGES_PER_CALL = 40;
const MAX_PICKS = 40;
// En el modo rápido el LLM no razona (las ideas y el plano son escritura directa) y OpenRouter elige el proveedor
// que más tokens por segundo escribe: el mismo plano tardó 5 s en uno y 29 s en otro.
const FAST_LLM = { temperature: 0.3, reasoning: { enabled: false }, provider: { sort: 'throughput' } };
// Algunos modelos no dejan apagar el razonamiento ("Reasoning is mandatory for this endpoint"). Con esos se reintenta
// con el razonamiento al mínimo y más tope de salida (el razonamiento también gasta tokens), y se recuerda el modelo.
const MUST_REASON = /reasoning is mandatory|cannot be disabled|reasoning.*required/i;
const LOW_REASONING = { effort: 'low' };
const REASONING_EXTRA_TOKENS = 4000;
export const mustReason = new Set();
// Respaldo contra la cola lenta: a veces un proveedor se traba (un plano de 2 s tardó 40 s). Si una llamada pasa
// HEDGE_MS sin responder, sale una copia en paralelo; gana la primera y la otra se cancela.
export const HEDGE_MS = Number(process.env.JEV_BUILD_HEDGE_MS || 8000);

export function hedged(run, { signal, delayMs = HEDGE_MS } = {}) {
  return new Promise((resolve, reject) => {
    const controllers = [];
    let pending = 0, done = false;
    const finish = (fn, v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      controllers.forEach((c) => c.abort());
      signal?.removeEventListener('abort', onAbort);
      fn(v);
    };
    const onAbort = () => finish(reject, Object.assign(new Error('cancelado'), { name: 'AbortError' }));
    const launch = (hedge) => {
      const c = new AbortController();
      controllers.push(c);
      pending++;
      run(c.signal).then((v) => finish(resolve, { ...v, hedged: hedge }), (err) => { if (--pending === 0) finish(reject, err); });
    };
    const timer = delayMs > 0 ? setTimeout(() => { if (!done && pending) launch(true); }, delayMs) : null;
    signal?.addEventListener('abort', onAbort, { once: true });
    launch(false);
  });
}

const fail = (message) => Object.assign(new Error(message), { status: 400 });
const str = (v, max, name) => {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s) throw fail(`Falta ${name}.`);
  return s.slice(0, max);
};

// El texto del LLM → objeto JSON (tolera bloques ```json y texto alrededor).
export function extractJson(text) {
  const t = String(text || '').replace(/```(?:json)?/gi, '');
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a < 0 || b <= a) throw fail('No devolviste un objeto JSON.');
  try { return JSON.parse(t.slice(a, b + 1)); } catch (err) { throw fail(`JSON inválido (${err.message}).`); }
}

// Modelo de OpenRouter elegido en la pantalla ("proveedor/modelo", opcionalmente con ":variante"); vacío = el de siempre.
const MODEL_ID = /^[a-z0-9][\w.-]*\/[\w.:-]+$/i;
export function parseModel(v) {
  const m = typeof v === 'string' ? v.trim() : '';
  if (!m) return LLM_MODEL;
  if (m.length > 120 || !MODEL_ID.test(m)) throw fail(`"${m.slice(0, 120)}" no parece un modelo de OpenRouter (por ejemplo deepseek/deepseek-v4.1-flash-1017).`);
  return m;
}

// ¿El modelo acepta imágenes? Se lee de la lista pública de modelos de OpenRouter (input_modalities), una vez por hora.
// Si no se puede leer, se asume que no: se manda solo texto y nada se rompe.
const MODELS_TTL = 60 * 60 * 1000;
export function createModalities(fetchImpl = fetch) {
  let cache = null, at = 0;
  return async (model) => {
    if (!cache || Date.now() - at > MODELS_TTL) {
      try {
        const res = await fetchImpl(`${process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1'}/models`);
        const data = (await res.json()).data || [];
        cache = new Map(data.map((m) => [m.id, m.architecture?.input_modalities || []]));
        at = Date.now();
      } catch {
        return false;
      }
    }
    return (cache.get(model) || []).includes('image');
  };
}

// Mensaje de usuario con imágenes adjuntas (formato de OpenAI que OpenRouter traduce a cada proveedor). Al final del
// texto va qué es cada imagen, en orden: el boceto del usuario y/o la foto de la escena.
function attach(text, images) {
  if (!images.length) return text;
  const legend = `\n\nIMÁGENES ADJUNTAS (en orden):\n${images.map((img, i) => `${i + 1}. ${IMAGE_LABELS[img.kind]}`).join('\n')}`;
  return [{ type: 'text', text: text + legend }, ...images.map((img) => ({ type: 'image_url', image_url: { url: img.url } }))];
}

// El boceto (dibujo del usuario) viaja como data URL PNG o JPEG; sin texto, el pedido es el dibujo.
const SKETCH_PROMPT = 'Lo que dibujé en el boceto.';
export function parseSketch(body = {}) {
  const sketch = typeof body.sketch === 'string' && IMAGE.test(body.sketch) ? body.sketch : null;
  const prompt = typeof body.prompt === 'string' && body.prompt.trim() ? body.prompt.trim().slice(0, 600) : sketch ? SKETCH_PROMPT : str(body.prompt, 600, 'el pedido');
  return { sketch, prompt };
}
const parseIssues = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, 20).map((x) => x.slice(0, 300)) : []);

export function parsePlanBody(body = {}) {
  const { prompt, sketch } = parseSketch(body);
  const model = parseModel(body.model);
  const scene = body.scene && typeof body.scene === 'object' ? body.scene : { objects: {}, parts: [] };
  const history = (Array.isArray(body.history) ? body.history : []).slice(-MAX_HISTORY);
  const render = typeof body.render === 'string' && IMAGE.test(body.render) ? body.render : null;
  return { prompt, sketch, scene, history, render, model, see: body.see === true, issues: parseIssues(body.issues) };
}

export function parseChooseBody(body = {}) {
  const options = Array.isArray(body.options) ? body.options.map((o) => String(o ?? '').trim().slice(0, LIMITS.label)) : [];
  if (options.length < LIMITS.optionsMin || options.length > LIMITS.optionsMax || options.some((o) => !o)) throw fail(`Hacen falta de ${LIMITS.optionsMin} a ${LIMITS.optionsMax} opciones con texto.`);
  const images = Array.isArray(body.images) ? body.images : [];
  if (images.length && (images.length !== options.length || !images.every((i) => IMAGE.test(String(i))))) throw fail('Las imágenes tienen que ser una por opción, PNG o JPEG.');
  return {
    ...parseSketch(body),
    object: str(body.object, 200, 'el objeto'),
    part: str(body.part, 200, 'la pieza'),
    question: str(body.question, LIMITS.question, 'la pregunta'),
    sceneText: typeof body.sceneText === 'string' ? body.sceneText.slice(0, 8000) : '',
    chosen: (Array.isArray(body.chosen) ? body.chosen : []).slice(0, LIMITS.questions).map((c) => `${String(c?.question ?? '').slice(0, 300)} → ${String(c?.label ?? '').slice(0, LIMITS.label)}`),
    options,
    images,
  };
}

export function parsePickBody(body = {}) {
  const picks = Array.isArray(body.picks) ? body.picks : [];
  if (picks.length > MAX_PICKS) throw fail(`Máximo ${MAX_PICKS} elecciones por pedido.`);
  const keys = new Set();
  const parsed = picks.map((p, i) => {
    const key = String(p?.key ?? '');
    if (!/^[a-z][a-z0-9_]{0,30}$/i.test(key) || keys.has(key)) throw fail(`La elección ${i + 1} necesita una key única (letras, números y _).`);
    keys.add(key);
    const options = Array.isArray(p.options) ? p.options.map((o) => String(o ?? '').trim().slice(0, 300)) : [];
    if (options.length < 1 || options.length > MANY_LETTERS.length || options.some((o) => !o)) throw fail(`La elección "${key}" necesita de 1 a ${MANY_LETTERS.length} opciones con texto.`);
    const images = Array.isArray(p.images) ? p.images : [];
    if (images.length && (images.length !== options.length || !images.every((img) => IMAGE.test(String(img))))) throw fail(`Las imágenes de "${key}" tienen que ser una por opción, PNG o JPEG.`);
    return { key, context: String(p.context ?? '').slice(0, 600), question: str(p.question, LIMITS.question, `la pregunta de "${key}"`), options, images, ...(p.topic === 'light' ? { topic: 'light' } : {}) };
  });
  const render = typeof body.render === 'string' && IMAGE.test(body.render) ? body.render : null;
  if (!parsed.length && !render) throw fail('No hay nada que preguntarle a JEV.');
  return { ...parseSketch(body), sceneText: typeof body.sceneText === 'string' ? body.sceneText.slice(0, 8000) : '', picks: parsed, render };
}

// Reparte las elecciones en llamadas de hasta MAX_IMAGES_PER_CALL imágenes (las que tienen una sola opción no se preguntan).
export function groupPicks(picks, reserve = 0) {
  const limit = MAX_IMAGES_PER_CALL - reserve; // reserve: imágenes fijas de cada llamada (el boceto)
  const groups = [];
  let cur = [], n = 0;
  for (const p of picks.filter((x) => x.options.length > 1)) {
    if (cur.length && n + p.images.length > limit) { groups.push(cur); cur = []; n = 0; }
    cur.push(p);
    n += p.images.length;
  }
  if (cur.length) groups.push(cur);
  return groups;
}

// Arreglos del revisor: cada uno apunta a una pieza que existe; los parches son absolutos (parsePatch).
export function parseFixes(raw, scene) {
  if (!raw || typeof raw !== 'object') throw fail('La respuesta tiene que ser un objeto JSON.');
  const note = typeof raw.note === 'string' ? raw.note.slice(0, 300) : '';
  if (raw.ok === true && !raw.fixes?.length) return { ok: true, fixes: [], note };
  const list = Array.isArray(raw.fixes) ? raw.fixes : [];
  if (list.length > 12) throw fail('Máximo 12 arreglos.');
  const exists = new Set((scene.parts || []).map((p) => `${p.object}/${p.id}`));
  const fixes = list.map((f, i) => {
    const key = `${f?.object}/${f?.part}`;
    if (!exists.has(key)) throw fail(`El arreglo ${i + 1} apunta a "${key}", que no existe en la escena.`);
    if (f.remove === true) return { object: f.object, part: f.part, remove: true };
    const patch = parsePatch(f.patch ?? {});
    if (!Object.keys(patch).length) throw fail(`El arreglo ${i + 1} no cambia nada.`);
    return { object: f.object, part: f.part, patch };
  });
  return { ok: !fixes.length, fixes, note };
}

export function createJevBuildRoutes({ mock, apiKey, llm, readBody, sendJson, badRequest, decideImpl, planImpl, ideasImpl, blueprintImpl, fixImpl, looksImpl, modalitiesImpl }) {
  const ask = decideImpl || (mock ? mockDecide : (opts) => decide({ apiKey, ...opts }));
  const available = !!(mock || decideImpl || (apiKey && llm));
  const imageInput = modalitiesImpl || (mock ? async () => true : createModalities());
  // Qué imágenes ve el planificador: el boceto siempre (si hay), y la foto de la escena si se pidió.
  // Si el modelo no acepta imágenes, solo texto; pero con boceto eso no sirve, así que es un error claro.
  async function imagesFor({ see, render, sketch, model }) {
    if (!sketch && !(see && render)) return [];
    const sees = await imageInput(model);
    if (sketch && !sees) throw fail(`El modelo ${model} no acepta imágenes y el boceto es una imagen: elegí uno que vea (por ejemplo ${LLM_MODEL}).`);
    if (!sees) return [];
    return [...(sketch ? [{ kind: 'sketch', url: sketch }] : []), ...(see && render ? [{ kind: 'scene', url: render }] : [])];
  }
  const seesScene = (images) => images.some((i) => i.kind === 'scene');

  // Un turno del LLM, con un reintento si la respuesta no pasa la validación.
  async function planStep({ prompt, scene, history, verify, model, issues, images, signal }) {
    if (planImpl || mock) return { step: parseStep(await (planImpl || mockPlan)({ prompt, scene, history })), usage: null };
    const sceneText = describeScene(scene);
    let error = null, usage = null, raw = '';
    for (let attempt = 0; attempt < 2; attempt++) {
      const out = await llm({
        model,
        temperature: 0.4,
        maxTokens: 4000,
        signal,
        messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: attach(turnMessage({ prompt, sceneText, history, verify, issues, error }), images) }],
      });
      raw = out.text;
      usage = out.usage || usage;
      try {
        return { step: parseStep(extractJson(raw)), usage, raw };
      } catch (err) {
        error = err.message;
      }
    }
    throw Object.assign(new Error(`El planificador no devolvió un paso válido: ${error}`), { status: 502, raw });
  }

  async function plan(req, res) {
    let input;
    try { input = parsePlanBody(await readBody(req, MAX_BODY) || {}); } catch (err) { return badRequest(res, err.message); }
    if (!available) return sendJson(res, 500, { error: 'Faltan OPENROUTER_API_KEY y TYPESAFE_API_KEY en el proyecto.' });
    const controller = new AbortController();
    res.on('close', () => { if (!res.writableFinished) controller.abort(); });
    const t0 = Date.now();
    try {
      let verify = null;
      if (input.render && input.scene.parts?.length) {
        const r = await ask({ model: JEV_MODEL, state: { vista: input.render, ...(input.sketch ? { boceto: input.sketch } : {}) }, questions: { visto: input.sketch ? sketchVerifyQuestion(input.prompt) : verifyQuestion(input.prompt) }, signal: controller.signal });
        verify = { noul: Number(r.answers?.visto?.noul) || 0 };
      }
      const images = await imagesFor(input);
      const { step, usage, raw } = await planStep({ ...input, verify, images, signal: controller.signal });
      return sendJson(res, 200, { step, verify, usage, sees: seesScene(images), sketch: images.some((i) => i.kind === 'sketch'), model: mock ? `${input.model} (demo)` : input.model, ms: Date.now() - t0, ...(raw ? { raw } : {}) });
    } catch (err) {
      if (!controller.signal.aborted) sendJson(res, err.status === 400 ? 400 : 502, { error: err.message, ...(err.raw ? { raw: err.raw } : {}) });
    }
  }

  async function choose(req, res) {
    let input;
    try { input = parseChooseBody(await readBody(req, MAX_BODY) || {}); } catch (err) { return badRequest(res, err.message); }
    if (!available) return sendJson(res, 500, { error: 'Falta TYPESAFE_API_KEY en el proyecto.' });
    const controller = new AbortController();
    res.on('close', () => { if (!res.writableFinished) controller.abort(); });
    const t0 = Date.now();
    const withImages = input.images.length > 0;
    const state = {
      pedido: input.prompt,
      escena: input.sceneText || 'Vacía: solo el suelo.',
      pieza: `${input.part}, de ${input.object}`,
      ...(input.chosen.length ? { elecciones_de_esta_pieza: input.chosen.join('\n') } : {}),
      ...Object.fromEntries(input.images.map((img, i) => [`opcion_${LETTERS[i]}`, img])),
      ...(input.sketch ? { boceto: input.sketch } : {}),
    };
    try {
      const r = await ask({ model: JEV_MODEL, state, questions: { opcion: choiceQuestion({ question: input.question + (input.sketch ? SKETCH_HINT : ''), options: input.options, withImages }) }, signal: controller.signal });
      const a = r.answers?.opcion || {};
      const index = Math.max(0, LETTERS.indexOf(a.choice));
      const probabilities = Object.fromEntries(input.options.map((label, i) => [label, Number(a.probabilities?.[LETTERS[i]]) || 0]));
      return sendJson(res, 200, { index, choice: input.options[index], confidence: Number(a.confidence) || probabilities[input.options[index]] || 0, probabilities, model: r.model, usage: r.usage, ms: Date.now() - t0 });
    } catch (err) {
      if (!controller.signal.aborted) sendJson(res, err.status === 400 ? 400 : 502, { error: err.message });
    }
  }

  // Un pedido al LLM que tiene que devolver JSON válido según `parse`, con un reintento que le muestra el error.
  async function llmJson({ system, message, parse, maxTokens, model, images = [], signal }) {
    let error = null, raw = '', usage = null, hedges = 0;
    for (let attempt = 0; attempt < 2; attempt++) {
      const content = error ? `${message}\n\nTU RESPUESTA ANTERIOR NO SE PUDO USAR: ${error}. Corregila y respondé solo el JSON.` : message;
      const messages = [{ role: 'system', content: system }, { role: 'user', content: attach(content, images) }];
      const call = (sig) => {
        const reason = mustReason.has(model);
        return llm({ model, ...FAST_LLM, ...(reason ? { reasoning: LOW_REASONING } : {}), maxTokens: maxTokens + (reason ? REASONING_EXTRA_TOKENS : 0), signal: sig, messages });
      };
      let out;
      try {
        out = await hedged(call, { signal });
      } catch (err) {
        if (err.status !== 400 || !MUST_REASON.test(err.message) || mustReason.has(model)) throw err;
        mustReason.add(model);
        out = await hedged(call, { signal });
      }
      hedges += out.hedged ? 1 : 0;
      raw = out.text;
      usage = out.usage || usage;
      try { return { value: parse(extractJson(raw)), usage, attempts: attempt + 1, hedges }; } catch (err) { error = err.message; }
    }
    throw Object.assign(new Error(`El planificador no devolvió JSON válido: ${error}`), { status: 502, raw });
  }

  // Envoltorio común: lee el cuerpo, corta si el cliente se va y mide el tiempo.
  function endpoint(parseBody, run) {
    return async (req, res) => {
      let input;
      try { input = parseBody(await readBody(req, MAX_BODY) || {}); } catch (err) { return badRequest(res, err.message); }
      if (!available) return sendJson(res, 500, { error: 'Faltan OPENROUTER_API_KEY y TYPESAFE_API_KEY en el proyecto.' });
      const controller = new AbortController();
      res.on('close', () => { if (!res.writableFinished) controller.abort(); });
      const t0 = Date.now();
      try {
        const out = await run(input, controller.signal);
        return sendJson(res, 200, { ...out, ms: Date.now() - t0 });
      } catch (err) {
        if (!controller.signal.aborted) sendJson(res, err.status === 400 ? 400 : 502, { error: err.message, ...(err.raw ? { raw: err.raw } : {}) });
      }
    };
  }

  const ideas = endpoint(
    (body) => { const { prompt, sketch, scene, model } = parsePlanBody(body); return { prompt, sketch, scene, model }; },
    async ({ prompt, sketch, scene, model }, signal) => {
      const images = await imagesFor({ sketch, model });
      if (ideasImpl || mock) return { ideas: parseIdeas(await (ideasImpl || mockIdeas)({ prompt, scene })) };
      const r = await llmJson({ system: IDEAS_SYSTEM, message: ideasMessage({ prompt, sceneText: describeScene(scene) }), parse: parseIdeas, maxTokens: 800, model, images, signal });
      return { model, ideas: r.value, usage: r.usage, attempts: r.attempts, hedges: r.hedges };
    },
  );

  const blueprint = endpoint(
    (body) => {
      const { prompt, sketch, scene, model } = parsePlanBody(body);
      const o = body.object || {};
      const object = { id: str(o.id, 40, 'object.id'), label: str(o.label, LIMITS.label, 'object.label'), position: Array.isArray(o.position) ? o.position.map(Number).slice(0, 3) : [0, 0, 0] };
      return { prompt, sketch, scene, model, object, concept: str(body.concept, LIMITS.label, 'el concepto'), relations: body.language === 'relations' };
    },
    async ({ prompt, sketch, scene, model, object, concept, relations }, signal) => {
      // Fase 3: el mismo pedido, pero el plano viene en el idioma por relaciones.
      const parse = relations ? parseRelBlueprint : parseBlueprint;
      const images = await imagesFor({ sketch, model });
      if (blueprintImpl || mock) return { blueprint: parse(await (blueprintImpl || (relations ? mockRelBlueprint : mockBlueprint))({ prompt, object, concept })) };
      const r = await llmJson({ system: relations ? REL_BLUEPRINT_SYSTEM : BLUEPRINT_SYSTEM, message: blueprintMessage({ prompt, object, concept, sceneText: describeScene(scene) }), parse, maxTokens: 3000, model, images, signal });
      return { model, blueprint: r.value, usage: r.usage, attempts: r.attempts, hedges: r.hedges };
    },
  );

  const pick = endpoint(parsePickBody, async ({ prompt, sketch, sceneText, picks, render }, signal) => {
    const base = { pedido: prompt, escena: sceneText || 'Vacía: solo el suelo.', ...(sketch ? { boceto: sketch } : {}) };
    const groups = groupPicks(picks, sketch ? 1 : 0);
    const calls = groups.map((group) => {
      const state = { ...base };
      const questions = {};
      for (const p of group) {
        p.images.forEach((img, i) => { state[`${p.key}_${MANY_LETTERS[i]}`] = img; });
        questions[p.key] = (p.topic === 'light' ? lookPickQuestion : pickQuestion)({ ...p, question: p.question + (sketch ? SKETCH_HINT : ''), withImages: p.images.length > 0 });
      }
      return { state, questions };
    });
    if (render) {
      const target = calls[0] || (calls[0] = { state: { ...base }, questions: {} });
      target.state.vista = render;
      target.questions.visto = sketch ? sketchVerifyQuestion(prompt) : verifyQuestion(prompt);
    }
    const results = await Promise.all(calls.map((c) => ask({ model: JEV_MODEL, state: c.state, questions: c.questions, signal })));
    const all = Object.assign({}, ...results.map((r) => r.answers || {}));
    const answers = {};
    for (const p of picks) {
      if (p.options.length === 1) { answers[p.key] = { index: 0, choice: p.options[0], confidence: 1, probabilities: { [p.options[0]]: 1 } }; continue; }
      const a = all[p.key] || {};
      const index = Math.max(0, MANY_LETTERS.indexOf(a.choice));
      const probabilities = Object.fromEntries(p.options.map((label, i) => [label, Number(a.probabilities?.[MANY_LETTERS[i]]) || 0]));
      answers[p.key] = { index, choice: p.options[index], confidence: Number(a.confidence) || probabilities[p.options[index]] || 0, probabilities };
    }
    return { answers, verify: render ? { noul: Number(all.visto?.noul) || 0 } : null, calls: results.length, usage: results.map((r) => r.usage) };
  });

  // Pasada de corrección (Fase 2 y 3): el modelo ve la descripción, la revisión del motor y, si puede, la foto.
  const fix = endpoint(
    (body) => {
      const { prompt, sketch, scene, model, render, see } = parsePlanBody(body);
      return { prompt, sketch, scene, model, render, see, issues: parseIssues(body.issues) };
    },
    async ({ prompt, sketch, scene, model, render, see, issues }, signal) => {
      const images = await imagesFor({ see, render, sketch, model });
      const parse = (raw) => parseFixes(raw, scene);
      if (fixImpl || mock) return { ...parse(await (fixImpl || mockFix)({ prompt, scene, issues })), sees: seesScene(images) };
      const r = await llmJson({ system: FIX_SYSTEM, message: fixMessage({ prompt, sceneText: describeScene(scene), issues }), parse, maxTokens: 2500, model, images, signal });
      return { ...r.value, sees: seesScene(images), usage: r.usage, attempts: r.attempts, hedges: r.hedges };
    },
  );

  // Luces: el LLM propone looks (con la foto del plano si la puede ver); JEV elige después con /pick.
  const looks = endpoint(
    (body) => {
      const { prompt, scene, model, render, see } = parsePlanBody(body);
      const clip = (v, max, fallback) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : fallback);
      return { prompt, scene, model, render, see, subject: clip(body.subject, 300, 'toda la escena'), current: clip(body.current, 3000, 'Luz base del motor.') };
    },
    async ({ prompt, scene, model, render, see, subject, current }, signal) => {
      // La foto es el plano del director con la luz de ahora (no la vista de construcción).
      const images = see && render && (await imageInput(model)) ? [{ kind: 'shot', url: render }] : [];
      const sees = images.length > 0;
      if (looksImpl || mock) return { looks: parseLooks(await (looksImpl || mockLooks)({ prompt, scene, current })), sees };
      const r = await llmJson({ system: LOOK_SYSTEM, message: lookMessage({ prompt, sceneText: describeScene(scene), subject, current }), parse: parseLooks, maxTokens: 2500, model, images, signal });
      return { model, looks: r.value, sees, usage: r.usage, attempts: r.attempts, hedges: r.hedges };
    },
  );

  return (req, res, url) => {
    if (!url.pathname.startsWith('/api/lab/jev-build/')) return false;
    const route = url.pathname.slice('/api/lab/jev-build/'.length);
    if (req.method === 'GET' && route === 'config') {
      sendJson(res, 200, { mock, available, llmModel: LLM_MODEL, jevModel: JEV_MODEL, limits: LIMITS, fast: FAST });
      return true;
    }
    if (req.method === 'POST' && route === 'plan') { plan(req, res); return true; }
    if (req.method === 'POST' && route === 'choose') { choose(req, res); return true; }
    if (req.method === 'POST' && route === 'ideas') { ideas(req, res); return true; }
    if (req.method === 'POST' && route === 'blueprint') { blueprint(req, res); return true; }
    if (req.method === 'POST' && route === 'pick') { pick(req, res); return true; }
    if (req.method === 'POST' && route === 'fix') { fix(req, res); return true; }
    if (req.method === 'POST' && route === 'looks') { looks(req, res); return true; }
    return false;
  };
}
