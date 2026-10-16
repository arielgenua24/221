import test from 'node:test';
import assert from 'node:assert/strict';
import { createLabTools } from '../src/lab/tools.js';
import { briefContent } from '../src/lab/harness.js';
import { parseLabBody } from '../src/lab/pipeline.js';

const IMG = 'data:image/jpeg;base64,/9j/AA==';
const call = (name, args, id = 'call_1') => ({ id, function: { name, arguments: JSON.stringify(args) } });
const ctx = (events) => ({
  emit: (e) => events.push(e), registry: new Map([['C1-1', IMG]]), sounds: new Map(), zones: [{ id: 'C1', from: 0, durationInFrames: 90 }], fps: 30, aspect: '9:16', limits: undefined,
  state: { searches: 0, searchSeq: 0, generated: 0, sounds: 0, videos: 0, toolCost: 0 },
});

test('las herramientas avisan cuándo empiezan y cuándo terminan, con su costo, para el registro de la pantalla', async () => {
  const tools = createLabTools({ mock: true });
  const events = [];
  const c = ctx(events);
  await tools.run(call('generar_imagen', { prompt: 'sticker del producto', imagenes: ['C1-1'] }, 'a1'), c);
  await tools.run(call('generar_sonido', { descripcion: 'short whoosh', duracion: 1 }, 'a2'), c);
  const types = events.map((e) => e.type);
  assert.deepEqual(types, ['tool', 'asset', 'tool_done', 'tool', 'sound', 'tool_done']);
  assert.equal(events[0].id, 'a1');
  const done = events.filter((e) => e.type === 'tool_done');
  assert.ok(done.every((d) => d.ok === true && d.cost > 0 && Number.isFinite(d.ms)));
  assert.deepEqual(done.map((d) => d.id), ['a1', 'a2']);
});

test('una herramienta que falla se avisa como error (con el mensaje), sin cobrar, y una inexistente también', async () => {
  const tools = createLabTools({ mock: true });
  const events = [];
  const c = ctx(events);
  await tools.run(call('generar_imagen', { prompt: 'x', imagenes: ['NOPE-9'] }, 'e1'), c); // referencia que no existe
  await tools.run(call('hacer_cafe', {}, 'e2'), c);
  const done = events.filter((e) => e.type === 'tool_done');
  assert.deepEqual(done.map((d) => d.ok), [false, false]);
  assert.match(done[0].error, /no existen estas imágenes/);
  assert.match(done[1].error, /no existe en este entorno/);
  assert.equal(done[0].cost, 0);
  // Argumentos que no son JSON también cierran la llamada.
  const bad = [];
  await tools.run({ id: 'e3', function: { name: 'generar_imagen', arguments: '{no' } }, ctx(bad));
  assert.deepEqual(bad.map((e) => e.type), ['tool', 'tool_done']);
  assert.equal(bad[1].ok, false);
});

const video = { name: 'v.mp4', duration: 12, width: 1080, height: 1920 };
const clip = (extra = {}) => ({ id: 'C1', start: 1, end: 4, prompt: 'p', notes: '', frames: [{ t: 0.5, url: IMG }], refs: [], toolPlan: [{ tool: 'images', at: 2.5, note: 'ilustración de Nemo' }, { tool: 'sound', at: 3, note: 'whoosh' }, { tool: 'robar', at: 3, note: 'x' }], ...extra });
const brief = { context: '', instructions: '', refs: [] };

test('el plan de herramientas de cada zona llega al agente, solo con las herramientas que esa ejecución tiene encendidas', () => {
  const input = parseLabBody({ model: 'anthropic/claude-opus-5.5', video, clips: [clip()], brief });
  assert.deepEqual(input.clips[0].toolPlan.map((u) => u.tool), ['images', 'sound']); // 'robar' no es una herramienta
  const all = briefContent({ brief, video, clips: input.clips }, { enabled: { search: true, images: true, sound: true, video: true } })[0].text;
  assert.match(all, /Editor’s plan for this zone.*image generation «ilustración de Nemo» around 2\.50 s · sound generation «whoosh» around 3\.00 s/);
  const noSound = briefContent({ brief, video, clips: input.clips }, { enabled: { images: true } })[0].text;
  assert.match(noSound, /image generation/);
  assert.doesNotMatch(noSound, /sound generation/);
  const none = briefContent({ brief, video, clips: input.clips }, { enabled: { search: false, images: false } })[0].text;
  assert.doesNotMatch(none, /Editor’s plan/);
  // Sin plan (marcado a mano) no aparece nada.
  assert.doesNotMatch(briefContent({ brief, video, clips: parseLabBody({ model: 'anthropic/claude-opus-5.5', video, clips: [clip({ toolPlan: undefined })], brief }).clips }, { enabled: { images: true } })[0].text, /Editor’s plan/);
});
