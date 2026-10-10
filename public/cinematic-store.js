// Mismo patrón del laboratorio: métricas livianas en localStorage y referencias en IndexedDB.
// Namespace independiente: no lee ni escribe experimentos de Motion Design.
const KEY = 'lab.cinematic.experiments.v1';
const DRAFT = 'lab.cinematic.draft.v1';
export function read(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } }
export function write(key, value) { localStorage.setItem(key, JSON.stringify(value)); }
export const listExperiments = () => read(KEY, []);
export function saveExperiment(ex) { write(KEY, [ex, ...listExperiments().filter((x) => x.id !== ex.id)]); }
export const draft = () => read(DRAFT, {});
export const saveDraft = (value) => write(DRAFT, value);
let dbp;
function db() {
  dbp ??= new Promise((resolve, reject) => {
    const r = indexedDB.open('lab-cinematic', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('assets');
    r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
  }); return dbp;
}
async function transaction(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction('assets', mode), r = fn(t.objectStore('assets'));
    t.oncomplete = () => resolve(r?.result); t.onerror = () => reject(t.error); t.onabort = () => reject(t.error);
  });
}
export const putAssets = (key, assets) => transaction('readwrite', (s) => s.put(assets, key));
export const getAssets = (key) => transaction('readonly', (s) => s.get(key));
export async function deleteExperiment(id) {
  await transaction('readwrite', (s) => s.delete(id));
  write(KEY, listExperiments().filter((x) => x.id !== id));
}
