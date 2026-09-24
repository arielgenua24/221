const endpoint = () => `${process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1'}/chat/completions`;

// Llamada en streaming a OpenRouter (API compatible con OpenAI).
// onDelta recibe el texto de la respuesta; onReasoning, el razonamiento si el modelo lo expone.
export async function streamChat({ apiKey, model, messages, maxTokens, temperature, plugins, onDelta, onReasoning, signal }) {
  const body = {
    model,
    messages,
    stream: true,
    max_tokens: maxTokens,
    usage: { include: true },
  };
  if (temperature !== undefined) body.temperature = temperature;
  if (plugins) body.plugins = plugins;

  const res = await fetch(endpoint(), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': process.env.APP_URL || 'http://localhost',
      'X-Title': '221 Content Harness',
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    throw new Error(`OpenRouter ${res.status} (${model}): ${(await res.text()).slice(0, 500)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let usage = null;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      // Las líneas que empiezan con ":" son comentarios de keep-alive.
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      let chunk;
      try {
        chunk = JSON.parse(data);
      } catch {
        continue;
      }
      if (chunk.error) throw new Error(`OpenRouter (${model}): ${chunk.error.message || JSON.stringify(chunk.error)}`);
      const delta = chunk.choices?.[0]?.delta;
      if (delta?.reasoning) onReasoning?.(delta.reasoning);
      if (delta?.content) {
        text += delta.content;
        onDelta?.(delta.content);
      }
      if (chunk.usage) usage = chunk.usage;
    }
  }
  return { text, usage };
}
