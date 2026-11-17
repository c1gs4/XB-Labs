// Real worker PTY + hub TUI lifecycle; temporary DB, no model calls.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { WebSocketServer } from 'ws';
process.env.XBLABS_DB = ':memory:';
const db = await import('./db.mjs');
const pty = await import('./pty.mjs');
const chat = await import('./chat.mjs');
const { AGENTS, applySettings } = await import('./agents.mjs');
const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'xb-tui-'));
const fixture = join(dir, 'terminal.cjs');
writeFileSync(fixture, "process.stdout.write('NATIVE_READY '+process.pid+'\\r\\n');process.stdin.on('data',d=>process.stdout.write('INPUT:'+d));setInterval(()=>{},1000);\n");
const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
await new Promise(r => server.once('listening', r));
let socket, hello, busy = false, err = '';
const frames = [], replies = new Map();
let seq = 0;
const sendTo = (_, m) => { socket.send(JSON.stringify(m)); return true; };
const askAgent = (_, m) => new Promise((resolve, reject) => {
  const req = ++seq;
  const t = setTimeout(() => { replies.delete(req); reject(new Error('worker timeout')); }, 10000);
  replies.set(req, r => { clearTimeout(t); replies.delete(req); resolve(r); });
  sendTo('', { ...m, req });
});
server.on('connection', ws => {
  socket = ws;
  ws.on('message', raw => {
    const m = JSON.parse(raw); frames.push(m);
    if (m.type === 'hello') hello = m;
    if (m.type === 'ls-result') replies.get(m.req)?.(m);
    if (m.type === 'data') pty.pump(m.id, m.data);
    if (m.type === 'exit') pty.finish(m.id, m.code);
  });
});
const worker = spawn(process.execPath, [fileURLToPath(new URL('./agent.mjs', import.meta.url)), '--hub', `ws://127.0.0.1:${server.address().port}`, '--name', 'fixture'], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
worker.stderr.on('data', d => err += d);
async function wait(fn, label) { const end = Date.now() + 25000; while (Date.now() < end) { if (fn()) return; await new Promise(r => setTimeout(r, 25)); } throw new Error(label + '\n' + err); }
const source = readFileSync(new URL('./index.mjs', import.meta.url), 'utf8');
const history = [{ kind: 'user', text: 'old' }];
chat.setRemoteHistory(async () => history);
try {
  await wait(() => hello, 'hello');
  assert.equal(hello.tuiProtocol, 1);
  const r = await askAgent('fixture', { type: 'chat-history', id: 'missing', agent: 'invalid' });
  assert.match(r.error, /history unavailable/);
  for (const agent of ['hermes', 'omp']) {
    const row = db.createSession({ title: agent, agent, device: 'fixture', kind: 'chat', cwd: dir });
    db.updateSession(row.id, { mode: 'json', status: 'idle', agent_session: 'exact-thread' });
    const agents = new Map([['fixture', { meta: hello }]]);
    let argv;
    const adapted = { [agent]: { json: { tui: ctx => { assert.equal(ctx.resume, 'exact-thread'); return ['node', fixture]; } } } };
    const context = vm.createContext({ db, pty, chat: { busy: () => busy, setTuiOpening() {} }, AGENTS: adapted, agents, readRemoteHistory: async () => history, applySettings, randomUUID: () => 'new-id', askAgent, sendTo, URL, tsListenIp: '100.64.0.1', PORT: 5200 });
    const start = source.indexOf('const openingTui =');
    vm.runInContext(source.slice(start, source.indexOf('/* ---------- job run summary', start)), context);
    context.id = row.id;
    busy = true;
    await assert.rejects(vm.runInContext('openSessionTui(id)', context), /answering/);
    busy = false;
    await Promise.all([vm.runInContext('openSessionTui(id)', context), vm.runInContext('openSessionTui(id)', context)]);
    await wait(() => frames.some(f => f.id === row.id && f.data?.includes('NATIVE_READY')), 'native ready');
    assert.equal(frames.filter(f => f.id === row.id && f.type === 'spawned').length, 1, 'deduplicated startup');
    const chunks = [], handlers = {};
    const client = { readyState: 1, send: raw => chunks.push(JSON.parse(raw)), on: (name, fn) => { handlers[name] = fn; } };
    pty.attach(row.id, client);
    assert.ok(pty.isTui(row.id));
    assert.match(chunks[0].data, /NATIVE_READY/);
    assert.ok(pty.write(row.id, 'KEYS_OK\r'));
    await wait(() => chunks.some(c => c.data?.includes('INPUT:KEYS_OK')), 'interactive stdin');
    handlers.close();
    const replay = [];
    pty.attach(row.id, { readyState: 1, send: raw => replay.push(JSON.parse(raw)), on() {} });
    assert.match(replay[0].data, /NATIVE_READY/);
    assert.equal(frames.filter(f => f.id === row.id && f.type === 'spawned').length, 1, 'reattach never restarts process');
    const closed = chat.closeTui(row.id);
    await closed;
    await wait(() => !pty.isLive(row.id), 'terminal closed');
    assert.equal(db.getSession(row.id).status, 'idle');
    assert.equal(db.readLog(row.id), '', 'TUI redraws must not pollute JSON log');
    agents.clear();
    await assert.rejects(vm.runInContext('openSessionTui(id)', context), /update XBLabs worker/);
  }
  assert.ok(AGENTS.hermes.json.tui({ sid: 's' }).includes('xblabs-s'));
  assert.deepEqual(AGENTS.omp.json.tui({ resume: 'exact-thread' }), ['omp', '--resume', 'exact-thread']);
  console.log('native-terminal.check ok — real interactive PTY, exact resume, concurrent attach, replay, same process, close, fail-closed; no inference');
} finally {
  pty.killAll(); worker.kill('SIGINT');
  await new Promise(r => worker.exitCode !== null ? r() : worker.once('exit', r));
  socket?.terminate(); await new Promise(r => server.close(r));
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
}
