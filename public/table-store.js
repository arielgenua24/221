// Mesa de agentes: las sesiones (texto) en localStorage y el contenido de los archivos en IndexedDB.
// Namespace propio: no toca los experimentos de Motion Design ni de Cinematic Videos.
const KEY = 'lab.table.sessions.v1';
const CURRENT = 'lab.table.current.v1';
const read = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } };
const write = (key, value) => localStorage.setItem(key, JSON.stringify(value));

export const listSessions = () => read(KEY, []);
export const getSession = (id) => listSessions().find((s) => s.id === id) || null;
export function saveSession(session) { write(KEY, [session, ...listSessions().filter((s) => s.id !== session.id)].slice(0, 60)); }
export const currentId = () => read(CURRENT, null);
export const setCurrent = (id) => write(CURRENT, id);

let dbp;
function db() {
  dbp ??= new Promise((resolve, reject) => {
    const r = indexedDB.open('lab-table', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('files');
    r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
  });
  return dbp;
}
async function transaction(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction('files', mode), r = fn(t.objectStore('files'));
    t.oncomplete = () => resolve(r?.result); t.onerror = () => reject(t.error); t.onabort = () => reject(t.error);
  });
}
// { [code]: data } por sesión.
export const putFiles = (id, files) => transaction('readwrite', (s) => s.put(files, id));
export const getFiles = async (id) => (await transaction('readonly', (s) => s.get(id))) || {};
export async function deleteSession(id) {
  await transaction('readwrite', (s) => s.delete(id)).catch(() => {});
  write(KEY, listSessions().filter((s) => s.id !== id));
}
