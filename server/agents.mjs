// The coding agents XBLabs knows how to start, and which of them this machine has.
// Imported by the hub (local device) and by server/agent.mjs (remote devices).
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, writeFileSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/* run(prompt): argv for one non-interactive turn that exits with the agent's own code (jobs).
   chat(prompt): argv for the interactive agent, opened on the prompt when there is one.
   resume: argv that reopens the agent's last conversation in that folder; absent = start new.
   Nothing here touches an agent's config: it starts as the device has it set up. */
const opt = (p, ...flag) => (p ? [...flag, p] : []);
/* yolo: the agent's own flag for skipping permission prompts, used only when Settings → Agents
   → Skip permission prompts is on. hermes and omp from their --help; the others from their docs,
   not run here. opencode has none. */
export const AGENTS = {
  claude:   { name: 'Claude Code', bin: 'claude',   run: (p) => ['claude', '-p', p],        chat: (p) => ['claude', ...opt(p)],                resume: ['claude', '--continue'],     yolo: ['--dangerously-skip-permissions'] },
  codex:    { name: 'Codex',       bin: 'codex',    run: (p) => ['codex', 'exec', p],       chat: (p) => ['codex', ...opt(p)],                 resume: ['codex', 'resume', '--last'], yolo: ['--dangerously-bypass-approvals-and-sandbox'] },
  gemini:   { name: 'Gemini CLI',  bin: 'gemini',   run: (p) => ['gemini', '-p', p],        chat: (p) => ['gemini', ...opt(p, '-i')],                                                yolo: ['--yolo'] },
  opencode: { name: 'OpenCode',    bin: 'opencode', run: (p) => ['opencode', 'run', p],     chat: (p) => ['opencode', ...opt(p, '--prompt')],  resume: ['opencode', '--continue'] },
  hermes:   { name: 'Hermes',      bin: 'hermes',   run: (p) => ['hermes', 'chat', '-q', p, '--oneshot'], chat: (p) => ['hermes', 'chat', ...opt(p, '-q')], resume: ['hermes', 'chat', '--continue'], yolo: ['--yolo'],
    /* Custom endpoint/key travel in OPENAI_* env, never unsupported CLI flags. */
    endpoint: (e) => ['--provider', 'custom', ...(e.LLM_MODEL ? ['-m', e.LLM_MODEL] : [])],
    pinsProvider: true },   // its gateway keeps a conversation on the provider it began with: no config switch mid-way
  omp:      { name: 'OMP',         bin: 'omp',      run: (p) => ['omp', '-p', p],           chat: (p) => ['omp', ...opt(p)],                   resume: ['omp', '--continue'],        yolo: ['--auto-approve'] },
};

/* More agents. Flags from each project's docs; only claude, hermes, omp and copilot were run here.
   tui(): an agent whose prompt flag is not known opens bare and gets the prompt typed into it
   (typePrompt). A wrong binary name is fixed in Settings → Agents → binary, no code change. */
