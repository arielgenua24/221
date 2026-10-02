import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createStoryStore } from '../src/story-store.js';
import { createRawStore } from '../src/raw-store.js';
import { createStoryJobs, runStoryTurn, parseStoryTurnBody, mergeShots, sanitizeShot } from '../src/story-pipeline.js';
import { frameImagePrompt, STORY_SYSTEM, DP_SYSTEM } from '../src/story-prompts.js';
import { createMockWaveSpeed, VIDEO_MODELS } from '../src/wavespeed.js';
import { mockLLM } from '../src/mock.js';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const CONFIG = { storyModel: 'demo', dpModel: 'demo', frameModel: 't2i', frameEditModel: 'edit', frameQuality: 'low', videoModel: 'wan', videoResolution: '480p' };
const silent = { error() {} };

async function withStore(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'story-'));
  try { return await fn(createStoryStore(dir), dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

async function until(check, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() > end) throw new Error('timeout esperando la tarea');
    await new Promise((r) => setTimeout(r, 20));
  }
}

test('los agentes leen la biblioteca agents-film (guías completas + catálogo, marcado para caché)', () => {
  for (const system of [STORY_SYSTEM, DP_SYSTEM]) {
    assert.equal(system[0].cache_control.type, 'ephemeral');
    assert.match(system[0].text, /CATÁLOGO DE REGLAS/);
  }
  assert.match(STORY_SYSTEM[0].text, /<guia id="kuleshov-effect"/);
  assert.match(DP_SYSTEM[0].text, /<guia id="camera-movement"/);
  assert.match(DP_SYSTEM[0].text, /<guia id="motivated-lighting"/);
});

test('Wan 3.0 sale sin audio propio (va con la música del montaje)', () => {
  const body = VIDEO_MODELS.wan.body({ prompt: 'p', image: 'u', duration: 5, aspect: '9:16', resolution: '480p' });
  assert.deepEqual(body, { prompt: 'p', image: 'u', duration: 5, aspect_ratio: '9:16', resolution: '480p', generate_audio: false });
});

test('sanitizeShot y mergeShots: refs reales, ids únicos, lo que no cambia conserva cuadro y video', () => {
  const codes = new Set(['M1', 'M2']);
  const s = sanitizeShot({ id: 'S1', refs: ['m1', 'M9', 'M1'], intensidad: 9, prompt_cuadro: 'a' }, codes);
  assert.deepEqual(s.refs, ['M1']);
  assert.equal(s.intensidad, 5);
  assert.equal(s.vinetas.length, 6);

  const done = { status: 'done', file: 'f.jpg' };
  const existing = [
    { ...sanitizeShot({ id: 'S1', prompt_cuadro: 'uno' }, codes), frame: done, approved: true, video: done },
    { ...sanitizeShot({ id: 'S2', prompt_cuadro: 'dos' }, codes), frame: done, approved: false, video: { status: 'idle' } },
  ];
  const { shots, reset } = mergeShots(existing, [
    { id: 'S1', titulo: 'otro título', prompt_cuadro: 'uno' },
    { id: 'S2', prompt_cuadro: 'dos, pero distinto' },
    { id: 'S2', prompt_cuadro: 'duplicada' },
  ], codes);
  assert.deepEqual(shots.map((x) => x.id), ['S1', 'S2', 'S3']);
  assert.equal(shots[0].titulo, 'otro título');
  assert.equal(shots[0].video.file, 'f.jpg', 'la toma que no cambió conserva su video');
  assert.equal(shots[1].frame.status, 'idle', 'la que cambió vuelve a dibujarse');
  assert.deepEqual(reset, ['S2']);
  const changedBeat = mergeShots([existing[0]], [{ id: 'S1', prompt_cuadro: 'uno', vinetas: ['salta', 'gira', 'patea', 'vuela', 'cae', 'gol'] }], codes);
  assert.equal(changedBeat.shots[0].frame.status, 'idle', 'cambiar la secuencia invalida el storyboard anterior');
});

