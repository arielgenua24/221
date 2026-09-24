import { EFFECTS, TRANSITIONS } from './timeline.js';

// Manual compartido de edición guiada por la música (ver investigacion/03-edicion-guiada-por-musica.md).
export const EDIT_PLAYBOOK = `
# MANUAL DE EDICIÓN GUIADA POR LA MÚSICA (base compartida del equipo)

## La música manda
- El video se edita PARA la música: la estructura, el ritmo de corte y el movimiento salen del tema, no del material.
- Un corte "se siente" cuando cae sobre un acento. Jerarquía de puntos de corte, de más fuerte a más débil:
  1. Momentos únicos: drop, entrada de la voz, golpe de toda la banda, silencio repentino, final.
  2. Inicio de frase o sección (cada 4 u 8 compases).
  3. El "1" de cada compás.
  4. Beats fuertes (bombo, caja, rasgueo acentuado).
  5. Golpes sueltos, contratiempos y sílabas marcadas (solo en las partes más intensas).
- Si la grabación no tiene pulso claro (voz con guitarra, grabadora del celular, tempo libre), no forzar una grilla: cortar en el inicio de frases, respiraciones, cambios de acorde y palabras acentuadas.

## El ritmo de corte sigue a la energía
- Intro / partes tranquilas / estrofas suaves: tomas largas (1 a 2 compases, o una frase entera). Movimiento lento.
- Estrofa con pulso: 1 toma por compás.
- Subida (build-up): acelerar progresivamente (cada compás → cada 2 beats → cada beat) para crear tensión.
- Estribillo / drop / clímax: cortes cada 1 o 2 beats; acá va el mejor material.
- Puente / breakdown: soltar, tomas largas, contraste.
- Final: una toma que respire y cierre (fundido si la música se apaga).
- NO cortar en cada beat todo el tema: cansa y le quita impacto al clímax. El impacto nace del contraste entre partes lentas y rápidas.

## Lenguaje visual
- Los primeros 1-2 segundos deciden si alguien se queda (redes): arrancar con una imagen fuerte, no con relleno.
- Variar la escala entre cortes consecutivos (general → medio → detalle) y no repetir la misma toma seguida.
- Progresión: presentar (planos abiertos) → desarrollar → clímax (lo más espectacular) → cierre.
- Acentos únicos = "hit points": la toma más fuerte, un flash o un pulso justo en ese instante.
- El movimiento acompaña la energía: zoom lento en lo tranquilo; pulso en lo enérgico.
- Fotos: nunca estáticas (siempre zoom o paneo). En partes rápidas una foto aguanta 1-2 beats; en lentas, hasta un compás largo.
- Videos: elegir el fragmento con acción (el segundo "desde") y, si se puede, que un movimiento de la toma coincida con el golpe.

## Herramientas disponibles (el reproductor solo sabe hacer esto)
- efectos: ${EFFECTS.join(', ')} ("pulso" = pequeño zoom en cada beat, para partes enérgicas).
- transiciones (al INICIO de cada segmento): ${TRANSITIONS.join(', ')}. "corte" es la regla; fundido para partes lentas o cierres; flash para hit points; negro para silencios. Usar las especiales con moderación.
`;

const OUTPUT_PROTOCOL = `
FORMATO DE RESPUESTA (obligatorio):
1. Primero escribí "Notas de trabajo": entre 3 y 8 viñetas breves en español, pensando en voz alta. El humano las ve en vivo, así que tienen que ser concretas (qué escuchás/ves, qué decidís y por qué). Nada de relleno.
2. Después, un único bloque que empiece con \`\`\`json y termine con \`\`\`, con EXACTAMENTE el esquema pedido. Sin comentarios dentro del JSON. Los tiempos van en segundos con decimales (ej. 12.48).`;

