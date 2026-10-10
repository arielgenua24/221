import path from 'node:path';
import { createVideoCatalog, parseExperiment, incompatibility } from './models.js';
import { createCinematicJobs } from './jobs.js';
import { createOpenRouterVideo } from './openrouter-video.js';

const CHAT_SYSTEM = `Sos un colaborador de dirección cinematográfica para un laboratorio que compara generadores de video. Conversá en español, conservá las decisiones previas y ayudá a precisar sujetos, acciones, cámara, iluminación, ambiente y sonido. Las imágenes adjuntas son referencias del usuario. No generes videos ni elijas un ganador. Cuando se pida un prompt final, devolvé solo el prompt listo para usar. El mismo prompt se usará sin cambios en todos los generadores.`;

export function createCinematicRoutes({ mock, llm, apiKey, wavespeedKey, wavespeed, mediaDir, runsDir, readBody, sendJson, badRequest, catalog: suppliedCatalog }) {
  const catalog = suppliedCatalog || createVideoCatalog({ wavespeedKey, mock });
  const jobs = createCinematicJobs({ dir: path.join(runsDir, 'cinematic-videos'), catalog, wavespeed,
    openrouter: createOpenRouterVideo({ apiKey, mediaDir }), mock });
  async function action(req, res, url) {
    try {
      if (req.method === 'GET' && url.pathname.endsWith('/models')) return sendJson(res, 200, { ...(await catalog()), mock });
      if (req.method === 'GET' && url.pathname.endsWith('/job')) return sendJson(res, 200, await jobs.get(url.searchParams.get('id') || ''));
      const body = await readBody(req, 60 * 1024 * 1024);
      if (url.pathname.endsWith('/recover')) return sendJson(res, 200, await jobs.recover(body.id));
      if (url.pathname.endsWith('/chat')) {
        if (!apiKey && !mock) throw new Error('Falta OPENROUTER_API_KEY para conversar. Podés pegar un prompt final y usar WaveSpeed.');
        if (typeof body.model !== 'string' || !body.model.trim()) throw new Error('Elegí un LLM de OpenRouter.');
        if (!Array.isArray(body.turns) || !body.turns.length || body.turns.length > 100 || body.turns.some((t) => !['user', 'assistant'].includes(t.role) || typeof t.text !== 'string' || t.text.length > 20000)) throw new Error('Conversación inválida (máximo 100 mensajes).');
        if (body.turns.at(-1).role !== 'user') throw new Error('Falta el mensaje del usuario.');
        const refs = body.references || [];
        if (!Array.isArray(refs) || refs.length > 10 || refs.some((r) => typeof r.url !== 'string' || !/^(data:image\/[\w.+-]+;base64,|https:\/\/)/.test(r.url))) throw new Error('Referencias inválidas.');
        const messages = [{ role: 'system', content: CHAT_SYSTEM },
          ...body.turns.map((t) => ({ role: t.role, content: t.text }))];
        // El historial completo y las referencias actuales acompañan cada turno.
        if (refs.length) messages.at(-1).content = [{ type: 'text', text: body.turns.at(-1).text }, ...refs.map((r) => ({ type: 'image_url', image_url: { url: r.url } }))];
        const started = Date.now();
        const output = mock ? { text: body.turns.at(-1).text.includes('prompt final')
          ? 'A cinematic slow push-in. Preserve the subject and colors from the references, soft side lighting, natural motion, detailed textures, a single continuous shot.'
          : 'Podemos precisar el movimiento de cámara, la luz y la acción. Voy a conservar estas decisiones al preparar el prompt final.', usage: { cost: 0 } }
          : await llm({ model: body.model.trim(), messages, signal: AbortSignal.timeout(180000) });
        return sendJson(res, 200, { text: output.text, usage: output.usage, ms: Date.now() - started });
      }
      const input = parseExperiment(body);
      if (url.pathname.endsWith('/preflight')) {
        const { models } = await catalog();
        return sendJson(res, 200, { results: input.generators.map((g) => ({ ...g, reason: incompatibility(models.find((m) => m.provider === g.provider && m.id === g.model), input) })) });
      }
      return sendJson(res, 202, await jobs.start(input));
    } catch (err) { if (!res.writableEnded) badRequest(res, err.message); }
  }
  return (req, res, url) => {
    if (!url.pathname.startsWith('/api/lab/cinematic/')) return false;
    const name = url.pathname.split('/').at(-1);
    if ((req.method === 'GET' && ['models', 'job'].includes(name)) || (req.method === 'POST' && ['run', 'preflight', 'chat', 'recover'].includes(name))) {
      action(req, res, url); return true;
    }
    return false;
  };
}
