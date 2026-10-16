import { el } from './shared.js';

// Descarga de un video renderizado en el Laboratorio.
// El render tarda unos segundos: cuando termina, el clic que lo pidió ya venció y el navegador puede bloquear la
// descarga automática sin avisar (sobre todo a partir de la segunda en el mismo sitio). Por eso, además de intentarla,
// queda un enlace «Guardar video» que la persona toca ella misma (eso siempre se permite) y que sirve para volver a
// bajarlo sin renderizar de nuevo.

// Guarda el video (reemplaza el anterior de esa tarjeta) e intenta la descarga automática. Devuelve { url, name, size }.
export function keepVideo(previous, blob, name) {
  if (previous?.url) URL.revokeObjectURL(previous.url);
  const saved = { url: URL.createObjectURL(blob), name, size: blob.size };
  const a = el('a');
  a.href = saved.url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  return saved;
}

export function forgetVideo(saved) {
  if (saved?.url) URL.revokeObjectURL(saved.url);
  return null;
}

// El enlace para guardarlo a mano.
export function savedLink(saved) {
  const a = el('a', 'small-btn lab-save', `⬇ Guardar video · ${(saved.size / 1048576).toFixed(1)} MB`);
  a.href = saved.url;
  a.download = saved.name;
  a.title = `${saved.name}\nSi no se descargó solo, tocá acá.`;
  return a;
}
