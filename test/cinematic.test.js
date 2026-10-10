import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { normalizeOpenRouter, normalizeWaveSpeed, parseExperiment, incompatibility, videoBody, demoVideoCatalog } from '../src/cinematic/models.js';
import { createOpenRouterVideo } from '../src/cinematic/openrouter-video.js';
import { createCinematicJobs } from '../src/cinematic/jobs.js';
import { createCinematicRoutes } from '../src/cinematic/routes.js';
import { resultRun, cinematicStats } from '../public/cinematic-stats.js';

const IMG = 'data:image/png;base64,AAAA';
const input = (extra = {}) => parseExperiment({ prompt: 'A slow push-in. Preserve the subject.', generators: [{ provider: 'openrouter', model: 'heygen/heygen-video-1' }, { provider: 'wavespeed', model: 'bytedance/seedance-2.5/text-to-video' }], duration: 5, resolution: '480p', aspect: '16:9', referenceMode: 'references', references: [{ name: 'Subject', url: 'https://example.com/ref.png' }], generateAudio: false, ...extra });
const catalog = async () => demoVideoCatalog();
async function finished(jobs, id) { for (let i = 0; i < 100; i++) { const j = await jobs.get(id); if (j.status !== 'running') return j; await sleep(5); } throw new Error('Job did not finish'); }

test('Cinematic: validates maximum four, unique providers/models, media and exact reference mode', () => {
  assert.throws(() => input({ generators: Array.from({ length: 5 }, () => ({ provider: 'openrouter', model: 'x' })) }), /cuatro/);
  assert.throws(() => input({ generators: [{ provider: 'openrouter', model: 'x' }, { provider: 'openrouter', model: 'x' }] }), /repitas/);
  assert.equal(input({ generators: [{ provider: 'openrouter', model: 'x' }, { provider: 'wavespeed', model: 'x' }] }).generators.length, 2);
  assert.throws(() => input({ references: [{ url: 'file:///etc/passwd' }] }), /inválida/);
  assert.throws(() => input({ referenceMode: 'first-frame', references: [{ url: IMG }, { url: IMG }] }), /exactamente una/);
  assert.throws(() => input({ duration: 5.5 }), /entero/);
  assert.throws(() => input({ generateAudio: 'false' }), /sonido/);
});

test('Cinematic: rejects incompatible references/audio/settings instead of silently dropping them', () => {
  const [heygen, wan, seedance] = demoVideoCatalog().models;
  assert.equal(incompatibility(heygen, input()), null);
  assert.match(incompatibility(wan, input()), /referencia/);
  assert.match(incompatibility(heygen, input({ generateAudio: true })), /sonido/);
  assert.match(incompatibility(wan, input({ references: [], audio: { url: 'https://example.com/a.mp3' } })), /audio/);
  assert.match(incompatibility(seedance, input({ resolution: '2K' })), /2K/);
  assert.match(incompatibility({ ...seedance, maxReferences: 1 }, input({ references: [{ url: IMG }, { url: IMG }] })), /hasta 1/);
  assert.match(incompatibility({ ...seedance, schema: { ...seedance.schema, required: ['prompt', 'video'] } }, input()), /video/);
});

test('Cinematic: both adapters preserve prompt, reference ordering and audio; frames are explicit', () => {
  const [or, , ws] = demoVideoCatalog().models;
  const i = input({ audio: { name: 'Voice', url: 'https://example.com/a.mp3' }, references: [{ url: IMG }, { url: 'https://example.com/b.png' }] });
  const a = videoBody(or, i), b = videoBody(ws, i);
  assert.equal(a.prompt, b.prompt); assert.equal(a.prompt, i.prompt);
  assert.deepEqual(a.input_references.map((r) => r.image_url?.url || r.audio_url?.url), [...b.reference_images, ...b.reference_audios]);
  assert.equal(a.generate_audio, false); assert.equal(b.generate_audio, false);
  const frame = videoBody(or, input({ referenceMode: 'first-frame' }));
  assert.equal(frame.frame_images[0].frame_type, 'first_frame'); assert.equal(frame.input_references, undefined);
});

