import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWav, analyzeAudio } from '../src/audio.js';
import { normalizeTimeline, snap, buildAnchors } from '../src/timeline.js';
import { runEditPipeline, parseEditBody } from '../src/edit-pipeline.js';
import { mockLLM } from '../src/mock.js';

// Música sintética: golpes a `bpm`, con el "1" de cada compás más fuerte y más energía desde la mitad.
function clicks({ bpm = 120, seconds = 20, sr = 16000, first = 0.3 } = {}) {
  const s = new Float32Array(sr * seconds);
  const period = 60 / bpm;
  for (let k = 0; first + k * period < seconds; k++) {
    const t0 = first + k * period;
    const amp = (k % 4 === 0 ? 1 : 0.5) * (t0 > seconds / 2 ? 1 : 0.4);
    for (let i = 0; i < 800; i++) {
      const idx = Math.round(t0 * sr) + i;
      if (idx < s.length) s[idx] += amp * Math.exp(-i / 150) * Math.sin(i * 0.9);
    }
  }
  return { samples: s, sr };
}

function toWav(samples, sr) {
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + samples.length * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((v, i) => buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v * 32767))), 44 + i * 2));
  return buf;
}

test('parseWav lee PCM de 16 bits', () => {
  const { samples, sr } = clicks({ seconds: 3 });
  const out = parseWav(toWav(samples, sr));
  assert.equal(out.sampleRate, sr);
  assert.equal(out.samples.length, samples.length);
  assert.ok(Math.abs(out.samples[Math.round(0.3 * sr) + 5] - samples[Math.round(0.3 * sr) + 5]) < 1e-3);
  assert.throws(() => parseWav(Buffer.from('no es un wav')), /WAV/);
});

test('analyzeAudio encuentra tempo, beats y compases', () => {
  for (const bpm of [120, 95]) {
    const { samples, sr } = clicks({ bpm });
    const a = analyzeAudio(samples, sr);
    assert.ok(Math.abs(a.bpm - bpm) < 3, `bpm ${a.bpm} vs ${bpm}`);
    assert.ok(a.beatConfidence > 0.5);
    // Cada beat detectado cae a menos de 40 ms de un golpe real.
    const period = 60 / bpm;
    for (const t of a.beats) {
      const k = Math.round((t - 0.3) / period);
      assert.ok(Math.abs(t - (0.3 + k * period)) < 0.04, `beat ${t}`);
    }
    assert.ok(Math.abs(a.downbeats[1] - a.downbeats[0] - 4 * period) < 0.05, 'compases cada 4 beats');
    assert.ok(a.energyChanges.some((c) => Math.abs(c.t - 10) < 1.5 && c.delta > 0), 'detecta la subida de energía');
  }
});

const analysis = { duration: 10, beats: [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5, 6], downbeats: [0.5, 2.5, 4.5], onsets: [], energy: [] };
const media = [{ id: 'V1', kind: 'video', duration: 3 }, { id: 'F1', kind: 'photo' }];

test('snap prefiere el compás y respeta la ventana', () => {
  const anchors = buildAnchors(analysis);
  assert.equal(snap(2.45, anchors), 2.5);
  assert.equal(snap(7.3, anchors), 7.3, 'sin ancla cerca, queda igual');
});

test('normalizeTimeline cubre todo el tema, engancha cortes y valida el material', () => {
  const { segmentos, warnings } = normalizeTimeline({
    segmentos: [
      { inicio: 0.4, media: 'V1', desde: 2.8, efecto: 'volar', transicion: 'flash' },
      { inicio: 2.46, media: 'F1', efecto: 'zoom_in', transicion: 'fundido' },
      { inicio: 2.55, media: 'V1' }, // demasiado cerca del anterior: se descarta
      { inicio: 4, media: 'X9' }, // material inexistente
      { inicio: 5.04, media: 'V1', desde: -3 },
    ],
  }, { analysis, media });
  assert.deepEqual(segmentos.map((s) => [s.inicio, s.fin, s.media]), [[0, 2.5, 'V1'], [2.5, 5, 'F1'], [5, 10, 'V1']]);
  assert.equal(segmentos[0].transicion, 'corte', 'el primer segmento no tiene transición');
  assert.equal(segmentos[0].efecto, 'ninguno', 'efecto desconocido → ninguno');
  assert.equal(segmentos[0].desde, 0.5, 'el fragmento de video entra en lo que dura el video');
  assert.equal(segmentos[1].transicion, 'fundido');
  assert.equal(segmentos[2].desde, 0);
  assert.ok(warnings.some((w) => /X9/.test(w)));
  assert.ok(warnings.some((w) => /congela/.test(w)), 'avisa si el video es más corto que el segmento');
});

