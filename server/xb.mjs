#!/usr/bin/env node
// xb: how agents talk to the XBLabs hub (GOA tasks, notes, other sessions). Run from inside a
// session, where XBLabs sets XBLABS_HUB and XBLABS_SESSION. `xb mcp` serves the same commands over MCP.
import { pathToFileURL } from 'node:url';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const HUB = process.env.XBLABS_HUB || 'http://127.0.0.1:5200';
const BOOL = new Set(['no-branch', 'yes', 'force', 'key-stdin']);

/* Args after the command: --flag value, --no-branch / --yes, everything else is a word. */
export function parse(args) {
  const flags = {}, words = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--no-branch') flags.branch = false;
    else if (a.startsWith('--') && BOOL.has(a.slice(2))) flags[a.slice(2)] = true;
    else if (a.startsWith('--')) flags[a.slice(2)] = args[++i];
    else words.push(a);
  }
  return { flags, words };
}

/* "30m", "90s", "2h", bare number = seconds → ms. */
export function duration(s) {
  const m = String(s).match(/^(\d+(?:\.\d+)?)([smh]?)$/);
  if (!m) throw new Error(`bad duration: ${s}`);
  return +m[1] * 1000 * { '': 1, s: 1, m: 60, h: 3600 }[m[2]];
}

/* id, unique id prefix, or session name (exact, case-insensitive) → id. */
export function resolveIn(list, q) {
  if (!q) throw new Error('session required');
  const hit = list.filter((s) => s.id === q);
  const pre = hit.length ? hit : list.filter((s) => s.id.startsWith(q));
  const named = pre.length ? pre : list.filter((s) => (s.title || '').toLowerCase() === q.toLowerCase());
  if (named.length === 1) return named[0].id;
  if (!named.length) throw new Error(`no session ${q}`);
  throw new Error(`${q} is ambiguous: ${named.map((s) => s.id).join(', ')}`);
}

