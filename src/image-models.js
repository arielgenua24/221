export const IMAGE_GENERATORS = [
  { id: 'gpt-image', label: 'GPT Image 2.5' },
  { id: 'seedream', label: 'Seedream 5 Pro' },
];

export function parseImageGenerator(value) {
  if (value === undefined || value === null) return 'gpt-image';
  if (!IMAGE_GENERATORS.some((m) => m.id === value)) throw new Error('Generador de imágenes inválido.');
  return value;
}

// Same WaveSpeed client; each model receives its own documented parameters.
export function imageRequest({ generator, model, prompt, images = [], aspect, quality }) {
  const body = { prompt, ...(images.length ? { images } : {}), aspect_ratio: aspect, output_format: 'jpeg' };
  if (parseImageGenerator(generator) === 'seedream') {
    const resolution = process.env.SEEDREAM_RESOLUTION || '1k';
    if (!['1k', '1.5k', '2k'].includes(resolution)) throw new Error('SEEDREAM_RESOLUTION debe ser 1k, 1.5k o 2k.');
    return { model: `bytedance/seedream-v5.0-pro${images.length ? '/edit' : ''}`, body: { ...body, resolution } };
  }
  return { model, body: { ...body, quality } };
}
