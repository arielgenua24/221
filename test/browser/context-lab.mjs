// Flujo del Context Lab en el navegador, contra un servidor demo (sin generaciones pagas).
// PLAYWRIGHT_MODULE puede apuntar a la instalación de Playwright. SHOTS=<carpeta> guarda capturas.
// Necesita ffmpeg para armar el clip de prueba (WebM: el Chromium de Playwright no decodifica H.264).
import assert from 'node:assert/strict';
import { mkdtemp, cp, rm, symlink, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import net from 'node:net';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dir = await mkdtemp(path.join(tmpdir(), 'context-browser-'));
const reservation = net.createServer(); await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
const port = reservation.address().port; await new Promise((resolve) => reservation.close(resolve));
const shots = process.env.SHOTS;
let server, browser; const errors = [];
try {
  for (const name of ['src', 'public', 'agents-film', 'package.json']) await cp(path.join(root, name), path.join(dir, name), { recursive: true });
  await symlink(path.join(root, 'node_modules'), path.join(dir, 'node_modules'));
  const clip = path.join(dir, 'clip.webm');
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=360x640:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '6', '-c:v', 'libvpx', '-b:v', '600k', '-c:a', 'libopus', '-shortest', clip]);
  server = spawn(process.execPath, ['src/server.js'], { cwd: dir, env: { ...process.env, PORT: String(port), MOCK: '1', OPENROUTER_API_KEY: '', WAVESPEED_API_KEY: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`${base}/api/config`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 50)); }
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  page.on('pageerror', (e) => errors.push(e.message));
  // El script también corre en el iframe aislado del Player (sin localStorage): solo en la página.
  await page.addInitScript(() => { if (window.top !== window) return; localStorage.setItem('raw-mic', '0'); localStorage.setItem('story-mic', '0'); localStorage.setItem('lab.motion.experiments.v1', JSON.stringify([{ id: 'sentinel', name: 'Motion history preserved', createdAt: '2026-10-09' }])); });
  await page.goto(`${base}/#laboratorio`);
  await page.locator('#lab-home a[href="#laboratorio/context-lab"]').click();
  const folder = page.locator('#lab-context-folder');
  await folder.waitFor({ state: 'visible' });
  assert.equal(await page.locator('#lab-motion-folder').isVisible(), false);
  const cards = folder.locator('.ctx-card');
  await page.waitForFunction(() => document.querySelectorAll('#lab-context-folder .ctx-card').length === 2);

  // Clip y una zona.
  await folder.locator('.lab-pick input[type=file]').setInputFiles({ name: 'clip.webm', mimeType: 'video/webm', buffer: await readFile(clip) });
  await folder.getByRole('button', { name: '+ Marcar clip acá' }).click();
  await folder.locator('textarea').first().fill('Una cafetería de barrio, tono cálido.');

  // V1: video IA y sonido obligatorios. V2 (por defecto): sin herramientas. V3: duplicado de V1 sin cuadros.
  const v1 = cards.nth(0);
  const toolRow = (card, name) => card.locator('.ctx-tool', { hasText: name });
  await toolRow(v1, 'Generar video IA').getByRole('radio', { name: 'Obligatoria' }).click();
  await toolRow(v1, 'Generar sonido').getByRole('radio', { name: 'Obligatoria' }).click();
  assert.equal(await toolRow(v1, 'Generar sonido').getByRole('radio', { name: 'Obligatoria' }).getAttribute('aria-checked'), 'true');
  assert.match(await v1.locator('.ctx-skills summary').textContent(), /\d+ de \d+/);
  await v1.getByRole('button', { name: 'Duplicar' }).click();
  await page.waitForFunction(() => document.querySelectorAll('#lab-context-folder .ctx-card').length === 3);
  const v2 = cards.nth(1); // la copia queda al lado de la original
  await v2.locator('.lab-slider input[type=range]').first().fill('0');
  await v2.getByRole('button', { name: 'Ver el prompt final' }).click();
  await page.waitForFunction(() => document.querySelectorAll('#lab-context-folder .ctx-preview:not([hidden])').length === 1);
  assert.match(await v2.locator('.ctx-preview').textContent(), /generar_video\(zona, imagen\?, prompt\) \(REQUIRED\)/);

  if (shots) { await mkdir(shots, { recursive: true }); await page.screenshot({ path: path.join(shots, 'context-config.png'), fullPage: false }); }

  // Ejecutar.
  await page.waitForFunction(() => ![...document.querySelectorAll('#lab-context-folder .lab-run')][0].disabled, null, { timeout: 15000 });
  await folder.locator('.lab-run').click();
  await page.waitForFunction(() => [...document.querySelectorAll('#lab-context-folder .ctx-card')].every((c) => ['done', 'error'].includes(c.dataset.status)), null, { timeout: 120000 });
  const statuses = await cards.evaluateAll((cs) => cs.map((c) => `${c.dataset.status}: ${c.querySelector('.lab-status').textContent}`));
  assert.ok(statuses.every((s) => s.startsWith('done')), statuses.join('\n'));

  // V1 generó su sonido y su toma (en su capa); la de V3 (sin herramientas) no.
  assert.equal(await v1.locator('.lab-tools audio').count(), 1);
  assert.equal(await v1.locator('.ctx-layer').count(), 2); // animación + vid1
  assert.equal(await cards.nth(2).locator('.ctx-layer').count(), 1);
  if (shots) {
    // En el medio de la zona: se ven la toma (en el demo, un cuadro quieto) y la animación encima.
    await v1.locator('.lab-stage iframe').evaluate((f) => f.contentWindow.postMessage({ type: 'seek', frame: 60 }, '*'));
    await page.waitForTimeout(1200);
    await v1.locator('.lab-stage').scrollIntoViewIfNeeded();
    await v1.locator('.lab-stage').screenshot({ path: path.join(shots, 'context-stage.png') });
  }
  // Ocultar la toma y la animación: se manda al Player sin errores.
  await v1.locator('.ctx-layer').nth(1).getByLabel('Visible').uncheck();
  await v1.locator('.ctx-layer').nth(0).getByLabel('Visible').uncheck();
  await v1.locator('.ctx-layer').nth(0).getByLabel('Visible').check();

  // Comparación: filas que cambian resaltadas.
  const table = folder.locator('.ctx-table');
  await table.waitFor();
  assert.match(await table.locator('tr.ctx-diff').first().textContent(), /Herramientas|Cuadros/);
  assert.match(await table.textContent(), /S·opc I·opc A·obl V·obl/);
  await v1.getByRole('button', { name: '✓ Aprobar' }).click();
  await folder.getByRole('button', { name: 'Prefiero V1' }).click();
  if (shots) { await page.screenshot({ path: path.join(shots, 'context-results.png'), fullPage: false }); await v1.screenshot({ path: path.join(shots, 'context-card.png') }); }

  // Historial: agrupado por configuración, y el de Motion Design intacto.
  await folder.getByRole('tab', { name: 'Historial' }).click();
  await page.locator('#ctx-history .lab-stats').waitFor();
  assert.match(await page.locator('#ctx-history').textContent(), /S·opc I·opc A·obl V·obl/);
  const motion = await page.evaluate(() => JSON.parse(localStorage.getItem('lab.motion.experiments.v1')));
  assert.equal(motion[0].id, 'sentinel');
  assert.equal(JSON.parse(await page.evaluate(() => localStorage.getItem('lab.context.experiments.v1')))[0].preference, 'V1');
  if (shots) await page.screenshot({ path: path.join(shots, 'context-history.png'), fullPage: false });

  // Reabrir el experimento desde el historial.
  await page.locator('#ctx-history').getByRole('button', { name: 'Abrir' }).first().click();
  await page.waitForFunction(() => [...document.querySelectorAll('#lab-context-folder .ctx-card')].filter((c) => c.dataset.status === 'done').length === 3, null, { timeout: 60000 });

  // Mobile: sin scroll horizontal.
  await page.setViewportSize({ width: 390, height: 900 });
  const overflow = await page.evaluate(() => document.querySelector('#view-lab .raw-scroll').scrollWidth - document.querySelector('#view-lab .raw-scroll').clientWidth);
  assert.ok(overflow <= 1, `scroll horizontal en mobile: ${overflow}px`);
  if (shots) await page.screenshot({ path: path.join(shots, 'context-mobile.png'), fullPage: false });

  assert.deepEqual(errors, []);
  console.log('context-lab browser flow: ok');
} finally {
  await browser?.close();
  server?.kill();
  await rm(dir, { recursive: true, force: true });
}
