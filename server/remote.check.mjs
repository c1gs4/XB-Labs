// Run: node server/remote.check.mjs — real worker, temporary repos, no live hub/device.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { WebSocketServer } from 'ws';

const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'xb-remote-'));
const repo = join(dir, 'repo'), plain = join(dir, 'plain');
mkdirSync(repo); mkdirSync(plain);
const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
git('init', '-b', 'main'); git('config', 'user.name', 'Remote check'); git('config', 'user.email', 'check@localhost');
writeFileSync(join(repo, 'seed.txt'), 'original\n'); git('add', '.'); git('commit', '-m', 'fixture');
const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
await new Promise(r => server.once('listening', r));
const frames = [], sockets = [];
server.on('connection', ws => { sockets.push(ws); ws.on('message', raw => frames.push(JSON.parse(raw))); });
const worker = spawn(process.execPath, [new URL('./agent.mjs', import.meta.url).pathname.replace(/^\/(\w:)/, '$1'), '--hub', `ws://127.0.0.1:${server.address().port}`, '--name', 'remote-check'], {
  env: { ...process.env, XBLABS_HOME: join(dir, 'home'), TMPDIR: dir, TEMP: dir, TMP: dir }, stdio: ['ignore', 'pipe', 'pipe'],
});
let errors = ''; worker.stderr.on('data', d => { errors += d; });
async function wait(fn, label, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = fn(); if (value) return value; await new Promise(r => setTimeout(r, 40)); }
  throw new Error(`timeout: ${label}\n${errors}`);
}
const send = m => sockets.at(-1).send(JSON.stringify(m));
const frame = (type, id) => frames.find(f => f.type === type && (!id || f.id === id));
const fixture = join(dir, 'write.cjs');
writeFileSync(fixture, "require('node:fs').writeFileSync('result.txt', 'ISOLATED_OK');\n");
const command = ['node', fixture];
try {
  await wait(() => frame('hello'), 'worker hello');
  send({ type: 'spawn', id: 'bad', cwd: plain, isolate: true, argv: command });
  const bad = await wait(() => frame('exit', 'bad') || frame('spawned', 'bad'), 'reject non-repo');
  assert.equal(bad.type, 'exit', 'isolation must reject non-repo without spawning');
  assert.notEqual(bad.code, 0);
  assert.match(frames.filter(f => f.id === 'bad').map(f => f.data || '').join(''), /isolat|worktree|git/i);
  assert.equal(existsSync(join(plain, 'result.txt')), false);
  // Valid but unborn repo returns {error}, not null.
  const unborn = join(dir, 'unborn'); mkdirSync(unborn);
  execFileSync('git', ['-C', unborn, 'init'], { stdio: 'pipe' });
  send({ type: 'spawn', id: 'unborn', cwd: unborn, isolate: true, argv: command });
  assert.notEqual((await wait(() => frame('exit', 'unborn'), 'reject unborn repo')).code, 0);
  send({ type: 'spawn', id: 'missing-cwd', isolate: true, argv: command });
  assert.notEqual((await wait(() => frame('exit', 'missing-cwd'), 'reject missing cwd')).code, 0);
  send({ type: 'spawn', id: 'missing-path', cwd: join(dir, 'absent'), isolate: false, argv: command });
  assert.notEqual((await wait(() => frame('exit', 'missing-path'), 'catch spawn error')).code, 0);
  for (const id of ['one', 'two']) send({ type: 'spawn', id, cwd: repo, isolate: true, argv: command });
  for (const id of ['one', 'two']) assert.equal((await wait(() => frame('exit', id), id)).code, 0, JSON.stringify(frames.filter(f => f.id === id)));
  const runs = ['one', 'two'].map(id => frame('spawned', id));
  assert.equal(new Set(runs.map(r => r.cwd)).size, 2);
  assert.equal(new Set(runs.map(r => r.branch)).size, 2);
  for (const r of runs) { assert.equal(r.branch, `xb/${r.id}`); assert.match(readFileSync(join(r.cwd, 'result.txt'), 'utf8'), /ISOLATED_OK/); }
  assert.equal(git('status', '--porcelain'), '');
  assert.equal(existsSync(join(repo, 'result.txt')), false);
  send({ type: 'spawn', id: 'plain', cwd: plain, isolate: false, argv: command });
  assert.equal((await wait(() => frame('exit', 'plain'), 'unisolated shell')).code, 0);
  assert.ok(existsSync(join(plain, 'result.txt')));
  const longFile = join(dir, 'long.cjs'); writeFileSync(longFile, 'setInterval(()=>{},1000);\n');
  send({ type: 'spawn', id: 'long', cwd: repo, isolate: true, argv: ['node', longFile] });
  const long = await wait(() => frame('spawned', 'long'), 'long run');
  sockets.at(-1).close();
  await wait(() => { try { process.kill(long.pid, 0); return false; } catch (e) { if (e.code !== 'ESRCH') throw e; return true; } }, 'disconnect kills PTY');
  await wait(() => sockets.length === 2 && frames.filter(f => f.type === 'hello').length === 2, 'reconnect');
  console.log('remote worker ok: fail-closed, two worktrees, plain shell, disconnect/reconnect');

  // Exercise actual hub spawnRun with injected boundaries; no SSH/network side effects.
  const source = readFileSync(new URL('./index.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('async function spawnRun(s) {');
  const end = source.indexOf('\n/* 9router usage', start);
  assert.ok(start >= 0 && end > start);
  for (const manual of [false, true]) {
    const updates = [], logs = []; let ssh = 0;
    const context = {
      db: { readLog: () => '', hubSettings: () => ({ env: {} }), sessionEnv: () => ({}), updateSession: (_, patch) => updates.push(patch), appendLog: (_, data) => logs.push(data) },
      pty: { runEnv: () => ({}), jobArgv: () => null, chatArgv: () => null, ensure: () => { ssh++; return {}; } },
      sendTo: () => false, evlog: { log: (...args) => logs.push(args.join(' ')) },
      manualHosts: () => manual ? [{ name: 'remote', host: 'example', user: 'test' }] : [],
      tailscale: { status: async () => ({ devices: [{ name: 'remote', ip: '100.64.0.1' }] }), config: () => ({}) }, process: { env: {} },
    };
    vm.createContext(context);
    const spawnRun = vm.runInContext(source.slice(start, end) + '\nspawnRun', context);
    assert.equal(await spawnRun({ id: 'check', device: 'remote', isolate: true }), false);
    assert.equal(ssh, 0); assert.ok(updates.some(p => p.status === 'failed'));
    assert.match(logs.join(' '), /isolat|worktree/i);
    assert.equal(await spawnRun({ id: 'plain', device: 'remote', isolate: false }), true);
    assert.equal(ssh, 1);
  }
  assert.match(source, /spawnRun\(\{ \.\.\.s, isolate: body\.isolate === true \}\)/, 'non-chat API preserves explicit isolation');
  assert.match(source, /agents\.get\(name\) !== rec/, 'replaced socket must not detach current worker');
  assert.match(source, /pty\.isLive\(s\.id\) \|\| \['starting', 'running', 'waiting'\]/, 'disconnect covers live idle and waiting sessions');
  const closeStart = source.indexOf("  ws.on('close', () => {", source.indexOf("agentWss.on('connection'"));
  const closeEnd = source.indexOf('\n  });', closeStart);
  assert.ok(closeStart >= 0 && closeEnd > closeStart);
  const rec = {}, settled = [], rows = Array.from({ length: 2001 }, (_, i) => ({ id: `history-${i}`, device: 'other', status: 'done' }));
  rows.push({ id: 'old-active', device: 'remote', status: 'waiting' });
  const closeContext = {
    ws: { on: (_, callback) => { closeContext.close = callback; } },
    agents: new Map([['remote', rec]]), rec, name: 'remote', evlog: { log: () => {} },
    remoteTurns: { disconnect: () => {} },
    db: { listSessions: ({ limit }) => limit < 0 ? rows : rows.slice(0, limit) },
    pty: { isLive: () => false, finish: id => settled.push(id) },
  };
  vm.createContext(closeContext);
  vm.runInContext(source.slice(closeStart, closeEnd) + '\n  });', closeContext);
  closeContext.close();
  assert.deepEqual(settled, ['old-active'], 'disconnect must settle active sessions beyond newest 2000');
  console.log('remote hub ok: isolated SSH refused; plain shell preserved; uncapped disconnect cleanup');
} finally {
  worker.kill('SIGINT');
  await new Promise(r => { if (worker.exitCode !== null) return r(); worker.once('exit', r); });
  for (const ws of sockets) ws.terminate();
  await new Promise(r => server.close(r));
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
