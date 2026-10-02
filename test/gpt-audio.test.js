import test from 'node:test';
import assert from 'node:assert/strict';
import { streamAudioChat } from '../src/gpt-audio.js';
import { PCMDecoder, VoiceActivity, wavBase64 } from '../public/voice-audio.js';
import { parseVoiceBody } from '../src/voice-session.js';

const sse = (...chunks) => chunks.map((c) => `data: ${typeof c === 'string' ? c : JSON.stringify(c)}\r\n\r\n`).join('');
const response = (text) => {
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream({ start(controller) { for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7)); controller.close(); } }));
};
test('audio OpenRouter: SSE cortado, transcripción del asistente, PCM y herramientas fragmentadas', async () => {
  let sent;
  const audio = [], spoken = [];
  const out = await streamAudioChat({ apiKey: 'test', messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: 'test', format: 'wav' } }] }], tools: [{ type: 'function' }],
    onAudio: (data) => audio.push(data), onTranscript: (text) => spoken.push(text),
    fetchImpl: async (url, opts) => {
      sent = JSON.parse(opts.body); assert.equal(opts.headers.Authorization, 'Bearer test');
      return response(sse({ choices: [{ delta: { audio: { data: 'AQ', transcript: 'Sí, ' }, tool_calls: [{ index: 0, id: 'call1', function: { name: 'record_user', arguments: '{"text":' } }] } }] },
        { choices: [{ delta: { audio: { data: 'ACAA==', transcript: 'te escucho.' }, tool_calls: [{ index: 0, function: { arguments: '"hola"}' } }] } }], usage: { total_tokens: 8 } }, '[DONE]'));
    },
  });
  assert.deepEqual(sent.modalities, ['text', 'audio']);
  assert.equal(sent.audio.format, 'pcm16'); assert.equal(sent.model, 'openai/gpt-audio-mini');
  assert.deepEqual(audio, ['AQ', 'ACAA==']); assert.equal(spoken.join(''), 'Sí, te escucho.');
  assert.equal(out.toolCalls[0].function.arguments, '{"text":"hola"}'); assert.equal(out.usage.total_tokens, 8);
});
test('audio no reintenta ni oculta errores del proveedor o streams incompletos', async () => {
  await assert.rejects(streamAudioChat({ apiKey: '', messages: [] }), /OPENROUTER_API_KEY/);
  await assert.rejects(streamAudioChat({ apiKey: 'k', messages: [], fetchImpl: async () => new Response('{"error":{"message":"model unavailable"}}', { status: 503 }) }), /503.*unavailable/);
  await assert.rejects(streamAudioChat({ apiKey: 'k', messages: [], fetchImpl: async () => response(sse({ error: { message: 'audio rejected' } })) }), /audio rejected/);
  await assert.rejects(streamAudioChat({ apiKey: 'k', messages: [], fetchImpl: async () => response(sse({ choices: [{ delta: { audio: { data: 'AQACAA==' } } }] })) }), /Se cortó/);
});
test('WAV del navegador es PCM16 mono 24 kHz válido; rechaza contexto y audio incorrectos', () => {
  const data = wavBase64([new Float32Array(4800).fill(0.5)], 48000);
  const bytes = Buffer.from(data, 'base64');
  assert.equal(bytes.readUInt32LE(24), 24000); assert.equal(bytes.length, 44 + 2400 * 2); assert.equal(bytes.readInt16LE(44), 16384);
  const input = { kind: 'raw', id: 'project-123', audio: { data, format: 'wav' } };
  assert.equal(parseVoiceBody(input).audio.data, data);
  assert.throws(() => parseVoiceBody({ ...input, text: 'hola' }), /por turno/);
  assert.throws(() => parseVoiceBody({ ...input, id: '../secrets' }), /inválido/);
  assert.throws(() => parseVoiceBody({ ...input, audio: { data, format: 'webm' } }), /WAV/);
  bytes.writeUInt32LE(16000, 24);
  assert.throws(() => parseVoiceBody({ ...input, audio: { data: bytes.toString('base64'), format: 'wav' } }), /24 kHz/);
  const capped = Buffer.from(wavBase64([new Float32Array(24000 * 31)], 24000), 'base64');
  assert.equal(capped.length, 44 + 24000 * 30 * 2);
});
test('PCM se reproduce correctamente aunque los fragmentos separen base64 y muestras', () => {
  const bytes = Buffer.from([0, 128, 0, 0, 255, 127, 0, 192, 1, 0]);
  const encoded = bytes.toString('base64');
  for (let split = 1; split < encoded.length; split++) {
    const decoder = new PCMDecoder();
    const samples = [...decoder.push(encoded.slice(0, split)), ...decoder.push(encoded.slice(split), true)];
    assert.deepEqual(samples, [-1, 0, 32767 / 32768, -0.5, 1 / 32768]);
  }
  const decoder = new PCMDecoder();
  assert.deepEqual([...decoder.push(bytes.subarray(0, 3).toString('base64')), ...decoder.push(bytes.subarray(3).toString('base64'), true)], [-1, 0, 32767 / 32768, -0.5, 1 / 32768]);
  assert.throws(() => new PCMDecoder().push('AA==', true), /incompleto/);
});
test('detección de turnos ignora un golpe, interrumpe con voz sostenida y cierra por silencio', () => {
  const vad = new VoiceActivity(24000), voice = new Float32Array(1200).fill(0.1), silent = new Float32Array(1200);
  assert.deepEqual(vad.push(voice), {}); assert.deepEqual(vad.push(silent), {});
  for (let i = 0; i < 3; i++) assert.deepEqual(vad.push(voice), {});
  assert.equal(vad.push(voice).started, true);
  for (let i = 0; i < 14; i++) assert.equal(vad.push(silent).chunks, undefined);
  assert.ok(vad.push(silent).chunks.length); assert.equal(vad.recording, false);
});