const tui = (name, bin, extra = {}) => ({ name, bin, chat: () => [bin], typePrompt: true, ...extra });
Object.assign(AGENTS, {
  copilot:    { name: 'GitHub Copilot', bin: 'copilot', run: (p) => ['copilot', '-p', p], chat: (p) => ['copilot', ...opt(p, '-i')], resume: ['copilot', '--continue'], yolo: ['--allow-all-tools'] },
  'claude-teams': { name: 'Claude Agent Teams', bin: 'claude', run: (p) => ['claude', '-p', p], chat: (p) => ['claude', ...opt(p)], resume: ['claude', '--continue'], yolo: ['--dangerously-skip-permissions'],
    env: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' } },
  openclaude: { name: 'OpenClaude',     bin: 'openclaude', run: (p) => ['openclaude', '-p', p], chat: (p) => ['openclaude', ...opt(p)], resume: ['openclaude', '--continue'], yolo: ['--dangerously-skip-permissions'] },
  kiro:       { name: 'Kiro CLI',       bin: 'kiro-cli', run: (p) => ['kiro-cli', 'chat', '--no-interactive', p], chat: (p) => ['kiro-cli', 'chat', ...opt(p)], resume: ['kiro-cli', 'chat', '--resume'], yolo: ['--trust-all-tools'] },
  qwen:       { name: 'Qwen Code',      bin: 'qwen',     run: (p) => ['qwen', '-p', p],     chat: (p) => ['qwen', ...opt(p, '-i')], yolo: ['--yolo'] },
  cursor:     { name: 'Cursor',         bin: 'cursor-agent', run: (p) => ['cursor-agent', '-p', p], chat: (p) => ['cursor-agent', ...opt(p)], resume: ['cursor-agent', 'resume'], yolo: ['--force'] },
  aider:      { name: 'Aider',          bin: 'aider',    run: (p) => ['aider', '--message', p], chat: () => ['aider'], typePrompt: true, yolo: ['--yes-always'] },
  goose:      { name: 'Goose',          bin: 'goose',    run: (p) => ['goose', 'run', '-t', p], chat: () => ['goose', 'session'], typePrompt: true, resume: ['goose', 'session', '-r'] },
  amp:        { name: 'Amp',            bin: 'amp',      run: (p) => ['amp', '-x', p],      chat: () => ['amp'], typePrompt: true, yolo: ['--dangerously-allow-all'] },
  crush:      { name: 'Crush',          bin: 'crush',    run: (p) => ['crush', 'run', p],   chat: () => ['crush'], typePrompt: true, yolo: ['--yolo'] },
  auggie:     { name: 'Auggie',         bin: 'auggie',   run: (p) => ['auggie', '--print', p], chat: (p) => ['auggie', ...opt(p)] },
  continue:   { name: 'Continue',       bin: 'cn',       run: (p) => ['cn', '-p', p],       chat: (p) => ['cn', ...opt(p)] },
  droid:      { name: 'Droid',          bin: 'droid',    run: (p) => ['droid', 'exec', p],  chat: () => ['droid'], typePrompt: true },
  pi:         { name: 'Pi',             bin: 'pi',       run: (p) => ['pi', '-p', p],       chat: (p) => ['pi', ...opt(p)], resume: ['pi', '--continue'] },
  codebuff:   { name: 'Codebuff',       bin: 'codebuff', chat: (p) => ['codebuff', ...opt(p)] },
  rovodev:    tui('Rovo Dev', 'acli', { chat: () => ['acli', 'rovodev', 'run'] }),
  opencode2:  tui('OpenCode 2', 'opencode2'),
  grok:       tui('Grok', 'grok'),
  mimo:       tui('MiMo Code', 'mimo'),
  ante:       tui('Ante', 'ante'),
  trae:       tui('Trae', 'trae-cli'),
  muse:       tui('Muse', 'muse'),
  deepseek:   tui('DeepSeek Harness', 'deepseek'),
  qoder:      tui('Qoder CLI', 'qodercli'),
  'qoder-cn': tui('Qoder CLI China', 'qodercli-cn'),
  zcode:      tui('ZCode', 'zcode'),
  prime:      tui('Prime Agent', 'prime'),
  antigravity: tui('Antigravity', 'antigravity'),
  kilo:       tui('Kilo Code', 'kilocode'),
  autohand:   tui('Autohand Code', 'autohand'),
  cline:      tui('Cline', 'cline'),
  freebuff:   tui('Freebuff', 'freebuff'),
  'command-code': tui('Command Code', 'command-code'),
  kimi:       tui('Kimi', 'kimi'),
  vibe:       tui('Mistral Vibe', 'vibe'),
  devin:      tui('Devin', 'devin'),
  openclaw:   tui('OpenClaw', 'openclaw'),
  codebuddy:  tui('CodeBuddy', 'codebuddy'),
  jcode:      tui('Jcode', 'jcode'),
});

/* Any terminal program: Settings → Agents → Custom, saved in hub settings `custom` as
   id -> { name, command }. Opens the command and types the prompt into it. */
export function splitCommand(s) {
  const out = []; let cur = '', q = '', any = false;
  for (const ch of String(s || '')) {
    if (q) { if (ch === q) q = ''; else cur += ch; }
    else if (ch === '"' || ch === "'") { q = ch; any = true; }
    else if (/\s/.test(ch)) { if (cur || any) out.push(cur); cur = ''; any = false; }
    else cur += ch;
  }
  if (cur || any) out.push(cur);
  return out;
}
export function registerCustom(custom = {}) {
  for (const id of Object.keys(AGENTS)) if (AGENTS[id].custom) delete AGENTS[id];
  for (const [id, c] of Object.entries(custom || {})) {
    const argv = splitCommand(c && c.command);
    if (!argv.length || Object.hasOwn(AGENTS, id)) continue;
    AGENTS[id] = { name: String(c.name || id), bin: argv[0], chat: () => [...argv], typePrompt: true, custom: true };
  }
}

/* Settings → Agents applied to a built command: another binary, the skip-permission flag, extra
   flags. ponytail: extra flags split on spaces, so a flag value cannot hold a space. */
export function applySettings(argv, agent, s, env = {}, { resume = false } = {}) {
  if (!argv) return argv;
  const a = (s.agents && s.agents[agent]) || {};
  const out = [...argv];
  if (a.bin) out[0] = a.bin;
  /* Agents that ignore the endpoint env vars take it as flags (the key stays in env). */
  /* An agent that freezes provider and model per conversation (hermes) refuses a resume that names
     them again, even when the hub's default model has changed since: send them only on creation. */
  if (Object.hasOwn(AGENTS, agent) && AGENTS[agent].endpoint && env && env.LLM_BASE_URL && !(resume && AGENTS[agent].frozen)) out.push(...AGENTS[agent].endpoint(env));
  if (s.session && s.session.skipPerms && Object.hasOwn(AGENTS, agent) && AGENTS[agent].yolo) out.push(...AGENTS[agent].yolo);
  if (a.flags) out.push(...a.flags.split(/\s+/).filter(Boolean));
  return out;
}
/* Agents switched off in Settings drop out of what a device reports. */
export const enabled = (id, s) => !(s.agents && s.agents[id] && s.agents[id].enabled === false);

const WIN = process.platform === 'win32';

/* Status hooks: extra flags that make an interactive agent tell the hub when a turn starts,
   ends or waits for me (server/hooks/). Passed per run on the command line, so the agent's
   own config files are never edited. Agents not listed here have no per-run way to load one
   (hermes reads hooks only from ~/.hermes/config.yaml; codex only reports turn end). */
const HOOKS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'hooks');
const HOOK_FLAGS = {
  omp: () => ['--hook', join(HOOKS_DIR, 'omp.mjs')],
  /* ponytail: written from Claude Code's documented hook settings, not run here (claude is
     not installed on this machine). First thing to check if a claude chat shows no status. */
  claude: () => {
    const cmd = (state) => [{ hooks: [{ type: 'command', command: `node "${join(HOOKS_DIR, 'report.mjs')}" ${state}` }] }];
    const file = join(tmpdir(), 'xblabs-claude-hooks.json');
    writeFileSync(file, JSON.stringify({ hooks: {
      SessionStart: cmd('idle'), UserPromptSubmit: cmd('working'), Notification: cmd('waiting'), Stop: cmd('idle'),
    } }));
    return ['--settings', file];
  },
};
export const hookFlags = (agent) => (Object.hasOwn(HOOK_FLAGS, agent) ? HOOK_FLAGS[agent]() : []);

