/* Automations: a prompt that starts a new session on a schedule ("weekdays 09:00", hub local time),
   each run on a new branch of its project. Kept in the hub setting `automations`.
   ponytail: a run missed while the hub was off is skipped, not caught up; hub-local folders only. */
import { randomBytes } from 'node:crypto';
import * as db from './db.mjs';

const KEY = 'automations', MAX = 50;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
export const list = () => { try { const v = JSON.parse(db.getSetting(KEY, '[]')); return Array.isArray(v) ? v : []; } catch { return []; } };
const save = (l) => db.setSetting(KEY, JSON.stringify(l));

/* The list from the client, checked; a known id keeps its run history. Throws the reason it is refused. */
export function replace(input, canRun) {
  if (!Array.isArray(input) || input.length > MAX) throw new Error(`at most ${MAX} automations`);
  const old = new Map(list().map((a) => [a.id, a]));
  const out = input.map((a, i) => {
    const name = String(a?.name || '').trim().slice(0, 60), at = `${name || `Automation ${i + 1}`}: `;
    const prompt = String(a?.prompt || '').trim();
    if (!name) throw new Error(`${at}needs a name`);
    if (!prompt || prompt.length > 8000) throw new Error(`${at}needs a prompt (up to 8000 characters)`);
    const cwd = String(a?.cwd || '').trim();
    if (!/[\\/]/.test(cwd)) throw new Error(`${at}pick a project folder`);
    const agent = String(a?.agent || '');
    if (!canRun(agent)) throw new Error(`${at}${agent || 'no agent'} cannot run unattended (needs a chat mode on this hub)`);
    const days = [...new Set((Array.isArray(a?.days) ? a.days : []).map(Number))].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6).sort();
    if (!days.length) throw new Error(`${at}pick at least one day`);
    const time = String(a?.time || '');
    if (!TIME.test(time)) throw new Error(`${at}time is HH:MM`);
    const id = /^aut_[0-9a-f]{8}$/.test(a?.id) ? a.id : `aut_${randomBytes(4).toString('hex')}`;
    const ws = String(a?.ws || '').trim().slice(0, 120) || cwd.split(/[\\/]/).filter(Boolean).pop();
    return { id, name, prompt, cwd, ws, agent, days, time, enabled: a?.enabled !== false, last: old.get(id)?.last || null };
  });
  save(out);
  return out;
}

const minuteOf = (d) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

/* Called every few seconds: starts each enabled automation whose day and minute is now, once. */
export async function tick(now, run) {
  const l = list(), hm = minuteOf(now).slice(-5), key = minuteOf(now);
  const due = l.filter((a) => a.enabled && a.days.includes(now.getDay()) && a.time === hm && a.last?.minute !== key);
  if (!due.length) return [];
  for (const a of due) a.last = { minute: key, at: now.getTime(), session: null, error: '' };
  save(l);   // marked before running: a slow start cannot fire it twice
  const out = [];
  for (const a of due) out.push(await record(a.id, run, key));
  return out;
}

/* Run one now (the schedule, or Run now). The result lands in its `last`. */
export async function record(id, run, minute = '') {
  const a = list().find((x) => x.id === id);
  if (!a) throw new Error('no such automation');
  let r;
  try { r = await run(a); } catch (err) { r = { error: String(err.message || err) }; }
  const l = list(), cur = l.find((x) => x.id === id);
  if (cur) { cur.last = { minute: minute || cur.last?.minute || '', at: Date.now(), session: r.id || null, error: r.error || '' }; save(l); }
  return { id, ...r };
}
