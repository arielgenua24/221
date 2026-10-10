// Laboratorio · Motion Design: el harness que comparten los dos agentes.
// Mismo prompt de sistema (contrato + Remotion Agent Skills oficiales), mismo material, mismo entorno.
// Si cambia algo de acá, subí la versión de harnessVersion(): así el historial distingue mejoras del modelo y del harness.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALLOWED_IMPORTS, GOOGLE_FONTS, REMOTION_VERSION, FPS } from './runtime.js';
import { MAX_GENERATED_IMAGES, MAX_SEARCHES } from './tools.js';

const SKILLS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'remotion-skills');
// Commit de github.com/remotion-dev/skills que está copiado en remotion-skills/ (ver SOURCE.md).
export const SKILLS_COMMIT = '32b241b97f4e0e4ab61fe9a41b05e6e64503f8c5';
// v2: el agente escribe solo la capa de motion (el video lo pone el entorno debajo) y tiene herramientas.
// v3: buscar referencias en internet es obligatorio antes de diseñar (y al revisar).
// v4: generar al menos una imagen propia (nano-banana por OpenRouter) y usarla; declarar qué referencias usó.
// v5: las referencias sirven para sacar una paleta de colores y objetos de referencia; los declara en sus notas.
// v6: Nano Banana 2.1 por WaveSpeed, con text-to-image y edit según las referencias.
const toolsLabel = (t) => [t?.search && 'búsqueda obligatoria', t?.images && 'imagen propia'].filter(Boolean).join('+') || 'sin herramientas';
export const harnessVersion = (tools) => `v6 · remotion ${REMOTION_VERSION} · skills ${SKILLS_COMMIT.slice(0, 7)} · ${toolsLabel(tools)}`;

// Las reglas de las skills que aplican a una capa de motion design sobre un video.
// (Studio, render por CLI, audio, mapas, 3D y captions quedan afuera: acá no existen.)
export const SKILL_FILES = [
  'remotion-markup/REFERENCE.md',
  'remotion-markup/timing.md',
  'remotion-markup/timing-props.md',
  'remotion-markup/sequencing.md',
  'remotion-markup/transitions.md',
  'remotion-markup/text-highlights.md',
  'remotion-markup/google-fonts.md',
  'remotion-markup/measuring-text.md',
  'remotion-markup/effects.md',
  'remotion-markup/light-leaks.md',
  'remotion-markup/motion-blur.md',
];

const skills = SKILL_FILES.map((f) => `<skill file="${f}">\n${readFileSync(path.join(SKILLS_DIR, f), 'utf8').trim()}\n</skill>`).join('\n\n');

function toolsSection(tools) {
  if (!tools?.search && !tools?.images) return '';
  return `
# Herramientas${tools.search || tools.images ? ` (${[tools.search && 'buscar referencias', tools.images && 'generar al menos una imagen propia'].filter(Boolean).join(' y ')}: OBLIGATORIO)` : ''}
Cada imagen que ves tiene un id: C1-2 (cuadro 2 de la zona C1), C1-R1 (referencia de una zona), R1 (referencia general)${tools.search ? ', S1… (búsqueda)' : ''}${tools.images ? ', gen1… (generada)' : ''}.${tools.search ? `
- buscar_referencias(consulta): imágenes de Google para MIRAR y tomar ideas (estilos de motion, tipografía, layouts, lo que hace el rubro del video). SIEMPRE, antes de escribir el componente, hacé al menos una búsqueda pensada para ESTE encargo (y otra vez cuando el humano pida cambios). Máx. ${MAX_SEARCHES} por ejecución. Las imágenes no se pueden usar dentro de la animación: inspirate en su lenguaje, no las copies.
  Las referencias tienen dos usos concretos; sacales provecho a los dos:
  1. PALETA DE COLORES. Mirá los colores dominantes y de acento de las referencias que elegiste y armá una paleta de 3 a 6 colores en hex (fondos o placas, texto, acentos). Elegila para que conviva con la luz y el color del video (armonía o contraste a propósito, nunca al azar) y para que el texto se lea sobre los cuadros reales. Usá ESOS hex en el código, no colores genéricos.
  2. OBJETOS DE REFERENCIA (si los hay). Fijate qué objetos, formas o elementos gráficos se repiten o identifican al tema (ej. una pelota, una taza, hojas, un ticket, un sello, flechas, marcos, un tipo de ícono). Usalos como motivos de la animación: dibujalos con código (formas, SVG, @remotion/shapes) o, si hace falta una pieza con más detalle, pedila con generar_imagen. Si las referencias no muestran objetos útiles, no los inventes.
  Podés buscar a propósito para cualquiera de los dos usos (ej. "autumn coffee color palette", "vintage toy ball illustration").` : ''}${tools.images ? `
- generar_imagen(prompt, imagenes?, proporcion?): genera UNA imagen con Nano Banana 2.1 vía WaveSpeed para usar DENTRO de la animación como \`images.gen1\` / \`images.gen2\` con \`<Img>\` de remotion. Esperamos que generes AL MENOS UNA y que sea protagonista: es lo que lleva la animación de "texto que se mueve" a una pieza con concepto. Pensala desde las referencias que encontraste: una ilustración con estilo propio, un objeto o personaje, el producto recortado y estilizado, una textura o un fondo gráfico para un título. Dale dirección de arte concreta en el prompt (estilo, paleta, luz, encuadre) y, si va encima del video, pedí fondo liso de un color o una pieza pensada para superponerse. Después animala (entrada, movimiento, salida) e integrala con la tipografía. Máx. ${MAX_GENERATED_IMAGES} en todo el trabajo (incluidas las revisiones).` : ''}
Si usás herramientas, terminá igual con el componente completo en un bloque \`\`\`tsx.`;
}

