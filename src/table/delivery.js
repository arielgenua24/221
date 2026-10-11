import { SEATS } from '../../public/table-core.js';
import { imageSpec, voiceSpec, soundSpec, ASPECTS, LIMITS } from './media.js';

// Mesa de agentes · la entrega de producción. El relator ya no escribe un texto para copiar y pegar:
// devuelve tomas (S1, S2…) y cada toma trae sus partes (cuadro, voz, sonido, video), cada una con su dueño
// (el agente que responde por ella) y la especificación exacta que se ejecuta con RUN.
export const MAX_SHOTS = 12;
export const SHOT_MIN = 2;
export const SHOT_MAX = 6;
export const VIDEO_ENGINES = ['wan', 'heygen'];
export const PART_KINDS = ['cuadro', 'voz', 'sonido', 'video', 'musica'];
// Qué medio genera cada parte (video aparte: lo aprueba el humano).
export const PART_MEDIA = { cuadro: 'image', voz: 'voice', sonido: 'sound', musica: 'sound', video: 'video' };
export const PART_LABEL = { cuadro: 'Cuadro (storyboard)', voz: 'Voz', sonido: 'Sonido', video: 'Video', musica: 'Música' };

const oneLine = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

// Cómo se describe la forma de la entrega a los modelos (relator y dueños de cada parte).
export const DELIVERY_SHAPE = `{
  "titulo": "Nombre de la pieza",
  "resumen": "La idea final en 2 o 3 frases.",
  "estilo": "Look y sonido comunes a toda la pieza: paleta, luz, textura, ritmo.",
  "personajes": [{ "nombre": "Lucía", "descripcion": "Aspecto físico y vestuario (en inglés), para repetirlo en cada prompt", "voz": "Aria" }],
  "tomas": [
    {
      "id": "S1",
      "titulo": "Título corto",
      "duracion": 5,
      "descripcion": "Qué pasa en la toma y para qué está en la pieza.",
      "cuadro": { "dueno": "B", "prompt": "Primer cuadro de la toma, en inglés…", "referencias": ["G2"], "base": "G2" },
      "voz": { "dueno": "A", "personaje": "Lucía", "voz": "Aria", "texto": "[whispers] Lo que dice…", "estabilidad": 0.5, "base": null },
      "sonido": { "dueno": "C", "prompt": "Efectos o ambiente de la toma, en inglés…", "tipo": "ambiente", "duracion": 5, "loop": false, "base": null },
      "video": { "dueno": "D", "prompt": "Solo el movimiento a partir del cuadro, en inglés…", "modelo": "wan" }
    }
  ],
  "musica": { "dueno": "C", "prompt": "Base musical para toda la pieza, en inglés…", "duracion": 22, "loop": true, "base": null },
  "pendientes": []
}`;

// Reglas de cada parte: las leen el relator y el agente que revisa una parte con el humano.
export const PART_RULES = {
  cuadro: `cuadro → Nano Banana 2.1. Es el PRIMER cuadro de la toma: el video arranca desde esta imagen. Prompt en inglés, concreto y autosuficiente (se ejecuta solo, sin ver los demás): sujeto y acción en su primer instante, lugar, encuadre, luz, paleta, estilo; repetí la descripción física de los personajes para que se mantengan entre tomas. "referencias": códigos de imágenes de la mesa (M1, A2, G3…) que mantienen un personaje, un producto o un look (máximo ${LIMITS.refs}).`,
  voz: `voz → ElevenLabs v4. Lo que dice un personaje o el narrador en esa toma, en el idioma de la pieza, con etiquetas de actuación en inglés entre corchetes si sirven ([whispers], [laughs], [sighs]…). Tiene que entrar en la toma: unas 2,5 palabras por segundo. Misma voz para el mismo personaje en toda la pieza. Sin voz en la toma → null.`,
  sonido: `sonido → ElevenLabs Sound Effects v2 (hasta ${LIMITS.soundMax} s): efectos o ambiente de esa toma, en inglés (fuente, acción, espacio, distancia, intensidad). "tipo": efecto | ambiente | musica. Sin sonido propio → null.`,
  video: `video → ${SHOT_MIN} a ${SHOT_MAX} s, 480p, sin sonido propio (la voz y los sonidos van encima). Anima el cuadro: el prompt en inglés describe SOLO lo que se mueve a partir de esa imagen (acción del sujeto, movimiento de cámara, clima), una sola toma continua, sin cortes ni texto en pantalla. "modelo": "wan" (Wan 3.0 Prime, por defecto) o "heygen" (HeyGen Video 1: mejor para una persona hablando a cámara).`,
  musica: `musica → ElevenLabs Sound Effects v2 en modo música, una sola para toda la pieza, hasta ${LIMITS.soundMax} s y en loop: género, tempo (BPM), instrumentos, clima, "no vocals". Si la pieza no lleva música → null.`,
};