/* Full path of a binary on PATH, or null. On Windows only PATHEXT names count: a bare
   extensionless shim is for bash, cmd cannot start it. */
export function findBin(bin, env = process.env) {
  const exts = WIN ? (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
  for (const dir of (env.PATH || env.Path || '').split(delimiter).filter(Boolean))
    for (const ext of exts) {
      const f = join(dir, bin + ext.toLowerCase());
      if (existsSync(f)) return f;
    }
  return null;
}

const version = (path) => new Promise((done) => {
  /* .cmd shims need a shell on Windows; the path is quoted because it may hold spaces. */
  const [cmd, args] = WIN ? [`"${path}" --version`, []] : [path, ['--version']];
  execFile(cmd, args, { timeout: 8000, shell: WIN, windowsHide: true },
    (err, out, errOut) => {
      const text = `${out}\n${errOut}`;
      /* A placeholder that only offers to install the real CLI (VS Code's copilot shim) is not installed. */
      if (/\bnot (found|installed)\b|\bto install it\b/i.test(text) && !/\d+\.\d+/.test(text)) return done(null);
      done(err ? '' : (text.match(/\d+\.\d+[\w.-]*/) || [''])[0]);
    });
});

/* [{ id, name, path, version }] for the agents installed here.
   ponytail: no signed-in check; each agent stores its login differently. Add per agent when a
   run failing on "not logged in" becomes a real annoyance. */
export async function detect() {
  const found = Object.entries(AGENTS).map(([id, a]) => ({ id, name: a.name, path: findBin(a.bin) })).filter((a) => a.path);
  return (await Promise.all(found.map(async (a) => ({ ...a, version: await version(a.path) })))).filter((a) => a.version !== null);
}

/* The hub asks on every /api/devices poll; installs change rarely, so look once a minute. */
let cache = null, at = 0;
export function detectCached(ms = 60000) {
  if (!cache || Date.now() - at > ms) { at = Date.now(); cache = detect(); }
  return cache;
}

/* Folders in one directory, for New session's folder browser. Same code on the hub and on a
   remote agent. '~' is the home folder; dot folders only when asked. */
export function listDirs(raw = '~', hidden = false) {
  const home = process.env.USERPROFILE || process.env.HOME || '.';
  const dir = resolve(raw === '~' || /^~[\/]/.test(raw) ? join(home, raw.slice(1)) : raw);
  const dirs = readdirSync(dir, { withFileTypes: true })
    .filter((d) => { try { return d.isDirectory() || (d.isSymbolicLink() && statSync(join(dir, d.name)).isDirectory()); } catch { return false; } })
    .map((d) => d.name).filter((n) => hidden || !n.startsWith('.'))
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  const up = dirname(dir);
  /* Which entries are Git checkouts (.git is a folder, or a file in a worktree): the picker marks them. */
  const repos = dirs.filter((n) => existsSync(join(dir, n, '.git')));
  const git = existsSync(join(dir, '.git'));
  /* A repo with no commit yet has nothing to branch from, so Compare agents cannot use it. */
  let commit = false;
  if (git) try { execFileSync('git', ['rev-parse', '-q', '--verify', 'HEAD'], { cwd: dir, stdio: 'ignore', timeout: 3000, windowsHide: true }); commit = true; } catch { /* no commit, or no git */ }
  return { path: dir, parent: up === dir ? null : up, home, dirs, repos, git, commit };
}

/* --- bubble chat: one turn per message, in the agent's own JSON output mode ----------------
   json.argv(prompt, ctx) builds the turn (ctx.sid = XBLabs session, ctx.resume = the agent's
   session id from an earlier turn); json.parse(obj) turns one output line into events:
     { kind: 'text' | 'thinking', delta }      streamed answer / reasoning
     { kind: 'tool', id, name, input }          a tool call
     { kind: 'tool_result', id, output, error } what it returned
     { kind: 'resume', id }                     the agent's session id, kept for the next turn
     { kind: 'usage', input, output, cache_read, context }   tokens of one model call
     { kind: 'model', model, provider }         the model that answered
     { kind: 'done', tokens, ms, error }        the turn is over
   Agents without json stay a terminal (TUI) session. */
/* A tool call the agent's own policy stopped because nobody was there to approve it (texts as
   hermes and omp print them here; claude's from its docs). */
export const NEEDS_APPROVAL = /BLOCKED: Command flagged|requires approval but no interactive UI|requires (your )?approval|permission (was )?denied|haven't granted it yet/i;
const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => x.text || '').join('') : c && c.text ? c.text : JSON.stringify(c ?? ''));

