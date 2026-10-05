import { createAgentRunner } from './agent.js';
import { STORY_SYSTEM, DP_SYSTEM, STORY_SPEECH_DEFAULT, storyTurnPrompt, frameFixPrompt, frameImagePrompt, shotVideoPrompt } from './story-prompts.js';
import { finalVideoPrompt } from './intuition-prompts.js';
import { VIDEO_MODELS } from './wavespeed.js';
import { SHOT_SECONDS, MAX_SHOTS, MAX_ASSETS, emptyJob } from './story-store.js';
import { parseImageGenerator, imageRequest } from './image-models.js';
import { parseStoryReferences, referenceSnapshot, storyHistoryText } from './story-references.js';

// Historia: el humano conversa con el Guionista (turnos con streaming); todo lo que tarda (dibujar cuadros,
// dirigir y generar cada toma) corre en segundo plano, una tarea por toma, en paralelo. El estado vive en el
// proyecto (story-store) y la interfaz lo consulta; así un video de minutos no depende de que la pestaña siga abierta.

const MAX_REFS = 4;
const str = (x, max = 600) => String(x ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

// ---------- Tomas: validar lo que devuelve el Guionista y fusionarlo con lo que ya existe ----------
export function sanitizeShot(raw, assetCodes) {
  const refs = [...new Set((Array.isArray(raw?.refs) ? raw.refs : []).map((r) => String(r).trim().toUpperCase()))].filter((c) => assetCodes.has(c)).slice(0, MAX_REFS);
  const beats = (Array.isArray(raw?.vinetas) ? raw.vinetas : []).map((v) => str(v, 220)).filter(Boolean).slice(0, 6);
  const fallback = str(raw?.accion, 220) || 'La acción de la toma';
  while (beats.length < 6) beats.push(`${fallback} · momento ${beats.length + 1}`);
  return {
    id: /^S\d{1,3}$/.test(String(raw?.id || '')) ? String(raw.id) : null,
    titulo: str(raw?.titulo, 80) || 'Toma',
    funcion: str(raw?.funcion, 300),
    intensidad: clamp(Math.round(Number(raw?.intensidad) || 3), 1, 5),
    accion: str(raw?.accion, 600),
    emocion: str(raw?.emocion, 200),
    encuadre: str(raw?.encuadre, 200),
    camara: str(raw?.camara, 200),
    luz: str(raw?.luz, 300),
    refs,
    vinetas: beats,
    prompt_cuadro: str(raw?.prompt_cuadro, 2000),
    reglas: (Array.isArray(raw?.reglas) ? raw.reglas : []).map((r) => str(r, 80)).filter(Boolean).slice(0, 8),
  };
}

// Una toma cuyo cuadro no cambia conserva su cuadro, su aprobación y su video.
// Devuelve las tomas nuevas y los ids que quedaron invalidados (para cancelar sus tareas).
export function mergeShots(existing, incoming, assetCodes) {
  const before = new Map(existing.map((s) => [s.id, s]));
  const used = new Set();
  let next = Math.max(0, ...existing.map((s) => Number(s.id.slice(1)) || 0));
  const reset = [];
  const shots = [];
  for (const raw of (Array.isArray(incoming) ? incoming : []).slice(0, MAX_SHOTS)) {
    const s = sanitizeShot(raw, assetCodes);
    if (!s.id || used.has(s.id)) s.id = `S${++next}`;
    else next = Math.max(next, Number(s.id.slice(1)));
    used.add(s.id);
    const old = before.get(s.id);
    const same = old && old.prompt_cuadro === s.prompt_cuadro && old.refs.join() === s.refs.join()
      && (old.vinetas || []).join() === s.vinetas.join();
    if (same) shots.push({ ...old, ...s, frame: old.frame, storyboard: old.storyboard, approved: old.approved, video: old.video });
    else {
      if (old) reset.push(s.id);
      shots.push({ ...s, frame: emptyJob(), storyboard: emptyJob(), approved: false, video: emptyJob() });
    }
  }
  for (const id of before.keys()) if (!used.has(id)) reset.push(id);
  return { shots, reset };
}

function sanitizeStory(raw, assetCodes) {
  if (!raw || typeof raw !== 'object') return null;
  const ev = raw.estilo_visual || {};
  return {
    titulo: str(raw.titulo, 120), logline: str(raw.logline, 400), emocion_central: str(raw.emocion_central, 200), arco: str(raw.arco, 600),
    estilo_visual: { paleta: str(ev.paleta, 300), luz: str(ev.luz, 300), textura: str(ev.textura, 300), look: str(ev.look, 400) },
    personajes: (Array.isArray(raw.personajes) ? raw.personajes : []).slice(0, 8).map((p) => ({
      nombre: str(p?.nombre, 60), descripcion_visual: str(p?.descripcion_visual, 600),
      material: (Array.isArray(p?.material) ? p.material : []).map((m) => String(m).toUpperCase()).filter((m) => assetCodes.has(m)),
    })),
    musica: str(raw.musica, 300),
  };
}

const sanitizeQuestions = (qs) => (Array.isArray(qs) ? qs : []).slice(0, 3)
  .map((q) => ({ pregunta: str(q?.pregunta, 200), opciones: (Array.isArray(q?.opciones) ? q.opciones : []).map((o) => str(o, 80)).filter(Boolean).slice(0, 5) }))
  .filter((q) => q.pregunta);

export function parseStoryTurnBody(body) {
  const projectId = String(body?.projectId || '');
  const text = String(body?.text || '').slice(0, 4000).trim();
  const answers = (Array.isArray(body?.answers) ? body.answers : []).slice(0, 6).map((a) => ({ pregunta: str(a?.pregunta, 200), respuesta: str(a?.respuesta, 200) })).filter((a) => a.respuesta);
  if (!projectId) throw new Error('Falta el proyecto.');
  if (!text && !answers.length) throw new Error('Escribí qué historia querés contar.');
  return { projectId, text, answers, references: parseStoryReferences(body.references) };
}

// Las imágenes del humano, rotuladas con su código, para que el agente las vea.
async function assetParts(store, assets, codes, onMissing) {
  const list = codes ? assets.filter((a) => codes.includes(a.code)) : assets;
  const parts = [];
  for (const a of list) {
    let url;
    try { url = await store.dataUrl(a.file); }
    catch (err) { if (onMissing && err.code === 'ENOENT') { onMissing(a); continue; } throw err; }
    parts.push({ type: 'text', text: `${a.code}${a.name ? ` — ${a.name}` : ''}` }, { type: 'image_url', image_url: { url } });
  }
  return parts;
}

// ---------- Un turno de conversación con el Guionista ----------
export async function runStoryTurn({ store, jobs, input, config, emit, llm, signal, remember = true }) {
  const project = await store.get(input.projectId);
  const log = { startedAt: new Date().toISOString(), projectId: project.id, input: { text: input.text, answers: input.answers }, steps: {} };
  const { agent, totals } = createAgentRunner({ emit, llm, signal, log });

  const references = (input.references || []).map((ref) => {
    const asset = project.assets.find((a) => a.code === ref.code);
    if (!asset) throw new Error('Esa referencia no está en la historia.');
    return referenceSnapshot(ref.file ? ref : asset);
  });
  const history = project.chat.slice(-12).map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', content: storyHistoryText(m) }));
  const userText = [input.text, ...(input.answers || []).map((a) => `${a.pregunta} → ${a.respuesta}`)].filter(Boolean).join('\n');
  if (remember) {
    await store.pushChat(project.id, { role: 'user', text: userText, references, at: log.startedAt });
    emit({ type: 'story_user', text: userText, references });
  }
  // Bound image context as the archive grows, prioritizing associations already
  // used in shots/cast and recent messages. Explicit current attachments always go first.
  const priorCodes = [...new Set([
    ...project.shots.flatMap((s) => s.refs || []),
    ...(project.story?.personajes || []).flatMap((p) => p.material || []),
    ...project.chat.slice(-12).reverse().flatMap((m) => (m.references || []).map((a) => a.code)),
    ...project.assets.map((a) => a.code),
  ])].filter((code) => !references.some((r) => r.code === code)).slice(0, MAX_ASSETS);
  const content = [{ type: 'text', text: storyTurnPrompt({ project, text: input.text, answers: input.answers, references }) },
    { type: 'text', text: 'Imágenes adjuntas explícitamente a ESTE mensaje:' }, ...(await assetParts(store, references)),
    { type: 'text', text: 'Material previo de la historia (contexto, NO seleccionado en este mensaje):' },
    ...(await assetParts(store, project.assets, priorCodes, (a) => emit({ type: 'notice', text: `La imagen previa ${a.name || a.code} ya no está disponible. Conservo sus asociaciones en la historia.` })))];
  const data = await agent({
    step: 'story-turn', role: 'Guionista', title: 'El Guionista piensa la historia', model: config.storyModel, system: STORY_SYSTEM,
    temperature: 0.7, history, content, meta: { project, text: input.text },
  });

  const codes = new Set(project.assets.map((a) => a.code));
  const decir = str(data.decir, 1200) || 'Listo.';
  const preguntas = sanitizeQuestions(data.preguntas);
  let reset = [];
  await store.mutate(project.id, (p) => {
    for (const n of Array.isArray(data.notas_material) ? data.notas_material : []) {
      const a = p.assets.find((x) => x.code === String(n?.codigo || '').toUpperCase());
      if (a && n.nota) a.note = str(n.nota, 240);
    }
    const story = sanitizeStory(data.historia, codes);
    if (story) p.story = story;
    if (Array.isArray(data.tomas) && data.tomas.length) {
      const merged = mergeShots(p.shots, data.tomas, codes);
      p.shots = merged.shots;
      reset = merged.reset;
      p.timeline.order = p.shots.map((s) => s.id);
    }
    p.ready = !!data.listo_para_storyboard && p.shots.length > 0;
    p.cost = (p.cost || 0) + totals.cost;
    if (remember) p.chat.push(
      { role: 'assistant', text: decir, preguntas, at: new Date().toISOString() },
    );
    p.chat = p.chat.slice(-60);
  });
  reset.forEach((id) => jobs.cancel(project.id, id));
  emit({ type: 'story_reply', decir, preguntas, ready: !!data.listo_para_storyboard });
  emit({ type: 'project', project: await jobs.view(project.id) });
  return { ...log, totals };
}

// ---------- Tareas en segundo plano (cuadros y videos, una por toma) ----------
export function createStoryJobs({ store, ws, llm, config, log = console }) {
  const running = new Map(); // `${pid}/${sid}/frame|video` → AbortController
  const live = new Map(); // mismo key → texto de progreso (no se guarda en disco)
  const uploads = new Map(); // archivo → Promise<URL en WaveSpeed>

  const key = (pid, sid, kind) => `${pid}/${sid}/${kind}`;
  const upload = (file, signal) => {
    if (!uploads.has(file)) {
      const p = store.dataUrl(file).then((d) => ws.upload(d, signal));
      p.catch(() => uploads.delete(file));
      uploads.set(file, p);
    }
    return uploads.get(file);
  };
  const setShot = (pid, sid, fn) => store.mutate(pid, (p) => {
    const s = p.shots.find((x) => x.id === sid);
    if (s) fn(s, p);
  });

  function start(pid, sid, kind, work) {
    const k = key(pid, sid, kind);
    running.get(k)?.abort();
    const controller = new AbortController();
    running.set(k, controller);
    const note = (text) => live.set(k, text);
    (async () => {
      try {
        await work({ signal: controller.signal, note });
      } catch (err) {
        if (controller.signal.aborted) return;
        log.error?.(`Historia ${k}: ${err.message}`);
        await setShot(pid, sid, (s) => { s[kind] = { ...s[kind], status: 'error', error: err.message.slice(0, 400) }; }).catch(() => {});
      } finally {
        if (running.get(k) === controller) { running.delete(k); live.delete(k); }
      }
    })();
  }

  // Ejecuta un agente fuera de un stream: sus notas van al progreso de la toma y su costo al proyecto.
  async function runAgent(pid, opts, { signal, note }) {
    const agentLog = { steps: {} };
    let notes = '';
    const emit = (ev) => {
      if (ev.type === 'delta') { notes += ev.text; note(notes.replace(/\s+/g, ' ').trim().slice(-220)); }
      if (ev.type === 'notice') note(ev.text);
    };
    const { agent, totals } = createAgentRunner({ emit, llm, signal, log: agentLog });
    const data = await agent(opts);
    await store.mutate(pid, (p) => { p.cost = (p.cost || 0) + totals.cost; });
    return { data, notes: notes.trim() };
  }

  // Modo demo sin imagen generada: un cuadro de muestra con el título de la toma.
  async function placeholder(project, shot) {
    const [w, h] = { '9:16': [540, 960], '16:9': [960, 540], '1:1': [720, 720] }[project.aspect];
    const hue = (Number(shot.id.slice(1)) * 47) % 360;
    const esc = (s) => String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},45%,28%)"/><stop offset="1" stop-color="hsl(${(hue + 60) % 360},55%,12%)"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/><text x="50%" y="46%" fill="#fff" font-family="sans-serif" font-size="${Math.round(w / 12)}" text-anchor="middle">${esc(shot.id)}</text><text x="50%" y="56%" fill="#ffffffcc" font-family="sans-serif" font-size="${Math.round(w / 24)}" text-anchor="middle">${esc(shot.titulo.slice(0, 32))}</text><text x="50%" y="92%" fill="#ffffff88" font-family="sans-serif" font-size="${Math.round(w / 34)}" text-anchor="middle">demo · sin imagen generada</text></svg>`;
    return store.saveFile(Buffer.from(svg), 'svg');
  }

  // Dibuja el primer cuadro de una toma. `anchor`: un cuadro ya dibujado que sirve de referencia de
  // continuidad cuando el humano no subió material (mismos personajes y mundo en todas las tomas).
  async function drawFrame(pid, sid, { signal, note, anchor, imageGenerator }) {
    const project = await store.get(pid);
    const shot = project.shots.find((s) => s.id === sid);
    if (!shot) return;
    await setShot(pid, sid, (s) => { s.frame.status = 'running'; });
    const refCodes = shot.refs.filter((c) => project.assets.some((a) => a.code === c));
    const files = refCodes.map((c) => project.assets.find((a) => a.code === c).file);
    let prompt = frameImagePrompt({ project, shot, refCodes });
    if (!files.length && anchor) {
      files.push(anchor);
      prompt += '\nThe reference image is another frame of this same story: keep the same characters, wardrobe, world and color grade, but compose THIS shot as described.';
    }
    note(files.length ? `Dibujando con ${files.length} referencia${files.length > 1 ? 's' : ''}…` : 'Dibujando…');
    const images = await Promise.all(files.map((f) => upload(f, signal)));
    const request = imageRequest({ generator: imageGenerator, model: images.length ? config.frameEditModel : config.frameModel, prompt, images, aspect: project.aspect, quality: config.frameQuality });
    const out = await ws.image({
      ...request, signal,
      onStatus: ({ status, elapsed }) => note(`${request.model} · ${status} · ${Math.round(elapsed)} s`),
    });
    // En demo el "cuadro" es una copia de la referencia (o una tarjeta con el título si no hay).
    const file = ws.mock && !/\.(jpe?g|png|webp)$/i.test(out.file || '') ? await placeholder(project, shot) : out.file;
    if (!file) throw new Error('El modelo de imagen no devolvió el cuadro.');
    await setShot(pid, sid, (s) => {
      s.frame = { status: 'done', file, prompt, model: request.model, round: (s.frame?.round || 0) + 1, error: null };
      s.storyboard = { ...emptyJob(), status: 'queued' };
      s.approved = false;
      s.video = emptyJob();
    });
    // La plancha visual muestra seis momentos de una misma toma. El cuadro aprobado sigue
    // siendo una imagen aparte y es el punto de partida exacto del video.
    if (ws.mock) {
      await setShot(pid, sid, (s) => { s.storyboard = { ...emptyJob(), status: 'done', demo: true }; });
    } else {
      try {
        await setShot(pid, sid, (s) => { s.storyboard.status = 'running'; });
        note('Dibujando las seis viñetas de la toma…');
        const image = await upload(file, signal);
        const beats = (shot.vinetas || []).map((v, i) => `${i + 1}. ${v}`).join('\n');
        const sheetPrompt = `Create ONE cinematic storyboard contact sheet with EXACTLY six distinct panels arranged in TWO ROWS and THREE COLUMNS, read left to right, top to bottom. The reference image is the exact opening composition and character identity. Show the action evolving across the next five seconds in one continuous shot, no scene cuts. Moments:\n${beats}\nPreserve face, clothing, setting, camera direction and lighting. Crisp panel borders, no letters, no captions, no logos. Each panel has the same aspect ratio as the opening frame. Style: ${project.story?.estilo_visual?.look || 'cinematic film still'}.`;
        const sheetRequest = imageRequest({ generator: imageGenerator, model: config.frameEditModel, prompt: sheetPrompt, images: [image], aspect: '16:9', quality: config.frameQuality });
        const sheet = await ws.image({ ...sheetRequest, signal,
          onStatus: ({ status, elapsed }) => note(`Storyboard · ${status} · ${Math.round(elapsed)} s`),
        });
        if (!sheet.file) throw new Error('El modelo no devolvió la plancha.');
        await setShot(pid, sid, (s) => { s.storyboard = { status: 'done', file: sheet.file, model: sheetRequest.model, error: null }; });
      } catch (err) {
        if (signal.aborted) throw err;
        await setShot(pid, sid, (s) => { s.storyboard = { status: 'error', file: null, error: err.message.slice(0, 400) }; });
      }
    }
  }

  const queueFrame = (pid, sid, extra = {}) => setShot(pid, sid, (s) => {
    s.frame = { ...s.frame, status: 'queued', error: null };
    s.storyboard = emptyJob();
    s.approved = false;
    running.get(key(pid, sid, 'video'))?.abort();
    s.video = emptyJob();
  }).then(() => extra);

  return {
    // El estado del proyecto + el progreso en vivo de cada tarea.
    async view(pid) {
      const p = await store.get(pid);
      return {
        ...p,
        shots: p.shots.map((s) => ({ ...s, live: { frame: live.get(key(pid, s.id, 'frame')) || null, video: live.get(key(pid, s.id, 'video')) || null } })),
        busy: p.shots.some((s) => ['queued', 'running'].includes(s.frame?.status) || ['queued', 'running'].includes(s.storyboard?.status) || ['queued', 'running'].includes(s.video?.status)),
      };
    },

    cancel(pid, sid) {
      for (const kind of ['frame', 'video']) running.get(key(pid, sid, kind))?.abort();
    },

    // Storyboard: dibuja los cuadros de las tomas pedidas (o de todas las que no tienen), en paralelo.
    async frames(pid, sids) {
      const p = await store.get(pid);
      const imageGenerator = parseImageGenerator(p.imageGenerator);
      if (!p.shots.length) throw new Error('Todavía no hay tomas: conversá primero con el Guionista.');
      const targets = (sids?.length ? p.shots.filter((s) => sids.includes(s.id)) : p.shots.filter((s) => s.frame?.status !== 'done'))
        .filter((s) => !running.has(key(pid, s.id, 'frame')));
      for (const s of targets) await queueFrame(pid, s.id);
      // Sin material del humano, el primer cuadro fija el mundo y los demás lo toman de referencia.
      const noRefs = targets.every((s) => !s.refs.length) && !p.assets.length;
      const existing = p.shots.find((s) => s.frame?.status === 'done' && !targets.includes(s))?.frame.file;
      if (noRefs && !existing && targets.length > 1) {
        const [first, ...rest] = targets;
        start(pid, first.id, 'frame', async (ctx) => {
          await drawFrame(pid, first.id, { ...ctx, imageGenerator });
          const anchor = (await store.get(pid)).shots.find((s) => s.id === first.id)?.frame?.file;
          rest.forEach((s) => start(pid, s.id, 'frame', (c) => drawFrame(pid, s.id, { ...c, anchor, imageGenerator })));
        });
      } else {
        targets.forEach((s) => start(pid, s.id, 'frame', (ctx) => drawFrame(pid, s.id, { ...ctx, anchor: noRefs ? existing : null, imageGenerator })));
      }
      return { started: targets.map((s) => s.id) };
    },

    // El humano pide cambios sobre un cuadro: el Guionista lo mira y corrige la toma (o se usa su prompt editado a mano).
    async reviseFrame(pid, sid, { feedback, prompt }) {
      const p = await store.get(pid);
      const imageGenerator = parseImageGenerator(p.imageGenerator);
      const shot = p.shots.find((s) => s.id === sid);
      if (!shot) throw new Error('Esa toma no existe.');
      if (!feedback && !prompt) throw new Error('Contá qué querés cambiar.');
      await queueFrame(pid, sid);
      start(pid, sid, 'frame', async (ctx) => {
        await setShot(pid, sid, (s) => { s.frame.status = 'running'; });
        if (prompt) {
          await setShot(pid, sid, (s) => { s.prompt_cuadro = String(prompt).slice(0, 2000); });
        } else {
          ctx.note('El Guionista mira el cuadro…');
          const project = await store.get(pid);
          const cur = project.shots.find((s) => s.id === sid);
          const content = [
            { type: 'text', text: frameFixPrompt({ project, shot: cur, feedback }) },
            ...(cur.frame?.file ? [{ type: 'text', text: `${sid} — cuadro actual` }, { type: 'image_url', image_url: { url: await store.dataUrl(cur.frame.file) } }] : []),
            ...(await assetParts(store, project.assets, cur.refs)),
          ];
          const { data } = await runAgent(pid, {
            step: `shotfix-${sid}`, role: 'Guionista', title: `${sid} · Corrigiendo el cuadro`, model: config.storyModel, system: STORY_SYSTEM,
            temperature: 0.5, content, meta: { shot: cur, feedback },
          }, ctx);
          const codes = new Set(project.assets.map((a) => a.code));
          const fixed = sanitizeShot({ ...data.toma, id: sid }, codes);
          await setShot(pid, sid, (s) => { Object.assign(s, fixed, { id: sid }); s.lastChange = str(data.cambios, 300); });
        }
        const anchor = (await store.get(pid)).shots.find((s) => s.id !== sid && s.frame?.status === 'done')?.frame.file;
        await drawFrame(pid, sid, { ...ctx, anchor: p.assets.length ? null : anchor, imageGenerator });
      });
      return { started: [sid] };
    },

    // Aprobada: el Director de Fotografía escribe la toma y Wan 3.0 la genera (5 s, 480p). Cada aprobación, su propia tarea.
    async approve(pid, sid, { feedback } = {}) {
      const p = await store.get(pid);
      const shot = p.shots.find((s) => s.id === sid);
      if (!shot) throw new Error('Esa toma no existe.');
      if (shot.frame?.status !== 'done' || !shot.frame.file) throw new Error(`${sid} todavía no tiene cuadro dibujado.`);
      if (running.has(key(pid, sid, 'video'))) return { started: [] };
      await setShot(pid, sid, (s) => { s.approved = true; s.video = { ...emptyJob(), status: 'queued', audioRequested: true }; });
      start(pid, sid, 'video', async (ctx) => {
        await setShot(pid, sid, (s) => { s.video.status = 'running'; });
        ctx.note('El Director de Fotografía mira el cuadro…');
        const project = await store.get(pid);
        const order = project.timeline.order.length ? project.timeline.order : project.shots.map((s) => s.id);
        const idx = order.indexOf(sid);
        const byId = (id) => project.shots.find((s) => s.id === id);
        const cur = byId(sid);
        const content = [
          { type: 'text', text: shotVideoPrompt({ project, shot: cur, prev: byId(order[idx - 1]), next: byId(order[idx + 1]), feedback: str(feedback, 800) }) },
          { type: 'image_url', image_url: { url: await store.dataUrl(cur.frame.file) } },
          ...(cur.storyboard?.file ? [{ type: 'text', text: 'Storyboard: seis momentos de esta toma, en orden de lectura.' }, { type: 'image_url', image_url: { url: await store.dataUrl(cur.storyboard.file) } }] : []),
        ];
        const { data: plan } = await runAgent(pid, {
          step: `shotdp-${sid}`, role: 'Director de Fotografía', title: `${sid} · Dirigiendo la toma`, model: config.dpModel, system: DP_SYSTEM,
          temperature: 0.5, content, meta: { shot: cur },
        }, ctx);
        const prompt = `${finalVideoPrompt(plan)}\nAudio: ${str(plan.sonido, 300) || 'Natural synchronized sounds of the visible action and setting, with fitting ambient sound. No voiceover or soundtrack unless requested.'}\n${STORY_SPEECH_DEFAULT}`;
        await setShot(pid, sid, (s) => { s.video.prompt = prompt; s.video.plan = plan; });
        const wan = VIDEO_MODELS.wan;
        ctx.note('Subiendo el cuadro a WaveSpeed…');
        const image = await upload(cur.frame.file, ctx.signal);
        const out = await ws.video({
          model: config.videoModel, signal: ctx.signal,
          body: wan.body({ prompt, image, duration: SHOT_SECONDS, aspect: project.aspect, resolution: config.videoResolution, generateAudio: true }),
          onStatus: ({ status, elapsed, task }) => {
            if (task) setShot(pid, sid, (s) => { s.video.task = task; }).catch(() => {});
            ctx.note(`Wan 3.0 · ${status}${elapsed ? ` · ${Math.round(elapsed)} s` : ''}`);
          },
        });
        await setShot(pid, sid, (s) => { s.video = { ...s.video, status: 'done', file: out.file, task: out.task, demo: !!ws.mock, error: null }; });
      });
      return { started: [sid] };
    },

    // Al arrancar el servidor: las tomas que quedaron generándose se retoman (la tarea ya estaba paga) o se marcan.
    async resume() {
      for (const { id: pid } of await store.list()) {
        const p = await store.get(pid);
        for (const s of p.shots) {
          if (['queued', 'running'].includes(s.frame?.status)) {
            await setShot(pid, s.id, (x) => { x.frame = { ...x.frame, status: 'error', error: 'Se reinició el servidor mientras se dibujaba: volvé a dibujarlo.' }; });
          }
          if (['queued', 'running'].includes(s.video?.status)) {
            if (s.video.task && !ws.mock) {
              start(pid, s.id, 'video', async (ctx) => {
                ctx.note('Retomando la toma en WaveSpeed…');
                const out = await ws.collect({ task: s.video.task, signal: ctx.signal, onStatus: ({ status, elapsed }) => ctx.note(`Wan 3.0 · ${status} · ${Math.round(elapsed)} s`) });
                await setShot(pid, s.id, (x) => { x.video = { ...x.video, status: 'done', file: out.file, error: null }; });
              });
            } else {
              await setShot(pid, s.id, (x) => { x.video = { ...x.video, status: 'error', error: 'Se reinició el servidor antes de enviar la toma: aprobala de nuevo.' }; x.approved = false; });
            }
          }
        }
      }
    },
  };
}
