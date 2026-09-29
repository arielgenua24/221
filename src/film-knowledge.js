import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Biblioteca de criterio cinematográfico (agents-film/): cada guía viene en dos formas,
// un .md para aprender (vocabulario, matices, ejemplos) y un .json con reglas accionables
// (id, definición, cuándo usar / no usar, intensidad visual). Se lee entera al arrancar:
// agregar una guía nueva en cualquier carpeta la suma sola al manual de los agentes.

export const FILM_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'agents-film');

function loadGuides(dir = FILM_DIR) {
  let folders;
  try { folders = readdirSync(dir).filter((d) => statSync(path.join(dir, d)).isDirectory()).sort(); } catch { return []; }
  return folders.flatMap((folder) => {
    const files = readdirSync(path.join(dir, folder));
    const names = [...new Set(files.filter((f) => /\.(md|json)$/.test(f)).map((f) => f.replace(/\.(md|json)$/, '')))].sort();
    return names.map((name) => {
      const read = (ext) => { try { return readFileSync(path.join(dir, folder, `${name}.${ext}`), 'utf8'); } catch { return null; } };
      let rules = null;
      try { rules = JSON.parse(read('json') || 'null'); } catch { rules = null; }
      return { id: name, folder, md: read('md'), rules };
    });
  });
}

export const FILM_GUIDES = loadGuides();

// Todas las reglas con su guía: "camera-movement/push-in-dolly-in".
export const FILM_RULES = new Map(FILM_GUIDES.flatMap((g) => (g.rules?.reglas || []).map((r) => [`${g.id}/${r.id}`, { guide: g.id, ...r }])));

const oneLine = (s) => String(s || '').replace(/\s+/g, ' ').trim();

// Catálogo compacto de TODAS las reglas (el índice que el agente cita por id).
function catalog(guides) {
  return guides.filter((g) => g.rules?.reglas?.length).map((g) => {
    const rules = g.rules.reglas.map((r) => {
      const intensity = r.parametros?.intensidad_visual;
      const bits = [
        `- \`${g.id}/${r.id}\`${intensity ? ` (intensidad ${intensity}/5)` : ''}: ${oneLine(r.definicion)}`,
        r.cuando_usar && `  Usar: ${oneLine(r.cuando_usar)}`,
        r.cuando_no_usar && `  No usar: ${oneLine(r.cuando_no_usar)}`,
      ];
      return bits.filter(Boolean).join('\n');
    }).join('\n');
    const principles = (g.rules.principios_generales || []).map((p) => `  · ${oneLine(p)}`).join('\n');
    return `### ${g.folder} / ${g.id}\n${rules}${principles ? `\nPrincipios:\n${principles}` : ''}`;
  }).join('\n\n');
}

// Manual para un agente: las guías de `full` completas (.md) + el catálogo de reglas de todas.
// `full` lista ids de guía (ej. 'camera-movement') o carpetas enteras (ej. 'cinematic-light').
export function filmManual({ full = [], guides = FILM_GUIDES } = {}) {
  if (!guides.length) return '';
  const wanted = new Set(full);
  const deep = guides.filter((g) => g.md && (wanted.has(g.id) || wanted.has(g.folder)));
  return `# BIBLIOTECA DE CINE (agents-film)

Es tu criterio profesional. Primero las guías completas que más usás en este trabajo; después, el catálogo de TODAS las reglas de la biblioteca, cada una con su id. Cuando una decisión tuya salga de una regla, citala por su id exacto (\`guía/regla\`).
Las guías insisten en algo que vale para todo: ningún recurso tiene un significado fijo; se elige por lo que el video y el encargo necesitan, y "no hacer nada" es muchas veces la mejor decisión.

${deep.map((g) => `<guia id="${g.id}" carpeta="${g.folder}">\n${g.md.trim()}\n</guia>`).join('\n\n')}

## CATÁLOGO DE REGLAS (todas las guías)

${catalog(guides)}
`;
}
