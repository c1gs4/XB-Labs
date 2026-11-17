// Run: node server/omp-job.check.mjs
import assert from 'node:assert/strict';
process.env.XBLABS_DB = ':memory:';
const db = await import('./db.mjs');
const pty = await import('./pty.mjs');
db.setSetting('llm.base_url', 'http://router.example/v1');
db.setSetting('llm.model', 'hub-default');
db.setLlmAgents(['omp']);
const job = db.createJob({ title: 'OMP metadata check', prompt: 'test' });
const row = db.createSession({ job_id: job.id, title: 'OMP', kind: 'job', agent: 'omp', device: 'worker', cwd: '/repo', prompt: 'test', model: 'requested-model' });
assert.equal(pty.runEnv(row).LLM_MODEL, 'requested-model');
const argv = pty.jobArgv(row);
assert.deepEqual(argv.slice(-6), ['--mode', 'json', '--extension', 'xblabs:omp', '--model', 'xblabs/requested-model']);
const send = () => true;
pty.attachRemote(row.id, send);
const frames = [
  { type: 'session', id: 'omp1' },
  { type: 'message_end', message: { role: 'assistant', model: 'requested-model', provider: 'xblabs' } },
  { type: 'turn_end', message: { usage: { input: 12, output: 3, cacheRead: 4 } } },
  { type: 'turn_end', message: { usage: { input: 8, output: 2, cacheRead: 1 } } },
  { type: 'agent_end' },
];
const wire = 'not JSON\r\n' + frames.map(f => JSON.stringify(f)).join('\r\n');
for (let i = 0; i < wire.length; i += 7) pty.pump(row.id, wire.slice(i, i + 7));
pty.finish(row.id, 0);
pty.finish(row.id, 0); // Duplicate transport exit cannot count tokens twice.
assert.equal(db.getSession(row.id).status, 'done');
assert.equal(db.getSession(row.id).model, 'requested-model');
assert.equal(pty.runEnv(db.getSession(row.id)).LLM_MODEL, 'requested-model');
assert.equal(pty.jobArgv(db.getSession(row.id)).at(-1), 'xblabs/requested-model');
assert.deepEqual(db.requestSummary().n, 1);
assert.equal(db.requestSummary().tin, 25); // whole context input includes cache, as chat accounting does.
assert.equal(db.requestSummary().tout, 5);
assert.equal(db.listEvents(row.id).filter(e => e.kind === 'done').length, 1);
// Partial usage survives disconnect and an unterminated final JSON line.
const interrupted = db.createSession({ job_id: job.id, title: 'partial', kind: 'job', agent: 'omp', device: 'worker', cwd: '/repo', prompt: 'test' });
pty.attachRemote(interrupted.id, send);
pty.pump(interrupted.id, JSON.stringify(frames[2]));
pty.finish(interrupted.id, 1);
assert.equal(db.getSession(interrupted.id).status, 'failed');
assert.equal(db.sessionStats()[interrupted.id].tin, 16);
const ssh = db.createSession({ job_id: job.id, title: 'SSH routing refusal', kind: 'job', agent: 'omp', device: 'worker', cwd: '/repo', prompt: 'test' });
db.updateSession(ssh.id, { ssh: JSON.stringify({ host: 'example' }) });
assert.equal(pty.ensure(ssh.id), null);
assert.equal(db.getSession(ssh.id).status, 'failed');
assert.match(db.readLog(ssh.id), /SSH cannot bind its provider/);
db.setSetting('llm.model', '');
assert.throws(() => pty.jobArgv({ ...row, model: '' }), /requires HTTP/);
db.setSetting('llm.base_url', 'file:///bad');
assert.throws(() => pty.jobArgv(row), /requires HTTP/);
console.log('OMP job ok: explicit routing, chunked JSON, one request, summed tokens, duplicate exit, disconnect');
