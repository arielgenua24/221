// No model or paid API calls. Uses a locally recorded solid-color video and authored animation fixtures.
// Run with PLAYWRIGHT_MODULE pointing to an existing Playwright installation if it is not installed locally.
import assert from 'node:assert/strict';
import http from 'node:http';
import { getEngine } from '../../src/engines/index.js';
import { mixedCanvas, mixedRemotion, mixedZones } from '../fixtures/mixed-composition.js';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end('<!doctype html><style>body{margin:0}iframe{display:block;border:0}</style><iframe sandbox="allow-scripts"></iframe>');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
let browser;
// Allow lossy video encoding/color conversion while still distinguishing background, video, and artwork.
const near = (actual, expected, label) => actual.slice(0, 3).forEach((n, i) => assert.ok(Math.abs(n - expected[i]) <= 24, `${label}: ${actual} vs ${expected}`));
const check = ({ corner, center }, t, label) => {
  near(corner, t >= 1.5 && t < 2.5 ? [20, 20, 19] : [34, 136, 68], `${label} corner at ${t}s`);
  near(center, t >= 0.5 && t < 3.5 ? [255, 90, 31] : [34, 136, 68], `${label} center at ${t}s`);
};
const times = [0.1, 0.75, 1.75, 2.75, 3.75];
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 800, height: 700 } });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  for (const [width, height] of [[320, 180], [180, 320]]) {
    // MediaRecorder makes a valid video without ffmpeg or external assets.
    await page.evaluate(async ({ width, height }) => {
      const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
      const g = canvas.getContext('2d');
      const draw = () => { g.fillStyle = '#228844'; g.fillRect(0, 0, width, height); };
      draw();
      const stream = canvas.captureStream(30);
      const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' });
      const chunks = []; recorder.ondataavailable = (e) => chunks.push(e.data);
      const stopped = new Promise((resolve) => recorder.onstop = resolve);
      recorder.start(); const timer = setInterval(draw, 16);
      await new Promise((resolve) => setTimeout(resolve, 4200));
      recorder.stop(); await stopped; clearInterval(timer); stream.getTracks().forEach((t) => t.stop());
      window.baseVideo = new Blob(chunks, { type: recorder.mimeType });
    }, { width, height });

    for (const engineId of ['canvas', 'remotion']) {
      const engine = getEngine(engineId);
      const { js } = await engine.compile(engineId === 'canvas' ? mixedCanvas : mixedRemotion, { width, height, duration: 4, fps: 30, zones: mixedZones });
      const html = await engine.frameDocument();
      await page.evaluate(({ html, width, height }) => {
        window.events = [];
        window.onmessage = (e) => { if (e.data?.source === 'lab-frame') window.events.push(e.data); };
        const frame = document.querySelector('iframe'); frame.width = width; frame.height = height; frame.srcdoc = html;
      }, { html, width, height });
      await page.waitForFunction(() => window.events.some((e) => e.type === 'boot'));
      await page.evaluate(({ js, width, height, zones }) => {
        document.querySelector('iframe').contentWindow.postMessage({ type: 'load', js, video: window.baseVideo, meta: { width, height, duration: 4, fps: 30 }, zones, images: {}, transform: { scale: 1, x: 0, y: 0 } }, '*');
      }, { js, width, height, zones: mixedZones });
      await page.waitForFunction(() => window.events.some((e) => e.type === 'checked' || e.type === 'error'), null, { timeout: 30000 });
      const errors = await page.evaluate(() => window.events.filter((e) => e.type === 'error' || e.type === 'checked' && !e.ok));
      assert.deepEqual(errors, [], `${engineId} playback errors`);
      for (const t of times) {
        const target = Math.round(t * 30);
        await page.evaluate((frame) => { window.events = []; document.querySelector('iframe').contentWindow.postMessage({ type: 'seek', frame }, '*'); }, target);
        await page.waitForFunction((frame) => window.events.some((e) => e.type === 'frame' && Math.abs(e.frame - frame) <= 1), target);
        const png = await page.locator('iframe').screenshot();
        const pixels = await page.evaluate(async (base64) => {
          const image = new Image(); image.src = `data:image/png;base64,${base64}`; await image.decode();
          const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
          const g = canvas.getContext('2d'); g.drawImage(image, 0, 0);
          const pixel = (x, y) => [...g.getImageData(x, y, 1, 1).data];
          return { corner: pixel(4, 4), center: pixel(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2)) };
        }, png.toString('base64'));
        check(pixels, t, `${engineId} ${width}×${height} playback`);
      }
      // Export one aspect ratio per engine and inspect the actual encoded frames as well.
      if (width === 320) {
        await page.evaluate(() => { window.events = []; document.querySelector('iframe').contentWindow.postMessage({ type: 'render' }, '*'); });
        await page.waitForFunction(() => window.events.some((e) => ['rendered', 'render_error'].includes(e.type)), null, { timeout: 60000 });
        const samples = await page.evaluate(async (times) => {
          const result = window.events.find((e) => ['rendered', 'render_error'].includes(e.type));
          if (result.type === 'render_error' || result.overlay) throw new Error(result.message || 'Only an overlay was exported');
          const video = document.createElement('video'); video.muted = true; video.src = URL.createObjectURL(result.blob);
          await new Promise((resolve, reject) => { video.onloadeddata = resolve; video.onerror = reject; });
          const canvas = document.createElement('canvas'); canvas.width = video.videoWidth; canvas.height = video.videoHeight;
          const g = canvas.getContext('2d'); const samples = [];
          for (const t of times) {
            await new Promise((resolve) => { video.onseeked = resolve; video.currentTime = t; });
            g.drawImage(video, 0, 0); const pixel = (x, y) => [...g.getImageData(x, y, 1, 1).data];
            samples.push({ corner: pixel(4, 4), center: pixel(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2)) });
          }
          URL.revokeObjectURL(video.src); return samples;
        }, times);
        samples.forEach((pixels, i) => check(pixels, times[i], `${engineId} export`));
      }
      console.log(`${engineId} ${width}×${height}: add-on → fullscreen → add-on verified${width === 320 ? ' in playback and export' : ' in playback'}`);
    }
  }
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
