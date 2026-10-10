import { SEATS, MAX_ROUNDS, PASS, DONE, visibleTo, fileVisibleTo } from '../../public/table-core.js';

// Mesa de agentes: cada turno es una llamada sin estado. El servidor arma lo que ve el agente que habla
// (la mesa + lo que el usuario le dijo solo a él) a partir del registro completo que manda el navegador.
export const LIMITS = { log: 600, text: 20000, field: 4000, files: 40, images: 16, textFile: 60000, pdf: 12 * 1024 * 1024 };

const str = (v, max, what) => {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') throw new Error(`${what}: tiene que ser texto.`);
  if (v.length > max) throw new Error(`${what}: máximo ${max} caracteres.`);
  return v.trim();
};
const seatOf = (v, what) => { if (!SEATS.includes(v)) throw new Error(`${what}: asiento inválido.`); return v; };
const round = (v) => { const n = Number(v); if (!Number.isInteger(n) || n < 0 || n > MAX_ROUNDS + 1) throw new Error('Ronda inválida.'); return n; };

function parseFile(f) {
  const kind = ['image', 'text', 'pdf'].includes(f?.kind) ? f.kind : null;
  if (!kind) throw new Error('Archivo inválido: la mesa recibe imágenes, texto y PDF.');
  const to = f.to === 'table' ? 'table' : seatOf(f.to, 'Archivo');
  const code = typeof f.code === 'string' && /^[A-DM]\d{1,3}$/.test(f.code) ? f.code : null;
  if (!code) throw new Error('Archivo sin código.');
  const name = str(f.name, 200, 'Nombre de archivo') || code;
  let data;
  if (kind === 'text') data = str(f.data, LIMITS.textFile, `Archivo ${code}`);
  else if (kind === 'image') {
    if (typeof f.data !== 'string' || !/^(data:image\/[\w.+-]+;base64,|https:\/\/)/.test(f.data)) throw new Error(`Imagen ${code} inválida.`);
    data = f.data;
  } else {
    if (typeof f.data !== 'string' || !f.data.startsWith('data:application/pdf;base64,') || f.data.length > LIMITS.pdf * 1.37) throw new Error(`PDF ${code} inválido o demasiado grande.`);
    data = f.data;
  }
  return { code, name, kind, to, data, round: round(f.round ?? 0) };
}

function parseEntry(e) {
  if (e?.type === 'agent') return { type: 'agent', round: round(e.round), seat: seatOf(e.seat, 'Turno'), action: e.action === 'pass' ? 'pass' : 'speak', done: e.done === true, text: str(e.text, LIMITS.text, 'Turno') };
  if (e?.type === 'user') return { type: 'user', round: round(e.round), to: e.to === 'table' ? 'table' : seatOf(e.to, 'Mensaje'), text: str(e.text, LIMITS.text, 'Mensaje'), files: Array.isArray(e.files) ? e.files.filter((c) => typeof c === 'string').slice(0, 20) : [] };
  if (e?.type === 'system') return { type: 'system', round: round(e.round ?? 0), text: str(e.text, 500, 'Aviso') };
  throw new Error('Registro de la mesa inválido.');
}

