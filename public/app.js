const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = text;
  return n;
};

const MAX_SIDE = 1280;
let maxPhotos = 8;
let photos = [];
let controller = null;
const steps = new Map();
let parallelBox = null;

// ---------- Configuración ----------
fetch('/api/config').then((r) => r.json()).then((cfg) => {
  maxPhotos = cfg.maxPhotos;
  const mode = $('mode');
  mode.textContent = cfg.mock ? 'Modo demo' : 'Modelos reales';
  if (cfg.mock) mode.classList.add('demo');
  const team = $('team');
  [
    ['Orquestador (brief, ideas, decisión final)', cfg.orchestratorModel],
    [`Investigadores ×3 en paralelo${cfg.researchWeb ? ', con búsqueda web' : ''}`, cfg.researcherModel],
    ['Crítico', cfg.criticModel],
  ].forEach(([label, model]) => {
    const li = el('li', null, `${label}: `);
    li.append(el('code', null, model));
    team.append(li);
  });
});

// ---------- Fotos ----------
function resize(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, MAX_SIDE / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(img.src);
      resolve(canvas.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = () => reject(new Error(`No pude leer ${file.name}`));
    img.src = URL.createObjectURL(file);
  });
}

async function addFiles(files) {
  const images = [...files].filter((f) => f.type.startsWith('image/'));
  for (const file of images) {
    if (photos.length >= maxPhotos) break;
    try { photos.push(await resize(file)); } catch (e) { showError(e.message); }
  }
  renderThumbs();
}

function renderThumbs() {
  const box = $('thumbs');
  box.replaceChildren();
  photos.forEach((src, i) => {
    const t = el('div', 'thumb');
    const img = el('img');
    img.src = src;
    img.alt = `Foto ${i + 1}`;
    const x = el('button', null, '×');
    x.title = 'Quitar';
    x.onclick = (e) => { e.preventDefault(); photos.splice(i, 1); renderThumbs(); };
    t.append(img, x);
    box.append(t);
  });
}

const drop = $('dropzone');
$('file').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (e) => addFiles(e.dataTransfer.files));

// ---------- Ejecución ----------
function showError(msg) { const e = $('error'); e.textContent = msg; e.hidden = !msg; }

function reset() {
  steps.clear();
  parallelBox = null;
  $('timeline').replaceChildren();
  $('ideas').replaceChildren();
  $('results').hidden = true;
  $('empty').hidden = true;
  $('usage').textContent = '';
  showError('');
}

$('run').addEventListener('click', async () => {
  const text = $('text').value.trim();
  if (!text && !photos.length) return showError('Subí al menos una foto o contá qué hace tu negocio.');
  reset();
  $('run').disabled = true;
  $('run').textContent = 'El equipo está trabajando…';
  $('stop').hidden = false;
  controller = new AbortController();
  try {
    const res = await fetch('/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, photos }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error((await res.json()).error || `Error ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.trim()) handle(JSON.parse(line));
      }
    }
  } catch (e) {
    if (e.name !== 'AbortError') showError(e.message);
  } finally {
    steps.forEach((s) => { if (s.status.classList.contains('running')) setStatus(s, 'fail'); });
    $('run').disabled = false;
    $('run').textContent = 'Crear ideas de contenido';
    $('stop').hidden = true;
  }
});

$('stop').addEventListener('click', () => controller?.abort());

// ---------- Eventos del arnés ----------
function handle(ev) {
  switch (ev.type) {
    case 'step_start': return startStep(ev);
    case 'delta': { const s = steps.get(ev.step); if (s) s.body.textContent += ev.text; return; }
    case 'reasoning': {
      const s = steps.get(ev.step);
      if (s) { s.thought = (s.thought + ev.text).slice(-300); s.thinking.textContent = '💭 ' + s.thought.replace(/\s+/g, ' ').trim(); }
      return;
    }
    case 'progress': { const s = steps.get(ev.step); if (s) s.progress.textContent = `Redactando entregable… ${ev.chars.toLocaleString('es')} caracteres`; return; }
    case 'notice': { const s = steps.get(ev.step); if (s) s.node.append(el('div', 'notice', ev.text)); return; }
    case 'step_end': {
      const s = steps.get(ev.step);
      if (s) { setStatus(s, 'ok'); s.progress.textContent = ''; s.thinking.textContent = ''; }
      return;
    }
    case 'step_error': { const s = steps.get(ev.step); if (s) { setStatus(s, 'fail'); s.node.append(el('div', 'notice', ev.text)); } return; }
    case 'brief': return renderBrief(ev.data);
    case 'concepts': return renderConcepts(ev.data);
    case 'critique': return renderCritique(ev.data);
    case 'ideas': return renderIdeas(ev.ideas, ev.note);
    case 'usage': {
      $('usage').textContent = `${ev.tokens.toLocaleString('es')} tokens${ev.cost ? ` · US$ ${ev.cost.toFixed(3)}` : ''}`;
      return;
    }
    case 'error': return showError(ev.text);
    default:
  }
}

