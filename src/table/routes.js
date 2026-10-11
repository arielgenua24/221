import { parseTableRequest, buildTurnMessages, buildSynthesisMessages, buildPartMessages, synthesisFix, imagesToShow, DEFAULT_BUDGET } from './prompts.js';
import { toolDefs, createTurnTools } from './tools.js';
import { sanitizeDelivery, sanitizePart, SHOT_MIN, SHOT_MAX } from './delivery.js';
import { SPECS, ASPECTS, VOICES, LIMITS as MEDIA_LIMITS, MEDIA_URL, mediaCosts, mediaUrlToData, estimate } from './media.js';
import { mockTableLLM } from './mock.js';
import { extractJson, NotesSplitter } from '../agent.js';
import { parseExperiment } from '../cinematic/models.js';

// Laboratorio · Mesa de agentes.
//   POST /api/lab/table/turn  → un turno (kind 'turn', con herramientas), la entrega (kind 'synthesis', JSON por tomas)
//                               o la revisión de una parte con su dueño (kind 'part'). Respuesta NDJSON.
//   POST /api/lab/table/run   → RUN de una parte de imagen, voz o sonido (NDJSON con el resultado).
//   POST /api/lab/table/video → RUN de un video: el humano lo aprueba con este pedido (tarea persistente).
//   GET  /api/lab/table/video?id=… · POST /api/lab/table/video/recover · GET /api/lab/table/config
// El navegador orquesta las rondas y manda el registro completo en cada pedido, así el usuario puede
// intervenir entre dos turnos cualquiera.
const MAX_BODY = 80 * 1024 * 1024;
const MAX_TOOL_ROUNDS = 3; // llamadas con herramientas por turno (después, el agente tiene que hablar)

// Motores de video de la entrega: el humano elige en la tarjeta de aprobación.
export const VIDEO_ENGINES = {
  wan: { provider: 'wavespeed', label: 'Wan 3.0 Prime · WaveSpeed', model: () => process.env.TABLE_WAN_MODEL || 'alibaba/wan-3.0-prime/image-to-video' },
  heygen: { provider: 'openrouter', label: 'HeyGen Video 1 · OpenRouter', model: () => process.env.TABLE_HEYGEN_MODEL || 'heygen/heygen-video-1' },
};

// La duración permitida por el modelo más cercana a la toma, sin pasar de SHOT_MAX.
export function pickDuration(durations, want) {
  const allowed = [...new Set(durations)].filter((d) => d >= 1 && d <= SHOT_MAX).sort((a, b) => a - b);
  if (!allowed.length) return want;
  return allowed.find((d) => d >= want) ?? allowed.at(-1);
}

const minCost = (costs) => Math.min(costs.image, costs.sound, 0.005);

