import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

export const openrouterBase = () => (process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');

// Video usa /videos, no /chat/completions. Nunca reenviamos un POST cobrado.
export function createOpenRouterVideo({ apiKey, mediaDir, fetchImpl = fetch, pollMs = 3000 }) {
  const auth = { Authorization: `Bearer ${apiKey}` };
  function localUrl(value) {
    const url = new URL(value, `${openrouterBase()}/`);
    const base = new URL(openrouterBase());
    if (url.origin !== base.origin || !url.pathname.startsWith(`${base.pathname}/videos/`)) throw new Error('OpenRouter devolvió una URL de tarea inválida.');
    return url.href;
  }
  async function json(url, init = {}) {
    const r = await fetchImpl(url, { ...init, headers: { ...auth, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(30000), redirect: 'error' });
    const data = await r.json();
    if (!r.ok) throw new Error(`OpenRouter ${r.status}: ${data.error?.message || data.error || 'Error de video'}`);
    return data;
  }
  async function collect({ task, pollingUrl, timeoutMs = 30 * 60000, onStatus }) {
    const started = Date.now();
    let lastCost = null;
    try {
      const url = localUrl(pollingUrl || `${openrouterBase()}/videos/${encodeURIComponent(task)}`);
      let failures = 0;
      for (;;) {
        if (Date.now() - started > timeoutMs) throw new Error('OpenRouter tardó más de 30 minutos. Podés volver a consultar esta tarea.');
        let data;
        try { data = await json(url); failures = 0; }
        catch (err) { if (++failures > 5) throw err; await sleep(pollMs); continue; }
        await onStatus?.({ status: data.status, task, elapsed: Date.now() - started });
        const cost = Number.isFinite(data.usage?.cost) ? data.usage.cost : null;
        if (cost !== null) lastCost = cost;
        if (['failed', 'cancelled', 'expired'].includes(data.status)) {
          const err = new Error(`OpenRouter: ${data.error || data.status}`); err.final = true; err.cost = cost; throw err;
        }
        if (data.status === 'completed') {
          const content = localUrl(data.unsigned_urls?.[0] || `${openrouterBase()}/videos/${encodeURIComponent(task)}/content`);
          // Solo el dominio de OpenRouter recibe la clave. fetch elimina Authorization al redirigir a otro origen.
          const r = await fetchImpl(content, { headers: auth, signal: AbortSignal.timeout(120000) });
          if (!r.ok) throw new Error(`No se pudo descargar el video (${r.status}).`);
          const file = `${randomUUID()}.mp4`;
          await mkdir(mediaDir, { recursive: true });
          await writeFile(path.join(mediaDir, file), Buffer.from(await r.arrayBuffer()));
          return { task, file, cost, generationId: data.generation_id };
        }
        await sleep(pollMs);
      }
    } catch (err) { err.task = task; err.cost ??= lastCost; throw err; }
  }
  return {
    collect,
    async video({ body, onStatus }) {
      if (!apiKey) throw new Error('Falta la clave de OpenRouter.');
      const job = await json(`${openrouterBase()}/videos`, { method: 'POST', body: JSON.stringify(body) });
      if (!job.id) throw new Error('OpenRouter no devolvió el identificador del video.');
      await onStatus?.({ status: 'created', task: job.id, pollingUrl: job.polling_url });
      return collect({ task: job.id, pollingUrl: job.polling_url, onStatus });
    },
  };
}
