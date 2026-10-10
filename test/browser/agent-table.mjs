// Prueba de punta a punta de Laboratorio · Mesa de agentes en modo demo.
// PLAYWRIGHT_MODULE can point to the bundled Playwright installation.
import assert from 'node:assert/strict';
import { mkdtemp, cp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import net from 'node:net';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dir = await mkdtemp(path.join(tmpdir(), 'table-browser-'));
const reservation = net.createServer(); await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
const port = reservation.address().port; await new Promise((resolve) => reservation.close(resolve));
let server, browser; const errors = []; const requests = [];
try {
  for (const name of ['src', 'public', 'agents-film', 'package.json']) await cp(path.join(root, name), path.join(dir, name), { recursive: true });
  await symlink(path.join(root, 'node_modules'), path.join(dir, 'node_modules'));
  const brief = path.join(dir, 'brief.md'); await writeFile(brief, 'Brief privado: el café abre a las 7.');
  server = spawn(process.execPath, ['src/server.js'], { cwd: dir, env: { ...process.env, PORT: String(port), MOCK: '1', OPENROUTER_API_KEY: '', WAVESPEED_API_KEY: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`${base}/api/config`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 50)); }
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('request', (r) => { if (r.url().endsWith('/api/lab/table/turn')) requests.push(r.postDataJSON()); });
  await page.addInitScript(() => { localStorage.setItem('raw-mic', '0'); localStorage.setItem('story-mic', '0'); });
  await page.route('**/api/lab/models', (r) => r.fulfill({ json: { mock: true, models: [{ id: 'chosen/llm', name: 'Chosen LLM', prompt: 1, completion: 2 }], harness: { version: 'test', tools: { search: true } } } }));
  await page.goto(`${base}/#laboratorio`); await page.locator('#lab-home').waitFor({ state: 'visible' });
  await page.locator('#lab-home a[href="#laboratorio/mesa-de-agentes"]').click();
  await page.locator('#lab-table-folder').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#lab-motion-folder').isVisible(), false);
  assert.equal(await page.locator('#lab-cinematic-folder').isVisible(), false);
  assert.equal(await page.locator('.table-seat').count(), 4);

  // Sin configurar no arranca.
  await page.click('#table-start');
  assert.match(await page.locator('#table-error').textContent(), /misión final/);

  await page.fill('#table-name', 'Spot cafetería');
  await page.fill('#table-goal', 'Un guion de 30 s para la cafetería, plano por plano.');
  for (const [seat, name] of [['a', 'Guionista'], ['b', 'Directora'], ['c', 'Fotografía'], ['d', 'Crítico']]) {
    await page.fill(`.seat-${seat} .table-agent-name`, name);
    await page.fill(`.seat-${seat} textarea >> nth=0`, `Misión de ${name}`);
  }
  await page.fill('.seat-a .lab-model', 'chosen/llm');
  await page.click('.seat-a >> text=Usar este modelo en los 4');
  assert.equal(await page.inputValue('.seat-d .lab-model'), 'chosen/llm');
  await page.setInputFiles('.seat-b input[type="file"]', brief);
  await page.locator('.seat-b .table-file').waitFor();
  assert.match(await page.locator('.seat-b .table-file').textContent(), /B1 · brief\.md/);

  // Ronda 1: los cuatro hablan una vez y la mesa se pausa.
  await page.click('#table-start');
  await page.locator('#table-continue').waitFor({ state: 'visible', timeout: 20000 });
  assert.equal(await page.locator('.table-entry:not(.user)').count(), 4);
  assert.equal(await page.locator('.seat-b input, .seat-b textarea').first().isDisabled(), true);
  const starter = requests[0].seat;
  assert.deepEqual(requests.map((r) => r.seat), [starter, ...['A', 'B', 'C', 'D', 'A', 'B', 'C'].slice('ABCD'.indexOf(starter) + 1, 'ABCD'.indexOf(starter) + 4)]);
  assert.ok(requests.every((r) => r.files.some((f) => f.code === 'B1' && f.data.includes('Brief privado'))));

  // Intervenciones: una privada para C y una para toda la mesa.
  await page.fill('.seat-c .table-say textarea', 'Solo para C: pensá en luz de mañana.');
  await page.click('.seat-c .table-say button[type="submit"]');
  await page.fill('#table-say-text', 'Para todos: el logo es naranja.');
  await page.click('#table-say button[type="submit"]');
  assert.equal(await page.locator('.table-entry.user').count(), 3);

  // Rondas 2 y 3 (en demo, D pasa en la 2 y todos dan por resuelta la misión en la 3).
  await page.click('#table-continue');
  await page.locator('#table-continue').waitFor({ state: 'visible', timeout: 20000 });
  assert.equal(await page.locator('.table-entry.pass').count(), 1);
  await page.click('#table-continue');
  await page.waitForFunction(() => document.getElementById('table-progress').textContent.includes('de acuerdo'), null, { timeout: 20000 });
  const lastTurn = requests.at(-1);
  assert.equal(lastTurn.log.filter((e) => e.type === 'user' && e.to === 'C').length, 1);

  // Al continuar, el relator redacta la entrega final.
  await page.click('#table-continue');
  await page.locator('#table-final .table-final-text').waitFor({ timeout: 20000 });
  await page.waitForFunction(() => document.querySelector('#table-final').textContent.includes('Relator'));
  assert.equal(requests.at(-1).kind, 'synthesis');
  assert.equal(requests.at(-1).reason, 'consensus');
  assert.match(await page.locator('#table-final').textContent(), /Entrega final/);
  assert.equal(await page.locator('#table-say-text').isDisabled(), true);
  await page.screenshot({ path: process.env.SCREENSHOT || path.join(dir, 'table.png'), fullPage: true });
  if (process.env.SCREENSHOT) { await page.locator('.table-log-card').scrollIntoViewIfNeeded(); await page.screenshot({ path: process.env.SCREENSHOT.replace('.png', '-log.png') }); }

  // Se guarda en el navegador: al recargar sigue ahí y aparece en el historial.
  await page.reload(); await page.locator('#table-final').waitFor({ state: 'visible' });
  assert.equal(await page.locator('.table-entry:not(.user)').count(), 12);
  await page.click('#table-history-toggle');
  assert.match(await page.locator('#table-history').textContent(), /Spot cafetería/);
  await page.setViewportSize({ width: 390, height: 900 });
  await page.click('#table-history-toggle');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'sin scroll horizontal en móvil');
  assert.deepEqual(errors, []);
  console.log('Mesa de agentes: OK');
} finally {
  await browser?.close(); server?.kill(); await rm(dir, { recursive: true, force: true });
}
