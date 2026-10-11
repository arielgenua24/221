import { SEATS, MAX_ROUNDS, PASS, DONE, visibleTo, fileVisibleTo, describeAsset } from '../../public/table-core.js';
import { ASPECTS, SPECS, MEDIA_URL, LIMITS as MEDIA_LIMITS, mediaCosts } from './media.js';
import { DELIVERY_SHAPE, PART_RULES, PART_LABEL, PART_KINDS, SHOT_MIN, SHOT_MAX, MAX_SHOTS } from './delivery.js';

// Mesa de agentes: cada turno es una llamada sin estado. El servidor arma lo que ve el agente que habla
// (la mesa + lo que el usuario le dijo solo a él + lo generado) a partir del registro completo que manda el navegador.
export const LIMITS = { log: 600, text: 20000, field: 4000, files: 40, images: 16, textFile: 60000, pdf: 12 * 1024 * 1024, assets: 80, generatedImages: 6, budget: 50 };
export const DEFAULT_BUDGET = 1.5;

const str = (v, max, what) => {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') throw new Error(`${what}: tiene que ser texto.`);
  if (v.length > max) throw new Error(`${what}: máximo ${max} caracteres.`);
  return v.trim();
};
const seatOf = (v, what) => { if (!SEATS.includes(v)) throw new Error(`${what}: asiento inválido.`); return v; };
const round = (v) => { const n = Number(v); if (!Number.isInteger(n) || n < 0 || n > MAX_ROUNDS + 1) throw new Error('Ronda inválida.'); return n; };
const money = (v) => `US$ ${v.toFixed(v < 0.1 ? 3 : 2)}`;

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

// Una pieza generada en la mesa (G1, G2…). Viaja sin bytes: el archivo vive en /media/ del servidor.
export function parseAsset(a, aspect) {
  const kind = ['image', 'voice', 'sound'].includes(a?.kind) ? a.kind : null;
  if (!kind) throw new Error('Pieza generada inválida.');
  const code = typeof a.code === 'string' && /^G\d{1,3}$/.test(a.code) ? a.code : null;
  if (!code) throw new Error('Pieza generada sin código.');
  if (!MEDIA_URL.test(a.url || '')) throw new Error(`Pieza ${code}: archivo inválido.`);
  let spec;
  try { spec = SPECS[kind](a.spec, aspect); } catch (err) { throw new Error(`Pieza ${code}: ${err.message}.`); }
  const cost = Number(a.cost) || 0;
  if (cost < 0 || cost > 20) throw new Error(`Pieza ${code}: costo inválido.`);
  return { code, kind, seat: seatOf(a.seat, `Pieza ${code}`), round: round(a.round ?? 0), url: a.url, spec, cost, model: str(a.model, 200, `Modelo de ${code}`) };
}

function parseEntry(e) {
  if (e?.type === 'agent') {
    return { type: 'agent', round: round(e.round), seat: seatOf(e.seat, 'Turno'), action: e.action === 'pass' ? 'pass' : 'speak', done: e.done === true, text: str(e.text, LIMITS.text, 'Turno'),
      assets: Array.isArray(e.assets) ? e.assets.filter((c) => typeof c === 'string' && /^G\d{1,3}$/.test(c)).slice(0, 10) : [] };
  }
  if (e?.type === 'user') return { type: 'user', round: round(e.round), to: e.to === 'table' ? 'table' : seatOf(e.to, 'Mensaje'), text: str(e.text, LIMITS.text, 'Mensaje'), files: Array.isArray(e.files) ? e.files.filter((c) => typeof c === 'string').slice(0, 20) : [] };
  if (e?.type === 'system') return { type: 'system', round: round(e.round ?? 0), text: str(e.text, 500, 'Aviso') };
  throw new Error('Registro de la mesa inválido.');
}

