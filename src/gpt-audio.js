// OpenRouter audio chat is a REST turn with SSE output, not a Realtime session.
export const AUDIO_RATE = 24000;

export async function streamAudioChat({ apiKey, model = 'openai/gpt-audio-mini', voice = 'alloy', messages, tools, signal, onAudio = () => {}, onTranscript = () => {}, fetchImpl = fetch }) {
  if (!apiKey) throw new Error('GPT Audio necesita OPENROUTER_API_KEY en el servidor.');
  const body = { model, messages, stream: true, modalities: ['text', 'audio'], audio: { voice, format: 'pcm16' }, max_tokens: 1600 };
  if (tools?.length) body.tools = tools;
  const res = await fetchImpl(`${(process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/$/, '')}/chat/completions`, {
    method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal,
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({}));
    throw new Error(`GPT Audio (${res.status}): ${error.error?.message || 'OpenRouter rechazó el pedido.'}`);
  }
  if (!res.body) throw new Error('OpenRouter no devolvió un stream de audio.');
  const calls = new Map();
  let content = '', transcript = '', audioBytes = 0, usage = null, finished = false;
  const line = (s) => {
    if (!s.startsWith('data:')) return;
    const data = s.slice(5).trim();
    if (!data) return;
    if (data === '[DONE]') { finished = true; return; }
    const chunk = JSON.parse(data);
    if (chunk.error) throw new Error(chunk.error.message || 'Error de OpenRouter Audio.');
    if (chunk.usage) usage = chunk.usage;
    const choice = chunk.choices?.[0];
    if (choice?.finish_reason) finished = true;
    const delta = choice?.delta || {};
    content += delta.content || '';
    if (delta.audio?.data) {
      audioBytes += delta.audio.data.length;
      onAudio(delta.audio.data);
    }
    if (delta.audio?.transcript) {
      transcript += delta.audio.transcript;
      onTranscript(delta.audio.transcript);
    }
    for (const part of delta.tool_calls || []) {
      const index = part.index ?? 0;
      const call = calls.get(index) || { id: '', type: 'function', function: { name: '', arguments: '' } };
      if (part.id) call.id = part.id;
      if (part.function?.name) call.function.name += part.function.name;
      if (part.function?.arguments) call.function.arguments += part.function.arguments;
      calls.set(index, call);
    }
  };
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const bytes of res.body) {
    signal?.throwIfAborted();
    buffer += decoder.decode(bytes, { stream: true });
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) { line(buffer.slice(0, end).trimEnd()); buffer = buffer.slice(end + 1); }
  }
  buffer += decoder.decode();
  if (buffer.trim()) line(buffer.trimEnd());
  signal?.throwIfAborted();
  if (!finished) throw new Error('Se cortó la respuesta de GPT Audio. Intentá nuevamente.');
  return { content, transcript, audioBytes, toolCalls: [...calls.values()], usage };
}
