// JEV construye · planificador de demo (sin OpenRouter). Recetas fijas de árbol y persona, una pieza por turno,
// con la misma forma de respuesta que el LLM: así se prueba el motor, las vistas previas y el bucle con JEV.

const where = (prompt, fallback) => (/izquierda/i.test(prompt) ? [-2.5, 0, 0] : /derecha/i.test(prompt) ? [2.5, 0, 0] : fallback);

const TREE = (prompt, at) => [
  {
    part: { id: 'tronco', label: 'el tronco' },
    base: { color: '#7a4a28', objectPosition: at },
    questions: [
      { key: 'forma', question: '¿Cómo harías el tronco de un árbol con primitivas?', options: [
        { label: 'un cilindro alto', patch: { primitive: 'cylinder', size: [0.4, 2.4, 0.4], position: [0, 1.2, 0] } },
        { label: 'un cono muy angosto', patch: { primitive: 'cone', size: [0.5, 2.6, 0.5], position: [0, 1.3, 0] } },
        { label: 'una caja alta', patch: { primitive: 'box', size: [0.4, 2.4, 0.4], position: [0, 1.2, 0] } },
      ] },
      { key: 'grosor', question: 'Ya elegiste la forma del tronco. ¿Qué tan grueso lo harías?', options: [
        { label: 'fino', patch: { size: [0.25, 2.4, 0.25] } },
        { label: 'grueso', patch: { size: [0.55, 2.4, 0.55] } },
      ] },
    ],
  },
  {
    part: { id: 'ramas', label: 'las ramas' },
    base: { primitive: 'cylinder', color: '#6b3f22', position: [0, 2.1, 0] },
    questions: [
      { key: 'disposicion', question: 'Ya hay un tronco de 2,4 m. ¿Cómo pondrías las ramas?', options: [
        { label: 'cuatro ramas en círculo, inclinadas hacia arriba', patch: { size: [0.12, 1.1, 0.12], rotation: [0, 0, -45], repeat: { pattern: 'ring', count: 4, spread: [0.35, 0, 0.35], jitter: 0.1 } } },
        { label: 'tres ramas en círculo, casi horizontales', patch: { size: [0.12, 1.2, 0.12], rotation: [0, 0, -75], repeat: { pattern: 'ring', count: 3, spread: [0.45, 0, 0.45], jitter: 0.1 } } },
      ] },
    ],
  },
  {
    part: { id: 'hojas', label: 'las hojas' },
    base: { color: '#3f8a3a' },
    questions: [
      { key: 'forma', question: 'Ya hay un tronco con ramas. ¿Cómo armarías la copa de hojas?', options: [
        { label: 'muchas esferas en un racimo', patch: { primitive: 'sphere', size: [0.8, 0.8, 0.8], position: [0, 3, 0], repeat: { pattern: 'cluster', count: 14, spread: [1, 0.6, 1], jitter: 0.3 } } },
        { label: 'una esfera grande', patch: { primitive: 'sphere', size: [2.2, 2, 2.2], position: [0, 3.1, 0] } },
        { label: 'un cono verde (pino)', patch: { primitive: 'cone', size: [1.8, 2.6, 1.8], position: [0, 3.3, 0] } },
      ] },
      { key: 'tono', question: '¿De qué verde las harías?', options: [
        { label: 'verde oscuro', patch: { color: '#24572c' } },
        { label: 'verde claro', patch: { color: '#62b14f' } },
      ] },
    ],
  },
  ...(/flor|rosa/i.test(prompt) ? [{
    part: { id: 'flores', label: 'las flores' },
    base: { primitive: 'sphere', position: [0, 3.1, 0] },
    questions: [
      { key: 'flores', question: 'Ya hay una copa de hojas. ¿Cómo pondrías las flores rosas?', options: [
        { label: 'muchas esferitas rosas sobre la copa', patch: { size: [0.18, 0.18, 0.18], color: '#f08cb4', repeat: { pattern: 'cluster', count: 24, spread: [1.2, 0.8, 1.2], jitter: 0.2 } } },
        { label: 'pocas flores grandes', patch: { size: [0.35, 0.35, 0.35], color: '#e0609a', repeat: { pattern: 'cluster', count: 8, spread: [1.1, 0.7, 1.1], jitter: 0.2 } } },
      ] },
    ],
  }] : []),
];

