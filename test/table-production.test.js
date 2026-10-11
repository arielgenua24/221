import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SEATS, toProduction, snapshot, totalCost, describeAsset, eachPart, findPart } from '../public/table-core.js';
import { imageSpec, voiceSpec, soundSpec, estimate, voiceBody, soundBody, createTableMedia, mediaUrlToData, demoSvg, wav } from '../src/table/media.js';
import { toolDefs, createTurnTools } from '../src/table/tools.js';
import { sanitizeDelivery, sanitizePart } from '../src/table/delivery.js';
import { parseTableRequest, buildTurnMessages, buildSynthesisMessages, buildPartMessages } from '../src/table/prompts.js';
import { createTableRoutes, pickDuration } from '../src/table/routes.js';
import { createVideoCatalog } from '../src/cinematic/models.js';
import { createCinematicJobs } from '../src/cinematic/jobs.js';

const agents = SEATS.map((seat) => ({ seat, name: `Agente ${seat}`, model: `model/${seat.toLowerCase()}`, mission: `Misión de ${seat}` }));
const textOf = (messages) => messages.map((m) => (typeof m.content === 'string' ? m.content : m.content.map((p) => p.text || '').join('\n'))).join('\n');
const asset = (code, kind, seat, spec, extra = {}) => ({ code, kind, seat, round: 1, url: `/media/${code.toLowerCase()}.${kind === 'image' ? 'png' : 'mp3'}`, spec, cost: 0.04, model: 'm', ...extra });
const IMG_ASSET = asset('G1', 'image', 'B', { prompt: 'A baker at dawn', referencias: [], proporcion: '9:16' });
const VOICE_ASSET = asset('G2', 'voice', 'A', { personaje: 'Lucía', texto: '[whispers] Hola', voz: 'Aria', estabilidad: 0.4 });
const SOUND_ASSET = asset('G3', 'sound', 'C', { prompt: 'Rain on a tin roof', tipo: 'ambiente', duracion: 5, loop: true });

test('Mesa · medios: las especificaciones validan, completan y estiman el costo', () => {
  assert.deepEqual(imageSpec({ prompt: '  a  cat ', referencias: ['m1', 'G2', 'x9', 'G2'], proporcion: '7:3' }, '16:9'), { prompt: 'a cat', referencias: ['M1', 'G2'], proporcion: '16:9' });
  assert.throws(() => imageSpec({ prompt: ' ' }), /prompt/);
  assert.deepEqual(voiceSpec({ texto: 'Hola', estabilidad: 3 }), { personaje: 'Narrador', texto: 'Hola', voz: 'Alice', estabilidad: 1 });
  assert.throws(() => voiceSpec({ texto: '' }), /texto/);
  assert.deepEqual(soundSpec({ prompt: 'Door', duracion: 99 }), { prompt: 'Door', tipo: 'efecto', duracion: 22, loop: false });
  assert.equal(soundSpec({ prompt: 'Piano', tipo: 'musica' }).loop, true);
  assert.equal(soundSpec({ prompt: 'x', duracion: 0.1 }).duracion, 0.5);
  assert.equal(estimate('image', { referencias: ['M1', 'M2'] }), 0.044);
  assert.equal(estimate('voice', { texto: 'x'.repeat(2000) }), 0.2);
  assert.equal(estimate('sound', {}), 0.03);
});

test('Mesa · medios: los cuerpos de ElevenLabs siguen el schema publicado (o los nombres documentados)', () => {
  const v = voiceSpec({ texto: 'Hola', voz: 'Aria', estabilidad: 0.3 });
  assert.deepEqual(voiceBody(v, null), { text: 'Hola', voice_id: 'Aria', stability: 0.3, similarity: 0.75 });
  assert.deepEqual(voiceBody(v, { text: {}, voice: {}, similarity_boost: {} }), { text: 'Hola', voice: 'Aria', stability: 0.3, similarity_boost: 0.75 });
  const s = soundSpec({ prompt: 'Door creak', duracion: 30 });
  assert.deepEqual(soundBody(s, null), { text: 'Door creak', duration: 22, loop: false, prompt_influence: 0.3 });
  assert.deepEqual(soundBody(s, { prompt: {}, duration: { minimum: 1, maximum: 10 } }), { prompt: 'Door creak', duration: 10 });
});

