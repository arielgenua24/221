// Laboratorio · habla del video: sube el clip a Whisper (WaveSpeed, por /api/lab/transcribe) y muestra la transcripción
// partida en cabezales de un segundo. Esos cabezales viajan en cada ejecución (`transcript`) y los agentes los usan
// para decidir en qué momento entra cada animación. Lo usan Motion Design y Context Lab.
import { el } from './shared.js';

const mmss = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
const money = (n) => `US$ ${n < 0.01 ? n.toFixed(4) : n.toFixed(3)}`;

// mount: dónde se agrega el panel. studio: createStudio() del marcador (para saber qué video hay y su duración).
// onChange: avisa cuando cambia el estado (el laboratorio refresca sus botones).
export function createSpeechPanel({ mount, studio, onChange = () => {} }) {
  let speech = { available: true, costPerSecond: 0.002, maxSeconds: 600 };
  let transcript = null; // { heads, language, duration, text, words, cost, truncated, model }
  let forFile = null; // el File al que pertenece la transcripción
  let busy = false;
  let controller = null;
  let enabled = true;
  let note = ''; // un aviso que se queda hasta la próxima acción (ej. «no encontró habla»)

  const node = el('div', 'lab-field lab-speech');
  const label = el('span', 'lab-field-label', 'Habla del video');
  const help = el('span', 'muted small', 'Whisper pasa a texto lo que dice la persona del video, con su momento exacto. Los agentes la reciben por segundo (un «cabezal» cada segundo) para meter cada animación cuando se dice eso.');
  const row = el('div', 'actions compact');
  const runBtn = el('button', 'small-btn', 'Transcribir con Whisper');
  runBtn.type = 'button';
  const useBox = el('input');
  useBox.type = 'checkbox'; useBox.checked = true;
  const useLabel = el('label', 'lab-inline');
  useLabel.append(useBox, el('span', 'small', 'Usar en el pedido'));
  const clearBtn = el('button', 'small-btn', 'Quitar');
  clearBtn.type = 'button';
  row.append(runBtn, useLabel, clearBtn);
  const status = el('p', 'small muted lab-speech-status');
  status.setAttribute('role', 'status');
  const details = el('details', 'lab-speech-heads');
  const summary = el('summary', 'small', 'Cabezales por segundo');
  const list = el('pre', 'small lab-speech-list');
  details.append(summary, list);
  node.append(label, help, row, status, details);
  mount.append(node);

  const video = () => studio.current();
  // Si cambió el video, la transcripción vieja ya no vale.
  function sync() {
    if (transcript && forFile && video()?.file !== forFile) { transcript = null; forFile = null; }
    render();
  }

  function render() {
    const v = video();
    node.hidden = !speech.available;
    runBtn.disabled = busy || !v || !speech.available;
    runBtn.textContent = busy ? 'Transcribiendo…' : transcript ? 'Transcribir de nuevo' : 'Transcribir con Whisper';
    useLabel.hidden = clearBtn.hidden = !transcript;
    details.hidden = !transcript;
    useBox.checked = enabled;
    if (transcript) {
      const spoken = transcript.heads.filter((h) => h.text).length;
      status.textContent = `${transcript.heads.length} cabezales (${spoken} con habla) · idioma ${transcript.language || '?'} · ${transcript.words} palabras${transcript.cost ? ` · ${money(transcript.cost)}` : ''}${transcript.truncated ? ` · Whisper solo toma los primeros ${Math.round(speech.maxSeconds / 60)} min` : ''}${enabled ? '' : ' · no se usa en el pedido'}`;
      list.textContent = transcript.heads.map((h) => `${mmss(h.t)}  ${h.text || '·'}`).join('\n');
    } else if (!busy) {
      status.textContent = note || (!v ? 'Subí un clip para poder transcribirlo.' : `Cuesta ≈ ${money(Math.min(v.duration, speech.maxSeconds) * speech.costPerSecond)} para este clip.`);
    }
  }

  // Sube el clip y transcribe. Devuelve la transcripción, o lanza el error (que también queda escrito en el panel).
  async function transcribe() {
    const v = video();
    if (!v) throw new Error('Subí un clip primero.');
    if (busy) throw new Error('Ya se está transcribiendo.');
    busy = true;
    controller = new AbortController();
    note = '';
    render();
    status.textContent = `Subiendo ${(v.file.size / 1024 / 1024).toFixed(1)} MB y transcribiendo… (segundos a un par de minutos)`;
    onChange();
    try {
      const res = await fetch(`/api/lab/transcribe?duration=${encodeURIComponent(v.duration)}`, {
        method: 'POST', headers: { 'Content-Type': v.file.type || 'video/mp4' }, body: v.file, signal: controller.signal,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `error ${res.status}`);
      if (!data.heads?.some((h) => h.text)) {
        transcript = null; forFile = null;
        throw new Error('Whisper no encontró habla en este video (¿sin voz o solo música?). No hay nada para sumar al pedido.');
      }
      transcript = data; forFile = v.file; enabled = true;
      return transcript;
    } catch (err) {
      if (!controller.signal.aborted) note = err.message.startsWith('Whisper no encontró') ? err.message : `No pude transcribir: ${err.message}`;
      throw err;
    } finally {
      busy = false; controller = null;
      render();
      onChange();
    }
  }
  runBtn.onclick = () => { transcribe().catch(() => {}); };
  clearBtn.onclick = () => { controller?.abort(); transcript = null; forFile = null; note = ''; render(); onChange(); };
  useBox.onchange = () => { enabled = useBox.checked; render(); onChange(); };

  return {
    node,
    setSpeech: (s) => { speech = { ...speech, ...s }; render(); },
    sync,
    busy: () => busy,
    // La transcripción de este clip: la que ya hay, o la hace ahora (modo Automático). La deja activada para el pedido.
    ensure: async () => {
      sync();
      if (transcript) { enabled = true; render(); onChange(); return transcript; }
      return transcribe();
    },
    // Lo que viaja al servidor: solo los cabezales (el servidor arma la sección del pedido). null = no se usa.
    get: () => (transcript && enabled ? { heads: transcript.heads.map(({ t, text, at }) => ({ t, text, at })), language: transcript.language, duration: transcript.duration } : null),
    // Un resumen liviano para el historial del experimento.
    summary: () => (transcript && enabled ? { language: transcript.language, words: transcript.words, seconds: transcript.heads.length, cost: transcript.cost || 0, model: transcript.model } : null),
    // Reabre un experimento: vuelve a mostrar lo que usó.
    restore: (t, file) => {
      transcript = t ? { ...t, words: t.heads.reduce((n, h) => n + h.text.split(' ').filter(Boolean).length, 0), cost: 0, model: null } : null;
      forFile = t ? file : null; enabled = true; note = ''; render();
    },
    full: () => transcript,
  };
}