function startStep({ step, role, title, model }) {
  const node = el('article', 'step');
  const head = el('div', 'step-head');
  const status = el('span', 'status running');
  const t = el('div', 'step-title', title);
  t.append(el('span', 'step-model', model));
  head.append(el('span', `role ${role}`, role), t, status);
  const body = el('div', 'step-body');
  const thinking = el('div', 'thinking');
  const progress = el('div', 'progress');
  node.append(head, body, thinking, progress);

  if (step.startsWith('research-')) {
    if (!parallelBox) {
      $('timeline').append(el('div', 'parallel-label', 'En paralelo'));
      parallelBox = el('div', 'parallel');
      $('timeline').append(parallelBox);
    }
    parallelBox.append(node);
  } else {
    $('timeline').append(node);
  }
  steps.set(step, { node, body, thinking, progress, status, thought: '' });
  node.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function setStatus(s, state) {
  s.status.className = `status ${state}`;
  s.status.textContent = state === 'ok' ? '✓' : state === 'fail' ? '✕' : '';
}

function renderBrief(b) {
  const s = steps.get('brief');
  if (!s || !b) return;
  const box = el('div', 'brief-sum');
  const add = (label, value) => {
    if (!value) return;
    const d = el('div');
    d.append(el('strong', null, label), document.createTextNode(value));
    box.append(d);
  };
  add('Negocio', [b.negocio?.rubro, b.negocio?.que_ofrece].filter(Boolean).join(' — '));
  add('Público', b.publico?.quien);
  add('Nivel de consciencia', b.nivel_consciencia);
  add('Tono', b.personalidad_marca?.tono);
  s.node.append(box);
}

function renderConcepts(concepts) {
  const s = steps.get('ideation');
  if (!s || !Array.isArray(concepts)) return;
  const chips = el('div', 'chips');
  concepts.forEach((c) => {
    const chip = el('span', 'chip');
    chip.append(el('b', null, `${c.id} `), document.createTextNode(`${c.titulo} · ${c.formato || ''}`));
    chip.title = c.subtitulo || '';
    chips.append(chip);
  });
  s.node.append(chips);
}

function renderCritique(crit) {
  const s = steps.get('critique');
  const evals = crit?.evaluaciones;
  if (!s || !Array.isArray(evals)) return;
  const chips = el('div', 'chips');
  evals
    .map((e) => ({ ...e, total: Object.values(e.puntajes || {}).reduce((a, n) => a + (Number(n) || 0), 0) }))
    .sort((a, b) => b.total - a.total)
    .forEach((e) => {
      const chip = el('span', 'chip');
      chip.append(el('b', null, `${e.id} `), el('span', 'score', `${e.total}/35`));
      chip.title = `${e.veredicto || ''}\nMejora: ${e.mejora || ''}`;
      chips.append(chip);
    });
  s.node.append(chips);
}

const FORMAT_LABEL = { reel_ia: 'Reel (video IA)', carrusel: 'Carrusel', imagen: 'Imagen' };

function renderIdeas(ideas, note) {
  const box = $('ideas');
  box.replaceChildren();
  (ideas || []).forEach((idea, i) => {
    const card = el('article', 'idea');
    card.style.animationDelay = `${i * 80}ms`;
    card.append(el('span', 'idea-num', `Idea ${i + 1}`), el('h3', null, idea.titulo), el('p', 'sub', idea.subtitulo));
    const tags = el('div', 'tags');
    [idea.funcion, FORMAT_LABEL[idea.formato] || idea.formato, idea.nivel_consciencia && `Consciencia ${idea.nivel_consciencia}`, idea.emocion]
      .filter(Boolean).forEach((t) => tags.append(el('span', 'tag', t)));
    card.append(tags);

    const det = el('details');
    det.append(el('summary', null, 'Ver detalle'));
    const dl = el('dl');
    const row = (k, v) => { if (!v || (Array.isArray(v) && !v.length)) return; dl.append(el('dt', null, k), el('dd', null, Array.isArray(v) ? v.map((x, j) => `${j + 1}. ${x}`).join('\n') : v)); };
    row('Ángulo', idea.angulo);
    if (idea.hook) row('Hook', [idea.hook.visual && `Visual: ${idea.hook.visual}`, idea.hook.texto && `Texto: ${idea.hook.texto}`, idea.hook.verbal && `Voz: ${idea.hook.verbal}`].filter(Boolean).join('\n'));
    row('Desarrollo', idea.desarrollo);
    row('Caption', idea.caption);
    row('Por qué funciona', idea.por_que);
    row('Producción', idea.produccion);
    det.append(dl);
    card.append(det);
    box.append(card);
  });
  $('note').textContent = note || '';
  $('results').hidden = false;
  $('results').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