// El prompt de sistema solo depende de qué herramientas hay (y eso es igual para los dos modelos).
export function labSystem(tools) {
  return `Sos un motion designer que trabaja con Remotion (${REMOTION_VERSION}). Te dan un video real y zonas marcadas por un humano; escribís UN componente de React/Remotion con la CAPA de motion design que va encima de ese video, solo en las zonas marcadas.

# Contrato del entorno (no negociable)
- Escribís un único archivo TSX. Devolvé el componente en UN bloque \`\`\`tsx al final de tu respuesta. Antes del bloque escribí notas breves (máx. 8 líneas) de tu idea, y en ellas estas tres líneas exactas:
  - \`Referencias usadas: S2, S5, R1\` con los ids de las imágenes que de verdad tomaste como inspiración (o \`Referencias usadas: ninguna\`).
  - \`Paleta: #1B1B1F, #F4F1EA, #FF5A1F\` con los hex que sacaste de las referencias y usás en el código (o \`Paleta: ninguna\`).
  - \`Objetos: pelota, hojas secas\` con los objetos o motivos de las referencias que llevaste a la animación (o \`Objetos: ninguno\`).
- El video original YA está renderizado debajo por el entorno, a pantalla completa. NO lo renderices: tu componente es una capa transparente encima (sin fondo opaco que lo tape). El humano después puede escalar y mover tu capa entera sobre el video.
- \`export default\` es el componente raíz de la capa. Recibe estas props:
  - \`zones: { id: string; from: number; durationInFrames: number; prompt: string; notes: string }[]\` — las zonas marcadas, en cuadros. Son las mismas que se listan en el pedido; podés usarlas o escribir los números directamente.
  - \`images: Record<string, string>\` — imágenes generadas con la herramienta (gen1, gen2), si las hay. Usalas con \`<Img src={images.gen1} />\` de remotion.
- La composición ya está registrada por el entorno: ${FPS} fps, el tamaño y la duración del video original. NO registres \`<Composition>\` ni llames \`registerRoot\`. Leé fps, width, height y durationInFrames con \`useVideoConfig()\`.
- Fuera de las zonas marcadas no dibujes nada. Usá \`<Sequence from={...} durationInFrames={...} premountFor={fps}>\` por zona.
- Imports permitidos (no hay ningún otro paquete, ni archivos locales, ni \`staticFile\`, ni red): ${ALLOWED_IMPORTS.filter((s) => !/^@remotion\/(effects|transitions|google-fonts)\//.test(s) && s !== '@remotion/media').join(', ')}, \`@remotion/effects/<efecto>\`, \`@remotion/transitions/<presentación>\` y \`@remotion/google-fonts/<Familia>\` con Familia ∈ { ${GOOGLE_FONTS.join(', ')} }.
- Todo determinista: el tiempo sale solo de \`useCurrentFrame()\`. Nada de \`Math.random\` (usá \`random(seed)\` de remotion), ni \`Date\`, ni animaciones/transiciones CSS, ni \`useEffect\` para animar.
- Todo tamaño relativo al cuadro (\`width\`/\`height\` de useVideoConfig): el video puede ser vertical u horizontal.
- No hay Remotion Studio, ni terminal, ni \`npx\`: ignorá en las skills lo que hable de instalar paquetes, abrir Studio, renderizar, la carpeta public/ o de poner videos. Lo demás (timing, easing, interpolate, secuencias, transiciones, efectos, fuentes, texto) aplicalo tal cual.
${toolsSection(tools)}
# Criterio
- El video del humano es la obra: no tapes caras, manos ni producto; usá el espacio negativo. El motion acompaña lo que pasa en cada zona (mirá los cuadros que te mandan con su segundo).
- Respetá las instrucciones, el contexto y las referencias visuales. Si las referencias muestran un estilo, imitá su lenguaje (tipografía, color, ritmo), no su contenido.
- Una idea fuerte por zona, bien terminada: entrada, momento y salida limpias dentro de la zona.

# Remotion Agent Skills (oficiales, remotion-dev/skills @ ${SKILLS_COMMIT.slice(0, 7)})
${skills}`;
}

const fmtS = (s) => `${s.toFixed(2)} s`;
const toFrames = (s) => Math.round(s * FPS);

// Zonas en cuadros, tal como las recibe el componente.
export function zonesFor(clips) {
  return clips.map((c) => ({ id: c.id, from: toFrames(c.start), durationInFrames: Math.max(1, toFrames(c.end) - toFrames(c.start)), prompt: c.prompt, notes: c.notes }));
}

