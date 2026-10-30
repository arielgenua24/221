import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { labSystem, briefContent, imageRegistry, reviewFix, REVIEW_APPROVED } from '../src/lab/harness.js';
import { parseLabBody, runLabAgent, approvedReview, MAX_STORYBOARD } from '../src/lab/pipeline.js';
import { planMessages } from '../src/lab/plan.js';
import { transcriptFrom } from '../src/lab/transcript.js';
import { defaultTemplate } from '../src/lab/context.js';
import { mockLabLLM } from '../src/lab/mock.js';
import { reviewFrames, reviewTurn, MAX_VISUAL_REVIEWS } from '../public/lab-review.js';

const IMG = 'data:image/jpeg;base64,/9j/AA==';
const video = { name: 'v.mp4', duration: 12, width: 1080, height: 1920 };
const clip = (id, start, end) => ({ id, start, end, prompt: `pedido ${id}`, notes: '', frames: [{ t: 0.5, url: IMG }], refs: [] });
const board = (n) => Array.from({ length: n }, (_, k) => ({ t: ((k + 0.5) / n) * 12, url: IMG }));
const body = (extra = {}) => ({ model: 'anthropic/claude-opus-5.5', brief: { context: '', instructions: '', refs: [] }, video, clips: [clip('C1', 1, 3.5), clip('C2', 6, 9)], ...extra });

