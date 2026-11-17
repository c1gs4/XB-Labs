// One PTY per run. Multiple WS clients can attach to the same PTY.
import * as pty from 'node-pty';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { appendLog, readLog, getSession, updateSession, addEvent, sessionEnv as configuredEnv, hubSettings, lastTurn } from './db.mjs';
import { detectLimit } from './accounts.mjs';
import { log as evlog } from './log.mjs';
import { AGENTS, hookFlags, applySettings } from './agents.mjs';
import { setupCommand, home } from './worktree.mjs';
import { EventEmitter } from 'node:events';
import { delimiter, join } from 'node:path';
import { randomUUID } from 'node:crypto';

/* 'waiting' (id) when output asks a question, 'exit' (id, code) when a process ends. */
export const events = new EventEmitter();
/* Where the xb CLI lives (server/goa.mjs writes it); first on PATH for every session. */
const PATH_KEY = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';

const SHELL = process.env.COMSPEC || 'C:\\Windows\\System32\\cmd.exe';
/* A tailnet host needs no agent: the hub's own ssh client opens the session. */
/* A key picked per host is a file name in ~/.ssh, never a path from the client. */
export const sshKeyArgs = (key) => (key && /^[\w.-]{1,64}$/.test(key) ? ['-i', join(homedir(), '.ssh', key), '-o', 'IdentitiesOnly=yes'] : []);
export const SSH_BIN = ['C:\\Windows\\System32\\OpenSSH\\ssh.exe', 'C:\\Program Files\\OpenSSH\\ssh.exe'].find((p) => existsSync(p)) || 'ssh';
/* A job run starts its agent once, non-interactively, with the task as the prompt, inside a
   shell that exits with it — so the run ends 'done' or 'failed' by the agent's own exit code. */
