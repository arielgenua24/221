import { readFileSync } from 'node:fs';
import { FONTS, HELPER_DOCS, checkMotionCode } from '../public/motion-lib.js';
import { SOUND_DOCS } from '../public/sound-lib.js';
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

const NOTES_PROTOCOL = `1. Primero escribí "Lo que veo y lo que propongo": entre 3 y 8 viñetas breves en español. El humano las ve en vivo: tienen que ser concretas (qué ves en los cuadros y en qué segundo, qué proponés y por qué). Nada de relleno.`;

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
Tu trabajo NO es animar: es MIRAR el video y definir el SISTEMA VISUAL que va a unir los tres clips (paleta, tipografías, gramática de movimiento, motivo recurrente, familia de sonidos) y la idea de cada clip, para que tres Motion Designers trabajando en paralelo produzcan tres piezas que parezcan hechas por la misma mano.
También decidís dónde va por defecto la "ventana" del overlay en cada clip (el humano después la puede mover), fuera de caras, del producto y de las zonas de la interfaz de las redes.
Respetás lo que pide el humano en cada clip: tu criterio decide CÓMO, no QUÉ.

${MOTION_MANUAL}
${JSON_PROTOCOL}`;

export const MOTION_SYSTEM = `Sos "el Motion Designer" de un estudio de primer nivel. Escribís motion design como código (Canvas 2D) que se dibuja encima de un clip de video vertical.
Recibís el sistema visual del Director de Arte (paleta, tipografías, gramática de movimiento, motivo, sonido) y el encargo de UN clip: sus cuadros con el segundo de cada uno, lo que pide el humano y sus referencias.
Tu vara es la de un motion designer senior: timing preciso, easing con intención, tipografía impecable, una idea clara, sincronizada con lo que pasa en el video. Nada genérico. También diseñás el sonido del clip: una partitura corta de efectos, sincronizada al cuadro con tu animación.
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
- Técnica: ${clip.mode === 'ai' ? 'VIDEO IA + CAPA DE TEXTO — la imagen de este tramo se reemplaza por una toma generada por IA a partir de un cuadro real del clip (la dirige el Director de Video IA); encima solo se animan palabras. La ventana es la de ese texto.' : 'motion design como código (Canvas 2D) encima del video original.'}
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
2. Definí UN sistema visual para los tres clips (sección 9 del manual). Paleta de 2 a 4 colores (hex) que pertenezca al video; tipografías SOLO de esta lista: ${Object.keys(FONTS).join(', ')}. Y una familia de sonidos (sección 12 del manual) elegida de este catálogo de efectos sintetizados, que suenan encima del audio original:
${SOUND_DOCS}
3. Para cada clip: su idea en una frase (en los clips de VIDEO IA, la idea es la toma que se va a generar + las palabras encima) (respetando el pedido del humano), su rol en el arco (presenta / desarrolla / remata), el evento del video con el que se sincroniza, y la ventana por defecto.

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
    "evitar": ["qué NO hacer en este video en particular"],
    "sonido": {
      "caracter": "cómo suena el sistema en una frase (ej. preciso y seco, cálido y suave)",
      "efectos": ["2 a 5 efectos del catálogo que forman la familia"],
      "audio_original": "qué hay en el audio del video (voz, música, ambiente) según lo que ves, y cuánto espacio deja",
      "volumen": "bajo | medio | alto, según el audio original"
    }
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
  "sonido": [{ "t": 0.2, "efecto": "whoosh", "dur": 0.4, "tono": "medio", "vol": 0.5, "pan": 0 }],
  "nota_para_el_humano": "una frase: qué va a ver y qué conviene ajustar si algo no le gusta"
}

