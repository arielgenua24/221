let mode = 'gemini';
try { if (localStorage.getItem('voice-mode') === 'gpt-audio') mode = 'gpt-audio'; } catch {}
export const isGptAudio = () => mode === 'gpt-audio';
function sync() { document.querySelectorAll('[data-voice-mode]').forEach((select) => { select.value = mode; }); }
function change(value) {
  mode = value === 'gpt-audio' ? value : 'gemini';
  try { localStorage.setItem('voice-mode', mode); } catch {}
  sync();
  window.dispatchEvent(new CustomEvent('voice-mode', { detail: mode }));
}
document.querySelectorAll('[data-voice-mode]').forEach((select) => select.addEventListener('change', (event) => change(event.target.value)));
window.addEventListener('storage', (event) => { if (event.key === 'voice-mode') change(event.newValue); });
sync();
