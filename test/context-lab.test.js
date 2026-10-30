import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseContextBody, parseVariant, contextConfig, composeSystem, defaultTemplate, toolsBlock, policySignature, ALL_SKILLS, DEFAULT_SKILLS, DEFAULT_POLICY } from '../src/lab/context.js';
import { runLabAgent, parseLabBody, usesSounds } from '../src/lab/pipeline.js';
import { createLabTools, toolDefs, demoSfx, DEFAULT_LIMITS, LIMIT_CAPS } from '../src/lab/tools.js';
import { briefContent, pickFrames } from '../src/lab/harness.js';
import { mockLabLLM } from '../src/lab/mock.js';

const IMG = 'data:image/jpeg;base64,/9j/AA==';
const video = { name: 'v.mp4', duration: 12, width: 1080, height: 1920 };
const frames = Array.from({ length: 6 }, (_, k) => ({ t: 0.5 + k * 0.4, url: IMG }));
const clip = (id, start, end) => ({ id, start, end, prompt: `pedido ${id}`, notes: '', frames, refs: [] });
const body = (variant = {}, extra = {}) => ({
  model: 'anthropic/claude-opus-5.5',
  brief: { context: 'cafetería', instructions: 'títulos grandes', refs: [{ name: 'ref.jpg', url: IMG }] },
  video,
  clips: [clip('C1', 1, 3.5)],
  variant,
  ...extra,
});
const ALL = { search: true, images: true, sound: true, video: true };

test('parseVariant valida modos, límites, skills, cuadros, temperatura y razonamiento', () => {
  const d = parseVariant();
  assert.deepEqual(d.policy, DEFAULT_POLICY);
  assert.deepEqual(d.limits, DEFAULT_LIMITS);
  assert.deepEqual(d.skills, DEFAULT_SKILLS);
  assert.equal(d.frames, 6);
  assert.equal(d.temperature, null);
  assert.equal(d.reasoning, null);
  const v = parseVariant({
    policy: { search: 'off', images: 'required', sound: 'bogus', video: 'optional' },
    limits: { searches: 99, images: 0, sounds: '2' },
    skills: ['remotion-markup/sfx.md', '../../etc/passwd', 'remotion-markup/sfx.md'],
    frames: 2, temperature: 5, reasoning: 'high',
  });
  assert.deepEqual(v.policy, { search: 'off', images: 'required', sound: 'off', video: 'optional' });
  assert.equal(v.limits.searches, LIMIT_CAPS.searches);
  assert.equal(v.limits.images, 1);
  assert.equal(v.limits.sounds, 2);
  assert.deepEqual(v.skills, ['remotion-markup/sfx.md']);
  assert.equal(v.frames, 2);
  assert.equal(v.temperature, 2);
  assert.equal(v.reasoning, 'high');
  assert.deepEqual(parseVariant({ skills: [] }).skills, []);
});

