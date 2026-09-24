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
  editor: (_, meta) => out(['(demo) Roto el material sobre la grilla: una toma por compás en lo tranquilo, cada 2 beats en lo intenso.', 'Las fotos siempre con zoom para que no queden quietas.'], { concepto: 'Montaje de demostración sobre la grilla del tema', ...autoTimeline(meta), nota_para_el_humano: 'MODO DEMO: el montaje es automático. Configurá OPENROUTER_API_KEY para que el Oído escuche el tema y el Editor mire tu material.' }),
};

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
    arco: 'Arrancar con una imagen fuerte, subir el ritmo en la parte más intensa y cerrar con una toma larga.',
    preguntas_al_humano: [{ id: 'q1', pregunta: '¿Qué querés que transmita el video?', opciones: ['Energía', 'Nostalgia', 'Mostrar un lugar', 'Contar un día'] }],
  };
}

export async function mockLLM({ step, onDelta, onReasoning, signal, meta }) {
  const [kind, id] = step.split('-');
  const text = (SCRIPTS[kind] || SCRIPTS.final)(id, meta);
  onReasoning?.('(demo) pensando…');
  const chunk = kind === 'editor' || kind === 'ear' ? 90 : 18; // los JSON de edición son largos
  for (let i = 0; i < text.length; i += chunk) {
    await sleep(step === 'brief' ? 18 : 10, signal);
    onDelta?.(text.slice(i, i + chunk));
  }
  return { text, usage: { cost: 0, total_tokens: Math.round(text.length / 4) } };
}
