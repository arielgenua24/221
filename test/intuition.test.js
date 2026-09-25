import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseIntuitionBody, parseRevisionBody, normalizeDirection, sanitizeBox, runIntuitionPipeline, runIntuitionRevision } from '../src/intuition-pipeline.js';
import { parseMotion, MOTION_SYSTEM, ART_DIRECTOR_SYSTEM, RUNTIME_CONTRACT } from '../src/intuition-prompts.js';
import { HELPERS, HELPER_DOCS, FONTS, compileMotion, checkMotionCode, makeEnv, googleFontsUrl } from '../public/motion-lib.js';
import { mockLLM, mockMotionCode } from '../src/mock.js';

const IMG = 'data:image/jpeg;base64,/9j/AA==';
const frames = (n = 6) => Array.from({ length: n }, (_, i) => ({ t: i * 0.5, url: IMG }));
const video = { name: 'v.mp4', duration: 20, width: 1080, height: 1920 };
const clip = (id, start, end, extra = {}) => ({ id, start, end, prompt: `pedido ${id}`, frames: frames(), refs: [], ...extra });

// Contexto 2D falso: registra las llamadas (sirve para ejecutar el código de demostración en Node).
function fakeCtx() {
  const calls = [];
  const gradient = { addColorStop() {} };
  return new Proxy({ calls }, {
    get(target, k) {
      if (k in target) return target[k];
      if (k === 'measureText') return (s) => ({ width: String(s).length * 10 });
      if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => gradient;
      return (...args) => { calls.push([k, ...args]); };
    },
    set(target, k, v) { target[k] = v; return true; },
  });
}

test('parseIntuitionBody valida clips, los ordena y descarta imágenes inválidas', () => {
  const out = parseIntuitionBody({
    text: 'marca de café',
    video,
    clips: [clip('C2', 10, 14), clip('C1', 1, 4, { frames: [...frames(), { t: 1, url: 'http://x' }], refs: [{ kind: 'video', name: 'ref', frames: [IMG, IMG, IMG, IMG, IMG] }, { kind: 'image', frames: ['nope'] }] })],
  });
  assert.deepEqual(out.clips.map((c) => c.id), ['C1', 'C2']);
  assert.equal(out.clips[0].frames.length, 6);
  assert.equal(out.clips[0].refs.length, 1);
  assert.equal(out.clips[0].refs[0].frames.length, 4);
  assert.throws(() => parseIntuitionBody({ video, clips: [] }), /al menos un clip/);
  assert.throws(() => parseIntuitionBody({ video, clips: [clip('C1', 0, 6)] }), /máximo 5/);
  assert.throws(() => parseIntuitionBody({ video, clips: [clip('C1', 0, 3), clip('C2', 2, 4)] }), /superponerse/);
  assert.throws(() => parseIntuitionBody({ video, clips: [clip('C1', 18, 22)] }), /se sale/);
  assert.throws(() => parseIntuitionBody({ video, clips: [clip('C1', 0, 2), clip('C2', 3, 4), clip('C3', 5, 6), clip('C4', 7, 8)] }), /Máximo 3/);
  assert.throws(() => parseIntuitionBody({ video: { duration: 0 }, clips: [clip('C1', 0, 2)] }), /Falta el video/);
});

test('sanitizeBox mantiene la ventana dentro del cuadro', () => {
  assert.deepEqual(sanitizeBox({ x: 0.9, y: -1, w: 0.5, h: 2 }), { x: 0.5, y: 0, w: 0.5, h: 1 });
  assert.deepEqual(sanitizeBox(null), { x: 0.08, y: 0.14, w: 0.84, h: 0.3 });
  assert.equal(sanitizeBox({ x: 0, y: 0, w: 0.01, h: 0.01 }).w, 0.1);
});

