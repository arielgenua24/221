// Laboratorio · Motion Design: el harness que comparten los dos agentes.
// Mismo prompt de sistema (contrato + Remotion Agent Skills oficiales), mismo material, mismo entorno.
// Si cambia algo de acá, subí la versión de harnessVersion(): así el historial distingue mejoras del modelo y del harness.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALLOWED_IMPORTS, GOOGLE_FONTS, REMOTION_VERSION, FPS } from './runtime.js';
import { MAX_GENERATED_IMAGES, MAX_SEARCHES, SEARCH_GUIDANCE } from './tools.js';
import { transcriptBlock } from './transcript.js';
import { docsBlock } from './docs.js';
import { getEngine } from '../engines/index.js';
import { canvasIntro, canvasContract } from './canvas-contract.js';
import { COMPOSITION_CRITERIA } from './composition.js';

const SKILLS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'remotion-skills');
// Commit de github.com/remotion-dev/skills que está copiado en remotion-skills/ (ver SOURCE.md).
export const SKILLS_COMMIT = '32b241b97f4e0e4ab61fe9a41b05e6e64503f8c5';
// v2: el agente escribe solo la capa de motion (el video lo pone el entorno debajo) y tiene herramientas.
// v3: buscar referencias en internet es obligatorio antes de diseñar (y al revisar).
// v4: generar al menos una imagen propia (nano-banana por OpenRouter) y usarla; declarar qué referencias usó.
// v5: las referencias sirven para sacar una paleta de colores y objetos de referencia; los declara en sus notas.
// v6: Nano Banana 2.1 por WaveSpeed, con text-to-image y edit según las referencias.
// v7: el diseñador decide por escena entre add-on y fullscreen, con cualquiera de los motores.
// v8: consultas enfocadas con inspiración libre; los timeouts de búsqueda son recuperables.
// v9: storyboard del video entero, bitácora con revisiones al 25/50/75/100 % y revisión visual de su propio render.
// El motor (src/engines/) entra en la firma: "remotion 4.x · skills …" o "canvas v1".
const toolsLabel = (t) => [t?.search && 'búsqueda obligatoria', t?.images && 'imagen propia'].filter(Boolean).join('+') || 'sin herramientas';
// Las Remotion Agent Skills solo existen para el motor Remotion.
export const usesSkills = (engine) => getEngine(engine).id === 'remotion';
export const engineTag = (engine) => (usesSkills(engine) ? `remotion ${REMOTION_VERSION} · skills ${SKILLS_COMMIT.slice(0, 7)}` : getEngine(engine).version);
export const harnessVersion = (tools, engine) => `v9 · ${engineTag(engine)} · ${toolsLabel(tools)}`;

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

function toolsSection(tools, engine) {
  if (!tools?.search && !tools?.images) return '';
  const { fence, words } = getEngine(engine);
  return `
# Tools (${[tools.search && 'reference search', tools.images && 'at least one original image'].filter(Boolean).join(' and ')}: REQUIRED)
Every image has an ID: C1-2 (frame 2 of zone C1), C1-R1 (zone reference), R1 (general reference)${tools.search ? ', S1… (search result)' : ''}${tools.images ? ', gen1… (generated)' : ''}.${tools.search ? `
- buscar_referencias(consulta): Google Images references to inspect for visual inspiration. Use it at least once before writing the component when designing or revising. Maximum ${MAX_SEARCHES} searches per execution. ${SEARCH_GUIDANCE} Images may be incorporated into the animation when animated and integrated meaningfully, rather than pasted as an inert block; borrow their design language, do not copy them.
  Translate useful references into design choices:
  1. COLOR PALETTE: derive 3 to 6 hex colors from the dominant and accent colors (backgrounds, panels, text, accents). Choose deliberate harmony or contrast with the video's lighting and color, ensuring readable text over the actual frames. Use THOSE hex values in your code.
  2. REFERENCE OBJECTS, if present: study recurring or characteristic objects, shapes, and graphic motifs (a ball, cup, leaves, ticket, stamp, arrows, frames, icons). Turn them into animation motifs using code ${words.shapes}, or request a more detailed asset with generar_imagen. Do not invent reference objects if none are useful.
` : ''}${tools.images ? `
- generar_imagen(prompt, imagenes?, proporcion?): generate ONE image with Nano Banana 2.1 via WaveSpeed to use INSIDE the animation as \`images.gen1\` / \`images.gen2\` ${words.imageWith}. Generate AT LEAST ONE and make it a leading visual element: an original illustration, object, character, stylized product cutout, texture, or graphic background. Base it on the references. Give concrete art direction (style, palette, lighting, framing); for add-ons, request an asset suited to compositing, such as a solid-color background, and for fullscreen, design it as part of the complete scene. Animate its entrance, motion, and exit and integrate it with typography. Maximum ${MAX_GENERATED_IMAGES} images across the entire work, including revisions.` : ''}
After using tools, still return the complete component in one \`\`\`${fence} block.`;
}

