// One marked zone, three scenes: add-on → fullscreen → add-on.
export const mixedZones = [{ id: 'C1', from: 15, durationInFrames: 90 }];
export const mixedCanvas = `const SCENES = [
  { from: 0.5, to: 1.5, draw() {
    g.fillStyle = '#FF5A1F'; g.fillRect(W * 0.4, H * 0.4, W * 0.2, H * 0.2);
  }},
  { from: 1.5, to: 2.5, draw() {
    g.fillStyle = '#141413'; g.fillRect(0, 0, W, H);
    g.fillStyle = '#FF5A1F'; g.fillRect(W * 0.4, H * 0.4, W * 0.2, H * 0.2);
  }},
  { from: 2.5, to: 3.5, draw() {
    g.fillStyle = '#FF5A1F'; g.fillRect(W * 0.4, H * 0.4, W * 0.2, H * 0.2);
  }},
];`;

export const mixedRemotion = `import { AbsoluteFill, Sequence, useCurrentFrame } from 'remotion';
function Scene() {
  const f = useCurrentFrame();
  return <AbsoluteFill style={{ backgroundColor: f >= 30 && f < 60 ? '#141413' : 'transparent' }}>
    <div style={{ position: 'absolute', left: '40%', top: '40%', width: '20%', height: '20%', backgroundColor: '#FF5A1F' }} />
  </AbsoluteFill>;
}
export default function Layer({ zones }) {
  return <>{zones.map((z) => <Sequence key={z.id} from={z.from} durationInFrames={z.durationInFrames} premountFor={30}><Scene /></Sequence>)}</>;
}`;

export const mixedNotes = 'One zone: add-on, fullscreen, then add-on.\nReferences used: R1\nPalette: #141413, #FF5A1F\nObjects: panel';