test('normalizeTimeline arma un montaje automático si el editor no devuelve nada útil', () => {
  const { segmentos, warnings } = normalizeTimeline({ segmentos: [] }, { analysis, media });
  assert.ok(segmentos.length >= 2);
  assert.equal(segmentos[0].inicio, 0);
  assert.equal(segmentos.at(-1).fin, 10);
  assert.ok(warnings.length);
});

test('parseEditBody valida audio y material', () => {
  const wav = `data:audio/wav;base64,${toWav(new Float32Array(10), 16000).toString('base64')}`;
  const img = 'data:image/jpeg;base64,AAAA';
  assert.throws(() => parseEditBody({ media: [] }), /música/);
  assert.throws(() => parseEditBody({ audio: { wav }, media: [{ id: 'V1', kind: 'video', frames: [] }] }), /video o una foto/);
  const out = parseEditBody({
    text: 'hola', audio: { wav, name: 'tema.m4a' },
    media: [
      { id: 'V1', kind: 'video', duration: 4, frames: [{ t: 0, url: img }, { t: 2, url: img }] },
      { id: '../x', kind: 'photo', frames: [{ url: img }] },
      { id: 'F1', kind: 'photo', frames: [{ url: img }, { url: img }] },
    ],
  });
  assert.equal(out.audio.name, 'tema.m4a');
  assert.ok(Buffer.isBuffer(out.audio.wav));
  assert.deepEqual(out.media.map((m) => [m.id, m.frames.length]), [['V1', 2], ['F1', 1]]);
});

test('el flujo de edición completo: audio al Oído, decisión humana y montaje enganchado', async () => {
  const { samples, sr } = clicks({ bpm: 120, seconds: 20 });
  const img = 'data:image/jpeg;base64,AAAA';
  const events = [];
  const prompts = {};
  const llm = (opts) => { prompts[opts.step] = opts.messages; return mockLLM(opts); };
  const ask = async (d) => {
    assert.equal(d.kind, 'map');
    assert.ok(d.map.secciones.length >= 1);
    return { respuestas: [{ pregunta: '¿Qué transmite?', respuesta: 'Nostalgia' }], comentario: 'El drop está en el segundo 10' };
  };
  const log = await runEditPipeline({
    text: 'Un video de mi viaje', audio: { name: 'tema.wav', wav: toWav(samples, sr) },
    media: [{ id: 'V1', kind: 'video', duration: 6, frames: [{ t: 1, url: img }] }, { id: 'F1', kind: 'photo', frames: [{ t: 0, url: img }] }],
    emit: (e) => events.push(e), llm, ask,
    config: { earModel: 'oido', editorModel: 'editor' },
  });

  // El Oído recibe el audio; el Editor recibe las imágenes rotuladas y la respuesta del humano.
  const earContent = prompts.ear[1].content;
  assert.equal(earContent[0].type, 'input_audio');
  assert.equal(earContent[0].input_audio.format, 'wav');
  const editorContent = prompts.editor[1].content;
  assert.equal(editorContent.filter((p) => p.type === 'image_url').length, 2);
  assert.match(editorContent[0].text, /Nostalgia/);
  assert.match(editorContent[0].text, /drop está en el segundo 10/);

  const segs = log.result.segmentos;
  assert.equal(segs[0].inicio, 0);
  assert.equal(segs.at(-1).fin, log.result.duracion);
  for (let i = 1; i < segs.length; i++) assert.equal(segs[i].inicio, segs[i - 1].fin, 'sin huecos');
  const types = new Set(events.map((e) => e.type));
  for (const t of ['analysis', 'map', 'timeline']) assert.ok(types.has(t), t);
  assert.equal(log.decisions.map.comentario, 'El drop está en el segundo 10');
});