// The two labs share the Remotion contract; only Context Lab exposes generated sounds.
export const remotionIntro = () => `You are a Motion Designer working with Remotion (${REMOTION_VERSION}). Given a real video and marked time zones, write ONE React/Remotion component for the animation above that video. Choose add-on or fullscreen compositions for each scene, only within the marked zones.`;

export function remotionContract({ sounds = false } = {}) {
  return `# Environment contract (required)
- Write one TSX file. Return the component in ONE \`\`\`tsx block at the end of your response. Before the block, write your \`## Work log\` (see "How you work") and then brief notes (at most 8 lines) describing your idea, including these three exact labels:
  - \`References used: S2, S5, R1\` with the image IDs actually used for inspiration (or \`References used: none\`).
  - \`Palette: #1B1B1F, #F4F1EA, #FF5A1F\` with the hex colors taken from the references and used in the code (or \`Palette: none\`).
  - \`Objects: ball, leaves\` with the reference objects or motifs included in the animation (or \`Objects: none\`).
- The original video is ALREADY rendered underneath, filling the frame. Do NOT render it yourself: your component draws the animation above it. For add-ons, leave unused space transparent. For fullscreen, cover the frame with your own opaque background (for example, an \`<AbsoluteFill style={{ backgroundColor: '#141413' }}>\` inside that scene's \`<Sequence>\`). The user can later scale and move your entire layer; initially design it at the video's full dimensions.
- The layer's root component is the \`export default\`. It receives these props:
  - \`zones: { id: string; from: number; durationInFrames: number; prompt: string; notes: string }[]\` — marked zones in frames, as listed in the request; use them or write the numbers directly.
  - \`images: Record<string, string>\` — generated images (gen1, gen2), if available. Use them with Remotion's \`<Img src={images.gen1} />\`.${sounds ? `
  - \`sounds: Record<string, string>\` — generated sound effects (sfx1, sfx2…), if available. Use them with \`<Audio src={sounds.sfx1} />\` from "@remotion/media".` : ''}
- The environment has already registered the composition: ${FPS} fps, using the original video's dimensions and duration. Do NOT register \`<Composition>\` or call \`registerRoot\`. Read fps, width, height, and durationInFrames with \`useVideoConfig()\`.
- Draw nothing outside the marked zones. Use \`<Sequence from={...} durationInFrames={...} premountFor={fps}>\` for each zone; you may add nested sequences for its scenes.
- Allowed imports (no other packages, local files, \`staticFile\`, or network access): ${ALLOWED_IMPORTS.filter((s) => !/^@remotion\/(effects|transitions|google-fonts)\//.test(s) && (sounds || s !== '@remotion/media')).join(', ')}, \`@remotion/effects/<effect>\`, \`@remotion/transitions/<presentation>\`, and \`@remotion/google-fonts/<Family>\` where Family ∈ { ${GOOGLE_FONTS.join(', ')} }.
- Everything must be deterministic: time comes only from \`useCurrentFrame()\`. No \`Math.random\` (use Remotion's \`random(seed)\`), \`Date\`, CSS animations/transitions, or \`useEffect\` for animation.
- Make all sizes relative to the frame (\`width\`/\`height\` from useVideoConfig): the video may be portrait or landscape.
- There is no Remotion Studio, terminal, or \`npx\`: ignore skill instructions about installing packages, opening Studio, rendering, public/ files, or adding videos. Apply the other guidance (timing, easing, interpolate, sequences, transitions, effects, fonts, text).`;
}

