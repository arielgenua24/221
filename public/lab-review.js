// Laboratorio · revisión visual: cuando la animación de un agente ya se reproduce sin errores, el iframe saca capturas
// (video + capa, tal cual se ven) de cada zona y se las devuelve al agente para que mire lo que hizo y la apruebe o la corrija.
// Lo usan Motion Design y Context Lab.
export const MAX_VISUAL_REVIEWS = 2; // vueltas seguidas de "mirar y corregir" por versión pedida
const MAX_SHOTS = 12;

const secs = (s) => `${s.toFixed(2)} s`;

// Los cuadros que se fotografían: dentro de cada zona, lejos de los bordes (ahí suelen estar las entradas y salidas a medio hacer).
// zones: [{ id, from, durationInFrames }] en cuadros. Devuelve [{ frame, label }].
export function reviewFrames(zones, fps) {
  const per = zones.length * 3 <= MAX_SHOTS ? [0.2, 0.5, 0.8] : zones.length * 2 <= MAX_SHOTS ? [0.3, 0.7] : [0.5];
  return zones.flatMap((z) => per.map((p, k) => {
    const frame = z.from + Math.min(z.durationInFrames - 1, Math.round(p * z.durationInFrames));
    return { frame, label: `${z.id}, ${k + 1} of ${per.length} in the zone, ${secs(frame / fps)} into the video (frame ${frame})` };
  })).slice(0, MAX_SHOTS);
}

// El turno de revisión que viaja al servidor: las capturas con su etiqueta (las de turnos anteriores ya no se mandan).
export function reviewTurn(turns, code, picks, shots, round) {
  turns.forEach((t) => { delete t.shots; });
  const byFrame = new Map(picks.map((p) => [p.frame, p.label]));
  return {
    code, kind: 'review', message: `revisión visual ${round}/${MAX_VISUAL_REVIEWS}`, round, rounds: MAX_VISUAL_REVIEWS,
    shots: shots.filter((s) => s.url).map((s) => ({ label: byFrame.get(s.frame) || `frame ${s.frame}`, url: s.url })),
  };
}
