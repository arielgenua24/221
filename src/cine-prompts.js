import { filmManual } from './film-knowledge.js';
import { CINE_DOCS, EJES } from '../public/cine-lib.js';

// ================= Cinematic Pro =================
// El Director de Fotografía mira un clip REAL del humano y lo lleva a nivel cine sin perder lo que ya tiene
// (la actuación, el audio, el momento): diagnostica con la biblioteca agents-film y escribe un tratamiento
// que se aplica encima del video (grade, luz motivada, cámara virtual, textura). Si el clip no se salva
// con eso, propone re-filmarlo con IA (video→video): el humano decide.

// Las guías que el DP necesita enteras; del resto de la biblioteca recibe el catálogo de reglas.
const DP_GUIDES = ['cinematic-light', 'color-direction', 'camera-movement', 'shot-framing', 'camera-as-narrator', 'visual-structure'];
export const FILM_MANUAL = filmManual({ full: DP_GUIDES });

const CINE_CRAFT = `
# CÓMO TRABAJA UN DIRECTOR DE FOTOGRAFÍA SOBRE MATERIAL YA FILMADO

## 0. Tu rol
El humano ya filmó. Tu trabajo es que ESE clip se vea como cine sin traicionarlo: lo que la persona hace y dice, el lugar y el momento son sagrados. Trabajás como un colorista + DP en postproducción: mirás, diagnosticás, y aplicás el mínimo de intervenciones que más cambian la sensación. Cada decisión se justifica con la biblioteca (citá la regla por su id).

## 1. Mirar antes de tocar (diagnóstico)
Recorré los cuadros con los siete componentes visuales y con la luz:
- **Luz**: ¿de dónde viene (motivación)? ¿dura o suave? ¿el sujeto se separa del fondo? ¿hay una fuente práctica que puedas "encender" o reforzar?
- **Tono**: ¿el sujeto es lo más legible? ¿negros empastados, altas luces quemadas, todo gris?
- **Color**: ¿qué paleta tiene de verdad el lugar? ¿hay un dominante sucio (verde fluorescente, azul de pantalla) que conviene neutralizar o convertir en intención?
- **Encuadre y espacio**: ¿el tamaño de plano sirve a lo que pasa? ¿un reencuadre (zoom 1.05–1.15) mejora la composición o la distancia emocional?
- **Movimiento**: ¿la cámara ya se mueve? Si ya se mueve, no le sumes otro movimiento que pelee; si está quieta y el momento lo pide, un push-in o drift lento puede sumar intención.
- **Intensidad**: ¿qué rol tiene este clip en el video (presenta, desarrolla, remata)? El tratamiento acompaña esa curva.

## 2. Las herramientas (y su límite honesto)
- **Grade**: es tu herramienta principal. Balance (temperatura/tinte), contraste, saturación, split toning (sombras y luces con color), negros levantados para un look fílmico. Siempre relativo a la paleta del sistema visual del Director de Arte: el grade es cómo esa paleta vive en la imagen.
- **Luz motivada**: una fuente suave agregada (key, luz de ventana, contraluz, práctica, un barrido lento) o una "sombra" (negative fill) que baja una zona para dar forma. Tiene que tener motivación en la escena (una ventana, una lámpara, el sol, una pantalla). Si no hay de dónde justificarla, no la uses.
- **Cámara virtual**: reencuadra el cuadro real (zoom, desplazamiento, rotación mínima, temblor de mano). No inventa imagen: más de 1.15 de zoom pierde definición en un video de celular. Sirve para push-ins lentos de intención, drifts, estabilizar la mirada o darle vida a un plano muerto.
- **Textura**: grano, halation, viñeta. Son la firma fílmica: sutiles (grano 0.15–0.35, viñeta 0.2–0.45, halation solo si hay altas luces que lo justifiquen).
- **Transición**: el tratamiento entra y sale en los bordes del clip. Si el clip está en medio del video, una entrada/salida de 0.2–0.4 s evita un salto de color; si el clip es un momento de quiebre, el corte seco (0) puede ser la decisión.

## 3. Re-filmar con IA (el corazón de Cinematic Pro)
El humano viene a Cinematic Pro a RE-FILMAR su clip. Siempre escribís el plan de re-filmado; el humano decide si lo genera (paga él). El orden es:
1. **Contrato de intención** → 2. **storyboard dibujado a mano** (6 viñetas, 3 × 2) que el humano aprueba o corrige → 3. el modelo de video (Wan 3.0 Prime reference→video) re-filma la escena **siguiendo el storyboard aprobado**: es la fuente de la verdad.

### 3.1 El contrato de intención ("cambios")
Traducís el pedido del humano a una lista de cambios respecto del clip original. Cada cambio cae en UN eje:
${Object.entries(EJES).map(([k, [d]]) => `- "${k}": ${d}`).join('\n')}
Por cada cambio: "pedido" (las palabras del humano, textual), "interpretacion" (qué vas a hacer, concreto, en español), "en_ingles" (ese cambio descrito para el modelo de video, una o dos frases visuales), "otra_lectura" (otra interpretación razonable de las mismas palabras, en español; vacío si no hay) y "confianza".
- Los cambios que proponés VOS (por ejemplo, una luz nueva que el humano no pidió) también van en la lista, con "pedido": "(propuesta del DP)". Lo que no aparece en ningún eje se conserva tal cual: si la luz cambia, tiene que estar en la lista.
- **Ambigüedad**: si las palabras admiten dos lecturas que darían tomas distintas, escribí "otra_lectura" y NO elijas en silencio: el humano elige antes de dibujar. El caso típico es un dispositivo de cámara ("cámara espía", "como una cámara de seguridad", "dron"): ¿la toma se VE a través de él (punto_de_vista) o el dispositivo APARECE en escena (elementos)? Mirá la guía \`camera-as-narrator\`: casi siempre es punto de vista.
- Si hay un cambio de punto_de_vista, la cámara es NUEVA: describí con precisión su posición física (dónde está, a qué altura, hacia dónde mira), la lente, la estabilidad y la textura.

### 3.2 Las viñetas ("vinetas")
Exactamente 6 viñetas de la toma RE-FILMADA (no del clip original), repartidas de 0 a la duración del clip, EN INGLÉS (las leen el dibujante y el modelo de video): su segundo, el encuadre (tamaño de plano, ángulo, lente, desde dónde se ve) y lo que pasa. Tienen que mostrar todos los cambios: si cambia el punto de vista, todas las viñetas se ven desde la cámara nueva.

### 3.3 El resto del plan
- "prompt": detalles visuales en INGLÉS que completan los cambios (luz con su motivación, atmósfera, color, textura fílmica), 40–100 palabras. No repitas lo que se conserva ni escribas encabezados: el sistema arma el prompt final con el storyboard, los cambios y lo que se conserva.
- "evitar": lo que no puede aparecer (on-screen text, new logos, face changes, extra fingers, flicker, morphing…).
- "sobre_toma": qué del tratamiento va encima de la toma re-filmada: "textura" (lo normal), "completo" o "nada".

## 4. Checklist antes de entregar
1. ¿Cada intervención responde a algo concreto que viste en los cuadros (componente + segundo)?
2. ¿Respetás la paleta del sistema visual y el pedido del humano?
3. ¿La piel se ve como piel? (no la tiñas de verde ni la satures de naranja; el split toning va sobre sombras/luces, no sobre la cara)
4. ¿La luz agregada tiene motivación y dirección coherente con la luz real del cuadro?
5. ¿El movimiento de cámara no pelea con el que ya existe? ¿el zoom no pasa de 1.15 salvo razón fuerte?
6. ¿Menos es más? Quitá la intervención que menos aporta.
`;

