/* Live data: every page reads the server instead of data.js.
   Adapters keep the shapes the views already expect, so the views stay untouched — except where
   the mock told a lie (tokens, disks) and the honest value is different. */

const LIVE = { ready: false, err: null, sessions: [], devices: [], logs: [], notes: [], usage: null, runs: new Map() };
window.__liveRuns = LIVE.runs;

const jget = async (p) => {
  const res = await fetch(p, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${p} ${res.status}`);
  return res.json();
};

const rel = (ts) => {
  if (!ts) return '—';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
};
const kb = (b) => (b > 1024 * 1024 ? `${(b / 1048576).toFixed(1)}M` : `${Math.round(b / 1024)}K`);
const mmss = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};
/* How long a session has run: to now while it works, to its last change once it stopped. */
const runFor = (r) => {
  const m = Math.max(0, Math.round(((['running', 'starting', 'waiting'].includes(r.status) ? Date.now() : r.updated_at) - r.created_at) / 60000));
  return m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`;
};
const liveCol = (st) => (st === 'starting' || st === 'queued' ? 'queued' : st === 'waiting' ? 'waiting' : st === 'running' ? 'running' : st === 'hibernated' ? 'hibernated' : 'done');

/* Settings → Notifications → Desktop notifications: a banner when a session starts asking for
   input, finishes or fails while the window is in the background. First poll only records. */
const seenStatus = new Map();
function notifyChanges(rows) {
  const first = !seenStatus.size;
  for (const r of rows) {
    const was = seenStatus.get(r.id);
    seenStatus.set(r.id, r.status);
    if (first || was === r.status || r.kind === 'shell') continue;
    const what = r.status === 'waiting' ? 'is asking for input' : r.status === 'failed' ? 'failed' : r.status === 'done' || (r.status === 'idle' && was === 'running') ? 'is done' : '';
    // Sound: waiting -> input, failed -> error, done -> done (chat for a bubble chat). Not for the session open and visible.
    if (what && (document.hidden || !(state.page === 'session' && state.activeTab === r.id))) playSound(r.status === 'waiting' ? 'input' : r.status === 'failed' ? 'error' : bubbleChat(r.id) ? 'chat' : 'done');
    if (!prefs['Desktop notifications'] || !document.hidden) continue;
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') continue;
    if (what) new Notification(`${r.jobTitle || r.title} ${what}`, { body: `${r.agent} · ${r.device}`, tag: r.id });
  }
}
document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-pref="Desktop notifications"]');
  if (t && typeof Notification !== 'undefined' && Notification.permission === 'default') Notification.requestPermission();
});

