// Laboratorio · Motion Design: el entorno de Remotion donde corre el código de los dos agentes.
// - buildRuntime(): empaqueta (esbuild) React + Remotion + los paquetes permitidos en un solo script
//   para el iframe aislado (public/lab-frame.html). Se arma una vez y queda en memoria.
// - compileMotionLayer(): transpila el TSX de un agente a CommonJS y valida el contrato
//   (imports permitidos, export default, no renderiza el video —lo pone el entorno—, determinismo).
// Los dos modelos corren exactamente sobre este mismo entorno: es parte del harness.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, transform } from 'esbuild';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(import.meta.url);
const pkg = (name) => JSON.parse(readFileSync(path.join(ROOT, 'node_modules', name, 'package.json'), 'utf8'));

export const REMOTION_VERSION = pkg('remotion').version;
export const FPS = 30;

// Familias de @remotion/google-fonts que el iframe trae empaquetadas (import '@remotion/google-fonts/<Nombre>').
export const GOOGLE_FONTS = [
  'Inter', 'SpaceGrotesk', 'Manrope', 'Syne', 'Unbounded', 'ArchivoBlack', 'Anton', 'BebasNeue', 'PlayfairDisplay',
  'InstrumentSerif', 'DMSerifDisplay', 'Fraunces', 'JetBrainsMono', 'Caveat', 'Montserrat', 'Poppins', 'Oswald', 'Roboto', 'DMSans', 'Sora',
];

// Paquetes con subrutas (cada efecto o transición es su propio import, como dicen las skills).
const subpaths = (name) => Object.keys(pkg(name).exports || {})
  .filter((k) => k !== '.' && k !== './package.json')
  .map((k) => `${name}/${k.slice(2)}`);

const ROOT_PACKAGES = [
  'react', 'react/jsx-runtime', 'remotion', '@remotion/media', '@remotion/effects', '@remotion/transitions', '@remotion/shapes',
  '@remotion/paths', '@remotion/noise', '@remotion/rough-notation', '@remotion/layout-utils', '@remotion/motion-blur', '@remotion/light-leaks', '@remotion/animation-utils',
];

// Lo único que el código de un agente puede importar.
export const ALLOWED_IMPORTS = [
  ...ROOT_PACKAGES,
  ...subpaths('@remotion/effects'),
  ...subpaths('@remotion/transitions'),
  ...GOOGLE_FONTS.map((f) => `@remotion/google-fonts/${f}`),
];
const ALLOWED = new Set(ALLOWED_IMPORTS);

// ---------- Runtime del iframe ----------
function entrySource() {
  const lines = [
    "import { createRoot } from 'react-dom/client';",
    "import { Player } from '@remotion/player';",
    "import { renderMediaOnWeb } from '@remotion/web-renderer';",
  ];
  const entries = ALLOWED_IMPORTS.map((spec, i) => {
    lines.push(`import * as m${i} from ${JSON.stringify(spec)};`);
    return `  ${JSON.stringify(spec)}: m${i},`;
  });
  lines.push(
    'const modules = {',
    ...entries,
    '};',
    'globalThis.LabRuntime = { modules, createRoot, Player, renderMediaOnWeb, React: m0, remotion: m2 };',
  );
  return lines.join('\n');
}

let runtime = null;
// Devuelve el script del iframe (se arma la primera vez que se pide: ~1 s).
export function buildRuntime() {
  runtime ??= build({
    stdin: { contents: entrySource(), resolveDir: ROOT, loader: 'js', sourcefile: 'lab-runtime-entry.js' },
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    minify: true,
    write: false,
    legalComments: 'none',
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'silent',
  }).then((r) => r.outputFiles[0].text).catch((err) => { runtime = null; throw err; });
  return runtime;
}

// ---------- Código de los agentes ----------
const FENCE = /```(?:tsx|jsx|typescript|ts|javascript|js)?[ \t]*\r?\n([\s\S]*?)```/g;

// El último bloque de código de la respuesta (los modelos a veces escriben un borrador antes).
export function extractCode(text) {
  const raw = String(text || '');
  const blocks = [...raw.matchAll(FENCE)].map((m) => m[1]).filter((b) => /export\s+default|import\s/.test(b));
  if (blocks.length) return blocks.at(-1).trim();
  // Bloque abierto que quedó sin cerrar (respuesta cortada).
  const open = raw.lastIndexOf('```');
  if (open >= 0) {
    const tail = raw.slice(open).replace(/^```[a-z]*[ \t]*\r?\n?/, '');
    if (/export\s+default/.test(tail)) return tail.trim();
  }
  throw new Error('la respuesta no trae un bloque ```tsx con el componente');
}

// Transpila y valida. Devuelve { js } o lanza un Error con un mensaje pensado para el modelo.
export async function compileMotionLayer(source) {
  const code = String(source || '');
  if (!code.trim()) throw new Error('no hay código');
  if (code.length > 80000) throw new Error('el código es demasiado largo (máx. 80.000 caracteres)');
  let out;
  try {
    out = await transform(code, { loader: 'tsx', jsx: 'automatic', format: 'cjs', target: 'es2022', sourcefile: 'MotionLayer.tsx', logLevel: 'silent' });
  } catch (err) {
    const first = err.errors?.[0];
    const where = first?.location ? ` (línea ${first.location.line}, columna ${first.location.column + 1}: \`${first.location.lineText.trim().slice(0, 120)}\`)` : '';
    throw new Error(`error de sintaxis: ${first?.text || err.message}${where}`);
  }
  const js = out.code;
  const imports = [...new Set([...js.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]))];
  const bad = imports.filter((s) => !ALLOWED.has(s));
  if (bad.length) {
    throw new Error(`importa módulos que no existen en este entorno: ${bad.join(', ')}. Solo podés importar: remotion, @remotion/media, @remotion/transitions(/<preset>), @remotion/effects/<efecto>, @remotion/shapes, @remotion/paths, @remotion/noise, @remotion/rough-notation, @remotion/layout-utils, @remotion/motion-blur, @remotion/light-leaks, @remotion/animation-utils, @remotion/google-fonts/<${GOOGLE_FONTS.join('|')}>, react. Todo tiene que estar en un solo archivo.`);
  }
  if (!/\bdefault:\s*\(\)\s*=>/.test(js)) throw new Error('falta el `export default` del componente principal');
  if (/\bvideoSrc\b/.test(code)) throw new Error('usa `videoSrc`: el video original ya lo renderiza el entorno debajo; tu componente es solo la capa de motion (transparente) que va encima');
  if (/\bMath\.random\s*\(/.test(code)) throw new Error('usa Math.random(): en Remotion cada cuadro tiene que ser determinista; usá random(seed) de "remotion"');
  if (/\b(?:Date\.now|performance\.now|new Date)\b/.test(code)) throw new Error('usa el reloj del sistema: el tiempo tiene que salir de useCurrentFrame()');
  if (/\bstaticFile\s*\(/.test(code)) throw new Error('usa staticFile(): acá no hay carpeta public/; las formas se dibujan con código y las imágenes generadas llegan en la prop `images`');
  return { js, imports };
}

export const runtimeInfo = () => ({ remotion: REMOTION_VERSION, fps: FPS, react: require('react/package.json').version });