const PERSON = (prompt, at) => [
  {
    part: { id: 'piernas', label: 'las piernas' },
    base: { primitive: 'cylinder', color: '#2d3a5c', objectPosition: at },
    questions: [
      { key: 'piernas', question: '¿Cómo harías las piernas de una persona parada?', options: [
        { label: 'dos cilindros paralelos', patch: { size: [0.18, 0.9, 0.18], position: [-0.13, 0.45, 0], repeat: { pattern: 'line', count: 2, spread: [0.26, 0, 0], jitter: 0 } } },
        { label: 'un solo cilindro ancho', patch: { size: [0.4, 0.9, 0.25], position: [0, 0.45, 0] } },
      ] },
    ],
  },
  {
    part: { id: 'torso', label: 'el torso' },
    base: { color: '#c0533a' },
    questions: [
      { key: 'forma', question: 'Ya hay dos piernas de 0,9 m. ¿Qué primitiva usarías para el torso?', options: [
        { label: 'una caja', patch: { primitive: 'box', size: [0.5, 0.65, 0.25], position: [0, 1.23, 0] } },
        { label: 'una cápsula', patch: { primitive: 'capsule', size: [0.48, 0.7, 0.28], position: [0, 1.25, 0] } },
        { label: 'una esfera', patch: { primitive: 'sphere', size: [0.6, 0.6, 0.6], position: [0, 1.2, 0] } },
      ] },
    ],
  },
  {
    part: { id: 'cuello', label: 'el cuello' },
    base: { primitive: 'cylinder', color: '#e0b48f', position: [0, 1.62, 0] },
    questions: [
      { key: 'cuello', question: 'Arriba del torso va el cuello. ¿Cómo lo harías?', options: [
        { label: 'un cilindro corto y fino', patch: { size: [0.12, 0.12, 0.12] } },
        { label: 'un cilindro corto y ancho', patch: { size: [0.22, 0.12, 0.22] } },
      ] },
    ],
  },
  {
    part: { id: 'cabeza', label: 'la cabeza' },
    base: { color: '#e0b48f' },
    questions: [
      { key: 'cabeza', question: 'Ya hay cuello. ¿Qué forma tendría la cabeza?', options: [
        { label: 'una esfera', patch: { primitive: 'sphere', size: [0.3, 0.3, 0.3], position: [0, 1.83, 0] } },
        { label: 'un elipsoide un poco alargado', patch: { primitive: 'ellipsoid', size: [0.27, 0.34, 0.29], position: [0, 1.85, 0] } },
        { label: 'una caja', patch: { primitive: 'box', size: [0.28, 0.3, 0.28], position: [0, 1.83, 0] } },
      ] },
    ],
  },
  {
    part: { id: 'brazos', label: 'los brazos' },
    base: { primitive: 'cylinder', color: '#c0533a' },
    questions: [
      { key: 'pose', question: 'Ya están torso, cuello y cabeza. ¿Cómo pondrías los brazos?', options: [
        { label: 'caídos a los costados', patch: { size: [0.12, 0.65, 0.12], position: [-0.33, 1.2, 0], repeat: { pattern: 'line', count: 2, spread: [0.66, 0, 0], jitter: 0 } } },
        { label: 'abiertos en cruz', patch: { size: [0.12, 0.6, 0.12], rotation: [0, 0, 90], position: [-0.55, 1.45, 0], repeat: { pattern: 'line', count: 2, spread: [1.1, 0, 0], jitter: 0 } } },
      ] },
    ],
  },
];

export async function mockPlan({ prompt, scene }) {
  const wantsTree = /árbol|arbol|pino|tree/i.test(prompt);
  const wantsPerson = /persona|hombre|mujer|chico|chica|person/i.test(prompt) || !wantsTree;
  const plans = [];
  if (wantsTree) plans.push({ object: { id: 'arbol', label: 'un árbol' }, steps: TREE(prompt, wantsPerson ? [-2.5, 0, 0] : where(prompt, [0, 0, 0])) });
  if (wantsPerson) plans.push({ object: { id: 'persona', label: 'una persona' }, steps: PERSON(prompt, wantsTree ? [1.5, 0, 0.5] : where(prompt, [0, 0, 0])) });
  const have = new Set((scene?.parts || []).map((p) => `${p.object}/${p.id}`));
  for (const { object, steps } of plans) {
    const next = steps.find((s) => !have.has(`${object.id}/${s.part.id}`));
    if (next) return { thought: `Demo: falta ${next.part.label} de ${object.label}.`, object, ...next };
  }
  return { done: true, thought: 'Demo: la receta está completa.', summary: plans.map((p) => p.object.label).join(' y ') };
}

