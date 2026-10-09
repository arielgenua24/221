import test from 'node:test';
import assert from 'node:assert/strict';
import { compileMotionLayer, extractCode, ALLOWED_IMPORTS, buildRuntime, REMOTION_VERSION } from '../src/lab/runtime.js';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { labSystem, harnessVersion, SKILL_FILES, briefContent, zonesFor, imageRegistry } from '../src/lab/harness.js';
import { parseLabBody, runLabAgent, usedReferences, paletteAndObjects, MAX_COMPILE_RETRIES } from '../src/lab/pipeline.js';
import { mockLabLLM } from '../src/lab/mock.js';
import { createLabTools, toolDefs, MAX_GENERATED_IMAGES } from '../src/lab/tools.js';
import { createMockWaveSpeed } from '../src/wavespeed.js';
import { frameHtml } from '../src/lab/routes.js';
import { newRun, runMetrics, modelStats, experimentStatus, isAdjusted } from '../public/lab-stats.js';

const IMG = 'data:image/jpeg;base64,/9j/AA==';
const video = { name: 'v.mp4', duration: 12, width: 1080, height: 1920 };
const clip = (id, start, end, extra = {}) => ({ id, start, end, prompt: `pedido ${id}`, notes: '', frames: [{ t: 0.5, url: IMG }, { t: 1.5, url: IMG }], refs: [], ...extra });
const body = (extra = {}) => ({
  model: 'anthropic/claude-opus-5.5',
  brief: { context: 'cafetería', instructions: 'títulos grandes', refs: [{ name: 'ref.jpg', url: IMG }, { name: 'mala', url: 'http://x' }] },
  video,
  clips: [clip('C2', 6, 9), clip('C1', 1, 3.5)],
  ...extra,
});

const GOOD = `import { AbsoluteFill, Sequence, Img, useVideoConfig } from "remotion";
import { fade } from "@remotion/transitions/fade";
import { loadFont } from "@remotion/google-fonts/Inter";
const { fontFamily } = loadFont();
type Z = { id: string; from: number; durationInFrames: number };
export default function Layer({ zones, images }: { zones: Z[]; images: Record<string, string> }) {
  const { fps } = useVideoConfig();
  void fade;
  return <AbsoluteFill>{images.gen1 ? <Img src={images.gen1} /> : null}{zones.map((z) => <Sequence key={z.id} from={z.from} durationInFrames={z.durationInFrames} premountFor={fps}><h1 style={{ fontFamily }}>{z.id}</h1></Sequence>)}</AbsoluteFill>;
}`;

test('compileMotionLayer transpila TSX a CommonJS y acepta los paquetes permitidos', async () => {
  const { js, imports } = await compileMotionLayer(GOOD);
  assert.match(js, /require\("remotion"\)/);
  assert.ok(imports.every((s) => ALLOWED_IMPORTS.includes(s)));
  assert.ok(imports.includes('@remotion/google-fonts/Inter'));
});

test('compileMotionLayer rechaza lo que rompe el contrato, con mensajes para el modelo', async () => {
  await assert.rejects(compileMotionLayer('export default function () { return <div>; }'), /error de sintaxis.*línea 1/);
  await assert.rejects(compileMotionLayer(GOOD.replace('import { fade } from "@remotion/transitions/fade";', 'import { fade } from "lodash";')), /no existen en este entorno: lodash/);
  await assert.rejects(compileMotionLayer(GOOD.replace('export default function', 'export function')), /export default/);
  // El video lo pone el entorno: la capa no lo renderiza.
  await assert.rejects(compileMotionLayer(GOOD.replace('{ zones, images }', '{ zones, images, videoSrc }')), /videoSrc/);
  await assert.rejects(compileMotionLayer(GOOD.replace('const { fps }', 'const r = Math.random(); const { fps }')), /Math\.random/);
  await assert.rejects(compileMotionLayer(GOOD.replace('const { fps }', 'const n = Date.now(); const { fps }')), /reloj/);
  await assert.rejects(compileMotionLayer(GOOD.replace('<Img src={images.gen1} />', '<Img src={staticFile("a.png")} />')), /staticFile/);
});