test('el prompt de sistema pide mirar primero, una bitácora y revisiones al 25, 50, 75 y 100 % (los dos motores y Context Lab)', () => {
  for (const system of [labSystem({}, 'remotion'), labSystem({}, 'canvas'), defaultTemplate('remotion'), defaultTemplate('canvas')]) {
    assert.match(system, /## Work log/);
    assert.match(system, /25%, 50%, 75%, AND 100%/);
    assert.match(system, /Coherence/);
    assert.match(system, /Consistency/);
    assert.match(system, /Good taste, the most important/);
    assert.match(system, /storyboard/i);
    assert.match(system, /VISUAL REVIEW/);
  }
});

test('parseLabBody valida el storyboard: solo imágenes, ordenado, dentro del video y con tope', () => {
  const input = parseLabBody(body({ storyboard: [{ t: 30, url: IMG }, { t: 2, url: IMG }, { t: 1, url: 'http://x' }, ...board(20)] }));
  assert.equal(input.storyboard.length, MAX_STORYBOARD);
  assert.ok(input.storyboard.every((f, i, a) => !i || a[i - 1].t <= f.t));
  assert.ok(input.storyboard.every((f) => f.t <= 12 && f.url === IMG));
});

test('briefContent pone el storyboard antes de las zonas, con ids ST y en qué zona cae cada cuadro', () => {
  const input = parseLabBody(body({ storyboard: board(4) }));
  const parts = briefContent(input);
  assert.match(parts[0].text, /# Storyboard of the whole video\n4 frames/);
  assert.match(parts[0].text, /- ST3 at 7\.50 s \(inside C2\)/);
  const labels = parts.filter((p) => p.type === 'text').slice(1).map((p) => p.text.split(' ')[0]);
  assert.deepEqual(labels.slice(0, 5), ['ST1', 'ST2', 'ST3', 'ST4', 'C1-1']);
  assert.equal(imageRegistry(input).get('ST2'), IMG);
  // Con 0 cuadros por zona (Context Lab) el agente tampoco ve el storyboard.
  assert.doesNotMatch(briefContent(input, { frames: 0 })[0].text, /Storyboard/);
});

test('el planificador ve el storyboard como imágenes y se le pide elegir con lo que se ve', () => {
  const transcript = transcriptFrom(JSON.parse(readFileSync(new URL('./fixtures/whisper-output.json', import.meta.url), 'utf8')), 6.03);
  const [system, user] = planMessages({ count: 2, video: { name: 'v', duration: 12 }, transcript, storyboard: board(3) });
  assert.match(system.content, /mirá el storyboard ANTES de elegir/);
  assert.ok(Array.isArray(user.content));
  assert.equal(user.content.filter((p) => p.type === 'image_url').length, 3);
  assert.match(user.content[0].text, /# Storyboard\n3 cuadros/);
  // Sin storyboard sigue como antes: solo texto.
  const [plain, only] = planMessages({ count: 2, video: { name: 'v', duration: 12 }, transcript });
  assert.equal(typeof only.content, 'string');
  assert.doesNotMatch(plain.content, /storyboard/);
});

test('reviewFrames fotografía cada zona lejos de los bordes, con tope de capturas', () => {
  const picks = reviewFrames([{ id: 'C1', from: 30, durationInFrames: 60 }, { id: 'C2', from: 180, durationInFrames: 90 }], 30);
  assert.deepEqual(picks.map((p) => p.frame), [42, 60, 78, 198, 225, 252]);
  assert.match(picks[0].label, /^C1, 1 of 3 in the zone, 1\.40 s into the video \(frame 42\)$/);
  const many = reviewFrames(Array.from({ length: 6 }, (_, i) => ({ id: `C${i + 1}`, from: i * 100, durationInFrames: 50 })), 30);
  assert.equal(many.length, 12);
});

test('reviewTurn arma el turno con las capturas etiquetadas y saca las de turnos anteriores', () => {
  const older = [{ code: 'x', kind: 'review', message: 'm', shots: [{ label: 'a', url: IMG }] }];
  const t = reviewTurn(older, 'code', [{ frame: 42, label: 'C1, 1 of 3' }], [{ frame: 42, url: IMG }, { frame: 50, url: '' }], 1);
  assert.equal(older[0].shots, undefined);
  assert.deepEqual(t, { code: 'code', kind: 'review', message: `revisión visual 1/${MAX_VISUAL_REVIEWS}`, round: 1, rounds: MAX_VISUAL_REVIEWS, shots: [{ label: 'C1, 1 of 3', url: IMG }] });
});

test('approvedReview: la palabra sola en una línea y ningún bloque de código', () => {
  assert.ok(approvedReview(`## Work log\n1. [x] algo\nCheckpoint (visual review 1): bien\n${REVIEW_APPROVED}`));
  assert.ok(approvedReview(`**${REVIEW_APPROVED}**`));
  assert.ok(!approvedReview(`${REVIEW_APPROVED}\n\`\`\`tsx\nexport default () => null;\n\`\`\``));
  assert.ok(!approvedReview('Not approved yet, the title covers the face'));
});

test('runLabAgent: en la revisión visual el agente ve SUS capturas y puede aprobar sin reescribir el código', async () => {
  const shots = [{ label: 'C1, 1 of 3 in the zone', url: IMG }, { label: 'C2, 2 of 3 in the zone', url: IMG }];
  const turns = [{ code: 'export default () => null;', kind: 'review', message: 'revisión visual 1/2', round: 1, rounds: 2, shots }];
  const input = parseLabBody(body({ turns }));
  const seen = [];
  const events = [];
  await runLabAgent({ input, emit: (e) => events.push(e), llm: async (o) => { seen.push(o.messages); return mockLabLLM(o); } });
  const last = seen[0].at(-1).content;
  assert.equal(last[0].text, reviewFix(1, 2, 'remotion'));
  assert.deepEqual(last.filter((p) => p.type === 'text').slice(1).map((p) => p.text), ['V1 — C1, 1 of 3 in the zone', 'V2 — C2, 2 of 3 in the zone']);
  assert.equal(last.filter((p) => p.type === 'image_url').length, 2);
  assert.ok(events.some((e) => e.type === 'approved' && /Checkpoint \(visual review 1\)/.test(e.notes)));
  assert.equal(events.find((e) => e.type === 'done').approved, true);
  assert.ok(!events.some((e) => e.type === 'result'));
});

test('runLabAgent: un modelo que encuentra problemas en su revisión entrega el componente corregido', async () => {
  const turns = [{ code: 'export default () => null;', kind: 'review', message: 'revisión visual 1/2', round: 1, rounds: 2, shots: [{ label: 'C1', url: IMG }] }];
  const events = [];
  // El demo barato corrige en la primera vuelta (y aprueba en la segunda).
  await runLabAgent({ input: parseLabBody(body({ model: 'qwen/qwen3.8-flash', turns })), emit: (e) => events.push(e), llm: mockLabLLM });
  const result = events.find((e) => e.type === 'result');
  assert.ok(result?.code);
  assert.match(result.notes, /## Work log/);
});

test('las capturas de revisiones anteriores ya no se reenvían', async () => {
  const turns = [
    { code: 'export default () => null;', kind: 'review', message: 'revisión visual 1/2', round: 1, rounds: 2, shots: [{ label: 'C1', url: IMG }] },
    { code: 'export default () => null;', kind: 'feedback', message: 'más grande' },
  ];
  const seen = [];
  await runLabAgent({ input: parseLabBody(body({ turns })), emit: () => {}, llm: async (o) => { seen.push(o.messages); return mockLabLLM(o); } });
  const review = seen[0].find((m) => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('Visual review 1/2'));
  assert.match(review.content, /no longer attached/);
});
