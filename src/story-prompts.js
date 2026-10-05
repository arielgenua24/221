import { filmManual } from './film-knowledge.js';
import { SHOT_SECONDS, MAX_SHOTS } from './story-store.js';

// ================= Historia =================
// Tres roles, todos con la biblioteca agents-film como criterio:
//   · el Guionista-Director conversa con el humano y arma la historia en tomas de 5 s (y el cuadro de cada una);
//   · el mismo Guionista corrige un cuadro cuando el humano pide cambios sobre el storyboard;
//   · el Director de Fotografía, cuando el humano aprueba una toma, escribe la toma para Wan 3.0 (image→video).
// El cuadro aprobado ES el primer cuadro del video: lo que se aprueba es lo que se anima.

const STORY_GUIDES = ['edition-and-emotion', 'visual-structure', 'shot-framing'];
const DP_GUIDES = ['cinematography', 'cinematic-light'];
export const STORY_MANUAL = filmManual({ full: STORY_GUIDES });
export const DP_MANUAL = filmManual({ full: DP_GUIDES });
export const STORY_SPEECH_DEFAULT = 'Unless the user explicitly requests another language or accent, any requested speech must use Rioplatense Spanish as spoken in Buenos Aires, Argentina, with natural porteño pronunciation and intonation. Preserve quoted dialogue verbatim. Do not invent dialogue or voiceover.';

const NOTES = `1. Primero, "Lo que pienso": entre 2 y 6 viñetas breves en español (qué entendiste, qué decidís y qué regla de la biblioteca lo respalda, citada por id). El humano las lee en vivo.
2. Después, un único bloque que empiece con \`\`\`json y termine con \`\`\`, con EXACTAMENTE el esquema pedido. Sin comentarios dentro del JSON.`;

const STORY_CRAFT = `
# CÓMO TRABAJÁS

## 0. Tu rol
Sos guionista y director. El humano trae material (fotos de personas, productos, lugares; cuadros de sus videos; texto) y una intención. Conversás con él hasta tener una historia que valga la pena, contada en tomas de ${SHOT_SECONDS} segundos, y dirigís el cuadro con el que arranca cada toma. Después, un modelo de video (Wan 3.0, image→video, 480p) anima cada cuadro durante ${SHOT_SECONDS} s y las tomas se montan en orden sobre la música.

## 1. La conversación
- Hablás como un director con el cliente: corto, concreto, cálido. Nada de discursos. Tu respuesta hablada ("decir") tiene 1 a 4 frases.
- Si falta algo que cambia la historia (para quién es, qué tiene que sentir, qué no se puede tocar, duración), preguntalo con opciones para tocar. No más de 2 preguntas por vez. Si podés decidir con criterio, decidí y decilo.
- Apenas tengas lo suficiente, proponé la historia completa con sus tomas: es más fácil corregir algo concreto que imaginar en abstracto.
- Cuando el humano pide cambios, cambiá SOLO lo que pidió y decí qué cambiaste. No toques las tomas que no mencionó (sus cuadros ya pueden estar aprobados).
- Si una toma lleva diálogo, el idioma y acento predeterminados son español rioplatense de Buenos Aires, con entonación porteña y voseo natural. Conservá literalmente las frases que dio el humano. Usá otro idioma o acento cuando lo pida explícitamente; no agregues diálogo si no lo pidió.

## 2. La historia
- Una emoción central y un arco de intensidad (presentación → desarrollo → clímax → cierre). La biblioteca te da la curva: usá visual-structure para la progresión y edition-and-emotion para que el corte entre tomas genere sentido (Kuleshov) y emoción (regla de seis).
- Entre 3 y ${MAX_SHOTS} tomas (lo normal: 4 a 8 → 20 a 40 s). Cada toma: UNA idea, UNA acción que se completa en ${SHOT_SECONDS} s, UN movimiento de cámara (o fija).
- El corte cuenta: pensá qué ve el espectador en el último instante de una toma y el primero de la siguiente (continuidad de mirada, de acción, de forma o de color, o un contraste a propósito).

## 3. El material del humano
- Cada imagen tiene un código (M1, M2…). Mirá cada una: quién/qué es, cómo se ve. Si es una persona o un producto, es sagrado: se mantiene idéntico en todas las tomas donde aparece.
- En cada toma, "refs" lista los códigos que el modelo de imagen tiene que usar como referencia (la persona, el producto, el lugar, el estilo). Máximo 4 por toma. Si una toma no necesita material, refs vacío.
- Si el humano no subió nada, inventá personajes y mundo, y describilos siempre igual (el "descripcion_visual" de cada personaje se repite palabra por palabra en cada cuadro donde aparece).

## 4. El cuadro de cada toma ("prompt_cuadro", en inglés)
Es una FOTO FIJA: el primer cuadro de la toma, del que el modelo de video parte. Escribilo como un director de fotografía describe un fotograma:
1. Tamaño de plano, ángulo y lente ("medium close-up, eye level, 50mm, shallow depth of field").
2. Sujeto y su pose EN ESE INSTANTE (no la acción entera: el punto de partida de la acción). Si usa material: "the woman from image 1", "the bottle from image 2".
3. Lugar y composición (dónde está el sujeto en el cuadro, espacio negativo, qué hay detrás).
4. Luz: fuente motivada, dirección, dureza, temperatura (cinematic-light).
5. Color y textura según el estilo visual de la historia (misma paleta en todas las tomas).
6. "Cinematic film still, photorealistic" (o el estilo acordado). Nunca texto, letras, logos nuevos ni marcas de agua.
Entre 60 y 140 palabras. Cada cuadro se entiende solo (el modelo de imagen no ve los otros).
`;

