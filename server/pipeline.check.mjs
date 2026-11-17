// Run: node server/pipeline.check.mjs — stage list rules, the prompt each stage gets, and the handoff
// on turn end (next stage once, stop on failure, done at the end). Temp DB, fixture sessions.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const base = mkdtempSync(join(tmpdir(), 'xb-pipe-'));
process.env.XBLABS_DB = join(base, 'test.db');
const db = await import('./db.mjs');
const pl = await import('./pipeline.mjs');
try {
  const ok = (a) => ['omp', 'hermes', 'claude'].includes(a);
  assert.throws(() => pl.clean([{ agent: 'omp' }], ok), /2 to 6/);
  assert.throws(() => pl.clean([{ agent: 'omp' }, { agent: 'codex', name: 'Review' }], ok), /Review: codex cannot run/);
  const stages = pl.clean([{ name: 'Plan', agent: 'hermes', prompt: 'Plan only.' }, { name: 'Build', agent: 'omp' }, { name: 'Review', agent: 'claude' }], ok);

  const p0 = pl.stagePrompt(stages, 0, 'add login');
  assert.match(p0, /Task: add login/); assert.match(p0, /stage 1 of 3 \(Plan\)/); assert.match(p0, /Plan only\./); assert.doesNotMatch(p0, /ended with/);
  assert.match(pl.stagePrompt(stages, 1, 'add login', 'step 1, step 2'), /Stage 1 \(Plan, hermes\) ended with:\nstep 1, step 2/);

  const turn = (id, text, extra) => { const t = db.lastTurn(id) + 1; db.addEvent(id, t, 'user', { text: 'x' }); db.addEvent(id, t, 'text', { text }); db.addEvent(id, t, 'done', extra || { error: '' }); };
  const s1 = db.createSession({ title: 'T · 1/3 Plan', cwd: base, agent: 'hermes' });
  pl.begin(s1.id, stages, 'add login');
  const started = [];
  const start = async (prev, prompt) => { const s = db.createSession({ title: 'n', cwd: prev.cwd, agent: prev.agent }); started.push({ prev, prompt, id: s.id }); return s.id; };

  turn(s1.id, 'the plan');
  let r = await pl.onTurn(s1.id, 0, start);
  assert.equal(r.state, 'next'); assert.equal(started[0].prev.agent, 'omp'); assert.equal(started[0].prev.step, 1);
  assert.match(started[0].prompt, /ended with:\nthe plan/);
  assert.equal(await pl.onTurn(s1.id, 0, start), null, 'a later turn of a finished stage starts nothing');
  assert.equal(pl.get(r.id).first, s1.id);

  const s2 = r.id;
  turn(s2, 'half', { error: 'rate limited' });
  r = await pl.onTurn(s2, 0, start);
  assert.deepEqual(r, { state: 'failed', stage: 'Build' }); assert.equal(started.length, 1);

  /* Another run of the same stages to the end. */
  const t1 = db.createSession({ title: 'U', cwd: base, agent: 'hermes' });
  pl.begin(t1.id, stages, 'other');
  turn(t1.id, 'a'); const n2 = (await pl.onTurn(t1.id, 0, start)).id;
  turn(n2, 'b'); const n3 = (await pl.onTurn(n2, 0, start)).id;
  turn(n3, 'c'); assert.deepEqual(await pl.onTurn(n3, 0, start), { state: 'done' });
  assert.equal(pl.get(n3).state, 'done'); assert.deepEqual(pl.get(t1.id).ids, [t1.id, n2, n3]);

  /* A stage that cannot start fails the pipeline instead of hanging it. */
  const v1 = db.createSession({ title: 'V', cwd: base, agent: 'hermes' });
  pl.begin(v1.id, stages, 'x'); turn(v1.id, 'a');
  r = await pl.onTurn(v1.id, 0, async () => { throw new Error('omp missing'); });
  assert.equal(r.state, 'failed'); assert.equal(r.error, 'omp missing'); assert.equal(pl.get(v1.id).state, 'failed');
  console.log('pipeline.check ok — stage rules, prompts, handoff once, stop on failure, done at the end');
} finally { try { rmSync(base, { recursive: true, force: true }); } catch { /* SQLite holds the file open on Windows until exit */ } }
