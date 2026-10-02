import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { parseImageGenerator } from './image-models.js';

// Historia guarda cada proyecto en disco (runs/story/): un JSON por proyecto con el material que subió
// el humano, la conversación con el Guionista, la historia, las tomas (cuadro, aprobación, video) y la
// línea de tiempo (orden de las tomas + música y su volumen). Los archivos van a files/ (se sirven en /story-files/…).
//
// Toma: { id: 'S1', titulo, accion, emocion, encuadre, camara, luz, sonido, refs: ['M1'], prompt_cuadro,
//         frame: { status, file, prompt, error, round }, approved, video: { status, file, task, prompt, error, plan } }
// status: 'idle' | 'queued' | 'running' | 'done' | 'error'

export const ASPECTS = ['9:16', '16:9', '1:1'];
export const SHOT_SECONDS = 5;
export const MAX_SHOTS = 12;
export const MAX_ASSETS = 16;
const MAX_CHAT = 60;

const cleanTitle = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
const MIME = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'aac', 'audio/ogg': 'ogg', 'audio/webm': 'webm', 'audio/flac': 'flac' };

export function parseDataUrl(dataUrl, allowed = /^(image|audio)\//) {
  const m = /^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(dataUrl || '');
  if (!m || !allowed.test(m[1]) || !MIME[m[1]]) throw new Error('Formato no soportado (imágenes JPG/PNG/WEBP; audio MP3/M4A/WAV/OGG).');
  return { type: m[1], bytes: Buffer.from(m[2], 'base64'), ext: MIME[m[1]] };
}

export const emptyJob = () => ({ status: 'idle', file: null, error: null });

