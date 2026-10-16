# Motion composition: add-on and fullscreen

The Motion Designer chooses the composition for each scene from the user's brief,
the available video frames, and the pacing. An explicit user request takes precedence.
There is no additional format selector or required alternation between formats.

- **Add-on:** detailed or simple animation over part of the picture, leaving unused
  space transparent. It should preserve the readability of important video content.
- **Fullscreen:** a complete composition with its own opaque background covering
  the full picture. Background, typography, objects, and movement form one design.

Both formats may appear within one video or one marked zone. Zones limit time,
not spatial coverage. The original video and its audio continue underneath; a
fullscreen composition covers the picture without pausing the underlying footage.

## Where the instructions live

- `composition.js` contains the shared creative criteria.
- `canvas-contract.js` describes the Canvas API and how to paint either format.
- `harness.js` owns the shared Remotion contract and assembles Motion Design's
  system prompt from the contract, tool instructions, creative criteria, and skills.
- `context.js` uses the same contracts and criteria in Context Lab's default templates.

This Markdown file documents the behavior; it is not loaded into the model prompt.
The executable prompt source is the JavaScript modules listed above.

## Drawing and playback

The animation surface already has the video's full width and height. No replacement
of the animation engines is necessary to enable fullscreen scenes.

Canvas clears its surface before each frame. A fullscreen scene must paint its
background in every `draw` call, before transforming the foreground. When that
scene ends, the next frame starts clean, so an add-on can reveal the original video
again without retaining the previous background.

Remotion can render the background in an `AbsoluteFill` within the scene's
`Sequence`. Its timing determines when the background covers and reveals the video.
The compositor places the animation above the original video in playback and export.

Scale and position adjustments affect the entire animation layer. Default scale
and position preserve fullscreen edge-to-edge coverage; manually shrinking or
moving the layer can reveal the underlying video. There is no new per-scene
transform override.

## Existing projects and templates

Composition defaults were introduced in Motion Design harness `v7` and Context
Lab harness `ctx-v2`. Current harnesses `v8` / `ctx-v3` also include focused search
guidance and recoverable search timeouts. The underlying engine versions are unchanged.
Saved custom templates keep their text. To adopt the new default in such a variant,
use **Restaurar por defecto**, or edit the template explicitly.

New contracts request `References used`, `Palette`, and `Objects` labels. The server
also accepts the legacy Spanish labels, so older replies and templates remain readable.

## Verification

`test/composition.test.js` exercises both prompt paths, both agent pipelines with
authored mixed compositions, and English/Spanish note compatibility.
`test/browser/motion-composition.mjs` checks add-on → fullscreen → add-on playback
in portrait and landscape and inspects encoded exports for both engines. It uses
a locally recorded video and authored fixtures; it does not call models or media APIs.