"sonido" es la partitura del clip (sección 12 del manual), con efectos de la familia del sistema (\`sistema.sonido\`). Catálogo:
${SOUND_DOCS}
Campos de cada evento: "t" (segundo del clip en que arranca; el mismo t del keyframe que acompaña), "efecto" (del catálogo), "dur" (solo en los que lo admiten), "tono" ("grave" | "medio" | "agudo", o semitonos de -24 a 24), "vol" (0 a 1), "pan" (-1 izquierda a 1 derecha; opcional), y opcionalmente "repetir" + "cada" (s) para rachas (ej. una tecla por letra). Entre 2 y 6 eventos. [] si el clip pide silencio.

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

// ================= Video IA + capa de texto =================
// En estos clips Opus no anima: DIRIGE. Escribe con obsesión de detalle cómo tiene que ser la toma,
// un modelo de video la genera a partir de un cuadro real del clip, y encima solo se animan palabras.

export const VIDEO_CRAFT = `
# MANUAL DE DIRECCIÓN PARA VIDEO GENERADO POR IA

## 0. Tu rol
No animás: dirigís. Tu materia prima es el lenguaje. Un modelo de video (image→video) va a partir de UN cuadro real del clip y va a inventar el movimiento a partir de tu prompt. Todo lo que no escribas lo decide el modelo al azar. Sos perfeccionista: cada palabra del prompt existe para eliminar una ambigüedad.

## 1. Elegir el cuadro base
- Es el PRIMER cuadro del video generado: tiene que ser nítido (sin barrido de movimiento), bien expuesto, con el sujeto entero y en una pose "de arranque" (no a mitad de un gesto que no se puede continuar).
- Preferí el cuadro desde el que la acción que querés tiene espacio para ocurrir (si el producto va a girar, que no esté cortado por el borde).

## 2. Una sola toma continua
- El clip dura como máximo 5 s: UNA toma, SIN cortes, sin cambios de escena, sin transiciones. Escribilo explícitamente.
- Una acción principal y, como mucho, una secundaria. Los modelos fallan cuando se les piden tres cosas en 5 s.
- Dividí la toma en 2 a 4 tiempos ("beats") con su segundo: el modelo respeta mejor un orden claro ("first…, then…, finally…").

## 3. Cómo se escribe el prompt de video (en INGLÉS: los modelos lo entienden mejor)
Orden fijo, en frases cortas y concretas:
1. **Sujeto y continuidad**: quién/qué es, tal como está en el cuadro base (ropa, colores, materiales, producto, logo). "Keep the exact same person / product / setting as the first frame."
2. **Acción** con verbos físicos precisos y velocidad ("slowly lifts the cup to eye level", no "interacts with the product").
3. **Cámara**: UN movimiento, con dirección y velocidad ("slow dolly-in", "gentle handheld drift", "locked-off static shot", "slow orbit 20° to the right"). Si la cámara está quieta, decilo.
4. **Lente y encuadre**: focal aproximada, profundidad de campo, altura de cámara.
5. **Luz**: fuente, dirección, dureza, temperatura; tiene que ser la MISMA luz del cuadro base (no cambies la hora del día).
6. **Color y textura**: el grading coherente con la paleta del sistema visual, grano, contraste.
7. **Ritmo y física**: peso, inercia, tela, líquido, pelo; nada flota ni se deforma.
8. **Tiempos**: los beats con sus segundos.
9. **Restricciones** (al final, como "Avoid: …"): texto en pantalla, letras, subtítulos, logos nuevos, marcas de agua, cortes, morphing, manos o dedos deformes, caras que cambian, producto que cambia de forma o de etiqueta, parpadeos de luz, cámara lenta si no la pediste.

## 4. Lo que el modelo hace mal (y cómo prevenirlo)
- **Texto**: los modelos escriben letras deformes. NUNCA pidas texto en el video: las palabras van en nuestra capa encima. Pedí además espacio negativo limpio donde irá el texto (cielo, pared, mesa).
- **Identidad**: caras, manos y productos derivan. Nombrá los rasgos que tienen que quedar idénticos.
- **Movimiento excesivo**: sin indicación, el modelo mueve todo. Pedí calma donde no hay acción.
- **Física**: líquidos, telas y pelo delatan a la IA. Describilos con detalle o evitá la acción.
- **Lo que está fuera del cuadro base no existe**: si algo tiene que aparecer, describilo con total precisión o no lo pidas.

## 5. El storyboard
Antes de gastar en el video, se dibuja un storyboard de viñetas (un modelo de imagen, a partir del cuadro base). Sirve para que el humano apruebe la idea. Cada viñeta: un instante con su segundo, el encuadre y la acción, dibujado como un storyboard profesional (no como el video final). Sin texto dentro de las viñetas, salvo el número.

## 6. Checklist del perfeccionista (antes de entregar)
1. ¿La toma se puede describir en una frase?
2. ¿El cuadro base es el mejor punto de partida para ESA acción?
3. ¿Hay exactamente un movimiento de cámara (o "static") con dirección y velocidad?
4. ¿La luz y el color son los del cuadro base y respetan la paleta del sistema?
5. ¿Nombré lo que NO puede cambiar (cara, manos, producto, etiqueta, ropa)?
6. ¿Dejé espacio negativo limpio donde va a ir el texto de nuestra capa?
7. ¿Prohibí texto, logos nuevos, cortes y deformaciones?
8. ¿Los beats suman la duración y la acción termina antes del final?
`;

export const VIDEO_DIRECTOR_SYSTEM = `Sos "el Director de Video IA" de un estudio de primer nivel: un director de fotografía y de comerciales obsesivo, perfeccionista hasta el último detalle.
En este clip el motion design NO se hace animando: se hace dirigiendo. Tu trabajo es escribir, con precisión absoluta, cómo tiene que ser la toma que va a generar un modelo de video (image→video) a partir de UN cuadro real del clip, y el storyboard que el humano va a aprobar antes de generar.
Encima del video generado, otro diseñador va a animar SOLO palabras: vos decidís qué dicen y dónde les dejás lugar.
Respetás el sistema visual del Director de Arte (paleta → grading, gramática de movimiento → ritmo de cámara) y lo que pide el humano: tu criterio decide CÓMO, no QUÉ.

${VIDEO_CRAFT}
${JSON_PROTOCOL}`;

export function videoDirectorPrompt({ direction, clip, index, total, video, model, seconds, layout }) {
  const plan = (direction.clips || []).find((c) => c.id === clip.id) || {};
  return `# ENCARGO: dirigir la toma generada por IA del ${clip.id}

## Sistema visual del Director de Arte (obligatorio)
\`\`\`json
${JSON.stringify({ concepto: direction.concepto, arco: direction.arco, sistema: direction.sistema }, null, 2)}
\`\`\`

## Tu clip, según el Director de Arte
\`\`\`json
${JSON.stringify(plan, null, 2)}
\`\`\`

${clipBrief(clip, index, total)}

## La técnica
- Modelo de video: ${model} (image→video). Va a generar ${seconds} s; en el video final se usan los primeros ${(clip.end - clip.start).toFixed(2)} s: la acción importante tiene que pasar ahí.
- Proporción: ${video.width}×${video.height} (se genera en la proporción más cercana).
- El audio original del video se mantiene: la toma generada es muda.
- Storyboard: ${layout.panels} viñetas en una grilla de ${layout.cols} columnas × ${layout.rows} filas.

Después de este texto vienen los cuadros del clip (numerados desde 0, con su segundo) y las referencias visuales.

Esquema JSON exacto:
{
  "cuadro_base": 0,
  "por_que_ese_cuadro": "por qué ese cuadro es el mejor punto de partida",
  "toma": "la toma en una frase (español)",
  "camara": "movimiento, dirección, velocidad, lente, altura",
  "luz_y_color": "luz del cuadro base + grading según la paleta",
  "beats": [{ "desde": 0, "hasta": 1.5, "accion": "qué pasa (español)" }],
  "continuidad": ["lo que no puede cambiar: rasgos, ropa, producto, etiqueta, fondo"],
  "espacio_para_texto": "dónde queda el espacio negativo limpio para las palabras de la capa",
  "prompt_video": "EL prompt en inglés, siguiendo el orden de la sección 3 (100 a 220 palabras)",
  "evitar": ["restricciones en inglés, cortas: 'on-screen text', 'new logos', 'cuts', ..."],
  "vinetas": [{ "n": 1, "t": 0, "encuadre": "plano y ángulo (inglés)", "accion": "qué se ve en ese instante (inglés)" }],
  "textos": ["las palabras exactas que va a animar la capa de texto (idioma del pedido)"],
  "nota_para_el_humano": "una o dos frases: qué va a ver en el storyboard y qué conviene mirar antes de aprobar"
}
"cuadro_base" es el número del cuadro del clip (desde 0). Exactamente ${layout.panels} viñetas, con "t" creciente dentro de los primeros ${(clip.end - clip.start).toFixed(2)} s.`;
}

