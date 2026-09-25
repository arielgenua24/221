import { readFileSync } from 'node:fs';
import { FONTS, HELPER_DOCS, checkMotionCode } from '../public/motion-lib.js';
import { extractJson } from './agent.js';

// El manual de motion design (src/MOTION_DESIGN.md) es el criterio de gusto que comparten los dos agentes.
export const MOTION_MANUAL = readFileSync(new URL('./MOTION_DESIGN.md', import.meta.url), 'utf8');

const FONT_LIST = Object.entries(FONTS)
  .map(([name, f]) => `- "${name}" — pesos ${f.weights.join(', ')}${f.italic ? ' (+ itálica)' : ''} — ${f.feel}`)
  .join('\n');

// El contrato técnico sale del runtime real (public/motion-lib.js): lo que se documenta es lo que existe.
export const RUNTIME_CONTRACT = `
# CONTRATO TÉCNICO DEL CÓDIGO (el reproductor solo entiende esto)

Escribís JavaScript plano (sin import, sin export, sin DOM, sin red) que define:

\`\`\`
function setup(env, ctx) { ...; return state }  // OPCIONAL. Corre una vez (y de nuevo si cambia el tamaño de la ventana). Precalculá acá (ctx sirve para medir texto).
function draw(ctx, t, env) { ... }           // OBLIGATORIA. Dibuja UN cuadro.
\`\`\`

- \`ctx\`: CanvasRenderingContext2D de una ventana TRANSPARENTE de \`env.w\` × \`env.h\` px, que se compone sobre el video. Llega limpio en cada cuadro.
- \`t\`: segundos desde el inicio del clip (0 → env.dur). El cuadro debe depender SOLO de t (función pura: se adelanta, retrocede y exporta).
- \`env\`: { w, h, u (1% del lado corto), vw (1% del ancho), vh (1% del alto), aspect (w/h), dur (duración del clip en s),
  fonts: { display, text } (nombres de familia del sistema visual), palette: [{ hex, rol }], state (lo que devolvió setup) }.
- La ventana la mueve y la redimensiona el humano después: el diseño tiene que adaptarse a CUALQUIER proporción (usá u, w, h y aspect; nunca píxeles fijos).

Helpers disponibles como variables sueltas (y también como M.<nombre>):
${HELPER_DOCS.map(([sig, desc]) => `- ${sig} — ${desc}`).join('\n')}

Tipografías disponibles (solo estas; usalas con font(peso, tamaño, familia) y solo con los pesos listados):
${FONT_LIST}

Prohibido: Math.random, Date, performance.now, fetch, setTimeout, requestAnimationFrame, document, window, imágenes externas,
estado que se acumule entre cuadros, bucles de más de ~300 elementos por cuadro. Todo esto rompe la exportación.
`;

const NOTES_PROTOCOL = `1. Primero escribí "Notas de trabajo": entre 3 y 8 viñetas breves en español, pensando en voz alta. El humano las ve en vivo: tienen que ser concretas (qué ves en los cuadros y en qué segundo, qué decidís y por qué). Nada de relleno.`;

const JSON_PROTOCOL = `
FORMATO DE RESPUESTA (obligatorio):
${NOTES_PROTOCOL}
2. Después, un único bloque que empiece con \`\`\`json y termine con \`\`\`, con EXACTAMENTE el esquema pedido. Sin comentarios dentro del JSON.`;

const CODE_PROTOCOL = `
FORMATO DE RESPUESTA (obligatorio):
${NOTES_PROTOCOL}
2. Después, un bloque \`\`\`json con el esquema pedido (sin comentarios dentro).
3. Por último, un bloque \`\`\`js con el código completo (setup opcional + draw). Nada después del bloque de código.`;

export const ART_DIRECTOR_SYSTEM = `Sos "el Director de Arte" de un estudio de motion design de primer nivel (pensá en Buck, ManvsMachine, Pentagram, el equipo de títulos de Apple).
Un humano te da UN video vertical y marca hasta 3 clips (de hasta 5 s cada uno) donde quiere motion design encima, con un pedido y referencias por clip.
Tu trabajo NO es animar: es MIRAR el video y definir el SISTEMA VISUAL que va a unir los tres clips (paleta, tipografías, gramática de movimiento, motivo recurrente) y la idea de cada clip, para que tres Motion Designers trabajando en paralelo produzcan tres piezas que parezcan hechas por la misma mano.
También decidís dónde va por defecto la "ventana" del overlay en cada clip (el humano después la puede mover), fuera de caras, del producto y de las zonas de la interfaz de las redes.
Respetás lo que pide el humano en cada clip: tu criterio decide CÓMO, no QUÉ.

${MOTION_MANUAL}
${JSON_PROTOCOL}`;

