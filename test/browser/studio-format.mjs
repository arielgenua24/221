// PLAYWRIGHT_MODULE can point to an installed Playwright package.
import assert from 'node:assert/strict';
import { mkdtemp, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import net from 'node:net';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dir = await mkdtemp(path.join(tmpdir(), 'studio-format-'));
const reservation = net.createServer();
await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
const port = reservation.address().port;
await new Promise((resolve) => reservation.close(resolve));
let server, browser;
const errors = [];
try {
  for (const name of ['src', 'public', 'agents-film', 'package.json']) await cp(path.join(root, name), path.join(dir, name), { recursive: true });
  server = spawn(process.execPath, ['src/server.js'], { cwd: dir, env: { ...process.env, PORT: String(port), MOCK: '1', OPENROUTER_API_KEY: '', WAVESPEED_API_KEY: '' }, stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${base}/api/config`)).ok) break; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
    for (const [width, height] of [[640, 360], [400, 400], [360, 640], [180, 720]]) {
      const page = await browser.newPage({ viewport });
      page.on('pageerror', (e) => errors.push(e.message));
      await page.addInitScript(() => {
        localStorage.setItem('raw-mic', '0'); localStorage.setItem('story-mic', '0');
      });
      await page.route('https://fonts.googleapis.com/**', (route) => route.fulfill({ body: '' }));
      await page.goto(`${base}/#estudio`);
      await page.locator('[data-mode="intuition"]').click();
      // Distinct colors at all four edges reveal any unintended center crop.
      const fixture = await page.evaluate(async ({ width, height }) => {
        const canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, width, height);
        ctx.fillStyle = '#f00'; ctx.fillRect(0, 0, width * .2, height);
        ctx.fillStyle = '#00f'; ctx.fillRect(width * .8, 0, width * .2, height);
        ctx.fillStyle = '#ff0'; ctx.fillRect(width * .2, 0, width * .6, height * .2);
        ctx.fillStyle = '#0f0'; ctx.fillRect(width * .2, height * .8, width * .6, height * .2);
        const stream = canvas.captureStream(30);
        const rec = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' });
        const chunks = [];
        rec.ondataavailable = (e) => chunks.push(e.data);
        const stopped = new Promise((resolve) => { rec.onstop = resolve; });
        rec.start();
        const timer = setInterval(() => ctx.drawImage(canvas, 0, 0), 30);
        await new Promise((resolve) => setTimeout(resolve, 1200));
        rec.stop(); await stopped; clearInterval(timer);
        stream.getTracks().forEach((track) => track.stop());
        const blob = new Blob(chunks, { type: 'video/webm' });
        window.formatFixture = URL.createObjectURL(blob);
        return btoa(String.fromCharCode(...new Uint8Array(await blob.arrayBuffer())));
      }, { width, height });
      await page.locator('#file').setInputFiles({ name: 'formato.webm', mimeType: 'video/webm', buffer: Buffer.from(fixture, 'base64') });
      await page.locator('.studio-video').waitFor();
      const preview = await page.locator('.studio-video').evaluate((v) => ({ width: v.clientWidth, height: v.clientHeight, text: v.parentElement.textContent }));
      assert.ok(Math.abs(preview.width / preview.height - width / height) < .01, JSON.stringify(preview));
      assert.ok(preview.height <= viewport.height * .56 + 2, 'preview fits viewport');
      assert.ok(!preview.text.includes('recortar al centro'));
      await page.evaluate(async ({ width, height }) => {
        const { createMotionPlayer } = await import('/intuition-player.js');
        const { openVideo } = await import('/media.js');
        const v = await openVideo(window.formatFixture);
        window.formatPlayer = createMotionPlayer({ video: { url: window.formatFixture, name: 'formato.webm', width, height, duration: v.duration }, clips: [], direction: { sistema: { tipografias: { display: 'Inter', texto: 'Inter' }, paleta: [] } } });
        document.getElementById('feed').append(window.formatPlayer.root);
      }, { width, height });
      await page.waitForFunction(() => document.querySelector('.motion-stage canvas')?.getContext('2d').getImageData(5, 5, 1, 1).data[0] > 200);
      const stage = await page.locator('.motion-stage').evaluate((s) => ({ width: s.clientWidth, height: s.clientHeight, w: s.querySelector('canvas').width, h: s.querySelector('canvas').height }));
      assert.deepEqual([stage.w, stage.h], [width, height]);
      assert.ok(Math.abs(stage.width / stage.height - width / height) < .01, JSON.stringify(stage));
      assert.ok(stage.height <= viewport.height * .7 + 2, 'stage fits viewport');
      await page.getByRole('button', { name: 'Exportar video con motion', exact: true }).click();
      await page.locator('.intuition-player .export-note a').waitFor();
      const exported = await page.evaluate(async () => {
        const { openVideo } = await import('/media.js');
        const v = await openVideo(document.querySelector('.intuition-player .export-note a').href);
        const c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight;
        const ctx = c.getContext('2d'); ctx.drawImage(v, 0, 0);
        const colors = [[.05, .5], [.95, .5], [.5, .05], [.5, .95]].map(([x, y]) => [...ctx.getImageData(Math.floor(x * c.width), Math.floor(y * c.height), 1, 1).data].slice(0, 3));
        return { width: v.videoWidth, height: v.videoHeight, colors };
      });
      assert.deepEqual([exported.width, exported.height], [width, height]);
      for (const [i, target] of [[255, 0, 0], [0, 0, 255], [255, 255, 0], [0, 255, 0]].entries()) {
        assert.ok(exported.colors[i].every((value, k) => Math.abs(value - target[k]) < 60), JSON.stringify(exported));
      }
      console.log(`OK ${width}×${height}, viewport ${viewport.width}: preview, stage, exported dimensions and all four edges`);
      if (width === 400 && viewport.width === 1280) {
        // A generated square take must stay complete inside a landscape project.
        const fitted = await page.evaluate(async () => {
          const { createMotionPlayer } = await import('/intuition-player.js');
          const { createCineRenderer } = await import('/cine-lib.js');
          const { openVideo } = await import('/media.js');
          const source = await openVideo(window.formatFixture);
          const player = createMotionPlayer({ video: { url: window.formatFixture, name: 'generated.webm', width: 640, height: 360, duration: source.duration }, clips: [{ id: 'C1', mode: 'ai', start: 0, end: source.duration }], direction: { clips: [], sistema: { tipografias: { display: 'Inter', texto: 'Inter' }, paleta: [] } } });
          document.getElementById('feed').append(player.root);
          await player.setAiVideo({ id: 'C1', url: window.formatFixture });
          await new Promise((resolve) => setTimeout(resolve, 150));
          const sample = (canvas) => {
            const out = document.createElement('canvas'); out.width = 640; out.height = 360;
            const ctx = out.getContext('2d'); ctx.drawImage(canvas, 0, 0);
            return [[20, 180], [150, 180], [490, 180], [320, 18], [320, 342]].map(([x, y]) => [...ctx.getImageData(x, y, 1, 1).data].slice(0, 3));
          };
          const renderer = createCineRenderer(640, 360);
          if (!renderer) throw new Error('WebGL unavailable');
          renderer.render(source, { cam: [1, 0, 0, 0], shadow: [0, 0, 0, 0], high: [0, 0, 0, 0], light: [0, 0, 0, 0], lightCol: [0, 0, 0], exp: 0, con: 0, sat: 0, temp: 0, tint: 0, black: 0, hal: 0, vig: 0, grain: 0, time: 0, lightMode: 1 });
          return { ai: sample(player.root.querySelector('canvas')), cine: sample(renderer.canvas) };
        });
        for (const colors of Object.values(fitted)) {
          for (const [i, target] of [[0, 0, 0], [255, 0, 0], [0, 0, 255], [255, 255, 0], [0, 255, 0]].entries()) {
            assert.ok(colors[i].every((value, k) => Math.abs(value - target[k]) < 60), JSON.stringify(fitted));
          }
        }
        console.log('OK generated square take: full image and black side bands in Canvas 2D and Cinematic Pro');
      }
      await page.close();
    }
  }
  assert.deepEqual(errors, []);
} finally {
  await browser?.close();
  server?.kill();
  await rm(dir, { recursive: true, force: true });
}
