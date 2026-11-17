// Ports a local session's process tree listens on. One OS call per table, cached 5s for all sessions.
// ponytail: local sessions only. Remote devices: have server/agent.mjs run the same tables() there
// and answer a "ports" message, then feed that reply to portsOf() here.
import { execFile } from 'node:child_process';

/* Pure: roots = pids, procs = [{pid, ppid, name}], listeners = [{port, pid}]. Ports opened by the
   tree under roots (roots included), minus `skip` (the hub's own port). */
export function portsOf(roots, procs, listeners, skip = []) {
  const kids = new Map();
  for (const p of procs) kids.set(p.ppid, [...(kids.get(p.ppid) || []), p.pid]);
  const tree = new Set(), todo = roots.filter(Boolean).map(Number);
  while (todo.length) { const pid = todo.pop(); if (!tree.has(pid)) { tree.add(pid); todo.push(...(kids.get(pid) || [])); } }
  const name = new Map(procs.map((p) => [p.pid, p.name]));
  const seen = new Set();
  return listeners.filter((l) => tree.has(l.pid) && !skip.includes(l.port) && !seen.has(l.port) && seen.add(l.port))
    .map((l) => ({ port: l.port, pid: l.pid, name: name.get(l.pid) || '' })).sort((a, b) => a.port - b.port);
}

/* Pure: the processes a session started that are still running, for its "background" menu.
   roots = [{pid, at}] (the agent processes of its turns and its terminal); a process belongs to the
   session when it descends from one, started after it (Windows keeps a dead parent's pid, so a
   finished turn's leftovers still match), or its command line names the session's folder.
   claimed = [{pid, at}]: pids the agent itself reported starting in the background (hermes runs
   those under its gateway daemon, outside the turn's tree); one counts when it started near that report.
   The roots themselves and the agent CLIs under them are the session, not its background; a process
   whose parent is listed too is folded into it (Stop takes the whole tree). */
const AGENT_CMD = /(^|[\\/\s"])(hermes|omp|claude|codex|gemini|opencode|aider)(\.(exe|cmd|ps1|js))?(["\s]|$)|hermes_cli|[\\/]hermes-agent[\\/]/i;
const NOISE = /^(conhost|openconsole|wmiprvse)(\.exe)?$/i;
export function bgOf(roots, procs, cwd = '', claimed = []) {
  const by = new Map(procs.map((p) => [p.pid, p]));
  const at = new Map(roots.filter((r) => r && r.pid).map((r) => [Number(r.pid), r.at || 0]));
  const norm = (x) => String(x || '').replace(/\\+/g, '/').toLowerCase();
  const dir = cwd && norm(cwd).replace(/\/+$/, '');
  const said = new Map(claimed.filter((c) => c && c.pid).map((c) => [Number(c.pid), c.at || 0]));
  const claim = (p) => said.has(p.pid) && (!p.at || !said.get(p.pid) || Math.abs(p.at - said.get(p.pid)) < 120000);
  const mine = new Map();   // pid -> true when it belongs
  const owns = (p, depth = 0) => {
    if (mine.has(p.pid)) return mine.get(p.pid);
    if (depth > 40) return false;
    let yes = false;
    if (claim(p)) yes = true;
    else if (at.has(p.ppid) && (!p.at || !at.get(p.ppid) || p.at >= at.get(p.ppid) - 2000)) yes = true;
    else if (dir && norm(p.cmd).includes(dir)) yes = true;
    else { const up = by.get(p.ppid); yes = !!up && up.pid !== p.pid && owns(up, depth + 1); }
    mine.set(p.pid, yes);
    return yes;
  };
  const list = procs.filter((p) => !at.has(p.pid) && p.pid !== process.pid && (claim(p) || (!NOISE.test(p.name || '') && !AGENT_CMD.test(p.cmd || p.name || ''))) && owns(p));
  const shown = new Set(list.map((p) => p.pid));
  const under = (p) => { for (let q = by.get(p.ppid), n = 0; q && n < 40; q = by.get(q.ppid), n++) if (shown.has(q.pid)) return true; return false; };
  return list.filter((p) => !under(p))
    .map((p) => ({ pid: p.pid, ppid: p.ppid, name: p.name || '', cmd: String(p.cmd || p.name || '').slice(0, 2000), at: p.at || null }))
    .sort((a, b) => (a.at || 0) - (b.at || 0));
}

/* Stop one process and everything under it. */
export function killTree(pid) {
  if (process.platform === 'win32') return sh('taskkill', ['/PID', String(pid), '/T', '/F']);
  return readTables().then(({ procs }) => {
    const all = [pid], kids = new Map();
    for (const p of procs) kids.set(p.ppid, [...(kids.get(p.ppid) || []), p.pid]);
    for (let i = 0; i < all.length; i++) all.push(...(kids.get(all[i]) || []));
    for (const x of all.reverse()) try { process.kill(x, 'SIGTERM'); } catch { /* gone */ }
  });
}

const sh = (bin, args) => new Promise((ok, no) => execFile(bin, args, { windowsHide: true, timeout: 15000, maxBuffer: 16e6 }, (e, out) => (e ? no(e) : ok(String(out)))));
const WIN = `$l=@(Get-NetTCPConnection -State Listen | Select-Object LocalPort,OwningProcess);`
  + `$p=@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine,@{n='At';e={[long]($_.CreationDate.ToUniversalTime()-[datetime]'1970-01-01').TotalMilliseconds}});`
  + `@{l=$l;p=$p} | ConvertTo-Json -Compress -Depth 3`;

/* One OS read: { procs, listeners }. */
export async function readTables() {
  if (process.platform === 'win32') {
    const j = JSON.parse(await sh('powershell', ['-NoProfile', '-NonInteractive', '-Command', WIN]));
    return { procs: [].concat(j.p || []).map((p) => ({ pid: p.ProcessId, ppid: p.ParentProcessId, name: p.Name, cmd: p.CommandLine || '', at: p.At || 0 })),
      listeners: [].concat(j.l || []).map((c) => ({ port: c.LocalPort, pid: c.OwningProcess })) };
  }
  const now = Date.now();
  const procs = (await sh('ps', ['-eo', 'pid=,ppid=,etimes=,comm=,args='])).split('\n').map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/))
    .filter(Boolean).map((m) => ({ pid: +m[1], ppid: +m[2], at: now - m[3] * 1000, name: m[4], cmd: m[5] }));
  const listeners = [];
  if (process.platform === 'linux') {
    for (const l of (await sh('ss', ['-ltnp'])).split('\n')) {
      const m = l.match(/:(\d+)\s+\S+\s+users:\(\("([^"]*)",pid=(\d+)/) || l.match(/:(\d+)\s+\S+\s+.*pid=(\d+)/);
      if (m) listeners.push({ port: +m[1], pid: +m[m.length - 1] });
    }
  } else {
    for (const l of (await sh('lsof', ['-iTCP', '-sTCP:LISTEN', '-P', '-n'])).split('\n').slice(1)) {
      const m = l.match(/^\S+\s+(\d+)\s.*:(\d+) \(LISTEN\)/);
      if (m) listeners.push({ port: +m[2], pid: +m[1] });
    }
  }
  return { procs, listeners };
}

let cache = null;
export const forget = () => { cache = null; };   // after a stop, the next read is fresh
export function tables() {
  if (!cache || Date.now() - cache.at > 5000) {
    const p = readTables().catch((e) => { if (cache && cache.p === p) cache = null; throw e; });
    cache = { at: Date.now(), p };
  }
  return cache.p;
}
