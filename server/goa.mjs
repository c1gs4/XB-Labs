// GOA: one head session that does not code. It hands tasks to worker sessions (any installed
// agent, own worktree each), follows them, and hears back here when a worker finishes a turn,
// asks something, fails or stalls. The head talks to the hub through the `xb` CLI.
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as db from './db.mjs';
import * as pty from './pty.mjs';
import * as worktree from './worktree.mjs';
import * as chat from './chat.mjs';
import { AGENTS, enabled } from './agents.mjs';
import { log as evlog } from './log.mjs';

const GOA_DIR = () => join(worktree.home(), 'goa');
const BIN_DIR = () => join(worktree.home(), 'bin');
const XB = join(dirname(fileURLToPath(import.meta.url)), 'xb.mjs');
const TAG = '[XBLabs GOA]';
const ACTIVE = ['running', 'waiting', 'turn-ended', 'reported'];

/* The head's instructions, as a rules file in its own folder: AGENTS.md for most agents,
   CLAUDE.md for Claude Code. Nothing is written into an agent's own config. */
const RULES = `# You are GOA, the head agent of XBLabs

You do not write code and you do not edit project files. You split my request into tasks,
hand each to a worker session with \`xb goa delegate\`, follow them, check what they did and
report back to me. Delegate, don't work.

## Commands (run them in your shell)
- \`xb goa agents\`: which coding agents are installed on which device.
- \`xb goa delegate --agent <id> --project <folder> "<task>"\`: start a worker on that project, in
  its own worktree and branch. Options: \`--session <id>\` to give the task to an existing worker,
  \`--no-branch\` to work in the project folder itself, \`--device <name>\` (only "local" for now).
  Write the task so a worker with no context can do it: goal, files, what done looks like.
- \`xb goa board\`: every task, its worker session, status and what the worker reported.
- \`xb goa show <task>\`: one task in full, with the end of its worker's terminal.
- \`xb goa task <task> --status done|failed|stopped [--note "..."]\`: settle a task. Only you
  settle tasks; a worker's report is not a result until you checked it.

## Notes
My notes in XBLabs: \`xb notes ls\`, \`xb notes read <id>\`, \`xb notes new --title "..." "text"\`,
\`xb notes edit <id> --append "text"\`. Workers can use the same commands.

## Browser
A real visible browser I can watch: \`xb browser open <url|port>\`, \`xb browser snapshot\` (text plus
numbered elements), \`xb browser click <n|css>\`, \`xb browser fill <n|css> "text"\`,
\`xb browser screenshot [file]\`, \`xb browser eval "js"\`, \`xb browser back|forward|reload\`.
Snapshot again after a page change; numbers are only valid for the last snapshot.

## Language
Everything you write for the hub or a worker is in English, whatever language I write in:
task text, follow-ups, \`--note\` text, notes and their titles, and the commands themselves.
Only your replies to me are in my language.

## What reaches you
Do not sleep, poll or wait inside a turn for workers. After delegating, end your turn: every
worker update comes to you as a new message by itself.

Lines starting with \`${TAG}\` come from XBLabs, not from me: a worker finished a turn,
reported, asked a question, failed or went quiet. Look at the task, then decide: settle it, give
the worker a follow-up with \`xb goa delegate --session <id> "..."\`, or tell me.

## Never
- Push, merge, open pull requests or delete branches. I do that from XBLabs after review.
- Edit files outside this folder.
- Answer a worker's permission question yourself when it is about deleting, publishing,
  paying or secrets: tell me instead.
`;

/* The xb CLI on PATH for every session (server/pty.mjs puts <home>/bin first), and the head's folder. */
export function init() {
  mkdirSync(BIN_DIR(), { recursive: true });
  mkdirSync(GOA_DIR(), { recursive: true });
  writeFileSync(join(BIN_DIR(), 'xb.cmd'), `@node "${XB}" %*\r\n`);
  writeFileSync(join(BIN_DIR(), 'xb'), `#!/bin/sh\nexec node "${XB.replace(/\\/g, '/')}" "$@"\n`, { mode: 0o755 });
  /* My own rules from Settings → GOA go under the built-in ones. */
  const mine = db.hubSettings().goa.rules.trim();
  const text = RULES + (mine ? `\n## My rules (set in XBLabs Settings, do not change them)\n${mine}\n` : '');
  writeFileSync(join(GOA_DIR(), 'AGENTS.md'), text);
  writeFileSync(join(GOA_DIR(), 'CLAUDE.md'), text);
  /* Workers started before they lived under GOA: move them there, under the current head. */
  for (const t of db.listTasks(500)) {
    const s = t.session_id && db.getSession(t.session_id);
    if (s && s.ws !== 'GOA') db.updateSession(s.id, { ws: 'GOA', parent: s.parent || headId() });
  }
}