/* Hermes: from `hermes chat --help` and a real run here. A named thread per XBLabs session. */
AGENTS.hermes.json = {
  /* An approved turn: -q never lets --yolo past its block (config only), -z is its unattended
     mode that does. -z prints only the final answer, so that turn shows as plain text. */
  approveArgv: (p, { sid }) => ['hermes', '-z', p, '--continue', `xblabs-${sid}`],
  argv: (p, { sid }) => ['hermes', 'chat', '-q', p, '--format', 'stream-json', '--continue', `xblabs-${sid}`, '--create-if-missing'],
  parse(o) {
    if (o.type === 'text') return [{ kind: 'text', delta: o.text || '' }];
    if (o.type === 'reasoning' || o.type === 'thinking') return [{ kind: 'thinking', delta: o.text || '' }];
    if (o.type === 'tool_use') return [{ kind: 'tool', id: o.tool_call_id, name: o.name, input: o.input }];
    if (o.type === 'tool_result') return [{ kind: 'tool_result', id: o.tool_call_id, output: textOf(o.output), error: !!o.is_error }];
    if (o.type === 'result') return [{ kind: 'done', tokens: o.tokens, ms: o.duration_ms, error: o.exit_code ? `exit ${o.exit_code}` : '' }];
    return [];
  },
};
/* OMP: from `omp --help` and a real run here. Resumed by the session id its first event gives. */
AGENTS.omp.json = {
  approve: ['--auto-approve'],
  argv: (p, { resume }) => ['omp', '-p', p, '--mode', 'json', ...(resume ? ['--resume', resume] : [])],
  parse(o) {
    const e = o.assistantMessageEvent;
    if (o.type === 'session' && o.id) return [{ kind: 'resume', id: o.id }];
    if (o.type === 'message_update' && e && e.type === 'text_delta') return [{ kind: 'text', delta: e.delta || '' }];
    if (o.type === 'message_update' && e && e.type === 'thinking_delta') return [{ kind: 'thinking', delta: e.delta || '' }];
    if (o.type === 'tool_execution_start') return [{ kind: 'tool', id: o.toolCallId, name: o.toolName, input: o.args }];
    if (o.type === 'tool_execution_end') return [{ kind: 'tool_result', id: o.toolCallId, output: textOf(o.result && o.result.content), error: !!o.isError }];
    /* One usage per model call; the last call's input + cache is how full the context is now. */
    if (o.type === 'turn_end' && o.message && o.message.usage) { const u = o.message.usage; return [{ kind: 'usage', input: u.input || 0, output: u.output || 0, cache_read: u.cacheRead || 0, context: (u.input || 0) + (u.cacheRead || 0) + (u.output || 0) }]; }
    if (o.type === 'message_end' && o.message && o.message.role === 'assistant' && o.message.model) return [{ kind: 'model', model: o.message.model, provider: o.message.provider || '' }];
    if (o.type === 'agent_end') return [{ kind: 'done' }];
    return [];
  },
};
/* Claude Code: from its documented stream-json format, not run here (not installed). The prompt
   goes on stdin, so a .cmd shim never sees it on a command line. */