export function videoRevisionPrompt({ feedback, prompt }) {
  return `El humano vio el storyboard (es la imagen que sigue) y ${feedback ? `pide este cambio:\n\n${feedback}` : 'no lo aprobó.'}${prompt ? `\n\nAdemás editó el prompt de video a mano; tomalo como punto de partida:\n\n${prompt}` : ''}

Mirá el storyboard con ojo crítico (¿qué dibujó mal el modelo de imagen?, ¿qué ambigüedad de tu prompt lo permitió?) y rehacé la dirección aplicando el cambio. Respondé con el mismo formato completo: notas breves y el bloque \`\`\`json con el esquema COMPLETO.`;
}

// Prompt para el modelo de imagen: una hoja de storyboard profesional a partir del cuadro base.
export function storyboardImagePrompt(plan, layout) {
  const panels = (plan.vinetas || []).slice(0, layout.panels);
  return `Create a professional film storyboard sheet: exactly ${layout.panels} panels arranged in a grid of ${layout.cols} columns and ${layout.rows} rows, read left to right, top to bottom. Each panel has the same aspect ratio as the reference photo, a thin dark border, and only its number (1–${layout.panels}) and time in seconds in a small corner label. No other text, no captions, no speech bubbles.
The reference image is the first frame of the shot: keep the exact same subject, clothing, product, setting, lighting and colors in every panel. Style: clean cinematic storyboard frames, realistic rendering faithful to the reference, consistent across panels.
Shot: ${plan.toma || ''}
Camera: ${plan.camara || ''}
Light and color: ${plan.luz_y_color || ''}
Panels:
${panels.map((v, i) => `${i + 1}. (${Number(v.t || 0).toFixed(1)}s) ${v.encuadre || ''} — ${v.accion || ''}`).join('\n')}`;
}

