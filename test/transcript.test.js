import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { wordsOf, buildHeads, parseTranscript, transcriptBlock, transcriptFrom, transcribeVideo, demoOutput } from '../src/lab/transcript.js';
import { briefContent, zonesFor } from '../src/lab/harness.js';
import { parseLabBody } from '../src/lab/pipeline.js';

// Salida REAL de wavespeed-ai/openai-whisper-with-video con enable_timestamps (clip de 6 s).
const REAL = JSON.parse(readFileSync(new URL('./fixtures/whisper-output.json', import.meta.url), 'utf8'));

test('wordsOf lee las palabras con tiempo de la salida real de Whisper', () => {
  const words = wordsOf(REAL);
  assert.equal(words.length, 18);
  assert.deepEqual(words[5], { word: 'Pixar,', start: 1.2, end: 1.58 });
});

test('wordsOf reparte las palabras de un tramo si el modelo no trajo palabras', () => {
  const words = wordsOf({ text_details: [{ start: 2, end: 4, text: 'hola mundo lindo hoy' }] });
  assert.deepEqual(words.map((w) => [w.word, w.start]), [['hola', 2], ['mundo', 2.5], ['lindo', 3], ['hoy', 3.5]]);
});

test('buildHeads: un cabezal por segundo; cada palabra va al segundo en que empieza', () => {
  const heads = buildHeads(wordsOf(REAL), 6.03);
  assert.equal(heads.length, 7); // 0..6
  assert.equal(heads[0].text, 'Today we are talking about');
  assert.equal(heads[1].text, 'Pixar, Nemo'); // «Pixar,» arranca en 1.2 y «Nemo» en 1.88: los dos en el segundo 1
  assert.equal(heads[2].text, 'and Dory swim'); // «swim» arranca en 2.82
  assert.equal(heads[6].text, '');
  assert.equal(heads[1].at, 1.2);
});

test('buildHeads marca los segundos no speech y no pierde palabras', () => {
  const heads = buildHeads([{ word: 'a', start: 0.1, end: 0.2 }, { word: 'b', start: 3.4, end: 3.6 }], 5);
  assert.deepEqual(heads.map((h) => h.text), ['a', '', '', 'b', '']);
  assert.equal(heads.flatMap((h) => h.text.split(' ')).filter(Boolean).length, 2);
});

test('parseTranscript valida lo que manda el navegador y descarta lo vacío', () => {
  assert.equal(parseTranscript(null), null);
  assert.equal(parseTranscript({ heads: [{ t: 0, text: '' }] }), null);
  const t = parseTranscript({ language: 'es', duration: 3, heads: [{ t: 0, text: '  hola   mundo ', at: 0.2 }, { t: 1, text: '', at: null }, { text: 'x'.repeat(900) }] });
  assert.equal(t.heads[0].text, 'hola mundo');
  assert.equal(t.heads[2].text.length, 400);
  assert.equal(t.heads[2].t, 2);
});