test('Mesa · medios: WaveSpeed recibe el modelo y el cuerpo de cada tipo y el resultado queda en /media', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mesa-media-'));
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), body: init.body && typeof init.body === 'string' ? JSON.parse(init.body) : null });
    if (String(url).endsWith('/api/v3/models')) return Response.json({ data: [{ model_id: 'elevenlabs/sound-effects-v2', api_schema: { api_schemas: [{ type: 'model_run', request_schema: { properties: { prompt: {}, duration: { minimum: 0.5, maximum: 22 }, loop: {} } } }] } }] });
    if (String(url).includes('/media/upload/binary')) return Response.json({ data: { download_url: 'https://cdn.example/ref.png' } });
    if (init.method === 'POST') return Response.json({ data: { id: 't1', urls: { get: 'https://api.example/result/t1' } } });
    if (String(url).includes('/result/')) return Response.json({ data: { status: 'completed', outputs: ['https://cdn.example/out.mp3'] } });
    return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'audio/mpeg' } });
  };
  try {
    const media = createTableMedia({ apiKey: 'k', mediaDir: dir, fetchImpl, pollMs: 1 });
    const sound = await media.generate('sound', soundSpec({ prompt: 'Rain', tipo: 'ambiente', duracion: 4 }));
    assert.match(sound.url, /^\/media\/[\w-]+\.mp3$/);
    const submit = calls.find((c) => c.url.endsWith('/elevenlabs/sound-effects-v2'));
    assert.deepEqual(submit.body, { prompt: 'Rain', duration: 4, loop: true });
    await media.generate('voice', voiceSpec({ texto: 'Hola', voz: 'Aria' }));
    assert.equal(calls.find((c) => c.url.endsWith('/elevenlabs/eleven-v4')).body.voice_id, 'Aria');
    await writeFile(path.join(dir, 'ref.png'), Buffer.from([137, 80]));
    await media.generate('image', imageSpec({ prompt: 'Cat', referencias: ['G1'] }), { resolve: async () => '/media/ref.png' });
    const edit = calls.find((c) => c.url.endsWith('/google/nano-banana-2.1/edit'));
    assert.deepEqual(edit.body.images, ['https://cdn.example/ref.png']);
    assert.equal(edit.body.aspect_ratio, '9:16');
    assert.match(await mediaUrlToData(dir, '/media/ref.png'), /^data:image\/png;base64,/);
    await assert.rejects(mediaUrlToData(dir, '/media/../secret.png'), /inválido/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('Mesa · medios: el demo produce piezas que se ven y se escuchan', async () => {
  assert.match(demoSvg({ prompt: 'A <b> & c', proporcion: '16:9' }), /viewBox="0 0 1024 576"[\s\S]*A &lt;b&gt; &amp; c/);
  const buf = wav(0.5, () => 0.5);
  assert.equal(buf.toString('ascii', 0, 4), 'RIFF');
  assert.equal(buf.length, 44 + 8000 * 2);
  const dir = await mkdtemp(path.join(tmpdir(), 'mesa-demo-'));
  try {
    const media = createTableMedia({ mediaDir: dir, mock: true });
    const out = await media.generate('voice', voiceSpec({ texto: 'Hola mundo' }));
    assert.equal(out.cost, 0); assert.equal(out.demo, true);
    assert.equal((await readFile(path.join(dir, path.basename(out.url)))).toString('ascii', 8, 12), 'WAVE');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

function turnReq(extra = {}) {
  return parseTableRequest({ kind: 'turn', seat: 'B', round: 2, goal: 'Spot de 15 s', agents, log: [], files: [], assets: [], budget: 0.1, aspect: '1:1', ...extra });
}
const fakeMedia = (calls = []) => ({ available: true, generate: async (kind, spec) => { calls.push({ kind, spec }); return { kind, url: `/media/out${calls.length}.png`, model: 'nano', cost: estimate(kind, spec), ms: 1 }; } });
const call = (name, args) => ({ id: 'c1', type: 'function', function: { name, arguments: JSON.stringify(args) } });

test('Mesa · herramientas: presupuesto, máximo por turno, códigos G y referencias que el agente ve', async () => {
  const defs = toolDefs({ aspect: '1:1' });
  assert.deepEqual(defs.map((d) => d.function.name), ['generar_imagen', 'generar_voz', 'generar_sonido']);
  assert.match(defs[0].function.description, /PRIMER cuadro/);
  const events = [];
  const gen = [];
  const req = turnReq({
    assets: [{ ...SOUND_ASSET, cost: 0.03 }],
    files: [{ code: 'M1', name: 'logo.png', kind: 'image', to: 'table', data: 'data:image/png;base64,AA' }, { code: 'C1', name: 'c.png', kind: 'image', to: 'C', data: 'data:image/png;base64,AA' }],
  });
  const tools = createTurnTools({ media: fakeMedia(gen), req, resolve: async () => null, emit: (e) => events.push(e) });
  assert.match((await tools.run(call('generar_imagen', { prompt: 'x', referencias: ['C1'] }))).text, /no hay imágenes C1/);
  const ok = await tools.run(call('generar_imagen', { prompt: 'A dog', referencias: ['M1'] }));
  assert.match(ok.text, /G4 \(la imagen\)/);
  assert.equal(ok.image.code, 'G4');
  assert.equal(gen[0].spec.proporcion, '1:1');
  assert.deepEqual(events.map((e) => e.type), ['tool', 'asset']);
  assert.equal(events[1].asset.seat, 'B');
  // 0.1 de presupuesto: ya se gastaron 0.03 + 0.042; otro sonido (0.03) no entra.
  assert.match((await tools.run(call('generar_sonido', { prompt: 'Rain', tipo: 'ambiente', duracion: 3 }))).text, /no alcanza el presupuesto/);
  assert.match((await tools.run(call('generar_voz', { personaje: 'A', texto: 'Hola', voz: 'Aria' }))).text, /G5/);
  assert.match((await tools.run(call('generar_voz', { personaje: 'A', texto: 'Hola', voz: 'Aria' }))).text, /máximo/);
  assert.match((await tools.run({ id: 'x', function: { name: 'borrar_todo', arguments: '{}' } })).text, /no existe/);
  assert.equal(tools.created.length, 2);
});

test('Mesa · prompts: el turno conoce lo generado (imágenes adjuntas, audios descritos) y sus herramientas', () => {
  const req = turnReq({ budget: 2, assets: [IMG_ASSET, VOICE_ASSET, SOUND_ASSET], log: [{ type: 'agent', seat: 'B', round: 1, action: 'speak', text: 'Propongo esto', assets: ['G1'] }] });
  req.toolsOn = true; req.toolBudget = 1.88;
  req.assetData = new Map([['G1', 'data:image/png;base64,G1']]);
  const msgs = buildTurnMessages(req);
  assert.match(msgs[0].content, /HERRAMIENTAS/); assert.match(msgs[0].content, /quedan US\$ 1\.88 de US\$ 2\.00/); assert.match(msgs[0].content, /FORMATO DE LA PIEZA: 1:1/);
  assert.match(msgs[0].content, /VIDEO no se genera durante la mesa/);
  const all = textOf(msgs);
  assert.match(all, /\(generó G1\) Propongo esto/);
  assert.match(all, /G2 · voz de A · Agente A \(ronda 1\): Lucía, voz Aria/);
  assert.match(all, /G3 · ambiente de C/);
  assert.equal(msgs[1].content.find((p) => p.type === 'image_url').image_url.url, 'data:image/png;base64,G1');
  const off = turnReq(); off.toolsOn = false;
  assert.match(buildTurnMessages(off)[0].content, /no podés generar piezas/);
  assert.match(describeAsset(SOUND_ASSET, agents), /5 s, loop/);
});

test('Mesa · entrega: tomas sanas, dueños, bases reales y duraciones dentro de 2 a 6 s', () => {
  const assets = [IMG_ASSET, VOICE_ASSET, SOUND_ASSET];
  const d = sanitizeDelivery({
    titulo: 'Spot', resumen: 'r', personajes: [{ nombre: 'Lucía', voz: 'Aria' }, { descripcion: 'sin nombre' }],
    tomas: [
      { titulo: 'Uno', duracion: 9, descripcion: 'Abre', cuadro: { dueno: 'b', prompt: 'otro prompt', base: 'G1' }, voz: { base: 'G2', texto: 'mal copiado' }, sonido: { base: 'G1', prompt: 'Door', dueno: 'C' }, video: { dueno: 'D', prompt: 'Push in', modelo: 'heygen' } },
      { titulo: 'Dos', duracion: 1, descripcion: 'Una toma sin cuadro', video: null },
      { titulo: 'Rota' },
      'basura',
    ],
    musica: { base: 'G3', dueno: 'C' },
  }, { aspect: '9:16', assets });
  assert.equal(d.shots.length, 2);
  const [s1, s2] = d.shots;
  assert.equal(s1.id, 'S1'); assert.equal(s1.duracion, 6); assert.equal(s2.duracion, 2);
  assert.deepEqual(s1.parts.cuadro.base, { code: 'G1', url: IMG_ASSET.url, cost: 0.04, model: 'm' });
  assert.equal(s1.parts.cuadro.spec.prompt, 'A baker at dawn', 'manda la pieza real, no lo que copió el relator');
  assert.equal(s1.parts.voz.owner, 'A', 'sin dueño: quien generó la base');
  assert.equal(s1.parts.voz.spec.texto, '[whispers] Hola');
  assert.equal(s1.parts.sonido.base, null, 'G1 es una imagen: no puede ser la base de un sonido');
  assert.equal(s1.parts.video.spec.modelo, 'heygen');
  assert.equal(s2.parts.cuadro.spec.prompt, 'Una toma sin cuadro', 'sin cuadro: sale de la descripción');
  assert.equal(s2.parts.video.spec.prompt, 'Una toma sin cuadro');
  assert.equal(d.musica, null, 'G3 es un ambiente, no música');
  assert.deepEqual(d.personajes.map((p) => p.nombre), ['Lucía']);
  assert.throws(() => sanitizeDelivery({ tomas: [] }), /ninguna toma/);
  assert.equal(sanitizePart('voz', { texto: '' }), null);
});

test('Mesa · producción: versiones, vista para el modelo y costo total', () => {
  const prod = toProduction(sanitizeDelivery({ tomas: [{ titulo: 'Uno', duracion: 5, cuadro: { prompt: 'Frame', base: 'G1', dueno: 'B' }, video: { prompt: 'Move' } }], musica: { prompt: 'Piano', dueno: 'C' } }, { assets: [IMG_ASSET] }));
  const frame = findPart(prod, 'S1', 'cuadro');
  assert.equal(frame.versions[0].result.from, 'G1');
  assert.equal(frame.versions[0].result.cost, 0, 'lo de la mesa ya se contó');
  assert.equal(eachPart(prod).length, 3);
  frame.versions.push({ spec: { ...frame.versions[0].spec, prompt: 'Frame v2' }, result: { url: '/media/x.png', cost: 0.04 } });
  frame.current = 1;
  findPart(prod, null, 'musica').thread.push({ role: 'agent', text: 'ok', usage: { cost: 0.01 } });
  const snap = snapshot(prod);
  assert.equal(snap.tomas[0].cuadro.prompt, 'Frame v2'); assert.equal(snap.tomas[0].cuadro.dueno, 'B');
  assert.equal(snap.tomas[0].voz, null); assert.equal(snap.musica.dueno, 'C');
  const session = { log: [{ type: 'agent', usage: { cost: 0.1 } }], assets: [IMG_ASSET], final: { usage: { cost: 0.2 }, production: prod } };
  assert.equal(Math.round(totalCost(session) * 1000) / 1000, 0.39);
});

test('Mesa · revisión de una parte: el dueño ve su parte, el hilo y su resultado; valida el pedido', () => {
  const base = { kind: 'part', goal: 'Spot', agents, log: [], files: [], assets: [], production: { tomas: [] } };
  const req = parseTableRequest({ ...base, part: { kind: 'cuadro', shot: 'S2', owner: 'C', spec: { prompt: 'A cat' }, thread: [{ role: 'user', text: 'Más luz' }], see: ['/media/a.png', '/media/b.mp3', 'https://x/y.png'], duration: 9 } });
  assert.equal(req.model, 'model/c'); assert.deepEqual(req.part.see, ['/media/a.png']); assert.equal(req.part.duration, 6);
  req.seeData = ['data:image/png;base64,SEE'];
  const msgs = buildPartMessages(req);
  assert.match(msgs[0].content, /Sos Agente C/); assert.match(msgs[0].content, /toma S2/); assert.match(msgs[0].content, /Nano Banana/);
  assert.match(textOf(msgs), /Humano: Más luz/);
  assert.equal(msgs[1].content.find((p) => p.type === 'image_url').image_url.url, 'data:image/png;base64,SEE');
  assert.throws(() => parseTableRequest({ ...base, part: { kind: 'cuadro', shot: 'S2', owner: 'C', spec: { prompt: 'x' }, thread: [] } }), /Falta tu mensaje/);
  assert.throws(() => parseTableRequest({ ...base, part: { kind: 'voz', owner: 'A', spec: { texto: 'x' }, thread: [{ role: 'user', text: 'hola' }] } }), /toma/);
  assert.throws(() => parseTableRequest({ ...base, production: undefined, part: { kind: 'musica', owner: 'A', spec: { prompt: 'x' }, thread: [{ role: 'user', text: 'a' }] } }), /entrega/);
  const synth = buildSynthesisMessages(parseTableRequest({ ...base, kind: 'synthesis', assets: [IMG_ASSET] }));
  assert.match(synth[0].content, /"tomas"/); assert.match(synth[0].content, /"base"/); assert.match(textOf(synth), /G1 · imagen de B/);
});

// ---------- Rutas ----------
function fakeRes() {
  const res = new EventEmitter();
  res.chunks = []; res.writableEnded = false; res.writableFinished = false;
  res.writeHead = (status) => { res.status = status; };
  res.write = (c) => res.chunks.push(c);
  res.end = (c) => { if (c) res.chunks.push(c); res.writableEnded = true; res.writableFinished = true; res.emit('finished'); };
  res.events = () => res.chunks.join('').trim().split('\n').map((l) => JSON.parse(l));
  res.json = () => JSON.parse(res.chunks.join(''));
  return res;
}
async function send(handle, method, p, body) {
  const res = fakeRes();
  const done = new Promise((resolve) => res.once('finished', resolve));
  assert.equal(handle({ method, body }, res, new URL(`http://x${p}`)), true);
  await done;
  return res;
}
const routes = (deps) => createTableRoutes({ readBody: async (r) => r.body, badRequest: (res, error) => { res.status = 400; res.error = error; res.end(); }, ...deps });
const turnBody = (extra = {}) => ({ kind: 'turn', seat: 'B', round: 1, goal: 'Spot', agents, log: [], files: [], assets: [], budget: 1, ...extra });

test('Mesa · ruta: el agente llama herramientas, ve lo que generó y después habla', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mesa-route-'));
  await writeFile(path.join(dir, 'out1.png'), Buffer.from([1]));
  const asks = [];
  const llm = async (r) => {
    asks.push({ tools: r.tools?.length || 0, toolChoice: r.toolChoice, messages: r.messages.length });
    if (asks.length === 1) { r.onDelta('Voy a dibujarlo.'); return { text: 'Voy a dibujarlo.', toolCalls: [call('generar_imagen', { prompt: 'A bakery' })], usage: { cost: 0.01 } }; }
    const shown = r.messages.at(-1);
    assert.equal(shown.role, 'user'); assert.equal(shown.content[2].image_url.url, 'data:image/png;base64,AQ==');
    assert.equal(r.messages.at(-2).role, 'tool');
    r.onDelta('Generé G1.'); return { text: 'Generé G1.', usage: { cost: 0.02 } };
  };
  try {
    const res = await send(routes({ mock: false, llm, media: fakeMedia(), mediaDir: dir }), 'POST', '/api/lab/table/turn', turnBody());
    const ev = res.events();
    const done = ev.at(-1);
    assert.equal(done.type, 'done');
    assert.equal(done.text, 'Voy a dibujarlo.\n\nGeneré G1.');
    assert.equal(done.assets[0].code, 'G1'); assert.equal(done.usage.cost, 0.03);
    assert.ok(ev.some((e) => e.type === 'asset'));
    assert.deepEqual(ev.filter((e) => e.type === 'delta').map((e) => e.text), ['Voy a dibujarlo.', '\n\n', 'Generé G1.']);
    assert.equal(asks[0].tools, 3);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('Mesa · ruta: sin presupuesto o con un modelo que no acepta herramientas, el turno sigue sin generar', async () => {
  let seen;
  const plain = async (r) => { seen = r; return { text: 'Hablo', usage: { cost: 0 } }; };
  await send(routes({ mock: false, llm: plain, media: fakeMedia() }), 'POST', '/api/lab/table/turn', turnBody({ budget: 0 }));
  assert.equal(seen.tools, undefined);
  assert.match(seen.messages[0].content, /no podés generar/);

  let n = 0;
  const picky = async (r) => {
    n++;
    if (r.tools) throw Object.assign(new Error('OpenRouter 404 (x): No endpoints found that support tool use'), { status: 404, streamed: false });
    return { text: 'Sin herramientas', usage: { cost: 0 } };
  };
  const res = await send(routes({ mock: false, llm: picky, media: fakeMedia() }), 'POST', '/api/lab/table/turn', turnBody());
  assert.equal(n, 2);
  assert.ok(res.events().some((e) => e.type === 'notice'));
  assert.equal(res.events().at(-1).text, 'Sin herramientas');

  // Un modelo que pide herramientas sin parar: a la cuarta vuelta se le dice que no (tool_choice none) y se usa lo que dijo.
  let k = 0;
  const greedy = async (r) => { k++; return { text: k > 3 ? 'Listo' : '', toolCalls: [call('generar_sonido', { prompt: 'x', tipo: 'efecto', duracion: 1 })], usage: {} }; };
  const out = (await send(routes({ mock: false, llm: greedy, media: fakeMedia() }), 'POST', '/api/lab/table/turn', turnBody({ budget: 5 }))).events().at(-1);
  assert.equal(k, 4); assert.equal(out.text, 'Listo'); assert.equal(out.assets.length, 2, 'máximo dos piezas por turno');
});

test('Mesa · ruta: la entrega se pide en JSON y, si viene rota, se corrige una vez', async () => {
  const good = JSON.stringify({ titulo: 'Spot', tomas: [{ titulo: 'Uno', duracion: 4, cuadro: { prompt: 'Frame', dueno: 'B' }, video: { prompt: 'Move', dueno: 'D' } }] });
  const replies = ['Perdón, no tengo JSON', `\`\`\`json\n${good}\n\`\`\``];
  const msgs = [];
  const llm = async (r) => { msgs.push(r.messages); return { text: replies.shift(), usage: { cost: 0.1 } }; };
  const done = (await send(routes({ mock: false, llm }), 'POST', '/api/lab/table/turn', { ...turnBody({ kind: 'synthesis' }) })).events();
  assert.ok(done.some((e) => e.type === 'notice'));
  const last = done.at(-1);
  assert.equal(last.delivery.shots[0].parts.cuadro.owner, 'B');
  assert.equal(last.usage.cost, 0.2);
  assert.match(msgs[1].at(-1).content, /no se pudo leer/);
  const broken = async () => ({ text: 'nada', usage: { cost: 0 } });
  const fail = (await send(routes({ mock: false, llm: broken }), 'POST', '/api/lab/table/turn', turnBody({ kind: 'synthesis' }))).events().at(-1);
  assert.equal(fail.delivery, null); assert.match(fail.error, /JSON/);
});

test('Mesa · ruta: el dueño de una parte responde y devuelve solo lo que cambió', async () => {
  const body = { kind: 'part', goal: 'Spot', agents, log: [], files: [], assets: [], production: { tomas: [] }, part: { kind: 'voz', shot: 'S1', owner: 'A', spec: { personaje: 'Lucía', texto: 'Hola', voz: 'Aria', estabilidad: 0.5 }, thread: [{ role: 'user', text: 'Más triste' }] } };
  const llm = async (r) => { r.onDelta('La hago más triste.\n\n```json\n'); return { text: 'La hago más triste.\n\n```json\n{"personaje":"Lucía","texto":"[sad] Hola","voz":"Aria","estabilidad":0.5,"dueno":"C"}\n```', usage: { cost: 0.01 } }; };
  const ev = (await send(routes({ mock: false, llm }), 'POST', '/api/lab/table/turn', body)).events();
  assert.deepEqual(ev.filter((e) => e.type === 'delta').map((e) => e.text).join(''), 'La hago más triste.\n\n');
  const done = ev.at(-1);
  assert.equal(done.reply, 'La hago más triste.'); assert.deepEqual(done.spec, { personaje: 'Lucía', texto: '[sad] Hola', voz: 'Aria', estabilidad: 0.5 });
  const same = async () => ({ text: 'No cambio nada.\n```json\n{"personaje":"Lucía","texto":"Hola","voz":"Aria","estabilidad":0.5}\n```', usage: {} });
  assert.equal((await send(routes({ mock: false, llm: same }), 'POST', '/api/lab/table/turn', body)).events().at(-1).spec, null);
});

test('Mesa · RUN: corre una parte con sus referencias; sin WaveSpeed lo dice', async () => {
  const gen = [];
  const handle = routes({ mock: false, media: fakeMedia(gen) });
  const res = await send(handle, 'POST', '/api/lab/table/run', { kind: 'image', aspect: '16:9', spec: { prompt: 'Frame', referencias: ['G1'] }, refs: { G1: '/media/g1.png' } });
  assert.equal(res.events().at(-1).result.url, '/media/out1.png');
  assert.equal(gen[0].spec.proporcion, '16:9');
  const missing = await send(handle, 'POST', '/api/lab/table/run', { kind: 'image', spec: { prompt: 'Frame', referencias: ['M3'] }, refs: {} });
  assert.equal(missing.status, 400); assert.match(missing.error, /M3/);
  const off = await send(routes({ mock: false, media: null }), 'POST', '/api/lab/table/run', { kind: 'sound', spec: { prompt: 'x' } });
  assert.match(off.error, /WAVESPEED_API_KEY/);
});

test('Mesa · video: duración permitida más cercana y aprobación que arranca del cuadro', async () => {
  assert.equal(pickDuration([5, 6, 7, 8], 3), 5);
  assert.equal(pickDuration([2, 3, 4, 5, 6, 7], 4), 4);
  assert.equal(pickDuration([8, 10], 4), 4, 'sin duraciones válidas: la pedida (la tarea la rechaza si no entra)');
  assert.equal(pickDuration([], 6), 6);
  const dir = await mkdtemp(path.join(tmpdir(), 'mesa-video-'));
  await writeFile(path.join(dir, 'frame.png'), Buffer.from([1, 2]));
  try {
    const catalog = createVideoCatalog({ mock: true });
    const jobs = createCinematicJobs({ dir: path.join(dir, 'jobs'), catalog, mock: true });
    const handle = routes({ mock: true, mediaDir: dir, video: { catalog, jobs, ready: { wan: true, heygen: false } } });
    const noFrame = await send(handle, 'POST', '/api/lab/table/video', { engine: 'wan', prompt: 'Push in', duration: 5 });
    assert.match(noFrame.error, /corré primero el cuadro/);
    const res = await send(handle, 'POST', '/api/lab/table/video', { engine: 'wan', prompt: 'Push in', duration: 9, aspect: '9:16', image: '/media/frame.png' });
    assert.equal(res.status, 202);
    const job = res.json();
    assert.equal(job.input.duration, 6); assert.equal(job.input.resolution, '480p'); assert.equal(job.input.referenceMode, 'first-frame');
    assert.equal(job.results[0].model, 'alibaba/wan-3.0-prime/image-to-video');
    assert.equal(job.estimate, 0.45);
    for (let i = 0; i < 100 && (await jobs.get(job.id)).status === 'running'; i++) await new Promise((r) => setTimeout(r, 5));
    assert.equal((await jobs.get(job.id)).results[0].status, 'done');
    const cfg = (await send(handle, 'GET', '/api/lab/table/config')).json();
    assert.equal(cfg.video.engines.find((e) => e.id === 'wan').ok, true);
    assert.equal(cfg.video.engines.find((e) => e.id === 'heygen').ok, false);
    assert.ok(cfg.video.engines.find((e) => e.id === 'wan').durations.every((d) => d <= 6));
    assert.equal(cfg.media, false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
