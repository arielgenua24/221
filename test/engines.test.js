import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { ENGINES, ENGINE_IDS, DEFAULT_ENGINE, getEngine, engineId, engineList } from '../src/engines/index.js';
import { canvasEngine, compile, extractCode, smokeTest, standaloneDocument, KIT_SOURCE } from '../src/engines/canvas/index.js';
import { blurFilter, ffmpegArgs } from '../src/engines/canvas/render.js';
import { labSystem, harnessVersion, compileFix, runtimeFix, useSounds } from '../src/lab/harness.js';
import { parseLabBody, runLabAgent, usesSounds } from '../src/lab/pipeline.js';
import { parseVariant, contextConfig, defaultTemplate, composeSystem, DEFAULT_SKILLS } from '../src/lab/context.js';
import { toolDefs } from '../src/lab/tools.js';

// Las escenas del motor propio, tal cual las escribiría un agente.
const SCENES = `
const FONTS = ['Anton', 'Inter:400,800'];
const SCENES = [
  { from: 0.5, to: 3, draw(t, p) {
      const s = spring(t - 0.1, 220, 22);
      g.translate(W / 2, H / 2); g.scale(0.6 + 0.4 * s, 0.6 + 0.4 * s);
      g.globalAlpha = clamp(t * 4) * (1 - seg(t, 2, 2.5));
      g.fillStyle = '#F0EEE6'; g.font = font(400, W * 0.17, 'Anton'); g.textAlign = 'center';
      g.fillText('MOTION', 0, 0);
      g.fillStyle = alpha('#D97757', 0.9); g.fillRect(-W * 0.3 * s, 50, W * 0.6 * s, 18);
  }},
  { from: 3, to: 6, draw(t) {
      const r = rng(7);
      for (let i = 0; i < 48; i++) {
        const k = spring(t - i * 0.03 - r() * 0.1, 260, 20);
        g.fillRect((i % 6) * 170 + 115 - 60 * k, Math.floor(i / 6) * 170 + 360 - 60 * k, 120 * k, 120 * k);
      }
  }},
];`;
const ENV = { width: 1080, height: 1920, duration: 8, fps: 30, zones: [{ id: 'C1', from: 15, durationInFrames: 75 }, { id: 'C2', from: 90, durationInFrames: 90 }] };

test('registro de motores: Remotion por defecto y cualquier id desconocido cae en él', () => {
  assert.deepEqual(ENGINE_IDS, ['remotion', 'canvas']);
  assert.equal(DEFAULT_ENGINE, 'remotion');
  assert.equal(engineId('canvas'), 'canvas');
  assert.equal(engineId('flash'), 'remotion');
  assert.equal(getEngine(undefined).id, 'remotion');
  // Todos cumplen el mismo contrato.
  for (const e of Object.values(ENGINES)) {
    for (const k of ['id', 'label', 'version', 'fence', 'fps']) assert.ok(e[k], `${e.id}.${k}`);
    for (const k of ['extractCode', 'compile', 'frameDocument']) assert.equal(typeof e[k], 'function', `${e.id}.${k}`);
    assert.ok(e.marker instanceof RegExp);
    for (const k of ['player', 'shapes', 'imageWith', 'imageTag', 'imageCtx', 'soundTag', 'soundTool', 'soundCtx']) assert.equal(typeof e.words[k], 'string', `${e.id}.words.${k}`);
    for (const k of ['imageUse', 'imageReady', 'soundUse', 'soundReady']) assert.match(e.words[k]('gen9'), /gen9/);
  }
  assert.deepEqual(engineList().map((e) => e.id), ENGINE_IDS);
});

