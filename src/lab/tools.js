// Laboratorio · herramientas de los agentes (las mismas, con los mismos límites, para los dos modelos).
// - buscar_referencias: Google Images vía SerpAPI (https://serpapi.com/google-images-api). Solo para mirar: no se usan en la animación.
// - generar_imagen: google/gemini-nano-banana-2.1 por la Image API de OpenRouter (POST /api/v1/images), a partir de un prompt
//   y, si quiere, de imágenes que el agente ya vio (cuadros, referencias, búsquedas). Lo generado queda disponible
//   para el componente en la prop `images` (images.gen1, images.gen2).
// Cada imagen que ve el agente tiene un id: C1-1 (cuadro 1 de la zona C1), C1-R1 (referencia de la zona), R1 (referencia general),
// S1… (resultado de búsqueda), gen1… (generada).
export const MAX_GENERATED_IMAGES = 2; // por lado y por experimento (contando revisiones)
export const MAX_SEARCHES = 3; // por ejecución
const SEARCH_RESULTS = 6;
const IMAGE_INPUTS = 6;
const ASPECTS = ['1:1', '3:2', '2:3', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];

// Costos orientativos en US$ (se suman al costo de la ejecución). Ajustables por entorno según tu plan.
export const TOOL_COSTS = {
  search: Number(process.env.LAB_SEARCH_COST ?? 0.015),
  image: Number(process.env.LAB_IMAGE_COST ?? 0.04), // solo si OpenRouter no informa el costo real
};
export const IMAGE_MODEL = process.env.LAB_IMAGE_MODEL || 'google/gemini-nano-banana-2.1';
const imagesEndpoint = () => `${process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1'}/images`;

export function toolDefs({ search, images }) {
  const defs = [];
  if (search) {
    defs.push({
      type: 'function',
      function: {
        name: 'buscar_referencias',
        description: `Busca imágenes de referencia en Google Images (estilos de motion, tipografías, gráficos, layouts, lo que hace el rubro del video). Devuelve hasta ${SEARCH_RESULTS} miniaturas para MIRAR, con ids S1, S2… De ellas sacás dos cosas: una PALETA de colores (hex) y los OBJETOS o motivos de referencia que haya. No se pueden usar dentro de la animación. Es obligatorio usarla al menos una vez antes de escribir el componente. Máximo ${MAX_SEARCHES} búsquedas por ejecución.`,
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
        description: `Genera UNA imagen con nano-banana (Gemini) para usarla DENTRO de la animación como images.gen1 / images.gen2. Es la pieza que le da fuerza creativa a la animación: una ilustración, un objeto o personaje, un recorte del producto, una textura, un sticker, un fondo gráfico para un título. Podés partir solo del prompt o darle de 0 a ${IMAGE_INPUTS} imágenes que ya viste (por id) como referencia de estilo o de contenido. Máximo ${MAX_GENERATED_IMAGES} imágenes en todo el trabajo.`,
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
  return defs;
}

const toDataUrl = (buf, type) => `data:${type};base64,${Buffer.from(buf).toString('base64')}`;

// Ejecuta las herramientas de UNA ejecución. `registry`: id → data URL de cada imagen que vio el agente.
// openrouterKey: la misma clave de OpenRouter que usan los modelos (la generación de imágenes también va por OpenRouter).
export function createLabTools({ serpKey, openrouterKey, mock = false, fetchImpl = fetch }) {
  const available = { search: !!serpKey || mock, images: !!openrouterKey || mock };

  async function search({ consulta }, ctx) {
    const q = String(consulta || '').trim().slice(0, 200);
    if (!q) return { text: 'Error: falta la consulta.' };
    if (ctx.state.searches >= MAX_SEARCHES) return { text: `Error: ya hiciste ${MAX_SEARCHES} búsquedas en esta ejecución. Escribí el componente con lo que tenés.` };
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
    if (!text) return { text: 'Error: falta el prompt.' };
    if (ctx.state.generated >= MAX_GENERATED_IMAGES) return { text: `Error: ya se generaron ${MAX_GENERATED_IMAGES} imágenes (el máximo). Usá las que hay o resolvelo con código.` };
    const ids = (Array.isArray(imagenes) ? imagenes : imagenes ? [imagenes] : []).map(String).slice(0, IMAGE_INPUTS);
    const unknown = ids.filter((id) => !ctx.registry.has(id));
    if (unknown.length) return { text: `Error: no existen estas imágenes: ${unknown.join(', ')}. Ids disponibles: ${[...ctx.registry.keys()].join(', ')}.` };
    const aspect = ASPECTS.includes(proporcion) ? proporcion : ctx.aspect;
    let url;
    let cost = TOOL_COSTS.image;
    try {
      if (mock) {
        // Demo: la "imagen generada" es la primera de entrada (o un cuadro del video).
        url = ids.length ? ctx.registry.get(ids[0]) : [...ctx.registry.values()][0];
        cost = 0.039;
      } else {
        const res = await fetchImpl(imagesEndpoint(), {
          method: 'POST',
          headers: { Authorization: `Bearer ${openrouterKey}`, 'Content-Type': 'application/json', 'HTTP-Referer': process.env.APP_URL || 'http://localhost', 'X-Title': '221 Content Harness' },
          body: JSON.stringify({
            model: IMAGE_MODEL, prompt: text, n: 1, resolution: '1K', aspect_ratio: aspect,
            ...(ids.length ? { input_references: ids.map((id) => ({ type: 'image_url', image_url: { url: ctx.registry.get(id) } })) } : {}),
          }),
          signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(180000)].filter(Boolean)),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) return { text: `Error al generar la imagen (${res.status}): ${String(data.error?.message || data.error || '').slice(0, 300)}` };
        const img = data.data?.[0];
        if (!img?.b64_json) return { text: 'Error: el generador no devolvió imagen.' };
        url = `data:${img.media_type || 'image/png'};base64,${img.b64_json}`;
        if (Number.isFinite(data.usage?.cost)) cost = data.usage.cost;
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

  async function run(call, ctx) {
    let args;
    try { args = JSON.parse(call.function.arguments || '{}'); } catch { return { text: 'Error: los argumentos no son JSON válido.' }; }
    const name = call.function.name;
    ctx.emit({ type: 'tool', name, args });
    if (name === 'buscar_referencias' && available.search) return search(args, ctx);
    if (name === 'generar_imagen' && available.images) return generate(args, ctx);
    return { text: `Error: la herramienta ${name} no existe en este entorno.` };
  }

  return { available, run };
}
