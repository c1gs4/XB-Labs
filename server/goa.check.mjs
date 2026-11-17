// Run: node server/goa.check.mjs — the head hands a task to a worker in its own worktree, the
// worker's report reaches the head's terminal, and only the head settles the task.
// Uses a stand-in agent (node) so no LLM is called.
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const base = mkdtempSync(join(tmpdir(), 'xbgoa-'));
process.env.XBLABS_HOME = join(base, 'home');
process.env.XBLABS_DB = ':memory:';
const heard = join(base, 'heard.txt');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 15000) => { for (let t = 0; t < ms; t += 250) { if (fn()) return true; await wait(250); } return false; };

const { AGENTS } = await import('./agents.mjs');
/* Stand-in agent: stays up, and writes whatever is typed into it to heard.txt. */
const listen = String.raw`process.stdin.on('data',d=>require('fs').appendFileSync(process.argv[1],d));setInterval(()=>{},1e6)`;
AGENTS.fake = { name: 'Fake', bin: 'node', run: (p) => ['node', '-e', '0'], chat: () => ['node', '-e', listen, heard] };
const db = await import('./db.mjs');
const pty = await import('./pty.mjs');
const goa = await import('./goa.mjs');

try {
  const repo = join(base, 'repo');
  mkdirSync(repo);
  const git = (...a) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'a.txt'), 'x');
  git('add', '.'); git('commit', '-qm', 'init');

  const h = goa.startHead('fake');
  assert.ok(h.live && h.cwd.endsWith('goa'));
  assert.ok(existsSync(join(process.env.XBLABS_HOME, 'goa', 'AGENTS.md')));
  assert.ok(existsSync(join(process.env.XBLABS_HOME, 'bin', 'xb.cmd')));
  assert.throws(() => goa.startHead('fake'), /already running/);

  assert.throws(() => goa.delegate({ agent: 'nope', project: repo, prompt: 'x' }), /unknown agent/);
  assert.throws(() => goa.delegate({ agent: 'fake', project: join(base, 'missing'), prompt: 'x' }), /no such folder/);
  assert.throws(() => goa.delegate({ agent: 'fake', device: 'Forge', project: repo, prompt: 'x' }), /this hub only/);

  const t = goa.delegate({ agent: 'fake', project: repo, prompt: 'add a readme' });
  assert.equal(t.status, 'running');
  const w = db.getSession(t.session_id);
  assert.ok(w.branch === `xb/${w.id}` && w.cwd.includes('worktrees'), w.cwd);   // own worktree
  assert.ok(pty.isLive(w.id));
  assert.match(w.prompt, /xb goa report/);                                     // worker told how to report

  assert.throws(() => goa.report(h.id, 'done'), /no open XBLabs task/);
  goa.report(w.id, 'done', 'readme added');
  assert.equal(db.getTask(t.id).status, 'reported');

  /* The head hears it once it is idle: one [XBLabs GOA] line typed into its terminal. */
  db.updateSession(h.id, { status: 'idle' });
  assert.ok(await until(() => existsSync(heard) && readFileSync(heard, 'utf8').includes('[XBLabs GOA]')), 'head never heard the report');
  assert.match(readFileSync(heard, 'utf8'), new RegExp(`${t.id}.*reported done: readme added`));

  assert.throws(() => goa.settle(t.id, 'reported'), /done\|failed\|stopped/);
  assert.equal(goa.settle(t.id, 'done').status, 'done');
  assert.ok(goa.show(t.id).worker.branch);

  /* A follow-up to a busy worker waits in the queue until that worker is ready. */
  db.updateSession(w.id, { status: 'running' });
  const f = goa.delegate({ session: w.id, prompt: 'also add a license' });
  assert.equal(f.status, 'queued');
  db.updateSession(w.id, { status: 'idle' });
  goa.pump();
  assert.equal(db.getTask(f.id).status, 'running');

  /* xb sends what the hub expects. */
  const got = [];
  const srv = createServer((req, res) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => { got.push([req.method, req.url, b]); res.end(JSON.stringify({ id: 't_1', status: 'queued', tasks: [] })); }); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const xb = (...a) => new Promise((done) => execFile(process.execPath, [join(import.meta.dirname, 'xb.mjs'), ...a],
    { env: { ...process.env, XBLABS_HUB: `http://127.0.0.1:${srv.address().port}`, XBLABS_SESSION: 'ses_w' } }, (err, out) => done(String(out))));
  assert.match(await xb('goa', 'delegate', '--agent', 'omp', '--project', 'C:/p', '--no-branch', 'fix', 'the', 'tests'), /queued t_1/);
  const [method, url, body] = got.pop();
  assert.deepEqual([method, url], ['POST', '/api/goa/tasks']);
  assert.deepEqual(JSON.parse(body), { agent: 'omp', project: 'C:/p', branch: false, prompt: 'fix the tests' });
  await xb('goa', 'report', '--outcome', 'done', 'all', 'green');
  assert.deepEqual(JSON.parse(got.pop()[2]), { session: 'ses_w', outcome: 'done', note: 'all green' });
  await xb('goa', 'task', 't_1', '--status', 'done');
  assert.deepEqual(got.pop().slice(0, 2), ['PATCH', '/api/goa/tasks/t_1']);
  srv.close();

  /* Bubble chats: a stand-in agent with a JSON mode (prints hermes-style lines). Head and worker
     both run as turns; the worker's turn end reaches the head as its next message. */
  goa.stopHead();
  const say = String.raw`const p=process.argv[1];console.log(JSON.stringify({type:'text',text:'heard: '+p.slice(0,60)}));console.log(JSON.stringify({type:'result',exit_code:0,duration_ms:5}))`;
  AGENTS.fakejson = { name: 'FakeJ', bin: 'node', run: () => ['node', '-e', '0'], chat: () => ['node', '-e', '0'], json: { argv: (p) => ['node', '-e', say, p], parse: AGENTS.hermes.json.parse } };
  const hj = goa.startHead('fakejson');
  assert.equal(db.getSession(hj.id).mode, 'json');
  const turnDone = (id) => until(() => db.listEvents(id, 0).some((e) => e.kind === 'done'));
  assert.ok(await turnDone(hj.id), 'head first turn never ended');
  const tj = goa.delegate({ agent: 'fakejson', project: repo, prompt: 'write docs' });
  const wj = db.getSession(tj.session_id);
  assert.equal(wj.mode, 'json');
  assert.ok(await until(() => db.getTask(tj.id).status === 'turn-ended'), 'worker turn end not seen');
  assert.ok(await until(() => db.listEvents(hj.id, 0).some((e) => e.kind === 'user' && /[XBLabs GOA].*ended a turn/.test(e.data.text))), 'head never got the worker news');
  assert.ok(goa.show(tj.id).screen.some((l) => /heard: write docs/.test(l)));   // xb goa show reads chat events
  console.log('goa.check ok');
} finally {
  pty.killAll();
  await wait(300);
  try { rmSync(base, { recursive: true, force: true }); } catch { /* a pty still holds a file on Windows */ }
}
process.exit(0);