export const MOTION_SYSTEM = `Sos "el Motion Designer" de un estudio de primer nivel. Escribís motion design como código (Canvas 2D) que se dibuja encima de un clip de video vertical.
Recibís el sistema visual del Director de Arte (paleta, tipografías, gramática de movimiento, motivo) y el encargo de UN clip: sus cuadros con el segundo de cada uno, lo que pide el humano y sus referencias.
Tu vara es la de un motion designer senior: timing preciso, easing con intención, tipografía impecable, una idea clara, sincronizada con lo que pasa en el video. Nada genérico.
Respetás el sistema visual al pie de la letra (es lo que da coherencia con los otros dos clips, que hacen otros diseñadores en paralelo).

${MOTION_MANUAL}
${RUNTIME_CONTRACT}
${CODE_PROTOCOL}`;

const fmtBox = (b) => `x ${b.x.toFixed(2)}, y ${b.y.toFixed(2)}, ancho ${b.w.toFixed(2)}, alto ${b.h.toFixed(2)} (fracciones del cuadro)`;

// Texto del encargo de un clip (sus cuadros y referencias van como imágenes aparte).
function clipBrief(clip, index, total) {
  const refs = clip.refs.length
    ? clip.refs.map((r) => `  - ${r.id}: ${r.kind === 'video' ? `video/GIF de referencia (${r.frames.length} cuadros)` : 'imagen de referencia'}${r.name ? ` "${r.name}"` : ''}`).join('\n')
    : '  (ninguna)';
  return `## ${clip.id} — clip ${index + 1} de ${total} en el tiempo del video (${clip.start.toFixed(2)} s → ${clip.end.toFixed(2)} s del video; dura ${(clip.end - clip.start).toFixed(2)} s)
- Pedido del humano: ${clip.prompt || '(no escribió nada: decidí vos lo que mejor sirva al video)'}
- Referencias en texto / notas de estilo: ${clip.notes || '(ninguna)'}
- Referencias visuales:
${refs}
- Cuadros del clip: tiempos relativos al inicio del clip (${clip.frames.map((f) => `${f.t.toFixed(2)} s`).join(', ')}).`;
}

export function directionPrompt({ text, video, clips }) {
  return `# ENCARGO: sistema visual para ${clips.length} clip${clips.length > 1 ? 's' : ''} de motion design sobre un video

Video: "${video.name}", ${video.duration.toFixed(1)} s, ${video.width}×${video.height} px (proporción ${(video.width / video.height).toFixed(3)}).
Dirección general del humano para todo el video: ${text || '(no escribió nada: inferila del video y de los pedidos de cada clip)'}

${clips.map((c, i) => clipBrief(c, i, clips.length)).join('\n\n')}

Después de este texto vienen, en orden, los cuadros de cada clip y sus referencias visuales (cada imagen está rotulada).

Tu trabajo:
1. Mirá los cuadros: qué pasa, en qué segundo, dónde está el sujeto, qué luz y qué colores tiene.
2. Definí UN sistema visual para los tres clips (sección 9 del manual). Paleta de 2 a 4 colores (hex) que pertenezca al video; tipografías SOLO de esta lista: ${Object.keys(FONTS).join(', ')}.
3. Para cada clip: su idea en una frase (respetando el pedido del humano), su rol en el arco (presenta / desarrolla / remata), el evento del video con el que se sincroniza, y la ventana por defecto.

Esquema JSON exacto:
{
  "lectura": "qué ves en el video: sujeto, lugar, luz, colores dominantes, movimiento de cámara",
  "concepto": "la idea que une los clips, en una frase",
  "arco": "cómo evoluciona la intensidad del primer clip al último",
  "sistema": {
    "paleta": [{ "hex": "#F4F1EA", "rol": "texto principal" }],
    "tipografias": { "display": "familia de la lista", "texto": "familia de la lista (puede ser la misma)", "tratamiento": "pesos, mayúsculas/minúsculas, tracking, tamaños relativos" },
    "movimiento": "la gramática: cómo entra, se sostiene y sale todo (con duraciones en segundos)",
    "easing": "curvas principales (nombres de ease.* o bezier(...)) y cuándo se usa cada una",
    "motivo": "el elemento recurrente que firma los tres clips",
    "composicion": "alineación, márgenes, grilla",
    "textura": "grano, líneas, nada… (sutil)",
    "reglas": ["regla concreta que los tres diseñadores tienen que cumplir"],
    "evitar": ["qué NO hacer en este video en particular"]
  },
  "clips": [
    {
      "id": "C1",
      "idea": "la idea del clip en una frase",
      "rol": "presenta | desarrolla | remata",
      "textos": ["textos exactos que aparecen en pantalla, si hay"],
      "sincronia": [{ "t": 1.2, "evento": "qué pasa en el video en ese segundo del clip y qué hace el motion" }],
      "ventana": { "x": 0.08, "y": 0.14, "w": 0.84, "h": 0.30 },
      "por_que_ahi": "por qué la ventana va en ese lugar (qué no tapa)"
    }
  ],
  "nota_para_el_humano": "una o dos frases sobre la dirección elegida"
}
La ventana va en fracciones del cuadro completo (0 a 1): x, y = esquina superior izquierda. Mínimo 0.2 de ancho y 0.1 de alto.`;
}