/* Overview timeframe: start of today, 7 or 30 days back, or all time. */
function ovSince() {
  const d = new Date(); d.setHours(0, 0, 0, 0);
  const back = { today: 0, '7d': 6, '30d': 29 }[state.ovRange || 'today'];
  return back == null ? 0 : d.getTime() - back * 86400000;
}
async function liveLoad() {
  try {
    const [jobs, sessions, shells, devices, usage, logs, notes, llm, ts, projects] = await Promise.all([
      jget('/api/jobs'), jget('/api/sessions?kind=chat'), jget('/api/sessions?kind=shell'),
      jget('/api/devices'), jget(`/api/usage?since=${ovSince()}`), jget('/api/logs'), jget('/api/notes'), jget('/api/llm'),
      jget('/api/tailscale'), jget('/api/projects'),
    ]);
    LIVE.hidden = new Set((projects.hidden || []).map((h) => h.ws));
    LIVE.ts = ts;
    LIVE.shells = shells; // Terminal-page shells, never listed as chat sessions
    LIVE.llm = llm;
    window.LIVE = LIVE;
    /* Standalone sessions (created from the composer) have no job — take the flat list as truth. */
    const jobTitle = new Map(jobs.map((j) => [j.id, j.title]));
    const runs = sessions.map((r) => ({ ...r, jobTitle: jobTitle.get(r.job_id) || r.title }));
    /* Mutate the existing map: window.__liveRuns is a live reference used by modalRun. */
    notifyChanges([...sessions, ...jobs.flatMap((j) => j.runs || [])]);
    if (!window.__hub && !window.__hubErr && typeof hubLoad === 'function') hubLoad();
    LIVE.runs.clear();
    for (const r of runs) LIVE.runs.set(r.id, r);
    /* Job runs are not sessions: they live on the Jobs board and in Overview → Recent runs. */
    LIVE.jobRuns = jobs.flatMap((j) => (j.runs || []).map((r) => ({ ...r, jobTitle: j.title })));
    for (const r of LIVE.jobRuns) LIVE.runs.set(r.id, r);
    /* GOA mode is its own profile: only GOA's sessions and workspace; outside it, none of them. */
    const shown = runs.filter((r) => (r.ws === 'GOA') === !!prefs.goaMode);
    LIVE.sessions = shown.map((r) => ({
      id: r.id, title: r.jobTitle || r.prompt?.slice(0, 48) || r.cwd, ws: r.ws, branch: r.branch || r.model || r.agent,
      agent: r.agent, initial: (r.agent || 'S')[0].toUpperCase(), col: liveCol(r.status),
      progress: r.status === 'done' ? 100 : r.status === 'running' ? 55 : 0,
      elapsed: runFor(r), msgs: (r.stats && r.stats.msgs) || 0, tokens: r.stats ? uShort(r.stats.tin + r.stats.tout) : '0',
      ctx: r.stats && r.stats.ctx ? uShort(r.stats.ctx) : '',
      meta: `${r.device} · ${r.agent} · ${r.cwd}`, live: r,
    }));
    LIVE.devices = devices.map((d) => ({
      name: d.name, id: `xbl-${d.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      icon: d.thisHost ? 'laptop' : 'desktop',
      status: d.status || (d.thisHost ? 'online' : d.live ? 'online' : d.runs ? 'idle' : 'offline'),
      ts: !!d.ts, tsOnline: !!d.tsOnline, tsIp: d.tsIp || '', tailnet: d.tailnet || '',
      os: d.ts ? `${d.tsOs || 'tailscale'}${d.agent || d.thisHost ? '' : ' · no agent'}` : d.manual && !d.agent ? 'ssh'
        : d.thisHost || d.agent ? `${d.platform} ${d.release}` : 'no agent',
      arch: d.thisHost || d.agent ? `${d.platform} / ${d.arch}` : '—',
      cpu: d.cpu ?? null, ram: d.ram ?? null, ramUsed: d.ramUsed ?? null, ramTotal: d.ramTotal ?? null,
      sess: d.runs, seen: rel(d.seen), seenAt: d.seen || 0,
      host: d.thisHost || d.agent ? d.host || '—' : d.manual ? d.sshHost : '—', ip: d.tsIp || (d.thisHost ? d.host : '—'),
      uptime: d.uptimeH != null ? `${d.uptimeH}h` : '—', disk: d.disk ?? null,
      agent: d.thisHost ? 'host' : d.agent ? 'agent attached' : '—', transport: d.thisHost ? 'local' : d.agent ? 'ws dial-out' : d.manual ? 'ssh' : '—',
      home: d.home || '', root: d.root || '', cores: d.cores || null,
      agents: d.agents || null,   // null: nothing on that device reports what is installed
      manual: !!d.manual, sshHost: d.sshHost || '', sshPort: d.sshPort || 22, sshUser: d.sshUser || '', sshKey: d.sshKey || '', outdated: !!d.outdated,
      proj: (d.workspaces || []).map((ws) => ({ ws, cpu: null, ram: null, disk: 0 })),
      /* Requests and tokens this device ran in the Overview timeframe; sessions on this hub say 'local'. */
      use: ((usage.requests && usage.requests.perDevice) || []).find((u) => u.device === d.name || (d.thisHost && u.device === 'local')) || null,
    }));
    /* Project folders outlive their session list; deleting a session is not forgetting a project. */
    LIVE.projects = (projects.folders || []).filter((r) => !LIVE.hidden.has(r.ws) && (r.ws === 'GOA') === !!prefs.goaMode);
    const seen = new Map();
    for (const r of [...LIVE.projects, ...shown]) {
      if (LIVE.hidden.has(r.ws)) continue;   // forgotten project stays out of the sidebar
      if (!seen.has(r.ws)) seen.set(r.ws, new Set());
      seen.get(r.ws).add(r.device);
    }
    const palette = ['#5b7cff', '#f08ac0', '#3fb67a', '#f6c28b', '#6fe0cd', '#ef5b5b'];
    /* Only saved folders and real sessions, never the mock list in data.js. */
    {
      DB.workspaces = [...seen.entries()].map(([id, set], i) => ({
        id, dir: id,
        /* Only hosts that still exist in the fleet; a deleted device must not linger here. */
        hosts: [...set].filter((n) => LIVE.devices.some((d) => d.name === n)).join(' · ') || 'no device',
        color: palette[i % palette.length],
      }));
    }
    LIVE.logs = logs;
    LIVE.notes = notes.map((n) => ({
      id: n.id, title: n.title, when: rel(n.updated_at), ws: n.ws,
      tags: n.tags ? n.tags.split(/[ ,]+/).filter(Boolean).map((t) => (t[0] === '#' ? t : `#${t}`)) : [],
      pinned: !!n.pinned, body: n.body, file: n.file || '',
    }));
    LIVE.usage = usage;
    LIVE.sig = JSON.stringify([jobs, sessions, shells, devices, usage, notes, projects, ts]);
    LIVE.err = null;
  } catch (err) {
    LIVE.err = String(err.message || err);
  }
  if (state.page === 'usage') await routerLoad();
  LIVE.ready = true;
  /* Views read DB.* at render time, so point them at the live arrays. */
  DB.sessions = LIVE.sessions;
  DB.devices = LIVE.devices;
  DB.logs = LIVE.logs;
  DB.notes = LIVE.notes;
  if (LIVE.usage) {
    const u = LIVE.usage;
    const byStatus = Object.fromEntries((u.perStatus || []).map((s) => [s.status, s.n]));
    DB.usage.metrics = [
      { label: 'Runs total', value: String(u.runs || 0), sub: `${byStatus.running || 0} running · ${byStatus.waiting || 0} waiting`, tone: 'up' },
      { label: 'Output', value: kb(u.bytes || 0), sub: 'pty bytes captured', tone: 'muted' },
      { label: 'Failed', value: String(byStatus.failed || 0), sub: `${byStatus.done || 0} finished clean`, tone: byStatus.failed ? 'warn' : 'up' },
      { label: 'Devices', value: String((u.perDevice || []).length), sub: 'with runs', tone: 'muted' },
    ];
    DB.usage.perDevice = (u.perDevice || []).map((d) => ({ name: d.name, tokens: kb(d.bytes), pct: d.pct, cost: '—' }));
    DB.usage.days14 = (u.perDay || []).map((d) => d.d.slice(5));
    const max = Math.max(1, ...(u.perDay || []).map((d) => d.n));
    DB.usage.series = (u.perDay || []).map((d) => +(d.n / max).toFixed(2));
    DB.usage.storage = (u.perDevice || []).map((d) => ({ name: d.name, used: d.pct, size: kb(d.bytes) }));
    DB.usage.budget = { used: 0, total: 0, tokens: `${kb(u.bytes || 0)} output` };

    /* Requests in the Overview timeframe, one bar per day (days with none show empty). */
    const rq = u.requests || { n: 0, tin: 0, tout: 0, tcache: 0, perDay: [], lastNo: 0 };
    const byDay = new Map(rq.perDay.map((d) => [d.d, d.n]));
    const key = (t) => { const x = new Date(t); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; };
    const from = ovSince() || (rq.perDay[0] ? new Date(`${rq.perDay[0].d}T00:00`).getTime() : Date.now());
    const dayKeys = [];
    for (let t = from; t <= Date.now(); t += 86400000) dayKeys.push(key(t));
    if (!dayKeys.includes(key(Date.now()))) dayKeys.push(key(Date.now()));
    const shownDays = dayKeys.slice(-31);
    DB.chart7 = shownDays.map((d, i) => ({ d: d.slice(5), in: byDay.get(d) || 0, out: 0, today: i === shownDays.length - 1, val: String(byDay.get(d) || 0) }));
    DB.reqTotal = rq.n;

    const online = LIVE.devices.filter((d) => d.status === 'online').length;
    const running = LIVE.sessions.filter((s) => s.col === 'running').length;
    const range = { today: 'today', '7d': 'last 7 days', '30d': 'last 30 days', all: 'all time' }[state.ovRange || 'today'];
    const tk = (l, v, t) => `<span class="ico-tok" title="${t}"><i>${l}</i><b class="num">${uShort(v)}</b></span>`;
    DB.stats = [
      { icon: 'monitor', label: 'Devices online', value: String(online), delta: `${LIVE.devices.length} known`, dir: 'up', tone: 'up' },
      { icon: 'robot', label: `Requests · ${range}`, value: String(rq.n), delta: `#${rq.lastNo} all time · ${running} running`, dir: 'up', tone: 'up' },
      { icon: 'coins', label: `Tokens · ${range}`, html: tk('I', rq.tin - rq.tcache, 'Input, not from cache') + tk('C', rq.tcache, 'Read from prompt cache') + tk('O', rq.tout, 'Output'), dir: 'flat', tone: 'muted' },
    ];
  }
}

