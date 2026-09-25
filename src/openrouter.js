const endpoint = () => `${process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1'}/chat/completions`;

// Errores que suelen arreglarse solos: cupo momentáneo del proveedor, cortes de red, 5xx.
const TRANSIENT = new Set([408, 409, 429, 500, 502, 503, 504]);

// "Retry-After" puede venir en segundos o como fecha HTTP.
function retryAfterMs(header) {
  if (!header) return null;
  const secs = Number(header);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const when = Date.parse(header);
  return Number.isFinite(when) ? Math.max(0, when - Date.now()) : null;
}

const backoffMs = (intento) => Math.min(20000, 1500 * 2 ** intento) + Math.round(Math.random() * 500);

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('cancelado'));
    const onAbort = () => { clearTimeout(timer); reject(new Error('cancelado')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// El cuerpo de error de OpenRouter trae el detalle útil anidado; lo dejamos corto y legible.
function detailOf(body) {
  try {
    const e = JSON.parse(body).error;
    if (e) {
      const partes = [e.message, e.metadata?.raw, e.metadata?.provider_name && `proveedor: ${e.metadata.provider_name}`];
      const texto = partes.filter(Boolean).join(' — ');
      if (texto) return texto.slice(0, 300);
    }
  } catch { /* no era JSON: mostramos el cuerpo crudo */ }
  return body.slice(0, 300);
}

function fail({ status, model, detail, streamed }) {
  const err = new Error(`OpenRouter ${status} (${model}): ${detail}`);
  err.status = status;
  err.streamed = streamed;
  // Un error transitorio deja de serlo si el modelo ya escribió: reintentar duplicaría la respuesta.
  err.transient = TRANSIENT.has(Number(status)) && !streamed;
  return err;
}

// Una llamada en streaming a OpenRouter (API compatible con OpenAI).
// onDelta recibe el texto de la respuesta; onReasoning, el razonamiento si el modelo lo expone.
async function once({ apiKey, model, messages, maxTokens, temperature, plugins, onDelta, onReasoning, signal }) {
  const body = {
    model,
    messages,
    stream: true,
    max_tokens: maxTokens,
    usage: { include: true },
  };
  if (temperature !== undefined) body.temperature = temperature;
  if (plugins) body.plugins = plugins;

  let res;
  try {
    res = await fetch(endpoint(), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': process.env.APP_URL || 'http://localhost',
        'X-Title': '221 Content Harness',
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (signal?.aborted || err.name === 'AbortError') throw err;
    // Se cayó la conexión antes de empezar: vale la pena reintentar.
    err.transient = true;
    err.streamed = false;
    throw err;
  }
  if (!res.ok) {
    const err = fail({ status: res.status, model, detail: detailOf(await res.text()), streamed: false });
    err.retryAfterMs = retryAfterMs(res.headers.get('retry-after'));
    throw err;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let usage = null;
  let finishReason = null;
  let streamed = false;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      // Las líneas que empiezan con ":" son comentarios de keep-alive.
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      let chunk;
      try {
        chunk = JSON.parse(data);
      } catch {
        continue;
      }
      // El proveedor también puede fallar con el stream ya abierto.
      if (chunk.error) {
        throw fail({
          status: chunk.error.code ?? 'error',
          model,
          detail: detailOf(JSON.stringify({ error: chunk.error })),
          streamed,
        });
      }
      const choice = chunk.choices?.[0];
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      const delta = choice?.delta;
      if (delta?.reasoning) { streamed = true; onReasoning?.(delta.reasoning); }
      if (delta?.content) {
        streamed = true;
        text += delta.content;
        onDelta?.(delta.content);
      }
      if (chunk.usage) usage = chunk.usage;
    }
  }
  return { text, usage, finishReason };
}

// Llama a OpenRouter reintentando los errores pasajeros (429 del pool compartido, 5xx, caídas de red).
// onRetry avisa de cada espera para poder mostrarla en vivo.
export async function streamChat(opts) {
  const { retries = Number(process.env.OPENROUTER_RETRIES ?? 3), onRetry, signal, model } = opts;
  for (let intento = 0; ; intento++) {
    try {
      return await once(opts);
    } catch (err) {
      if (!err.transient || intento >= retries || signal?.aborted) throw err;
      const waitMs = err.retryAfterMs ?? backoffMs(intento);
      onRetry?.({ model, status: err.status, attempt: intento + 1, retries, waitMs, message: err.message });
      await sleep(waitMs, signal);
    }
  }
}