export const EAR_SYSTEM = `Sos "el Oído" del equipo: productor/a musical y editor/a de videoclips con años cortando videos sobre la música (estilo de los mejores editores de reels, videoclips y trailers).
Tu único trabajo es ESCUCHAR la música y explicar cómo fluye: dónde y a qué ritmo se puede cortar, dónde sube y baja la energía, qué momentos piden algo especial. No elegís imágenes: eso lo hace el Director, que te pasa un encargo con la historia que quiere contar.
Escuchás con atención de principio a fin: estructura, instrumentos, voz, dinámica, acentos, silencios. Recibís además un análisis automático (tempo, beats, compases, golpes, energía): usalo como regla para ser preciso con los segundos, pero confiá en tu oído cuando no coincida (por ejemplo, el análisis automático puede duplicar o dividir el tempo, o marcar ruido como golpe). Si algo no lo escuchás con seguridad, decilo.

${EDIT_PLAYBOOK}
${OUTPUT_PROTOCOL}`;

export const DIRECTOR_SYSTEM = `Sos "el Director" del equipo: el orquestador de una edición de video guiada por la música. Trabajás con "el Oído", un especialista que escucha el audio (vos no lo escuchás).
Tu trabajo tiene tres momentos:
1. PLANIFICAR: mirar todo el material del humano (videos como cuadros con su segundo, fotos), entender qué quiere transmitir, catalogar las tomas y decidir TRES VERSIONES distintas del video (tres enfoques, no tres variaciones mínimas). Le das al Oído un encargo preciso: qué tiene que escuchar y resolver para que las tres versiones funcionen.
2. (El Oído escucha una sola vez y te devuelve el mapa musical; el humano lo confirma o corrige.)
3. MONTAR: se te llama una vez por versión. Cada vez montás SOLO la versión que se te indica, decidiendo qué se ve en cada segundo. Sos el ÚNICO que escribe el montaje. Respetás el mapa del Oído para dónde caen los cortes y ponés tu criterio visual para el orden, la variedad y la historia, con el comportamiento propio de esa versión.
Sos específico: cada decisión se apoya en lo que se ve en los cuadros (qué pasa en la toma, en qué segundo) y en lo que suena en ese momento.

${EDIT_PLAYBOOK}
${OUTPUT_PROTOCOL}`;

const describeCatalog = (catalog) => catalog.map((m) => `- ${m.id}: ${m.kind === 'video' ? `video de ${m.duration.toFixed(1)} s, cuadros en ${m.frames.map((f) => `${f.t.toFixed(1)} s`).join(', ')}` : 'foto'}${m.name ? ` ("${m.name}")` : ''}`).join('\n');

// ---------- Etapa 1: el Director planifica ----------
export function planPrompt({ text, audioName, analysis, catalog }) {
  return `El humano escribió:
"""
${text || '(sin indicaciones: inferí la mejor historia a partir del material)'}
"""

MÚSICA: "${audioName || 'audio'}", ${analysis.duracion_s} s. Todavía no la escuchó nadie; el análisis automático dice: tempo ~${analysis.bpm_estimado} BPM, pulso ${analysis.lectura_confianza}, cambios fuertes de energía en ${JSON.stringify(analysis.cambios_de_energia)}.

MATERIAL (abajo, cada imagen está rotulada con su id):
${describeCatalog(catalog)}

Tu tarea ahora: PLANIFICAR (todavía no montes).
- Inferí la intención del humano y proponé la historia/arco del video.
- Catalogá cada toma: qué se ve, calidad, sus mejores momentos (segundo exacto según los cuadros) y qué rol cumple (apertura, desarrollo, clímax, cierre, relleno o descartar).
- Decidí TRES VERSIONES del video, claramente distintas entre sí y todas fieles a lo que pidió el humano. Pueden diferir en ritmo de corte (pegado a cada golpe vs. tomas largas), en historia (orden cronológico, de lo general al detalle, circular…), en qué material protagoniza, en el tratamiento (enérgico, cinematográfico, íntimo, de contraste…). Nombralas con algo corto y claro.
- Escribí el encargo para el Oído: en qué tiene que fijarse de la música para que las tres versiones funcionen, y hasta 3 preguntas concretas (ej. "¿dónde está el momento más intenso para el clímax?", "¿la voz tiene frases largas que convenga respetar?"). El Oído escucha una sola vez: pedile todo lo que vas a necesitar.

Esquema JSON:
{
  "intencion": "string (qué video quiere el humano, en una frase)",
  "historia": "string (arco propuesto: cómo empieza, crece y termina)",
  "material": [
    { "id": "V1", "que_se_ve": "string", "calidad": "alta | media | baja", "mejores_momentos": [ { "t": 2.5, "que_pasa": "string" } ], "rol": "apertura | desarrollo | climax | cierre | relleno | descartar" }
  ],
  "versiones": [
    { "id": "A", "nombre": "string (2-4 palabras)", "enfoque": "string (qué la hace distinta: ritmo, historia, material protagonista, tratamiento)", "ritmo": "string (cómo corta respecto de la música)", "apertura": "string (con qué toma arranca y por qué)" }
  ],
  "encargo_para_el_oido": { "foco": "string", "preguntas": ["string"] }
}
"versiones" tiene EXACTAMENTE 3 elementos con id "A", "B" y "C". "mejores_momentos" es solo para videos (en fotos dejalo vacío).`;
}