/* 9router usage for the Usage page; fetched only while that page is open. */
async function routerLoad() {
  try { LIVE.router = await jget(`/api/router/usage?period=${state.usagePeriod || 'today'}`); }
  catch (err) { LIVE.router = { period: state.usagePeriod || 'today', error: String(err.message || err) }; }
}

/* ---------- LLM endpoint: one setting, inherited by every run ---------- */
async function llmSave(fields = {}) {
  const val = (id) => (document.getElementById(id) || {}).value || '';
  const body = {
    base_url: fields.base_url ?? val('llm-base'),
    model: fields.model ?? val('llm-model'),
    ...('api_key' in fields ? { api_key: fields.api_key } : { api_key: val('llm-key') }),
  };
  const res = await fetch('/api/llm', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await res.json();
  if (j.error) { toast(`Save failed: ${j.error}`); return null; }
  LIVE.llm = j;
  await liveLoad();
  return j;
}

async function llmTest() {
  const st = document.getElementById('llm-status');
  if (st) st.textContent = 'Testing…';
  const res = await fetch('/api/llm/test', { method: 'POST' });
  const j = await res.json();
  const line = j.ok
    ? `OK · HTTP ${j.status} · ${j.models ?? '?'} models${j.sample ? ` · first: ${j.sample}` : ''}`
    : `Failed · ${j.error || `HTTP ${j.status}`}`;
  if (st) { st.textContent = line; st.className = `llm-status ${j.ok ? 'ok' : 'err'}`; }
  toast(`Endpoint ${j.ok ? 'reachable' : 'unreachable'}`, j.ok ? 'check-circle' : 'warning');
}

/* --- Tailscale: the device list source, configured once in Settings --- */
async function tsPut(payload) {
  return fetch('/api/tailscale', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
    .then(async (r) => ({ ok: r.ok, body: await r.json() }));
}
async function tsSave() {
  const mode = (window.__tsMode = window.__tsMode || (LIVE.ts && LIVE.ts.mode) || 'cli');
  const res = await tsPut({
    mode,
    tailnet: (document.getElementById('ts-tailnet') || {}).value || '-',
    api_key: (document.getElementById('ts-key') || {}).value || '',
    ssh_user: (document.getElementById('ts-ssh-user') || {}).value || '',
  });
  const line = document.getElementById('ts-status');
  if (!res.ok) { if (line) line.textContent = `Connect failed · ${res.body.error || 'unknown error'}`; toast('Tailscale connect failed', 'warning'); return; }
  await liveLoad();
  if (line) line.textContent = `Connected · ${res.body.devices.length} devices · ${res.body.tailnet || 'tailnet'}`;
  toast(`Tailscale: ${res.body.devices.length} devices`);
  render();
}
async function tsTest() {
  const r = await fetch('/api/tailscale/test').then((x) => x.json());
  const line = document.getElementById('ts-status');
  if (line) line.textContent = r.ok ? `OK · ${r.status} · ${r.devices} devices · ${r.tailnet || 'tailnet'}` : `Failed · ${r.error || r.status}`;
}
async function tsClear() {
  await fetch('/api/tailscale', { method: 'DELETE' });
  await liveLoad();
  toast('Tailscale key cleared');
  render();
}

/* Terminal tabs: one shell per tab, picked from the tailnet, closed with an ×. */
function termAlive(s) { return !!s && ['running', 'starting', 'waiting'].includes(s.status); }
function termActive() {
  const shells = LIVE.shells || [];
  const active = shells.find((s) => s.id === state.termTab);
  if (active) return active.id;
  const live = shells.find(termAlive) || shells[0];
  return live ? live.id : null;
}
function termSelect(id) {
  const s = (LIVE.shells || []).find((x) => x.id === id);
  if (!s) return;
  if (!termAlive(s)) { termOpen(s.device); return; } // dead session: reopen a shell on that host
  state.termTab = id;
  render();
}
async function termClose(id) {
  try { await fetch(`/api/sessions/${id}`, { method: 'DELETE' }); } catch {}
  if (state.termTab === id) state.termTab = null;
  const cache = window.__termSessions || {};
  for (const [host, sid] of Object.entries(cache)) if (sid === id) delete cache[host];
  await liveLoad();
  render();
}
async function termOpen(host) {
  /* An explicit tab is a new shell, even on a host that already has one. */
  const id = await termEnsure(host, true);
  if (!id) return;
  state.termTab = id;
  render();
}
/* The + button: pick a device from the fleet, then open a shell tab on it. */
function popDevices(anchor) {
  const devs = (DB.devices || []).slice().sort((a, b) => (b.status === 'online' ? 1 : 0) - (a.status === 'online' ? 1 : 0));
  popover.className = 'popover';
  popover.style.maxHeight = '';
  popover.innerHTML = `
    <div class="pop-head"><span style="flex:1">New shell on…</span></div>
    <div class="pop-body" style="padding:4px;max-height:280px;overflow:auto">
      ${devs.map((d) => `<div class="pop-row" data-devpick="${esc(d.name)}">
        <span class="dot ${d.status === 'online' ? 'up' : 'off'}"></span>${esc(d.name)}
        <span class="grow"></span><small class="dim">${esc(d.ip || (d.status === 'online' ? 'online' : 'offline'))}</small></div>`).join('')
        || '<div class="pop-row dim">No devices — connect Tailscale in Settings.</div>'}
    </div>`;
  const r = zRect(anchor);
  popover.style.width = '260px';
  popover.style.top = Math.round(Math.min(r.bottom + 6, VH() - 300)) + 'px';
  popover.style.left = Math.round(Math.max(8, Math.min(r.left, VW() - 270))) + 'px';
  popover.hidden = false;
  popover.querySelectorAll('[data-devpick]').forEach((row) => row.addEventListener('click', () => {
    const host = row.dataset.devpick;
    closeAll();
    termOpen(host);
  }));
}

/* Deleting a session means the row is gone from sqlite; a poll can never bring it back. */
/* After a delete: stay on the page you are on. Only when the session you are looking at is the
   one that went, move to a neighbouring open tab of that workspace; with none left, to the list. */
function afterDelete(gone) {
  const goneSet = new Set(gone);
  for (const ws of Object.keys(state.openTabs || {})) state.openTabs[ws] = state.openTabs[ws].filter((x) => !goneSet.has(x));
  if (state.selectedSession && goneSet.has(state.selectedSession)) state.selectedSession = null;
  if (!state.activeTab || !goneSet.has(state.activeTab)) return;
  const ws = (DB.sessions.find((x) => x.id === state.activeTab) || {}).ws;
  const next = ((state.openTabs || {})[ws] || []).find((x) => DB.sessions.some((y) => y.id === x && !goneSet.has(x)));
  state.activeTab = next || null;
  if (next) { state.selectedSession = next; state.sessionTitle = (DB.sessions.find((x) => x.id === next) || {}).title; }
  else if (state.page === 'session') { state.page = state.backPage || 'overview'; state.sessionTitle = null; }   // where you came from
}

async function sessionDelete(id) {
  try {
    const r = await fetch(`/api/sessions/${id}`, { method: 'DELETE' });
    if (!r.ok) { const b = await r.json().catch(() => ({})); toast(`Delete failed · ${b.error || r.status}`, 'warning'); return; }
    afterDelete([id]);
    await liveLoad();
    render();
    toast('Session deleted');
  } catch (err) { toast(`Delete failed · ${err.message}`, 'warning'); }
}

/* Clear a workspace's session list — the folder and its branches on disk stay put. */
async function wsClear(ws) {
  try {
    const r = await fetch(`/api/sessions?ws=${encodeURIComponent(ws)}`, { method: 'DELETE' });
    const b = await r.json().catch(() => ({}));
    if (!r.ok) { toast(`Clear failed · ${b.error || r.status}`, 'warning'); return; }
    afterDelete(b.ids || DB.sessions.filter((x) => x.ws === ws).map((x) => x.id));
    await liveLoad();
    render();
    toast(`${b.deleted || 0} session(s) cleared from ${ws}`);
  } catch (err) { toast(`Clear failed · ${err.message}`, 'warning'); }
}

/* "+" on a workspace: land straight on a fresh chat page for that workspace. The title stays
   "New session" until the first message lands, then it is renamed from that message. */
async function newChatIn(ws) {
  try {
    const known = LIVE.sessions.find((s) => s.ws === ws);
    const folder = (LIVE.projects || []).find((p) => p.ws === ws);
    const r = await fetch('/api/sessions', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'New session', ws, kind: 'chat', cwd: (known && known.live && (known.live.origin || known.live.cwd)) || (folder && folder.cwd) || ws, device: (known && known.live && known.live.device) || (folder && folder.device) || 'local', agent: 'shell' }),
    });
    const s = await r.json();
    if (!r.ok) { toast(`Could not start a session · ${s.error || r.status}`, 'warning'); return; }
    await liveLoad();
    state.selectedSession = s.id;
    state.activeTab = s.id;
    state.sessionTitle = s.title;
    state.sent = [];
    state.attached = [];
    state.openWs = ws;
    state.ws = ws;
    const bucket = tabsOf(ws);
    if (!bucket.includes(s.id)) state.openTabs = { ...state.openTabs, [ws]: [...bucket, s.id] };
    state.page = 'session';
    render();
    setTimeout(() => document.getElementById('composer')?.focus(), 60);
  } catch (err) { toast(`Could not start a session · ${err.message}`, 'warning'); }
}

