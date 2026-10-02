import { el } from './shared.js';

// An overlay, rather than an inert native dialog: opening it must not stop
// microphone capture, playback or the conversation behind it.
export function createRawProposal({ context, active, api, event, feedbackFocus, feedbackBlur, voiceMode, error, completion }) {
  const viewerId = crypto.randomUUID(), cursors = new Map();
  let shown = null, readyId = '', epoch = 0, timer = null, polling = false, busy = false, scope = '';
  const box = el('section', 'raw-proposal-overlay'); box.hidden = true;
  box.setAttribute('role', 'dialog'); box.setAttribute('aria-labelledby', 'raw-proposal-title');
  const card = el('div', 'raw-proposal-card');
  const title = el('h2', null, '¿Te parece si hago esto?'); title.id = 'raw-proposal-title';
  const hint = el('p', 'muted', 'Seguimos conversando. Revisá las referencias y decime si aprobás el plan o qué querés cambiar.');
  const refs = el('div', 'raw-proposal-refs'), summary = el('p', 'raw-proposal-summary'), details = el('p', 'muted small');
  const label = el('label', null, 'También podés escribir una corrección'); label.htmlFor = 'raw-proposal-feedback';
  const feedback = el('textarea'); feedback.id = 'raw-proposal-feedback'; feedback.rows = 2; feedback.placeholder = 'Por ejemplo: conservar el fondo de R1…';
  const status = el('p', 'raw-proposal-status'); status.setAttribute('aria-live', 'polite');
  const actions = el('div', 'actions');
  const approve = el('button', 'primary', 'Acepto, generar'), revise = el('button', null, 'Aplicar cambios'), reject = el('button', null, 'No, cancelar');
  for (const b of [approve, revise, reject]) b.type = 'button';
  actions.append(approve, revise, reject); card.append(title, hint, refs, summary, details, label, feedback, status, actions); box.append(card); document.body.append(box);
  feedback.addEventListener('focus', feedbackFocus);
  feedback.addEventListener('blur', feedbackBlur);
  feedback.addEventListener('input', buttons);
  approve.onclick = () => decide('approve'); revise.onclick = () => decide('revise'); reject.onclick = () => decide('reject');
  function buttons() {
    approve.disabled = busy || shown?.status !== 'pending' || readyId !== shown?.id || !!feedback.value.trim();
    revise.disabled = busy || shown?.status !== 'pending' || !feedback.value.trim();
    reject.disabled = busy || shown?.status !== 'pending';
  }
  function clear() { epoch++; shown = null; readyId = ''; box.hidden = true; feedback.value = ''; busy = false; buttons(); }
  async function render(proposal) {
    if (!active() || proposal?.folderId !== context()?.id) return;
    if (!proposal) { clear(); return; }
    if (shown?.id === proposal.id) { shown = proposal; status.textContent = proposal.status === 'revising' ? 'Estoy preparando los cambios. Podés seguir hablando.' : readyId === proposal.id ? 'Esperando tu aprobación. Todavía no se envió al generador.' : status.textContent; buttons(); return; }
    const version = ++epoch; shown = proposal; readyId = ''; busy = false; feedback.value = ''; box.hidden = false;
    summary.textContent = proposal.summary;
    details.textContent = `${proposal.imageGenerator === 'seedream' ? 'Seedream 5 Pro' : 'GPT Image 2.5'} · ${proposal.aspect}${proposal.style && proposal.style !== 'Any Style' ? ` · ${proposal.style}` : ''}`;
    status.textContent = proposal.status === 'revising' ? 'Estoy preparando los cambios. Podés seguir hablando.' : 'Cargando las referencias…';
    refs.replaceChildren();
    const images = proposal.references.map((ref) => {
      const figure = el('figure'), img = el('img'); img.alt = `${ref.code}${ref.name ? `: ${ref.name}` : ''}`;
      figure.append(img, el('figcaption', null, `${ref.code}${ref.name ? ` · ${ref.name}` : ''}`)); refs.append(figure);
      // Register load handlers before setting src (including a cached image).
      const loaded = new Promise((resolve, reject) => { img.onload = resolve; img.onerror = () => reject(new Error(`No pude mostrar ${ref.code}. No se generará sin revisar las referencias.`)); });
      img.src = `/raw-files/${ref.file}`;
      return loaded;
    });
    buttons();
    if (proposal.status !== 'pending') return;
    try {
      await Promise.all(images);
      if (version !== epoch || !active() || context()?.id !== proposal.folderId || document.hidden) return;
      await api('/api/raw/proposals/seen', { folderId: proposal.folderId, proposalId: proposal.id, viewerId });
      if (version !== epoch || !active()) return;
      readyId = proposal.id; status.textContent = 'Esperando tu aprobación. Todavía no se envió al generador.'; buttons();
    } catch (e) { if (version === epoch) { status.textContent = e.message; error(e.message); } }
  }
  async function decide(action) {
    if (!shown || busy) return;
    const proposal = shown, version = epoch;
    if (action === 'approve' && feedback.value.trim()) return;
    busy = true; buttons(); status.textContent = action === 'revise' ? 'Preparando una nueva propuesta…' : 'Guardando tu decisión…';
    try {
      const result = await api('/api/raw/proposals/decide', { folderId: proposal.folderId, proposalId: proposal.id, viewerId, action, feedback: action === 'revise' ? feedback.value.trim() : '', voiceMode: voiceMode() });
      if (version !== epoch) return;
      if (action === 'revise') { shown.status = 'revising'; status.textContent = 'Estoy preparando los cambios. Podés seguir hablando.'; }
      else clear();
      event({ type: 'raw_proposal_decision', ...result });
    } catch (e) { if (version === epoch) { status.textContent = e.message; error(e.message); } }
    finally { if (version === epoch) { busy = false; buttons(); } schedule(50); }
  }
  function schedule(ms = 1000) { if (!timer && !polling && active()) timer = setTimeout(poll, ms); }
  async function poll() {
    timer = null;
    if (!active()) { clear(); return; }
    const id = context().id, version = epoch;
    polling = true;
    try {
      const data = await api(`/api/raw/proposals?id=${encodeURIComponent(id)}`);
      if (!active() || context()?.id !== id || version !== epoch) return;
      if (data.proposal) { render(data.proposal); }
      else if (shown) clear();
      for (const job of data.jobs) {
        let seq = cursors.get(job.id) || 0;
        for (const ev of job.events) if (ev.seq > seq) { event(ev); seq = ev.seq; }
        cursors.set(job.id, seq);
        if (['done', 'error'].includes(job.status)) completion(job);
      }
    } catch (e) { if (active() && context()?.id === id) error(e.message); }
    finally { polling = false; schedule(); }
  }
  return {
    context: () => ({ proposalId: shown?.status === 'pending' && readyId === shown.id && active() && !document.hidden ? shown.id : '', viewerId }),
    typing: () => document.activeElement === feedback,
    sync() {
      const next = active() ? context()?.id : '';
      if (scope !== next) { clear(); scope = next; }
      if (!active()) { clearTimeout(timer); timer = null; }
      else schedule(20);
    },
    show(proposal) { if (active() && proposal?.folderId === context()?.id) render(proposal); },
    changed() { clear(); schedule(20); },
  };
}
