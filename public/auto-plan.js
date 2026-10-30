// Laboratorio · modo Automático del marcador: transcribe el clip (si hace falta), un agente elige los momentos donde conviene
// animar (/api/lab/plan) y devuelve las zonas con los segundos de los cuadros que quiere ver. El marcador (intuition.js) recorta esos
// cuadros del video y dibuja las zonas. Lo usan Motion Design y Context Lab.
const MODEL_ID = /^[\w.-]+\/[\w.:@-]+$/;
// Lo que se dice entre start y end (segundos), tal cual la transcripción (igual que saidBetween de src/lab/plan.js).
export const saidBetween = (heads, start, end) => (heads || []).filter((h) => h.text && h.t < end && h.t + 1 > start).map((h) => h.text.trim()).join(' ').replace(/\s+/g, ' ').trim().slice(0, 600);
const money = (n) => (n < 0.01 ? n.toFixed(4) : n.toFixed(3));

// getSpeech(): el panel de habla (speech.js). getBrief(): { context, instructions }. getModel(): el modelo que elige los momentos
// (el mismo del experimento). getInfo(): { speech, zones } de /api/lab/models o /api/lab/context/info.
// getTools(): qué herramientas tendrá el diseñador, { search?, images?, sound?, video? } = 'optional' | 'required' (las ausentes no existen).
export function createAutoPlanner({ getSpeech, getBrief, getModel, getInfo, getTools = () => ({}) }) {
  let heads = null; // la última transcripción: para mostrar lo que se dice en cada clip, aunque se mueva a mano
  let last = null;
  let lastMusic = null; // { model, musicModel, cost, cues, tone } de la última música, hasta que un experimento la toma // { model, cost, requested, got, note } de la última elección, hasta que un experimento la toma

  const auto = {
    get maxCount() { return getInfo()?.zones?.max || 6; },
    available() {
      const info = getInfo();
      if (info && info.speech && !info.speech.available) return { ok: false, why: 'El modo Automático necesita transcribir el habla con Whisper: falta WAVESPEED_API_KEY en .env.' };
      return { ok: true };
    },
    // storyboard: cuadros de todo el video ([{ t, url }]): el agente elige mirando lo que hay en pantalla, no solo lo que se dice.
    async run({ count, video, storyboard = [], setStatus }) {
      const model = getModel();
      if (!MODEL_ID.test(model)) throw new Error('Elegí primero el modelo: el agente que elige los momentos usa el mismo del experimento.');
      const speech = getSpeech();
      setStatus('Transcribiendo lo que se dice en el video…');
      const t = await speech.ensure();
      heads = t.heads;
      setStatus(`El agente (${model}) ${storyboard.length ? `mira ${storyboard.length} cuadros del video y ` : ''}está eligiendo ${count} momento${count > 1 ? 's' : ''}…`);
      const res = await fetch('/api/lab/plan', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, count, video, brief: getBrief(), tools: getTools(), storyboard, transcript: { heads: t.heads.map(({ t: s, text, at }) => ({ t: s, text, at })), language: t.language, duration: t.duration } }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `error ${res.status}`);
      last = { model: data.model, cost: data.cost || 0, requested: count, got: data.zones.length, note: data.note || '' };
      return data.zones;
    },
    musicAvailable() {
      const info = getInfo();
      if (info?.music && !info.music.available) return { ok: false, why: 'La música de fondo se genera con ElevenLabs en WaveSpeed: falta WAVESPEED_API_KEY en .env.' };
      return { ok: true };
    },
    // Música de fondo: el mismo modelo escucha (transcripción) y mira (frames: cuadros repartidos en el video) y planea los tramos;
    // el servidor los genera. Devuelve { cues, tone, note, cost, model, musicModel }.
    async music({ video, frames, setStatus = () => {} }) {
      const model = getModel();
      if (!MODEL_ID.test(model)) throw new Error('Elegí primero el modelo: el que compone la música es el mismo del experimento.');
      const speech = getSpeech();
      let transcript = null;
      try {
        setStatus('Transcribiendo lo que se dice en el video…');
        const t = await speech.ensure();
        heads = t.heads;
        transcript = { heads: t.heads.map(({ t: s, text, at }) => ({ t: s, text, at })), language: t.language, duration: t.duration };
      } catch { /* sin habla: compone solo con las imágenes */ }
      setStatus(`${model} mira y escucha el video y compone la música; después ElevenLabs genera cada tramo (puede tardar un minuto)…`);
      const res = await fetch('/api/lab/music', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, video, brief: getBrief(), transcript, frames }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `error ${res.status}`);
      lastMusic = { model: data.model, musicModel: data.musicModel, cost: data.cost || 0, cues: data.cues.length, tone: data.tone || '' };
      return data;
    },
    describeMusic(out) { return `(compuesta por ${out.model}${out.musicModel ? `, generada con ${out.musicModel}` : ''}${out.cost ? ` · US$ ${money(out.cost)}` : ''})`; },
    // Lo que se dice en ese tramo del video ('' si todavía no hay transcripción).
    said(start, end) { return heads ? saidBetween(heads, start, end) : ''; },
    // Lo que se agrega al aviso final del marcador.
    describe() { return last ? `${last.note ? `${last.note} ` : ''}(elegidos por ${last.model}${last.cost ? ` · ${`US$ ${money(last.cost)}`}` : ''})` : ''; },
  };

  return {
    auto,
    // El experimento se queda con el registro de la elección (una sola vez: no se cuenta dos veces el mismo costo).
    take() { const l = last; last = null; return l; },
    takeMusic() { const m = lastMusic; lastMusic = null; return m; },
  };
}
