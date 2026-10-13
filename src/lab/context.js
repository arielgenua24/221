// Laboratorio · Context Lab: el MISMO modelo varias veces sobre el mismo video y las mismas zonas,
// cambiando el CONTEXTO de cada variante (la idea inversa de Motion Design, que cambia el modelo y deja fijo el contexto).
// Por variante se elige todo lo que entra en la ventana de contexto del agente:
//   - el prompt de sistema (una plantilla editable con marcadores {{herramientas}}, {{ejemplos}} y {{skills}}),
//   - qué Remotion Agent Skills se incluyen,
//   - cada herramienta (búsqueda, imagen, sonido, video) apagada / opcional / obligatoria, y sus límites,
//   - contexto, instrucciones y referencias visuales del pedido, ejemplos (few-shot), cuántos cuadros por zona ve,
//   - temperatura y esfuerzo de razonamiento.
// El bucle del agente, el runtime de Remotion y las herramientas son los de Motion Design (pipeline.js, runtime.js, tools.js).
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALLOWED_IMPORTS, GOOGLE_FONTS, REMOTION_VERSION, FPS } from './runtime.js';
import { SKILL_FILES, SKILLS_COMMIT } from './harness.js';
import { parseLabBody, TOOL_KEYS, TOOL_MODES } from './pipeline.js';
import { DEFAULT_LIMITS, LIMIT_CAPS } from './tools.js';
import { VIDEO_MODELS, DEFAULT_VIDEO_MODEL } from '../wavespeed.js';

// ctx-v1: primera versión del Context Lab. Si cambia la plantilla por defecto o las reglas, subila.
export const CONTEXT_HARNESS = 'ctx-v1';
export const MAX_VARIANTS = 4;
export const MAX_FRAMES = 6; // los que saca el navegador por zona
const MAX_TEMPLATE = 60000;
const MAX_EXAMPLES = 20000;
const REASONING = ['low', 'medium', 'high'];
// Una variante nueva: búsqueda e imagen opcionales (el modelo decide), sonido y video apagados.
export const DEFAULT_POLICY = { search: 'optional', images: 'optional', sound: 'off', video: 'off' };

const SKILLS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'remotion-skills');
// Todas las skills de remotion-markup que se pueden sumar al contexto, con su tamaño (≈ tokens = caracteres / 4).
export const ALL_SKILLS = readdirSync(path.join(SKILLS_DIR, 'remotion-markup'))
  .filter((f) => f.endsWith('.md'))
  .sort((a, b) => (a === 'REFERENCE.md' ? -1 : b === 'REFERENCE.md' ? 1 : a.localeCompare(b)))
  .map((f) => {
    const file = `remotion-markup/${f}`;
    const text = readFileSync(path.join(SKILLS_DIR, file), 'utf8').trim();
    const title = /^description:\s*(.+)$/m.exec(text)?.[1] || /^#\s+(.+)$/m.exec(text)?.[1] || f;
    return { file, title: title.slice(0, 120), chars: text.length, text };
  });
const SKILL_BY_FILE = new Map(ALL_SKILLS.map((s) => [s.file, s]));
export const DEFAULT_SKILLS = SKILL_FILES.filter((f) => SKILL_BY_FILE.has(f));
// Con sonido, conviene que el agente tenga las reglas de audio de Remotion.
export const SOUND_SKILLS = ['remotion-markup/audio.md', 'remotion-markup/sfx.md'].filter((f) => SKILL_BY_FILE.has(f));

const imports = () => `${ALLOWED_IMPORTS.filter((s) => !/^@remotion\/(effects|transitions|google-fonts)\//.test(s)).join(', ')}, \`@remotion/effects/<efecto>\`, \`@remotion/transitions/<presentación>\` y \`@remotion/google-fonts/<Familia>\` con Familia ∈ { ${GOOGLE_FONTS.join(', ')} }`;

