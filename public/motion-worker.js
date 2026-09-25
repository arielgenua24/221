// Worker que ejecuta el motion design generado por IA. Aislado del resto de la app:
// sin DOM, y el servidor lo entrega con una CSP que le prohíbe toda conexión de red.
// Protocolo:
//   → { type: 'font', family, weight, style, unicodeRange, buffer }
//   → { type: 'load', id, code, dur, fonts, palette }          ← { type: 'loaded', id, error? }
//   → { type: 'frame', id, req, t, w, h }                      ← { type: 'frame', id, req, bitmap? , error? }
//   → { type: 'unload', id }
import { compileMotion, makeEnv } from './motion-lib.js';

// Por las dudas (la CSP ya lo impide): sin red.
for (const k of ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'importScripts']) {
  try { self[k] = undefined; } catch { /* sigue */ }
}

const clips = new Map(); // id -> { draw, setup, dur, fonts, palette, canvas, ctx, env, state, key }
const pendingFonts = [];

async function addFont({ family, weight, style, unicodeRange, buffer }) {
  if (!self.fonts || typeof FontFace === 'undefined') return;
  try {
    const face = new FontFace(family, buffer, { weight: String(weight), style: style || 'normal', unicodeRange: unicodeRange || undefined });
    await face.load();
    self.fonts.add(face);
  } catch { /* se usa la fuente del sistema */ }
}

function envFor(clip, w, h) {
  const key = `${w}x${h}`;
  if (clip.key === key) return clip.env;
  clip.key = key;
  clip.canvas = new OffscreenCanvas(w, h);
  clip.ctx = clip.canvas.getContext('2d');
  clip.env = makeEnv({ w, h, dur: clip.dur, fonts: clip.fonts, palette: clip.palette });
  // setup corre de nuevo cada vez que cambia el tamaño de la ventana.
  clip.env.state = clip.setup ? clip.setup(clip.env, clip.ctx) ?? {} : {};
  return clip.env;
}

self.onmessage = async ({ data: msg }) => {
  if (msg.type === 'font') { pendingFonts.push(addFont(msg)); return; }
  if (msg.type === 'unload') { clips.delete(msg.id); return; }
  if (msg.type === 'load') {
    try {
      const { draw, setup } = compileMotion(msg.code);
      clips.set(msg.id, { draw, setup, dur: msg.dur, fonts: msg.fonts, palette: msg.palette || [], key: null });
      await Promise.all(pendingFonts);
      self.postMessage({ type: 'loaded', id: msg.id });
    } catch (err) {
      clips.delete(msg.id);
      self.postMessage({ type: 'loaded', id: msg.id, error: err.message });
    }
    return;
  }
  if (msg.type === 'frame') {
    const clip = clips.get(msg.id);
    if (!clip) { self.postMessage({ type: 'frame', id: msg.id, req: msg.req, error: 'sin código' }); return; }
    const w = Math.max(2, Math.round(msg.w));
    const h = Math.max(2, Math.round(msg.h));
    try {
      const env = envFor(clip, w, h);
      const { ctx } = clip;
      // Cada cuadro arranca de un contexto limpio (así un cuadro nunca depende del anterior).
      if (ctx.reset) ctx.reset();
      else {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
        ctx.filter = 'none';
        ctx.clearRect(0, 0, w, h);
      }
      ctx.save();
      clip.draw(ctx, Math.max(0, Math.min(clip.dur, msg.t)), env);
      ctx.restore();
      const bitmap = clip.canvas.transferToImageBitmap();
      self.postMessage({ type: 'frame', id: msg.id, req: msg.req, t: msg.t, bitmap }, [bitmap]);
    } catch (err) {
      clip.key = null; // que el próximo cuadro rehaga el canvas
      self.postMessage({ type: 'frame', id: msg.id, req: msg.req, error: `${err.name}: ${err.message}` });
    }
  }
};
