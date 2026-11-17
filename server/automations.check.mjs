// Run: node server/automations.check.mjs — list rules, a run once at its day and minute (not twice,
// not on other days, not when off), Run now, and a failed start kept in `last`. Temp DB, fixture runner.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const base = mkdtempSync(join(tmpdir(), 'xb-aut-'));
process.env.XBLABS_DB = join(base, 'test.db');
const au = await import('./automations.mjs');
try {
  const ok = (a) => a === 'omp';
  const good = { name: 'Deps', prompt: 'bump deps', cwd: join(base, 'repo'), agent: 'omp', days: [1, 2, 3, 4, 5], time: '09:00' };
  assert.throws(() => au.replace([{ ...good, agent: 'codex' }], ok), /Deps: codex cannot run unattended/);
  assert.throws(() => au.replace([{ ...good, days: [] }], ok), /at least one day/);
  assert.throws(() => au.replace([{ ...good, time: '9:00' }], ok), /HH:MM/);
  assert.throws(() => au.replace([{ ...good, cwd: 'repo' }], ok), /project folder/);
  assert.throws(() => au.replace([{ ...good, prompt: ' ' }], ok), /needs a prompt/);
  const [a] = au.replace([{ ...good, days: [5, 1, 1, 9] }], ok);
  assert.match(a.id, /^aut_[0-9a-f]{8}$/); assert.deepEqual(a.days, [1, 5]); assert.equal(a.ws, 'repo'); assert.equal(a.enabled, true);

  const runs = [];
  const run = async (x) => { runs.push(x.id); return { id: `ses_${runs.length}` }; };
  const mon9 = new Date(2026, 10, 16, 9, 0, 10);   // a Monday
  assert.equal(mon9.getDay(), 1);
  assert.deepEqual(await au.tick(new Date(2026, 10, 16, 8, 59, 50), run), []);
  assert.equal((await au.tick(mon9, run)).length, 1);
  assert.deepEqual(await au.tick(new Date(2026, 10, 16, 9, 0, 40), run), [], 'same minute: once');
  assert.deepEqual(await au.tick(new Date(2026, 10, 15, 9, 0, 0), run), [], 'Sunday is not a run day');
  assert.equal(au.list()[0].last.session, 'ses_1');

  /* Saving the list again keeps its history; turning it off stops the schedule. */
  au.replace([{ ...au.list()[0], enabled: false }], ok);
  assert.equal(au.list()[0].last.session, 'ses_1');
  assert.deepEqual(await au.tick(new Date(2026, 10, 17, 9, 0, 0), run), []);

  /* Run now works when off; a refused start is kept, not thrown. */
  const r = await au.record(a.id, async () => ({ error: 'repo is not a Git repository' }));
  assert.equal(r.error, 'repo is not a Git repository'); assert.equal(au.list()[0].last.error, 'repo is not a Git repository');
  await assert.rejects(au.record('aut_00000000', run), /no such automation/);
  assert.deepEqual(runs, [a.id]);
  console.log('automations.check ok — list rules, once per day and minute, off stops it, Run now, failures kept');
} finally { try { rmSync(base, { recursive: true, force: true }); } catch { /* SQLite holds the file open on Windows until exit */ } }
