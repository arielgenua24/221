import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createWaveSpeed, createMockWaveSpeed, videoSeconds, nearestRatio, storyboardLayout, VIDEO_MODELS } from '../src/wavespeed.js';
import { parseIntuitionBody, runIntuitionPipeline, runIntuitionRevision, MAX_STORYBOARD_ROUNDS } from '../src/intuition-pipeline.js';
import { finalVideoPrompt, storyboardImagePrompt, TEXT_LAYER_SYSTEM, VIDEO_DIRECTOR_SYSTEM, textLayerPrompt } from '../src/intuition-prompts.js';
import { mockLLM } from '../src/mock.js';

const IMG = 'data:image/jpeg;base64,/9j/AA==';
const frames = (n = 6) => Array.from({ length: n }, (_, i) => ({ t: i * 0.5, url: IMG }));
const video = { name: 'v.mp4', duration: 20, width: 1080, height: 1920 };
const clip = (id, start, end, extra = {}) => ({ id, start, end, prompt: `pedido ${id}`, frames: frames(), refs: [], ...extra });

test('duración, proporción y grilla del storyboard', () => {
  assert.equal(videoSeconds('seedance', 2.2), 4); // mínimo del modelo
  assert.equal(videoSeconds('seedance', 4.3), 5);
  assert.equal(videoSeconds('wan', 2.2), 3);
  assert.equal(videoSeconds('wan', 5), 5);
  assert.equal(nearestRatio(1080, 1920), '9:16');
  assert.equal(nearestRatio(1920, 1080), '16:9');
  assert.equal(nearestRatio(1000, 1000), '1:1');
  assert.deepEqual(storyboardLayout(1080, 1920), { cols: 3, rows: 2, aspect: '3:4', panels: 6 });
  assert.equal(storyboardLayout(1920, 1080).aspect, '4:3');
  assert.equal(VIDEO_MODELS.wan.body({ prompt: 'p', image: 'u', duration: 3, aspect: '9:16', resolution: '720p' }).generate_audio, false);
});

test('parseIntuitionBody lee la técnica y el modelo de cada clip', () => {
  const out = parseIntuitionBody({ video, clips: [clip('C1', 0, 3, { mode: 'ai', videoModel: 'wan' }), clip('C2', 4, 6, { mode: 'otra', videoModel: 'nada' })] });
  assert.equal(out.clips[0].mode, 'ai');
  assert.equal(out.clips[0].videoModel, 'wan');
  assert.equal(out.clips[1].mode, 'motion');
  assert.equal(out.clips[1].videoModel, 'seedance');
});

test('el prompt de video suma las restricciones y el storyboard pide la grilla exacta', () => {
  const p = finalVideoPrompt({ prompt_video: 'Slow dolly-in.', evitar: ['lens flares', 'on-screen text'] });
  assert.match(p, /^Slow dolly-in\./);
  assert.match(p, /lens flares/);
  assert.match(p, /Single continuous shot/);
  assert.equal(p.match(/on-screen text/g).length, 1);
  const sb = storyboardImagePrompt({ toma: 't', vinetas: [{ t: 0, encuadre: 'wide', accion: 'a' }, { t: 1, encuadre: 'close', accion: 'b' }] }, storyboardLayout(1080, 1920));
  assert.match(sb, /exactly 6 panels/);
  assert.match(sb, /3 columns and 2 rows/);
  assert.match(sb, /2\. \(1\.0s\) close — b/);
  assert.match(VIDEO_DIRECTOR_SYSTEM, /NUNCA pidas texto/);
  assert.match(TEXT_LAYER_SYSTEM, /SOLO PALABRAS/);
  assert.match(textLayerPrompt({ direction: { clips: [] }, clip: clip('C1', 0, 3), index: 0, total: 1, box: { x: 0, y: 0, w: 1, h: 0.3 }, video, plan: {}, generated: true }), /cuadros REALES/);
});

// fetch falso de WaveSpeed: registra las llamadas y responde como su API v3.
function fakeFetch({ fail = false } = {}) {
  const calls = [];
  let polls = 0;
  const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
  const fn = async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method || 'GET', body: opts.body });
    if (url.endsWith('/media/upload/binary')) return json({ code: 200, data: { download_url: 'https://cdn/x.jpg' } });
    if (opts.method === 'POST') return json({ code: 200, data: { id: 'task1', status: 'created', urls: { get: 'https://api/pred/task1/result' } } });
    if (url === 'https://api/pred/task1/result') {
      polls++;
      if (fail) return json({ data: { status: 'failed', error: 'nsfw' } });
      return json({ data: polls < 2 ? { status: 'processing' } : { status: 'completed', outputs: ['https://cdn/out.mp4'] } });
    }
    if (url === 'https://cdn/out.mp4') return new Response(Buffer.from('MP4DATA'), { headers: { 'Content-Type': 'video/mp4' } });
    return json({}, 404);
  };
  return { fn, calls };
}