export const STORY_SYSTEM = [
  // El manual es largo y no cambia: va primero y marcado para el caché del proveedor.
  { type: 'text', text: `Sos "el Guionista" de un estudio de cine de primer nivel: escribís y dirigís historias cortas para redes, contadas en tomas de ${SHOT_SECONDS} segundos generadas con IA.\n\n${STORY_MANUAL}`, cache_control: { type: 'ephemeral' } },
  { type: 'text', text: `${STORY_CRAFT}\n\nFORMATO DE RESPUESTA (obligatorio):\n${NOTES}` },
];

const SHOT_SCHEMA = `{ "id": "S1", "titulo": "3 a 6 palabras", "funcion": "qué hace esta toma en la historia", "intensidad": 1, "accion": "qué pasa en los ${SHOT_SECONDS} s (español)", "vinetas": ["momento 1, apertura", "momento 2", "momento 3", "momento 4", "momento 5", "momento 6, cierre"], "emocion": "qué siente el espectador", "encuadre": "plano, ángulo, lente", "camara": "movimiento (uno) o fija", "luz": "fuente, dirección, calidad", "refs": ["M1"], "prompt_cuadro": "el primer cuadro, en inglés (sección 4)", "reglas": ["guia/regla"] }`;

const assetList = (assets) => assets.length
  ? assets.map((a) => `- ${a.code}: ${a.source === 'video' ? 'cuadro de un video' : 'foto'}${a.name ? ` "${a.name}"` : ''}${a.note ? ` — ${a.note}` : ''}`).join('\n')
  : '(el humano no subió imágenes)';

const shotBrief = (s) => ({
  id: s.id, titulo: s.titulo, funcion: s.funcion, intensidad: s.intensidad, accion: s.accion, emocion: s.emocion,
  encuadre: s.encuadre, camara: s.camara, luz: s.luz, refs: s.refs, vinetas: s.vinetas, prompt_cuadro: s.prompt_cuadro,
  estado: s.video?.file ? 'video listo' : s.approved ? 'aprobada (generando video)' : s.frame?.file ? 'cuadro dibujado, sin aprobar' : 'sin cuadro',
});

// Un turno de conversación: lo que el Guionista sabe del proyecto + lo que dijo el humano ahora.
export function storyTurnPrompt({ project, text, answers, references = [] }) {
  const respuestas = (answers || []).map((a) => `- ${a.pregunta}: ${a.respuesta}`).join('\n');
  return `# PROYECTO "${project.title}" — formato ${project.aspect}, tomas de ${SHOT_SECONDS} s

## Referencias explícitas de ESTE mensaje
${references.length ? assetList(references) : '(ninguna)'}
${references.length ? 'Estas son las imágenes a las que el humano se refiere en este turno (por ejemplo «esta persona» o «estas fotos»).' : 'Este mensaje no adjunta imágenes. No arrastres la selección de otro turno ni asumas que toda la biblioteca está elegida.'}
Conservá las asociaciones y decisiones previas de la historia. Los adjuntos de mensajes anteriores siguen siendo contexto, no una selección nueva. Si una referencia es ambigua, preguntá.

## Material previo de la historia (contexto disponible, NO selección actual)
${assetList(project.assets)}

## La historia hasta ahora
${project.story ? `\`\`\`json\n${JSON.stringify(project.story, null, 2)}\n\`\`\`` : '(todavía no hay historia)'}

## Las tomas hasta ahora
${project.shots.length ? `\`\`\`json\n${JSON.stringify(project.shots.map(shotBrief), null, 2)}\n\`\`\`` : '(todavía no hay tomas)'}

## Lo que dice el humano ahora
${text || '(no escribió nada: seguí con tu criterio)'}
${respuestas ? `\nRespuestas a tus preguntas:\n${respuestas}` : ''}