AGENTS.claude.json = {
  stdin: true,
  approve: ['--dangerously-skip-permissions'],
  argv: (p, { resume }) => ['claude', '-p', '--output-format', 'stream-json', '--verbose', ...(resume ? ['--resume', resume] : [])],
  parse(o) {
    if (o.type === 'system' && o.subtype === 'init' && o.session_id) return [{ kind: 'resume', id: o.session_id }, ...(o.model ? [{ kind: 'model', model: o.model, provider: 'anthropic' }] : [])];
    const content = (o.message && Array.isArray(o.message.content)) ? o.message.content : [];
    /* A subagent's own messages carry the Task call that started it: only its tool calls are kept,
       as steps of that subagent; its text is its business until the Task result. */
    const parent = o.parent_tool_use_id || undefined;
    if (o.type === 'assistant') return content.map((c) => (c.type === 'text' && !parent ? { kind: 'text', delta: c.text || '' }
      : c.type === 'thinking' && !parent ? { kind: 'thinking', delta: c.thinking || '' }
      : c.type === 'tool_use' ? { kind: 'tool', id: c.id, name: c.name, input: c.input, parent } : null)).filter(Boolean);
    if (o.type === 'user') return content.filter((c) => c.type === 'tool_result').map((c) => ({ kind: 'tool_result', id: c.tool_use_id, output: textOf(c.content), error: !!c.is_error }));
    if (o.type === 'result') return [{ kind: 'done', tokens: o.usage, ms: o.duration_ms, error: o.is_error ? textOf(o.result) : '' }];
    return [];
  },
};

