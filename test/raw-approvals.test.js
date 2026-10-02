import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRawApprovals, explicitApproval } from '../src/raw-approvals.js';
import { createRawStore } from '../src/raw-store.js';
import { runRawTurn, runRawGeneration, parseRawTurnBody } from '../src/raw-agent.js';
import { createMockWaveSpeed } from '../src/wavespeed.js';
import { mockLLM } from '../src/mock.js';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const config = { rawModel: 'test/model', imageModel: 'original/model', imageQuality: 'high' };
async function fixture(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'raw-approval-'));
  const store = createRawStore(path.join(dir, 'raw'));
  const folder = await store.createFolder({ name: 'Preview' });
  await store.addAsset({ folderId: folder.id, kind: 'persona', dataUrl: PNG });
  await store.addAsset({ folderId: folder.id, kind: 'referencia', dataUrl: PNG });
  const fake = createMockWaveSpeed({ mediaDir: store.filesDir });
  let uploads = 0, submissions = 0, submitted;
  const ws = { upload(...args) { uploads++; return fake.upload(...args); }, image(args) { submissions++; submitted = args; return fake.image(args); } };
  const options = { dir: path.join(dir, 'approvals'), generate: (plan, emit) => runRawGeneration({ store, plan, ws, emit }) };
  const service = createRawApprovals(options);
  const input = parseRawTurnBody({ folderId: folder.id, text: 'hazme esta persona con este estilo', imageGenerator: 'seedream', aspect: '3:4' });
  const events = [];
  const log = await runRawTurn({ store, input, config, emit: (e) => events.push(e), llm: mockLLM, propose: (p) => service.propose(p) });
  const decision = { folderId: folder.id, proposalId: log.proposal.id, viewerId: 'viewer-123', action: 'approve' };
  try { await fn({ dir, store, service, options, log, input, events, decision, stats: () => ({ uploads, submissions, submitted }) }); }
  finally { await service.idle(); await rm(dir, { recursive: true, force: true }); }
}

test('RAW no sube ni paga hasta que el modal se vio y llegó la aprobación; doble confirmación envía una vez', () => fixture(async ({ service, log, input, events, decision, stats }) => {
  assert.equal(stats().uploads, 0); assert.equal(stats().submissions, 0);
  assert.ok(events.some((e) => e.type === 'raw_listen'));
  assert.ok(events.some((e) => e.type === 'raw_proposal'));
  assert.equal(log.generation, undefined);
  assert.deepEqual(log.proposal.codes, ['P1', 'R1']);
  await assert.rejects(service.decide(decision), /modal/);
  await service.seen(input.folderId, log.proposal.id, decision.viewerId);
  await Promise.all([service.decide(decision), service.decide(decision)]);
  await service.idle();
  assert.equal(stats().submissions, 1);
  assert.equal(stats().submitted.model, 'bytedance/seedream-v5.0-pro/edit');
  assert.equal(stats().submitted.body.aspect_ratio, '3:4');
  assert.equal(stats().submitted.body.quality, undefined);
  const { jobs } = await service.list(input.folderId);
  assert.equal(jobs[0].status, 'done');
  assert.equal(jobs[0].events.at(-1).type, 'raw_generated');
}));

test('rechazo y aprobación con feedback no gastan; no se acepta una propuesta de otro proyecto', () => fixture(async ({ service, log, decision, stats }) => {
  await service.seen(decision.folderId, log.proposal.id, decision.viewerId);
  await assert.rejects(service.decide({ ...decision, feedback: 'Cambiar el fondo' }), /cambios/);
  await assert.rejects(service.decide({ ...decision, folderId: 'otro-proyecto' }), /pertenece/);
  await service.decide({ ...decision, action: 'reject' });
  await assert.rejects(service.decide(decision), /cambió/);
  assert.equal(stats().submissions, 0);
}));

test('feedback prepara otra revisión y exige ver/confirmar el nuevo modal; la aprobación vieja queda inválida', () => fixture(async ({ service, options, input, decision, stats }) => {
  const pending = await service.pending(input.folderId);
  const stored = JSON.parse(await readFile(path.join(options.dir, 'proposals.json'), 'utf8'))[0];
  const revised = await service.propose({ ...stored, summary: 'Conservar el fondo y cambiar sólo la luz' }, pending.id);
  await assert.rejects(service.decide(decision), /cambió/);
  await assert.rejects(service.decide({ ...decision, proposalId: revised.id }), /modal/);
  assert.equal(stats().submissions, 0);
}));

test('las referencias borradas fallan antes de subir o generar; un reinicio nunca reintenta una imagen', () => fixture(async ({ service, options, store, decision, stats }) => {
  await service.seen(decision.folderId, decision.proposalId, decision.viewerId);
  await store.deleteAsset('R1');
  await service.decide(decision); await service.idle();
  assert.equal(stats().uploads, 0); assert.equal(stats().submissions, 0);
  const saved = JSON.parse(await readFile(path.join(options.dir, 'proposals.json'), 'utf8'));
  saved[0].status = 'generating';
  await writeFile(path.join(options.dir, 'proposals.json'), JSON.stringify(saved));
  const restarted = createRawApprovals({ ...options, generate() { throw new Error('No reintentar'); } });
  const { jobs } = await restarted.list(decision.folderId);
  assert.equal(jobs[0].status, 'error'); assert.match(jobs[0].error, /reinició/);
  await assert.rejects(restarted.decide(decision), /cambió/);
}));

test('aprobación por voz exige una afirmación del plan; “sí, pero…” y preguntas no pagan', () => fixture(async ({ service, decision, stats }) => {
  await service.seen(decision.folderId, decision.proposalId, decision.viewerId);
  for (const text of ['sí, pero cambia el fondo', 'no generes todavía', '¿si apruebo, qué va a hacer?', 'sí, tengo una pregunta', 'sí, quiero el fondo rojo']) {
    await assert.rejects(service.decide({ ...decision, source: 'voice', text }), /explícita/);
  }
  assert.equal(stats().submissions, 0);
  await service.decide({ ...decision, source: 'voice', text: 'Sí, dale, generá la imagen.' });
  await service.idle(); assert.equal(stats().submissions, 1);
  for (const text of ['Perfecto, hacelo', 'Me parece bien, de acuerdo', 'Sí, apruebo este plan']) assert.equal(explicitApproval(text), true, text);
}));

test('una petición de generar sin servicio de propuestas nunca puede saltar la aprobación', () => fixture(async ({ store, input, stats }) => {
  await assert.rejects(runRawTurn({ store, input, config, llm: mockLLM, emit() {} }), /aprobación previa/);
  assert.equal(stats().submissions, 0);
}));
