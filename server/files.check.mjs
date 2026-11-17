// Run: node server/files.check.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { resolveInside, mentionedMedia } from './files.mjs';

const base = mkdtempSync(join(tmpdir(), 'xbfiles-'));
const cwd = join(base, 'proj'), out = join(base, 'secret.txt');
mkdirSync(join(cwd, 'sub'), { recursive: true });
writeFileSync(join(cwd, 'sub', 'a.png'), 'x'); writeFileSync(join(cwd, 'b.js'), 'x'); writeFileSync(out, 'nope');
let linked = true, flink = true;   // Windows may refuse file symlinks; junctions work
try { symlinkSync(base, join(cwd, 'dirlink'), 'junction'); } catch { linked = false; }
try { symlinkSync(out, join(cwd, 'link.txt')); } catch { flink = false; }

try {
  assert.equal(resolveInside(cwd, 'sub/a.png').type, 'image/png');
  assert.equal(resolveInside(cwd, 'b.js').type, 'text/plain; charset=utf-8');
  for (const bad of ['../secret.txt', 'sub/../../secret.txt', resolve(out), '', '..', 'a\0b'])
    assert.throws(() => resolveInside(cwd, bad), (e) => e.status === 400, `refuse ${JSON.stringify(bad)}`);
  assert.throws(() => resolveInside(cwd, 'sub'), (e) => e.status === 404);
  assert.throws(() => resolveInside(cwd, 'nope.txt'), (e) => e.status === 404);
  if (linked) {
    if (flink) assert.throws(() => resolveInside(cwd, 'link.txt'), (e) => e.status === 400);
    assert.throws(() => resolveInside(cwd, 'dirlink/secret.txt'), (e) => e.status === 400);
  } else console.log('symlink checks skipped (no permission)');

  /* A picture the agent saved elsewhere: only when its exact path is in the session's messages. */
  const pic = join(base, 'cache', 'pic.png');
  mkdirSync(join(base, 'cache')); writeFileSync(pic, 'x');
  assert.equal(mentionedMedia(pic, [`saved: ${pic}`]).type, 'image/png');
  assert.equal(mentionedMedia(pic, [JSON.stringify(`saved: ${pic}`)]).type, 'image/png', 'a JSON-escaped mention counts');
  assert.equal(mentionedMedia(pic, [`saved: ${pic.replace(/\\/g, '/')}`]).type, 'image/png', 'either slash');
  assert.throws(() => mentionedMedia(pic, ['nothing here']), (e) => e.status === 403);
  assert.throws(() => mentionedMedia(out, [out]), (e) => e.status === 400, 'text files are never served this way');
  assert.throws(() => mentionedMedia('cache/pic.png', ['cache/pic.png']), (e) => e.status === 400);
  assert.throws(() => mentionedMedia(pic.replace('.png', '.svg'), [pic.replace('.png', '.svg')]), (e) => e.status === 400, 'no svg');
  assert.throws(() => mentionedMedia(join(base, 'gone.png'), [join(base, 'gone.png')]), (e) => e.status === 404);
  console.log('files checks ok');
} finally { rmSync(base, { recursive: true, force: true }); }
