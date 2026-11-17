// Run: node server/browser.check.mjs [--live] — pure parts; --live launches a real browser.
import assert from 'node:assert/strict';
import { mkdtempSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (process.argv.includes('--live')) process.env.XBLABS_HOME = mkdtempSync(join(tmpdir(), 'xbbrowser-'));
const b = await import('./browser.mjs');

assert.equal(b.normUrl('example.com'), 'http://example.com');
assert.equal(b.normUrl('https://x.dev/a'), 'https://x.dev/a');
assert.equal(b.normUrl('5173'), 'http://localhost:5173');
assert.equal(b.normUrl(':5173'), 'http://localhost:5173');
assert.equal(b.normUrl(':5200/api/health'), 'http://localhost:5200/api/health');
assert.equal(b.normUrl('localhost:3000'), 'http://localhost:3000');
assert.equal(b.normUrl('data:text/html,<b>x</b>'), 'data:text/html,<b>x</b>');
assert.throws(() => b.normUrl(''));
assert.deepEqual(b.parseRef('7'), { ref: 7 });
assert.deepEqual(b.parseRef('#go .a'), { css: '#go .a' });
assert.doesNotThrow(() => new Function(`return ${b.SNAPSHOT_JS}`));
console.log('browser pure checks ok');

if (process.argv.includes('--live')) {
  const png = join(process.env.XBLABS_HOME, 'shot.png');
  try {
    assert.ok(b.findExe(), 'no browser installed');
    await b.act('open', ['data:text/html,<button>Hi</button><input name=q>']);
    const s = (await b.act('snapshot')).text;
    assert.match(s, /\[1\] button "Hi"/);
    assert.match(s, /\[2\] input:text ""|\[2\] input:text "q"/);
    await b.act('fill', ['2', 'abc']);
    assert.equal((await b.act('eval', ['document.querySelector("input").value'])).text, 'abc');
    await b.act('screenshot', [png]);
    assert.ok(statSync(png).size > 1024);
    assert.ok((await b.act('screenshot')).png.length > 1024);
    // one target per session; screencast yields frames; input click changes the page
    const page = (t) => `data:text/html,<body style="margin:0"><button style="width:300px;height:200px" onclick="document.title='${t}'">go</button>`;
    await b.act('open', [page('A')], 's1'); await b.act('open', [page('B')], 's2');
    assert.equal((await b.act('eval', ['location.href'], 's1')).text.includes("'A'"), true);
    assert.equal((await b.act('eval', ['location.href'], 's2')).text.includes("'B'"), true);
    assert.equal((await b.act('eval', ['location.href'])).text.includes("'A'"), false, 'hub target is separate');
    const frames = []; const un = await b.watch('s1', (m) => m.type === 'frame' && frames.push(m));
    await b.input('s1', { type: 'move', x: 50, y: 50 });
    for (let i = 0; i < 30 && !frames.length; i++) await new Promise((r) => setTimeout(r, 200));
    assert.ok(frames.length >= 1 && frames[0].data.length > 100, 'screencast frame');
    await b.input('s1', { type: 'click', x: 50, y: 50 });
    assert.equal((await b.act('eval', ['document.title'], 's1')).text, 'A');
    assert.equal((await b.act('eval', ['document.title'], 's2')).text, '');
    un();
    console.log('browser live checks ok');
  } finally { b.close(); await new Promise((r) => setTimeout(r, 500)); try { rmSync(process.env.XBLABS_HOME, { recursive: true, force: true }); } catch { /* profile still locked */ } }
}
