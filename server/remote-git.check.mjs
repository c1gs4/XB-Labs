// Run: node server/remote-git.check.mjs — a real worker reads and acts on its own session branch
// for the hub, and the branch reaches the hub's checkout as a bundle. Temp folders only.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const base = mkdtempSync(join(tmpdir(), 'xb-rgit-'));
process.env.XBLABS_HOME = join(base, 'home');   // the worker gets the same folder
for (const k of ['NAME', 'EMAIL']) process.env[`GIT_AUTHOR_${k}`] = process.env[`GIT_COMMITTER_${k}`] = k === 'NAME' ? 't' : 't@t';
const { isolate, takeBundle } = await import('./worktree.mjs');
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' }).trim();

const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
await new Promise((r) => server.once('listening', r));
let socket, hello, seq = 0;
const waiting = new Map();
server.on('connection', (ws) => {
  socket = ws;
  ws.on('message', (raw) => { const m = JSON.parse(raw); if (m.type === 'hello') hello = m; if (m.type === 'ls-result' && waiting.has(m.req)) waiting.get(m.req)(m); });
});
const ask = (msg) => new Promise((done) => { const req = ++seq; waiting.set(req, done); socket.send(JSON.stringify({ ...msg, req })); });
const worker = spawn(process.execPath, [fileURLToPath(new URL('./agent.mjs', import.meta.url)), '--hub', `ws://127.0.0.1:${server.address().port}`, '--name', 'far'],
  { env: { ...process.env }, stdio: ['ignore', 'ignore', 'pipe'] });
let err = ''; worker.stderr.on('data', (d) => { err += d; });

try {
  const end = Date.now() + 20000;
  while (!hello && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
  assert.ok(hello, `worker hello\n${err}`);
  assert.equal(hello.gitProtocol, 2);
  assert.equal(hello.build, (await import('./install.mjs')).agentBuild(), 'a worker on this code is up to date');

  /* The project on the far device, and the hub's own clone of it. */
  const repo = join(base, 'far-repo');
  mkdirSync(repo);
  git(base, 'init', '-q', '-b', 'main', repo);
  writeFileSync(join(repo, 'a.txt'), 'base'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'init');
  const hubCopy = join(base, 'hub-copy'); git(base, 'clone', '-q', repo, hubCopy);
  const wt = isolate(repo, 'ses_far');

  writeFileSync(join(wt.cwd, 'a.txt'), 'changed far away');
  let r = await ask({ type: 'git', cwd: wt.cwd, action: 'changes' });
  assert.equal(r.branch, 'xb/ses_far'); assert.equal(r.dirty, true); assert.match(r.patch, /changed far away/);

  r = await ask({ type: 'git', cwd: wt.cwd, action: 'commit', message: 'far work' });
  assert.ok(r.ok, JSON.stringify(r));
  r = await ask({ type: 'git', cwd: wt.cwd, action: 'bundle' });
  assert.ok(r.data && r.from, JSON.stringify(r).slice(0, 200));
  const took = takeBundle(hubCopy, r, { merge: true });
  assert.ok(took.merged, JSON.stringify(took));
  assert.equal(readFileSync(join(hubCopy, 'a.txt'), 'utf8'), 'changed far away');

  /* Clone takes Git URLs only; anything that could be read as an option or a local path is refused. */
  for (const url of ['--upload-pack=touch x', '-oProxyCommand=x', 'C:\Windows', 'file:///etc', 'https://host/repo;rm']) {
    r = await ask({ type: 'clone', url, path: base });
    assert.match(r.error, /give a Git URL/, url);
  }
  r = await ask({ type: 'clone', url: 'https://example.invalid/owner/other-repo.git', path: base });
  assert.ok(r.error && !/give a Git URL/.test(r.error), 'a well-formed URL reaches git');
  assert.ok(!existsSync(join(base, 'other-repo')), 'a failed clone leaves nothing');
  r = await ask({ type: 'git', cwd: wt.cwd, action: 'rm -rf' });
  assert.match(r.error, /unknown git action/);
  r = await ask({ type: 'git', cwd: repo, action: 'discard' });
  assert.match(r.error, /not an XBLabs branch/, 'the real checkout is never discarded');
  r = await ask({ type: 'git', cwd: wt.cwd, action: 'discard' });
  assert.ok(r.removed, JSON.stringify(r));
  assert.ok(!existsSync(wt.cwd));
  console.log('remote-git.check ok — worker diff, commit, bundle to hub + merge, clone URL rules, refuses unknown actions and the real checkout');
} finally {
  worker.kill(); server.close();
  rmSync(base, { recursive: true, force: true });
}
