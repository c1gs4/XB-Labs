// Run: node server/team.check.mjs — the lead's plan format, a teammate per task, results back to the
// lead once all answered, failures. Temp DB, fixture sessions, no model calls.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const base = mkdtempSync(join(tmpdir(), 'xb-team-'));
process.env.XBLABS_DB = join(base, 'test.db');
const db = await import('./db.mjs');
const tm = await import('./team.mjs');
try {
  const plan = (list) => `Plan below.\n\n\`\`\`team-tasks\n${JSON.stringify(list)}\n\`\`\``;
  assert.throws(() => tm.parsePlan('no block'), /no team-tasks block/);
  assert.throws(() => tm.parsePlan('```team-tasks\n{bad\n```'), /not valid JSON/);
  assert.throws(() => tm.parsePlan(plan([{ owner: 'x' }])), /task 1 has no title/);
  const tasks = tm.parsePlan(plan([{ title: 'Store', owner: 'Store Dev', brief: 'db.js' }, { title: 'API', owner: 'store dev' }, ...Array(8).fill({ title: 'more' })]));
  assert.equal(tasks.length, tm.TASK_MAX, 'capped');
  assert.deepEqual(tasks.slice(0, 2).map((t) => [t.id, t.owner, t.status]), [['T1', 'store-dev', 'todo'], ['T2', 'store-dev-2', 'todo']], 'owners slugged, unique');
  assert.match(tm.planPrompt('build a CLI'), /```team-tasks/);
  assert.match(tm.taskPrompt('goal', tasks[0], tasks), /teammate "store-dev"[\s\S]*T1 — Store[\s\S]*Others work on: T2 API/);

  const turn = (id, text, extra) => { const t = db.lastTurn(id) + 1; db.addEvent(id, t, 'user', { text: 'x' }); db.addEvent(id, t, 'text', { text }); db.addEvent(id, t, 'done', extra || { error: '' }); };
  const lead = db.createSession({ title: 'Team', cwd: base, agent: 'hermes' });
  tm.begin(lead.id, { goal: 'ship it', agent: 'omp' });
  const started = [], sent = [];
  const start = async (l, task, prompt) => { const s = db.createSession({ title: task.owner, cwd: l.cwd, agent: 'omp', parent: l.id }); started.push({ task, prompt, id: s.id }); return s.id; };
  const send = async (id, text) => { sent.push({ id, text }); };

  /* Planning turn → two teammates. A second event for the same turn does nothing. */
  turn(lead.id, plan([{ title: 'Store', owner: 'store' }, { title: 'API', owner: 'api' }]));
  let r = await tm.onTurn(lead.id, 0, { start, send });
  assert.deepEqual(r, { state: 'working', tasks: 2 });
  assert.equal(started.length, 2);
  assert.equal((await tm.onTurn(lead.id, 0, { start, send })), null, 'planned once');
  assert.equal(tm.get(started[0].id).lead, lead.id, 'a teammate finds its team');
  assert.equal(tm.get(lead.id).tasks[1].status, 'running');
  const roles = tm.roles();
  assert.deepEqual([roles.get(lead.id).role, roles.get(lead.id).mates, roles.get(started[1].id).role, roles.get(started[1].id).lead], ['lead', 2, 'mate', lead.id], 'the sidebar hides mates behind their lead');

  /* One done: still working. Both done: the lead gets every result once. */
  turn(started[0].id, 'store done');
  r = await tm.onTurn(started[0].id, 0, { start, send });
  assert.deepEqual(r, { state: 'task', task: 'T1', status: 'done' });
  assert.equal(sent.length, 0);
  turn(started[1].id, 'api broke', { error: 'exit 1' });
  r = await tm.onTurn(started[1].id, 0, { start, send });
  assert.equal(r.state, 'review'); assert.equal(tm.get(lead.id).tasks[1].status, 'failed');
  assert.equal(sent.length, 1); assert.equal(sent[0].id, lead.id); assert.match(sent[0].text, /T1 — Store \(store, done\)\nstore done[\s\S]*T2 — API \(api, failed\)\napi broke/);
  assert.equal(await tm.onTurn(started[0].id, 0, { start, send }), null, 'a teammate\'s later turns are its own');

  /* The lead's review turn closes the run. */
  turn(lead.id, 'all good');
  assert.deepEqual(await tm.onTurn(lead.id, 0, { start, send }), { state: 'done' });

  /* A teammate whose first turn stopped for approval: its report is in that turn, the approved one only says it ran. */
  const l3 = db.createSession({ title: 'Team 3', cwd: base, agent: 'hermes' });
  tm.begin(l3.id, { goal: 'y', agent: 'omp' });
  turn(l3.id, plan([{ title: 'Only', owner: 'solo' }]));
  await tm.onTurn(l3.id, 0, { start, send });
  const solo = started[started.length - 1].id;
  turn(solo, 'full report: built x, tested y');
  turn(solo, 'Output: ok');
  r = await tm.onTurn(solo, 0, { start, send });
  assert.equal(r.state, 'review');
  assert.match(tm.get(l3.id).tasks[0].result, /full report: built x[\s\S]*Output: ok/);

  /* A lead that gives no plan fails the team, starts nobody. */
  const l2 = db.createSession({ title: 'Team 2', cwd: base, agent: 'hermes' });
  tm.begin(l2.id, { goal: 'x', agent: 'omp' });
  const before = started.length;
  turn(l2.id, 'I will just do it myself.');
  r = await tm.onTurn(l2.id, 0, { start, send });
  assert.equal(r.state, 'failed'); assert.match(r.error, /no team-tasks block/); assert.equal(started.length, before, 'nobody started');
  console.log('team.check ok — plan format, a teammate per task, results back to the lead, failures');
} finally { try { rmSync(base, { recursive: true, force: true }); } catch { /* SQLite may still hold the file on Windows */ } }