// The system prompt depends only on available tools and the engine, equally for both models.
export function labSystem(tools, engine) {
  if (!usesSkills(engine)) return `${canvasIntro()}\n\n${canvasContract()}\n${toolsSection(tools, engine)}\n${COMPOSITION_CRITERIA}`;
  return `${remotionIntro()}\n\n${remotionContract()}\n${toolsSection(tools, engine)}\n${COMPOSITION_CRITERIA}\n\n# Remotion Agent Skills (official, remotion-dev/skills @ ${SKILLS_COMMIT.slice(0, 7)})\n${skills}`;
}

const fmtS = (s) => `${s.toFixed(2)} s`;
const toFrames = (s) => Math.round(s * FPS);

// Zonas en cuadros, tal como las recibe el componente.
export function zonesFor(clips) {
  return clips.map((c) => ({ id: c.id, from: toFrames(c.start), durationInFrames: Math.max(1, toFrames(c.end) - toFrames(c.start)), prompt: c.prompt, notes: c.notes }));
}

// n cuadros repartidos de una lista (Context Lab elige cuántos cuadros por zona ve el agente).
export function pickFrames(frames, n) {
  if (!Number.isFinite(n) || n >= frames.length) return frames.map((f, k) => ({ f, k }));
  if (n <= 0) return [];
  return Array.from({ length: n }, (_, i) => Math.round(((i + 0.5) / n) * frames.length - 0.5)).map((k) => ({ f: frames[k], k }));
}

// El pedido (idéntico para los dos modelos): texto + cuadros de cada zona + referencias.
// opts.frames: cuántos cuadros por zona se muestran (por defecto, todos). Los ids no cambian (C1-3 sigue siendo el 3.º).
const TOOL_LABEL = { search: 'reference search', images: 'image generation', sound: 'sound generation', video: 'AI video generation' };
// El plan de herramientas que armó el editor (modo Automático) para una zona: solo las que esta ejecución tiene encendidas.
function planNote(plan, enabled) {
  const uses = (plan || []).filter((u) => !enabled || enabled[u.tool]);
  if (!uses.length) return '';
  return ` Editor’s plan for this zone (a suggestion: change it if your idea calls for it): ${uses.map((u) => `${TOOL_LABEL[u.tool]}${u.note ? ` «${u.note}»` : ''} around ${fmtS(u.at)}`).join(' · ')}.`;
}
// El storyboard: cuadros repartidos en TODO el video (no solo en las zonas), para que el agente entienda el arco de principio a fin.
// Se apaga junto con los cuadros de las zonas (Context Lab con 0 cuadros por zona: el agente trabaja a ciegas).
const storyboardOf = (storyboard, frames) => (frames === 0 ? [] : storyboard || []);

