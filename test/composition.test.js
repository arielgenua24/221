import test from 'node:test';
import assert from 'node:assert/strict';
import { labSystem } from '../src/lab/harness.js';
import { contextConfig, parseVariant } from '../src/lab/context.js';
import { parseLabBody, runLabAgent, paletteAndObjects, usedReferences } from '../src/lab/pipeline.js';
import { mixedCanvas, mixedRemotion, mixedNotes } from './fixtures/mixed-composition.js';

for (const engine of ['canvas', 'remotion']) {
  test(`${engine}: both labs give the designer scene-level composition choices without the old overlay-only restriction`, () => {
    const motion = labSystem({ search: false, images: false }, engine);
    const context = contextConfig(parseVariant({ engine, skills: [] }), {}).system;
    for (const system of [motion, context]) {
      assert.match(system, /choose add-on or fullscreen for each scene/);
      assert.match(system, /Follow any explicit format requested by the user/);
      assert.match(system, /including within a single marked zone/);
      assert.match(system, /Zones constrain WHEN to animate, not the available width or height/);
      assert.match(system, /own opaque background/);
      assert.match(system, /covering the picture does not pause the video or mute its voice/);
      assert.doesNotMatch(system, /sin fondo opaco|no pintes un fondo opaco|no tapes caras/);
      assert.match(system, /# Environment contract/);
    }
    // Editable templates retain their intended meaning; the new defaults do not overwrite them.
    assert.equal(contextConfig(parseVariant({ engine, template: 'Only transparent add-ons for this brand.' }), {}).system, 'Only transparent add-ons for this brand.');
  });

  test(`${engine}: the agent pipeline accepts a mixed composition and parses its English notes`, async () => {
    const img = 'data:image/png;base64,AAAA';
    const input = parseLabBody({
      engine, model: 'test/fixture',
      video: { name: 'base.webm', duration: 4, width: 320, height: 180 },
      clips: [{ id: 'C1', start: 0.5, end: 3.5, frames: [{ t: 0, url: img }], refs: [] }],
      brief: { refs: [{ name: 'reference.png', url: img }] },
    });
    const events = [];
    const code = engine === 'canvas' ? mixedCanvas : mixedRemotion;
    const fence = engine === 'canvas' ? 'js' : 'tsx';
    await runLabAgent({ input, emit: (event) => events.push(event), llm: async ({ messages }) => {
      assert.match(messages[0].content, /FULLSCREEN/);
      return { text: `${mixedNotes}\n\n\`\`\`${fence}\n${code}\n\`\`\``, usage: {} };
    } });
    assert.equal(events.find((e) => e.type === 'done').compileErrors, 0);
    const result = events.find((e) => e.type === 'result');
    assert.equal(result.engine, engine);
    assert.equal(result.code, code);
    assert.deepEqual(result.usedRefs, ['R1']);
    assert.deepEqual(result.palette, ['#141413', '#FF5A1F']);
    assert.deepEqual(result.objects, ['panel']);
  });
}

test('English note labels and legacy Spanish labels remain compatible, including empty values', () => {
  const reg = new Map([['S2', 'image']]);
  for (const notes of ['References used: S2\nPalette: #abc\nObjects: ball and leaves', 'Referencias usadas: S2\nPaleta: #abc\nObjetos: ball y leaves']) {
    assert.deepEqual(usedReferences(notes, reg), ['S2']);
    assert.deepEqual(paletteAndObjects(notes), { palette: ['#AABBCC'], objects: ['ball', 'leaves'] });
  }
  assert.deepEqual(paletteAndObjects('Palette: none\nObjects: none'), { palette: [], objects: [] });
  assert.deepEqual(paletteAndObjects('Paleta: ninguna\nObjetos: ninguno'), { palette: [], objects: [] });
});
