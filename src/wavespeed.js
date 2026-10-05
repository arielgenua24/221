import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';

// Cliente de WaveSpeed (https://wavespeed.ai): generación de imágenes (storyboard) y de video (image→video).
// Flujo de su API v3: POST /api/v3/<modelo> devuelve un id → GET /api/v3/predictions/<id>/result hasta "completed".
// Las imágenes de entrada se suben primero (/api/v3/media/upload/binary) y se pasan por URL.

const base = () => (process.env.WAVESPEED_BASE_URL || 'https://api.wavespeed.ai').replace(/\/+$/, '');

// Modelos de video (image→video). El cuerpo de cada uno sigue su documentación en WaveSpeed;
// la ruta se puede cambiar por variable de entorno si WaveSpeed publica otra versión.
export const VIDEO_MODELS = {
  seedance: {
    label: 'Seedance 2.0',
    path: () => process.env.SEEDANCE_MODEL || 'bytedance/seedance-2.0/image-to-video',
    minSeconds: 4,
    maxSeconds: 15,
    body: ({ prompt, image, duration, aspect, resolution }) => ({ prompt, image, duration, aspect_ratio: aspect, resolution }),
  },
  wan: {
    label: 'Wan 3.0 Prime',
    path: () => process.env.WAN_MODEL || 'alibaba/wan-3.0-prime/image-to-video',
    minSeconds: 2,
    maxSeconds: 30,
    // Otras herramientas conservan el audio de su video original; Historia pide sonido nuevo por toma.
    body: ({ prompt, image, duration, aspect, resolution, seed, generateAudio = false }) => ({ prompt, image, duration, aspect_ratio: aspect, resolution, generate_audio: generateAudio, ...(seed !== undefined ? { seed } : {}) }),
  },
};
export const DEFAULT_VIDEO_MODEL = VIDEO_MODELS[process.env.VIDEO_MODEL] ? process.env.VIDEO_MODEL : 'seedance';

// Re-filmado de "Cinematic Pro": modelos con referencias (el humano elige en la tarjeta de aprobación).
// El storyboard aprobado y cuadros del clip van como imágenes de referencia y, si la cámara no cambia, el clip real como video
// de referencia; el modelo genera la toma de nuevo guiado por ellos y por el prompt. Sin audio: suena el original.
// tag: cómo se nombran las referencias en el prompt ("Image 1" en Wan, "@Image 1" en Seedance).
// cost: estimación en US$ a 480p (WaveSpeed cobra por segundo; es orientativa).
const ceilSeconds = (clip, min, max) => Math.min(max, Math.max(min, Math.ceil(clip - 0.01)));
export const REFILM_MODELS = {
  // Video de referencia MP4/MOV de 1 a 15 s; salida de 2 a 30 s.
  wan: {
    label: 'Wan 3.0 Prime',
    path: () => process.env.CINE_REFILM_MODEL || 'alibaba/wan-3.0-prime/reference-to-video',
    tag: '',
    seconds: (clipSeconds) => ceilSeconds(clipSeconds, 2, 15),
    cost: ({ seconds }) => 0.075 * seconds,
    body: ({ prompt, video, images = [], duration, aspect, resolution }) => ({
      prompt, ...(video ? { reference_videos: [video] } : {}), ...(images.length ? { reference_images: images } : {}),
      duration, aspect_ratio: aspect, resolution, generate_audio: false, enable_prompt_expansion: false,
    }),
  },
  // Seedance 2.5 con referencias (su "text-to-video" acepta imágenes y videos): salida de 4 a 30 s;
  // con video de referencia cobra entrada + salida.
  seedance: {
    label: 'Seedance 2.5',
    path: () => process.env.CINE_SEEDANCE_MODEL || 'bytedance/seedance-2.5/text-to-video',
    tag: '@',
    seconds: (clipSeconds) => ceilSeconds(clipSeconds, 4, 15),
    cost: ({ seconds, video, clipSeconds }) => (video ? 0.11 * (Math.max(2, clipSeconds) + seconds) : 0.18 * seconds),
    body: ({ prompt, video, images = [], duration, aspect, resolution }) => ({
      prompt, ...(video ? { reference_videos: [video] } : {}), ...(images.length ? { reference_images: images } : {}),
      duration, aspect_ratio: aspect, resolution, generate_audio: false,
    }),
  },
};
export const DEFAULT_REFILM_MODEL = REFILM_MODELS[process.env.CINE_REFILM_DEFAULT] ? process.env.CINE_REFILM_DEFAULT : 'wan';
export const refilmResolution = () => process.env.CINE_REFILM_RESOLUTION || '480p';