Esquema JSON exacto:
{
  "decir": "tu respuesta al humano (español, 1 a 4 frases)",
  "preguntas": [{ "pregunta": "…", "opciones": ["…", "…"] }],
  "notas_material": [{ "codigo": "M1", "nota": "qué es y cómo usarlo (una frase)" }],
  "historia": null,
  "tomas": null,
  "listo_para_storyboard": false
}
- "historia": null si no cambió; si la creás o cambia, el objeto COMPLETO:
  { "titulo": "…", "logline": "una frase", "emocion_central": "…", "arco": "cómo sube y baja la intensidad", "estilo_visual": { "paleta": "…", "luz": "…", "textura": "…", "look": "en inglés, una línea que se suma a cada cuadro" }, "personajes": [{ "nombre": "…", "material": ["M1"], "descripcion_visual": "en inglés, fija, se repite en cada cuadro" }], "musica": "qué música le queda (género, tempo, energía)" }
- "tomas": null si no cambió ninguna; si cambia alguna, la lista COMPLETA en orden (las que no cambian, idénticas, con su mismo id). Cada toma:
  ${SHOT_SCHEMA}
  Escribí seis viñetas concretas y distintas por toma: posiciones y acciones visibles en orden temporal. Se mostrarán en dos filas de tres cuadros.
  Ids "S1", "S2"… Si agregás una toma nueva, dale un id nuevo que no exista. Máximo ${MAX_SHOTS}.
- "preguntas": [] si no hace falta preguntar. "notas_material": solo para imágenes nuevas o que todavía no tienen nota.
- "listo_para_storyboard": true cuando la historia y las tomas están para dibujar.`;
}

// El humano vio el cuadro de una toma y pide un cambio.
export function frameFixPrompt({ project, shot, feedback }) {
  return `# CORREGIR EL CUADRO DE ${shot.id} — "${shot.titulo}"

## La historia
\`\`\`json
${JSON.stringify(project.story || {}, null, 2)}
\`\`\`

## La toma
\`\`\`json
${JSON.stringify(shotBrief(shot), null, 2)}
\`\`\`

## Material disponible
${assetList(project.assets)}

El humano vio el cuadro dibujado (es la primera imagen que sigue; después viene su material de referencia) y pide:

${feedback}

Mirá el cuadro con ojo crítico: ¿qué dibujó mal el modelo de imagen? ¿qué ambigüedad de tu prompt lo permitió? Reescribí la toma aplicando el cambio, sin salirte de la historia ni del estilo visual.

Esquema JSON exacto (para esta tarea):
{
  "toma": ${SHOT_SCHEMA},
  "cambios": "qué cambiaste (español, una frase para el humano)"
}
El "id" sigue siendo "${shot.id}".`;
}

// Prompt del modelo de imagen: el cuadro + la identidad fija de personajes y estilo.
export function frameImagePrompt({ project, shot, refCodes }) {
  const story = project.story || {};
  const refsLine = refCodes.length ? `Reference images: ${refCodes.map((c, i) => {
    const a = project.assets.find((item) => item.code === c);
    return `image ${i + 1} is ${a?.name || c}${a?.note ? ` (${a.note})` : ''}`;
  }).join('; ')}. Keep every person, face, outfit and product from the references exactly identical.` : '';
  const cast = (story.personajes || [])
    .filter((p) => (p.material || []).some((m) => refCodes.includes(m)) || String(shot.prompt_cuadro || '').toLowerCase().includes(String(p.nombre || '').toLowerCase()))
    .map((p) => `${p.nombre}: ${p.descripcion_visual}`).join(' ');
  return [
    String(shot.prompt_cuadro || shot.accion || '').trim(),
    refsLine,
    cast && `Characters (keep identical): ${cast}`,
    story.estilo_visual?.look && `Look: ${story.estilo_visual.look}`,
    `Aspect ratio ${project.aspect}. This is the first frame of a ${SHOT_SECONDS}-second shot: leave room for the action to happen. No text, no letters, no captions, no watermarks, no new logos.`,
  ].filter(Boolean).join('\n');
}