export const headId = () => db.getSetting('goa.head') || null;
/* A session is a bubble chat (one JSON turn per message, server/chat.mjs) when its agent has a
   JSON mode; otherwise a terminal. Both kinds are driven the same way below. */
const bubble = (id) => (db.getSession(id) || {}).mode === 'json';
const alive = (id) => (bubble(id) ? (db.getSession(id) || {}).status !== 'stopped' : pty.isLive(id));
export function head() {
  const id = headId();
  const s = id && db.getSession(id);
  return s ? { ...s, live: alive(s.id) } : null;
}

/* Ready for a new message: not answering and not asking anything. A terminal agent without
   hooks never says idle, so for it a quiet screen counts too. */
function ready(id) {
  const s = db.getSession(id);
  if (!s || s.status === 'waiting') return false;
  if (bubble(id)) return !chat.busy(id) && s.status !== 'stopped';
  return pty.isLive(id) && (s.status === 'idle' || pty.quietFor(id) >= 8000);
}
/* A bubble chat gets it as its next turn; a terminal gets it typed, Enter apart. */
function type(id, text) {
  if (bubble(id)) { chat.send(id, text).catch((err) => evlog('warn', 'goa', `${id} not sent · ${err.message}`)); return; }
  pty.write(id, text.replace(/\s*\n\s*/g, ' '));
  setTimeout(() => pty.write(id, '\r'), 200);
  db.updateSession(id, { status: 'running' });
}
/* Start a new session: its first turn in a bubble chat, else its terminal. False when it fails. */
function begin(s, prompt) {
  if (chat.canBubble(s)) {
    db.updateSession(s.id, { mode: 'json' });
    chat.send(s.id, prompt).catch((err) => evlog('warn', 'goa', `${s.id} first turn · ${err.message}`));
    return true;
  }
  return !!pty.ensure(s.id);
}

export function startHead(agent) {
  if (!Object.hasOwn(AGENTS, agent)) throw new Error(`unknown agent: ${agent}`);
  const cur = head();
  if (cur && cur.live) throw new Error('GOA is already running; stop it first');
  init();
  const prompt = 'Read AGENTS.md in this folder and follow it. Then say you are ready and wait for my request.';
  const s = db.createSession({ ws: 'GOA', title: 'GOA', kind: 'chat', agent, cwd: GOA_DIR(), prompt });
  db.setSetting('goa.head', s.id);
  begin(s, prompt);
  evlog('info', 'goa', `head started · ${agent} · ${s.id}`);
  return head();
}
export function stopHead() {
  const id = headId();
  if (!id) return;
  chat.stop(id);
  pty.kill(id);
  db.updateSession(id, { status: 'stopped', pid: null });
}

/* --- delegate ---------------------------------------------------------- */
export function delegate({ agent, device = 'local', project, prompt, branch = true, session }) {
  prompt = String(prompt || '').trim();
  if (!prompt) throw new Error('task text required');
  if (session) {
    const s = db.getSession(session);
    if (!s || s.id === headId()) throw new Error(`no worker session ${session}`);
    return queued(db.createTask({ project: s.cwd, device: s.device, agent: s.agent, prompt, session_id: s.id, branch: !!s.branch }));
  }
  if (!Object.hasOwn(AGENTS, agent)) throw new Error(`unknown agent: ${agent}. See xb goa agents`);
  if (!enabled(agent, db.hubSettings())) throw new Error(`${agent} is switched off in XBLabs Settings`);
  if (device !== 'local') throw new Error('workers run on this hub only for now (device "local")');
  project = resolve(String(project || ''));
  if (!existsSync(project) || !statSync(project).isDirectory()) throw new Error(`no such folder: ${project}`);
  return queued(db.createTask({ project, device, agent, prompt, branch }));
}
function queued(t) { evlog('info', 'goa', `task ${t.id} queued · ${t.agent} · ${t.project}`); pump(); return db.getTask(t.id); }

