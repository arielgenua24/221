import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { streamChat } from '../src/openrouter.js';

test('streamChat parsea el SSE de OpenRouter (contenido, razonamiento, uso y keep-alive)', async () => {
  let received;
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    received = { auth: req.headers.authorization, body: JSON.parse(body) };
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    res.write(': OPENROUTER PROCESSING\n\n');
    send({ choices: [{ delta: { reasoning: 'pienso' } }] });
    const payload = 'Hola ```json\n{"ok":true}\n```';
    // corta el mensaje en trozos, incluso en medio de una línea SSE
    const raw = `data: ${JSON.stringify({ choices: [{ delta: { content: payload } }] })}\n\n`;
    res.write(raw.slice(0, 20)); res.write(raw.slice(20));
    send({ choices: [{ delta: {} }], usage: { total_tokens: 10, cost: 0.001 } });
    res.end('data: [DONE]\n\n');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${server.address().port}`;
  const deltas = []; const thoughts = [];
  const out = await streamChat({ apiKey: 'k', model: 'm', messages: [], maxTokens: 10, plugins: [{ id: 'web' }], onDelta: (t) => deltas.push(t), onReasoning: (t) => thoughts.push(t) });
  server.close();
  assert.equal(out.text, 'Hola ```json\n{"ok":true}\n```');
  assert.deepEqual(thoughts, ['pienso']);
  assert.equal(out.usage.cost, 0.001);
  assert.equal(received.auth, 'Bearer k');
  assert.equal(received.body.stream, true);
  assert.deepEqual(received.body.plugins, [{ id: 'web' }]);
});

test('streamChat reporta errores HTTP con el modelo', async () => {
  const server = http.createServer((req, res) => { res.writeHead(404); res.end('{"error":"model not found"}'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${server.address().port}`;
  await assert.rejects(streamChat({ apiKey: 'k', model: 'x/y', messages: [] }), /404 \(x\/y\).*model not found/);
  server.close();
});

test('streamChat reintenta el 429 del proveedor y respeta Retry-After', async () => {
  let llamadas = 0;
  const server = http.createServer((req, res) => {
    llamadas++;
    if (llamadas < 3) {
      res.writeHead(429, { 'Retry-After': '0' });
      res.end('{"error":{"message":"Provider returned error","code":429,"metadata":{"raw":"temporarily rate-limited upstream","provider_name":"Google"}}}');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'listo' } }] })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${server.address().port}`;
  const esperas = [];
  const out = await streamChat({ apiKey: 'k', model: 'g/f', messages: [], onRetry: (i) => esperas.push(i) });
  server.close();
  assert.equal(out.text, 'listo');
  assert.equal(llamadas, 3);
  assert.deepEqual(esperas.map((e) => e.status), [429, 429]);
  assert.deepEqual(esperas.map((e) => e.waitMs), [0, 0]);
  assert.match(esperas[0].message, /Provider returned error — temporarily rate-limited upstream — proveedor: Google/);
});

test('streamChat se rinde tras agotar los reintentos y marca el error como pasajero', async () => {
  const server = http.createServer((req, res) => { res.writeHead(503, { 'Retry-After': '0' }); res.end('{"error":{"message":"no capacity"}}'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${server.address().port}`;
  const err = await streamChat({ apiKey: 'k', model: 'x/y', messages: [], retries: 1 }).then(() => null, (e) => e);
  server.close();
  assert.match(err.message, /OpenRouter 503 \(x\/y\): no capacity/);
  assert.equal(err.transient, true);
  assert.equal(err.status, 503);
});

test('streamChat no reintenta si el modelo ya empezó a escribir', async () => {
  let llamadas = 0;
  const server = http.createServer((req, res) => {
    llamadas++;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ya escribí' } }] })}\n\n`);
    res.end(`data: ${JSON.stringify({ error: { message: 'se cayó el proveedor', code: 429 } })}\n\n`);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${server.address().port}`;
  const err = await streamChat({ apiKey: 'k', model: 'x/y', messages: [] }).then(() => null, (e) => e);
  server.close();
  assert.equal(llamadas, 1);
  assert.equal(err.streamed, true);
  assert.equal(err.transient, false);
});

test('streamChat no reintenta un 404 (el modelo no existe)', async () => {
  let llamadas = 0;
  const server = http.createServer((req, res) => { llamadas++; res.writeHead(404); res.end('{"error":{"message":"model not found"}}'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${server.address().port}`;
  await assert.rejects(streamChat({ apiKey: 'k', model: 'x/y', messages: [] }), /404 \(x\/y\).*model not found/);
  server.close();
  assert.equal(llamadas, 1);
});