test('Historia vincula imágenes de la carpeta Raw y conserva sus nombres para el modelo', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'story-raw-'));
  try {
    const raw = createRawStore(path.join(dir, 'raw'));
    const folder = await raw.createFolder({ name: 'PES 3' });
    const person = await raw.addAsset({ folderId: folder.id, kind: 'persona', dataUrl: PNG, name: 'Pablo' });
    const story = createStoryStore(path.join(dir, 'story'), { rawFilesDir: raw.filesDir });
    const project = await story.create({ title: 'La volea', aspect: '9:16', rawFolderId: folder.id });
    const linked = await story.linkRawAsset(project.id, person);
    assert.equal(linked.name, 'Pablo');
    assert.equal(linked.rawCode, person.code);
    assert.equal((await story.dataUrl(linked.file)).startsWith('data:image/png;base64,'), true);
    assert.equal((await story.list())[0].rawFolderId, folder.id);
    assert.equal((await story.linkRawAsset(project.id, person)).code, linked.code, 'no duplica la misma imagen');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('parseStoryTurnBody valida el pedido', () => {
  assert.throws(() => parseStoryTurnBody({ projectId: 'x' }), /Escribí/);
  assert.equal(parseStoryTurnBody({ projectId: 'x', text: ' hola ' }).text, 'hola');
});

test('el prompt del cuadro nombra las referencias y fija el look y el formato', () => {
  const project = { aspect: '9:16', assets: [{ code: 'M1', note: 'la protagonista' }], story: { estilo_visual: { look: 'warm grade' }, personajes: [{ nombre: 'Ana', material: ['M1'], descripcion_visual: 'short red hair' }] } };
  const p = frameImagePrompt({ project, shot: { prompt_cuadro: 'Close-up of Ana', accion: '' }, refCodes: ['M1'] });
  assert.match(p, /image 1 is M1 \(la protagonista\)/);
  assert.match(p, /Ana: short red hair/);
  assert.match(p, /warm grade/);
  assert.match(p, /Aspect ratio 9:16/);
});

test('flujo completo (demo): conversar → tomas → storyboard en paralelo → aprobar → video, y el montaje guarda orden y música', () => withStore(async (store) => {
  const ws = createMockWaveSpeed({ mediaDir: store.filesDir });
  const jobs = createStoryJobs({ store, ws, llm: mockLLM, config: CONFIG, log: silent });
  const p = await store.create({ title: 'Prueba', aspect: '9:16' });
  await store.addAsset(p.id, { dataUrl: PNG, name: 'ana.png', source: 'foto' });

  const events = [];
  await runStoryTurn({ store, jobs, input: { projectId: p.id, text: 'Una historia de amanecer', answers: [] }, config: CONFIG, emit: (e) => events.push(e), llm: mockLLM });
  const reply = events.find((e) => e.type === 'story_reply');
  assert.ok(reply.decir);
  let cur = await store.get(p.id);
  assert.equal(cur.shots.length, 4);
  assert.deepEqual(cur.shots[0].refs, ['M1']);
  assert.equal(cur.chat.length, 2);
  assert.ok(cur.assets[0].note, 'el Guionista anota el material');

  await jobs.frames(p.id);
  cur = await until(async () => { const x = await jobs.view(p.id); return !x.busy && x; });
  assert.ok(cur.shots.every((s) => s.frame.status === 'done' && s.frame.file), 'todos los cuadros dibujados');

  // Aprobar dos tomas a la vez: cada una su tarea.
  await Promise.all(['S1', 'S2'].map((id) => jobs.approve(p.id, id)));
  cur = await until(async () => { const x = await jobs.view(p.id); return !x.busy && x; });
  for (const id of ['S1', 'S2']) {
    const s = cur.shots.find((x) => x.id === id);
    assert.equal(s.video.status, 'done');
    assert.match(s.video.prompt, /Single continuous shot/);
    assert.ok(s.video.plan.prompt_video);
  }
  assert.equal(cur.shots.find((x) => x.id === 'S3').approved, false);

  // Pedir cambios sobre un cuadro: vuelve a dibujarse y pierde la aprobación.
  await jobs.reviseFrame(p.id, 'S1', { feedback: 'más cerca' });
  cur = await until(async () => { const x = await jobs.view(p.id); return !x.busy && x; });
  const s1 = cur.shots.find((x) => x.id === 'S1');
  assert.equal(s1.frame.round, 2);
  assert.equal(s1.approved, false);
  assert.match(s1.prompt_cuadro, /más cerca/);

  await store.setMusic(p.id, { dataUrl: 'data:audio/mpeg;base64,SUQz', name: 'tema.mp3' });
  await store.setTimeline(p.id, { order: ['S3', 'S1', 'nope'], music: { volume: 1.7, offset: 2 } });
  cur = await store.get(p.id);
  assert.deepEqual(cur.timeline.order, ['S3', 'S1', 'S2', 'S4']);
  assert.equal(cur.timeline.music.volume, 1);
  assert.equal(cur.timeline.music.offset, 2);
}));

test('al reiniciar, lo que quedó a medias se marca (o se retoma si la tarea ya estaba enviada)', () => withStore(async (store, dir) => {
  const p = await store.create({ title: 'x' });
  await store.mutate(p.id, (d) => {
    d.shots = [
      { ...sanitizeShot({ id: 'S1' }, new Set()), frame: { status: 'running' }, approved: true, video: { status: 'running', task: 't1' } },
      { ...sanitizeShot({ id: 'S2' }, new Set()), frame: { status: 'done', file: 'a.jpg' }, approved: true, video: { status: 'queued' } },
    ];
  });
  const fresh = createStoryStore(dir);
  const collected = [];
  const ws = { mock: false, collect: async ({ task }) => { collected.push(task); return { task, file: 'v.mp4' }; } };
  const jobs = createStoryJobs({ store: fresh, ws, llm: mockLLM, config: CONFIG, log: silent });
  await jobs.resume();
  const cur = await until(async () => { const x = await jobs.view(p.id); return !x.busy && x; });
  assert.deepEqual(collected, ['t1']);
  assert.equal(cur.shots[0].frame.status, 'error');
  assert.equal(cur.shots[0].video.file, 'v.mp4');
  assert.equal(cur.shots[1].video.status, 'error');
  assert.equal(cur.shots[1].approved, false);
}));