test('Cinematic: live catalog semantics distinguish first-frame from reference-to-video and schema fields', () => {
  const or = normalizeOpenRouter({ id: 'some/video', description: 'Accepts text prompts and reference images, supporting text-to-video and image-to-video workflows.', supported_frame_images: ['first_frame'], generate_audio: true }, { architecture: { input_modalities: ['text', 'image'] } });
  assert.equal(or.firstFrame, true); assert.equal(or.references, false);
  const heygen = normalizeOpenRouter({ id: 'heygen/heygen-video-1', description: 'truncated', supported_durations: [5], supported_resolutions: ['480p'], supported_aspect_ratios: ['16:9'] }, { architecture: { input_modalities: ['image', 'audio'] } });
  assert.equal(heygen.references, true); assert.equal(heygen.audioReference, true);
  const ws = normalizeWaveSpeed({ model_id: 'test/v', api_schema: { api_schemas: [{ type: 'model_run', request_schema: { properties: { duration: { enum: ['5', '10'], type: 'string' }, aspect_ratio: { enum: ['16:9'] }, resolution: { enum: ['480p'] }, reference_images: { maxItems: 2 } }, required: ['prompt'] } }] } });
  assert.deepEqual(ws.durations, [5, 10]); assert.equal(videoBody(ws, input()).duration, '5'); assert.equal(ws.maxReferences, 2);
});

