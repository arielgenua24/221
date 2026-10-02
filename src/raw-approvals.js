import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';

export function hasRawFeedback(text) {
  const s = String(text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  return /\b(pero|cambia\w*|cambie\w*|modifica\w*|corrig\w*|corrij\w*|agrega\w*|anad\w*|quita\w*|saca\w*|prefiero|en vez|reemplaza\w*|mejor|usa\w*|utiliza\w*)\b/.test(s);
}

// A second user turn must explicitly approve the proposal. Corrections always
// require another preview, including phrases such as “sí, pero cambia el fondo”.
export function explicitApproval(text) {
  const s = String(text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  if (/\b(no|pero|aunque|salvo|excepto|antes|cambia\w*|cambie\w*|cambio\w*|modifica\w*|corrig\w*|corrij\w*|agrega\w*|anad\w*|quita\w*|saca\w*|mejor|diferente|otra?\w*|espera\w*)\b/.test(s) || /[¿?]/.test(s)) return false;
  const yes = /\b(si|dale|acepto|aproba\w*|apruebo|confirmo|adelante|genera\w*|hazlo|hacelo|hagamos\w*|hace\w*|ok|okay|correcto|perfecto|de acuerdo|parece bien)\b/.test(s);
  // A bare “sí” inside feedback or an unrelated sentence isn't confirmation.
  const words = s.replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(Boolean);
  return yes && words.every((w) => /^(si|dale|acepto|aprob\w*|apruebo|confirm\w*|adelante|gener\w*|hazlo|hacelo|hagamos\w*|hace\w*|ok|okay|correcto|perfecto|de|acuerdo|me|te|lo|la|las|los|el|eso|esto|asi|tal|cual|esta|este|bien|parece|con|ese|esa|es|y|que|quiero|hagas|hacer|mostraste|mostras|mostro|mostrado|plan|propuesta|imagen|ahora|por|favor|gracias|vamos|mandale|confirmacion|listo|veo|entendi|todo|tal|como|exactamente|dale|estoy)$/.test(w));
}

export function proposalView(p) {
  if (!p) return null;
  return { id: p.id, folderId: p.folderId, status: p.status, summary: p.summary, aspect: p.aspect, style: p.style, imageGenerator: p.imageGenerator,
    model: p.request.model, codes: p.inputs.map((a) => a.code), references: p.inputs.map(({ code, file, name }) => ({ code, file, name })), error: p.error, at: p.at };
}

// Claims are serialized and persisted BEFORE starting paid work. Repeated
// approvals cannot submit a second request. Restart never retries paid work.
export function createRawApprovals({ dir, generate, revise, completed }) {
  let data, ready, queue = Promise.resolve();
  const seen = new Set(), tasks = new Map();
  const file = path.join(dir, 'proposals.json');
  async function save() {
    await mkdir(dir, { recursive: true });
    const tmp = `${file}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(data)); await rename(tmp, file);
  }
  async function load() {
    if (!ready) ready = (async () => {
      try { data = JSON.parse(await readFile(file, 'utf8')); }
      catch (e) { if (e.code !== 'ENOENT') throw e; data = []; }
      for (const p of data) if (['generating', 'revising'].includes(p.status)) {
        p.status = 'error'; p.error = 'El servidor se reinició. Revisá el resultado antes de volver a pedir una imagen.';
        p.events.push({ type: 'raw_gen_error', id: p.id, text: p.error, seq: p.events.length + 1 });
      }
      await save();
    })();
    await ready;
  }
  function transaction(fn) {
    const task = queue.catch(() => {}).then(async () => { await load(); const result = await fn(); await save(); return result; });
    queue = task.catch(() => {}); return task;
  }
  const active = (folderId) => data.findLast((p) => p.folderId === folderId && ['pending', 'revising'].includes(p.status));
  function owned(folderId, id) {
    const p = data.find((p) => p.id === id && p.folderId === folderId);
    if (!p) throw new Error('La propuesta no pertenece a este proyecto.');
    return p;
  }
  function run(p, work) {
    const task = Promise.resolve().then(work);
    tasks.set(p.id, task);
    task.catch((e) => console.error('RAW approval:', e.message)).finally(() => tasks.delete(p.id));
  }
  const service = {
    async pending(folderId) { await queue; await load(); const p = active(folderId); return p ? { ...proposalView(p), prompt: p.prompt } : null; },
    async list(folderId) {
      await queue; await load();
      return { proposal: proposalView(active(folderId)), jobs: data.filter((p) => p.folderId === folderId && p.status !== 'pending' && (p.status !== 'superseded' || p.events.length)).slice(-20).map((p) => ({ ...proposalView(p), events: p.events })) };
    },
    propose(plan, expectedId) {
      return transaction(() => {
        const old = active(plan.folderId);
        if (expectedId && old?.id !== expectedId) throw new Error('El plan cambió durante la revisión. Revisá la propuesta actual.');
        if (old) old.status = 'superseded';
        const p = { ...structuredClone(plan), id: randomUUID(), status: 'pending', at: new Date().toISOString(), events: [] };
        data.push(p);
        return proposalView(p);
      });
    },
    beginRevision(folderId, id) {
      return transaction(() => {
        const p = owned(folderId, id);
        if (p !== active(folderId)) throw new Error('La propuesta cambió mientras hablabas.');
        if (p.status === 'pending') p.status = 'revising';
      });
    },
    async seen(folderId, id, viewerId) {
      if (!/^[\w-]{6,64}$/.test(viewerId || '')) throw new Error('Falta la sesión del modal.');
      await queue; await load(); const p = owned(folderId, id);
      if (p !== active(folderId) || p.status !== 'pending') throw new Error('Esta propuesta ya cambió. Revisá la nueva.');
      seen.add(`${id}:${viewerId}`); return { ok: true };
    },
    async decide({ folderId, proposalId, viewerId, action, feedback = '', source = 'button', text = '', voiceMode = 'gemini' }) {
      let start;
      const result = await transaction(() => {
        const p = owned(folderId, proposalId);
        if (!['approve', 'reject', 'revise'].includes(action)) throw new Error('Decisión inválida.');
        // Only an already claimed SAME proposal is idempotent; never substitute
        // whatever proposal happens to be current when the request arrives.
        if (action === 'approve' && ['generating', 'done'].includes(p.status)) return { id: p.id, status: p.status };
        if (p !== active(folderId) || p.status !== 'pending') throw new Error('Esta propuesta ya cambió. Revisá la nueva antes de confirmar.');
        if (action === 'approve') {
          if (feedback.trim()) throw new Error('Aplicá los cambios y revisá la nueva propuesta antes de generar.');
          if (!seen.has(`${p.id}:${viewerId}`)) throw new Error('Primero abrí el modal y revisá todas las referencias.');
          if (source === 'voice' && !explicitApproval(text)) throw new Error('Necesito una aprobación explícita del plan, sin correcciones. Si querés cambios, preparo otra propuesta.');
          p.status = 'generating'; p.voiceMode = voiceMode === 'gpt' ? 'gpt' : 'gemini';
          // The serialized transaction's save must finish before submission.
          start = () => run(p, async () => {
            const emit = (event) => { p.events.push({ ...event, seq: p.events.length + 1 }); };
            try {
              const asset = await generate(structuredClone(p), emit);
              await transaction(() => { p.status = 'done'; });
              try { await completed?.(p, asset); } catch (e) { console.error('RAW voice notification:', e.message); }
            } catch (e) {
              emit({ type: 'raw_gen_error', id: p.id, text: e.message });
              await transaction(() => { p.status = 'error'; p.error = e.message; });
              try { await completed?.(p, null); } catch (e) { console.error('RAW voice notification:', e.message); }
            }
          });
        } else if (action === 'reject') p.status = 'rejected';
        else {
          if (!feedback.trim()) throw new Error('Decime qué querés cambiar.');
          p.status = 'revising'; p.voiceMode = voiceMode === 'gpt' ? 'gpt' : 'gemini';
          start = () => run(p, async () => {
            try {
              const result = await revise(structuredClone(p), feedback.trim());
              if (result?.reply?.decir) await transaction(() => { p.events.push({ type: 'raw_revision_reply', text: result.proposal ? 'Actualicé la propuesta. Revisala y decime si la aprobás.' : result.reply.decir, seq: p.events.length + 1 }); });
            }
            catch (e) { await transaction(() => { p.status = 'error'; p.error = e.message; }); }
          });
        }
        return { id: p.id, status: p.status };
      });
      start?.();
      return result;
    },
    async idle() { await queue; await Promise.allSettled([...tasks.values()]); await queue; },
  };
  return service;
}
