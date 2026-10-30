import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLook, parseLooks, resolveLook, describeRig, parseRig, LOOK } from '../public/jev-build/look.js';

const near = (a, b, eps = 1e-3) => a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < eps, `${a} ≈ ${b}`));
const KEY = { role: 'key', color: '#FFD8A8', intensity: 4, from: { side: -45, height: 45, distance: 5 } };
// El sujeto en el origen, la cámara en +Z mirándolo (como la vista por defecto).
const SUBJECT = { id: 'avion', origin: [0, 0, 0], center: [0, 1, 0], radius: 1 };
const CAMERA = [0, 1, 8];

test('parseLook completa lo que falta y acota los números', () => {
  const l = parseLook({ label: 'Rembrandt', exposure: 9, lights: [KEY, { role: 'rim', intensity: 40 }] });
  assert.equal(l.exposure, 2.5);
  assert.equal(l.lights[0].color, '#ffd8a8');
  assert.equal(l.lights[0].shadow, true); // la principal hace sombra si no se dice nada
  assert.equal(l.lights[1].intensity, 10);
  assert.equal(l.lights[1].shadow, false);
  assert.deepEqual(l.lights[1].from, { side: 0, height: 30, distance: 5 });
  assert.throws(() => parseLook({ label: 'x', lights: [] }), /de 1 a/);
  assert.throws(() => parseLook({ label: 'x', lights: [{ color: 'rojo' }] }), /#rrggbb/);
  assert.throws(() => parseLooks({ looks: [{ label: 'uno', lights: [KEY] }] }), new RegExp(`de ${LOOK.minOptions}`));
});

test('resolveLook pone cada luz del lado del cuadro que dice, mirando al sujeto', () => {
  const look = parseLook({ label: 'tres puntos', lights: [
    { role: 'key', from: { side: 90, height: 0, distance: 4 } },
    { role: 'fill', from: { side: -90, height: 0, distance: 4 } },
    { role: 'rim', from: { side: 180, height: 0, distance: 4 } },
    { role: 'practical', kind: 'sun', from: { side: 0, height: 90 } },
  ] });
  const rig = resolveLook(look, { subject: SUBJECT, camera: CAMERA });
  near(rig.lights[0].position, [4, 1, 0]); // derecha del cuadro = +X con la cámara en +Z
  near(rig.lights[1].position, [-4, 1, 0]);
  near(rig.lights[2].position, [0, 1, -4]); // detrás del sujeto
  near(rig.lights[3].position, [0, 21, 0]); // el sol, lejos y arriba
  assert.ok(rig.lights.every((l) => l.target.join() === '0,1,0'));
  // Con la cámara del otro lado, "la derecha del cuadro" también se da vuelta.
  near(resolveLook(look, { subject: SUBJECT, camera: [0, 1, -8] }).lights[0].position, [-4, 1, 0]);
});

test('la luz héroe queda relativa al sujeto y nunca adentro de él', () => {
  const look = parseLook({ label: 'héroe', lights: [{ role: 'hero', from: { side: 0, height: 0, distance: 1 } }] });
  const rig = resolveLook(look, { subject: { id: 'avion', origin: [10, 0, 0], center: [10, 1, 0], radius: 2 }, camera: [10, 1, 8] });
  const l = rig.lights[0];
  assert.equal(l.anchor, 'avion');
  near(l.position, [0, 1, 3]); // a 1,5 × radio, medido desde su origen
  near(l.target, [0, 1, 0]);
  // Sin sujeto elegido no hay a quién seguir: queda fija en el mundo.
  assert.equal(resolveLook(look, { subject: { ...SUBJECT, id: null }, camera: CAMERA }).lights[0].anchor, null);
});

test('describeRig devuelve los mismos ángulos con los que se resolvió', () => {
  const rig = resolveLook(parseLook({ label: 'L', lights: [KEY] }), { subject: SUBJECT, camera: CAMERA });
  const text = describeRig(rig, { camera: CAMERA, center: SUBJECT.center });
  assert.match(text, /side: -45, height: 45, distance: 5/);
  assert.match(describeRig(null, { camera: CAMERA, center: [0, 0, 0] }), /Luz base/);
});

test('parseRig acepta un rig guardado y descarta basura', () => {
  const rig = resolveLook(parseLook({ label: 'L', lights: [KEY] }), { subject: SUBJECT, camera: CAMERA });
  assert.deepEqual(parseRig(JSON.parse(JSON.stringify(rig))), rig);
  assert.equal(parseRig({ label: 'x', lights: [{ position: [0, 0] }] }), null);
  assert.equal(parseRig(null), null);
});
