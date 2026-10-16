// Laboratorio · herramientas de los agentes (las mismas, con los mismos límites, para los dos modelos).
// - buscar_referencias: Google Images vía SerpAPI (https://serpapi.com/google-images-api). Solo para mirar: no se usan en la animación.
// - generar_imagen: Nano Banana 2.1 por WaveSpeed (text-to-image o edit), a partir de un prompt
//   y, si quiere, de imágenes que el agente ya vio (cuadros, referencias, búsquedas). Lo generado queda disponible
//   para el componente en la prop `images` (images.gen1, images.gen2).
// - generar_sonido (solo Context Lab): un efecto de sonido (SFX) por WaveSpeed text→audio, para la prop `sounds` (sounds.sfx1…).
// - generar_video (solo Context Lab): una toma image→video (Seedance / Wan por WaveSpeed) a partir de un cuadro de una zona.
//   No entra en el componente: el entorno la pone en una CAPA PROPIA entre el video original y la animación,
//   y el humano la puede ocultar, mover o escalar aparte.
// Cada imagen que ve el agente tiene un id: C1-1 (cuadro 1 de la zona C1), C1-R1 (referencia de la zona), R1 (referencia general),
// S1… (resultado de búsqueda), gen1… (generada).
// Los límites salen de ctx.limits (Context Lab los elige por variante); si no vienen, valen los de Motion Design.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createWaveSpeed, mediaDataUrl, VIDEO_MODELS, DEFAULT_VIDEO_MODEL, videoSeconds } from '../wavespeed.js';
import { getEngine } from '../engines/index.js';

export const MAX_GENERATED_IMAGES = 2; // por lado y por experimento (contando revisiones)
export const MAX_SEARCHES = 3; // por ejecución
export const MAX_SOUNDS = 3; // por variante y por experimento (contando revisiones)
export const MAX_VIDEOS = 1; // por variante y por experimento (contando revisiones)
export const DEFAULT_LIMITS = { searches: MAX_SEARCHES, images: MAX_GENERATED_IMAGES, sounds: MAX_SOUNDS, videos: MAX_VIDEOS };
// Topes duros (lo máximo que se puede elegir en una variante).
export const LIMIT_CAPS = { searches: 6, images: 4, sounds: 6, videos: 3 };
const SFX_SECONDS = [1, 10];
const SEARCH_RESULTS = 6;
const IMAGE_INPUTS = 6;
const ASPECTS = ['1:1', '3:2', '2:3', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];

// Costos orientativos en US$ (se suman al costo de la ejecución). Ajustables por entorno según tu plan.
export const TOOL_COSTS = {
  search: Number(process.env.LAB_SEARCH_COST ?? 0.015),
  image: Number(process.env.LAB_IMAGE_COST ?? 0.04), // Nano Banana 2.1, 1k, sin búsquedas
  imageReference: Number(process.env.LAB_IMAGE_REFERENCE_COST ?? 0.002),
  sound: Number(process.env.LAB_SFX_COST ?? 0.035), // por efecto (orientativo: depende del modelo de WaveSpeed)
  videoSecond: Number(process.env.LAB_VIDEO_COST_PER_SECOND ?? 0.06), // por segundo generado a 480p (orientativo)
};
export const IMAGE_MODEL = process.env.LAB_IMAGE_MODEL || 'google/nano-banana-2.1/text-to-image';
export const IMAGE_EDIT_MODEL = process.env.LAB_IMAGE_EDIT_MODEL || 'google/nano-banana-2.1/edit';
// Efectos de sonido: text→audio en WaveSpeed. El cuerpo es { prompt, duration } (Kling Text-to-Audio);
// si cambiás de modelo y usa otros nombres, ajustá sfxBody.
export const SFX_MODEL = process.env.LAB_SFX_MODEL || 'kwaivgi/kling-text-to-audio';
const sfxBody = ({ prompt, duration }) => ({ prompt, duration });
export const videoResolution = () => process.env.LAB_VIDEO_RESOLUTION || '480p';

const limitsOf = (ctx) => ({ ...DEFAULT_LIMITS, ...(ctx?.limits || {}) });

