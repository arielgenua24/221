// Modo demo: simula a los modelos (sin API key) para probar la interfaz y el flujo.
import { autoTimeline } from './timeline.js';
const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('cancelado')); }, { once: true });
});

const out = (notes, data) => `Notas de trabajo:\n${notes.map((n) => `- ${n}`).join('\n')}\n\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\``;

const BRIEF = {
  negocio: { nombre: null, rubro: 'Indumentaria — jeans', que_ofrece: 'Jeans de tiro alto con elastano, producción local', tipo: 'producto', ubicacion_o_mercado: 'Argentina (supuesto)' },
  fotos: [{ n: 1, que_se_ve: 'Jean azul índigo sobre fondo blanco, luz dura', aprovechable_para: 'Base para escenas generadas sin alterar la prenda' }],
  publico: { quien: 'Mujeres 22-40 que compran online y temen equivocarse de talle', deseos: ['Un jean que le quede bien sin probárselo', 'Verse arreglada sin esfuerzo'], dolores: ['Talles que no coinciden', 'Cintura que se abre al sentarse'], como_habla: 'Directo, con humor, "ningún jean me queda bien de cintura"' },
  nivel_consciencia: '2 — sabe que tiene el problema del calce, no conoce la marca',
  sofisticacion_mercado: 'alta — todos prometen "calce perfecto" y "calidad"',
  momentos_de_compra: ['Cambio de estación', 'Tengo una cita', 'Volver a la oficina', 'Cambio de talle'],
  personalidad_marca: { rasgos: ['cercana', 'honesta', 'práctica'], tono: 'cómplice y con humor suave', paleta_observada: ['índigo', 'blanco', 'beige'] },
  diferenciales_posibles: ['Cintura que no se abre', 'Guía de talles por medidas reales'],
  restricciones: ['No inventar reseñas', 'No alterar la prenda'],
  supuestos: ['Venta por Instagram con envíos a todo el país'],
  preguntas_al_humano: [
    { id: 'q1', pregunta: '¿Cuál es el objetivo principal este mes?', opciones: ['Vender más', 'Conseguir seguidores', 'Que conozcan la marca'] },
    { id: 'q2', pregunta: '¿Cuánto humor se banca la marca?', opciones: ['Mucho', 'Un poco', 'Nada, tono serio'] },
  ],
  plan_investigacion: [
    { id: 'A', titulo: 'Público y sus frustraciones', objetivo: 'Mapear deseos, dolores y lenguaje', preguntas: ['¿Qué frustra al comprar jeans online?'], limites: 'Sin ideas de contenido' },
    { id: 'B', titulo: 'Ángulos del rubro', objetivo: 'Qué funciona y qué está saturado en cuentas de jeans', preguntas: ['¿Qué ángulos están trillados?'], limites: 'Sin análisis de público' },
    { id: 'C', titulo: 'Hooks y tendencias', objetivo: 'Hooks aplicables', preguntas: ['¿Qué hooks detienen el scroll en moda?'], limites: 'Sin formatos de catálogo' },
  ],
};

const RESEARCH = (id) => ({
  encargo: id,
  hallazgos: [{ insight: `Hallazgo de ejemplo del encargo ${id}: el miedo nº1 es el talle.`, por_que: 'Es la principal causa de devoluciones en ropa online.', confianza: 'media' }],
  angulos_prometedores: [{ angulo: 'Prueba en situaciones reales', ejemplo_concreto: 'Sentadilla, sentarse a comer, subir al colectivo' }],
  hooks_ejemplo: ['Si el jean se te abre en la cintura al sentarte, esto es para vos'],
  frases_del_publico: ['Ningún jean me queda bien de cintura'],
  evitar: ['"Calidad premium" sin prueba'],
});

