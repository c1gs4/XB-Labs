// Run: node server/worktree.check.mjs — sessions get their own worktree under XBLabs' folder,
// never share files, and their work reaches the real checkout only through commit + merge.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const base = mkdtempSync(join(tmpdir(), 'xbwt-'));
process.env.XBLABS_HOME = join(base, 'home');
const { isolate, changes, act, home, setupCommand, changedFiles, secretsIn, list, setRoots, root, checkRoot, bundle, takeBundle } = await import('./worktree.mjs');
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' }).trim();
process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 't';
process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 't@t';
try {
  const repo = join(base, 'repo');
  mkdirSync(join(repo, 'sub'), { recursive: true });
  git(base, 'init', '-q', '-b', 'main', repo);
  assert.ok(isolate(repo, 'ses_empty')?.error);                                // no commits yet → error, caller keeps cwd
  writeFileSync(join(repo, 'sub', 'a.txt'), 'base');
  writeFileSync(join(repo, '.gitignore'), '.env\n');
  writeFileSync(join(repo, '.xblabs.json'), JSON.stringify({ setup: 'npm ci' }));   // no "copy": .env by default
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'init');
  writeFileSync(join(repo, '.env'), 'SECRET=1');                                // ignored, not in git

  const a = isolate(join(repo, 'sub'), 'ses_a');
  const b = isolate(join(repo, 'sub'), 'ses_b');
  assert.equal(a.branch, 'xb/ses_a');
  assert.ok(a.cwd.startsWith(join(home(), 'worktrees')), a.cwd);                // under XBLabs' folder
  assert.ok(a.cwd.endsWith(join('ses_a', 'sub')), a.cwd);                       // subfolder kept
  assert.deepEqual(a.copied, ['.env']);
  assert.equal(readFileSync(join(a.cwd, '..', '.env'), 'utf8'), 'SECRET=1');

  writeFileSync(join(a.cwd, 'a.txt'), 'changed by a');
  writeFileSync(join(a.cwd, 'new.txt'), 'hi');
  assert.equal(readFileSync(join(b.cwd, 'a.txt'), 'utf8'), 'base');            // b untouched
  assert.equal(readFileSync(join(repo, 'sub', 'a.txt'), 'utf8'), 'base');      // real checkout untouched

  assert.equal(setupCommand(a.cwd), 'npm ci');
  assert.equal(setupCommand(base), '');                                         // not a repo → none
  assert.deepEqual(list().map((w) => w.id).sort(), ['ses_a', 'ses_b']);

  /* Two sessions on the same file: both see it, in the same repo. */
  writeFileSync(join(b.cwd, 'a.txt'), 'changed by b');
  const fa = changedFiles(a.cwd), fb = changedFiles(b.cwd);
  assert.equal(fa.top, fb.top);
  assert.ok(fa.files.has('sub/a.txt') && fb.files.has('sub/a.txt') && !fb.files.has('sub/new.txt'));
  writeFileSync(join(b.cwd, 'a.txt'), 'base');

  const c = changes(a.cwd);
  assert.equal(c.base, 'main');
  assert.deepEqual(c.stat.map((x) => x.file).sort(), ['sub/a.txt', 'sub/new.txt']);  // new file counted
  assert.match(c.patch, /\+changed by a/);
  assert.ok(c.dirty && c.files.includes('sub/new.txt'));
  assert.ok(!c.files.includes('.env'));                                         // ignored stays out of the tree

  assert.match((await act(a.cwd, 'merge')).error, /uncommitted/);               // nothing is left behind
  assert.ok((await act(a.cwd, 'commit', { message: '' })).error);
  assert.ok((await act(a.cwd, 'commit', { message: 'a work' })).ok);
  assert.equal(changes(a.cwd).ahead, 1);
  assert.ok((await act(a.cwd, 'merge')).ok);
  assert.equal(readFileSync(join(repo, 'sub', 'a.txt'), 'utf8'), 'changed by a');   // reached the real checkout

  /* A committed key stops push and PR before anything leaves the machine. */
  writeFileSync(join(b.cwd, 'k.txt'), 'token = ghp_' + 'a'.repeat(36));
  assert.ok((await act(b.cwd, 'commit', { message: 'oops' })).ok);
  assert.deepEqual(secretsIn(b.cwd, git(b.cwd, 'merge-base', 'main', 'HEAD')), ['GitHub token']);
  assert.match((await act(b.cwd, 'push')).error, /GitHub token/);
  assert.match((await act(b.cwd, 'pr')).error, /GitHub token/);

  const d = await act(b.cwd, 'discard');
  assert.ok(d.removed && !existsSync(b.cwd));
  assert.doesNotMatch(git(repo, 'branch', '--list', 'xb/*'), /ses_b/);
  await assert.rejects(act(repo, 'discard'), /not an XBLabs branch/);           // the real checkout is never thrown away

  const plain = join(base, 'plain');
  mkdirSync(plain);
  assert.equal(isolate(plain, 'ses_c'), null);                                  // not a repo → run in place
  /* A branch made on another device reaches the hub's own checkout as a bundle, then merges there. */
  const hubCopy = join(base, 'hub-copy');
  git(base, 'clone', '-q', repo, hubCopy);
  const far = isolate(repo, 'ses_far');
  assert.match(bundle(far.cwd).error, /no commits/);
  writeFileSync(join(far.cwd, 'far.txt'), 'from far');
  git(far.cwd, 'add', '.'); git(far.cwd, 'commit', '-qm', 'far work');
  writeFileSync(join(far.cwd, 'dirty.txt'), 'x');
  assert.match(bundle(far.cwd).error, /uncommitted/);
  rmSync(join(far.cwd, 'dirty.txt'));
  const pack = bundle(far.cwd);
  assert.equal(pack.branch, 'xb/ses_far'); assert.ok(pack.data.length > 0);
  assert.match(takeBundle(join(base, 'nowhere'), pack).error, /not a Git checkout/);
  assert.match(takeBundle(hubCopy, { ...pack, branch: 'main' }).error, /not an XBLabs branch/);
  const took = takeBundle(hubCopy, pack, { merge: true });
  assert.ok(took.merged, JSON.stringify(took));
  assert.equal(readFileSync(join(hubCopy, 'far.txt'), 'utf8'), 'from far');
  const lonely = join(base, 'lonely'); git(base, 'init', '-q', '-b', 'main', lonely); writeFileSync(join(lonely, 'x'), 'x'); git(lonely, 'add', '.'); git(lonely, 'commit', '-qm', 'other');
  assert.match(takeBundle(lonely, pack).error, /does not have the commit/);
  /* A hub with no copy of the project: an empty folder takes the whole thing, then merges. */
  const whole = bundle(far.cwd, { full: true });
  const fresh = join(base, 'fresh-hub');
  const got = takeBundle(fresh, whole, { merge: true });
  assert.ok(got.merged, JSON.stringify(got));
  assert.equal(readFileSync(join(fresh, 'far.txt'), 'utf8'), 'from far');
  assert.equal(git(fresh, 'remote').trim(), '', 'no remote left pointing at a temp file');
  assert.match(takeBundle(join(base, 'lonely'), { ...whole }).error, /does not have the commit/, 'a non-empty unrelated checkout is still refused');
  await act(far.cwd, 'discard');
  /* Settings → Storage moves where new worktrees go; the old ones stay listed and stay removable. */
  const before = list().length; assert.ok(before > 0);
  assert.throws(() => checkRoot(join(repo, 'wt-here')), /inside a Git repository/);
  assert.ok(!existsSync(join(repo, 'wt-here')), 'a refused folder is not created');
  assert.throws(() => checkRoot('relative/dir'), /absolute/);
  const moved = checkRoot(join(base, 'elsewhere', 'wt'));
  setRoots(moved, [join(home(), 'worktrees')]);
  assert.equal(root(), moved);
  const w2 = isolate(repo, 'ses_moved');
  assert.ok(w2.cwd.startsWith(moved), 'a new worktree goes to the new folder');
  assert.equal(list().length, before + 1, 'old and new are both listed');
  assert.ok((await act(w2.cwd, 'discard')).removed);
  const old = list().find((w) => !w.dir.startsWith(moved));
  assert.ok(old && (await act(old.dir, 'discard')).removed, 'an old one is still owned by XBLabs');
  setRoots();
  console.log('worktree.check ok');
} finally {
  rmSync(base, { recursive: true, force: true });
}