// Revisión de una parte de la entrega: el humano le habla al dueño de esa parte.
function parsePart(p, aspect) {
  const kind = PART_KINDS.includes(p?.kind) ? p.kind : null;
  if (!kind) throw new Error('Parte inválida.');
  const shot = kind === 'musica' ? null : typeof p.shot === 'string' && /^S\d{1,2}$/.test(p.shot) ? p.shot : null;
  if (kind !== 'musica' && !shot) throw new Error('Falta la toma de la parte.');
  if (!p.spec || typeof p.spec !== 'object') throw new Error('Falta la especificación de la parte.');
  const spec = kind === 'video' ? { prompt: str(p.spec.prompt, MEDIA_LIMITS.prompt, 'Prompt de video'), modelo: p.spec.modelo === 'heygen' ? 'heygen' : 'wan' }
    : SPECS[{ cuadro: 'image', voz: 'voice', sonido: 'sound', musica: 'sound' }[kind]](p.spec, aspect);
  const thread = (Array.isArray(p.thread) ? p.thread : []).slice(-30).map((m) => ({ role: m?.role === 'agent' ? 'agent' : 'user', text: str(m?.text, LIMITS.text, 'Mensaje de la parte') })).filter((m) => m.text);
  if (thread.at(-1)?.role !== 'user') throw new Error('Falta tu mensaje para el dueño de la parte.');
  const see = (Array.isArray(p.see) ? p.see : []).filter((u) => typeof u === 'string' && MEDIA_URL.test(u) && /\.(png|jpe?g|webp|svg)$/.test(u)).slice(0, 2);
  return { kind, shot, owner: seatOf(p.owner, 'Dueño de la parte'), spec, thread, see, duration: Math.min(SHOT_MAX, Math.max(SHOT_MIN, Number(p.duration) || 5)) };
}

export function parseTableRequest(body) {
  const kind = ['synthesis', 'part'].includes(body?.kind) ? body.kind : 'turn';
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
  if (!Array.isArray(body.assets ?? []) || (body.assets ?? []).length > LIMITS.assets) throw new Error(`Máximo ${LIMITS.assets} piezas generadas por mesa.`);
  const maxRounds = body.maxRounds === undefined ? MAX_ROUNDS : Number(body.maxRounds);
  if (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > MAX_ROUNDS) throw new Error(`Las rondas van de 1 a ${MAX_ROUNDS}.`);
  const aspect = body.aspect === undefined ? '9:16' : body.aspect;
  if (!ASPECTS.includes(aspect)) throw new Error('Formato de la pieza inválido.');
  const budget = body.budget === undefined ? DEFAULT_BUDGET : Number(body.budget);
  if (!Number.isFinite(budget) || budget < 0 || budget > LIMITS.budget) throw new Error(`El presupuesto va de 0 a ${LIMITS.budget} US$.`);
  const out = {
    kind, name: str(body.name, 120, 'Nombre de la mesa'), goal, agents, maxRounds, aspect, budget, tools: body.tools !== false,
    log: body.log.map(parseEntry), files: (body.files || []).map(parseFile), assets: (body.assets || []).map((a) => parseAsset(a, aspect)),
  };
  if (kind === 'turn') {
    out.seat = seatOf(body.seat, 'Turno');
    out.round = round(body.round);
    if (out.round < 1 || out.round > maxRounds) throw new Error('Ronda fuera de la mesa.');
    out.model = agents.find((a) => a.seat === out.seat).model;
  } else if (kind === 'synthesis') {
    out.reason = ['consensus', 'rounds', 'forced'].includes(body.reason) ? body.reason : 'rounds';
    out.model = str(body.synthesisModel, 200, 'Modelo del relator') || agents[0].model;
  } else {
    out.part = parsePart(body.part, aspect);
    out.seat = out.part.owner;
    out.model = agents.find((a) => a.seat === out.seat).model;
    const production = JSON.stringify(body.production ?? null);
    if (!body.production || typeof body.production !== 'object' || production.length > 120000) throw new Error('Falta la entrega (o es demasiado grande).');
    out.production = body.production;
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
    const made = e.assets?.length ? ` (generó ${e.assets.join(', ')})` : '';
    return `[Ronda ${e.round} · ${who}]${made} ${body}${e.done ? ` ${DONE}` : ''}`;
  });
  return lines.length ? lines.join('\n\n') : '(Todavía nadie habló.)';
}

