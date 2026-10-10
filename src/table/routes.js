import { parseTableRequest, buildTurnMessages, buildSynthesisMessages } from './prompts.js';
import { PASS, DONE } from '../../public/table-core.js';

// Laboratorio · Mesa de agentes.
//   POST /api/lab/table/turn → un turno de un agente (kind: 'turn') o la entrega final (kind: 'synthesis').
// El navegador orquesta las rondas y manda el registro completo en cada turno, así el usuario puede
// intervenir entre dos turnos cualquiera. Respuesta: NDJSON { type: 'delta' | 'retry' | 'done' | 'error' }.
const MAX_BODY = 80 * 1024 * 1024;

function mockText(req) {
  if (req.kind === 'synthesis') return `## Entrega final (demo)\n\n${req.goal}\n\n- ${req.agents.map((a) => `${a.name}: aporte integrado.`).join('\n- ')}\n\nEn modo demo no hay un modelo real: configurá OPENROUTER_API_KEY para conversar de verdad.`;
  const me = req.agents.find((a) => a.seat === req.seat);
  if (req.round === 2 && req.seat === 'D') return `${PASS} Lo que dijeron ya cubre mi parte.`;
  const said = req.log.filter((e) => e.type === 'agent').at(-1);
  const reply = said ? `Tomo lo que dijo ${req.agents.find((a) => a.seat === said.seat).name} y lo llevo a mi terreno` : 'Arranco yo';
  return `${reply}: desde ${me.mission || 'mi rol'}, propongo un paso concreto para "${req.goal.slice(0, 60)}" (ronda ${req.round}, demo).${req.round >= 3 ? ` ${DONE}` : ''}`;
}

async function mockReply(req, send, signal) {
  const text = mockText(req);
  for (const word of text.split(/(?<= )/)) {
    if (signal.aborted) throw new Error('cancelado');
    send({ type: 'delta', text: word });
    await new Promise((r) => setTimeout(r, 15));
  }
  return { text, usage: { cost: 0 } };
}

export function createTableRoutes({ mock, llm, readBody, badRequest }) {
  async function turn(req, res) {
    let input;
    try { input = parseTableRequest(await readBody(req, MAX_BODY)); } catch (err) { return badRequest(res, err.message); }
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
    const controller = new AbortController();
    res.on('close', () => { if (!res.writableFinished) controller.abort(); });
    const send = (ev) => { if (!res.writableEnded) res.write(`${JSON.stringify(ev)}\n`); };
    const started = Date.now();
    try {
      const messages = input.kind === 'synthesis' ? buildSynthesisMessages(input) : buildTurnMessages(input);
      const out = mock ? await mockReply(input, send, controller.signal) : await llm({
        model: input.model, messages, signal: controller.signal,
        onDelta: (text) => send({ type: 'delta', text }),
        onRetry: ({ attempt, retries, waitMs, message }) => send({ type: 'retry', attempt, retries, waitMs, message }),
      });
      send({ type: 'done', text: out.text, usage: out.usage || null, model: input.model, ms: Date.now() - started });
    } catch (err) {
      if (!controller.signal.aborted) send({ type: 'error', error: err.message });
    } finally {
      res.end();
    }
  }
  return (req, res, url) => {
    if (req.method === 'POST' && url.pathname === '/api/lab/table/turn') { turn(req, res); return true; }
    return false;
  };
}
