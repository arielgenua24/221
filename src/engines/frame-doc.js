// El documento del iframe aislado donde corre la animación de un agente (lo comparten todos los motores).
// Va entero en línea: la página lo carga como srcdoc con sandbox="allow-scripts" (origen opaco, sin acceso a la app)
// y la CSP del <meta> le corta la red. Cada motor aporta sus scripts y, si quiere, más estilos.

// Sin red salvo las fuentes de Google; el video llega como Blob (blob:) y el código se evalúa con new Function ('unsafe-eval').
export const FRAME_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval'",
  "style-src 'unsafe-inline' https://fonts.googleapis.com",
  'font-src https://fonts.gstatic.com data: blob:',
  'img-src data: blob:',
  'media-src blob:',
  'connect-src blob: data: https://fonts.googleapis.com https://fonts.gstatic.com',
  'worker-src blob:',
].join('; ');

// Un "</script" dentro del código cerraría la etiqueta antes de tiempo.
export const inline = (js) => js.replace(/<\/(script)/gi, '<\\/$1');

export function frameDocument(scripts, { style = '' } = {}) {
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  html, body { margin: 0; height: 100%; background: #000; overflow: hidden; color: #f4f1ea; font: 13px/1.4 system-ui, sans-serif; }
  #root { width: 100%; height: 100%; }
  .lab-frame-error { position: absolute; inset: 0; display: grid; place-items: center; padding: 16px; text-align: center; background: #1b0f0c; color: #ffb4a1; white-space: pre-wrap; overflow: auto; }${style}
</style>
</head>
<body>
<div id="root"></div>
${scripts.map((s) => `<script>${inline(s)}</script>`).join('\n')}
</body>
</html>`;
}
