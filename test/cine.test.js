import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FILM_GUIDES, FILM_RULES, filmManual } from '../src/film-knowledge.js';
import { CINE_SYSTEM, cinePrompt, refilmPrompt, cineStoryboardPrompt, storyboardSheetAspect } from '../src/cine-prompts.js';
import { normalizeTreatment, evalTreatment, envelope } from '../public/cine-lib.js';
import { parseIntuitionBody, parseRevisionBody, runIntuitionPipeline, runIntuitionRevision } from '../src/intuition-pipeline.js';
import { createMockWaveSpeed, REFILM_MODELS, DEFAULT_REFILM_MODEL, refilmResolution } from '../src/wavespeed.js';
import { mockLLM } from '../src/mock.js';

const IMG = 'data:image/jpeg;base64,/9j/AA==';
const CLIP_VIDEO = 'data:video/mp4;base64,AAAAIGZ0eXA=';
const frames = (n = 6) => Array.from({ length: n }, (_, i) => ({ t: i * 0.5, url: IMG }));
const video = { name: 'v.mp4', duration: 20, width: 1080, height: 1920 };
const clip = (id, start, end, extra = {}) => ({ id, start, end, prompt: `pedido ${id}`, frames: frames(), refs: [], mode: 'cine', ...extra });
const config = { motionModel: 'm', videoResolution: '720p', storyboardModel: 'openai/gpt-image-2.5-flare/edit', storyboardQuality: 'high' };

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
  // Sin storyboard, misma cámara: lo que cambia va primero y lo que se conserva son los ejes que no cambian.
  const luz = { eje: 'luz', en_ingles: 'Warm window light from the left.' };
  const p = refilmPrompt({ cambios: [luz], prompt: 'Soft haze.', preservar: ['her face'], evitar: ['face changes'] }, { video: true, frames: 1 });
  assert.match(p, /^What changes from the original footage \(most important\):\n- Warm window light from the left\./);
  assert.match(p, /Video 1, Image 1 are the original footage: use them only for .*motion and timing/);
  assert.match(p, /Keep unchanged: the original camera position, angle, lens and camera movement;/);
  assert.doesNotMatch(p, /Keep unchanged:[^\n]*original light/); // la luz cambia: no se puede pedir conservarla
  assert.doesNotMatch(p, /her face/); // "preservar" es para el humano (en español): no va al modelo
  assert.equal(p.match(/face changes/g).length, 1);
  // Con storyboard y cámara nueva: el storyboard es Image 1 y la fuente de la verdad; nada pide conservar la cámara original.
  const spy = { eje: 'punto_de_vista', en_ingles: 'Seen through a hidden spy camera on the desk, fisheye.' };
  const moved = refilmPrompt({ cambios: [spy], cambia_camara: true, vinetas: [{ t: 0, encuadre: 'tabletop fisheye', accion: 'they talk' }], prompt: 'Cold light.', evitar: [] }, { storyboard: true, video: false, frames: 3 });
  assert.match(moved, /^Image 1 is the approved storyboard: .* source of truth/);
  assert.match(moved, /Storyboard panels:\n1\. \(0\.0 s\) tabletop fisheye — they talk/);
  assert.match(moved, /Image 2, Image 3, Image 4 are the original footage: use them only for who the people are/);
  assert.match(moved, /Do NOT copy the original camera position/);
  assert.doesNotMatch(moved, /Video 1|same framing|Keep unchanged:[^\n]*camera/i);
  assert.match(moved, /never show storyboard panels/);
  // El eje punto de vista implica cámara nueva.
  assert.equal(normalizeTreatment({ refilmar: { cambios: [{ eje: 'punto_de_vista', en_ingles: 'x' }] } }, 3).refilmar.cambia_camara, true);
  assert.equal(normalizeTreatment({ refilmar: { cambios: [{ eje: 'raro' }] } }, 3).refilmar.cambios.length, 0);
  assert.equal(normalizeTreatment({ refilmar: { cambia_camara: true } }, 3).refilmar.cambia_camara, true);
  assert.equal(normalizeTreatment({ refilmar: { cambia_camara: 'sí' } }, 3).refilmar.cambia_camara, false);
  // Sin prompt del DP igual hay plan (re-filmar se propone siempre).
  assert.match(refilmPrompt({ prompt: '', preservar: [], evitar: [] }, { treatment: { intencion: 'íntimo' } }), /Mood: íntimo\./);
  // Los dos modelos para re-filmar, con el cuerpo que espera cada uno en WaveSpeed (480p por defecto, Wan por defecto).
  const { wan, seedance } = REFILM_MODELS;
  assert.equal(DEFAULT_REFILM_MODEL, 'wan');
  assert.equal(refilmResolution(), '480p');
  assert.equal(wan.path(), 'alibaba/wan-3.0-prime/reference-to-video');
  assert.deepEqual(wan.body({ prompt: 'p', video: 'v', images: ['i'], duration: 3, aspect: '9:16', resolution: '480p' }), {
    prompt: 'p', reference_videos: ['v'], reference_images: ['i'], duration: 3, aspect_ratio: '9:16', resolution: '480p', generate_audio: false, enable_prompt_expansion: false,
  });
  assert.deepEqual([0.9, 1.2, 2, 2.4, 5].map(wan.seconds), [2, 2, 2, 3, 5]);
  assert.equal(seedance.path(), 'bytedance/seedance-2.5/text-to-video');
  assert.deepEqual(seedance.body({ prompt: 'p', images: ['i'], duration: 4, aspect: '9:16', resolution: '480p' }), {
    prompt: 'p', reference_images: ['i'], duration: 4, aspect_ratio: '9:16', resolution: '480p', generate_audio: false,
  });
  assert.deepEqual([1.2, 3, 4.5].map(seedance.seconds), [4, 4, 5]); // Seedance genera 4 s como mínimo
  // Seedance nombra las referencias con "@".
  const tagged = refilmPrompt({ cambios: [], vinetas: [{ t: 0, encuadre: 'x' }] }, { storyboard: true, video: true, frames: 1, tag: '@' });
  assert.match(tagged, /^@Image 1 is the approved storyboard/);
  assert.match(tagged, /@Video 1, @Image 2 are the original footage/);
  // Storyboard dibujado a mano: una hoja de 3 columnas × 2 filas, con la cámara nueva si cambia.
  const sb = cineStoryboardPrompt({ refilmar: { cambia_camara: true, prompt: 'Overhead fisheye.', vinetas: [{ t: 0, encuadre: 'top shot', accion: 'they talk' }] }, dur: 3, panelAspect: '9:16' });
  assert.match(sb, /Hand-drawn/);
  assert.match(sb, /exactly 6 panels in a grid of 3 columns and 2 rows/);
  assert.match(sb, /The camera is NEW/);
  assert.match(sb, /1\. \(0\.0s\) top shot — they talk/);
  assert.match(sb, /6\. \(3\.0s\)/); // las viñetas que faltan se reparten hasta el final
  assert.equal(storyboardSheetAspect(1080, 1920), '4:5'); // 3 × 9:16 de ancho, 2 de alto
  assert.equal(storyboardSheetAspect(1920, 1080), '3:1');
  const tv = normalizeTreatment({ refilmar: { vinetas: Array.from({ length: 9 }, (_, i) => ({ t: 9 - i, accion: 'x' })) } }, 3).refilmar.vinetas;
  assert.equal(tv.length, 6);
  assert.ok(tv.every((v, i) => v.t <= 3 && (!i || v.t >= tv[i - 1].t)));
  // Un clip de Cinematic Pro necesita al menos 1.2 s (≥ 1 s de video de referencia).
  assert.throws(() => parseIntuitionBody({ video, clips: [clip('C1', 0, 1)] }), /al menos 1\.2 s/);
  assert.equal(parseIntuitionBody({ video, clips: [clip('C1', 0, 1, { mode: 'motion' })] }).clips.length, 1);
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

