// Run: node server/xb.check.mjs — xb arg parsing, session resolution, and an MCP round trip. No hub needed.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { parse, duration, resolveIn } from './xb.mjs';

const p = parse(['--agent', 'codex', '--yes', 'hello', 'world', '--no-branch']);
assert.deepEqual(p, { flags: { agent: 'codex', yes: true, branch: false }, words: ['hello', 'world'] });
assert.equal(duration('30m'), 1800000);
assert.equal(duration('90'), 90000);
assert.throws(() => duration('soon'));

const list = [{ id: 'ses_aaa1', title: 'Alpha' }, { id: 'ses_aab2', title: 'beta' }];
assert.equal(resolveIn(list, 'ses_aaa1'), 'ses_aaa1');
assert.equal(resolveIn(list, 'ses_aab'), 'ses_aab2');
assert.equal(resolveIn(list, 'ALPHA'), 'ses_aaa1');
assert.throws(() => resolveIn(list, 'ses_aa'), /ambiguous/);
assert.throws(() => resolveIn(list, 'nope'), /no session/);

/* MCP over a real child process: initialize, tools/list, help via tools/call. */
const child = spawn(process.execPath, [new URL('./xb.mjs', import.meta.url).pathname.replace(/^\/(\w:)/, '$1'), 'mcp'], { stdio: ['pipe', 'pipe', 'inherit'] });
let buf = ''; const waiters = [];
child.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); waiters.shift()(m); } });
const rpc = (m) => new Promise((r) => { waiters.push(r); child.stdin.write(JSON.stringify(m) + '\n'); });
assert.equal((await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })).result.serverInfo.name, 'xb');
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
const tools = (await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).result.tools;
assert.equal(tools.length, 1); assert.equal(tools[0].name, 'xb');
const help = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'xb', arguments: { args: ['help'] } } });
assert.match(help.result.content[0].text, /xb spawn/);
child.stdin.end();
console.log('xb.check ok');
