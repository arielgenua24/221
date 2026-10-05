import { PCMDecoder, VoiceActivity, wavBase64, SAMPLE_RATE } from './voice-audio.js';

export function createGptVoice({ context, enabled, mic, inputAllowed, phase, user, reply, event, error, refresh = async () => {}, beginInput = () => ({}), discardInput = () => {} }) {
  let audioContext = null, capture = null, opening = null, lifetime = 0, inputEpoch = 0, request = null, playing = null, pollTimer = null, polling = false, recordingInput = null;
  const cursors = new Map(), announced = new Set();
  const here = () => enabled() && context() && !document.hidden;
  const key = (ctx) => ctx && `${ctx.kind}/${ctx.id}`;
  const current = (ctx, epoch) => here() && lifetime === epoch && key(context()) === key(ctx);
  const post = async (url, body, signal) => {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Error ${res.status}`);
    return res;
  };
  const ack = (state, played) => {
    if (!state?.turnId || state.acked) return Promise.resolve();
    state.acked = true;
    return post('/api/voice/played', { kind: state.ctx.kind, id: state.ctx.id, turnId: state.turnId, played }).catch(() => {});
  };
  function cancel(retryNotification = true) {
    request?.controller.abort(); request = null;
    if (playing) {
      playing.cancelled = true;
      if (playing.notification && retryNotification) announced.delete(playing.notification);
      for (const source of playing.sources) { source.onended = null; try { source.stop(); } catch {} }
      playing.sources.clear(); ack(playing, false); playing.resolve?.(); playing = null;
    }
  }
  function pauseInput() {
    if (recordingInput) { discardInput(recordingInput); recordingInput = null; }
    if (capture) {
      capture.processor.onaudioprocess = null;
      capture.stream.getTracks().forEach((track) => track.stop());
      capture.source.disconnect(); capture.processor.disconnect(); capture.gain.disconnect();
      capture = null;
    }
    // Invalidate a permission dialog that returns after focus/tab/project changes.
    inputEpoch++;
  }
  function stop() {
    lifetime++; cancel(); pauseInput();
    clearTimeout(pollTimer); pollTimer = null;
    cursors.clear(); announced.clear();
    audioContext?.close().catch(() => {}); audioContext = null;
  }
  async function unlock() {
    if (!here()) return;
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) throw new Error('Este navegador no admite reproducción de GPT Audio.');
    audioContext ||= new AudioContext({ sampleRate: SAMPLE_RATE });
    const player = audioContext;
    await player.resume();
    if (audioContext !== player) return;
    if (player.state !== 'running') throw new Error('Tocá la pantalla para habilitar el audio.');
  }
  async function resume() {
    if (!here()) return;
    startPolling();
    if (!mic() || !inputAllowed() || capture || opening) return;
    const epoch = lifetime, permissionEpoch = inputEpoch, ctx = context();
    let stale = false;
    opening = (async () => {
      let stream;
      try {
        await unlock();
        if (!current(ctx, epoch) || permissionEpoch !== inputEpoch || !mic() || !inputAllowed()) { stale = true; return; }
        if (!navigator.mediaDevices?.getUserMedia) throw new Error('El micrófono necesita HTTPS o localhost y un navegador compatible.');
        stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 }, video: false });
        if (!current(ctx, epoch) || permissionEpoch !== inputEpoch || !mic() || !inputAllowed()) { stale = true; stream.getTracks().forEach((track) => track.stop()); return; }
        const source = audioContext.createMediaStreamSource(stream);
        // ScriptProcessor is supported by the browsers used by the existing app;
        // no browser STT service is involved. Silence detection runs locally.
        const processor = audioContext.createScriptProcessor(2048, 1, 1), gain = audioContext.createGain(); gain.gain.value = 0;
        const vad = new VoiceActivity(audioContext.sampleRate);
        processor.onaudioprocess = (ev) => {
          if (!here() || !mic() || !inputAllowed()) return;
          const result = vad.push(ev.inputBuffer.getChannelData(0));
          if (result.started) { cancel(); recordingInput = beginInput(); phase('listening', 'Te escucho…'); }
          if (result.chunks) { const metadata = recordingInput; recordingInput = null; send({ ...metadata, audio: { data: wavBase64(result.chunks, audioContext.sampleRate), format: 'wav' } }); }
        };
        source.connect(processor); processor.connect(gain); gain.connect(audioContext.destination);
        capture = { stream, source, processor, gain, vad };
        if (!request && !playing) phase('listening');
      } catch (err) {
        stream?.getTracks().forEach((track) => track.stop());
        if (current(ctx, epoch)) { error(err.message || 'No pude abrir el micrófono.'); phase('idle'); }
      }
    })();
    try { await opening; } finally { opening = null; if (stale && here() && mic() && inputAllowed()) resume(); }
  }
  function queuePCM(state, samples) {
    if (!samples.length || state.cancelled) return;
    const buffer = audioContext.createBuffer(1, samples.length, SAMPLE_RATE); buffer.copyToChannel(samples, 0);
    const source = audioContext.createBufferSource(); source.buffer = buffer; source.connect(audioContext.destination);
    state.sources.add(source);
    const at = Math.max(audioContext.currentTime + 0.04, state.at);
    state.at = at + buffer.duration;
    source.onended = () => { source.disconnect(); state.sources.delete(source); if (state.done && !state.sources.size) state.resolve?.(); };
    source.start(at);
    phase('speaking', state.text);
  }
  async function send(message) {
    if (!here()) return;
    cancel();
    if (recordingInput) { discardInput(recordingInput); recordingInput = null; }
    if (!message.greeting && !message.notification && !message.references) message = { ...beginInput(), ...message };
    capture?.vad.reset();
    const ctx = context(), epoch = lifetime;
    const controller = new AbortController(), token = { controller };
    request = token;
    const state = { ctx, notification: message.notification, sources: new Set(), at: 0, text: '', turnId: null, done: false, cancelled: false, acked: false };
    playing = state;
    let mine = null, theirs = null, recorded = false;
    if (!message.greeting && !message.notification) mine = user(message.text || 'Mensaje de voz…', null, message.references);
    phase('thinking'); error('');
    try {
      await unlock();
      if (!current(ctx, epoch) || controller.signal.aborted) return;
      const response = await post('/api/voice/turn', { ...ctx, ...message }, controller.signal);
      const reader = response.body.getReader(), decoder = new TextDecoder(), pcm = new PCMDecoder();
      let buffer = '', completed = false;
      const onEvent = (ev) => {
        if (!current(ctx, epoch) || controller.signal.aborted) return;
        if (ev.type === 'error') throw new Error(ev.text);
        if (ev.type === 'voice_start') state.turnId = ev.turnId;
        if (ev.type === 'voice_user') { recorded = true; mine = user(ev.text, mine, ev.references || message.references); }
        if (ev.type === 'voice_audio') queuePCM(state, pcm.push(ev.data));
        if (ev.type === 'voice_transcript') { state.text += ev.text; theirs = reply(state.text, theirs); phase(state.sources.size ? 'speaking' : 'thinking', state.text); }
        if (ev.type === 'voice_job' || ev.type === 'raw_proposal_decision') event(ev);
        if (ev.type === 'voice_done') { state.turnId = ev.turnId; completed = true; pcm.push('', true); }
      };
      while (true) {
        const { value, done } = await reader.read();
        buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1); if (line) onEvent(JSON.parse(line)); }
        if (done) break;
      }
      if (buffer.trim()) onEvent(JSON.parse(buffer));
      if (!completed) throw new Error('Se cortó la respuesta de GPT Audio.');
      state.done = true;
      if (state.sources.size) await new Promise((resolve) => { state.resolve = resolve; });
      if (!state.cancelled && current(ctx, epoch)) await ack(state, true);
    } catch (err) {
      if (!controller.signal.aborted && current(ctx, epoch)) error(err.message);
      if (playing === state) cancel(false);
    } finally {
      if (!recorded && !message.greeting && !message.notification) discardInput(message);
      if (request === token) request = null;
      if (playing === state) playing = null;
      if (current(ctx, epoch) && !request && !playing) {
        try { await refresh(); } catch (err) { if (current(ctx, epoch)) error(err.message); }
        if (current(ctx, epoch) && !request && !playing) { phase(mic() && inputAllowed() ? 'listening' : 'idle'); resume(); }
      }
    }
  }
  function startPolling() { if (!pollTimer && !polling && here()) pollTimer = setTimeout(poll, 1200); }
  async function poll() {
    pollTimer = null;
    if (!here()) return;
    const ctx = context(), epoch = lifetime;
    polling = true;
    try {
      const res = await fetch(`/api/voice/jobs?kind=${ctx.kind}&id=${encodeURIComponent(ctx.id)}`);
      if (!res.ok) throw new Error('No pude consultar los trabajos de GPT Audio.');
      const { jobs } = await res.json();
      if (!current(ctx, epoch)) return;
      let changed = false;
      for (const job of jobs) {
        let cursor = cursors.get(job.id) || 0;
        if (job.notified) { cursors.set(job.id, job.events.at(-1)?.seq || 0); continue; }
        for (const ev of job.events) if (ev.seq > cursor) { event(ev); cursor = ev.seq; changed = true; }
        cursors.set(job.id, cursor);
        if (job.status === 'error' && !announced.has(job.id)) error(job.result);
      }
      if (changed && !request && !playing) await refresh();
      const result = jobs.find((job) => ['done', 'error'].includes(job.status) && !job.notified && !announced.has(job.id));
      if (result && !request && !playing && !capture?.vad.recording && mic() && inputAllowed()) {
        announced.add(result.id);
        await send({ notification: result.id });
      }
    } catch (err) { if (current(ctx, epoch)) error(err.message); }
    finally { polling = false; startPolling(); }
  }
  window.addEventListener('pointerdown', () => { if (here()) unlock().then(resume).catch((err) => error(err.message)); });
  return { resume, send, pauseInput, stop, cancel, busy: () => !!request || !!playing };
}
