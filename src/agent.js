// Piezas compartidas por todos los flujos: ejecutar un agente con streaming de notas,
// extraer su JSON (con una reparación si viene roto) y llevar la cuenta de costos.

// Separa las "notas de trabajo" (visibles, en vivo) del bloque JSON final.
export class NotesSplitter {
  constructor(emit) { this.emit = emit; this.buf = ''; this.sent = 0; this.inJson = false; }
  push(t) {
    this.buf += t;
    if (this.inJson) return;
    const fence = this.buf.indexOf('```');
    if (fence >= 0) {
      if (fence > this.sent) this.emit(this.buf.slice(this.sent, fence));
      this.sent = fence;
      this.inJson = true;
      return;
    }
    const safe = this.buf.length - 2; // por si "```" llega partido entre chunks
    if (safe > this.sent) { this.emit(this.buf.slice(this.sent, safe)); this.sent = safe; }
  }
  end() { if (!this.inJson && this.buf.length > this.sent) this.emit(this.buf.slice(this.sent)); }
}

export function extractJson(text) {
  const blocks = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)];
  const candidate = blocks.length ? blocks[blocks.length - 1][1] : text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  return JSON.parse(candidate);
}

// Devuelve `agent(opts)`, que ejecuta un agente y registra su salida en `log.steps`.
export function createAgentRunner({ emit, llm, signal, log }) {
  const totals = { cost: 0, tokens: 0 };

  function track(usage) {
    if (!usage) return;
    totals.cost += usage.cost || 0;
    totals.tokens += usage.total_tokens || 0;
    emit({ type: 'usage', ...totals });
  }

  // `history`: turnos previos del mismo agente (así conserva su contexto entre etapas).
  // `meta` no llega al modelo: solo lo usan los modelos simulados del modo demo.
  async function agent({ step, role, title, model, system, content, history = [], maxTokens = 6000, temperature, plugins, meta }) {
    emit({ type: 'step_start', step, role, title, model });
    const splitter = new NotesSplitter((t) => emit({ type: 'delta', step, text: t }));
    let chars = 0;
    const messages = [{ role: 'system', content: system }, ...history, { role: 'user', content }];
    const call = (msgs, plg) => llm({
      step, model, messages: msgs, maxTokens, temperature, plugins: plg, signal, meta,
      onDelta: (t) => {
        splitter.push(t);
        if (splitter.inJson) { chars += t.length; if (chars % 400 < t.length) emit({ type: 'progress', step, chars }); }
      },
      onReasoning: (t) => emit({ type: 'reasoning', step, text: t }),
    });

    let result;
    try {
      result = await call(messages, plugins);
    } catch (err) {
      if (!plugins || signal?.aborted) throw err;
      emit({ type: 'notice', step, text: `Búsqueda web no disponible para este modelo (${err.message.slice(0, 120)}). Sigo sin web.` });
      result = await call(messages, undefined);
    }
    splitter.end();
    track(result.usage);

    let data;
    try {
      data = extractJson(result.text);
    } catch (err) {
      emit({ type: 'notice', step, text: 'El JSON vino mal formado; pido una corrección.' });
      const repair = await llm({
        step, model, maxTokens, signal, meta,
        messages: [...messages, { role: 'assistant', content: result.text }, { role: 'user', content: `Tu bloque JSON no es válido (${err.message}). Devolvé SOLO el bloque \`\`\`json corregido y completo, sin notas.` }],
      });
      track(repair.usage);
      data = extractJson(repair.text);
      result.text += `\n\n[REPARACIÓN]\n${repair.text}`;
    }
    log.steps[step] = { role, model, raw: result.text, data, usage: result.usage };
    emit({ type: 'step_end', step, data });
    return data;
  }

  return { agent, totals };
}