const CONCEPTS = [
  ['C1', 'La prueba de la sentadilla', 'F7 Demostrar', 'reel_ia'],
  ['C2', 'Tipos de personas en el probador', 'F3 Humor', 'reel_ia'],
  ['C3', 'Tu talle sin probártelo', 'F1 Educar', 'carrusel'],
  ['C4', 'Del rollo de tela a tu placard', 'F9 Detrás de escena', 'carrusel'],
  ['C5', 'Un jean, tres planes', 'F6 Mostrar', 'carrusel'],
  ['C6', 'El jean que no se abre', 'F6 Mostrar', 'imagen'],
  ['C7', '¿Tiro alto o tiro medio?', 'F10 Comunidad', 'imagen'],
  ['C8', 'Volvió el índigo: 40 unidades', 'F12 Oferta', 'imagen'],
].map(([id, titulo, funcion, formato], i) => ({
  id, titulo, subtitulo: `Subtítulo de ejemplo para "${titulo}".`, funcion, angulo: 'ejemplo', formato,
  nivel_consciencia: (i % 4) + 1, emocion: 'diversión',
  hook: { visual: 'Frame 1 de ejemplo', texto: 'Texto en pantalla de ejemplo', verbal: 'Frase de ejemplo' },
  desarrollo: ['Paso 1', 'Paso 2'], por_que_funciona: 'Ejemplo.', produccion: 'A partir de la foto 1, sin alterar la prenda.',
}));

const CRITIQUE = {
  evaluaciones: CONCEPTS.map((c, i) => ({
    id: c.id,
    puntajes: { claridad: 4, hook: 3 + (i % 3), promesa: 4, compartible: 2 + (i % 4), especificidad: 3, producible: 4, riesgo: 5 },
    veredicto: 'Evaluación de ejemplo.', mejora: 'Mejora de ejemplo.',
  })),
  observacion_general: 'Modo demo.',
};

const FINAL = {
  ideas: [
    { id_origen: 'C1', titulo: 'La prueba de la sentadilla', subtitulo: 'Tres situaciones reales donde un jean común se abre en la cintura y el nuestro no: sentarse a comer, agacharse, subir al colectivo.', funcion: 'F7 Demostrar', formato: 'reel_ia', angulo: 'Demostración en situaciones reales', nivel_consciencia: 2, emocion: 'alivio', hook: { visual: 'Sentadilla profunda en primer plano', texto: 'La prueba que ningún jean aprueba', verbal: '¿Tu jean pasa esta prueba?' }, desarrollo: ['Sentadilla', 'Almuerzo', 'Colectivo', 'Cierre con la cintura intacta'], caption: 'Hicimos la prueba que más nos piden 👀', por_que: 'Nombra el dolor exacto del público y lo resuelve con prueba visual.', produccion: 'Video IA a partir de la foto 1 conservando la prenda.' },
    { id_origen: 'C2', titulo: 'Tipos de personas en el probador', subtitulo: 'Humor de situaciones que todo el mundo vivió probándose jeans, con un cierre donde nuestra guía de talles evita el drama.', funcion: 'F3 Humor', formato: 'reel_ia', angulo: 'POV situacional', nivel_consciencia: 1, emocion: 'diversión', hook: { visual: 'Cortina de probador que se abre', texto: 'POV: el probador a las 19 h', verbal: 'Todas fuimos la número 3' }, desarrollo: ['Tipo 1', 'Tipo 2', 'Tipo 3', 'Cierre'], caption: '¿Cuál sos? 😂', por_que: 'Identificación + moneda social: se envía a amigas.', produccion: 'Escenas IA; la prenda se toma de las fotos reales.' },
    { id_origen: 'C3', titulo: 'Tu talle sin probártelo', subtitulo: 'Carrusel práctico: cómo medir cintura y cadera en casa y traducirlo a nuestro talle, para guardar antes de comprar.', funcion: 'F1 Educar', formato: 'carrusel', angulo: 'Guía práctica', nivel_consciencia: 3, emocion: 'alivio', hook: { visual: 'Cinta métrica sobre el jean', texto: 'Nunca más un talle equivocado', verbal: '' }, desarrollo: ['Portada', 'Medir cintura', 'Medir cadera', 'Tabla', 'CTA'], caption: 'Guardalo para tu próxima compra 📏', por_que: 'Valor práctico: genera guardados y envíos.', produccion: 'Diseño con la foto real del jean + tipografía.' },
    { id_origen: 'C7', titulo: '¿Tiro alto o tiro medio?', subtitulo: 'Una imagen dividida que invita a votar en comentarios y nos dice qué producir en la próxima tanda.', funcion: 'F10 Comunidad', formato: 'imagen', angulo: 'Elección A/B', nivel_consciencia: 4, emocion: 'curiosidad', hook: { visual: 'Imagen partida al medio', texto: '¿Equipo A o equipo B?', verbal: '' }, desarrollo: ['Imagen única'], caption: 'Votá en comentarios 👇', por_que: 'Participación + información para el negocio.', produccion: 'Composición con dos fotos reales.' },
  ],
  nota_para_el_humano: 'Esto es el MODO DEMO: las respuestas son de ejemplo. Configurá OPENROUTER_API_KEY para usar los modelos reales.',
};