test('normalizeDirection corrige tipografías, colores y ventanas', () => {
  const d = normalizeDirection({ sistema: { tipografias: { display: 'Comic Sans', texto: 'Inter' }, paleta: [{ hex: '#ff0000' }, { hex: 'rojo' }] }, clips: [{ id: 'C1', ventana: { x: 2 } }] }, [clip('C1', 0, 2), clip('C2', 3, 5)]);
  assert.equal(d.sistema.tipografias.display, 'Inter');
  assert.deepEqual(d.sistema.paleta.map((p) => p.hex), ['#FF0000']);
  assert.equal(d.clips.length, 2);
  assert.ok(d.clips.every((c) => c.ventana.x + c.ventana.w <= 1));
  const empty = normalizeDirection(null, [clip('C1', 0, 2)]);
  assert.ok(empty.sistema.paleta.length >= 2);
});

test('parseMotion separa el JSON del código y detecta errores', () => {
  const ok = parseMotion('Notas:\n- algo\n\n```json\n{"idea":"x"}\n```\n\n```js\nfunction draw(ctx, t, env) { ctx.fillRect(0, 0, 1, 1); }\n```');
  assert.equal(ok.idea, 'x');
  assert.match(ok.code, /function draw/);
  // Sin JSON igual sirve: lo esencial es el código.
  assert.match(parseMotion('```javascript\nconst draw = (ctx) => {};\n```').code, /draw/);
  assert.throws(() => parseMotion('```json\n{}\n```'), /falta el bloque/);
  assert.throws(() => parseMotion('```js\nfunction draw(ctx) { ctx.fill(\n```'), /sintaxis/);
  assert.throws(() => parseMotion('```js\nfunction draw(ctx) {\n'), /cortado/);
  assert.throws(() => parseMotion('```js\nfunction paint() {}\n```'), /falta la función draw/);
  assert.throws(() => parseMotion('```js\nfunction draw() { return Math.random(); }\n```'), /rand\(seed\)/);
  assert.throws(() => parseMotion('```js\nfunction draw() { return Date.now(); }\n```'), /reloj/);
});

test('el código puede declarar constantes con el nombre de un helper', () => {
  const { draw } = compileMotion('const lerp = (a, b) => a + b;\nfunction draw() { return lerp(1, 2) + clamp(5, 0, 1); }');
  assert.equal(draw(), 4);
});