function generatedSection(req) {
  if (!req.assets.length) return '';
  return `\n\nMaterial generado en la mesa (lo ven los cuatro; las imágenes más recientes van adjuntas, los audios solo se conocen por esta descripción):\n${req.assets.map((a) => `- ${describeAsset(a, req.agents)}`).join('\n')}`;
}

// Archivos visibles como partes del mensaje: texto en línea, PDF como archivo, imágenes (las más recientes).
// Después, las imágenes generadas en la mesa más recientes (req.assetData: código → data URL, lo carga la ruta).
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
  const generated = req.assets.filter((a) => a.kind === 'image' && req.assetData?.has(a.code));
  for (const a of generated) parts.push({ type: 'text', text: `Imagen ${a.code} (generada por ${a.seat} en la ronda ${a.round}):` }, { type: 'image_url', image_url: { url: req.assetData.get(a.code) } });
  const older = req.assets.filter((a) => a.kind === 'image' && !req.assetData?.has(a.code)).map((a) => a.code);
  if (older.length) parts.push({ type: 'text', text: `(Imágenes generadas que no van adjuntas, por límite: ${older.join(', ')}. Conocés su prompt.)` });
  return parts;
}

// Las imágenes generadas que se le muestran al modelo (las más recientes): la ruta las lee de disco.
export const imagesToShow = (req) => req.assets.filter((a) => a.kind === 'image').slice(-LIMITS.generatedImages);

const VIDEO_RULE = `El VIDEO no se genera durante la mesa: al final, el humano aprueba cada toma y se genera con Wan 3.0 Prime o HeyGen Video 1 (480p, de ${SHOT_MIN} a ${SHOT_MAX} s por toma, partiendo del cuadro de storyboard de esa toma, sin sonido propio: la voz, los sonidos y la música se suman encima). Pensá la pieza en tomas cortas y cada cuadro como el primer cuadro de su toma.`;