const qPosix = (a) => `'${String(a).replace(/'/g, `'\\''`)}'`;
/* pre: a project's setup command, run first; the agent starts only if it succeeds. With no
   agent, cmd stays open after it (/k) so the shell is still there. */
export function shellArgs(argv, win, pre = '') {
  if (!argv) return pre ? (win ? `/d /s /k "${pre}"` : ['-lc', `${pre}; exec "${'$'}SHELL"`]) : [];
  const and = pre ? `${pre} && ` : '';
  if (win) return `/d /s /c "${and}${argv.map((a, i) => (i ? `"${String(a).replace(/"/g, "'").replace(/[\r\n]+/g, ' ')}"` : a)).join(' ')}"`;
  return ['-lc', and + argv.map(qPosix).join(' ')];
}
/* The agent command for a job run, or null for a plain shell (no agent or no task). */
export function runEnv(row) {
  const env = configuredEnv(row);
  return row.agent === 'omp' && row.kind === 'job' && env.LLM_BASE_URL && row.model
    ? { ...env, LLM_MODEL: row.model, OPENAI_MODEL: row.model, ANTHROPIC_MODEL: row.model } : env;
}
export function jobArgv(row) {
  const a = row && row.kind === 'job' && row.prompt && row.prompt.trim() && Object.hasOwn(AGENTS, row.agent) && AGENTS[row.agent];
  if (!a) return null;
  /* No one-shot mode: the job opens the agent and the prompt is typed in (typePrompt). */
  const argv = a.run ? a.run(row.prompt.trim()) : a.typePrompt ? a.chat('') : a.chat(row.prompt.trim());
  const env = runEnv(row);
  const out = argv && applySettings(argv, row.agent, hubSettings(), env);
  if (out && row.agent === 'omp') {
    out.push('--mode', 'json');
    if (env.LLM_BASE_URL) {
      if (!/^https?:$/.test(new URL(env.LLM_BASE_URL).protocol) || !env.LLM_MODEL?.trim()) throw new Error('OMP shared endpoint requires HTTP(S) URL and model');
      out.push('--extension', row.device && row.device !== 'local' ? 'xblabs:omp' : hookFlags('omp')[1], '--model', `xblabs/${env.LLM_MODEL}`);
    } else if (row.model) out.push('--model', row.model);
  }
  return out;
}
/* A chat session is its agent, interactive: opened on the session's prompt the first time,
   on the agent's own last conversation after that (the session has output from before).
   ponytail: "last conversation" is per folder, so two chats in one folder resume the same one
   until chats get their own worktree (PLAN G2). */
export function chatArgv(row, resumed = false) {
  const a = row && row.kind === 'chat' && Object.hasOwn(AGENTS, row.agent) && AGENTS[row.agent];
  if (!a) return null;
  return applySettings(resumed ? (a.resume || a.chat('')) : a.chat((row.prompt || '').trim()), row.agent, hubSettings(), configuredEnv(row));
}
const live = new Map(); // sessionId -> { proc, clients:Set<ws>, buf:string, stop() }

/* An agent that asks a question is blocked, not busy. Only honest source for 'waiting approval'. */
const ASK = /\(y\/n\)|\[y\/n\]|\[Y\/n\]|\(yes\/no\)|continue\?|proceed\?|proceed \(|allow .{0,60}\?|approve .{0,60}\?/i;

function makeEntry(sessionId) {
  const entry = { clients: new Set(), buf: '', lastOut: Date.now() };
  const row = getSession(sessionId);
  if (row?.kind === 'job' && row.agent === 'omp') {
    let pending = '', calls = 0;
    const used = { input: 0, output: 0, cache_read: 0, context: null };
    const line = (text) => {
      let parsed; try { parsed = JSON.parse(text.trim()); } catch { return; }
      for (const e of AGENTS.omp.json.parse(parsed)) {
        if (e.kind === 'usage') { calls++; used.input += e.input; used.output += e.output; used.cache_read += e.cache_read; used.context = e.context; }
        if (e.kind === 'model') updateSession(sessionId, { model: e.model }); // Job restart needs executable model ID, not a display label.
      }
    };
    entry.readUsage = (data) => {
      pending += data;
      let i; while ((i = pending.indexOf('\n')) >= 0) { line(pending.slice(0, i)); pending = pending.slice(i + 1); }
      if (pending.length > 4000000) pending = ''; // ponytail: metadata parser caps malformed unterminated lines at 4 MB.
    };
    entry.saveUsage = () => { line(pending); pending = ''; if (calls) addEvent(sessionId, 0, 'done', { tokens: used }); };
  }
  const flush = () => {
    if (!entry.buf) return;
    const chunk = entry.buf;
    entry.buf = '';
    try { appendLog(sessionId, chunk); } catch { /* session row already gone (deleted mid-run) */ }
  };
  const flushTimer = setInterval(flush, 1500);
  entry.stop = () => { flush(); clearInterval(flushTimer); entry.saveUsage?.(); };
  live.set(sessionId, entry);
  return entry;
}

/* Output path shared by local PTY and remote agent streams. */
export function pump(sessionId, d) {
  const entry = live.get(sessionId);
  if (!entry) return;
  entry.readUsage?.(d);
  entry.buf += d;
  if (entry.tui && entry.buf.length > 400000) {   // a TUI's screen, replayed on reattach
    const cut = entry.buf.length - 200000;
    entry.buf = entry.buf.slice(cut); entry.inMark = Math.max(0, (entry.inMark || 0) - cut);
  }
  entry.lastOut = Date.now();
  /* A TUI says why it is slow (provider down, retrying, rate limited): the chat shows that line. */
  if (entry.tui) { const l = statusLines(plainText(d)); if (l.length) { entry.note = { text: l[l.length - 1], at: Date.now() }; events.emit('tui-status', sessionId, l); } }
  const row = getSession(sessionId);
  if (!entry.tui && row && row.status !== 'waiting' && ASK.test(d.slice(-400))) {
    updateSession(sessionId, { status: 'waiting' });
    evlog('warn', row.device || 'agent', `run ${sessionId} is asking for approval`);
    events.emit('waiting', sessionId);
  }
  /* A usage limit in the output: 'limit' (id, { until, text }); the hub decides what to do.
     Looked for in the new chunk plus a short tail, and quiet for a minute after a hit. */
  if (row && row.kind !== 'shell' && Date.now() - (entry.limitAt || 0) > 60000) {
    const text = ((entry.limTail || '') + plainText(d)).replace(/\s+/g, ' ');
    entry.limTail = text.slice(-300);
    const hit = detectLimit(text);
    if (hit) { entry.limitAt = Date.now(); entry.limTail = ''; events.emit('limit', sessionId, { ...hit, text: text.slice(-200) }); }
  }
  const msg = JSON.stringify({ type: 'data', data: d });
  for (const ws of entry.clients) if (ws.readyState === 1) ws.send(msg);
}

export function finish(sessionId, exitCode) {
  const entry = live.get(sessionId);
  if (entry) {
    entry.stop();
    live.delete(sessionId);
    for (const ws of entry.clients) if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'exit', code: exitCode }));
    if (entry.tui) { events.emit('tui-exit', sessionId, entry); return; }
  }
  /* A run the user killed exits non-zero; it stays 'stopped', not 'failed'. */
  if (['stopped', 'hibernated'].includes(getSession(sessionId)?.status)) { updateSession(sessionId, { pid: null }); return; }
  updateSession(sessionId, { status: exitCode === 0 ? 'done' : 'failed', pid: null });
  evlog(exitCode === 0 ? 'info' : 'error', 'pty', `run ${sessionId} exited ${exitCode}`);
  events.emit('exit', sessionId, exitCode);
}

