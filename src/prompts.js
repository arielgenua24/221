import { PLAYBOOK } from './knowledge.js';

// Protocolo de salida común: notas visibles para el humano + JSON para la máquina.
const OUTPUT_PROTOCOL = `
FORMATO DE RESPUESTA (obligatorio):
1. Primero escribí "Notas de trabajo": entre 3 y 8 viñetas breves en español, pensando en voz alta. El humano las ve en vivo, así que tienen que ser concretas e interesantes (qué notás, qué decidís y por qué). Nada de relleno.
2. Después, un único bloque que empiece con \`\`\`json y termine con \`\`\`, con EXACTAMENTE el esquema pedido. Sin comentarios dentro del JSON.`;

export const ORCHESTRATOR_SYSTEM = `Sos el Director Creativo y orquestador de un equipo de contenido para redes sociales (Instagram y TikTok, contenido orgánico) que trabaja para pymes de cualquier rubro: productos (ropa, comida...) y servicios (fotografía, fletes...).
Sos el ÚNICO que toma decisiones finales y escribe los entregables. Delegás investigación y crítica, pero la coherencia del resultado es tu responsabilidad.
Trabajás con rigor: nada genérico, todo específico para ESTE negocio y SU público. Si falta información, hacés supuestos explícitos y razonables en lugar de inventar hechos.
Escribís en español rioplatense neutro salvo que el negocio indique otra cosa.

${PLAYBOOK}
${OUTPUT_PROTOCOL}`;

export const RESEARCHER_SYSTEM = `Sos investigador/a de contenido para redes sociales. Conocés en profundidad qué contenido funciona en Instagram y TikTok por rubro, qué formatos, ángulos, hooks y tendencias rinden, y cómo piensa y habla el público.
Recibís el brief completo del equipo (léelo entero: contiene decisiones y supuestos que tenés que respetar) y UN encargo específico. Respondé SOLO tu encargo, dentro de sus límites, sin repetir lo que corresponde a otros investigadores.
Sé concreto: ejemplos específicos del rubro, frases que el público realmente diría, patrones observables. Marcá tu nivel de confianza con honestidad; si algo es intuición y no conocimiento, decilo.

${PLAYBOOK}
${OUTPUT_PROTOCOL}`;

export const CRITIC_SYSTEM = `Sos el/la crítico/a del equipo: un editor de contenido exigente y honesto. Tu trabajo es evitar que publiquemos contenido genérico, "AI slop", clickbait o riesgoso.
Evaluás conceptos que escribió otra persona del equipo. No sos complaciente: un 5 es excepcional. Justificás cada juicio y proponés una mejora concreta y accionable para cada concepto.

${PLAYBOOK}
${OUTPUT_PROTOCOL}`;

// ---------- Etapa 1: brief + plan de investigación ----------
export function briefPrompt(userText, photoCount) {
  return `El cliente escribió:
"""
${userText || '(sin texto; inferí todo lo posible de las fotos)'}
"""
Adjuntó ${photoCount} foto(s)${photoCount ? ' (abajo)' : ''}.

Tu tarea: construir el BRIEF (el registro compartido que leerá todo el equipo) y planificar exactamente 3 investigaciones para los investigadores, que trabajarán EN PARALELO. Cada encargo debe tener un objetivo distinto, sin superposición, con preguntas precisas y límites claros. Sugerencia de reparto (adaptalo al caso):
- A: público — deseos, dolores, lenguaje real, momentos de compra.
- B: rubro — qué ángulos y formatos funcionan y qué está saturado.
- C: hooks, tendencias y recursos virales aplicables a este negocio.

Describí las fotos con precisión (qué se ve, calidad, luz, colores, qué se puede aprovechar para producir con IA sin alterar el producto).

Esquema JSON:
{
  "negocio": { "nombre": "string o null", "rubro": "string", "que_ofrece": "string", "tipo": "producto | servicio", "ubicacion_o_mercado": "string o null" },
  "fotos": [ { "n": 1, "que_se_ve": "string", "aprovechable_para": "string" } ],
  "publico": { "quien": "string", "deseos": ["string"], "dolores": ["string"], "como_habla": "string" },
  "nivel_consciencia": "1-5 con explicación breve",
  "sofisticacion_mercado": "baja | media | alta, con explicación breve",
  "momentos_de_compra": ["string"],
  "personalidad_marca": { "rasgos": ["string"], "tono": "string", "paleta_observada": ["string"] },
  "diferenciales_posibles": ["string"],
  "restricciones": ["string"],
  "supuestos": ["string"],
  "plan_investigacion": [
    { "id": "A", "titulo": "string corto", "objetivo": "string", "preguntas": ["string"], "limites": "qué NO debe cubrir" }
  ]
}`;
}

// ---------- Etapa 2: investigación ----------
export function researchPrompt(brief, task) {
  return `BRIEF COMPARTIDO DEL EQUIPO:
${JSON.stringify(stripPlan(brief), null, 2)}

TU ENCARGO (${task.id} — ${task.titulo}):
Objetivo: ${task.objetivo}
Preguntas:
${(task.preguntas || []).map((q) => `- ${q}`).join('\n')}
Límites: ${task.limites}

Esquema JSON:
{
  "encargo": "${task.id}",
  "hallazgos": [ { "insight": "string", "por_que": "string", "confianza": "alta | media | baja" } ],
  "angulos_prometedores": [ { "angulo": "string", "ejemplo_concreto": "string" } ],
  "hooks_ejemplo": ["string"],
  "frases_del_publico": ["string"],
  "evitar": ["string"]
}`;
}