export function briefContent({ brief, video, clips, transcript = null, storyboard = [] }, { frames, enabled } = {}) {
  const zones = zonesFor(clips);
  const board = storyboardOf(storyboard, frames);
  const inZone = (t) => clips.find((c) => t >= c.start - 0.01 && t <= c.end + 0.01)?.id;
  const text = [
    `# Video\n${video.name} · ${video.width}×${video.height} · ${fmtS(video.duration)} · ${Math.ceil(video.duration * FPS)} frames at ${FPS} fps.`,
    `# Context\n${brief.context || '(no context provided)'}`,
    `# Instructions\n${brief.instructions || '(no instructions: propose the most suitable motion design)'}`,
    docsBlock(brief.docs),
    `# Marked zones (animate ONLY here)\n${clips.map((c, i) => `- ${c.id}: ${fmtS(c.start)} → ${fmtS(c.end)} = frames ${zones[i].from} → ${zones[i].from + zones[i].durationInFrames} (${zones[i].durationInFrames} frames).${c.prompt ? ` Request: ${c.prompt}` : ''}${c.notes ? ` Style: ${c.notes}` : ''}${planNote(c.toolPlan, enabled)}${c.refs.length ? ` (${c.refs.length} zone reference${c.refs.length > 1 ? 's' : ''} below)` : ''}`).join('\n')}`,
    transcriptBlock(transcript, zones),
    board.length ? `# Storyboard of the whole video\n${board.length} frames spread from the first second to the last (ST1…ST${board.length}, below): study them FIRST to understand the full arc and where each zone sits in it.\n${board.map((f, k) => `- ST${k + 1} at ${fmtS(f.t)}${inZone(f.t) ? ` (inside ${inZone(f.t)})` : ''}`).join('\n')}` : '',
    brief.refs.length ? `# General visual references\n${brief.refs.length} image${brief.refs.length > 1 ? 's' : ''} below: the user’s desired style.` : '',
    frames === 0 ? 'No video frames are provided: work from each zone’s description. Write your work log, then the component.' : `Below are ${board.length ? 'the storyboard, then ' : ''}frames from each zone (with their timestamps) and the references. Write your work log, then the component.`,
  ].filter(Boolean).join('\n\n');
  const parts = [{ type: 'text', text }];
  board.forEach((f, k) => parts.push(
    { type: 'text', text: `ST${k + 1} — storyboard, ${fmtS(f.t)} into the video (frame ${toFrames(f.t)})${inZone(f.t) ? `, inside ${inZone(f.t)}` : ''}` },
    { type: 'image_url', image_url: { url: f.url } },
  ));
  clips.forEach((c) => {
    pickFrames(c.frames, frames).forEach(({ f, k }) => parts.push(
      { type: 'text', text: `${c.id}-${k + 1} — frame from ${c.id} at ${fmtS(c.start + f.t)} in the video (${fmtS(f.t)} into the zone, frame ${toFrames(c.start + f.t)})` },
      { type: 'image_url', image_url: { url: f.url } },
    ));
    c.refs.forEach((r, k) => r.frames.forEach((url, j) => parts.push(
      { type: 'text', text: `${c.id}-R${k + 1}${r.frames.length > 1 ? `.${j + 1}` : ''} — reference for ${c.id}${r.name ? ` "${r.name}"` : ''}${r.frames.length > 1 ? `, frame ${j + 1} of ${r.frames.length}` : ''}` },
      { type: 'image_url', image_url: { url } },
    )));
  });
  brief.refs.forEach((r, k) => parts.push(
    { type: 'text', text: `R${k + 1} — general visual reference${r.name ? ` "${r.name}"` : ''}` },
    { type: 'image_url', image_url: { url: r.url } },
  ));
  return parts;
}

// Las imágenes del pedido por id (las herramientas las usan como entrada de generar_imagen).
export function imageRegistry({ brief, clips, storyboard = [] }) {
  const reg = new Map();
  storyboard.forEach((f, k) => reg.set(`ST${k + 1}`, f.url));
  clips.forEach((c) => {
    c.frames.forEach((f, k) => reg.set(`${c.id}-${k + 1}`, f.url));
    c.refs.forEach((r, k) => r.frames.forEach((url, j) => reg.set(`${c.id}-R${k + 1}${r.frames.length > 1 ? `.${j + 1}` : ''}`, url)));
  });
  brief.refs.forEach((r, k) => reg.set(`R${k + 1}`, r.url));
  return reg;
}

