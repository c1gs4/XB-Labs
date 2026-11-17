// One git worktree + branch per session, under XBLabs' own folder, so the real checkout is
// never written to. Work goes back by commit / push / PR / merge, each asked for by me.
import { execFile, execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/* XBLabs' folder on this machine: worktrees (and later GOA) live here. */
export const home = () => resolve(process.env.XBLABS_HOME || join(homedir(), '.xblabs'));
/* Where new session folders go (Settings → Storage; <home>/worktrees by default), and every place
   they went before: older worktrees stay listed and stay XBLabs' own after the folder changes. */
const roots = { cur: '', past: [] };
export function setRoots(cur = '', past = []) { roots.cur = cur || ''; roots.past = Array.isArray(past) ? past.filter((p) => typeof p === 'string' && p) : []; }
const WT_ROOT = () => resolve(roots.cur || join(home(), 'worktrees'));
export const root = WT_ROOT;
const ALL_ROOTS = () => [...new Set([WT_ROOT(), join(home(), 'worktrees'), ...roots.past].map((r) => resolve(r)))];

const git = (cwd, ...a) => execFileSync('git', ['-c', 'core.quotepath=off', '-C', cwd, ...a],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, maxBuffer: 32 << 20 }).trim();
/* Async, for commands that talk to a remote (push, gh) and may take a while. */
const run = (bin, args, cwd, timeout = 120000) => new Promise((done) => execFile(bin, args, { cwd, windowsHide: true, timeout },
  (err, out, errOut) => done(err ? { error: String(errOut || err.message).trim().split('\n').slice(-3).join(' ') } : { out: String(out).trim() })));
const errText = (e) => String(e.stderr || e.message).trim().split('\n').pop();

/* Per-project settings, committed in the repo as .xblabs.json:
   { "copy": [".env", "config/local.json"], "setup": "npm install" }. Missing or bad = {}. */
function readConfig(top) {
  try { const c = JSON.parse(readFileSync(join(top, '.xblabs.json'), 'utf8')); return c && typeof c === 'object' ? c : {}; } catch { return {}; }
}
/* The setup command for the worktree a session runs in, or '' when the project has none. */
export function setupCommand(cwd) {
  try { const s = readConfig(resolve(git(cwd, 'rev-parse', '--show-toplevel'))).setup; return typeof s === 'string' ? s.trim() : ''; } catch { return ''; }
}

/* "run": { "dev": "npm run dev" } -> only non-empty string commands under a plain name. */
/* The folder holding .xblabs.json: the repo's top, or the folder itself when it is not a repo. */
function cfgTop(cwd) { try { return resolve(git(cwd, 'rev-parse', '--show-toplevel')); } catch { return resolve(cwd); } }
export function parseRun(cfg) {
  const r = cfg && cfg.run && typeof cfg.run === 'object' && !Array.isArray(cfg.run) ? cfg.run : {};
  return Object.fromEntries(Object.entries(r).filter(([k, v]) => typeof v === 'string' && v.trim()).map(([k, v]) => [k, v.trim()]));
}
export function runCommands(cwd) {
  try { return parseRun(readConfig(cfgTop(cwd))); } catch { return {}; }
}
/* Adds one command to the project's .xblabs.json (this folder's copy: a worktree's lands on its branch). */
export function saveRunCommand(cwd, name, command) {
  const top = cfgTop(cwd), cfg = readConfig(top);
  cfg.run = { ...parseRun(cfg), [name]: command };
  writeFileSync(join(top, '.xblabs.json'), JSON.stringify(cfg, null, 2) + '\n');
}

/* Files a new worktree gets from the real checkout because git does not carry them: `.env` by
   default, or the project's "copy" list. */
function copyIgnored(top, dir) {
  const c = readConfig(top).copy;
  const list = Array.isArray(c) ? c : ['.env'];
  const copied = [];
  for (const rel of list) {
    const from = resolve(top, String(rel)), to = resolve(dir, String(rel));
    if (!from.startsWith(top + sep) || !to.startsWith(dir + sep)) continue;   // stays inside both folders
    if (!existsSync(from) || existsSync(to)) continue;
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
    copied.push(String(rel));
  }
  return copied;
}