const SCRIPTS = {
  brief: () => out(['Veo un jean índigo de tiro alto, foto de estudio con luz dura.', 'El rubro está saturado de "calce perfecto": hay que diferenciarse con prueba, no con promesa.', 'Supongo venta por Instagram; lo marco como supuesto.', 'Reparto la investigación en público, rubro y hooks.'], BRIEF),
  research: (id) => out([`Encargo ${id}: me concentro solo en lo que me pidieron.`, 'El dolor más repetido es el talle y la cintura que se abre.', 'Las cuentas del rubro abusan del flat lay sin contexto.'], RESEARCH(id)),
  ideation: () => out(['Recorro la matriz buscando combinaciones que no se repitan.', 'Dos ideas de marca (humor, detrás de escena) y varias de activación.', 'Cada idea se apoya en un detalle concreto de las fotos.'], { conceptos: CONCEPTS }),
  critique: () => out(['C2 tiene el hook más fuerte, pero riesgo de estereotipos: cuidar el tono.', 'C6 es genérico: cualquier marca podría publicarlo.', 'C8 sirve solo si la escasez es real.'], CRITIQUE),
  final: () => out(['Elijo C1, C2, C3 y C7 por puntaje y diversidad.', 'Aplico la mejora de la crítica a C2 para evitar estereotipos.', 'Descarto C6 por genérico.'], FINAL),
  ear: (_, meta) => out(['(demo) No escucho de verdad: armo el mapa con el análisis automático.', `Tempo ~${meta.analysis.bpm} BPM.`, 'Secciones cortadas donde más cambia la energía.'], mockMap(meta.analysis)),
  plan: (_, meta) => out(['(demo) No miro de verdad las imágenes: catalogo el material por orden.', 'Historia simple: arrancar fuerte, crecer y cerrar con calma.', 'Le pido al Oído que encuentre el momento más intenso.'], {
    intencion: '(demo) Un video con ritmo a partir del material',
    historia: 'Abrir con la mejor toma, crecer con la música y cerrar con una toma larga.',
    material: meta.media.map((m, i) => ({ id: m.id, que_se_ve: '(demo)', calidad: 'media', mejores_momentos: m.kind === 'video' ? [{ t: Math.min(1, m.duration / 3), que_pasa: '(demo)' }] : [], rol: i === 0 ? 'apertura' : 'desarrollo' })),
    versiones: [
      { id: 'A', nombre: 'Al golpe', enfoque: '(demo) Pegada al ritmo', ritmo: 'Cada 2 beats en lo intenso', apertura: 'La toma más fuerte' },
      { id: 'B', nombre: 'Tomas largas', enfoque: '(demo) Respira: el doble de largo por toma', ritmo: 'Cada 2 compases', apertura: 'Un plano general' },
      { id: 'C', nombre: 'Ráfagas', enfoque: '(demo) Cortes en cada beat, orden rotado', ritmo: 'Cada beat', apertura: 'Un detalle' },
    ],
    encargo_para_el_oido: { foco: 'Dónde sube la energía para el clímax', preguntas: ['¿Dónde está el momento más intenso?'] },
  }),
  direction: (_, meta) => out(['(demo) No miro de verdad los cuadros.', 'Sistema editorial: Space Grotesk + mono, un solo acento.', 'Ventanas lejos de las zonas de botones.'], mockDirection(meta)),
  revise: (id, meta) => SCRIPTS.motion(id, meta),
  motion: (id, meta) => codeOut([`(demo) ${id}: título que se revela desde una máscara.`, 'Entrada outExpo, salida inQuart, todo termina antes del final.'], mockMotion(meta)),
  montage: (id, meta) => out([`(demo) Versión ${id}: roto el material sobre la grilla con otro ritmo y otro orden.`, 'Las fotos siempre con zoom para que no queden quietas.'], { concepto: `Versión ${id} de demostración: ${meta.version?.nombre || ''}`, ...autoTimeline({ ...meta, ...{ A: { pace: 1, shift: 0 }, B: { pace: 2, shift: 1 }, C: { pace: 0.5, shift: 2 } }[id] }), nota_para_el_humano: 'MODO DEMO: el montaje es automático. Configurá OPENROUTER_API_KEY para que el Oído escuche el tema y el Director mire tu material.' }),
};