// Pedidos de corrección y empujones: el código y el reproductor se nombran según el motor (por defecto, Remotion).
const fenceOf = (engine) => `\`\`\`${getEngine(engine).fence}`;
const wordsOf = (engine) => getEngine(engine).words;
export const generateFirst = (engine) => `Before writing the component, generate at least one original image with generar_imagen (required in this environment) and use it in the animation with ${wordsOf(engine).imageTag}. Build on the references and make it a strong visual element. Then return the COMPLETE file in one ${fenceOf(engine)} block.`;
export const useImages = (ids, engine) => `You generated ${ids.join(' and ')} but your component does not use them. Integrate them into the animation with ${wordsOf(engine).imageUse(ids[0])}, animated rather than pasted, and return the COMPLETE file in one ${fenceOf(engine)} block.`;
export const soundFirst = (engine) => `Before writing the component, generate at least one sound effect with generar_sonido (required in this environment) and place it with ${wordsOf(engine).soundTag}, synchronized with a movement. Then return the COMPLETE file in one ${fenceOf(engine)} block.`;
export const videoFirst = (engine) => `Before writing the component, generate a shot with generar_video (required in this environment): choose a zone and starting frame and write the shot prompt. It appears in a separate layer below your animation. Then return the COMPLETE file in one ${fenceOf(engine)} block, designed to work with that shot.`;
export const useSounds = (ids, engine) => `You generated ${ids.join(' and ')} but your component does not use them. Add them with ${wordsOf(engine).soundUse(ids[0])} and return the COMPLETE file in one ${fenceOf(engine)} block.`;
export const searchFirst = (engine) => `Before writing the component, search for references with buscar_referencias (required in this environment). ${SEARCH_GUIDANCE} Inspect the results, then write the COMPLETE file in one ${fenceOf(engine)} block.`;
export const compileFix = (message, engine) => `The code does not compile or violates the environment contract: ${message}\nFix it and return the COMPLETE file in one ${fenceOf(engine)} block.`;
export const truncatedFix = (engine) => `Your previous answer was cut off by the output token limit before the code block was finished. Write a more compact version (same idea, less repetition) and return the COMPLETE file in one ${fenceOf(engine)} block, with at most two short lines of notes before it.`;
export const continueCode = (engine) => `Your answer was cut off by the output token limit in the middle of the ${fenceOf(engine)} block. Continue EXACTLY from the last character you wrote: do not repeat anything, do not reopen the block, no notes. Write only the rest of the file and close the block with \`\`\` when it ends.`;
export const runtimeFix = (message, engine) => `The component compiles but fails during playback in ${wordsOf(engine).player}: ${message}\nFix the cause and return the COMPLETE file in one ${fenceOf(engine)} block.`;
// Revisión visual: el agente ve capturas de SU animación renderizada sobre el video y la aprueba o la corrige.
export const REVIEW_APPROVED = 'APPROVED';
export const reviewFix = (round, rounds, engine) => `Visual review ${round}/${rounds}. Below are screenshots of YOUR current animation rendered over the real video (V1, V2…, each with its zone and time). This is exactly what the viewer will see: look at every one carefully before answering.
Check, against the storyboard and what is said at each moment:
- Does anything cover faces, hands, the product, or on-screen information that must stay readable?
- Is all text legible (size, contrast against the actual picture, line length) and inside the frame with safe margins?
- Does each piece sit in the free space and relate to what is on screen, or does it ignore the picture?
- Coherence, consistency (palette, type, motion language, positions across zones), and, above all, good taste: is anything generic, cluttered, misaligned, or cheap?
Update your \`## Work log\` with a line \`Checkpoint (visual review ${round}): …\` describing what you saw.
If it is right as it is, answer with the log and a last line that says only ${REVIEW_APPROVED}, with NO code block. Otherwise fix what you saw and return the COMPLETE file in one ${fenceOf(engine)} block.`;
export const feedbackFix = (feedback, engine) => `User feedback on your animation: ${feedback}\nApply the changes and return the COMPLETE file in one ${fenceOf(engine)} block.`;
