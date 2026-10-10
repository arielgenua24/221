import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { incompatibility, videoBody } from './models.js';

// Las tareas continúan aunque el usuario cambie de carpeta o recargue la página.
// El ID del proveedor se guarda apenas se recibe. Recuperar solo consulta: no reenvía.
export function createCinematicJobs({ dir, catalog, openrouter, wavespeed, mock = false }) {
  const active = new Map();
  const file = (id) => {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Experimento inválido.');
    return path.join(dir, `${id}.json`);
  };
  async function persist(job) {
    await mkdir(dir, { recursive: true });
    const target = file(job.id), tmp = `${target}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(job)); await rename(tmp, target);
  }
  const snapshot = ({ input, ...job }) => ({ ...job, input: { ...input, references: input.references.map(({ name }) => ({ name })), audio: input.audio ? { name: input.audio.name } : null } });
  // Serializa escrituras de los cuatro resultados; una escritura antigua nunca pisa una nueva.
  function saver(job) {
    let queue = Promise.resolve();
    return () => { queue = queue.then(() => persist(job)); return queue; };
  }
  async function execute(job, recover = false) {
    const save = saver(job);
    const uploads = new Map();
    const signal = AbortSignal.timeout(30 * 60000);
    const upload = (url) => {
      if (!url.startsWith('data:')) return url;
      if (!uploads.has(url)) uploads.set(url, wavespeed.upload(url, signal));
      return uploads.get(url);
    };
    await Promise.allSettled(job.results.map(async (result) => {
      if (!['queued', 'running', 'recoverable'].includes(result.status)) return;
      const started = Date.now();
      const onStatus = async (s) => {
        result.phase = s.status;
        if (s.task) result.task = s.task;
        if (s.pollingUrl) result.pollingUrl = s.pollingUrl;
        await save();
      };
      try {
        const client = result.provider === 'openrouter' ? openrouter : wavespeed;
        if (!client && !mock) throw new Error(`Falta la clave de ${result.provider === 'openrouter' ? 'OpenRouter' : 'WaveSpeed'}.`);
        if (recover && !result.task) throw new Error('La ejecución se interrumpió antes de guardar el ID del proveedor. No se reenvió para evitar un cobro duplicado.');
        result.status = 'running'; result.error = null; await save();
        let output;
        if (mock) output = { file: null, task: 'demo', cost: 0 };
        else if (result.task) output = await client.collect({ task: result.task, pollingUrl: result.pollingUrl, onStatus, signal });
        else {
          const { models } = await catalog();
          const m = models.find((m) => m.provider === result.provider && m.id === result.model);
          const reason = incompatibility(m, job.input);
          if (reason) { result.status = 'skipped'; result.error = reason; await save(); return; }
          let images = job.input.references.map((r) => r.url), audio = job.input.audio?.url;
          // Los archivos locales se alojan una vez por tarea para que ambos proveedores
          // reciban URLs de los mismos bytes. OpenRouter no tiene endpoint de upload.
          if (images.some((u) => u.startsWith('data:')) || audio?.startsWith('data:')) {
            if (!wavespeed) throw new Error('Para subir archivos locales se necesita la clave de WaveSpeed. También podés usar URLs HTTPS.');
            images = await Promise.all(images.map(upload));
            if (audio) audio = await upload(audio);
          }
          output = await client.video({ model: result.model, body: videoBody(m, job.input, { images, audio }), onStatus, signal });
        }
        Object.assign(result, output, { status: 'done', phase: mock ? 'demo' : 'completed', ms: result.ms + Date.now() - started });
      } catch (err) {
        Object.assign(result, { status: (err.task || result.task) && !err.final ? 'recoverable' : 'error', error: err.message,
          task: err.task || result.task, cost: err.cost ?? result.cost, ms: result.ms + Date.now() - started });
      }
      await save();
    }));
    job.status = 'done'; await save();
  }
  function launch(job, recover = false) {
    const promise = execute(job, recover).catch(async (err) => {
      job.status = 'error'; job.error = err.message; await persist(job);
    }).finally(() => active.delete(job.id));
    active.set(job.id, { job, promise });
  }
  async function read(id) { return active.get(id)?.job || JSON.parse(await readFile(file(id), 'utf8')); }
  return {
    async start(input) {
      const { models } = await catalog();
      const job = { id: randomUUID(), createdAt: new Date().toISOString(), status: 'running', mock, input,
        results: input.generators.map((g, i) => {
          const m = models.find((m) => m.provider === g.provider && m.id === g.model);
          const error = incompatibility(m, input);
          return { key: 'ABCD'[i], ...g, name: m?.name || g.model, status: error ? 'skipped' : 'queued', error,
            phase: '', ms: 0, cost: error ? 0 : null, task: null, file: null };
        }) };
      await persist(job); launch(job); return snapshot(job);
    },
    async get(id) {
      const job = await read(id);
      if (job.status === 'running' && !active.has(id)) launch(job, true);
      return snapshot(job);
    },
    async recover(id) {
      const job = await read(id);
      if (active.has(id)) {
        if (job.status === 'running') return snapshot(job);
        await active.get(id).promise;
      }
      if (!job.results.some((r) => r.status === 'recoverable' && r.task)) throw new Error('No hay tareas pendientes para recuperar.');
      job.status = 'running'; await persist(job); launch(job, true); return snapshot(job);
    },
  };
}