const NOTES = `1. Primero escribí "Lo que veo y lo que propongo": entre 3 y 8 viñetas breves en español, concretas (qué ves en los cuadros y en qué segundo, qué cambiás y qué regla de la biblioteca lo respalda). El humano las lee en vivo.
2. Después, un único bloque que empiece con \`\`\`json y termine con \`\`\`, con EXACTAMENTE el esquema pedido. Sin comentarios dentro del JSON.`;

export const CINE_SYSTEM = [
  // El manual es largo y no cambia: va primero y marcado para el caché del proveedor (Anthropic vía OpenRouter).
  { type: 'text', text: `Sos "el Director de Fotografía" de un estudio de primer nivel (pensá en Roger Deakins, Hoyte van Hoytema, y en los coloristas de Company 3), trabajando en postproducción sobre clips cortos de video para redes. Conservá el formato original del video (horizontal, vertical o cuadrado); no lo conviertas automáticamente a 9:16.\n\n${FILM_MANUAL}`, cache_control: { type: 'ephemeral' } },
  { type: 'text', text: `${CINE_CRAFT}\n\nFORMATO DE RESPUESTA (obligatorio):\n${NOTES}` },
];

function brief(clip, index, total) {
  const refs = clip.refs.length ? clip.refs.map((r) => `  - ${r.id}: ${r.kind === 'video' ? 'video/GIF' : 'imagen'} de referencia${r.name ? ` "${r.name}"` : ''}`).join('\n') : '  (ninguna)';
  return `## ${clip.id} — clip ${index + 1} de ${total} (${clip.start.toFixed(2)} s → ${clip.end.toFixed(2)} s del video; dura ${(clip.end - clip.start).toFixed(2)} s)
- Pedido del humano: ${clip.prompt || '(no escribió nada: llevalo a nivel cine con tu criterio)'}
- Notas de estilo: ${clip.notes || '(ninguna)'}
- Referencias visuales (looks a los que apunta):
${refs}
- Cuadros del clip: ${clip.frames.map((f) => `${f.t.toFixed(2)} s`).join(', ')} (relativos al inicio del clip).`;
}

