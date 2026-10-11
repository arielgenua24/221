import { PASS, DONE } from '../../public/table-core.js';

// Mesa de agentes · modo demo (sin OPENROUTER_API_KEY o MOCK=1). Simula a los modelos con la misma forma de respuesta
// (texto en streaming, llamadas a herramientas, entrega en JSON), así el demo recorre el flujo completo:
// en la ronda 1 cada agente genera una pieza, en la 2 uno pasa, en la 3 todos dan la misión por resuelta.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function stream(text, onDelta, signal) {
  for (const word of text.split(/(?<= )/)) {
    if (signal?.aborted) throw Object.assign(new Error('cancelado'), { name: 'AbortError' });
    onDelta?.(word);
    await sleep(8);
  }
}

function demoCall(req) {
  const image = req.assets.find((a) => a.kind === 'image');
  const args = {
    A: { name: 'generar_voz', args: { personaje: 'Narrador', texto: `[warmly] ${req.goal.slice(0, 90)}`, voz: 'George' } },
    B: { name: 'generar_imagen', args: { prompt: `Storyboard first frame: ${req.goal.slice(0, 160)}`, proporcion: req.aspect } },
    C: { name: 'generar_sonido', args: { prompt: 'Soft room tone with a distant city murmur', tipo: 'ambiente', duracion: 5, loop: true } },
    D: { name: 'generar_imagen', args: { prompt: 'Closer shot of the same scene, warmer light', referencias: image ? [image.code] : [] } },
  }[req.seat];
  return { id: `call_${req.seat}${req.round}`, type: 'function', function: { name: args.name, arguments: JSON.stringify(args.args) } };
}

function turnText(req, made) {
  if (req.round === 2 && req.seat === 'D') return `${PASS} Lo que dijeron ya cubre mi parte.`;
  const me = req.agents.find((a) => a.seat === req.seat);
  const said = req.log.filter((e) => e.type === 'agent').at(-1);
  const reply = said ? `Tomo lo que dijo ${req.agents.find((a) => a.seat === said.seat).name} y lo llevo a mi terreno` : 'Arranco yo';
  const generated = made ? ` Generé ${made} para que la mesa lo vea.` : '';
  return `${reply}: desde ${me.mission || 'mi rol'}, propongo un paso concreto para "${req.goal.slice(0, 60)}" (ronda ${req.round}, demo).${generated}${req.round >= 3 ? ` ${DONE}` : ''}`;
}

function demoDelivery(req) {
  const first = (kind) => req.assets.find((a) => a.kind === kind);
  const img = first('image'), voice = first('voice'), sound = first('sound');
  const shot = (n, extra = {}) => ({
    id: `S${n}`, titulo: ['Apertura', 'Desarrollo', 'Cierre'][n - 1], duracion: [5, 4, 6][n - 1], descripcion: `Toma ${n} de la pieza (demo).`,
    cuadro: { dueno: 'B', prompt: `Storyboard frame ${n}: ${req.goal.slice(0, 120)}`, referencias: img ? [img.code] : [], base: null },
    voz: { dueno: 'A', personaje: 'Narrador', voz: 'George', texto: `[calm] Esta es la toma ${n}.`, base: null },
    sonido: n === 2 ? null : { dueno: 'C', prompt: 'Gentle whoosh transition', tipo: 'efecto', duracion: 2, loop: false, base: null },
    video: { dueno: 'D', prompt: 'Slow push-in, subtle natural motion, single continuous shot', modelo: 'wan' },
    ...extra,
  });
  return {
    titulo: req.name || 'Pieza demo', resumen: `Demo de la entrega de producción para: ${req.goal.slice(0, 200)}`, estilo: 'Luz cálida, grano de película, ritmo pausado.',
    personajes: [{ nombre: 'Narrador', descripcion: 'Off-screen narrator', voz: 'George' }],
    tomas: [
      shot(1, {
        ...(img ? { cuadro: { dueno: img.seat, base: img.code, prompt: img.spec.prompt } } : {}),
        ...(voice ? { voz: { dueno: voice.seat, base: voice.code, ...voice.spec } } : {}),
        ...(sound ? { sonido: { dueno: sound.seat, base: sound.code, ...sound.spec } } : {}),
      }),
      shot(2), shot(3),
    ],
    musica: { dueno: 'C', prompt: 'Warm lo-fi piano, 80 BPM, no vocals', duracion: 20, loop: true, base: null },
    pendientes: ['En modo demo no hay un modelo real: configurá OPENROUTER_API_KEY para conversar de verdad.'],
  };
}

function partReply(req) {
  const ask = req.part.thread.at(-1).text;
  const spec = { ...req.part.spec };
  if ('texto' in spec) spec.texto = `${spec.texto} (${ask.slice(0, 60)})`;
  else spec.prompt = `${spec.prompt}, ${ask.slice(0, 120)}`;
  return `Hecho: ajusté la parte según lo que pediste (demo).\n\n\`\`\`json\n${JSON.stringify(spec, null, 1)}\n\`\`\``;
}

export async function mockTableLLM({ messages, tools, toolChoice, onDelta, signal, meta }) {
  const req = meta?.req;
  await sleep(40);
  if (meta?.table === 'synthesis') {
    const text = `\`\`\`json\n${JSON.stringify(demoDelivery(req), null, 1)}\n\`\`\``;
    await stream(text, onDelta, signal);
    return { text, usage: { cost: 0 } };
  }
  if (meta?.table === 'part') {
    const text = partReply(req);
    await stream(text, onDelta, signal);
    return { text, usage: { cost: 0 } };
  }
  const results = messages.filter((m) => m.role === 'tool');
  if (tools?.length && toolChoice !== 'none' && !results.length && req.round === 1) return { text: '', toolCalls: [demoCall(req)], usage: { cost: 0 } };
  const made = results.map((m) => /\bG\d+\b/.exec(m.content)?.[0]).filter(Boolean).join(', ');
  const text = turnText(req, made);
  await stream(text, onDelta, signal);
  return { text, usage: { cost: 0 } };
}
