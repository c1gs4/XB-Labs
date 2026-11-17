// Bubble chat: each message I send is one turn of the agent, run in its JSON output mode
// (agents.mjs json adapters). Its events are stored (chat_events) and polled by the page.
// Agents without a JSON mode stay terminal (PTY) sessions.
import { spawn, execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as db from './db.mjs';
import { AGENTS, findBin, applySettings, NEEDS_APPROVAL, configuredModel } from './agents.mjs';
import { sessionEnv, events as ptyEvents, isLive, isTui, kill as ptyKill, write as ptyWrite, ompEndpoint, statusLines } from './pty.mjs';
import { detectLimit } from './accounts.mjs';
import { setupCommand } from './worktree.mjs';
import { log as evlog } from './log.mjs';

const running = new Map();   // sessionId -> child process
const OUT_MAX = 4000;        // a tool's output is kept to this many characters
let remote = null;
let remoteHistory = null;
let tuiOpening = () => null;
export const setRemote = (transport) => { remote = transport; };
export const setRemoteHistory = (read) => { remoteHistory = read; };
export const setTuiOpening = (opening) => { tuiOpening = opening; };

export const canBubble = (row) => !!row && row.kind === 'chat' && ((row.device || 'local') === 'local' || remote?.available(row.device))
  && Object.hasOwn(AGENTS, row.agent) && !!AGENTS[row.agent].json;
/* A message typed into the open TUI: busy until its answer is synced back (or the TUI closes),
   so the chat shows it working and queues the next message. */
const tuiTurn = new Set();
const sending = new Set();   // a message waiting for the TUI to finish opening: busy already
/* Each local turn's agent process, kept after it exits: what it started may still run (see ports.bgOf). */
const turnPids = new Map();
export const turnRoots = (id) => turnPids.get(id) || [];
export const busy = (id) => running.has(id) || tuiTurn.has(id) || sending.has(id);

/* Retry and provider-error lines become one status card per turn, like a tool call. A line that
   only differs in its numbers (a countdown, cycle 2/5) replaces the one before it. */
/* Numbers ignored; a line the TUI cut short ("…(c...") is the same line as its full form.
   Changes `have` in place; true when something changed. */
export function mergeStatus(have, lines) {
  const core = (l) => l.replace(/[\d.…]+/g, '#').replace(/#+$/, '');
  const same = (a, b) => core(a).startsWith(core(b)) || core(b).startsWith(core(a));
  let changed = false;
  for (const l of lines) {
    const i = have.findIndex((x) => same(x, l));
    if (i >= 0) { if (have[i] !== l && l.length >= have[i].length - 3) { have[i] = l; changed = true; } }
    else if (have.length < 30) { have.push(l); changed = true; }
  }
  return changed;
}
const statusEv = new Map();   // sessionId -> { turn, ev, lines }
function addStatus(id, turn, lines) {
  let s = statusEv.get(id);
  if (!s || s.turn !== turn) { s = { turn, ev: null, lines: [] }; statusEv.set(id, s); }
  if (!mergeStatus(s.lines, lines)) return;
  if (s.ev) db.updateEvent(s.ev, { lines: s.lines }); else s.ev = db.addEvent(id, turn, 'status', { lines: s.lines });
}
ptyEvents.on('tui-status', (id, lines) => { if (tuiTurn.has(id)) addStatus(id, db.lastTurn(id), lines); });
export const busyIds = () => [...running.keys()];

/* A project's setup script, once, before the first turn in a fresh worktree. */
function setup(row, turn) {
  const cmd = row.branch && turn === 1 ? setupCommand(row.cwd) : '';
  if (!cmd) return Promise.resolve();
  const ev = db.addEvent(row.id, turn, 'note', { text: `Running setup: ${cmd}` });
  return new Promise((done) => execFile(process.env.COMSPEC || 'cmd.exe', ['/d', '/s', '/c', cmd], { cwd: row.cwd, windowsHide: true, timeout: 600000, maxBuffer: 8 << 20 },
    (err, out, errOut) => { db.updateEvent(ev, { text: `Setup ${err ? 'failed' : 'done'}: ${cmd}`, output: String(errOut || out).slice(-OUT_MAX), error: !!err }); done(); }));
}

/* The Terminal view's TUI and the chat are one conversation: while the TUI runs, what is said
   there is copied into the chat every second, and a tool card fills in when its result lands.
   ponytail: re-reads the agent's whole store each tick; fine for normal sessions, tail the file
   if huge transcripts get slow. */
const tuiWait = new Map();   // sessionId -> resolve of closeTui
const toolData = (it) => ({ name: it.name, input: it.input, output: it.output == null ? null : String(it.output).slice(0, OUT_MAX), error: it.error });
function syncTui(id, entry) {
  if (entry.syncing) return entry.syncing;
  entry.syncing = (async () => {
    const row = db.getSession(id);
    const a = row && AGENTS[row.agent] && AGENTS[row.agent].json;
    if (!a || !a.history) return;
    /* The TUI started a new conversation (no id yet): find the one it wrote. */
    const away = (row.device || 'local') !== 'local';
    if (!away && !row.agent_session && a.find) { const f = a.find(row, entry.since - 2000); if (f) { row.agent_session = f; db.updateSession(id, { agent_session: f }); } }
    const all = away ? await remoteHistory(row, entry.since - 2000) : await a.history(row);
    if (entry.copied == null) { entry.copied = await entry.markP; entry.pend = new Map(); }
    entry.copied = Math.min(entry.copied, all.length);
    /* A JSON turn writes the same conversation and its own events: skip what it wrote, or the
       chat shows every message twice. */
    if (running.has(id)) { entry.ownTurn = true; return; }
    if (entry.ownTurn) { entry.ownTurn = false; entry.copied = all.length; entry.tok = all.tokens; return; }
    if (all.tokens && !entry.tok) entry.tok = all.tokens;
    for (const [i, ev] of entry.pend) if (all[i] && all[i].output != null) { db.updateEvent(ev, toolData(all[i])); entry.pend.delete(i); }
    const items = all.slice(entry.copied);
    const lastKind = all[all.length - 1]?.kind;
    /* Only a new answer ends the turn: right after typing, the store still ends with the last one. */
    if (items.length && lastKind === 'text') tuiTurn.delete(id); else if (items.length && lastKind === 'user' && isTui(id)) tuiTurn.add(id);   // typed in the TUI itself too
    if (!items.length) { tuiUsage(id, entry, all); return; }
    let turn = db.lastTurn(id);
    if (items[0].kind !== 'user') turn = Math.max(turn, 1);
    items.forEach((it, k) => {
      if (it.kind === 'user') turn++;
      const ev = db.addEvent(id, turn, it.kind, it.kind === 'tool' ? toolData(it) : { text: it.text });
      if (it.kind === 'tool' && it.output == null) entry.pend.set(entry.copied + k, ev);
    });
    entry.copied = all.length;
    tuiUsage(id, entry, all);
  })().catch((err) => evlog('warn', 'chat', `${id} terminal history not read · ${err.message}`)).finally(() => { entry.syncing = null; });
  return entry.syncing;
}
/* A TUI turn reports no done event: once its answer is in and the store's totals moved, the
   difference is that turn's usage. */
function tuiUsage(id, entry, all) {
  const t = all.tokens, p = entry.tok;
  if (!t || !p || all[all.length - 1]?.kind !== 'text' || (t.input === p.input && t.output === p.output)) return;
  db.addEvent(id, db.lastTurn(id), 'done', { tokens: { input: t.input - p.input, output: t.output - p.output, cache_read: t.cache_read - p.cache_read, context: null }, ms: 0, error: '' });
  ptyEvents.emit('turn', id, 0);   // a turn typed into the TUI ended: pipelines and notifications hear it like a JSON turn
  entry.tok = t;
}
/* A hibernated session whose terminal opens again (opened in the app, a message sent) is awake. */
const wakeUp = (id) => { if (db.getSession(id)?.status === 'hibernated') db.updateSession(id, { status: 'idle' }); };
ptyEvents.on('tui-start', (id, entry) => { wakeUp(id); entry.timer = setInterval(() => syncTui(id, entry), 1000); });
ptyEvents.on('tui-exit', async (id, entry) => {
  clearInterval(entry.timer);
  try { await entry.syncing; await syncTui(id, entry); }
  finally {
    tuiTurn.delete(id);   // after the last sync: a closed TUI is not answering anything
    /* Its terminal closed and no JSON turn runs: the session is idle, not 'running' forever. */
    const row = db.getSession(id);
    if (row && row.status === 'running' && !running.has(id)) db.updateSession(id, { status: 'idle', pid: null });
    const w = tuiWait.get(id); if (w) { tuiWait.delete(id); w(); }
  }
});
/* A message typed in the chat while the TUI is open goes into the TUI, so one process holds the
   conversation; the sync above brings it and the answer back into the chat. */
function typeIntoTui(id, text) {
  tuiTurn.add(id);
  ptyWrite(id, /\n/.test(text) ? `\x1b[200~${text}\x1b[201~` : text);
  setTimeout(() => ptyWrite(id, '\r'), 150);   // after the TUI has taken the text in
}
/* Close the TUI, and resolve once its conversation is in the chat. */
export function closeTui(id) {
  if (!isLive(id)) return Promise.resolve();
  return new Promise((done) => {
    const t = setTimeout(() => { tuiWait.delete(id); done(); }, 8000);
    tuiWait.set(id, () => { clearTimeout(t); done(); });
    ptyKill(id);
  });
}

export async function send(sessionId, text, { approve = false, from = '' } = {}) {   // from: who sent it when it is not me (the hub for a team)
  /* The TUI may still be starting: wait for it, busy meanwhile. If it fails to open, the message
     runs as a JSON turn instead of being lost. */
  wakeUp(sessionId);
  sending.add(sessionId);
  try { await tuiOpening(sessionId)?.catch(() => {}); } finally { sending.delete(sessionId); }
  const row0 = db.getSession(sessionId);
  if (!canBubble(row0)) throw new Error('this session is a terminal session');
  if (running.has(sessionId)) throw new Error('the agent is still answering');
  text = String(text || '').trim();
  if (!text) throw new Error('message is empty');
  if (isTui(sessionId)) {
    /* Into the open TUI: a card it answers is settled and the session stops waiting, as a JSON turn does. */
    for (const e of db.listEvents(sessionId, 0)) if (e.kind === 'approval' && e.data.state === 'pending') db.updateEvent(e.id, { ...e.data, state: approve ? 'approved' : 'answered' });
    if (row0.status === 'waiting') db.updateSession(sessionId, { status: 'running' });
    typeIntoTui(sessionId, text); return;
  }
  const row = db.getSession(sessionId);
  const a = AGENTS[row.agent];
  const turn = db.lastTurn(sessionId) + 1;
  /* An agent that does not name its model per turn: the one its config is set to. */
  const away = (row.device || 'local') !== 'local';
  const cm = away || row.llm_model ? null : configuredModel(row.agent);   // a picked model is what the session shows
  if (cm) { const m = cm.provider ? `${cm.model} · ${cm.provider}` : cm.model; if (m !== row.model) { row.model = m; db.updateSession(sessionId, { model: m }); } }
  /* A new message answers any open approval: it is settled, not left asking. */
  for (const e of db.listEvents(sessionId, 0)) if (e.kind === 'approval' && e.data.state === 'pending') db.updateEvent(e.id, { ...e.data, state: approve ? 'approved' : 'answered' });
  db.addEvent(sessionId, turn, 'user', { text, approve, ...(from ? { from } : {}) });
  db.updateSession(sessionId, { status: 'running' });
  running.set(sessionId, null);   // taken before the setup await, so a second send waits
  if (!away) await setup(row, turn);

  const ctx = { sid: sessionId, resume: row.agent_session };
  const plain = approve && !!a.json.approveArgv;   // an approved turn in a text-only mode
  let argv = plain ? applySettings(a.json.approveArgv(text, ctx), row.agent, db.hubSettings(), db.sessionEnv(row), { resume: turn > 1 })
    : [...applySettings(a.json.argv(text, ctx), row.agent, db.hubSettings(), db.sessionEnv(row), { resume: turn > 1 }), ...(approve ? a.json.approve || [] : [])];
  /* A worker adds OMP's endpoint itself (remote-chat); here the hub does. */
  if (!away) {
    try { argv = ompEndpoint(row, argv, db.sessionEnv(row)); }
    catch (err) { running.delete(sessionId); db.addEvent(sessionId, turn, 'error', { text: err.message }); db.updateSession(sessionId, { status: 'idle' }); return; }
  }
  const bin = findBin(argv[0]) || argv[0];
  /* .exe runs directly, args never touch a shell. A .cmd/.bat shim needs cmd, so only an agent
     that takes the prompt on stdin may use one: the command line then holds no user text. */
  const shim = /\.(cmd|bat)$/i.test(bin);
  if (!away && shim && !a.json.stdin) { running.delete(sessionId); db.addEvent(sessionId, turn, 'error', { text: `${bin} is a script shim; this agent needs its prompt on the command line, so it runs as a terminal session` }); db.updateSession(sessionId, { status: 'idle' }); return; }
  const cwd = row.cwd && existsSync(row.cwd) ? row.cwd : process.cwd();
  let proc;
  try {
    proc = away ? remote.spawn(row, argv, { ...db.hubSettings().env, ...db.sessionEnv(row) }, { setup: !!row.branch && turn === 1 })
      : spawn(bin, argv.slice(1), { cwd, env: { ...process.env, ...sessionEnv(row) }, windowsHide: true, shell: shim, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (err) { running.delete(sessionId); db.addEvent(sessionId, turn, 'error', { text: String(err.message || err) }); db.updateSession(sessionId, { status: 'idle' }); return; }
  running.set(sessionId, proc);
  const started = Date.now();
  if (!away && proc.pid) turnPids.set(sessionId, [...turnRoots(sessionId), { pid: proc.pid, at: started }].slice(-30));
  proc.stdin.end(a.json.stdin ? text : '');
  evlog('info', row.ws, `${sessionId} turn ${turn} · ${row.agent}`);

  /* Streamed text and thinking grow one event each; tool results attach to their call. */
  let last = null;          // { id, kind, data } of the event deltas append to
  const tools = new Map();  // tool call id -> event id
  let done = false, buf = '', errTail = '', lastText = '';   // lastText: the end of the agent's own text, where a limit notice lands
  const used = { input: 0, output: 0, cache_read: 0, context: null, calls: 0 };   // summed usage events
  const blocked = [];       // tool calls its policy stopped, for one approval card
  const apply = (e) => {
    if (e.kind === 'text' || e.kind === 'thinking') {
      if (!e.delta) return;
      if (e.kind === 'text') lastText = (lastText + e.delta).slice(-500);
      if (last && last.kind === e.kind) { last.data.text += e.delta; db.updateEvent(last.id, last.data); return; }
      const data = { text: e.delta.replace(/^\s+/, '') };
      last = { id: db.addEvent(sessionId, turn, e.kind, data), kind: e.kind, data };
      return;
    }
    last = null;
    if (e.kind === 'resume') { if (e.id && e.id !== row.agent_session) db.updateSession(sessionId, { agent_session: e.id }); return; }
    if (e.kind === 'tool') { tools.set(e.id, db.addEvent(sessionId, turn, 'tool', { name: e.name, input: e.input ?? null, ...(e.parent && tools.has(e.parent) ? { parent: tools.get(e.parent) } : {}) })); return; }
    if (e.kind === 'tool_result') {
      const out = { output: String(e.output ?? '').slice(0, OUT_MAX), error: !!e.error, end: Date.now() };
      if (e.error && NEEDS_APPROVAL.test(out.output)) out.needsApproval = true;
      const at = tools.get(e.id);
      if (at) {
        const cur = db.listEvents(sessionId, 0).find((x) => x.id === at);
        db.updateEvent(at, { ...(cur ? cur.data : {}), ...out });
        if (out.needsApproval && cur) blocked.push({ name: cur.data.name, input: cur.data.input });
      }
      else db.addEvent(sessionId, turn, 'tool', { name: 'tool', input: null, ...out });
      return;
    }
    if (e.kind === 'model') { const m = !away && e.provider ? `${e.model} · ${e.provider}` : e.model; if (m !== row.model) { row.model = m; db.updateSession(sessionId, { model: m }); } return; }
    if (e.kind === 'usage') { used.calls++; used.input += e.input; used.output += e.output; used.cache_read += e.cache_read; used.context = e.context; return; }
    if (e.kind === 'done') {
      /* One shape for every agent: totals for the turn, and the context size when it is known. */
      const t = e.tokens;
      const tokens = t ? { input: t.input ?? t.input_tokens ?? 0, output: t.output ?? t.output_tokens ?? 0, cache_read: t.cache_read ?? t.cacheRead ?? t.cache_read_input_tokens ?? 0, context: null }
        : used.calls ? { input: used.input, output: used.output, cache_read: used.cache_read, context: used.context } : null;
      done = true;
      db.addEvent(sessionId, turn, 'done', { tokens, ms: e.ms || (Date.now() - started), error: e.error || '' });
      if (e.error) { const h = detectLimit(String(e.error)); if (h) ptyEvents.emit('limit', sessionId, { ...h, text: String(e.error).slice(0, 200) }); }
    }
  };
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (d) => {
    if (!db.getSession(sessionId)) return;
    if (away) { db.appendLog(sessionId, d); ptyEvents.emit('chat-output', sessionId, d); }
    if (plain) { apply({ kind: 'text', delta: d }); return; }
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith('{')) { const s = statusLines(line); if (s.length) addStatus(sessionId, turn, s); continue; }
      try { for (const e of a.json.parse(JSON.parse(line))) apply(e); } catch { /* not a JSON event line */ }
    }
  });
  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', (d) => { errTail = (errTail + d).slice(-2000); const s = statusLines(d); if (s.length && db.getSession(sessionId)) addStatus(sessionId, turn, s); });
  const finish = (code) => {
    if (running.get(sessionId) !== proc) return;
    if (!db.getSession(sessionId)) { running.delete(sessionId); return; }
    if (buf.trim().startsWith('{')) { try { for (const e of a.json.parse(JSON.parse(buf))) apply(e); } catch {} buf = ''; }
    running.delete(sessionId);
    const failText = errTail + (done ? '' : ' ' + lastText);
    const hit = code !== 0 || !done ? detectLimit(failText) : null;
    if (hit) ptyEvents.emit('limit', sessionId, { ...hit, text: failText.trim().slice(-200) });
    if (!done) db.addEvent(sessionId, turn, code === 0 ? 'done' : 'error', code === 0 ? {} : { text: (errTail.trim().split('\n').slice(-6).join('\n') || `exited ${code}`) });
    /* Something was stopped for approval: ask, and the session waits for me. */
    if (blocked.length) {
      db.addEvent(sessionId, turn, 'approval', { tools: blocked, state: 'pending' });
      db.updateSession(sessionId, { status: 'waiting', pid: null });
      /* The session's approval mode answers for me: auto approves (once: an approved turn that
         blocks again asks), read-only denies. Ask leaves the card to me. */
      const mode = db.getSession(sessionId)?.approval || 'ask';
      if ((mode === 'auto' && !approve) || (mode === 'read' && !/^Denied\b/.test(text))) {   // once each way: a turn answering an automatic answer that blocks again asks me
        setImmediate(() => answer(sessionId, mode === 'auto', { auto: true }).catch((err) => evlog('warn', row.ws, `${sessionId} auto ${mode === 'auto' ? 'approve' : 'deny'} · ${err.message}`)));
        return;
      }
      ptyEvents.emit('waiting', sessionId);
      return;
    }
    db.updateSession(sessionId, { status: db.getSession(sessionId)?.status === 'hibernated' ? 'hibernated' : 'idle', pid: null });   // a forced hibernate killed this turn
    ptyEvents.emit('turn', sessionId, code);
  };
  proc.on('error', (err) => { errTail += String(err.message || err); finish(-1); });
  proc.on('close', (code) => finish(code ?? -1));
}

/* My answer to an approval card, sent as the next turn. Approve runs that one turn with the
   agent's own skip-approval flag; deny tells it not to. */
export function approve(sessionId, yes) { return answer(sessionId, yes); }
/* by: auto (the session's approval mode) or timeout (nobody answered an unattended run in time). */
function answer(sessionId, yes, { auto = false, timeout = false } = {}) {
  const ev = db.listEvents(sessionId, 0).filter((e) => e.kind === 'approval' && e.data.state === 'pending').pop();
  if (!ev) return Promise.reject(new Error('nothing is waiting for approval'));
  const what = ev.data.tools.map((t) => `${t.name}: ${typeof t.input === 'string' ? t.input : (t.input && (t.input.command || t.input.path)) || JSON.stringify(t.input)}`).join('; ');
  db.updateEvent(ev.id, { ...ev.data, state: yes ? 'approved' : 'denied', ...(auto ? { auto } : {}), ...(timeout ? { timeout } : {}) });
  return send(sessionId, yes ? `Approved. Run what was blocked now: ${what}`
    : `Denied${timeout ? ' (nobody answered in time)' : auto ? ' (this session is read-only)' : ''}. Do not run: ${what}. Find another way, or tell me why it is needed.`, { approve: yes, from: auto || timeout ? 'auto' : '' });
}
/* An unattended run (team, pipeline) whose card nobody answered: denied, so the run moves on. */
export const timeOut = (sessionId) => answer(sessionId, false, { timeout: true });

export function stop(sessionId) {
  /* A turn in the TUI: Esc is how these TUIs stop the current turn. */
  if (tuiTurn.has(sessionId) && isTui(sessionId)) { ptyWrite(sessionId, '\x1b'); tuiTurn.delete(sessionId); return true; }
  const p = running.get(sessionId);
  if (!p) return false;
  try { p.kill(); } catch { /* already gone */ }
  return true;
}