// El pedido (idéntico para los dos modelos): texto + cuadros de cada zona + referencias.
export function briefContent({ brief, video, clips }) {
  const zones = zonesFor(clips);
  const text = [
    `# Video\n${video.name} · ${video.width}×${video.height} · ${fmtS(video.duration)} · ${Math.ceil(video.duration * FPS)} cuadros a ${FPS} fps.`,
    `# Contexto\n${brief.context || '(sin contexto)'}`,
    `# Instrucciones\n${brief.instructions || '(sin instrucciones: proponé vos el motion más adecuado)'}`,
    `# Zonas marcadas (el motion va SOLO acá)\n${clips.map((c, i) => `- ${c.id}: ${fmtS(c.start)} → ${fmtS(c.end)} = cuadros ${zones[i].from} → ${zones[i].from + zones[i].durationInFrames} (${zones[i].durationInFrames} cuadros).${c.prompt ? ` Pedido: ${c.prompt}` : ''}${c.notes ? ` Estilo: ${c.notes}` : ''}${c.refs.length ? ` (${c.refs.length} referencia${c.refs.length > 1 ? 's' : ''} propia${c.refs.length > 1 ? 's' : ''} abajo)` : ''}`).join('\n')}`,
    brief.refs.length ? `# Referencias visuales generales\n${brief.refs.length} imagen${brief.refs.length > 1 ? 'es' : ''} abajo: el estilo que el humano quiere conseguir.` : '',
    'Abajo van cuadros de cada zona (con su segundo dentro de la zona) y las referencias. Escribí el componente.',
  ].filter(Boolean).join('\n\n');
  const parts = [{ type: 'text', text }];
  clips.forEach((c) => {
    c.frames.forEach((f, k) => parts.push(
      { type: 'text', text: `${c.id}-${k + 1} — cuadro de ${c.id} en ${fmtS(c.start + f.t)} del video (${fmtS(f.t)} dentro de la zona, cuadro ${toFrames(c.start + f.t)})` },
      { type: 'image_url', image_url: { url: f.url } },
    ));
    c.refs.forEach((r, k) => r.frames.forEach((url, j) => parts.push(
      { type: 'text', text: `${c.id}-R${k + 1}${r.frames.length > 1 ? `.${j + 1}` : ''} — referencia de ${c.id}${r.name ? ` "${r.name}"` : ''}${r.frames.length > 1 ? `, cuadro ${j + 1} de ${r.frames.length}` : ''}` },
      { type: 'image_url', image_url: { url } },
    )));
  });
  brief.refs.forEach((r, k) => parts.push(
    { type: 'text', text: `R${k + 1} — referencia visual general${r.name ? ` "${r.name}"` : ''}` },
    { type: 'image_url', image_url: { url: r.url } },
  ));
  return parts;
}

// Las imágenes del pedido por id (las herramientas las usan como entrada de generar_imagen).
export function imageRegistry({ brief, clips }) {
  const reg = new Map();
  clips.forEach((c) => {
    c.frames.forEach((f, k) => reg.set(`${c.id}-${k + 1}`, f.url));
    c.refs.forEach((r, k) => r.frames.forEach((url, j) => reg.set(`${c.id}-R${k + 1}${r.frames.length > 1 ? `.${j + 1}` : ''}`, url)));
  });
  brief.refs.forEach((r, k) => reg.set(`R${k + 1}`, r.url));
  return reg;
}

export const generateFirst = () => 'Antes de escribir el componente tenés que generar al menos una imagen propia con generar_imagen (es obligatorio en este entorno) y usarla en la animación con <Img src={images.gen1} />. Pensala desde las referencias: que sea la pieza visual fuerte de la animación. Después devolvé el archivo COMPLETO en un solo bloque ```tsx.';
export const useImages = (ids) => `Generaste ${ids.join(' y ')} pero tu componente no las usa. Integralas en la animación con <Img src={images.${ids[0]}} /> de remotion (animadas, no pegadas) y devolvé el archivo COMPLETO en un solo bloque \`\`\`tsx.`;
export const searchFirst = () => 'Antes de escribir el componente tenés que buscar referencias en internet con buscar_referencias (es obligatorio en este entorno). Hacé una o más búsquedas pensadas para este encargo, mirá los resultados y recién después escribí el archivo COMPLETO en un solo bloque ```tsx.';
export const compileFix = (message) => `El código no compila o no cumple el contrato del entorno: ${message}\nCorregilo y devolvé el archivo COMPLETO en un solo bloque \`\`\`tsx.`;
export const runtimeFix = (message) => `El componente compila pero falla al reproducirse en el Player de Remotion: ${message}\nCorregí la causa y devolvé el archivo COMPLETO en un solo bloque \`\`\`tsx.`;
export const feedbackFix = (feedback) => `Revisión del humano sobre tu animación: ${feedback}\nAplicá los cambios y devolvé el archivo COMPLETO en un solo bloque \`\`\`tsx.`;
