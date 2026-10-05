// Drafts are scoped to the story. Taking a snapshot never shares mutable references.
export function createStorySelection(limit = 16) {
  const drafts = new Map();
  const key = (a) => a.rawCode ? `raw:${a.rawCode}` : a.code;
  const draft = (id) => { if (!drafts.has(id)) drafts.set(id, new Map()); return drafts.get(id); };
  return {
    has: (id, asset) => draft(id).has(key(asset)),
    list: (id) => [...draft(id).values()].map((a) => ({ ...a })),
    toggle(id, asset) {
      const selected = draft(id), k = key(asset);
      if (selected.has(k)) selected.delete(k);
      else {
        if (selected.size >= limit) throw new Error(`Elegí hasta ${limit} referencias para el mensaje.`);
        selected.set(k, { ...asset });
      }
    },
    remove(id, asset) { draft(id).delete(key(asset)); },
    take(id) { const references = this.list(id); draft(id).clear(); return { projectId: id, references }; },
    restore(snapshot) {
      if (!snapshot) return;
      const selected = draft(snapshot.projectId);
      for (const a of snapshot.references) if (!selected.has(key(a)) && selected.size < limit) selected.set(key(a), { ...a });
    },
  };
}
export const referenceSelectors = (refs) => refs.map((a) => a.rawCode ? { rawCode: a.rawCode } : { code: a.code });
