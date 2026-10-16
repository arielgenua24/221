// Laboratorio · nivel de razonamiento. Cada modelo de OpenRouter acepta sus propios niveles: el catálogo (/models) trae por
// modelo un objeto `reasoning` con { supported_efforts, default_effort, default_enabled, mandatory, supports_max_tokens }.
// Acá se normaliza ese objeto para la pantalla (qué niveles ofrecer) y se traduce lo que pidió el humano al nivel más
// cercano que el modelo acepta (OpenRouter rechaza con 400 un nivel que el modelo no soporta).
//
// Orden de menor a mayor. `none` apaga el razonamiento (solo si el modelo no lo exige).
export const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const RANK = new Map(EFFORTS.map((e, i) => [e, i]));
const sortUp = (list) => [...new Set(list)].filter((e) => RANK.has(e) && e !== 'none').sort((a, b) => RANK.get(a) - RANK.get(b));

// Del objeto del catálogo a lo que usa la pantalla. null = el modelo no razona (o es un router sin el dato).
//   efforts: niveles que acepta, de menor a mayor. [] = razona pero no deja fijar el nivel.
//   default: nivel de fábrica (null si no lo dice). defaultEnabled: ¿razona por defecto? mandatory: ¿no se puede apagar?
export function reasoningMeta(entry) {
  const r = entry?.reasoning;
  if (!r || typeof r !== 'object') return null;
  // supported_efforts: null = acepta todos los niveles del gateway; ausente = no expone niveles.
  const efforts = Array.isArray(r.supported_efforts) ? sortUp(r.supported_efforts) : r.supported_efforts === null ? sortUp(EFFORTS) : [];
  return {
    efforts,
    default: RANK.has(r.default_effort) ? r.default_effort : null,
    defaultEnabled: r.default_enabled !== false,
    mandatory: !!r.mandatory,
    maxTokens: !!r.supports_max_tokens,
  };
}

// El nivel pedido → { param, effective, note }.
//   requested: '' / null = el del modelo (no se manda nada). meta: reasoningMeta() del modelo, o undefined si no se pudo leer
//   el catálogo (entonces se manda tal cual y OpenRouter decide).
//   param: lo que va en la llamada ({ effort }) o undefined. effective: el nivel que se usó (null = el del modelo).
//   note: aviso para el humano cuando se tuvo que cambiar o ignorar lo que pidió.
export function resolveReasoning(requested, meta) {
  if (!requested || !RANK.has(requested)) return { param: undefined, effective: null, note: null };
  if (meta === undefined) return { param: { effort: requested }, effective: requested, note: null };
  if (meta === null) return { param: undefined, effective: null, note: `Este modelo no tiene razonamiento ajustable: ignoro «${requested}».` };
  if (requested === 'none') {
    if (meta.mandatory) return { param: undefined, effective: null, note: 'Este modelo siempre razona: no se puede apagar. Uso su nivel por defecto.' };
    return { param: { effort: 'none' }, effective: 'none', note: null };
  }
  if (!meta.efforts.length) return { param: undefined, effective: null, note: `Este modelo razona pero no deja elegir el nivel: ignoro «${requested}» y uso el suyo.` };
  if (meta.efforts.includes(requested)) return { param: { effort: requested }, effective: requested, note: null };
  // El más cercano de los que acepta (si está a la misma distancia, el más bajo: gasta menos).
  const want = RANK.get(requested);
  const near = [...meta.efforts].sort((a, b) => Math.abs(RANK.get(a) - want) - Math.abs(RANK.get(b) - want) || RANK.get(a) - RANK.get(b))[0];
  return { param: { effort: near }, effective: near, note: `Este modelo no acepta «${requested}» (acepta ${meta.efforts.join(', ')}): uso «${near}».` };
}
