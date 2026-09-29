# Visual Intensity and Progression for AI Video Creation

## Purpose

Use this guide to compare visual options and plan deliberate changes across shots. Bruce Block's contrast and affinity framework offers useful tendencies, including comparisons of line orientation and subject/camera movement. Treat these as directional heuristics that the agent can inspect or encode, not as automatic measures of emotion or quality.

# Part 1: Understand comparative visual intensity

## Contrast, affinity, and context

**Affinity** is similarity within a frame or across shots. **Contrast** is difference. Repeated horizontal lines, a consistent camera distance, or a recurring color can create affinity. A sudden diagonal, a new silhouette, or a shift from stillness to motion can create contrast. The effect depends on what the viewer has already seen and what the scene means.

Film Book Notes' summary of Block describes these useful comparisons:

- **Line orientation:** Diagonals tend to have more inherent visual intensity than verticals, and verticals more than horizontals. This is a *component-level tendency*. Line density, contrast, position, and subject matter can easily change the overall impression.
- **Subject and camera movement:** A still subject with a still camera is generally the least active combination. Movement of both subject and camera can be the most active. Direction, speed, scale, steadiness, and relative motion change the outcome.
- **Movement continuity:** A cut that preserves motion direction and pace may feel smoother; a break in that pattern may call attention to the transition. Either can serve the scene.
- **Visual rhythm:** Entrances and exits, starts and stops, direction changes, repeated forms, and edit spacing all create patterns. A cut can be a visual beat, but rhythm does not require fast cutting or music.

These comparisons are not a ranking of artistic worth. A still horizontal composition can be powerful because of a face, sound, timing, or story context. A moving camera and subject can feel calm when they travel together smoothly. Do not translate “more visual intensity” directly into “better,” “scarier,” or “more engaging.”

## Other observable variables

Space can become more or less deep through convergence, overlap, and parallax. Shape can change when a silhouette opens or closes. Tone and color can create affinity within a scene or contrast at a transition. These variables interact: a single bright moving object may dominate attention even inside a dense arrangement of diagonal lines.

# Part 2: Use the comparisons as decision rules

## Plan a progression, not a permanent maximum

Choose the intended experience for each moment. Establish a visual baseline, decide where a difference should be noticed, then select the smallest change that expresses it. An escalation might move from a locked shot to a moving subject, then to moving subject and camera. A resolution might return to stillness. This is an option, not an obligatory arc.

For each proposed change, ask:

1. What is the viewer meant to notice or understand at this point?
2. Which existing pattern makes the change legible?
3. Which component changes: line, space, shape, tone, color, movement, or rhythm?
4. Will the change preserve essential action and spatial clarity?
5. Does watching the sequence confirm the intended effect?

## Make heuristics programmable without making them absolute

An editing or shot-planning agent can store **observable features**, not an ungrounded universal score:

```text
Shot: [identifier and time range]
Dominant line directions: [horizontal / vertical / diagonal / mixed / uncertain]
Line evidence: [visible edges or paths and their prominence]
Camera motion: [still / moving; direction, speed, duration]
Subject motion: [still / moving; direction, speed, duration]
Relative motion: [whether background and subject separate or move together]
Other salient factors: [face, text, product, brightness, color, sound]
Previous-shot pattern: [what is repeated or changed]
Creative interpretation: [why this should feel continuous or contrasting]
Confidence: [high / medium / low; reason]
```

Use a rule such as “flag an added diagonal after several horizontal compositions” or “flag a shift from both still to both moving” to **offer a candidate moment for emphasis**. Keep a human-readable reason and allow the creative plan to reject it. Do not assign fixed emotional labels from geometry alone. Do not infer precise camera motion from a finished frame when subject motion, zoom, or generated artifacts make the evidence ambiguous.

## Example: a clothing-store reel

The opening uses steady, frontal product views with mostly horizontal shelf lines so the garments are easy to compare. At the try-on reveal, the model crosses the frame and a diagonal fabric fold becomes prominent. The agent can flag the new line direction and motion as a contrast, then verify whether the garment remains legible. If the moving camera obscures fit, keep the camera still and let the turn supply the change.

# Part 3: Adapt intensity choices to social media and AI-generated video

Short videos need rapid comprehension, not continuous maximum stimulation. Establish the product, person, or claim clearly; use contrast at moments that change the viewer's understanding. In an explainer, a stable shot may let a difficult idea land. In a performance or fashion video, combined motion may be useful when the movement itself is the point. Keep essential text and product features readable in the target crop.

For generated video, specify which element moves and which remains still. “The model turns while the camera remains locked; the scarf crosses the frame diagonally” is more verifiable than “increase visual intensity.” When proposing a stronger moment, check for unwanted camera drift, warped silhouettes, inconsistent garments, and motion that breaks continuity. If the generated result fails, choose a simpler shot or adjust the edit rather than preserving a theoretical intensity ranking.

## Recommended comparison

```text
Before: [dominant line, motion, space, and rhythm]
After: [what changes and what remains consistent]
Purpose: [story or communication reason for the change]
Expected tendency: [greater affinity or contrast in which component]
Evidence and uncertainty: [what can actually be seen or measured]
Review: [whether the viewer can read the intended subject and action]
```

## Final quality check

1. Are line and movement comparisons used as tendencies rather than universal emotional laws?
2. Does each flagged contrast have a visible cause and a reason in the content?
3. Are subject motion and camera motion distinguished?
4. Does the sequence preserve legibility, identity, and action continuity?
5. Can the agent explain and revise its suggestion after reviewing the rendered video?

## Source

Adapted from [Film Book Notes, “The Visual Story by Bruce Block”](https://filmbooknotes.blogspot.com/2013/05/the-visual-story-by-bruce-block.html), especially its notes on line orientation, movement combinations, motion continuity, and visual rhythm. The structured feature format and social-media example are proposed applications, not a scoring system supplied by the notes.