export function attach(sessionId, ws) {
  const row = getSession(sessionId);
  if (!row) return;
  if (row.mode === 'json' && row.device && row.device !== 'local' && !isTui(sessionId)) {
    ws.send(JSON.stringify({ type: 'backlog', data: readLog(sessionId) }));
    const output = (id, data) => { if (id === sessionId && ws.readyState === 1) ws.send(JSON.stringify({ type: 'data', data })); };
    events.on('chat-output', output);
    ws.on('close', () => events.off('chat-output', output));
    return; // Remote JSON log only: never start a second, local TUI.
  }
  if (!live.has(sessionId) && row.device && row.device !== 'local' && !row.ssh) {
    /* A remote run only exists while its agent is attached; never fake it with a local shell. */
    ws.send(JSON.stringify({ type: 'data', data: `\r\n[${row.device}: agent not attached]\r\n` }));
    return;
  }
  const entry = ensure(sessionId);
  if (!entry) return;
  entry.clients.add(ws);
  ws.send(JSON.stringify({ type: 'backlog', data: entry.tui ? entry.buf : readLog(sessionId) }));   // a TUI keeps running between views; its output so far redraws it
  ws.on('close', () => entry.clients.delete(ws));
}

/* The env a session's process starts with: Settings → Environment, the endpoint for agents that
   use it, and what server/hooks/ and the xb CLI need. Shared by the PTY and bubble-chat turns. */
export function sessionEnv(row, extraEnv) {
  return { ...(AGENTS[row.agent] && AGENTS[row.agent].env), ...hubSettings().env, ...(extraEnv ?? runEnv(row)),
    XBLABS_SESSION: row.id, XBLABS_HUB: `http://127.0.0.1:${process.env.PORT || 5200}`,
    [PATH_KEY]: join(home(), 'bin') + delimiter + (process.env[PATH_KEY] || '') };
}

