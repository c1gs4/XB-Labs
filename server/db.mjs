// SQLite layer. node:sqlite is built into Node 26 — no better-sqlite3, no ORM.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync, readdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, statSync, utimesSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { configEnv, endpointEnv, validateConfig, pickConfig } from './accounts.mjs';

const DB_PATH = process.env.XBLABS_DB || join(process.cwd(), 'data', 'xblabs.db');
if (DB_PATH !== ':memory:') mkdirSync(dirname(DB_PATH), { recursive: true });

/* Notes live as plain .txt files in their own folder next to the database (data/Notes by
   default); sqlite keeps only what a text file cannot: workspace, tags, pin. */
export const NOTES_DIR = DB_PATH === ':memory:' ? null : process.env.XBLABS_NOTES || join(dirname(DB_PATH), 'Notes');
if (NOTES_DIR) mkdirSync(NOTES_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS jobs (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  prompt      TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'running',
  created_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  job_id      TEXT REFERENCES jobs(id) ON DELETE CASCADE,
  ws          TEXT NOT NULL DEFAULT 'xblabs-web',
  title       TEXT NOT NULL,
  prompt      TEXT NOT NULL DEFAULT '',
  cwd         TEXT NOT NULL,
  device      TEXT NOT NULL DEFAULT 'local',
  agent       TEXT NOT NULL DEFAULT 'shell',
  kind        TEXT NOT NULL DEFAULT 'chat',
  ssh         TEXT,
  model       TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'starting',
  pid         INTEGER,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS terminal_log (
  session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,
  data        TEXT NOT NULL,
  PRIMARY KEY (session_id, seq)
);
CREATE TABLE IF NOT EXISTS notes (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  body        TEXT NOT NULL DEFAULT '',
  ws          TEXT NOT NULL DEFAULT 'xblabs-web',
  tags        TEXT NOT NULL DEFAULT '',
  pinned      INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
/* A project XBLabs forgets. The folder on disk is never touched — this only hides the row
   and drops the session records that pointed at it. */
CREATE TABLE IF NOT EXISTS projects_hidden (
  ws         TEXT PRIMARY KEY,
  hidden_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS project_folders (
  ws         TEXT NOT NULL,
  device     TEXT NOT NULL,
  cwd        TEXT NOT NULL,
  PRIMARY KEY (ws, device, cwd)
);

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_job ON sessions(job_id);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
`);

/* Added after the first schema: the git branch a job run works on (its own worktree). */
try { db.exec('ALTER TABLE sessions ADD COLUMN branch TEXT'); } catch { /* already there */ }
try { db.exec('ALTER TABLE sessions ADD COLUMN parent TEXT'); } catch { /* already there */ }
try { db.exec('ALTER TABLE sessions ADD COLUMN origin TEXT'); } catch { /* already there */ }   // project folder a worktree session came from   // GOA worker: its head session

/* Runs are children of this process: a pid left over from a previous boot is dead weight, not 'running'. */
db.prepare("UPDATE sessions SET status = 'stopped', pid = NULL WHERE pid IS NOT NULL").run();

const now = () => Date.now();
export const uid = (p) => `${p}_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;

/* --- jobs ------------------------------------------------------------- */
export function createJob({ title, prompt, ws = 'xblabs-web' }) {
  const id = uid('job');
  db.prepare('INSERT INTO jobs (id,title,prompt,status,created_at) VALUES (?,?,?,?,?)')
    .run(id, title, prompt, 'running', now());
  return getJob(id);
}

export function getJob(id) {
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
  if (!job) return null;
  job.runs = db.prepare('SELECT * FROM sessions WHERE job_id = ? ORDER BY created_at').all(id);
  return job;
}

export function listJobs(limit = 50) {
  const jobs = db.prepare('SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?').all(limit);
  const stmt = db.prepare('SELECT * FROM sessions WHERE job_id = ? ORDER BY created_at');
  return jobs.map((j) => ({ ...j, runs: stmt.all(j.id) }));
}

export function setJobStatus(id, status) {
  db.prepare('UPDATE jobs SET status = ? WHERE id = ?').run(status, id);
}

/* --- sessions --------------------------------------------------------- */
export function createSession({ job_id = null, ws = 'xblabs-web', title, prompt = '', cwd, device = 'local', agent = 'shell', model = '', kind = 'chat', parent = null, config, llm_model = '' }) {
  const id = uid('ses');
  const config_id = resolveConfigId(agent, config);
  const t = now();
  /* A new run in a forgotten project brings it back — hiding is not a permanent ban. */
  db.prepare('DELETE FROM projects_hidden WHERE ws = ?').run(ws);
  db.prepare(`INSERT INTO sessions (id,job_id,ws,title,prompt,cwd,device,agent,kind,model,status,created_at,updated_at,parent)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, job_id, ws, title, prompt, cwd, device, agent, kind, model, 'starting', t, t, parent);
  if (config_id) db.prepare('UPDATE sessions SET config_id = ? WHERE id = ?').run(config_id, id);
  if (llm_model) db.prepare('UPDATE sessions SET llm_model = ?, model = ? WHERE id = ?').run(llm_model, llm_model, id);
  if (kind === 'chat') rememberProject({ ws, device, cwd });
  if (job_id) addRequest(id, agent);   // a job run is a request too
  return getSession(id);
}

export function getSession(id) {
  return db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) ?? null;
}

export function listSessions({ status, job, kind, limit = 200 } = {}) {
  const where = [];
  const args = [];
  if (status) { where.push('status = ?'); args.push(status); }
  if (job) { where.push('job_id = ?'); args.push(job); }
  if (kind) { where.push('kind = ?'); args.push(kind); }
  const sql = `SELECT * FROM sessions ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               ORDER BY created_at DESC LIMIT ?`;
  return db.prepare(sql).all(...args, limit);
}

export function updateSession(id, patch) {
  const keys = Object.keys(patch).filter((k) => ['title', 'status', 'pid', 'model', 'agent', 'cwd', 'ws', 'ssh', 'kind', 'branch', 'mode', 'agent_session', 'parent', 'origin', 'config_id', 'approval'].includes(k));
  if (!keys.length) return getSession(id);
  const sql = `UPDATE sessions SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`;
  db.prepare(sql).run(...keys.map((k) => patch[k]), now(), id);
  return getSession(id);
}

export function deleteSession(id) {
  const s = getSession(id);
  if (s?.kind === 'chat') rememberProject(s);
  db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
}

function rememberProject({ ws, device, cwd, origin }) {
  db.prepare('INSERT OR IGNORE INTO project_folders (ws, device, cwd) VALUES (?, ?, ?)').run(ws, device, origin || cwd);
}
export function forgetProject({ ws, device, cwd }) {
  db.prepare('DELETE FROM project_folders WHERE ws = ? AND device = ? AND cwd = ?').run(ws, device, cwd);
}
export function listProjects() {
  return db.prepare('SELECT ws, device, cwd FROM project_folders ORDER BY ws, device, length(cwd), cwd').all();
}

export function hideProject(ws) {
  db.prepare('INSERT OR REPLACE INTO projects_hidden (ws, hidden_at) VALUES (?, ?)').run(ws, now());
}
export function unhideProject(ws) {
  db.prepare('DELETE FROM projects_hidden WHERE ws = ?').run(ws);
}
export function hiddenProjects() {
  return db.prepare('SELECT ws, hidden_at FROM projects_hidden ORDER BY hidden_at DESC').all();
}

/* Clear a workspace's session list without touching the folder on disk. */
export function deleteSessionsBy({ ws, kind }) {
  const where = [];
  const args = [];
  if (ws) { where.push('ws = ?'); args.push(ws); }
  if (kind) { where.push('kind = ?'); args.push(kind); }
  if (!where.length) return 0;
  for (const s of db.prepare(`SELECT * FROM sessions WHERE ${where.join(' AND ')} AND kind = 'chat'`).all(...args)) rememberProject(s);
  const ids = db.prepare(`SELECT id FROM sessions WHERE ${where.join(' AND ')}`).all(...args).map((r) => r.id);
  db.prepare(`DELETE FROM sessions WHERE ${where.join(' AND ')}`).run(...args);
  return ids;
}

/* --- terminal scrollback (ring, 500 chunks/session) -------------------- */
export function appendLog(sessionId, data) {
  const row = db.prepare('SELECT COALESCE(MAX(seq),0) AS m FROM terminal_log WHERE session_id = ?').get(sessionId);
  db.prepare('INSERT INTO terminal_log (session_id, seq, data) VALUES (?,?,?)').run(sessionId, row.m + 1, data);
  if (row.m > 500) db.prepare('DELETE FROM terminal_log WHERE session_id = ? AND seq <= ?').run(sessionId, row.m - 500);
}

export function readLog(sessionId) {
  return db.prepare('SELECT data FROM terminal_log WHERE session_id = ? ORDER BY seq').all(sessionId)
    .map((r) => r.data).join('');
}

/* --- notes ------------------------------------------------------------- */
/* The file is named after the title; a clash with another note's file gets the id appended. */
function noteFileName(title, id) {
  const base = String(title || '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '-').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '').slice(0, 80) || 'Untitled';
  const taken = db.prepare('SELECT 1 FROM notes WHERE file = ? COLLATE NOCASE AND id != ?');
  return taken.get(`${base}.txt`, id) ? `${base} (${id.slice(-6)}).txt` : `${base}.txt`;
}
/* Write the note's body to its file (renaming it when the title changed) and stamp the file's
   mtime with updated_at, so a later edit made outside the app is the only way the two differ. */
function writeNoteFile(n) {
  if (!NOTES_DIR || !n) return n;
  const name = noteFileName(n.title, n.id);
  if (n.file && n.file !== name && existsSync(join(NOTES_DIR, n.file))) renameSync(join(NOTES_DIR, n.file), join(NOTES_DIR, name));
  const path = join(NOTES_DIR, name);
  writeFileSync(path, n.body ?? '', 'utf8');
  utimesSync(path, new Date(), new Date(n.updated_at));
  if (n.file !== name) db.prepare('UPDATE notes SET file = ? WHERE id = ?').run(name, n.id);
  return { ...n, file: name };
}
/* Folder → sqlite: a file edited elsewhere wins over the stored body, a file dropped into the
   folder becomes a note, a note whose file went missing is written back (never lost). */
function syncNotesFolder() {
  if (!NOTES_DIR) return;
  const rows = db.prepare('SELECT * FROM notes').all();
  const known = new Set(rows.map((r) => r.file).filter(Boolean));
  for (const n of rows) {
    const path = n.file && join(NOTES_DIR, n.file);
    if (!path || !existsSync(path)) { writeNoteFile(n); continue; }
    const m = statSync(path).mtimeMs;
    if (m > n.updated_at + 1000) {
      db.prepare('UPDATE notes SET body = ?, updated_at = ? WHERE id = ?').run(readFileSync(path, 'utf8'), Math.round(m), n.id);
    }
  }
  for (const f of readdirSync(NOTES_DIR)) {
    if (!f.toLowerCase().endsWith('.txt') || known.has(f)) continue;
    const path = join(NOTES_DIR, f);
    const id = uid('nte'); const t = Math.round(statSync(path).mtimeMs);
    db.prepare('INSERT INTO notes (id,title,body,ws,tags,pinned,file,created_at,updated_at) VALUES (?,?,?,?,?,0,?,?,?)')
      .run(id, f.replace(/\.txt$/i, ''), readFileSync(path, 'utf8'), 'xblabs-web', '', f, t, t);
  }
}
export function listNotes() {
  syncNotesFolder();
  return db.prepare('SELECT * FROM notes ORDER BY pinned DESC, updated_at DESC').all();
}
export function createNote({ title, body = '', ws = 'xblabs-web', tags = '' }) {
  const id = uid('nte'); const t = now();
  db.prepare('INSERT INTO notes (id,title,body,ws,tags,pinned,created_at,updated_at) VALUES (?,?,?,?,?,0,?,?)')
    .run(id, title, body, ws, tags, t, t);
  return writeNoteFile(db.prepare('SELECT * FROM notes WHERE id = ?').get(id));
}
export function updateNote(id, patch) {
  const keys = Object.keys(patch).filter((k) => ['title', 'body', 'ws', 'tags', 'pinned'].includes(k));
  if (!keys.length) return db.prepare('SELECT * FROM notes WHERE id = ?').get(id);
  db.prepare(`UPDATE notes SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
    .run(...keys.map((k) => patch[k]), now(), id);
  return writeNoteFile(db.prepare('SELECT * FROM notes WHERE id = ?').get(id));
}
export function deleteNote(id) {
  const n = db.prepare('SELECT file FROM notes WHERE id = ?').get(id);
  db.prepare('DELETE FROM notes WHERE id = ?').run(id);
  if (NOTES_DIR && n && n.file && existsSync(join(NOTES_DIR, n.file))) unlinkSync(join(NOTES_DIR, n.file));
}

/* --- aggregates -------------------------------------------------------- */
export function usageSummary() {
  const perStatus = db.prepare('SELECT status, COUNT(*) n FROM sessions GROUP BY status').all();
  const bytes = db.prepare('SELECT s.id, s.device, COALESCE(SUM(LENGTH(l.data)),0) b FROM sessions s LEFT JOIN terminal_log l ON l.session_id = s.id GROUP BY s.id').all();
  const perDevice = {};
  for (const r of bytes) perDevice[r.device] = (perDevice[r.device] || 0) + r.b;
  const perDay = db.prepare(`SELECT strftime('%Y-%m-%d', created_at/1000, 'unixepoch', 'localtime') d, COUNT(*) n
                             FROM sessions GROUP BY d ORDER BY d DESC LIMIT 14`).all().reverse();
  const total = bytes.reduce((a, r) => a + r.b, 0);
  return {
    runs: bytes.length, bytes: total, perStatus,
    perDevice: Object.entries(perDevice).map(([name, b]) => ({ name, bytes: b, pct: total ? Math.round((b / total) * 100) : 0 })).sort((a, b) => b.bytes - a.bytes),
    perDay,
  };
}

export function deviceRows() {
  /* runs = chat sessions on the device (what its Sessions column shows); live/waiting cover
     every PTY, since a busy job or shell still means the machine is working. */
  return db.prepare(`SELECT device, SUM(CASE WHEN kind = 'chat' THEN 1 ELSE 0 END) runs,
      SUM(CASE WHEN status IN ('running','starting') THEN 1 ELSE 0 END) live,
      SUM(CASE WHEN status = 'waiting' THEN 1 ELSE 0 END) waiting,
      MAX(updated_at) seen, GROUP_CONCAT(DISTINCT ws) workspaces
    FROM sessions GROUP BY device`).all();
}

/* ---------- settings: one place for the LLM endpoint every run inherits ---------- */
export function getSetting(key, fallback = '') {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

export function setSetting(key, value) {
  db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .run(key, value ?? '', Date.now());
}

/* Masked view for the UI: the key itself never leaves the server in full. */
export function llmSettings() {
  const key = getSetting('llm.api_key');
  return {
    base_url: getSetting('llm.base_url'),
    model: getSetting('llm.model'),
    has_key: !!key,
    key_hint: key ? `${key.slice(0, 3)}…${key.slice(-4)}` : '',
    models: llmModels(),
  };
}

/* The model catalog: endpoint model ids, each with the short name the composer shows.
   Stored as JSON in settings; a bad value reads as an empty list, never a crash. */
export function llmModels() {
  try {
    const list = JSON.parse(getSetting('llm.models') || '[]');
    return Array.isArray(list) ? list.filter((m) => m && typeof m.id === 'string' && m.id) : [];
  } catch { return []; }
}
export function setLlmModels(list) {
  if (!Array.isArray(list) || list.length > 200) throw new Error('models must be a list of at most 200 entries');
  const clean = list.map((m) => ({ id: String(m?.id ?? '').trim().slice(0, 200), name: String(m?.name ?? '').trim().slice(0, 80) }))
    .filter((m) => m.id);
  setSetting('llm.models', JSON.stringify(clean));
  return clean;
}

/* Agents (registry ids, or 'shell') whose runs get the endpoint env. Empty by default: an
   agent starts with its own login and config unless it is switched on here. */
export function llmAgents() {
  try {
    const list = JSON.parse(getSetting('llm.agents') || '[]');
    return Array.isArray(list) ? list.filter((a) => typeof a === 'string') : [];
  } catch { return []; }
}
export function setLlmAgents(list) {
  setSetting('llm.agents', JSON.stringify([...new Set(list)]));
  return llmAgents();
}

/* Env that points a run at the saved endpoint. With an agent given, only when that agent is
   switched on; with none, the full set (what Settings lists). */
export function llmEnv(agent, pick = '') {
  if (agent !== undefined && !llmAgents().includes(agent)) return {};
  const base = getSetting('llm.base_url');
  const key = getSetting('llm.api_key');
  const model = pick || getSetting('llm.model');   // a session may pick its own model on the same endpoint
  if (!base && !key) return {};
  return endpointEnv({ base_url: base, api_key: key, model });
}

/* Migration for DBs created before sessions.kind: shells are not chat sessions. */
try { db.exec("ALTER TABLE sessions ADD COLUMN kind TEXT NOT NULL DEFAULT 'chat'"); } catch { /* column exists */ }
try { db.exec("ALTER TABLE sessions ADD COLUMN ssh TEXT"); } catch { /* column exists */ }
try { db.exec("ALTER TABLE notes ADD COLUMN file TEXT"); } catch { /* column exists */ }
db.prepare("UPDATE sessions SET kind = 'shell' WHERE kind = 'chat' AND agent = 'shell' AND title LIKE '% · shell'").run();
/* Three kinds of row: 'chat' is a session the user opened and talks in, 'job' is a temporary run
   an agent spawned for a job (it has a job_id), 'shell' is a terminal. Older DBs stored job runs
   as 'chat', so they showed up as sessions. */
db.prepare("UPDATE sessions SET kind = 'job' WHERE kind = 'chat' AND job_id IS NOT NULL").run();
db.exec("INSERT OR IGNORE INTO project_folders (ws, device, cwd) SELECT ws, device, COALESCE(origin, cwd) FROM sessions WHERE kind = 'chat'");

/* --- GOA tasks: what the head agent handed to which worker session ------- */
db.exec(`CREATE TABLE IF NOT EXISTS goa_tasks (
  id          TEXT PRIMARY KEY,
  session_id  TEXT,
  project     TEXT NOT NULL,
  device      TEXT NOT NULL DEFAULT 'local',
  agent       TEXT NOT NULL,
  prompt      TEXT NOT NULL,
  branch      INTEGER NOT NULL DEFAULT 1,
  status      TEXT NOT NULL DEFAULT 'queued',
  outcome     TEXT,
  note        TEXT,
  question    TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
)`);
export function createTask({ project, device = 'local', agent, prompt, branch = true, session_id = null }) {
  const id = uid('t');
  db.prepare('INSERT INTO goa_tasks (id,session_id,project,device,agent,prompt,branch,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(id, session_id, project, device, agent, prompt, branch ? 1 : 0, 'queued', now(), now());
  return getTask(id);
}
export const getTask = (id) => db.prepare('SELECT * FROM goa_tasks WHERE id = ?').get(id) ?? null;
export const listTasks = (limit = 500) => db.prepare('SELECT * FROM goa_tasks ORDER BY created_at DESC LIMIT ?').all(limit);
export function updateTask(id, patch) {
  const keys = Object.keys(patch).filter((k) => ['session_id', 'status', 'outcome', 'note', 'question'].includes(k));
  if (keys.length) db.prepare(`UPDATE goa_tasks SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...keys.map((k) => patch[k]), now(), id);
  return getTask(id);
}

/* --- hub settings (Settings → Sessions, Agents, Environment, GOA, Notifications) ----------
   One JSON value, read through defaults so a key added later is never undefined. */
const HUB_DEFAULTS = {
  session: { agent: '', worktree: true, skipPerms: false, hibernateAfter: 30, maxAgents: 0 },
  agents: {},                 // id -> { enabled, bin, flags }
  env: {},                    // NAME -> value, given to every session on this hub
  goa: { max: 4, stallMin: 10, rules: '' },
  notify: { push: '' },       // ntfy-style URL: POST text to it
  accounts: { fallback: false },             // at a usage limit move the session to the next agent config (an API config may cost money)
  decide: { approve: false, loop: false },   // Decisions: a cheap model answers safe approvals / stops loops
  custom: {},                 // id -> { name, command }: any terminal program as an agent
};
export function hubSettings() {
  let s = {};
  try { s = JSON.parse(getSetting('hub.settings') || '{}') || {}; } catch { /* bad value: defaults */ }
  const out = {};
  for (const [k, v] of Object.entries(HUB_DEFAULTS)) out[k] = { ...v, ...(s[k] && typeof s[k] === 'object' ? s[k] : {}) };
  return out;
}
/* Validated, so a bad request cannot store something a spawn would choke on. */
export function setHubSettings(patch = {}) {
  const cur = hubSettings();
  const str = (v, n = 400) => String(v ?? '').slice(0, n);
  if (patch.session) cur.session = {
    agent: str(patch.session.agent ?? cur.session.agent, 40),
    worktree: patch.session.worktree === undefined ? cur.session.worktree : !!patch.session.worktree,
    skipPerms: patch.session.skipPerms === undefined ? cur.session.skipPerms : !!patch.session.skipPerms,
    hibernateAfter: Math.min(10080, Math.max(0, Math.round(+(patch.session.hibernateAfter ?? cur.session.hibernateAfter)) || 0)),
    maxAgents: Math.min(64, Math.max(0, Math.round(+(patch.session.maxAgents ?? cur.session.maxAgents)) || 0)),
  };
  if (patch.agents && typeof patch.agents === 'object') for (const [id, a] of Object.entries(patch.agents)) {
    if (!/^[\w-]{1,40}$/.test(id) || !a || typeof a !== 'object') continue;
    cur.agents[id] = { enabled: a.enabled !== false, bin: str(a.bin, 300).trim(), flags: str(a.flags, 300).trim() };
  }
  if (patch.env && typeof patch.env === 'object') {
    const env = {};
    for (const [k, v] of Object.entries(patch.env)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(k)) throw new Error(`bad variable name: ${k}`);
      env[k] = str(v, 4000);
    }
    cur.env = env;
  }
  if (patch.goa) cur.goa = {
    max: Math.min(16, Math.max(1, Math.round(+patch.goa.max || cur.goa.max))),
    stallMin: Math.min(240, Math.max(1, Math.round(+patch.goa.stallMin || cur.goa.stallMin))),
    rules: str(patch.goa.rules ?? cur.goa.rules, 8000),
  };
  if (patch.notify) {
    const push = str(patch.notify.push, 400).trim();
    if (push && !/^https?:\/\//i.test(push)) throw new Error('push URL must start with http:// or https://');
    cur.notify = { push };
  }
  if (patch.decide) cur.decide = {
    approve: patch.decide.approve === undefined ? cur.decide.approve : patch.decide.approve === true,
    loop: patch.decide.loop === undefined ? cur.decide.loop : patch.decide.loop === true,
  };
  /* The whole list is replaced: ids are short slugs, a command is one line. */
  if (patch.custom && typeof patch.custom === 'object') {
    const custom = {};
    for (const [id, c] of Object.entries(patch.custom)) {
      if (!/^[a-z0-9][a-z0-9-]{0,29}$/.test(id)) throw new Error(`bad agent id: ${id} (a-z, 0-9, -)`);
      const command = str(c && c.command, 300).replace(/[\r\n]+/g, ' ').trim();
      if (!command) throw new Error(`agent ${id}: command required`);
      custom[id] = { name: str((c && c.name) || id, 40).trim() || id, command };
    }
    cur.custom = custom;
  }
  if (patch.accounts) cur.accounts = { fallback: patch.accounts.fallback === undefined ? cur.accounts.fallback : patch.accounts.fallback === true };
  setSetting('hub.settings', JSON.stringify(cur));
  return cur;
}

/* --- agent configs: other accounts / model APIs an agent can run on, and the log of switches ---
   The agent's own install is the "official" config, id ''; its limit lives in setting limit.<agent>. */
try { db.exec("ALTER TABLE sessions ADD COLUMN config_id TEXT NOT NULL DEFAULT ''"); } catch { /* already there */ }
try { db.exec("ALTER TABLE sessions ADD COLUMN llm_model TEXT NOT NULL DEFAULT ''"); } catch { /* already there */ }   // model picked at New session
db.exec(`CREATE TABLE IF NOT EXISTS agent_configs (
  id TEXT PRIMARY KEY, agent TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL,
  base_url TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '', api_key TEXT NOT NULL DEFAULT '', config_dir TEXT NOT NULL DEFAULT '',
  priority INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1, limited_until INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
  UNIQUE (agent, name)
);
CREATE TABLE IF NOT EXISTS account_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, time INTEGER NOT NULL, session_id TEXT, agent TEXT, from_config TEXT, to_config TEXT, kind TEXT NOT NULL, detail TEXT
)`);
export const getAgentConfig = (id) => db.prepare('SELECT * FROM agent_configs WHERE id = ?').get(id) ?? null;
export const listAgentConfigs = (agent) => (agent
  ? db.prepare('SELECT * FROM agent_configs WHERE agent = ? ORDER BY priority, created_at').all(agent)
  : db.prepare('SELECT * FROM agent_configs ORDER BY agent, priority, created_at').all());
/* Rows plus the official account as a pseudo-row, the shape pickConfig reads. */
export const officialConfig = (agent) => ({ id: '', agent, name: 'Official', kind: 'official', enabled: 1, priority: -1, limited_until: +getSetting(`limit.${agent}`, '0') || 0 });
export const configsFor = (agent) => [officialConfig(agent), ...listAgentConfigs(agent)];
export function addAgentConfig(c) {
  const v = validateConfig(c);
  const id = uid('cfg');
  const prio = db.prepare('SELECT COALESCE(MAX(priority), 0) + 1 AS p FROM agent_configs WHERE agent = ?').get(v.agent).p;
  try {
    db.prepare('INSERT INTO agent_configs (id, agent, name, kind, base_url, model, api_key, config_dir, priority, enabled, limited_until, created_at) VALUES (?,?,?,?,?,?,?,?,?,1,0,?)')
      .run(id, v.agent, v.name, v.kind, v.base_url, v.model, v.api_key, v.config_dir, c.priority !== undefined && Number.isFinite(+c.priority) ? Math.round(+c.priority) : prio, now());
  } catch (err) { throw new Error(/UNIQUE/.test(String(err.message)) ? `${v.agent} already has a config named ${v.name}` : err.message); }
  return getAgentConfig(id);
}
/* api_key changes only when a non-empty value is sent; clear_limit zeroes the limit. */
export function updateAgentConfig(id, patch) {
  const cur = getAgentConfig(id);
  if (!cur) return null;
  const next = { ...cur };
  for (const k of ['name', 'base_url', 'model', 'config_dir']) if (typeof patch[k] === 'string') next[k] = patch[k];
  if (typeof patch.api_key === 'string' && patch.api_key.trim()) next.api_key = patch.api_key;
  const v = validateConfig(next);
  next.priority = patch.priority === undefined ? cur.priority : Math.round(+patch.priority) || 0;
  next.enabled = patch.enabled === undefined ? cur.enabled : patch.enabled ? 1 : 0;
  next.limited_until = patch.clear_limit ? 0 : cur.limited_until;
  try {
    db.prepare('UPDATE agent_configs SET name=?, base_url=?, model=?, api_key=?, config_dir=?, priority=?, enabled=?, limited_until=? WHERE id=?')
      .run(v.name, v.base_url, v.model, v.api_key, v.config_dir, next.priority, next.enabled, next.limited_until, id);
  } catch (err) { throw new Error(/UNIQUE/.test(String(err.message)) ? `${cur.agent} already has a config named ${v.name}` : err.message); }
  return getAgentConfig(id);
}
export function deleteAgentConfig(id) {
  db.prepare("UPDATE sessions SET config_id = '' WHERE config_id = ?").run(id);
  return db.prepare('DELETE FROM agent_configs WHERE id = ?').run(id).changes > 0;
}
export function setConfigLimit(agent, configId, until) {
  if (configId) db.prepare('UPDATE agent_configs SET limited_until = ? WHERE id = ?').run(until, configId);
  else setSetting(`limit.${agent}`, String(until));
}
/* A config named by id or name for this agent ('official' = the official one); none = automatic. */
export function resolveConfigId(agent, config) {
  const all = configsFor(agent);
  let prefer = '';
  if (config !== undefined && config !== null && config !== '' && config !== 'auto') {
    const f = String(config).toLowerCase() === 'official' ? all[0] : all.find((c) => c.id === config || c.name === config);
    if (!f) throw new Error(`${agent} has no config ${config}`);
    prefer = f.id;
  }
  return (pickConfig(all, agent, Date.now(), prefer) ?? all[0]).id;
}
export function addAccountLog({ session_id = null, agent = '', from_config = '', to_config = '', kind, detail = '' }) {
  db.prepare('INSERT INTO account_log (time, session_id, agent, from_config, to_config, kind, detail) VALUES (?,?,?,?,?,?,?)')
    .run(Date.now(), session_id, agent, from_config, to_config, kind, String(detail).slice(0, 500));
}
export const listAccountLog = (limit = 50) => db.prepare('SELECT * FROM account_log ORDER BY id DESC LIMIT ?').all(Math.min(500, Math.max(1, Math.round(+limit) || 50)));
/* The env a session's process starts with: its config when it has one, else the hub-wide endpoint. */
export function sessionEnv(row) {
  const cfg = row.config_id ? getAgentConfig(row.config_id) : null;
  const env = cfg ? configEnv(cfg, row.agent) : llmEnv(row.agent, row.llm_model || '');
  return row.agent === 'hermes' && env.LLM_BASE_URL ? { ...env, CUSTOM_BASE_URL: env.LLM_BASE_URL } : env;
}

/* --- Decisions log: what the judge did with an approval prompt or a loop ------------------- */
db.exec(`CREATE TABLE IF NOT EXISTS decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, session_id TEXT, kind TEXT NOT NULL,
  summary TEXT, verdict TEXT, reason TEXT, model TEXT, ms INTEGER
)`);
export function addDecision(d) {
  db.prepare('INSERT INTO decisions (at, session_id, kind, summary, verdict, reason, model, ms) VALUES (?,?,?,?,?,?,?,?)')
    .run(Date.now(), d.session_id ?? null, d.kind, d.summary ?? '', d.verdict ?? '', d.reason ?? '', d.model ?? '', Math.round(d.ms || 0));
}
export const listDecisions = (limit = 50) => db.prepare('SELECT * FROM decisions ORDER BY id DESC LIMIT ?').all(Math.min(500, Math.max(1, Math.round(+limit) || 50)));

/* --- chat events: a bubble-chat session's turns, as the agent's JSON output reported them ----
   v is a global counter bumped on every insert and update, so a poller asking "after v" also
   gets a text event that grew since it last looked. */
try { db.exec('ALTER TABLE sessions ADD COLUMN mode TEXT'); } catch { /* already there */ }          // 'json' = bubble chat
try { db.exec('ALTER TABLE sessions ADD COLUMN agent_session TEXT'); } catch { /* already there */ } // the agent's own session id, for resume
try { db.exec('ALTER TABLE sessions ADD COLUMN approval TEXT'); } catch { /* already there */ }      // 'auto' | 'ask' | 'read': what a blocked tool call gets
db.exec(`CREATE TABLE IF NOT EXISTS chat_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  turn        INTEGER NOT NULL,
  kind        TEXT NOT NULL,
  data        TEXT NOT NULL,
  v           INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_events ON chat_events(session_id, v);`);
try { db.exec('ALTER TABLE chat_events ADD COLUMN at INTEGER'); } catch { /* already there; older rows have no time */ }
let chatV = db.prepare('SELECT COALESCE(MAX(v), 0) AS v FROM chat_events').get().v;
/* Requests: one row per message sent to an agent (and per job run), numbered for good. Deleting a
   session drops its log but keeps its rows, so the count and the numbers never go back. Tokens
   land on the session's newest request when its turn reports them. */
db.exec(`CREATE TABLE IF NOT EXISTS requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, agent TEXT, at INTEGER NOT NULL,
  tin INTEGER NOT NULL DEFAULT 0, tout INTEGER NOT NULL DEFAULT 0, tcache INTEGER NOT NULL DEFAULT 0, ctx INTEGER
);
CREATE INDEX IF NOT EXISTS idx_requests_at ON requests(at);
CREATE INDEX IF NOT EXISTS idx_requests_sid ON requests(session_id);`);
/* Whole prompt in: omp (context set) reports input without the cache, hermes with it. */
const tokIn = (t) => (t.input ?? t.input_tokens ?? 0) + (t.context != null ? t.cache_read || 0 : 0);
const tokOut = (t) => t.output ?? t.output_tokens ?? 0;
if (!db.prepare('SELECT 1 FROM requests LIMIT 1').get()) {
  /* First run: number the messages already here. chat_events has no time, so they take the session's. */
  const add = db.prepare('INSERT INTO requests (session_id, agent, at) VALUES (?,?,?)');
  const tok = db.prepare('UPDATE requests SET tin = tin + ?, tout = tout + ?, tcache = tcache + ?, ctx = COALESCE(?, ctx) WHERE id = ?');
  const last = new Map();
  for (const e of db.prepare(`SELECT e.session_id sid, e.kind, e.data, s.agent, s.updated_at at FROM chat_events e
      JOIN sessions s ON s.id = e.session_id WHERE e.kind IN ('user', 'done') ORDER BY e.id`).all()) {
    if (e.kind === 'user') { last.set(e.sid, Number(add.run(e.sid, e.agent, e.at).lastInsertRowid)); continue; }
    const t = JSON.parse(e.data).tokens;
    if (t && last.has(e.sid)) tok.run(tokIn(t), tokOut(t), t.cache_read || 0, t.context ?? tokIn(t), last.get(e.sid));
  }
}
/* The device a request ran on, kept here so it outlives the session. */
try { db.exec('ALTER TABLE requests ADD COLUMN device TEXT'); } catch { /* already there */ }
db.exec("UPDATE requests SET device = (SELECT device FROM sessions WHERE sessions.id = requests.session_id) WHERE device IS NULL");
export function addRequest(sessionId, agent) {
  const dev = (getSession(sessionId) || {}).device || 'local';
  return Number(db.prepare('INSERT INTO requests (session_id, agent, at, device) VALUES (?,?,?,?)').run(sessionId, agent || '', now(), dev).lastInsertRowid);
}
function requestTokens(sessionId, t) {
  const r = db.prepare('SELECT id FROM requests WHERE session_id = ? ORDER BY id DESC LIMIT 1').get(sessionId);
  if (r) db.prepare('UPDATE requests SET tin = tin + ?, tout = tout + ?, tcache = tcache + ?, ctx = COALESCE(?, ctx) WHERE id = ?')
    .run(tokIn(t), tokOut(t), t.cache_read || 0, t.context ?? tokIn(t), r.id);
}
/* Requests and tokens since a time: totals, per day, and the highest number ever given. */
export function requestSummary(since = 0) {
  const w = db.prepare('SELECT COUNT(*) n, COALESCE(SUM(tin),0) tin, COALESCE(SUM(tout),0) tout, COALESCE(SUM(tcache),0) tcache FROM requests WHERE at >= ?').get(since);
  const perDay = db.prepare(`SELECT strftime('%Y-%m-%d', at/1000, 'unixepoch', 'localtime') d, COUNT(*) n FROM requests WHERE at >= ? GROUP BY d ORDER BY d`).all(since);
  const perDevice = db.prepare(`SELECT COALESCE(device, 'local') device, COUNT(*) n, SUM(tin) tin, SUM(tout) tout, SUM(tcache) tcache
      FROM requests WHERE at >= ? GROUP BY COALESCE(device, 'local') ORDER BY n DESC`).all(since);
  return { ...w, perDay, perDevice, lastNo: db.prepare('SELECT COALESCE(MAX(id),0) m FROM requests').get().m };
}
/* Per session: messages sent, tokens, last known context size. */
export function sessionStats() {
  const out = {};
  for (const r of db.prepare(`SELECT session_id sid, COUNT(*) msgs, SUM(tin) tin, SUM(tout) tout, SUM(tcache) tcache,
      (SELECT q.ctx FROM requests q WHERE q.session_id = r.session_id AND q.ctx IS NOT NULL ORDER BY q.id DESC LIMIT 1) ctx
      FROM requests r WHERE session_id IS NOT NULL GROUP BY session_id`).all()) out[r.sid] = r;
  return out;
}
export function addEvent(sessionId, turn, kind, data) {
  if (kind === 'user') addRequest(sessionId, (getSession(sessionId) || {}).agent);
  if (kind === 'done' && data && data.tokens) requestTokens(sessionId, data.tokens);
  return Number(db.prepare('INSERT INTO chat_events (session_id, turn, kind, data, v, at) VALUES (?,?,?,?,?,?)')
    .run(sessionId, turn, kind, JSON.stringify(data), ++chatV, Date.now()).lastInsertRowid);
}
export function updateEvent(id, data) {
  db.prepare('UPDATE chat_events SET data = ?, v = ? WHERE id = ?').run(JSON.stringify(data), ++chatV, id);
}
export function listEvents(sessionId, after = 0) {
  return db.prepare('SELECT id, turn, kind, data, v, at FROM chat_events WHERE session_id = ? AND v > ? ORDER BY id').all(sessionId, after)
    .map((e) => ({ ...e, data: JSON.parse(e.data) }));
}
/* A session's last n events, oldest first: enough to tell what it is waiting on. */
export function recentEvents(sessionId, n = 6) {
  return db.prepare('SELECT id, turn, kind, data, at FROM chat_events WHERE session_id = ? ORDER BY id DESC LIMIT ?').all(sessionId, n)
    .reverse().map((e) => ({ ...e, data: JSON.parse(e.data) }));
}
/* Messages whose text holds q (case-insensitive for ASCII), newest first. who: 'user' | 'agent' | ''. */
export function searchEvents(q, { session = '', who = '', limit = 40 } = {}) {
  const kinds = who === 'user' ? ['user'] : who === 'agent' ? ['text'] : ['user', 'text'];
  const like = `%${String(q).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  return db.prepare(`SELECT e.id, e.session_id, e.kind, json_extract(e.data, '$.text') AS text FROM chat_events e
      WHERE e.kind IN (${kinds.map(() => '?').join(',')}) AND json_extract(e.data, '$.text') LIKE ? ESCAPE '\\'
      ${session ? 'AND e.session_id = ?' : ''} ORDER BY e.id DESC LIMIT ?`)
    .all(...kinds, like, ...(session ? [session] : []), limit);
}
export const lastTurn = (sessionId) => db.prepare('SELECT COALESCE(MAX(turn), 0) AS t FROM chat_events WHERE session_id = ?').get(sessionId).t;
