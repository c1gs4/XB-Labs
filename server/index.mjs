// XBLabs server: static app + REST for jobs/sessions + one PTY per run over WS.
import { createServer } from 'node:http';
import { createServer as netServer, connect as netConnect } from 'node:net';
import { execFileSync, spawn as spawnChild } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { existsSync, mkdirSync, readFileSync, readdirSync, statfsSync, writeFileSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { cpus, freemem, totalmem, platform, release, arch, hostname, uptime, homedir } from 'node:os';
import * as db from './db.mjs';
import * as pty from './pty.mjs';
import * as tailscale from './tailscale.mjs';
import * as evlog from './log.mjs';
import * as worktree from './worktree.mjs';
import * as ports from './ports.mjs';
import { AGENTS, applySettings, detectCached, enabled, listDirs, configuredModel, registerCustom } from './agents.mjs';
import * as goa from './goa.mjs';
import * as install from './install.mjs';
import * as browser from './browser.mjs';
import { resolveInside, mentionedMedia } from './files.mjs';
import { createReadStream } from 'node:fs';
import * as chat from './chat.mjs';
import * as pipeline from './pipeline.mjs';
import * as team from './team.mjs';
import { lastAsk } from '../app/js/choices.mjs';
import * as automations from './automations.mjs';
import * as slashCommands from './commands.mjs';
import { remoteChat } from './remote-chat.mjs';
import * as decide from './decide.mjs';
import { idleToHibernate, limitError } from './hibernate.mjs';
import { pickConfig, sharesConversation, publicConfig } from './accounts.mjs';

const PORT = Number(process.env.PORT || 5200);
registerCustom(db.hubSettings().custom);   // Settings → Agents → Custom: any terminal program
const ROOT = fileURLToPath(new URL('../app', import.meta.url));   // next to server/, whatever the cwd (the desktop build starts the hub from the user's home)

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.webp': 'image/webp', '.map': 'application/json',
};

/* Used share of the system drive, or null where statfs is not available. */
function diskPct() {
  try { const s = statfsSync(platform() === 'win32' ? (process.env.SystemDrive || 'C:') + '\\' : '/'); return s.blocks ? Math.round((1 - s.bavail / s.blocks) * 100) : null; } catch { return null; }
}
/* Windows has no loadavg; sample the per-core tick counters instead. */
let prevCpu = null;
function cpuPct() {
  const now = cpus().map((c) => c.times);
  if (!prevCpu) { prevCpu = now; return 0; }
  let idle = 0, total = 0;
  now.forEach((t, i) => {
    const p = prevCpu[i] || { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 };
    const dIdle = t.idle - p.idle;
    const dTotal = (t.user + t.nice + t.sys + t.idle + t.irq) - (p.user + p.nice + p.sys + p.idle + p.irq);
    idle += dIdle; total += dTotal;
  });
  prevCpu = now;
  return total > 0 ? Math.min(100, Math.max(0, Math.round((1 - idle / total) * 100))) : 0;
}

const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};
const readBody = (req, max = 1e6) => new Promise((ok, bad) => {
  let b = '';
  req.on('data', (c) => { b += c; if (b.length > max) bad(new Error('body too large')); });
  req.on('end', () => { try { ok(b ? JSON.parse(b) : {}); } catch (e) { bad(e); } });
  req.on('error', bad);
});

// Trust boundary: never serve outside ROOT.
async function serveStatic(req, res, pathname) {
  const rel = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '');
  const file = resolve(join(ROOT, rel || 'index.html'));
  if (!file.startsWith(ROOT)) return json(res, 403, { error: 'forbidden' });
  let target = file;
  try { if ((await stat(target)).isDirectory()) target = join(target, 'index.html'); } catch {
    return json(res, 404, { error: 'not found', path: rel });
  }
  try {
    const buf = await readFile(target);
    res.writeHead(200, {
      'content-type': MIME[extname(target).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-store, must-revalidate',
    });
    res.end(buf);
  } catch { json(res, 404, { error: 'not found' }); }
}

/* ---- agents: machines that dialed in. A run is local unless its device is in here. ---- */
const agents = new Map(); // name -> { ws, meta, cpu, ram, since }
const sendTo = (name, msg) => {
  const a = agents.get(name);
  if (!a || a.ws.readyState !== 1) return false;
  a.ws.send(JSON.stringify(msg));
  return true;
};
const remoteTurns = remoteChat(sendTo, name => agents.get(name)?.meta?.chatProtocol === 1);
chat.setRemote(remoteTurns);
/* Ask an agent something and wait for its answer (matched by req), e.g. a folder listing. */
const asks = new Map();
let askSeq = 0;
/* The hub's checkout of a remote session's project, where Bring to hub puts its branch: the one
   I picked before for this project, else this hub's own folder for it when that is a Git checkout. */
function hubRepoFor(s) {
  const picked = db.getSetting(`hubRepo.${s.ws}`);
  if (picked) return picked;
  const mine = db.listProjects().filter((f) => f.ws === s.ws && f.device === 'local').map((f) => f.cwd).sort((a, b) => a.length - b.length);
  return mine.find((c) => existsSync(join(c, '.git'))) || '';
}
async function bringToHub(s, repo, merge) {
  const to = String(repo || hubRepoFor(s) || '').trim();
  if (!to) return [409, { error: 'pick the folder on this hub that holds this project', needRepo: true }];
  /* An empty folder gets the whole project; a checkout gets only the branch's own commits. */
  const b = await askAgent(s.device, { type: 'git', cwd: s.cwd, action: 'bundle', full: worktree.isFreshFolder(to) }, 120000);
  if (b.error) return [409, { error: b.error }];
  const r = worktree.takeBundle(to, b, { merge });
  if (!r.error) db.setSetting(`hubRepo.${s.ws}`, r.top || to);
  evlog.log(r.error ? 'warn' : 'info', s.ws, `${s.id} branch from ${s.device} · ${r.error || r.said}`);
  return [r.error ? 409 : 200, r];
}
function askAgent(name, msg, ms = 8000) {
  return new Promise((done) => {
    const req = ++askSeq;
    const timer = setTimeout(() => { asks.delete(req); done({ error: `${name} did not answer` }); }, ms);
    asks.set(req, (m) => { clearTimeout(timer); asks.delete(req); done(m); });
    if (!sendTo(name, { ...msg, req })) { clearTimeout(timer); asks.delete(req); done({ error: `no XBLabs agent on ${name}: type the folder path` }); }
  });
}

async function readRemoteHistory(row, since) {
  const r = await askAgent(row.device, { type: 'chat-history', id: row.id, agent: row.agent, cwd: row.cwd, agent_session: row.agent_session, since });
  if (r.error) throw new Error(r.error);
  if (r.agent_session && !row.agent_session) db.updateSession(row.id, { agent_session: r.agent_session });
  return Object.assign(r.items || [], { tokens: r.tokens });
}
chat.setRemoteHistory(readRemoteHistory);
const AGENT_BUILD = install.agentBuild();
try { worktree.setRoots(db.getSetting('storage.worktrees'), JSON.parse(db.getSetting('storage.pastWorktrees') || '[]')); } catch { /* defaults */ }
const openingTui = new Map();
chat.setTuiOpening(id => openingTui.get(id));
function openSessionTui(id) {
  if (openingTui.has(id)) return openingTui.get(id);
  const opening = (async () => {
    const row = db.getSession(id);
    if (pty.isTui(id)) return;
    if (chat.busy(id)) throw new Error('Agent is answering in Chat; wait before opening Terminal');
    const a = AGENTS[row.agent]?.json;
    if (!a?.tui) throw new Error('Native terminal unavailable for this agent');
    if ((row.device || 'local') === 'local') {
      if (!pty.ensure(id)) throw new Error('Could not start native terminal');
      return;
    }
    if (agents.get(row.device)?.meta?.tuiProtocol !== 1) throw new Error(`${row.device}: update XBLabs worker for native Terminal`);
    const history = await readRemoteHistory(row, Date.now());
    if (chat.busy(id)) throw new Error('Agent is answering in Chat; wait before opening Terminal');
    const current = db.getSession(id);
    if (!current) throw new Error('Session no longer exists');
    const newId = randomUUID();
    const env = { ...db.hubSettings().env, ...pty.runEnv(current), XBLABS_SESSION: id,
      XBLABS_HUB: `http://${tsListenIp || '127.0.0.1'}:${PORT}` };
    const argv = applySettings(a.tui({ sid: id, resume: current.agent_session, newId }), row.agent, db.hubSettings(), env, { resume: db.lastTurn(id) > 0 });
    if (argv.includes(newId)) db.updateSession(id, { agent_session: newId });
    if (row.agent === 'omp' && env.LLM_BASE_URL) {
      if (!/^https?:$/.test(new URL(env.LLM_BASE_URL).protocol) || !env.LLM_MODEL?.trim()) throw new Error('OMP shared endpoint requires HTTP(S) URL and model');
      argv.push('--extension', 'xblabs:omp', '--model', `xblabs/${env.LLM_MODEL}`);
    }
    pty.attachRemote(id, m => sendTo(row.device, m), true, history.length);
    const result = await askAgent(row.device, { type: 'spawn', id, cwd: row.cwd, env, argv, isolate: false });
    if (result.error) { pty.finish(id, 1); throw new Error(result.error); }
  })().finally(() => openingTui.delete(id));
  openingTui.set(id, opening);
  return opening;
}

/* ---------- job run summary ----------
   What a run did, as facts plus its meaningful output lines (no ANSI, no shell banner, no bare
   prompts). With an LLM endpoint saved, a finished run also gets a short written summary; it is
   cached per run and output length, so reopening the dialog does not call the model again. */