// ---------- Intuition (motion design) ----------
const MOCK_PALETTE = [{ hex: '#F4F1EA', rol: 'texto principal' }, { hex: '#FF5A1F', rol: 'acento: una sola cosa por clip' }, { hex: '#111111', rol: 'velo / sombras' }];

function mockDirection({ clips, text }) {
  const roles = clips.length === 1 ? ['remata'] : clips.length === 2 ? ['presenta', 'remata'] : ['presenta', 'desarrolla', 'remata'];
  return {
    lectura: '(demo) No miro de verdad los cuadros: armo un sistema editorial neutro que funciona sobre casi cualquier video.',
    concepto: text ? `(demo) ${text.slice(0, 120)}` : '(demo) Títulos editoriales que se revelan desde una línea',
    arco: 'Presentar con calma, acelerar en el medio y rematar con el texto más grande.',
    sistema: {
      paleta: MOCK_PALETTE,
      tipografias: { display: 'Space Grotesk', texto: 'JetBrains Mono', tratamiento: 'Titulares en 700 con tracking apretado; índices en mono 400, mayúsculas chicas.' },
      movimiento: 'Todo entra revelándose desde una máscara (0,8 s, outExpo) y sale hacia arriba (0,45 s, inQuart). En el sostén, deriva mínima.',
      easing: 'ease.outExpo para entrar, ease.inQuart para salir; nada rebota.',
      motivo: 'Una línea fina del color de acento que se dibuja arriba a la izquierda, con el índice 01 / 02 / 03.',
      composicion: 'Alineado a la izquierda, márgenes de 6u.',
      textura: 'Ninguna.',
      reglas: ['Máximo 8 palabras por clip', 'El acento solo en la línea del motivo'],
      evitar: ['Glow', 'Rebotes', 'Tapar caras'],
    },
    clips: clips.map((c, i) => ({
      id: c.id,
      idea: c.prompt ? `(demo) ${c.prompt.slice(0, 80)}` : '(demo) Un título que se revela línea por línea',
      rol: roles[i] || 'desarrolla',
      textos: [demoText(c)],
      sincronia: [{ t: 0.4, evento: '(demo) entra el título' }],
      ventana: { x: 0.07, y: i % 2 ? 0.16 : 0.5, w: 0.86, h: 0.3 },
      por_que_ahi: '(demo) Lejos de la zona de botones y de la descripción.',
    })),
    nota_para_el_humano: 'MODO DEMO: el sistema visual es fijo. Configurá OPENROUTER_API_KEY para que Opus mire tu video.',
  };
}

// Texto corto para el título de demostración: lo que pidió el humano, o uno de ejemplo.
const demoText = (clip) => (clip.prompt || 'Hecho con intuición').replace(/\s+/g, ' ').split(' ').slice(0, 7).join(' ');