function toolsSection(req) {
  const c = mediaCosts();
  const head = `\nFORMATO DE LA PIEZA: ${req.aspect}. ${VIDEO_RULE}`;
  if (!req.toolsOn) return `${head}\nEn esta mesa no podés generar piezas: describí en texto lo que propongas (prompts concretos, listos para generar).`;
  return `${head}

HERRAMIENTAS (generan de verdad, no solo describen):
- Tenés generar_imagen (Nano Banana 2.1), generar_voz (ElevenLabs v4) y generar_sonido (ElevenLabs Sound Effects v2). Lo que generás queda sobre la mesa con un código G y los cuatro lo conocen.
- Usalas cuando una pieza concreta haga avanzar la discusión más que un párrafo: fijar el look o un personaje con un cuadro, probar cómo suena una línea clave, definir el clima con un ambiente. No generes por generar ni repitas lo que ya existe: si algo está en la mesa, criticalo o mejoralo citando su código (para mejorar una imagen, partí de ella con "referencias").
- Máximo ${MEDIA_LIMITS.perTurn} piezas por turno. Presupuesto de la mesa para generar: quedan ${money(req.toolBudget)} de ${money(req.budget)} (imagen ≈ ${money(c.image)}, voz ≈ ${money(c.voicePer1k)} cada 1000 caracteres, sonido ≈ ${money(c.sound)}). Si no alcanza, describilo en texto.
- Las imágenes generadas las ves; las voces y los sonidos nadie los puede escuchar en la mesa: juzgalos por su texto, su voz y su descripción.
- Después de usar herramientas, igual escribí tu aporte: qué generaste, para qué y qué proponés (citá el código).`;
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
- Hablan por turnos, en rondas. Esta es la ronda ${req.round} de ${req.maxRounds}. Al terminar la última ronda (o antes, si la mesa ya está de acuerdo) un relator convierte lo acordado en una entrega de producción: tomas con su cuadro, voz, sonido y video, que se generan sin que nadie copie ni pegue nada.
- En tu turno escuchaste todo lo anterior. Elegí UNA cosa: aportar algo nuevo y concreto, responder o corregir a un compañero (nombralo), o pasar.
- Si no tenés nada valioso que sumar, respondé solamente ${PASS} y, si querés, una línea con el porqué. Pasar es mejor que repetir.
- Si creés que con lo acordado la misión final ya está resuelta, terminá tu mensaje con ${DONE}. Si los cuatro pasan o dicen ${DONE} en una misma ronda, la mesa se cierra antes.
- Sé breve y específico: como máximo unas 180 palabras. No repitas lo que ya se dijo: construí sobre eso. Defendé tu misión, pero al servicio de la misión final.
- El usuario puede intervenir en cualquier momento. Lo que le dice a toda la mesa lo ven todos; lo que te dice en privado solo lo ves vos (usalo, pero sabé que los demás no lo leyeron).
- Los archivos tienen un código (M1, M2… de la mesa; ${me.seat}1, ${me.seat}2… los tuyos; G1, G2… lo generado). Citá el código cuando te refieras a uno.
- Hablá en el idioma en que está escrita la misión final. No escribas el nombre de tu asiento al principio: la mesa ya sabe quién habla.
${toolsSection(req)}${last ? `\n\nEsta es la ÚLTIMA ronda: dejá tu aporte final para cerrar el trabajo; no abras temas nuevos.` : ''}`;
}

export function buildTurnMessages(req) {
  const me = req.agents.find((a) => a.seat === req.seat);
  const content = [{ type: 'text', text: `Conversación de la mesa hasta ahora:\n\n${transcript(req, req.seat)}${generatedSection(req)}\n\nEs tu turno, ${me.name}.` }, ...fileParts(req, req.seat)];
  return [{ role: 'system', content: turnSystem(req) }, { role: 'user', content: content.length === 1 ? content[0].text : content }];
}

const REASONS = {
  consensus: 'La mesa se cerró antes porque en una ronda completa los cuatro agentes pasaron o dieron la misión por resuelta.',
  rounds: 'La mesa usó todas sus rondas.',
  forced: 'El usuario cerró la mesa y pidió la entrega.',
};

export function synthesisSystem(req) {
  return `Sos el relator de una mesa de cuatro agentes que prepara una pieza de video. No opinás: convertís lo que la mesa acordó en una ENTREGA DE PRODUCCIÓN dividida en tomas y partes. Cada parte se va a ejecutar tal cual, por separado y sin que nadie copie ni pegue nada, con estos modelos:
- ${PART_RULES.cuadro}
- ${PART_RULES.voz}
- ${PART_RULES.sonido}
- ${PART_RULES.video}
- ${PART_RULES.musica}

MISIÓN FINAL DE LA MESA:
${req.goal}

FORMATO DE LA PIEZA: ${req.aspect}.

Agentes:
${req.agents.map(describeAgent).join('\n')}

${REASONS[req.reason]}

Devolvé SOLO un bloque \`\`\`json con esta forma (sin texto antes ni después):
${DELIVERY_SHAPE}

Reglas:
- Entre 1 y ${MAX_SHOTS} tomas; cuántas, lo decide la misión. Cada toma dura de ${SHOT_MIN} a ${SHOT_MAX} s (entero). Toda toma tiene cuadro y video; voz y sonido son opcionales (null).
- "dueno" de cada parte: la letra del asiento (A, B, C o D) del agente que más trabajó o defendió esa parte en la mesa. Va a responder por ella cuando el humano pida cambios, así que elegí bien.
- "base": si en la mesa ya se generó una pieza que ES esa parte (y nadie la objetó), poné su código G (imagen para cuadro, voz para voz, sonido para sonido o música); se usa tal cual y no se vuelve a pagar. Si no, null.
- Usá las decisiones a las que llegó la mesa; si dos agentes quedaron en desacuerdo, elegí la opción mejor argumentada.
- Respetá lo que el usuario le dijo a toda la mesa: tiene prioridad sobre lo que propusieron los agentes.
- Los textos para el humano (titulo, resumen, estilo, descripcion, pendientes) y el texto de las voces, en el idioma de la misión final. Los prompts de cuadro, sonido, música y video, en inglés.
- "pendientes": lo que la mesa no llegó a resolver (lista vacía si no queda nada).`;
}

