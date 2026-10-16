import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  musicPrompt, musicMessages, parseMusic, cueRequest, musicBody, planMusic, generateMusic, demoMusic,
  MUSIC_PROMPT_MAX, MUSIC_MAX_SECONDS, MIN_CUE_SECONDS, MAX_MUSIC_CUES, MUSIC_MODEL,
} from '../src/lab/music.js';

const video = { name: 'v.mp4', duration: 40 };
const transcript = { heads: [{ t: 0, text: 'Esa noche algo se movió en el sótano', at: 0.2 }, { t: 1, text: '', at: null }, { t: 2, text: 'y nadie volvió a bajar', at: 2.1 }] };
const IMG = 'data:image/jpeg;base64,/9j/AA==';

test('musicPrompt: siempre instrumental, sin voces y nunca más de 450 caracteres (sin partir palabras)', () => {
  const p = musicPrompt('dark ambient drones, 70 BPM');
  assert.match(p, /^Instrumental background music, dark ambient/);
  assert.match(p, /No vocals\.$/);
  const long = musicPrompt(`instrumental ${'very slow eerie strings and distant piano '.repeat(30)}`);
  assert.ok(long.length <= MUSIC_PROMPT_MAX, long.length);
  assert.match(long, /\w\. No vocals\.$/);
  assert.equal(musicPrompt('Instrumental piano, no vocals'), 'Instrumental piano, no vocals');
});

test('musicMessages: le da la transcripción y los cuadros, y le pide que el tono no contradiga el video', () => {
  const [system, user] = musicMessages({ video, transcript, frames: [{ t: 3, url: IMG }, { t: 20, url: IMG }], brief: { context: 'terror' } });
  assert.match(system.content, /Nunca contradigas el contenido/);
  assert.match(system.content, new RegExp(`hasta ${MUSIC_PROMPT_MAX} caracteres`));
  assert.match(system.content, new RegExp(`Máximo ${MAX_MUSIC_CUES} tramos`));
  assert.match(user.content[0].text, /algo se movió en el sótano/);
  assert.match(user.content[0].text, /terror/);
  assert.equal(user.content.filter((p) => p.type === 'image_url').length, 2);
});

test('parseMusic ordena, acota al video, estira los cortos, no superpone y numera los tramos', () => {
  const { cues, tone } = parseMusic(`ok {"tono":"tenso","cues":[
    {"start":20,"end":60,"mood":"alivio","prompt":"soft strings","volume":0.9},
    {"start":0,"end":22,"mood":"tenso","prompt":"low drones","volume":0.2},
    {"start":30,"end":31,"prompt":"pisa"},
    {"start":5,"end":9,"prompt":""}
  ],"nota":""}`, { duration: 40 });
  assert.equal(tone, 'tenso');
  assert.deepEqual(cues.map((c) => [c.id, c.start, c.end]), [['M1', 0, 22], ['M2', 22, 40]]);
  assert.equal(cues[1].volume, 0.6); // tope
  assert.ok(cues.every((c) => c.prompt.length <= MUSIC_PROMPT_MAX && /No vocals/.test(c.prompt)));
  assert.throws(() => parseMusic('nada', { duration: 40 }), /JSON válido/);
  assert.throws(() => parseMusic('{"a":1}', { duration: 40 }), /"cues"/);
});

test('cueRequest: hasta 22 s por pedido; un tramo más largo se pide como loop', () => {
  assert.deepEqual(cueRequest({ start: 0, end: 12.5 }), { seconds: 12.5, loop: false });
  assert.deepEqual(cueRequest({ start: 0, end: 40 }), { seconds: MUSIC_MAX_SECONDS, loop: true });
  assert.deepEqual(musicBody({ prompt: 'x', seconds: 22, loop: true }), { prompt: 'x', duration: 22, loop: true, prompt_influence: 0.5 });
});

test('planMusic llama al modelo con imágenes y reintenta una vez si la respuesta no sirve', async () => {
  const calls = [];
  const llm = async (o) => {
    calls.push(o);
    return calls.length === 1 ? { text: 'no sé', usage: { cost: 0.01 } } : { text: '{"cues":[{"start":0,"end":40,"mood":"inquietante","prompt":"eerie pads"}]}', usage: { cost: 0.02, total_tokens: 50 } };
  };
  const out = await planMusic({ llm, model: 'a/b', video, transcript, frames: [{ t: 1, url: IMG }] });
  assert.equal(calls.length, 2);
  assert.ok(Math.abs(out.cost - 0.03) < 1e-9);
  assert.equal(out.cues.length, 1);
  assert.match(calls[1].messages.at(-1).content, /Tu respuesta no sirve/);
});

test('generateMusic pide cada tramo a ElevenLabs con su duración y loop; un tramo que falla no tumba a los demás', async () => {
  const seen = [];
  const ws = { audio: async ({ model, body }) => { seen.push({ model, body }); if (body.prompt === 'boom') throw new Error('WaveSpeed 500'); return { file: `${seen.length}.mp3` }; } };
  const cues = [{ id: 'M1', start: 0, end: 30, prompt: 'calm' }, { id: 'M2', start: 30, end: 40, prompt: 'boom' }];
  const out = await generateMusic({ ws, cues });
  assert.equal(seen[0].model, MUSIC_MODEL);
  assert.deepEqual(seen.map((s) => [s.body.duration, s.body.loop]), [[22, true], [10, false]]);
  assert.equal(out[0].url, '/media/1.mp3');
  assert.ok(out[0].cost > 0);
  assert.equal(out[1].url, null);
  assert.match(out[1].error, /500/);
});

test('modo demo: genera un WAV por tramo en la carpeta de medios', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'music-'));
  try {
    const [cue] = await generateMusic({ cues: [{ id: 'M1', start: 0, end: MIN_CUE_SECONDS, prompt: 'x' }], mock: true, mediaDir: dir });
    assert.match(cue.url, /^\/media\/music-demo-.*\.wav$/);
    assert.ok((await stat(path.join(dir, cue.url.slice(7)))).size > 44);
    assert.equal(demoMusic(1).toString('ascii', 0, 4), 'RIFF');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