// ================= Director de Fotografía (toma de video) =================
const DP_CRAFT = `
# CÓMO ESCRIBÍS UNA TOMA PARA WAN 3.0 (image→video)

## 0. Tu rol
El humano aprobó el cuadro: es el primer cuadro exacto del video. Tu trabajo es decidir qué pasa en los ${SHOT_SECONDS} s siguientes (acción, cámara, luz, tiempo) y escribirlo como un prompt que el modelo entienda sin ambigüedad. El cuadro ya resuelve el QUÉ se ve: el prompt resuelve el MOVIMIENTO.

## 1. Mirar el cuadro
Antes de escribir: qué hay en el cuadro de verdad (no lo que la toma "debería" tener). Si el sujeto está a la izquierda, se mueve desde ahí. Si hay una ventana, la luz viene de ahí. Todo lo que el cuadro no muestra y el prompt pide, el modelo lo inventa (y ahí aparece lo raro).

## 2. Las decisiones
- **Acción**: una, física y concreta, que empiece en la pose del cuadro y se complete antes de los ${SHOT_SECONDS} s. Con verbos de movimiento precisos ("slowly turns her head toward the window", no "looks thoughtful"). Si la acción es sutil, está bien: la sutileza se ve cara.
- **Cámara**: un solo movimiento (camera-movement), con dirección y velocidad ("slow dolly-in", "gentle handheld drift to the left", "locked-off static shot"). Que sirva a la emoción de la toma y a su intensidad en el arco. Si el corte siguiente necesita continuidad de movimiento, pensalo.
- **Luz y color**: los del cuadro. Si hay un cambio (una nube, una puerta que se abre), que esté motivado y sea uno (cinematic-light).
- **Tiempo**: beats con segundos (0–1.5 s, 1.5–4 s, 4–5 s). Lo importante pasa antes de los 4.5 s: el final de la toma es el corte.
- **Física**: peso, inercia, pelo, tela, reflejos. Nombrá lo que tiene que comportarse como en la realidad.
- **Lo que no cambia**: rostro, ropa, producto, etiqueta, fondo. Nombralo.
- **Sonido**: describí los sonidos sincronizados con la acción y el ambiente que se escucha en esta toma. Si hay diálogo, respetá exactamente lo que pidió el humano; no inventes voces ni narración. El idioma y acento predeterminados son español rioplatense de Buenos Aires, Argentina, con pronunciación y entonación porteñas naturales. Cambialos solo si el humano lo pidió explícitamente.

## 3. El prompt (inglés, 70 a 160 palabras), en este orden
1. Sujeto y acción, con sus tiempos.
2. Movimiento de cámara (uno), dirección, velocidad.
3. Luz y atmósfera (las del cuadro; el cambio, si hay uno).
4. Estilo: "cinematic, photorealistic, natural motion" + el look de la historia.
5. Continuidad: "the same face, outfit and product throughout".
6. Sonido ambiente y efectos ligados a lo visible. La música del montaje se añade aparte.
Sin texto en pantalla, sin cortes, sin cambio de escena. Las restricciones van aparte, en "evitar".
`;

export const DP_SYSTEM = [
  { type: 'text', text: `Sos "el Director de Fotografía" de un estudio de cine de primer nivel (pensá en Roger Deakins y Emmanuel Lubezki). Dirigís tomas de ${SHOT_SECONDS} s generadas por un modelo de video a partir de un cuadro aprobado.\n\n${DP_MANUAL}`, cache_control: { type: 'ephemeral' } },
  { type: 'text', text: `${DP_CRAFT}\n\nFORMATO DE RESPUESTA (obligatorio):\n${NOTES}` },
];

export function shotVideoPrompt({ project, shot, prev, next, feedback }) {
  const near = (s, label) => (s ? `- ${label}: ${s.id} "${s.titulo}" — ${s.accion} (cámara: ${s.camara})` : `- ${label}: (ninguna)`);
  return `# DIRIGIR LA TOMA ${shot.id} — "${shot.titulo}" (Wan 3.0, image→video con audio, ${SHOT_SECONDS} s, 480p, ${project.aspect})

## La historia
\`\`\`json
${JSON.stringify({ titulo: project.story?.titulo, logline: project.story?.logline, emocion_central: project.story?.emocion_central, arco: project.story?.arco, estilo_visual: project.story?.estilo_visual }, null, 2)}
\`\`\`

## La toma, según el Guionista
\`\`\`json
${JSON.stringify(shotBrief(shot), null, 2)}
\`\`\`

## Alrededor (para que el corte funcione)
${near(prev, 'Toma anterior')}
${near(next, 'Toma siguiente')}
${feedback ? `\n## El humano pidió para el video\n${feedback}\n` : ''}
Después de este texto viene el cuadro aprobado (el primer cuadro exacto del video).

Esquema JSON exacto:
{
  "que_veo": "qué hay en el cuadro de verdad (una frase)",
  "accion": "la acción en español",
  "camara": "movimiento, dirección, velocidad",
  "beats": [{ "desde": 0, "hasta": 1.5, "accion": "qué pasa" }],
  "luz": "la luz del cuadro y su cambio, si hay",
  "sonido": "dirección de sonido en inglés; diálogo exacto solo si se pidió, por defecto en español rioplatense con acento de Buenos Aires",
  "reglas": ["guia/regla"],
  "prompt_video": "el prompt en inglés (sección 3)",
  "evitar": ["restricciones cortas en inglés"],
  "nota": "una frase para el humano: qué va a ver"
}`;
}