export function motionPrompt({ direction, clip, index, total, box, video }) {
  const plan = (direction.clips || []).find((c) => c.id === clip.id) || {};
  const boxPx = { w: Math.round(box.w * video.width), h: Math.round(box.h * video.height) };
  return `# ENCARGO: motion design del ${clip.id}

## Sistema visual del Director de Arte (obligatorio, compartido con los otros clips)
\`\`\`json
${JSON.stringify({ concepto: direction.concepto, arco: direction.arco, sistema: direction.sistema }, null, 2)}
\`\`\`

## Tu clip, según el Director de Arte
\`\`\`json
${JSON.stringify(plan, null, 2)}
\`\`\`

${clipBrief(clip, index, total)}

## La ventana
Por defecto: ${fmtBox(box)} → ${boxPx.w}×${boxPx.h} px (proporción ${(boxPx.w / boxPx.h).toFixed(2)}). El humano la puede mover y redimensionar: diseñá para esta proporción pero que funcione en cualquier otra.
El clip dura ${(clip.end - clip.start).toFixed(2)} s: \`env.dur\` = ${(clip.end - clip.start).toFixed(2)}. Todo termina antes de ese momento.

Después de este texto vienen los cuadros del clip (rotulados con su segundo relativo al clip) y las referencias visuales.

Esquema JSON exacto (antes del código):
{
  "idea": "la idea del clip en una frase",
  "linea_de_tiempo": [{ "t": 0.2, "que_pasa": "qué hace el motion en ese segundo y con qué evento del video coincide" }],
  "nota_para_el_humano": "una frase: qué va a ver y qué conviene ajustar si algo no le gusta"
}

Y después, el bloque \`\`\`js con setup (opcional) y draw.`;
}

export function revisionPrompt({ feedback, error }) {
  return error
    ? `El código falló al ejecutarse en el reproductor con este error:\n\n${error}\n\n${feedback ? `Además, el humano pide: ${feedback}\n\n` : ''}Corregilo sin perder la idea ni el sistema visual. Respondé con el mismo formato completo: notas breves, el bloque \`\`\`json y el bloque \`\`\`js con el código COMPLETO.`
    : `El humano vio el resultado y pide este cambio:\n\n${feedback}\n\nRehacé el clip aplicando el cambio, sin salirte del sistema visual (coherencia con los otros clips). Si el pedido contradice el sistema, priorizá el pedido pero con la paleta, las tipografías y la gramática del sistema. Respondé con el mismo formato completo: notas breves, el bloque \`\`\`json y el bloque \`\`\`js con el código COMPLETO.`;
}

// ---------- Lectura de la respuesta del Motion Designer: JSON + código ----------
const CODE_FENCE = /```(?:js|javascript)[ \t]*\r?\n([\s\S]*?)(?:```|$)/gi;

export function parseMotion(text) {
  const raw = typeof text === 'string' ? text : '';
  const blocks = [...raw.matchAll(CODE_FENCE)];
  if (!blocks.length) {
    if (!raw.trim()) throw new Error('el modelo no devolvió texto');
    throw new Error('falta el bloque ```js con el código (quizás quedó cortado)');
  }
  const last = blocks.at(-1);
  const closed = last[0].trimEnd().endsWith('```') && last[0].length > 6;
  if (!closed) throw new Error('el bloque ```js quedó cortado');
  const code = last[1].trim();
  checkMotionCode(code);
  // El JSON va antes del código; si falta o viene roto, seguimos igual con lo esencial (el código).
  let meta = {};
  try { meta = extractJson(raw.slice(0, last.index)); } catch { meta = {}; }
  return { ...meta, code };
}

// Lo que se le pide al modelo cuando la respuesta no sirve.
export function motionFix(message, cortado) {
  return `Tu respuesta no se puede usar (${message}). Devolvé de nuevo SOLO el bloque \`\`\`json y el bloque \`\`\`js con el código COMPLETO y corregido, sin notas${cortado ? '. Hacé el código más corto para que entre entero' : ''}.`;
}