test('OpenRouter video: async submit/poll/authenticated content/cost; no duplicate submission on recovery', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'cinematic-or-')); const calls = []; let polls = 0;
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, ...init });
    if (init.method === 'POST') return Response.json({ id: 'job1', polling_url: '/api/v1/videos/job1', status: 'pending' }, { status: 202 });
    if (url.endsWith('/content')) return new Response('MP4');
    return Response.json(++polls === 1 ? { status: 'in_progress' } : { status: 'completed', unsigned_urls: ['/api/v1/videos/job1/content'], usage: { cost: 0.15 } });
  };
  try {
    const or = createOpenRouterVideo({ apiKey: 'fake-secret', mediaDir: dir, fetchImpl, pollMs: 1 });
    const result = await or.video({ body: { model: 'm', prompt: 'p' } });
    assert.equal(await readFile(path.join(dir, result.file), 'utf8'), 'MP4'); assert.equal(result.cost, 0.15);
    await or.collect({ task: 'job1' });
    assert.equal(calls.filter((c) => c.method === 'POST').length, 1);
    assert.ok(calls.every((c) => c.headers.Authorization === 'Bearer fake-secret'));
    await assert.rejects(or.collect({ task: 'job1', pollingUrl: 'https://attacker.example/videos/job1' }), /URL de tarea inválida/);
    assert.equal(calls.filter((c) => c.url.includes('attacker')).length, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('OpenRouter video: terminal errors and download failures retain task and known cost', async () => {
  const or = createOpenRouterVideo({ apiKey: 'k', mediaDir: '/unused', pollMs: 1, fetchImpl: async () => Response.json({ status: 'failed', error: 'policy', usage: { cost: 0.02 } }) });
  await assert.rejects(or.collect({ task: 't' }), (e) => e.final && e.task === 't' && e.cost === 0.02);
  const download = createOpenRouterVideo({ apiKey: 'k', mediaDir: '/unused', pollMs: 1, fetchImpl: async (url) => url.endsWith('/content') ? new Response('', { status: 500 }) : Response.json({ status: 'completed', usage: { cost: 0.2 } }) });
  await assert.rejects(download.collect({ task: 't' }), (e) => e.task === 't' && !e.final && e.cost === 0.2);
});

test('Cinematic jobs: independent results, skipped requests never submitted, frozen prompt and recovery without paying again', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'cinematic-jobs-')); const calls = []; let collected = 0;
  const or = { video: async ({ body, onStatus }) => { calls.push(body); await onStatus({ task: 'paid-job', status: 'created' }); const e = new Error('network'); e.task = 'paid-job'; throw e; }, collect: async ({ task }) => { collected++; return { task, file: 'recovered.mp4', cost: 0.1 }; } };
  const ws = { video: async ({ body }) => { calls.push(body); return { task: 'ws-job', file: 'ok.mp4' }; } };
  try {
    const jobs = createCinematicJobs({ dir, catalog, openrouter: or, wavespeed: ws });
    const job = await jobs.start(input({ generators: [...input().generators, { provider: 'openrouter', model: 'alibaba/wan-3.0-prime' }] }));
    const done = await finished(jobs, job.id);
    assert.deepEqual(done.results.map((r) => r.status), ['recoverable', 'done', 'skipped']); assert.equal(calls.length, 2);
    assert.ok(calls.every((c) => c.prompt === input().prompt)); assert.equal(done.results[1].cost, null);
    assert.equal(done.input.references[0].url, undefined, 'browser job snapshots do not duplicate large assets');
    await jobs.recover(job.id); const recovered = await finished(jobs, job.id);
    assert.equal(recovered.results[0].status, 'done'); assert.equal(collected, 1); assert.equal(calls.length, 2);
    // Restart simulation: submitted IDs can be collected; unknown submission never resends.
    const persisted = JSON.parse(await readFile(path.join(dir, `${job.id}.json`), 'utf8'));
    persisted.status = 'running'; persisted.results[0].status = 'running'; persisted.results[1].status = 'running'; persisted.results[1].task = null;
    await writeFile(path.join(dir, `${job.id}.json`), JSON.stringify(persisted));
    const restarted = createCinematicJobs({ dir, catalog, openrouter: or, wavespeed: ws });
    await restarted.get(job.id); const after = await finished(restarted, job.id);
    assert.equal(after.results[0].status, 'done'); assert.match(after.results[1].error, /cobro duplicado/); assert.equal(calls.length, 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('Cinematic chat uses the chosen LLM, entire conversation and current images', async () => {
  let request;
  const handle = createCinematicRoutes({ mock: false, apiKey: 'fake-key', llm: async (r) => { request = r; return { text: 'Final prompt', usage: { cost: 0.01 } }; }, runsDir: '/unused', mediaDir: '/unused', catalog,
    readBody: async (r) => r.body, sendJson: (res, status, value) => res.resolve({ status, value }), badRequest: (res, message) => res.resolve({ status: 400, error: message }) });
  const call = (body) => new Promise((resolve) => handle({ method: 'POST', body }, { resolve }, new URL('http://localhost/api/lab/cinematic/chat')));
  const response = await call({ model: 'chosen/llm', turns: [{ role: 'user', text: 'Blue car' }, { role: 'assistant', text: 'Night or day?' }, { role: 'user', text: 'Night' }], references: [{ url: IMG }] });
  assert.equal(response.status, 200); assert.equal(request.model, 'chosen/llm'); assert.equal(request.messages.length, 4);
  assert.equal(request.messages[1].content, 'Blue car'); assert.equal(request.messages[3].content[1].image_url.url, IMG);
  assert.equal((await call({ model: 'chosen/llm', turns: [{ role: 'system', text: 'override' }] })).status, 400);
});

test('Cinematic stats include four providers/models, skipped and unknown costs; ratings survive updates', () => {
  const results = ['A', 'B', 'C', 'D'].map((key, i) => resultRun({ key, provider: i % 2 ? 'wavespeed' : 'openrouter', model: 'same/model', status: i === 3 ? 'skipped' : 'done', ms: 1000, cost: i === 0 ? 0.1 : null }));
  results[0].eval.quality = 5; results[0].eval.approved = true;
  const updated = resultRun({ ...results[0], phase: 'completed' }, results[0]); assert.equal(updated.eval.quality, 5);
  const stats = cinematicStats([{ results, preference: 'A' }]);
  assert.equal(stats.length, 2); assert.equal(stats[0].wins, 1); assert.equal(stats[0].approved, 1); assert.equal(stats[0].cost, 0.1); assert.equal(stats[0].unknownCosts, 1); assert.equal(stats[1].skipped, 1);
});