const ANSI = /\x1b\][^\x07]*(\x07|\x1b\\)|\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b[=>()][0-9A-Za-z]?/g;
const NOISE = [/^Microsoft Windows \[Version/, /^\(c\) Microsoft Corporation/, /^[A-Za-z]:\\[^>]*>$/, /^PS [^>]*>$/, /^[\w@.-]+:[^$#]*[$#]$/];
const summaries = new Map(); // id -> { len, text }
async function runSummary(s) {
  const log = db.readLog(s.id);
  /* Replay backspaces like a terminal would: "jsdf\b \b…" is text the user typed and erased. */
  const typed = (l) => { const a = []; let c = 0; for (const ch of l) { if (ch === '\b') c = Math.max(0, c - 1); else a[c++] = ch; } return a.join(''); };
  const lines = log.replace(ANSI, '').split(/\r?\n|\r/).map((l) => typed(l).trimEnd()).filter((l) => l.trim() && !NOISE.some((re) => re.test(l.trim())));
  const live = pty.isLive(s.id);
  const out = {
    status: s.status, live, device: s.device, agent: s.agent, cwd: s.cwd, branch: s.branch || '', prompt: s.prompt,
    started: s.created_at, ended: live ? null : s.updated_at, bytes: Buffer.byteLength(log),
    lineCount: lines.length, tail: lines.slice(-8), text: null, textError: null,
  };
  const llm = db.llmSettings();
  if (live || !lines.length || !llm.base_url || !llm.model) return out;
  const hit = summaries.get(s.id);
  if (hit && hit.len === log.length) { out.text = hit.text; return out; }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const headers = { 'content-type': 'application/json', ...(llm.has_key ? { authorization: `Bearer ${db.getSetting('llm.api_key')}` } : {}) };
    const r = await fetch(`${llm.base_url}/chat/completions`, {
      method: 'POST', headers, signal: ctrl.signal,
      body: JSON.stringify({
        model: llm.model, max_tokens: 220, temperature: 0.2,
        messages: [
          { role: 'system', content: 'Summarise an agent run for the person who dispatched it. Two to four plain sentences: what it did, how it ended, and anything that needs their attention. Use only what the output shows. No markdown, no preamble.' },
          { role: 'user', content: `Task: ${s.prompt || '(none)'}\nAgent: ${s.agent} on ${s.device} in ${s.cwd}\nStatus: ${s.status}\n\nOutput (last part):\n${lines.join('\n').slice(-6000)}` },
        ],
      }),
    });
    const j = await r.json().catch(() => ({}));
    const text = j.choices?.[0]?.message?.content?.trim();
    if (!r.ok || !text) throw new Error(j.error?.message || `HTTP ${r.status}`);
    summaries.set(s.id, { len: log.length, text });
    out.text = text;
  } catch (err) {
    out.textError = String(err.name === 'AbortError' ? 'timed out' : err.message || err);
    evlog.log('warn', 'llm', `run summary ${s.id} · ${out.textError}`);
  } finally { clearTimeout(timer); }
  return out;
}

/* What Settings → Models shows: the endpoint, the env names it sets, and which agents get it. */
/* Agents worth listing in Settings: installed here or on a connected device, custom ones, and any
   already switched to the endpoint. The registry has ~45; listing them all would bury these. */
async function knownAgentIds() {
  const ids = new Set((await detectCached()).map((a) => a.id));
  for (const [, a] of agents) for (const x of (a.meta && Array.isArray(a.meta.agents) ? a.meta.agents : [])) if (x && x.id) ids.add(x.id);
  for (const [id, a] of Object.entries(AGENTS)) if (a.custom) ids.add(id);
  db.llmAgents().forEach((x) => ids.add(x));
  return [...ids].filter((id) => Object.hasOwn(AGENTS, id)).concat('shell');
}
const llmOut = async () => ({ ...db.llmSettings(), env_names: Object.keys(db.llmEnv()), agents: db.llmAgents(), agent_ids: await knownAgentIds() });

/* Other local sessions in the same repo that changed a file this one changed too.
   ponytail: same file, not same lines; that is enough to look before merging. */
function overlapFor(s) {
  let mine;
  try { mine = worktree.changedFiles(s.cwd); } catch { return []; }
  if (!mine.files.size) return [];
  const out = [];
  for (const o of db.listSessions({ limit: 500 })) {
    if (o.id === s.id || !o.branch || o.device !== 'local' || o.ssh || !existsSync(o.cwd)) continue;
    try {
      const theirs = worktree.changedFiles(o.cwd);
      const files = theirs.top === mine.top ? [...theirs.files].filter((f) => mine.files.has(f)) : [];
      if (files.length) out.push({ id: o.id, title: o.title, branch: o.branch, files });
    } catch { /* worktree gone */ }
  }
  return out;
}

/* Local session into its own worktree + branch; a folder that is not a repo stays as it is. */
function isolateSession(s) {
  const w = worktree.isolate(s.cwd, s.id);
  if (w?.error) evlog.log('warn', s.ws, `${s.id} no worktree (${w.error}) · runs in ${s.cwd}`);
  else if (w) {
    db.updateSession(s.id, { cwd: w.cwd, branch: w.branch, origin: s.cwd });
    evlog.log('info', s.ws, `${s.id} on branch ${w.branch}${w.copied.length ? ` · copied ${w.copied.join(', ')}` : ''}`);
  }
}

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;   // one place to bump

/* Phone push: POST the text to the URL in Settings → Notifications (ntfy and alike).
   Only for agent work (jobs and chats), never for plain shells. */
async function notify(text, { force = false } = {}) {
  const url = db.hubSettings().notify.push;
  if (!url) return force ? { error: 'no push URL saved' } : {};
  try {
    const r = await fetch(url, { method: 'POST', body: text, headers: { Title: 'XBLabs' }, signal: AbortSignal.timeout(5000) });
    return r.ok ? { ok: true } : { error: `HTTP ${r.status}` };
  } catch (err) { return { error: String(err.message || err) }; }
}
const worth = (s) => s && s.kind !== 'shell';
pty.events.on('waiting', (id) => { const s = db.getSession(id); if (worth(s)) notify(`${s.title}: asking for input (${s.agent})`); });
pty.events.on('turn', (id, code) => { const s = db.getSession(id); if (worth(s)) notify(`${s.title}: ${code === 0 ? 'answered' : `turn failed (exit ${code})`}`); });
/* Pipeline: the next stage is a new session in the same worktree, after the previous stage's turn. */
async function startStage(prev, prompt) {
  const title = `${String(prev.title).replace(/ · \d+\/\d+ .*$/, '')} · ${prev.step + 1}/${prev.total} ${prev.name}`;
  const s = db.createSession({ ws: prev.ws, title, prompt, cwd: prev.cwd, device: 'local', agent: prev.agent, kind: 'chat', parent: prev.id });
  db.updateSession(s.id, { status: 'idle', mode: 'json', approval: prev.approval || null });
  await chat.send(s.id, prompt);
  /* Branch only after its first turn started: the worktree is set up already, its setup script must not run again. */
  if (prev.branch) db.updateSession(s.id, { branch: prev.branch, origin: prev.origin });
  return s.id;
}
pty.events.on('turn', (id, code) => {
  pipeline.onTurn(id, code, startStage).then((r) => {
    if (!r) return;
    const s = db.getSession(id);
    if (r.state === 'next') evlog.log('info', s.ws, `${id} pipeline → ${r.id}`);
    else { evlog.log(r.state === 'done' ? 'info' : 'warn', s.ws, `${id} pipeline ${r.state}${r.stage ? ` at ${r.stage}` : ''}${r.error ? ` · ${r.error}` : ''}`); notify(`${s.title}: pipeline ${r.state}`); }
  }).catch((err) => evlog.log('warn', 'xblabs-web', `pipeline · ${err.message}`));
});
/* Unattended runs (a team, a pipeline) do not wait forever on an approval nobody sees: after
   APPROVAL_WAIT the card is denied and the agent is told to find another way. */
const APPROVAL_WAIT = 10 * 60e3;
setInterval(() => {
  /* A bubble chat left 'running' with no turn and no terminal (closed before this fix, or a hub restart). */
  for (const s of db.listSessions({ status: 'running', limit: 500 })) if (s.mode === 'json' && !chat.busy(s.id) && !pty.isLive(s.id)) db.updateSession(s.id, { status: 'idle', pid: null });
  for (const s of db.listSessions({ status: 'waiting', limit: 500 })) {
    const card = db.recentEvents(s.id, 6).filter((e) => e.kind === 'approval' && e.data.state === 'pending').pop();
    /* A bubble chat marked waiting with no open card was answered some other way: it is not waiting. */
    if (!card && s.mode === 'json' && !pty.tuiAsk(s.id)) { db.updateSession(s.id, { status: pty.isLive(s.id) ? 'running' : 'idle' }); continue; }
    if (!team.get(s.id) && !pipeline.get(s.id)) continue;
    if (!card || Date.now() - card.at < APPROVAL_WAIT) continue;
    chat.timeOut(s.id).then(() => evlog.log('warn', s.ws, `${s.id} approval not answered in ${APPROVAL_WAIT / 60e3} min · denied so the run goes on`))
      .catch((err) => evlog.log('warn', s.ws, `${s.id} approval timeout · ${err.message}`));
  }
}, 30e3);
/* A teammate: a child session of the lead in the lead's folder, its task as the first message. */
async function startTeammate(lead, task, prompt) {
  const s = db.createSession({ ws: lead.ws, title: `${lead.title} · ${task.id} ${task.owner}`, prompt, cwd: lead.cwd, device: 'local', agent: team.get(lead.id)?.agent || lead.agent, kind: 'chat', parent: lead.id });
  db.updateSession(s.id, { status: 'idle', mode: 'json', approval: lead.approval || null });   // teammates answer approvals as their lead does
  await chat.send(s.id, prompt);
  if (lead.branch) db.updateSession(s.id, { branch: lead.branch, origin: lead.origin });   // after its first turn started, as a pipeline stage
  return s.id;
}
pty.events.on('turn', (id, code) => {
  team.onTurn(id, code, { start: startTeammate, send: (lead, text, o) => chat.send(lead, text, o) }).then((r) => {
    if (!r) return;
    const s = db.getSession(id);
    if (r.state === 'working') evlog.log('info', s.ws, `${id} team planned · ${r.tasks} teammate(s) started`);
    else if (r.state === 'task') evlog.log(r.status === 'done' ? 'info' : 'warn', s.ws, `${id} team task ${r.task} ${r.status}`);
    else {
      evlog.log(r.state === 'failed' ? 'warn' : 'info', s.ws, `${id} team ${r.state}${r.error ? ` · ${r.error}` : ''}`);
      /* Done: the lead's own report, first line, is what reaches me. */
      const said = r.state === 'done' ? (db.recentEvents(id, 12).filter((e) => e.kind === 'text').pop()?.data.text || '').split('\n').find((l) => l.trim()) || '' : '';
      notify(`${s.title}: team ${r.state === 'review' ? 'finished, lead reviewing' : r.state}${said ? ` · ${said.replace(/[*#`]/g, '').slice(0, 140)}` : ''}`);
    }
  }).catch((err) => evlog.log('warn', 'xblabs-web', `team · ${err.message}`));
});
/* Automations start through this hub's own session API, so a run is exactly a New session with
   its own worktree and branch (a folder without Git is refused, nothing runs in the project itself). */
const canRunUnattended = (a) => Object.hasOwn(AGENTS, a) && !!AGENTS[a].json;
async function runAutomation(a) {
  const d = new Date(), ad = server.address();
  const host = !ad.address || ad.address === '0.0.0.0' || ad.address === '::' ? '127.0.0.1' : ad.address.includes(':') ? `[${ad.address}]` : ad.address;
  const r = await fetch(`http://${host}:${ad.port}/api/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: `${a.name} · ${d.toLocaleDateString('en-CA')} ${d.toTimeString().slice(0, 5)}`, prompt: a.prompt, ws: a.ws, cwd: a.cwd, agent: a.agent, kind: 'chat', isolate: true, requireIsolation: true, device: 'local' }) });
  const j = await r.json();
  evlog.log(j.error ? 'warn' : 'info', a.ws, `automation ${a.name} · ${j.error || `started ${j.id}`}`);
  if (j.error) notify(`Automation ${a.name}: not started · ${j.error}`);
  return j.error ? { error: j.error } : { id: j.id };
}
setInterval(() => { automations.tick(new Date(), runAutomation).catch((err) => evlog.log('warn', 'xblabs-web', `automations · ${err.message}`)); }, 15000).unref();
pty.events.on('exit', (id, code) => { const s = db.getSession(id); if (worth(s) && s.status !== 'stopped') notify(`${s.title}: ${code === 0 ? 'finished' : `failed (exit ${code})`}`); });

/* The saved endpoint's model list, fetched at most every 10 minutes. */
let modelsCache = { at: 0, list: [] };
async function endpointModels() {
  if (Date.now() - modelsCache.at < 600000) return modelsCache.list;
  const base = db.getSetting('llm.base_url'), key = db.getSetting('llm.api_key');
  if (!base) return [];
  try {
    const r = await fetch(`${base}/models`, { headers: key ? { authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(8000) });
    const j = await r.json();
    modelsCache = { at: Date.now(), list: Array.isArray(j.data) ? j.data.filter((m) => m && typeof m.id === 'string') : [] };
  } catch { modelsCache = { at: Date.now() - 540000, list: modelsCache.list }; }   // retry in a minute
  return modelsCache.list;
}

/* Hosts added by hand in Settings → Devices: reached over ssh from the hub, no Tailscale or agent.
   Host and user go into ssh's argv, so neither may start with '-' (it would read as an option). */
const HOST_RE = /^[A-Za-z0-9][\w.-]{0,252}$/, USER_RE = /^[A-Za-z0-9_][\w.-]{0,63}$/;
function manualHosts() {
  try { const a = JSON.parse(db.getSetting('devices.manual') || '[]'); return Array.isArray(a) ? a.filter((h) => h && HOST_RE.test(h.host || '') && HOST_RE.test(h.name || '')) : []; } catch { return []; }
}
const probeCache = new Map();   // "host:port" -> { at, up }
function probe(host, port) {
  const k = `${host}:${port}`, c = probeCache.get(k);
  if (c && Date.now() - c.at < 20000) return Promise.resolve(c.up);
  return new Promise((done) => {
    const sock = netConnect({ host, port, timeout: 1500 });
    const end = (up) => { sock.destroy(); probeCache.set(k, { at: Date.now(), up }); done(up); };
    sock.once('connect', () => end(true)).once('timeout', () => end(false)).once('error', () => end(false));
  });
}

/* Connect a device from the hub: ssh in and run the one-line installer (server/install.mjs).
   The agent it installs dials back on its own; this only drives the install and keeps its output.
   BatchMode: never a password prompt. Tailscale SSH in check mode prints an approval link
   instead, which the UI offers as a button. */
const KEY_RE = /^[\w.-]{1,64}$/;
/* { host: 'name-or-ip[:port]', user, name, key } from the client, checked; or { error }. */
function parseHost(b) {
  const raw = String(b.host || '').trim(), user = String(b.user || '').trim(), key = String(b.key || '').trim();
  const [host, portS] = raw.split(':'), port = portS ? Number(portS) : Number(b.port) || 22;
  const name = String(b.name || host || '').trim().slice(0, 40);
  if (!HOST_RE.test(host || '') || raw.split(':').length > 2) return { error: 'host must be a hostname or IPv4 address, optionally :port' };
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { error: 'port must be 1–65535' };
  if (user && !USER_RE.test(user)) return { error: 'user may hold letters, digits, . _ - only' };
  if (!HOST_RE.test(name) || name.toLowerCase() === 'local') return { error: 'pick another name' };
  if (key && !sshKeys().includes(key)) return { error: 'that key is not in ~/.ssh on the hub' };
  return { name, host, port, user, key };
}
function sshKeys() {
  const d = join(homedir(), '.ssh');
  try { return readdirSync(d).filter((f) => KEY_RE.test(f) && !f.endsWith('.pub') && existsSync(join(d, `${f}.pub`))); } catch { return []; }
}
/* The server's identification line, sent before any auth: "SSH-2.0-Tailscale", "SSH-2.0-OpenSSH_for_Windows_9.5", … */
function sshBanner(host, port = 22) {
  return new Promise((done) => {
    let buf = '';
    const sock = netConnect({ host, port, timeout: 3000 });
    const end = (v) => { sock.destroy(); done(v); };
    sock.on('data', (d) => { buf += d; if (buf.includes('\n')) end(buf.split(/\r?\n/)[0].slice(0, 120)); });
    sock.once('timeout', () => end(buf ? buf.slice(0, 120) : null)).once('error', () => end(null));
  });
}
const sshKind = (b) => (!b ? 'none' : /tailscale/i.test(b) ? 'tailscale' : /windows/i.test(b) ? 'windows' : 'openssh');
const connects = new Map();   // id -> { name, lines, state, url, code, at }
function startConnect({ name, host, port, user, key, kind, hub }) {
  const id = `con_${randomUUID().slice(0, 8)}`;
  const job = { name, lines: [], state: 'running', url: '', code: null, at: Date.now() };
  connects.set(id, job);
  for (const [k, j] of connects) if (Date.now() - j.at > 3600000) connects.delete(k);
  /* Names and hosts are checked against a strict charset, so plain quoting is enough here. */
  const token = !tsListenIp && process.env.XBLABS_TOKEN ? process.env.XBLABS_TOKEN.replace(/[^\w.-]/g, '') : '';
  const remote = kind === 'windows'
    ? `powershell -NoProfile -ExecutionPolicy Bypass -Command "$env:XBLABS_NAME='${name}';${token ? ` $env:XBLABS_TOKEN='${token}';` : ''} irm http://${hub}/install.ps1 | iex"`
    : `U=http://${hub}/install.sh; (curl -fsSL $U || wget -qO- $U) | XBLABS_NAME=${name}${token ? ` XBLABS_TOKEN=${token}` : ''} sh`;
  const p = spawnChild(pty.SSH_BIN, ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=10',
    /* No key picked: offer every key in ~/.ssh, and -v tells which one the server took. */
    '-v', '-p', String(port), ...(key ? pty.sshKeyArgs(key) : sshKeys().flatMap((k) => ['-i', join(homedir(), '.ssh', k)])),
    `${user}@${host}`, remote], { windowsHide: true });
  const add = (d) => {
    for (const l of String(d).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').split(/\r?\n/)) {
      const ok = l.match(/Server accepts key: (.+?) (?:RSA|ED25519|ECDSA|DSA)\b/i);
      if (ok) { const k = ok[1].split(/[\\/]/).pop(); if (sshKeys().includes(k)) job.key = k; }
      if (l.trim() && !/^(debug\d|OpenSSH_)/.test(l)) job.lines.push(l.slice(0, 400));
    }
    if (job.lines.length > 400) job.lines.splice(0, job.lines.length - 400);
    const m = job.lines.join('\n').match(/https:\/\/login\.tailscale\.com\/[\w\/-]+/);
    if (m) job.url = m[0];
  };
  p.stdout.on('data', add); p.stderr.on('data', add);
  const kill = setTimeout(() => { add('[xblabs] gave up after 10 minutes'); p.kill(); }, 600000);
  p.on('error', (err) => { add(`[xblabs] ${err.message}`); });
  p.on('close', (code) => {
    clearTimeout(kill);
    job.code = code; job.state = code === 0 ? 'done' : 'failed';
    evlog.log(code === 0 ? 'info' : 'warn', name, `connect over ssh ${code === 0 ? 'installed the agent' : `failed (exit ${code})`}`);
    /* Keep how to reach it: shells and runs fall back to this ssh login when the agent is down. */
    if (code === 0) {
      const list = manualHosts().filter((h) => h.name.toLowerCase() !== name.toLowerCase());
      const used = key || job.key;
      list.push({ name, host, port, user, ...(used ? { key: used } : {}) });
      db.setSetting('devices.manual', JSON.stringify(list));
    }
  });
  evlog.log('info', name, `connect over ssh · ${user}@${host}:${port} · ${kind}`);
  return id;
}

async function spawnRun(s) {
  const dev = s.device || 'local';
  if (dev === 'local') { if (!pty.ensure(s.id, pty.runEnv(s))) return false; evlog.log('info', dev, `run ${s.id} started in ${s.cwd}`); return true; }

  const first = !db.readLog(s.id);
  if (sendTo(dev, { type: 'spawn', id: s.id, cwd: s.cwd, env: { ...db.hubSettings().env, ...pty.runEnv(s) }, argv: pty.jobArgv(s) || pty.chatArgv(s), isolate: !!s.isolate })) {
    const entry = pty.attachRemote(s.id, (m) => sendTo(dev, m));
    if (first) pty.typeFirst(s, entry);
    evlog.log('info', dev, `run ${s.id} spawned on ${dev} in ${s.cwd}`);
    return true;
  }

  if (s.isolate) {
    const reason = `${dev}: isolation requires an attached XBLabs agent; SSH fallback has no worktree`;
    db.appendLog(s.id, `[xblabs] ${reason}\r\n`);
    db.updateSession(s.id, { status: 'failed', pid: null });
    evlog.log('error', dev, `run ${s.id} cannot start — ${reason}`);
    return false;
  }

  /* Unisolated shells may use SSH; isolated runs must never share the project folder. */
  const man = manualHosts().find((h) => h.name.toLowerCase() === String(dev).toLowerCase());
  if (man) {
    db.updateSession(s.id, { ssh: JSON.stringify({ user: man.user || '', host: man.host, port: man.port || 22, key: man.key || '' }) });
    if (!pty.ensure(s.id, pty.runEnv(s))) return false;
    evlog.log('info', dev, `run ${s.id} ssh ${man.user ? man.user + '@' : ''}${man.host}:${man.port || 22} · manual host`);
    return true;
  }
  const ts = await tailscale.status().catch(() => ({ devices: [] }));
  const host = (ts.devices || []).find((d) => String(d.name).toLowerCase() === String(dev).toLowerCase());
  if (host && host.ip) {
    const user = tailscale.config().ssh_user || process.env.USERNAME || '';
    db.updateSession(s.id, { ssh: JSON.stringify({ user, host: host.ip }) });
    if (!pty.ensure(s.id, pty.runEnv(s))) return false;
    evlog.log('info', dev, `run ${s.id} ssh ${user ? user + '@' : ''}${host.ip} · tailnet, no agent needed`);
    return true;
  }

  db.updateSession(s.id, { status: 'failed', pid: null });
  evlog.log('error', dev, `run ${s.id} cannot start — no agent and not in the tailnet`);
  return false;
}

/* 9router usage, read from its own dashboard API. /api/usage/* sits behind the dashboard login
   (an auth_token cookie), not the LLM API key, so the hub logs in with the saved dashboard
   password and keeps the cookie in memory until 9router rejects it. */
let routerCookie = '';
const httpErr = (msg, status) => Object.assign(new Error(msg), { status });
async function routerFetch(origin, path) {
  const go = () => fetch(origin + path, { headers: routerCookie ? { cookie: routerCookie } : {}, signal: AbortSignal.timeout(8000) });
  let r = await go();
  const password = db.getSetting('router.password');
  if (r.status === 401 && password) {
    const l = await fetch(`${origin}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password }), signal: AbortSignal.timeout(8000),
    });
    const j = await l.json().catch(() => ({}));
    if (!l.ok) throw httpErr(j.error || `9router login HTTP ${l.status}`, l.status);
    const cookie = l.headers.getSetCookie().map((s) => s.split(';')[0]).find((s) => s.startsWith('auth_token='));
    if (!cookie) throw httpErr(j.error || j.message || '9router gave no session; change its default password first', 401);
    routerCookie = cookie;
    r = await go();
  }
  if (r.status === 401) throw httpErr(password ? '9router rejected the saved password' : '9router dashboard password needed', 401);
  if (!r.ok) throw httpErr(`9router HTTP ${r.status}`, r.status);
  return r.json();
}
const ROUTER_PERIODS = ['today', '24h', '7d', '30d', '60d', 'all'];

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;

  try {
    if (p === '/api/health') return json(res, 200, {
      ok: true, port: PORT, pid: process.pid, db: resolve(process.env.XBLABS_DB || join(process.cwd(), 'data', 'xblabs.db')),
      version: VERSION, node: process.version, uptimeS: Math.round(process.uptime()), home: worktree.home(), live: db.listSessions({ limit: 2000 }).filter((s) => pty.isLive(s.id)).length,
    });

    /* Theme, appearance and profile live in the hub too, so a new origin or a cleared browser keeps them.
       ponytail: one shared copy per hub, not per user; real accounts replace this with a user row. */
    if (p === '/api/ui-state' && req.method === 'GET') {
      const get = (k) => { try { return JSON.parse(db.getSetting(k) || 'null'); } catch { return null; } };
      return json(res, 200, { prefs: get('ui.prefs'), profile: get('ui.profile') });
    }
    if (p === '/api/ui-state' && req.method === 'PUT') {
      try {
        const b = await readBody(req, 8e6);   // the glass wallpaper is a data URL
        const obj = (v) => v && typeof v === 'object' && !Array.isArray(v);
        if (obj(b.prefs)) db.setSetting('ui.prefs', JSON.stringify(b.prefs));
        if (obj(b.profile)) db.setSetting('ui.profile', JSON.stringify(b.profile));
        return json(res, 200, { ok: true });
      } catch (err) { return json(res, 400, { error: String(err.message || err) }); }
    }
    /* Settings → Sessions, Agents, Environment, GOA, Notifications: one validated JSON value. */
    if (p === '/api/hub-settings' && req.method === 'GET') return json(res, 200, db.hubSettings());
    if (p === '/api/hub-settings' && req.method === 'PUT') {
      try {
        const s = db.setHubSettings(await readBody(req));
        goa.init();   // GOA's rules file carries my rules
        registerCustom(s.custom);
        evlog.log('info', 'settings', 'hub settings saved');
        return json(res, 200, s);
      } catch (err) { return json(res, 400, { error: String(err.message || err) }); }
    }
    if (p === '/api/hub-settings/test-push' && req.method === 'POST') {
      const r = await notify('XBLabs test notification', { force: true });
      return json(res, r.error ? 502 : 200, r);
    }
    /* Agent configs: other accounts / model APIs. The key is never sent back, only has_key. */
    if (p === '/api/agent-configs' || p.startsWith('/api/agent-configs/')) {
      const cid = p.slice('/api/agent-configs/'.length);
      try {
        if (p === '/api/agent-configs' && req.method === 'GET') {
          const a = url.searchParams.get('agent');
          return json(res, 200, [...Object.keys(AGENTS).filter((x) => !a || x === a).map(db.officialConfig), ...db.listAgentConfigs(a || undefined).map(publicConfig)]);
        }
        if (p === '/api/agent-configs' && req.method === 'POST') return json(res, 201, publicConfig(db.addAgentConfig(await readBody(req))));
        if (cid === 'official' && req.method === 'PATCH') {
          const b = await readBody(req);
          if (!AGENTS[b.agent]) return json(res, 400, { error: 'agent is required' });
          if (b.clear_limit) db.setConfigLimit(b.agent, '', 0);
          return json(res, 200, db.officialConfig(b.agent));
        }
        if (cid && req.method === 'PATCH') { const c = db.updateAgentConfig(cid, await readBody(req)); return c ? json(res, 200, publicConfig(c)) : json(res, 404, { error: 'no such config' }); }
        if (cid && req.method === 'DELETE') return db.deleteAgentConfig(cid) ? json(res, 200, { ok: true }) : json(res, 404, { error: 'no such config' });
      } catch (err) { return json(res, 400, { error: String(err.message || err) }); }
    }
    if (p === '/api/accounts/log') return json(res, 200, db.listAccountLog(url.searchParams.get('limit')));
    if (p === '/api/decisions') return json(res, 200, db.listDecisions(url.searchParams.get('limit')));
    if (p === '/api/logs' && req.method === 'DELETE') return json(res, 200, { cleared: evlog.clear() });
    if (p === '/api/logs') return json(res, 200, evlog.list(Number(url.searchParams.get('limit')) || 200));
    if (p === '/api/usage') return json(res, 200, { ...db.usageSummary(), requests: db.requestSummary(Number(url.searchParams.get('since')) || 0) });

    if (p === '/api/router/usage' && req.method === 'GET') {
      const base = db.getSetting('llm.base_url');
      const hasPassword = !!db.getSetting('router.password');
      if (!base) return json(res, 200, { error: 'Save the 9router base URL in Settings → Models first', hasPassword });
      const period = ROUTER_PERIODS.includes(url.searchParams.get('period')) ? url.searchParams.get('period') : '7d';
      const origin = new URL(base).origin;
      try {
        /* One after the other: the first call may log in, the second reuses its cookie. */
        const stats = await routerFetch(origin, `/api/usage/stats?period=${period}`);
        const chart = await routerFetch(origin, `/api/usage/chart?period=${period}`);
        return json(res, 200, { origin, period, stats, chart, hasPassword });
      } catch (err) {
        const msg = err.name === 'TimeoutError' ? `${origin} did not answer in 8 s` : String(err.message || err);
        return json(res, 200, { origin, period, error: msg, needsLogin: err.status === 401 || err.status === 403, hasPassword });
      }
    }
    if (p === '/api/router' && req.method === 'PUT') {
      const { password = '' } = await readBody(req);
      db.setSetting('router.password', String(password));
      routerCookie = '';
      evlog.log('info', 'settings', password ? '9router dashboard password saved' : '9router dashboard password cleared');
      return json(res, 200, { hasPassword: !!password });
    }

    /* One LLM endpoint; the key is stored server-side and goes into a run's env only for the
       agents switched on (none by default, so each agent keeps its own config). */
    if (p === '/api/llm/agents' && req.method === 'PUT') {
      const { agents: list } = await readBody(req);
      if (!Array.isArray(list)) return json(res, 400, { error: 'agents must be a list' });
      db.setLlmAgents(list.filter((a) => a === 'shell' || Object.hasOwn(AGENTS, a)));
      evlog.log('info', 'settings', `llm endpoint on for: ${db.llmAgents().join(', ') || 'no agent'}`);
      return json(res, 200, await llmOut());
    }
    if (p === '/api/llm' && req.method === 'GET')
      return json(res, 200, await llmOut());
    if (p === '/api/llm' && req.method === 'PUT') {
      const b = await readBody(req);
      const base = String(b.base_url || '').trim();
      if (base && !/^https?:\/\//i.test(base)) return json(res, 400, { error: 'base_url must start with http:// or https://' });
      db.setSetting('llm.base_url', base.replace(/\/+$/, ''));
      db.setSetting('llm.model', String(b.model || '').trim());
      if (typeof b.api_key === 'string' && b.api_key.trim()) db.setSetting('llm.api_key', b.api_key.trim());
      if (b.clear_key) db.setSetting('llm.api_key', '');
      evlog.log('info', 'settings', `llm endpoint saved · ${base || '(empty)'}`);
      return json(res, 200, await llmOut());
    }
    if (p === '/api/llm/models' && req.method === 'PUT') {
      const { models } = await readBody(req);
      try { return json(res, 200, { models: db.setLlmModels(models) }); } catch (err) { return json(res, 400, { error: err.message }); }
    }
    /* What the saved endpoint actually serves, for "Fetch available models". */
    /* One model's context window and output cap, as the saved endpoint (9router) lists them.
       Agents set to a model on that same endpoint get their real window from here. */
    if (p === '/api/llm/model-info' && req.method === 'GET') {
      const id = url.searchParams.get('model') || '';
      const list = await endpointModels();
      const m = list.find((x) => x.id === id) || list.find((x) => x.id.endsWith('/' + id));
      return json(res, m ? 200 : 404, m ? { id: m.id, context_length: m.context_length || null, max_completion_tokens: m.max_completion_tokens || null } : { error: `${id} is not on the saved endpoint` });
    }
    if (p === '/api/llm/models/available' && req.method === 'GET') {
      const s = db.llmSettings();
      if (!s.base_url) return json(res, 400, { error: 'save a base URL first' });
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      try {
        const headers = s.has_key ? { authorization: `Bearer ${db.getSetting('llm.api_key')}` } : {};
        const r = await fetch(`${s.base_url}/models`, { headers, signal: ctrl.signal });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) return json(res, 502, { error: j.error?.message || `HTTP ${r.status}` });
        const ids = (j.data || j.models || []).map((m) => m.id || m.name).filter(Boolean);
        return json(res, 200, { models: [...new Set(ids)].sort() });
      } catch (err) {
        return json(res, 502, { error: err.name === 'AbortError' ? 'timed out' : String(err.message || err) });
      } finally { clearTimeout(timer); }
    }

    if (p === '/api/llm/test' && req.method === 'POST') {
      const s = db.llmSettings();
      if (!s.base_url) return json(res, 400, { ok: false, error: 'no base url saved yet' });
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      try {
        const headers = s.has_key ? { authorization: `Bearer ${db.getSetting('llm.api_key')}` } : {};
        const r = await fetch(`${s.base_url}/models`, { headers, signal: ctrl.signal });
        const text = await r.text();
        let count = null, sample = '';
        try { const parsed = JSON.parse(text); const arr = parsed.data || parsed.models || []; count = arr.length; sample = arr[0]?.id || arr[0]?.name || ''; } catch {}
        evlog.log(r.ok ? 'info' : 'warn', 'settings', `llm test · ${r.status} · ${count ?? '?'} models`);
        return json(res, 200, { ok: r.ok, status: r.status, models: count, sample, base: s.base_url });
      } catch (err) {
        evlog.log('error', 'settings', `llm test failed · ${err.message}`);
        return json(res, 200, { ok: false, status: 0, error: String(err.message || err) });
      } finally { clearTimeout(timer); }
    }

    /* Every agent XBLabs knows how to start, installed here or not. */
    /* The agent's own slash commands, read from its install here; null = use the app's list. */
    const cm = p.match(/^\/api\/agents\/([\w-]+)\/commands$/);
    if (cm && req.method === 'GET') {
      try { return json(res, 200, { list: await slashCommands.list(cm[1]) }); }
      catch (err) { return json(res, 200, { list: null, error: String(err.message || err) }); }
    }
    if (p === '/api/agents/registry' && req.method === 'GET') {
      const found = new Map((await detectCached()).map((a) => [a.id, a]));
      return json(res, 200, Object.entries(AGENTS).map(([id, a]) => ({
        id, name: a.name || id, bin: a.bin || '', installed: found.has(id), version: (found.get(id) || {}).version || '',
        custom: !!a.custom, oneShot: !!a.run, typed: !!a.typePrompt, resume: !!a.resume, endpoint: !!(a.endpoint || a.env),
      })).sort((x, y) => (y.installed - x.installed) || x.name.localeCompare(y.name)));
    }

    /* One tiny chat call with a model: does the endpoint really serve it, and how fast. */
    if (p === '/api/llm/test-model' && req.method === 'POST') {
      const { model } = await readBody(req);
      const s = db.llmSettings();
      if (!s.base_url || !model) return json(res, 400, { ok: false, error: !model ? 'model required' : 'no base url saved yet' });
      const t0 = Date.now();
      try {
        const key = db.getSetting('llm.api_key');
        const r = await fetch(`${s.base_url.replace(/\/+$/, '')}/chat/completions`, {
          method: 'POST', signal: AbortSignal.timeout(30000),
          headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
          body: JSON.stringify({ model: String(model), max_tokens: 8, messages: [{ role: 'user', content: 'Reply with OK.' }] }),
        });
        const text = await r.text();
        if (!r.ok) {
          let msg = text.slice(0, 200);
          try { const j = JSON.parse(text); msg = (j.error && (j.error.message || j.error)) || j.message || msg; } catch { /* plain text */ }
          return json(res, 200, { ok: false, ms: Date.now() - t0, error: `HTTP ${r.status} · ${String(msg).slice(0, 200)}` });
        }
        return json(res, 200, { ok: true, ms: Date.now() - t0, reply: decide.completionText(text).slice(0, 60) });
      } catch (err) {
        return json(res, 200, { ok: false, ms: Date.now() - t0, error: String(err.message || err) });
      }
    }

    if (p === '/api/devices') {
      const rows = db.deviceRows();
      const machines = rows.map((r) => ({
        name: r.device, runs: r.runs, live: r.live || 0, waiting: r.waiting || 0,
        workspaces: (r.workspaces || '').split(',').filter(Boolean), seen: r.seen,
      }));
      if (!machines.some((m) => m.name === 'local')) machines.unshift({ name: 'local', runs: 0, live: 0, waiting: 0, workspaces: [], seen: null });
      const local = machines.find((m) => m.name === 'local');
      /* The fleet is the tailnet: every host Tailscale knows about shows up, online or not. */
      const ts = await tailscale.status().catch(() => ({ devices: [] }));
      for (const d of ts.devices || []) {
        let m = d.self ? local : machines.find((x) => x.name.toLowerCase() === String(d.name).toLowerCase()
          || x.name.toLowerCase() === String(d.dns || '').toLowerCase());
        if (!m) { m = { name: d.name, runs: 0, live: 0, waiting: 0, workspaces: [], seen: null }; machines.push(m); }
        Object.assign(m, {
          ts: true, tsOs: d.os || '', tsIp: d.ip || '', tsOnline: !!d.online, tsSelf: !!d.self,
          tailnet: ts.tailnet || '', status: d.online ? 'online' : 'offline',
        });
      }
      Object.assign(local, {
        thisHost: true, platform: platform(), release: release(), arch: arch(), host: process.env.XBLABS_HOSTNAME || hostname(),   // override: demos and screenshots
        cpu: cpuPct(),
        ram: Math.round(((totalmem() - freemem()) / totalmem()) * 100),
        ramUsed: totalmem() - freemem(), ramTotal: totalmem(),
        cores: cpus().length, uptimeH: Math.round(uptime() / 3600), disk: diskPct(),
        home: homedir(), root: platform() === 'win32' ? (process.env.SystemDrive || 'C:') + '\\' : '/',
        agents: (await detectCached()).filter((a) => enabled(a.id, db.hubSettings())),   /* installed here, minus the ones switched off */
      });
      /* Hosts added by hand: online means their ssh port answers. */
      const man = manualHosts();
      const up = await Promise.all(man.map((h) => probe(h.host, h.port || 22)));
      man.forEach((h, i) => {
        let m = machines.find((x) => x.name.toLowerCase() === h.name.toLowerCase());
        if (!m) { m = { name: h.name, runs: 0, live: 0, waiting: 0, workspaces: [], seen: null }; machines.push(m); }
        Object.assign(m, { manual: true, sshHost: h.host, sshPort: h.port || 22, sshUser: h.user || '', sshKey: h.key || '', ...(m.ts ? {} : { status: up[i] ? 'online' : 'offline' }) });
      });
      /* Remote machines report their own stats; nothing here is invented when an agent is absent. */
      for (const [name, a] of agents) {
        let m = machines.find((x) => x.name === name);
        if (!m) { m = { name, runs: 0, live: 0, waiting: 0, workspaces: [], seen: null }; machines.push(m); }
        Object.assign(m, {
          agent: true, live: true, status: 'online', seen: Date.now(), platform: a.meta.platform, release: a.meta.release, arch: a.meta.arch,
          host: a.meta.host, home: a.meta.home, root: a.meta.root, cores: a.meta.cores,
          /* Behind = its code differs from what this hub would install now (older workers send no build). */
          outdated: a.meta.build !== AGENT_BUILD,
          cpu: a.cpu, ram: a.ram, ramUsed: a.ramUsed, ramTotal: a.ramTotal, shell: a.meta.shell,
          disk: a.disk ?? null, ...(a.uptimeH != null ? { uptimeH: a.uptimeH } : {}),
          /* What that machine found on its own PATH. Absent = an older agent that does not report. */
          ...(Array.isArray(a.meta.agents) ? {
            agents: a.meta.agents.filter((x) => x && typeof x.id === 'string' && enabled(x.id, db.hubSettings()))
              .map((x) => ({ id: x.id, name: String(x.name || x.id), path: String(x.path || ''), version: String(x.version || '') })),
          } : {}),
        });
      }
      /* The fleet is the tailnet plus any agent attached right now (its --name may differ from the Tailscale name). */
      return json(res, 200, machines.filter((m) => m.ts || m.agent || m.manual || m.name === 'local'));
    }

    if (p === '/api/tailscale' && req.method === 'GET') return json(res, 200, await tailscale.status());
    if (p === '/api/tailscale' && req.method === 'PUT') {
      const b = await readBody(req);
      try {
        if (b.ssh_user !== undefined) db.setSetting('ts.ssh_user', String(b.ssh_user || '').trim());
        const s = await tailscale.connect({ mode: b.mode, api_key: b.api_key, tailnet: b.tailnet });
        evlog.log('info', 'settings', `tailscale connected · ${s.mode} · ${s.devices.length} devices · ${s.tailnet || 'tailnet'}`);
        return json(res, 200, s);
      } catch (err) {
        evlog.log('error', 'settings', `tailscale connect failed · ${err.message}`);
        return json(res, 400, { error: String(err.message || err) });
      }
    }
    if (p === '/api/tailscale' && req.method === 'DELETE') {
      tailscale.disconnect();
      evlog.log('warn', 'settings', 'tailscale disconnected');
      return json(res, 200, await tailscale.status());
    }
    /* Sign this hub into Tailscale: `tailscale login` prints an auth URL, the browser opens it. */
    if (p === '/api/tailscale/login' && req.method === 'POST') {
      try { const url = await tailscale.login(); evlog.log('info', 'settings', 'tailscale sign-in started in the browser'); return json(res, 200, { url }); }
      catch (err) { return json(res, 400, { error: String(err.message || err) }); }
    }
    if (p === '/api/hosts' && req.method === 'GET') return json(res, 200, manualHosts());
    if (p === '/api/ssh/keys' && req.method === 'GET') return json(res, 200, sshKeys());
    if (p === '/api/ssh/probe' && req.method === 'GET') {
      const host = url.searchParams.get('host') || '', port = Number(url.searchParams.get('port') || 22);
      if (!HOST_RE.test(host) || !(port >= 1 && port <= 65535)) return json(res, 400, { error: 'bad host or port' });
      const banner = await sshBanner(host, port);
      return json(res, 200, { open: !!banner, kind: sshKind(banner), banner: banner || '' });
    }
    if (p === '/api/devices/connect' && req.method === 'POST') {
      const h = parseHost(await readBody(req));
      if (h.error) return json(res, 400, h);
      if (!h.user) return json(res, 400, { error: 'user required: the account to log in as on that device' });
      const hub = tsListenIp ? `${tsListenIp}:${PORT}` : install.okHost(req.headers.host) && !/^(localhost|127\.|\[)/.test(req.headers.host) ? req.headers.host : '';
      if (!hub) return json(res, 400, { error: 'other devices cannot reach this hub yet: turn on Tailscale here, or start the hub with XBLABS_HOST' });
      const kind = sshKind(await sshBanner(h.host, h.port));
      if (kind === 'none') return json(res, 400, { error: `no ssh server answers on ${h.host}:${h.port}; use the one-line install on that device instead` });
      return json(res, 202, { id: startConnect({ ...h, kind, hub }), kind });
    }
    if (p.startsWith('/api/devices/connect/') && req.method === 'GET') {
      const j = connects.get(p.slice('/api/devices/connect/'.length));
      return j ? json(res, 200, j) : json(res, 404, { error: 'unknown connect' });
    }
    if (p === '/api/hosts' && req.method === 'POST') {
      const h = parseHost(await readBody(req));
      if (h.error) return json(res, 400, h);
      const { name, host, port, user, key } = h;
      const list = manualHosts().filter((x) => x.name.toLowerCase() !== name.toLowerCase());
      list.push({ name, host, port, user, ...(key ? { key } : {}) });
      db.setSetting('devices.manual', JSON.stringify(list));
      probeCache.delete(`${host}:${port}`);
      const reachable = await probe(host, port);
      evlog.log('info', 'settings', `host added · ${name} (${host}:${port}) · ${reachable ? 'ssh port open' : 'ssh port not reachable'}`);
      return json(res, 201, { name, host, port, user, reachable });
    }
    if (p.startsWith('/api/hosts/') && req.method === 'DELETE') {
      const name = decodeURIComponent(p.slice('/api/hosts/'.length)).toLowerCase();
      db.setSetting('devices.manual', JSON.stringify(manualHosts().filter((h) => h.name.toLowerCase() !== name)));
      return json(res, 200, { ok: true });
    }
    if (p === '/api/tailscale/test') {
      const s = await tailscale.status();
      return json(res, 200, { ok: s.ok && s.connected, status: s.backend, devices: (s.devices || []).length, tailnet: s.tailnet, error: s.error });
    }

    if (p === '/api/browser' && req.method === 'POST') {
      const b = await readBody(req);
      try { return json(res, 200, await browser.act(String(b.action || ''), Array.isArray(b.args) ? b.args : [], typeof b.session === 'string' && /^[\w-]+$/.test(b.session) ? b.session : undefined)); }
      catch (e) { return json(res, 200, { error: e.message }); }
    }
    if (p === '/api/notes' && req.method === 'GET') return json(res, 200, db.listNotes());
    if (p === '/api/notes' && req.method === 'POST') {
      const b = await readBody(req);
      if (!b.title) return json(res, 400, { error: 'title required' });
      const n = db.createNote(b); evlog.log('info', 'notes', `note created · ${n.title}`);
      return json(res, 201, n);
    }
    if (p.startsWith('/api/notes/')) {
      const id = p.split('/')[3];
      if (req.method === 'PATCH') return json(res, 200, db.updateNote(id, await readBody(req)));
      if (req.method === 'DELETE') { db.deleteNote(id); return json(res, 200, { ok: true }); }
    }

    if (p === '/api/jobs' && req.method === 'GET') return json(res, 200, db.listJobs());

    if (p === '/api/jobs' && req.method === 'POST') {
      const { title, prompt = '', ws, targets = [] } = await readBody(req);
      const valid = targets.filter((t) => t && typeof t.cwd === 'string' && t.cwd);
      if (!title || !valid.length) return json(res, 400, { error: 'title and at least one target (with cwd) required' });
      const job = db.createJob({ title, prompt, ws });
      evlog.log('info', 'jobs', `job ${job.id} dispatched · ${valid.length} target(s)`);
      const runs = await Promise.all(valid.map(async (t) => {
        const s = db.createSession({
          job_id: job.id, ws: ws || 'xblabs-web', title: job.title,
          prompt, cwd: t.cwd, device: t.device || 'local', agent: t.agent || 'shell', model: t.model || '', kind: 'job',
        });
        /* Own worktree + branch per run unless the target opts out (isolate: false). Local runs
           are isolated here; remote agents do it on their machine and report back on 'spawned'. */
        const isolate = t.isolate !== false;
        if (isolate && s.device === 'local') isolateSession(s);
        await spawnRun({ ...db.getSession(s.id), isolate });
        return db.getSession(s.id);
      }));
      return json(res, 201, { ...db.getJob(job.id), runs });
    }

    if (p === '/api/sessions' && req.method === 'GET')
      { const st = db.sessionStats(), roles = team.roles(); return json(res, 200, db.listSessions({
        status: url.searchParams.get('status') || undefined,
        job: url.searchParams.get('job') || undefined,
        kind: url.searchParams.get('kind') || undefined,
      }).map((r) => ({ ...r, stats: st[r.id] || null, team_role: roles.get(r.id)?.role || null, team_mates: roles.get(r.id)?.mates || 0,
        /* A bubble chat whose last answer asks me to pick: the choices, for the notification list. */
        ask: r.kind === 'chat' && r.mode === 'json' && !chat.busy(r.id) ? lastAsk(db.recentEvents(r.id)) : null }))); }

    if (p === '/api/search' && req.method === 'GET') {
      const q = (url.searchParams.get('q') || '').trim();
      if (q.length < 2) return json(res, 200, { hits: [] });
      return json(res, 200, { hits: db.searchEvents(q.slice(0, 200), { session: url.searchParams.get('session') || '', who: url.searchParams.get('who') || '' }) });
    }

    if (p === '/api/projects' && req.method === 'GET')
      return json(res, 200, { hidden: db.hiddenProjects(), folders: db.listProjects() });

    /* Forget a project: session rows and the sidebar entry go. The folder, its git branches and
       any database file inside it are never touched — this endpoint has no filesystem access. */
    if (p.startsWith('/api/projects/') && req.method === 'DELETE') {
      const ws = decodeURIComponent(p.slice('/api/projects/'.length));
      if (!ws) return json(res, 400, { error: 'ws required' });
      const ids = db.deleteSessionsBy({ ws });
      for (const id of ids) { chat.stop(id); pty.kill(id); }
      db.hideProject(ws);
      evlog.log('warn', ws, `project forgotten · ${ids.length} session(s) removed, files on disk untouched`);
      return json(res, 200, { ok: true, deleted: ids.length, hidden: ws });
    }

    /* Clear a workspace: the session rows go, the folder and its git branch stay. */
    if (p === '/api/sessions' && req.method === 'DELETE') {
      const ws = url.searchParams.get('ws');
      if (!ws) return json(res, 400, { error: 'ws required — refusing to delete every session' });
      const ids = db.deleteSessionsBy({ ws, kind: url.searchParams.get('kind') || undefined });
      for (const id of ids) { chat.stop(id); pty.kill(id); }
      evlog.log('warn', ws, `cleared ${ids.length} session(s) from ${ws}`);
      return json(res, 200, { ok: true, deleted: ids.length, ids });
    }

    if (p === '/api/sessions' && req.method === 'POST') {
      const body = await readBody(req);
      /* A pipeline: its first stage is this session; the rest start as each stage's turn ends. */
      let stages = null, task = '', teamCfg = null;
      if (body.pipeline !== undefined && body.team !== undefined) return json(res, 400, { error: 'a session is a pipeline or a team, not both' });
      /* A team: this session is its lead; it plans the task board, the hub starts the teammates. */
      if (body.team !== undefined) {
        if ((body.device || 'local') !== 'local') return json(res, 400, { error: 'teams run on this hub only for now' });
        const mate = String(body.team?.agent || body.agent || '');
        for (const a of [body.agent, mate]) if (!Object.hasOwn(AGENTS, a) || !AGENTS[a].json) return json(res, 400, { error: `${a || 'no agent'} cannot run in a team (needs a chat mode on this hub)` });
        task = String(body.prompt || '').trim();
        if (!task) return json(res, 400, { error: 'a team needs a goal' });
        teamCfg = { goal: task, agent: mate };
        Object.assign(body, { kind: 'chat', isolate: true, requireIsolation: true, prompt: team.planPrompt(task) });
      }
      if (body.pipeline !== undefined) {
        if ((body.device || 'local') !== 'local') return json(res, 400, { error: 'pipelines run on this hub only for now' });
        try { stages = pipeline.clean(body.pipeline, (a) => Object.hasOwn(AGENTS, a) && !!AGENTS[a].json); } catch (err) { return json(res, 400, { error: err.message }); }
        task = String(body.prompt || '').trim();
        if (!task) return json(res, 400, { error: 'a pipeline needs a task' });
        Object.assign(body, { kind: 'chat', agent: stages[0].agent, isolate: true, requireIsolation: true, prompt: pipeline.stagePrompt(stages, 0, task) });
      }
      if (body.requireIsolation === true && (body.kind !== 'chat' || !Object.hasOwn(AGENTS, body.agent) || body.isolate !== true)) return json(res, 400, { error: 'fan-out requires a known agent, chat session and isolation' });
      if (body.kind !== 'chat' || String(body.prompt || '').trim()) { const e = agentLimitError(); if (e) return json(res, 409, { error: e }); }
      body.cwd = body.cwd || process.cwd();   /* default to the hub dir, never 400 for a workspace click */
      try { db.resolveConfigId(body.agent || 'shell', body.config); } catch (err) { return json(res, 400, { error: err.message }); }
      if (body.llm_model !== undefined && body.llm_model !== '' && !(typeof body.llm_model === 'string' && /^[\w.:/@+-]{1,200}$/.test(body.llm_model))) return json(res, 400, { error: 'invalid model id' });
      /* Was the folder already in the sidebar? A refused fan-out must not leave it there. */
      const known = db.listProjects().some((f) => f.ws === (body.ws || 'xblabs-web') && f.device === (body.device || 'local') && f.cwd === body.cwd);
      const s = db.createSession(body);
      /* A chat session is only a thread until something is dispatched: no shell, no PTY,
         no pty-exit noise in the Terminal log panel. */
      if (s.kind === 'chat') {
        /* An agent chat gets its own worktree unless asked not to (isolate: false); a plain
           shell chat works in the folder itself unless asked to. Remote chats: not yet. */
        const isolate = body.isolate ?? s.agent !== 'shell';
        if (isolate && s.device === 'local') isolateSession(s);
        if (body.requireIsolation === true && s.device === 'local' && !db.getSession(s.id).branch) {
          /* Nothing ran: the row goes too, or opening it later would start the agent in the folder itself. */
          db.deleteSession(s.id);
          if (!known) db.forgetProject({ ws: s.ws, device: s.device, cwd: body.cwd });
          return json(res, 409, { error: `${String(s.cwd).split(/[\\/]/).filter(Boolean).pop()} is not a Git repository with a commit; each agent needs its own branch (git init, commit, then try again). The prompt was not dispatched` });
        }
        db.updateSession(s.id, { status: 'idle', ...(['auto', 'ask', 'read'].includes(body.approval) ? { approval: body.approval } : {}) });
        /* The model its own config names, so the MODEL tab has it before the first answer. */
        const cm = s.device === 'local' && !s.llm_model ? configuredModel(s.agent) : null;   // a picked model is what it runs
        if (cm) db.updateSession(s.id, { model: cm.provider ? `${cm.model} · ${cm.provider}` : cm.model });
        /* An agent with a JSON mode on this hub is a bubble chat: the prompt is its first turn. */
        if (chat.canBubble(db.getSession(s.id))) {
          if (s.device !== 'local') {
            const prepared = await askAgent(s.device, { type: 'chat-prepare', id: s.id, cwd: s.cwd, isolate }, 30000);
            if (prepared.error) { db.updateSession(s.id, { status: 'failed' }); return json(res, 409, { error: prepared.error }); }
            db.updateSession(s.id, { cwd: prepared.cwd, ...(prepared.branch ? { branch: prepared.branch, origin: s.cwd } : {}) });
          }
          db.updateSession(s.id, { mode: 'json' });
          if (stages) pipeline.begin(s.id, stages, task);
          if (teamCfg) team.begin(s.id, teamCfg);
          if (String(body.prompt || '').trim()) chat.send(s.id, body.prompt).catch((err) => evlog.log('warn', s.ws, `${s.id} first turn · ${err.message}`));
          return json(res, 201, db.getSession(s.id));
        }
        /* On another device the agent starts now, there (its own worktree made by that agent). */
        if (body.requireIsolation === true && s.device === 'local' && !(await spawnRun(db.getSession(s.id)))) return json(res, 409, { error: 'fan-out agent could not start' });
        if (s.device !== 'local' && !(await spawnRun({ ...db.getSession(s.id), isolate }))) return json(res, 409, { error: isolate ? `${s.device}: isolation requires an attached XBLabs agent; SSH fallback has no worktree` : `${s.device}: no XBLabs agent and no tailnet address` });
        return json(res, 201, db.getSession(s.id));
      }
      if (!(await spawnRun({ ...s, isolate: body.isolate === true }))) return json(res, 409, { error: body.isolate === true ? `${s.device}: isolation requires an attached XBLabs agent; SSH fallback has no worktree` : `${s.device}: no agent and no tailnet address` });
      return json(res, 201, db.getSession(s.id));
    }

    /* Automations: scheduled prompts, each run a new session on its own branch. */
    if (p === '/api/automations' && req.method === 'GET') return json(res, 200, { list: automations.list(), now: Date.now() });
    if (p === '/api/automations' && req.method === 'PUT') {
      try { return json(res, 200, { list: automations.replace((await readBody(req)).list, canRunUnattended) }); }
      catch (err) { return json(res, 400, { error: err.message }); }
    }
    const am = p.match(/^\/api\/automations\/(aut_[0-9a-f]{8})\/run$/);
    if (am && req.method === 'POST') {
      try { const r = await automations.record(am[1], runAutomation); return json(res, r.error ? 409 : 201, r); }
      catch (err) { return json(res, 404, { error: err.message }); }
    }

    /* GOA: the head session, its tasks, and what the xb CLI calls. */
    if (p.startsWith('/api/goa')) {
      try {
        if (p === '/api/goa' && req.method === 'GET') return json(res, 200, { head: goa.head(), tasks: db.listTasks() });
        if (p === '/api/goa/head' && req.method === 'POST') return json(res, 201, goa.startHead((await readBody(req)).agent));
        if (p === '/api/goa/head' && req.method === 'DELETE') { goa.stopHead(); return json(res, 200, { ok: true }); }
        if (p === '/api/goa/tasks' && req.method === 'POST') return json(res, 201, goa.delegate(await readBody(req)));
        if (p === '/api/goa/report' && req.method === 'POST') {
          const b = await readBody(req);
          goa.report(b.session, b.outcome, b.note);
          return json(res, 200, { ok: true });
        }
        const t = p.match(/^\/api\/goa\/tasks\/([\w-]+)$/);
        if (t && req.method === 'GET') return json(res, 200, goa.show(t[1]));
        if (t && req.method === 'PATCH') { const b = await readBody(req); return json(res, 200, goa.settle(t[1], b.status, b.note)); }
      } catch (err) { return json(res, 400, { error: String(err.message || err) }); }
      return json(res, 404, { error: 'not found' });
    }

    /* Settings → Storage: every session folder under <home>/worktrees, and its session if any. */
    /* Folder browser for New session: the folders in one directory, on the hub or on a device
       through its XBLabs agent. Read-only; New folder works on the hub only. */
    if (p === '/api/fs' && req.method === 'GET') {
      const device = url.searchParams.get('device') || 'local', path = url.searchParams.get('path') || '~', hidden = url.searchParams.get('hidden') === '1';
      if (device !== 'local') {
        const r = await askAgent(device, { type: 'ls', path, hidden });
        return json(res, r.error ? 400 : 200, r.error ? { error: r.error } : { path: r.path, parent: r.parent, home: r.home, dirs: r.dirs || [] });
      }
      try { return json(res, 200, listDirs(path, hidden)); }
      catch (err) { return json(res, 400, { error: err.code === 'ENOENT' ? `no such folder: ${path}` : String(err.message || err) }); }
    }
    if (p === '/api/fs/mkdir' && req.method === 'POST') {
      const { path: at, name } = await readBody(req);
      if (!name || /[\\/:*?"<>|]/.test(name) || name === '.' || name === '..') return json(res, 400, { error: 'bad folder name' });
      try { mkdirSync(join(resolve(at), name)); return json(res, 201, { path: join(resolve(at), name) }); }
      catch (err) { return json(res, 400, { error: err.code === 'EEXIST' ? 'already exists' : String(err.message || err) }); }
    }

    /* Folder picker → Clone: the project comes from its Git URL, on this hub or on the picked device. */
    if (p === '/api/fs/clone' && req.method === 'POST') {
      const { device = 'local', path: at, url } = await readBody(req);
      if (device === 'local') { const r = await worktree.clone(url, at); return json(res, r.error ? 400 : 201, r); }
      if ((agents.get(device)?.meta?.gitProtocol || 0) < 2) return json(res, 409, { error: `${device}: update the XBLabs worker there to clone (Settings → Devices → Update)` });
      const r = await askAgent(device, { type: 'clone', url, path: at }, 600000);
      evlog.log(r.error ? 'warn' : 'info', 'projects', `clone on ${device} · ${r.error || r.said}`);
      return json(res, r.error ? 400 : 201, r);
    }

    /* Settings → Storage: where new session worktrees go. Old ones stay where they are and stay listed. */
    if (p === '/api/storage' && req.method === 'PUT') {
      try {
        const b = await readBody(req);
        const was = worktree.root();
        const dir = b.worktrees ? worktree.checkRoot(String(b.worktrees)) : '';
        const past = [...new Set([...JSON.parse(db.getSetting('storage.pastWorktrees') || '[]'), was])].filter((x) => x && x !== (dir || worktree.root()));
        db.setSetting('storage.worktrees', dir);
        db.setSetting('storage.pastWorktrees', JSON.stringify(past.slice(-20)));
        worktree.setRoots(dir, past);
        evlog.log('info', 'storage', `new worktrees go to ${worktree.root()}`);
        return json(res, 200, { root: worktree.root() });
      } catch (err) { return json(res, 400, { error: String(err.message || err) }); }
    }
    if (p === '/api/worktrees' && req.method === 'GET') {
      const rows = new Map(db.listSessions({ limit: 2000 }).map((s) => [s.id, s]));
      return json(res, 200, { home: worktree.root(), custom: !!db.getSetting('storage.worktrees'), list: worktree.list().map((w) => {
        const s = rows.get(w.id);
        return { ...w, session: s ? { title: s.title, status: s.status, agent: s.agent, live: pty.isLive(s.id) } : null };
      }) });
    }
    if (p.startsWith('/api/worktrees/') && req.method === 'DELETE') {
      const id = decodeURIComponent(p.slice('/api/worktrees/'.length));
      const w = worktree.list().find((x) => x.id === id);
      if (!w) return json(res, 404, { error: 'no such worktree' });
      if (pty.isLive(id)) return json(res, 409, { error: 'stop the session first' });
      try {
        const r = await worktree.act(w.dir, 'discard');
        if (r.removed && db.getSession(id)) db.updateSession(id, { cwd: r.top, branch: null });
        evlog.log(r.error ? 'warn' : 'info', 'storage', `worktree ${id} · ${r.error || r.said}`);
        return json(res, r.error ? 409 : 200, r);
      } catch (err) { return json(res, 409, { error: String(err.message || err) }); }
    }

    /* Settings → Agents → Kill all: every live PTY stops; the rows stay, marked 'stopped'. */
    if (p === '/api/sessions/kill-all' && req.method === 'POST') {
      const n = db.listSessions({}).filter((s) => pty.isLive(s.id)).length;
      pty.killAll();
      evlog.log('warn', 'hub', `killed ${n} running session(s)`);
      return json(res, 200, { ok: true, killed: n });
    }

    const m = p.match(/^\/api\/sessions\/([\w-]+)(\/approve|\/log|\/input|\/summary|\/status|\/git|\/chat|\/chat\/stop|\/chat\/approve|\/chat\/tui-close|\/chat\/pick|\/hibernate|\/wake|\/switch|\/run|\/ports|\/procs|\/file|\/media|\/browser\/input|\/browser\/tabs|\/browser\/view|\/browser\/logs|\/upload)?$/);
    if (m) {
      const id = m[1];
      if (!db.getSession(id)) return json(res, 404, { error: 'no such session' });
      /* FILES viewer: one file of the session's folder, contained by resolveInside. */
      if (m[2] === '/file' && req.method === 'GET') {
        const s = db.getSession(id);
        if (s.device !== 'local' || s.ssh) return json(res, 404, { error: 'files are only served for local sessions' });
        try {
          const f = resolveInside(s.cwd, new URL(req.url, 'http://x').searchParams.get('path'));
          res.writeHead(200, { 'content-type': f.type, 'content-length': f.size, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': 'sandbox' });
          return createReadStream(f.file).pipe(res);
        } catch (e) { return json(res, e.status || 500, { error: e.message }); }
      }
      /* A picture/media file the agent named outside the session folder (mentionedMedia's rules). */
      if (m[2] === '/media' && req.method === 'GET') {
        const s = db.getSession(id);
        if (s.device !== 'local' || s.ssh) return json(res, 404, { error: 'files are only served for local sessions' });
        try {
          const texts = db.listEvents(id, 0).filter((e) => e.kind === 'text' || e.kind === 'tool').map((e) => JSON.stringify(e.data));
          const f = mentionedMedia(new URL(req.url, 'http://x').searchParams.get('path'), texts);
          res.writeHead(200, { 'content-type': f.type, 'content-length': f.size, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': 'sandbox' });
          return createReadStream(f.file).pipe(res);
        } catch (e) { return json(res, e.status || 500, { error: e.message }); }
      }
      /* A composer attachment: saved under <cwd>/.xblabs/attach (ignored by git), the path goes into the prompt. */
      if (m[2] === '/upload' && req.method === 'POST') {
        const s = db.getSession(id);
        // ponytail: local sessions only; remote devices need the agent to receive the bytes (Phase 2).
        if (s.device !== 'local' || s.ssh) return json(res, 409, { error: 'attachments work on local sessions only' });
        const name = String(url.searchParams.get('name') || 'file').replace(/[^\w.-]+/g, '_').slice(-80) || 'file';
        const chunks = []; let n = 0;
        try {
          for await (const c of req) { n += c.length; if (n > 20e6) return json(res, 413, { error: 'file over 20 MB' }); chunks.push(c); }
          const dir = join(s.cwd, '.xblabs', 'attach');
          mkdirSync(dir, { recursive: true });
          const ign = join(s.cwd, '.xblabs', '.gitignore');
          if (!existsSync(ign)) writeFileSync(ign, '*\n');
          const file = join(dir, `${Date.now().toString(36)}-${name}`);
          writeFileSync(file, Buffer.concat(chunks));
          return json(res, 201, { path: file });
        } catch (e) { return json(res, 500, { error: e.message }); }
      }
      /* The session's browser tabs: list, new {url}, close {key}, activate {key}; viewport; console + network. */
      if (m[2] === '/browser/tabs') {
        try {
          if (req.method === 'GET') return json(res, 200, await browser.listTabs(id));
          const b = await readBody(req);
          if (b.op === 'new') return json(res, 200, await browser.newTab(id, b.url ? String(b.url) : ''));
          if (b.op === 'close') return json(res, 200, await browser.closeTab(id, String(b.key || '')));
          if (b.op === 'activate') return json(res, 200, await browser.activateTab(id, String(b.key || '')));
          return json(res, 400, { error: 'op: new | close | activate' });
        } catch (e) { return json(res, 400, { error: e.message }); }
      }
      if (m[2] === '/browser/view' && req.method === 'POST') {
        try { return json(res, 200, await browser.setView(id, await readBody(req))); } catch (e) { return json(res, 400, { error: e.message }); }
      }
      if (m[2] === '/browser/logs' && req.method === 'GET') {
        try { return json(res, 200, await browser.logs(id)); } catch (e) { return json(res, 400, { error: e.message }); }
      }
      if (m[2] === '/browser/input' && req.method === 'POST') {
        try { await browser.input(id, await readBody(req)); return json(res, 200, { ok: true }); }
        catch (e) { return json(res, 200, { error: e.message }); }
      }
      /* Processes this session started that still run (dev servers, watchers, leftovers of a
         turn), and a manual stop for one. Local only; a stop re-reads the table and refuses a pid
         that is not this session's. ponytail: turn pids live in memory, so after a hub restart only
         processes naming the session's own worktree are found. */
      if (m[2] === '/procs' && (req.method === 'GET' || req.method === 'POST')) {
        const s = db.getSession(id);
        if (s.device !== 'local' || s.ssh) return json(res, 200, req.method === 'GET' ? [] : { error: 'background processes are listed for sessions on this hub only' });
        const roots = [...chat.turnRoots(id), ...(s.pid ? [{ pid: s.pid, at: 0 }] : [])];
        /* What its tools reported starting in the background ("pid": N in a background call's result). */
        const claimed = db.listEvents(id, 0).filter((e) => e.kind === 'tool' && e.data.output && (e.data.input?.background || /background/i.test(e.data.output)))
          .flatMap((e) => [...String(e.data.output).matchAll(/"pid"\s*:\s*(\d+)/g)].map((x) => ({ pid: +x[1], at: e.at })));
        const mine = (t) => ports.bgOf(roots, t.procs, s.branch ? s.cwd : '', claimed);
        try {
          if (req.method === 'GET') return json(res, 200, mine(await ports.tables()));
          const pid = Number((await readBody(req)).pid);
          if (!mine(await ports.readTables()).some((p) => p.pid === pid)) return json(res, 404, { error: 'that process is not running in this session' });
          await ports.killTree(pid);
          ports.forget();
          evlog.log('warn', s.ws, `${id} stopped background process ${pid}`);
          return json(res, 200, { ok: true });
        } catch (err) { return json(res, 500, { error: String(err.message || err) }); }
      }
      /* Ports the session's process tree listens on (local only, see ports.mjs). */
      if (m[2] === '/ports' && req.method === 'GET') {
        const s = db.getSession(id);
        if (s.device !== 'local' || s.ssh) return json(res, 200, []);
        /* Its terminal tabs (Run commands too) are sessions of their own in the same folder: their ports count. */
        const pids = db.listSessions({ limit: 1000 }).filter((x) => x.pid && x.cwd === s.cwd && (x.device || 'local') === 'local' && !x.ssh).map((x) => x.pid);
        if (!pids.length) return json(res, 200, []);
        try { const t = await ports.tables(); return json(res, 200, ports.portsOf(pids, t.procs, t.listeners, [PORT])); }
        catch (err) { return json(res, 500, { error: String(err.message || err) }); }
      }
      /* Project run menu: commands from .xblabs.json "run". Running one opens a new shell session
         (a Terminal tab) in the session's folder and types the command into it. */
      if (m[2] === '/run') {
        const s = db.getSession(id);
        if (s.device !== 'local' || s.ssh) return json(res, 409, { error: 'run commands work on local sessions only' });
        if (req.method === 'GET') return json(res, 200, worktree.runCommands(s.cwd));
        if (req.method === 'POST') {
          const b = await readBody(req);
          let name = b.name, cmd;
          try {
            if (typeof b.command === 'string' && b.command.trim()) {
              name = String(b.save || '').trim(); cmd = b.command.trim();
              if (!/^[\w.-]{1,40}$/.test(name)) return json(res, 400, { error: 'save: a short name (letters, digits, . _ -) is required' });
              worktree.saveRunCommand(s.cwd, name, cmd);
            } else cmd = worktree.runCommands(s.cwd)[name];
          } catch (err) { return json(res, 409, { error: String(err.message || err) }); }
          if (!cmd) return json(res, 404, { error: `no run command ${name || ''} in .xblabs.json` });
          const sh = db.createSession({ title: `${s.title} · ${name || 'run'}`, kind: 'shell', agent: 'shell', device: 'local', cwd: s.cwd, ws: s.ws });
          if (!(await spawnRun(sh))) return json(res, 409, { error: 'could not start a shell' });
          pty.write(sh.id, cmd + '\r');
          evlog.log('info', s.ws, `${id} run ${name} · ${cmd.slice(0, 90)}`);
          return json(res, 201, { id: sh.id, name, command: cmd });
        }
      }
      /* Saved commands are typed into a shell by the hub, so they land even before a tab mounts. */
      if (m[2] === '/input' && req.method === 'POST') {
        const { data } = await readBody(req);
        if (typeof data !== 'string' || !data) return json(res, 400, { error: 'data must be a non-empty string' });
        pty.write(id, data);
        return json(res, 200, { ok: true });
      }
      /* An agent's own hook says what it is doing (server/hooks/). Only a live session listens:
         a late report must not reopen a run that already ended. */
      if (m[2] === '/status' && req.method === 'POST') {
        const status = { working: 'running', waiting: 'waiting', idle: 'idle' }[(await readBody(req)).state];
        if (!status) return json(res, 400, { error: 'state must be working, waiting or idle' });
        if (pty.isLive(id)) {
          const was = db.getSession(id).status;
          db.updateSession(id, { status }); goa.onStatus(id, status);
          const s = db.getSession(id);
          if (status === 'waiting' && was !== 'waiting' && worth(s)) notify(`${s.title}: asking for input (${s.agent})`);
          if (status === 'idle' && was === 'running' && worth(s) && id !== goa.headId()) notify(`${s.title}: turn finished (${s.agent})`);
        }
        return json(res, 200, { ok: true });
      }
      /* The session's work against the branch it came from, and what to do with it. Only for a
         session on its own branch, on this machine (remote devices: PLAN G2, later). */
      /* Bubble chat: the events after a version, one more message, or stop the running turn. */
      if (m[2] === '/chat' && req.method === 'GET')
        return json(res, 200, { events: db.listEvents(id, +url.searchParams.get('after') || 0), busy: chat.busy(id), ask: pty.tuiAsk(id), note: chat.busy(id) ? pty.tuiNote(id) : '', pipeline: pipeline.get(id), team: team.get(id) });
      if (m[2] === '/chat' && req.method === 'POST') {
        try { await chat.send(id, (await readBody(req)).text); return json(res, 202, { ok: true }); }
        catch (err) { return json(res, 409, { error: String(err.message || err) }); }
      }
      if (m[2] === '/hibernate' && req.method === 'POST') {
        const r = hibernate(id, !!(await readBody(req)).force);
        return json(res, r.error ? 409 : 200, r.error ? r : db.getSession(id));
      }
      if (m[2] === '/switch' && req.method === 'POST') {
        const b = await readBody(req);
        const s = db.getSession(id);
        const to = String(b.config).toLowerCase() === 'official' ? db.officialConfig(s.agent) : db.configsFor(s.agent).find((c) => c.id === b.config || c.name === b.config);
        if (!to) return json(res, 404, { error: `${s.agent} has no config ${b.config}` });
        const from = db.configsFor(s.agent).find((c) => c.id === (s.config_id || '')) || db.officialConfig(s.agent);
        if (to.id === from.id) return json(res, 200, s);
        /* hermes runs conversations in its gateway, which keeps the provider a conversation began on. */
        if (AGENTS[s.agent] && AGENTS[s.agent].pinsProvider && db.listEvents(id, 0).length) return json(res, 409, { error: `${s.agent} keeps the provider a conversation started on; open a new session on ${to.name}` });
        if (!sharesConversation(from, to)) {
          /* ponytail: a terminal session keeps its conversation in the log; only bubble chats can start over. */
          if (b.newConversation !== true) return json(res, 409, { error: `${to.name} keeps its conversation elsewhere; the session would lose its history. Send newConversation:true to start over` });
          if (s.mode !== 'json') return json(res, 409, { error: 'a terminal session cannot start over on another account; open a new session' });
          db.updateSession(id, { agent_session: null });
        }
        const r = await switchSession(id, to.id, 'manual', false);
        return json(res, r.error ? 409 : 200, r.error ? r : db.getSession(id));
      }
      if (m[2] === '/wake' && req.method === 'POST') {
        const r = wake(id);
        return json(res, r.error ? 409 : 200, r.error ? r : db.getSession(id));
      }
      if (m[2] === '/chat/stop' && req.method === 'POST') return json(res, 200, { stopped: chat.stop(id) });
      if (m[2] === '/chat/pick' && req.method === 'POST')
        return pty.tuiPick(id, +(await readBody(req)).n) ? json(res, 200, { ok: true }) : json(res, 409, { error: 'the terminal is not asking anything now' });
      if (m[2] === '/chat/tui-close' && req.method === 'POST') {
        await openingTui.get(id)?.catch(() => {});
        await chat.closeTui(id); return json(res, 200, { ok: true });
      }
      if (m[2] === '/chat/approve' && req.method === 'POST') {
        try { await chat.approve(id, (await readBody(req)).decision === 'y'); return json(res, 202, { ok: true }); }
        catch (err) { return json(res, 409, { error: String(err.message || err) }); }
      }
      if (m[2] === '/git') {
        const s = db.getSession(id);
        if (!s.branch) return json(res, 409, { error: 'this session works in the project folder, not on its own branch' });
        if (s.ssh) return json(res, 409, { error: 'ssh sessions have no worktree' });
        if (s.device !== 'local') {
          /* The branch lives on that device: its worker reads and acts on it. */
          if (!(agents.get(s.device)?.meta?.gitProtocol >= 1)) return json(res, 409, { error: `${s.device}: update the XBLabs worker there to read its branches (Settings → Devices → Update)` });
          if (req.method === 'GET') {
            const r = await askAgent(s.device, { type: 'git', cwd: s.cwd, action: 'changes' }, 20000);
            if (r.error) return json(res, 409, { error: r.error });
            const { type, req: _r, ...data } = r;
            return json(res, 200, { ...data, device: s.device, hubRepo: hubRepoFor(s) });
          }
          if (req.method === 'POST') {
            const { action, message, repo, merge } = await readBody(req);
            if (action === 'discard' && pty.isLive(id)) return json(res, 409, { error: 'stop the session first' });
            if (action === 'hub') return json(res, ...await bringToHub(s, repo, !!merge));
            const { type: _t, req: _q, ...r } = await askAgent(s.device, { type: 'git', cwd: s.cwd, action, message }, action === 'push' || action === 'pr' ? 120000 : 30000);
            evlog.log(r.error ? 'warn' : 'info', s.ws, `${id} git ${action} on ${s.device} · ${r.error || r.said}`);
            if (r.removed) db.updateSession(id, { cwd: r.top, branch: null });
            return json(res, r.error ? 409 : 200, r);
          }
        }
        try {
          if (req.method === 'GET') return json(res, 200, { ...worktree.changes(s.cwd), overlap: overlapFor(s) });
          if (req.method === 'POST') {
            const { action, message } = await readBody(req);
            if (action === 'discard' && pty.isLive(id)) return json(res, 409, { error: 'stop the session first' });
            const r = await worktree.act(s.cwd, action, { message });
            evlog.log(r.error ? 'warn' : 'info', s.ws, `${id} git ${action} · ${r.error || r.said}`);
            if (r.removed) db.updateSession(id, { cwd: r.top, branch: null });
            return json(res, r.error ? 409 : 200, r);
          }
        } catch (err) { return json(res, 409, { error: String(err.message || err).split('\n')[0] }); }
      }
      if (m[2] === '/approve' && req.method === 'POST') {
        const { decision } = await readBody(req);
        if (!['y', 'n', 'esc'].includes(decision)) return json(res, 400, { error: "decision must be y | n | esc" });
        /* A bubble chat's approval card (answered from a notification, not the card itself): answer
           the card, so the chat, its status and the notification move on together. */
        if (decision !== 'esc' && db.listEvents(id, 0).some((e) => e.kind === 'approval' && e.data.state === 'pending')) {
          try { await chat.approve(id, decision === 'y'); } catch (err) { return json(res, 409, { error: String(err.message || err) }); }
          evlog.log(decision === 'y' ? 'info' : 'warn', 'approval', `${id} ${decision === 'y' ? 'approved' : 'denied'} (chat)`);
          return json(res, 200, db.getSession(id));
        }
        pty.write(id, decision === 'esc' ? '\x1b' : decision + '\r');
        db.updateSession(id, { status: decision === 'y' ? 'running' : 'rejected' });
        evlog.log(decision === 'y' ? 'info' : 'warn', 'approval', `${id} ${decision === 'y' ? 'approved' : 'rejected'}`);
        return json(res, 200, db.getSession(id));
      }
      if (m[2] === '/log' && req.method === 'GET') return json(res, 200, { data: db.readLog(id) });
      if (m[2] === '/summary' && req.method === 'GET') return json(res, 200, await runSummary(db.getSession(id)));
      if (req.method === 'GET') return json(res, 200, db.getSession(id));
      if (req.method === 'PATCH') return json(res, 200, db.updateSession(id, await readBody(req)));
      if (req.method === 'DELETE') { chat.stop(id); pty.kill(id); db.deleteSession(id); return json(res, 200, { ok: true }); }
    }

    /* One-line agent install for other devices (server/install.mjs). Code only, no secrets. */
    if ((p === '/install.sh' || p === '/install.ps1') && req.method === 'GET') {
      if (!install.okHost(req.headers.host)) return json(res, 400, { error: 'bad host header' });
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(install.script(p.endsWith('ps1') ? 'ps1' : 'sh', req.headers.host));
    }
    if (p.startsWith('/agent/pkg/') && req.method === 'GET') {
      const body = install.file(p.slice('/agent/pkg/'.length), url.searchParams.get('os') || '');
      if (body == null) return json(res, 404, { error: 'not an agent file' });
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(body);
    }

    if (p.startsWith('/api/')) return json(res, 404, { error: 'no such endpoint' });
    return serveStatic(req, res, p === '/' ? '/index.html' : p);
  } catch (err) {
    console.error('[xblabs]', err);
    json(res, 500, { error: String(err.message || err) });
  }
});

/* Agents dial out to the hub: no inbound port, no router config on the remote machine. */
const agentWss = new WebSocketServer({ noServer: true });
agentWss.on('connection', (ws, req) => {
  const q = new URL(req.url, 'http://x').searchParams;
  const name = (q.get('name') || '').trim().slice(0, 40);
  const token = q.get('token') || '';
  if (!name) return ws.close(1008, 'name required');
  const need = process.env.XBLABS_TOKEN;
  /* Came in on the tailnet listener: Tailscale already said who this is, no token needed. */
  const viaTailnet = !!tsListenIp && String(req.socket.localAddress || '').replace(/^::ffff:/, '') === tsListenIp;
  if (need && token !== need && !viaTailnet) { evlog.log('warn', 'agent', `rejected ${name} — bad token`); return ws.close(1008, 'bad token'); }

  const rec = { ws, meta: {}, cpu: null, ram: null, since: Date.now() };
  agents.set(name, rec);
  evlog.log('info', name, 'agent attached');

  ws.on('message', (raw) => {
    if (agents.get(name) !== rec) return;
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.type === 'hello') {
      rec.meta = m;
      evlog.log('info', name, `agent hello · ${m.platform} ${m.release} · ${m.cores} cores`);
    }
    if (m.type === 'stats') {
      rec.cpu = m.cpu ?? null; rec.ram = m.ram ?? null;
      rec.ramUsed = m.ramUsed ?? null; rec.ramTotal = m.ramTotal ?? null;
      rec.disk = m.disk ?? null; rec.uptimeH = m.uptimeH ?? null;
      rec.runs = m.runs ?? 0;
    }
    if (m.type === 'spawned' && !pty.isTui(m.id)) db.updateSession(m.id, {
      status: 'running', pid: m.pid ?? null,
      ...(typeof m.cwd === 'string' && typeof m.branch === 'string' ? { cwd: m.cwd, branch: m.branch } : {}),
    });
    if (m.type === 'ls-result' && asks.has(m.req)) asks.get(m.req)(m);
    if (m.type === 'chat-data' || m.type === 'chat-exit') remoteTurns.receive(name, m);
    if (m.type === 'data' && typeof m.data === 'string') pty.pump(m.id, m.data);
    if (m.type === 'exit') pty.finish(m.id, m.code | 0);
  });

  ws.on('close', () => {
    if (agents.get(name) !== rec) return;   // an old connection cannot detach its replacement
    agents.delete(name);
    remoteTurns.disconnect(name);
    evlog.log('warn', name, 'agent detached');
    /* SQLite LIMIT -1 includes old active sessions, however much newer history exists. */
    for (const s of db.listSessions({ limit: -1 })) {
      if (s.device === name && (pty.isLive(s.id) || ['starting', 'running', 'waiting'].includes(s.status))) pty.finish(s.id, 1);
    }
  });
});

const ptyWss = new WebSocketServer({ noServer: true });
const browserWss = new WebSocketServer({ noServer: true });

/* Two ws servers on one http server: a `path` option makes each one abort the other's upgrades,
   so route the upgrade by hand instead. */
server.on('upgrade', (req, socket, head) => {
  const p = new URL(req.url, 'http://x').pathname;
  const target = p === '/agent' ? agentWss : p === '/pty' ? ptyWss : p === '/browser' ? browserWss : null;
  if (!target) return socket.destroy();
  target.handleUpgrade(req, socket, head, (ws) => target.emit('connection', ws, req));
});

ptyWss.on('connection', async (ws, req) => {
  const q = new URL(req.url, 'http://x').searchParams, id = q.get('session');
  if (!id || !db.getSession(id)) return ws.close(1008, 'unknown session');
  try {
    if (db.getSession(id).mode === 'json') await openSessionTui(id);
  } catch (err) {
    if (ws.readyState === 1) { ws.send(JSON.stringify({ type: 'error', error: err.message })); ws.close(1011, 'terminal unavailable'); }
    return;
  }
  if (ws.readyState !== 1) return;
  pty.attach(id, ws);
  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === 'input' && typeof msg.data === 'string') pty.write(id, msg.data);
    if (msg.type === 'resize') pty.resize(id, msg.cols | 0, msg.rows | 0);
    if (msg.type === 'kill') pty.write(id, '\x03');
  });
});

/* Loopback by default, plus the Tailscale IP when on a tailnet (listenTailnet). Set XBLABS_HOST=0.0.0.0 for other networks (LAN). */
/* Hibernate: stop the agent's process, keep the row. Reopening resumes through the agent's own
   resume path (pty.ensure reads the log; a bubble chat's next turn passes agent_session). */
const liveAgents = () => new Set([...pty.liveIds(), ...chat.busyIds()].filter((i) => (db.getSession(i) || {}).agent !== 'shell')).size;
const agentLimitError = () => limitError(db.hubSettings().session.maxAgents, liveAgents());
function hibernate(id, force) {
  const s = db.getSession(id);
  if (s.status === 'hibernated') return { ok: true };
  if (s.device && s.device !== 'local') return { error: 'only sessions on this hub can hibernate' };
  /* A terminal agent without status hooks reads 'running' even when it waits for input: quiet = not busy. */
  const quietTui = s.status === 'running' && s.kind === 'chat' && s.mode !== 'json' && pty.quietFor(id) > 15000;
  if (!force && (chat.busy(id) || (['running', 'waiting', 'starting'].includes(s.status) && !quietTui))) return { error: 'the agent is busy; retry with force to stop it mid-turn' };
  if (s.mode !== 'json' && !pty.isLive(id)) return { error: 'session is not running' };
  db.updateSession(id, { status: 'hibernated', pid: null });   // first, so the exit handlers keep it
  chat.stop(id); pty.kill(id);
  evlog.log('info', s.ws, `${id} hibernated`);
  return { ok: true };
}
function wake(id) {
  const s = db.getSession(id);
  if (s.status !== 'hibernated') return { error: 'session is not hibernated' };
  if (s.mode === 'json') { db.updateSession(id, { status: 'idle' }); return { ok: true }; }   // no process until its next message
  const e = agentLimitError();
  if (e) return { error: e };
  db.updateSession(id, { status: 'starting' });
  if (!pty.ensure(id)) return { error: 'could not start the agent' };
  return { ok: true };
}
/* Move a session to another config: stop it, set config_id, wake it so it resumes on the new
   env. Mid-turn (cont) it is told to carry on. */
async function switchSession(id, toId, kind, cont, detail = '') {
  const s = db.getSession(id);
  if (s.device && s.device !== 'local') return { error: 'only sessions on this hub can switch config' };
  const wasHib = s.status === 'hibernated';
  if (!wasHib) { const h = hibernate(id, true); if (h.error && !/not running/.test(h.error)) return h; }
  db.updateSession(id, { config_id: toId });
  db.addAccountLog({ session_id: id, agent: s.agent, from_config: s.config_id || '', to_config: toId, kind, detail });
  if (!wasHib && db.getSession(id).status === 'hibernated') {
    if (s.mode !== 'json') await new Promise((r) => setTimeout(r, 1500));   // the killed process must finish exiting before the new one takes the slot
    const w = wake(id);
    if (w.error) return w;
    if (cont) setTimeout(() => {
      const text = 'Continue where you left off.';
      if (s.mode === 'json') chat.send(id, text).catch((err) => evlog.log('warn', s.ws, `${id} continue · ${err.message}`));
      else pty.write(id, text + '\r');
    }, s.mode === 'json' ? 500 : 4000);
  }
  evlog.log('info', s.ws, `${id} now on config ${toId || 'official'} (${kind})`);
  return { ok: true };
}

/* A usage limit seen in an agent's output: mark that config limited, log it, tell me. With
   accounts.fallback on, the session moves to the next config. */
pty.events.on('limit', async (id, { until, text }) => {
  const s = db.getSession(id);
  if (!s || s.kind === 'shell') return;
  const all = () => db.configsFor(s.agent);
  const from = all().find((c) => c.id === (s.config_id || '')) || all()[0];
  db.setConfigLimit(s.agent, from.id, until);
  db.addAccountLog({ session_id: id, agent: s.agent, from_config: from.id, kind: 'limit', detail: text });
  const until_ = new Date(until).toTimeString().slice(0, 5);
  evlog.log('warn', s.ws, `${id} ${s.agent} ${from.name} hit a usage limit until ${until_}`);
  notify(`${s.title}: ${s.agent} (${from.name}) hit a usage limit until ${until_}`);
  if (!db.hubSettings().accounts.fallback) return;
  const next = pickConfig(all(), s.agent, Date.now());
  if (!next) { notify(`${s.agent}: every config is at its limit`); return; }
  if (!sharesConversation(from, next) || (AGENTS[s.agent] && AGENTS[s.agent].pinsProvider)) {
    db.addAccountLog({ session_id: id, agent: s.agent, from_config: from.id, to_config: next.id, kind: 'fallback', detail: 'different storage: not switched' });
    notify(`${s.agent}: limit hit; new sessions will start on ${next.name}`);
    return;
  }
  const r = await switchSession(id, next.id, 'fallback', true, text);
  if (r.error) evlog.log('warn', s.ws, `${id} fallback to ${next.name} failed · ${r.error}`);
  else notify(`${s.title}: moved to ${next.name}`);
});

setInterval(() => {
  const afterMin = db.hubSettings().session.hibernateAfter;
  const live = new Set(pty.liveIds());
  for (const id of idleToHibernate([...db.listSessions({ status: 'idle', limit: 2000 }), ...db.listSessions({ status: 'running', limit: 2000 })], { now: Date.now(), afterMin, headId: goa.headId(), live, busy: new Set(chat.busyIds()), quiet: pty.quietFor })) hibernate(id, true);   // idleToHibernate already left out busy, asking and head sessions
}, 60000).unref();

decide.start({ db, pty, chat, notify, headId: goa.headId });
/* On a tailnet already: also listen on this host's Tailscale IP, so agents on the user's other
   devices reach the hub with no XBLABS_HOST and no token. Only tailnet peers can route there.
   An explicit XBLABS_HOST turns this off. Tailscale started after the hub needs a hub restart. */
let tsListenIp = '';
async function listenTailnet() {
  if (process.env.XBLABS_HOST) return;
  const ts = await tailscale.status().catch(() => ({}));
  if (!/^100\.\d+\.\d+\.\d+$/.test(ts.ip || '')) return;
  netServer((sock) => server.emit('connection', sock))
    .on('listening', () => { tsListenIp = ts.ip; evlog.log('info', 'tailscale', `hub on the tailnet · ws://${ts.ip}:${PORT}`); })
    .on('error', (err) => evlog.log('warn', 'tailscale', `tailnet listen failed · ${err.message}`))
    .listen(PORT, ts.ip);
}
server.listen(PORT, process.env.XBLABS_HOST || '127.0.0.1', () => {
  listenTailnet();
  console.log(`[xblabs] http://127.0.0.1:${PORT}  root=${ROOT}  db=${process.env.XBLABS_DB || 'data/xblabs.db'}`);
  try { goa.init(); } catch (err) { evlog.log('warn', 'goa', `xb CLI not written · ${err.message}`); }   // xb on PATH for every session
  /* Worktree sessions from before `origin` was kept: their project is the worktree's main repo. */
  for (const s of db.listSessions({ limit: 2000 })) {
    if (s.origin || !s.branch || (s.device || 'local') !== 'local' || !s.cwd || !existsSync(s.cwd)) continue;
    try {
      const common = execFileSync('git', ['-C', s.cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8', windowsHide: true, timeout: 5000 }).trim();
      if (common) db.updateSession(s.id, { origin: resolve(common, '..') });
    } catch { /* not a git worktree any more */ }
  }
});

const bye = () => { pty.killAll(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 800); };
process.on('SIGINT', bye); process.on('SIGTERM', bye);

/* Screencast of a session's browser tab; runs only while a client is connected. */
browserWss.on('connection', async (ws, req) => {
  const q = new URL(req.url, 'http://x').searchParams, id = q.get('session');
  if (!id || !db.getSession(id)) return ws.close(1008, 'unknown session');
  let off = null, gone = false;
  ws.on('close', () => { gone = true; off?.(); });
  try {
    const un = await browser.watch(id, (m) => ws.readyState === 1 && ws.send(JSON.stringify(m)), q.get('tab') || undefined);
    gone ? un() : (off = un);
  } catch (e) { ws.send(JSON.stringify({ type: 'error', error: e.message })); }
});