export function cinePrompt({ direction, clip, index, total, video, refilm }) {
  const plan = (direction.clips || []).find((c) => c.id === clip.id) || {};
  const dur = (clip.end - clip.start).toFixed(2);
  return `# ENCARGO: llevar a nivel cine el ${clip.id} (Cinematic Pro)

## Sistema visual del Director de Arte (compartido con los otros clips del video)
\`\`\`json
${JSON.stringify({ concepto: direction.concepto, arco: direction.arco, lectura: direction.lectura, paleta: direction.sistema?.paleta, textura: direction.sistema?.textura, evitar: direction.sistema?.evitar }, null, 2)}
\`\`\`

## Tu clip, según el Director de Arte
\`\`\`json
${JSON.stringify({ idea: plan.idea, rol: plan.rol, sincronia: plan.sincronia }, null, 2)}
\`\`\`

${brief(clip, index, total)}

Video: "${video.name}", ${video.width}×${video.height}. El clip dura ${dur} s: todos los "t" van de 0 a ${dur}.
Re-filmar con IA: ${refilm ? 'DISPONIBLE: escribí siempre el plan de re-filmado completo (el humano aprueba antes de gastar).' : 'NO disponible en este servidor: resolvé todo con el tratamiento ("recomendado": false).'}

Después de este texto vienen los cuadros del clip (rotulados con su segundo) y las referencias visuales.

## Parámetros del tratamiento (el reproductor solo entiende esto)
${CINE_DOCS}

Esquema JSON exacto:
{
  "lectura": "qué ves: sujeto, lugar, luz real (fuente, dirección, dureza, temperatura), paleta, encuadre, si la cámara se mueve",
  "diagnostico": [{ "componente": "luz | tono | color | encuadre | espacio | movimiento | intensidad", "observacion": "qué ves (con el segundo)", "decision": "qué hacés al respecto (o por qué no lo tocás)" }],
  "intencion": "qué tiene que sentir quien mira este clip, en una frase",
  "reglas_aplicadas": [{ "id": "guía/regla exacto del catálogo", "por_que": "cómo se aplica acá" }],
  "grade": { "exposicion": 0, "contraste": 0.15, "saturacion": -0.1, "temperatura": 0.1, "tinte": 0, "sombras": { "hex": "#1E3A4C", "fuerza": 0.3 }, "luces": { "hex": "#F2C48D", "fuerza": 0.25 }, "negros": 0.04, "halation": 0.2, "vineta": 0.3, "grano": 0.2 },
  "luz": { "tipo": "ventana", "motivacion": "la ventana fuera de cuadro a la izquierda", "hex": "#FFD9A8", "radio": 0.7, "keyframes": [{ "t": 0, "x": -0.1, "y": 0.3, "fuerza": 0.25 }] },
  "camara": { "movimiento": "push-in lento", "easing": "inOutSine", "handheld": 0, "keyframes": [{ "t": 0, "zoom": 1.0, "x": 0, "y": 0, "rot": 0 }, { "t": ${dur}, "zoom": 1.08, "x": 0, "y": -0.2, "rot": 0 }] },
  "transicion": { "entrada": 0.3, "salida": 0.3 },
  "refilmar": {
    "recomendado": true,
    "cambios": [{ "eje": "punto_de_vista", "pedido": "las palabras del humano", "interpretacion": "qué vas a hacer", "en_ingles": "the change, described visually for the video model", "otra_lectura": "otra interpretación razonable, o vacío", "confianza": "alta | media | baja" }],
    "por_que": "qué gana este clip al re-filmarlo",
    "vinetas": [{ "t": 0, "encuadre": "shot size, angle, lens, where it is seen from (in English)", "accion": "what happens at that second (in English)" }],
    "prompt": "visual details in English: light with its motivation, atmosphere, color, texture",
    "preservar": ["lo que no puede cambiar, en español, para el humano"],
    "evitar": ["on-screen text", "face changes"],
    "sobre_toma": "textura"
  },
  "nota_para_el_humano": "una o dos frases: qué va a notar y qué conviene ajustar con el control de intensidad"
}
Los valores del ejemplo son solo formato: decidí cada uno mirando TUS cuadros.`;
}