// Fase 2 · time reducing: las mismas recetas, pero en dos tiempos (ideas en palabras, después el plano entero).
const CONCEPTS = {
  arbol: ['tronco cilíndrico, ramas y racimo de esferas verdes', 'tronco y una sola esfera grande de copa', 'tronco fino y un cono verde, como un pino'],
  persona: ['piernas, torso de caja, cuello, cabeza esférica y brazos', 'cuerpo de cápsula con cabeza y brazos abiertos'],
};

export async function mockIdeas({ prompt, scene }) {
  const wantsTree = /árbol|arbol|pino|tree/i.test(prompt);
  const wantsPerson = /persona|hombre|mujer|chico|chica|person/i.test(prompt) || !wantsTree;
  const have = new Set(Object.keys(scene?.objects || {}));
  const objects = [];
  if (wantsTree && !have.has('arbol')) objects.push({ id: 'arbol', label: 'un árbol', position: wantsPerson ? [-2.5, 0, 0] : where(prompt, [0, 0, 0]), concepts: CONCEPTS.arbol });
  if (wantsPerson && !have.has('persona')) objects.push({ id: 'persona', label: 'una persona', position: wantsTree ? [1.5, 0, 0.5] : where(prompt, [0, 0, 0]), concepts: CONCEPTS.persona });
  return objects.length ? { objects } : { done: true, summary: 'Demo: todo lo pedido ya está en la escena.' };
}

// Plano entero: los pasos de la receta como piezas, con como mucho 2 preguntas de 3 opciones.
export async function mockBlueprint({ prompt, object }) {
  const steps = object.id === 'arbol' ? TREE(prompt, object.position) : PERSON(prompt, object.position);
  return {
    pieces: steps.map(({ part, base, questions }) => {
      const { objectPosition, ...rest } = base;
      // Las piezas de una sola pregunta obvia van fijas (la primera opción), como pide el modo rápido.
      const keep = questions.length > 1 || questions[0].options.length > 2 ? questions.slice(0, 2).map((q) => ({ ...q, options: q.options.slice(0, 3) })) : [];
      const fixed = keep.length ? {} : questions[0].options[0].patch;
      return { part, base: { ...rest, ...fixed }, questions: keep };
    }),
  };
}

// Fase 3 · idioma por relaciones: las mismas dos recetas, sin una sola cuenta de altura.
const REL_TREE = (prompt) => [
  { part: { id: 'tronco', label: 'el tronco' }, base: { primitive: 'cylinder', on: { piece: 'suelo', side: 'top' }, color: '#7a4a28' },
    questions: [{ key: 'grosor', question: '¿Qué tan grueso es el tronco?', options: [
      { label: 'fino', patch: { size: [0.25, 2.4, 0.25] } },
      { label: 'grueso', patch: { size: [0.55, 2.4, 0.55] } }] }] },
  { part: { id: 'rama', label: 'una rama' }, base: { primitive: 'cylinder', from: { anchor: 'tronco.top', offset: [0, -0.5, 0] }, to: { anchor: 'tronco.top', offset: [0.9, 0.4, 0] }, thickness: 0.12, color: '#6b3f22', mirror: 'x' } },
  { part: { id: 'hojas', label: 'las hojas' }, base: { primitive: 'sphere', on: { piece: 'tronco', side: 'top', offset: [0, -0.3, 0] }, color: '#3f8a3a' },
    questions: [{ key: 'copa', question: 'Ya hay tronco y ramas. ¿Cómo es la copa?', options: [
      { label: 'racimo de esferas', patch: { size: [0.8, 0.8, 0.8], repeat: { pattern: 'cluster', count: 14, spread: [1.1, 0.6, 1.1], jitter: 0.3 } } },
      { label: 'una esfera grande', patch: { size: [2.4, 2, 2.4] } }] }] },
  ...(/flor|rosa/i.test(prompt) ? [{ part: { id: 'flores', label: 'las flores' }, base: { primitive: 'sphere', size: [0.18, 0.18, 0.18], on: { piece: 'hojas', side: 'bottom', offset: [0, 1, 0] }, color: '#f08cb4', repeat: { pattern: 'cluster', count: 24, spread: [1.3, 0.8, 1.3], jitter: 0.2 } } }] : []),
];