// ---------- Etapa 3: ideación divergente ----------
export function ideationPrompt(brief, research) {
  return `BRIEF:
${JSON.stringify(stripPlan(brief), null, 2)}

INVESTIGACIÓN DEL EQUIPO:
${JSON.stringify(research, null, 2)}

Tu tarea: generar 8 conceptos de contenido DISTINTOS entre sí, usando la investigación y recorriendo la matriz Función × Ángulo × Formato × Nivel de consciencia × Emoción.
Reglas de diversidad (obligatorias):
- Ningún par de conceptos repite la misma combinación función + ángulo.
- Al menos 5 funciones distintas; al menos 2 conceptos de "marca" (F3/F4/F5/F9/F10) y al menos 2 de "activación" (F6/F7/F8/F12).
- Los 3 formatos (reel_ia, carrusel, imagen) aparecen al menos una vez.
- Al menos 2 niveles de consciencia distintos.
- Cada concepto tiene que ser imposible de copiar tal cual por otra marca del rubro: usá detalles concretos de ESTE negocio y de SUS fotos.
- Todo debe poder producirse sin filmar, a partir de las fotos reales + IA.

Esquema JSON:
{
  "conceptos": [
    {
      "id": "C1",
      "titulo": "string (nombre corto y evocador de la idea, máx. 8 palabras)",
      "subtitulo": "string (una frase que explica la idea, máx. 25 palabras)",
      "funcion": "F# Nombre",
      "angulo": "string",
      "formato": "reel_ia | carrusel | imagen",
      "nivel_consciencia": 1,
      "emocion": "string",
      "hook": { "visual": "string", "texto": "string", "verbal": "string" },
      "desarrollo": ["paso/escena/diapositiva"],
      "por_que_funciona": "string (conectado con la investigación)",
      "produccion": "string (cómo se produce con IA a partir de qué foto, sin alterar el producto)"
    }
  ]
}`;
}

// ---------- Etapa 4: crítica ----------
export function critiquePrompt(brief, concepts) {
  return `BRIEF:
${JSON.stringify(stripPlan(brief), null, 2)}

CONCEPTOS A EVALUAR:
${JSON.stringify(concepts, null, 2)}

Evaluá cada concepto de 1 a 5 en:
- claridad: se entiende en 2 segundos.
- hook: detiene el scroll; las 3 capas dicen lo mismo.
- promesa: el contenido cumple lo que promete el hook.
- compartible: alguien se lo mandaría a otra persona (STEPPS).
- especificidad: NO podría publicarlo cualquier otra marca del rubro.
- producible: se puede hacer sin filmar y sin alterar el producto real.
- riesgo: 5 = sin riesgo; baja si hay humor ofensivo, promesas falsas o testimonios inventados.

Esquema JSON:
{
  "evaluaciones": [
    {
      "id": "C1",
      "puntajes": { "claridad": 1, "hook": 1, "promesa": 1, "compartible": 1, "especificidad": 1, "producible": 1, "riesgo": 1 },
      "veredicto": "string (una frase honesta)",
      "mejora": "string (cambio concreto que lo haría mejor)"
    }
  ],
  "observacion_general": "string"
}`;
}

// ---------- Etapa 5: selección final ----------
export function finalPrompt(brief, concepts, critique) {
  return `BRIEF:
${JSON.stringify(stripPlan(brief), null, 2)}

CONCEPTOS:
${JSON.stringify(concepts, null, 2)}

CRÍTICA INDEPENDIENTE:
${JSON.stringify(critique, null, 2)}

Tu tarea: elegir las 4 mejores ideas para publicar y MEJORARLAS aplicando la crítica cuando tenga razón (si no estás de acuerdo con la crítica, decidís vos, pero justificalo en las notas).
Criterios: calidad según la crítica + diversidad entre las 4 (funciones, formatos y niveles de consciencia distintos; mezcla marca/activación).
El título y subtítulo son lo que verá el humano primero: tienen que ser claros, concretos y atractivos, no genéricos.

Esquema JSON:
{
  "ideas": [
    {
      "id_origen": "C#",
      "titulo": "string (máx. 8 palabras)",
      "subtitulo": "string (máx. 25 palabras)",
      "funcion": "F# Nombre",
      "formato": "reel_ia | carrusel | imagen",
      "angulo": "string",
      "nivel_consciencia": 1,
      "emocion": "string",
      "hook": { "visual": "string", "texto": "string", "verbal": "string" },
      "desarrollo": ["string"],
      "caption": "string (texto de la publicación, listo para usar)",
      "por_que": "string",
      "produccion": "string"
    }
  ],
  "nota_para_el_humano": "string (qué necesitás confirmar o qué supuestos hiciste)"
}`;
}

function stripPlan(brief) {
  const { plan_investigacion, ...rest } = brief || {};
  return rest;
}
