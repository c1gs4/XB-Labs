// Run: node server/ports.check.mjs — process-tree ports, .xblabs.json run parsing, one real OS table read.
import assert from 'node:assert/strict';
import { portsOf, readTables, bgOf } from './ports.mjs';
import { parseRun } from './worktree.mjs';

const procs = [{ pid: 1, ppid: 0, name: 'init' }, { pid: 10, ppid: 1, name: 'pwsh' }, { pid: 11, ppid: 10, name: 'npm' },
  { pid: 12, ppid: 11, name: 'node' }, { pid: 50, ppid: 1, name: 'other' }];
const listeners = [{ port: 5173, pid: 12 }, { port: 3000, pid: 11 }, { port: 9999, pid: 50 }, { port: 5200, pid: 10 }, { port: 5173, pid: 12 }];
assert.deepEqual(portsOf([10], procs, listeners, [5200]).map((p) => p.port), [3000, 5173]);   // child + grandchild, unrelated 9999 and hub 5200 out, deduped
assert.equal(portsOf([10], procs, listeners, [5200])[1].name, 'node');
assert.deepEqual(portsOf([], procs, listeners), []);
assert.deepEqual(portsOf([999], procs, listeners), []);

assert.deepEqual(parseRun({ run: { dev: ' npm run dev ', test: 'npm test', bad: 5, empty: '  ' } }), { dev: 'npm run dev', test: 'npm test' });
assert.deepEqual(parseRun({ run: ['x'] }), {});
assert.deepEqual(parseRun({}), {});
assert.deepEqual(parseRun(null), {});

/* Background: what a session's turns left running; the agent itself and unrelated processes are not. */
const bp = [
  { pid: 10, ppid: 1, name: 'cmd.exe', cmd: 'cmd /c hermes chat -q hi', at: 1000 },       // a finished turn's root
  { pid: 11, ppid: 10, name: 'python.exe', cmd: 'python C:\\x\\hermes-agent\\cli.py', at: 1100 },   // the agent itself
  { pid: 12, ppid: 11, name: 'node.exe', cmd: 'node server.js --port 8000', at: 1200 },   // what it started
  { pid: 13, ppid: 12, name: 'conhost.exe', cmd: 'conhost', at: 1200 },
  { pid: 20, ppid: 10, name: 'node.exe', cmd: 'node old.js', at: -9000 },                   // pid reuse: started well before the root
  { pid: 30, ppid: 1, name: 'python.exe', cmd: 'python -m http.server --directory C:\\wt\\ses_1', at: 900 },   // names the folder
  { pid: 40, ppid: 1, name: 'node.exe', cmd: 'node other.js', at: 1300 },
];
assert.deepEqual(bgOf([{ pid: 10, at: 1000 }], bp, 'C:/wt/ses_1/').map((p) => p.pid), [30, 12]);
assert.deepEqual(bgOf([], bp, ''), []);
/* hermes: its gateway daemon runs the background call; the turn reported the pid. Children fold into it. */
const gw = [...bp, { pid: 60, ppid: 1, name: 'python.exe', cmd: 'python -m hermes_cli.main gateway run', at: 100 },
  { pid: 50, ppid: 60, name: 'bash.exe', cmd: 'bash -lic "python -m http.server 8765"', at: 2100 },
  { pid: 51, ppid: 50, name: 'python.exe', cmd: 'C:\\h\\hermes-agent\\venv\\python.exe -m http.server 8765', at: 2150 }];
assert.deepEqual(bgOf([{ pid: 10, at: 1000 }], gw, '', [{ pid: 50, at: 2000 }]).map((p) => p.pid), [12, 50]);
assert.deepEqual(bgOf([], gw, '', [{ pid: 50, at: 900000 }]), [], 'a reported pid that started long before the report is someone else');

if (process.argv.includes('--real')) {
  const t0 = Date.now(), t = await readTables();
  assert.ok(t.procs.length && t.listeners.length);
  console.log(`real tables: ${t.procs.length} procs, ${t.listeners.length} listeners, ${Date.now() - t0} ms`);
}
console.log('ports.check ok');
