// Laboratorio · Context Lab: el MISMO modelo varias veces sobre el mismo video y las mismas zonas,
// cambiando el CONTEXTO de cada variante (la idea inversa de Motion Design, que cambia el modelo y deja fijo el contexto).
// Por variante se elige todo lo que entra en la ventana de contexto del agente:
//   - el prompt de sistema (una plantilla editable con marcadores {{herramientas}}, {{ejemplos}} y {{skills}}),
//   - qué Remotion Agent Skills se incluyen,
//   - cada herramienta (búsqueda, imagen, sonido, video) apagada / opcional / obligatoria, y sus límites,
//   - contexto, instrucciones y referencias visuales del pedido, ejemplos (few-shot), cuántos cuadros por zona ve,
//   - temperatura y esfuerzo de razonamiento,
//   - el motor de animación (src/engines/): Remotion o el motor propio en canvas (cada uno con su plantilla por defecto).
// El bucle del agente, el runtime de Remotion y las herramientas son los de Motion Design (pipeline.js, runtime.js, tools.js).
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SKILL_FILES, SKILLS_COMMIT, usesSkills, engineTag, remotionIntro, remotionContract } from './harness.js';
import { getEngine, engineId } from '../engines/index.js';
import { canvasIntro, canvasContract } from './canvas-contract.js';
import { COMPOSITION_CRITERIA } from './composition.js';
import { parseLabBody, TOOL_KEYS, TOOL_MODES } from './pipeline.js';
import { EFFORTS } from './reasoning.js';
import { DEFAULT_LIMITS, LIMIT_CAPS, SEARCH_GUIDANCE } from './tools.js';
import { VIDEO_MODELS, DEFAULT_VIDEO_MODEL } from '../wavespeed.js';

// ctx-v2: add-on y fullscreen a criterio del diseñador en las plantillas de ambos motores.
// ctx-v3: guía compartida de consultas y timeouts de búsqueda recuperables.
export const CONTEXT_HARNESS = 'ctx-v3';
export const MAX_VARIANTS = 4;
export const MAX_FRAMES = 6; // los que saca el navegador por zona
const MAX_TEMPLATE = 60000;
const MAX_EXAMPLES = 20000;
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

// La plantilla por defecto: la misma base que Motion Design, con las partes variables como marcadores.
// {{herramientas}} se arma según los modos de la variante; {{ejemplos}} con sus ejemplos; {{skills}} con las skills elegidas.
// Si borrás un marcador, esa parte no entra en el contexto. Cada motor tiene la suya (el contrato cambia; el resto, no).
export function defaultTemplate(engine) {
  if (!usesSkills(engine)) return `${canvasIntro()}\n\n${canvasContract()}\n\n{{herramientas}}\n\n${COMPOSITION_CRITERIA}\n\n{{ejemplos}}`;
  return `${remotionIntro()}\n\n${remotionContract({ sounds: true })}\n\n{{herramientas}}\n\n${COMPOSITION_CRITERIA}\n\n{{ejemplos}}\n\n{{skills}}`;
}

const MODE_LABEL = { optional: 'optional', required: 'REQUIRED' };

// Tool instructions follow each variant's availability and policy.
export function toolsBlock(enabled, policy, limits, engine) {
  const { fence, words } = getEngine(engine);
  const lim = { ...DEFAULT_LIMITS, ...limits };
  const on = TOOL_KEYS.filter((k) => enabled[k]);
  if (!on.length) return '# Tools\nNo tools are available in this environment: solve the task with code.';
  const tag = (k) => `(${MODE_LABEL[policy[k]]})`;
  const req = (k) => policy[k] === 'required';
  const lines = [`# Tools\nEvery image has an ID: C1-2 (frame 2 of zone C1), C1-R1 (zone reference), R1 (general reference)${enabled.search ? ', S1… (search result)' : ''}${enabled.images ? ', gen1… (generated)' : ''}.`];
  if (enabled.search) lines.push(`- buscar_referencias(consulta) ${tag('search')}: Google Images references to inspect for visual inspiration. ${req('search') ? 'Search at least once before writing the component when designing or revising.' : 'Use it when you need visual inspiration or information.'} Maximum ${lim.searches} searches per execution. ${SEARCH_GUIDANCE} Do not use these images inside the animation. Derive a PALETTE of 3 to 6 hex colors that works with the video, and reference OBJECTS or motifs (draw them with code or request a detailed asset with generar_imagen).`);
  if (enabled.images) lines.push(`- generar_imagen(prompt, imagenes?, proporcion?) ${tag('images')}: generate ONE image with Nano Banana 2.1 to use INSIDE the animation as ${words.imageCtx}. ${req('images') ? 'Generate AT LEAST ONE and make it a leading visual element.' : 'Generate an image only when an original illustration, object, texture, or sticker improves the piece.'} Give concrete art direction. For add-ons, request an asset suited to compositing; for fullscreen, design it as part of the complete scene. Animate it. Maximum ${lim.images} images across the entire work.`);
  if (enabled.sound) lines.push(`- generar_sonido(descripcion, duracion?) ${tag('sound')}: generate ONE short sound effect (whoosh, pop, impact, riser…) available as \`sounds.sfx1\`. ${req('sound') ? 'Generate AT LEAST ONE.' : 'Use it when the movement benefits from sound.'} Place it with ${words.soundCtx}: sound should mark the movement's impact. It is mixed over the original audio; keep the voice clear. You cannot listen to it, so describe it precisely in English. Maximum ${lim.sounds} effects across the entire work.`);
  if (enabled.video) lines.push(`- generar_video(zona, imagen?, prompt) ${tag('video')}: generate ONE AI shot (image-to-video) starting from a zone's frame. Do NOT include it in your component: the environment displays it in a SEPARATE LAYER between the original video and your animation during that zone. The user can hide, move, or scale it. ${req('video') ? 'Generate ONE for the zone where it contributes most.' : 'Use it only when a new shot adds real value; it is slow and expensive.'} Design your animation to work with that shot. Maximum ${lim.videos} shots across the entire work.`);
  lines.push(`After using tools, still return the complete component in one \`\`\`${fence} block.`);
  return lines.join('\n');
}