test('Cinematic Pro: el DP entrega el tratamiento; siempre se propone re-filmar y se genera si el humano aprueba', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'cine-'));
  try {
    const ws = createMockWaveSpeed({ mediaDir: dir });
    const calls = [];
    const origVideo = ws.video;
    ws.video = async (opts) => { calls.push(opts); return origVideo(opts); };
    const uploads = [];
    ws.upload = async (u) => { uploads.push(u); return `https://cdn/${uploads.length}`; };
    const images = [];
    ws.image = async (opts) => { images.push(opts); return { task: 't', remote: 'https://cdn/board.jpg', file: 'board.jpg' }; };

    // Aprobado con el clip grabado (MP4).
    const ok = await run({ clips: [clip('C1', 0, 3), clip('C2', 5, 7, { mode: 'motion' })], ws, ask: () => ({ aprobar: true, video: CLIP_VIDEO, prompt: '' }) });
    const cine = ok.events.find((e) => e.type === 'cine');
    assert.equal(cine.data.id, 'C1');
    assert.equal(cine.data.luz.tipo, 'ventana');
    assert.ok(ok.events.some((e) => e.type === 'motion' && e.data.id === 'C2'));
    assert.equal(ok.asked.length, 1);
    assert.equal(ok.asked[0].kind, 'refilm');
    assert.equal(calls.length, 1);
    assert.equal(ok.asked[0].plan.resolution, '480p');
    // Antes de preguntar se dibuja el storyboard de la toma (GPT Image edit, una hoja 3 × 2).
    assert.equal(images.length, 1);
    assert.equal(images[0].model, 'openai/gpt-image-2.5-flare/edit');
    assert.equal(images[0].body.aspect_ratio, '4:5');
    assert.match(images[0].body.prompt, /3 columns and 2 rows/);
    assert.equal(ok.asked[0].plan.storyboard, '/media/board.jpg');
    assert.equal(ok.asked[0].plan.vinetas.length, 6);
    uploads.splice(0, 2); // las referencias del storyboard (primer cuadro y cuadro del medio)
    assert.equal(calls[0].model, 'alibaba/wan-3.0-prime/reference-to-video');
    assert.deepEqual(uploads, [CLIP_VIDEO, IMG]); // Video 1 = el clip, Image 1 = su primer cuadro
    // Misma cámara: el clip va como Video 1; el storyboard (ya en el CDN, no se vuelve a subir) es Image 1 y el primer cuadro, Image 2.
    assert.deepEqual(calls[0].body.reference_videos, ['https://cdn/3']);
    assert.deepEqual(calls[0].body.reference_images, ['https://cdn/board.jpg', 'https://cdn/4']);
    assert.equal(ok.asked[0].plan.needsVideo, true);
    assert.equal(calls[0].body.resolution, '480p');
    assert.equal(calls[0].body.duration, 3);
    assert.equal(calls[0].body.aspect_ratio, '9:16');
    assert.equal(calls[0].body.generate_audio, false);
    assert.match(calls[0].body.prompt, /^Image 1 is the approved storyboard/);
    assert.match(calls[0].body.prompt, /Video 1, Image 2 are the original footage/);
    assert.ok(ok.events.some((e) => e.type === 'cine_video' && e.data.id === 'C1' && e.data.demo));
    assert.ok(ok.log.cine.C1.refilm.approved);

    // Se propone en TODOS los clips de Cinematic Pro (aunque el DP no lo recomiende).
    calls.length = 0;
    const all = await run({ clips: [clip('C1', 0, 3), clip('C2', 5, 7)], ws, ask: () => ({ aprobar: false }) });
    assert.deepEqual(all.asked.map((a) => a.clip), ['C1', 'C2']);
    assert.ok(all.events.filter((e) => e.type === 'cine').every((e) => e.data.refilmar.recomendado));

    // Rechazado: no se genera nada y el reproductor se queda con el tratamiento.
    calls.length = 0;
    const no = await run({ clips: [clip('C1', 0, 3)], ws, ask: () => ({ aprobar: false }) });
    assert.equal(calls.length, 0);
    assert.ok(no.events.some((e) => e.type === 'cine_video' && e.data.skipped));

    // Aprobado pero grabado en WebM: WaveSpeed no lo acepta, se avisa sin gastar.
    const webm = await run({ clips: [clip('C1', 0, 3)], ws, ask: () => ({ aprobar: true, video: 'data:video/webm;base64,GkXfow==' }) });
    assert.equal(calls.length, 0);
    assert.ok(webm.events.some((e) => e.type === 'step_error' && e.step === 'refilm-C1' && /MP4/.test(e.text)));

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

test('Cinematic Pro: pedir cambios al storyboard → el DP rehace el plan y se redibuja', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'cine-'));
  try {
    const ws = createMockWaveSpeed({ mediaDir: dir });
    const images = [];
    ws.image = async (opts) => { images.push(opts); return { task: 't', remote: 'r', file: null }; };
    let n = 0;
    const r = await run({ clips: [clip('C1', 0, 3)], ws, ask: (d) => (d.kind === 'refilm' && ++n === 1 ? { aprobar: false, cambios: 'la cámara más alta' } : { aprobar: false }) });
    const refilms = r.asked.filter((a) => a.kind === 'refilm');
    assert.equal(refilms.length, 2);
    assert.deepEqual(refilms.map((a) => a.plan.round), [1, 2]);
    assert.equal(images.length, 2); // se volvió a dibujar
    assert.equal(r.events.filter((e) => e.type === 'cine').length, 2);
    assert.equal(r.log.cine.C1.rounds.length, 2);
    // El DP recibió el pedido en la segunda vuelta.
    assert.ok(r.events.some((e) => e.type === 'step_start' && e.step === 'cine-C1-r2'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Cinematic Pro: si el re-filmado falla, se reintenta con el mismo clip (y una tarea aceptada se retoma sin pagar de nuevo)', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'cine-'));
  try {
    const ws = createMockWaveSpeed({ mediaDir: dir });
    const uploads = [];
    ws.upload = async (u) => { uploads.push(u); return `https://cdn/${uploads.length}`; };
    let videos = 0;
    ws.video = async () => { videos++; const e = new Error('Consultando: fetch failed'); if (videos === 1) e.task = 'task-1'; throw e; };
    const collected = [];
    ws.collect = async ({ task }) => { collected.push(task); return { task, remote: 'r', file: 'take.mp4' }; };
    const r = await run({ clips: [clip('C1', 0, 3)], ws, ask: (d) => ({ aprobar: true, video: CLIP_VIDEO }) });
    const retry = r.asked.find((a) => a.kind === 'refilm_retry');
    assert.ok(retry.plan.resume);
    assert.equal(videos, 1); // no se volvió a enviar (no se paga dos veces)
    assert.deepEqual(collected, ['task-1']);
    assert.ok(r.events.some((e) => e.type === 'cine_video' && e.data.url === '/media/take.mp4'));

    // Sin tarea aceptada (falló antes): se reenvía sin volver a subir el clip; después de 3 intentos se rinde.
    videos = 0; uploads.length = 0;
    ws.video = async () => { videos++; throw new Error('Subiendo: no pude conectar'); };
    const r2 = await run({ clips: [clip('C1', 0, 3)], ws, ask: () => ({ aprobar: true, video: CLIP_VIDEO }) });
    assert.equal(videos, 3);
    assert.equal(r2.asked.filter((a) => a.kind === 'refilm_retry').length, 2);
    assert.equal(uploads.filter((u) => u === CLIP_VIDEO).length, 1);
    assert.equal(r2.log.cine.C1.refilm.errors.length, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('WaveSpeed: los errores de red dicen la causa; subir se reintenta y enviar solo si la conexión ni se abrió', async () => {
  const { createWaveSpeed } = await import('../src/wavespeed.js');
  const netFail = (code) => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(`connect ${code}`), { code }) });
  const ok = (data) => new Response(JSON.stringify({ data }), { status: 200 });

  let n = 0;
  const flaky = createWaveSpeed({ apiKey: 'k', mediaDir: '/tmp', fetchImpl: async () => { if (++n < 3) throw netFail('ECONNRESET'); return ok({ download_url: 'https://u' }); } });
  assert.equal(await flaky.upload(CLIP_VIDEO), 'https://u');
  assert.equal(n, 3);

  n = 0;
  const reset = createWaveSpeed({ apiKey: 'k', mediaDir: '/tmp', fetchImpl: async () => { n++; throw netFail('ECONNRESET'); } });
  await assert.rejects(reset.video({ model: 'm', body: {} }), (e) => /Enviando la tarea a m: no pude conectar con WaveSpeed \(ECONNRESET/.test(e.message) && e.network);
  assert.equal(n, 1); // pudo haber llegado: no se reenvía

  n = 0;
  const dns = createWaveSpeed({ apiKey: 'k', mediaDir: '/tmp', fetchImpl: async () => { if (++n < 2) throw netFail('ENOTFOUND'); return ok({ id: 'x' }); }, pollMs: 1 });
  const p = dns.video({ model: 'm', body: {}, timeoutMs: 50 });
  await assert.rejects(p, (e) => e.task === 'x'); // se envió (al 2.º intento); la consulta falla → queda el id para retomarla
  assert.ok(n >= 2);
});

test('Cinematic Pro: si el pedido admite dos lecturas se pregunta antes de dibujar; con cámara nueva no se manda el clip', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'cine-'));
  try {
    const ws = createMockWaveSpeed({ mediaDir: dir });
    const uploads = [];
    ws.upload = async (u) => { uploads.push(u); return `https://cdn/${uploads.length}`; };
    const images = [];
    ws.image = async (opts) => { images.push(opts); return { task: 't', remote: 'https://cdn/board.jpg', file: 'board.jpg' }; };
    const calls = [];
    ws.video = async (opts) => { calls.push(opts); return { task: 'v', remote: null, file: null }; };
    const spyClip = clip('C1', 0, 3, { prompt: 'una cámara espía en la mesa entre los dos' });

    // Elige la otra lectura (punto de vista): el DP rehace el plan y recién ahí se dibuja.
    const r = await run({ clips: [spyClip], ws, ask: (d) => (d.kind === 'intent' ? { elecciones: [{ i: 0, opcion: 'b' }] } : { aprobar: true }) });
    const intent = r.asked.find((a) => a.kind === 'intent');
    assert.equal(intent.plan.preguntas[0].eje, 'elementos');
    assert.match(intent.plan.preguntas[0].b, /DESDE una cámara espía/);
    assert.deepEqual(r.asked.map((a) => a.kind), ['intent', 'refilm']); // la pregunta va antes del storyboard
    assert.equal(images.length, 1);
    assert.match(images[0].body.prompt, /The camera is NEW/);
    const plan = r.asked[1].plan;
    assert.equal(plan.cambia_camara, true);
    assert.equal(plan.needsVideo, false);
    assert.equal(plan.cambios[0].eje, 'punto_de_vista');
    // Sin video de referencia (empujaría a copiar la cámara original): storyboard + 3 cuadros del clip. Se aprueba sin grabar nada.
    assert.equal(calls.length, 1);
    assert.equal(calls[0].body.reference_videos, undefined);
    assert.deepEqual(calls[0].body.reference_images, ['https://cdn/board.jpg', 'https://cdn/3', 'https://cdn/4', 'https://cdn/5']);
    assert.match(calls[0].body.prompt, /hidden spy camera/);
    assert.doesNotMatch(calls[0].body.prompt, /small black spy camera sits on the table/);

    // Si confirma la primera lectura, no hay vuelta extra del DP.
    const same = await run({ clips: [spyClip], ws, ask: (d) => (d.kind === 'intent' ? { elecciones: [{ i: 0, opcion: 'a' }] } : { aprobar: false }) });
    assert.ok(!same.events.some((e) => e.type === 'step_start' && e.step === 'cine-C1-r2'));
    assert.equal(same.asked.find((a) => a.kind === 'refilm').plan.needsVideo, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Cinematic Pro: el humano elige el modelo para re-filmar (Wan 3.0 Prime o Seedance 2.5)', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'cine-'));
  try {
    const ws = createMockWaveSpeed({ mediaDir: dir });
    ws.upload = async (u) => (u === CLIP_VIDEO ? 'https://cdn/clip.mp4' : 'https://cdn/frame.jpg');
    ws.image = async () => ({ task: 't', remote: 'https://cdn/board.jpg', file: 'board.jpg' });
    const calls = [];
    ws.video = async (opts) => { calls.push(opts); return { task: 'v', remote: null, file: null }; };
    const r = await run({ clips: [clip('C1', 0, 3)], ws, ask: () => ({ aprobar: true, model: 'seedance', video: CLIP_VIDEO }) });
    const plan = r.asked[0].plan;
    assert.deepEqual(plan.models.map((m) => m.id), ['wan', 'seedance']);
    assert.equal(plan.model, 'wan');
    assert.deepEqual(plan.models.map((m) => m.seconds), [3, 4]);
    assert.ok(plan.models.every((m) => m.cost > 0));
    assert.match(plan.models[1].prompt, /^@Image 1 is the approved storyboard/);
    assert.equal(calls[0].model, 'bytedance/seedance-2.5/text-to-video');
    assert.equal(calls[0].body.duration, 4);
    assert.equal(calls[0].body.enable_prompt_expansion, undefined);
    assert.match(calls[0].body.prompt, /@Video 1, @Image 2 are the original footage/);
    assert.equal(r.log.cine.C1.refilm.model, 'bytedance/seedance-2.5/text-to-video');

    // Un modelo desconocido cae en el de por defecto.
    calls.length = 0;
    await run({ clips: [clip('C1', 0, 3)], ws, ask: () => ({ aprobar: true, model: 'otro', video: CLIP_VIDEO }) });
    assert.equal(calls[0].model, 'alibaba/wan-3.0-prime/reference-to-video');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
