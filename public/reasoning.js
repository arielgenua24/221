// Laboratorio · selector de nivel de razonamiento. Cada modelo acepta sus propios niveles: /api/lab/models y
// /api/lab/context/info traen por modelo `reasoning` (ver src/lab/reasoning.js):
//   { efforts: [...de menor a mayor], default, defaultEnabled, mandatory } · null = no razona · efforts [] = sin niveles.
// Funciones puras salvo fillReasoning(), que arma un <select>. Las usan lab.js y context-lab.js.

export const EFFORT_LABEL = { none: 'Apagado', minimal: 'Mínimo', low: 'Bajo', medium: 'Medio', high: 'Alto', xhigh: 'Muy alto', max: 'Máximo' };
const label = (e) => EFFORT_LABEL[e] || e;
// Un modelo que no está en el catálogo (escrito a mano): no sabemos qué acepta, así que se ofrecen los tres niveles comunes.
const GENERIC = ['low', 'medium', 'high'];

// Qué ofrecer para un modelo. `model`: la entrada del catálogo (undefined = no está / no hay catálogo).
// → { disabled, options: [{ value, label }], hint }
export function reasoningChoices(model) {
  if (!model) return { disabled: false, options: [{ value: '', label: 'Por defecto del modelo' }, ...GENERIC.map((e) => ({ value: e, label: label(e) }))], hint: 'Modelo fuera del catálogo: no sé qué niveles acepta; se prueba tal cual.' };
  const r = model.reasoning;
  if (!r) return { disabled: true, options: [{ value: '', label: 'No razona' }], hint: 'Este modelo no tiene razonamiento ajustable.' };
  if (!r.efforts?.length) return { disabled: true, options: [{ value: '', label: 'Sin niveles' }], hint: r.mandatory ? 'Razona siempre, pero OpenRouter no deja fijarle el nivel: usa el suyo.' : 'Admite razonamiento, pero OpenRouter no expone niveles para este modelo: usa el suyo.' };
  const def = !r.defaultEnabled && !r.mandatory ? 'apagado' : r.default ? label(r.default).toLowerCase() : null;
  const options = [
    { value: '', label: def ? `Por defecto del modelo (${def})` : 'Por defecto del modelo' },
    ...(r.mandatory ? [] : [{ value: 'none', label: label('none') }]),
    ...r.efforts.map((e) => ({ value: e, label: label(e) })),
  ];
  const range = r.efforts.length > 1 ? `${r.efforts[0]} → ${r.efforts.at(-1)}` : r.efforts[0];
  return { disabled: false, options, hint: `Niveles de este modelo: ${range}${r.mandatory ? ' · siempre razona' : ' · se puede apagar'}.` };
}

// Llena un <select> con los niveles del modelo y devuelve el valor que quedó. Si el valor que había ya no existe en este modelo
// (cambiaste de modelo), vuelve a «por defecto».
export function fillReasoning(select, model, value) {
  const { disabled, options, hint } = reasoningChoices(model);
  select.replaceChildren(...options.map((o) => { const el = document.createElement('option'); el.value = o.value; el.textContent = o.label; return el; }));
  const keep = options.some((o) => o.value === (value || '')) ? value || '' : '';
  select.value = keep;
  select.disabled = disabled;
  select.title = hint;
  return { value: keep, hint, reset: (value || '') !== keep };
}

// Cómo se muestra un nivel en tablas e historial. `used`: el nivel que se usó de verdad si el servidor lo cambió.
export function reasoningText(requested, used) {
  if (!requested) return 'por defecto';
  const base = label(requested).toLowerCase();
  return used && used !== requested ? `${base} (→ ${label(used).toLowerCase()})` : base;
}
