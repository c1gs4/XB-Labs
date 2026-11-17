// XBLabs agent: runs shells on this machine and streams them to a hub.
// Usage: node server/agent.mjs --hub ws://127.0.0.1:5200 --name Forge [--token abc]
import { existsSync, readFileSync, statfsSync } from 'node:fs';
import { WebSocket } from 'ws';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import { isolate } from './worktree.mjs';
import { AGENTS, detect, listDirs, findBin } from './agents.mjs';
import { setupCommand, changes, act, bundle, clone } from './worktree.mjs';

/* node-pty has no Linux prebuild; the one-line installer puts the homebridge fork there instead. */
const ptyMod = await import('node-pty').catch(() => import('@homebridge/node-pty-prebuilt-multiarch'));
const pty = ptyMod.spawn ? ptyMod : ptyMod.default;

/* Hash of this worker's own code, sent in hello: the hub shows Update only when it differs.
   Same files and recipe as agentBuild() in install.mjs (install.check keeps them equal). */
const BUILD_FILES = ['server/agent.mjs', 'server/agents.mjs', 'server/worktree.mjs', 'server/hooks/report.mjs', 'server/hooks/omp.mjs'];
const BUILD = (() => {
  try {
    const h = createHash('sha256');
    for (const f of BUILD_FILES) h.update(f).update('\0').update(readFileSync(new URL(`../${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n'));
    return h.digest('hex').slice(0, 16);
  } catch { return ''; }
})();
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const HUB = opt('hub', 'ws://127.0.0.1:5200').replace(/\/+$/, '');
const NAME = opt('name', os.hostname());
const TOKEN = opt('token', process.env.XBLABS_TOKEN || '');

const WIN = os.platform() === 'win32';
/* A service (systemd, launchd, cron) starts with a bare PATH, so agents installed for the user
   (~/.local/bin, npm or bun globals, nvm) were not found. Take the PATH the user's login shell
   builds, plus the usual user bin folders, so detection and spawned agents see what a terminal sees. */
if (!WIN) {
  const H = os.homedir(), have = new Set((process.env.PATH || '').split(':').filter(Boolean));
  let login = '';
  try { login = execFileSync(process.env.SHELL || '/bin/sh', ['-lc', 'printf "XBPATH=%s" "$PATH"'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).split('XBPATH=').pop().trim(); } catch { /* no login shell */ }
  const extra = [...login.split(':'), `${H}/.local/bin`, `${H}/bin`, `${H}/.npm-global/bin`, `${H}/.bun/bin`, `${H}/.cargo/bin`, `${H}/.deno/bin`, `${H}/.volta/bin`, '/usr/local/bin', '/opt/homebrew/bin', '/snap/bin']
    .filter((d) => d && d.startsWith('/') && !have.has(d) && existsSync(d));
  if (extra.length) process.env.PATH = [...have, ...new Set(extra)].join(':');
}
const SHELL = WIN ? process.env.COMSPEC || 'C:\\Windows\\System32\\cmd.exe' : process.env.SHELL || '/bin/sh';
/* A job run starts its agent once, non-interactively, with the task as the prompt, inside a
   shell that exits with it — so the run ends 'done' or 'failed' by the agent's own exit code. */
const qPosix = (a) => `'${String(a).replace(/'/g, `'\\''`)}'`;
function shellArgs(argv, win) {
  if (!argv) return [];
  if (win) return `/d /s /c "${argv.map((a, i) => (i ? `"${String(a).replace(/"/g, "'").replace(/[\r\n]+/g, ' ')}"` : a)).join(' ')}"`;
  return ['-lc', argv.map(qPosix).join(' ')];
}
const procs = new Map(); // sessionId -> pty

let prev = null;
/* Used share of the system drive, or null where statfs is not available. */
function diskPct() {
  try { const s = statfsSync(os.platform() === 'win32' ? (process.env.SystemDrive || 'C:') + '\\' : '/'); return s.blocks ? Math.round((1 - s.bavail / s.blocks) * 100) : null; } catch { return null; }
}
function cpuPct() {
  const now = os.cpus().map((c) => c.times);
  if (!prev) { prev = now; return 0; }
  let idle = 0, total = 0;
  now.forEach((t, i) => {
    const p = prev[i] || { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 };
    idle += t.idle - p.idle;
    total += (t.user + t.nice + t.sys + t.idle + t.irq) - (p.user + p.nice + p.sys + p.idle + p.irq);
  });
  prev = now;
  return total > 0 ? Math.min(100, Math.max(0, Math.round((1 - idle / total) * 100))) : 0;
}

function connect() {
  const url = `${HUB}/agent?name=${encodeURIComponent(NAME)}${TOKEN ? `&token=${encodeURIComponent(TOKEN)}` : ''}`;
  const ws = new WebSocket(url);
  const send = (msg) => { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); };

  ws.on('open', async () => {
    const agents = await detect().catch(() => []);   // looked up again on every reconnect
    send({
      agents, chatProtocol: 1, tuiProtocol: 1,
      type: 'hello', name: NAME, platform: os.platform(), release: os.release(), arch: os.arch(),
      host: os.hostname(), home: os.homedir(), root: os.platform() === 'win32' ? (process.env.SystemDrive || 'C:') + '\\' : '/',
      cores: os.cpus().length, mem: os.totalmem(), shell: SHELL, gitProtocol: 2, build: BUILD, version: JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version,
    });
    console.log(`[agent] connected to ${HUB} as ${NAME}`);
  });

  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.type === 'chat-prepare') {
      try {
        const w = m.isolate && m.cwd ? isolate(m.cwd, m.id) : null;
        if (m.isolate && (!w?.cwd || !w?.branch || w.error)) throw new Error(`isolation requires a worktree: ${w?.error || 'cwd must be inside a committed git repository'}`);
        send({ type: 'ls-result', req: m.req, cwd: w?.cwd || m.cwd || os.homedir(), ...(w?.branch ? { branch: w.branch } : {}) });
      } catch (err) { send({ type: 'ls-result', req: m.req, error: err.message }); }
    }
    if (m.type === 'chat-history') {
      (async () => {
        try {
          const a = AGENTS[m.agent]?.json;
          if (!a?.history) throw new Error('agent history unavailable');
          const row = { id: m.id, cwd: m.cwd, agent_session: m.agent_session };
          if (!row.agent_session && a.find) row.agent_session = a.find(row, m.since);
          const items = await a.history(row);
          send({ type: 'ls-result', req: m.req, items, tokens: items.tokens, agent_session: row.agent_session });
        } catch (err) { send({ type: 'ls-result', req: m.req, error: err.message }); }
      })();
    }
    if (m.type === 'chat-start') {
      if (procs.has(m.id)) return send({ type: 'chat-exit', id: m.id, run: m.run, code: 1, error: 'session already running' });
      try {
        const args = m.argv.map((arg, i) => arg === 'xblabs:omp' && m.argv[i - 1] === '--extension' ? fileURLToPath(new URL('./hooks/omp.mjs', import.meta.url)) : arg);
        const bin = findBin(args[0]) || args[0];
        if (/\.(cmd|bat)$/i.test(bin)) throw new Error('remote bubble chat requires an executable, not a shell shim');
        const cwd = m.cwd || os.homedir();
        const setup = m.setup ? setupCommand(cwd) : '';
        if (setup && WIN) throw new Error('remote bubble setup on Windows requires a shell-safe runner; run project setup first');
        const options = { cwd, env: { ...process.env, ...m.env }, windowsHide: true, detached: !WIN, stdio: ['pipe', 'pipe', 'pipe'] };
        const proc = setup ? spawn(SHELL, ['-lc', `${setup} && exec ${[bin, ...args.slice(1)].map(qPosix).join(' ')}`], options)
          : spawn(bin, args.slice(1), options);
        const entry = { kill: () => { if (WIN || !proc.pid) proc.kill(); else { try { process.kill(-proc.pid, 'SIGTERM'); } catch { proc.kill(); } } }, run: m.run };
        procs.set(m.id, entry);
        proc.stdin.on('error', () => {});
        proc.stdin.end(m.input || '');
        proc.stdout.setEncoding('utf8'); proc.stderr.setEncoding('utf8');
        proc.stdout.on('data', data => send({ type: 'chat-data', id: m.id, run: m.run, stream: 'stdout', data }));
        proc.stderr.on('data', data => send({ type: 'chat-data', id: m.id, run: m.run, stream: 'stderr', data }));
        let ended = false;
        const finish = (code, error = '') => { if (ended) return; ended = true; if (procs.get(m.id) === entry) procs.delete(m.id); send({ type: 'chat-exit', id: m.id, run: m.run, code, error }); };
        proc.on('error', err => finish(1, err.message));
        proc.on('close', code => finish(code ?? 1));
      } catch (err) { send({ type: 'chat-exit', id: m.id, run: m.run, code: 1, error: err.message }); }
    }
    if (m.type === 'spawn') {
      if (procs.has(m.id)) return;
      try {
        const w = m.isolate && m.cwd ? isolate(m.cwd, m.id) : null;
        if (m.isolate && (!w?.cwd || !w?.branch || w.error)) {
          throw new Error(`isolation requires a worktree: ${w?.error || 'cwd must be inside a committed git repository'}`);
        }
        const cwd = w?.cwd || m.cwd || os.homedir();
        const args = m.argv?.map((arg, i) => arg === 'xblabs:omp' && m.argv[i - 1] === '--extension' ? fileURLToPath(new URL('./hooks/omp.mjs', import.meta.url)) : arg);
        const proc = pty.spawn(SHELL, shellArgs(args, WIN), {
          name: 'xterm-256color', cols: m.cols || 100, rows: m.rows || 30,
          cwd, useConpty: true,
          env: { ...process.env, ...(m.env || {}) }, // hub injects the shared LLM endpoint
        });
        procs.set(m.id, proc);
        send({ type: 'spawned', id: m.id, pid: proc.pid, ...(w?.branch ? { cwd, branch: w.branch } : {}) });
        if (m.req) send({ type: 'ls-result', req: m.req, pid: proc.pid });
        proc.onData((d) => send({ type: 'data', id: m.id, data: d }));
        proc.onExit(({ exitCode }) => { if (procs.get(m.id) === proc) procs.delete(m.id); send({ type: 'exit', id: m.id, code: exitCode }); });
      } catch (err) {
        send({ type: 'data', id: m.id, data: `\r\n[xblabs] cannot start: ${err.message}\r\n` });
        send({ type: 'exit', id: m.id, code: 1 });
        if (m.req) send({ type: 'ls-result', req: m.req, error: err.message });
      }
    }
    if (m.type === 'input') { const p = procs.get(m.id); if (p?.write) p.write(m.data); }
    if (m.type === 'resize') { const p = procs.get(m.id); if (p?.resize) p.resize(Math.max(2, m.cols), Math.max(2, m.rows)); }
    /* The hub's folder browser asks what is in a folder on this machine. */
    if (m.type === 'ls') {
      try { send({ type: 'ls-result', req: m.req, ...listDirs(m.path, !!m.hidden) }); }
      catch (err) { send({ type: 'ls-result', req: m.req, error: err.code === 'ENOENT' ? `no such folder: ${m.path}` : String(err.message || err) }); }
    }
    /* The hub reads and acts on this device's session branches: diff, commit, push, PR, merge
       here, discard, or pack the branch as a bundle for the hub. */
    if (m.type === 'clone') clone(m.url, m.path).then((r) => send({ type: 'ls-result', req: m.req, ...r }), (err) => send({ type: 'ls-result', req: m.req, error: String(err.message || err) }));
    if (m.type === 'git') {
      (async () => {
        try {
          const r = m.action === 'changes' ? changes(m.cwd) : m.action === 'bundle' ? bundle(m.cwd, { full: !!m.full })
            : ['commit', 'push', 'pr', 'merge', 'discard'].includes(m.action) ? await act(m.cwd, m.action, { message: m.message }) : { error: `unknown git action: ${m.action}` };
          send({ type: 'ls-result', req: m.req, ...r });
        } catch (err) { send({ type: 'ls-result', req: m.req, error: String(err.message || err).split('\n')[0] }); }
      })();
    }
    if (m.type === 'kill') { const p = procs.get(m.id); if (p && (!m.run || p.run === m.run)) { try { p.kill(); } catch {} if (!p.run) procs.delete(m.id); } }
  });

  const stats = setInterval(() => send({
    type: 'stats', cpu: cpuPct(), ram: Math.round(((os.totalmem() - os.freemem()) / os.totalmem()) * 100),
    ramUsed: os.totalmem() - os.freemem(), ramTotal: os.totalmem(), runs: procs.size,
    disk: diskPct(), uptimeH: Math.round(os.uptime() / 3600),
  }), 5000);

  const bye = () => {
    clearInterval(stats);
    /* Children belong to this agent: tell the hub they are gone instead of leaving 'running' rows. */
    for (const [id, proc] of procs) {
      try { proc.kill(); } catch {}
      send({ type: 'exit', id, code: 1 });
    }
    procs.clear();
  };
  ws.on('close', () => { bye(); console.log('[agent] disconnected, retrying in 3s'); setTimeout(connect, 3000); });
  ws.on('error', (e) => console.error('[agent]', e.message));
}

/* One signal handler for the whole process — connect() runs again after every reconnect. */
const stop = () => {
  for (const [, p] of procs) { try { p.kill(); } catch {} }
  procs.clear();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

connect();