// La plantilla por defecto: la misma base que Motion Design, con las partes variables como marcadores.
// {{herramientas}} se arma según los modos de la variante; {{ejemplos}} con sus ejemplos; {{skills}} con las skills elegidas.
// Si borrás un marcador, esa parte no entra en el contexto.
export function defaultTemplate() {
  return `Sos un motion designer que trabaja con Remotion (${REMOTION_VERSION}). Te dan un video real y zonas marcadas por un humano; escribís UN componente de React/Remotion con la CAPA de motion design que va encima de ese video, solo en las zonas marcadas.

# Contrato del entorno (no negociable)
- Escribís un único archivo TSX. Devolvé el componente en UN bloque \`\`\`tsx al final de tu respuesta. Antes del bloque escribí notas breves (máx. 8 líneas) de tu idea, y en ellas estas tres líneas exactas:
  - \`Referencias usadas: S2, S5, R1\` con los ids de las imágenes que de verdad tomaste como inspiración (o \`Referencias usadas: ninguna\`).
  - \`Paleta: #1B1B1F, #F4F1EA, #FF5A1F\` con los hex que usás en el código (o \`Paleta: ninguna\`).
  - \`Objetos: pelota, hojas secas\` con los objetos o motivos que llevaste a la animación (o \`Objetos: ninguno\`).
- El video original YA está renderizado debajo por el entorno, a pantalla completa. NO lo renderices: tu componente es una capa transparente encima (sin fondo opaco que lo tape). El humano después puede escalar y mover tu capa entera sobre el video.
- \`export default\` es el componente raíz de la capa. Recibe estas props:
  - \`zones: { id: string; from: number; durationInFrames: number; prompt: string; notes: string }[]\` — las zonas marcadas, en cuadros.
  - \`images: Record<string, string>\` — imágenes generadas con la herramienta (gen1, gen2…), si las hay. Usalas con \`<Img src={images.gen1} />\` de remotion.
  - \`sounds: Record<string, string>\` — efectos de sonido generados (sfx1, sfx2…), si los hay. Usalos con \`<Audio src={sounds.sfx1} />\` de "@remotion/media".
- La composición ya está registrada por el entorno: ${FPS} fps, el tamaño y la duración del video original. NO registres \`<Composition>\` ni llames \`registerRoot\`. Leé fps, width, height y durationInFrames con \`useVideoConfig()\`.
- Fuera de las zonas marcadas no dibujes nada. Usá \`<Sequence from={...} durationInFrames={...} premountFor={fps}>\` por zona.
- Imports permitidos (no hay ningún otro paquete, ni archivos locales, ni \`staticFile\`, ni red): ${imports()}.
- Todo determinista: el tiempo sale solo de \`useCurrentFrame()\`. Nada de \`Math.random\` (usá \`random(seed)\` de remotion), ni \`Date\`, ni animaciones/transiciones CSS, ni \`useEffect\` para animar.
- Todo tamaño relativo al cuadro (\`width\`/\`height\` de useVideoConfig): el video puede ser vertical u horizontal.
- No hay Remotion Studio, ni terminal, ni \`npx\`: ignorá en las skills lo que hable de instalar paquetes, abrir Studio, renderizar, la carpeta public/ o de poner videos.

{{herramientas}}

# Criterio
- El video del humano es la obra: no tapes caras, manos ni producto; usá el espacio negativo. El motion acompaña lo que pasa en cada zona.
- Respetá las instrucciones, el contexto y las referencias visuales. Si las referencias muestran un estilo, imitá su lenguaje (tipografía, color, ritmo), no su contenido.
- Una idea fuerte por zona, bien terminada: entrada, momento y salida limpias dentro de la zona.

{{ejemplos}}

{{skills}}`;
}

const MODE_LABEL = { optional: 'opcional', required: 'OBLIGATORIA' };