/* null: cwd is not inside a git repo, run there as before.
   { error }: repo found but no worktree (e.g. no commits yet) — caller keeps cwd.
   { cwd, branch, copied }: run here. Path: <home>/worktrees/<repo>-<hash>/<id>, branch xb/<id>.
   The branch it came from is kept in git config, for diff and merge later. */
export function isolate(cwd, id) {
  let top;
  try { top = resolve(git(cwd, 'rev-parse', '--show-toplevel')); } catch { return null; }
  const branch = `xb/${id}`;
  const tag = createHash('sha1').update(top.toLowerCase()).digest('hex').slice(0, 6);
  const dir = join(WT_ROOT(), `${basename(top)}-${tag}`, id);
  try {
    const base = git(top, 'rev-parse', '--abbrev-ref', 'HEAD');
    git(top, 'worktree', 'add', '-b', branch, dir, 'HEAD');
    git(top, 'config', `branch.${branch}.xbBase`, base === 'HEAD' ? git(top, 'rev-parse', 'HEAD') : base);
  } catch (e) { return { error: errText(e) }; }
  return { cwd: join(dir, relative(top, resolve(cwd))), branch, copied: copyIgnored(top, dir) };
}

/* The worktree a session's cwd sits in, its real checkout, and the branch it came from. */
function locate(cwd) {
  const wt = resolve(git(cwd, 'rev-parse', '--show-toplevel'));
  const branch = git(wt, 'rev-parse', '--abbrev-ref', 'HEAD');
  const top = dirname(resolve(wt, git(wt, 'rev-parse', '--git-common-dir')));
  let base = '';
  try { base = git(wt, 'config', `branch.${branch}.xbBase`); } catch { /* made before xbBase */ }
  if (!base) try { base = git(top, 'rev-parse', '--abbrev-ref', 'HEAD'); } catch { /* none */ }
  return { wt, top, branch, base };
}

const PATCH_MAX = 400 << 10;

/* Everything the session changed since it left its base: commits on its branch plus what is
   not committed yet, new files included. Files: every tracked or new file, changed ones marked. */
export function changes(cwd) {
  const { wt, branch, base } = locate(cwd);
  git(wt, 'add', '-A', '--intent-to-add');   // new files show in the diff; nothing is staged for real
  const from = git(wt, 'merge-base', base, 'HEAD');
  const stat = git(wt, 'diff', '--numstat', from).split('\n').filter(Boolean).map((l) => {
    const [add, del, ...f] = l.split('\t');
    return { file: f.join('\t'), add: add === '-' ? 0 : +add, del: del === '-' ? 0 : +del, binary: add === '-' };
  });
  let patch = git(wt, 'diff', from);
  const cut = patch.length > PATCH_MAX;
  if (cut) patch = patch.slice(0, PATCH_MAX);
  const files = git(wt, 'ls-files', '-co', '--exclude-standard').split('\n').filter(Boolean).slice(0, 5000);
  const dirty = !!git(wt, 'status', '--porcelain');
  const ahead = +git(wt, 'rev-list', '--count', `${from}..HEAD`);
  return { branch, base, stat, patch, cut, files, dirty, ahead };
}

/* Which repo a worktree belongs to and the files its session changed (no diff text): what the
   hub compares across sessions to warn about two of them editing the same file. */
export function changedFiles(cwd) {
  const { wt, top, base } = locate(cwd);
  const from = git(wt, 'merge-base', base, 'HEAD');
  const files = new Set([
    ...git(wt, 'diff', '--name-only', from).split('\n'),
    ...git(wt, 'ls-files', '-o', '--exclude-standard').split('\n'),
  ].filter(Boolean));
  return { top: top.toLowerCase(), files };
}

