// Motor Remotion: el agente escribe un componente React/Remotion (TSX). Es el de siempre, sin cambios:
// se compila con src/lab/runtime.js y se reproduce en el iframe de src/lab/frame.js (<Player> + @remotion/web-renderer).
import { readFile } from 'node:fs/promises';
import { buildRuntime, compileMotionLayer, extractCode, REMOTION_VERSION, FPS } from '../lab/runtime.js';
import { frameDocument } from './frame-doc.js';

const FRAME_SCRIPT = new URL('../lab/frame.js', import.meta.url);
let doc = null;

export const remotionEngine = {
  id: 'remotion',
  label: 'Remotion',
  version: `remotion ${REMOTION_VERSION}`,
  fps: FPS,
  fence: 'tsx',
  // Dónde termina la nota del modelo y empieza su código (para separar las notas de la respuesta).
  marker: /export\s+default/,
  // Cómo se nombran las cosas en los textos compartidos del harness (herramientas, pedidos de corrección).
  words: {
    player: 'the Remotion Player',
    shapes: '(shapes, SVG, @remotion/shapes)',
    imageWith: 'with Remotion’s `<Img>`',
    imageTag: '<Img src={images.gen1} />',
    imageUse: (id) => `<Img src={images.${id}} /> from remotion`,
    imageReady: (id) => `<Img src={images.${id}} /> from "remotion" (already provided by the images prop)`,
    imageCtx: '`images.gen1` with `<Img>`',
    soundTag: '<Audio src={sounds.sfx1} /> from "@remotion/media"',
    soundUse: (id) => `<Audio src={sounds.${id}} /> from "@remotion/media" inside the movement’s <Sequence>`,
    soundTool: '<Audio src={sounds.sfx1} volume={…} /> from "@remotion/media" inside a <Sequence> synchronized with the movement it accompanies',
    soundReady: (id) => `<Audio src={sounds.${id}} /> from "@remotion/media" inside the corresponding <Sequence> (already provided by the sounds prop)`,
    soundCtx: '`<Audio src={sounds.sfx1} volume={0.6} />` from "@remotion/media" inside the movement’s `<Sequence>`',
  },
  extractCode,
  compile: compileMotionLayer,
  // Se arma una vez (esbuild empaqueta React + Remotion: ~1 s) y queda en memoria.
  frameDocument() {
    doc ??= Promise.all([buildRuntime(), readFile(FRAME_SCRIPT, 'utf8')])
      .then(([runtime, script]) => frameDocument([runtime, script]))
      .catch((err) => { doc = null; throw err; });
    return doc;
  },
};
