// Raw: el agente de voz que trabaja con el humano dentro de un proyecto (carpeta).
// Habla (lo que dice se convierte en audio), mira las imágenes del proyecto, las categoriza,
// pregunta cuando tiene dudas y, cuando está seguro, genera la imagen.

export const GREETING = 'Hola, dime qué quieres trabajar hoy.';
export const DONE_LINES = ['Listo, aquí la tienes. ¿Qué te parece?', 'Ya está. ¿La ajustamos o seguimos?', 'Terminé. Mírala y dime qué cambio.'];
export const ASPECTS = ['1:1', '3:4', '4:3', '9:16', '16:9'];

export const RAW_SYSTEM = `Eres Raw, un director de arte que trabaja CON la persona, por voz, dentro de un proyecto (una carpeta).
Todo lo que pones en "decir" se convierte en audio y suena en voz alta: habla como en una conversación real.

## Cómo hablas
- En español, cálido y directo. Frases cortas: 1 o 2 oraciones, máximo ~30 palabras.
- Nada de listas, markdown, emojis ni códigos raros en "decir" (se leen en voz alta). Para señalar imágenes, usa "la primera", "la de la izquierda", o su nombre corto; los códigos (P1, R3…) son para el JSON.
- Confirma en voz alta lo que entendiste antes de generar ("Okay: esta persona con este estilo de referencia").

## Las imágenes del proyecto
- Cada imagen tiene un código: P = persona, R = referencia, G = generada antes. Las ves más abajo, cada una con su código justo antes.
- Están en orden de llegada: "la última que te subí" es la de fecha más reciente de ese tipo. "Recién subida" = llegó desde el turno anterior.
- Si una imagen no tiene categoría (o dice NUEVA), mírala y categorízala en "etiquetas": tipo (persona o referencia, corrígelo si está mal), una categoría corta (estilo, personaje, pose, fondo, vestuario, producto, composición, paleta, textura, logo…), un nombre corto y una descripción de lo que ves. También puedes re-categorizar cuando aprendas algo nuevo.
- Las imágenes quedan vivas en el proyecto: usa las de turnos anteriores sin pedir que las suban de nuevo.

## Dudas: pregunta, no adivines
- Si la persona dice "esta imagen", "la última referencia", "esa persona" y hay más de una candidata razonable, NO generes: usa "mostrar" con las candidatas (máx. 4, las más probables) y pregunta cuál. Ej.: "A ver, espera: estas tres son las últimas referencias. ¿A cuál te refieres?"
- Si falta algo esencial (quién, qué estilo, qué quiere lograr), pregunta UNA cosa concreta.
- Si la persona tocó una imagen o dijo cuál es ("a esta", "la segunda"), resuélvelo con lo que mostraste en el turno anterior y sigue.
- Si solo hay una candidata obvia, no preguntes: confirma en voz alta y genera.

## Generar
- Cuando estés seguro, completa "generar": los códigos de las imágenes de entrada (primero la persona o el sujeto, después las referencias de estilo) y un prompt EN INGLÉS para el modelo de edición de imagen.
- El prompt dice qué tomar de cada imagen por posición ("Image 1: the person — keep their face, identity and features. Image 2: style reference — match its rendering, palette and linework."), qué resultado se quiere (composición, pose, fondo, encuadre, luz) y qué NO cambiar. Concreto y visual; nunca pidas texto escrito dentro de la imagen salvo que lo pidan.
- "proporcion": una de ${ASPECTS.join(', ')}. Usa la preferida por la persona si no pidió otra.
- Mientras se genera, "decir" confirma lo que vas a hacer (la generación tarda un poco).
- No combines "mostrar" y "generar" en el mismo turno.
- Si piden cambios sobre una generada (G…), úsala como entrada junto con lo necesario.

## Formato de salida
Primero, como máximo una línea de nota para ti (qué entendiste). Después, SIEMPRE un único bloque:
\`\`\`json
{
  "decir": "lo que dices en voz alta",
  "etiquetas": [{ "codigo": "R3", "tipo": "referencia", "categoria": "estilo", "nombre": "Estilo PES 13", "descripcion": "Render de videojuego 2013, piel brillante, luz de estadio" }],
  "mostrar": { "codigos": ["R1", "R2", "R3"], "pregunta": "¿Cuál de estas?" },
  "generar": { "entradas": ["P1", "R3"], "prompt": "Image 1: ... Image 2: ...", "proporcion": "3:4", "resumen": "P1 al estilo de R3" }
}
\`\`\`
"etiquetas" puede ser []; "mostrar" y "generar" van en null cuando no aplican.`;

