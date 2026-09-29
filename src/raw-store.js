import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';

// Raw guarda todo en disco (runs/raw/): carpetas y subcarpetas, las imágenes de cada proyecto
// (personas, referencias y generadas) y la conversación con el agente. Así las imágenes quedan
// "vivas" en el proyecto: el agente y el humano las pueden volver a usar en cualquier momento.
//
// index.json: { folders: [...], assets: [...], history: { <folderId>: [...] }, counters: { P, R, G } }
// files/: los archivos de imagen (se sirven en /raw-files/…); files/tts/: audios de voz cacheados.

export const KINDS = { persona: 'P', referencia: 'R', generada: 'G' };
export const MAX_NAME = 80;
const MAX_HISTORY = 40;

const cleanName = (name) => String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);

function dataUrlParts(dataUrl) {
  const m = /^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/=\s]+)$/.exec(dataUrl || '');
  if (!m) throw new Error('La imagen tiene que ser JPG, PNG, WEBP o GIF.');
  return { type: m[1], bytes: Buffer.from(m[2], 'base64'), ext: m[1].split('/')[1].replace('jpeg', 'jpg') };
}

export function createRawStore(dir) {
  const FILES = path.join(dir, 'files');
  const INDEX = path.join(dir, 'index.json');
  let data = null;
  let queue = Promise.resolve();

  async function load() {
    if (data) return data;
    try {
      data = JSON.parse(await readFile(INDEX, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') throw new Error(`No pude leer ${INDEX}: ${err.message}`);
      data = {};
    }
    data.folders ??= [];
    data.assets ??= [];
    data.history ??= {};
    data.counters ??= { P: 0, R: 0, G: 0 };
    return data;
  }

  // Escritura atómica (archivo temporal + rename), una por vez.
  async function persist() {
    await mkdir(dir, { recursive: true });
    const tmp = `${INDEX}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(data, null, 2));
    await rename(tmp, INDEX);
  }

  // Serializa las operaciones que modifican el índice.
  function mutate(fn) {
    const run = queue.then(async () => {
      await load();
      const out = await fn(data);
      await persist();
      return out;
    });
    queue = run.catch(() => {});
    return run;
  }

  const folderOf = (d, id) => d.folders.find((f) => f.id === id);
  function requireFolder(d, id) {
    const f = folderOf(d, id);
    if (!f) throw new Error('Esa carpeta no existe.');
    return f;
  }

  // La carpeta y todas sus antecesoras, de la raíz hacia abajo.
  function lineageOf(d, id) {
    const out = [];
    for (let f = folderOf(d, id); f && out.length < 50; f = f.parentId ? folderOf(d, f.parentId) : null) out.unshift(f);
    return out;
  }

  function descendantsOf(d, id) {
    const out = [id];
    for (let i = 0; i < out.length; i++) d.folders.filter((f) => f.parentId === out[i]).forEach((f) => out.push(f.id));
    return out;
  }

  async function saveImage(dataUrl) {
    const { bytes, ext } = dataUrlParts(dataUrl);
    if (bytes.length > 15 * 1024 * 1024) throw new Error('La imagen supera 15 MB.');
    const file = `${randomUUID()}.${ext}`;
    await mkdir(FILES, { recursive: true });
    await writeFile(path.join(FILES, file), bytes);
    return file;
  }

  return {
    filesDir: FILES,

    async tree() {
      const d = await load();
      return d.folders.map((f) => ({
        ...f,
        assets: d.assets.filter((a) => a.folderId === f.id).length,
        children: d.folders.filter((c) => c.parentId === f.id).length,
      }));
    },

    createFolder: ({ name, parentId = null }) => mutate((d) => {
      const clean = cleanName(name);
      if (!clean) throw new Error('Ponele un nombre a la carpeta.');
      if (parentId) requireFolder(d, parentId);
      const folder = { id: randomUUID(), name: clean, parentId: parentId || null, createdAt: new Date().toISOString() };
      d.folders.push(folder);
      return folder;
    }),

    renameFolder: (id, name) => mutate((d) => {
      const clean = cleanName(name);
      if (!clean) throw new Error('Ponele un nombre a la carpeta.');
      const f = requireFolder(d, id);
      f.name = clean;
      return f;
    }),

    // Borra la carpeta, sus subcarpetas, sus imágenes y su conversación.
    deleteFolder: (id) => mutate(async (d) => {
      requireFolder(d, id);
      const ids = new Set(descendantsOf(d, id));
      const gone = d.assets.filter((a) => ids.has(a.folderId));
      d.folders = d.folders.filter((f) => !ids.has(f.id));
      d.assets = d.assets.filter((a) => !ids.has(a.folderId));
      ids.forEach((i) => delete d.history[i]);
      await Promise.all(gone.map((a) => rm(path.join(FILES, a.file), { force: true })));
      return { deleted: ids.size, assets: gone.length };
    }),

    async lineage(id) {
      const d = await load();
      requireFolder(d, id);
      return lineageOf(d, id);
    },

    // Las imágenes que el proyecto tiene a mano: las de la carpeta y las de sus carpetas padre
    // (una subcarpeta hereda las personas y referencias del proyecto), en orden de llegada.
    async assetsFor(id, { inherit = true } = {}) {
      const d = await load();
      requireFolder(d, id);
      const ids = new Set(inherit ? lineageOf(d, id).map((f) => f.id) : [id]);
      return d.assets.filter((a) => ids.has(a.folderId)).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.seq - b.seq);
    },

    async getAsset(code) {
      const d = await load();
      return d.assets.find((a) => a.code === code || a.id === code) || null;
    },

    // kind: persona | referencia | generada. `dataUrl` o `file` (ya guardado en filesDir).
    addAsset: ({ folderId, kind, dataUrl, file, name, prompt, inputs }) => mutate(async (d) => {
      requireFolder(d, folderId);
      if (!KINDS[kind]) throw new Error(`Tipo de imagen desconocido: ${kind}`);
      const saved = file || await saveImage(dataUrl);
      const letter = KINDS[kind];
      d.counters[letter] = (d.counters[letter] || 0) + 1;
      const asset = {
        id: randomUUID(),
        code: `${letter}${d.counters[letter]}`,
        seq: d.assets.length,
        folderId,
        kind,
        file: saved,
        name: cleanName(name) || null,
        category: null, // la pone el agente cuando la mira
        description: null,
        tags: [],
        prompt: prompt || null,
        inputs: inputs || [],
        createdAt: new Date().toISOString(),
      };
      d.assets.push(asset);
      return asset;
    }),

    updateAsset: (code, patch) => mutate((d) => {
      const a = d.assets.find((x) => x.code === code || x.id === code);
      if (!a) throw new Error(`No encuentro la imagen ${code}.`);
      // La letra del código no cambia (es su identidad); solo cambia el tipo.
      if (patch.kind && KINDS[patch.kind] && a.kind !== 'generada') a.kind = patch.kind;
      if (patch.name !== undefined) a.name = cleanName(patch.name) || null;
      if (patch.category !== undefined) a.category = cleanName(patch.category) || null;
      if (patch.description !== undefined) a.description = String(patch.description || '').slice(0, 400) || null;
      if (Array.isArray(patch.tags)) a.tags = patch.tags.map(cleanName).filter(Boolean).slice(0, 8);
      return a;
    }),

    deleteAsset: (code) => mutate(async (d) => {
      const a = d.assets.find((x) => x.code === code || x.id === code);
      if (!a) throw new Error(`No encuentro la imagen ${code}.`);
      d.assets = d.assets.filter((x) => x !== a);
      await rm(path.join(FILES, a.file), { force: true });
      return a;
    }),

    async history(folderId) {
      const d = await load();
      return d.history[folderId] || [];
    },

    appendHistory: (folderId, entries) => mutate((d) => {
      requireFolder(d, folderId);
      const list = [...(d.history[folderId] || []), ...entries.map((e) => ({ ...e, at: new Date().toISOString() }))];
      d.history[folderId] = list.slice(-MAX_HISTORY);
      return d.history[folderId];
    }),

    async dataUrl(asset) {
      const ext = path.extname(asset.file).slice(1).toLowerCase();
      const type = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' }[ext] || 'image/jpeg';
      return `data:${type};base64,${(await readFile(path.join(FILES, asset.file))).toString('base64')}`;
    },
  };
}
