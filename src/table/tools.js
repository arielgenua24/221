import { fileVisibleTo } from '../../public/table-core.js';
import { ASPECTS, SOUND_KINDS, LIMITS, VOICES, DEFAULT_VOICE, SPECS, estimate, mediaCosts } from './media.js';

// Mesa de agentes · las herramientas de un turno. Los cuatro agentes tienen las mismas tres;
// lo que generan queda sobre la mesa con un código G (G1, G2…) y entra en el registro.
// El presupuesto es de la mesa (lo fija el humano): se descuenta lo estimado de cada pieza generada en las rondas.
export const TOOL_KIND = { generar_imagen: 'image', generar_voz: 'voice', generar_sonido: 'sound' };
const money = (v) => `US$ ${v.toFixed(v < 0.1 ? 3 : 2)}`;

export function toolDefs({ aspect, costs = mediaCosts() }) {
  const voices = VOICES.map((v) => `${v.id} (${v.label})`).join('; ');
  return [
    {
      type: 'function',
      function: {
        name: 'generar_imagen',
        description: `Genera UNA imagen con Nano Banana 2.1: un cuadro de storyboard, un personaje, un objeto, un lugar o una prueba de look. Queda sobre la mesa con un código G y los cuatro la VEN en sus próximos turnos: usala para que la discusión sea sobre algo concreto. Un cuadro de storyboard es el PRIMER cuadro de una toma de video (hasta 6 s): el video arranca exactamente desde esa imagen, así que tiene que mostrar el momento inicial de la acción. Podés partir de imágenes que ya están en la mesa (M1, A2, G3…) para mantener un personaje, un producto o un estilo. Cuesta ≈ ${money(costs.image)}.`,
        parameters: {
          type: 'object',
          properties: {
            prompt: { type: 'string', description: 'En inglés y concreto: sujeto y acción (congelada en su primer instante), lugar, encuadre (plano, ángulo, lente), luz, paleta y estilo/textura. Repetí la descripción física de cada personaje para que se mantenga entre imágenes. Sin texto escrito en la imagen salvo que sea esencial. Ej.: "Medium close-up of an elderly baker dusting flour off her hands, warm tungsten light from a side window, shallow depth of field, 35mm film grain, muted ochre palette".' },
            referencias: { type: 'array', items: { type: 'string' }, maxItems: LIMITS.refs, description: 'Códigos de imágenes que ya están en la mesa para mantener identidad o estilo (ej. ["M1", "G2"]). Opcional.' },
            proporcion: { type: 'string', enum: ASPECTS, description: `Por defecto, la de la pieza (${aspect}). Cambiala solo si la imagen no es un cuadro de la pieza.` },
          },
          required: ['prompt'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'generar_voz',
        description: `Genera la voz de un personaje o del narrador con ElevenLabs v4: una línea o un fragmento corto del guion, para probar cómo suena antes de cerrarlo. Queda sobre la mesa con un código G. Nadie en la mesa puede escucharla: los demás van a leer el texto y la voz elegida. Cuesta ≈ ${money(costs.voicePer1k)} cada 1000 caracteres.`,
        parameters: {
          type: 'object',
          properties: {
            personaje: { type: 'string', description: 'Quién habla: el nombre del personaje o "Narrador".' },
            texto: { type: 'string', description: 'Exactamente lo que dice, en el idioma de la pieza. Dirigí la actuación con etiquetas en inglés entre corchetes antes de la frase: [whispers], [laughs], [sighs], [excited], [sad], [angry], [curious], [sarcastic]. Pausas con "…" o "—". Una toma de 6 s admite unas 12 a 15 palabras.' },
            voz: { type: 'string', description: `Una voz sugerida o un voice_id de ElevenLabs. Sugeridas: ${voices}. Mantené la misma voz para el mismo personaje en toda la pieza. Por defecto ${DEFAULT_VOICE}.` },
            estabilidad: { type: 'number', minimum: 0, maximum: 1, description: 'Baja (0.3) = más expresiva y variable; alta (0.8) = más pareja. Por defecto 0.5.' },
          },
          required: ['personaje', 'texto', 'voz'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'generar_sonido',
        description: `Genera un efecto de sonido, un ambiente o una base musical corta con ElevenLabs Sound Effects v2 (hasta ${LIMITS.soundMax} s). Queda sobre la mesa con un código G. Nadie en la mesa puede escucharlo: los demás leen tu descripción. Cuesta ≈ ${money(costs.sound)}.`,
        parameters: {
          type: 'object',
          properties: {
            prompt: { type: 'string', description: 'En inglés: la fuente y la acción, el espacio (cuarto chico, calle, bosque), la distancia y la intensidad. Para música: género, tempo (BPM), instrumentos, clima y "no vocals". Ej.: "Heavy wooden door creaks open slowly in a stone hallway, distant echo".' },
            tipo: { type: 'string', enum: SOUND_KINDS, description: 'efecto (un evento), ambiente (fondo continuo) o musica.' },
            duracion: { type: 'number', minimum: LIMITS.soundMin, maximum: LIMITS.soundMax, description: 'Segundos. Para una toma, su duración.' },
            loop: { type: 'boolean', description: 'true para ambientes o música que tienen que poder repetirse sin corte.' },
          },
          required: ['prompt', 'tipo', 'duracion'],
        },
      },
    },
  ];
}

// Ejecuta las herramientas de UN turno. `req` es el pedido validado (agentes, assets, presupuesto, formato).
// `resolve(code)` → la imagen de la mesa con ese código. `emit` avisa al navegador en vivo.
export function createTurnTools({ media, req, resolve, emit, signal, costs = mediaCosts() }) {
  const spentBefore = req.assets.reduce((s, a) => s + (Number(a.cost) || 0), 0);
  let next = Math.max(0, ...req.assets.map((a) => Number(a.code.slice(1)) || 0));
  const created = [];
  const state = { generated: 0, cost: 0 };
  const remaining = () => Math.max(0, req.budget - spentBefore - state.cost);
  const known = new Set([...req.files.filter((f) => f.kind === 'image' && fileVisibleTo(f, req.seat)).map((f) => f.code), ...req.assets.filter((a) => a.kind === 'image').map((a) => a.code)]);

  async function run(call) {
    const name = call.function?.name;
    const kind = TOOL_KIND[name];
    if (!kind) return { text: `Error: la herramienta ${name} no existe.` };
    let args;
    try { args = JSON.parse(call.function.arguments || '{}'); } catch { return { text: 'Error: los argumentos no son JSON válido.' }; }
    let spec;
    try { spec = SPECS[kind](args, req.aspect); } catch (err) { return { text: `Error: ${err.message}.` }; }
    if (kind === 'image') {
      // Solo referencias que existen y que este agente puede ver (las privadas de otros no le llegan).
      const unknown = spec.referencias.filter((c) => !known.has(c));
      if (unknown.length) return { text: `Error: no hay imágenes ${unknown.join(', ')} en la mesa. Usá códigos que veas en la conversación.` };
    }
    if (state.generated >= LIMITS.perTurn) return { text: `Error: ya generaste ${LIMITS.perTurn} piezas en este turno (el máximo). Terminá tu aporte con lo que hay.` };
    const cost = estimate(kind, spec, costs);
    if (cost > remaining() + 1e-9) return { text: `Error: no alcanza el presupuesto de la mesa (quedan ${money(remaining())}, esto cuesta ≈ ${money(cost)}). Describilo en texto.` };
    emit({ type: 'tool', kind, name, spec });
    let out;
    try {
      out = await media.generate(kind, spec, { resolve, signal });
    } catch (err) {
      if (signal?.aborted) throw err;
      emit({ type: 'tool_error', kind, error: err.message });
      return { text: `Error al generar: ${String(err.message).slice(0, 300)}` };
    }
    // Solo cuenta (y se cobra del presupuesto) lo que llegó.
    state.generated += 1;
    state.cost += out.cost;
    const asset = { code: `G${++next}`, kind, seat: req.seat, round: req.round, spec, url: out.url, model: out.model, cost: out.cost, ms: out.ms, ...(out.demo ? { demo: true } : {}) };
    created.push(asset);
    if (kind === 'image') known.add(asset.code);
    emit({ type: 'asset', asset });
    const what = { image: 'la imagen', voice: 'la voz', sound: 'el sonido' }[kind];
    return {
      text: `Listo: ${asset.code} (${what}) ya está sobre la mesa. ${kind === 'image' ? 'Te la muestro a continuación.' : 'Nadie la puede escuchar: la mesa conoce su texto y sus parámetros.'} Quedan ${money(remaining())} de presupuesto.`,
      ...(kind === 'image' ? { image: { code: asset.code, url: out.url } } : {}),
    };
  }

  return { run, created, state, remaining };
}
