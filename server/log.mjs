// In-memory event ring: the Logs page reads this. Server truth, not a mock stream.
const RING = [];
const MAX = 500;
const subs = new Set();

export function log(level, src, msg) {
  const e = { t: new Date().toTimeString().slice(0, 8), lvl: level, src, msg, at: Date.now() };
  RING.push(e);
  if (RING.length > MAX) RING.shift();
  for (const fn of subs) fn(e);
  return e;
}

export const list = (limit = 200) => RING.slice(-limit).reverse();
export const clear = () => { const n = RING.length; RING.length = 0; return n; };
export const subscribe = (fn) => { subs.add(fn); return () => subs.delete(fn); };