const REL_PERSON = () => [
  { part: { id: 'pierna', label: 'la pierna' }, base: { primitive: 'cylinder', from: [0.12, 0, 0], to: [0.12, 0.9, 0], thickness: 0.17, color: '#2d3a5c', mirror: 'x' } },
  { part: { id: 'torso', label: 'el torso' }, base: { primitive: 'box', size: [0.5, 0.65, 0.26], on: { piece: 'pierna', side: 'top', offset: [-0.12, 0, 0] }, color: '#c0533a' } },
  { part: { id: 'cuello', label: 'el cuello' }, base: { primitive: 'cylinder', size: [0.12, 0.12, 0.12], on: { piece: 'torso', side: 'top' }, color: '#e0b48f' } },
  { part: { id: 'cabeza', label: 'la cabeza' }, base: { primitive: 'sphere', on: { piece: 'cuello', side: 'top' }, color: '#e0b48f' },
    questions: [{ key: 'cabeza', question: '¿De qué tamaño es la cabeza?', options: [
      { label: 'proporcionada', patch: { size: [0.28, 0.3, 0.28] } },
      { label: 'grande, de caricatura', patch: { size: [0.42, 0.44, 0.42] } }] }] },
  { part: { id: 'brazo', label: 'el brazo' }, base: { primitive: 'cylinder', from: { anchor: 'torso.right', offset: [0, 0.27, 0] }, thickness: 0.11, color: '#c0533a', mirror: 'x' },
    questions: [{ key: 'pose', question: '¿Cómo están los brazos?', options: [
      { label: 'caídos a los costados', patch: { to: { anchor: 'torso.right', offset: [0.1, -0.33, 0] } } },
      { label: 'abiertos en cruz', patch: { to: { anchor: 'torso.right', offset: [0.66, 0.27, 0] } } }] }] },
];

export async function mockRelBlueprint({ prompt, object }) {
  return { pieces: object.id === 'arbol' ? REL_TREE(prompt) : REL_PERSON() };
}

export async function mockFix({ issues }) {
  return issues.length ? { fixes: [], note: `Demo: el motor marcó ${issues.length} problema${issues.length > 1 ? 's' : ''}; en demo no se corrige nada.` } : { ok: true, note: 'Demo: todo en orden.' };
}

// Luces de demo: tres looks fijos y contrastados (cálido de costado, noir con contraluz, hora dorada con héroe).
export async function mockLooks() {
  return { looks: [
    { label: 'Rembrandt cálido', idea: 'Principal ámbar de costado y arriba, relleno azul suave: volumen y calidez.', exposure: 1, background: '#2a2f3a', haze: 0.15, sky: { color: '#9fb4ff', ground: '#2b2420', intensity: 0.35 },
      lights: [{ role: 'key', color: '#ffc58a', intensity: 4, from: { side: -55, height: 40, distance: 5 }, softness: 0.4 }, { role: 'fill', color: '#7f9cff', intensity: 1, from: { side: 60, height: 10, distance: 6 }, softness: 0.9, shadow: false }, { role: 'rim', color: '#ffffff', intensity: 3, from: { side: 160, height: 35, distance: 5 }, softness: 0.3, shadow: false }] },
    { label: 'Noir con contraluz', idea: 'Sin relleno: una principal dura desde arriba y un contraluz frío que dibuja el borde.', exposure: 0.8, background: '#07080b', haze: 0.35, sky: { color: '#3b4a66', ground: '#000000', intensity: 0.08 },
      lights: [{ role: 'key', color: '#f2f4ff', intensity: 5, from: { side: 80, height: 60, distance: 4 }, softness: 0.1 }, { role: 'rim', color: '#4da3ff', intensity: 6, from: { side: -170, height: 20, distance: 4 }, softness: 0.2, shadow: false }] },
    { label: 'Hora dorada con héroe', idea: 'Sol bajo y anaranjado, cielo violeta y una luz héroe que acompaña al sujeto.', exposure: 1.1, background: '#f3a26b', haze: 0.25, sky: { color: '#b48cff', ground: '#5a3b2a', intensity: 0.6 },
      lights: [{ role: 'key', kind: 'sun', color: '#ff9a4d', intensity: 3.5, from: { side: -120, height: 12 }, softness: 0.5 }, { role: 'hero', color: '#ffe3b8', intensity: 1.5, from: { side: 25, height: 20, distance: 3 }, softness: 0.8, shadow: false }] },
  ] };
}
