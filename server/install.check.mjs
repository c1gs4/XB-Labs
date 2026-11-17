// node server/install.check.mjs: the one-line installer is filled in and only serves agent files.
import assert from 'node:assert/strict';
import { okHost, file, script, FILES } from './install.mjs';

assert.ok(okHost('100.64.0.1:5200') && okHost('hub.tail1234.ts.net') && okHost('localhost:5200'));
for (const bad of ["x$(id)", "a'b", 'a b', '-oProxy', '', 'a:b:c', 'a;b']) assert.ok(!okHost(bad), bad);

assert.equal(file('server/db.mjs'), null, 'only whitelisted files');
assert.equal(file('../package.json'), null);
assert.match(file('package.json', 'linux'), /node-pty-prebuilt-multiarch/);
assert.match(file('package.json', 'win32'), /"node-pty"/);
assert.match(file('server/agent.mjs'), /dials|hub/);

for (const kind of ['sh', 'ps1']) {
  const s = script(kind, 'hub:5200');
  assert.ok(!/__[A-Z_]+__/.test(s), `${kind}: placeholders filled`);
  assert.ok(s.includes("'http://hub:5200'") && s.includes("'ws://hub:5200'"), `${kind}: hub address`);
  for (const f of FILES) assert.ok(s.includes(f), `${kind}: fetches ${f}`);
}
/* The worker hashes the same files as the hub, or every worker would always look out of date. */
const { readFileSync: rf } = await import('node:fs');
const agentSrc = rf(new URL('./agent.mjs', import.meta.url), 'utf8');
const listed = JSON.parse(agentSrc.match(/const BUILD_FILES = (\[[^\]]*\])/)[1].replace(/'/g, '"'));
const { BUILD_FILES, agentBuild } = await import('./install.mjs');
assert.deepEqual(listed, BUILD_FILES);
assert.match(agentBuild(), /^[0-9a-f]{16}$/);
console.log('install.check ok');