export function buildSynthesisMessages(req) {
  const content = [{ type: 'text', text: `Conversación completa de la mesa:\n\n${transcript(req, null)}${generatedSection(req)}\n\nArmá la entrega de producción.` }, ...fileParts(req, null)];
  return [{ role: 'system', content: synthesisSystem(req) }, { role: 'user', content: content.length === 1 ? content[0].text : content }];
}

export const synthesisFix = (message) => `Tu entrega no se pudo leer (${message}). Devolvé SOLO el bloque \`\`\`json completo y válido, con la forma pedida, sin notas. Si no entra, acortá los textos.`;

// ---------- Revisión de una parte con el humano (después de la entrega) ----------
export function partSystem(req) {
  const me = req.agents.find((a) => a.seat === req.seat);
  const p = req.part;
  const where = p.kind === 'musica' ? 'la música de toda la pieza' : `la parte "${PART_LABEL[p.kind]}" de la toma ${p.shot} (dura ${p.duration} s)`;
  return `Sos ${me.name} (asiento ${me.seat}), uno de los cuatro agentes de una mesa de trabajo.
${me.mission ? `\nTu misión y rol en la mesa:\n${me.mission}\n` : ''}${me.notes ? `\nIndicaciones del usuario solo para vos:\n${me.notes}\n` : ''}
MISIÓN FINAL DE LA MESA:
${req.goal}

La mesa ya terminó y entregó una producción dividida en tomas. Vos respondés por ${where}. El humano te habla directamente sobre ella; no hace falta que la mesa vuelva a reunirse.

Esta parte se ejecuta así:
${PART_RULES[p.kind]}

Cómo responder:
1. Primero, en 1 a 3 frases y en el idioma del humano, qué cambiás y por qué. Si lo que pide te parece un error, decíselo con honestidad y proponé una alternativa (igual aplicá lo que pide si insiste: la decisión es suya).
2. Después, un bloque \`\`\`json con la parte completa revisada: todos sus campos, con la misma forma que la actual (sin "dueno" ni "base"). Si no hace falta cambiar nada (por ejemplo, era una pregunta), no pongas bloque.
- Mantené la coherencia con el resto de la producción (personajes, estilo, voces, duración de la toma).
- Lo que cambiás se genera recién cuando el humano toca RUN: no prometas resultados, describí la versión nueva.`;
}

export function buildPartMessages(req) {
  const p = req.part;
  const thread = p.thread.map((m) => `${m.role === 'user' ? 'Humano' : 'Vos'}: ${m.text}`).join('\n\n');
  const text = `Conversación de la mesa (para que recuerdes cómo se llegó a esto):\n\n${transcript(req, req.seat)}${generatedSection(req)}

Entrega de producción vigente:
\`\`\`json
${JSON.stringify(req.production, null, 1)}
\`\`\`

Tu parte, versión actual:
\`\`\`json
${JSON.stringify(p.spec, null, 1)}
\`\`\`

Conversación con el humano sobre esta parte:
${thread}`;
  const content = [{ type: 'text', text }];
  (req.seeData || []).forEach((url, i) => content.push({ type: 'text', text: i === 0 && p.kind === 'cuadro' ? 'El resultado actual de tu parte:' : 'Resultado generado de esta toma:' }, { type: 'image_url', image_url: { url } }));
  return [{ role: 'system', content: partSystem(req) }, { role: 'user', content: content.length === 1 ? text : content }];
}
