// Run: node server/fanout.check.mjs — real HTTP, DB and Git worktrees; fixture agents, no model calls.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';

const base = mkdtempSync(join(tmpdir(), 'xb-fanout-'));
process.env.XBLABS_DB = join(base, 'test.db');
process.env.XBLABS_HOME = join(base, 'home');
const db = await import('./db.mjs');
const worktree = await import('./worktree.mjs');
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'user.name=test', '-c', 'user.email=test@example.invalid', ...args], { encoding: 'utf8' }).trim();
const source = readFileSync(new URL('./index.mjs', import.meta.url), 'utf8');
const start = source.indexOf("    if (p === '/api/sessions' && req.method === 'POST') {");
const end = source.indexOf('    /* GOA:', start);
assert.ok(start > 0 && end > start);
const dispatched = [];
const fixture = async (id) => {
  const s = db.getSession(id);
  dispatched.push(s);
  writeFileSync(join(s.cwd, 'result.txt'), `fixture ${s.agent}\n`);
  db.updateSession(id, { status: 'idle' });
};
const context = vm.createContext({ db, worktree, process, AGENTS: { claude: {}, codex: {}, omp: {} },
  evlog: { log() {} }, configuredModel: () => null, agentLimitError: () => null,
  chat: { canBubble: (s) => s.agent !== 'omp', send: fixture },
  spawnRun: async (s) => { await fixture(s.id); return true; },
  readBody: async (req) => { let text = ''; for await (const c of req) text += c; return JSON.parse(text); },
  json: (res, status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); },
});
vm.runInContext(source.slice(source.indexOf('function isolateSession(s) {'), source.indexOf('\nconst VERSION')), context);
const dispatch = vm.runInContext(`(async (p, req, res) => { ${source.slice(start, end)} })`, context);
const server = createServer(async (req, res) => {
  try {
    if (req.url === '/api/sessions' && req.method === 'POST') return await dispatch(req.url, req, res);
    if (req.url === '/api/sessions') { res.end(JSON.stringify(db.listSessions({ limit: -1 }))); return; }
    const m = req.url.match(/^\/api\/sessions\/([\w-]+)\/git$/);
    if (m) { res.end(JSON.stringify(worktree.changes(db.getSession(m[1]).cwd))); return; }
    res.writeHead(404); res.end('{}');
  } catch (err) { res.writeHead(400); res.end(JSON.stringify({ error: err.message })); }
});
try {
  const repo = join(base, 'repo');
  mkdirSync(repo);
  git(base, 'init', '-q', '-b', 'main', repo);
  writeFileSync(join(repo, 'base.txt'), 'base\n');
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'fixture');
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  process.env.XBLABS_HUB = `http://127.0.0.1:${server.address().port}`;
  const { run } = await import('./xb.mjs');
  for (const args of [ ['--agents', 'claude,claude'], ['--agents', 'claude,'], ['--agents', 'claude,codex', '--no-branch'], ['--agents', 'claude,codex', '--agent', 'omp'] ])
    await assert.rejects(run(['spawn', ...args, '--project', repo, 'same prompt']), /usage/);
  assert.equal(dispatched.length, 0);
  const result = await run(['spawn', '--agents', 'claude,codex,omp', '--project', repo, 'same prompt']);
  assert.equal(result.code, 0, result.text);
  assert.equal(dispatched.length, 3);
  assert.equal(new Set(dispatched.map((s) => s.cwd)).size, 3);
  assert.equal(new Set(dispatched.map((s) => s.branch)).size, 3);
  assert.ok(dispatched.every((s) => s.kind === 'chat' && s.prompt === 'same prompt' && s.branch));
  assert.equal(git(repo, 'status', '--porcelain'), '');
  assert.ok(dispatched.every((s) => readFileSync(join(s.cwd, 'result.txt'), 'utf8') === `fixture ${s.agent}\n`));
  const comparison = await run(['compare', ...dispatched.slice(0, 2).map((s) => s.id)]);
  assert.equal(comparison.code, 0);
  assert.match(comparison.text, /fixture claude/); assert.match(comparison.text, /fixture codex/);
  assert.match(comparison.text, /branch: xb\/ses_/);
  await assert.rejects(run(['compare', dispatched[0].id, dispatched[0].id]), /distinct/);
  const notRepo = join(base, 'not-repo'); mkdirSync(notRepo);
  const denied = await run(['spawn', '--agents', 'claude,codex', '--project', notRepo, 'never run']);
  assert.equal(denied.code, 1); assert.match(denied.text, /prompt was not dispatched/);
  assert.equal(dispatched.length, 3);
  const rejected = db.listSessions({ limit: -1 }).filter((s) => s.prompt === 'never run');
  assert.equal(rejected.length, 0, 'a refused fan-out leaves no session that could be opened and run');
  assert.ok(!db.listProjects().some((f) => f.cwd === notRepo), 'nor a sidebar folder');
  const plain = db.createSession({ title: 'plain', agent: 'claude', cwd: notRepo, prompt: 'never run' });
  const unavailable = await run(['compare', plain.id, dispatched[0].id]);
  assert.equal(unavailable.code, 1);
  assert.match(unavailable.text, /unavailable:/);
  assert.match(unavailable.text, /fixture claude/); // one bad branch must not hide another result
  const partial = await run(['spawn', '--agents', 'unknown,claude', '--project', repo, 'partial fixture']);
  assert.equal(partial.code, 1); assert.match(partial.text, /unknown  failed/); assert.match(partial.text, /claude  ses_/);
  assert.equal(dispatched.length, 4);
  assert.equal(git(repo, 'status', '--porcelain'), '');
  console.log('fanout.check ok — distinct chat branches, same prompt, compare, fail closed, partial failure');
} finally {
  await new Promise((r) => server.close(r));
  // SQLite remains open until process exit on Windows; worktrees and fixture DB stay in scratch.
  rmSync(join(base, 'not-repo'), { recursive: true, force: true });
}