test('canvas: compila las escenas, quita tipos y extrae el último bloque con SCENES', async () => {
  const { js } = await compile(SCENES, ENV);
  assert.match(js, /const SCENES/);
  assert.match((await compile(SCENES.replace('draw(t) {', 'draw(t: number) {'), ENV)).js, /draw\(t\) \{/);
  assert.equal(extractCode(`notas\n\`\`\`js\nborrador\n\`\`\`\n\`\`\`js\n${SCENES}\n\`\`\``), SCENES.trim());
  assert.equal(extractCode(`notas\n\`\`\`javascript\n${SCENES}`), SCENES.trim()); // respuesta cortada
  assert.throws(() => extractCode('```tsx\nexport default () => null\n```'), /SCENES/);
});

test('canvas: rechaza lo que rompe el contrato con mensajes para el modelo', async () => {
  const bad = (from, to) => compile(SCENES.replace(from, to), ENV);
  await assert.rejects(compile('const SCENES = [', ENV), /error de sintaxis.*línea/);
  await assert.rejects(bad('const r = rng(7);', 'const r = () => Math.random();'), /Math\.random/);
  await assert.rejects(bad('const r = rng(7);', 'const r = rng(Date.now());'), /reloj/);
  await assert.rejects(compile(`import x from 'y';\n${SCENES}`.replace("'Anton', ", ''), ENV), /import/);
  await assert.rejects(bad("g.textAlign = 'center';", "document.title = 'x';"), /DOM/);
  await assert.rejects(bad("g.textAlign = 'center';", 'requestAnimationFrame(() => {});'), /reloj/);
  await assert.rejects(compile('const LAYERS = [];', ENV), /SCENES/);
  // Un comentario que nombra "window" no cuenta.
  await compile(`// la ventana (window) de la zona\n${SCENES}`, ENV);
});

test('canvas: la prueba de humo encuentra errores de ejecución antes del navegador', async () => {
  const bad = (from, to) => compile(SCENES.replace(from, to), ENV);
  await assert.rejects(bad('const s = spring(t - 0.1, 220, 22);', 'const s = sprung(t);'), /ReferenceError: sprung is not defined/);
  await assert.rejects(bad("g.textAlign = 'center';", 'g.arc(0, 0, -s, 0, 1);'), /IndexSizeError: arc: radio negativo/);
  await assert.rejects(bad("g.textAlign = 'center';", "g.createLinearGradient(0, 0, 1, 1).addColorStop(t, '#fff');"), /addColorStop/);
  await assert.rejects(bad("g.textAlign = 'center';", 'g.drawImage(images.gen1, 0, 0);'), /drawImage: la imagen es undefined/);
  await compile(SCENES.replace("g.textAlign = 'center';", 'g.drawImage(images.gen1, 0, 0);'), { ...ENV, images: ['gen1'] });
  await assert.rejects(bad('for (let i = 0; i < 48; i++)', 'for (let i = 0; i < 48; i += 0)'), /bucle infinito/);
  await assert.rejects(bad("'Anton', ", "'Comic Sans', "), /Comic Sans.*no existe/);
  await assert.rejects(bad('from: 3, to: 6', 'from: 6, to: 3'), /from < to/);
  await assert.rejects(compile(`${SCENES}\nconst AUDIO = [{ sound: 'sfx1', at: 1 }];`, ENV), /sfx1.*no generaste/);
  await compile(`${SCENES}\nconst AUDIO = [{ sound: 'sfx1', at: 1 }];`, { ...ENV, sounds: ['sfx1'] });
  // Lo que solo existe en el navegador no se puede probar acá: pasa (lo prueba el iframe).
  await compile(SCENES.replace("g.textAlign = 'center';", 'const off = new OffscreenCanvas(2, 2);'), ENV);
  assert.equal(smokeTest((await compile(SCENES, ENV)).js, ENV), null);
});

test('canvas: el kit es determinista (spring, rng) y dibuja solo las escenas activas', () => {
  const ctx = vm.createContext({});
  vm.runInContext(KIT_SOURCE, ctx);
  const K = ctx.CanvasKit;
  const { spring, rng } = K.HELPERS;
  assert.equal(spring(0), 0);
  assert.ok(Math.abs(spring(3) - 1) < 1e-3);
  assert.ok(spring(0.1, 400, 10) > 1 || spring(0.15, 400, 10) > 1); // poco amortiguado: rebota
  const a = rng(7), b = rng(7);
  assert.deepEqual([a(), a(), a()], [b(), b(), b()]);
  // El código del agente corre en el realm del kit: lo que use tiene que estar en su global.
  const calls = [];
  ctx.calls = calls;
  const g = { canvas: { width: 10, height: 10 }, reset() {}, save() {}, restore() {} };
  const layer = K.evaluate('const SCENES = [{ from: 1, to: 2, draw(t, p) { calls.push([t, p]); } }];', { g, W: 10, H: 10, zones: [], images: {}, sounds: {} });
  for (const t of [0.5, 1, 1.5, 2]) K.drawAt(layer, g, t);
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [[0, 0], [0.5, 0.5]]);
  assert.deepEqual([...K.sampleTimes(layer)], [1, 1.5, 1.999]);
});