// Duración que se le pide al modelo: entera, dentro de su rango, y nunca más corta que el clip.
export function videoSeconds(model, clipSeconds) {
  const m = VIDEO_MODELS[model] || VIDEO_MODELS[DEFAULT_VIDEO_MODEL];
  return Math.min(m.maxSeconds, Math.max(m.minSeconds, Math.ceil(clipSeconds - 0.01)));
}

// La proporción soportada más cercana a la del video.
const RATIOS = [['9:16', 9 / 16], ['3:4', 3 / 4], ['1:1', 1], ['4:3', 4 / 3], ['16:9', 16 / 9]];
export function nearestRatio(width, height) {
  const r = width / height;
  return RATIOS.reduce((best, cur) => (Math.abs(Math.log(cur[1] / r)) < Math.abs(Math.log(best[1] / r)) ? cur : best))[0];
}

// Grilla del storyboard (6 viñetas) según la proporción del video, y la proporción de la hoja.
export function storyboardLayout(width, height) {
  const r = width / height;
  if (r < 0.9) return { cols: 3, rows: 2, aspect: '3:4', panels: 6 };
  if (r > 1.1) return { cols: 2, rows: 3, aspect: '4:3', panels: 6 };
  return { cols: 3, rows: 2, aspect: '3:2', panels: 6 };
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(new Error('cancelado'));
  const onAbort = () => { clearTimeout(timer); reject(new Error('cancelado')); };
  const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
  signal?.addEventListener('abort', onAbort, { once: true });
});

function dataUrlToBlob(dataUrl) {
  const m = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(dataUrl || '');
  if (!m) throw new Error('archivo inválido (se esperaba un data URL)');
  const bytes = m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]));
  return { blob: new Blob([bytes], { type: m[1] }), ext: (m[1].split('/')[1] || 'bin').replace('jpeg', 'jpg') };
}

async function errorDetail(res) {
  const body = await res.text().catch(() => '');
  try {
    const j = JSON.parse(body);
    return String(j.message || j.error || j.data?.error || body).slice(0, 300);
  } catch {
    return body.slice(0, 300);
  }
}

// "fetch failed" no dice nada: la causa real (DNS, conexión rechazada, corte, timeout) viene en err.cause.
// Si la conexión ni se abrió, el pedido no llegó a WaveSpeed: se puede reintentar sin riesgo de pagar dos veces.
const NEVER_SENT = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'UND_ERR_CONNECT_TIMEOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN']);
function networkError(what, err) {
  const c = err?.cause;
  const why = [c?.code, c?.message].filter(Boolean).join(': ') || err?.message || 'error de red';
  const e = new Error(`${what}: no pude conectar con WaveSpeed (${why}).`);
  e.code = c?.code;
  e.network = true;
  return e;
}

