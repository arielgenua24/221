// Pestaña Laboratorio · JEV a píxel.
// Copia fiel de los cuatro experimentos de jev-to-pix (components/studio.tsx y experiment-*.tsx): JEV no dibuja
// píxeles, solo responde preguntas cerradas (noul / box); la imagen se reconstruye a partir de esas probabilidades.
//   Exp 1  8×8 noul sobre la imagen entera (1 ciclo).
//   Exp 2  box() + grilla densa 12–20² dentro del recorte (2 ciclos).
//   Exp 3  box() + 16×16 noul + 4 sub-cajas; super-resolución 48–80² en cliente (2 ciclos).
//   Exp 4  box() + SLIC con IDs impresos + random walker + refinamiento jerárquico opcional (2–3 ciclos).
import { el, config, editableSubtitle, experimentSection } from './jev-pixel-lab/common.js';
import { createExperimentOne } from './jev-pixel-lab/exp1.js';
import { createExperimentTwo } from './jev-pixel-lab/exp2.js';
import { createExperimentThree } from './jev-pixel-lab/exp3.js';
import { createExperimentFour } from './jev-pixel-lab/exp4.js';

const $ = (id) => document.getElementById(id);
const TAB = 'lab-jevpixel';
let started = false;

const error = (msg) => { const e = $('jevpixel-error'); if (!e) return; e.textContent = msg || ''; e.hidden = !msg; };

function mount(root) {
  const page = el('div', 'jp-root');

  const head = el('header', 'jp-page-head');
  const left = el('div', 'jp-page-title');
  left.append(el('p', 'jp-kicker', 'Decision engine · Laboratorio incremental'), el('p', 'jp-display', 'JEV'));
  const meta = el('p', 'jp-page-meta');
  meta.append(config.model, el('br'), 'Exp 1 (64) · Exp 2 (box + 256) · Exp 3 (10X–25X · hasta 6,400)');
  if (config.mock) meta.append(el('br'), el('span', 'jp-demo', 'demo: respuestas simuladas'));
  head.append(left, meta);
  page.append(head);

  page.append(
    experimentSection({
      n: 1, kicker: 'Base original · 8×8 (64 mosaicos)', title: 'Laboratorio Experimento 1',
      open: false, body: createExperimentOne(),
    }),
    experimentSection({
      n: 2, kicker: 'Segunda mejora · box() + recorte enfocado de alta densidad', title: 'Laboratorio Experimento 2',
      subtitle: editableSubtitle('Busca de alta resolución', 'Subtítulo del Laboratorio Experimento 2'),
      open: false, body: createExperimentTwo(),
    }),
    experimentSection({
      n: 3, badge: 'Experimento Activo · 10X+', title: 'Laboratorio Experimento 3', active: true,
      subtitle: editableSubtitle('Super-resolución 10X guiada por bordes y tomografía de sub-cajas', 'Subtítulo del Laboratorio Experimento 3'),
      open: true, body: createExperimentThree(),
    }),
    experimentSection({
      n: 4, badge: 'Experimento Activo · Píxel exacto', title: 'Laboratorio Experimento 4', active: true,
      subtitle: 'Segmentación a nivel píxel: superpíxeles SLIC supervisados + random walker + refinamiento jerárquico',
      open: true, body: createExperimentFour(),
    }),
  );
  root.replaceChildren(page);
}

async function start() {
  if (started) return;
  started = true;
  const root = $('jevpixel-experiment');
  if (!root) return;
  try {
    Object.assign(config, await fetch('/api/lab/jev-pixel/config').then((r) => r.json()));
    if (!config.available) error('Falta TYPESAFE_API_KEY en el proyecto: JEV no va a poder responder.');
  } catch {
    error('No se pudo leer la configuración de JEV a píxel.');
  }
  mount(root);
}

// Soltar archivos fuera de una zona de imagen no navega la página.
const here = () => document.body.dataset.tab === TAB;
window.addEventListener('dragover', (e) => { if (here()) e.preventDefault(); });
window.addEventListener('drop', (e) => { if (here()) e.preventDefault(); });

window.addEventListener('tab', ({ detail }) => { if (detail === TAB) start(); });
if (here()) start();