// Un motion de verdad (escrito a mano), para que el modo demo muestre el reproductor funcionando.
export function mockMotionCode({ text, index = 0, total = 1, accentLine = true }) {
  return `const TEXT = ${JSON.stringify(text)};
const INDEX = ${JSON.stringify(`${String(index + 1).padStart(2, '0')} / ${String(total).padStart(2, '0')}`)};

function setup(env, ctx) {
  const { w, h, u, fonts } = env;
  const m = 6 * u;
  const maxW = w - 2 * m;
  // El título más grande que entre en la ventana, en hasta 3 líneas.
  let size = Math.min(16 * u, h * 0.42);
  let lines = [];
  for (; size > 3.5 * u; size *= 0.92) {
    ctx.font = font(700, size, fonts.display);
    lines = wrap(ctx, TEXT, maxW);
    const fitsW = lines.every((l) => ctx.measureText(l).width <= maxW);
    if (fitsW && lines.length <= 3 && lines.length * size * 1.02 <= h - 2 * m - 6 * u) break;
  }
  return { m, size, lines, lh: size * 1.02 };
}

function draw(ctx, t, env) {
  const { w, h, u, dur, fonts, palette, state } = env;
  const ink = palette[0]?.hex || '#F4F1EA';
  const accent = palette[1]?.hex || '#FF5A1F';
  const { m, size, lines, lh } = state;

  // Línea de tiempo del clip (segundos)
  const T_LINE = 0.1, T_TITLE = 0.35, OUT_START = dur - 0.6, OUT_END = dur - 0.12;
  const out = ease.inQuart(seg(t, OUT_START, OUT_END));

  // Velo suave detrás del título para asegurar la lectura (se desvanece antes de los bordes: no se ve como caja)
  const k = 0.32 * ease.outCubic(seg(t, 0, 0.7)) * (1 - out);
  const veil = ctx.createLinearGradient(0, h * 0.25, 0, h);
  veil.addColorStop(0, rgba('#111111', 0));
  veil.addColorStop(0.7, rgba('#111111', k));
  veil.addColorStop(1, rgba('#111111', 0));
  ctx.fillStyle = veil;
  ctx.fillRect(0, 0, w, h);

  // Motivo: línea que se dibuja + índice
  const pLine = ease.outExpo(seg(t, T_LINE, T_LINE + 1));
  ctx.strokeStyle = ${accentLine ? 'accent' : 'ink'};
  ctx.lineWidth = Math.max(1, 0.45 * u);
  ctx.beginPath();
  ctx.moveTo(m, m);
  ctx.lineTo(m + (w - 2 * m) * 0.38 * pLine * (1 - out), m);
  ctx.stroke();
  ctx.font = font(400, 3.4 * u, fonts.text);
  ctx.textBaseline = 'top';
  ctx.fillStyle = rgba(ink, ease.outCubic(seg(t, T_LINE + 0.25, T_LINE + 0.7)) * (1 - out));
  ctx.fillText(INDEX, m, m + 2.2 * u);

  // Título: cada línea sube desde su máscara, en cascada; al salir, se va hacia arriba.
  ctx.font = font(700, size, fonts.display);
  ctx.fillStyle = ink;
  const top = h - m - lines.length * lh;
  lines.forEach((line, i) => {
    const pIn = ease.outExpo(stagger(t, i, lines.length, { start: T_TITLE, each: 0.9, total: 1.15 }));
    const pOut = ease.inQuart(stagger(t, lines.length - 1 - i, lines.length, { start: OUT_START, each: 0.4, total: OUT_END - OUT_START }));
    const drift = 0.6 * u * seg(t, T_TITLE + 0.9, OUT_START); // el sostén nunca queda congelado
    const y = top + i * lh;
    ctx.save();
    ctx.beginPath();
    ctx.rect(m - u, y - 0.08 * lh, w - 2 * m + 2 * u, lh * 1.12);
    ctx.clip();
    ctx.fillText(line, m, y + (1 - pIn) * lh * 1.1 - pOut * lh * 1.1 - drift);
    ctx.restore();
  });
}
`;
}