/* Forget a project: XBLabs drops the row and its sessions. Files on disk are never touched. */
async function wsDelete(ws) {
  try {
    const r = await fetch(`/api/projects/${encodeURIComponent(ws)}`, { method: 'DELETE' });
    const b = await r.json().catch(() => ({}));
    if (!r.ok) { toast(`Delete failed · ${b.error || r.status}`, 'warning'); return; }
    afterDelete(DB.sessions.filter((x) => x.ws === ws).map((x) => x.id));
    if (state.openWs === ws) state.openWs = null;
    if (state.ws === ws) state.ws = 'all';
    await liveLoad();
    render();
    toast(`${ws} forgotten · ${b.deleted || 0} session(s) removed`, 'trash');
  } catch (err) { toast(`Delete failed · ${err.message}`, 'warning'); }
}

/* Device row menu: everything here does something real. */
function popDeviceMenu(anchor, dev) {
  if (!dev) return;
  const items = [
    ['term', 'Open terminal', dev.status === 'online' ? '' : 'offline'],
    ['ip', 'Copy tailnet IP', dev.ip || 'no address'],
    ['name', 'Copy hostname', dev.name],
    ['admin', 'Open in Tailscale admin', ''],
  ];
  popover.className = 'popover';
  popover.style.maxHeight = '';
  popover.innerHTML = `
    <div class="pop-head"><span style="flex:1">${esc(dev.name)}</span><small class="dim">${esc(dev.id)}</small></div>
    <div class="pop-body" style="padding:4px">
      ${items.map(([k, label, sub]) => `<div class="pop-row" data-devact="${k}">
        <span style="flex:1">${label}</span>${sub ? `<small class="dim">${esc(sub)}</small>` : ''}</div>`).join('')}
    </div>`;
  const r = zRect(anchor);
  popover.style.width = '248px';
  popover.style.top = Math.round(Math.min(r.bottom + 6, VH() - 240)) + 'px';
  popover.style.left = Math.round(Math.max(8, Math.min(r.right - 248, VW() - 256))) + 'px';
  popover.hidden = false;
  popover.querySelectorAll('[data-devact]').forEach((row) => row.addEventListener('click', async () => {
    const act = row.dataset.devact;
    closeAll();
    if (act === 'term') { state.page = 'logs'; render(); termOpen(dev.name); return; }
    if (act === 'ip' || act === 'name') {
      const text = act === 'ip' ? dev.ip : dev.name;
      if (!text) { toast('No address for this device'); return; }
      try { await navigator.clipboard.writeText(text); toast(`Copied ${text}`); } catch { toast(text); }
      return;
    }
    if (act === 'admin') window.open('https://login.tailscale.com/admin/machines', '_blank');
  }));
}

