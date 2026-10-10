import { openrouterBase } from './openrouter-video.js';

const wsBase = () => (process.env.WAVESPEED_BASE_URL || 'https://api.wavespeed.ai').replace(/\/+$/, '');
export function normalizeOpenRouter(m, general = {}) {
  const inputs = general.architecture?.input_modalities || [];
  // OpenRouter no expone un boolean de reference-to-video. Su cookbook pide
  // confirmar esa modalidad en la descripción; aceptar imágenes no basta.
  // HeyGen se confirma en su página oficial: el catálogo recorta su descripción
  // antes de mencionar las referencias (https://openrouter.ai/heygen/heygen-video-1).
  const references = m.id === 'heygen/heygen-video-1' || /reference[- ](?:guided|based|to-video)|set of (?:reference )?images|multimodal reference/i.test(m.description || '');
  return {
    id: m.id, provider: 'openrouter', name: m.name || m.id, description: m.description,
    durations: m.supported_durations || [], resolutions: m.supported_resolutions || [], aspects: m.supported_aspect_ratios || [],
    firstFrame: (m.supported_frame_images || []).includes('first_frame'), references: references && inputs.includes('image'),
    audioReference: references && inputs.includes('audio'), generateAudio: m.generate_audio === true,
    pricing: m.pricing_skus || {},
  };
}
export function normalizeWaveSpeed(m) {
  const schema = m.api_schema?.api_schemas?.find((s) => s.type === 'model_run')?.request_schema;
  const p = schema?.properties || {};
  const durations = p.duration?.enum?.map(Number) || (p.duration?.minimum !== undefined && p.duration?.maximum <= 120
    ? Array.from({ length: p.duration.maximum - p.duration.minimum + 1 }, (_, i) => i + p.duration.minimum) : []);
  return {
    id: m.model_id, provider: 'wavespeed', name: m.name || m.model_id, description: m.description,
    durations, resolutions: p.resolution?.enum || [], aspects: p.aspect_ratio?.enum || [],
    firstFrame: !!p.image, references: !!p.reference_images, maxReferences: p.reference_images?.maxItems,
    audioReference: !!p.reference_audios || !!p.audio, generateAudio: !!p.generate_audio,
    schema, basePrice: m.base_price ?? null,
  };
}
export function demoVideoCatalog() {
  const settings = { durations: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolutions: ['480p', '720p'], aspects: ['16:9', '9:16', '1:1'], firstFrame: true, references: true, audioReference: true, generateAudio: true };
  const schema = { properties: { prompt: {}, duration: {}, resolution: {}, aspect_ratio: {}, reference_images: {}, reference_audios: {}, generate_audio: {} }, required: ['prompt'] };
  return { models: [
    { ...settings, id: 'heygen/heygen-video-1', name: 'HeyGen Video 1 · demo', provider: 'openrouter', durations: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolutions: ['480p', '768p'], generateAudio: false },
    { ...settings, id: 'alibaba/wan-3.0-prime', name: 'Wan 3.0 Prime · demo', provider: 'openrouter', references: false, audioReference: false },
    { ...settings, id: 'bytedance/seedance-2.5/text-to-video', name: 'Seedance 2.5 · demo', provider: 'wavespeed', firstFrame: false, schema },
    { ...settings, id: 'alibaba/wan-3.0-prime/reference-to-video', name: 'Wan 3.0 Prime · demo', provider: 'wavespeed', firstFrame: false, schema },
  ], warnings: ['Catálogo de demostración; no se envían generaciones reales.'] };
}
export function createVideoCatalog({ wavespeedKey, fetchImpl = fetch, mock = false }) {
  let cache;
  return async function catalog() {
    if (mock) return demoVideoCatalog();
    if (cache && Date.now() - cache.at < 3600000) return cache.value;
    const warnings = [];
    const get = async (url, headers) => {
      const r = await fetchImpl(url, { headers, signal: AbortSignal.timeout(12000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return (await r.json()).data;
    };
    const [videos, general, wavespeed] = await Promise.allSettled([
      get(`${openrouterBase()}/videos/models`), get(`${openrouterBase()}/models?output_modalities=video`),
      wavespeedKey ? get(`${wsBase()}/api/v3/models`, { Authorization: `Bearer ${wavespeedKey}` }) : Promise.resolve([]),
    ]);
    const all = general.status === 'fulfilled' ? general.value : [];
    const or = videos.status === 'fulfilled' ? videos.value.filter((m) => m.supported_durations?.length)
      .map((m) => normalizeOpenRouter(m, all.find((g) => g.id === m.id))) : [];
    const ws = wavespeed.status === 'fulfilled' ? wavespeed.value
      .filter((m) => ['text-to-video', 'image-to-video', 'reference-to-video'].includes(m.type)).map(normalizeWaveSpeed) : [];
    if (videos.status === 'rejected') warnings.push('No se pudo cargar el catálogo de video de OpenRouter.');
    if (general.status === 'rejected') warnings.push('No se pudieron verificar todas las modalidades de referencia de OpenRouter.');
    if (wavespeed.status === 'rejected') warnings.push('No se pudo cargar el catálogo de WaveSpeed.');
    if (!wavespeedKey) warnings.push('Falta WAVESPEED_API_KEY para usar WaveSpeed.');
    const value = { models: [...or, ...ws], warnings };
    if (!warnings.some((w) => w.startsWith('No se'))) cache = { at: Date.now(), value };
    return value;
  };
}

export function parseExperiment(body) {
  if (!body || typeof body.prompt !== 'string' || !body.prompt.trim() || body.prompt.length > 20000) throw new Error('Escribí un prompt de hasta 20.000 caracteres.');
  if (!Array.isArray(body.generators) || body.generators.length < 1 || body.generators.length > 4) throw new Error('Elegí entre uno y cuatro generadores.');
  const seen = new Set();
  const generators = body.generators.map((g) => {
    if (!g || !['openrouter', 'wavespeed'].includes(g.provider) || typeof g.model !== 'string' || !/^[\w./:-]+$/.test(g.model)) throw new Error('Generador inválido.');
    const key = `${g.provider}:${g.model}`;
    if (seen.has(key)) throw new Error('No repitas el mismo generador y proveedor.');
    seen.add(key); return { provider: g.provider, model: g.model };
  });
  if (!Number.isInteger(body.duration) || body.duration < 1 || body.duration > 120) throw new Error('La duración debe ser un número entero entre 1 y 120 segundos.');
  if (!['16:9', '9:16', '1:1', '4:3', '3:4', '3:2', '2:3', '21:9', '9:21'].includes(body.aspect)) throw new Error('Proporción inválida.');
  if (typeof body.resolution !== 'string' || !/^(480p|720p|768p|1080p|1K|2K|4K|4k)$/.test(body.resolution)) throw new Error('Resolución inválida.');
  if (!['references', 'first-frame'].includes(body.referenceMode)) throw new Error('Modo de referencias inválido.');
  if (!Array.isArray(body.references) || body.references.length > 10) throw new Error('Usá hasta diez imágenes de referencia.');
  function media(value, kind) {
    if (!value || typeof value.url !== 'string' || (!new RegExp(`^data:${kind}/[\\w.+-]+;base64,[A-Za-z0-9+/=]+$`).test(value.url) && !/^https:\/\/[^\s]+$/.test(value.url))) throw new Error(`Referencia de ${kind} inválida.`);
    return { name: String(value.name || kind).slice(0, 160), url: value.url };
  }
  const references = body.references.map((r) => media(r, 'image'));
  if (body.referenceMode === 'first-frame' && references.length > 1) throw new Error('El primer cuadro usa exactamente una imagen.');
  if (typeof body.generateAudio !== 'boolean') throw new Error('Elegí si se generará sonido.');
  return { prompt: body.prompt.trim(), generators, duration: body.duration, aspect: body.aspect, resolution: body.resolution,
    referenceMode: body.referenceMode, references, audio: body.audio ? media(body.audio, 'audio') : null, generateAudio: body.generateAudio };
}

// Fallar cerrado: nunca recortar referencias ni cambiar el pedido para un modelo.
export function incompatibility(m, input) {
  if (!m) return 'El modelo no está en el catálogo verificado del proveedor.';
  if (!m.durations.includes(input.duration)) return `No admite ${input.duration} s (admite: ${m.durations.join(', ') || 'sin duración verificable'}).`;
  if (!m.resolutions.includes(input.resolution)) return `No admite ${input.resolution}.`;
  if (!m.aspects.includes(input.aspect)) return `No admite ${input.aspect} como proporción explícita.`;
  if (input.references.length) {
    if (input.referenceMode === 'first-frame' && !m.firstFrame) return 'No admite primer cuadro.';
    if (input.referenceMode === 'references' && !m.references) return 'No tiene soporte verificado para imágenes de referencia.';
    if (m.maxReferences && input.references.length > m.maxReferences) return `Admite hasta ${m.maxReferences} referencias; se pidieron ${input.references.length}.`;
  }
  if (input.audio && !m.audioReference) return 'No admite audio de referencia.';
  if (input.generateAudio && !m.generateAudio) return 'No tiene soporte verificado para generar sonido.';
  if (m.provider === 'wavespeed') {
    const supplied = new Set(['prompt', 'duration', 'resolution', 'aspect_ratio', 'generate_audio', 'enable_prompt_expansion']);
    if (input.references.length) supplied.add(input.referenceMode === 'first-frame' ? 'image' : 'reference_images');
    if (input.audio) { supplied.add('reference_audios'); supplied.add('audio'); }
    const missing = (m.schema?.required || []).filter((k) => !supplied.has(k));
    if (missing.length) return `Requiere campos adicionales: ${missing.join(', ')}.`;
    if (m.id.endsWith('/reference-to-video') && !input.references.length && !input.audio) return 'Requiere al menos una referencia.';
  }
  return null;
}
export function videoBody(m, input, { images = input.references.map((r) => r.url), audio = input.audio?.url } = {}) {
  const body = { prompt: input.prompt, duration: input.duration, resolution: input.resolution, aspect_ratio: input.aspect };
  if (m.provider === 'openrouter') {
    body.model = m.id; body.generate_audio = input.generateAudio;
    if (images.length && input.referenceMode === 'first-frame') body.frame_images = [{ type: 'image_url', image_url: { url: images[0] }, frame_type: 'first_frame' }];
    const refs = input.referenceMode === 'references' ? images.map((url) => ({ type: 'image_url', image_url: { url } })) : [];
    if (audio) refs.push({ type: 'audio_url', audio_url: { url: audio } });
    if (refs.length) body.input_references = refs;
  } else {
    const p = m.schema.properties;
    if (p.duration?.type === 'string') body.duration = String(input.duration);
    if (p.generate_audio) body.generate_audio = input.generateAudio;
    if (p.enable_prompt_expansion) body.enable_prompt_expansion = false;
    if (images.length) body[input.referenceMode === 'first-frame' ? 'image' : 'reference_images'] = input.referenceMode === 'first-frame' ? images[0] : images;
    if (audio) { if (p.reference_audios) body.reference_audios = [audio]; else body.audio = audio; }
  }
  return body;
}