// La sección de herramientas según los modos de la variante (solo las que el agente ve de verdad).
export function toolsBlock(enabled, policy, limits) {
  const lim = { ...DEFAULT_LIMITS, ...limits };
  const on = TOOL_KEYS.filter((k) => enabled[k]);
  if (!on.length) return '# Herramientas\nEn este entorno no tenés herramientas: resolvé todo con código.';
  const tag = (k) => `(${MODE_LABEL[policy[k]]})`;
  const req = (k) => policy[k] === 'required';
  const lines = [`# Herramientas\nCada imagen que ves tiene un id: C1-2 (cuadro 2 de la zona C1), C1-R1 (referencia de una zona), R1 (referencia general)${enabled.search ? ', S1… (búsqueda)' : ''}${enabled.images ? ', gen1… (generada)' : ''}.`];
  if (enabled.search) lines.push(`- buscar_referencias(consulta) ${tag('search')}: imágenes de Google para MIRAR y tomar ideas (estilos de motion, tipografía, layouts, lo que hace el rubro del video). ${req('search') ? 'Antes de escribir el componente hacé al menos una búsqueda pensada para ESTE encargo (y otra vez cuando el humano pida cambios).' : 'Usala si te hace falta inspiración o información visual.'} Máx. ${lim.searches} por ejecución. No se pueden usar dentro de la animación. Sacales dos cosas: una PALETA de 3 a 6 hex que conviva con el video, y OBJETOS o motivos que identifiquen el tema (dibujalos con código o, si hace falta detalle, con generar_imagen).`);
  if (enabled.images) lines.push(`- generar_imagen(prompt, imagenes?, proporcion?) ${tag('images')}: genera UNA imagen con Nano Banana 2.1 para usar DENTRO de la animación como \`images.gen1\` con \`<Img>\`. ${req('images') ? 'Generá AL MENOS UNA y que sea protagonista.' : 'Generala solo si una pieza visual propia (ilustración, objeto, textura, sticker) mejora la animación.'} Dale dirección de arte concreta y, si va encima del video, pedí fondo liso o una pieza pensada para superponerse. Después animala. Máx. ${lim.images} en todo el trabajo.`);
  if (enabled.sound) lines.push(`- generar_sonido(descripcion, duracion?) ${tag('sound')}: genera UN efecto de sonido corto (whoosh, pop, impacto, riser…) que queda en \`sounds.sfx1\`. ${req('sound') ? 'Generá AL MENOS UNO.' : 'Usalo si el movimiento pide sonido.'} Ponelo con \`<Audio src={sounds.sfx1} volume={0.6} />\` de "@remotion/media" dentro de la \`<Sequence>\` del movimiento que acompaña: el sonido marca el golpe, no lo adorna. Se mezcla sobre el audio original: que no tape la voz. No lo podés escuchar, describilo con precisión (en inglés). Máx. ${lim.sounds} en todo el trabajo.`);
  if (enabled.video) lines.push(`- generar_video(zona, imagen?, prompt) ${tag('video')}: genera UNA toma con IA (image→video) a partir de un cuadro de la zona. NO la pongas en tu componente: el entorno la muestra en una CAPA PROPIA entre el video original y tu animación, durante esa zona, y el humano la puede ocultar, mover o escalar. ${req('video') ? 'Generá UNA para la zona donde más aporte.' : 'Usala solo si una toma nueva aporta de verdad (es lenta y cara).'} Diseñá tu capa para convivir con esa toma. Máx. ${lim.videos} en todo el trabajo.`);
  lines.push('Si usás herramientas, terminá igual con el componente completo en un bloque ```tsx.');
  return lines.join('\n');
}

export function skillsBlock(files) {
  const list = files.map((f) => SKILL_BY_FILE.get(f)).filter(Boolean);
  if (!list.length) return '';
  return `# Remotion Agent Skills (oficiales, remotion-dev/skills @ ${SKILLS_COMMIT.slice(0, 7)})\n${list.map((s) => `<skill file="${s.file}">\n${s.text}\n</skill>`).join('\n\n')}`;
}

