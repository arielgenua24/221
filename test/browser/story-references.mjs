// Run with PLAYWRIGHT_MODULE pointing to an installed Playwright package.
import assert from 'node:assert/strict';
import { mkdtemp, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import net from 'node:net';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dir = await mkdtemp(path.join(tmpdir(), 'story-browser-'));
const reservation = net.createServer();
await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
const port = reservation.address().port;
await new Promise((resolve) => reservation.close(resolve));
let server, browser;
const errors = [];
try {
  for (const name of ['src', 'public', 'agents-film', 'package.json']) await cp(path.join(root, name), path.join(dir, name), { recursive: true });
  server = spawn(process.execPath, ['src/server.js'], { cwd: dir, env: { ...process.env, PORT: String(port), MOCK: '1', OPENROUTER_API_KEY: '', WAVESPEED_API_KEY: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${base}/api/config`)).ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
  const api = async (url, body) => {
    const res = await fetch(base + url, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
    const data = await res.json(); assert.ok(res.ok, JSON.stringify(data)); return data;
  };
  const { folder } = await api('/api/raw/folders', { name: 'Prueba referencias' });
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const { asset: person } = await api('/api/raw/assets', { folderId: folder.id, kind: 'persona', name: 'Ana', dataUrl: png });
  const { asset: place } = await api('/api/raw/assets', { folderId: folder.id, kind: 'referencia', name: 'Bosque', dataUrl: png });
  const { project: p } = await api('/api/story/projects', { rawFolderId: folder.id, title: 'Historia A' });
  const { project: other } = await api('/api/story/projects', { rawFolderId: folder.id, title: 'Historia B' });
  assert.equal(p.assets.length, 0, 'no autoenlaza biblioteca al crear');
  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => {
    localStorage.setItem('story-mic', '0'); localStorage.setItem('raw-mic', '0');
    window.SpeechRecognition = class {
      start() { window.testRecognition = this; }
      abort() {}
    };
    window.speechSynthesis.speak = (u) => { queueMicrotask(() => u.onend?.()); };
  });
  await page.route('**/api/raw/speak', (route) => route.fulfill({ json: {} }));
  await page.goto(`${base}/#historia/${p.id}`);
  const personHit = () => page.locator('#story-library .raw-thumb-hit').filter({ has: page.locator('img[alt="Ana"]') });
  const placeHit = () => page.locator('#story-library .raw-thumb-hit').filter({ has: page.locator('img[alt="Bosque"]') });
  await personHit().waitFor();
  assert.equal(await page.locator('#story-library .selected').count(), 0);
  await personHit().click();
  assert.equal(await page.locator('#story-attachments img[alt="Ana"]').count(), 1);
  assert.equal((await api(`/api/story/project?id=${p.id}`)).project.assets.length, 0, 'seleccionar no vincula globalmente');
  await personHit().click();
  assert.equal(await page.locator('#story-attachments img').count(), 0);
  await personHit().click(); await placeHit().click();
  await page.locator('#story-attachments button[aria-label="Quitar Bosque del próximo mensaje"]').click();
  assert.equal(await page.locator('#story-attachments img').count(), 1);
  await page.locator('#story-text').fill('Esta persona camina por el bosque');
  await page.locator('#story-send').click();
  await page.waitForFunction(() => !document.querySelector('#story-send').classList.contains('stop'));
  assert.equal(await page.locator('#story-attachments img').count(), 0);
  assert.equal(await page.locator('#story-chat .me .story-message-refs img[alt="Ana"]').count(), 1);
  let saved = (await api(`/api/story/project?id=${p.id}`)).project;
  assert.deepEqual(saved.chat[0].references.map((a) => a.rawCode), [person.code]);
  await page.reload(); await personHit().waitFor();
  assert.equal(await page.locator('#story-library .selected').count(), 0);
  assert.equal(await page.locator('#story-chat .me .story-message-refs img[alt="Ana"]').count(), 1);
  await page.locator('#story-text').fill('Ahora continúa'); await page.locator('#story-send').click();
  await page.waitForFunction(() => !document.querySelector('#story-send').classList.contains('stop'));
  saved = (await api(`/api/story/project?id=${p.id}`)).project;
  assert.deepEqual(saved.chat.filter((m) => m.role === 'user').at(-1).references, []);
  // SpeechRecognition: snapshot at speech start, changed selections belong to next turn.
  await personHit().click(); await page.locator('#story-mic').click();
  await page.waitForFunction(() => !!window.testRecognition);
  await page.evaluate(() => window.testRecognition.onspeechstart());
  await placeHit().click();
  await page.evaluate(() => {
    window.testRecognition.onresult({ resultIndex: 0, results: [Object.assign([{ transcript: 'Esta persona saluda' }], { isFinal: true })] });
    window.testRecognition.onend();
  });
  await page.waitForFunction(() => document.querySelector('#story-send').classList.contains('stop'));
  await page.waitForFunction(() => !document.querySelector('#story-send').classList.contains('stop'));
  saved = (await api(`/api/story/project?id=${p.id}`)).project;
  assert.deepEqual(saved.chat.filter((m) => m.role === 'user').at(-1).references.map((a) => a.rawCode), [person.code]);
  assert.equal(await page.locator('#story-attachments img[alt="Bosque"]').count(), 1);
  await page.locator('#story-mic').click();
  // Switching histories isolates the pending draft while retaining it in the originating story.
  await page.locator('#story-back').click();
  await page.locator('.story-project').filter({ hasText: 'Historia B' }).click();
  await placeHit().waitFor();
  assert.equal(await page.locator('#story-attachments img').count(), 0);
  assert.equal(await page.locator('#story-chat .me').count(), 0);
  await page.locator('#story-back').click();
  await page.locator('.story-project').filter({ hasText: 'Historia A' }).click();
  await placeHit().waitFor();
  assert.equal(await page.locator('#story-attachments img[alt="Bosque"]').count(), 1);
  // GPT Audio UI: mock network, exercise real composer + voice controller integration.
  const voiceBodies = [];
  await page.route('**/api/voice/jobs?**', (route) => route.fulfill({ json: { jobs: [] } }));
  await page.route('**/api/voice/played', (route) => route.fulfill({ json: { ok: true } }));
  await page.route('**/api/voice/turn', (route) => {
    const body = route.request().postDataJSON(); voiceBodies.push(body);
    return route.fulfill({ contentType: 'application/x-ndjson', body: [
      { type: 'voice_start', turnId: 'gpt-ui-test' },
      { type: 'voice_user', text: body.text, references: body.references },
      { type: 'voice_transcript', text: 'Entendido.' },
      { type: 'voice_done', turnId: 'gpt-ui-test' },
    ].map((e) => JSON.stringify(e)).join('\n') + '\n' });
  });
  await page.locator('#view-story [data-voice-mode]').selectOption('gpt-audio');
  await page.locator('#story-text').fill('Usá este lugar'); await page.locator('#story-send').click();
  await page.waitForFunction(() => document.querySelector('#story-phase').textContent === 'Listo');
  assert.deepEqual(voiceBodies.at(-1).references.map((a) => a.rawCode), [place.code]);
  assert.equal(await page.locator('#story-attachments img').count(), 0);
  // Failure before acceptance must restore references and text, not silently lose the draft.
  await placeHit().click();
  await page.route('**/api/voice/turn', (route) => route.fulfill({ status: 400, json: { error: 'No se pudo enviar' } }));
  await page.locator('#story-text').fill('Reintentar'); await page.locator('#story-send').click();
  await page.locator('#story-error').filter({ hasText: 'No se pudo enviar' }).waitFor();
  assert.equal(await page.locator('#story-attachments img[alt="Bosque"]').count(), 1);
  assert.equal(await page.locator('#story-text').inputValue(), 'Reintentar');
  assert.deepEqual(errors, []);
  assert.equal((await api(`/api/story/project?id=${other.id}`)).project.chat.length, 0);
  console.log('PASS: UI mobile, toggle, compositor, texto, recarga, Gemini, GPT Audio, error e aislamiento.');
} finally {
  await browser?.close();
  if (server) { server.kill('SIGTERM'); await new Promise((resolve) => server.once('exit', resolve)); }
  await rm(dir, { recursive: true, force: true });
}
