// Choices an agent ends its turn asking me to pick from. One copy for the chat (app.js, loaded as a
// module that puts these on window) and the hub (server/index.mjs, for notifications).
/* Choices an answer ends with: a question, then 2 to 8 short list items (or the list, then the
   question). Anything else is an ordinary list, not a menu. */
export function askChoices(text) {
  const lines = String(text || '').replace(/\r/g, '').trim().split('\n'), opts = [];
  const item = (l) => /^\s*(?:\d{1,2}[.)]|[-*•]|[A-Ha-h][.)])\s+(.+)$/.exec(l);
  let q = !item(lines[lines.length - 1]) && lines[lines.length - 1].includes('?');
  if (q) { lines.pop(); while (lines.length && !lines[lines.length - 1].trim()) lines.pop(); }
  while (lines.length && item(lines[lines.length - 1])) opts.unshift(item(lines.pop())[1].trim());
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const lead = lines[lines.length - 1] || '';
  q = q || /\?\**:?\s*$/.test(lead) || (/:\**\s*$/.test(lead) && /\?|\b(pilih|pilihan|mana|opsi|choose|pick|which|select|option)/i.test(lead));
  return q && opts.length >= 2 && opts.length <= 8 && opts.every((o) => o.length <= 200) ? opts : null;
}
/* A clarify / AskUserQuestion tool call's own choices. */
export function toolChoices(input) {
  const i = typeof input === 'string' ? (() => { try { return JSON.parse(input); } catch { return {}; } })() : input || {};
  const raw = i.choices || i.options || i.questions?.[0]?.options || [];
  const opts = raw.map((o) => String(typeof o === 'string' ? o : o?.label || '').trim()).filter(Boolean);
  return opts.length >= 2 ? opts.slice(0, 8) : null;
}
/* The choices a conversation is waiting on: its last event that is not bookkeeping asks. */
export function lastAsk(events) {
  const ev = events.filter((e) => !['done', 'status', 'note'].includes(e.kind));
  const last = ev[ev.length - 1];
  if (!last) return null;
  if (last.kind === 'text') return askChoices(last.data.text);
  if (last.kind === 'tool' && /clarify|askuser/i.test(last.data.name || '')) return toolChoices(last.data.input);
  return null;
}
if (typeof window !== 'undefined') Object.assign(window, { askChoices, toolChoices, lastAsk });