test('canvas: el documento del iframe trae el kit y el reproductor, con la misma CSP', async () => {
  const html = await canvasEngine.frameDocument();
  assert.match(html, /Content-Security-Policy" content="default-src 'none'/);
  assert.match(html, /CanvasKit/);
  assert.match(html, /CanvasMedia/); // mediabunny empaquetado: render cuadro a cuadro con WebCodecs
  assert.match(html, /source: 'lab-frame'/);
  for (const type of ['boot', 'loaded', 'checked', 'frame', 'render_progress', 'rendered', 'render_error']) assert.match(html, new RegExp(`type: '${type}'`), type);
  for (const type of ['load', 'transform', 'layers', 'segments', 'render', 'play', 'pause', 'seek']) assert.match(html, new RegExp(`msg\\.type === '${type}'`), type);
});

test('canvas: página suelta con window.seek(t) para el render headless', async () => {
  const { js } = await compile(SCENES, ENV);
  const html = standaloneDocument({ js, width: 1080, height: 1920, duration: 8, images: { gen1: 'data:image/png;base64,AAAA' } });
  assert.match(html, /<canvas id="c" width="1080" height="1920">/);
  assert.match(html, /window\.seek = \(t\)/);
  assert.match(html, /navigator\.webdriver/);
  assert.doesNotMatch(html.replace(/<\/script>/g, ''), /<\/script/i);
});

test('render headless: tmix promedia los subcuadros; con video de base, la capa va encima y conserva el audio', () => {
  assert.equal(blurFilter(60, 4), "tmix=frames=4,select='eq(mod(n\\,4)\\,3)',setpts=N/60/TB");
  const silent = ffmpegArgs({ fps: 60, sub: 4, out: 'out/silent.mp4' });
  assert.deepEqual(silent.slice(0, 7), ['-y', '-f', 'image2pipe', '-framerate', '240', '-i', '-']);
  assert.equal(silent.at(-1), 'out/silent.mp4');
  const over = ffmpegArgs({ fps: 30, sub: 2, out: 'final.mp4', video: 'base.mp4' }).join(' ');
  assert.match(over, /-i base\.mp4/);
  assert.match(over, /\[base\]\[fx\]overlay/);
  assert.match(over, /-map 1:a\?/);
});