test('transcriptBlock: cuadros absolutos, zonas que toca, silencios juntos y arranque tardío', () => {
  const t = transcriptFrom(REAL, 6.03);
  const zones = zonesFor([{ id: 'C1', start: 1, end: 3 }]);
  const block = transcriptBlock(t, zones);
  assert.match(block, /^# Video speech/);
  assert.match(block, /0:00 · frame 0 · Today we are talking about/);
  assert.match(block, /0:01 · frame 30 \(speech starts at frame 36\) · \[C1\] · Pixar, Nemo/);
  assert.match(block, /0:02 · frame 60 \(speech starts at frame 73\) · \[C1\] · and Dory swim/);
  assert.match(block, /0:03 · frame 90 · across the ocean,/); // la zona C1 termina en el segundo 3: no la toca
  assert.match(block, /0:06 · frame 180 · \(no speech\)/);
  const gap = transcriptBlock(parseTranscript({ heads: [{ t: 0, text: 'a', at: 0 }, { t: 1, text: '', at: null }, { t: 2, text: '', at: null }, { t: 3, text: 'b', at: 3.5 }] }));
  assert.match(gap, /0:01–0:02 · frame 30 · \(no speech\)/);
  assert.match(gap, /0:03 · frame 90 \(speech starts at frame 105\) · b/);
  assert.equal(transcriptBlock(null), '');
});

test('briefContent suma la sección de habla solo si hay transcripción, y parseLabBody la valida', () => {
  const video = { name: 'v.mp4', duration: 12, width: 1080, height: 1920 };
  const clips = [{ id: 'C1', start: 1, end: 3, prompt: '', notes: '', frames: [], refs: [] }];
  const brief = { context: '', instructions: '', refs: [] };
  const without = briefContent({ brief, video, clips })[0].text;
  assert.doesNotMatch(without, /Video speech/);
  const t = transcriptFrom(REAL, 6.03);
  const text = briefContent({ brief, video, clips, transcript: t })[0].text;
  assert.match(text, /# Video speech/);
  assert.ok(text.indexOf('# Marked zones') < text.indexOf('# Video speech'));
  const IMG = 'data:image/jpeg;base64,/9j/AA==';
  const parsed = parseLabBody({ model: 'anthropic/claude-opus-5.5', video, clips: [{ id: 'C1', start: 1, end: 3, prompt: '', notes: '', frames: [{ t: 0.5, url: IMG }], refs: [] }], brief, transcript: { heads: t.heads, language: 'en' } });
  assert.equal(parsed.transcript.heads.length, 7);
  assert.equal(parseLabBody({ model: 'anthropic/claude-opus-5.5', video, clips: [{ id: 'C1', start: 1, end: 3, prompt: '', notes: '', frames: [{ t: 0.5, url: IMG }], refs: [] }], brief }).transcript, null);
});

test('transcribeVideo sube el video, pide tiempos por palabra y calcula el costo', async () => {
  const calls = [];
  const ws = {
    uploadBuffer: async (buf, type, name) => { calls.push(['upload', buf.length, type, name]); return 'https://cdn/x.mp4'; },
    transcribe: async ({ model, body }) => { calls.push(['whisper', model, body]); return { task: 't1', output: REAL }; },
  };
  const out = await transcribeVideo({ ws, buffer: Buffer.from('abc'), type: 'video/mp4', name: 'clip.mp4', duration: 6.03 });
  assert.deepEqual(calls[0], ['upload', 3, 'video/mp4', 'clip.mp4']);
  assert.equal(calls[1][1], 'wavespeed-ai/openai-whisper-with-video');
  assert.deepEqual(calls[1][2], { video: 'https://cdn/x.mp4', language: 'auto', task: 'transcribe', enable_timestamps: true });
  assert.equal(out.language, 'en');
  assert.equal(out.heads.length, 7);
  assert.ok(out.cost > 0 && out.cost < 0.05);
  await assert.rejects(transcribeVideo({ ws: { uploadBuffer: async () => 'u', transcribe: async () => ({ output: 'texto' }) }, buffer: Buffer.from('a'), type: 'video/mp4', duration: 3 }), /tiempos/);
});

test('modo demo: guion determinista con silencios, sin llamar a nadie', async () => {
  const out = await transcribeVideo({ mock: true, duration: 10 });
  assert.equal(out.heads.length, 10);
  assert.equal(out.cost, 0);
  assert.equal(out.heads[4].text, '');
  assert.deepEqual(out, await transcribeVideo({ mock: true, duration: 10 }));
  assert.ok(demoOutput(3).text_details[0].words.length > 0);
});

test('runLabAgent le entrega la transcripción al modelo en el primer mensaje (y sin ella no hay sección)', async () => {
  const { runLabAgent } = await import('../src/lab/pipeline.js');
  const IMG = 'data:image/jpeg;base64,/9j/AA==';
  const base = (extra = {}) => parseLabBody({
    model: 'anthropic/claude-opus-5.5', video: { name: 'v.mp4', duration: 6, width: 1080, height: 1920 },
    clips: [{ id: 'C1', start: 1, end: 3, prompt: '', notes: '', frames: [{ t: 0.5, url: IMG }], refs: [] }],
    brief: { context: '', instructions: '', refs: [] }, ...extra,
  });
  const seen = [];
  const llm = async ({ messages }) => { seen.push(messages[1].content[0].text); return { text: '```tsx\nexport default function L() { return null; }\n```', usage: {} }; };
  const t = transcriptFrom(REAL, 6.03);
  await runLabAgent({ input: base({ transcript: { heads: t.heads, language: 'en' } }), emit: () => {}, llm });
  await runLabAgent({ input: base(), emit: () => {}, llm });
  assert.match(seen[0], /# Video speech[\s\S]*0:01 · frame 30 \(speech starts at frame 36\) · \[C1\] · Pixar, Nemo/);
  assert.doesNotMatch(seen[1], /Video speech/);
});
