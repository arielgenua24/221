// Motor canvas · el núcleo: helpers de animación + cómo se evalúa y se dibuja el código de un agente.
// Es un script clásico (no un módulo) porque se usa igual en tres lugares:
//   - el iframe del Player (src/engines/canvas/frame.js),
//   - la página suelta para renderizar headless con window.seek(t) (standaloneDocument, render.js),
//   - el servidor, dentro de un sandbox de node:vm, para probar el código antes de mandarlo (smoke test).
// El código del agente es una función pura del tiempo: el mismo t da siempre el mismo cuadro.
(function (root) {
  'use strict';

  // Familias de Google Fonts que el entorno sabe cargar (las mismas que el motor Remotion, con su nombre real).
  const FONT_FAMILIES = [
    'Inter', 'Space Grotesk', 'Manrope', 'Syne', 'Unbounded', 'Archivo Black', 'Anton', 'Bebas Neue', 'Playfair Display',
    'Instrument Serif', 'DM Serif Display', 'Fraunces', 'JetBrains Mono', 'Caveat', 'Montserrat', 'Poppins', 'Oswald', 'Roboto', 'DM Sans', 'Sora',
  ];

  // ---------- Helpers (el agente los recibe como variables globales) ----------
  const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
  const lerp = (a, b, t) => a + (b - a) * t;
  const invLerp = (a, b, x) => (b === a ? 0 : clamp((x - a) / (b - a)));
  const remap = (x, a, b, c, d) => lerp(c, d, invLerp(a, b, x));
  // Progreso 0→1 de t entre a y b (segundos), ya recortado.
  const seg = (t, a, b) => invLerp(a, b, t);

  // Resorte amortiguado en forma cerrada, 0 → 1. Función pura del tiempo (k: rigidez, d: amortiguación).
  function spring(t, k = 170, d = 26) {
    if (t <= 0) return 0;
    const w0 = Math.sqrt(k), z = d / (2 * w0);
    if (z < 1) {
      const wd = w0 * Math.sqrt(1 - z * z);
      return 1 - Math.exp(-z * w0 * t) * (Math.cos(wd * t) + (z * w0 / wd) * Math.sin(wd * t));
    }
    return 1 - Math.exp(-w0 * t) * (1 + w0 * t); // z >= 1 se trata como crítico
  }

  // Ruido con semilla, nunca Math.random: el render tiene que dar igual en cada corrida.
  function rng(seed) {
    return () => {
      seed |= 0; seed = seed + 0x6D2B79F5 | 0;
      let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  const c1 = 1.70158, c3 = c1 + 1;
  const ease = {
    linear: (x) => x,
    inQuad: (x) => x * x,
    outQuad: (x) => 1 - (1 - x) * (1 - x),
    inOutQuad: (x) => (x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2),
    inCubic: (x) => x * x * x,
    outCubic: (x) => 1 - Math.pow(1 - x, 3),
    inOutCubic: (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2),
    outQuart: (x) => 1 - Math.pow(1 - x, 4),
    inExpo: (x) => (x === 0 ? 0 : Math.pow(2, 10 * x - 10)),
    outExpo: (x) => (x === 1 ? 1 : 1 - Math.pow(2, -10 * x)),
    inOutExpo: (x) => (x === 0 ? 0 : x === 1 ? 1 : x < 0.5 ? Math.pow(2, 20 * x - 10) / 2 : (2 - Math.pow(2, -20 * x + 10)) / 2),
    outBack: (x) => 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2),
    inOutSine: (x) => -(Math.cos(Math.PI * x) - 1) / 2,
  };

  // `font(700, 120, 'Anton')` → '700 120px "Anton", sans-serif'
  const font = (weight, px, family = 'Inter') => `${weight} ${Math.round(px)}px "${family}", sans-serif`;
  // '#FF5A1F' + alfa → 'rgba(255, 90, 31, 0.5)'
  function alpha(hex, a) {
    const h = String(hex).replace('#', '');
    const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h.slice(0, 6);
    const n = parseInt(full, 16) || 0;
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${clamp(a)})`;
  }
  // Parte un texto en líneas que entran en maxWidth con la fuente actual de g.
  function wrap(g, text, maxWidth) {
    const lines = [];
    let line = '';
    for (const word of String(text).split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (line && g.measureText(next).width > maxWidth) { lines.push(line); line = word; } else line = next;
    }
    if (line) lines.push(line);
    return lines;
  }
  // Dibuja una imagen cubriendo (o conteniendo) un rectángulo, como object-fit.
  function drawFit(g, img, x, y, w, h, mode = 'cover') {
    const iw = img.naturalWidth || img.videoWidth || img.width, ih = img.naturalHeight || img.videoHeight || img.height;
    if (!iw || !ih) return;
    const s = mode === 'contain' ? Math.min(w / iw, h / ih) : Math.max(w / iw, h / ih);
    g.drawImage(img, x + (w - iw * s) / 2, y + (h - ih * s) / 2, iw * s, ih * s);
  }

  const HELPERS = { clamp, lerp, invLerp, remap, seg, spring, rng, ease, font, alpha, wrap, drawFit };
  // Lo que el entorno le pone al alcance al código (además de los helpers).
  const GLOBALS = ['g', 'W', 'H', 'FPS', 'DUR', 'zones', 'images', 'sounds'];

  // FONTS: ['Anton', 'Inter:400,800'] → [{ family, weights }]. Lanza si la familia no existe en el entorno.
  function parseFonts(list) {
    if (!Array.isArray(list)) throw new Error('FONTS tiene que ser una lista, ej. const FONTS = [\'Anton\', \'Inter:400,700\']');
    return list.map((f) => {
      const [family, w] = String(f).split(':');
      const name = family.trim();
      if (!FONT_FAMILIES.includes(name)) throw new Error(`la fuente "${name}" no existe en este entorno. Familias: ${FONT_FAMILIES.join(', ')}`);
      const weights = (w || '400').split(/[,;]/).map((x) => Math.round(Number(x))).filter((x) => x >= 100 && x <= 900);
      return { family: name, weights: weights.length ? [...new Set(weights)] : [400] };
    });
  }

  // Ejecuta el código del agente con el entorno y devuelve { scenes, fonts, audio } ya validados.
  // El código va dentro de un bloque: puede redeclarar un helper (const clamp = …) sin chocar con los del entorno.
  function evaluate(js, env) {
    const names = GLOBALS.concat(Object.keys(HELPERS));
    const body = `"use strict";\n{\n${js}\n;return { SCENES: typeof SCENES === 'undefined' ? undefined : SCENES, FONTS: typeof FONTS === 'undefined' ? [] : FONTS, AUDIO: typeof AUDIO === 'undefined' ? [] : AUDIO };\n}`;
    // eslint-disable-next-line no-new-func
    const out = new Function(...names, body)(...GLOBALS.map((k) => env[k]), ...Object.values(HELPERS));
    if (!Array.isArray(out.SCENES)) throw new Error('falta `const SCENES = [{ from, to, draw(t) { … } }, …]`');
    const scenes = out.SCENES.map((s, i) => {
      if (!s || typeof s.draw !== 'function') throw new Error(`la escena ${i + 1} no tiene draw(t)`);
      const from = Number(s.from), to = Number(s.to);
      if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) throw new Error(`la escena ${i + 1} necesita from < to en segundos (tiene from: ${s.from}, to: ${s.to})`);
      return { from, to, draw: s.draw, name: s.name || `escena ${i + 1}` };
    });
    if (!Array.isArray(out.AUDIO)) throw new Error('AUDIO tiene que ser una lista, ej. const AUDIO = [{ sound: \'sfx1\', at: 1.2, volume: 0.6 }]');
    const audio = out.AUDIO.map((a, i) => {
      const id = String(a?.sound || '');
      if (!env.sounds || !(id in env.sounds)) throw new Error(`AUDIO[${i}] usa el sonido "${id}", que no existe${env.sounds && Object.keys(env.sounds).length ? ` (hay: ${Object.keys(env.sounds).join(', ')})` : ': no generaste ningún sonido'}`);
      const at = Number(a.at);
      if (!Number.isFinite(at) || at < 0) throw new Error(`AUDIO[${i}].at tiene que ser el segundo del video donde suena`);
      return { sound: id, at, volume: clamp(Number(a.volume ?? 1)) };
    });
    return { scenes, fonts: parseFonts(out.FONTS), audio };
  }

  // Limpia el contexto y dibuja las escenas activas en el segundo T. Cada cuadro arranca de cero:
  // un cuadro nunca depende del anterior (se puede saltar a cualquier t).
  function drawAt(layer, g, T) {
    if (g.reset) g.reset();
    else {
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.globalAlpha = 1;
      g.globalCompositeOperation = 'source-over';
      g.filter = 'none';
      g.clearRect(0, 0, g.canvas.width, g.canvas.height);
    }
    for (const s of layer.scenes) {
      if (T < s.from || T >= s.to) continue;
      g.save();
      try { s.draw(T - s.from, (T - s.from) / (s.to - s.from)); } catch (err) {
        // (El mensaje de un DOMException no se puede reescribir: se envuelve.)
        throw new Error(`${s.name} en ${T.toFixed(2)} s → ${err?.name || 'Error'}: ${err?.message || err}`);
      } finally { g.restore(); }
    }
  }

  // Los segundos que recorre una prueba de humo: comienzo, medio y final de cada escena.
  const sampleTimes = (layer) => [...new Set(layer.scenes.flatMap((s) => [s.from, (s.from + s.to) / 2, s.to - 1e-3]))].sort((a, b) => a - b);

  root.CanvasKit = { FONT_FAMILIES, HELPERS, GLOBALS, evaluate, drawAt, sampleTimes, parseFonts };
})(typeof globalThis !== 'undefined' ? globalThis : this);