async function call(path, method = 'GET', body) {
  const r = await fetch(HUB + path, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}
const sid = async (q) => resolveIn(await call('/api/sessions'), q);
const row = (t) => `${t.id}  ${t.status.padEnd(10)} ${t.agent.padEnd(8)} ${(t.session_id || '-').padEnd(16)} ${t.outcome ? `[${t.outcome}] ` : ''}${(t.note || t.prompt).replace(/\s+/g, ' ').slice(0, 90)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const plain = (s) => s.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)|\x1b./g, '').replace(/\r/g, '');

export const HELP = `xb ls                                       sessions: id, status, agent, title
xb spawn [--agent ID] [--config NAME] [--project DIR] [--name NAME] [PROMPT]   start a session, print its id
xb spawn --agents A,B --project DIR PROMPT  same prompt, own branch per agent; prints session ids
xb compare SESSION SESSION...              show each branch's changes; never merges
xb send SESSION TEXT...                     message the session's agent
xb read SESSION [--last N]                  recent chat events (terminal sessions: terminal tail)
xb wait SESSION [--timeout 30m]             block until idle; exit 0 done, 2 asking, 124 timeout
xb answer SESSION N                         pick option N (1-based) of a pending approval menu
xb stop SESSION                             interrupt the agent's current turn
xb hibernate SESSION [--force]              stop its agent process, keep the conversation (refuses a busy one without --force)
xb wake SESSION                             resume a hibernated session
xb rename SESSION NAME
xb configs [AGENT]                          agent configs (other accounts / model APIs) and when each is limited
xb configs add AGENT NAME (--url U --model M --key-stdin | --dir DIR)   the key is read from stdin, never an argument
xb configs rm AGENT NAME
xb switch SESSION --config NAME             move the session to that config ('official' = the agent's own login)
xb accounts log [--last N]                  limit hits, switches and fallbacks
xb close SESSION --yes                      kill and delete the session
xb mcp                                      serve these commands as an MCP tool over stdio
xb help                                     this list
(SESSION = id, unique id prefix, or session name)

xb goa agents
xb goa delegate --agent <id> --project <folder> [--no-branch] [--device local] "<task>"
xb goa delegate --session <worker session id> "<follow-up>"
xb goa board
xb goa show <task>
xb goa task <task> --status done|failed|stopped [--note "..."]
xb goa report --outcome done|partly|nothing|blocked|refused|failed "<one line>"   (worker side)

xb notes ls
xb notes read <id>
xb notes new --title "<title>" [--tags a,b] "<text>"      (text "-" reads stdin)
xb notes edit <id> [--title "<title>"] [--append "<text>"] ["<new full text>"]

xb decide status                            Decisions switches and the judging model
xb decide log [--last N]                    what the judge decided (default 20)

xb browser [--session ID] open URL|PORT     open a page in the session's browser tab (5173 or :5173 = localhost); ID defaults to $XBLABS_SESSION
xb browser snapshot                         title, url, text and numbered clickable elements: [n] role "label"
xb browser click REF                        REF = number from the last snapshot, or a CSS selector
xb browser fill REF TEXT...
xb browser screenshot [FILE]                save a PNG (no FILE: the path is printed from a temp file)
xb browser eval JS...
xb browser back|forward|reload`;

/* Text "-" is read from stdin. */
async function body(t) {
  if (t !== '-') return t;
  let out = '';
  for await (const c of process.stdin) out += c;
  return out;
}

const fmtEvent = (e) => {
  const d = e.data || {};
  if (e.kind === 'user') return `> ${d.text}`;
  if (e.kind === 'text' || e.kind === 'error' || e.kind === 'note') return `${e.kind === 'text' ? '' : e.kind + ': '}${d.text || ''}`;
  if (e.kind === 'tool') return `[tool ${d.name}${d.input ? ' ' + JSON.stringify(d.input).slice(0, 120) : ''}]`;
  if (e.kind === 'approval') return `[approval ${d.state || ''}]`;
  return null;
};

/* Runs one xb command. Returns { text, code }; throws Error on failure. No process.exit, no console. */
export async function run(argv) {
  const [area, cmd, ...more] = argv;
  const lines = [], out = (s) => lines.push(s);
  const done = (code = 0) => ({ text: lines.join('\n'), code });
  if (!area || area === 'help') { out(HELP); return done(area ? 0 : 1); }

  if (area === 'browser') {
    /* Flags may come before the action: xb browser --session ID open URL. */
    const { flags, words: all } = parse([cmd, ...more].filter((x) => x !== undefined));
    const [action, ...words] = all;
    if (!action || action === 'help') { out(HELP); return done(action ? 0 : 1); }
    const session = flags.session || process.env.XBLABS_SESSION || undefined;
    const shot = action === 'screenshot';   // the hub's cwd is not the agent's: the PNG comes back and is written here
    const r = await call('/api/browser', 'POST', { action, args: shot ? [] : words, session });
    if (r.error) throw new Error(r.error);
    if (r.png) {
      const f = words[0] ? resolve(words[0]) : join(tmpdir(), `xb-shot-${Date.now()}.png`);
      writeFileSync(f, Buffer.from(r.png, 'base64')); out(`saved ${f}`);
    } else out(r.text);
    return done();
  }

  if (area === 'notes' || area === 'goa') {
    const { flags, words } = parse(more), text = words.join(' ');
    if (area === 'notes') {
      if (cmd === 'ls') {
        const all = await call('/api/notes');
        out(all.length ? all.map((n) => `${n.id}  ${n.title}${n.tags ? `  [${n.tags}]` : ''}`).join('\n') : 'no notes yet');
      } else if (cmd === 'read') {
        const n = (await call('/api/notes')).find((x) => x.id === words[0]);
        if (!n) throw new Error(`no note ${words[0] || ''}`);
        out(`# ${n.title}${n.tags ? `\ntags: ${n.tags}` : ''}\n\n${n.body}`);
      } else if (cmd === 'new') {
        const n = await call('/api/notes', 'POST', { title: flags.title, tags: flags.tags || '', body: await body(text) });
        out(`created ${n.id}`);
      } else if (cmd === 'edit') {
        const id = words.shift();
        const cur = (await call('/api/notes')).find((x) => x.id === id);
        if (!cur) throw new Error(`no note ${id || ''}`);
        const patch = {};
        if (flags.title) patch.title = flags.title;
        if (flags.append) patch.body = `${cur.body}${cur.body && !cur.body.endsWith('\n') ? '\n' : ''}${await body(flags.append)}`;
        else if (words.length) patch.body = await body(words.join(' '));
        await call(`/api/notes/${encodeURIComponent(id)}`, 'PATCH', patch);
        out(`updated ${id}`);
      } else { out(HELP); return done(1); }
      return done();
    }
    if (!cmd || cmd === 'help') { out(HELP); return done(cmd ? 0 : 1); }
    if (cmd === 'agents') {
      for (const d of await call('/api/devices')) out(`${d.name}: ${d.agents ? d.agents.map((a) => `${a.id}${a.version ? ' ' + a.version : ''}`).join(', ') || 'none' : 'unknown (no XBLabs agent there)'}`);
    } else if (cmd === 'delegate') {
      const t = await call('/api/goa/tasks', 'POST', { agent: flags.agent, device: flags.device, project: flags.project, session: flags.session, branch: flags.branch !== false, prompt: text });
      out(`queued ${t.id}${t.session_id ? ` → session ${t.session_id}` : ''} (status ${t.status})`);
    } else if (cmd === 'board') {
      const { tasks } = await call('/api/goa');
      out(tasks.length ? tasks.map(row).join('\n') : 'no tasks yet');
    } else if (cmd === 'show') {
      const t = await call(`/api/goa/tasks/${encodeURIComponent(words[0] || '')}`);
      out(`${row(t)}\nproject: ${t.project}\ntask: ${t.prompt}`);
      if (t.worker) out(`worker: ${t.worker.id} · ${t.worker.status}${t.worker.live ? '' : ' (not running)'} · ${t.worker.cwd}${t.worker.branch ? ` · branch ${t.worker.branch}` : ''}`);
      if (t.screen.length) out(`--- end of worker terminal ---\n${t.screen.join('\n')}`);
    } else if (cmd === 'task') {
      out(row(await call(`/api/goa/tasks/${encodeURIComponent(words[0] || '')}`, 'PATCH', { status: flags.status, note: flags.note })));
    } else if (cmd === 'report') {
      await call('/api/goa/report', 'POST', { session: process.env.XBLABS_SESSION, outcome: flags.outcome, note: text });
      out('reported');
    } else { out(HELP); return done(1); }
    return done();
  }

  if (area === 'decide') {
    const { flags } = parse(more);
    if (cmd === 'status') {
      const d = (await call('/api/hub-settings')).decide, l = await call('/api/llm');
      out(`approve ${d.approve ? 'on' : 'off'}, loop ${d.loop ? 'on' : 'off'}; judge: ${l.base_url && l.model ? l.model : 'no LLM configured'}`);
    } else if (cmd === 'log') {
      const rows = await call(`/api/decisions?limit=${+flags.last || 20}`);
      out(rows.length ? rows.map((r) => `${new Date(r.at).toISOString().slice(0, 19)}  ${(r.session_id || '-').padEnd(10)} ${r.kind.padEnd(9)} ${(r.verdict || '').padEnd(6)} ${(r.summary || '').replace(/\s+/g, ' ').slice(0, 60)} | ${r.reason || ''}`).join('\n') : 'no decisions yet');
    } else { out(HELP); return done(1); }
    return done();
  }

  /* Session control: `area` is the command. */
  const { flags, words } = parse(argv.slice(1));
  if (area === 'ls') {
    const all = await call('/api/sessions');
    out(all.length ? all.map((s) => `${s.id}  ${s.status.padEnd(9)} ${s.agent.padEnd(8)} ${s.title}`).join('\n') : 'no sessions');
  } else if (area === 'spawn') {
    if (Object.hasOwn(flags, 'agents')) {
      const agents = String(flags.agents || '').split(',').map((a) => a.trim());
      if (flags.agent || flags.branch === false || agents.length < 2 || agents.some((a) => !a) || new Set(agents).size !== agents.length || !flags.project || !words.join(' ').trim())
        throw new Error('usage: xb spawn --agents A,B --project DIR PROMPT (distinct agents, own branches required)');
      let failed = false;
      for (const agent of agents) {
        try {
          const s = await call('/api/sessions', 'POST', { kind: 'chat', agent, device: flags.device || 'local', cwd: flags.project, title: `${flags.name || 'Fan-out'} · ${agent}`, prompt: words.join(' '), isolate: true, requireIsolation: true, ...(flags.config ? { config: flags.config } : {}) });
          out(`${agent}  ${s.id}`);
        } catch (err) { failed = true; out(`${agent}  failed: ${err.message}`); }
      }
      return done(failed ? 1 : 0);
    }
    /* Same call the UI's New session makes; a bubble agent takes the prompt as its first turn. */
    const s = await call('/api/sessions', 'POST', { kind: 'chat', agent: flags.agent || 'claude', cwd: flags.project, title: flags.name, prompt: words.join(' '), ...(flags.config ? { config: flags.config } : {}) });
    out(s.id);
  } else if (area === 'compare') {
    if (words.length < 2) throw new Error('usage: xb compare SESSION SESSION...');
    const sessions = await call('/api/sessions');
    const ids = words.map((q) => resolveIn(sessions, q));
    if (new Set(ids).size !== ids.length) throw new Error('compare requires distinct sessions');
    let failed = false;
    for (const id of ids) {
      const s = sessions.find((r) => r.id === id);
      out(`--- ${id} · ${s.agent} · ${s.status} ---`);
      try {
        const g = await call(`/api/sessions/${id}/git`);
        out(`branch: ${g.branch} · base: ${g.base}`);
        out(g.patch || '(no changes)');
        if (g.cut) out('(diff truncated by hub)');
      } catch (err) { failed = true; out(`unavailable: ${err.message}`); }
    }
    return done(failed ? 1 : 0);
  } else if (area === 'send') {
    if (words.length < 2) throw new Error('usage: xb send SESSION TEXT...');
    const id = await sid(words[0]);
    await call(`/api/sessions/${id}/chat`, 'POST', { text: words.slice(1).join(' ') });
    out(`sent to ${id}`);
  } else if (area === 'read') {
    const id = await sid(words[0]), n = +flags.last || 20;
    const { events, ask } = await call(`/api/sessions/${id}/chat`);
    const shown = events.map(fmtEvent).filter((x) => x !== null).slice(-n);
    if (shown.length) out(shown.join('\n'));
    else {
      const tail = plain((await call(`/api/sessions/${id}/log`)).data || '').split('\n').filter((l) => l.trim()).slice(-n);
      out(tail.length ? `--- terminal tail ---\n${tail.join('\n')}` : '(nothing yet)');
    }
    if (ask) out(`--- asking: ${ask.title} ---\n${ask.options.map((o, i) => `${i + 1}. ${o}`).join('\n')}`);
  } else if (area === 'wait') {
    const id = await sid(words[0]), end = Date.now() + duration(flags.timeout || '30m');
    for (;;) {
      const c = await call(`/api/sessions/${id}/chat`);
      if (c.ask) { out(`asking: ${c.ask.title}`); return done(2); }
      if (!c.busy) { out(`${id} idle`); return done(0); }
      if (Date.now() >= end) { out('timeout'); return done(124); }
      await sleep(2000);
    }
  } else if (area === 'answer') {
    const n = +words[1];
    if (!(n >= 1)) throw new Error('usage: xb answer SESSION N   (N = option number, from 1)');
    const id = await sid(words[0]);
    await call(`/api/sessions/${id}/chat/pick`, 'POST', { n: n - 1 });
    out(`picked ${n}`);
  } else if (area === 'stop') {
    const id = await sid(words[0]);
    if (!(await call(`/api/sessions/${id}/chat/stop`, 'POST')).stopped) throw new Error('nothing to stop: no running turn (terminal-only sessions cannot be interrupted over the API)');
    out(`stopped ${id}`);
  } else if (area === 'hibernate' || area === 'wake') {
    const id = await sid(words[0]);
    await call(`/api/sessions/${id}/${area}`, 'POST', area === 'hibernate' ? { force: !!flags.force } : {});
    out(`${area === 'wake' ? 'woke' : 'hibernated'} ${id}`);
  } else if (area === 'configs') {
    const hhmm = (t) => (t > Date.now() ? `limited until ${new Date(t).toTimeString().slice(0, 5)}` : 'ok');
    const [sub, agent, name] = words;
    if (sub === 'add') {
      if (!agent || !name) throw new Error('usage: xb configs add AGENT NAME (--url U --model M --key-stdin | --dir DIR)');
      const api_key = flags['key-stdin'] ? (await body('-')).trim() : '';
      await call('/api/agent-configs', 'POST', { agent, name, kind: flags.dir ? 'account' : 'api', base_url: flags.url, model: flags.model, api_key, config_dir: flags.dir });
      out(`added ${agent} ${name}`);
    } else if (sub === 'rm') {
      const c = (await call(`/api/agent-configs?agent=${encodeURIComponent(agent)}`)).find((x) => x.name === name && x.id);
      if (!c) throw new Error(`${agent} has no config ${name}`);
      await call(`/api/agent-configs/${c.id}`, 'DELETE');
      out(`removed ${agent} ${name}`);
    } else {
      for (const c of await call(`/api/agent-configs${sub ? `?agent=${encodeURIComponent(sub)}` : ''}`))
        out(`${c.agent.padEnd(8)} ${c.name.padEnd(16)} ${c.kind.padEnd(8)} ${(c.model || c.config_dir || '-').padEnd(24)} ${c.enabled ? hhmm(c.limited_until) : 'disabled'}`);
    }
  } else if (area === 'switch') {
    if (!flags.config) throw new Error('usage: xb switch SESSION --config NAME');
    const id = await sid(words[0]);
    await call(`/api/sessions/${id}/switch`, 'POST', { config: flags.config });
    out(`${id} now on ${flags.config}`);
  } else if (area === 'accounts') {
    if (cmd !== 'log') throw new Error('usage: xb accounts log [--last N]');
    for (const e of (await call(`/api/accounts/log?limit=${+flags.last || 50}`)).reverse())
      out(`${new Date(e.time).toLocaleString()}  ${e.kind.padEnd(8)} ${e.agent} ${e.session_id || '-'}  ${e.from_config || 'official'} -> ${e.to_config || '-'}  ${(e.detail || '').slice(0, 80)}`);
  } else if (area === 'rename') {
    if (words.length < 2) throw new Error('usage: xb rename SESSION NAME');
    const id = await sid(words[0]);
    await call(`/api/sessions/${id}`, 'PATCH', { title: words.slice(1).join(' ') });
    out(`renamed ${id}`);
  } else if (area === 'run') {
    /* One word = a command name when XBLABS_SESSION is known, else the session. */
    const env = process.env.XBLABS_SESSION, [a, b] = words;
    const id = await sid(b !== undefined || !env ? a : env), name = b !== undefined ? b : (env ? a : undefined);
    if (name === undefined) {
      const c = await call(`/api/sessions/${id}/run`);
      out(Object.keys(c).length ? Object.entries(c).map(([k, v]) => `${k.padEnd(12)} ${v}`).join('\n') : 'no run commands: add "run" to .xblabs.json');
    } else { await call(`/api/sessions/${id}/run`, 'POST', { name }); out(`running ${name} in a new terminal tab`); }
  } else if (area === 'ports') {
    const id = await sid(words[0] || process.env.XBLABS_SESSION);
    const r = await call(`/api/sessions/${id}/ports`);
    out(r.length ? r.map((x) => `:${x.port}  pid ${x.pid}  ${x.name}`).join('\n') : 'no listening ports');
  } else if (area === 'close') {
    const id = await sid(words[0]);
    if (!flags.yes) throw new Error(`close kills and deletes ${id}; repeat with --yes`);
    await call(`/api/sessions/${id}`, 'DELETE');
    out(`closed ${id}`);
  } else { out(HELP); return done(1); }
  return done();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  if (argv[0] === 'mcp') import('./mcp.mjs').then((m) => m.serve());  /* not awaited: mcp.mjs imports this module */
  else try {
    const { text, code } = await run(argv);
    if (text) console.log(text);
    process.exit(code);
  } catch (err) {
    console.error(`xb: ${err.message}`);
    process.exit(1);
  }
}