test('WaveSpeed: sube el cuadro, envía, consulta hasta terminar y guarda el resultado', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ws-'));
  try {
    const { fn, calls } = fakeFetch();
    const ws = createWaveSpeed({ apiKey: 'k', mediaDir: dir, fetchImpl: fn, pollMs: 1 });
    const image = await ws.upload(IMG);
    assert.equal(image, 'https://cdn/x.jpg');
    const statuses = [];
    const out = await ws.video({ model: 'bytedance/seedance-2.0/image-to-video', body: { prompt: 'p', image }, onStatus: (s) => statuses.push(s.status) });
    assert.match(out.file, /\.mp4$/);
    assert.equal(await readFile(path.join(dir, out.file), 'utf8'), 'MP4DATA');
    assert.deepEqual(statuses, ['created', 'processing', 'completed']);
    const post = calls.find((c) => c.method === 'POST' && c.url.endsWith('image-to-video'));
    assert.deepEqual(JSON.parse(post.body), { prompt: 'p', image: 'https://cdn/x.jpg' });
    assert.equal(calls.filter((c) => c.method === 'POST').length, 2); // subida + envío, sin reintentos

    const bad = createWaveSpeed({ apiKey: 'k', mediaDir: dir, fetchImpl: fakeFetch({ fail: true }).fn, pollMs: 1 });
    await assert.rejects(bad.video({ model: 'm', body: {} }), /failed.*nsfw/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('flujo Video IA (demo): storyboard → cambios → aprobación → toma + capa de texto', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ws-'));
  try {
    const events = [];
    const asks = [];
    const answers = [{ cambios: 'que la cámara no se mueva' }, { aprobar: true, prompt: 'Locked-off static shot.' }];
    const input = parseIntuitionBody({ text: 'café', video, clips: [clip('C1', 1, 3.5, { mode: 'ai', videoModel: 'wan' }), clip('C2', 5, 8)] });
    const log = await runIntuitionPipeline({
      ...input,
      emit: (e) => events.push(e),
      llm: mockLLM,
      ask: async (d) => { asks.push(d); return answers.shift(); },
      ws: createMockWaveSpeed({ mediaDir: dir }),
      config: { motionModel: 'x', storyboardModel: 'sb', storyboardQuality: 'high', videoResolution: '720p', mediaDir: dir },
    });
    assert.equal(asks.length, 2);
    assert.equal(asks[0].kind, 'storyboard');
    assert.match(asks[0].plan.storyboard, /^\/media\/.+\.jpg$/);
    assert.equal(asks[1].plan.round, 2);
    assert.ok(events.some((e) => e.type === 'step_start' && e.step === 'vdirector-C1-r2'));
    const vid = events.find((e) => e.type === 'ai_video');
    assert.equal(vid.data.id, 'C1');
    assert.equal(vid.data.demo, true);
    assert.equal(vid.data.seconds, 3);
    assert.match(vid.data.prompt, /^Locked-off static shot\./);
    const motions = events.filter((e) => e.type === 'motion');
    assert.deepEqual(motions.map((m) => m.data.id).sort(), ['C1', 'C2']);
    const c1 = motions.find((m) => m.data.id === 'C1').data;
    assert.deepEqual(c1.sonido, []); // la capa de texto no lleva efectos
    assert.ok(c1.plan.prompt_video);
    assert.ok(motions.find((m) => m.data.id === 'C2').data.sonido.length > 0);
    assert.equal(log.aiVideo.C1.approved.round, 2);
    assert.ok(events.find((e) => e.type === 'step_start' && e.step === 'motion-C1').role === 'Tipógrafo');

    // Revisión de la capa de texto de un clip de video IA
    const rev = [];
    await runIntuitionRevision({
      video, clip: input.clips[0], direction: log.result.direction, box: { x: 0, y: 0, w: 1, h: 0.3 }, index: 0, total: 2,
      previous: { code: c1.code, meta: {} }, feedback: 'más chico', error: '', plan: c1.plan, generated: true,
      emit: (e) => rev.push(e), llm: mockLLM, config: { motionModel: 'x' },
    });
    assert.deepEqual(rev.find((e) => e.type === 'motion').data.sonido, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('flujo Video IA: sin cliente de WaveSpeed falla claro; tope de versiones del storyboard', async () => {
  const input = parseIntuitionBody({ video, clips: [clip('C1', 1, 3, { mode: 'ai' })] });
  await assert.rejects(runIntuitionPipeline({ ...input, emit: () => {}, llm: mockLLM, config: { motionModel: 'x' } }), /WAVESPEED_API_KEY/);
  const dir = await mkdtemp(path.join(tmpdir(), 'ws-'));
  try {
    let n = 0;
    await runIntuitionPipeline({
      ...input, emit: () => {}, llm: mockLLM, ws: createMockWaveSpeed({ mediaDir: dir }),
      ask: async () => { n++; return { cambios: 'otra vez' }; },
      config: { motionModel: 'x', storyboardModel: 'sb', mediaDir: dir },
    });
    assert.equal(n, MAX_STORYBOARD_ROUNDS);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