export function ensure(sessionId, extraEnv) {
  if (live.has(sessionId)) return live.get(sessionId);
  const row = getSession(sessionId);
  if (!row) return null;
  if (row.device && row.device !== 'local' && !row.ssh) return null;
  if (row.kind === 'chat' && row.mode === 'json' && AGENTS[row.agent]?.json?.tui) return ensureTui(row, extraEnv);

  const ssh = row.ssh ? JSON.parse(row.ssh) : null;
  /* SSH cannot forward the endpoint or resolve worker hooks; never use its default provider. */
  if (ssh && row.kind === 'job' && row.agent === 'omp' && runEnv(row).LLM_BASE_URL) {
    updateSession(sessionId, { status: 'failed', pid: null });
    appendLog(sessionId, '[xblabs] OMP shared endpoint requires an attached XBLabs agent; SSH cannot bind its provider\r\n');
    return null;
  }
  /* A job ends with its process, so only the interactive chat needs status hooks. */
  const ranBefore = !!readLog(sessionId);
  const chat = chatArgv(row, ranBefore);
  /* A fresh worktree runs the project's setup once, in this terminal, before the agent. */
  const setup = !ssh && row.branch && !ranBefore ? setupCommand(row.cwd) : '';
  const argv = jobArgv(row) || (chat && [...chat, ...hookFlags(row.agent)]);
  /* Attaching a terminal can start the process too, so the endpoint env is decided here. */
  extraEnv = sessionEnv(row, extraEnv);
  let proc;
  try {
    proc = ssh
      ? pty.spawn(SSH_BIN, [
          '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ServerAliveInterval=30',
          '-o', 'ServerAliveCountMax=3', ...(ssh.port && ssh.port !== 22 ? ['-p', String(ssh.port)] : []), ...sshKeyArgs(ssh.key), ...(argv ? ['-t'] : []), `${ssh.user ? ssh.user + '@' : ''}${ssh.host}`,
          /* Remote side is a posix login shell, so the agent finds its npm/pipx PATH. */
          ...(argv ? [`bash -lc ${qPosix(argv.map(qPosix).join(' '))}`] : []),
        ], {
          name: 'xterm-256color', cols: 100, rows: 30, useConpty: true, cwd: process.cwd(),
          env: { ...process.env, TERM: 'xterm-256color', ...extraEnv },
        })
      : pty.spawn(SHELL, shellArgs(argv, true, setup), {
          name: 'xterm-256color', cols: 100, rows: 30,
          /* A path that does not exist here would make CreateProcess fail with 267. */
          cwd: (row.cwd && existsSync(row.cwd) ? row.cwd : process.cwd()), useConpty: true,
          env: { ...process.env, ...extraEnv }, // one LLM endpoint for every run
        });
  } catch (err) {
    updateSession(sessionId, { status: 'failed', pid: null });
    evlog('error', row.device || 'pty', `run ${sessionId} could not start · ${err.message}`
      + ` · bin=${ssh ? SSH_BIN : SHELL} cwd=${process.cwd()} argv=${ssh ? ssh.host : 'shell'}`);
    return null;
  }

  const entry = makeEntry(sessionId);
  entry.proc = proc;
  proc.onData((d) => pump(sessionId, d));
  proc.onExit(({ exitCode }) => finish(sessionId, exitCode));

  updateSession(sessionId, { status: 'running', pid: proc.pid });
  if (!ranBefore) typeFirst(row, entry);
  if (argv) evlog('info', row.device || 'local', `run ${sessionId} · ${argv.join(' ').slice(0, 90)}`);
  return entry;
}

/* Remote run: the agent owns the process, we only proxy bytes. Same entry shape as a local PTY. */
/* A bubble chat's Terminal view: the agent's own TUI on the same conversation. It never touches
   the session's status (the JSON turns own it) and keeps no log. markP = how many items the
   agent's store held at start, so 'tui-exit' can copy only what was typed in the TUI. */
/* OMP ignores the LLM_* env: the hub endpoint, and the model a session picked, reach it through
   XBLabs' extension as a provider named xblabs. Without it OMP runs its own default model. */
export function ompEndpoint(row, argv, env) {
  if (row.agent !== 'omp' || !env || !env.LLM_BASE_URL) return argv;
  if (!/^https?:$/.test(new URL(env.LLM_BASE_URL).protocol) || !env.LLM_MODEL?.trim()) throw new Error('OMP shared endpoint requires HTTP(S) URL and model');
  return [...argv, '--extension', row.device && row.device !== 'local' ? 'xblabs:omp' : hookFlags('omp')[1], '--model', `xblabs/${env.LLM_MODEL}`];
}
function ensureTui(row, extraEnv) {
  const a = AGENTS[row.agent].json;
  const ctx = { sid: row.id, resume: row.agent_session, newId: randomUUID() };
  const env0 = extraEnv ?? configuredEnv(row);
  let argv = applySettings(a.tui(ctx), row.agent, hubSettings(), env0, { resume: lastTurn(row.id) > 0 });
  try { argv = ompEndpoint(row, argv, env0); } catch (err) { evlog('error', 'pty', `${row.id} TUI could not start · ${err.message}`); return null; }
  if (argv.includes(ctx.newId)) updateSession(row.id, { agent_session: ctx.newId });
  let proc;
  try {
    proc = pty.spawn(SHELL, shellArgs(argv, true), {
      name: 'xterm-256color', cols: 100, rows: 30, useConpty: true,
      cwd: row.cwd && existsSync(row.cwd) ? row.cwd : process.cwd(), env: { ...process.env, ...sessionEnv(row, extraEnv) },
    });
  } catch (err) { evlog('error', 'pty', `${row.id} TUI could not start · ${err.message}`); return null; }
  const entry = { clients: new Set(), buf: '', lastOut: Date.now(), tui: true, stop() {}, proc, since: Date.now(),
    markP: a.history(row).then((h) => h.length, () => 0) };
  live.set(row.id, entry);
  proc.onData((d) => pump(row.id, d));
  proc.onExit(({ exitCode }) => {
    if (live.get(row.id) === entry) live.delete(row.id);
    for (const ws of entry.clients) if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'exit', code: exitCode }));
    events.emit('tui-exit', row.id, entry);
  });
  evlog('info', 'local', `${row.id} TUI · ${argv.join(' ').slice(0, 90)}`);
  events.emit('tui-start', row.id, entry);
  return entry;
}