export function parseTableRequest(body) {
  const kind = body?.kind === 'synthesis' ? 'synthesis' : 'turn';
  if (!Array.isArray(body?.agents) || body.agents.length !== SEATS.length) throw new Error('La mesa necesita exactamente cuatro agentes.');
  const agents = body.agents.map((a, i) => {
    const seat = seatOf(a?.seat, 'Agente');
    if (seat !== SEATS[i]) throw new Error('Los agentes tienen que venir en orden A, B, C, D.');
    const name = str(a.name, 80, `Nombre de ${seat}`);
    const model = str(a.model, 200, `Modelo de ${seat}`);
    if (!name) throw new Error(`Falta el nombre del agente ${seat}.`);
    if (!model) throw new Error(`Falta el modelo del agente ${seat}.`);
    return { seat, name, model, mission: str(a.mission, LIMITS.field, `Misión de ${seat}`), notes: str(a.notes, LIMITS.field, `Indicaciones de ${seat}`) };
  });
  const goal = str(body.goal, LIMITS.field, 'Misión final');
  if (!goal) throw new Error('Falta la misión final de la mesa.');
  if (!Array.isArray(body.log) || body.log.length > LIMITS.log) throw new Error(`Registro inválido (máximo ${LIMITS.log} entradas).`);
  if (!Array.isArray(body.files ?? []) || (body.files ?? []).length > LIMITS.files) throw new Error(`Máximo ${LIMITS.files} archivos por mesa.`);
  const maxRounds = body.maxRounds === undefined ? MAX_ROUNDS : Number(body.maxRounds);
  if (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > MAX_ROUNDS) throw new Error(`Las rondas van de 1 a ${MAX_ROUNDS}.`);
  const out = { kind, name: str(body.name, 120, 'Nombre de la mesa'), goal, agents, maxRounds, log: body.log.map(parseEntry), files: (body.files || []).map(parseFile) };
  if (kind === 'turn') {
    out.seat = seatOf(body.seat, 'Turno');
    out.round = round(body.round);
    if (out.round < 1 || out.round > maxRounds) throw new Error('Ronda fuera de la mesa.');
    out.model = agents.find((a) => a.seat === out.seat).model;
  } else {
    out.reason = ['consensus', 'rounds', 'forced'].includes(body.reason) ? body.reason : 'rounds';
    out.model = str(body.synthesisModel, 200, 'Modelo del relator') || agents[0].model;
  }
  return out;
}

const label = (agents, seat) => `${seat} · ${agents.find((a) => a.seat === seat).name}`;

function describeAgent(a) {
  return [`- ${label([a], a.seat)}`, a.mission && `  Misión: ${a.mission}`].filter(Boolean).join('\n');
}

// Una línea por entrada del registro, desde el punto de vista de `seat` (null = relator).
function transcript(req, seat) {
  const lines = req.log.filter((e) => visibleTo(e, seat)).map((e) => {
    if (e.type === 'system') return `— ${e.text} —`;
    if (e.type === 'user') {
      const to = e.to === 'table' ? 'toda la mesa' : 'vos, en privado (los demás no lo vieron)';
      const files = e.files.length ? ` [adjuntó ${e.files.join(', ')}]` : '';
      return `[${e.round ? `Ronda ${e.round}` : 'Antes de empezar'} · Usuario → ${to}]${files} ${e.text}`.trim();
    }
    const who = `${label(req.agents, e.seat)}${e.seat === seat ? ' (vos)' : ''}`;
    const body = e.action === 'pass' ? `${PASS}${e.text ? ` ${e.text}` : ''}` : e.text;
    return `[Ronda ${e.round} · ${who}] ${body}${e.done ? ` ${DONE}` : ''}`;
  });
  return lines.length ? lines.join('\n\n') : '(Todavía nadie habló.)';
}

// Archivos visibles como partes del mensaje: texto en línea, PDF como archivo, imágenes (las más recientes).
function fileParts(req, seat) {
  const files = req.files.filter((f) => fileVisibleTo(f, seat));
  const parts = [];
  const images = files.filter((f) => f.kind === 'image');
  const keep = new Set(images.slice(-LIMITS.images));
  const dropped = images.filter((f) => !keep.has(f)).map((f) => f.code);
  for (const f of files) {
    const owner = f.to === 'table' ? 'de la mesa' : 'privado tuyo';
    if (f.kind === 'text') parts.push({ type: 'text', text: `Archivo ${f.code} (${owner}) · ${f.name}:\n"""\n${f.data}\n"""` });
    else if (f.kind === 'pdf') parts.push({ type: 'text', text: `Archivo ${f.code} (${owner}) · ${f.name} (PDF):` }, { type: 'file', file: { filename: f.name, file_data: f.data } });
    else if (keep.has(f)) parts.push({ type: 'text', text: `Imagen ${f.code} (${owner}) · ${f.name}:` }, { type: 'image_url', image_url: { url: f.data } });
  }
  if (dropped.length) parts.push({ type: 'text', text: `(Imágenes omitidas por límite: ${dropped.join(', ')}. Solo conocés lo que se dijo de ellas.)` });
  return parts;
}