// Shared by the tool definition and both labs' system prompts, for either engine.
export const SEARCH_GUIDANCE = 'Explore freely for useful visual inspiration, including connections beyond the literal subject. Keep each Google Images query natural, simple, and focused on one visual need. Avoid overly specific queries or bundling unrelated subjects into one query. If results are poor, simplify the query or change direction instead of appending more keywords. Use attached references and useful results you already have; search again only to resolve a concrete visual need that remains.';

// enabled: qué herramientas ve el agente. opts.modes: 'optional' | 'required' por herramienta (por defecto, obligatorias:
// así funciona Motion Design). opts.limits: máximos de esta ejecución. opts.words: cómo nombra el motor imágenes y sonidos.
export function toolDefs({ search, images, sound, video }, { modes = {}, limits = {}, words = getEngine().words } = {}) {
  const lim = { ...DEFAULT_LIMITS, ...limits };
  const must = (k) => (modes[k] || 'required') === 'required';
  const defs = [];
  if (search) {
    defs.push({
      type: 'function',
      function: {
        name: 'buscar_referencias',
        description: `Search Google Images for visual references and inspiration. ${SEARCH_GUIDANCE} Returns up to ${SEARCH_RESULTS} thumbnails to INSPECT, with IDs S1, S2… Derive a color PALETTE in hex and any reference OBJECTS or motifs. Do not use these images inside the animation. ${must('search') ? 'You must use it at least once before writing the component.' : 'Optional: use it when helpful.'} Maximum ${lim.searches} searches per execution.`,
        parameters: {
          type: 'object',
          properties: { consulta: { type: 'string', description: 'A natural, simple query for one visual need, preferably in English for design styles. Examples: "modular typography" or "Pixar desk lamp". Do not combine the whole brief into one query.' } },
          required: ['consulta'],
        },
      },
    });
  }
  if (images) {
    defs.push({
      type: 'function',
      function: {
        name: 'generar_imagen',
        description: `Generate ONE image with Nano Banana 2.1 (WaveSpeed) to use INSIDE the animation as images.gen1 / images.gen2: an illustration, object, character, product cutout, texture, sticker, or graphic background. Use a prompt alone or provide up to ${IMAGE_INPUTS} previously seen images by ID as style or content references.${must('images') ? '' : ' Optional.'} Maximum ${lim.images} images across the entire work.`,
        parameters: {
          type: 'object',
          properties: {
            prompt: { type: 'string', description: 'Describe the image with concrete art direction (style, palette, lighting, framing). For an add-on, request an asset suited to compositing, such as a solid-color background for a cutout. For fullscreen, design the image as part of the complete scene.' },
            imagenes: { type: 'array', items: { type: 'string' }, maxItems: IMAGE_INPUTS, description: 'Reference image IDs, e.g. ["C1-2", "S3"]. Optional.' },
            proporcion: { type: 'string', enum: ASPECTS, description: 'Image aspect ratio.' },
          },
          required: ['prompt'],
        },
      },
    });
  }
  if (sound) {
    defs.push({
      type: 'function',
      function: {
        name: 'generar_sonido',
        description: `Generate ONE short sound effect (SFX) from a description: whoosh, pop, click, impact, riser, text swoosh, chime, ambience… It is available in sounds as sounds.sfx1, sounds.sfx2… Place it with ${words.soundTool}. It is mixed over the video's original audio. You cannot listen to it, so describe it precisely.${must('sound') ? '' : ' Optional.'} Maximum ${lim.sounds} effects across the entire work.`,
        parameters: {
          type: 'object',
          properties: {
            descripcion: { type: 'string', description: 'Describe the sound precisely in English. Examples: "short soft whoosh, airy, no reverb", "cartoon pop, high pitch, dry".' },
            duracion: { type: 'number', minimum: SFX_SECONDS[0], maximum: SFX_SECONDS[1], description: 'Duration in seconds.' },
          },
          required: ['descripcion'],
        },
      },
    });
  }
  if (video) {
    defs.push({
      type: 'function',
      function: {
        name: 'generar_video',
        description: `Generate ONE AI video shot (image-to-video) from a video frame or another image you have seen, plus a prompt. Do NOT put it in your component: the environment displays it in a SEPARATE LAYER between the original video and your animation during the requested zone. The user can hide, move, or scale it. Design the animation to work with the shot. It takes several minutes and is the most expensive tool; use it when a new shot adds real value.${must('video') ? '' : ' Optional.'} Maximum ${lim.videos} shots across the entire work.`,
        parameters: {
          type: 'object',
          properties: {
            zona: { type: 'string', description: 'Target zone ID, e.g. "C1". The shot lasts for that zone.' },
            imagen: { type: 'string', description: 'Starting image ID, e.g. "C1-3". If omitted, a frame from the middle of the zone is used.' },
            prompt: { type: 'string', description: 'Describe the shot in English: subject, action, camera, lighting, pacing, and what must remain unchanged.' },
          },
          required: ['zona', 'prompt'],
        },
      },
    });
  }
  return defs;
}