/* Terminal page = a real shell for the chosen host, one per host, reused while it lives.
   A host with no agent says so instead of pretending to connect. */
async function termEnsure(host, force = false) {
  const cache = (window.__termSessions = window.__termSessions || {});
  const alive = (s) => s && ['running', 'starting', 'waiting'].includes(s.status);
  const shells = LIVE.shells || [];
  const byId = (id) => shells.find((s) => s.id === id);
  if (!force) {
    if (alive(byId(cache[host]))) return cache[host];
    /* Reloads adopt the shell already running for this host instead of spawning another. */
    const prev = shells
      .filter((s) => s.device === host && alive(s))
      .sort((a, b) => b.created_at - a.created_at)[0];
    if (prev) { cache[host] = prev.id; return prev.id; }
  }
  if (window.__termPending === host) return null;

  const dev = LIVE.devices.find((d) => d.name === host);
  /* A tailnet host needs no agent: the hub ssh's in with its own key. */
  if (host !== 'local' && !(dev && (dev.ts || dev.agent))) {
    toast(`${host}: not in the tailnet — connect Tailscale in Settings`);
    return null;
  }
  window.__termPending = host;
  try {
    const cwd = (dev && (dev.home || dev.root)) || 'C:/XBLabs';
    const s = await fetch('/api/sessions', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: `${host} · shell`, cwd, device: host, agent: 'shell', kind: 'shell', ws: 'xblabs-web' }),
    }).then((r) => r.json());
    if (s.error) { toast(`Shell failed: ${s.error}`); return null; }
    cache[host] = s.id;
    await liveLoad();
    return s.id;
  } catch (err) { toast(`Shell failed: ${err.message}`); return null; }
  finally { window.__termPending = null; }
}

/* ---------- model catalog ----------
   Rows are edited in place: a draft keeps rows the user added but has not filled in yet, and
   every change saves the filled rows to the hub. The caret marks a row as the endpoint's
   default model (the same value as the Default model field above). */
