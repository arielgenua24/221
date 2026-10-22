// Pestaña Laboratorio · JEV habla.
// JEV no genera texto: elige entre opciones. Para cada token nuevo el corpus (hasta 39.000 palabras del español,
// más signos de puntuación) se baraja y se parte en bloques de 255, cada bloque es un choice, las sobrevivientes
// compiten en un choice final y, después de penalizar las repeticiones, el token elegido se agrega al texto.
// El bucle corre acá: un POST /api/lab/jev-lm/next por token.
import { el } from './shared.js';

const $ = (id) => document.getElementById(id);
const TAB = 'lab-jevlm';
const PUNCT = [',', '.', '?', '!', ';', ':'];
const ENDS = new Set(['.', '?', '!']);
const CORPUS_SIZES = [2000, 5000, 10000, 30000, 39000];
const pct = (p) => `${(p * 100).toFixed(p >= 0.1 ? 0 : 1)}%`;
const num = (n) => Number(n).toLocaleString('es-AR');
const isPunct = (w) => PUNCT.includes(w);

let started = false;
let config = { mock: false, available: true, model: 'jev-1.14.0' };
let controller = null;
let run = null;

const error = (msg) => { const e = $('jevlm-error'); if (!e) return; e.textContent = msg || ''; e.hidden = !msg; };

// Igual que join() de src/jev-lm/corpus.js: signos pegados y mayúscula después de un cierre.
function join(text, token) {
  if (isPunct(token)) return text + token;
  const capital = ENDS.has(text.trimEnd().at(-1));
  return `${text} ${capital ? token[0].toUpperCase() + token.slice(1) : token}`;
}

function field(label, control, hint) {
  const wrap = el('label', 'jl-field');
  wrap.append(el('span', 'jl-label', label), control);
  if (hint) wrap.append(el('span', 'jl-hint', hint));
  return wrap;
}

function select(options, value) {
  const s = el('select');
  for (const [v, label] of options) { const o = el('option', null, label); o.value = String(v); s.append(o); }
  s.value = String(value);
  return s;
}

function input(type, value, attrs = {}) {
  const i = el('input');
  i.type = type;
  if (type === 'checkbox') i.checked = !!value; else i.value = String(value);
  Object.assign(i, attrs);
  return i;
}

function check(control, text) {
  const wrap = el('label', 'jl-check');
  wrap.append(control, el('span', null, text));
  return wrap;
}