test('extractCode toma el último bloque con el componente y tolera respuestas cortadas', () => {
  assert.equal(extractCode(`notas\n\`\`\`tsx\nborrador\n\`\`\`\n\n\`\`\`tsx\n${GOOD}\n\`\`\``), GOOD);
  assert.equal(extractCode(`notas\n\`\`\`tsx\n${GOOD}`), GOOD);
  assert.throws(() => extractCode('solo texto'), /bloque/);
});

test('el harness incluye las Remotion Agent Skills, el contrato de capa y las herramientas disponibles', () => {
  assert.ok(SKILL_FILES.length >= 8);
  const all = labSystem({ search: true, images: true });
  const none = labSystem({ search: false, images: false });
  assert.match(all, /<skill file="remotion-markup\/REFERENCE.md">/);
  assert.match(all, /<skill file="remotion-markup\/transitions.md">/);
  assert.match(all, /YA está renderizado debajo/);
  assert.match(all, /buscar_referencias/);
  assert.match(all, /generar_imagen/);
  assert.doesNotMatch(none, /buscar_referencias|generar_imagen/);
  assert.match(harnessVersion({ search: true, images: true }), new RegExp(`^v5 · remotion ${REMOTION_VERSION.replace(/\./g, '\\.')}.*búsqueda obligatoria\\+imagen propia`));
  assert.match(all, /OBLIGATORIO/);
  assert.match(all, /PALETA DE COLORES/);
  assert.match(all, /OBJETOS DE REFERENCIA/);
  assert.match(all, /`Paleta: #/);
  assert.match(harnessVersion({}), /sin herramientas/);
  // El prompt de sistema no depende del modelo: solo de las herramientas, que son las mismas para los dos.
  assert.equal(labSystem({ search: true, images: true }), all);
  assert.deepEqual(toolDefs({ search: true, images: false }).map((t) => t.function.name), ['buscar_referencias']);
});

test('parseLabBody valida el modelo, reutiliza la validación de clips de Intuition y filtra referencias', () => {
  const input = parseLabBody(body());
  assert.deepEqual(input.clips.map((c) => c.id), ['C1', 'C2']);
  assert.equal(input.brief.refs.length, 1);
  assert.equal(input.turns.length, 0);
  assert.throws(() => parseLabBody(body({ model: 'sin barra' })), /modelo válido/);
  assert.throws(() => parseLabBody(body({ clips: [] })), /al menos un clip/);
  // Zonas de hasta 11 s (Intuition sigue en 5 s).
  assert.equal(parseLabBody(body({ clips: [clip('C1', 0.5, 11.5)] })).clips[0].end, 11.5);
  assert.throws(() => parseLabBody(body({ clips: [clip('C1', 0, 11.6)] })), /como máximo 11 s/);
  const withTurns = parseLabBody(body({ turns: [{ code: 'x', kind: 'feedback', message: 'más chico' }, { code: '', kind: 'runtime', message: 'boom' }] }));
  assert.deepEqual(withTurns.turns, [{ code: 'x', kind: 'feedback', message: 'más chico' }]);
});

test('briefContent arma el mismo pedido con zonas en cuadros, cuadros del video y referencias', () => {
  const input = parseLabBody(body());
  const parts = briefContent(input);
  assert.match(parts[0].text, /C1: 1\.00 s → 3\.50 s = cuadros 30 → 105/);
  assert.match(parts[0].text, /Contexto\ncafetería/);
  assert.equal(parts.filter((p) => p.type === 'image_url').length, 2 * 2 + 1);
  assert.match(parts[1].text, /^C1-1 — /);
  assert.deepEqual([...imageRegistry(input).keys()], ['C1-1', 'C1-2', 'C2-1', 'C2-2', 'R1']);
  assert.deepEqual(zonesFor(input.clips).map((z) => [z.from, z.durationInFrames]), [[30, 75], [180, 90]]);
});

test('runLabAgent corrige solo un componente que no compila y suma el costo de todas las llamadas', async () => {
  const events = [];
  const input = parseLabBody(body({ model: 'qwen/qwen3.8-flash' })); // en el demo, los modelos baratos fallan la primera vez
  await runLabAgent({ input, emit: (e) => events.push(e), llm: mockLabLLM });
  const done = events.find((e) => e.type === 'done');
  assert.equal(events.filter((e) => e.type === 'compile_error').length, 1);
  assert.equal(done.calls, 2);
  assert.equal(done.compileErrors, 1);
  assert.ok(done.cost > 0);
  const result = events.find((e) => e.type === 'result');
  assert.match(result.js, /require\("remotion"\)/);
  assert.match(result.notes, /demo/);
});

test('runLabAgent reenvía los turnos previos (revisión del humano) y corta tras agotar las correcciones', async () => {
  const seen = [];
  const input = parseLabBody(body({ turns: [{ code: GOOD, kind: 'feedback', message: 'más chico' }] }));
  await runLabAgent({ input, emit: () => {}, llm: async (opts) => { seen.push(opts.messages); return mockLabLLM(opts); } });
  const msgs = seen[0];
  assert.equal(msgs[0].role, 'system');
  assert.equal(msgs.at(-2).role, 'assistant');
  assert.match(msgs.at(-1).content, /Revisión del humano.*más chico/);

  const broken = async () => ({ text: '```tsx\nexport default () => <div>\n```', usage: { cost: 0.01, total_tokens: 10 } });
  const events = [];
  await assert.rejects(runLabAgent({ input: parseLabBody(body()), emit: (e) => events.push(e), llm: broken }), (err) => {
    assert.match(err.message, /no entregó un componente válido/);
    assert.equal(err.totals.calls, MAX_COMPILE_RETRIES + 1);
    assert.ok(Math.abs(err.totals.cost - 0.01 * (MAX_COMPILE_RETRIES + 1)) < 1e-9);
    return true;
  });
});

test('runLabAgent ejecuta herramientas: busca referencias, genera una imagen y la deja para el componente', async () => {
  const mediaDir = await mkdtemp(path.join(tmpdir(), 'lab-'));
  const tools = createLabTools({ mock: true, ws: createMockWaveSpeed({ mediaDir }), mediaDir });
  const events = [];
  const seen = [];
  await runLabAgent({ input: parseLabBody(body()), emit: (e) => events.push(e), llm: async (o) => { seen.push(o); return mockLabLLM(o); }, tools });
  const types = events.map((e) => e.type);
  assert.ok(types.includes('search'));
  const asset = events.find((e) => e.type === 'asset');
  assert.equal(asset.id, 'gen1');
  assert.match(asset.url, /^data:image\//);
  const done = events.find((e) => e.type === 'done');
  assert.equal(done.calls, 3); // búsqueda + imagen + componente
  assert.equal(done.compileErrors, 0);
  assert.equal(done.searches, 1);
  assert.equal(done.images, 1);
  assert.ok(done.toolCost > 0 && done.cost > done.llmCost);
  // El resultado de cada herramienta vuelve como mensaje "tool" y las imágenes en un mensaje aparte.
  const last = seen.at(-1).messages;
  assert.ok(last.some((m) => m.role === 'tool'));
  assert.ok(last.some((m) => m.role === 'assistant' && m.tool_calls?.length));
  assert.ok(seen[0].tools.length === 2);

  // En una revisión, la imagen ya generada sigue disponible y cuenta para el máximo.
  const again = [];
  const input = parseLabBody(body({ assets: [{ id: 'gen1', url: asset.url, prompt: 'x' }, { id: 'gen2', url: asset.url, prompt: 'y' }], turns: [{ code: GOOD, kind: 'feedback', message: 'más grande' }] }));
  const ctxTools = createLabTools({ mock: true, ws: createMockWaveSpeed({ mediaDir }), mediaDir });
  const out = await ctxTools.run({ function: { name: 'generar_imagen', arguments: JSON.stringify({ prompt: 'z', imagenes: ['C1-1'] }) } },
    { emit: () => {}, registry: new Map([['C1-1', IMG]]), aspect: '9:16', state: { searches: 0, searchSeq: 0, generated: MAX_GENERATED_IMAGES, toolCost: 0 } });
  assert.match(out.text, /máximo/);
  await runLabAgent({ input, emit: (e) => again.push(e), llm: mockLabLLM, tools: ctxTools });
  assert.ok(!again.some((e) => e.type === 'asset'));
});

test('runLabAgent sigue sin herramientas si el modelo no las soporta en OpenRouter', async () => {
  const events = [];
  const tools = { available: { search: true, images: false }, run: async () => ({ text: 'x' }) };
  const llm = async (o) => {
    if (o.tools) throw Object.assign(new Error('OpenRouter 404 (x/y): No endpoints found that support tool use'), { status: 404, streamed: false });
    return mockLabLLM(o);
  };
  await runLabAgent({ input: parseLabBody(body()), emit: (e) => events.push(e), llm, tools });
  assert.ok(events.some((e) => e.type === 'notice' && /no acepta herramientas/.test(e.text)));
  assert.equal(events.find((e) => e.type === 'done').toolsOff, true);
});

const searchTools = () => ({ available: { search: true, images: false }, run: createLabTools({ mock: true, ws: null, mediaDir: tmpdir() }).run });

test('la búsqueda de referencias es obligatoria: se fuerza con tool_choice en la primera llamada', async () => {
  const seen = [];
  const events = [];
  await runLabAgent({ input: parseLabBody(body()), emit: (e) => events.push(e), llm: async (o) => { seen.push(o); return mockLabLLM(o); }, tools: searchTools() });
  assert.deepEqual(seen[0].toolChoice, { type: 'function', function: { name: 'buscar_referencias' } });
  assert.equal(seen[1].toolChoice, undefined); // después de buscar, el modelo elige solo
  const done = events.find((e) => e.type === 'done');
  assert.equal(done.searches, 1);
  assert.equal(done.searchRequired, true);
  assert.equal(done.nudged, false);
});

test('si el modelo entrega código sin buscar, no se compila: se le pide que busque primero', async () => {
  const events = [];
  // En el demo, los modelos baratos ignoran el tool_choice (como algunos proveedores) y además fallan la primera compilación.
  await runLabAgent({ input: parseLabBody(body({ model: 'qwen/qwen3.8-flash' })), emit: (e) => events.push(e), llm: mockLabLLM, tools: searchTools() });
  assert.ok(events.some((e) => e.type === 'notice' && /sin buscar referencias/.test(e.text)));
  const done = events.find((e) => e.type === 'done');
  assert.equal(done.nudged, true);
  assert.equal(done.searches, 1);
  assert.equal(done.compileErrors, 1); // el código previo a la búsqueda no cuenta como error de compilación
  assert.equal(done.calls, 4); // código sin buscar → búsqueda → código con error → corregido
});

test('si el proveedor no deja forzar la herramienta, se pide por instrucción y la búsqueda igual ocurre', async () => {
  const events = [];
  const llm = async (o) => {
    if (o.toolChoice) throw Object.assign(new Error('OpenRouter 400 (x/y): tool_choice is not supported with thinking'), { status: 400, streamed: false });
    return mockLabLLM(o);
  };
  await runLabAgent({ input: parseLabBody(body()), emit: (e) => events.push(e), llm, tools: searchTools() });
  assert.ok(events.some((e) => e.type === 'notice' && /no acepta que se le fuerce/.test(e.text)));
  assert.equal(events.find((e) => e.type === 'done').searches, 1);
});

test('al corregir un error de reproducción no se obliga a buscar de nuevo', async () => {
  const seen = [];
  const input = parseLabBody(body({ turns: [{ code: GOOD, kind: 'runtime', message: 'TypeError: boom' }] }));
  const events = [];
  await runLabAgent({ input, emit: (e) => events.push(e), llm: async (o) => { seen.push(o); return mockLabLLM(o); }, tools: searchTools() });
  assert.equal(seen[0].toolChoice, undefined);
  assert.equal(events.find((e) => e.type === 'done').searchRequired, false);
});

test('generar una imagen propia es obligatorio: si escribe sin generar, se le pide una vez', async () => {
  const events = [];
  // En el demo, los modelos que no son opus/sol no generan por iniciativa propia.
  await runLabAgent({ input: parseLabBody(body({ model: 'qwen/qwen3.8-max-prime' })), emit: (e) => events.push(e), llm: mockLabLLM, tools: createLabTools({ mock: true }) });
  assert.ok(events.some((e) => e.type === 'notice' && /sin generar ninguna imagen/.test(e.text)));
  const done = events.find((e) => e.type === 'done');
  assert.equal(done.imageRequired, true);
  assert.equal(done.nudgedImage, true);
  assert.equal(done.images, 1);
  assert.equal(done.calls, 4); // búsqueda → código sin imagen → imagen → código
  assert.deepEqual(events.find((e) => e.type === 'result').usedRefs, ['S1', 'S3']);
});

test('si genera una imagen y no la usa en el código, se le pide que la integre', async () => {
  const events = [];
  const seen = [];
  const tools = { available: { search: false, images: true }, run: createLabTools({ mock: true }).run };
  const llm = async (o) => {
    seen.push(o);
    if (seen.length === 1) return { text: '', toolCalls: [{ id: 'c1', type: 'function', function: { name: 'generar_imagen', arguments: '{"prompt":"x"}' } }], usage: {} };
    if (seen.length === 2) return { text: '```tsx\n' + GOOD.replace('{images.gen1 ? <Img src={images.gen1} /> : null}', '').replace('{ zones, images }', '{ zones }') + '\n```', usage: {} };
    return { text: 'Referencias usadas: gen1\n```tsx\n' + GOOD + '\n```', usage: {} };
  };
  await runLabAgent({ input: parseLabBody(body()), emit: (e) => events.push(e), llm, tools });
  assert.ok(events.some((e) => e.type === 'notice' && /No usa gen1/.test(e.text)));
  assert.match(seen[2].messages.at(-1).content, /Generaste gen1 pero tu componente no las usa/);
  assert.equal(events.find((e) => e.type === 'done').nudgedUse, true);
  assert.deepEqual(events.find((e) => e.type === 'result').usedRefs, ['gen1']);
});

test('usedReferences lee la línea de referencias y descarta ids que no existen', () => {
  const reg = new Map([['S1', 'a'], ['S3', 'b'], ['R1', 'c'], ['C1-2', 'd']]);
  assert.deepEqual(usedReferences('Idea…\nReferencias usadas: S1, S3 y R1, S9', reg), ['S1', 'S3', 'R1']);
  assert.deepEqual(usedReferences('referencias usadas: ninguna', reg), []);
  assert.equal(usedReferences('sin la línea', reg), null);
});

test('paletteAndObjects lee la paleta (hex normalizados) y los objetos de las notas', () => {
  const notes = 'Idea…\nReferencias usadas: S1\nPaleta: #1b1b1f, #F4F1EA, #f50, #F4F1EA, rojo\nObjetos: pelota, hojas secas y un ticket.';
  assert.deepEqual(paletteAndObjects(notes), { palette: ['#1B1B1F', '#F4F1EA', '#FF5500'], objects: ['pelota', 'hojas secas', 'un ticket'] });
  assert.deepEqual(paletteAndObjects('Paleta: ninguna\nObjetos: ninguno'), { palette: [], objects: [] });
  assert.deepEqual(paletteAndObjects('sin líneas'), { palette: null, objects: null });
});

test('el resultado trae la paleta y los objetos que declaró el agente', async () => {
  const events = [];
  await runLabAgent({ input: parseLabBody(body()), emit: (e) => events.push(e), llm: mockLabLLM, tools: createLabTools({ mock: true }) });
  const result = events.find((e) => e.type === 'result');
  assert.ok(result.palette.length >= 2 && result.palette.every((h) => /^#[0-9A-F]{6}$/.test(h)));
  assert.ok(result.objects.length >= 1);
});

test('generar_imagen llama a la Image API de OpenRouter con nano-banana y usa el costo real', async () => {
  let req;
  const fetchImpl = async (url, init) => {
    req = { url, body: JSON.parse(init.body), auth: init.headers.Authorization };
    return { ok: true, status: 200, json: async () => ({ data: [{ b64_json: 'AAAA', media_type: 'image/png' }], usage: { cost: 0.0421 } }) };
  };
  const tools = createLabTools({ openrouterKey: 'k', fetchImpl });
  const events = [];
  const ctx = { emit: (e) => events.push(e), registry: new Map([['C1-1', IMG]]), aspect: '9:16', state: { searches: 0, searchSeq: 0, generated: 0, toolCost: 0 } };
  const out = await tools.run({ function: { name: 'generar_imagen', arguments: JSON.stringify({ prompt: 'sticker', imagenes: ['C1-1'] }) } }, ctx);
  assert.match(req.url, /\/images$/);
  assert.equal(req.body.model, 'google/gemini-nano-banana-2.1');
  assert.equal(req.body.aspect_ratio, '9:16');
  assert.deepEqual(req.body.input_references, [{ type: 'image_url', image_url: { url: IMG } }]);
  assert.equal(req.auth, 'Bearer k');
  assert.match(out.text, /Listo: gen1/);
  assert.equal(ctx.state.toolCost, 0.0421);
  assert.equal(events.find((e) => e.type === 'asset').url, 'data:image/png;base64,AAAA');
  // Sin imágenes de entrada también genera (solo con el prompt).
  await tools.run({ function: { name: 'generar_imagen', arguments: JSON.stringify({ prompt: 'otra' }) } }, ctx);
  assert.equal(req.body.input_references, undefined);
  assert.equal(ctx.state.generated, 2);
});

test('el runtime del iframe empaqueta React + Remotion y lo inyecta en un documento con CSP', async () => {
  const runtime = await buildRuntime();
  assert.match(runtime, /LabRuntime/);
  const html = frameHtml(runtime, 'console.log("</script>")');
  assert.match(html, /Content-Security-Policy" content="default-src 'none'/);
  assert.match(html, /<\\\/script>/);
  assert.equal((html.match(/<\/script>/g) || []).length, 2);
});

test('métricas: costo por animación aprobada incluye las ejecuciones rechazadas y las correcciones', () => {
  const run = (model, attempts, ev) => ({ ...newRun(model), attempts, hasCode: true, eval: { ...newRun(model).eval, ...ev } });
  const experiments = [
    { harness: 'v1', preference: 'A', sides: {
      A: run('a/caro', [{ reason: 'initial', calls: 1, cost: 0.3, tokens: 100, ms: 1000, ok: true }], { approved: true, quality: 5 }),
      B: run('b/barato', [{ reason: 'initial', calls: 2, cost: 0.02, tokens: 100, ms: 500, ok: true }, { reason: 'feedback', calls: 1, cost: 0.01, tokens: 50, ms: 400, ok: true }], { approved: false, quality: 2 }),
    } },
    { harness: 'v1', preference: 'B', sides: {
      A: run('a/caro', [{ reason: 'initial', calls: 1, cost: 0.3, tokens: 100, ms: 1000, ok: true }], { approved: true }),
      B: run('b/barato', [{ reason: 'initial', calls: 1, cost: 0.01, tokens: 100, ms: 500, ok: true }, { reason: 'runtime', calls: 1, cost: 0.01, tokens: 10, ms: 100, ok: true }], { approved: true, quality: 4 }),
    } },
  ];
  const m = runMetrics(experiments[0].sides.B);
  assert.equal(m.calls, 3);
  assert.equal(m.attempts, 3); // registros viejos sin compileErrors: cada llamada extra fue una recompilación
  assert.equal(m.autoFixes, 1); // la recompilación dentro de la primera ejecución
  assert.equal(m.interventions, 1);
  assert.equal(runMetrics(experiments[1].sides.B).autoFixes, 1); // el arreglo por error al reproducir
  // Las llamadas por herramientas no son intentos; ajustar tamaño o posición cuenta como intervención.
  const withTools = { ...newRun('c/x'), attempts: [{ reason: 'initial', calls: 3, compileErrors: 0, cost: 0.1, toolCost: 0.05, searches: 1, images: 1, ok: true }], transform: { scale: 0.8, x: 0, y: 0 } };
  const mt = runMetrics(withTools);
  assert.equal(mt.calls, 3);
  assert.equal(mt.attempts, 1);
  assert.equal(mt.autoFixes, 0);
  assert.equal(mt.toolCost, 0.05);
  assert.equal(mt.interventions, 1);
  assert.ok(mt.adjusted);
  assert.ok(!isAdjusted({ scale: 1, x: 0, y: 0 }));
  // Cortar o mover la animación también es intervención manual.
  const mc = runMetrics({ ...withTools, transform: { scale: 1, x: 0, y: 0 }, segments: [{ id: 'C1', from: 0, len: 30, to: 60 }], segmentsEdited: true });
  assert.ok(mc.cut);
  assert.equal(mc.interventions, 1);

  const [first, second] = modelStats(experiments);
  assert.equal(first.model, 'a/caro');
  assert.equal(first.approved, 2);
  assert.ok(Math.abs(first.costPerApproved - 0.3) < 1e-9);
  assert.equal(second.model, 'b/barato');
  assert.equal(second.approved, 1);
  assert.ok(Math.abs(second.costPerApproved - 0.05) < 1e-9); // 0.03 + 0.02 gastados / 1 aprobada
  assert.equal(second.wins, 1);
  assert.equal(second.avgQuality, 3);
  assert.equal(experimentStatus(experiments[0]), 'evaluado');
  assert.equal(experimentStatus({ sides: { A: newRun('x/y'), B: newRun('x/z') } }), 'borrador');
});