export const examplesBlock = (examples) => (examples ? `# Ejemplos\n<ejemplos>\n${examples}\n</ejemplos>` : '');

// Arma el prompt de sistema final de una variante.
export function composeSystem({ template, enabled, policy, limits, skills, examples }) {
  const base = template?.trim() ? template : defaultTemplate();
  return base
    .replace(/\{\{\s*herramientas\s*\}\}/gi, () => toolsBlock(enabled, policy, limits))
    .replace(/\{\{\s*ejemplos\s*\}\}/gi, () => examplesBlock(examples))
    .replace(/\{\{\s*skills\s*\}\}/gi, () => skillsBlock(skills))
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Firma corta de la configuración de herramientas (agrupa el historial). Ej. "S·opc I·obl A·— V·—".
const MODE_SHORT = { off: '—', optional: 'opc', required: 'obl' };
export const policySignature = (policy) => TOOL_KEYS.map((k) => `${{ search: 'S', images: 'I', sound: 'A', video: 'V' }[k]}·${MODE_SHORT[policy?.[k]] || '—'}`).join(' ');
export const contextHarness = (policy) => `${CONTEXT_HARNESS} · remotion ${REMOTION_VERSION} · skills ${SKILLS_COMMIT.slice(0, 7)} · ${policySignature(policy)}`;

const str = (x, max) => String(x ?? '').slice(0, max);
const clampInt = (x, lo, hi, fallback) => (Number.isFinite(Number(x)) && x !== null && x !== '' ? Math.min(hi, Math.max(lo, Math.round(Number(x)))) : fallback);

// La configuración de una variante, validada.
export function parseVariant(v = {}) {
  const policy = Object.fromEntries(TOOL_KEYS.map((k) => [k, TOOL_MODES.includes(v.policy?.[k]) ? v.policy[k] : DEFAULT_POLICY[k]]));
  const limits = Object.fromEntries(Object.keys(DEFAULT_LIMITS).map((k) => [k, clampInt(v.limits?.[k], 1, LIMIT_CAPS[k], DEFAULT_LIMITS[k])]));
  const skills = Array.isArray(v.skills) ? [...new Set(v.skills.map(String))].filter((f) => SKILL_BY_FILE.has(f)) : DEFAULT_SKILLS;
  const temperature = v.temperature === null || v.temperature === undefined || v.temperature === '' ? null : Math.min(2, Math.max(0, Number(v.temperature) || 0));
  return {
    template: str(v.template, MAX_TEMPLATE),
    examples: str(v.examples, MAX_EXAMPLES).trim(),
    policy, limits, skills,
    frames: clampInt(v.frames, 0, MAX_FRAMES, MAX_FRAMES),
    temperature,
    reasoning: REASONING.includes(v.reasoning) ? v.reasoning : null,
    videoModel: VIDEO_MODELS[v.videoModel] ? v.videoModel : DEFAULT_VIDEO_MODEL,
  };
}

// Lo que recibe /api/lab/context/run: lo mismo que /api/lab/run (modelo, video, zonas, brief de la variante, turnos,
// lo ya generado) + la configuración de la variante.
export function parseContextBody(body) {
  return { input: parseLabBody(body), variant: parseVariant(body?.variant) };
}

// La config de runLabAgent para una variante, según las herramientas que existen en el servidor.
export function contextConfig(variant, available) {
  const enabled = Object.fromEntries(TOOL_KEYS.map((k) => [k, !!available?.[k] && variant.policy[k] !== 'off']));
  return {
    system: composeSystem({ ...variant, enabled }),
    policy: variant.policy,
    limits: variant.limits,
    temperature: variant.temperature ?? undefined,
    reasoning: variant.reasoning,
    frames: variant.frames,
    videoModel: variant.videoModel,
    harness: contextHarness(variant.policy),
    // Con cuatro herramientas posibles hacen falta más vueltas que en Motion Design.
    maxToolRounds: 4 + Object.values(enabled).filter(Boolean).length,
  };
}
