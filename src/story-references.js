// Only identifiers are accepted from the browser; files and names come from the stores.
export function parseStoryReferences(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 16) throw new Error('Elegí hasta 16 referencias para el mensaje.');
  const seen = new Set();
  return value.map((ref) => {
    const raw = typeof ref?.rawCode === 'string' && /^[PRG]\d{1,6}$/.test(ref.rawCode);
    const own = typeof ref?.code === 'string' && /^M\d{1,6}$/.test(ref.code);
    if (!raw && !own) throw new Error('Referencia de mensaje inválida.');
    const item = raw ? { rawCode: ref.rawCode } : { code: ref.code };
    const key = raw ? ref.rawCode : ref.code;
    if (seen.has(key)) return null;
    seen.add(key); return item;
  }).filter(Boolean);
}
export const referenceSnapshot = ({ code, rawCode, file, name, kind, source, note }) => ({ code, rawCode, file, name, kind, source, note });
export const referenceLabels = (refs = []) => refs.map((a) => `${a.code}${a.name ? ` (${a.name})` : ''}`).join(', ');
export const storyHistoryText = (message) => `${message.text}${message.role === 'user' ? `\n[Referencias explícitas de ese mensaje: ${message.references ? referenceLabels(message.references) || 'ninguna' : 'sin registro de adjuntos; conservar el contexto previo'}]` : ''}`;
