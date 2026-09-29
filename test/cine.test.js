import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FILM_GUIDES, FILM_RULES, filmManual } from '../src/film-knowledge.js';
import { CINE_SYSTEM, cinePrompt, refilmPrompt } from '../src/cine-prompts.js';
import { normalizeTreatment, evalTreatment, envelope } from '../public/cine-lib.js';
import { parseIntuitionBody, parseRevisionBody, runIntuitionPipeline, runIntuitionRevision } from '../src/intuition-pipeline.js';
import { createMockWaveSpeed, EDIT_MODEL } from '../src/wavespeed.js';
import { mockLLM } from '../src/mock.js';

const IMG = 'data:image/jpeg;base64,/9j/AA==';
const CLIP_VIDEO = 'data:video/webm;base64,GkXfow==';
const frames = (n = 6) => Array.from({ length: n }, (_, i) => ({ t: i * 0.5, url: IMG }));
const video = { name: 'v.mp4', duration: 20, width: 1080, height: 1920 };
const clip = (id, start, end, extra = {}) => ({ id, start, end, prompt: `pedido ${id}`, frames: frames(), refs: [], mode: 'cine', ...extra });
const config = { motionModel: 'm', videoResolution: '720p' };

test('la biblioteca agents-film se carga entera y el manual del DP cita reglas por id', () => {
  assert.ok(FILM_GUIDES.length >= 14);
  assert.ok(FILM_RULES.has('camera-movement/push-in'));
  const manual = filmManual({ full: ['cinematic-light'] });
  assert.match(manual, /<guia id="motivated-lighting"/);
  assert.doesNotMatch(manual, /<guia id="rule-of-six"/); // de las demás, solo el catálogo
  assert.match(manual, /`rule-of-six\//);
  // El manual va primero y marcado para el caché; el oficio del DP, después.
  assert.equal(CINE_SYSTEM[0].cache_control.type, 'ephemeral');
  assert.match(CINE_SYSTEM[0].text, /<guia id="color-direction"/);
  assert.match(CINE_SYSTEM[1].text, /Re-filmar con IA/);
});

test('normalizeTreatment deja todo dentro de rango', () => {
  const t = normalizeTreatment({
    grade: { exposicion: 9, contraste: 'x', saturacion: -5, sombras: { hex: '#123abc', fuerza: 3 }, luces: { hex: 'rojo', fuerza: 1 } },
    luz: { tipo: 'ventana', keyframes: [{ t: 99, x: 5, fuerza: 2 }, { t: 0.5 }] },
    camara: { easing: 'raro', keyframes: [{ t: 3, zoom: 3, x: 4, rot: 40 }] },
    refilmar: { recomendado: true, prompt: 'corto' },
    reglas_aplicadas: [{ id: 'camera-movement/push-in', por_que: 'intención' }, 'shot-framing/close-up'],
  }, 2);
  assert.equal(t.grade.exposicion, 1);
  assert.equal(t.grade.contraste, 0);
  assert.equal(t.grade.saturacion, -1);
  assert.deepEqual(t.grade.sombras, { hex: '#123ABC', fuerza: 1 });
  assert.equal(t.grade.luces.fuerza, 0); // color inválido: no tiñe
  assert.deepEqual(t.luz.keyframes.map((k) => k.t), [0.5, 2]); // ordenados y dentro del clip
  assert.equal(t.luz.keyframes[1].x, 1.3);
  assert.equal(t.camara.easing, 'inOutCubic');
  assert.deepEqual(t.camara.keyframes[0], { zoom: 1.4, x: 1, y: 0, rot: 5, t: 2 });
  assert.equal(t.refilmar.recomendado, false); // sin un prompt de verdad no se propone
  assert.deepEqual(t.reglas, ['camera-movement/push-in', 'shot-framing/close-up']);
  const empty = normalizeTreatment(null, 3);
  assert.equal(empty.luz.tipo, 'ninguna');
  assert.equal(empty.camara.keyframes.length, 1);
});

test('evalTreatment: entra y sale suave, y la cámara nunca deja ver los bordes', () => {
  const tr = normalizeTreatment({
    grade: { contraste: 0.4, grano: 0.5 },
    camara: { handheld: 1, keyframes: [{ t: 0, zoom: 1 }, { t: 3, zoom: 1.2, x: 1, y: -1, rot: 3 }] },
    luz: { tipo: 'key', keyframes: [{ t: 0, x: 0.2, y: 0.2, fuerza: 0.5 }] },
    transicion: { entrada: 0.5, salida: 0.5 },
  }, 3);
  assert.equal(envelope(tr, 0, 3), 0);
  assert.equal(envelope(tr, 1.5, 3), 1);
  assert.equal(evalTreatment(tr, 0, 3).con, 0);
  const mid = evalTreatment(tr, 2.5, 3);
  assert.ok(Math.abs(mid.con - 0.4) < 1e-9);
  for (let t = 0; t <= 3; t += 0.1) {
    const [zoom, ox, oy] = evalTreatment(tr, t, 3).cam;
    const slack = (1 - 1 / zoom) / 2;
    assert.ok(Math.abs(ox) <= slack + 1e-9 && Math.abs(oy) <= slack + 1e-9, `bordes en t=${t}`);
  }
  // Encima de una toma re-filmada, "textura" deja solo grano/halation/viñeta.
  const tex = evalTreatment(tr, 1.5, 3, { parts: 'textura' });
  assert.equal(tex.con, 0);
  assert.equal(tex.cam[0], 1);
  assert.equal(tex.light[3], 0);
  assert.ok(tex.grain > 0);
  assert.equal(evalTreatment(tr, 1.5, 3, { intensity: 0 }).grain, 0);
});

test('el prompt del DP y el de re-filmar', () => {
  const direction = { concepto: 'c', sistema: { paleta: [{ hex: '#111111', rol: 'x' }] }, clips: [{ id: 'C1', idea: 'íntimo' }] };
  const c = parseIntuitionBody({ video, clips: [clip('C1', 0, 3)] }).clips[0];
  assert.equal(c.mode, 'cine');
  assert.match(cinePrompt({ direction, clip: c, index: 0, total: 1, video, refilm: false }), /NO disponible/);
  assert.match(cinePrompt({ direction, clip: c, index: 0, total: 1, video, refilm: true }), /"t" van de 0 a 3\.00/);
  const p = refilmPrompt({ prompt: 'Relight with warm window light.', preservar: ['her face'], evitar: ['face changes'] });
  assert.match(p, /^Relight/);
  assert.match(p, /Preserve exactly: her face\./);
  assert.equal(p.match(/face changes/g).length, 1);
  assert.equal(EDIT_MODEL.body({ prompt: 'p', video: 'u', resolution: '720p' }).generate_audio, false);
});

async function run({ clips, ws, ask }) {
  const events = [];
  const asked = [];
  const log = await runIntuitionPipeline({
    text: '', video, clips: parseIntuitionBody({ video, clips }).clips, emit: (e) => events.push(e), llm: mockLLM, config, ws,
    ask: async (d) => { asked.push(d); return ask(d); },
  });
  return { events, asked, log };
}

test('Cinematic Pro: el DP entrega el tratamiento; re-filmar solo si el humano aprueba y manda el clip', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'cine-'));
  try {
    const ws = createMockWaveSpeed({ mediaDir: dir });
    const calls = [];
    const origVideo = ws.video;
    ws.video = async (opts) => { calls.push(opts); return origVideo(opts); };

    // El demo propone re-filmar el primer clip: aprobado con el clip grabado.
    const ok = await run({ clips: [clip('C1', 0, 3), clip('C2', 5, 7, { mode: 'motion' })], ws, ask: () => ({ aprobar: true, video: CLIP_VIDEO, prompt: '' }) });
    const cine = ok.events.find((e) => e.type === 'cine');
    assert.equal(cine.data.id, 'C1');
    assert.equal(cine.data.luz.tipo, 'ventana');
    assert.ok(ok.events.some((e) => e.type === 'motion' && e.data.id === 'C2'));
    assert.equal(ok.asked.length, 1);
    assert.equal(ok.asked[0].kind, 'refilm');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].model, EDIT_MODEL.path());
    assert.equal(calls[0].body.video, CLIP_VIDEO); // el mock no sube: pasa el data URL tal cual
    assert.match(calls[0].body.prompt, /Keep the original motion/);
    assert.ok(ok.events.some((e) => e.type === 'cine_video' && e.data.id === 'C1' && e.data.demo));
    assert.ok(ok.log.cine.C1.refilm.approved);

    // Rechazado: no se genera nada y el reproductor se queda con el tratamiento.
    calls.length = 0;
    const no = await run({ clips: [clip('C1', 0, 3)], ws, ask: () => ({ aprobar: false }) });
    assert.equal(calls.length, 0);
    assert.ok(no.events.some((e) => e.type === 'cine_video' && e.data.skipped));

    // Sin WaveSpeed: ni se pregunta.
    const off = await run({ clips: [clip('C1', 0, 3)], ws: null, ask: () => ({ aprobar: true }) });
    assert.equal(off.asked.length, 0);
    assert.equal(off.events.find((e) => e.type === 'cine').data.refilmar.recomendado, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Cinematic Pro: rehacer el tratamiento con el pedido del humano', async () => {
  const direction = { sistema: { paleta: [] }, clips: [{ id: 'C1' }] };
  assert.throws(() => parseRevisionBody({ video, clip: clip('C1', 0, 3), direction, feedback: 'más frío', previous: {} }), /tratamiento anterior/);
  const input = parseRevisionBody({ video, clip: clip('C1', 0, 3), direction, feedback: 'más frío', previous: { treatment: { grade: {} } } });
  const events = [];
  await runIntuitionRevision({ ...input, emit: (e) => events.push(e), llm: mockLLM, config });
  const out = events.find((e) => e.type === 'cine');
  assert.ok(out.data.revision);
  assert.ok(out.data.grade.temperatura < 0);
  assert.equal(out.data.refilmar.recomendado, false);
});
