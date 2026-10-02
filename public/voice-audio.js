export const SAMPLE_RATE = 24000;
export function wavBase64(chunks, inputRate) {
  const size = chunks.reduce((n, c) => n + c.length, 0);
  const input = new Float32Array(size);
  let offset = 0;
  for (const chunk of chunks) { input.set(chunk, offset); offset += chunk.length; }
  const count = Math.min(SAMPLE_RATE * 30, Math.floor(size * SAMPLE_RATE / inputRate));
  const bytes = new Uint8Array(44 + count * 2), view = new DataView(bytes.buffer);
  const str = (at, s) => { [...s].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0))); };
  str(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); str(8, 'WAVE'); str(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, SAMPLE_RATE, true); view.setUint32(28, SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); str(36, 'data'); view.setUint32(40, count * 2, true);
  const ratio = inputRate / SAMPLE_RATE;
  for (let i = 0; i < count; i++) {
    let sample = 0, n = 0;
    for (let j = Math.floor(i * ratio); j < Math.max(Math.floor(i * ratio) + 1, Math.floor((i + 1) * ratio)); j++) { sample += input[j] || 0; n++; }
    sample = Math.max(-1, Math.min(1, sample / n));
    view.setInt16(44 + i * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
  }
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}

// Works with arbitrary base64 fragment boundaries, including a fragment between PCM bytes.
export class PCMDecoder {
  constructor() { this.base64 = ''; this.byte = null; }
  push(data, final = false) {
    this.base64 += data;
    const samples = [];
    while (this.base64.length >= 4) {
      const end = this.base64.indexOf('=');
      const length = end >= 0 ? Math.ceil((end + 1) / 4) * 4 : Math.floor(this.base64.length / 4) * 4;
      if (length > this.base64.length) break;
      const binary = atob(this.base64.slice(0, length));
      this.base64 = this.base64.slice(length);
      for (let i = 0; i < binary.length; i++) {
        const byte = binary.charCodeAt(i);
        if (this.byte === null) this.byte = byte;
        else { const value = this.byte | (byte << 8); samples.push((value >= 32768 ? value - 65536 : value) / 32768); this.byte = null; }
      }
    }
    if (final && (this.base64 || this.byte !== null)) throw new Error('El audio de GPT llegó incompleto.');
    return Float32Array.from(samples);
  }
}

export class VoiceActivity {
  constructor(rate) { this.rate = rate; this.reset(); }
  reset() { this.pre = []; this.chunks = []; this.recording = false; this.speech = 0; this.silence = 0; this.total = 0; }
  push(samples) {
    const chunk = Float32Array.from(samples), ms = samples.length * 1000 / this.rate;
    const rms = Math.sqrt(samples.reduce((sum, n) => sum + n * n, 0) / samples.length);
    const voice = rms > 0.018;
    if (!this.recording) {
      this.pre.push(chunk);
      while (this.pre.reduce((n, c) => n + c.length, 0) > this.rate * 0.25) this.pre.shift();
      this.speech = voice ? this.speech + ms : 0;
      if (this.speech < 160) return {};
      this.recording = true; this.chunks = this.pre; this.pre = []; this.total = this.chunks.reduce((n, c) => n + c.length, 0) * 1000 / this.rate;
      return { started: true };
    }
    this.chunks.push(chunk); this.total += ms;
    this.silence = voice ? 0 : this.silence + ms;
    if (this.silence < 750 && this.total < 29750) return {};
    const chunks = this.chunks; this.reset(); return { chunks };
  }
}