test('los helpers documentados existen y las curvas van de 0 a 1', () => {
  for (const [sig] of HELPER_DOCS) {
    const name = sig.split(/[.(]/)[0].trim();
    assert.ok(name in HELPERS, `falta el helper ${name}`);
  }
  for (const [name, f] of Object.entries(HELPERS.ease)) {
    assert.ok(Math.abs(f(0)) < 1e-6, `${name}(0)`);
    assert.ok(Math.abs(f(1) - 1) < 1e-6, `${name}(1)`);
  }
  assert.ok(Math.abs(HELPERS.bezier(0.2, 0.8, 0.2, 1)(1) - 1) < 1e-6);
  assert.ok(HELPERS.spring(3) > 0.99 && HELPERS.spring(3) < 1.01);
  assert.equal(HELPERS.rand(7), HELPERS.rand(7));
  assert.equal(HELPERS.rgba('#ff0000', 0.5), 'rgba(255,0,0,0.5)');
  assert.equal(HELPERS.stagger(0.5, 0, 3, { start: 0, each: 1, total: 2 }), 0.5);
  assert.match(googleFontsUrl('Playfair Display'), /ital,wght@0,400;0,700;1,400;1,700/);
  assert.equal(googleFontsUrl('Comic Sans'), null);
});

test('los prompts llevan el manual de motion design y el contrato técnico', () => {
  const manual = readFileSync(new URL('../src/MOTION_DESIGN.md', import.meta.url), 'utf8');
  assert.ok(ART_DIRECTOR_SYSTEM.includes(manual));
  assert.ok(MOTION_SYSTEM.includes(manual) && MOTION_SYSTEM.includes(RUNTIME_CONTRACT));
  for (const f of Object.keys(FONTS)) assert.ok(RUNTIME_CONTRACT.includes(f));
});

test('el motion de demostración compila, es determinista y termina limpio', () => {
  const { setup, draw } = compileMotion(mockMotionCode({ text: 'Nuevo drop de verano', index: 1, total: 3 }));
  for (const [w, h] of [[900, 400], [300, 900], [60, 40]]) {
    const env = makeEnv({ w, h, dur: 4, fonts: { display: 'Space Grotesk', text: 'JetBrains Mono' }, palette: [{ hex: '#F4F1EA' }, { hex: '#FF5A1F' }] });
    const ctx = fakeCtx();
    env.state = setup(env, ctx);
    assert.ok(env.state.lines.length >= 1);
    const frame = (t) => { const c = fakeCtx(); draw(c, t, env); return JSON.stringify(c.calls); };
    assert.equal(frame(1.3), frame(1.3));
    assert.notEqual(frame(0.2), frame(1.3));
    for (const t of [0, 0.5, 2, 3.9, 4]) assert.doesNotThrow(() => frame(t));
  }
});

test('flujo completo en modo demo: sistema visual + un motion por clip', async () => {
  const input = parseIntuitionBody({ text: 'café de especialidad', video, clips: [clip('C1', 1, 4), clip('C2', 6, 10), clip('C3', 12, 16)] });
  const events = [];
  const log = await runIntuitionPipeline({ ...input, emit: (e) => events.push(e), llm: mockLLM, config: { motionModel: 'demo' } });
  const direction = events.find((e) => e.type === 'direction').data;
  assert.equal(direction.clips.length, 3);
  assert.ok(FONTS[direction.sistema.tipografias.display]);
  const motions = events.filter((e) => e.type === 'motion').map((e) => e.data);
  assert.deepEqual(motions.map((m) => m.id).sort(), ['C1', 'C2', 'C3']);
  motions.forEach((m) => assert.doesNotThrow(() => checkMotionCode(m.code)));
  assert.equal(log.result.motions.length, 3);
  assert.ok(events.some((e) => e.type === 'step_start' && e.step === 'motion-C2'));

  // Revisión de un clip con el pedido del humano.
  const rev = parseRevisionBody({
    video, clip: input.clips[1], direction, box: direction.clips[1].ventana, index: 1, total: 3,
    previous: { code: motions.find((m) => m.id === 'C2').code, meta: { idea: 'x' } }, feedback: 'más lento',
  });
  const revEvents = [];
  await runIntuitionRevision({ ...rev, emit: (e) => revEvents.push(e), llm: mockLLM, config: { motionModel: 'demo' } });
  const revised = revEvents.find((e) => e.type === 'motion').data;
  assert.equal(revised.id, 'C2');
  assert.equal(revised.revision, true);
  assert.match(revised.nota, /más lento/);
});

test('parseRevisionBody pide un cambio o un error', () => {
  const base = { video, clip: clip('C1', 0, 2), direction: { sistema: {} }, previous: { code: 'function draw(){}' } };
  assert.throws(() => parseRevisionBody(base), /qué querés cambiar/);
  assert.throws(() => parseRevisionBody({ ...base, feedback: 'x', direction: null }), /sistema visual/);
  assert.equal(parseRevisionBody({ ...base, error: 'TypeError' }).error, 'TypeError');
});

test('un Motion Designer que falla no tira abajo a los demás', async () => {
  const input = parseIntuitionBody({ video, clips: [clip('C1', 1, 3), clip('C2', 5, 7)] });
  const llm = async (opts) => {
    if (opts.step === 'motion-C2') return { text: 'sin código', usage: {} };
    return mockLLM(opts);
  };
  const events = [];
  const log = await runIntuitionPipeline({ ...input, emit: (e) => events.push(e), llm, config: { motionModel: 'demo' } });
  assert.equal(log.result.motions.length, 1);
  assert.ok(events.some((e) => e.type === 'step_error' && e.step === 'motion-C2'));
  // Se pidió corrección antes de rendirse.
  assert.ok(events.some((e) => e.type === 'notice' && e.step === 'motion-C2'));
});
