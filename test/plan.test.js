import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { planTranscript, planMessages, parsePlan, planZones, heuristicPlan, saidBetween, MIN_PLAN_SECONDS, MAX_PLAN_SECONDS } from '../src/lab/plan.js';
import { saidBetween as clientSaid } from '../public/auto-plan.js';
import { transcriptFrom } from '../src/lab/transcript.js';
import { parseLabBody, MAX_LAB_CLIPS } from '../src/lab/pipeline.js';

const REAL = JSON.parse(readFileSync(new URL('./fixtures/whisper-output.json', import.meta.url), 'utf8'));
const transcript = transcriptFrom(REAL, 6.03);
const video = { name: 'v.mp4', duration: 20 };
const opts = { count: 3, duration: 20 };

test('planTranscript: una línea por segundo con el instante exacto en que arranca; los silencios se juntan', () => {
  const text = planTranscript([{ t: 0, text: 'hola', at: 0.3 }, { t: 1, text: '', at: null }, { t: 2, text: '', at: null }, { t: 3, text: 'mundo', at: 3 }]);
  assert.equal(text, '0:00 · desde 0.3 s · hola\n0:01–0:02 · (sin habla)\n0:03 · desde 3 s · mundo');
});

test('planMessages: pide exactamente N momentos, con la transcripción, el contexto y los límites', () => {
  const [system, user] = planMessages({ count: 4, video, brief: { context: 'cafetería', instructions: 'títulos grandes' }, transcript });
  assert.match(system.content, /EXACTAMENTE 4 momentos/);
  assert.match(system.content, new RegExp(`de ${MIN_PLAN_SECONDS} a ${MAX_PLAN_SECONDS} s`));
  assert.match(user.content, /# Cuántas animaciones\n4/);
  assert.match(user.content, /cafetería/);
  assert.match(user.content, /0:01 · desde 1\.2 s · Pixar, Nemo/);
  // Solo recorta: no pide ideas de animación ni herramientas.
  assert.match(system.content, /no proponés ideas/);
  assert.doesNotMatch(system.content, /"idea"|"tools"/);
});

test('parsePlan acepta JSON con texto o fences alrededor y normaliza las zonas', () => {
  const { zones, note } = parsePlan('Acá va:\n```json\n{"zones":[{"start":10,"end":14,"frames":[10.5,12,13.8],"idea":" Título  grande "},{"start":2,"end":5,"frames":[2.5,4],"idea":"a"}],"nota":"ok"}\n```', opts);
  assert.deepEqual(zones.map((z) => [z.start, z.end]), [[2, 5], [10, 14]]); // ordenadas
  assert.equal(zones[1].idea, undefined); // lo que invente el modelo no pasa
  assert.equal(zones[1].tools, undefined);
  assert.deepEqual(zones[1].frames, [10.5, 12, 13.8]);
  assert.equal(note, 'ok');
});

test('parsePlan arregla lo arreglable: largo, bordes del video, superposiciones y cuadros fuera de la zona', () => {
  const { zones } = parsePlan(JSON.stringify({ zones: [
    { start: 1, end: 30, frames: [1.5, 50, -3] }, // se acorta a 8 s; los cuadros fuera de la zona se descartan y se completan
    { start: 5, end: 9, frames: [6, 7] }, // pisa a la anterior: se descarta
    { start: 18.9, end: 19.2, frames: [19] }, // muy corta y al final del video: se estira hacia atrás
    { start: 'x', end: 3 }, // inválida
  ] }), opts);
  assert.equal(zones.length, 2);
  assert.deepEqual([zones[0].start, zones[0].end], [1, 9]);
  assert.ok(zones[0].frames.length >= 2 && zones[0].frames.every((t) => t >= 1 && t <= 9));
  assert.ok(zones[1].end <= 20 && zones[1].end - zones[1].start >= MIN_PLAN_SECONDS - 0.01);
  assert.ok(zones.every((z) => z.frames.length >= 2 && z.frames.length <= 4));
});

test('parsePlan: nunca devuelve más zonas que las pedidas, ni más de 4 cuadros por zona; si no hay JSON, falla claro', () => {
  const many = Array.from({ length: 6 }, (_, i) => ({ start: i * 3, end: i * 3 + 2, frames: [i * 3, i * 3 + 0.5, i * 3 + 1, i * 3 + 1.5, i * 3 + 2] }));
  const { zones } = parsePlan(JSON.stringify({ zones: many }), { count: 2, duration: 20 });
  assert.equal(zones.length, 2);
  assert.ok(zones.every((z) => z.frames.length === 4));
  assert.throws(() => parsePlan('no sé', opts), /JSON válido/);
  assert.throws(() => parsePlan('{"a":1}', opts), /"zones"/);
});

test('planZones llama al modelo, suma el costo y reintenta una vez si la primera respuesta no sirve', async () => {
  const calls = [];
  const llm = async (o) => {
    calls.push(o);
    return calls.length === 1
      ? { text: 'te lo debo', usage: { cost: 0.01, total_tokens: 100 } }
      : { text: '{"zones":[{"start":1,"end":4,"frames":[1.2,3],"idea":"x"}]}', usage: { cost: 0.02, total_tokens: 120 } };
  };
  const out = await planZones({ llm, model: 'a/b', count: 1, video, brief: {}, transcript });
  assert.equal(calls.length, 2);
  assert.match(calls[1].messages.at(-1).content, /Tu respuesta no sirve/);
  assert.equal(out.zones.length, 1);
  assert.equal(out.zones[0].idea, undefined);
  assert.equal(out.zones[0].said, saidBetween(transcript.heads, 1, 4)); // lo que se dice, de la transcripción
  assert.ok(out.zones[0].said.length > 0);
  assert.ok(Math.abs(out.cost - 0.03) < 1e-9);
  assert.equal(out.tokens, 220);
  await assert.rejects(planZones({ llm: async () => ({ text: 'nada', usage: {} }), model: 'a/b', count: 1, video, brief: {}, transcript }), /no devolvió un plan válido/);
});

test('heuristicPlan (demo): elige los segundos con más habla, repartidos y sin pisarse', () => {
  const heads = Array.from({ length: 20 }, (_, t) => ({ t, at: t, text: t % 2 ? 'uno dos tres' : 'a' }));
  const out = heuristicPlan({ count: 3, video: { duration: 20 }, transcript: { heads } });
  assert.equal(out.zones.length, 3);
  assert.ok(out.zones.every((z, i) => !i || z.start >= out.zones[i - 1].end));
  assert.ok(out.zones.every((z) => z.frames.length === 3 && z.frames.every((t) => t >= z.start && t <= z.end)));
  assert.equal(out.cost, 0);
});

test('el Laboratorio acepta hasta 6 zonas (el modo Automático elige cuántas) pero no más', () => {
  const IMG = 'data:image/jpeg;base64,/9j/AA==';
  const clips = (n) => Array.from({ length: n }, (_, i) => ({ id: `C${i + 1}`, start: i * 3, end: i * 3 + 2, prompt: '', notes: '', frames: [{ t: 0.5, url: IMG }], refs: [] }));
  const body = (n) => ({ model: 'anthropic/claude-opus-5.5', video: { name: 'v.mp4', duration: 30, width: 1080, height: 1920 }, clips: clips(n), brief: {} });
  assert.equal(parseLabBody(body(MAX_LAB_CLIPS)).clips.length, 6);
  assert.throws(() => parseLabBody(body(MAX_LAB_CLIPS + 1)), /Máximo 6 clips/);
});

// ---------- Lo que se dice en cada zona ----------
test('saidBetween: el texto tal cual de los segundos con habla que tocan la zona (igual en servidor y navegador)', () => {
  const heads = [{ t: 0, text: 'hola' }, { t: 1, text: '' }, { t: 2, text: 'esto  cuesta' }, { t: 3, text: '12.900 pesos' }, { t: 4, text: 'chau' }];
  assert.equal(saidBetween(heads, 2.4, 4), 'esto cuesta 12.900 pesos');
  assert.equal(saidBetween(heads, 0.5, 1.8), 'hola');
  assert.equal(saidBetween(heads, 1, 2), '');
  for (const [a, b] of [[2.4, 4], [0, 5], [1, 2]]) assert.equal(clientSaid(heads, a, b), saidBetween(heads, a, b));
});

test('heuristicPlan (demo) trae lo que se dice y no inventa herramientas', () => {
  const heads = Array.from({ length: 20 }, (_, t) => ({ t, at: t, text: `palabra${t}` }));
  const out = heuristicPlan({ count: 2, video: { duration: 20 }, transcript: { heads } });
  assert.ok(out.zones.every((z) => z.said.startsWith('palabra') && z.tools === undefined && z.idea === undefined));
});