/* --- the same conversation in the agent's own TUI (the Terminal view of a bubble chat) -------
   json.tui(ctx) opens the interactive CLI on the conversation the JSON turns use (ctx.newId: a
   fresh id for an agent that takes one). json.history(row) reads that conversation back from the
   agent's own store as items in order:
     { kind: 'user' | 'text' | 'thinking', text }   { kind: 'tool', name, input, output, error }
   so what was typed in the TUI can be copied into the chat afterwards. */
const HOME = () => process.env.USERPROFILE || process.env.HOME || '';
/* Calls in order of appearance; a result attaches to its call by id. */
function itemsOf(rows) {
  const out = [], calls = new Map();
  for (const r of rows) {
    if (r.kind === 'result') { const c = calls.get(r.id); if (c) Object.assign(c, { output: r.output, error: !!r.error }); continue; }
    if (r.kind === 'tool') { const it = { kind: 'tool', name: r.name, input: r.input ?? null, output: null, error: false }; calls.set(r.id, it); out.push(it); continue; }
    if (r.text && r.text.trim()) out.push({ kind: r.kind, text: r.text.trim() });
  }
  return out;
}
const jsonl = (f) => { try { return readFileSync(f, 'utf8').split('\n').filter((l) => l.startsWith('{')).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } };
const tryJSON = (t) => { try { return JSON.parse(t); } catch { return t; } };

AGENTS.hermes.frozen = true;   // `Resume retains gateway session policy` since hermes 0.23
AGENTS.hermes.json.tui = ({ sid }) => ['hermes', 'chat', '--continue', `xblabs-${sid}`, '--create-if-missing'];
AGENTS.hermes.json.history = async (row) => {
  const home = [process.env.HERMES_HOME, process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'hermes'), join(HOME(), '.hermes')].find((d) => d && existsSync(join(d, 'state.db')));
  if (!home) return [];
  const { DatabaseSync } = await import('node:sqlite');
  const d = new DatabaseSync(join(home, 'state.db'), { readOnly: true });
  try {
    const s = d.prepare('SELECT id, input_tokens, output_tokens, cache_read_tokens FROM sessions WHERE title = ? ORDER BY started_at DESC LIMIT 1').get(`xblabs-${row.id}`);
    if (!s) return [];
    const rows = [];
    for (const m of d.prepare('SELECT role, content, tool_call_id, tool_calls, reasoning, reasoning_content FROM messages WHERE session_id = ? AND active = 1 ORDER BY id').all(s.id)) {
      if (m.role === 'user') rows.push({ kind: 'user', text: m.content || '' });
      else if (m.role === 'assistant') {
        rows.push({ kind: 'thinking', text: m.reasoning || m.reasoning_content || '' });
        rows.push({ kind: 'text', text: m.content || '' });
        for (const c of (m.tool_calls && tryJSON(m.tool_calls)) || []) if (c && c.function) rows.push({ kind: 'tool', id: c.id, name: c.function.name, input: tryJSON(c.function.arguments) });
      } else if (m.role === 'tool') {
        const o = tryJSON(m.content || '');
        rows.push({ kind: 'result', id: m.tool_call_id, output: typeof o === 'object' && o ? (o.output ?? o.content ?? o.error ?? m.content) : m.content, error: !!(o && (o.error || o.status === 'error')) });
      }
    }
    /* Totals for turns typed in the TUI, which report no done event; input counts the cache like a JSON turn. */
    return Object.assign(itemsOf(rows), { tokens: { input: (s.input_tokens || 0) + (s.cache_read_tokens || 0), output: s.output_tokens || 0, cache_read: s.cache_read_tokens || 0 } });
  } finally { d.close(); }
};