test('el prompt de sistema se arma desde la plantilla: herramientas según los modos, ejemplos y skills elegidas', () => {
  const variant = parseVariant({ policy: { search: 'required', images: 'off', sound: 'optional', video: 'off' }, skills: ['remotion-markup/sfx.md'], examples: 'EJEMPLO-123' });
  const { system } = contextConfig(variant, ALL);
  assert.match(system, /buscar_referencias\(consulta\) \(REQUIRED\)/);
  assert.match(system, /generar_sonido\(descripcion, duracion\?\) \(optional\)/);
  assert.doesNotMatch(system, /generar_imagen\(|generar_video\(/);
  assert.match(system, /<ejemplos>\nEJEMPLO-123/);
  assert.match(system, /<skill file="remotion-markup\/sfx.md">/);
  assert.doesNotMatch(system, /<skill file="remotion-markup\/REFERENCE.md">/);
  assert.doesNotMatch(system, /\{\{\s*(?:herramientas|ejemplos|skills)\s*\}\}/);
  // Una herramienta que no existe en el servidor no se anuncia aunque la variante la pida.
  assert.doesNotMatch(contextConfig(variant, { ...ALL, sound: false }).system, /generar_sonido/);
  // Plantilla propia: sin marcadores, no entra nada más.
  assert.equal(composeSystem({ template: 'Solo esto.', enabled: ALL, policy: variant.policy, limits: {}, skills: DEFAULT_SKILLS, examples: '' }), 'Solo esto.');
  assert.match(defaultTemplate(), /\{\{herramientas\}\}[\s\S]*\{\{ejemplos\}\}[\s\S]*\{\{skills\}\}/);
  assert.match(toolsBlock({}, {}, {}), /No tools are available/);
  assert.equal(policySignature({ search: 'optional', images: 'required', sound: 'off', video: 'off' }), 'S·opc I·obl A·— V·—');
  assert.ok(ALL_SKILLS.length >= 20 && ALL_SKILLS.every((s) => s.chars > 0));
});

test('los cuadros por zona se eligen repartidos y conservan su id', () => {
  assert.deepEqual(pickFrames([1, 2, 3, 4, 5, 6], 2).map((x) => x.k), [1, 4]);
  assert.equal(pickFrames([1, 2], 0).length, 0);
  assert.equal(pickFrames([1, 2], undefined).length, 2);
  const input = parseLabBody(body());
  const two = briefContent(input, { frames: 2 }).filter((p) => p.type === 'text' && /^C1-\d/.test(p.text)).map((p) => p.text.slice(0, 4));
  assert.deepEqual(two, ['C1-2', 'C1-5']);
  assert.match(briefContent(input, { frames: 0 })[0].text, /No video frames are provided/);
});

test('toolDefs anuncia sonido y video solo si están encendidos, con su modo', () => {
  const names = toolDefs(ALL, { modes: { search: 'optional' } }).map((d) => d.function.name);
  assert.deepEqual(names, ['buscar_referencias', 'generar_imagen', 'generar_sonido', 'generar_video']);
  assert.match(toolDefs({ search: true }, { modes: { search: 'optional' } })[0].function.description, /Optional/);
  assert.match(toolDefs({ search: true })[0].function.description, /You must/);
  assert.match(demoSfx(1), /^data:audio\/wav;base64,UklGR/);
  assert.ok(usesSounds('<Audio src={sounds.sfx1} />'));
  assert.ok(!usesSounds('<Audio src={x} />'));
});

test('una variante con todas las herramientas obligatorias: busca, genera imagen, toma de video y sonido', async () => {
  const events = [];
  const seen = [];
  const { input, variant } = parseContextBody(body({ policy: { search: 'required', images: 'required', sound: 'required', video: 'required' }, temperature: 0.3, reasoning: 'low', frames: 3 }));
  const tools = createLabTools({ mock: true });
  await runLabAgent({ input, emit: (e) => events.push(e), llm: async (o) => { seen.push(o); return mockLabLLM(o); }, tools, config: contextConfig(variant, tools.available) });
  const run = events.find((e) => e.type === 'run');
  assert.match(run.harness, /^ctx-v4 .* S·obl I·obl A·obl V·obl$/);
  assert.equal(run.context.images, 3 + 1); // 3 cuadros + 1 referencia
  assert.deepEqual(run.context.tools, ['buscar_referencias', 'generar_imagen', 'generar_sonido', 'generar_video']);
  assert.equal(seen[0].temperature, 0.3);
  assert.deepEqual(seen[0].reasoning, { effort: 'low' });
  assert.equal(seen[0].messages[0].content, contextConfig(variant, tools.available).system);
  const sound = events.find((e) => e.type === 'sound');
  assert.equal(sound.id, 'sfx1');
  assert.match(sound.url, /^data:audio\//);
  const vid = events.find((e) => e.type === 'video');
  assert.equal(vid.id, 'vid1');
  assert.equal(vid.zone, 'C1');
  assert.equal(vid.from, 30);
  assert.equal(vid.durationInFrames, 75);
  assert.equal(vid.kind, 'image'); // en el demo la "toma" es un cuadro quieto
  const done = events.find((e) => e.type === 'done');
  assert.equal(done.sounds, 1);
  assert.equal(done.videos, 1);
  assert.equal(done.images, 1);
  assert.equal(done.searches, 1);
  assert.equal(done.videoRequired, true);
  assert.equal(done.soundRequired, true);
  assert.ok(events.find((e) => e.type === 'result').code.includes('sounds.sfx1'));
});

test('una variante sin herramientas no ofrece ninguna y una herramienta apagada no se ejecuta aunque el modelo la invente', async () => {
  const { input, variant } = parseContextBody(body({ policy: { search: 'off', images: 'off', sound: 'off', video: 'off' } }));
  const tools = createLabTools({ mock: true });
  const seen = [];
  const events = [];
  const llm = async (o) => {
    seen.push(o);
    if (seen.length === 1) return { text: '', toolCalls: [{ id: 'x', type: 'function', function: { name: 'generar_sonido', arguments: '{"descripcion":"pop"}' } }], usage: {} };
    return mockLabLLM(o);
  };
  // Sin herramientas en la llamada, el modelo igual pide una: se responde con error y no se genera nada.
  await runLabAgent({ input, emit: (e) => events.push(e), llm, tools, config: contextConfig(variant, tools.available) });
  assert.equal(seen[0].tools, undefined);
  assert.ok(!events.some((e) => e.type === 'sound'));
  assert.match(seen[1].messages.find((m) => m.role === 'tool').content, /no hay más herramientas|no está disponible/);
});

test('opcional: el modelo decide; sin uso no se le insiste', async () => {
  const { input, variant } = parseContextBody(body({ policy: { search: 'optional', images: 'optional', sound: 'optional', video: 'off' } }, { model: 'qwen/qwen3.8-max-prime' }));
  const tools = createLabTools({ mock: true });
  const events = [];
  await runLabAgent({ input, emit: (e) => events.push(e), llm: mockLabLLM, tools, config: contextConfig(variant, tools.available) });
  assert.ok(!events.some((e) => e.type === 'notice' && /le pido/.test(e.text)), 'no hay pedidos del entorno');
  assert.ok(!events.some((e) => e.type === 'search'), 'en opcional no se fuerza la búsqueda');
  const done = events.find((e) => e.type === 'done');
  assert.equal(done.searchRequired, false);
  assert.equal(done.imageRequired, false);
});

test('los sonidos y videos previos se reenvían y cuentan para el máximo', async () => {
  const { input, variant } = parseContextBody(body({ policy: { search: 'off', images: 'off', sound: 'required', video: 'off' }, limits: { sounds: 1 } }, {
    sounds: [{ id: 'sfx1', url: demoSfx(1), prompt: 'pop', duration: 1 }, { id: 'malo', url: 'x' }],
    videos: [{ id: 'vid1', zone: 'C1', prompt: 'toma' }],
    turns: [{ code: 'export default () => null', kind: 'feedback', message: 'más rápido' }],
  }));
  assert.equal(input.sounds.length, 1);
  assert.equal(input.videos.length, 1);
  const tools = createLabTools({ mock: true });
  const events = [];
  const seen = [];
  await runLabAgent({ input, emit: (e) => events.push(e), llm: async (o) => { seen.push(o); return mockLabLLM(o); }, tools, config: contextConfig(variant, tools.available) });
  // Ya tiene un sonido: no se le exige otro ni se genera uno nuevo (llegó al máximo).
  assert.equal(events.find((e) => e.type === 'done').soundRequired, false);
  assert.ok(!events.some((e) => e.type === 'sound'));
  const note = seen[0].messages.find((m) => Array.isArray(m.content) && m.content.some((p) => /Sonidos que ya generaste/.test(p.text || '')));
  assert.ok(note);
  assert.ok(note.content.some((p) => /Tomas de video que ya generaste/.test(p.text || '')));
});