// Las Remotion Agent Skills solo tienen sentido con el motor Remotion.
export function skillsBlock(files, engine) {
  if (!usesSkills(engine)) return '';
  const list = files.map((f) => SKILL_BY_FILE.get(f)).filter(Boolean);
  if (!list.length) return '';
  return `# Remotion Agent Skills (official, remotion-dev/skills @ ${SKILLS_COMMIT.slice(0, 7)})\n${list.map((s) => `<skill file="${s.file}">\n${s.text}\n</skill>`).join('\n\n')}`;
}

export const examplesBlock = (examples) => (examples ? `# Examples\n<ejemplos>\n${examples}\n</ejemplos>` : '');

// Arma el prompt de sistema final de una variante.
export function composeSystem({ template, enabled, policy, limits, skills, examples, engine }) {
  const base = template?.trim() ? template : defaultTemplate(engine);
  return base
    .replace(/\{\{\s*herramientas\s*\}\}/gi, () => toolsBlock(enabled, policy, limits, engine))
    .replace(/\{\{\s*ejemplos\s*\}\}/gi, () => examplesBlock(examples))
    .replace(/\{\{\s*skills\s*\}\}/gi, () => skillsBlock(skills, engine))
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Firma corta de la configuración de herramientas (agrupa el historial). Ej. "S·opc I·obl A·— V·—".
const MODE_SHORT = { off: '—', optional: 'opc', required: 'obl' };
export const policySignature = (policy) => TOOL_KEYS.map((k) => `${{ search: 'S', images: 'I', sound: 'A', video: 'V' }[k]}·${MODE_SHORT[policy?.[k]] || '—'}`).join(' ');
export const contextHarness = (policy, engine) => `${CONTEXT_HARNESS} · ${engineTag(engine)} · ${policySignature(policy)}`;

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
    reasoning: EFFORTS.includes(v.reasoning) ? v.reasoning : null,
    videoModel: VIDEO_MODELS[v.videoModel] ? v.videoModel : DEFAULT_VIDEO_MODEL,
    engine: engineId(v.engine),
  };
}

// Lo que recibe /api/lab/context/run: lo mismo que /api/lab/run (modelo, video, zonas, brief de la variante, turnos,
// lo ya generado) + la configuración de la variante.
export function parseContextBody(body) {
  return { input: parseLabBody(body), variant: parseVariant(body?.variant) };
}

// La config de runLabAgent para una variante, según las herramientas que existen en el servidor.
// reasoningMeta: lo que acepta el modelo (reasoning.js), para pedir el nivel más cercano que soporta.
export function contextConfig(variant, available, reasoningMeta) {
  const enabled = Object.fromEntries(TOOL_KEYS.map((k) => [k, !!available?.[k] && variant.policy[k] !== 'off']));
  return {
    system: composeSystem({ ...variant, enabled }),
    policy: variant.policy,
    limits: variant.limits,
    temperature: variant.temperature ?? undefined,
    reasoning: variant.reasoning,
    reasoningMeta,
    frames: variant.frames,
    videoModel: variant.videoModel,
    harness: contextHarness(variant.policy, variant.engine),
    engine: variant.engine,
    // Con cuatro herramientas posibles hacen falta más vueltas que en Motion Design.
    maxToolRounds: 4 + Object.values(enabled).filter(Boolean).length,
  };
}
