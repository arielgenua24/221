import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTakeRecorder, parseTake, poseAt, lerpPose, frameCount, cameraBPath, parseCamB, TAKE } from '../public/jev-build/take.js';

const Q0 = [0, 0, 0, 1];
const QY90 = [0, Math.SQRT1_2, 0, Math.SQRT1_2]; // 90° alrededor de Y

// Un vuelo de 2 s: la cámara avanza de x = 0 a x = 4 y el avión va 1 m delante, girando 90°.
function flight() {
  const rec = createTakeRecorder({ subject: 'avion' });
  for (let i = 0; i <= 4; i++) {
    const u = i / 4;
    rec.add(1000 + i * 500, [4 * u, 1, 5, ...Q0], [4 * u, 1, 4, ...lerpPose([0, 0, 0, ...Q0], [0, 0, 0, ...QY90], u).slice(3)]);
  }
  return rec.finish();
}

test('la actuación graba tiempos desde 0 e ignora cuadros repetidos', () => {
  const rec = createTakeRecorder({ subject: 'avion' });
  rec.add(5000, [0, 0, 0, ...Q0]);
  rec.add(5000, [9, 9, 9, ...Q0]);
  rec.add(5250, [1, 0, 0, ...Q0], [1, 0, -1, ...Q0]);
  const t = rec.finish();
  assert.deepEqual(t.samples.map((s) => s.t), [0, 0.25]);
  assert.equal(t.duration, 0.25);
  assert.equal(t.subject, 'avion');
  assert.equal(t.samples[0].object, undefined);
});

test('poseAt interpola posición y rotación entre muestras y se queda en los extremos', () => {
  const take = flight();
  const mid = poseAt(take, 0.75); // entre 0.5 s y 1 s
  assert.ok(Math.abs(mid.camera[0] - 1.5) < 1e-9);
  assert.deepEqual(poseAt(take, -1).camera, take.samples[0].camera);
  assert.deepEqual(poseAt(take, 99).object, take.samples.at(-1).object);
  // A mitad de camino el avión giró 45°: el cuaternión es unitario y su ángulo es 45°.
  const q = poseAt(take, 1).object.slice(3);
  assert.ok(Math.abs(Math.hypot(...q) - 1) < 1e-9);
  assert.ok(Math.abs(2 * Math.acos(q[3]) - Math.PI / 4) < 1e-3);
});

test('slerp toma el camino corto aunque el cuaternión venga con signo opuesto', () => {
  const p = lerpPose([0, 0, 0, ...QY90], [0, 0, 0, ...QY90.map((v) => -v)], 0.5);
  assert.ok(Math.abs(Math.abs(p[4]) - Math.SQRT1_2) < 1e-9);
});

test('frameCount cubre toda la duración a fps fijos', () => {
  assert.equal(frameCount(flight(), 30), 61);
  assert.equal(frameCount(flight(), TAKE.fps), Math.round(2 * TAKE.fps) + 1);
});

test('cámara B fija: no se mueve ni gira (el avión pasa por el cuadro); seguidora: lo persigue y lo mira', () => {
  const take = flight();
  const camB = { position: [0, 2, 8], target: [0, 1, 0], mode: 'fixed' };
  const fixed = cameraBPath(take, camB, 30);
  assert.equal(fixed.length, 61);
  assert.deepEqual(fixed[0].position, [0, 2, 8]);
  assert.deepEqual(fixed.at(-1).position, [0, 2, 8]);
  assert.ok(fixed.every((f) => f.target.join() === '0,1,0'), 'mira siempre a donde la dejaste');
  const follow = cameraBPath(take, { ...camB, mode: 'follow' }, 30);
  assert.deepEqual(follow[0].position, [0, 2, 8]);
  assert.ok(follow.at(-1).position[0] > 2 && follow.at(-1).position[0] < 4, 'va detrás del avión, con retraso');
  assert.equal(follow.at(-1).position[1], 2);
  assert.deepEqual(follow.at(-1).target, [4, 1, 4]);
});

test('sin objeto en la actuación, la cámara B mira a donde la dejaste', () => {
  const rec = createTakeRecorder();
  rec.add(0, [0, 1, 5, ...Q0]);
  rec.add(1000, [1, 1, 5, ...Q0]);
  const path = cameraBPath(rec.finish(), { position: [3, 2, 3], target: [0, 1, 0], mode: 'follow' }, 10);
  assert.deepEqual(path.at(-1), { position: [3, 2, 3], target: [0, 1, 0] });
});

test('parseTake y parseCamB validan lo guardado', () => {
  const take = flight();
  assert.deepEqual(parseTake(JSON.parse(JSON.stringify(take))), take);
  assert.throws(() => parseTake({ samples: [take.samples[0]] }), /al menos 2/);
  assert.throws(() => parseTake({ samples: [take.samples[1], take.samples[0]] }), /inválida/);
  assert.deepEqual(parseCamB({ position: [1, 2, 3], target: [0, 0, 0], mode: 'raro' }), { position: [1, 2, 3], target: [0, 0, 0], mode: 'fixed' });
  assert.equal(parseCamB({ position: [1, 2] }), null);
});
