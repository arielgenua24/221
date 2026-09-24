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