/* Agents without a prompt flag get the first prompt typed in once their screen is up.
   A shell job's prompt is the command to run, one line each. Local and remote runs alike. */
export function typeFirst(row, entry) {
  const typed = (row.prompt || '').trim(), a = AGENTS[row.agent];
  const shellJob = row.agent === 'shell' && row.kind === 'job';
  if (!typed || !entry || !(shellJob || (a?.typePrompt && (row.kind === 'chat' || (row.kind === 'job' && !a.run))))) return;
  const proc = entry.proc;
  setTimeout(() => {
    if (entry.proc !== proc) return;
    proc.write(shellJob ? typed.replace(/\r?\n/g, '\r') : typed.includes('\n') ? `\x1b[200~${typed}\x1b[201~` : typed);
    setTimeout(() => { if (entry.proc === proc) proc.write('\r'); }, 150);
  }, 3500);
}

export function attachRemote(sessionId, send, tui = false, mark = 0) {
  if (live.has(sessionId)) return live.get(sessionId);
  const entry = makeEntry(sessionId);
  entry.remote = true;
  if (tui) {
    entry.stop();
    entry.stop = () => {};
    entry.tui = true; entry.since = Date.now(); entry.markP = Promise.resolve(mark);
  }
  entry.proc = {
    write: (d) => send({ type: 'input', id: sessionId, data: d }),
    resize: (cols, rows) => send({ type: 'resize', id: sessionId, cols, rows }),
    kill: () => send({ type: 'kill', id: sessionId }),
  };
  if (tui) events.emit('tui-start', sessionId, entry);
  else updateSession(sessionId, { status: 'running' });
  return entry;
}

