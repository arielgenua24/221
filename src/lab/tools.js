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

// enabled: qué herramientas ve el agente. opts.modes: 'optional' | 'required' por herramienta (por defecto, obligatorias:
// así funciona Motion Design). opts.limits: máximos de esta ejecución.
export function toolDefs({ search, images, sound, video }, { modes = {}, limits = {} } = {}) {
  const lim = { ...DEFAULT_LIMITS, ...limits };
  const must = (k) => (modes[k] || 'required') === 'required';
  const defs = [];
  if (search) {
    defs.push({
      type: 'function',
      function: {
        name: 'buscar_referencias',
        description: `Busca imágenes de referencia en Google Images (estilos de motion, tipografías, gráficos, layouts, lo que hace el rubro del video). Devuelve hasta ${SEARCH_RESULTS} miniaturas para MIRAR, con ids S1, S2… De ellas sacás dos cosas: una PALETA de colores (hex) y los OBJETOS o motivos de referencia que haya. No se pueden usar dentro de la animación. ${must('search') ? 'Es obligatorio usarla al menos una vez antes de escribir el componente.' : 'Es opcional: usala si te sirve.'} Máximo ${lim.searches} búsquedas por ejecución.`,
        parameters: {
          type: 'object',
          properties: { consulta: { type: 'string', description: 'Qué buscar, en pocas palabras (mejor en inglés para estilos de diseño). Ej. "kinetic typography lower third editorial"' } },
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
        description: `Genera UNA imagen con Nano Banana 2.1 (WaveSpeed) para usarla DENTRO de la animación como images.gen1 / images.gen2. Es la pieza que le da fuerza creativa a la animación: una ilustración, un objeto o personaje, un recorte del producto, una textura, un sticker, un fondo gráfico para un título. Podés partir solo del prompt o darle de 0 a ${IMAGE_INPUTS} imágenes que ya viste (por id) como referencia de estilo o de contenido.${must('images') ? '' : ' Es opcional.'} Máximo ${lim.images} imágenes en todo el trabajo.`,
        parameters: {
          type: 'object',
          properties: {
            prompt: { type: 'string', description: 'Qué imagen generar, con dirección de arte concreta (estilo, paleta, luz, encuadre). Si va encima del video, pedí un fondo liso de un solo color para recortarlo o integrarlo, o que sea una pieza gráfica pensada para superponerse.' },
            imagenes: { type: 'array', items: { type: 'string' }, maxItems: IMAGE_INPUTS, description: 'Ids de imágenes de referencia (ej. ["C1-2", "S3"]). Opcional.' },
            proporcion: { type: 'string', enum: ASPECTS, description: 'Proporción de la imagen.' },
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
        description: `Genera UN efecto de sonido corto (SFX) a partir de una descripción: whoosh, pop, click, impacto, riser, swoosh de texto, campanita, ambiente… Queda disponible en la prop sounds como sounds.sfx1, sounds.sfx2… y lo ponés con <Audio src={sounds.sfx1} volume={…} /> de "@remotion/media" dentro de una <Sequence> sincronizada con el movimiento que acompaña. Suena mezclado sobre el audio original del video. No lo podés escuchar: describilo bien.${must('sound') ? '' : ' Es opcional.'} Máximo ${lim.sounds} sonidos en todo el trabajo.`,
        parameters: {
          type: 'object',
          properties: {
            descripcion: { type: 'string', description: 'El sonido, concreto y en inglés (los modelos de audio lo entienden mejor). Ej. "short soft whoosh, airy, no reverb", "cartoon pop, high pitch, dry".' },
            duracion: { type: 'number', minimum: SFX_SECONDS[0], maximum: SFX_SECONDS[1], description: 'Duración en segundos.' },
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
        description: `Genera UNA toma de video con IA (image→video) a partir de un cuadro del video (o de otra imagen que viste) y un prompt. NO va dentro de tu componente: el entorno la pone en una CAPA PROPIA entre el video original y tu animación, durante la zona que indiques, y el humano la puede ocultar, mover o escalar. Diseñá tu capa para convivir con ella (títulos o marcos encima, sin taparla). Tarda varios minutos y es la herramienta más cara: usala cuando una toma nueva aporte de verdad.${must('video') ? '' : ' Es opcional.'} Máximo ${lim.videos} en todo el trabajo.`,
        parameters: {
          type: 'object',
          properties: {
            zona: { type: 'string', description: 'Id de la zona donde va la toma (ej. "C1"). Dura lo que dura la zona.' },
            imagen: { type: 'string', description: 'Id de la imagen que es el primer cuadro (ej. "C1-3"). Si no lo das, se usa un cuadro del medio de la zona.' },
            prompt: { type: 'string', description: 'La toma, en inglés: sujeto, acción, cámara, luz, ritmo y qué no puede cambiar.' },
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
      const res = await fetchImpl(`https://serpapi.com/search.json?${params}`, { signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(20000)].filter(Boolean)) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) return { text: `Error de la búsqueda: ${data.error || res.status}` };
      const picks = (data.images_results || []).filter((r) => r.thumbnail).slice(0, SEARCH_RESULTS);
      // Las miniaturas se bajan acá: el modelo las recibe como data URL (no todos los proveedores bajan URLs externas).
      results = (await Promise.all(picks.map(async (r) => {
        try {
          const img = await fetchImpl(r.thumbnail, { signal: AbortSignal.timeout(10000) });
          const type = img.headers.get('content-type') || '';
          if (!img.ok || !type.startsWith('image/')) return null;
          return { title: String(r.title || '').slice(0, 120), source: String(r.source || '').slice(0, 80), link: String(r.link || ''), url: toDataUrl(await img.arrayBuffer(), type.split(';')[0]) };
        } catch { return null; }
      }))).filter(Boolean);
    }
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
      text: `Listo: ${id}. Usala en el componente con <Img src={images.${id}} /> de "remotion" (la prop images ya la trae): animala, integrala con el video y con la tipografía.`,
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
    return { text: `Listo: ${id} (${duration} s, "${text}"). Usalo con <Audio src={sounds.${id}} /> de "@remotion/media" dentro de la <Sequence> del momento que acompaña (la prop sounds ya lo trae). Ajustá volume para que no tape la voz del video.` };
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

  async function run(call, ctx) {
    let args;
    try { args = JSON.parse(call.function.arguments || '{}'); } catch { return { text: 'Error: los argumentos no son JSON válido.' }; }
    const name = call.function.name;
    ctx.emit({ type: 'tool', name, args });
    if (name === 'buscar_referencias' && available.search) return search(args, ctx);
    if (name === 'generar_imagen' && available.images) return generate(args, ctx);
    if (name === 'generar_sonido' && available.sound) return sound(args, ctx);
    if (name === 'generar_video' && available.video) return video(args, ctx);
    return { text: `Error: la herramienta ${name} no existe en este entorno.` };
  }

  return { available, run };
}