// ---------- Validar lo que devuelve el relator ----------
const seatOf = (v) => (SEATS.includes(String(v || '').toUpperCase()) ? String(v).toUpperCase() : null);

// El dueño: el que dice el relator; si no, quien generó la pieza base; si no, quien más generó de ese tipo; si no, A.
function ownerFor(raw, base, kind, assets) {
  const named = seatOf(raw?.dueno);
  if (named) return named;
  if (base) return base.seat;
  const counts = {};
  for (const a of assets.filter((x) => x.kind === PART_MEDIA[kind])) counts[a.seat] = (counts[a.seat] || 0) + 1;
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'A';
}

// Una pieza generada en la mesa que ya ES esta parte: su especificación real manda (el relator a veces la copia mal).
function baseFor(raw, kind, assets) {
  const code = String(raw?.base || '').trim().toUpperCase();
  const asset = assets.find((a) => a.code === code && a.kind === PART_MEDIA[kind]);
  if (!asset) return null;
  if (kind === 'musica' && asset.spec?.tipo !== 'musica') return null;
  return asset;
}

export function sanitizePart(kind, raw, { aspect, assets = [], duration = 5 } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const base = kind === 'video' ? null : baseFor(raw, kind, assets);
  let spec;
  try {
    if (base) spec = { ...base.spec };
    else if (kind === 'cuadro') spec = imageSpec(raw, aspect);
    else if (kind === 'voz') spec = voiceSpec(raw);
    else if (kind === 'sonido') spec = soundSpec({ ...raw, duracion: raw.duracion ?? duration });
    else if (kind === 'musica') spec = soundSpec({ ...raw, tipo: 'musica', loop: raw.loop ?? true });
    else if (kind === 'video') {
      const prompt = oneLine(raw.prompt, LIMITS.prompt);
      if (!prompt) return null;
      spec = { prompt, modelo: VIDEO_ENGINES.includes(raw.modelo) ? raw.modelo : 'wan' };
    } else return null;
  } catch {
    return null;
  }
  if (kind === 'cuadro') spec.proporcion = aspect; // todos los cuadros, en el formato de la pieza
  return { kind, owner: ownerFor(raw, base, kind, assets), spec, base: base ? { code: base.code, url: base.url, cost: base.cost, model: base.model } : null };
}

export function sanitizeDelivery(raw, { aspect = '9:16', assets = [] } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('la entrega no es un objeto');
  const list = (Array.isArray(raw.tomas) ? raw.tomas : []).slice(0, MAX_SHOTS);
  const shots = [];
  for (const t of list) {
    if (!t || typeof t !== 'object') continue;
    const duracion = clamp(Math.round(Number(t.duracion) || 5), SHOT_MIN, SHOT_MAX);
    const descripcion = oneLine(t.descripcion, 800);
    const ctx = { aspect, assets, duration: duracion };
    // Toda toma tiene cuadro y video (si faltan, salen de la descripción): sin cuadro no hay de dónde arrancar el video.
    const cuadro = sanitizePart('cuadro', t.cuadro, ctx) || (descripcion ? sanitizePart('cuadro', { prompt: descripcion, dueno: t.cuadro?.dueno }, ctx) : null);
    if (!cuadro) continue;
    const video = sanitizePart('video', t.video, ctx) || sanitizePart('video', { prompt: descripcion || cuadro.spec.prompt, dueno: t.video?.dueno }, ctx);
    shots.push({
      id: `S${shots.length + 1}`,
      titulo: oneLine(t.titulo, 80) || `Toma ${shots.length + 1}`,
      duracion,
      descripcion,
      parts: { cuadro, voz: sanitizePart('voz', t.voz, ctx), sonido: sanitizePart('sonido', t.sonido, ctx), video },
    });
  }
  if (!shots.length) throw new Error('la entrega no trae ninguna toma válida');
  return {
    titulo: oneLine(raw.titulo, 120) || 'Pieza de la mesa',
    resumen: oneLine(raw.resumen, 1200),
    estilo: oneLine(raw.estilo, 1200),
    proporcion: ASPECTS.includes(aspect) ? aspect : '9:16',
    personajes: (Array.isArray(raw.personajes) ? raw.personajes : []).slice(0, 8)
      .map((p) => ({ nombre: oneLine(p?.nombre, 60), descripcion: oneLine(p?.descripcion, 600), voz: oneLine(p?.voz, 80) }))
      .filter((p) => p.nombre),
    shots,
    musica: sanitizePart('musica', raw.musica, { aspect, assets }),
    pendientes: (Array.isArray(raw.pendientes) ? raw.pendientes : []).map((p) => oneLine(p, 300)).filter(Boolean).slice(0, 10),
  };
}