export function write(sessionId, data) {
  const row0 = getSession(sessionId);
  if (row0?.mode === 'json' && row0.device && row0.device !== 'local' && !isTui(sessionId)) return false;
  let entry = live.get(sessionId);
  if (!entry) {
    /* Never resurrect a remote run as a local shell: the bytes would go to the wrong machine. */
    const row = getSession(sessionId);
    if (row && row.device && row.device !== 'local' && !row.ssh) return false;
    entry = ensure(sessionId);
  }
  if (entry) {
    entry.proc.write(data);
    if (!/^(\x1b\[[IO])+$/.test(data)) entry.inMark = entry.buf.length;   // what is asked after a keystroke is new; focus in/out is not one
  }
  return true;
}

/* A TUI waiting on a numbered menu (an approval) since my last keystroke, read from its output:
   { title, detail[], options[], sel }. ponytail: text heuristics on the raw stream, no screen
   model; a TUI that redraws by diff only is read from the menu's first full draw. */
const plainText = (s) => s.replace(/\x1b\[[0-9;]*[HfABEFd]/g, '\n').replace(/\x1b\[(\d*)C/g, (_, n) => ' '.repeat(+n || 1))
  .replace(/\x1b\[[0-9;]*G/g, ' ').replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b\[[0-9;?<>=]*[ -/]*[@-~]|\x1b[()][A-Z0-9]|\x1b[=>78]/g, '').replace(/\r\n?/g, '\n');
export function parseAsk(txt) {
  const lines = plainText(txt).split('\n').map((l) => l.replace(/[│┃║╭╮╰╯]/g, ' ').replace(/\s+$/, ''));
  const OPT = /^\s*([❯>›▸➜])?\s*(\d)\.\s+(.+?)\s*$/;
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i--) { const m = lines[i].match(OPT); if (m && m[2] === '1') { start = i; break; } }
  if (start < 0) return null;
  const options = []; let sel = 0;
  for (let i = start; i < lines.length; i++) {
    const m = lines[i].match(OPT);
    if (!m) { if (lines[i].trim()) break; continue; }
    if (+m[2] !== options.length + 1) break;
    if (m[1]) sel = options.length;
    options.push(m[3]);
  }
  if (options.length < 2 || !options.some((o) => /\b(allow|yes|approve|deny|no|reject)\b/i.test(o))) return null;
  const head = lines.slice(Math.max(0, start - 14), start).map((s) => s.replace(/^[\s─━]+|[\s─━]+$/g, '').trim()).filter(Boolean);
  const ti = head.map((s) => /dangerous|permission|approv|allow|proceed|want to|confirm/i.test(s)).lastIndexOf(true);
  return { title: (ti >= 0 ? head[ti] : 'The agent is asking').replace(/^[^\w]+/, ''), detail: ti >= 0 ? head.slice(ti + 1) : head.slice(-4), options, sel };
}
console.assert((() => { const a = parseAsk('x\r\n│ ⚠ Dangerous Command │\r\n│ rm -rf a │\r\n\x1b[1m❯ 1. Allow once\x1b[0m\r\n  2. Deny\r\n status'); return a && a.title === 'Dangerous Command' && a.options.length === 2 && a.sel === 0 && a.detail[0] === 'rm -rf a'; })(), 'parseAsk');
const STATUS = /[^\n\r]{0,40}(?:temporarily unavailable|retrying|rate.?limit|overloaded|gave up|attempt \d+\/\d+ failed|HTTP [45]\d\d)[^\n\r]{0,120}/gi;
/* Lines where an agent says it is retrying or its provider failed, cleaned for the chat. */
export const statusLines = (text) => [...String(text).matchAll(STATUS)].map((m) => m[0].replace(/^[^\w]+/, '').replace(/\s*[─━═│]{2,}.*$/, '').replace(/\s+·\s*[\dhms ]+$/, '').replace(/\s+/g, ' ').trim().slice(0, 200)).filter((l) => l.length > 8);
/* The TUI's latest status line, while it is recent (a countdown redraws it). */
export function tuiNote(id) {
  const e = live.get(id);
  return e && e.tui && e.note && Date.now() - e.note.at < 90000 ? e.note.text : '';
}
console.assert(statusLines('\x1b[2K⏳Provider temporarily unavailable — retrying automatically in 16s (cycle 1/5); press Esc to stop\n x Attempt 1/3 failed: HTTP 500: database or disk is full\nok').length === 2, 'statusLines');
export function tuiAsk(id) {
  const e = live.get(id);
  return e && e.tui ? parseAsk(e.buf.slice(Math.max(e.inMark || 0, e.buf.length - 16000))) : null;
}
/* Pick option n (0-based) of that menu: arrows from the highlighted one, then Enter. */
export function tuiPick(id, n) {
  const a = tuiAsk(id);
  if (!a || !(n >= 0 && n < a.options.length)) return false;
  const d = n - a.sel;
  write(id, (d > 0 ? '\x1b[B' : '\x1b[A').repeat(Math.abs(d)));
  setTimeout(() => write(id, '\r'), 120);
  return true;
}

export function resize(sessionId, cols, rows) {
  const entry = live.get(sessionId);
  /* A resize can race the process exit; node-pty throws then, which would take the hub down. */
  if (entry) try { entry.proc.resize(Math.max(2, cols), Math.max(2, rows)); } catch { /* exited */ }
}

export function kill(id) {
  const entry = live.get(id);
  if (!entry) return false;
  if (entry.remote && entry.tui) { try { entry.proc.kill(); } catch {} return true; }
  entry.stop();
  live.delete(id);
  try { entry.proc.kill(); } catch {}
  return true;
}

export function killAll() {
  for (const [id, entry] of live) {
    try { entry.proc.kill(); } catch {}
    if (!entry.tui) updateSession(id, { status: 'stopped' });
  }
  live.clear();
}

export const isLive = (id) => live.has(id);
export const liveIds = () => [...live.keys()];
export const isTui = (id) => !!(live.get(id) || {}).tui;
/* ms since the session last printed anything; Infinity when it is not running. */
export const quietFor = (id) => { const e = live.get(id); return e ? Date.now() - (e.lastOut || 0) : Infinity; };
