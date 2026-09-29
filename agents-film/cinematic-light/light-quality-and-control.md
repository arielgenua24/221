# Light Quality and Control for AI Video Creation

## Purpose

Use this guide to describe what light visibly does to a scene before naming equipment or a lighting style. Understand source, direction, shadow quality, brightness, and color so the agent can request an image that is legible and physically coherent. A cinematic result can be bright, dark, soft, or hard; choose according to the scene.

# Part 1: Understand the language of light

## Source and direction

Identify the apparent source first: a window, open sky, sun, lamp, screen, streetlight, fire, or another plausible source. **Natural** light comes from natural phenomena; **artificial** light comes from human-made sources. **Ambient** light is the illumination already present in the location. A **practical** is a light source visible within the set or frame. These descriptions can overlap: a visible lamp can be both artificial and practical.

Describe where the source sits relative to the subject and frame: camera left or right, high or low, behind or in front, near or far. The direction should agree with highlights and cast shadows. A light can be added outside the frame to shape the image while still appearing to come from a plausible source in the scene; see [motivated lighting](motivated-lighting.md).

## Hardness and shadow shape

- **Hard light:** More defined shadow edges and sharper transitions from light to dark. Direct sunlight or a small undiffused source can produce it. It can reveal texture and form or make shadows conspicuous.
- **Soft light:** Gradual shadow edges and smoother transitions. A large apparent source, diffusion, bounce, or an overcast sky can produce it. It can make transitions across a face or product more gentle.

Hardness describes the *edge* of a shadow. It is distinct from overall brightness and from the amount of contrast across the finished frame. Soft light can still be used in a dark scene; hard light can be used in a bright one. Do not turn “cinematic” into a default request for harsh shadows.

## Brightness, contrast, and falloff

**Exposure** is how the camera records the light that reaches it. **Contrast** describes the difference between light and dark areas. A high-key image usually keeps subject and background relatively even; a low-key image allows larger differences. Either can use more than one kind of source. Keep important faces, garments, product details, or text visible at the intended viewing size.

Light generally weakens with distance from its source. A nearby lamp should not illuminate a whole large room with identical strength unless there is another source or bounce to explain it. Reflected or **bounce** light can lift shadows; **diffusion** can soften light before it reaches the subject; blocking or **negative fill** can deepen a side of the image. Name these techniques only when they help specify the visible result.

## Color and continuity

Different sources can have different color appearances: daylight may read cooler or more neutral than a warm household lamp, depending on conditions and white balance. Describe the *relative* colors that matter instead of prescribing Kelvin values without a production reason. If the subject turns or the camera moves, highlights and shadows should respond consistently to the same sources. A new color or direction of light needs an apparent source or a scene change.

# Part 2: Choose and verify a lighting treatment

Begin with the action and what viewers must read. Then choose a plausible source, its direction, its hardness, and how much the background should remain visible. Write the plan in observable terms:

1. **Source:** What in or just outside the scene could emit or reflect the light?
2. **Direction:** Which side of the face, object, or garment receives it? Where do shadows fall?
3. **Quality:** Are shadow edges crisp or gradual? Is the surface texture meant to stand out?
4. **Balance:** What remains readable in the dark areas? What should be brightest?
5. **Color:** How does this source compare with other visible light?
6. **Continuity:** What should remain stable across neighboring shots and moving subjects?

For example, a person showing a dark jacket beside a large window may need broad, soft window light to preserve fabric detail, with a small bounce from the room to keep the far sleeve readable. A sharp late-afternoon beam could instead emphasize weave and silhouette if the jacket stays visible. Choose by the product and the intended impression, not by a universal preference for one light quality.

Avoid mixing incompatible instructions such as “overcast soft light” with “knife-sharp noon-sun shadows” unless a second source is specified. Inspect the generated frame for detached shadows, conflicting highlight directions, unexplained glowing edges, clipped highlights, and faces or products that change brightness between adjacent shots.

# Part 3: Adapt lighting to social media and AI-generated video

Social videos may be viewed on a small screen and in bright surroundings. Review the final crop at phone size so skin, products, gestures, and captions remain legible. A low-key look can work when the important detail is still visible; a bright look can work without flattening all shape. Match the lighting to a testimonial, tutorial, fashion sequence, or story rather than imposing one house style.

For generated video, prefer concrete spatial descriptions over gear lists. “Large window on frame left gives soft light across the face; the right cheek is gently darker; the shadow falls to frame right” tells the model what to render. “Use a softbox and a flag” may be useful for a real shoot, but equipment names alone do not specify the visible outcome. State the source, direction, shadow edge, color, and continuity needs in the prompt; then check the rendered frames.

## Recommended lighting specification

```text
Purpose: [what the light should reveal, hide, or emphasize]
Apparent source: [window / sun / lamp / screen / other]
Direction and position: [relative to subject and camera]
Quality: [hard or soft shadow edges; visible texture]
Brightness and contrast: [what is light, dark, and still readable]
Color relationship: [relative warmth or coolness of sources]
Continuity: [how lighting behaves as subject or camera moves]
```

## Final quality check

1. Can the viewer infer a plausible source for the main light?
2. Do highlights and shadows agree on direction and quality?
3. Are hardness, brightness, and contrast described as separate properties?
4. Are the required face, product, action, and text details legible in the final crop?
5. Does lighting remain coherent across motion and adjacent shots?

## Source

Adapted from [StudioBinder's *Cinematic Lighting Cheatsheet*](https://s.studiobinder.com/wp-content/uploads/2022/10/Cinematic-Lighting-Cheatsheet.pdf), especially its definitions of natural, ambient, practical, hard, soft, bounce, diffusion, falloff, exposure, and contrast. The decision process and AI-video examples are applications of those terms.
