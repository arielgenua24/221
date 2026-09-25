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

const FENCE = /```(?:json)?[ \t]*\r?\n?([\s\S]*?)```/g;

// Un JSON cortado a la mitad todavía sirve: buscamos el último punto donde un valor
// terminó y cerramos ahí las llaves/corchetes que quedaron abiertos.
function truncatedVariants(src, max = 60) {
  const closers = [];
  const cuts = [];
  let inStr = false;
  let esc = false;
  const mark = (i) => cuts.push(i + '|' + [...closers].reverse().join(''));
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') { inStr = false; mark(i + 1); }
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') { closers.push('}'); continue; }
    if (ch === '[') { closers.push(']'); continue; }
    if (ch === '}' || ch === ']') { closers.pop(); mark(i + 1); continue; }
    // fin de un número o de true/false/null
    if (/[\w.]/.test(ch) && !/[\w.]/.test(src[i + 1] || '')) mark(i + 1);
  }
  const out = [];
  for (let k = cuts.length - 1; k >= 0 && out.length < max; k--) {
    const cut = cuts[k];
    const sep = cut.indexOf('|');
    out.push(src.slice(0, Number(cut.slice(0, sep))) + cut.slice(sep + 1));
  }
  return out;
}

function parseLoose(chunk) {
  if (!chunk) return undefined;
  const from = ['{', '['].map((c) => chunk.indexOf(c)).filter((i) => i >= 0);
  if (!from.length) return undefined;
  const body = chunk.slice(Math.min(...from)).trimEnd();
  for (const candidate of [body, ...truncatedVariants(body)]) {
    try { return { data: JSON.parse(candidate), repaired: candidate !== body }; } catch { /* sigue probando */ }
  }
  return undefined;
}

// Devuelve el JSON del agente. Tolera bloques ```json sin cerrar y respuestas cortadas.
export function extractJson(text) {
  const raw = typeof text === 'string' ? text : '';
  if (!raw.trim()) throw new Error('el modelo no devolvió texto');

  const blocks = [...raw.matchAll(FENCE)].map((m) => m[1]);
  // Un ``` que sobrevive a tapar los bloques cerrados es una cerca abierta: ahí quedó cortado.
  const masked = raw.replace(FENCE, (s) => '\u0000'.repeat(s.length));
  const open = masked.lastIndexOf('```');
  const tail = open >= 0 ? raw.slice(open).replace(/^```(?:json)?[ \t]*\r?\n?/, '') : '';

  const candidates = [tail, ...blocks.reverse(), raw];
  for (const candidate of candidates) {
    const hit = parseLoose(candidate);
    if (hit) return hit.data;
  }
  if (!raw.includes('{') && !raw.includes('[')) throw new Error('la respuesta no trae ningún bloque JSON');
  throw new Error('el JSON quedó cortado y no se pudo recuperar');
}

// Un modelo puede venir como lista ("a,b,c"): si el primero no llega a responder
// (saturado, sin cupo, inexistente), se prueba el siguiente.
export function modelList(model) {
  return (Array.isArray(model) ? model : String(model ?? '').split(','))
    .map((m) => String(m).trim())
    .filter(Boolean);
}

const jsonFix = (message, cortado) => `Tu bloque JSON no es válido (${message}). Devolvé SOLO el bloque \`\`\`json corregido y completo, sin notas${cortado ? ', y acortá los textos para que entre entero' : ''}.`;

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
  // `parse` lee la respuesta (por defecto, su bloque JSON); `fix` arma el pedido de corrección si no se pudo leer.
  async function agent({ step, role, title, model, system, content, history = [], maxTokens = 8000, temperature, plugins, meta, parse = extractJson, fix = jsonFix }) {
    const candidates = modelList(model);
    if (!candidates.length) throw new Error(`«${title}» no tiene modelo configurado.`);
    emit({ type: 'step_start', step, role, title, model: candidates[0] });
    const messages = [{ role: 'system', content: system }, ...history, { role: 'user', content }];
    let splitter;
    let chars = 0;
    const call = (usedModel, msgs, plg) => llm({
      step, model: usedModel, messages: msgs, maxTokens, temperature, plugins: plg, signal, meta,
      onDelta: (t) => {
        splitter.push(t);
        if (splitter.inJson) { chars += t.length; if (chars % 400 < t.length) emit({ type: 'progress', step, chars }); }
      },
      onReasoning: (t) => emit({ type: 'reasoning', step, text: t }),
      // El proveedor está saturado y se reintenta solo: lo contamos en vivo.
      onRetry: ({ status, attempt, retries, waitMs }) => emit({
        type: 'notice', step,
        text: `${usedModel} no da abasto ahora (${status}). Reintento ${attempt}/${retries} en ${Math.max(1, Math.round(waitMs / 1000))} s…`,
      }),
    });

    let result;
    let used;
    for (let i = 0; i < candidates.length; i++) {
      used = candidates[i];
      if (i > 0) emit({ type: 'step_model', step, model: used });
      splitter = new NotesSplitter((t) => emit({ type: 'delta', step, text: t }));
      chars = 0;
      try {
        try {
          result = await call(used, messages, plugins);
        } catch (err) {
          if (!plugins || signal?.aborted || err.streamed || err.transient) throw err;
          emit({ type: 'notice', step, text: `Búsqueda web no disponible para este modelo (${err.message.slice(0, 120)}). Sigo sin web.` });
          result = await call(used, messages, undefined);
        }
        break;
      } catch (err) {
        // Si ya escribió algo, cambiar de modelo mezclaría dos respuestas: cortamos acá.
        if (i === candidates.length - 1 || signal?.aborted || err.streamed) throw err;
        emit({ type: 'notice', step, text: `${used} no pudo responder (${err.message.slice(0, 160)}). Sigo con ${candidates[i + 1]}.` });
      }
    }
    splitter.end();
    track(result.usage);

    // Si el JSON no se puede leer, pedimos una corrección; si se cortó por falta de
    // tokens, el reintento va sin notas y con el doble de presupuesto.
    let data;
    let last = result;
    for (let intento = 0; ; intento++) {
      try {
        data = parse(last.text);
        break;
      } catch (err) {
        if (intento >= 2 || signal?.aborted) {
          throw new Error(`«${title}» no devolvió ${parse === extractJson ? 'un JSON' : 'una respuesta'} usable: ${err.message}`);
        }
        const cortado = last.finishReason === 'length' || /cortado|no devolvió texto/.test(err.message);
        emit({
          type: 'notice', step,
          text: cortado
            ? 'La respuesta se cortó por largo; la pido de nuevo, más corta.'
            : `La respuesta vino mal formada (${err.message.slice(0, 140)}); pido una corrección.`,
        });
        const previo = last.text?.trim()
          ? [{ role: 'assistant', content: last.text }, { role: 'user', content: fix(err.message, cortado) }]
          : [{ role: 'user', content: 'No llegó ninguna respuesta. Devolvé SOLO el bloque ```json pedido, sin notas ni razonamiento extenso.' }];
        last = await llm({
          step, model: used, signal, meta, temperature,
          maxTokens: cortado ? Math.min(maxTokens * 2, 32000) : maxTokens,
          messages: [...messages, ...previo],
        });
        track(last.usage);
        result.text += `\n\n[REPARACIÓN ${intento + 1}]\n${last.text || ''}`;
      }
    }
    log.steps[step] = { role, model: used, raw: result.text, data, usage: result.usage };
    emit({ type: 'step_end', step, data });
    return data;
  }

  return { agent, totals };
}