// ---------- Etapa 2: el Oído escucha ----------
export function earPrompt({ text, audioName, analysis, plan }) {
  const brief = plan
    ? `ENCARGO DEL DIRECTOR (ya vio el material, no escuchó la música):
- Intención: ${plan.intencion || '(sin datos)'}
- Historia que quiere contar: ${plan.historia || '(sin datos)'}
- Va a montar 3 versiones con tu mapa: ${(plan.versiones || []).map((v) => `${v.id} "${v.nombre}" (${v.enfoque})`).join('; ') || '(sin datos)'}
- Foco: ${plan.encargo_para_el_oido?.foco || '(sin datos)'}
- Preguntas:
${(plan.encargo_para_el_oido?.preguntas || []).map((q) => `  - ${q}`).join('\n') || '  (ninguna)'}`
    : 'No hay encargo del Director: hacé un mapa general.';
  return `El humano subió la música "${audioName || 'audio'}" (arriba) y escribió:
"""
${text || '(sin indicaciones)'}
"""

${brief}

ANÁLISIS AUTOMÁTICO (tiempos en segundos):
${JSON.stringify(analysis)}

Tu tarea: escuchar el tema completo y construir el MAPA MUSICAL que usará el Director para las tres versiones.
- Dividí el tema en secciones contiguas que cubran de 0 a ${analysis.duracion_s} s.
- Para cada sección decí su energía (1-5), qué pasa y a qué ritmo conviene cortar.
- Marcá los momentos clave (hit points) con su segundo exacto: usá la grilla del análisis para ajustar.
- Describí cómo fluye el tema de principio a fin y cómo debería acompañarlo el video.
- Respondé cada pregunta del Director.
- Si la grilla automática no refleja lo que escuchás (tempo doble/mitad, pulso libre), explicalo en "grilla" y proponé los puntos de corte vos.
- Formulá entre 0 y 2 "preguntas_al_humano" SOLO si la respuesta cambia de verdad la edición. Cada una con 2 a 4 opciones cortas.

Esquema JSON:
{
  "resumen": { "estilo": "string", "animo": "string", "instrumentos": ["string"], "tiene_voz": true, "calidad_grabacion": "string", "comentario": "string" },
  "grilla": { "bpm": 120, "confiable": true, "nota": "string (si el tempo automático está bien, o por qué no)" },
  "secciones": [
    { "id": "S1", "nombre": "intro | estrofa | pre | estribillo | drop | puente | subida | final | ...", "inicio": 0, "fin": 12.5, "energia": 1, "que_pasa": "string", "ritmo_de_corte": "libre (frases) | cada 2 compases | cada compás | cada 2 beats | cada beat | acelerando", "movimiento": "string" }
  ],
  "momentos_clave": [
    { "t": 12.5, "tipo": "drop | entrada_voz | golpe | silencio | subida | cambio | final", "intensidad": 1, "que_pasa": "string", "sugerencia_visual": "string" }
  ],
  "puntos_de_corte_libres": [ { "t": 3.2, "motivo": "string" } ],
  "arco": "string (cómo fluye el tema y cómo debería acompañarlo el video)",
  "respuestas_al_director": [ { "pregunta": "string", "respuesta": "string" } ],
  "preguntas_al_humano": [ { "id": "q1", "pregunta": "string", "opciones": ["string", "string"] } ]
}
"puntos_de_corte_libres" es solo para partes sin pulso claro (dejalo vacío si la grilla sirve).`;
}