export function cineRevisionPrompt({ feedback }) {
  return `El humano vio el clip con tu tratamiento y pide este cambio:\n\n${feedback}\n\nRehacé el tratamiento aplicando el cambio, sin perder lo que funcionaba ni salirte de la paleta del sistema. Respondé con el mismo formato completo: notas breves y el bloque \`\`\`json con el esquema COMPLETO.`;
}

// El humano vio el storyboard dibujado de la toma re-filmada y pide cambios: el DP rehace el plan.
export function cineStoryboardRevisionPrompt({ feedback, prompt = '', sheet = false }) {
  return `El humano vio el storyboard dibujado a mano de la toma re-filmada${sheet ? ' (es la imagen adjunta: 6 viñetas, 3 columnas × 2 filas)' : ''} y pide este cambio:

${feedback}
${prompt ? `\nAdemás editó a mano el prompt de re-filmado; tomalo como base:\n${prompt}\n` : ''}
Rehacé el plan de re-filmado aplicando el cambio: "refilmar" (prompt, vinetas, cambia_camara, preservar, evitar, sobre_toma) y, solo si el pedido lo necesita, el tratamiento. El pedido del humano manda; no pierdas lo que no pidió cambiar. Con tus viñetas nuevas se vuelve a dibujar el storyboard.
Respondé con el mismo formato completo: notas breves y el bloque \`\`\`json con el esquema COMPLETO.`;
}

// El prompt que se manda al modelo de re-filmado (reference→video). Lo arma el código, no el DP, en este orden:
//   1. el storyboard aprobado es la fuente de la verdad (Image 1), viñeta por viñeta
//   2. los cambios del contrato (lo más importante, primero)
//   3. para qué sirven las otras referencias (solo identidad; con Video 1 también movimiento y tiempos)
//   4. lo que se conserva = los ejes que no cambian (un cambio y un "conservar" no se pueden contradecir)
//   5. los detalles visuales del DP, cómo se renderiza y lo que se evita
// refs: { storyboard: bool, video: bool, frames: cantidad de cuadros del clip } — en el orden en que se mandan.
// tag: cómo nombra las referencias el modelo ('' → "Image 1" en Wan, '@' → "@Image 1" en Seedance).
export function refilmPrompt(refilmar, { treatment = {}, storyboard = false, video = true, frames = 1, tag = '' } = {}) {
  const changes = (refilmar.cambios || []).filter((c) => c.en_ingles?.trim());
  const changed = new Set(changes.map((c) => c.eje));
  if (refilmar.cambia_camara) changed.add('punto_de_vista');
  let img = 1;
  const board = storyboard ? `${tag}Image ${img++}` : null;
  const frameRefs = Array.from({ length: frames }, () => `${tag}Image ${img++}`);
  const panels = (refilmar.vinetas || []).filter((v) => v.encuadre || v.accion);
  const lines = [];

  if (board) lines.push(`${board} is the approved storyboard: ${panels.length || 6} hand-drawn panels in 3 columns and 2 rows, read left to right, top to bottom. It is the source of truth: re-shoot the scene so it matches the storyboard panel by panel — camera position, angle, lens, framing and action.`);
  if (changes.length) lines.push(`What changes from the original footage (most important):\n${changes.map((c) => `- ${c.en_ingles.trim()}`).join('\n')}`);
  if (panels.length) lines.push(`${board ? 'Storyboard panels' : 'Shot, beat by beat'}:\n${panels.map((v, i) => `${i + 1}. (${Number(v.t || 0).toFixed(1)} s) ${[v.encuadre, v.accion].filter(Boolean).join(' — ')}`).join('\n')}`);
  const sources = [...(video ? [`${tag}Video 1`] : []), ...frameRefs];
  if (sources.length) {
    const what = video && !changed.has('punto_de_vista') ? 'who the people are (faces, hair, clothing), the objects, the place, and the motion and timing of the action' : 'who the people are (faces, hair, clothing), the objects and the place';
    lines.push(`${sources.join(', ')} ${sources.length > 1 ? 'are' : 'is'} the original footage: use ${sources.length > 1 ? 'them' : 'it'} only for ${what}.${changed.has('punto_de_vista') ? ' Do NOT copy the original camera position, angle or framing: the camera is the new one described above.' : ''}`);
  }
  const keep = Object.entries(EJES).filter(([k]) => !changed.has(k)).map(([, [, en]]) => en);
  if (keep.length) lines.push(`Keep unchanged: ${keep.join('; ')}.`);
  const body = String(refilmar.prompt || '').trim()
    || `Cinematic, motivated light with real direction and soft falloff; filmic color and subtle film grain.${treatment.intencion ? ` Mood: ${treatment.intencion}.` : ''}`;
  lines.push(body);
  if (board) lines.push('Render it as photorealistic live-action footage like the original: never show storyboard panels, borders, numbers, pencil lines or a drawn style.');
  const avoid = [...new Set([...(refilmar.evitar || []), 'on-screen text', 'new logos', 'face changes', 'morphing', 'flicker', 'extra fingers'])];
  lines.push(`Avoid: ${avoid.join(', ')}.`);
  return lines.join('\n');
}