const footer = (t) => `\n\n(XBLabs task ${t.id}. When you finish this task or stop, run this one command in your shell as it is, from any folder, with no cd before it: xb goa report --outcome done|partly|blocked|failed "one line in English on what you did")`;

/* Start what can start: a task for an existing worker when that worker is ready, a task for a
   new worker while fewer than goa.max workers are busy. Oldest first. */
export function pump() {
  const max = db.hubSettings().goa.max;
  const tasks = db.listTasks().reverse();
  let busy = tasks.filter((t) => ['running', 'waiting'].includes(t.status) && t.session_id && alive(t.session_id)).length;
  for (const t of tasks.filter((x) => x.status === 'queued')) {
    if (t.session_id) {
      if (!bubble(t.session_id) && !pty.isLive(t.session_id)) pty.ensure(t.session_id);   // reopens on the agent's last conversation
      if (!ready(t.session_id)) continue;
      type(t.session_id, t.prompt + footer(t));
      db.updateTask(t.id, { status: 'running' });
      continue;
    }
    if (busy >= max) continue;
    /* Workers live under GOA in the sidebar, as children of the head that gave the task. */
    const s = db.createSession({ ws: 'GOA', parent: headId(), title: `${basename(t.project)} · ${t.prompt.slice(0, 50)}`, kind: 'chat', agent: t.agent, cwd: t.project, device: t.device, prompt: t.prompt + footer(t) });
    if (t.branch) {
      const w = worktree.isolate(t.project, s.id);
      if (w && !w.error) db.updateSession(s.id, { cwd: w.cwd, branch: w.branch, origin: t.project });
      else if (w?.error) evlog('warn', 'goa', `task ${t.id} no worktree (${w.error}) · works in ${t.project}`);
    }
    db.updateTask(t.id, { session_id: s.id, status: 'running' });
    if (!begin(db.getSession(s.id), t.prompt + footer(t))) { db.updateTask(t.id, { status: 'failed', note: 'worker could not start' }); tell(`task ${t.id} could not start its ${t.agent} worker.`); continue; }
    busy++;
    evlog('info', 'goa', `task ${t.id} → ${s.id} (${t.agent})`);
  }
}

/* --- what the head hears ----------------------------------------------- */
const outbox = [];
function tell(text) { if (head()?.live) outbox.push(`${TAG} ${text}`); }
const taskOf = (sessionId) => db.listTasks().find((t) => t.session_id === sessionId && ACTIVE.includes(t.status));
const who = (t) => `task ${t.id} (${t.agent}, session ${t.session_id})`;
/* A bubble worker's last answer, so the head has the result even when the worker did not report. */
function lastWords(id) {
  if (!bubble(id)) return '';
  const e = db.listEvents(id, 0).filter((x) => x.kind === 'text').pop();
  const txt = e ? e.data.text.replace(/\s+/g, ' ').trim() : '';
  return txt ? ` Its last message: "${txt.length > 600 ? txt.slice(0, 600) + '…' : txt}"` : '';
}

