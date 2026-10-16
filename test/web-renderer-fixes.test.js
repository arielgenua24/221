import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { patchWebRenderer } from '../src/lab/web-renderer-fixes.js';

const source = await readFile(new URL('../node_modules/@remotion/web-renderer/dist/esm/index.mjs', import.meta.url), 'utf8');

test('los arreglos del renderizador web encuentran su código en la versión instalada', () => {
  const out = patchWebRenderer(source);
  for (const fn of ['__labBackgroundFills', '__labRepeatingGradient', '__labCalc', '__labOuterShadows', '__labInsetShadows', '__labBackdrop']) assert.ok(out.includes(`var ${fn} =`), fn);
  assert.ok(out.includes('__labBackdrop({ ctx: context'), 'backdrop-filter en drawElement');
  assert.ok(out.includes('__labInsetShadows({ ctx: context'), 'inset después del fondo');
  assert.ok(out.includes('return __labCalc(value, reference)'), 'calc() en clip-path');
  assert.ok(!out.includes('function parsePolygon(args, rect) {\n  const pointStrings = args.split(",")'), 'polygon separa sin cortar calc()');
});

test('un cambio en el paquete hace fallar el build en vez de dejar un render roto', () => {
  assert.throws(() => patchWebRenderer(source.replace('function resolveLength(value, reference) {', 'function resolveLength(v, r) {')), /clip-path: calc/);
});

test('calc() y repeating-linear-gradient se resuelven como en CSS', () => {
  const out = patchWebRenderer(source);
  const helpers = out.slice(out.indexOf('// ---- arreglos del Laboratorio'));
  const { __labCalc, __labSplit } = new Function(`${helpers}; return { __labCalc, __labSplit };`)();
  assert.equal(__labCalc('calc(100% - 14px)', 200), 186);
  assert.equal(__labCalc('calc(50% + 10px)', 80), 50);
  assert.ok(Number.isNaN(__labCalc('calc(alert(1))', 80)));
  assert.deepEqual(__labSplit('repeating-linear-gradient(0deg, rgba(0, 0, 0, 0.6) 0px, transparent 2px), rgba(4, 14, 32, 0.82)', ','),
    ['repeating-linear-gradient(0deg, rgba(0, 0, 0, 0.6) 0px, transparent 2px)', 'rgba(4, 14, 32, 0.82)']);
  assert.deepEqual(__labSplit('calc(100% - 14px) 100%', ' '), ['calc(100% - 14px)', '100%']);
});