export function createStoryStore(dir, { rawFilesDir = null } = {}) {
  const FILES = path.join(dir, 'files');
  const PROJECTS = path.join(dir, 'projects');
  const cache = new Map();
  let queue = Promise.resolve();

  const fileOf = (id) => {
    if (!/^[\w-]{6,64}$/.test(id || '')) throw new Error('Proyecto inválido.');
    return path.join(PROJECTS, `${id}.json`);
  };

  async function load(id) {
    if (cache.has(id)) return cache.get(id);
    let p;
    try { p = JSON.parse(await readFile(fileOf(id), 'utf8')); } catch (err) {
      if (err.code === 'ENOENT') throw new Error('Ese proyecto no existe.');
      throw err;
    }
    cache.set(id, p);
    return p;
  }

  async function persist(p) {
    await mkdir(PROJECTS, { recursive: true });
    p.updatedAt = new Date().toISOString();
    const file = fileOf(p.id);
    const tmp = `${file}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(p, null, 2));
    await rename(tmp, file);
  }

  // Serializa las escrituras: varios trabajos (cuadros y videos en paralelo) tocan el mismo proyecto.
  function mutate(id, fn) {
    const run = queue.then(async () => {
      const p = await load(id);
      const out = await fn(p);
      await persist(p);
      return out ?? p;
    });
    queue = run.catch(() => {});
    return run;
  }

  async function saveFile(bytes, ext) {
    await mkdir(FILES, { recursive: true });
    const file = `${randomUUID()}.${ext}`;
    await writeFile(path.join(FILES, file), bytes);
    return file;
  }

  return {
    filesDir: FILES,
    saveFile,
    get: load,
    mutate,

    async list() {
      let names = [];
      try { names = (await readdir(PROJECTS)).filter((f) => f.endsWith('.json')); } catch { return []; }
      const all = await Promise.all(names.map((n) => load(n.slice(0, -5)).catch(() => null)));
      return all.filter(Boolean)
        .map((p) => ({
          id: p.id, title: p.title, aspect: p.aspect, rawFolderId: p.rawFolderId || null, updatedAt: p.updatedAt, shots: p.shots.length,
          clips: p.shots.filter((s) => s.video?.file).length,
          cover: p.shots.find((s) => s.frame?.file)?.frame.file || p.assets[0]?.file || null,
        }))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },

    async create({ title, aspect, rawFolderId = null, imageGenerator }) {
      const now = new Date().toISOString();
      const p = {
        id: randomUUID(), title: cleanTitle(title) || 'Historia sin título', aspect: ASPECTS.includes(aspect) ? aspect : '9:16',
        createdAt: now, updatedAt: now, counter: 0, rawFolderId,
        imageGenerator: parseImageGenerator(imageGenerator),
        assets: [], chat: [], story: null, shots: [],
        timeline: { order: [], music: null },
      };
      cache.set(p.id, p);
      await mutate(p.id, () => {});
      return p;
    },

    async remove(id) {
      await load(id);
      cache.delete(id);
      await rm(fileOf(id), { force: true });
      return { deleted: id };
    },

    update: (id, { title, aspect, imageGenerator }) => mutate(id, (p) => {
      if (imageGenerator !== undefined) p.imageGenerator = parseImageGenerator(imageGenerator);
      if (title !== undefined) p.title = cleanTitle(title) || p.title;
      if (aspect !== undefined && ASPECTS.includes(aspect)) p.aspect = aspect;
    }),

    // Material del humano: fotos, cuadros de sus videos. `M1`, `M2`… es cómo lo cita el Guionista.
    async addAsset(id, { dataUrl, name, source }) {
      const { bytes, ext } = parseDataUrl(dataUrl, /^image\//);
      const p = await load(id);
      if (p.assets.length >= MAX_ASSETS) throw new Error(`Máximo ${MAX_ASSETS} imágenes por proyecto.`);
      const file = await saveFile(bytes, ext);
      return mutate(id, (d) => {
        const asset = { code: `M${++d.counter}`, file, name: cleanTitle(name) || null, source: source === 'video' ? 'video' : 'foto', note: null };
        d.assets.push(asset);
        return asset;
      });
    },

    linkRawAsset: (id, raw) => mutate(id, (p) => {
      const existing = p.assets.find((a) => a.rawCode === raw.code);
      if (existing) return existing;
      if (p.assets.length >= MAX_ASSETS) throw new Error(`Máximo ${MAX_ASSETS} imágenes por proyecto.`);
      const asset = { code: `M${++p.counter}`, file: `raw:${path.basename(raw.file)}`, rawCode: raw.code,
        name: cleanTitle(raw.name) || null, source: 'raw', kind: raw.kind, note: raw.description || null };
      p.assets.push(asset);
      return asset;
    }),

    renameAsset: (id, code, name) => mutate(id, (p) => {
      const asset = p.assets.find((a) => a.code === code);
      if (!asset) throw new Error('Esa referencia no está en la historia.');
      asset.name = cleanTitle(name) || null;
      return asset;
    }),

    deleteAsset: (id, code) => mutate(id, (p) => {
      p.assets = p.assets.filter((a) => a.code !== code);
      p.shots.forEach((s) => { s.refs = (s.refs || []).filter((r) => r !== code); });
      return { deleted: code };
    }),

    async setMusic(id, { dataUrl, name }) {
      const { bytes, ext } = parseDataUrl(dataUrl, /^audio\//);
      const file = await saveFile(bytes, ext);
      return mutate(id, (p) => {
        p.timeline.music = { file, name: cleanTitle(name) || 'música', volume: p.timeline.music?.volume ?? 0.8, offset: 0 };
      });
    },

    // Orden de las tomas y mezcla de la música.
    setTimeline: (id, { order, music }) => mutate(id, (p) => {
      if (Array.isArray(order)) {
        const ids = new Set(p.shots.map((s) => s.id));
        const clean = [...new Set(order.map(String))].filter((x) => ids.has(x));
        p.timeline.order = [...clean, ...p.shots.map((s) => s.id).filter((x) => !clean.includes(x))];
      }
      if (music === null) p.timeline.music = null;
      else if (music && p.timeline.music) {
        const vol = Number(music.volume);
        const off = Number(music.offset);
        if (Number.isFinite(vol)) p.timeline.music.volume = Math.min(1, Math.max(0, vol));
        if (Number.isFinite(off)) p.timeline.music.offset = Math.min(600, Math.max(0, off));
      }
    }),

    pushChat: (id, ...messages) => mutate(id, (p) => {
      p.chat.push(...messages.map((m) => ({ ...m, at: new Date().toISOString() })));
      if (p.chat.length > MAX_CHAT) p.chat = p.chat.slice(-MAX_CHAT);
    }),

    async dataUrl(file) {
      const ext = path.extname(file).slice(1).toLowerCase();
      const type = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', svg: 'image/svg+xml' }[ext] || 'application/octet-stream';
      const isRaw = file.startsWith('raw:');
      if (isRaw && !rawFilesDir) throw new Error('La carpeta Raw no está disponible.');
      return `data:${type};base64,${(await readFile(path.join(isRaw ? rawFilesDir : FILES, path.basename(isRaw ? file.slice(4) : file)))).toString('base64')}`;
    },
  };
}