export function createTableRoutes({ mock, llm, readBody, badRequest, sendJson, media = null, mediaDir = null, video = null }) {
  const ask = mock ? mockTableLLM : llm;
  const json = sendJson || ((res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); });
  const toData = (url) => (MEDIA_URL.test(url) ? mediaUrlToData(mediaDir, url) : url);

  // Las imágenes generadas más recientes, para que el modelo las vea (las que no están en disco se omiten).
  async function loadImages(input) {
    const map = new Map();
    if (!mediaDir) return map;
    for (const a of imagesToShow(input)) {
      try { map.set(a.code, await mediaUrlToData(mediaDir, a.url)); } catch { /* el archivo ya no está: se conoce por su prompt */ }
    }
    return map;
  }

  // NDJSON en streaming, con corte si el navegador se va.
  function streamed(res, work) {
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
    const controller = new AbortController();
    res.on('close', () => { if (!res.writableFinished) controller.abort(); });
    const send = (ev) => { if (!res.writableEnded) res.write(`${JSON.stringify(ev)}\n`); };
    const started = Date.now();
    return work(send, controller.signal)
      .then((out) => send({ type: 'done', ...out, ms: Date.now() - started }))
      .catch((err) => { if (!controller.signal.aborted) send({ type: 'error', error: err.message }); })
      .finally(() => res.end());
  }

  const retry = (send) => ({ attempt, retries, waitMs, message }) => send({ type: 'retry', attempt, retries, waitMs, message });
  const addUsage = (total, u) => { if (u) { total.cost += Number(u.cost) || 0; total.total_tokens += Number(u.total_tokens) || 0; } };

  // ---------- Un turno: el agente habla y, si quiere, genera (hasta MAX_TOOL_ROUNDS idas y vueltas) ----------
  async function agentTurn(input, send, signal) {
    const costs = mediaCosts();
    const spent = input.assets.reduce((s, a) => s + a.cost, 0);
    input.toolBudget = Math.max(0, input.budget - spent);
    input.toolsOn = !!media?.available && input.tools && input.toolBudget >= minCost(costs);
    input.assetData = await loadImages(input);
    const messages = buildTurnMessages(input);
    let tools = null;
    const resolve = async (code) => {
      const file = input.files.find((f) => f.code === code && f.kind === 'image');
      if (file) return file.data;
      return (input.assets.find((a) => a.code === code) || tools?.created.find((a) => a.code === code))?.url || null;
    };
    tools = input.toolsOn ? createTurnTools({ media, req: input, resolve, emit: send, signal, costs }) : null;
    const defs = tools ? toolDefs({ aspect: input.aspect, costs }) : null;
    const usage = { cost: 0, total_tokens: 0 };
    const segments = [];
    let toolsOff = false;
    let separate = false; // el texto que sigue a una herramienta va en un párrafo aparte
    for (let k = 0; ; k++) {
      const offer = !!tools && !toolsOff;
      const last = k >= MAX_TOOL_ROUNDS;
      const call = (withTools) => ask({
        model: input.model, messages, signal, meta: { table: 'turn', req: input },
        ...(withTools ? { tools: defs, ...(last ? { toolChoice: 'none' } : {}) } : {}),
        onDelta: (t) => { if (separate) { send({ type: 'delta', text: '\n\n' }); separate = false; } send({ type: 'delta', text: t }); },
        onRetry: retry(send),
      });
      let res;
      try {
        res = await call(offer);
      } catch (err) {
        // El modelo (o su proveedor) no acepta herramientas: el turno sigue sin generar.
        if (!offer || err.streamed || signal.aborted || ![400, 404].includes(Number(err.status)) || !/tool/i.test(err.message)) throw err;
        toolsOff = true;
        send({ type: 'notice', text: `${input.model} no acepta herramientas en OpenRouter: este turno sigue sin generar.` });
        res = await call(false);
      }
      addUsage(usage, res.usage);
      if (res.text?.trim()) segments.push(res.text.trim());
      if (!offer || last || !res.toolCalls?.length) break;
      messages.push({ role: 'assistant', content: res.text || '', tool_calls: res.toolCalls, ...(res.reasoningDetails ? { reasoning_details: res.reasoningDetails } : {}) });
      const shown = [];
      for (const c of res.toolCalls) {
        const out = await tools.run(c);
        messages.push({ role: 'tool', tool_call_id: c.id, content: out.text });
        if (out.image) {
          try { shown.push({ type: 'text', text: `${out.image.code}:` }, { type: 'image_url', image_url: { url: await toData(out.image.url) } }); } catch { /* sin vista previa */ }
        }
      }
      // Las imágenes van en un mensaje aparte: no todos los proveedores aceptan imágenes dentro del resultado de una herramienta.
      if (shown.length) messages.push({ role: 'user', content: [{ type: 'text', text: 'Lo que generaste:' }, ...shown] });
      separate = segments.length > 0;
    }
    return { text: segments.join('\n\n'), usage, assets: tools?.created || [], toolCost: tools?.state.cost || 0, model: input.model, toolsOff };
  }

  // ---------- La entrega: JSON por tomas; si viene rota, una corrección ----------
  async function synthesis(input, send, signal) {
    input.assetData = await loadImages(input);
    const messages = buildSynthesisMessages(input);
    const usage = { cost: 0, total_tokens: 0 };
    const call = (msgs, stream) => ask({ model: input.model, messages: msgs, signal, meta: { table: 'synthesis', req: input }, onRetry: retry(send), ...(stream ? { onDelta: (t) => send({ type: 'delta', text: t }) } : {}) });
    const first = await call(messages, true);
    addUsage(usage, first.usage);
    let text = first.text;
    let delivery = null, error = null;
    try {
      delivery = sanitizeDelivery(extractJson(text), { aspect: input.aspect, assets: input.assets });
    } catch (err) {
      send({ type: 'notice', text: `La entrega vino incompleta (${err.message}): le pido al relator que la corrija.` });
      const fix = await call([...messages, { role: 'assistant', content: text || '(respuesta vacía)' }, { role: 'user', content: synthesisFix(err.message) }], false);
      addUsage(usage, fix.usage);
      text = fix.text;
      try { delivery = sanitizeDelivery(extractJson(text), { aspect: input.aspect, assets: input.assets }); } catch (err2) { error = err2.message; }
    }
    return { text, delivery, error, usage, model: input.model };
  }

  // ---------- Feedback sobre una parte: responde su dueño y, si cambia algo, devuelve la versión nueva ----------
  async function revisePart(input, send, signal) {
    input.assetData = await loadImages(input);
    input.seeData = (await Promise.all(input.part.see.map((u) => mediaUrlToData(mediaDir, u).catch(() => null)))).filter(Boolean);
    const splitter = new NotesSplitter((t) => send({ type: 'delta', text: t }));
    const res = await ask({ model: input.model, messages: buildPartMessages(input), signal, meta: { table: 'part', req: input }, onDelta: (t) => splitter.push(t), onRetry: retry(send) });
    splitter.end();
    const usage = { cost: 0, total_tokens: 0 };
    addUsage(usage, res.usage);
    const fence = res.text.indexOf('```');
    const reply = (fence >= 0 ? res.text.slice(0, fence) : res.text).trim();
    let spec = null;
    if (fence >= 0) {
      try {
        const part = sanitizePart(input.part.kind, { ...extractJson(res.text), dueno: input.part.owner }, { aspect: input.aspect, duration: input.part.duration });
        if (part && JSON.stringify(part.spec) !== JSON.stringify(input.part.spec)) spec = part.spec;
      } catch { /* la respuesta queda, sin versión nueva */ }
    }
    return { reply: reply || (spec ? 'Listo, cambié la parte.' : '(sin respuesta)'), spec, usage, model: input.model };
  }

  async function turn(req, res) {
    let input;
    try { input = parseTableRequest(await readBody(req, MAX_BODY)); } catch (err) { return badRequest(res, err.message); }
    const work = input.kind === 'synthesis' ? synthesis : input.kind === 'part' ? revisePart : agentTurn;
    return streamed(res, (send, signal) => work(input, send, signal));
  }

  // ---------- RUN: imagen, voz o sonido de una parte ----------
  async function run(req, res) {
    let kind, spec, refs;
    try {
      const body = await readBody(req, MAX_BODY);
      kind = ['image', 'voice', 'sound'].includes(body?.kind) ? body.kind : null;
      if (!kind) throw new Error('Tipo de parte inválido.');
      const aspect = ASPECTS.includes(body.aspect) ? body.aspect : '9:16';
      spec = SPECS[kind](body.spec, aspect);
      refs = body.refs && typeof body.refs === 'object' ? body.refs : {};
      for (const code of kind === 'image' ? spec.referencias : []) {
        const v = refs[code];
        if (typeof v !== 'string' || !(MEDIA_URL.test(v) || /^data:image\/[\w.+-]+;base64,/.test(v) || /^https:\/\//.test(v))) throw new Error(`Falta la imagen ${code} (ya no está en la mesa).`);
      }
      if (!media?.available) throw new Error('Para correr partes hace falta WAVESPEED_API_KEY en el .env del servidor.');
    } catch (err) {
      return badRequest(res, err.message);
    }
    return streamed(res, async (send, signal) => {
      const out = await media.generate(kind, spec, { resolve: async (code) => refs[code], signal, onStatus: ({ status }) => send({ type: 'status', status }) });
      return { result: { url: out.url, model: out.model, cost: out.cost, ms: out.ms, ...(out.demo ? { demo: true } : {}) } };
    });
  }

  // ---------- Video: el humano lo aprueba al pedirlo (480p, hasta 6 s, desde el cuadro de la toma) ----------
  async function videoInput(body) {
    const engine = VIDEO_ENGINES[body?.engine] ? body.engine : 'wan';
    const e = VIDEO_ENGINES[engine];
    const { models } = await video.catalog();
    const m = models.find((x) => x.provider === e.provider && x.id === e.model());
    const want = Math.min(SHOT_MAX, Math.max(SHOT_MIN, Math.round(Number(body?.duration) || 5)));
    const image = typeof body?.image === 'string' ? body.image : '';
    if (!MEDIA_URL.test(image) && !/^data:image\//.test(image)) throw new Error('El video arranca del cuadro de la toma: corré primero el cuadro.');
    const audioOk = body?.sync === true && MEDIA_URL.test(body?.audio || '') && m?.audioReference;
    return {
      engine,
      input: parseExperiment({
        prompt: String(body?.prompt || '').trim(), generators: [{ provider: e.provider, model: e.model() }],
        duration: pickDuration(m?.durations || [], want), aspect: ASPECTS.includes(body?.aspect) ? body.aspect : '9:16', resolution: '480p',
        referenceMode: m && !m.firstFrame && m.references ? 'references' : 'first-frame',
        references: [{ name: 'cuadro', url: await toData(image) }],
        audio: audioOk ? { name: 'voz', url: await toData(body.audio) } : undefined,
        generateAudio: false,
      }),
    };
  }

  async function videoAction(req, res, url) {
    try {
      if (!video) throw new Error('El video necesita WAVESPEED_API_KEY (Wan) u OPENROUTER_API_KEY (HeyGen) en el .env del servidor.');
      if (req.method === 'GET') return json(res, 200, await video.jobs.get(url.searchParams.get('id') || ''));
      const body = await readBody(req, MAX_BODY);
      if (url.pathname.endsWith('/recover')) return json(res, 200, await video.jobs.recover(String(body?.id || '')));
      const { engine, input } = await videoInput(body);
      const job = await video.jobs.start(input);
      return json(res, 202, { ...job, engine, estimate: engine === 'wan' ? Math.round(mediaCosts().videoPerSecond * input.duration * 1000) / 1000 : null });
    } catch (err) {
      if (!res.writableEnded) badRequest(res, err.message);
    }
  }

  // ---------- Lo que la pantalla necesita saber (qué hay disponible y cuánto cuesta) ----------
  async function config(res) {
    const costs = mediaCosts();
    let engines = [], warnings = [];
    if (video) {
      try {
        const cat = await video.catalog();
        warnings = cat.warnings || [];
        engines = Object.entries(VIDEO_ENGINES).map(([id, e]) => {
          const m = cat.models.find((x) => x.provider === e.provider && x.id === e.model());
          const ready = video.ready?.[id] !== false;
          return {
            id, label: e.label, model: e.model(), ok: !!m && ready, reason: !ready ? (id === 'wan' ? 'Falta WAVESPEED_API_KEY.' : 'Falta OPENROUTER_API_KEY (y WAVESPEED_API_KEY para subir el cuadro).') : m ? null : 'No está en el catálogo del proveedor.',
            durations: (m?.durations || []).filter((d) => d <= SHOT_MAX), resolutions: m?.resolutions || [], aspects: m?.aspects || [], audioReference: !!m?.audioReference,
            perSecond: id === 'wan' ? costs.videoPerSecond : null,
          };
        });
      } catch (err) { warnings.push(`No se pudo leer el catálogo de video: ${err.message}`); }
    }
    json(res, 200, {
      mock: !!mock, media: !!media?.available, costs, voices: VOICES, aspects: ASPECTS, defaultBudget: DEFAULT_BUDGET,
      limits: { perTurn: MEDIA_LIMITS.perTurn, soundMax: MEDIA_LIMITS.soundMax, shotMin: SHOT_MIN, shotMax: SHOT_MAX, toolRounds: MAX_TOOL_ROUNDS },
      estimates: { image: estimate('image', { referencias: [] }, costs), sound: estimate('sound', {}, costs) },
      video: { available: !!video, engines, warnings },
    });
  }

  return (req, res, url) => {
    const p = url.pathname;
    if (req.method === 'POST' && p === '/api/lab/table/turn') { turn(req, res); return true; }
    if (req.method === 'POST' && p === '/api/lab/table/run') { run(req, res); return true; }
    if ((req.method === 'POST' && ['/api/lab/table/video', '/api/lab/table/video/recover'].includes(p)) || (req.method === 'GET' && p === '/api/lab/table/video')) { videoAction(req, res, url); return true; }
    if (req.method === 'GET' && p === '/api/lab/table/config') { config(res); return true; }
    return false;
  };
}
