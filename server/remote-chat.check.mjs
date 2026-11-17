// Real worker + hub chat parser + temporary DB. No provider calls or installed services.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { remoteChat } from './remote-chat.mjs';
process.env.XBLABS_DB = ':memory:';
const db = await import('./db.mjs');
const chat = await import('./chat.mjs');
const { AGENTS } = await import('./agents.mjs');
const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'xb-chat-'));
const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
await new Promise(r => server.once('listening', r));
let socket, hello, workerError = '';
const frames = [];
const transport = remoteChat((name, m) => { frames.push(m); if (!socket || socket.readyState !== 1) return false; socket.send(JSON.stringify(m)); return true; }, () => hello?.chatProtocol === 1);
chat.setRemote(transport);
server.on('connection', ws => { socket = ws; ws.on('message', raw => { const m = JSON.parse(raw); frames.push(m); if (m.type === 'hello') hello = m; transport.receive('fixture', m); }); ws.on('close', () => transport.disconnect('fixture')); });
const worker = spawn(process.execPath, [fileURLToPath(new URL('./agent.mjs', import.meta.url)), '--hub', `ws://127.0.0.1:${server.address().port}`, '--name', 'fixture'], { env: { ...process.env, XBLABS_HOME: join(dir, 'home') }, stdio: ['ignore', 'pipe', 'pipe'] });
worker.stderr.on('data', d => workerError += d);
async function wait(fn, label) { const end = Date.now() + 25000; while (Date.now() < end) { if (fn()) return; await new Promise(r => setTimeout(r, 25)); } throw new Error(label + '\n' + workerError); }
const fixture = join(dir, 'agent.cjs');
writeFileSync(fixture, `const p=process.argv[2], resume=process.argv[3];
if(p==='hold'){setInterval(()=>{},1000);return;}
if(p==='fail'){process.stderr.write('fixture startup failed');process.exit(2);}
const kind=process.argv[4]; const out=o=>process.stdout.write(JSON.stringify(o)+'\\n');
if(kind==='omp') {out({type:'session',id:'thread-1'});out({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'answer '+p+' '+resume}});out({type:'turn_end',message:{usage:{input:11,output:3,cacheRead:2}}});process.stdout.write(JSON.stringify({type:'agent_end'}));}
else {out({type:'text',text:'answer '+p+' '+resume});out({type:'tool_use',tool_call_id:'t1',name:'read_file',input:{path:'fixture'}});out({type:'tool_result',tool_call_id:'t1',output:'ok'});process.stdout.write(JSON.stringify({type:'result',exit_code:0,tokens:{input:7,output:2}}));}
`);
const saved = {};
try {
  await wait(() => hello, 'worker hello');
  assert.equal(hello.chatProtocol, 1);
  for (const agent of ['hermes', 'omp']) {
    saved[agent] = AGENTS[agent].json.argv;
    AGENTS[agent].json.argv = (p, { resume }) => [process.execPath, fixture, p, resume || '', agent];
    const s = db.createSession({ title: agent, ws: 'test', agent, device: 'fixture', cwd: dir });
    db.updateSession(s.id, { mode: 'json' });
    assert.ok(chat.canBubble(s));
    await chat.send(s.id, 'first'); await wait(() => !chat.busy(s.id), 'first turn');
    let events = db.listEvents(s.id, 0);
    assert.ok(events.some(e => e.kind === 'text' && e.data.text.includes('answer first')));
    assert.ok(events.some(e => e.kind === 'done' && e.data.tokens?.output > 0), 'trailing JSON without newline must be parsed');
    if (agent === 'hermes') assert.equal(events.find(e => e.kind === 'tool').data.output, 'ok');
    else assert.equal(db.getSession(s.id).agent_session, 'thread-1');
    await chat.send(s.id, 'second'); await wait(() => !chat.busy(s.id), 'second turn');
    events = db.listEvents(s.id, 0);
    assert.equal(events.filter(e => e.kind === 'user').length, 2);
    if (agent === 'omp') assert.ok(events.some(e => e.kind === 'text' && e.data.text.includes('thread-1')));
    await chat.send(s.id, 'fail'); await wait(() => !chat.busy(s.id), 'startup failure');
    assert.ok(db.listEvents(s.id, 0).some(e => e.kind === 'error' && /fixture startup failed/.test(e.data.text)));
    assert.equal(db.getSession(s.id).status, 'idle');
    await chat.send(s.id, 'hold'); assert.ok(chat.busy(s.id)); assert.equal(chat.stop(s.id), true);
    await wait(() => !chat.busy(s.id), 'stop clears busy');
    assert.equal(db.getSession(s.id).status, 'idle');
  }
  const s = db.createSession({ title: 'disconnect', agent: 'omp', device: 'fixture', cwd: dir });
  await chat.send(s.id, 'hold'); socket.close();
  await wait(() => !chat.busy(s.id), 'disconnect settles turn');
  assert.ok(db.listEvents(s.id, 0).some(e => e.kind === 'error' && /disconnected/.test(e.data.text)));
  const sent = [];
  const isolated = remoteChat((_, m) => { sent.push(m); return true; }, () => true);
  const proc = isolated.spawn({ id: 'routing', device: 'fixture', agent: 'omp', cwd: dir }, ['omp', '-p', 'hi'], { LLM_BASE_URL: 'http://example.test/v1', LLM_MODEL: 'raw/model' });
  proc.stdin.end(); assert.deepEqual(sent[0].argv.slice(-4), ['--extension', 'xblabs:omp', '--model', 'xblabs/raw/model']);
  let output = ''; proc.stdout.on('data', d => output += d);
  isolated.receive('wrong-worker', { type: 'chat-data', id: 'routing', run: sent[0].run, stream: 'stdout', data: 'bad' });
  isolated.receive('fixture', { type: 'chat-data', id: 'routing', run: 'stale', stream: 'stdout', data: 'bad' });
  assert.equal(output, '');
  isolated.receive('fixture', { type: 'chat-data', id: 'routing', run: sent[0].run, stream: 'stdout', data: 'ok' });
  assert.equal(output, 'ok');
  console.log('remote-chat.check ok — real worker, Hermes/OMP parsers, resume, tools, tokens, startup error, stop, disconnect, endpoint routing, stale frames');
} finally {
  for (const [id, argv] of Object.entries(saved)) AGENTS[id].json.argv = argv;
  worker.kill('SIGTERM'); await new Promise(r => { if (worker.exitCode !== null) r(); else worker.once('exit', r); });
  if (socket) socket.terminate(); await new Promise(r => server.close(r));
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