const modelShort = (id) => String(id || '').split('/').pop();
let mcatDraft = null;
const mcatList = () => mcatDraft || ((LIVE.llm && LIVE.llm.models) || []).map((m) => ({ ...m }));
/* Model test results by id: green ok with the time, red with the error, a spinner while asking. */
const MTEST = {};
function mtestBtn(id) {
  const r = id && MTEST[id];
  const st = !r ? '' : r.busy ? 'busy' : r.ok ? 'ok' : 'err';
  const tip = !r ? 'Test this model' : r.busy ? 'Testing…' : r.ok ? `OK · ${(r.ms / 1000).toFixed(1)}s` : `Error · ${r.error}`;
  return `<button class="mcat-btn mtest ${st}" data-act="mcat-test" title="${esc(tip)}" aria-label="${esc(tip)}">${r && r.busy ? '<i class="mt-spin"></i>' : ic(r ? (r.ok ? 'check-circle' : 'x-circle') : 'play-circle', r ? 'fill' : 'regular')}</button>`;
}
async function mtest(id) {
  MTEST[id] = { busy: true }; mcatRepaint();
  const j = await fetch('/api/llm/test-model', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: id }) })
    .then((r) => r.json()).catch((err) => ({ ok: false, error: err.message }));
  MTEST[id] = j; mcatRepaint();
  return j;
}
function mcatRows() {
  const list = mcatList();
  const def = LIVE.llm && LIVE.llm.model;
  return list.map((m, i) => `
    <div class="mcat-row" data-i="${i}">
      <span class="input"><input data-mcat="id" data-combo="__llmAvail" autocomplete="off" value="${esc(m.id)}" placeholder="Model id, as the endpoint names it" aria-label="Model id"></span>
      <span class="input"><input data-mcat="name" value="${esc(m.name)}" placeholder="${esc(modelShort(m.id) || 'Display name')}" aria-label="Display name"></span>
      ${mtestBtn(m.id)}
      <button class="mcat-btn ${m.id && m.id === def ? 'on' : ''}" data-act="mcat-default" title="${m.id && m.id === def ? 'Default model' : 'Make default model'}">${ic('caret-right', 'bold')}</button>
      <button class="mcat-btn" data-act="mcat-del" title="Remove model">${ic('trash')}</button>
    </div>`).join('') || '<div class="dim mcat-empty">No models yet. Add one or fetch what the endpoint serves.</div>';
}
function mcatRepaint() { const el = document.getElementById('mcat-list'); if (el) el.innerHTML = mcatRows(); }
function mcatRead() {
  return [...document.querySelectorAll('#mcat-list .mcat-row')].map((r) => ({
    id: r.querySelector('[data-mcat="id"]').value.trim(), name: r.querySelector('[data-mcat="name"]').value.trim(),
  }));
}
async function mcatSave(list) {
  mcatDraft = list;
  const r = await fetch('/api/llm/models', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ models: list.filter((m) => m.id) }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { toast(`Models not saved · ${j.error || r.status}`, 'warning'); return false; }
  if (LIVE.llm) LIVE.llm.models = j.models;
  if (!list.some((m) => !m.id)) mcatDraft = null;          // nothing half-filled left to keep
  return true;
}
document.addEventListener('change', (e) => {
  if (!e.target.closest('#mcat-list [data-mcat]')) return;
  mcatSave(mcatRead()).then((ok) => { if (ok) mcatRepaint(); });
});
document.addEventListener('click', async (e) => {
  const act = e.target.closest('[data-act^="mcat-"]');
  if (!act) return;
  e.stopPropagation();
  const list = mcatRead();
  const i = +(act.closest('.mcat-row')?.dataset.i ?? -1);
  if (act.dataset.act === 'mcat-add') {
    mcatDraft = [...list, { id: '', name: '' }]; mcatRepaint();
    document.querySelector('#mcat-list .mcat-row:last-child [data-mcat="id"]')?.focus();
  } else if (act.dataset.act === 'mcat-del') {
    list.splice(i, 1); if (await mcatSave(list)) mcatRepaint();
  } else if (act.dataset.act === 'mcat-default') {
    const m = list[i];
    if (!m || !m.id) { toast('Fill in the model id first', 'info'); return; }
    const field = document.getElementById('llm-model');
    if (field) field.value = m.id;
    await mcatSave(list); await llmSave(); mcatRepaint();
    toast(`Default model · ${m.name || modelShort(m.id)}`);
  } else if (act.dataset.act === 'mcat-test') {
    const m = list[i];
    if (!m || !m.id) { toast('Fill in the model id first', 'info'); return; }
    const j = await mtest(m.id);
    toast(j.ok ? `${modelShort(m.id)} OK · ${(j.ms / 1000).toFixed(1)}s` : `${modelShort(m.id)} failed · ${j.error}`, j.ok ? 'check-circle' : 'warning');
  } else if (act.dataset.act === 'mcat-test-all') {
    const ids = list.map((m) => m.id).filter(Boolean);
    const res = await Promise.all(ids.map(mtest));
    const bad = res.filter((r) => !r.ok).length;
    toast(bad ? `${bad} of ${ids.length} models failed` : `All ${ids.length} models answered`, bad ? 'warning' : 'check-circle');
  } else if (act.dataset.act === 'mcat-reset') {
    const def = LIVE.llm && LIVE.llm.model;
    if (await mcatSave(def ? [{ id: def, name: modelShort(def) }] : [])) mcatRepaint();
    toast('Model list restored');
  } else if (act.dataset.act === 'mcat-fetch') {
    const r = await fetch('/api/llm/models/available');
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { toast(`Could not fetch models · ${j.error || r.status}`, 'warning'); return; }
    const have = new Set(list.map((m) => m.id));
    const fresh = j.models.filter((id) => !have.has(id));
    if (!fresh.length) { toast(`All ${j.models.length} models are already listed`, 'info'); return; }
    glideSelect(act, {
      options: fresh.map((id) => ({ value: id, label: id })), value: null, label: 'Add a model', width: 360,
      onPick: async (id) => { if (await mcatSave([...mcatRead().filter((m) => m.id), { id, name: modelShort(id) }])) mcatRepaint(); },
    });
  }
}, true);

/* ---------- notes write path ---------- */
async function liveNewNote() {
  try {
    const note = await fetch('/api/notes', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Untitled note', body: '', ws: 'xblabs-web', tags: '' }),
    }).then((r) => r.json());
    await liveLoad();
    state.selectedNote = note.id;
    state.notePreview = false;   // a new note is for typing
    state.page = 'notes';
    render();
    setTimeout(() => { const t = $('#note-body'); if (t) { t.focus(); t.setSelectionRange(0, 8); } }, 80);
  } catch (err) { toast(`Note failed: ${err.message}`); }
}