export function turnSystem(req) {
  const me = req.agents.find((a) => a.seat === req.seat);
  const others = req.agents.filter((a) => a.seat !== req.seat);
  const last = req.round === req.maxRounds;
  return `Sos ${me.name} (asiento ${me.seat}), uno de los cuatro agentes sentados a una mesa de trabajo.
${me.mission ? `\nTu misión y rol en la mesa:\n${me.mission}\n` : ''}${me.notes ? `\nIndicaciones del usuario solo para vos:\n${me.notes}\n` : ''}
MISIÓN FINAL DE LA MESA (lo que tienen que entregar juntos):
${req.goal}

Tus compañeros:
${others.map(describeAgent).join('\n')}

Cómo funciona la mesa:
- Hablan por turnos, en rondas. Esta es la ronda ${req.round} de ${req.maxRounds}. Al terminar la última ronda (o antes, si la mesa ya está de acuerdo) un relator redacta la entrega final con lo que hayan acordado.
- En tu turno escuchaste todo lo anterior. Elegí UNA cosa: aportar algo nuevo y concreto, responder o corregir a un compañero (nombralo), o pasar.
- Si no tenés nada valioso que sumar, respondé solamente ${PASS} y, si querés, una línea con el porqué. Pasar es mejor que repetir.
- Si creés que con lo acordado la misión final ya está resuelta, terminá tu mensaje con ${DONE}. Si los cuatro pasan o dicen ${DONE} en una misma ronda, la mesa se cierra antes.
- Sé breve y específico: como máximo unas 180 palabras. No repitas lo que ya se dijo: construí sobre eso. Defendé tu misión, pero al servicio de la misión final.
- El usuario puede intervenir en cualquier momento. Lo que le dice a toda la mesa lo ven todos; lo que te dice en privado solo lo ves vos (usalo, pero sabé que los demás no lo leyeron).
- Los archivos tienen un código (M1, M2… de la mesa; ${me.seat}1, ${me.seat}2… los tuyos). Citá el código cuando te refieras a uno.
- Hablá en el idioma en que está escrita la misión final. No escribas el nombre de tu asiento al principio: la mesa ya sabe quién habla.${last ? `\n\nEsta es la ÚLTIMA ronda: dejá tu aporte final para cerrar el trabajo; no abras temas nuevos.` : ''}`;
}

export function buildTurnMessages(req) {
  const me = req.agents.find((a) => a.seat === req.seat);
  const content = [{ type: 'text', text: `Conversación de la mesa hasta ahora:\n\n${transcript(req, req.seat)}\n\nEs tu turno, ${me.name}.` }, ...fileParts(req, req.seat)];
  return [{ role: 'system', content: turnSystem(req) }, { role: 'user', content: content.length === 1 ? content[0].text : content }];
}

const REASONS = {
  consensus: 'La mesa se cerró antes porque en una ronda completa los cuatro agentes pasaron o dieron la misión por resuelta.',
  rounds: 'La mesa usó todas sus rondas.',
  forced: 'El usuario cerró la mesa y pidió la entrega.',
};

export function synthesisSystem(req) {
  return `Sos el relator de una mesa de cuatro agentes. No opinás: convertís lo que la mesa acordó en la entrega final.

MISIÓN FINAL DE LA MESA:
${req.goal}

Agentes:
${req.agents.map(describeAgent).join('\n')}

${REASONS[req.reason]}

Escribí la entrega final, completa y lista para usar, que cumpla la misión final.
- Usá las decisiones a las que llegó la mesa; si dos agentes quedaron en desacuerdo, elegí la opción mejor argumentada y aclaralo en una línea.
- Respetá lo que el usuario le dijo a toda la mesa: tiene prioridad sobre lo que propusieron los agentes.
- Citá los archivos por su código (M1, A2…) cuando la entrega dependa de ellos.
- Al final, en una sección breve "Pendientes", listá lo que la mesa no llegó a resolver (si no queda nada, omitila).
- Escribí en el idioma de la misión final, en Markdown.`;
}

export function buildSynthesisMessages(req) {
  const content = [{ type: 'text', text: `Conversación completa de la mesa:\n\n${transcript(req, null)}\n\nRedactá la entrega final.` }, ...fileParts(req, null)];
  return [{ role: 'system', content: synthesisSystem(req) }, { role: 'user', content: content.length === 1 ? content[0].text : content }];
}