const OMP_DIR = () => join(HOME(), '.omp', 'agent', 'sessions');
/* An OMP session file by id, or (no id yet) the newest one for this folder written since `since`. */
function ompFile(id, cwd, since = 0) {
  let best = null;
  for (const dir of (() => { try { return readdirSync(OMP_DIR()); } catch { return []; } })()) {
    let files; try { files = readdirSync(join(OMP_DIR(), dir)); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const p = join(OMP_DIR(), dir, f);
      if (id) { if (f.endsWith(`_${id}.jsonl`)) return p; continue; }
      const t = statSync(p).mtimeMs;
      if (t < since || (best && best.t >= t)) continue;
      const head = jsonl(p).find((o) => o.type === 'session');
      if (head && resolve(head.cwd || '') === resolve(cwd || '')) best = { p, t, id: head.id };
    }
  }
  return id ? null : best;
}
AGENTS.omp.json.tui = ({ resume }) => ['omp', ...(resume ? ['--resume', resume] : [])];
AGENTS.omp.json.find = (row, since) => { const b = ompFile(null, row.cwd, since); return b && b.id; };
AGENTS.omp.json.history = async (row) => {
  const f = row.agent_session && ompFile(row.agent_session);
  if (!f) return [];
  const rows = [];
  for (const o of jsonl(f)) {
    const m = o.type === 'message' && o.message;
    if (!m) continue;
    const parts = Array.isArray(m.content) ? m.content : [{ type: 'text', text: textOf(m.content) }];
    if (m.role === 'user') rows.push({ kind: 'user', text: parts.filter((c) => c.type === 'text').map((c) => c.text).join('') });
    else if (m.role === 'assistant') for (const c of parts) {
      if (c.type === 'thinking') rows.push({ kind: 'thinking', text: c.thinking || '' });
      if (c.type === 'text') rows.push({ kind: 'text', text: c.text });
      if (c.type === 'toolCall') rows.push({ kind: 'tool', id: c.id, name: c.name, input: c.arguments });
    } else if (m.role === 'toolResult') rows.push({ kind: 'result', id: m.toolCallId, output: textOf(m.content), error: !!m.isError });
  }
  return itemsOf(rows);
};

/* Claude Code: --session-id / --resume and its per-project JSONL, from its docs (not run here). */
AGENTS.claude.json.tui = ({ resume, newId }) => ['claude', ...(resume ? ['--resume', resume] : ['--session-id', newId])];
AGENTS.claude.json.history = async (row) => {
  if (!row.agent_session) return [];
  const slug = resolve(row.cwd || '').replace(/[^A-Za-z0-9]/g, '-');
  const rows = [];
  for (const o of jsonl(join(HOME(), '.claude', 'projects', slug, `${row.agent_session}.jsonl`))) {
    if (o.isMeta || !o.message) continue;
    const c = o.message.content;
    const parts = Array.isArray(c) ? c : [{ type: 'text', text: textOf(c) }];
    for (const p of parts) {
      if (p.type === 'text') rows.push({ kind: o.type === 'user' ? 'user' : 'text', text: p.text });
      if (p.type === 'thinking') rows.push({ kind: 'thinking', text: p.thinking });
      if (p.type === 'tool_use') rows.push({ kind: 'tool', id: p.id, name: p.name, input: p.input });
      if (p.type === 'tool_result') rows.push({ kind: 'result', id: p.tool_use_id, output: textOf(p.content), error: !!p.is_error });
    }
  }
  return itemsOf(rows);
};

/* The model an agent is set to use in its own config, for agents whose JSON output does not say
   (hermes prints model ""). Read-only; keys and tokens in the file are never read out. */
export function configuredModel(agent) {
  if (agent !== 'hermes') return null;
  const home = process.env.USERPROFILE || process.env.HOME || '';
  for (const f of [process.env.HERMES_HOME && join(process.env.HERMES_HOME, 'config.yaml'), process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'hermes', 'config.yaml'), join(home, '.hermes', 'config.yaml')].filter(Boolean)) {
    try {
      const block = (readFileSync(f, 'utf8').replace(/\r/g, '').match(/^model:\s*\n((?:[ \t]+.*\n?)*)/m) || [])[1] || '';
      const get = (k) => ((block.match(new RegExp(`^\\s+${k}:\\s*(.+)$`, 'm')) || [])[1] || '').trim().replace(/^['"]|['"]$/g, '');
      if (get('default')) return { model: get('default'), provider: get('provider').replace(/^custom:/, '') };
    } catch { /* not there */ }
  }
  return null;
}