const ago = (iso, now) => {
  const s = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (s < 90) return 'hace un momento';
  if (s < 3600) return `hace ${Math.round(s / 60)} min`;
  if (s < 86400) return `hace ${Math.round(s / 3600)} h`;
  return `hace ${Math.round(s / 86400)} días`;
};

export function assetLine(a, { now = Date.now(), fresh = false, folderName } = {}) {
  const parts = [`${a.code} · ${a.kind}`];
  parts.push(a.category ? `categoría: ${a.category}` : 'SIN CATEGORÍA (NUEVA: categorízala)');
  if (a.name) parts.push(`nombre: ${a.name}`);
  if (a.description) parts.push(`se ve: ${a.description}`);
  if (a.kind === 'generada' && a.inputs?.length) parts.push(`hecha con ${a.inputs.join(' + ')}`);
  if (folderName) parts.push(`de la carpeta "${folderName}"`);
  parts.push(ago(a.createdAt, now));
  if (fresh) parts.push('RECIÉN SUBIDA');
  return `- ${parts.join(' · ')}`;
}

// El mensaje de un turno: contexto del proyecto + imágenes (cada una precedida por su código) + lo que dijo la persona.
// `images`: [{ asset, url }] con las que se le muestran al modelo (las demás van solo como texto).
export function rawTurnContent({ lineage, assets, images, freshCodes = [], text, selected = [], style, aspect, lastShown, now = Date.now() }) {
  const names = new Map(lineage.map((f) => [f.id, f.name]));
  const here = lineage.at(-1)?.id;
  const fresh = new Set(freshCodes);
  const lines = [
    `Proyecto: ${lineage.map((f) => f.name).join(' / ')}`,
    `Preferencias en la interfaz: estilo "${style || 'Any Style'}", proporción ${aspect || '1:1'}.`,
    '',
    assets.length ? 'Imágenes del proyecto (orden de llegada, la última es la más reciente):' : 'El proyecto todavía no tiene imágenes.',
    ...assets.map((a) => assetLine(a, { now, fresh: fresh.has(a.code), folderName: a.folderId !== here ? names.get(a.folderId) : undefined })),
  ];
  if (lastShown?.codigos?.length) lines.push('', `En tu turno anterior mostraste: ${lastShown.codigos.join(', ')} (en ese orden, de izquierda a derecha) y preguntaste: "${lastShown.pregunta || ''}".`);
  const content = [{ type: 'text', text: lines.join('\n') }];
  images.forEach(({ asset, url }) => {
    content.push({ type: 'text', text: `${asset.code}:` });
    content.push({ type: 'image_url', image_url: { url } });
  });
  const said = [
    selected.length ? `(La persona tocó en pantalla: ${selected.join(', ')})` : '',
    text ? `La persona dice: "${text}"` : '(La persona no dijo nada: solo tocó o subió imágenes.)',
  ].filter(Boolean).join('\n');
  content.push({ type: 'text', text: said });
  return content;
}

// Lo que queda en el historial del lado del agente (texto: las imágenes no se repiten turno a turno).
export function assistantMemory(data) {
  const parts = [`Dije: "${data.decir || ''}"`];
  if (data.mostrar?.codigos?.length) parts.push(`[Mostré ${data.mostrar.codigos.join(', ')} y pregunté: ${data.mostrar.pregunta || ''}]`);
  if (data.generar?.entradas?.length) parts.push(`[Generé con ${data.generar.entradas.join(' + ')}: ${data.generar.resumen || data.generar.prompt}]`);
  return parts.join(' ');
}

// El prompt final para el modelo de edición: le dice qué es cada imagen de entrada, por posición.
export function imagePrompt({ prompt, inputs, style }) {
  const roles = inputs.map((a, i) => {
    const what = [a.kind === 'persona' ? 'the person/subject' : a.kind === 'generada' ? 'a previous result to edit' : 'reference', a.category, a.name].filter(Boolean).join(', ');
    return `Image ${i + 1} = ${what}.`;
  }).join(' ');
  const styleLine = style && style !== 'Any Style' ? ` Preferred style: ${style}.` : '';
  return `${roles}\n${prompt}${styleLine}`.trim();
}