/* Things that must not leave the machine. A hit stops the push; the fix is to take it out of
   the branch, not to override. ponytail: patterns for common key formats, not a full scanner. */
const SECRET_FILE = /(^|\/)(\.env(\..+)?|id_rsa|id_ed25519|.+\.pem|.+\.p12|credentials\.json)$/i;
const SECRET_TEXT = [
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ['OpenAI-style key', /\bsk-[A-Za-z0-9_-]{32,}\b/],
  ['Slack token', /\bxox[abpr]-[A-Za-z0-9-]{10,}\b/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
];
export function secretsIn(wt, from) {
  const hits = git(wt, 'diff', '--name-only', `${from}..HEAD`).split('\n').filter((f) => f && SECRET_FILE.test(f)).map((f) => `${f} (file)`);
  const added = git(wt, 'diff', '--unified=0', `${from}..HEAD`).split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++'));
  for (const [name, re] of SECRET_TEXT) if (added.some((l) => re.test(l))) hits.push(name);
  return hits;
}

/* Only XBLabs' own branches in XBLabs' own worktrees are pushed, merged or thrown away. */
function own(cwd) {
  const l = locate(cwd);
  if (!l.branch.startsWith('xb/')) throw new Error(`not an XBLabs branch: ${l.branch}`);
  if (!ALL_ROOTS().some((r) => l.wt.toLowerCase().startsWith(r.toLowerCase() + sep)) && !l.wt.includes(`${sep}.xb-worktrees${sep}`))
    throw new Error('worktree is outside the XBLabs folder');
  return l;
}

/* Every session folder under <home>/worktrees, for Settings → Storage. */
export function list() {
  const out = [];
  for (const top of ALL_ROOTS()) {
    if (!existsSync(top)) continue;
    for (const repo of readdirSync(top, { withFileTypes: true }).filter((d) => d.isDirectory()))
      for (const s of readdirSync(join(top, repo.name), { withFileTypes: true }).filter((d) => d.isDirectory()))
        out.push({ id: s.name, repo: repo.name, dir: join(top, repo.name, s.name), root: top, modified: statSync(join(top, repo.name, s.name)).mtimeMs });
  }
  return out.sort((a, b) => b.modified - a.modified);
}

/* A folder that may hold session worktrees: absolute, creatable, writable, and not inside a Git
   checkout (a worktree nested in another repo confuses both). Returns the resolved path or throws. */
export function checkRoot(p) {
  if (typeof p !== 'string' || !p.trim() || p.length > 500 || /[\r\n\0]/.test(p)) throw new Error('give a folder path');
  if (!isAbsolute(p.trim())) throw new Error('give an absolute path, like D:\\XBLabs\\worktrees');
  const dir = resolve(p.trim());
  /* Asked of the nearest folder that exists, before anything is created. */
  let near = dir;
  while (!existsSync(near) && dirname(near) !== near) near = dirname(near);
  let inRepo = false;
  try { execFileSync('git', ['-C', near, 'rev-parse', '--show-toplevel'], { stdio: 'ignore', windowsHide: true }); inRepo = true; } catch { /* not a checkout: good */ }
  if (inRepo) throw new Error('that folder is inside a Git repository; pick one outside any project');
  mkdirSync(dir, { recursive: true });
  const probe = join(dir, `.xb-write-${process.pid}`);
  writeFileSync(probe, ''); rmSync(probe);
  return dir;
}

/* A project that is not on this machine yet: cloned from its Git URL into a new folder named after
   the repo, inside the folder the picker shows. The URL reaches git as one argument after --. */
const CLONE_URL = /^(https?:\/\/|ssh:\/\/|git@)[\w.@:/~+%-]+$/;
export async function clone(url, into) {
  url = String(url || '').trim();
  if (!CLONE_URL.test(url) || url.length > 500) return { error: 'give a Git URL (https://…, ssh://… or git@host:owner/repo)' };
  const name = url.replace(/\/+$/, '').split(/[/:]/).pop().replace(/\.git$/i, '');
  if (!/^[\w.-]+$/.test(name) || name === '.' || name === '..') return { error: 'cannot tell the folder name from that URL' };
  const dest = join(resolve(String(into || '.')), name);
  if (existsSync(dest)) return { error: `${name} already exists here` };
  const r = await run('git', ['clone', '--', url, dest], resolve(String(into || '.')), 600000);   // a big repo takes a while
  return r.error ? { error: r.error } : { ok: true, path: dest, said: `cloned ${name}` };
}

/* A session branch on another device travels to the hub as a git bundle: only the commits the
   branch made since its base, so the hub needs that base and nothing else. No Git remote needed. */
const BUNDLE_MAX = 40 << 20;
export function bundle(cwd, { full = false } = {}) {
  const l = own(cwd);
  if (git(l.wt, 'status', '--porcelain')) return { error: 'commit the session first, it has uncommitted changes' };
  const from = git(l.wt, 'merge-base', l.base, 'HEAD');
  if (!+git(l.wt, 'rev-list', '--count', `${from}..HEAD`)) return { error: 'the branch has no commits yet' };
  const file = join(tmpdir(), `xb-${process.pid}-${Date.now()}.bundle`);
  try {
    /* full: the base branch too, for a hub that has no copy of the project yet. */
    if (full) git(l.wt, 'bundle', 'create', file, l.base, l.branch);
    else git(l.wt, 'bundle', 'create', file, `${from}..${l.branch}`);
    const data = readFileSync(file);
    if (data.length > BUNDLE_MAX) return { error: `the branch is ${Math.round(data.length / 1048576)} MB, over the 40 MB a bundle may carry` };
    return { branch: l.branch, base: l.base, from, full, data: data.toString('base64') };
  } finally { rmSync(file, { force: true }); }
}
/* The hub's own checkout of the project takes the branch (same name, xb/ only), and can merge it
   into its base the same way a local session merges: on the base, nothing uncommitted. */
/* An empty or new folder on the hub: the project lands there whole (its base branch checked out,
   the session branch beside it). Anything else must already be a checkout of the project. */
/* Why a merge on the hub stopped, in words that say what to do. */
function mergeStopped(e, branch, top) {
  const t = errText(e);
  if (/auto-detect email|tell me who you are|user\.email/i.test(String(e.stderr || e.message)))
    return `${branch} is in ${top}, not merged: Git on this hub has no name and email for the merge commit. Run git config --global user.name "Your Name" and git config --global user.email you@example.com, then merge again`;
  return `${branch} is in ${top}, but the merge stopped: ${t}`;
}
export const isFreshFolder = (dir) => !existsSync(dir) || (statSync(dir).isDirectory() && readdirSync(dir).length === 0);
export function takeBundle(repo, { branch, base, from, data, full }, { merge = false } = {}) {
  if (!/^xb\/[\w.-]+$/.test(String(branch || ''))) return { error: 'not an XBLabs branch' };
  if (!/^[0-9a-f]{7,64}$/.test(String(from || ''))) return { error: 'bad base commit' };
  if (full && isFreshFolder(repo)) {
    if (!/^[\w./-]+$/.test(String(base || ''))) return { error: 'bad base branch' };
    const dest = resolve(repo), file = join(tmpdir(), `xb-${process.pid}-${Date.now()}.bundle`);
    try {
      writeFileSync(file, Buffer.from(String(data || ''), 'base64'));
      git(dirname(dest), 'clone', '-q', '-b', base, '--', file, dest);
      git(dest, 'branch', branch, `origin/${branch}`);
      git(dest, 'remote', 'remove', 'origin');   // it pointed at a temp file
    } catch (e) { return { error: errText(e) }; }
    finally { rmSync(file, { force: true }); }
    if (!merge) return { ok: true, said: `${dest} now holds the project (${base}) and ${branch}`, top: dest };
  }
  let top;
  try { top = resolve(git(repo, 'rev-parse', '--show-toplevel')); } catch { return { error: `${repo} is not a Git checkout` }; }
  try { git(top, 'cat-file', '-e', `${from}^{commit}`); }
  catch { return { error: `${top} does not have the commit the branch starts from (${from.slice(0, 8)}); pull ${base || 'the base branch'} there first` }; }
  const file = join(tmpdir(), `xb-${process.pid}-${Date.now()}.bundle`);
  try {
    writeFileSync(file, Buffer.from(String(data || ''), 'base64'));
    git(top, 'bundle', 'verify', file);
    git(top, 'fetch', '--no-tags', file, `+refs/heads/${branch}:refs/heads/${branch}`);
  } catch (e) { return { error: errText(e) }; }
  finally { rmSync(file, { force: true }); }
  if (!merge) return { ok: true, said: `${branch} is now in ${top}`, top };
  if (git(top, 'status', '--porcelain')) return { ok: true, said: `${branch} is in ${top}; not merged, that checkout has uncommitted changes`, top };
  const on = git(top, 'rev-parse', '--abbrev-ref', 'HEAD');
  if (base && on !== base) return { ok: true, said: `${branch} is in ${top}; not merged, it is on ${on}, not ${base}`, top };
  try { git(top, 'merge', '--no-ff', '--no-edit', branch); } catch (e) { try { git(top, 'merge', '--abort'); } catch { /* nothing to abort */ } return { error: mergeStopped(e, branch, top) }; }
  return { ok: true, said: `merged ${branch} into ${on} in ${top}`, top, merged: true };
}

export async function act(cwd, action, { message } = {}) {
  const l = own(cwd);
  try {
    if (action === 'commit') {
      const msg = String(message || '').trim();
      if (!msg) return { error: 'commit message required' };
      git(l.wt, 'add', '-A');
      if (!git(l.wt, 'diff', '--cached', '--name-only')) return { error: 'nothing to commit' };
      git(l.wt, 'commit', '-m', msg);
      return { ok: true, said: `committed on ${l.branch}` };
    }
    if (action === 'push') {
      /* Its own branch name on the remote, never the base branch, and nothing secret in it. */
      const hits = secretsIn(l.wt, git(l.wt, 'merge-base', l.base, 'HEAD'));
      if (hits.length) return { error: `not pushed, the branch carries: ${hits.join(', ')}` };
      const r = await run('git', ['push', '-u', 'origin', `${l.branch}:${l.branch}`], l.wt);
      return r.error ? r : { ok: true, said: `pushed ${l.branch} to origin` };
    }
    if (action === 'pr') {
      const hits = secretsIn(l.wt, git(l.wt, 'merge-base', l.base, 'HEAD'));
      if (hits.length) return { error: `no PR, the branch carries: ${hits.join(', ')}` };
      const r = await run('gh', ['pr', 'create', '--fill', '--head', l.branch, '--base', l.base], l.wt);
      return r.error ? r : { ok: true, said: r.out.split('\n').pop() };
    }
    if (action === 'merge') {
      /* Into the base branch, in the real checkout. Refused unless that checkout is on the base
         and the session has nothing uncommitted, so no work is left behind or overwritten. */
      if (git(l.wt, 'status', '--porcelain')) return { error: 'commit the session first, it has uncommitted changes' };
      const on = git(l.top, 'rev-parse', '--abbrev-ref', 'HEAD');
      if (on !== l.base) return { error: `${l.top} is on ${on}, not ${l.base}` };
      git(l.top, 'merge', '--no-ff', '--no-edit', l.branch);
      return { ok: true, said: `merged ${l.branch} into ${l.base}` };
    }
    if (action === 'discard') {
      git(l.top, 'worktree', 'remove', '--force', l.wt);
      git(l.top, 'branch', '-D', l.branch);
      return { ok: true, said: `removed ${l.branch} and its folder`, removed: true, top: l.top };
    }
  } catch (e) { return { error: errText(e) }; }
  return { error: `unknown action: ${action}` };
}