test('harness: Remotion sigue igual; con canvas cambian el contrato, el bloque de código y el reproductor', () => {
  const tools = { search: true, images: true };
  assert.equal(labSystem(tools), labSystem(tools, 'remotion'));
  assert.match(harnessVersion(tools), /^v9 · remotion .* · skills [0-9a-f]{7} · /);
  assert.match(harnessVersion(tools, 'canvas'), /^v9 · canvas v1 · /);
  const sys = labSystem(tools, 'canvas');
  assert.match(sys, /const SCENES/);
  assert.match(sys, /```js/);
  assert.match(sys, /g\.drawImage\(images\.gen1/);
  assert.doesNotMatch(sys, /Remotion Agent Skills|```tsx|<Img|useCurrentFrame/);
  assert.match(compileFix('x'), /```tsx block\.$/);
  assert.match(compileFix('x', 'canvas'), /```js block\.$/);
  assert.match(runtimeFix('x'), /Remotion Player/);
  assert.match(runtimeFix('x', 'canvas'), /Canvas player/);
  assert.match(useSounds(['sfx1'], 'canvas'), /AUDIO = \[\{ sound: 'sfx1'/);
  assert.ok(usesSounds("const AUDIO = [{ sound: 'sfx2', at: 1 }];"));
  const soundTool = (words) => toolDefs({ sound: true }, words ? { words } : {})[0].function.description;
  assert.match(soundTool(), /<Audio src=\{sounds\.sfx1\}/);
  assert.match(soundTool(canvasEngine.words), /AUDIO = \[/);
});

test('Context Lab: cada variante elige motor; la plantilla por defecto y las skills dependen de él', () => {
  assert.equal(parseVariant({}).engine, 'remotion');
  assert.equal(parseVariant({ engine: 'canvas' }).engine, 'canvas');
  assert.equal(parseVariant({ engine: 'otro' }).engine, 'remotion');
  assert.equal(defaultTemplate(), defaultTemplate('remotion'));
  assert.match(defaultTemplate('canvas'), /const SCENES[\s\S]*\{\{herramientas\}\}[\s\S]*\{\{ejemplos\}\}/);
  const all = { search: true, images: true, sound: true, video: false };
  const canvas = contextConfig(parseVariant({ engine: 'canvas', policy: { search: 'optional', images: 'optional', sound: 'optional', video: 'off' } }), all);
  assert.equal(canvas.engine, 'canvas');
  assert.match(canvas.harness, /canvas v1/);
  assert.doesNotMatch(canvas.system, /Remotion Agent Skills|<Audio|```tsx/);
  assert.match(canvas.system, /AUDIO = \[\{ sound: 'sfx1'/);
  // Aunque la plantilla editada tenga {{skills}}, con canvas no entran las de Remotion.
  assert.equal(composeSystem({ template: 'A {{skills}}', enabled: {}, policy: {}, limits: {}, skills: DEFAULT_SKILLS, examples: '', engine: 'canvas' }), 'A');
  assert.match(contextConfig(parseVariant({}), all).harness, /remotion .* skills/);
});

const video = { name: 'clip.mp4', duration: 8, width: 1080, height: 1920 };
const frame = (t) => ({ t, url: 'data:image/jpeg;base64,AAAA' });
const clips = [{ id: 'C1', start: 0.5, end: 3, prompt: 'título', notes: '', refs: [], frames: [frame(0), frame(1)] }, { id: 'C2', start: 3, end: 6, prompt: 'grilla', notes: '', refs: [], frames: [frame(0)] }];

test('pipeline: con el motor canvas el agente entrega JS, se compila con su motor y el resultado dice qué motor es', async () => {
  const input = parseLabBody({ model: 'a/b', video, clips, brief: { context: 'x' }, engine: 'canvas' });
  assert.equal(input.engine, 'canvas');
  assert.equal(parseLabBody({ model: 'a/b', video, clips, brief: {} }).engine, 'remotion');
  const seen = [];
  const replies = ['Va.\n```js\nconst SCENES = [{ from: 0.5, to: 3, draw(t) { g.arc(0, 0, -1, 0, 1); } }];\n```', `Paleta: #F0EEE6\n\`\`\`js\n${SCENES}\n\`\`\``];
  const llm = async ({ messages }) => { seen.push(messages); return { text: replies[seen.length - 1], usage: {} }; };
  const events = [];
  await runLabAgent({ input, emit: (e) => events.push(e), llm });
  assert.equal(events.find((e) => e.type === 'run').engine, 'canvas');
  assert.match(seen[0][0].content, /const SCENES/); // prompt de sistema del motor canvas
  assert.match(events.find((e) => e.type === 'compile_error').text, /radio negativo/);
  assert.match(seen[1].at(-1).content, /```js block\.$/);
  const result = events.find((e) => e.type === 'result');
  assert.equal(result.engine, 'canvas');
  assert.match(result.js, /const SCENES/);
  assert.equal(result.notes, 'Paleta: #F0EEE6');
  assert.deepEqual(result.palette, ['#F0EEE6']);
  assert.match(events.find((e) => e.type === 'done').harness, /canvas v1/);
});

test('pipeline: las revisiones con canvas reenvían el código en un bloque ```js', async () => {
  const input = parseLabBody({ model: 'a/b', video, clips, brief: {}, engine: 'canvas', turns: [{ code: SCENES, kind: 'feedback', message: 'más grande' }] });
  let msgs;
  await runLabAgent({ input, emit: () => {}, llm: async ({ messages }) => { msgs = messages; return { text: `\`\`\`js\n${SCENES}\n\`\`\``, usage: {} }; } });
  assert.match(msgs[2].content, /^```js\n/);
  assert.match(msgs[3].content, /más grande[\s\S]*```js block\.$/);
});

test('demo: el modelo simulado escribe escenas canvas que compilan (y el barato se corrige)', async () => {
  const { mockLabLLM } = await import('../src/lab/mock.js');
  for (const model of ['anthropic/claude-opus-5.5', 'google/gemini-3.8-flash']) {
    const input = parseLabBody({ model, video, clips, brief: {}, engine: 'canvas' });
    const events = [];
    await runLabAgent({ input, emit: (e) => events.push(e), llm: mockLabLLM });
    assert.equal(events.find((e) => e.type === 'result')?.engine, 'canvas', model);
  }
});