// El humano eligió entre las lecturas posibles de su pedido: el DP rehace el plan con esa elección.
export function cineIntentPrompt(choices) {
  return `Antes de dibujar, le preguntamos al humano qué quiso decir. Respondió:

${choices.map((c) => `- "${c.pedido}": ${c.texto}`).join('\n')}

Rehacé el plan completo con esa intención: "cambios" (eje correcto, interpretación, en_ingles; sin "otra_lectura" en lo que ya se aclaró), "vinetas" y "prompt", y el tratamiento si hace falta. Respondé con el mismo formato completo: notas breves y el bloque \`\`\`json con el esquema COMPLETO.`;
}

// Storyboard dibujado a mano de la toma re-filmada: UNA hoja de 3 columnas × 2 filas (para GPT Image edit,
// con cuadros del clip original como referencia de quiénes y qué hay en la escena).
export const STORYBOARD_GRID = { cols: 3, rows: 2, panels: 6 };
export function cineStoryboardPrompt({ refilmar, treatment = {}, dur, panelAspect }) {
  const { cols, rows, panels: n } = STORYBOARD_GRID;
  const given = refilmar.vinetas || [];
  const panels = Array.from({ length: n }, (_, i) => given[i] || { t: (i / (n - 1)) * dur, encuadre: '', accion: '' });
  const camera = refilmar.cambia_camara
    ? 'The camera is NEW: draw every panel from the new viewpoint and lens described below, NOT from the viewpoint of the reference photos.'
    : 'Same camera viewpoint as the reference photos.';
  return `Hand-drawn film storyboard sheet: exactly ${n} panels in a grid of ${cols} columns and ${rows} rows, read left to right, top to bottom, on white paper. Every panel has a ${panelAspect} aspect ratio and a thin hand-inked border; only its number (1–${n}) and time in seconds in a small corner label. No other text, captions or speech bubbles.
Style: a professional storyboard artist's pencil and ink sketch with grey marker shading, loose confident lines — NOT a photo, NOT a realistic render. Show the light direction with the shading, and draw small arrows only where the camera moves.
The reference photos are frames of the original clip: use them only for who and what is in the scene (people, faces, clothing, product, place). ${camera}
${(refilmar.cambios || []).some((c) => c.en_ingles) ? `What changes from the reference photos:\n${refilmar.cambios.filter((c) => c.en_ingles).map((c) => `- ${c.en_ingles}`).join('\n')}\n` : ''}Look: ${String(refilmar.prompt || treatment.intencion || '').trim().slice(0, 600)}
Panels:
${panels.map((v, i) => `${i + 1}. (${Number(v.t || 0).toFixed(1)}s) ${v.encuadre || ''}${v.accion ? ` — ${v.accion}` : ''}`).join('\n')}`;
}

// La proporción de la hoja más cercana entre las que acepta GPT Image (3 viñetas de ancho por 2 de alto).
const SHEET_RATIOS = ['1:3', '1:2', '9:16', '2:3', '3:4', '4:5', '1:1', '5:4', '4:3', '3:2', '16:9', '2:1', '21:9', '3:1'];
export function storyboardSheetAspect(width, height) {
  const target = (width / height) * (STORYBOARD_GRID.cols / STORYBOARD_GRID.rows);
  const val = (r) => { const [a, b] = r.split(':').map(Number); return a / b; };
  return SHEET_RATIOS.reduce((best, r) => (Math.abs(Math.log(val(r) / target)) < Math.abs(Math.log(val(best) / target)) ? r : best));
}