function mount(root) {
  const page = el('div', 'jl-root');

  const meta = el('p', 'jl-meta');
  meta.append(`${config.model} · 255 opciones por pregunta · torneo por bloques`);
  if (config.mock) meta.append(' · ', el('span', 'jl-demo', 'demo: respuestas simuladas'));

  // Controles
  const form = el('form', 'jl-form');
  const prompt = el('textarea', 'jl-prompt');
  prompt.rows = 2;
  prompt.value = 'El perro';
  prompt.maxLength = config.limits?.textMax ?? 600;
  prompt.setAttribute('aria-label', 'Comienzo de la oración');
  const words = select(CORPUS_SIZES.map((n) => [n, `${num(n)} palabras · ${Math.ceil(n / 255)} bloques`]), 30000);
  const steps = input('number', 12, { min: 1, max: 30 });
  const keep = select([['auto', 'Automático (llenar 255)'], [1, '1 por bloque'], [3, '3 por bloque'], [5, '5 por bloque']], 'auto');
  const order = select([['mezcla', 'Mezclados'], ['frecuencia', 'Por frecuencia']], 'mezcla');
  const framing = select([['hueco', 'Oración con hueco (___)'], ['continuar', '¿Cómo continúa?']], 'hueco');
  const penalty = input('number', 1.5, { min: 0, max: 5, step: 0.5 });
  const target = input('number', 10, { min: 0, max: 40, step: 1 });
  const sample = select([['greedy', 'La más probable'], ['temp', 'Sortear con temperatura']], 'greedy');
  const temperature = input('number', 0.8, { min: 0.1, max: 3, step: 0.1 });
  const exclude = input('text', '', { placeholder: 'palabras separadas por coma' });
  const stopAtEnd = input('checkbox', true);
  const clean = input('checkbox', true);
  const punct = input('checkbox', true);
  const ngram = input('checkbox', true);
  const rerank = select([[0, 'No'], [5, 'Las 5 mejores'], [10, 'Las 10 mejores'], [20, 'Las 20 mejores']], 10);
  const tempField = field('Temperatura', temperature, 'Más alta = más variedad');
  tempField.hidden = true;
  sample.addEventListener('change', () => { tempField.hidden = sample.value !== 'temp'; });

  const grid = el('div', 'jl-grid');
  grid.append(
    field('Corpus', words, 'Las más frecuentes del español'),
    field('Pasos', steps, 'Palabras o signos a generar'),
    field('Pregunta', framing, 'Cómo se le pregunta a JEV'),
    field('Sobrevivientes', keep, 'Por bloque, hacia la final'),
    field('Bloques', order, 'Cómo se agrupan las palabras'),
    field('Reclasificar', rerank, 'Escribe las oraciones y JEV elige la mejor'),
    field('Penalización', penalty, 'Contra repetir palabras (0 = nada)'),
    field('Largo de oración', target, 'Cerrar antes se penaliza (0 = libre)'),
    field('Elección', sample),
    tempField,
    field('Excluir', exclude, 'Palabras que no puede elegir'),
  );
  const checks = el('div', 'jl-checks');
  checks.append(
    check(clean, 'Corpus limpio (sin nombres, inglés ni faltas)'),
    check(punct, 'Signos de puntuación como opciones'),
    check(ngram, 'Filtro de n-gramas (solo palabras que siguen en oraciones reales)'),
    check(stopAtEnd, 'Cortar al cerrar la oración'),
  );

  const go = el('button', 'jl-btn primary', 'Hablar');
  go.type = 'submit';
  const stop = el('button', 'jl-btn', 'Detener');
  stop.type = 'button';
  stop.disabled = true;
  const download = el('button', 'jl-btn', 'Descargar JSON');
  download.type = 'button';
  download.disabled = true;
  const actions = el('div', 'jl-actions');
  actions.append(go, stop, download);

  form.append(field('Comienzo de la oración', prompt), grid, checks, actions);

  // Salida
  const out = el('section', 'jl-out');
  const sentence = el('p', 'jl-sentence');
  sentence.setAttribute('aria-live', 'polite');
  const stats = el('p', 'jl-stats');
  const list = el('ol', 'jl-steps');
  out.append(sentence, stats, list);
  out.hidden = true;

  page.append(meta, form, out);
  root.replaceChildren(page);

  const renderSentence = (running) => {
    sentence.replaceChildren(el('span', 'jl-given', run.prompt));
    let text = run.prompt;
    for (const s of run.steps) {
      const next = join(text, s.word);
      const shown = next.slice(text.length);
      if (shown.startsWith(' ')) sentence.append(' ');
      sentence.append(Object.assign(el('span', 'jl-new', shown.trimStart()), { title: `${pct(s.probability)} tras la penalización` }));
      text = next;
    }
    if (running) sentence.append(el('span', 'jl-caret'));
    const tokens = run.steps.reduce((n, s) => n + s.tokens, 0);
    const secs = run.steps.reduce((n, s) => n + s.ms, 0) / 1000;
    stats.textContent = `${run.steps.length} paso${run.steps.length === 1 ? '' : 's'} · ${num(tokens)} tokens · ${secs.toFixed(1)} s${running ? ' · pensando…' : ''}`;
  };

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (controller) return;
    error('');
    const opts = {
      words: Number(words.value), corpus: clean.checked ? 'limpio' : 'crudo',
      keep: keep.value === 'auto' ? 'auto' : Number(keep.value), order: order.value, framing: framing.value,
      punct: punct.checked, penalty: Number(penalty.value), ngram: ngram.checked, rerank: Number(rerank.value), target: Number(target.value),
      sample: sample.value, temperature: Number(temperature.value),
      exclude: exclude.value.split(',').map((w) => w.trim()).filter(Boolean),
    };
    const total = Math.min(30, Math.max(1, Number(steps.value) || 10));
    const seed = Math.floor(Math.random() * 1e6) + 1;
    run = { prompt: prompt.value.trim(), config: { ...opts, steps: total, stopAtEnd: stopAtEnd.checked, seed, model: config.model }, steps: [], startedAt: new Date().toISOString() };
    if (!run.prompt) return error('Escribí el comienzo de la oración.');
    controller = new AbortController();
    go.disabled = true; stop.disabled = false; download.disabled = true;
    out.hidden = false;
    list.replaceChildren();
    renderSentence(true);
    let text = run.prompt;
    const generated = [];
    try {
      for (let i = 0; i < total; i++) {
        const res = await fetch('/api/lab/jev-lm/next', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, generated, seed: seed + i * 7919, ...opts }), signal: controller.signal,
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
        const step = { n: i + 1, ...data, tokens: data.rounds.reduce((t, r) => t + (r.usage?.input_tokens ?? 0), 0) };
        run.steps.push(step);
        list.append(renderStep(step));
        generated.push(step.word);
        text = join(text, step.word);
        renderSentence(true);
        if (stopAtEnd.checked && ENDS.has(step.word)) break;
      }
    } catch (err) {
      if (err.name !== 'AbortError') error(err.message);
    } finally {
      controller = null;
      run.text = text;
      renderSentence(false);
      go.disabled = false; stop.disabled = true; download.disabled = !run.steps.length;
    }
  });

  stop.addEventListener('click', () => controller?.abort());

  download.addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(run, null, 2)], { type: 'application/json' });
    const a = el('a');
    a.href = URL.createObjectURL(blob);
    a.download = `jev-habla-${run.startedAt.replace(/[:.]/g, '-')}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
}

// Un paso: el token elegido, la distribución final (tras la penalización) y, plegadas, las ganadoras de cada bloque.
function renderStep(step) {
  const li = el('li', 'jl-step');
  const head = el('div', 'jl-step-head');
  head.append(
    el('span', 'jl-step-n', String(step.n)),
    el('span', 'jl-step-ctx', step.text),
    el('strong', 'jl-step-word', isPunct(step.word) ? `« ${step.word} »` : step.word),
    el('span', 'jl-step-meta', `${pct(step.probability)} · ${(step.ms / 1000).toFixed(1)} s · ${num(step.tokens)} tok`),
  );
  li.append(head);
  if (step.ngram) {
    li.append(el('p', 'jl-hint', step.ngram.source === 'sin filtro'
      ? 'N-gramas: contexto sin datos suficientes, se usó el corpus entero.'
      : `N-gramas (${step.ngram.source}): ${num(step.ngram.size)} candidatas.`));
  }
  if (step.rerank && step.rerank.before !== step.word) {
    li.append(el('p', 'jl-note', `El torneo elegía «${step.rerank.before}»; al leer las oraciones completas JEV prefirió «${step.word}».`));
  } else if (step.choice !== step.word && !step.rerank) {
    li.append(el('p', 'jl-note', `JEV prefería «${step.choice}» (${pct(step.confidence)}); la penalización de repetición eligió «${step.word}».`));
  }
  if (step.rerank) {
    const details = el('details', 'jl-blocks');
    details.append(el('summary', null, `Reclasificación · ${step.rerank.sentences.length} oraciones`));
    const bars = el('div', 'jl-bars');
    for (const [word, p] of step.rerank.distribution) {
      const row = el('div', `jl-bar wide${word === step.word ? ' chosen' : ''}`);
      const fill = el('span', 'jl-bar-fill');
      fill.style.width = `${Math.max(2, p * 100)}%`;
      const track = el('span', 'jl-bar-track');
      track.append(fill);
      row.append(el('span', 'jl-bar-word', join(step.text, word)), track, el('span', 'jl-bar-p', pct(p)));
      bars.append(row);
    }
    details.append(bars);
    li.append(details);
  }

  const raw = new Map(step.distribution);
  const bars = el('div', 'jl-bars');
  const top = step.adjusted.slice(0, 8); // ronda final del torneo
  const max = top[0]?.[1] || 1;
  for (const [word, p] of top) {
    const row = el('div', `jl-bar${word === step.word ? ' chosen' : ''}`);
    const fill = el('span', 'jl-bar-fill');
    fill.style.width = `${Math.max(2, (p / max) * 100)}%`;
    const track = el('span', 'jl-bar-track');
    track.append(fill);
    const before = raw.get(word) ?? 0;
    const label = el('span', 'jl-bar-p', pct(p));
    if (Math.abs(before - p) >= 0.005) label.title = `${pct(before)} antes de la penalización`;
    row.append(el('span', 'jl-bar-word', word), track, label);
    bars.append(row);
  }
  li.append(bars);

  const first = step.rounds.find((r) => r.blocks);
  if (first) {
    const details = el('details', 'jl-blocks');
    const rounds = step.rounds.length - 1;
    details.append(el('summary', null, `Ronda 1 · ${first.blocks.length} bloques de ${num(first.candidates)} opciones · pasan ${first.keep} por bloque · ${step.finalists.length} finalistas${rounds > 1 ? ` · ${rounds} rondas` : ''}`));
    const chips = el('div', 'jl-chips');
    for (const b of first.blocks) {
      const finalP = raw.get(b.choice) ?? 0;
      const chip = el('span', `jl-chip${b.choice === step.word ? ' chosen' : ''}`);
      chip.title = `Bloque ${b.block + 1}: ${pct(b.confidence ?? 0)} dentro del bloque · ${pct(finalP)} en la final`;
      chip.append(el('b', null, b.choice ?? '—'), el('small', null, pct(b.confidence ?? 0)));
      chips.append(chip);
    }
    details.append(chips);
    li.append(details);
  }
  return li;
}

async function start() {
  if (started) return;
  started = true;
  const root = $('jevlm-experiment');
  if (!root) return;
  try {
    config = await fetch('/api/lab/jev-lm/config').then((r) => r.json());
    if (!config.available) error('Falta TYPESAFE_API_KEY en el proyecto: JEV no va a poder responder.');
  } catch {
    error('No se pudo leer la configuración de JEV habla.');
  }
  mount(root);
}

window.addEventListener('tab', ({ detail }) => { if (detail === TAB) start(); });
if (document.body.dataset.tab === TAB) start();