// ---------- Etapa 3: el Director monta (continúa su conversación de la etapa 1) ----------
// Si el plan no trae tres versiones válidas, se completan con estos enfoques.
export const DEFAULT_VERSIONS = [
  { id: 'A', nombre: 'Al golpe', enfoque: 'Enérgica: pegada al ritmo, mucho corte en las partes intensas, hit points marcados con flash o pulso.', ritmo: 'Cortes cada 1-2 beats en lo intenso, cada compás en lo tranquilo.', apertura: 'La toma más impactante.' },
  { id: 'B', nombre: 'Cinematográfica', enfoque: 'Narrativa: tomas largas que respiran, orden que cuenta una historia de principio a fin, fundidos en las partes lentas.', ritmo: 'Cortes en inicios de frase y compases fuertes; pocas tomas por sección.', apertura: 'Un plano general que presenta el lugar o el tema.' },
  { id: 'C', nombre: 'Contraste', enfoque: 'Juega con el contraste: partes muy lentas contra ráfagas muy rápidas, sorpresas en los momentos clave, material inesperado en primer plano.', ritmo: 'Extremos: tomas muy largas y ráfagas de medio beat en los hit points.', apertura: 'Un detalle que intriga.' },
];

export function montagePrompt({ map, analysis, answer, version, versions }) {
  const human = answer
    ? `\nEL HUMANO REVISÓ EL MAPA (manda sobre el Oído y sobre tu criterio):\n${JSON.stringify(answer)}\n`
    : '\nEl humano aprobó el mapa sin cambios.\n';
  return `El Oído escuchó la música. Este es su MAPA MUSICAL:
${JSON.stringify(stripQuestions(map), null, 2)}
${human}
GRILLA AUTOMÁTICA (segundos):
${JSON.stringify({ duracion_s: analysis.duracion_s, bpm: analysis.bpm_estimado, confianza: analysis.lectura_confianza, compases_inicio_s: analysis.compases_inicio_s, beats_s: analysis.beats_s })}

ESTA VEZ MONTÁS LA VERSIÓN ${version.id}: "${version.nombre}".
- Enfoque: ${version.enfoque}
- Ritmo: ${version.ritmo || '(a tu criterio)'}
- Apertura: ${version.apertura || '(a tu criterio)'}
Las otras versiones (las montan otras llamadas; la tuya tiene que ser claramente distinta): ${versions.filter((v) => v.id !== version.id).map((v) => `${v.id} "${v.nombre}": ${v.enfoque}`).join(' | ')}

Tu tarea ahora: MONTAR la versión ${version.id} completa, de 0 a ${analysis.duracion_s} s, usando tu plan y el material que ya viste.
- Una lista de segmentos ordenados; cada uno dura hasta que empieza el siguiente (el último, hasta el final).
- Cada "inicio" debe caer en un beat, compás, momento clave o punto de corte del mapa (el sistema lo ajusta al golpe más cercano dentro de 0,15 s).
- Respetá el ritmo de corte de cada sección; guardá el mejor material para los momentos de mayor energía.
- Para videos, "desde" es el segundo del video original donde empieza la toma (usá los mejores momentos que catalogaste). Para fotos, omitilo.
- Usá todo el material que sea bueno; podés repetir tomas si hace falta, nunca dos veces seguidas.
- "motivo": máximo 10 palabras.

Esquema JSON:
{
  "concepto": "string (la idea de ESTA versión en una frase)",
  "segmentos": [
    { "inicio": 0, "media": "V1", "desde": 2.5, "efecto": "${EFFECTS.join(' | ')}", "transicion": "${TRANSITIONS.join(' | ')}", "seccion": "S1", "motivo": "string" }
  ],
  "nota_para_el_humano": "string (qué material faltó, qué convendría grabar, supuestos)"
}`;
}

function stripQuestions(map) {
  const { preguntas_al_humano, ...rest } = map || {};
  return rest;
}