function mockMotion({ clip, direction, index, total, revision, feedback }) {
  const plan = direction.clips.find((c) => c.id === clip.id) || {};
  return {
    idea: plan.idea || '(demo) Título revelado',
    linea_de_tiempo: [{ t: 0.1, que_pasa: 'Se dibuja la línea del motivo' }, { t: 0.35, que_pasa: 'Sube el título línea por línea' }, { t: clip.end - clip.start - 0.6, que_pasa: 'Sale hacia arriba' }],
    nota_para_el_humano: revision ? `(demo) Apliqué: "${feedback || 'arreglo'}" (en demo solo cambia el color de la línea).` : 'MODO DEMO: es un motion de ejemplo. Mové y redimensioná la ventana para ver cómo se adapta.',
    code: mockMotionCode({ text: demoText(clip), index, total, accentLine: !revision }),
  };
}

const codeOut = (notes, { code, ...meta }) => `${out(notes, meta)}\n\n\`\`\`js\n${code}\`\`\``;

function mockMap(a) {
  const cuts = [0, ...a.energyChanges.map((c) => c.t), a.duration];
  const energyAt = (t0, t1) => {
    const xs = a.energy.filter((x) => x.t >= t0 && x.t < t1).map((x) => x.e);
    return xs.length ? xs.reduce((p, c) => p + c, 0) / xs.length : 0.5;
  };
  const secciones = cuts.slice(0, -1).map((t, i) => {
    const e = energyAt(t, cuts[i + 1]);
    const nivel = Math.max(1, Math.min(5, Math.round(e * 5)));
    return { id: `S${i + 1}`, nombre: i === 0 ? 'intro' : nivel >= 4 ? 'estribillo' : 'estrofa', inicio: t, fin: cuts[i + 1], energia: nivel, que_pasa: '(demo) sección detectada por energía', ritmo_de_corte: nivel >= 4 ? 'cada 2 beats' : 'cada compás', movimiento: nivel >= 4 ? 'pulso' : 'zoom lento' };
  });
  return {
    resumen: { estilo: '(demo)', animo: '(demo)', instrumentos: [], tiene_voz: false, calidad_grabacion: '(demo)', comentario: 'Mapa simulado a partir del análisis automático.' },
    grilla: { bpm: a.bpm, confiable: a.beatConfidence >= 0.25, nota: '(demo)' },
    secciones,
    momentos_clave: a.energyChanges.filter((c) => c.delta > 0).map((c) => ({ t: c.t, tipo: 'subida', intensidad: 4, que_pasa: 'Sube la energía', sugerencia_visual: 'Toma más fuerte + flash' })),
    puntos_de_corte_libres: [],
    respuestas_al_director: [{ pregunta: '¿Dónde está el momento más intenso?', respuesta: `(demo) Donde más sube la energía${a.energyChanges[0] ? `, cerca de ${a.energyChanges[0].t} s` : ''}.` }],
    arco: 'Arrancar con una imagen fuerte, subir el ritmo en la parte más intensa y cerrar con una toma larga.',
    preguntas_al_humano: [{ id: 'q1', pregunta: '¿Qué querés que transmita el video?', opciones: ['Energía', 'Nostalgia', 'Mostrar un lugar', 'Contar un día'] }],
  };
}

export async function mockLLM({ step, onDelta, onReasoning, signal, meta }) {
  const [kind, id] = step.split('-');
  const text = (SCRIPTS[kind] || SCRIPTS.final)(id, meta);
  onReasoning?.('(demo) pensando…');
  const chunk = ['plan', 'ear', 'montage', 'direction', 'motion', 'revise'].includes(kind) ? 90 : 18; // los JSON de edición son largos
  for (let i = 0; i < text.length; i += chunk) {
    await sleep(step === 'brief' ? 18 : 10, signal);
    onDelta?.(text.slice(i, i + chunk));
  }
  return { text, usage: { cost: 0, total_tokens: Math.round(text.length / 4) } };
}