const AUDIO_TYPES = { mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac' };
async function audioDataUrl(mediaDir, file) {
  const ext = path.extname(file).slice(1).toLowerCase();
  return `data:${AUDIO_TYPES[ext] || 'audio/mpeg'};base64,${(await readFile(path.join(mediaDir, file))).toString('base64')}`;
}

// Demo: un "whoosh" sintético (barrido de seno con envolvente), WAV PCM 16 bits mono, determinista.
export function demoSfx(seconds = 1) {
  const rate = 22050;
  const n = Math.round(rate * Math.min(3, Math.max(0.3, seconds)));
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / n;
    phase += (2 * Math.PI * (300 + 900 * t)) / rate;
    const env = Math.sin(Math.PI * t) ** 2;
    buf.writeInt16LE(Math.round(Math.sin(phase) * env * 0.35 * 32767), 44 + i * 2);
  }
  return `data:audio/wav;base64,${buf.toString('base64')}`;
}

const toDataUrl = (buf, type) => `data:${type};base64,${Buffer.from(buf).toString('base64')}`;

// Ejecuta las herramientas de UNA ejecución. `registry`: id → data URL de cada imagen que vio el agente.
// wavespeedKey: generación de imágenes; serpKey: búsqueda de referencias.
export function createLabTools({ serpKey, wavespeedKey, mediaDir, mock = false, fetchImpl = fetch, pollMs = 3000 }) {
  // sound y video solo se ofrecen si la ejecución los pide (Context Lab): Motion Design no los usa.
  const available = { search: !!serpKey || mock, images: !!wavespeedKey || mock, sound: !!wavespeedKey || mock, video: !!wavespeedKey || mock };
  const ws = !mock && wavespeedKey ? createWaveSpeed({ apiKey: wavespeedKey, mediaDir, fetchImpl, pollMs }) : null;

  async function search({ consulta }, ctx) {
    ctx.signal?.throwIfAborted();
    const q = String(consulta || '').trim().slice(0, 200);
    const max = limitsOf(ctx).searches;
    if (!q) return { text: 'Error: falta la consulta.' };
    if (ctx.state.searches >= max) return { text: `Error: ya hiciste ${max} búsquedas en esta ejecución. Escribí el componente con lo que tenés.` };
    ctx.state.searches += 1;
    ctx.state.toolCost += TOOL_COSTS.search;
    let results;
    if (mock) {
      // Demo: los "resultados" son cuadros del propio video.
      results = [...ctx.registry.entries()].filter(([id]) => /^C\d-\d$/.test(id)).slice(0, 3)
        .map(([, url], i) => ({ title: `(demo) resultado ${i + 1} para "${q}"`, source: 'demo', link: '', url }));
    } else {
      const params = new URLSearchParams({ engine: 'google_images', q, api_key: serpKey, hl: 'es', safe: 'active' });
      const timeout = AbortSignal.timeout(20000);
      const signal = AbortSignal.any([ctx.signal, timeout].filter(Boolean));
      let res, data;
      try {
        res = await fetchImpl(`https://serpapi.com/search.json?${params}`, { signal });
        data = await res.json().catch((err) => {
          if (signal.aborted || err.name === 'TimeoutError') throw err;
          return {};
        });
        ctx.signal?.throwIfAborted();
      } catch (err) {
        // A local deadline is a tool result; cancelling the run must still stop it.
        if (ctx.signal?.aborted || (!timeout.aborted && err.name !== 'TimeoutError')) throw err;
        const remaining = Math.max(0, max - ctx.state.searches);
        return { text: `Error de la búsqueda: se agotó el tiempo de espera de 20 s para "${q}". Búsquedas restantes: ${remaining}. ${remaining ? 'Podés reintentar o cambiar la consulta si todavía necesitás una referencia concreta, o continuar con las referencias disponibles.' : 'Continuá con las referencias disponibles; no quedan búsquedas.'}` };
      }
      if (!res.ok || data.error) return { text: `Error de la búsqueda: ${data.error || res.status}` };
      const picks = (data.images_results || []).filter((r) => r.thumbnail).slice(0, SEARCH_RESULTS);
      // Las miniaturas se bajan acá: el modelo las recibe como data URL (no todos los proveedores bajan URLs externas).
      results = (await Promise.all(picks.map(async (r) => {
        try {
          const img = await fetchImpl(r.thumbnail, { signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(10000)].filter(Boolean)) });
          const type = img.headers.get('content-type') || '';
          if (!img.ok || !type.startsWith('image/')) return null;
          return { title: String(r.title || '').slice(0, 120), source: String(r.source || '').slice(0, 80), link: String(r.link || ''), url: toDataUrl(await img.arrayBuffer(), type.split(';')[0]) };
        } catch (err) { if (ctx.signal?.aborted) throw err; return null; }
      }))).filter(Boolean);
    }
    ctx.signal?.throwIfAborted();
    if (!results.length) return { text: `La búsqueda "${q}" no devolvió imágenes.` };
    const listed = results.map((r) => {
      const id = `S${++ctx.state.searchSeq}`;
      ctx.registry.set(id, r.url);
      return { id, ...r };
    });
    ctx.emit({ type: 'search', query: q, results: listed.map(({ id, title, source, link, url }) => ({ id, title, source, link, thumb: url })) });
    return {
      text: `Búsqueda "${q}": ${listed.length} imágenes (${listed.map((r) => r.id).join(', ')}). Te las muestro a continuación. Miralas con dos preguntas: ¿qué colores dominantes y de acento tienen (para tu paleta en hex)? y ¿qué objetos o motivos aparecen que puedas llevar a la animación?`,
      parts: listed.flatMap((r) => [{ type: 'text', text: `${r.id} — ${r.title}${r.source ? ` (${r.source})` : ''}` }, { type: 'image_url', image_url: { url: r.url } }]),
    };
  }

  async function generate({ prompt, imagenes, proporcion }, ctx) {
    const text = String(prompt || '').trim().slice(0, 3000);
    const max = limitsOf(ctx).images;
    if (!text) return { text: 'Error: falta el prompt.' };
    if (ctx.state.generated >= max) return { text: `Error: ya se generaron ${max} imágenes (el máximo). Usá las que hay o resolvelo con código.` };
    const ids = (Array.isArray(imagenes) ? imagenes : imagenes ? [imagenes] : []).map(String).slice(0, IMAGE_INPUTS);
    const unknown = ids.filter((id) => !ctx.registry.has(id));
    if (unknown.length) return { text: `Error: no existen estas imágenes: ${unknown.join(', ')}. Ids disponibles: ${[...ctx.registry.keys()].join(', ')}.` };
    const aspect = ASPECTS.includes(proporcion) ? proporcion : ASPECTS.includes(ctx.aspect) ? ctx.aspect : '1:1';
    let url;
    let cost = TOOL_COSTS.image + ids.length * TOOL_COSTS.imageReference;
    try {
      if (mock) {
        // Demo: la "imagen generada" es la primera de entrada (o un cuadro del video).
        url = ids.length ? ctx.registry.get(ids[0]) : [...ctx.registry.values()][0];
        cost = 0.039;
      } else {
        const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(180000)].filter(Boolean));
        const images = [];
        for (const id of ids) images.push(await ws.upload(ctx.registry.get(id), signal));
        const result = await ws.image({
          model: images.length ? IMAGE_EDIT_MODEL : IMAGE_MODEL,
          body: {
            prompt: text, resolution: '1k', aspect_ratio: aspect, output_format: 'png',
            enable_web_search: false, enable_image_search: false,
            ...(images.length ? { images } : {}),
          },
          signal, timeoutMs: 180000,
        });
        // El iframe no permite URLs externas: el agente y Remotion reciben la imagen como data URL.
        url = await mediaDataUrl(mediaDir, result.file);
      }
    } catch (err) {
      return { text: `Error al generar la imagen: ${err.message.slice(0, 300)}` };
    }
    // Solo se cobra (y cuenta para el máximo) la imagen que llegó.
    ctx.state.generated += 1;
    ctx.state.toolCost += cost;
    const id = `gen${ctx.state.generated}`;
    ctx.registry.set(id, url);
    ctx.emit({ type: 'asset', id, url, prompt: text, inputs: ids });
    return {
      text: `Listo: ${id}. Usala en el componente con ${(ctx.words || getEngine().words).imageReady(id)}: animala, integrala con el video y con la tipografía.`,
      parts: [{ type: 'text', text: `${id} (generada)` }, { type: 'image_url', image_url: { url } }],
    };
  }

  async function sound({ descripcion, duracion }, ctx) {
    const text = String(descripcion || '').trim().slice(0, 600);
    const max = limitsOf(ctx).sounds;
    ctx.state.sounds ??= 0;
    ctx.sounds ??= new Map();
    if (!text) return { text: 'Error: falta la descripción del sonido.' };
    if (ctx.state.sounds >= max) return { text: `Error: ya se generaron ${max} sonidos (el máximo). Usá los que hay.` };
    const duration = Math.round(Math.min(SFX_SECONDS[1], Math.max(SFX_SECONDS[0], Number(duracion) || 2)));
    let url;
    try {
      if (mock) url = demoSfx(duration);
      else {
        const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(120000)].filter(Boolean));
        const result = await ws.audio({ model: SFX_MODEL, body: sfxBody({ prompt: text, duration }), signal, timeoutMs: 120000 });
        // El iframe no permite URLs externas: el sonido viaja como data URL (la página lo pasa como Blob).
        url = await audioDataUrl(mediaDir, result.file);
      }
    } catch (err) {
      return { text: `Error al generar el sonido: ${err.message.slice(0, 300)}` };
    }
    ctx.state.sounds += 1;
    ctx.state.toolCost += mock ? 0.02 : TOOL_COSTS.sound;
    const id = `sfx${ctx.state.sounds}`;
    ctx.sounds.set(id, url);
    ctx.emit({ type: 'sound', id, url, prompt: text, duration });
    return { text: `Listo: ${id} (${duration} s, "${text}"). Usalo con ${(ctx.words || getEngine().words).soundReady(id)}. Ajustá volume para que no tape la voz del video.` };
  }

  async function video({ zona, imagen, prompt }, ctx) {
    const text = String(prompt || '').trim().slice(0, 3000);
    const max = limitsOf(ctx).videos;
    ctx.state.videos ??= 0;
    if (!text) return { text: 'Error: falta el prompt.' };
    if (ctx.state.videos >= max) return { text: `Error: ya se generaron ${max} tomas (el máximo).` };
    const zone = (ctx.zones || []).find((z) => z.id === String(zona || '').trim().toUpperCase());
    if (!zone) return { text: `Error: no existe la zona "${zona}". Zonas: ${(ctx.zones || []).map((z) => z.id).join(', ')}.` };
    const frames = [...ctx.registry.keys()].filter((id) => id.startsWith(`${zone.id}-`) && /^C\d+-\d+$/.test(id));
    const imageId = imagen ? String(imagen) : frames[Math.floor(frames.length / 2)];
    if (!imageId || !ctx.registry.has(imageId)) return { text: `Error: no existe la imagen "${imagen}". Ids disponibles: ${[...ctx.registry.keys()].join(', ')}.` };
    const fps = ctx.fps || 30;
    const zoneSeconds = zone.durationInFrames / fps;
    const modelKey = VIDEO_MODELS[ctx.videoModel] ? ctx.videoModel : DEFAULT_VIDEO_MODEL;
    const model = VIDEO_MODELS[modelKey];
    const seconds = videoSeconds(modelKey, zoneSeconds);
    let layer;
    try {
      if (mock) {
        // Demo: no se genera video; la "toma" es el cuadro elegido, quieto (alcanza para probar la capa).
        layer = { kind: 'image', url: ctx.registry.get(imageId) };
      } else {
        ctx.emit({ type: 'notice', text: `Generando la toma con ${model.label} (${seconds} s, ${videoResolution()}): tarda unos minutos…` });
        const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(16 * 60 * 1000)].filter(Boolean));
        const image = await ws.upload(ctx.registry.get(imageId), signal);
        const aspect = ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'].includes(ctx.aspect) ? ctx.aspect : '16:9';
        const result = await ws.video({ model: model.path(), body: model.body({ prompt: text, image, duration: seconds, aspect, resolution: videoResolution() }), signal });
        layer = { kind: 'video', url: `/media/${result.file}` };
      }
    } catch (err) {
      return { text: `Error al generar el video: ${err.message.slice(0, 300)}` };
    }
    ctx.state.videos += 1;
    ctx.state.toolCost += mock ? 0.05 : TOOL_COSTS.videoSecond * seconds;
    const id = `vid${ctx.state.videos}`;
    ctx.emit({ type: 'video', id, ...layer, zone: zone.id, from: zone.from, durationInFrames: zone.durationInFrames, prompt: text, source: imageId, model: model.label, seconds });
    return { text: `Listo: ${id}. El entorno lo muestra en su propia capa, debajo de tu animación y encima del video original, en ${zone.id} (cuadros ${zone.from} → ${zone.from + zone.durationInFrames}), partiendo de ${imageId}. No lo renderices vos: diseñá tu capa para que conviva con esa toma.` };
  }

  // Ejecuta una herramienta y avisa al navegador: `tool` al empezar (con su id de llamada) y `tool_done` al terminar, con si salió bien,
  // el costo de esta llamada y cuánto tardó. Entre los dos llegan los resultados (search, asset, sound, video).
  async function run(call, ctx) {
    const name = call.function?.name;
    const id = call.id || '';
    let args;
    try { args = JSON.parse(call.function.arguments || '{}'); } catch {
      ctx.emit({ type: 'tool', id, name, args: {} });
      const out = { text: 'Error: los argumentos no son JSON válido.' };
      ctx.emit({ type: 'tool_done', id, name, ok: false, error: out.text, cost: 0, ms: 0 });
      return out;
    }
    ctx.emit({ type: 'tool', id, name, args });
    const t0 = Date.now();
    const cost0 = ctx.state?.toolCost || 0;
    let out;
    try {
      if (name === 'buscar_referencias' && available.search) out = await search(args, ctx);
      else if (name === 'generar_imagen' && available.images) out = await generate(args, ctx);
      else if (name === 'generar_sonido' && available.sound) out = await sound(args, ctx);
      else if (name === 'generar_video' && available.video) out = await video(args, ctx);
      else out = { text: `Error: la herramienta ${name} no existe en este entorno.` };
    } catch (err) {
      out = { text: `Error: ${err.message}` };
      ctx.emit({ type: 'tool_done', id, name, ok: false, error: out.text.slice(0, 300), cost: 0, ms: Date.now() - t0 });
      throw err;
    }
    const failed = /^Error/.test(out.text);
    ctx.emit({ type: 'tool_done', id, name, ok: !failed, ...(failed ? { error: out.text.slice(0, 300) } : {}), cost: Math.max(0, (ctx.state?.toolCost || 0) - cost0), ms: Date.now() - t0 });
    return out;
  }

  return { available, run };
}