// El prompt que se manda al modelo de video: el de Opus + las restricciones.
export function finalVideoPrompt(plan) {
  const avoid = (Array.isArray(plan.evitar) ? plan.evitar : []).map((s) => String(s).trim()).filter(Boolean);
  const base = ['on-screen text', 'letters', 'subtitles', 'watermarks', 'new logos', 'cuts or scene changes', 'morphing', 'deformed hands', 'changing faces'];
  const all = [...new Set([...avoid, ...base.filter((b) => !avoid.some((a) => a.toLowerCase().includes(b.split(' ')[0])))])];
  return `${String(plan.prompt_video || '').trim()}\nSingle continuous shot, no cuts. Avoid: ${all.join(', ')}.`;
}

export const TEXT_LAYER_SYSTEM = `Sos "el Tipógrafo de Movimiento" de un estudio de primer nivel. Escribís código Canvas 2D que anima SOLO PALABRAS encima de una toma de video generada por IA.
La imagen ya la resolvió el Director de Video IA (una toma dirigida al detalle): vos no agregás imagen. Tu único material es la tipografía.
Permitido: letras y palabras animadas (revelados con máscara, cascadas, escala con golpe, tracking que se cierra…), y lo mínimo para que se lean: un velo suave de legibilidad y, si hace falta, un subrayado fino ligado al texto.
Prohibido: formas decorativas, partículas, marcos, íconos, líneas sueltas, fondos, cualquier cosa que no sea texto o su legibilidad. Sin partitura de sonido (el clip conserva su audio original).
Respetás el sistema visual al pie de la letra (paleta, tipografías, easing, gramática de entrada y salida): es lo que da coherencia con los otros clips.

${MOTION_MANUAL}
${RUNTIME_CONTRACT}
${CODE_PROTOCOL}`;

export function textLayerPrompt({ direction, clip, index, total, box, video, plan, generated }) {
  const art = (direction.clips || []).find((c) => c.id === clip.id) || {};
  const boxPx = { w: Math.round(box.w * video.width), h: Math.round(box.h * video.height) };
  const dur = (clip.end - clip.start).toFixed(2);
  return `# ENCARGO: capa de texto del ${clip.id} (encima de una toma generada por IA)

## Sistema visual del Director de Arte (obligatorio)
\`\`\`json
${JSON.stringify({ concepto: direction.concepto, sistema: direction.sistema }, null, 2)}
\`\`\`

## El clip según el Director de Arte
\`\`\`json
${JSON.stringify(art, null, 2)}
\`\`\`

## La toma, según el Director de Video IA (lo que se va a ver debajo de tus palabras)
\`\`\`json
${JSON.stringify({ toma: plan?.toma, camara: plan?.camara, beats: plan?.beats, espacio_para_texto: plan?.espacio_para_texto, textos: plan?.textos }, null, 2)}
\`\`\`

- Pedido del humano: ${clip.prompt || '(nada en particular)'}
- Notas de estilo: ${clip.notes || '(ninguna)'}

## La ventana
Por defecto: ${fmtBox(box)} → ${boxPx.w}×${boxPx.h} px (proporción ${(boxPx.w / boxPx.h).toFixed(2)}). El humano la puede mover y redimensionar.
El clip dura ${dur} s: \`env.dur\` = ${dur}. Todo termina antes de ese momento. Sincronizá las palabras con los beats de la toma.

${generated
    ? 'Después de este texto vienen cuadros REALES de la toma ya generada (rotulados con su segundo): usalos para ubicar y sincronizar el texto.'
    : 'Después de este texto vienen el cuadro base (el primer cuadro de la toma) y el storyboard aprobado: la toma todavía se está generando, así que guiate por los beats.'}

Esquema JSON exacto (antes del código):
{
  "idea": "qué dicen las palabras y cómo se mueven, en una frase",
  "linea_de_tiempo": [{ "t": 0.3, "que_pasa": "qué hace el texto y con qué beat de la toma coincide" }],
  "sonido": [],
  "nota_para_el_humano": "una frase: qué va a ver y qué conviene ajustar"
}

Y después, el bloque \`\`\`js con setup (opcional) y draw. SOLO texto (y su legibilidad).`;
}