/* Worker side: `xb goa report`. The report is what the worker says; the head still settles. */
export function report(sessionId, outcome, note = '') {
  const t = taskOf(sessionId);
  if (!t) throw new Error('this session has no open XBLabs task');
  if (!['done', 'partly', 'nothing', 'blocked', 'refused', 'failed'].includes(outcome)) throw new Error('outcome must be done|partly|nothing|blocked|refused|failed');
  db.updateTask(t.id, { status: 'reported', outcome, note: String(note).slice(0, 500) });
  tell(`${who(t)} reported ${outcome}${note ? `: ${String(note).slice(0, 300)}` : ''}. Check it, then settle with xb goa task ${t.id} --status done|failed.`);
}
/* A status hook said the worker is idle / waiting (index.mjs /status). */
export function onStatus(sessionId, status) {
  if (sessionId === headId()) return;
  const t = taskOf(sessionId);
  if (!t) return;
  if (status === 'idle' && t.status === 'running') {
    db.updateTask(t.id, { status: 'turn-ended' });
    tell(`${who(t)} ended a turn without a report.${lastWords(sessionId)} Check with xb goa show ${t.id}, then settle it or give a follow-up.`);
  }
  if (status === 'waiting') onWaiting(sessionId);
  pump();
}
function onWaiting(sessionId) {
  const t = taskOf(sessionId);
  if (!t || t.status === 'waiting') return;
  db.updateTask(t.id, { status: 'waiting', question: 'asking for permission or input' });
  tell(`${who(t)} is asking a question. Look with xb goa show ${t.id}; anything about deleting, publishing, paying or secrets goes to me.`);
}
pty.events.on('waiting', (id) => { if (id !== headId()) onWaiting(id); });
/* A bubble-chat worker finished a turn (server/chat.mjs). Its report, if any, came during it. */
pty.events.on('turn', (id) => { if (id !== headId()) onStatus(id, 'idle'); else flush(); });
pty.events.on('exit', (id, code) => {
  if (id === headId()) return;
  const t = taskOf(id);
  if (t) {
    db.updateTask(t.id, { status: code === 0 ? 'turn-ended' : 'failed', note: t.note || `worker exited ${code}` });
    tell(`${who(t)} worker exited with code ${code}.`);
  }
  pump();
});

/* Only the head settles a task. */
export function settle(id, status, note) {
  if (!['done', 'failed', 'stopped'].includes(status)) throw new Error('status must be done|failed|stopped');
  const t = db.getTask(id);
  if (!t) throw new Error(`no task ${id}`);
  db.updateTask(id, { status, ...(note ? { note: String(note).slice(0, 500) } : {}) });
  pump();
  return db.getTask(id);
}

/* One task in full, with the end of its worker's terminal, for `xb goa show`. */
export function show(id) {
  const t = db.getTask(id);
  if (!t) throw new Error(`no task ${id}`);
  const s = t.session_id && db.getSession(t.session_id);
  /* A bubble chat's last lines are its last messages and tool calls, not a screen. */
  if (s && s.mode === 'json') {
    const lines = db.listEvents(s.id, 0).slice(-12).flatMap((e) => (e.kind === 'text' || e.kind === 'user' ? `${e.kind === 'user' ? '> ' : ''}${e.data.text}`.split('\n')
      : e.kind === 'tool' ? [`[${e.data.name}] ${JSON.stringify(e.data.input).slice(0, 160)}`, ...String(e.data.output || '').split('\n').slice(0, 4).map((l) => '  ' + l)]
      : e.kind === 'approval' ? [`[needs approval] ${e.data.state}`] : e.kind === 'error' ? [`[error] ${e.data.text}`] : []));
    return { ...t, worker: { id: s.id, status: s.status, cwd: s.cwd, branch: s.branch, live: alive(s.id) }, screen: lines.filter((l) => l.trim()).slice(-40) };
  }
  const screen = t.session_id ? db.readLog(t.session_id).replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07]*\x07|\r/g, '').split('\n').filter((l) => l.trim()).slice(-30) : [];
  return { ...t, worker: s ? { id: s.id, status: s.status, cwd: s.cwd, branch: s.branch, live: pty.isLive(s.id) } : null, screen };
}

/* Every few seconds: deliver one line to the head when it is ready, and flag quiet workers. */
const stalled = new Set();
/* Everything waiting goes to the head at once when it is ready: in a bubble chat each delivery
   is a whole turn, so one turn for all of it. */
function flush() {
  const h = headId();
  if (!outbox.length || !h || !ready(h)) return;
  type(h, bubble(h) ? outbox.splice(0).join('\n') : outbox.shift());
}
setInterval(() => {
  flush();
  const stallMs = db.hubSettings().goa.stallMin * 60000;
  for (const t of db.listTasks(200)) {
    if (t.status !== 'running' || !t.session_id || stalled.has(t.id)) continue;
    if (pty.quietFor(t.session_id) >= stallMs && pty.quietFor(t.session_id) !== Infinity) {
      stalled.add(t.id);
      tell(`${who(t)} printed nothing for ${Math.round(stallMs / 60000)} minutes. Look with xb goa show ${t.id}.`);
    }
  }
  if (db.listTasks(50).some((t) => t.status === 'queued')) pump();
}, 3000).unref();