// mediaDir: carpeta donde se guardan los resultados (se sirven en /media/…): así el navegador
// los puede dibujar en un canvas y exportar (un video de otro dominio "ensucia" el canvas).
export function createWaveSpeed({ apiKey, mediaDir, fetchImpl = fetch, pollMs = 3000 }) {
  const auth = { Authorization: `Bearer ${apiKey}` };

  // fetch con errores de red legibles y reintentos (solo los que se piden: subir y bajar no cobran).
  async function call(what, url, init, { retries = 0, retryIf = () => true } = {}) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fetchImpl(url, init);
      } catch (err) {
        if (init?.signal?.aborted) throw err;
        if (attempt < retries && retryIf(err?.cause?.code)) { await sleep(800 * 2 ** attempt, init?.signal); continue; }
        throw networkError(what, err);
      }
    }
  }

  async function upload(dataUrl, signal) {
    if (/^https?:\/\//.test(dataUrl)) return dataUrl;
    const { blob, ext } = dataUrlToBlob(dataUrl);
    const form = new FormData();
    form.append('file', blob, `${blob.type.startsWith('video/') ? 'clip' : 'cuadro'}.${ext}`);
    const kind = blob.type.startsWith('video/') ? 'el video' : 'la imagen';
    const res = await call(`Subiendo ${kind} (${(blob.size / 1024 / 1024).toFixed(1)} MB)`, `${base()}/api/v3/media/upload/binary`, { method: 'POST', headers: auth, body: form, signal }, { retries: 3 });
    if (!res.ok) throw new Error(`WaveSpeed no aceptó el archivo (${res.status}): ${await errorDetail(res)}`);
    const url = (await res.json())?.data?.download_url;
    if (!url) throw new Error('WaveSpeed no devolvió la URL del archivo subido.');
    return url;
  }

  // El envío se reintenta SOLO si la conexión ni se abrió: si se corta después, la tarea pudo haberse aceptado (y cobrado).
  async function submit(model, body, signal) {
    const res = await call(`Enviando la tarea a ${model}`, `${base()}/api/v3/${model}`, {
      method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal,
    }, { retries: 2, retryIf: (code) => NEVER_SENT.has(code) });
    if (!res.ok) throw new Error(`WaveSpeed ${res.status} (${model}): ${await errorDetail(res)}`);
    const data = (await res.json())?.data;
    if (!data?.id) throw new Error(`WaveSpeed (${model}) no devolvió el id de la tarea.`);
    return { id: data.id, getUrl: data.urls?.get || `${base()}/api/v3/predictions/${data.id}/result` };
  }

  // Consulta hasta que termina. Las consultas sí se reintentan (no cobran).
  async function wait({ id, getUrl }, { signal, timeoutMs, onStatus }) {
    const started = Date.now();
    let fails = 0;
    for (;;) {
      if (Date.now() - started > timeoutMs) throw new Error(`WaveSpeed tardó más de ${Math.round(timeoutMs / 60000)} min (tarea ${id}).`);
      await sleep(pollMs, signal);
      let data;
      try {
        const res = await fetchImpl(getUrl, { headers: auth, signal });
        if (!res.ok) throw new Error(`${res.status}: ${await errorDetail(res)}`);
        data = (await res.json())?.data;
        fails = 0;
      } catch (err) {
        if (signal?.aborted) throw err;
        if (++fails > 5) throw new Error(`No pude consultar la tarea ${id} en WaveSpeed: ${err.message}${err.cause?.code ? ` (${err.cause.code})` : ''}`);
        continue;
      }
      const status = String(data?.status || '').toLowerCase();
      onStatus?.({ status, elapsed: (Date.now() - started) / 1000 });
      if (status === 'completed') {
        const out = (data.outputs || []).find((o) => typeof o === 'string');
        if (!out) throw new Error(`La tarea ${id} terminó sin resultado.`);
        return out;
      }
      if (['failed', 'cancelled', 'canceled', 'timeout'].includes(status)) {
        const e = new Error(`WaveSpeed: la tarea ${id} terminó en "${status}"${data.error ? `: ${String(data.error).slice(0, 300)}` : ''}.`);
        e.final = true; // la tarea murió: no se puede retomar
        throw e;
      }
    }
  }

  // Baja el resultado a mediaDir y devuelve su nombre de archivo (se sirve en /media/<archivo>).
  async function save(url, fallbackExt, signal) {
    const res = await call('Bajando el resultado', url, { signal }, { retries: 3 });
    if (!res.ok) throw new Error(`No pude bajar el resultado de WaveSpeed (${res.status}).`);
    const type = res.headers.get('content-type') || '';
    const fromUrl = /\.(mp4|webm|mov|png|jpe?g|webp|mp3|wav|ogg|m4a)(?:\?|$)/i.exec(url)?.[1]?.toLowerCase();
    const ext = fromUrl || (type.includes('mp4') ? 'mp4' : type.includes('png') ? 'png' : type.includes('webp') ? 'webp' : type.includes('jpeg') ? 'jpg'
      : type.includes('mpeg') ? 'mp3' : type.includes('wav') ? 'wav' : type.includes('ogg') ? 'ogg' : fallbackExt);
    const file = `${randomUUID()}.${ext}`;
    await mkdir(mediaDir, { recursive: true });
    await writeFile(path.join(mediaDir, file), Buffer.from(await res.arrayBuffer()));
    return file;
  }

  return {
    upload,
    async image({ model, body, signal, timeoutMs = 5 * 60 * 1000, onStatus }) {
      const task = await submit(model, body, signal);
      const url = await wait(task, { signal, timeoutMs, onStatus });
      const file = await save(url, 'png', signal);
      return { task: task.id, remote: url, file };
    },
    async video({ model, body, signal, timeoutMs = 15 * 60 * 1000, onStatus }) {
      const task = await submit(model, body, signal);
      onStatus?.({ status: 'created', elapsed: 0, task: task.id });
      try {
        const url = await wait(task, { signal, timeoutMs, onStatus });
        const file = await save(url, 'mp4', signal);
        return { task: task.id, remote: url, file };
      } catch (err) {
        if (!err.final) err.task = task.id; // la tarea ya se aceptó (y cobró): un reintento la retoma con collect, sin volver a pagar
        throw err;
      }
    },
    // Retoma una tarea de video ya enviada (ej. después de reiniciar el servidor): no se vuelve a cobrar.
    async collect({ task, signal, timeoutMs = 15 * 60 * 1000, onStatus }) {
      const url = await wait({ id: task, getUrl: `${base()}/api/v3/predictions/${task}/result` }, { signal, timeoutMs, onStatus });
      const file = await save(url, 'mp4', signal);
      return { task, remote: url, file };
    },
    // Voz (text-to-speech). Tarda segundos, no minutos.
    async audio({ model, body, signal, timeoutMs = 90 * 1000, onStatus }) {
      const task = await submit(model, body, signal);
      const url = await wait(task, { signal, timeoutMs, onStatus });
      const file = await save(url, 'mp3', signal);
      return { task: task.id, remote: url, file };
    },
  };
}

