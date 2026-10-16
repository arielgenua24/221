// Motor canvas · render headless de alta calidad (fuera del navegador del usuario):
//   página con window.seek(t) → Chromium headless (Playwright) → PNG por subcuadro → ffmpeg (tmix = motion blur) → mp4
// Cada cuadro final promedia `sub` subcuadros consecutivos (desenfoque de movimiento real, no simulado).
// Si se pasa `video`, la capa (transparente) se compone sobre el video original y se conserva su audio.
//
//   node src/engines/canvas/render.js --code scenes.js --width 1080 --height 1920 --dur 15 [--fps 60] [--sub 4]
//                                     [--video base.mp4] [--background '#141413'] [--out out/final.mp4]
//
// Necesita `playwright` (npm i -D playwright && npx playwright install chromium) y `ffmpeg` en el PATH.
// Ninguno es dependencia de la app: se cargan recién al renderizar.
import { spawn } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile, standaloneDocument } from './index.js';

// Filtro de ffmpeg: promedia SUB subcuadros y se queda con uno por grupo (tmix + select), al fps final.
export const blurFilter = (fps, sub) => (sub > 1
  ? `tmix=frames=${sub},select='eq(mod(n\\,${sub})\\,${sub - 1})',setpts=N/${fps}/TB`
  : `setpts=N/${fps}/TB`);

// Los argumentos de ffmpeg: los PNG llegan por stdin; con video de base se superponen encima y se copia su audio.
export function ffmpegArgs({ fps, sub, out, video = null, crf = 16 }) {
  const input = ['-f', 'image2pipe', '-framerate', String(fps * sub), '-i', '-'];
  const encode = ['-r', String(fps), '-c:v', 'libx264', '-crf', String(crf), '-pix_fmt', 'yuv420p'];
  if (!video) return ['-y', ...input, '-vf', blurFilter(fps, sub), ...encode, out];
  return ['-y', ...input, '-i', video,
    '-filter_complex', `[0:v]${blurFilter(fps, sub)}[fx];[1:v]fps=${fps}[base];[base][fx]overlay=0:0:shortest=1[v]`,
    '-map', '[v]', '-map', '1:a?', ...encode, '-c:a', 'aac', '-shortest', out];
}

async function loadPlaywright() {
  try { return await import(process.env.PLAYWRIGHT_MODULE || 'playwright'); } catch {
    throw new Error('el render headless necesita Playwright: npm i -D playwright && npx playwright install chromium');
  }
}

// js: el código del agente ya compilado (compile(...).js). images: { gen1: dataUrl }. onProgress(segundos renderizados).
export async function renderCanvas({ js, width, height, duration, fps = 60, sub = 4, zones = [], images = {}, video = null, background = null, out = 'out/final.mp4', onProgress = () => {} }) {
  const { chromium } = await loadPlaywright();
  await mkdir(path.dirname(path.resolve(out)), { recursive: true });
  const html = standaloneDocument({ js, width, height, duration, fps, zones, images, background: video ? null : background });
  const browser = await chromium.launch();
  let ff = null;
  try {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: 'load' });
    await page.evaluate(() => window.ready); // fuentes e imágenes cargadas antes del primer cuadro
    ff = spawn('ffmpeg', ffmpegArgs({ fps, sub, out, video }), { stdio: ['pipe', 'inherit', 'inherit'] });
    const closed = new Promise((resolve, reject) => {
      ff.on('error', (err) => reject(err.code === 'ENOENT' ? new Error('falta ffmpeg en el PATH') : err));
      ff.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg terminó con código ${code}`))));
    });
    const canvas = page.locator('#c');
    const total = Math.round(duration * fps * sub);
    for (let i = 0; i < total; i++) {
      await page.evaluate((t) => window.seek(t), i / (fps * sub));
      const png = await canvas.screenshot({ type: 'png', omitBackground: !background || !!video });
      if (!ff.stdin.write(png)) await new Promise((r) => ff.stdin.once('drain', r));
      if (i % (fps * sub) === 0) onProgress(i / (fps * sub), duration);
    }
    ff.stdin.end();
    await closed;
    return out;
  } finally {
    if (ff && ff.exitCode === null && !ff.stdin.writableEnded) ff.kill('SIGKILL');
    await browser.close();
  }
}

// ---------- CLI ----------
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
  const num = (k, d) => Number(arg(k, d));
  const width = num('width', 1080), height = num('height', 1920), duration = num('dur', 15), fps = num('fps', 60), sub = num('sub', 4);
  const source = await readFile(arg('code', 'scenes.js'), 'utf8');
  const { js } = await compile(source, { width, height, duration, fps });
  await renderCanvas({
    js, width, height, duration, fps, sub, video: arg('video', null), background: arg('background', null), out: arg('out', 'out/final.mp4'),
    onProgress: (s, d) => console.log(`renderizado ${s}s / ${d}s`),
  });
  console.log(`listo: ${arg('out', 'out/final.mp4')}`);
}
