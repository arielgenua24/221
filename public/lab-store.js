// Laboratorio · persistencia local.
// localStorage: experimentos (configuración, métricas, evaluaciones) — livianos, para el historial.
// IndexedDB: lo pesado, por referencia (el video, las imágenes de referencia, los cuadros y el código de cada agente).
// createLabStore() arma un almacén con su propio namespace (Context Lab usa otro); las funciones exportadas
// sueltas son las de Motion Design, con las mismas claves de siempre.

export function createLabStore({ key: KEY, prefsKey: PREFS, db: DB }) {
  function read(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
  }
  function write(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
  }

  const listExperiments = () => read(KEY, []);
  function saveExperiment(ex) {
    const all = listExperiments().filter((x) => x.id !== ex.id);
    all.unshift({ ...ex, updatedAt: new Date().toISOString() });
    all.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    if (!write(KEY, all)) throw new Error('No se pudo guardar el experimento (localStorage lleno o bloqueado).');
  }
  function deleteExperiment(id) {
    write(KEY, listExperiments().filter((x) => x.id !== id));
    return dropBlobs(id);
  }
  const prefs = () => read(PREFS, {});
  const setPrefs = (p) => write(PREFS, { ...prefs(), ...p });

  // ---------- IndexedDB ----------
  let dbp = null;
  function db() {
    dbp ??= new Promise((resolve, reject) => {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore('blobs');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbp;
  }
  async function tx(mode, fn) {
    const d = await db();
    return new Promise((resolve, reject) => {
      const t = d.transaction('blobs', mode);
      const out = fn(t.objectStore('blobs'));
      t.oncomplete = () => resolve(out?.result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('IndexedDB abortó la operación'));
    });
  }
  // Claves: `<experimentId>:video`, `<experimentId>:inputs`, `<experimentId>:code:A`, …
  const putBlob = (key, value) => tx('readwrite', (s) => s.put(value, key)).catch(() => null);
  const getBlob = (key) => tx('readonly', (s) => s.get(key)).catch(() => undefined);
  async function dropBlobs(id) {
    try {
      await tx('readwrite', (s) => s.delete(IDBKeyRange.bound(`${id}:`, `${id}:￿`)));
    } catch { /* nada que borrar */ }
  }

  return { listExperiments, saveExperiment, deleteExperiment, prefs, setPrefs, putBlob, getBlob };
}

const motion = createLabStore({ key: 'lab.motion.experiments.v1', prefsKey: 'lab.motion.prefs.v1', db: 'lab-motion' });
export const { listExperiments, saveExperiment, deleteExperiment, prefs, setPrefs, putBlob, getBlob } = motion;
