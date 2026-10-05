# The Camera as Narrator: Point-of-View Devices

## Purpose

Some requests are not about a movement or a shot size but about **who is watching**. "Like a spy camera", "as if from a security camera", "found footage", "through the eyes of the dog" all describe a *point-of-view device*: the camera itself becomes a character or an object inside the story, and the whole image takes the physical limits of that device (its position, lens, height, stability and texture).

This guide teaches how to recognize these requests, what each device means visually, and how to describe it for an AI video model.

# Part 1: Recognize the request — viewpoint or prop?

The same words can mean two different things:

- **Viewpoint:** the shot is *seen through* the device. "Make it look like a spy camera filmed it", "the camera is a hidden camera on the desk", "spy-cam view". The camera position, lens and texture change; nothing new appears in frame.
- **Prop:** the device *appears in the scene* as an object. "Add a small spy camera on the table", "put a security camera on the wall". The original camera stays; a new object is visible.

Signals for **viewpoint**: "like", "as if", "seen from", "the camera is…", "from the point of view of", "position the camera…", "make it feel like footage from…".
Signals for **prop**: "add", "put", "place", "show a…", "there should be a… on/in…", and a location *inside* the frame where the object sits.

When the words do not decide it ("a spy camera between the two characters"), **do not choose silently**: state both readings and ask. Choosing wrong costs a full generation.

If the request is a viewpoint, the image must be **reframed from the device's physical position**. Placing the device in the scene and keeping the old camera is the most common mistake.

# Part 2: The devices

## Hidden spy camera
A tiny camera concealed among objects (on a desk, inside a bookshelf, behind a plant). Static, very low or at object height, wide or fisheye lens with barrel distortion, foreground objects partly blocking the edges, people unaware of it, slightly soft focus, compressed low-light video with noise. Feels voyeuristic, secret, tense.
Prompt cue: "seen through a hidden spy camera concealed on the desk, at tabletop height, static, wide fisheye lens with barrel distortion, foreground clutter blurring the frame edges, the people unaware of the camera, compressed low-light video texture".

## Security / CCTV camera
Mounted high in a corner, looking down at a steep angle, static (or a slow mechanical pan), wide lens, flat overexposed light, desaturated color, low frame rate, digital noise. Feels observed, cold, documentary, evidential.
Prompt cue: "seen from a ceiling-mounted security camera in the corner of the room, high angle looking down, static, wide lens, flat desaturated surveillance video".
Do not add burned-in timestamps or REC overlays unless asked: video models render text badly.

## Subjective POV
The camera is the eyes of a character: eye height of that character, moves with their head and body, hands may enter the frame, other characters look into the lens. Feels immersive, first person.
Prompt cue: "first-person point of view through the eyes of [character], eye height, the camera moves with their head, their hands entering the bottom of the frame".

## Found footage / handheld amateur
An amateur operator inside the scene: unstable handheld, imperfect framing, autofocus hunting, quick reframes toward the action. Feels raw, real, urgent.

## Bodycam / dashcam
Fixed to a body or a car: chest height or dashboard height, very wide lens, horizon moves with the body/vehicle, constant small vibration.

## Peephole / door viewer
Extreme fisheye circle with dark vignette around it, looking through a small hole, static. Feels intrusive.

## Drone / aerial
High above, smooth floating motion, top-down or oblique angle. Feels omniscient, scale-revealing. (Not a "spy" device unless the request says so.)

## Webcam / screen camera
At screen height facing the person, slightly low angle, wide lens, flat front light from the screen, compressed video.

# Part 3: Apply it to AI video

- Describe the **physical position** first (where the device is, how high, which way it looks), then the lens, then stability, then texture. Position is what makes the viewpoint read.
- A viewpoint change is a **new camera**: never also ask the model to keep the original framing or camera movement.
- Keep the people, their actions and the place: only the observer changes.
- Texture (noise, compression, desaturation) sells the device but should stay subtle enough for the people to remain recognizable.
- Avoid on-screen text (timestamps, REC, battery icons) unless the human asks for it.