document.addEventListener('click', async (e) => {
  const up = e.target.closest('[data-uperiod]');
  if (up) { state.usagePeriod = up.dataset.uperiod; render(); return; }
  const um = e.target.closest('[data-umetric]');
  if (um) { state.usageMetric = um.dataset.umetric; render(); return; }
  if (e.target.closest('[data-act="router-save"]')) {
    e.stopPropagation();
    const password = ($('#router-pass') || {}).value || '';
    if (!password) { toast('Type the 9router dashboard password first', 'warning'); return; }
    await fetch('/api/router', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }) });
    await routerLoad(); render();
    toast(LIVE.router && !LIVE.router.error ? 'Signed in to 9router' : `9router: ${LIVE.router.error}`);
    return;
  }
  const llmChip = e.target.closest('[data-llm-agent]');
  if (llmChip) {
    e.stopPropagation();
    const cur = new Set((LIVE.llm && LIVE.llm.agents) || []);
    const a = llmChip.dataset.llmAgent;
    cur.has(a) ? cur.delete(a) : cur.add(a);
    const r = await fetch('/api/llm/agents', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agents: [...cur] }) });
    const j = await r.json();
    if (j.error) { toast(`Save failed: ${j.error}`); return; }
    LIVE.llm = j; render();
    llmChip.classList.toggle('active', cur.has(a)); llmChip.setAttribute('aria-pressed', String(cur.has(a)));
    if (!cur.has(a) && llmChip.classList.contains('off')) llmChip.disabled = true;   // not installed: off for good once turned off
    const nm = a === 'shell' ? 'Plain shell' : AGENT_NAMES[a] || a;
    toast(cur.has(a) ? `${nm} runs use this endpoint` : `${nm} runs use their own config`);
    return;
  }
  if (e.target.closest('[data-act="llm-save"]')) { e.stopPropagation(); await llmSave(); toast('Endpoint saved'); return; }
  if (e.target.closest('[data-act="llm-test"]')) { e.stopPropagation(); await llmTest(); return; }
  if (e.target.closest('[data-act="ts-save"]')) { e.stopPropagation(); tsSave(); return; }
  if (e.target.closest('[data-act="ts-test"]')) { e.stopPropagation(); tsTest(); return; }
  if (e.target.closest('[data-act="ts-clear"]')) { e.stopPropagation(); tsClear(); return; }
  const modeBtn = e.target.closest('[data-act^="ts-mode-"]');
  if (modeBtn) {
    window.__tsMode = modeBtn.dataset.act.slice(8);
    document.querySelectorAll('[data-act^="ts-mode-"]').forEach((b) => b.classList.toggle('active', b === modeBtn));
    return;
  }
  if (e.target.closest('[data-act="llm-clear"]')) {
    e.stopPropagation();
    await fetch('/api/llm', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ base_url: (document.getElementById('llm-base') || {}).value || '', model: (document.getElementById('llm-model') || {}).value || '', clear_key: true }) });
    await liveLoad(); toast('Key cleared'); render(); return;
  }
  if (e.target.closest('[data-act="note-autosave"]')) {
    e.stopPropagation();
    prefs.noteAutosave = !prefs.noteAutosave; savePrefs();
    if (prefs.noteAutosave) await noteSaveNow();   // what is typed so far is kept
    render(); return;
  }
  if (e.target.closest('[data-act="note-preview"]')) {
    e.stopPropagation();
    if (!state.notePreview) await noteSaveNow();
    state.notePreview = !state.notePreview; render(); return;
  }
  const fmt = e.target.closest('[data-note-fmt]');
  if (fmt) {
    e.stopPropagation();
    const t = $('#note-body'), f = fmt.dataset.noteFmt;
    if (!t) return;
    const a = t.selectionStart, b = t.selectionEnd;
    if (f.endsWith(' ')) {   // a line prefix: heading, list, quote; replaces the line's old one
      const s = t.value.lastIndexOf('\n', a - 1) + 1;
      const old = (t.value.slice(s).match(/^(#{1,3} |[-*] (?!\[)|> )/) || [''])[0];
      t.setRangeText(old === f ? '' : f, s, s + old.length, 'end');
    } else {                 // wraps the selection: bold, italic, strike, code
      t.setRangeText(f + t.value.slice(a, b) + f, a, b, 'select');
      t.setSelectionRange(a + f.length, b + f.length);
    }
    t.focus();
    t.dispatchEvent(new Event('input', { bubbles: true }));
    return;
  }
  if (e.target.closest('[data-act="note-check"]')) {
    e.stopPropagation();
    const t = $('#note-body');
    if (!t) return;
    /* A new "- [ ] " line under the caret's line. */
    const at = t.value.indexOf('\n', t.selectionEnd);
    const end = at < 0 ? t.value.length : at;
    const ins = `${t.value && end > 0 && t.value[end - 1] !== '\n' ? '\n' : ''}- [ ] `;
    t.setRangeText(ins, end, end, 'end');
    t.focus();
    t.dispatchEvent(new Event('input', { bubbles: true }));
    return;
  }
  const save = e.target.closest('[data-note-save]');
  const del = e.target.closest('[data-note-del]');
  if (save) {
    e.stopPropagation();
    const body = ($('#note-body') || {}).value ?? '';
    await fetch(`/api/notes/${save.dataset.noteSave}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body }),
    });
    await liveLoad(); toast('Note saved');
    return;
  }
  if (del) {
    e.stopPropagation();
    await fetch(`/api/notes/${del.dataset.noteDel}`, { method: 'DELETE' });
    await liveLoad(); state.selectedNote = null; render(); toast('Note deleted');
  }
});

/* Notes: one PATCH, the local row updated in place so typing is never re-rendered under me. */
async function notePatch(id, patch) {
  const r = await fetch(`/api/notes/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) });
  if (!r.ok) throw new Error(r.statusText);
  const n = DB.notes.find((x) => x.id === id);
  if (n) Object.assign(n, patch);
  const st = document.getElementById('note-state');
  if (st) st.textContent = 'Saved';
}
async function noteSaveNow() {
  const t = $('#note-body');
  if (!t) return;
  const n = DB.notes.find((x) => x.id === t.dataset.noteId);
  if (n && n.body !== t.value) await notePatch(n.id, { body: t.value }).catch((err) => toast(`Not saved: ${err.message}`, 'warning'));
}
let noteTimer = null;
document.addEventListener('input', (e) => {
  const t = e.target.closest('#note-body');
  if (!t || !prefs.noteAutosave) return;
  const st = document.getElementById('note-state');
  if (st) st.textContent = 'Saving…';
  clearTimeout(noteTimer);
  const id = t.dataset.noteId, body = t.value;   // this note, as typed now: switching notes cannot misfile it
  noteTimer = setTimeout(() => notePatch(id, { body }).catch((err) => toast(`Not saved: ${err.message}`, 'warning')), 700);
});
/* Rename: Enter or leaving the field saves; Esc puts the old title back. */
document.addEventListener('keydown', (e) => {
  const inp = e.target.closest && e.target.closest('[data-note-title]');
  if (!inp) return;
  if (e.key === 'Enter') { e.preventDefault(); inp.blur(); }
  if (e.key === 'Escape') { const n = DB.notes.find((x) => x.id === inp.dataset.noteTitle); if (n) inp.value = n.title; inp.blur(); }
});
document.addEventListener('focusout', async (e) => {
  const inp = e.target.closest && e.target.closest('[data-note-title]');
  if (!inp) return;
  const n = DB.notes.find((x) => x.id === inp.dataset.noteTitle);
  const title = inp.value.trim();
  if (!n || !title || title === n.title) { if (n) inp.value = n.title; return; }
  try { await notePatch(n.id, { title }); await liveLoad(); render(); toast('Note renamed'); }
  catch (err) { toast(`Rename failed: ${err.message}`, 'warning'); }
});
/* Preview: ticking a box flips that line's [ ] / [x] and saves. */
document.addEventListener('change', async (e) => {
  const box = e.target.closest && e.target.closest('[data-note-chk]');
  if (!box) return;
  const n = DB.notes.find((x) => x.id === state.selectedNote);
  if (!n) return;
  const lines = String(n.body || '').split('\n');
  const i = +box.dataset.noteChk;
  lines[i] = lines[i].replace(/\[( |x|X)\]/, box.checked ? '[x]' : '[ ]');
  try {
    await notePatch(n.id, { body: lines.join('\n') });
    n.body = lines.join('\n');   // the counters follow the tick without a re-render (which would jump the scroll)
    document.querySelectorAll('.editor .note-prog, .note-item.active .note-prog').forEach((p) => { p.outerHTML = noteProg(noteTodos(n.body)); });
  } catch (err) { box.checked = !box.checked; toast(`Not saved: ${err.message}`, 'warning'); }
});

async function liveBoot() {
  await liveLoad();
  if (state.page === 'jobs' && typeof loadJobs === 'function') loadJobs({ quiet: true });
  render();
}

/* Refresh the log rows in place: a full render() would tear down the mounted terminal. */
function refreshLogPanel() {
  const body = document.querySelector('.term-logpanel .console-body');
  if (!body) return;
  /* Same scoping as viewLogs: a log line belongs to the tab you are looking at. */
  const active = document.querySelector('.ttab.active')?.dataset.termtab || null;
  const rows = active ? DB.logs.filter((l) => (state.logLevel === 'all' || l.lvl === state.logLevel)
    && (state.logFilter === 'all' || l.src === state.logFilter) && String(l.msg).includes(active)) : [];
  body.innerHTML = rows.map((l) => `<div class="logrow ${l.lvl}"><time>${l.t}</time><span class="lvl">${l.lvl}</span>`
    + `<span class="src">${l.src}</span><span class="msg">${esc(l.msg)}</span></div>`).join('')
    || `<div class="jempty">${active ? 'No events for this shell yet.' : 'Open a terminal tab to see its log.'}</div>`;
  const badge = document.querySelector('.term-logpanel .wsbadge');
  if (badge) badge.textContent = String(rows.length);
}

/* A poll never re-renders under someone typing: it would steal focus and drop the caret. */
const typing = () => !!document.activeElement?.closest?.('#main input, #main textarea, #main select');
setInterval(() => { if (!document.hidden) liveLoad().then(() => {
  if (typing() || document.querySelector('.u-plot:hover')) return;   // keep the chart tooltip under the cursor
  if (state.page === 'logs') return refreshLogPanel();   // terminal stays mounted
  /* The live page owns its terminal; it re-renders only when it was drawn before its run loaded. */
  if (state.page === 'session') { if (render.bubble !== bubbleChat(state.activeTab)) render(); else { sessionStatusPaint(state.activeTab); graphPaint(state.activeTab); } return; }
  if (!['sessions', 'devices', 'usage', 'notes', 'overview'].includes(state.page)) return;
  const now = Date.now(), seen = liveLoad.seen || {};
  if (seen.sig === LIVE.sig && seen.page === state.page && now - seen.at < 60000) return;   // same data: no repaint
  liveLoad.seen = { sig: LIVE.sig, page: state.page, at: now };
  render();
}); }, 5000);

liveBoot();