// Modo demo: no llama a nadie. El "storyboard" es el cuadro elegido y no hay video (se ve el original).
export function createMockWaveSpeed({ mediaDir }) {
  return {
    mock: true,
    upload: async (dataUrl) => dataUrl,
    async image({ body }) {
      const src = body.images?.[0];
      if (!src?.startsWith('data:')) return { task: 'demo', remote: null, file: null };
      const { blob, ext } = dataUrlToBlob(src);
      const file = `${randomUUID()}.${ext}`;
      await mkdir(mediaDir, { recursive: true });
      await writeFile(path.join(mediaDir, file), Buffer.from(await blob.arrayBuffer()));
      return { task: 'demo', remote: null, file };
    },
    async video() { return { task: 'demo', remote: null, file: null }; },
    async collect() { return { task: 'demo', remote: null, file: null }; },
    // Sin voz generada: el navegador lee el texto con su propia voz.
    async audio() { return { task: 'demo', remote: null, file: null }; },
  };
}

// Un archivo guardado, como data URL (para mostrárselo a un modelo por OpenRouter).
export async function mediaDataUrl(mediaDir, file) {
  const ext = path.extname(file).slice(1).toLowerCase();
  const type = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }[ext] || 'application/octet-stream';
  return `data:${type};base64,${(await readFile(path.join(mediaDir, file))).toString('base64')}`;
}
