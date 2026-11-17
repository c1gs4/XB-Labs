// Run: node server/hibernate.check.mjs — idle-timer choice and the max-agents refusal.
import assert from 'node:assert/strict';
import { idleToHibernate, limitError } from './hibernate.mjs';

const now = 10 * 60000, min = (m) => now - m * 60000;
const rows = [
  { id: 'old', status: 'idle', updated_at: min(5) },
  { id: 'fresh', status: 'idle', updated_at: min(1) },
  { id: 'run', status: 'running', updated_at: min(9) },
  { id: 'ask', status: 'waiting', updated_at: min(9) },
  { id: 'head', status: 'idle', updated_at: min(9) },
  { id: 'turn', status: 'idle', updated_at: min(9) },
  { id: 'gone', status: 'idle', updated_at: min(9) },
];
const live = new Set(['old', 'fresh', 'run', 'ask', 'head', 'turn']);
const o = { now, afterMin: 3, headId: 'head', live, busy: new Set(['turn']) };
assert.deepEqual(idleToHibernate(rows, o), ['old']);
assert.deepEqual(idleToHibernate(rows, { ...o, afterMin: 0 }), []);
/* A chat with no status hooks stays 'running': quiet terminal = idle; a job never counts. */
const q = { ...o, live: new Set([...live, 'tui', 'job']), quiet: (id) => ({ tui: 5 * 60000, job: 9 * 60000, run: 60000 })[id] || 0 };
assert.deepEqual(idleToHibernate([...rows, { id: 'tui', status: 'running', kind: 'chat' }, { id: 'job', status: 'running', kind: 'job' }], q), ['old', 'tui']);
assert.equal(limitError(0, 99), '');
assert.equal(limitError(3, 2), '');
assert.match(limitError(3, 3), /3 of 3/);
console.log('hibernate.check ok');
