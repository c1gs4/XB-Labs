/* XBLabs — UI shell. No framework, no build step. */
const DB = window.DB;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

/* ---------- preferences ----------
   Everything Settings can change, keyed by the row title it is shown under, mirrored to
   localStorage so a restart keeps it. Values here are per machine, not per workspace. */
const PREFS_KEY = 'xblabs.prefs';
const prefs = (() => { try { return JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') || {}; } catch { return {}; } })();
/* The hub keeps a copy too (/api/ui-state): localStorage is per origin, so another address or a cleared
   browser would otherwise lose the theme and profile. */
const uiPushT = {};
function uiPush(key, value) {
  clearTimeout(uiPushT[key]);
  uiPushT[key] = setTimeout(() => fetch('/api/ui-state', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ [key]: value }) }).catch(() => {}), 300);
}
function savePrefs() { try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* private mode: session-only */ } uiPush('prefs', prefs); }
/* Notification sounds: synthesized tones, no files. Quiet hours are "HH:MM" strings and may cross midnight. */
function inQuiet(from, to, now) {
  if (!from || !to || from === to) return false;
  return from < to ? now >= from && now < to : now >= from || now < to;
}
console.assert(inQuiet('09:00', '17:00', '12:00') && !inQuiet('09:00', '17:00', '17:00') && inQuiet('22:00', '07:00', '23:30') && inQuiet('22:00', '07:00', '06:59') && !inQuiet('22:00', '07:00', '12:00') && !inQuiet('', '', '12:00'), 'inQuiet');
let notifCtx;
function playSound(kind, force) {
  if (!force && (prefs.sound === false || inQuiet(prefs.quietFrom, prefs.quietTo, new Date().toTimeString().slice(0, 5)))) return;
  const vol = Math.min(100, Math.max(0, parseInt(prefs.soundVolume ?? 60, 10) || 0)) / 100;
  try {
    notifCtx = notifCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (notifCtx.state === 'suspended') notifCtx.resume();
    // [frequency Hz, start s, length s, wave]
    const notes = { done: [[660, 0, .12, 'sine'], [880, .13, .2, 'sine']], input: [[1040, 0, .3, 'triangle']], error: [[200, 0, .15, 'square'], [200, .2, .2, 'square']], chat: [[520, 0, .07, 'sine']] }[kind] || [];
    for (const [f, at, len, type] of notes) {
      const o = notifCtx.createOscillator(), g = notifCtx.createGain(), t = notifCtx.currentTime + at;
      o.type = type; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0001, vol * (type === 'square' ? .15 : .4)), t + .015);
      g.gain.exponentialRampToValueAtTime(0.0001, t + len);
      o.connect(g).connect(notifCtx.destination); o.start(t); o.stop(t + len + .02);
    }
  } catch { /* audio blocked or unavailable: stay silent */ }
}
const START_PAGES = { Overview: 'overview', Sessions: 'sessions', Jobs: 'jobs', Devices: 'devices', Usage: 'usage', Town: 'town', Terminal: 'logs', Notes: 'notes' };
const sysDark = window.matchMedia('(prefers-color-scheme: dark)');

const state = {
  page: START_PAGES[prefs['Start page']] || 'overview',
  ws: 'all',
  // Which directory is expanded in the sidebar. Kept apart from `ws` (the board filter) so the
  // list can show its sessions while the board still says "All".
  openWs: 'xblabs-web',
  // Right side panel of the agent session: which tab is showing and how wide it is. Width is
  // user-draggable via the splitter and clamped so neither pane can be crushed.
  sideTab: 'model',
  chatView: prefs.chatLayout === 'term' ? 'term' : 'chat',
  sideW: 420,
  view: 'board',
  /* Dark and light themes are picked separately; mode decides which one shows. A saved 'paper'
     in palette from older builds means "light". */
  palette: prefs.palette && prefs.palette !== 'paper' ? prefs.palette : 'midnight',
  lightPalette: prefs.lightPalette || 'paper',
  sidebar: true, wsCollapsed: false,
  selectedDevice: null,   // a device name: indexes shift when the table sorts or filters
  selectedSession: 'ses_9f2c1a',
  selectedNote: null,   // a note id: the list re-sorts by last edit, so an index would drift to another note
  logLevel: 'all',
  logTab: 'all',
  termTab: null,
  termLogs: true,
  logsPaused: false,
  settingsTab: 'general',
  status: 'online',
  filesOpen: true,
  sessionTitle: 'Reduce deploy image size',
  selFile: null,
  viewFile: null,
  folders: {},
  model: '',   // syncModel() picks the default model from Models & keys
  reasoning: 'Medium',
  approval: 'Auto-approve',   // the mode a new session starts with; each session keeps its own (approval column)
  attached: [],
  sent: [],
  /* Tabs are bucketed per project: opening a session never mixes another workspace's
     sessions into the strip. Key = workspace id, value = ordered session ids. */
  openTabs: {
    'xblabs-web': ['ses_77c0e4', 'ses_9f2c1a'],
    'xblabs-api': ['ses_c81f3d'],
    'docs-site': ['ses_2ab91f']
  },
  activeTab: 'ses_77c0e4',
  /* Filters and view options that real controls write to. Kept flat so a re-render is always
     the single source of truth for what the lists show. */
  devStatus: 'all',
  noteFilter: 'all',
  range: 7,
  group: false,
  sort: 'recent',
  devSort: 'status',
  logFollow: true,
  logFilter: 'all',
  themeMode: prefs.mode || (prefs.palette === 'paper' ? 'light' : 'dark'),
  chartMetric: 'tokens',
  layoutSaved: false,
  devQuery: '',
  noteQuery: '',
  notePreview: true,   // notes open formatted; the pencil edits
  sessQuery: ''
};

/* One function turns prefs into what the document shows: theme, mode, code font,
   scale, motion and the glass wallpaper. Called at boot and after every Settings change. */
/* UI scale is CSS zoom on <html>. Rects, pointer coords and innerWidth/innerHeight come back in
   screen px, while left/top/width written to styles are zoomed again: convert to page px first. */
const ZM = () => parseFloat(document.documentElement.style.zoom) || 1;
const VW = () => window.innerWidth / ZM(), VH = () => window.innerHeight / ZM();
function zRect(el) {
  const r = el.getBoundingClientRect(), z = ZM();
  return { left: r.left / z, right: r.right / z, top: r.top / z, bottom: r.bottom / z, width: r.width / z, height: r.height / z };
}
function applyPrefs() {
  const root = document.documentElement;
  /* Mode picks the family: dark shows the chosen dark theme, light the chosen light theme. */
  const light = isLight();
  root.dataset.mode = light ? 'light' : 'dark';
  root.dataset.theme = light ? state.lightPalette : state.palette;
  const font = prefs['Monospace font'];
  root.style.setProperty('--font-code', font && font !== 'JetBrains Mono' ? `"${font}", var(--font-mono)` : 'var(--font-mono)');
  const scale = Math.min(150, Math.max(75, parseInt(prefs['UI scale'], 10) || 100));
  /* The desktop build zooms the webview itself (every coordinate stays right); the browser falls back to CSS zoom. */
  const native = globalThis.__TAURI__?.webview?.getCurrentWebview?.();
  if (native) native.setZoom(scale / 100).catch(() => {});
  root.style.zoom = native || scale === 100 ? '' : String(scale / 100);
  root.style.setProperty('--zoom', native ? '1' : String(scale / 100));   // CSS divides 100vh by it (zoom scales vh too)
  const chatSize = Math.min(18, Math.max(11, parseFloat(prefs['Chat font size']) || 12));
  root.style.setProperty('--chat-font-size', `${chatSize}px`);
  root.toggleAttribute('data-reduce-motion', !!prefs['Reduce motion']);
  root.toggleAttribute('data-privacy', !!prefs.privacy);
  const g = prefs.glass;
  root.toggleAttribute('data-glass', !!(g && g.on && g.img));
  if (g && g.img) {
    root.style.setProperty('--glass-img', `url("${g.img}")`);
    root.style.setProperty('--glass-panel', `${g.panel ?? 72}%`);
    root.style.setProperty('--glass-blur', `${g.blur ?? 18}px`);
    root.style.setProperty('--glass-dim', String((g.dim ?? 24) / 100));
    root.style.setProperty('--glass-fit', { Fill: 'cover', Fit: 'contain', Stretch: '100% 100%' }[g.fit || 'Fill']);
  }
}
function isLight() { return state.themeMode === 'system' ? !sysDark.matches : state.themeMode === 'light'; }
sysDark.addEventListener('change', () => { if (state.themeMode === 'system') applyPrefs(); });
applyPrefs();

/* ---------- helpers ---------- */
function ic(name, weight = 'regular', extra = '') {
  const cls = weight === 'fill' ? 'icon fill ph-fill' : weight === 'bold' ? 'icon bold ph-bold' : 'icon ph';
  return `<i class="${cls} ph-${name}${extra ? ' ' + extra : ''}" aria-hidden="true"></i>`;
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
/* "9.4/15.8G" — used / total, so a percentage is never the whole story. */
/* ponytail: title = first message, trimmed. Upgrade to an LLM summary once /api/llm has a key. */
function chatTitle(text) {
  const one = String(text).split('\n')[0].replace(/[`*_#>]/g, '').replace(/\s+/g, ' ').trim();
  if (one.length <= 52) return one || 'New session';
  const cut = one.slice(0, 52);
  const at = cut.lastIndexOf(' ');
  return cut.slice(0, at > 20 ? at : 52) + '\u2026';
}

const memText = (used, total) => {
  if (!used || !total) return '';
  const g = (n) => (n >= 1073741824 ? (n / 1073741824).toFixed(1) + 'G' : Math.round(n / 1048576) + 'M');
  return `${g(used)}/${g(total)}`;
};
document.documentElement.dataset.build = document.querySelector('meta[name=build]')?.content || '?';
console.info('[XBLabs] build', document.documentElement.dataset.build);

const wsColor = (id) => (DB.workspaces.find((w) => w.id === id) || {}).color || 'var(--accent)';
const statusPill = (s) => `<span class="status ${s}"><i></i>${s[0].toUpperCase() + s.slice(1)}</span>`;
const agentInitial = (a) => a.replace(/[^A-Za-z0-9]/g, '').slice(0, 1).toUpperCase();


/* ---------- titlebar ----------
   Updated design: the separate topbar is gone. Breadcrumb, search, quick commands and
   New session all live in the 40 px title bar, right of the focus pill and context. */
/* Patch `el` to match `html` in place instead of replacing it. Re-created nodes restart their
   CSS animations and transitions, re-decode images and drop :hover, which reads as a blink on
   every page switch. Unchanged nodes are left untouched. */
function morph(el, html) {
  const t = document.createElement('template');
  t.innerHTML = html;
  morphKids(el, t.content);
}
function morphKids(a, b) {
  const bn = [...b.childNodes];
  bn.forEach((n, i) => {
    let o = a.childNodes[i];
    /* Keyed by id: a node with an id that moved (a sibling appeared before it) is moved, not rebuilt. */
    if (n.nodeType === 1 && n.id && o?.id !== n.id) { const k = [...a.children].find((c) => c.id === n.id); if (k) { a.insertBefore(k, o || null); o = k; } }
    if (!o) a.append(n);
    else if (o.nodeType !== n.nodeType || o.nodeName !== n.nodeName) o.replaceWith(n);
    else if (o.nodeType !== 1) { if (o.nodeValue !== n.nodeValue) o.nodeValue = n.nodeValue; }
    else if (o.__live && o.id && o.id === n.id) {   // a live terminal keeps its xterm; a session change rebuilds anyway
      for (const { name, value } of [...n.attributes]) if (o.getAttribute(name) !== value) o.setAttribute(name, value); }
    else if (o.nodeName === 'CANVAS') {
      // width/height are set by the drawing code, not the markup; touching them clears the canvas
      for (const { name, value } of [...n.attributes]) if (o.getAttribute(name) !== value) o.setAttribute(name, value);
    } else {
      // Custom properties written by script (card glow, stagger index) are not in the markup;
      // dropping them on a poll snapped the glow off and back on: the colour blink.
      const js = [...o.style].filter((p) => p.startsWith('--') && !n.style.getPropertyValue(p)).map((p) => [p, o.style.getPropertyValue(p)]);
      for (const { name } of [...o.attributes]) if (!n.hasAttribute(name) && !(name === 'style' && js.length)) o.removeAttribute(name);
      for (const { name, value } of [...n.attributes]) if (o.getAttribute(name) !== value) o.setAttribute(name, value);
      if (js.length) { if (!n.hasAttribute('style')) o.removeAttribute('style'); js.forEach(([p, v]) => o.style.setProperty(p, v)); }
      morphKids(o, n);
    }
  });
  while (a.childNodes.length > bn.length) a.lastChild.remove();
}

function renderTitlebar() {
  const page = state.page;
  const isSession = page === 'session';
  const small = isSession ? ' sm' : '';
  const crumb = isSession
    ? `<span>${esc(prefs['Workspace name'] || 'XBLabs')}</span>${ic('caret-right')}<span class="cur">${esc(state.sessionTitle)}</span>`
    : page === 'focus'
      ? `<span>${esc(prefs['Workspace name'] || 'XBLabs')}</span>${ic('caret-right')}<span class="cur">Focus mode</span>`
      : `<span>${esc(prefs['Workspace name'] || 'XBLabs')}</span>${ic('caret-right')}<span class="cur">${{ logs: 'Terminal' }[page] || (page[0].toUpperCase() + page.slice(1))}</span>`;
  $('#titlebar').classList.toggle('compact', isSession);
  morph($('#titlebar'), `
    <div class="wincontrols">
      <button class="wincontrol close" title="Close" aria-label="Close" data-win="close">${ic('x', 'bold')}</button>
      <button class="wincontrol min" title="Minimize" aria-label="Minimize" data-win="min">${ic('minus', 'bold')}</button>
      <button class="wincontrol max" title="Maximize" aria-label="Maximize" data-win="max">${ic('plus', 'bold')}</button>
    </div>
    <div class="crumbs">${crumb}</div>
    <button class="pill-focus icon-only" data-act="focus" title="Focus mode · Ctrl F" aria-label="Focus mode">
      ${ic('corners-out')}
    </button>
    <button class="tb-goa ${prefs.goaMode ? 'on' : ''}" data-act="goa-mode" aria-pressed="${!!prefs.goaMode}" title="${prefs.goaMode ? 'Leave GOA mode' : 'Enter GOA mode'}">${ic(prefs.goaMode ? 'sign-out' : 'crown-simple', 'bold')}<span>${prefs.goaMode ? 'Exit GOA' : 'GOA'}</span></button>
    <div class="spacer"></div>
    <button class="btn secondary${small} icon-only tb-notif" data-act="notifs" title="Notifications" aria-label="Notifications">${ic('bell')}<i class="tb-notif-dot" hidden></i></button>
    <button class="tb-search${small} icon-only" data-act="search" title="Search everything" aria-label="Search everything">${ic('magnifying-glass')}</button>
    <button class="btn secondary${small} icon-only" data-act="commands" title="Quick commands · Ctrl J" aria-label="Quick commands">${ic('lightning')}</button>
    <button class="btn primary${small} icon-only" data-act="new-session" title="New session" aria-label="New session">${ic('plus', 'bold')}</button>`);
  notifBadge();
}

/* Notifications: everything currently waiting on the user (approvals from sessions, shells,
   job runs, and agents that ended a turn asking me to pick), deduped by id. Sources are whatever
   the live and jobs polls last loaded. */
function notifItems() {
  const out = new Map();
  for (const s of (window.LIVE && LIVE.shells) || []) if (s.status === 'waiting') out.set(s.id, { id: s.id, title: s.title || s.id, sub: `Shell · ${s.device || 'local'}`, icon: 'terminal-window' });
  for (const s of DB.sessions) if (s.live && s.live.status === 'waiting') out.set(s.id, { id: s.id, title: s.title, sub: `Session · ${s.live.device || s.agent || 'local'}`, icon: 'robot', session: true });
  for (const s of DB.sessions) if (s.live && Array.isArray(s.live.ask) && !out.has(s.id) && !(CHAT[s.id] && CHAT[s.id].pending?.length)) out.set(s.id, { id: s.id, title: s.title, sub: `${AGENT_NAMES[s.live.agent] || s.live.agent || 'Agent'} asks you to pick`, icon: 'list-bullets', session: true, ask: s.live.ask });
  for (const j of state.jobs || []) for (const r of j.runs || []) if (r.status === 'waiting' && !out.has(r.id)) out.set(r.id, { id: r.id, title: j.title, sub: `Job run · ${r.device || ''}`, icon: 'kanban' });
  return [...out.values()];
}
/* Copy that also works where the Clipboard API is refused (an embedded pane, plain http on a
   tailnet address): the old textarea + execCommand path, still inside the click. */
function copyText(text) {
  const legacy = () => {
    const ta = document.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;left:-9999px;opacity:0';
    document.body.append(ta); ta.select();
    const ok = document.execCommand('copy'); ta.remove();
    if (!ok) throw new Error('clipboard blocked');
  };
  try { if (!navigator.clipboard || !window.isSecureContext) { legacy(); return Promise.resolve(); } } catch (err) { return Promise.reject(err); }
  return navigator.clipboard.writeText(text).catch(() => legacy());
}
/* A code block in the chat copies on click (not while text in it is being selected). */
document.addEventListener('click', (e) => {
  const pre = e.target.closest('#chat-bubbles pre.md-code');
  if (!pre || String(window.getSelection() || '')) return;
  copyText(pre.innerText).then(() => { toast('Copied', 'copy'); pre.classList.remove('copied'); void pre.offsetWidth; pre.classList.add('copied'); },
    () => toast('Clipboard is blocked here', 'warning'));
});
/* Double-click a team lead in the sidebar: its teammates show under it (sub rows), or hide again. */
document.addEventListener('dblclick', (e) => {
  const b = e.target.closest('[data-team-lead]');
  if (!b) return;
  const o = state.teamOpen || (state.teamOpen = new Set()), id = b.dataset.teamLead;
  o.has(id) ? o.delete(id) : o.add(id);
  renderSidebar();
});
/* An approval answered anywhere (notification, chat card, job card): the bell, the session's colour
   and its chat follow at once, not on the next poll or a session switch. */
async function afterDecision(id) {
  try { await liveLoad(); } catch { /* the next poll catches up */ }
  renderSidebar(); notifBadge(); sessionStatusPaint(id); graphPaint(state.activeTab);
  if (CHAT[id]) { await chatPull(id); chatPaint(id); }
}
function notifBadge() {
  const n = notifItems().length, b = document.querySelector('.tb-notif');
  if (!b) return;
  const dot = b.querySelector('.tb-notif-dot');
  dot.hidden = !n; dot.textContent = n > 9 ? '9+' : n || '';
  b.title = n ? `${n} waiting for you` : 'Notifications';
  if (!popover.hidden && popover.classList.contains('pop-notif')) popNotifs(b);
}
setInterval(notifBadge, 2000);
function popNotifs(anchor) {
  const items = notifItems();
  popover.className = 'popover pop-notif';
  popover.style.maxHeight = '';
  popover.innerHTML = `
    <div class="pop-head"><span style="flex:1">Notifications</span>${items.length ? `<span class="dim">${items.length} waiting</span>` : ''}</div>
    <div class="pop-body" style="padding:4px">
      ${items.map((x) => `
      <div class="notif-row">
        ${ic(x.icon, 'fill')}
        <div class="notif-txt"${x.session ? ` data-session="${esc(x.id)}"` : ''}><b>${esc(x.title)}</b><span>${esc(x.sub)}${x.ask ? '' : ' · waiting for approval'}</span></div>
        ${x.ask ? '' : `<button class="btn xs accent" data-approve="${esc(x.id)}">Approve</button>
        <button class="btn xs secondary" data-reject="${esc(x.id)}">Deny</button>`}
      </div>${x.ask ? `<div class="notif-pick">${x.ask.slice(0, 6).map((o, i) => `<button data-act="notif-pick" data-id="${esc(x.id)}" data-v="${esc(o)}"><i>${i + 1}</i><span>${esc(o)}</span></button>`).join('')}</div>` : ''}`).join('') || `<div class="notif-empty">${ic('bell-slash')}<span>Nothing needs you right now</span></div>`}
    </div>`;
  const r = zRect(anchor);
  popover.style.width = '340px';
  popover.style.top = Math.round(r.bottom + 6) + 'px';
  popover.style.left = Math.round(Math.max(8, Math.min(r.right - 340, VW() - 348))) + 'px';
  popover.hidden = false;
}

/* ---------- sidebar ---------- */
const NAV = [
  ['overview', 'Overview', 'squares-four'],
  ['town', 'Town', 'buildings'],
  ['sessions', 'Sessions', 'chats-circle', 12],
  ['jobs', 'Jobs', 'kanban'],
  ['devices', 'Devices', 'desktop', 9],
  ['usage', 'Usage', 'chart-line-up'],
  ['logs', 'Terminal', 'terminal-window'],
  ['notes', 'Notes', 'notebook', 12]
];

/* Sidebar: a floating panel. Navigation is a column of rows with one pill that slides to the
   active page. Workspaces are a branched menu: each project is a section on a trunk line, its
   sessions branch off it, and the open session's branch is traced in the accent.
   Motion plays only when something changed (page, open project, open session), never on the
   5 s poll re-render. */
/* Is folder a inside folder b (or b itself)? Windows or POSIX paths, any slash, any case. */
function inFolder(a, b) {
  const n = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const x = n(a), y = n(b);
  return x === y || x.startsWith(y + '/');
}
const sbLast = { page: null, openWs: undefined, active: null, navTop: null };
function renderSidebar() {
  const sb = $('#sidebar');
  sb.classList.toggle('collapsed', !state.sidebar);
  const notch = document.getElementById('sb-notch');
  notch.title = notch.ariaLabel = state.sidebar ? 'Hide sidebar' : 'Show sidebar';
  notch.setAttribute('aria-expanded', state.sidebar ? 'true' : 'false');
  const activeSess = state.page === 'session' ? state.activeTab : null;
  /* GOA isolation: on the GOA page or in one of its sessions, only GOA's own workspace shows,
     open, with each head (main) followed by the workers it started (sub). */
  const goaMode = !!prefs.goaMode;
  /* Rows of one workspace as a one-level tree. In GOA a worker sits under the head that started
     it; elsewhere a session in a subfolder (XBLabs/1) sits under the session in its parent folder.
     A sub row carries a tag (sub, or its subfolder); up counts the sub rows the next main row's
     line climbs past. */
  const nestRows = (wsId, list) => {
    const parentOf = new Map();
    for (const s of list) {
      if (wsId === 'GOA') { if (s.live?.parent && list.some((m) => m.id === s.live.parent)) parentOf.set(s.id, s.live.parent); continue; }
      /* A teammate sits under its team's lead, as a GOA worker under its head. */
      if (s.live?.team_role === 'mate') { if (list.some((m) => m.id === s.live.parent)) parentOf.set(s.id, s.live.parent); continue; }
      const c = s.live?.cwd;
      const p = c && list.filter((m) => m !== s && m.live?.cwd && !inFolder(m.live.cwd, c) && inFolder(c, m.live.cwd)).sort((a, b) => b.live.cwd.length - a.live.cwd.length)[0];
      if (p) parentOf.set(s.id, p.id);
    }
    const rootOf = (s) => { let id = s.id; const seen = new Set(); while (parentOf.has(id) && !seen.has(id)) { seen.add(id); id = parentOf.get(id); } return id; };
    const out = [];
    for (const m of list.filter((s) => !parentOf.has(s.id))) {
      out.push({ s: m, sub: false, tag: wsId === 'GOA' ? 'main' : '' });   // a team lead shows its teammate count instead
      for (const k of list.filter((s) => parentOf.has(s.id) && rootOf(s) === m.id)) {
        const rel = wsId === 'GOA' ? 'sub' : k.live?.team_role === 'mate' ? '' : k.live.cwd.slice(m.live.cwd.replace(/[\\/]+$/, '').length).replace(/^[\\/]+/, '');
        out.push({ s: k, sub: true, tag: rel });
      }
    }
    let up = 0;
    for (const r of out) { if (r.sub) up++; else { r.up = up; up = 0; } }
    return out;
  };
  const html = `
    <div class="ws-switch" data-label="xblabs">
      <span class="ws-logo wsname">
        <img class="ws-mark ws-mark-white" src="assets/brand/mark-white-anim.svg" alt="xblabs">
        <img class="ws-mark ws-mark-dark" src="assets/brand/mark-black-anim.svg" alt="xblabs">
        <img class="ws-wordmark ws-wordmark-white" src="assets/brand/wm-white-anim.svg" alt="xblabs">
        <img class="ws-wordmark ws-wordmark-dark" src="assets/brand/wm-black-anim.svg" alt="xblabs">
      </span>
    </div>
    <div class="sb-scroll">
    <div class="s-header">Navigation</div>
    <nav class="nav-list" aria-label="Pages"><i class="nav-ind" aria-hidden="true" style="transform:translateY(${sbLast.navTop ?? 0}px);opacity:${sbLast.navTop == null ? 0 : 1}"></i>
    ${(goaMode ? [['goa', 'GOA', 'crown-simple'], ...NAV] : NAV).map(([k, label, icon, cnt]) => {
      /* Badges are counts of real rows, not the mock numbers from data.js. */
      if (k === 'sessions') cnt = DB.sessions.length;
      if (k === 'jobs') cnt = state.jobsWaiting || null;
      if (k === 'devices') cnt = DB.devices.length;
      if (k === 'logs') cnt = ((window.LIVE && LIVE.shells) || []).filter((s) => ['running', 'starting', 'waiting'].includes(s.status)).length || null;
      if (k === 'notes') cnt = DB.notes.length;
      const on = state.page === k || (k === 'sessions' && state.page === 'session');
      return `
      <button class="navitem ${on ? 'active' : ''}" data-nav="${k}" title="${label}" data-label="${label}" ${on ? 'aria-current="page"' : ''}>
        ${ic(icon, on ? 'bold' : 'regular')}
        <span>${label}</span>
        ${cnt ? `<span class="s-count">${cnt}</span>` : ''}
      </button>`; }).join('')}
    </nav>
    <button class="s-header s-toggle" data-act="toggle-ws-list" aria-expanded="${state.wsCollapsed ? 'false' : 'true'}" title="${state.wsCollapsed ? 'Show workspaces' : 'Hide workspaces'}">
      ${goaMode ? 'GOA workspace' : 'Workspaces'} ${ic(state.wsCollapsed ? 'caret-right' : 'caret-down')}
    </button>
    <div class="ws-list ${state.wsCollapsed ? 'is-hidden' : ''}">
    <button class="ws-all ${state.ws === 'all' ? 'active' : ''}" data-ws="all" title="All sessions" data-label="All sessions">
      <span class="ws-all-ico">${ic('squares-four')}</span>
      <span class="wslabel">All</span><span class="wscount">${DB.sessions.length}</span>
    </button>
    ${DB.workspaces.filter((w) => !state.pendingDel?.has(`ws:${w.id}`) && (!goaMode || w.id === 'GOA')).map((w) => {
      const rows = nestRows(w.id, DB.sessions.filter((s) => s.ws === w.id && !state.pendingDel?.has(s.id) && !(s.live && s.live.team_role === 'mate' && s.id !== activeSess && !state.teamOpen?.has(s.live.parent))));   // teammates run in the background; double-click their lead to list them
      const mine = rows.map((r) => r.s);
      const open = state.openWs === w.id || (goaMode && w.id === 'GOA');
      const at = mine.findIndex((s) => s.id === activeSess);
      /* The lit path runs folder → main row → its sub. With a sub open, its main row lights its
         elbow (act) and only the subs between them carry the line down (pass). */
      const root = at >= 0 && rows[at].sub ? rows.slice(0, at).map((r) => r.sub).lastIndexOf(false) : -1;
      const lit = (i) => (i === at || i === root ? 'act'
        : i < at && (rows[i].sub ? root >= 0 && i > root : root < 0 || i < root) ? 'pass' : '');
      return `
      <div class="br-sec ${open ? 'open' : ''}" data-sec="${esc(w.id)}">
      <div class="ws-item swipe ${state.ws === w.id ? 'active' : ''}" data-swipe-ws="${esc(w.id)}" data-reveal="100">
      <div class="swipe-actions" aria-hidden="true">
        <button class="sw-act" data-newchat="${esc(w.id)}" tabindex="-1" title="New session">${ic('plus')}</button>
        <button class="sw-act" data-act="ws-clear" data-id="${esc(w.id)}" tabindex="-1" title="Clear sessions">${ic('broom')}</button>
        <button class="sw-act danger" data-swipe-ws-del="${esc(w.id)}" tabindex="-1" title="Forget project">${ic('trash')}</button>
      </div>
      <div class="swipe-face">
      <button class="ws-row ${state.ws === w.id ? 'active' : ''}" data-ws="${w.id}" aria-expanded="${open ? 'true' : 'false'}" title="${esc(w.dir)}" data-label="${esc(w.dir)}">
        <span class="ws-initial" style="color:${wsColor(w.id)}">${esc(w.dir[0].toUpperCase())}</span>
        <span class="ws-main">
          ${ic(open ? 'folder-open' : 'folder', 'regular', 'br-caret')}
          <span class="wslabel">${esc(w.dir)}</span>
          <span class="wscount">${mine.length}</span>
        </span>
        <span class="ws-sub">${esc(w.hosts)}</span>
      </button>
      </div>
      </div>
      <div class="br-kids" ${open ? '' : 'inert'}><div class="br-kids-in">
        ${rows.map(({ s, sub, tag, up }, i) => `
        <div class="br-row swipe ${sub ? 'sub' : ''} ${lit(i)}" data-swipe="${esc(s.id)}" style="--i:${i}${up ? `;--up:${up}` : ''}">
          <div class="swipe-actions" aria-hidden="true">
            <button class="sw-act" data-act="rename-session" data-id="${esc(s.id)}" tabindex="-1">${ic('pencil-simple')}</button>
            <button class="sw-act danger" data-swipe-del="${esc(s.id)}" tabindex="-1">${ic('trash')}</button>
          </div>
          <div class="swipe-face">
            <button class="br-main" data-session="${s.id}" title="${esc(s.title)}${s.live?.team_mates ? ' · double-click to show or hide its teammates' : ''}"${s.live?.team_mates ? ` data-team-lead="${esc(s.id)}"` : ''}><i class="sess-dot ${s.col}"></i><span>${esc(s.title)}</span>${s.live && s.live.team_mates ? `<em class="br-tag br-team" title="Teammates work in the background · open the lead's GRAPH tab">${ic('users-three')}${s.live.team_mates}</em>` : ''}${tag ? `<em class="br-tag" title="${esc(tag)}">${sub && tag !== 'sub' ? ic('folder-simple') : ''}${esc(tag)}</em>` : ''}${brAgent(s)}</button>
          </div>
        </div>`).join('') || '<div class="br-empty">No sessions yet</div>'}
      </div></div>
      </div>`;
    }).join('')}
    </div>
    </div>
    <button class="privacy-btn ${prefs.privacy ? 'on' : ''}" data-act="privacy" aria-pressed="${!!prefs.privacy}" title="Privacy mode">
      ${ic(prefs.privacy ? 'eye-slash' : 'eye')}<span>Privacy mode</span><i class="sw-toggle"></i>
    </button>
    <button class="profile" data-act="profile" title="Edit profile">
      <div class="avatar">${avatarHTML()}</div>
      <div class="profile-text"><b>${esc(DB.user.name)}</b>${DB.user.username ? `<small>@${esc(DB.user.username)}</small>` : ''}</div>
    </button>`;
  /* Patched in place: the animated logo, avatar and status dots keep playing across renders. */
  morph(sb, html);

  /* Nav pill: rendered where it was last time (markup above), so a poll re-render changes
     nothing and nothing animates; only a real page change moves it. */
  const ind = $('.nav-ind', sb), cur = $('.navitem.active', sb);
  if (ind && cur) {
    const top = cur.offsetTop;
    if (sbLast.navTop == null) { ind.style.transition = 'none'; ind.style.transform = `translateY(${top}px)`; ind.style.opacity = '1'; ind.offsetWidth; ind.style.transition = ''; }
    else if (sbLast.navTop !== top) ind.style.transform = `translateY(${top}px)`;
    sbLast.navTop = top;
  } else if (ind) { ind.style.opacity = '0'; sbLast.navTop = null; }

  /* Fold: a section that just opened or closed animates from its previous state. */
  if (sbLast.openWs !== undefined && sbLast.openWs !== state.openWs) {
    const opened = state.openWs && sb.querySelector(`.br-sec[data-sec="${CSS.escape(state.openWs)}"]`);
    const closed = sbLast.openWs && sb.querySelector(`.br-sec[data-sec="${CSS.escape(sbLast.openWs)}"]`);
    if (opened) { opened.classList.remove('open'); opened.offsetWidth; opened.classList.add('open', 'unfold'); }
    if (closed && closed !== opened) { closed.classList.add('open'); closed.offsetWidth; closed.classList.remove('open'); }
  }
  /* Trace: draw the branch to the session that just became active. */
  if (activeSess && activeSess !== sbLast.active) sb.querySelector('.br-row.act')?.classList.add('draw');
  sb.querySelectorAll('.br-row.pass').forEach((r) => { if (activeSess !== sbLast.active) r.classList.add('draw'); });
  sbLast.openWs = state.openWs; sbLast.active = activeSess; sbLast.page = state.page;
}

/* ---------- profile ----------
   The sidebar card is a button; it opens the account popover, whose first row opens the editor.
   `DB.user` is the single source of truth and is mirrored to localStorage, so a photo and handle
   survive a reload without any backend. */
const PROFILE_KEY = 'xblabs.profile.v1';
let modalPfp = null;

function initialsOf(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean).slice(0, 2);
  return parts.map((w) => w[0]).join('') || 'u';   /* avatar mirrors what was typed, no shout-caps */
}
function avatarHTML() {
  return DB.user.pfp ? `<img src="${DB.user.pfp}" alt="">` : DB.user.initials;
}
function saveProfile() {
  try { localStorage.setItem(PROFILE_KEY, JSON.stringify(DB.user)); } catch (err) { /* private mode */ }
  uiPush('profile', DB.user);
}
try {
  const saved = JSON.parse(localStorage.getItem(PROFILE_KEY) || '{}');
  /* The seeded demo identity must never come back from storage: keep only what was edited. */
  if (saved.name === 'Nadia Rahma' || saved.name === 'user') delete saved.name;
  if (saved.email === 'nadia@xblabs.dev') delete saved.email;
  if (['NR', 'u', 'U'].includes(saved.initials)) delete saved.initials;
  Object.assign(DB.user, saved);
} catch (err) { /* ignore */ }
/* Hub copy wins over this browser's; an empty hub gets this browser's copy (first run after upgrade). */
fetch('/api/ui-state').then((r) => r.json()).then((u) => {
  if (u.prefs) {
    Object.keys(prefs).forEach((k) => delete prefs[k]); Object.assign(prefs, u.prefs);
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* session-only */ }
    state.palette = prefs.palette && prefs.palette !== 'paper' ? prefs.palette : 'midnight';
    state.lightPalette = prefs.lightPalette || 'paper';
    state.themeMode = prefs.mode || (prefs.palette === 'paper' ? 'light' : 'dark');
  } else if (Object.keys(prefs).length) uiPush('prefs', prefs);
  if (u.profile) { Object.assign(DB.user, u.profile); try { localStorage.setItem(PROFILE_KEY, JSON.stringify(DB.user)); } catch { /* session-only */ } }
  else if (localStorage.getItem(PROFILE_KEY)) uiPush('profile', DB.user);
  if (u.prefs || u.profile) { applyPrefs(); render(); }
}).catch(() => {});

function modalEditProfile() {
  modalPfp = DB.user.pfp || null;
  showModal(`
    <div class="modal-head"><div class="tb">
      <h2>Edit profile</h2>
      <p>Stored on this machine only — the photo never leaves the browser.</p>
    </div><button class="close-x" data-act="close">${ic('x')}</button></div>
    <div class="modal-body">
      <div class="pf-head">
        <div class="avatar pf-av" id="pf-av">${modalPfp ? `<img src="${modalPfp}" alt="">` : DB.user.initials}</div>
        <div class="pf-actions">
          <label class="btn secondary sm">Upload photo<input type="file" id="pf-file" accept="image/*" hidden></label>
          ${modalPfp ? '<button class="btn secondary sm" data-act="pf-clear">Remove</button>' : ''}
          <small class="pf-hint">Square image works best</small>
        </div>
      </div>
      <div class="row-2">
        <div class="field"><label>Display name</label><span class="input"><input id="pf-name" maxlength="40" value="${esc(DB.user.name)}"></span></div>
        <div class="field"><label>Username</label><span class="input"><input id="pf-user" maxlength="24" placeholder="handle" value="${esc(DB.user.username || '')}"></span></div>
      </div>
      <div class="field"><label>Email</label><span class="input"><input id="pf-email" value="${esc(DB.user.email)}"></span></div>
      <div class="field"><label>Bio</label><span class="input"><input id="pf-bio" maxlength="140" placeholder="One line about you" value="${esc(DB.user.bio || '')}"></span></div>
    </div>
    <div class="modal-foot"><span class="grow"></span><button class="btn secondary" data-act="close">Cancel</button><button class="btn primary" data-act="pf-save">Save changes</button></div>`, 480);
  $('#pf-file').addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    const fr = new FileReader();
    fr.onload = () => { modalPfp = fr.result; $('#pf-av').innerHTML = `<img src="${modalPfp}" alt="">`; };
    fr.readAsDataURL(f);
  });
}

/* ---------- shared bits ---------- */
function pageHead(title, accent, subtitle, actions = '') {
  return `<div class="page-head">
    <div class="title-block">
      <div class="title-row"><h1 aria-label="${esc(title)}">${[...title].map((c, i) => `<span class="ch" aria-hidden="true" style="--c:${i}">${c === ' ' ? '&nbsp;' : esc(c)}</span>`).join('')}</h1></div>
      <div class="subtitle">${subtitle}</div>
    </div>
    <div class="head-actions">${actions}</div>
  </div>`;
}
function segment(items, active, attr) {
  return `<div class="segment">${items.map(([k, l]) => `<button class="${k === active ? 'active' : ''}" ${attr}="${k}">${l}</button>`).join('')}</div>`;
}
function statCards(list) {
  return `<div class="stat-grid">${list.map((s) => `
    <div class="stat">
      <div class="top">${ic(s.icon)}<span>${esc(s.label)}</span></div>
      <div class="val">${s.html || `<b>${esc(s.value)}</b>
        <span class="delta ${s.tone === 'warn' && s.value !== '0' ? 'warn' : 'dim'}">${esc(s.delta)}</span>`}
      </div>
    </div>`).join('')}</div>`;
}
/* Dashboard runtime: time since this page was opened; every [data-uptime] ticks once a second. */
const OPENED_AT = Date.now();
const uptime = () => {
  const s = Math.floor((Date.now() - OPENED_AT) / 1000);
  return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map((n) => String(n).padStart(2, '0')).join(':');
};
const openedAt = () => new Date(OPENED_AT).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
setInterval(() => { const t = uptime(); document.querySelectorAll('[data-uptime]').forEach((e) => { e.textContent = t; }); }, 1000);

/* Single place that decides which devices a list shows and in what order. */
const DEV_SORTS = [
  { value: 'status', label: 'Status' }, { value: 'name', label: 'Name' }, { value: 'cpu', label: 'CPU' },
  { value: 'ram', label: 'RAM' }, { value: 'sessions', label: 'Sessions' }, { value: 'seen', label: 'Last seen' },
];
function devicesFiltered() {
  const q = state.devQuery.trim().toLowerCase();
  let rows = DB.devices.filter((d) => (state.devStatus === 'all' || d.status === state.devStatus)
    && (!q || `${d.name} ${d.ip || ''} ${d.os || ''}`.toLowerCase().includes(q)));
  /* Name and status ascend; load, sessions and last seen put the busiest or newest first.
     Missing numbers (offline hosts) sink to the bottom; ties fall back to the name. */
  const rank = { online: 0, idle: 1, offline: 2 };
  const by = {
    name: () => 0,
    status: (a, b) => (rank[a.status] ?? 3) - (rank[b.status] ?? 3),
    cpu: (a, b) => (b.cpu ?? -1) - (a.cpu ?? -1),
    ram: (a, b) => (b.ram ?? -1) - (a.ram ?? -1),
    sessions: (a, b) => (b.sess || 0) - (a.sess || 0),
    seen: (a, b) => (b.seenAt || 0) - (a.seenAt || 0),
  }[state.devSort] || (() => 0);
  rows = [...rows].sort((a, b) => by(a, b) || a.name.localeCompare(b.name));
  return rows;
}

function deviceTable(rows, opts = {}) {
  return `<div class="table">
    <div class="thead">
      <div class="c-dev">Device ${ic('caret-down')}</div>
      <div class="c-96">Status</div><div class="c-84">OS</div>
      <div class="c-58">CPU %</div><div class="c-58">RAM %</div>
      <div class="c-84" style="text-align:right">Sessions</div><div class="c-108" style="text-align:right" title="Requests and tokens in the Overview timeframe">Usage</div><div class="c-108">Last seen</div><div class="c-28"></div>
    </div>
    <div class="rows">${rows.map((d, i) => `
      <div class="trow ${opts.selected === d.name ? 'selected' : ''}" data-device="${esc(d.name)}">
        <div class="c-dev">
          <div class="dev-ico">${ic(d.icon)}</div>
          <div class="dev-name"><b>${esc(d.name)}</b><small>${esc(d.id)}</small></div>
        </div>
        <div class="c-96">${statusPill(d.status)}</div>
        <div class="c-84 muted">${esc(d.os)}</div>
        <div class="c-58 ${d.cpu === null ? 'dim' : d.cpu > 80 ? '' : 'muted'}" style="${d.cpu > 80 ? 'color:var(--danger)' : ''}">${d.cpu == null ? '—' : d.cpu + '%'}
          ${d.cores ? `<small class="dim" style="display:block;font-size:9.5px;line-height:1.1">${d.cores} cores</small>` : ''}</div>
        <div class="c-58" style="${d.ram > 80 ? 'color:var(--danger)' : ''}">${d.ram == null ? '—' : d.ram + '%'}
          ${memText(d.ramUsed, d.ramTotal) ? `<small class="dim" style="display:block;font-size:9.5px;line-height:1.1">${memText(d.ramUsed, d.ramTotal)}</small>` : ''}</div>
        <div class="c-84 muted" style="text-align:right">${d.sess}</div>
        <div class="c-108 muted num" style="text-align:right" title="${d.use ? `${d.use.n} requests · in ${uShort(d.use.tin)} (cache ${uShort(d.use.tcache)}) · out ${uShort(d.use.tout)}` : 'No requests in this timeframe'}">${d.use ? `${d.use.n} req<small class="dim" style="display:block;font-size:9.5px;line-height:1.1">${uShort(d.use.tin + d.use.tout)} tok</small>` : '—'}</div>
        <div class="c-108 dim">${esc(d.seen)}</div>
        <div class="c-28"><button class="cbtn dev-menu" data-devmenu="${esc(d.name)}" aria-label="Device actions">${ic('dots-three')}</button></div>
      </div>`).join('')}</div>
  </div>`;
}
function sessionRow(s) {
  const st = (s.live && s.live.status) || s.col;
  const label = { queued: 'Queued', starting: 'Starting', running: 'Running', waiting: 'Waiting', idle: 'Idle', hibernated: 'Hibernated', done: 'Done' }[st] || st;
  return `<div class="srow ${state.selectedSession === s.id ? 'active' : ''}" data-session="${s.id}" data-al="${s.id}">
    <div class="srow-in">
      <div class="srow-top">
        <span class="pill ${st === 'idle' ? 'done' : s.col}"><i></i>${label}</span>
        <span class="agent">${esc(s.agent)}</span>
        <span class="wsbadge">${esc(s.ws)}</span>
        <span style="flex:1"></span>
        <span class="dim num" title="Runtime">${ic('timer')}${esc(s.elapsed)}</span>
      </div>
      <div class="srow-bottom"><b>${esc(s.title)}</b><small class="num">${s.msgs} msgs · ${esc(s.tokens)} tok${s.ctx ? ` · ctx ${esc(s.ctx)}` : ''}</small></div>
    </div>
  </div>`;
}

/* ---------- overview ---------- */
/* Sessions with a live or resumable agent, newest change first. */
const activeSessions = () => DB.sessions.filter((s) => s.live && ['running', 'starting', 'waiting', 'idle'].includes(s.live.status))
  .sort((a, b) => b.live.updated_at - a.live.updated_at);
function viewOverview() {
  const chart = `<div class="card chart-card ov-chart">
    <div class="chart-head">
      <div class="tb"><small>Requests per day</small><b class="num">${DB.reqTotal ?? DB.chart7.reduce((n, d) => n + (d.in || 0), 0)} requests</b></div>
      <div class="seg ov-range" role="tablist" aria-label="Timeframe">${[['today', 'Today'], ['7d', '7 days'], ['30d', '30 days'], ['all', 'All']].map(([k, l]) => `<button role="tab" aria-selected="${(state.ovRange || 'today') === k}" class="${(state.ovRange || 'today') === k ? 'on' : ''}" data-act="ov-range" data-v="${k}">${l}</button>`).join('')}</div>
    </div>
    <div class="bars">${DB.chart7.map((d, i) => `
      <div class="bar-col ${d.today ? 'today' : ''}" style="--b:${i}">
        ${d.in ? `<span class="peakval">${d.in}</span>` : ''}
        <div class="stack" style="height:${4 + Math.round(116 * (d.in || 0) / Math.max(1, ...DB.chart7.map((x) => x.in || 0)))}px">
          <div class="seg-out" style="height:${d.out}px"></div>
          <div class="seg-in" style="height:${d.in}px"></div>
        </div>
        <label>${DB.chart7.length > 10 && i % Math.ceil(DB.chart7.length / 8) && !d.today ? '' : d.d}</label>
      </div>`).join('')}</div>
  </div>`;

  const table = `<div class="card" style="flex:1;display:flex;flex-direction:column;min-height:260px">
    <div class="card-head" style="border-bottom:1px solid var(--border-subtle)">
      <h2>Devices</h2>
      <span class="count-chip"><i></i>${DB.devices.filter((d) => d.status === 'online').length} online of ${DB.devices.length}</span>
      <div class="grow"></div>
      <button class="btn ghost sm" data-act="dev-sort" title="Sort devices · ${DEV_SORTS.find((o) => o.value === state.devSort)?.label || 'Status'}" aria-label="Sort devices" aria-haspopup="listbox" aria-expanded="false">${ic('arrows-down-up')}</button>
      <button class="btn ghost sm" data-act="filter" title="Filter devices">${ic('funnel')}</button>
    </div>
    ${deviceTable(devicesFiltered())}
    <div class="tfoot">
      <div style="display:flex;gap:8px"><span>Avg CPU ${Math.round(DB.devices.reduce((a, d) => a + (d.cpu || 0), 0) / Math.max(1, DB.devices.length))}%${DB.devices.some((d) => d.cores) ? ` · ${DB.devices.reduce((a, d) => a + (d.cores || 0), 0)} cores` : ''}</span><span>Avg RAM ${Math.round(DB.devices.reduce((a, d) => a + (d.ram || 0), 0) / Math.max(1, DB.devices.length))}%</span><span>${DB.devices.filter((d) => d.status === 'offline').length} offline</span></div>
      <span class="link" data-nav="devices">View all ${DB.devices.length} devices ${ic('caret-right')}</span>
    </div>
  </div>`;

  const sessionsCard = `<div class="card" style="flex:1;min-height:150px;display:flex;flex-direction:column">
    <div class="card-body" style="display:flex;flex-direction:column;gap:12px;height:100%;padding:14px">
      <div style="display:flex;align-items:center;gap:8px;height:22px">
        <b style="font-size:14px;font-weight:600">Active sessions</b>
        <span class="wsbadge">${activeSessions().length}</span>
        <span style="flex:1"></span>
        <span class="link" data-nav="sessions" style="color:var(--text-secondary);font-size:11px">View all ${ic('caret-right')}</span>
      </div>
      <div style="display:flex;flex-direction:column;gap:5px;overflow:auto" data-alist="active" tabindex="0" aria-label="Active sessions">
        ${activeSessions().map(sessionRow).join('')}
      </div>
    </div>
  </div>`;

  /* Agent registry at a glance: what is installed on this hub; the full list lives in Settings → Agents. */
  if (!window.__reg && !regCard.asked) { regCard.asked = 1; fetch('/api/agents/registry', { cache: 'no-store' }).then((r) => r.json()).then((j) => { window.__reg = Array.isArray(j) ? j : []; if (state.page === 'overview') render(); }).catch(() => { window.__reg = []; }); }
  const agentsCard = regCard();

  /* Right rail hero: how long this dashboard has been open, the "balance card" of this page. */
  const hero = `<div class="ov-hero" data-grainient>
    <div class="ov-hero-top">${ic('timer')}<span>Dashboard runtime</span></div>
    <b class="num" data-uptime>${uptime()}</b>
    <div class="budget-row"><span>Opened</span><b class="num">${openedAt()}</b></div>
  </div>`;
  const quick = `<div class="ov-quick">
    <button class="btn secondary" data-act="new-session">${ic('plus')}Session</button>
    <button class="btn secondary" data-nav="logs">${ic('terminal-window')}Terminal</button>
    <button class="btn secondary" data-nav="notes">${ic('note')}Notes</button>
  </div>`;

  /* Recent runs: the newest job runs (temporary agent sessions spawned for a job), newest on
     top. Chat sessions are not runs; they are in Active sessions above. */
  const runs = [...((window.LIVE && LIVE.jobRuns) || [])].sort((a, b) => b.created_at - a.created_at).slice(0, 8)
    .map((r) => ({ id: r.id, title: r.jobTitle || r.title, agent: r.agent, live: r,
      /* A finished run shows how long it took, not a clock that keeps counting. */
      elapsed: mmss((['running', 'starting', 'waiting'].includes(r.status) ? Date.now() : r.updated_at) - r.created_at) }));
  /* Marker by state: the lattice orbits only while running; a finished run shows a
     green check, a failed one a red x, a stopped one a red square. The row's edge and status
     label take the same colour. */
  const mark = (st) => ['running', 'starting'].includes(st) ? ['current', lattice()]
    : st === 'done' ? ['st-done', ic('check', 'bold')]
      : st === 'waiting' ? ['st-wait', ic('hourglass', 'fill', 'wn')]
        : st === 'failed' || st === 'rejected' ? ['st-fail', ic('x', 'bold')] : ['st-stop', ic('square', 'fill')];
  const recent = `<div class="card" style="flex:1;display:flex;flex-direction:column;min-height:0">
    <div class="card-head" style="height:46px;padding:0 16px;align-items:center">
      <h2>Recent runs</h2>
      <div class="grow"></div>
      <span class="link" data-nav="jobs" style="color:var(--text-secondary);font-size:11px">Jobs ${ic('caret-right')}</span>
    </div>
    <div class="timeline" style="flex:1;overflow:auto;padding-top:2px" data-alist="runs" tabindex="0" aria-label="Recent runs">
      ${runs.map((s) => { const [cls, glyph] = mark(s.live.status); return `
        <div class="tl-item ${cls}" data-run-terminal="${esc(s.id)}" data-al="${esc(s.id)}" style="cursor:pointer">
          <div class="tl-marker"><span class="dot ${cls}">${glyph}</span></div>
          <div class="tl-body">
            <div class="tl-msg"><span>${esc(s.title)}</span><time>${esc(s.elapsed)}</time></div>
            <div class="tl-meta"><span>${esc(s.live.device || 'local')}</span><span>${esc(s.agent || 'shell')}</span><span class="sp"></span><span class="tl-st">${esc(s.live.status)}</span></div>
          </div>
        </div>`; }).join('') || '<div class="jempty">No job runs yet. Dispatch a job to see it here.</div>'}
    </div>
  </div>`;

  const activeFilters = (state.devStatus !== 'all') + (state.ws !== 'all');
  const actions = `<div class="ov-actions">
    <button class="btn secondary" data-act="filter">${ic('funnel')}Filter${activeFilters ? `<span class="wsbadge" style="background:var(--surface-3);color:var(--text-primary)">${activeFilters}</span>` : ''}</button>
    <button class="btn secondary" data-act="open-ws">${ic('folder-open')}Open workspace</button>
    <button class="btn accent" data-act="dispatch">${ic('paper-plane-tilt')}Dispatch job</button>
    <span class="grow"></span>
    <span class="dim ov-date">${new Date().toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}</span>
  </div>`;
  return `<div class="split fill bento ov">
      <div class="col grow">${actions}${statCards(DB.stats.slice(0, 3)).replace('class="stat-grid"', 'class="stat-grid bento ov-stats"')}${chart}${table}</div>
      <div class="col fixed-380">
        <button class="ov-search" data-act="search">${ic('magnifying-glass')}<span>Search sessions…</span><span class="kbd neutral">Ctrl K</span></button>
        ${hero}${quick}${agentsCard}${sessionsCard}${recent}
      </div>
    </div>`;
}

/* ---------- sessions ---------- */
function viewSessions() {
  const q = (state.sessQuery || '').trim().toLowerCase();
  const visible = DB.sessions.filter((s) => !state.pendingDel?.has(s.id)
    && (state.ws === 'all' || s.ws === state.ws)
    && (!q || `${s.title} ${s.ws} ${s.agent || ''} ${s.id}`.toLowerCase().includes(q)));
  const order = (rows) => (state.sort === 'size' ? [...rows].sort((a, b) => b.msgs - a.msgs)
    : state.group ? [...rows].sort((a, b) => a.ws.localeCompare(b.ws)) : rows);
  const view = state.view === 'list' ? 'list' : 'board';

  const cols = DB.columns.map((c) => {
    const rows = order(visible.filter((s) => s.col === c.key));
    return `<div class="bcol">
      <div class="bcol-head"><i class="mark" style="background:${c.color}"></i><b>${c.label}</b><span class="cnt">${rows.length}</span></div>
      <div class="bcards">${rows.map((s, ri) => `
        ${state.group && (ri === 0 || rows[ri - 1].ws !== s.ws) ? `<div class="bgroup"><i style="background:${wsColor(s.ws)}"></i>${esc(s.ws)}</div>` : ''}
        <article class="bcard ${state.selectedSession === s.id ? 'sel' : ''}" data-session="${s.id}" style="--i:${ri}">
          <div class="bcard-top">
            <span class="sid num">${s.id}</span>
            <span class="badge"><i style="background:${c.color}"></i>${c.label}</span>
          </div>
          <h4>${esc(s.title)}</h4>
          <div class="bcard-chips">
            <span class="wschip"><i style="background:${wsColor(s.ws)}"></i>${esc(s.ws)}</span>
            <span class="branch">${esc(s.branch)}</span>
          </div>
          <div class="bcard-foot">
            <span class="agentav" title="${esc(s.agent)}">${agentLogo(s.agent || 'shell')}</span>
            <span>${esc(s.agent === 'shell' ? 'Plain shell' : AGENT_NAMES[s.agent] || s.agent)}</span>
            <span class="time">${esc(s.elapsed)}</span>
          </div>
        </article>`).join('') || '<div class="bempty">No sessions</div>'}</div>
    </div>`;
  }).join('');

  /* List: one swipe row per session, grouped by project. Swipe left for rename and delete. */
  const groups = [...new Set(order(visible).map((s) => s.ws))];
  const colOf = (k) => DB.columns.find((c) => c.key === k) || DB.columns[0];
  const list = `<div class="card slist" data-alist="sessions" tabindex="0" aria-label="Sessions">${groups.map((g) => `
      <div class="slist-group"><i style="background:${wsColor(g)}"></i>${esc(g)}<span class="cnt">${visible.filter((s) => s.ws === g).length}</span></div>
      ${order(visible.filter((s) => s.ws === g)).map((s, i) => `
      <div class="swipe slist-row" data-swipe="${esc(s.id)}" data-al="${esc(s.id)}" style="--i:${i}">
        <div class="swipe-actions" aria-hidden="true">
          <button class="sw-act" data-act="rename-session" data-id="${esc(s.id)}" tabindex="-1">${ic('pencil-simple')}</button>
          <button class="sw-act danger" data-swipe-del="${esc(s.id)}" tabindex="-1">${ic('trash')}</button>
        </div>
        <div class="swipe-face">
          <button class="slist-main" data-session="${s.id}">
            <i class="sess-dot ${s.col}"></i><span class="slist-title">${esc(s.title)}</span>
            <span class="slist-meta">${esc(colOf(s.col).label)}</span>
            <span class="slist-meta">${esc(s.agent || 'shell')}</span>
            <span class="slist-meta num">${esc(s.elapsed)}</span>
          </button>
        </div>
      </div>`).join('')}`).join('') || '<div class="jempty" style="padding:24px">No sessions match</div>'}
    </div>`;

  const chips = [['all', 'All', DB.sessions.length],
    ...DB.workspaces.slice(0, 3).map((w) => [w.id, w.dir, DB.sessions.filter((s) => s.ws === w.id).length])]
    .map(([k, l, n]) => `<button class="chip ${state.ws === k ? 'active' : ''}" data-ws="${k}">${l}<span class="cnt">${n}</span></button>`).join('');

  return pageHead('Sessions', 'sessions',
    `${DB.sessions.length} sessions · ${DB.sessions.filter((s) => s.col === 'waiting').length} waiting on approval · ${new Set(DB.sessions.map((s) => s.agent)).size} agents`,
    `${segment([['list', 'List'], ['board', 'Board']], view, 'data-view')}
     <button class="btn secondary" data-act="compare" title="Compare agents' branches side by side">${ic('columns')}Compare</button>
     <button class="btn primary" data-act="new-session">${ic('plus', 'bold')}New session</button>`)
    + `<div class="toolbar">
        ${chips}
        <div class="field-inline" style="margin-left:2px">${ic('magnifying-glass')}<input data-q="sessQuery" value="${esc(state.sessQuery || '')}" placeholder="Search sessions" aria-label="Search sessions"></div>
        <div class="grow"></div>
        <button class="tb-btn ${state.group ? 'on' : ''}" data-group="1">${ic('squares-four')}Group by workspace</button>
        <button class="tb-btn plain" data-sort="${state.sort === 'recent' ? 'size' : 'recent'}">${ic('arrows-down-up')}${state.sort === 'recent' ? 'Recent' : 'Largest'}</button>
      </div>`
    + (view === 'list' ? list : `<div class="board">${cols}</div>`);
}

/* ---------- devices ---------- */
/* Per-project resource attribution for one device. Each project owns a slice of CPU/RAM/disk;
   whatever the slices don't account for is the OS and unrelated processes, shown as the
   remainder row so every column visibly adds up to the device total. */
function projUsage(d) {
  const proj = d.proj || [];
  const sum = (k) => proj.reduce((a, b) => a + (b[k] || 0), 0);
  const tot = { cpu: d.cpu, ram: d.ram, disk: d.disk };
  const rest = {
    cpu: tot.cpu === null ? null : Math.max(0, tot.cpu - sum('cpu')),
    ram: tot.ram === null ? null : Math.max(0, tot.ram - sum('ram')),
    disk: Math.max(0, tot.disk - sum('disk'))
  };
  const cell = (v, total) => v === null ? '<span class="dim">—</span>'
    : `<span class="pu-val">${v}<i>%</i></span><span class="pu-bar"><b class="${v > 80 ? 'hot' : v > 60 ? 'warm' : ''}" style="width:${Math.max(2, v)}%"></b></span>`;
  const row = (label, color, v, own) => `
    <div class="pu-row ${own ? '' : 'muted'}">
      <div class="pu-name"><i style="background:${color}"></i><span>${esc(label)}</span></div>
      <div class="pu-cell">${cell(v.cpu, tot.cpu)}</div>
      <div class="pu-cell">${cell(v.ram, tot.ram)}</div>
      <div class="pu-cell">${cell(v.disk, tot.disk)}</div>
    </div>`;

  if (!proj.length) {
    return `<div class="s-header" style="padding:0 0 6px">Usage by project</div>
      <div class="pu-empty">${ic('moon')}<span>${d.status === 'offline' ? 'Device offline — no metrics' : 'No project activity on this machine'}</span></div>`;
  }

  return `<div class="s-header" style="padding:0 0 6px">Usage by project</div>
    <div class="pu">
      <div class="pu-head"><div class="pu-name">Project</div><div class="pu-cell">CPU</div><div class="pu-cell">RAM</div><div class="pu-cell">Disk</div></div>
      ${proj.map((x) => row(x.ws, wsColor(x.ws), x, true)).join('')}
      ${row('System & other', 'var(--text-disabled)', rest, false)}
      <div class="pu-foot">
        <span>Total</span>
        <span class="pu-cell">${tot.cpu === null ? '—' : tot.cpu + '%'}${d.cores ? `<small class="dim" style="font-size:9.5px;margin-left:4px">${d.cores} cores</small>` : ''}</span>
        <span class="pu-cell">${tot.ram === null ? '—' : tot.ram + '%'}</span>
        <span class="pu-cell">${tot.disk}%</span>
      </div>
    </div>`;
}

function viewDevices() {
  const d = DB.devices.find((x) => x.name === state.selectedDevice) || DB.devices[0];
  /* Before the hub answers there are no devices yet: say so instead of showing a stale list. */
  if (!d) return pageHead('Devices', 'fleet', 'Waiting for the hub…') + '<div class="dim" style="padding:14px;font-size:12px">No devices yet.</div>';
  const detail = `<div class="card" style="width:340px;flex:none;display:flex;flex-direction:column">
    <div style="display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid var(--border-subtle)">
      <div class="dev-ico" style="width:30px;height:30px">${ic(d.icon)}</div>
      <div style="flex:1;display:flex;flex-direction:column;gap:1px"><b style="font-size:13px">${esc(d.name)}</b><small class="dim mono" style="font-size:10.5px">${esc(d.id)}</small></div>
      ${statusPill(d.status)}
    </div>
    <div style="padding:14px;display:flex;flex-direction:column;gap:14px;overflow:auto;flex:1">
      <div>
      <div class="s-header" style="padding:0 0 6px">Device usage</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        ${[['CPU', d.cpu === null ? '—' : `${d.cpu}%${d.cores ? ` · ${d.cores} cores` : ''}`, d.cpu || 0], ['RAM', d.ram === null ? '—' : `${d.ram}%${memText(d.ramUsed, d.ramTotal) ? ' · ' + memText(d.ramUsed, d.ramTotal) : ''}`, d.ram || 0], ['Disk', d.disk == null ? '—' : d.disk + '%', d.disk || 0], ['Sessions', String(d.sess), d.sess * 12]].map(([k, v, p]) => `
          <div style="display:flex;flex-direction:column;gap:6px">
            <div style="display:flex;font-size:10.5px;color:var(--text-tertiary)"><span>${k}</span><span style="margin-left:auto;color:var(--text-secondary)">${v}</span></div>
            <div class="progress" style="width:100%;height:4px"><b style="height:4px;width:${Math.min(100, p)}%;background:${p > 80 ? 'var(--danger)' : p > 60 ? 'var(--warning)' : 'var(--accent)'}"></b></div>
          </div>`).join('')}
      </div>
      </div>
      ${projUsage(d)}
      <div>
        <div class="s-header" style="padding:0 0 6px">Connection</div>
        ${[['Host', d.host], ['Architecture', d.arch], ['Transport', d.transport], ['Uptime', d.uptime], ['Agent', d.agent], ['Last seen', d.seen]].map(([k, v]) => `
          <div class="kv" style="padding:7px 0"><div class="kt"><b style="font-size:12px;font-weight:400;color:var(--text-secondary)">${k}</b></div><span class="mono" style="font-size:11.5px">${esc(v)}</span></div>`).join('')}
      </div>
      <div>
        <div class="s-header" style="padding:0 0 6px">Coding agents</div>
        ${!d.agents ? '<div class="dim" style="font-size:11.5px;padding:4px 0">Unknown: no XBLabs agent on this device to look</div>'
          : d.agents.map((a) => `
          <div class="kv" style="padding:7px 0" title="${esc(a.path)}"><div class="kt"><b style="font-size:12px;font-weight:400;color:var(--text-secondary)">${esc(a.name)}</b></div><span class="mono" style="font-size:11.5px">${esc(a.version || 'installed')}</span></div>`).join('')
          || '<div class="dim" style="font-size:11.5px;padding:4px 0">None found on PATH</div>'}
      </div>
      <div>
        <div class="s-header" style="padding:0 0 6px">Sessions on this device</div>
        ${DB.sessions.filter((s) => s.live && s.live.device === d.name).slice(0, 6).map((s) => `
          <div class="pop-row" data-session="${s.id}">${ic('chat-circle')}<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(s.title)}</span><span class="meta">${esc(s.elapsed)}</span></div>`).join('')
          || '<div class="dim" style="font-size:11.5px;padding:4px 0">No runs on this device yet</div>'}
      </div>
    </div>
    <div style="display:flex;gap:8px;padding:12px 14px;border-top:1px solid var(--border-subtle)">
      <button class="btn secondary sm" style="flex:1" data-act="term-open" data-host="${esc(d.name)}">${ic('terminal-window')}Open shell</button>
      <button class="btn secondary sm" style="flex:1" data-act="refresh">${ic('arrows-clockwise', 'bold')}Refresh</button>
    </div>
  </div>`;

  return pageHead('Devices', 'fleet', `${DB.devices.length} paired · ${DB.devices.filter((d) => d.status === 'online').length} online · ${DB.devices.filter((d) => d.status !== 'online').length} idle or offline`,
    `<button class="btn primary" data-act="pair">${ic('plus', 'bold')}Pair device</button>
     <button class="btn secondary" data-act="filter">${ic('funnel')}Filter</button>
     <button class="btn secondary" data-act="refresh">${ic('arrows-clockwise')}Refresh</button>`)
    + `<div class="toolbar">
        ${[['all', 'All'], ['online', 'Online'], ['idle', 'Idle'], ['offline', 'Offline']].map(([k, t]) =>
          `<button class="chip ${state.devStatus === k ? 'active' : ''}" data-devst="${k}">${t}<span class="cnt">${k === 'all' ? DB.devices.length : DB.devices.filter((d) => d.status === k).length}</span></button>`).join('')}
        <div class="field-inline" style="width:200px">${ic('magnifying-glass')}<input data-q="devQuery" value="${esc(state.devQuery)}" placeholder="Find device" aria-label="Find device"></div>
        <div class="grow"></div>
      </div>`
    + `<div class="split fill">
        <div class="card" style="flex:1;display:flex;flex-direction:column;min-height:0">
          ${deviceTable(devicesFiltered(), { selected: (DB.devices.find((x) => x.name === state.selectedDevice) || DB.devices[0] || {}).name })}
          <div class="tfoot"><span>${devicesFiltered().length} of ${DB.devices.length} devices · refreshed ${window.__refreshedAt || 'on load'}</span><span class="link" data-nav="logs">${ic('terminal-window')}Open terminal</span></div>
        </div>
        ${detail}
      </div>`;
}

/* ---------- usage ---------- */
/* Usage mirrors the 9router dashboard behind the saved LLM endpoint (Settings → Models): the same
   totals, chart and per-model table, read through the hub's /api/router/usage. */
const U_PERIODS = [['today', 'Today'], ['24h', '24h'], ['7d', '7D'], ['30d', '30D'], ['60d', '60D'], ['all', 'All']];
const uNum = (n) => Math.round(n || 0).toLocaleString('en-US');
const uShort = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(Math.round(n || 0)));
const uCost = (n) => `$${(n || 0).toFixed(2)}`;
/* Smooth line + soft area. The SVG stretches to the card (viewBox
   1000×200, preserveAspectRatio none, non-scaling strokes); axis labels, crosshair, dot and the
   hover tooltip are HTML on top, positioned in percent. */
function lineChart(labels, vals, fmt, name) {
  const n = vals.length;
  if (!n) return '<div class="dim" style="flex:1">No requests in this period</div>';
  const W = 1000, H = 200, f = (v) => +v.toFixed(1);
  const raw = Math.max(...vals) || 1, mag = 10 ** Math.floor(Math.log10(raw));
  const top = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((m) => m >= raw);
  const pts = vals.map((v, i) => [n === 1 ? W / 2 : i / (n - 1) * W, H - v / top * H]);
  /* Monotone cubic (Fritsch–Carlson): smooth but never dips below zero. */
  const sl = pts.slice(1).map((p, i) => (p[1] - pts[i][1]) / (p[0] - pts[i][0]));
  const m = pts.map((_, i) => (i === 0 ? sl[0] || 0 : i === n - 1 ? sl[n - 2] : sl[i - 1] * sl[i] <= 0 ? 0 : (sl[i - 1] + sl[i]) / 2));
  sl.forEach((s, i) => {
    if (!s) { m[i] = m[i + 1] = 0; return; }
    const a = m[i] / s, b = m[i + 1] / s, h = a * a + b * b;
    if (h > 9) { const t = 3 / Math.sqrt(h); m[i] = t * a * s; m[i + 1] = t * b * s; }
  });
  let line = `M${f(pts[0][0])},${f(pts[0][1])}`;
  for (let i = 0; i < n - 1; i++) {
    const dx = (pts[i + 1][0] - pts[i][0]) / 3;
    line += `C${f(pts[i][0] + dx)},${f(pts[i][1] + m[i] * dx)} ${f(pts[i + 1][0] - dx)},${f(pts[i + 1][1] - m[i + 1] * dx)} ${f(pts[i + 1][0])},${f(pts[i + 1][1])}`;
  }
  const every = Math.max(1, Math.ceil(n / 14));
  const ticks = labels.map((l, i) => [l, i]).filter(([, i]) => i % every === 0 || i === n - 1);
  const xp = (i) => (n === 1 ? 50 : i / (n - 1) * 100);
  const data = esc(JSON.stringify(vals.map((v, i) => [labels[i], fmt(v), f(pts[i][1] / H * 100)])));
  return `<div class="u-line">
    <div class="u-y">${[4, 3, 2, 1, 0].map((k) => `<span style="top:${(4 - k) * 25}%">${fmt(top * k / 4)}</span>`).join('')}</div>
    <div class="u-plot" data-pts="${data}" data-name="${esc(name)}">
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
        <defs><linearGradient id="u-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:var(--accent);stop-opacity:.28"/><stop offset="1" style="stop-color:var(--accent);stop-opacity:0"/></linearGradient></defs>
        ${[0, 1, 2, 3, 4].map((k) => `<line class="u-grid" x1="0" x2="${W}" y1="${k * H / 4}" y2="${k * H / 4}"/>`).join('')}
        ${ticks.map(([, i]) => `<line class="u-grid" x1="${f(pts[i][0])}" x2="${f(pts[i][0])}" y1="0" y2="${H}"/>`).join('')}
        <path d="${line}L${f(pts[n - 1][0])},${H}L${f(pts[0][0])},${H}Z" fill="url(#u-fill)"/>
        <path class="u-stroke" d="${line}"/>
      </svg>
      <i class="u-cross"></i><i class="u-dot"></i><div class="u-tip" role="status"></div>
    </div>
    <div class="u-x">${ticks.map(([l, i]) => `<span style="left:${xp(i)}%">${esc(l)}</span>`).join('')}</div>
  </div>`;
}
/* Hover: nearest point to the cursor gets the crosshair, dot and a tooltip with its value. */
document.addEventListener('pointermove', (e) => {
  const plot = e.target.closest?.('.u-plot');
  if (!plot) return;
  const pts = JSON.parse(plot.dataset.pts), r = plot.getBoundingClientRect();
  const i = Math.round(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * (pts.length - 1));
  const x = pts.length === 1 ? 50 : i / (pts.length - 1) * 100;
  plot.classList.add('hover');
  plot.style.setProperty('--hx', `${x}%`);
  plot.style.setProperty('--hy', `${pts[i][2]}%`);
  const tip = plot.querySelector('.u-tip');
  tip.innerHTML = `<b>${esc(pts[i][0])}</b><span>${esc(plot.dataset.name)} : ${esc(pts[i][1])}</span>`;
  tip.classList.toggle('flip', x > 70);
});
document.addEventListener('pointerleave', (e) => { if (e.target.classList?.contains('u-plot')) e.target.classList.remove('hover'); }, true);

/* New timeframe on screen: numbers count up and the line draws again, on the main thread only
   (text and an inline clip-path), so no card is lifted onto its own GPU layer. */
function usageReplay() {
  if (typeof stillMotion === 'function' && stillMotion()) return;
  document.querySelectorAll('#main .u-stats .val b').forEach((b) => typeof countUp === 'function' && countUp(b));
  const paths = [...document.querySelectorAll('#main .u-plot path')];
  const t0 = performance.now(), dur = 1100;
  const step = (t) => {
    const p = Math.min(1, (t - t0) / dur), e = 1 - (1 - p) ** 3;
    paths.forEach((el) => { el.style.clipPath = p === 1 ? '' : `inset(0 ${((1 - e) * 100).toFixed(2)}% 0 0)`; });
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
function viewUsage() {
  const period = state.usagePeriod || 'today';
  const metric = state.usageMetric || 'tokens';
  const R = window.LIVE && LIVE.router;
  /* A timeframe switch keeps the last numbers up until the new ones arrive, then patches them in
     place and replays only the count-up and the line. Rebuilding the page to replay its entrance
     moved every card on a GPU layer, which flashed their borders white. The loading card is only
     for the first read. */
  const shown = !!R && !R.error;
  if ((!R || R.period !== period) && !viewUsage.loading && typeof routerLoad === 'function') {
    viewUsage.loading = true;
    routerLoad().finally(() => {
      viewUsage.loading = false;
      if (state.page !== 'usage') return;
      if (shown) { render(); usageReplay(); } else { render.last = null; render(); }   // first read: the full entrance
    });
  }
  const head = pageHead('Usage', 'storage', R && R.origin ? `9router · <span class="sens">${esc(R.origin)}</span>` : '9router',
    segment(U_PERIODS, period, 'data-uperiod'));

  if (!R || (R.period !== period && !shown)) return head + '<div class="card u-empty"><b>Loading 9router usage…</b></div>';
  if (R.error) {
    return head + `<div class="card u-empty">
      <b>${esc(R.error)}</b>
      ${R.needsLogin || !R.hasPassword ? `<small class="dim">9router keeps usage behind its dashboard login. The password is saved on the hub only and used to sign in to ${esc(R.origin || '9router')}.</small>
      <div class="u-login"><span class="input"><input id="router-pass" type="password" autocomplete="off" placeholder="${R.hasPassword ? 'Saved — type to replace' : '9router dashboard password'}" aria-label="9router dashboard password"></span>
        <button class="btn primary" data-act="router-save">Sign in</button></div>` : ''}
    </div>`;
  }

  const s = R.stats || {};
  const chart = R.chart || [];
  const stats = [
    ['Total requests', uNum(s.totalRequests), ''],
    ['Input tokens', uNum(s.totalPromptTokens), 'u-in'],
    ['Cached tokens', uNum(s.totalCachedTokens), 'u-cache'],
    ['Output tokens', uNum(s.totalCompletionTokens), 'u-out'],
    ['Est. cost', `~${uCost(s.totalCost)}`, 'u-cost'],
  ];
  const vals = chart.map((d) => d[metric] || 0);
  const fmt = metric === 'cost' ? uCost : uShort;

  const models = Object.values(s.byModel || {}).sort((a, b) => b.cost - a.cost || b.requests - a.requests);
  const providers = Object.entries(s.byProvider || {}).sort((a, b) => b[1].promptTokens + b[1].completionTokens - a[1].promptTokens - a[1].completionTokens);
  const pMax = Math.max(1, ...providers.map(([, p]) => p.promptTokens + p.completionTokens));
  /* byProvider is keyed by raw provider id; byModel keys ("model (id)") carry its display name. */
  const pName = {};
  for (const [k, m] of Object.entries(s.byModel || {})) { const id = k.match(/\(([^()]*)\)$/)?.[1]; if (id && m.provider) pName[id] = m.provider; }
  const when = (t) => rel(Date.parse(t));

  return head
    + `<div class="stat-grid u-stats">${stats.map(([l, v, c]) => `<div class="stat"><div class="top">${l}</div><div class="val"><b class="${c}">${v}</b></div></div>`).join('')}</div>`
    + `<div class="card chart-card ov-chart u-chart">
        <div class="chart-head">
          <div class="tb"><small>${metric === 'tokens' ? 'Input + output tokens' : metric === 'cost' ? 'Estimated cost' : 'Requests'} · ${esc(U_PERIODS.find((p) => p[0] === period)[1])}</small><b class="num">${fmt(vals.reduce((a, v) => a + v, 0))}</b></div>
          ${segment([['tokens', 'Tokens'], ['requests', 'Requests'], ['cost', 'Cost']], metric, 'data-umetric')}
        </div>
        ${lineChart(chart.map((d) => d.label), vals, fmt, { tokens: 'Tokens', requests: 'Requests', cost: 'Cost' }[metric])}
      </div>`
    + `<div class="split u-split">
        <div class="card u-table-card">
          <div class="card-head"><h2>Usage by model</h2><div class="grow"></div><span class="count-chip">${models.length} models</span></div>
          <div class="u-table">
            <div class="u-tr u-th"><span>Model</span><span>Provider</span><span>Requests</span><span>Last used</span><span>Input</span><span>Cached</span><span>Output</span><span>Cost</span></div>
            ${models.map((m) => `<div class="u-tr">
              <span class="u-model" title="${esc(m.rawModel)}">${esc(m.rawModel)}</span><span class="dim" title="${esc(m.provider || "")}">${esc(m.provider || "—")}</span>
              <span class="num">${uNum(m.requests)}</span><span class="dim">${when(m.lastUsed)}</span>
              <span class="num u-in">${uShort(m.promptTokens)}</span><span class="num u-cache">${m.cachedTokens ? uShort(m.cachedTokens) : '—'}</span>
              <span class="num u-out">${uShort(m.completionTokens)}</span><span class="num u-cost">${uCost(m.cost)}</span>
            </div>`).join('') || '<div class="jempty">No model usage in this period</div>'}
          </div>
        </div>
        <div class="col fixed-380">
          <div class="card u-recent">
            <div class="card-head"><h2>Recent requests</h2></div>
            <div class="u-list">${(s.recentRequests || []).map((r) => `<div class="u-li">
              <i class="${r.status === 'ok' ? 'ok' : 'bad'}"></i><span class="u-model" title="${esc(r.model)}">${esc(r.model)}</span>
              <span class="num"><b class="u-in">${uNum(r.promptTokens)}↑</b> <b class="u-out">${uNum(r.completionTokens)}↓</b></span>
              <span class="dim">${when(r.timestamp)}</span></div>`).join('') || '<div class="jempty">No requests yet</div>'}</div>
          </div>
          <div class="card u-prov">
            <div class="card-head"><h2>By provider</h2></div>
            <div class="u-list">${providers.map(([name, p]) => `<div class="u-pv">
              <span title="${esc(name)}">${esc(pName[name] || name)}</span>
              <div class="progress"><b style="width:${Math.round((p.promptTokens + p.completionTokens) / pMax * 100)}%"></b></div>
              <span class="num dim">${uShort(p.promptTokens + p.completionTokens)}</span></div>`).join('')}</div>
          </div>
        </div>
      </div>`;
}

/* ---------- logs ---------- */
function viewLogs() {
  const levels = ['all', 'info', 'warn', 'error'];
  const logsOpen = state.termLogs !== false;
  const liveAlive = (s) => !!s && ['running', 'starting', 'waiting'].includes(s.status);
  /* One tab per shell, live ones first — same as leaving several SSH tabs open. */
  /* A tab exists while its shell runs; closing the tab or the process removes it. */
  const shells = [...(window.LIVE && LIVE.shells ? LIVE.shells : [])]
    .filter(liveAlive)
    .sort((a, b) => b.created_at - a.created_at)
    .slice(0, 8);
  const activeId = shells.some((s) => s.id === state.termTab) ? state.termTab
    : (shells.find(liveAlive) || shells[0] || {}).id || null;
  /* Logs belong to a tab: none open means nothing to show, and the panel follows the tab you
     are looking at instead of blending every shell together. */
  const rows = activeId ? DB.logs.filter((l) => (state.logLevel === 'all' || l.lvl === state.logLevel)
    && (state.logFilter === 'all' || l.src === state.logFilter)
    && (state.logTab === 'all' || state.logTab === 'server' || l.src === state.logTab)
    && String(l.msg).includes(activeId)) : [];
  const tsInfo = (window.LIVE && LIVE.ts) || {};
  return pageHead('Terminal', 'terminal-window',
    `${shells.filter(liveAlive).length} live shell${shells.filter(liveAlive).length === 1 ? '' : 's'} · ${shells.length} open · ${esc(tsInfo.tailnet || 'no tailnet')}`,
    `<button class="btn secondary" data-act="copy" ${activeId ? '' : 'disabled'}>${ic('copy')}Copy output</button>
     <button class="btn secondary" data-act="term-logs">${ic('sidebar-simple')}${logsOpen ? 'Hide logs' : 'Show logs'}</button>`)
    + `<div class="term-split" style="--logs-w:${termLogsW()}px">
        <section class="card term-main">
          <div class="termtabs">
            ${shells.map((s) => `<div class="ttab ${liveAlive(s) ? 'on' : ''} ${s.id === activeId ? 'active' : ''}" data-termtab="${esc(s.id)}" title="${esc(s.id)} · ${esc(s.cwd || '')}">
                <i class="tt-dot"></i><span class="tt-name">${esc(s.title)}</span>
                <button class="tt-x" data-termtab-close="${esc(s.id)}" aria-label="Close shell">${ic('x', '', 'tt-xico')}</button>
              </div>`).join('')}
            <button class="tt-plus" data-act="term-new" title="New shell">${ic('plus')}</button>
            <span class="grow"></span>
          </div>
          ${activeId ? '<div class="runterm" id="term-main"></div>'
            : `<div class="runterm term-empty" id="term-main"><span>No shell open — press ${ic('plus')} and pick a device.</span></div>`}
        </section>
        ${logsOpen ? `<section class="card term-logpanel">
          <div class="term-drag" data-term-drag title="Drag to resize" role="separator" aria-orientation="vertical" aria-label="Resize logs"></div>
          <div class="chat-head"><b>Logs</b><span class="wsbadge">${rows.length}</span><span class="grow"></span>
            <div class="levels">${levels.map((l) => `<button class="chip ${state.logLevel === l ? 'active' : ''}" data-level="${l}">${l}</button>`).join('')}</div>
            <button class="cbtn" data-act="clear" title="Clear log ring">${ic('trash')}</button>
          </div>
          <div class="console-body">${rows.map((l) => `
            <div class="logrow ${l.lvl}"><time>${l.t}</time><span class="lvl">${l.lvl}</span><span class="src">${l.src}</span><span class="msg">${esc(l.msg)}</span></div>`).join('')
            || `<div class="jempty">${activeId ? 'No events for this shell yet.' : 'Open a terminal tab to see its log.'}</div>`}
          </div>
        </section>` : ''}
      </div>`;
}

/* Width of the Terminal page's Logs panel, dragged by its left edge and remembered here. */
function termLogsW() { try { return Math.max(240, +localStorage.getItem('xblabs.logsW') || 380); } catch { return 380; } }
document.addEventListener('pointerdown', (e) => {
  const h = e.target.closest('[data-term-drag]');
  const split = h && h.closest('.term-split');
  if (!split) return;
  e.preventDefault();
  h.classList.add('on');
  h.setPointerCapture(e.pointerId);
  const box = zRect(split);
  let w = termLogsW();
  const move = (ev) => {
    w = Math.round(Math.min(box.width - 320, Math.max(240, box.right - ev.clientX / ZM() - 6)));
    split.style.setProperty('--logs-w', `${w}px`);
    try { localStorage.setItem('xblabs.logsW', String(w)); } catch { /* not kept */ }   // a poll re-render mid-drag keeps it
  };
  const up = () => {
    h.classList.remove('on');
    h.removeEventListener('pointermove', move);
    try { localStorage.setItem('xblabs.logsW', String(w)); } catch { /* not kept */ }
    window.dispatchEvent(new Event('resize'));   // the terminal refits to its new width
  };
  h.addEventListener('pointermove', move);
  h.addEventListener('pointerup', up, { once: true });
  h.addEventListener('pointercancel', up, { once: true });
});

/* ---------- notes ---------- */
function notesFiltered() {
  const q = state.noteQuery.trim().toLowerCase();
  return DB.notes
    .map((note, i) => [note, i])
    .filter(([n]) => !q || `${n.title} ${n.body} ${n.ws} ${(n.tags || []).join(' ')}`.toLowerCase().includes(q))
    .filter(([n]) => state.noteFilter === 'all' ? true
      : state.noteFilter === 'pinned' ? n.pinned
        : state.noteFilter === 'mine' ? n.author === DB.user.name
          : !n.pinned);
}

function viewNotes() {
  /* With no notes (or a selection that no longer exists) the editor shows an empty state; reading
     n.title on undefined used to throw, and the previous page stayed on screen. */
  const n = DB.notes.find((x) => x.id === state.selectedNote) || DB.notes[0];
  state.selectedNote = n ? n.id : null;
  return pageHead('Notes', 'notes', `${DB.notes.length} notes · ${DB.notes.filter((n) => n.pinned).length} pinned · ${new Set(DB.notes.map((n) => n.ws)).size} workspaces`,
    `<button class="btn primary" data-act="new-note">${ic('plus', 'bold')}New note</button>`)
    + `<div class="split">
        <div class="card notes-list">
          <div style="padding:12px;display:flex;flex-direction:column;gap:8px;border-bottom:1px solid var(--border-subtle)">
            <div style="display:flex;align-items:center;gap:8px"><b style="font-size:13px">All notes</b><span class="wsbadge">${DB.notes.length}</span></div>
            <div class="field-inline" style="width:100%">${ic('magnifying-glass')}<input data-q="noteQuery" value="${esc(state.noteQuery)}" placeholder="Search notes" aria-label="Search notes"></div>
            <div style="display:flex;gap:4px">${[['all', 'All'], ['pinned', 'Pinned'], ['mine', 'Mine'], ['shared', 'Shared']].map(([k, t]) => `<button class="chip sm ${state.noteFilter === k ? 'active' : ''}" data-nf="${k}" style="${state.noteFilter === k ? '' : 'border-color:transparent;background:none'}">${t}</button>`).join('')}</div>
          </div>
          <div class="rows" style="flex:1">${notesFiltered().map(([note, i]) => `
            <div class="note-item ${note.id === state.selectedNote ? 'active' : ''}" data-note="${esc(note.id)}">
              <div class="note-top">${note.pinned ? ic('push-pin-simple-fill', 'fill', 'pin') : ''}<span>${esc(note.title)}</span><time>${esc(note.when)}</time></div>
              <p>${esc(note.body)}</p>
              <div class="note-meta">${noteProg(noteTodos(note.body))}<span>${esc(note.ws)}</span>${note.tags.map((t) => `<span class="tag">${t}</span>`).join('')}</div>
            </div>`).join('')}</div>
          <div class="tfoot" style="height:34px"><span>${notesFiltered().length} of ${DB.notes.length} shown</span></div>
        </div>
        ${!n ? `<div class="card editor notes-empty">${ic('notebook')}<b>No notes yet</b>
          <span>Notes are saved as .txt files in the Notes folder. A .txt dropped into that folder shows up here too.</span>
          <button class="btn primary sm" data-act="new-note">${ic('plus', 'bold')}New note</button></div>` : `<div class="card editor">
          <div class="editor-head">
            ${ic('notebook')}<input class="note-title" data-note-title="${esc(n.id)}" value="${esc(n.title)}" aria-label="Note title" title="Rename: type, then Enter" spellcheck="false">
            <span class="note-headmeta" title="${n.file ? `Saved as Notes/${esc(n.file)} · ` : ''}${esc(n.ws)} · ${esc(n.when)}">${noteProg(noteTodos(n.body))}<span>${esc(n.when)}</span></span>
            <span id="note-state" class="dim" aria-live="polite"></span>
            <button class="btn ghost sm ${state.notePreview ? 'active' : ''}" data-act="note-preview" aria-pressed="${!!state.notePreview}" title="${state.notePreview ? 'Back to editing' : 'Preview: tick checkboxes'}">${ic(state.notePreview ? 'pencil-simple' : 'eye')}</button>
            <button class="chip sm note-auto ${prefs.noteAutosave ? 'active' : ''}" data-act="note-autosave" aria-pressed="${!!prefs.noteAutosave}" title="Save while typing">${ic(prefs.noteAutosave ? 'toggle-right' : 'toggle-left')}Auto save</button>
            <button class="btn ghost sm" data-note-del="${esc(n.id)}" title="Delete note">${ic('trash')}</button>
            ${prefs.noteAutosave ? '' : `<button class="btn primary sm" data-note-save="${esc(n.id)}">Save</button>`}
          </div>
          ${state.notePreview ? '' : `<div class="note-fmt-bar" role="toolbar" aria-label="Format">${[
            [['**', 'text-b', 'Bold'], ['*', 'text-italic', 'Italic'], ['~~', 'text-strikethrough', 'Strikethrough'], ['`', 'code', 'Code']],
            [['# ', 'text-h-one', 'Big heading'], ['## ', 'text-h-two', 'Heading'], ['### ', 'text-h-three', 'Small heading']],
            [['- ', 'list-bullets', 'List'], ['check', 'check-square', 'Checkbox line'], ['> ', 'quotes', 'Quote']],
          ].map((g) => g.map(([f, i, t]) => (f === 'check'
            ? `<button class="nfb" data-act="note-check" title="${t}" aria-label="${t}">${ic(i)}</button>`
            : `<button class="nfb" data-note-fmt="${f}" title="${t}" aria-label="${t}">${ic(i)}</button>`)).join('')).join('<i class="nfb-sep"></i>')}
            ${n.file ? `<span class="mono note-file" title="Saved as Notes/${esc(n.file)}">Notes/${esc(n.file)}</span>` : ''}</div>`}
          <div class="editor-body">
            ${state.notePreview ? `<div class="note-preview">${noteHTML(n.body)}</div>`
            : `<textarea id="note-body" data-note-id="${esc(n.id)}" spellcheck="false" placeholder="Write it down…">${esc(n.body)}</textarea>`}
          </div>
        </div>`}
      </div>`;
}

/* ---------- focus ---------- */
/* Focus shows what is actually live: up to three shells or runs, each a real terminal, plus a
   slot that opens a new shell on any device. */
function focusPanes() {
  const alive = (st) => ['running', 'starting', 'waiting'].includes(st);
  const seen = new Set();
  const out = [];
  for (const s of (window.LIVE && LIVE.shells) || []) {
    if (alive(s.status) && !seen.has(s.id)) { seen.add(s.id); out.push({ id: s.id, title: s.title, device: s.device, status: s.status, shell: true }); }
  }
  for (const s of DB.sessions) {
    if (s.live && alive(s.live.status) && !seen.has(s.id)) { seen.add(s.id); out.push({ id: s.id, title: s.title, device: s.live.device, status: s.live.status }); }
  }
  return out.slice(0, 3);
}
function focusSubtitle() {
  const p = focusPanes();
  const waiting = p.filter((x) => x.status === 'waiting').length;
  return `${p.length} live pane${p.length === 1 ? '' : 's'} · ${new Set(p.map((x) => x.device)).size} device${new Set(p.map((x) => x.device)).size === 1 ? "" : "s"}${waiting ? ` · ${waiting} waiting for approval` : ''}`;
}
function viewFocus() {
  const panes = focusPanes();
  return pageHead('Focus', 'focus', focusSubtitle(),
    `<button class="btn secondary" data-act="exit-focus">${ic('corners-in')}Exit focus</button>
     <button class="btn primary" data-act="term-new">${ic('plus', 'bold')}New shell</button>`)
    + `<div class="panes">
        ${panes.map((p) => `
        <section class="pane">
          <div class="pane-head">${ic(p.shell ? 'terminal-window' : 'robot')}${esc(p.device || 'local')}<span class="sid">${esc(p.id)}</span><span class="grow"></span>
            ${p.status === 'waiting' ? `<button class="btn xs accent" data-approve="${esc(p.id)}">Approve</button><button class="btn xs danger" data-reject="${esc(p.id)}">Deny</button>` : statusPill(p.status === 'waiting' ? 'idle' : 'online')}
            ${p.shell ? `<button class="btn ghost xs" data-termtab-close="${esc(p.id)}" title="Close shell" aria-label="Close shell">${ic('x')}</button>` : ''}
          </div>
          <div class="runterm focus-term" data-mount="${esc(p.id)}"></div>
        </section>`).join('')}
        <section class="pane">
          <div class="pane-head">${ic('plus-square')}New pane<span class="grow"></span></div>
          <div class="empty-pane" style="background:var(--bg-sunken)">
            ${ic('terminal-window')}
            <b>Open a shell</b>
            <p>Pick any device in the tailnet. The shell joins this grid and the Terminal page.</p>
            <div class="pickers"><button class="picker" data-act="term-new">${ic('desktop')}Choose device ${ic('caret-down')}</button></div>
          </div>
        </section>
      </div>`
    + `<div class="focus-foot"><span>${panes.length} of 3 panes in use</span><span class="sp"></span><span>Ctrl F exit</span></div>`;
}

/* ---------- agent session ----------
   Session screen: chat panel | 340 px side column (terminal + checks) |
   optional 300 px files panel. The "files off" artboard is the same layout minus the panel,
   toggled by the sidebar-simple button in the session header. */
const SESSION = {
  id: 'ses_77c0e4', title: 'Reduce deploy image size', agent: 'sonnet', mode: 'yolo · auto-approve edits',
  meter: '12.4K / 200K', ws: 'xblabs-web', branch: 'main', image: 'node:20-alpine', age: '12m', msgs: 3, tokens: '12K',
  checks: [
    { name: 'typecheck', status: 'pass 4.1s', ok: true },
    { name: 'unit tests · 148', status: 'pass 12.6s', ok: true },
    { name: 'bundle budget', status: 'pass 0.9s', ok: true },
    { name: 'e2e · playwright', status: 'running', ok: false }
  ],
  tree: [
    { n: 'src', folder: true, open: true },
    { n: 'app', folder: true, depth: 1 },
    { n: 'components', folder: true, depth: 2 },
    { n: 'lib', folder: true, depth: 2 },
    { n: 'routes', folder: true, depth: 2 },
    { n: 'docs', folder: true },
    { n: 'scripts', folder: true },
    { n: '.wrangler', folder: true },
    { n: '.worktrees', folder: true },
    { n: 'Dockerfile', mod: true, sel: true },
    { n: 'docker-compose.yml' },
    { n: 'package.json' },
    { n: 'pnpm-lock.yaml' },
    { n: 'vite.config.ts' },
    { n: 'wrangler.jsonc' },
    { n: 'tsconfig.json' },
    { n: 'AGENTS.md', doc: true },
    { n: 'CHANGELOG.md', doc: true },
    { n: '.gitignore', doc: true }
  ],
  term: [
    ['$ docker build -t xblabs/web .', 'p'],
    ['#1 [internal] load build definition', 'd'],
    ['#4 [build 2/6] RUN pnpm install --prod', 'd'],
    ['  removed 2,140 packages in 34.2s', 't'],
    ['#6 [build 5/6] RUN node scripts/prune.mjs', 'd'],
    ['  pruned 412 MB of dev dependencies', 't'],
    ['#8 exporting to image', 'd'],
    ['  writing image sha256:9f2c1ab  done', 't'],
    ['  naming to docker.io/xblabs/web:main  done', 't'],
    ['DONE 22.4s → 69.1MB (was 118.3MB)', 'ok'],
    ['', ''],
    ['$ docker image ls xblabs/web', 'p'],
    ['REPOSITORY    TAG     SIZE', 'd'],
    ['xblabs/web    main    69.1MB', 's']
  ]
};

/* A tab is a session id. The deploy session carries the hand-authored transcript; every other
   tab derives its header and terminal from its own DB.sessions row so the chrome never lies
   about which session you're looking at. */

/* ---------- agent trace primitives (thinking / tool / edit) ----------
   Mirrors what the Hermes chat shows for a run: folded reasoning, tool calls with their
   status, and file edits as a real +/- diff. All fold on click via .open. */
/* Codicon from the Hermes Desktop bundle — same glyphs its own trace rows use. */
function ci(name, cls = '') { return `<i class="codicon codicon-${name} ${cls}" aria-hidden="true"></i>`; }

/* Thought line (React Bits). Lives in app.js because the first render runs before micro.js loads. */
/* Lattice Loader (React Bits): a 3x3 lattice whose ring lights in an orbit while the agent works,
   then freezes into a check (done) or a cross (error). 'idle' is the dim silhouette alone. */
const LAT_ORBIT = [0, 1, 2, 7, null, 3, 6, 5, 4];   // step per cell, clockwise from top-left; centre is a hole
const LAT_CHECK = [3, 7, 5, 2], LAT_CROSS = [0, 2, 4, 6, 8];
function lattice(st = 'working') {
  return `<span class="lattice ${st}" aria-hidden="true">${LAT_ORBIT.map((d, i) => `<i class="${d == null ? 'hole' : ''}${LAT_CHECK.includes(i) ? ' ck' : ''}${LAT_CROSS.includes(i) ? ' x' : ''}" style="--d:${d ?? 0}"></i>`).join('')}</span>`;
}
function thoughtLine(o) {
  const working = o.secs == null;
  const secs = working ? ((Date.now() - o.t0) / 1000).toFixed(1) : o.secs;
  const steps = o.steps || [];
  const done = steps.length ? `Thought for ${secs}s` : o.empty || 'Done thinking';
  return `<div class="tline ${working ? 'working open' : ''}" data-fold="1" ${o.id ? `data-tl="${o.id}"` : ''}>
    <div class="tl-head">
      <span class="tl-glyph">${ic('sparkle', 'fill')}</span>
      <span class="tl-label"><span class="tl-work">Thinking…</span><span class="tl-done">${esc(done)}</span></span>
      <span class="tl-time num">${working ? secs + 's' : ''}</span>
      ${steps.length ? `<span class="tl-chev">${ic('caret-down')}</span>` : ''}
    </div>
    <div class="tl-steps"><div class="tl-steps-in">${tlSteps(steps, working)}</div></div>
  </div>`;
}
function tlSteps(steps, working) {
  return steps.map((s, i) => {
    const cur = working && i === steps.length - 1;
    return `<div class="tl-step ${cur ? 'cur' : ''}"><span class="tl-tick">${cur ? '<i></i>' : ic('check', 'bold')}</span><span>${esc(s)}</span></div>`;
  }).join('');
}
function think(secs, paras) { return thoughtLine({ secs, steps: paras }); }

/* One dim sentence per action: "Ran docker build -t xblabs/web ." — no card, no accent.
   `verb` defaults to Ran; read/search pass their own so the line reads like prose. */
function tool(o) {
  const cls = o.status === 'err' ? 'err' : o.status === 'run' ? 'run' : o.status === 'gone' ? 'gone' : 'ok';
  return `<div class="tool ${o.open ? 'open' : ''}" data-fold="1">
    <div class="tool-head">${ci(o.glyph || 'terminal', 'trace-glyph')}<span class="tool-name">${esc(o.verb || 'Ran')}</span>
      <span class="tool-args">${esc(o.args || '')}</span><span class="tool-meta ${cls}">${esc(o.meta || '')}</span></div>
    <div class="tool-body">${(o.out || []).map(([t, tone]) => `<div class="tool-out ${tone || ''}">${esc(t)}</div>`).join('')}</div>
  </div>`;
}

/* Collapse repeats: the header states the count, expanding reveals each row indented. */
function traceGroup(label, items) {
  return `<div class="tgroup" data-fold="1">
    <div class="tgroup-head">${ci('run-all', 'trace-glyph')}<b>${esc(label)}</b><span class="chev">${ic('caret-right')}</span></div>
    <div class="tgroup-children">${items.join('')}</div>
  </div>`;
}

function editCard(o) {
  const rows = o.lines.map(([k, n, t]) => `<div class="${k}"><span class="n">${n}</span><span>${k === 'add' ? '+' : k === 'del' ? '-' : ' '}${esc(t)}</span></div>`).join('');
  return `<div class="edit ${o.closed ? '' : 'open'}" data-fold="1">
    <div class="edit-head">${ci('edit', 'trace-glyph')}<span class="edit-file">${esc(o.file)}</span>
      <span class="edit-stat"><b class="add">+${o.add}</b> <b class="del">-${o.del}</b></span>
      <span class="open-diff">diff</span></div>
    <div class="diff">${rows}</div>
  </div>`;
}

/* The session's changed files. One source: the transcript renders them inline, the MODEL tab
   lists them. Duplicating the diff data is how the two views drift apart. */
const EDITS = [
  { file: 'Dockerfile', add: 18, del: 6, lines: [['ctx', 1, 'FROM node:20-alpine AS builder'], ['add', 2, 'WORKDIR /app'], ['add', 3, 'COPY package.json pnpm-lock.yaml ./'], ['add', 4, 'RUN pnpm install --frozen-lockfile'], ['del', 5, 'RUN npm install'], ['ctx', 6, ''], ['add', 7, 'FROM node:20-alpine AS runner'], ['add', 8, 'COPY --from=builder /app/node_modules ./node_modules']] },
  { file: 'docker-compose.yml', add: 3, del: 2, lines: [['ctx', 18, 'services:'], ['ctx', 19, '  web:'], ['del', 20, '    build: .'], ['add', 20, '    build:'], ['add', 21, '      context: .'], ['add', 22, '      target: runner']] },
];

function sessionFor(id) {
  const row = DB.sessions.find((x) => x.id === id);
  if (!row || row.id === SESSION.id) return SESSION;
  const ws = row.ws;
  return {
    id: row.id, title: row.title, agent: row.agent.toLowerCase(), mode: 'default · ask before edits',
    meter: `${row.tokens || 0} / 200K`, ws, branch: row.branch, image: 'node:20-alpine', age: row.elapsed,
    msgs: row.msgs, tokens: row.tokens, col: row.col,
    checks: [
      { name: 'typecheck', status: `${(row.msgs % 5) + 1}.${row.msgs % 9}s`, ok: row.col !== 'waiting' },
      { name: 'unit tests · 148', status: row.col === 'queued' ? 'queued' : 'pass', ok: row.col === 'running' }
    ],
    tree: [
      { n: 'src', folder: true, open: true },
      { n: 'app', folder: true, depth: 1 },
      { n: 'components', folder: true, depth: 1 },
      { n: 'lib', folder: true, depth: 1 },
      { n: 'docs', folder: true },
      { n: 'package.json' },
      { n: 'AGENTS.md', doc: true }
    ],
    term: [
      [`$ git switch ${row.branch}`, 'p'],
      [`Switched to branch '${row.branch}'`, 't'],
      ['', ''],
      ['$ git status --short', 'p'],
      [' M src/lib/session.ts', 'd'],
      [' M src/routes/index.tsx', 'd'],
      ['', ''],
      [`# ${row.msgs} messages · ${row.tokens} tokens`, 'd']
    ]
  };
}

/* Compact transcript for sessions without a hand-authored one: two messages that only assert
   what the row already knows (branch, message count, tokens), so nothing is invented. */
function genericMsgs(S) {
  const ws = S.ws;
  return `
    <div class="msg-user-block">
      <span class="msg-meta">you · ${esc(S.age)} ago</span>
      <div class="msg-bubble">${esc(S.title)}</div>
    </div>
    <div class="msg-agent"><div class="msg-content">
      ${worked("Worked", `${S.age} · 2 steps · 2 files`, `<div class="trace">
        ${think(3, [`${S.msgs} messages in, still on ${S.branch}. Checking what is dirty before touching anything.`])}
        ${tool({ glyph: 'terminal', verb: 'Ran', args: 'git status --short', meta: S.col === 'waiting' ? 'awaiting approval' : 'exit 0',
          out: [[' M src/lib/session.ts', 'dim'], [' M src/routes/index.tsx', 'dim']] })}
      </div>`)}
      <p class="msg-foot">Working on <b>${esc(ws)}</b> at branch <span class="mono">${esc(S.branch)}</span>. ${S.msgs} messages so far, ${esc(S.tokens)} tokens.</p>
    </div></div>`;
}

function tabsOf(ws) {
  return (state.openTabs && state.openTabs[ws]) || [];
}

/* The session's worktree as read by the hub: id -> { data } | { error } | { loading }. */
const GIT = {};
async function gitLoad(id, { quiet = false } = {}) {
  if (!quiet) GIT[id] = { ...(GIT[id] || {}), loading: true };
  try {
    const r = await fetch(`/api/sessions/${id}/git`, { cache: 'no-store' });
    const j = await r.json();
    GIT[id] = j.error ? { error: j.error } : { data: j };
  } catch (err) { GIT[id] = { error: err.message }; }
  return GIT[id];
}
/* Paths -> the flat tree fileRows walks: folders first, each path a row, changed files marked. */
function treeFromPaths(paths, changed) {
  const root = new Map();
  for (const p of paths) {
    let node = root;
    for (const part of p.split('/').slice(0, -1)) { if (!node.has(part + '/')) node.set(part + '/', new Map()); node = node.get(part + '/'); }
    node.set(p.split('/').pop(), p);
  }
  const out = [];
  const walk = (node, depth, pre) => [...node.entries()]
    .sort(([a, av], [b, bv]) => (typeof bv === 'string') - (typeof av === 'string') || a.localeCompare(b))
    .forEach(([name, v]) => {
      if (typeof v === 'string') out.push({ n: v, label: name, depth, mod: changed.has(v) });
      else {
        const path = pre + name;
        out.push({ n: path, label: name.slice(0, -1), folder: true, depth, mod: [...changed].some((c) => c.startsWith(path)) });
        walk(v, depth + 1, path);
      }
    });
  walk(root, 0, '');
  return out;
}

/* Flat tree + depth, so a folder hides its descendants by walking the stack above it. */
function fileRows(S) {
  const open = (f) => state.folders?.[f.n] ?? f.open ?? false;
  const hidden = (f, stack) => stack.some((anc) => !open(anc));
  const stack = [];
  const out = [];
  S.tree.forEach((f) => {
    const d = f.depth || 0;
    stack.length = d;
    if (!hidden(f, stack)) {
      const sel = state.selFile === f.n || (!state.selFile && f.sel);
      out.push(`<button class="fnode ${sel ? 'sel' : ''}" data-${f.folder ? 'folder' : 'file'}="${esc(f.n)}">
        ${d ? `<i class="indent" style="width:${d * 12}px"></i>` : ''}
        ${f.folder ? ic(open(f) ? 'folder-open' : 'folder') : ic(f.doc ? 'file-text' : 'file-code')}
        <span>${esc(f.label || f.n)}</span>${f.mod ? '<b class="mod">M</b>' : ''}
      </button>`);
    }
    if (f.folder) stack.push(f);
  });
  return out.join('');
}

function sessionTabs(S) {
  const list = tabsOf(S.ws);
  return `<div class="chtabs">
    <span class="chtabs-ws">${ic('folder-open')}${esc(DB.workspaces.find((w) => w.id === S.ws)?.dir || S.ws)}</span>
    ${list.map((id) => {
      const s = DB.sessions.find((x) => x.id === id);
      if (!s) return '';
      const on = id === state.activeTab;
      return `<div class="chtab ${on ? 'on' : ''}" data-tab="${id}">
        <i class="sess-dot ${s.col}"></i><span>${esc(s.title)}</span>
        <button class="chtab-x" data-tabclose="${id}" title="Close tab">${ic('x')}</button>
      </div>`;
    }).join('')}
    <button class="chtab-new" data-act="new-session" title="New session in ${esc(S.ws)}">${ic('plus')}</button>
    <span class="grow"></span>
  </div>`;
}

/* ---------- session shells ----------
   A chat session is a thread, not a process. Its terminal panel is a real shell kept beside it:
   chat id -> shell id, remembered on this machine. A dead or deleted shell is replaced on demand. */
const SHELL_MAP_KEY = 'xblabs.sessShells';
const shellMap = (() => { try { return JSON.parse(localStorage.getItem(SHELL_MAP_KEY) || '{}') || {}; } catch { return {}; } })();
function saveShellMap() { try { localStorage.setItem(SHELL_MAP_KEY, JSON.stringify(shellMap)); } catch { /* session-only */ } }
const shellAlive = (st) => ['running', 'starting', 'waiting'].includes(st);
const shellInflight = {};
async function sessionShell(chatId, { fresh = false } = {}) {
  const known = ((window.LIVE && LIVE.shells) || []).find((s) => s.id === shellMap[chatId]);
  if (!fresh && known && shellAlive(known.status)) return known.id;
  if (shellInflight[chatId]) return shellInflight[chatId];
  const run = window.__liveRuns && window.__liveRuns.get(chatId);
  const sess = DB.sessions.find((s) => s.id === chatId);
  const cwd = run && /[\\/:]/.test(run.cwd || '') ? run.cwd : undefined;   // a bare project name is not a folder
  shellInflight[chatId] = (async () => {
    const s = await fetch('/api/sessions', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: `${(sess && sess.title) || 'Session'} · shell`, kind: 'shell', agent: 'shell', device: (run && run.device) || 'local', cwd, ws: (sess && sess.ws) || 'xblabs-web' }),
    }).then((r) => r.json());
    if (s.error) throw new Error(s.error);
    shellMap[chatId] = s.id; saveShellMap();
    await liveLoad();
    return s.id;
  })();
  try { return await shellInflight[chatId]; } finally { delete shellInflight[chatId]; }
}
/* A chat whose agent XBLabs can start is that agent: its terminal is the session's own PTY and
   the composer types into it. Any other chat keeps a plain shell beside it. */
function agentChat(chatId) {
  const run = window.__liveRuns && window.__liveRuns.get(chatId);
  const ids = (window.LIVE && LIVE.llm && LIVE.llm.agent_ids) || [];
  return !!run && run.kind === 'chat' && run.mode !== 'json' && run.agent !== 'shell' && ids.includes(run.agent);
}
/* ---------- bubble chat ----------
   A session in JSON mode: each message is one agent turn on the hub (server/chat.mjs); the
   page polls its events and draws them as bubbles. */
const bubbleChat = (id) => ((window.__liveRuns && window.__liveRuns.get(id)) || {}).mode === 'json';
const TERM_SEEN = new Set();   // bubble sessions whose native terminal is mounted (shown or hidden behind Chat)
const TUI_AGENTS = new Set(['hermes', 'omp', 'claude']);   // agents with a native terminal on the same conversation
const showSessionComposer = (id) => !agentChat(id) && !(bubbleChat(id) && state.chatView === 'term');
const CHAT = {};   // session id -> { v, ev: Map(id -> event), busy, open: Set(open tool cards) }
async function chatPull(id, strict = false) {
  const c = CHAT[id] || (CHAT[id] = { v: 0, ev: new Map(), busy: false, open: new Set() });
  try {
    const response = await fetch(`/api/sessions/${id}/chat?after=${c.v}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const r = await response.json();
    for (const e of r.events || []) {
      c.ev.set(e.id, e); c.v = Math.max(c.v, e.v);
      /* Its stored copy arrived (the same text, or else the oldest one: an agent may store it reworded). */
      if (e.kind === 'user' && c.pending?.length) { const i = c.pending.findIndex((x) => x.text === e.data.text); c.pending.splice(i >= 0 ? i : 0, 1); }
    }
    /* Sent, and the hub is no longer working on it (stopped, or the terminal never took it): not pending. */
    if (!r.busy && c.pending?.length) c.pending = c.pending.filter((x) => !x.sent || Date.now() - x.sent < 8000);   // a few seconds' grace: no flicker while its copy arrives
    const ask = r.ask ? JSON.stringify(r.ask) : '';
    const changed = (r.events || []).length > 0 || c.busy !== !!r.busy || !c.loaded || ask !== (c.askKey || '') || (r.note || '') !== (c.note || '');
    c.busy = !!r.busy || !!c.pending?.length; c.note = r.note || ''; c.loaded = true; c.ask = r.ask || null; c.askKey = ask;
    const pk = JSON.stringify([r.pipeline && [r.pipeline.step, r.pipeline.state, r.pipeline.ids], r.team && [r.team.state, r.team.tasks.map((t) => [t.status, t.session])]]);
    if (pk !== (c.pipeKey || '')) { c.pipeline = r.pipeline || null; c.team = r.team || null; c.pipeKey = pk; graphPaint(id); }
    return changed;
  } catch (err) { if (strict) throw err; return false; }
}
function chatPaint(id) {
  sessionStatusPaint(id);
  /* A turn just ended: what it changed on disk shows without reopening the session. */
  const cc = CHAT[id], run = window.__liveRuns && window.__liveRuns.get(id);
  if (cc && cc.wasBusy && !cc.busy && run && run.branch) gitLoad(id, { quiet: true }).then(() => { const el = document.getElementById('mt-changes'); if (el && state.activeTab === id) el.outerHTML = changesCard(run); });
  if (cc) cc.wasBusy = cc.busy;
  const box = document.getElementById('chat-bubbles');
  if (!box || state.activeTab !== id) return;
  const near = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
  box.innerHTML = bubblesHTML(id);
  if (state.chatBottom === id) box.scrollTo({ top: box.scrollHeight, behavior: 'instant' });
  else if (near) box.scrollTop = box.scrollHeight;
  if (CHAT[id] && CHAT[id].loaded && state.chatBottom === id) state.chatBottom = null;
  /* The header's status follows the turn, without a full render that would drop typed text. */
  const usage = document.getElementById('mt-usage');
  if (usage) usage.outerHTML = usageCard(id);
  composerPaint(id);
  const pb = document.getElementById('plan-box');
  if (pb) pb.outerHTML = planBox(id);
  const ss = document.getElementById('sa-strip');
  if (ss) ss.outerHTML = saStrip(id);
  graphPaint(id);
  chatJump();
  recallMark();
}
setInterval(async () => {
  const id = state.activeTab;
  if (state.page !== 'session' || document.hidden || !bubbleChat(id)) return;
  if (await chatPull(id)) chatPaint(id);
  /* The turn ended and messages wait: send the next one. */
  const q = QUEUE[id];
  if (q && q.length && CHAT[id] && !CHAT[id].busy) { CHAT[id].busy = true; bubbleSend(id, q.shift()); queuePaint(id); }
}, 900);
/* A note's to-dos: [done, total]. */
function noteTodos(body) {
  const m = String(body || '').match(/^\s*[-*] \[( |x|X)\]/gm) || [];
  return [m.filter((x) => !x.endsWith('[ ]')).length, m.length];
}
const noteProg = ([d, t]) => (t ? `<span class="note-prog" title="${d} of ${t} to-dos done"><i style="width:${Math.round(d / t * 100)}%"></i><b>${d}/${t}</b></span>` : '');
console.assert(noteTodos('- [x] a\n- [ ] b\n* [X] c\n- d').join() === '2,3', 'noteTodos');
/* Inline markdown of a note line: code, bold, italic, strikethrough, http links. */
/* A path that names a file (has an extension): agents write these as `out/report.pdf`. */
const FILE_PATH = /^(?:[a-zA-Z]:)?[\w.\-~/\\ ]*[\w-]\.[a-zA-Z0-9]{1,6}$/;
function mdInline(s) {
  return esc(s).split(/(`[^`]+`)/).map((p, i) => (i % 2 ? (FILE_PATH.test(p.slice(1, -1)) && /[\\/]/.test(p) ? `<a class="md-path" data-mdhref="${p.slice(1, -1)}"><code>${p.slice(1, -1)}</code></a>` : `<code>${p.slice(1, -1)}</code>`)
    : p.replace(/(?<![\w("=:/>\\.-])((?:[A-Za-z]:[\\/]|\/)[^\s<>"'`|*?]*\.(?:png|jpe?g|gif|webp|bmp))(?![\w.])/gi, '<span class="md-img-ref" data-mdsrc="$1"></span><span class="md-imgpath">$1</span>')
      .replace(/!\[([^\]]*)\]\(([^\s)]+)\)/g, '<span class="md-img-ref" data-mdsrc="$2">$1</span>')
      .replace(/\[([^\]]+)\]\((?!https?:)([^\s)]+\.[a-zA-Z0-9]{1,6})\)/g, '<a class="md-file" data-mdhref="$2">$1</a>')
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/\b__([^_]+)__\b/g, '<b>$1</b>').replace(/(^|[^\w*])[*_]([^*_\s][^*_]*)[*_](?!\w)/g, '$1<i>$2</i>')
      .replace(/~~([^~]+)~~/g, '<s>$1</s>').replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>'))).join('');
}
/* A note's preview, one element per source line so a checkbox still knows its line. */
function noteHTML(body) {
  let fence = false;
  return String(body || '').split('\n').map((l, i) => {
    if (/^\s*```/.test(l)) { fence = !fence; return ''; }
    if (fence) return `<div class="note-line note-code">${esc(l) || '&nbsp;'}</div>`;
    let m = l.match(/^(\s*)[-*] \[( |x|X)\] ?(.*)$/);
    if (m) return `<label class="note-chk" style="margin-left:${m[1].length * 8}px"><input type="checkbox" data-note-chk="${i}" ${m[2] !== ' ' ? 'checked' : ''}><span>${mdInline(m[3])}</span></label>`;
    if ((m = l.match(/^(#{1,3}) +(.*)$/))) return `<div class="note-h note-h${m[1].length}">${mdInline(m[2])}</div>`;
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(l)) return '<hr class="note-hr">';
    if ((m = l.match(/^(\s*)(?:[-*]|(\d+)\.) +(.*)$/))) return `<div class="note-li" style="margin-left:${m[1].length * 8}px"><span class="note-bul">${m[2] ? m[2] + '.' : '•'}</span><span>${mdInline(m[3])}</span></div>`;
    if ((m = l.match(/^> ?(.*)$/))) return `<div class="note-quote">${mdInline(m[1]) || '&nbsp;'}</div>`;
    if (/^\s*\|.*\|\s*$/.test(l)) return /^[\s|:-]+$/.test(l) ? '' : `<div class="note-tr">${l.trim().slice(1, -1).split('|').map((c) => `<span>${mdInline(c.trim())}</span>`).join('')}</div>`;
    return `<div class="note-line">${mdInline(l) || '&nbsp;'}</div>`;
  }).join('');
}
console.assert(mdInline('a **b** *c* ~~d~~ `*e*` 2*3') === 'a <b>b</b> <i>c</i> <s>d</s> <code>*e*</code> 2*3' && noteHTML('# T\n- [x] **a**').includes('data-note-chk="1" checked'), 'noteHTML');
/* Agent Markdown. Raw HTML stays escaped; reuse the safe inline renderer from Notes. */
function mdLite(t) {
  const lines = String(t || '').replace(/\r\n?/g, '\n').split('\n'), out = [];
  const cells = (s) => s.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  const tableRule = (s) => s.includes('|') && cells(s).every((c) => /^:?-{3,}:?$/.test(c));
  const block = (s, next = '') => /^\s*(?:#{1,6}\s|`{3,}|~{3,}|>|[-+*]\s|\d+[.)]\s|(?:-{3,}|\*{3,}|_{3,})\s*$)/.test(s) || tableRule(next);
  for (let i = 0; i < lines.length;) {
    const line = lines[i]; let m;
    if (!line.trim()) { i++; continue; }
    if ((m = line.match(/^\s*(`{3,}|~{3,})\s*([^\s]*)?.*$/))) {
      const fence = m[1], language = m[2] || '', code = [];
      i++;
      while (i < lines.length && !new RegExp(`^\\s*${fence[0]}{${fence.length},}\\s*$`).test(lines[i])) code.push(lines[i++]);
      if (i < lines.length) i++;
      out.push(`<pre class="md-code"><code${/^[\w+-]+$/.test(language) ? ` class="language-${language}"` : ''}>${esc(code.join('\n'))}</code></pre>`);
    } else if ((m = line.match(/^\s*(#{1,6})\s+(.+?)\s*$/))) {
      out.push(`<h${m[1].length}>${mdInline(m[2].replace(/\s+#+$/, ''))}</h${m[1].length}>`); i++;
    } else if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      out.push('<hr>'); i++;
    } else if (/^\s*>/.test(line)) {
      const quote = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) quote.push(lines[i++].replace(/^\s*> ?/, ''));
      out.push(`<blockquote>${mdLite(quote.join('\n'))}</blockquote>`);
    } else if ((m = line.match(/^(\s*)([-+*]|\d+[.)])\s+(.*)$/))) {
      const ordered = /^\d/.test(m[2]), tag = ordered ? 'ol' : 'ul', indent = m[1].length, items = [];
      const first = ordered ? parseInt(m[2], 10) : 1;
      while (i < lines.length) {
        const item = lines[i].match(/^(\s*)([-+*]|\d+[.)])\s+(.*)$/);
        if (!item || item[1].length !== indent || /^\d/.test(item[2]) !== ordered) break;
        const body = [item[3]]; i++;
        while (i < lines.length && lines[i].trim() && lines[i].match(/^\s*/)[0].length > indent) body.push(lines[i++].slice(indent + 2));
        const task = body[0].match(/^\[([ xX])\]\s+(.*)$/);
        if (task) body[0] = task[2];
        items.push(`<li${task ? ' class="md-task"' : ''}>${task ? `<input type="checkbox" disabled${task[1] !== ' ' ? ' checked' : ''} aria-label="Task status">` : ''}${mdLite(body.join('\n'))}</li>`);
      }
      out.push(`<${tag}${ordered && first !== 1 ? ` start="${first}"` : ''}>${items.join('')}</${tag}>`);
    } else if (i + 1 < lines.length && line.includes('|') && tableRule(lines[i + 1])) {
      const head = cells(line), rows = []; i += 2;
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) rows.push(cells(lines[i++]));
      out.push(`<div class="md-table"><table><thead><tr>${head.map((c) => `<th>${mdInline(c)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${head.map((_, n) => `<td>${mdInline(r[n] || '')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
    } else {
      const paragraph = [line]; i++;
      while (i < lines.length && lines[i].trim() && !block(lines[i], lines[i + 1] || '')) paragraph.push(lines[i++]);
      out.push(`<p>${paragraph.map((s) => mdInline(s)).join('<br>')}</p>`);
    }
  }
  return out.join('');
}
/* A tool's glyph from its name; first match wins, so the specific kinds come before the broad ones. */
const TOOL_GLYPHS = [
  [/execute_code|python|eval|repl/i, 'code'], [/bash|shell|exec|command|terminal|process|run/i, 'terminal'],
  [/web|fetch|http|url|browse|navigate|scrape|crawl/i, 'globe'], [/search|grep|find|glob/i, 'search'],
  [/list|ls\b|dir|tree|folder/i, 'folder-opened'], [/write|edit|patch|create|replace|insert|apply/i, 'edit'],
  [/delete|remove|trash/i, 'trash'], [/read|view|open|cat|file/i, 'file-code'],
  [/todo|task|plan|checklist/i, 'checklist'], [/memory|note|remember/i, 'note'], [/skill|doc|manual/i, 'book'],
  [/delegate|agent|spawn/i, 'agent'], [/image|vision|screenshot|photo|media/i, 'file-media'],
  [/git|commit|diff/i, 'git-commit'], [/sql|db|database|query/i, 'database'], [/mail|email|message|send/i, 'mail'],
  [/clarify|ask|question/i, 'question'], [/history|session|recall/i, 'history'], [/install|package|npm|pip/i, 'package'],
];
const toolGlyph = (n) => (TOOL_GLYPHS.find(([re]) => re.test(n)) || [0, 'tools'])[1];
console.assert(toolGlyph('search_files') === 'search' && toolGlyph('execute_code') === 'code' && toolGlyph('read_file') === 'file-code' && toolGlyph('web_search') === 'globe' && toolGlyph('zzz') === 'tools', 'toolGlyph');
/* Images and files an agent names in its answer: a web URL as is, a path in the session folder
   through the hub's file route (absolute paths only when inside that folder). Elsewhere: text. */
function mdMedia(html, sid) {
  const run = (window.__liveRuns && window.__liveRuns.get(sid)) || DB.sessions.find((x) => x.id === sid) || {};
  const local = (run.device || 'local') === 'local';
  const cwd = String(run.cwd || '').replace(/\\/g, '/').replace(/\/+$/, '');
  const unesc = (s) => s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const url = (raw) => {
    const p = unesc(raw);
    if (/^https?:\/\//i.test(p) || /^data:image\//i.test(p)) return p;
    if (!local) return '';
    let r = p.replace(/\\/g, '/').replace(/^\.\//, '');
    if (/^([a-z]:)?\//i.test(r)) {
      if (!cwd || !r.toLowerCase().startsWith(`${cwd.toLowerCase()}/`))   // elsewhere: media the agent named, checked by the hub
        return /\.(png|jpe?g|gif|webp|bmp|pdf|mp4|webm|mp3|wav)$/i.test(r) ? `/api/sessions/${sid}/media?path=${encodeURIComponent(p)}` : '';
      r = r.slice(cwd.length + 1);
    }
    return `/api/sessions/${sid}/file?path=${encodeURIComponent(r)}`;
  };
  const name = (s) => unesc(s).split(/[\\/]/).pop();
  return html
    .replace(/<span class="md-img-ref" data-mdsrc="([^"]*)">([^<]*)<\/span>/g, (m, s, alt) => {
      const u = url(s);
      return u ? `<img class="md-img" src="${esc(u)}" alt="${alt || esc(name(s))}" title="${alt || esc(name(s))}" loading="lazy">` : `<code>${alt || s}</code>`;
    })
    .replace(/<a class="(md-file|md-path)" data-mdhref="([^"]*)">/g, (m, cls, s) => {
      const u = url(s);
      return u ? `<a class="${cls}" href="${esc(u)}" target="_blank" rel="noopener" title="Open ${esc(name(s))}">${cls === 'md-file' ? ic(/\.(png|jpe?g|gif|webp|svg)$/i.test(s) ? 'image' : 'file') : ''}` : `<a class="${cls}">`;
    });
}
/* A broken image shows its name; a click on one opens it large. */
document.addEventListener('error', (e) => { const t = e.target; if (t.matches && t.matches('img.md-img')) t.replaceWith(Object.assign(document.createElement('code'), { textContent: t.alt })); }, true);
document.addEventListener('click', (e) => {
  const img = e.target.closest && e.target.closest('img.md-img');
  if (img) { const z = document.createElement('div'); z.className = 'img-zoom'; z.innerHTML = `<img src="${esc(img.src)}" alt="${esc(img.alt)}">`; z.onclick = () => z.remove(); document.body.append(z); return; }
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') document.querySelector('.img-zoom')?.remove(); });
/* A tool call folded to one line, like Thinking: glyph, name, its argument, a status dot.
   Open shows the full argument and the output. */
function toolRow(e, open, stale) {
  const d = e.data, inp = d.input || {}, n = String(d.name || 'tool');
  const args = String(typeof inp === 'string' ? inp : inp.command || inp.path || inp.file_path || inp.pattern || inp.query || inp.url || JSON.stringify(inp) || '');
  const st = d.output == null ? (stale ? 'gone' : 'run') : d.error || d.needsApproval ? 'err' : 'ok';
  const said = { run: 'running…', gone: 'no result', err: d.needsApproval ? 'needs approval' : 'error', ok: 'done' }[st];
  const full = typeof inp === 'string' ? inp : JSON.stringify(inp, null, 2);
  return `<details class="worked chat-think chat-tool ${st}" data-evid="${e.id}" ${open ? 'open' : ''}><summary>${ci(toolGlyph(n), 'trace-glyph')}<b>${esc(n)}</b><span class="peek">${esc(args.slice(0, 200))}</span><i class="tool-dot ${st}" title="${said}"></i>${ic('caret-right')}</summary>
    <div class="worked-body">${full && full !== '{}' ? `<pre class="tool-full in">${esc(full.slice(0, 2000))}</pre>` : ''}<pre class="tool-full">${d.output == null ? esc(said) : esc(String(d.output).slice(0, 6000)) || '(empty)'}</pre></div></details>`;
}
/* An edit tool's input as a diff: old/new strings, a whole new file, or a patch body.
   null when the call carries none of those (then it shows as a plain tool line). */
function editDiff(d) {
  const inp = d.input && typeof d.input === 'object' ? d.input : {};
  const file = inp.file_path || inp.path || inp.filename || inp.file || '';
  const patch = typeof d.input === 'string' ? d.input : inp.patch || inp.diff || '';
  const lines = [];
  if (/^(\*\*\*|@@|---|\+\+\+|diff )/m.test(patch)) {
    let n = 0;
    for (const l of String(patch).split('\n')) {
      if (/^(\*\*\*|---|\+\+\+|diff |index )/.test(l)) continue;
      const m = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(l);
      if (m) { n = +m[1]; continue; }
      if (l.startsWith('+')) lines.push(['add', n++, l.slice(1)]);
      else if (l.startsWith('-')) lines.push(['del', '', l.slice(1)]);
      else if (l.startsWith(' ')) lines.push(['ctx', n++, l.slice(1)]);
    }
  } else {
    const oldS = inp.old_string ?? inp.old_str ?? inp.oldText ?? null;
    const newS = inp.new_string ?? inp.new_str ?? inp.newText ?? inp.content ?? inp.text ?? null;
    if (newS == null && oldS == null) return null;
    if (oldS != null) String(oldS).split('\n').forEach((t, i) => lines.push(['del', i + 1, t]));
    if (newS != null) String(newS).split('\n').forEach((t, i) => lines.push(['add', i + 1, t]));
  }
  if (!lines.length) return null;
  const files = [...String(patch).matchAll(/^(?:\*\*\* (?:Update|Add|Delete) File: |\+\+\+ (?:b\/)?)(.+)$/gm)].map((m) => m[1]);
  return { file: file || files.join(', ') || 'file', add: lines.filter((l) => l[0] === 'add').length, del: lines.filter((l) => l[0] === 'del').length, lines: lines.slice(0, 60) };
}
console.assert(editDiff({ input: { file_path: 'a.js', old_string: 'x', new_string: 'y\nz' } }).add === 2 && editDiff({ input: '*** Update File: b.js\n@@ -1 +1 @@\n-a\n+b' }).file === 'b.js' && editDiff({ input: { command: 'ls' } }) === null, 'editDiff');
const firstLines = (t, n) => String(t || '').split('\n').filter((l) => l.trim()).slice(0, n);
/* A message sent with files: their paths (withFiles) show as images / file chips above the bubble. */
/* Time above a bubble: 14:05 today, 16 Nov 14:05 on another day. Older messages have no time. */
function msgTime(at) {
  if (!at) return '';
  const d = new Date(at), hm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  const day = d.toDateString() === new Date().toDateString() ? '' : `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })} `;
  return `<div class="msg-time" title="${esc(d.toLocaleString())}">${day}${hm}</div>`;
}
function userBubble(sid, evId, text, at) {
  const m = String(text || '').match(/\n\nAttached files:\n((?:- .+(?:\n|$))+)$/);
  const body = m ? text.slice(0, m.index) : text;
  const files = m ? m[1].trim().split('\n').map((l) => l.slice(2).split(/[\\/]/).pop()) : [];
  const src = (n) => `/api/sessions/${sid}/file?path=${encodeURIComponent('.xblabs/attach/' + n)}`;
  const label = (n) => n.replace(/^[a-z0-9]+-/, '');
  const att = files.length ? `<div class="msg-atts">${files.map((n) => /\.(png|jpe?g|gif|webp|bmp)$/i.test(n)
    ? `<span class="atch img msg-att"><img src="${src(n)}" alt="${esc(label(n))}" loading="lazy"></span>`
    : `<span class="atch">${ic('file-code')}<span>${esc(label(n))}</span></span>`).join('')}</div>` : '';
  return `<div class="msg-user-block" id="ev-${evId}">${att}${body ? `<div class="msg-bubble">${esc(body)}</div>` : ''}${msgTime(at)}</div>`;
}
/* What the agent waits on me for sits on the message box, never buried in the scroll: its own
   approval card (JSON turn), or the menu its open terminal shows (TUI). */
function approveHTML(id) {
  const c = CHAT[id];
  let html = '';
  if (c && c.loaded) {
    const run = (window.__liveRuns && window.__liveRuns.get(id)) || {};
    const card = [...c.ev.values()].filter((e) => e.kind === 'approval' && e.data.state === 'pending').sort((a, b) => a.id - b.id).pop();
    if (card) {
      const what = card.data.tools.map((t) => `<code>${esc(typeof t.input === 'string' ? t.input : (t.input && (t.input.command || t.input.path)) || t.name)}</code>`).join(' ');
      html = `<div class="chat-approve c-approve">${ic('shield-warning')}<div><b>${esc(AGENT_NAMES[run.agent] || run.agent || 'The agent')} needs your OK</b><span>Its own rules stopped: ${what}</span></div>
        <button class="btn primary sm" data-act="chat-approve" data-id="${esc(id)}" data-dec="y">Approve</button><button class="btn secondary sm" data-act="chat-approve" data-id="${esc(id)}" data-dec="n">Deny</button></div>`;
    } else if (c.ask) {
      const a = c.ask;
      html = `<div class="chat-approve tui-ask c-approve">${ic('shield-warning')}<div><b>${esc(a.title)}</b>${a.detail.length ? `<code class="ask-detail">${esc(a.detail.join('\n'))}</code>` : ''}
        <div class="ask-opts">${a.options.map((o, i) => `<button class="btn ${i === a.sel ? 'primary' : 'secondary'} sm" data-act="tui-pick" data-id="${esc(id)}" data-n="${i}">${esc(o)}</button>`).join('')}</div></div></div>`;
    }
  }
  return `<div id="c-approve">${html}</div>`;
}
/* The agent ended its turn asking me to choose: its choices, in the composer; a click answers. */
function pickHTML(id) {
  const c = CHAT[id];
  const opts = c && c.loaded && !c.busy && !c.pending?.length && window.lastAsk ? lastAsk([...c.ev.values()].sort((a, b) => a.id - b.id)) : null;
  return `<div id="c-pick">${opts ? `<div class="chat-pick" role="group" aria-label="Pick an answer">${opts.map((o, i) => `<button class="pick-opt" data-act="chat-pick" data-id="${esc(id)}" data-v="${esc(o)}"><i>${i + 1}</i><span>${mdInline(o)}</span></button>`).join('')}</div>` : ''}</div>`;
}
/* Pinned answers, per session, in this browser (a reading aid, not shared state). */
function pinsOf(id) { try { return JSON.parse(localStorage.getItem(`xb-pins-${id}`) || '[]'); } catch { return []; } }
function pinToggle(id, ev) {
  const p = pinsOf(id), i = p.indexOf(ev);
  i >= 0 ? p.splice(i, 1) : p.push(ev);
  try { localStorage.setItem(`xb-pins-${id}`, JSON.stringify(p)); } catch {}
}
/* Under a turn's answer: copy, branch, pin, when, and what it cost. Shown while the cursor is on the answer or the row. */
function msgFoot(id, done, ev, pins, latest) {
  const texts = ev.filter((x) => x.turn === done.turn && x.kind === 'text'), last = texts[texts.length - 1];
  const t = done.data.tokens || {}, inp = t.input ?? t.input_tokens, outp = t.output ?? t.output_tokens, cache = t.cache_read;
  const bit = (icon, v, title) => `<span title="${title}">${ic(icon)}${v}</span>`;
  const bits = [done.data.ms ? bit('timer', `${(done.data.ms / 1000).toFixed(1)}s`, 'Turn time') : '',
    inp != null ? bit('arrow-down', `${uShort(inp)} in`, 'Input tokens') : '',
    cache ? bit('lightning', `${uShort(cache)} cached`, 'Read from prompt cache') : '',
    inp != null ? bit('arrow-up', `${uShort(outp || 0)} out`, 'Output tokens') : ''].filter(Boolean).join('');
  const at = (last && last.at) || done.at;
  const btn = (act, icon, label, on) => `<button class="mf-btn${on ? ' on' : ''}" data-act="${act}" data-id="${esc(id)}" data-turn="${done.turn}"${last ? ` data-ev="${last.id}"` : ''} title="${label}" aria-label="${label}">${ic(icon, on ? 'fill' : 'regular')}</button>`;
  return `<div class="msg-foot${latest ? ' latest' : ''}">${last ? btn('msg-copy', 'copy', 'Copy') + btn('msg-branch', 'arrows-split', 'Branch in a new session') + btn('msg-pin', 'push-pin', pins.includes(last.id) ? 'Unpin' : 'Pin', pins.includes(last.id)) : ''}${msgTime(at).replace('<div class="msg-time"', '<span class="mf-time"').replace('</div>', '</span>')}${bits ? `<span class="mf-tok">${bits}</span>` : ''}</div>`;
}
const turnText = (id, turn) => [...CHAT[id].ev.values()].filter((e) => e.turn === turn && e.kind === 'text').sort((a, b) => a.id - b.id).map((e) => e.data.text).join('\n\n');
/* Branch: a new session of the same agent in the same project, its first message carrying the
   conversation up to that answer (the agent starts a fresh thread; this is how it knows). */
async function branchFrom(id, turn) {
  const r = window.__liveRuns.get(id) || {}, c = CHAT[id];
  const lines = [...c.ev.values()].filter((e) => e.turn <= turn && (e.kind === 'user' || e.kind === 'text')).sort((a, b) => a.id - b.id)
    .map((e) => `${e.kind === 'user' ? 'Me' : 'You'}: ${e.data.text}`);
  let ctx = lines.join('\n\n');
  if (ctx.length > 12000) ctx = `…${ctx.slice(-12000)}`;
  const res = await fetch('/api/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'chat', agent: r.agent, ws: r.ws, device: r.device, cwd: r.origin || r.cwd, title: `${r.title || 'Session'} · branch`, parent: id, approval: r.approval || 'ask' }) }).then((x) => x.json()).catch((err) => ({ error: err.message }));
  if (res.error) { toast(res.error, 'warning'); return; }
  await liveLoad();
  const bucket = tabsOf(r.ws);
  state.openTabs = { ...state.openTabs, [r.ws]: [...bucket.filter((x) => x !== res.id), res.id] };
  state.activeTab = state.selectedSession = res.id; state.sessionTitle = res.title; state.openWs = r.ws; state.page = 'session'; render();
  const ta = document.getElementById('composer');
  if (ta) { ta.value = `Continuing from an earlier conversation:\n\n${ctx}\n\n---\n\n`; ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); ta.dispatchEvent(new Event('input')); }
}
function bubblesHTML(id) {
  const c = CHAT[id];
  if (!c || !c.loaded) { chatPull(id).then(() => chatPaint(id)); return `<div class="chat-loading" role="status">${[...'Loading the conversation'].map((ch, i) => `<span style="--i:${i}">${ch === ' ' ? '&nbsp;' : ch}</span>`).join('')}<i class="run-dots"><b></b><b></b><b></b></i></div>${(c?.pending || []).map((x) => `<div class="pending-send">${userBubble(id, 'p', x.text)}</div>`).join('')}`; }
  const run = (window.__liveRuns && window.__liveRuns.get(id)) || {};
  const ev = [...c.ev.values()].sort((a, b) => a.id - b.id)
    .filter((e) => !(e.kind === 'note' && /^From the .+ terminal$/.test(e.data.text || '')));   // old sync markers, noise
  /* A tool with no result that a later message of mine followed never reported one (it timed
     out or was stopped): it is over, not running. */
  const stale = new Set(), open = [];
  for (const e of ev) { if (e.kind === 'tool' && e.data.output == null) open.push(e.id); else if (e.kind === 'user') open.splice(0).forEach((x) => stale.add(x)); }
  if (!ev.length && !c.busy && !c.pending?.length) return `<div class="chat-empty">${agentLogo(run.agent || 'shell')}<b>${esc(AGENT_NAMES[run.agent] || run.agent || 'The agent')} is ready</b><span>Send a message to start. Type / for its commands.</span></div>`;
  const pins = pinsOf(id), lastTurn = Math.max(0, ...ev.map((e) => e.turn));
  /* Answers that arrive while I watch reveal in; the history already there does not. The
     negative delay keeps a re-paint mid-reveal from restarting it. */
  const now = Date.now();
  if (!c.born) c.born = new Map(ev.map((e) => [e.id, 0]));
  /* Subagent calls of one burst share a panel, shown where the first was made. */
  const subGroup = new Map();
  let g = null;
  for (const e of ev) {
    if (isSubCall(e)) { if (!g || g.turn !== e.turn) subGroup.set(e.id, g = { turn: e.turn, calls: [] }); g.calls.push(e); }
    else if (e.kind === 'text' || e.kind === 'user') g = null;
  }
  const out = ev.map((e) => {
    const d = e.data;
    if (e.kind === 'user' && d.from === 'auto') return '';   // an automatic approve / deny: the approval line above already says it
    if (e.kind === 'user' && d.from === 'team') return `<details class="worked chat-think hub-msg" data-evid="${e.id}" id="ev-${e.id}" ${c.open.has(e.id) ? 'open' : ''}><summary>${ic('users-three', 'fill')}<b>Team results</b><span class="peek">every teammate answered · sent to the lead to review</span>${ic('caret-right')}</summary><div class="worked-body">${mdLite(d.text)}</div></details>`;
    if (e.kind === 'user') return userBubble(id, e.id, d.text, e.at);
    if (e.kind === 'text') {
      if (!c.born.has(e.id)) c.born.set(e.id, now);
      const age = c.born.get(e.id) && now - c.born.get(e.id);
      return `<div class="msg-agent${age && age < 1400 ? ' msg-in' : ''}${pins.includes(e.id) ? ' pinned' : ''}" id="ev-${e.id}"${age && age < 1400 ? ` style="--age:-${age}ms"` : ''}><div class="msg-content msg-text">${mdMedia(mdLite(d.text), id)}</div></div>`;
    }
    if (e.kind === 'thinking') return `<details class="worked chat-think" data-evid="${e.id}" ${c.open.has(e.id) ? 'open' : ''}><summary>${ic('sparkle', 'fill')}<b>Thinking</b><span class="peek">${esc(firstLines(d.text, 1)[0] || '')}</span>${ic('caret-right')}</summary><div class="worked-body">${mdLite(d.text)}</div></details>`;
    if (e.kind === 'tool' && e.data.parent) return '';   // a subagent's step: counted on its card
    if (isSubCall(e)) {
      const gr = subGroup.get(e.id);
      return gr ? subagentsBlock(gr.calls.flatMap((x) => subsOf(x, ev.filter((k) => k.data.parent === x.id), stale.has(x.id) || !c.busy || x.turn !== lastTurn, ev)), c) : '';
    }
    if (e.kind === 'tool') {
      const ed = /edit|write|patch|create|replace|insert/i.test(d.name || '') && editDiff(d);
      if (ed && !d.error) return `<div class="msg-agent"><div class="msg-content">${codeCard(ed, e.id, c)}</div></div>`;
      const plan = planItems(d);
      if (plan) return `<div class="chat-note">${ic('list-checks')}<span>Updated tasks · ${plan.filter((x) => x.st === 'done').length}/${plan.length}</span></div>`;
      return toolRow(e, c.open.has(e.id), stale.has(e.id));
    }
    if (e.kind === 'status') {
      const bad = d.lines.some((l) => /gave up|failed|HTTP [45]\d\d|full|error/i.test(l));
      return `<details class="worked chat-status ${bad ? 'bad' : ''}" data-evid="${e.id}" ${c.open.has(e.id) ? 'open' : ''}><summary>${ic(bad ? 'warning-circle' : 'hourglass-medium')}<b>${bad ? 'Provider error' : 'Retrying'}</b><span class="peek">${esc(d.lines[d.lines.length - 1] || '')}</span>${ic('caret-right')}</summary><div class="worked-body"><ul class="status-lines">${d.lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul></div></details>`;
    }
    if (e.kind === 'note' && d.error) return failCard(d.text || 'Step failed', d.output, e.id, c);
    if (e.kind === 'note') return `<div class="chat-note">${ic('info')}<span>${esc(d.text)}</span></div>${d.output ? `<pre class="md-code">${esc(d.output)}</pre>` : ''}`;
    if (e.kind === 'approval') {
      const what = d.tools.map((t) => `<code>${esc(typeof t.input === 'string' ? t.input : (t.input && (t.input.command || t.input.path)) || t.name)}</code>`).join(' ');
      return d.state === 'pending'
        ? `<div class="chat-note ask-note">${ic('shield-warning')}<span>Waiting for your OK on ${what} · answer it above the message box</span></div>`
        : `<div class="chat-note">${ic(d.state === 'approved' ? 'check' : 'x')} ${d.state === 'approved' ? 'Approved' : d.state === 'denied' ? 'Denied' : 'Answered with a new message'}${d.auto ? ' automatically' : d.timeout ? ' (no answer in time)' : ''}: ${what}</div>`;
    }
    if (e.kind === 'error') return failCard('Run failed', d.text || 'the turn failed', e.id, c);
    if (e.kind === 'done') {
      return msgFoot(id, e, ev, pins, e.turn === lastTurn) + (d.error ? failCard('Turn ended with an error', d.error, `d${e.id}`, c) : '');
    }
    return '';
  }).join('');
  const pend = (c.pending || []).map((x, i) => `<div class="pending-send" title="Sending · waits for the terminal to open">${userBubble(id, `p${i}`, x.text, x.at)}</div>`).join('');
  const pinned = pins.map((p) => c.ev.get(p)).filter(Boolean);
  const pinBar = pinned.length ? `<div class="pin-bar"><span class="pin-lbl">${ic('push-pin', 'fill')}Pinned</span><div class="pin-list">${pinned.map((p) => `<span class="pin-chip"><button data-act="recall" data-ev="${p.id}" title="${esc(String(p.data.text).slice(0, 300))}">${esc(String(p.data.text).replace(/[#*`>_]/g, '').trim().split('\n')[0].slice(0, 60))}</button><button class="pin-x" data-act="msg-pin" data-id="${esc(id)}" data-ev="${p.id}" title="Unpin" aria-label="Unpin">${ic('x')}</button></span>`).join('')}</div></div>` : '';
  return pinBar + recallHTML(ev) + out + pend + (c.busy ? `<div class="run-line">${lattice()}<span>${c.note ? `${ic('hourglass-medium')}${esc(c.note)}` : `${esc(AGENT_NAMES[run.agent] || run.agent)} is working`}</span><i class="run-dots"><b></b><b></b><b></b></i></div>` : '');
}
/* Recall rail: one tick per message I sent, pinned to the chat's right edge; hover shows it,
   a click scrolls back to it. Newest 40 only, so the rail never outgrows the view. */
function recallHTML(ev) {
  const mine = ev.filter((e) => e.kind === 'user' && e.data.text).slice(-40);
  if (mine.length < 2) return '';
  const all = ev.filter((e) => e.kind === 'user' && e.data.text).length;
  return `<nav class="recall" aria-label="My messages"><div class="recall-in">${mine.map((e, i) => {
    const t = String(e.data.text).trim(), first = t.split('\n')[0];
    return `<button class="rc-tick" data-act="recall" data-ev="${e.id}" aria-label="${esc(first.slice(0, 80))}"><span class="rc-tip"><i>#${all - mine.length + i + 1} of ${all}</i><b>${esc(first.slice(0, 60))}</b>${t.length > first.length || first.length > 60 ? `<em>${esc(t.slice(Math.min(first.length, 60)).trim().slice(0, 200))}</em>` : ''}</span></button>`;
  }).join('')}</div></nav>`;
}
/* The tick of the message I am reading now: the last one of mine above a third of the view. */
function recallMark() {
  const box = document.getElementById('chat-bubbles');
  const ticks = box ? box.querySelectorAll('.rc-tick') : [];
  if (!ticks.length) return;
  const line = zRect(box).top + box.clientHeight * 0.35;
  let cur = ticks[0];
  for (const t of ticks) { const m = document.getElementById(`ev-${t.dataset.ev}`); if (m && zRect(m).top <= line) cur = t; }
  if (box.scrollHeight - box.scrollTop - box.clientHeight < 4) cur = ticks[ticks.length - 1];   // at the bottom: the newest
  ticks.forEach((t) => t.classList.toggle('on', t === cur));
}
document.addEventListener('scroll', (e) => { if (e.target.id === 'chat-bubbles') requestAnimationFrame(recallMark); }, true);
/* A failed step or run: one red line, the first line of the error; a click shows the rest. */
function failCard(title, text, key, c) {
  const lines = String(text || '').split('\n').filter((l) => l.trim());
  const open = c.open.has(key);
  return `<div class="fail-line ${open ? 'open' : ''}" data-evid="${key}" title="${esc(lines.join('\n'))}">${ic('x-circle', 'fill')}<span><b>${esc(title)}</b>${lines[0] ? ` · ${esc(lines[0])}` : ''}${lines.length > 1 && !open ? ` <em>+${lines.length - 1} lines</em>` : ''}</span></div>
    ${open && lines.length > 1 ? `<pre class="fail-more">${esc(lines.slice(1).join('\n'))}</pre>` : ''}`;
}

/* Code change card: file name, +/- counts, the changed lines highlighted, a colored edge per line. */
const HL_KW = /^(?:const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|new|class|extends|import|export|from|default|async|await|try|catch|finally|throw|typeof|instanceof|in|of|this|null|undefined|true|false|def|self|None|True|False|elif|pass|lambda|with|as|fn|pub|struct|impl|use|mut|type|interface)$/;
function hl(text) {
  const re = /(\/\/.*$|#(?!\w*[({]).*$|\/\*.*?\*\/)|("(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?|`(?:[^`\\]|\\.)*`?)|(<\/?[A-Za-z][\w.]*)|\b(\d[\d_.xXa-fA-F]*)\b|([A-Za-z_$][\w$]*)(?=\s*\()|([A-Za-z_$][\w$]*)|([=!<>]=+|=>|&&|\|\||[{}()[\];,.?:+\-*/%<>=!&|^~])/gm;
  let out = '', at = 0, m;
  while ((m = re.exec(text))) {
    out += esc(text.slice(at, m.index));
    const [tok, com, str, tag, num, call, word, op] = m;
    out += com ? `<i class="h-c">${esc(tok)}</i>` : str ? `<i class="h-s">${esc(tok)}</i>` : tag ? `<i class="h-t">${esc(tok)}</i>`
      : num ? `<i class="h-n">${esc(tok)}</i>` : call ? (HL_KW.test(tok) ? `<i class="h-k">${esc(tok)}</i>` : `<i class="h-f">${esc(tok)}</i>`)
      : word ? (HL_KW.test(tok) ? `<i class="h-k">${esc(tok)}</i>` : esc(tok)) : op ? `<i class="h-o">${esc(tok)}</i>` : esc(tok);
    at = m.index + tok.length;
    if (!tok.length) re.lastIndex++;
  }
  return out + esc(text.slice(at));
}
console.assert(hl('const a = "x"; // c').includes('h-k') && hl('<b>').includes('h-t') && !hl('a<b').includes('<b'), 'hl');
function codeCard(ed, key, c) {
  const open = !c.open.has(key);   // open by default; the set holds the ones I folded
  const name = String(ed.file).split(/[\\/]/).pop();
  return `<div class="code-card ${open ? 'open' : ''}">
    <div class="code-head" data-evid="${key}" title="${esc(ed.file)}">${ic('code')}<b>${esc(name)}</b><span class="add">+${ed.add}</span><span class="del">-${ed.del}</span>${ic('caret-down')}</div>
    ${open ? `<div class="code-body">${ed.lines.map(([k, , t]) => `<div class="cl ${k}">${hl(t) || ' '}</div>`).join('')}</div>` : ''}
  </div>`;
}

/* The agent's plan: its latest todo / plan tool call, as checklist items. null when the call is not one. */
function planItems(d) {
  if (!/todo|plan|task/i.test(d.name || '') || /^(task|agent|delegate_task|subagent|spawn_agent)$/i.test(d.name)) return null;   // a subagent call's tasks are not a plan
  const inp = d.input && typeof d.input === 'object' ? d.input : {};
  const list = inp.todos || inp.plan || inp.items || inp.tasks;
  if (!Array.isArray(list) || !list.length) return null;
  return list.map((x) => {
    const st = String((x && (x.status || x.state)) || (x && x.done ? 'completed' : '')).toLowerCase();
    return { text: typeof x === 'string' ? x : x.content || x.step || x.title || x.task || x.text || '', st: /complete|done/.test(st) ? 'done' : /progress|active|running/.test(st) ? 'run' : 'todo' };
  });
}
console.assert(planItems({ name: 'TodoWrite', input: { todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress' }] } })[1].st === 'run' && planItems({ name: 'bash', input: {} }) === null && planItems({ name: 'delegate_task', input: { tasks: [{ goal: 'x' }] } }) === null, 'planItems');
function planBox(id) {
  const c = CHAT[id];
  const ev = c ? [...c.ev.values()].filter((e) => e.kind === 'tool').sort((a, b) => b.id - a.id) : [];
  let items = null;
  for (const e of ev) if ((items = planItems(e.data))) break;
  if (!items) return '<div id="plan-box" hidden></div>';
  const done = items.filter((x) => x.st === 'done').length;
  const open = state.planOpen !== false;
  return `<div id="plan-box" class="plan-box ${open ? 'open' : ''}">
    <button class="plan-head" data-act="plan-toggle">${ic('caret-down')}${ic('list-checks')}<b>${done === items.length ? 'Previous tasks' : 'Tasks'} ${done}/${items.length}</b></button>
    ${open ? `<div class="plan-list">${items.map((x) => `<div class="plan-it ${x.st}"><i>${x.st === 'done' ? ic('check', 'bold') : ''}</i><span>${esc(x.text)}</span></div>`).join('')}</div>` : ''}
  </div>`;
}
document.addEventListener('click', (e) => {
  const card = e.target.closest('[data-evid]');
  const c = card && CHAT[state.activeTab];
  if (!c) return;
  const n = /^\d+$/.test(card.dataset.evid) ? +card.dataset.evid : card.dataset.evid;
  c.open.has(n) ? c.open.delete(n) : c.open.add(n);
  if (card.matches('.fail-line, .code-head')) setTimeout(() => chatPaint(state.activeTab));   // the folded view does not hold the rest
}, true);
async function mountSessionTerm(fresh = false) {
  const el = document.getElementById('sess-term');
  const chatId = state.activeTab;
  if (!el || !chatId) return;
  /* No shell is started just by looking: only when I ask for one. */
  const known = ((window.LIVE && LIVE.shells) || []).find((s) => s.id === shellMap[chatId]);
  if (!fresh && !(known && shellAlive(known.status))) {
    el.innerHTML = `<div class="term-empty"><span>No shell for this session.</span> <button class="btn secondary xs" data-act="sess-term-new">${ic('terminal-window')}Open a shell here</button></div>`;
    return;
  }
  try {
    const id = await sessionShell(chatId, { fresh });
    const now = document.getElementById('sess-term');
    if (!now || state.activeTab !== chatId || state.page !== 'session') return;   // user moved on
    now.innerHTML = '';
    await mountTerminal(id, now, { keep: !!document.getElementById('chat-term') });
  } catch (err) {
    const now = document.getElementById('sess-term');
    if (now) now.innerHTML = `<div class="term-empty"><span>Shell failed to start · ${esc(err.message)}</span></div>`;
    throw err;
  }
}

/* ---------- chat tools: find in chat, queue, stop, model+effort picker, slash commands ---------- */
/* Slash commands each agent's own CLI knows. Sent as the message text; the agent decides what
   it does with one in its JSON mode. shortcut: hand-kept list, read it from each CLI once they expose one. */
const SLASH = {
  claude: [['/clear', 'Start over with an empty context'], ['/compact', 'Summarize the conversation to free context'], ['/context', 'Show what fills the context window'], ['/cost', 'Tokens and cost of this session'], ['/review', 'Review a pull request'], ['/init', 'Write a CLAUDE.md for this project'], ['/memory', 'Edit memory files'], ['/model', 'Switch the model'], ['/agents', 'Manage subagents'], ['/mcp', 'MCP servers and their tools'], ['/permissions', 'Allowed and denied tools'], ['/todos', 'Current todo list'], ['/status', 'Version, model and account'], ['/doctor', 'Check the installation'], ['/export', 'Export the conversation'], ['/help', 'All commands']],
  codex: [['/model', 'Choose the model and reasoning effort'], ['/approvals', 'What Codex may do without asking'], ['/review', 'Review the current changes'], ['/new', 'Start a new chat'], ['/init', 'Write an AGENTS.md for this project'], ['/compact', 'Summarize to free context'], ['/diff', 'Show the git diff'], ['/mention', 'Mention a file'], ['/status', 'Session config and token usage'], ['/mcp', 'List MCP tools']],
  gemini: [['/help', 'All commands'], ['/chat', 'Save, resume or list chats'], ['/clear', 'Clear the screen and context'], ['/compress', 'Summarize the context'], ['/copy', 'Copy the last answer'], ['/memory', 'Show or add memory'], ['/restore', 'Undo tool changes'], ['/stats', 'Token and session stats'], ['/tools', 'Available tools'], ['/mcp', 'MCP servers'], ['/extensions', 'Active extensions'], ['/settings', 'Edit settings']],
  opencode: [['/init', 'Write an AGENTS.md for this project'], ['/new', 'Start a new session'], ['/sessions', 'List sessions'], ['/compact', 'Summarize the session'], ['/share', 'Share this session'], ['/undo', 'Undo the last message'], ['/redo', 'Redo'], ['/models', 'List models'], ['/export', 'Export the conversation'], ['/details', 'Toggle tool details'], ['/help', 'All commands']],
  hermes: [['/help', 'All commands'], ['/new', 'Start a new conversation'], ['/model', 'Switch the model'], ['/tools', 'Available tools'], ['/skills', 'Installed skills'], ['/compress', 'Summarize the context'], ['/usage', 'Token usage'], ['/retry', 'Retry the last message'], ['/undo', 'Remove the last exchange'], ['/personality', 'Set the personality']],
  omp: [['/model', 'Switch the model'], ['/new', 'Start a new session'], ['/compact', 'Summarize to free context'], ['/resume', 'Resume a session'], ['/session', 'Session info and stats'], ['/tree', 'Jump within the session tree'], ['/fork', 'Branch from an earlier message'], ['/export', 'Export to HTML'], ['/copy', 'Copy the last answer'], ['/settings', 'Settings'], ['/hotkeys', 'Keyboard shortcuts']],
};
const QUEUE = {};   // session id -> messages waiting for the running turn to end
const sessAgent = (id) => (((window.__liveRuns && window.__liveRuns.get(id)) || {}).agent) || (DB.sessions.find((x) => x.id === id) || {}).agent || '';
/* Busy = a turn is running: the bubble chat's own flag, else the session row's column. */
function chatBusy(id) {
  if (bubbleChat(id)) return !!(CHAT[id] && CHAT[id].busy);
  return (DB.sessions.find((x) => x.id === id) || {}).col === 'running';
}
/* Composer files go to the session folder; the agent gets their paths with the message. */
async function withFiles(id, text) {
  const files = state.attached.splice(0);
  document.querySelector('.composer .attach-list')?.remove();
  if (!files.length) return text;
  const paths = [];
  for (const f of files) {
    try {
      const blob = f.file || await (await fetch(f.img)).blob();
      const j = await (await fetch(`/api/sessions/${id}/upload?name=${encodeURIComponent(f.name)}`, { method: 'POST', body: blob })).json();
      if (j.error) throw new Error(j.error);
      paths.push(j.path);
    } catch (e) { toast(`${f.name}: ${e.message}`, 'warning'); }
  }
  if (paths.length) toast(`${paths.length} file(s) sent`, 'paperclip');
  return paths.length ? `${text}\n\nAttached files:\n${paths.map((p) => '- ' + p).join('\n')}` : text;
}
/* The message shows at once (dimmed) and the chat goes busy; it is replaced by the stored one when
   the hub has it, which waits for a terminal that is still opening. */
function bubbleSend(id, text) {
  const c = CHAT[id] || (CHAT[id] = { v: 0, ev: new Map(), busy: false, open: new Set() });
  const p = { text, sent: 0, at: Date.now() };
  (c.pending = c.pending || []).push(p); c.busy = true; state.chatBottom = id;
  chatPaint(id); composerPaint(id);
  const drop = () => { const i = c.pending.indexOf(p); if (i >= 0) c.pending.splice(i, 1); };
  return fetch(`/api/sessions/${id}/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) })
    .then((x) => x.json()).then((j) => { if (j.error) { drop(); toast(j.error, 'warning'); } else p.sent = Date.now(); return chatPull(id); })
    .catch((err) => { drop(); toast(`Not sent · ${err.message}`, 'warning'); })
    .then(() => chatPaint(id));
}
function chatStop(id) {
  if (bubbleChat(id)) return fetch(`/api/sessions/${id}/chat/stop`, { method: 'POST' }).then(() => chatPull(id)).then(() => chatPaint(id));
  /* A terminal agent: Esc is the interrupt key of the agent TUIs. */
  return fetch(`/api/sessions/${id}/input`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data: '\x1b' }) });
}
function sendBtnHTML(busy) {
  return busy
    ? `<button class="send-btn stop" data-act="chat-halt" title="Stop the model" aria-label="Stop the model">${ic('stop', 'fill')}</button>`
    : `<button class="send-btn" data-act="send" title="Send · Enter" aria-label="Send">${ic('arrow-up', 'bold')}</button>`;
}
function queueHTML(id) {
  const q = QUEUE[id] || [];
  return `<div class="c-queue" id="c-queue" ${q.length ? '' : 'hidden'}>${q.map((t, i) => `<span class="c-q">${ic('clock-countdown')}<span>${esc(t)}</span><button data-act="unqueue" data-i="${i}" title="Remove from queue" aria-label="Remove from queue">${ic('x')}</button></span>`).join('')}</div>`;
}
function queuePaint(id) { const el = document.getElementById('c-queue'); if (el) el.outerHTML = queueHTML(id); }
/* The send button, the queue and the header pill follow the turn without a full render. */
function composerPaint(id) {
  const busy = chatBusy(id);
  const b = document.querySelector('.composer .send-btn');
  if (b && b.classList.contains('stop') !== busy) b.outerHTML = sendBtnHTML(busy);
  const ta = document.getElementById('composer');
  if (ta) ta.placeholder = composerHint(busy);
  queuePaint(id);
  const pk = document.getElementById('c-pick');
  if (pk) { const html = pickHTML(id); if (pk.outerHTML !== html) pk.outerHTML = html; }
  const ap = document.getElementById('c-approve');
  if (ap) { const html = approveHTML(id); if (ap.outerHTML !== html) ap.outerHTML = html; }
}
const composerHint = (busy) => (busy ? 'Working… Ctrl+Enter queues your next message' : 'Ask anything · / for commands · Ctrl+Enter to queue');

/* Find in this chat: messages from me, the agent, or both, newest first. */
function chatFindBar(id) {
  if (!state.chatFindOpen) return '';
  const who = state.chatFindWho || '';
  return `<div class="cfind">
    <div class="cfind-row">${ic('magnifying-glass')}<input id="chat-find-q" value="${esc(state.chatFindQ || '')}" placeholder="Search this chat" aria-label="Search this chat" autocomplete="off">
      <div class="seg">${[['', 'All'], ['user', 'Me'], ['agent', 'Agent']].map(([v, l]) => `<button class="${who === v ? 'on' : ''}" data-act="chat-find-who" data-v="${v}">${l}</button>`).join('')}</div>
      <button class="sh-btn" data-act="chat-search" title="Close search" aria-label="Close search">${ic('x')}</button></div>
    <div class="cfind-list" id="chat-find-list">${bubbleChat(id) ? '' : '<p class="cfind-empty">This session runs in a terminal; only bubble chats keep searchable messages.</p>'}</div>
  </div>`;
}
function chatFind() {
  const id = state.activeTab, el = document.getElementById('chat-find-q'), list = document.getElementById('chat-find-list');
  if (!el || !list || !bubbleChat(id)) return;
  const q = state.chatFindQ = el.value;
  if (q.trim().length < 2) { list.innerHTML = q.trim() ? '<p class="cfind-empty">Type at least 2 characters</p>' : ''; return; }
  searchMsgs(q, { session: id, who: state.chatFindWho || '' }).then((hits) => {
    if (!hits) return;
    list.innerHTML = hits.length ? `<p class="cfind-count">${hits.length}${hits.length >= 40 ? '+' : ''} message${hits.length === 1 ? '' : 's'}</p>${hits.map((h) => msgRow(h, q.trim(), false)).join('')}` : `<p class="cfind-empty">No message holds “${esc(q.trim())}”</p>`;
  });
}
/* Scroll to a message found by search and flash it. Waits for the conversation to load. */
function chatJump() {
  const n = state.jumpEv;
  if (!n) return;
  const el = document.getElementById(`ev-${n}`);
  if (!el) return;   // chatPaint calls again once the events are in
  state.jumpEv = 0;
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
}

/* Model and effort in one menu: two columns, a click on either applies and the menu stays. */
function popModelEffort() {
  const col = (title, key, items) => `<div class="me-col"><div class="me-h">${title}</div>${items.map((i) => `<button class="me-row${state[key] === i ? ' sel' : ''}" data-me="${key}" data-val="${esc(i)}"><span>${esc(i)}</span>${state[key] === i ? ic('check', 'bold') : ''}</button>`).join('')}</div>`;
  popover.className = 'popover me-pop';
  popover.style.maxHeight = '';
  popover.innerHTML = `<div class="me-grid">${col('Model', 'model', CHOICES.model)}${col('Effort', 'reasoning', CHOICES.reasoning)}</div>`;
  positionComposerMenu(popover, 380);
}
const meLabel = () => `${ic('cpu')}<span>${esc(state.model)}</span><em>${esc(state.reasoning)}</em>${ic('caret-down')}`;
document.addEventListener('click', (e) => {
  const r = e.target.closest('[data-me]');
  if (!r) return;
  e.stopImmediatePropagation();   // the row is replaced below; the page handler would read it as an outside click
  state[r.dataset.me] = r.dataset.val;
  popModelEffort();
  const b = document.querySelector('[data-act="model-effort"]');
  if (b) b.innerHTML = meLabel();
});

/* Slash menu: opens while the composer holds only "/word", lists the session agent's commands. */
/* The agent's own commands as its install reports them (Hermes: commands + skills); the list above
   is the fallback for agents the hub cannot read, or a session on another device. */
const CMDS = {};   // agent -> [[cmd, desc, group, args]] | 'loading' | null
function cmdLoad(agent) {
  if (CMDS[agent] !== undefined) return;
  CMDS[agent] = 'loading';
  fetch(`/api/agents/${encodeURIComponent(agent)}/commands`, { cache: 'no-store' }).then((r) => r.json()).then((j) => { CMDS[agent] = Array.isArray(j.list) ? j.list : null; })
    .catch(() => { CMDS[agent] = null; })
    .finally(() => { const ta = document.getElementById('composer'); if (slashOpen() && ta && /^\/[\w:.-]*$/.test(ta.value)) popSlash(ta.value); });
}
function slashItems(q) {
  const agent = sessAgent(state.activeTab);
  const local = ((DB.sessions.find((x) => x.id === state.activeTab) || {}).device || 'local') === 'local';
  if (local) cmdLoad(agent);
  const own = local && Array.isArray(CMDS[agent]) ? CMDS[agent] : null;
  const list = own || (SLASH[agent] || []).map(([c, d]) => [c, d, '', '']);
  const f = q.slice(1).toLowerCase();
  const hit = list.filter(([c, dsc]) => c.slice(1).toLowerCase().startsWith(f) || (f.length > 1 && dsc.toLowerCase().includes(f)));
  return hit.sort((a, b) => (b[0].slice(1).toLowerCase().startsWith(f) - a[0].slice(1).toLowerCase().startsWith(f)));   // name matches first
}
function popSlash(q) {
  const items = slashItems(q);
  const agent0 = sessAgent(state.activeTab);
  if (!items.length && CMDS[agent0] !== 'loading') { if (popover.classList.contains('slash-pop')) { popover.hidden = true; popover.className = 'popover'; } return; }
  state.slashSel = Math.min(state.slashSel || 0, items.length - 1);
  const agent = sessAgent(state.activeTab);
  popover.className = 'popover slash-pop';
  popover.style.maxHeight = '';
  const n = Array.isArray(CMDS[agent]) ? `${CMDS[agent].length} from its install` : CMDS[agent] === 'loading' ? 'reading its install…' : '';
  popover.innerHTML = `<div class="pop-head">${ic('terminal')}<span style="flex:1">${esc(AGENT_NAMES[agent] || agent)} commands <small class="dim">${n}</small></span><kbd class="kbdcap">↑↓</kbd><kbd class="kbdcap">Tab</kbd></div>
    <div class="pop-body" style="padding:4px">${items.map(([c, dsc, g, a], i) => `<div class="pop-row slash-row${i === state.slashSel ? ' sel' : ''}" data-slash="${esc(c)}" title="${esc(dsc)}"><code>${esc(c)}${a ? ` <i class="dim">${esc(a)}</i>` : ''}</code><span>${esc(dsc)}</span>${g ? `<small class="slash-g">${esc(g)}</small>` : ''}</div>`).join('') || '<div class="dim" style="padding:8px;font-size:11.5px">Reading commands…</div>'}</div>`;
  positionComposerMenu(popover, 360);
  popover.querySelector('.slash-row.sel')?.scrollIntoView({ block: 'nearest' });
}
const slashOpen = () => !popover.hidden && popover.classList.contains('slash-pop');
function slashPick(cmd) {
  const ta = document.getElementById('composer');
  popover.hidden = true; popover.className = 'popover';
  if (!ta) return;
  ta.value = `${cmd} `; ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);
}
document.addEventListener('mousedown', (e) => {
  const r = e.target.closest('[data-slash]');
  if (!r) return;
  e.preventDefault();   // the composer keeps focus
  slashPick(r.dataset.slash);
});

/* ---------- session chrome (header, worked fold, subagents, composer) ---------- */
/* "12.4K / 200K" -> 6. Unparseable meters read as 0, never NaN. */
function ctxPct(meter) {
  const n = (s) => { const m = /([\d.]+)\s*([KM]?)/i.exec(s || ''); return m ? m[1] * ({ k: 1e3, m: 1e6 }[m[2].toLowerCase()] || 1) : 0; };
  const [used, cap] = String(meter || '').split('/').map(n);
  return cap ? Math.min(100, Math.round((used / cap) * 100)) : 0;
}
console.assert(ctxPct('12.4K / 200K') === 6 && ctxPct('300K / 1M') === 30 && ctxPct('') === 0, 'ctxPct');
const SESS_ST = { running: 'Working', starting: 'Starting', waiting: 'Waiting', queued: 'Queued', failed: 'Failed', stopped: 'Stopped', hibernated: 'Hibernated' };
function sessionStatus(id) {
  const row = (window.__liveRuns && window.__liveRuns.get(id)) || {};
  if (['failed', 'stopped', 'hibernated'].includes(row.status)) return row.status;
  if (bubbleChat(id) && CHAT[id]?.loaded) return CHAT[id].busy ? 'running' : 'idle';
  return row.status || (DB.sessions.find((x) => x.id === id) || {}).col || 'idle';
}
function sessionStatusPaint(id) {
  if (state.page !== 'session' || state.activeTab !== id) return;
  const pill = document.querySelector('.sh-st'), st = sessionStatus(id);
  if (pill) { pill.className = `sh-st ${st}`; pill.innerHTML = `<i></i>${SESS_ST[st] || 'Idle'}`; }
}
async function refreshSession(id, button) {
  button.disabled = true;
  try {
    const response = await fetch('/api/sessions?kind=chat', { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const row = (await response.json()).find((r) => r.id === id);
    if (!row) throw new Error('Session no longer exists');
    window.__liveRuns?.set(id, row);
    const shown = DB.sessions.find((s) => s.id === id);
    if (shown) { shown.live = row; shown.col = row.status; }
    if (bubbleChat(id)) { await chatPull(id, true); chatPaint(id); }
    else sessionStatusPaint(id);
    if (state.page === 'session' && state.activeTab === id) {
      const t0 = document.getElementById('chat-term'), terminal = t0 && !t0.closest('[hidden]') ? t0 : null;
      const shell = document.getElementById('sess-term');
      if (terminal || shell) {
        window.__ptyCleanup?.(); window.__ptyCleanup = null;
        if (terminal) { terminal.innerHTML = ''; await mountTerminal(id, terminal); }
        if (shell) await mountSessionTerm();
      }
    }
    toast('Session refreshed · terminal reconnected', 'arrow-clockwise');
  } catch (err) { toast(`Refresh failed: ${err.message}`, 'warning'); }
  finally { button.disabled = false; }
}
/* Ports the open session listens on (local sessions): polled every 5s while visible. */
const SESS_PORTS = {};
/* Processes the session started that still run: a chip in its header opens the list, each with a Stop. */
const SESS_BG = {};
const portChips = (id) => (SESS_PORTS[id] || []).map((p) => `<button class="sh-btn" data-act="open-port" data-port="${+p.port}" title="${esc(p.name || 'process')} · pid ${+p.pid}">:${+p.port}</button>`).join('')
  + ((SESS_BG[id] || []).length ? `<button class="sh-bg" data-act="bg-procs" data-id="${esc(id)}" title="Processes this session started that are still running">${ic('spinner-gap', 'bold')}<span>${SESS_BG[id].length} background</span></button>` : '');
async function sessPoll(id) {
  const [r, b] = await Promise.all([`/api/sessions/${id}/ports`, `/api/sessions/${id}/procs`].map((u) => fetch(u).then((x) => x.json()).catch(() => null)));
  if (state.activeTab !== id) return;
  if (Array.isArray(r)) SESS_PORTS[id] = r;
  if (Array.isArray(b)) SESS_BG[id] = b;
  const el = document.getElementById('sh-ports');
  if (el) el.innerHTML = portChips(id);
  if (!popover.hidden && popover.classList.contains('bg-pop') && popover.dataset.bg === id) popBg(null, id);
  graphPaint(id);
}
setInterval(() => {
  const id = state.activeTab;
  if (state.page !== 'session' || document.hidden || !document.getElementById('sh-ports') || !id) return;
  sessPoll(id);
}, 5000);
const bgDur = (ms) => { const t = Math.max(0, Math.round(ms / 1000)), h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60); return h ? `${h}h ${m}m` : m ? `${m}m ${t % 60}s` : `${t}s`; };
function popBg(el, id) {
  const list = SESS_BG[id] || [], open = popBg.open || (popBg.open = new Set());
  popover.className = 'popover bg-pop';
  popover.dataset.bg = id;
  popover.style.maxHeight = '';
  popover.innerHTML = `<div class="pop-head"><span style="flex:1">${list.length ? `${list.length} background process${list.length === 1 ? '' : 'es'} running` : 'Nothing running in the background'}</span></div>
    <div class="pop-body bg-list">${list.map((p) => `<div class="bg-row${open.has(p.pid) ? ' open' : ''}">
      <div class="bg-main">${ic('spinner-gap', 'bold', 'bg-spin')}<div class="bg-txt"><code class="bg-cmd">${esc(p.cmd)}</code>
        <div class="bg-meta"><span class="bg-name">${esc(p.name.replace(/\.exe$/i, ''))}</span>${p.at ? `<span>${bgDur(Date.now() - p.at)}</span>` : ''}</div></div>
        <button class="sh-btn" data-act="bg-more" data-id="${esc(id)}" data-pid="${+p.pid}" title="Details" aria-label="Details">${ic(open.has(p.pid) ? 'caret-up' : 'caret-down')}</button>
        <button class="sh-btn bg-stop" data-act="bg-stop" data-id="${esc(id)}" data-pid="${+p.pid}" title="Stop it and what it started" aria-label="Stop">${ic('stop', 'fill')}</button></div>
      ${open.has(p.pid) ? `<div class="bg-detail"><div><span>pid</span><b>${+p.pid}</b><span>parent</span><b>${+p.ppid}</b></div>${p.at ? `<div><span>started</span><b>${esc(new Date(p.at).toLocaleString())}</b></div>` : ''}
        <pre class="tool-full">${esc(p.cmd)}</pre><button class="btn secondary sm" data-act="copy-text" data-text="${esc(p.cmd)}">${ic('copy')}Copy command</button></div>` : ''}
    </div>`).join('') || '<div class="pop-row dim">Dev servers, watchers and other processes this session starts show here.</div>'}</div>`;
  if (el) {
    const r = zRect(el), w = Math.min(420, VW() - 16);
    popover.style.width = w + 'px';
    popover.style.top = Math.round(r.bottom + 6) + 'px';
    popover.style.left = Math.round(Math.max(8, Math.min(r.right - w, VW() - w - 8))) + 'px';
  }
  popover.hidden = false;
}
/* Run menu: the project's .xblabs.json "run" commands; one opens a new Terminal tab in the session's folder. */
async function popRunMenu(el, id) {
  const cmds = await fetch(`/api/sessions/${id}/run`).then((x) => x.json()).catch(() => ({}));
  const rows = cmds.error ? `<div class="pop-row dim">${esc(cmds.error)}</div>` : Object.entries(cmds).map(([n, c]) =>
    `<div class="pop-row" data-act="run-cmd" data-id="${esc(id)}" data-name="${esc(n)}" title="${esc(c)}">${ic('play')}<span style="flex:1">${esc(n)}</span><span class="dim mono">${esc(c.slice(0, 24))}</span></div>`).join('')
    || '<div class="pop-row dim">Commands come from "run" in the project\'s .xblabs.json</div>';
  popover.className = 'popover';
  popover.style.maxHeight = '';
  popover.innerHTML = `<div class="pop-head"><span style="flex:1">Run</span></div>
    <div class="pop-body" style="padding:4px">${rows}
      ${cmds.error ? '' : `<div class="pop-row" data-act="run-add" data-id="${esc(id)}">${ic('plus')}<span style="flex:1">Add command…</span></div>`}</div>`;
  const r = zRect(el);
  popover.style.width = '260px';
  popover.style.top = Math.round(r.bottom + 6) + 'px';
  popover.style.left = Math.round(Math.max(8, Math.min(r.right - 260, VW() - 276))) + 'px';
  popover.hidden = false;
}
async function runPost(id, body) {
  const r = await fetch(`/api/sessions/${id}/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((x) => x.json()).catch((err) => ({ error: err.message }));
  if (r.error) return toast(r.error, 'warning');
  await liveLoad();
  state.termTab = r.id; state.page = 'logs'; render();
}
function sessHead(S, st, pct, panelOpen) {
  return `<div class="sh">
    <span class="sh-av" data-grainient>${agentLogo(S.agent || 'shell')}</span>
    <div class="sh-txt"><b>${esc(S.title)}</b>
      <div class="sh-tags"><span class="sh-agent">${esc(AGENT_NAMES[S.agent] || S.agent)}${(() => { const n = cfgName(S.agent, ((DB.sessions.find((x) => x.id === S.id) || {}).live || {}).config_id); return n ? ` · ${esc(n)}` : ''; })()}</span><span>${ic('git-branch')}${esc(S.branch || 'no branch')}</span>${(() => { const r = (DB.sessions.find((x) => x.id === S.id) || {}).live || {}, path = r.origin || r.cwd || '';
        return `<button class="sh-path" data-act="copy-text" data-text="${esc(r.cwd || path)}" title="${esc(path)}${r.cwd && r.cwd !== path ? `
Working in ${esc(r.cwd)}` : ''}
Click to copy">${ic('folder')}<b>${esc(S.ws)}</b>${path ? `<span><bdi>${esc(path)}</bdi></span>` : ''}</button>`; })()}</div>
    </div>
    <span class="grow"></span>
    <span id="sh-ports" style="display:contents">${portChips(S.id)}</span>
    ${viewSwitch(S.id)}
    <button class="sh-btn" data-act="session-refresh" title="Refresh this session" aria-label="Refresh this session">${ic('arrow-clockwise')}</button>
    <button class="sh-btn${state.chatFindOpen ? ' on' : ''}" data-act="chat-search" title="Search this chat" aria-label="Search this chat">${ic('magnifying-glass')}</button>
    <span class="sh-st ${st || 'idle'}"><i></i>${SESS_ST[st] || 'Idle'}</span>
    ${panelOpen ? '' : `<button class="sh-btn" data-act="toggle-files" title="Show panel" aria-label="Show panel">${ic('sidebar-simple')}</button>`}
  </div>`;
}
/* Terminal opens the native CLI on the same conversation; never JSON stdout. */
function viewSwitch(id) {
  const bubble = bubbleChat(id), pty = agentChat(id);
  if (!bubble && !pty) return '';
  const v = bubble ? state.chatView : 'term';
  const b = (k, icon, label) => `<button class="${v === k ? 'on' : ''}" data-act="chat-view" data-v="${k}" ${!bubble && k !== 'term' ? 'disabled title="This agent has no JSON mode, so it only runs in its terminal"' : `title="${label} view"`}>${ic(icon)}<span>${label}</span></button>`;
  return `<div class="seg sh-seg">${b('chat', 'chat-circle-dots', 'Chat')}${b('term', 'terminal', 'Terminal')}</div>`;
}
function worked(label, meta, body) {
  return `<details class="worked" open><summary>${ic('caret-right')}<b>${esc(label)}</b><span>${esc(meta)}</span></summary><div class="worked-body">${body}</div></details>`;
}
/* Subagents: a call of the agent's own subagent tool (claude Task/Agent, hermes delegate_task,
   omp task). One call may start several (a tasks list). Their own tool calls (claude tells which
   call they belong to) are the steps; the call's result is what they reported. */
const SUB_TOOL = /^(task|agent|delegate_task|subagent|spawn_agent)$/i;
const isSubCall = (e) => e.kind === 'tool' && SUB_TOOL.test(e.data.name || '') && !e.data.parent;
/* OMP's task tool starts its subagents in the background and returns at once; each one's result
   comes later in a tool output of the same turn (its wait tool) as <task-result id=NAME ...>. */
function bgResults(ev, turn) {
  const out = new Map();
  for (const e of ev) {
    if (e.kind !== 'tool' || e.turn !== turn || typeof e.data.output !== 'string' || !e.data.output.includes('<task-result')) continue;
    for (const m of e.data.output.matchAll(/<task-result ([^>]*)>([\s\S]*?)<\/task-result>/g)) {
      const a = Object.fromEntries([...m[1].matchAll(/(\w+)="([^"]*)"/g)].map((x) => [x[1], x[2]]));
      const body = /<output>([\s\S]*?)<\/output>/.exec(m[2]);
      if (a.id) out.set(a.id, { status: a.status || 'completed', secs: a.duration ? Math.round(parseFloat(a.duration)) : null, out: (body ? body[1] : m[2]).trim() });
    }
  }
  return out;
}
function subsOf(e, kids, stale, ev = []) {
  const d = e.data, inp = typeof d.input === 'string' ? (() => { try { return JSON.parse(d.input); } catch { return { prompt: d.input }; } })() : d.input || {};
  const items = Array.isArray(inp.tasks) && inp.tasks.length ? inp.tasks : [inp];
  const run = d.output == null && !stale, last = kids[kids.length - 1];
  const secs = Math.max(0, Math.round(((d.end || (run ? Date.now() : e.at || Date.now())) - (e.at || Date.now())) / 1000));
  const step = last ? `${last.data.name} ${String((last.data.input && (last.data.input.command || last.data.input.file_path || last.data.input.path || last.data.input.pattern || last.data.input.query)) || '')}`.trim() : '';
  /* hermes reports a batch as {results: [{task_index, status, summary}]}: each card gets its own. */
  let res = null;
  try { res = JSON.parse(d.output).results; } catch {}
  const later = /background agents?/i.test(String(d.output || '')) ? bgResults(ev, e.turn) : null;
  return items.map((x, n) => {
    const r = Array.isArray(res) ? res.find((y) => y.task_index === n) || res[n] : null;
    const say = String(x.description || x.name || x.goal || x.title || x.task || x.assignment || x.prompt || 'Subagent').trim();
    if (later) {
      /* Running until its own result shows up; a turn that ended without one leaves it unknown, not failed. */
      const b = later.get(x.name), going = !b && !stale;
      return { key: `${e.id}.${n}`, title: say.split('\n')[0].slice(0, 90), type: String(x.agent || inp.agent || d.name), brief: String(x.task || x.assignment || say),
        act: going ? 'Working in the background' : b ? 'Reported back' : 'No result in this turn', steps: kids.length, model: '', secs: b && b.secs != null ? b.secs : secs,
        run: going, err: !!b && /fail|error|cancel/i.test(b.status), out: b ? b.out : null };
    }
    return { key: `${e.id}.${n}`, title: say.split('\n')[0].slice(0, 90), type: String(x.subagent_type || inp.subagent_type || x.agent || inp.agent || d.name),
      brief: String(x.prompt || x.context || inp.context || x.assignment || say), act: step || (run ? 'Starting' : d.error ? 'Failed' : 'Reported back'),
      steps: kids.length || (r && Array.isArray(r.tool_trace) ? r.tool_trace.length : 0), model: r && r.model, secs: r && r.duration_seconds ? Math.round(r.duration_seconds) : secs, run,
      err: !run && (d.error || (d.output == null && stale) || (r && /fail|error/i.test(r.status || ''))), out: r ? r.summary ?? r.result ?? JSON.stringify(r) : d.output };
  });
}
function subagentsBlock(list, c) {
  const max = Math.max(1, ...list.map((a) => a.secs)), on = list.filter((a) => a.run).length, bad = list.filter((a) => a.err).length;
  const st = (a) => (a.run ? ['run', 'Running'] : a.err ? ['err', 'Failed'] : ['ok', 'Completed']);
  return `<div class="sa-board">
    <div class="sa-head">${ic('users-three')}<b>${list.length > 1 ? `${list.length} subagents` : 'Subagent'}</b><span>${on ? `${on} running` : bad ? `${bad} failed` : 'all done'} · ${max}s</span></div>
    ${list.map((a) => { const [k, label] = st(a); return `<details class="sa-row ${k}" data-evid="sa${a.key}" ${c.open.has(`sa${a.key}`) ? 'open' : ''}><summary>
      <i class="sa-dot"></i><span class="sa-name" title="${esc(a.title)}">${esc(a.title)}</span>
      <span class="sa-step" title="${esc(a.act)}">${a.run ? esc(a.act) : `${a.steps ? `${a.steps} steps · ` : ''}${a.secs}s`}</span>
      <span class="sa-who">${esc(a.model || a.type)}</span><span class="sa-pill">${label}</span>${ic('caret-down')}</summary>
      <div class="sa-body"><div class="sa-brief">${esc(a.brief.slice(0, 2000))}</div>${a.out != null ? `<div class="msg-text sa-out">${mdLite(String(a.out).slice(0, 8000))}</div>` : ''}</div>
    </details>`; }).join('')}
  </div>`;
}
/* The strip above the composer while a turn's subagents run; repainted with the chat. */
function saStrip(id) {
  const subs = bubbleChat(id) ? liveSubs(id) : [], on = subs.filter((a) => a.run);
  return `<div id="sa-strip">${subs.length ? `<div class="sa-strip">${ic('users-three')}<b>${subs.length} subagents · ${on.length} running</b>
    ${subs.map((a) => `<span class="${a.run ? 'run' : ''}"><i></i>${esc(a.title)}</span>`).join('')}</div>` : ''}</div>`;
}
/* The subagents of the turn running now, for the strip above the composer. */
function liveSubs(id) {
  const c = CHAT[id];
  if (!c || !c.loaded || !c.busy) return [];
  const ev = [...c.ev.values()], turn = Math.max(...ev.map((e) => e.turn));
  return ev.filter((e) => e.turn === turn && isSubCall(e)).flatMap((e) => subsOf(e, ev.filter((k) => k.data.parent === e.id), false, ev));
}

/* The session's change set from its worktree (git, new files included). Re-read after each turn. */
function changesCard(r) {
  const g = r.branch ? GIT[r.id] : null, gd = g && g.data;
  const add = gd ? gd.stat.reduce((n, x) => n + x.add, 0) : 0, del = gd ? gd.stat.reduce((n, x) => n + x.del, 0) : 0;
  return `<div class="mt-card" id="mt-changes">
      <div class="mt-h">${ic('file-text')}Changes${gd ? ` · <b class="add">+${add}</b> <b class="del">−${del}</b>` : ''}</div>
      ${!r.branch ? '<p class="mt-empty">Works in the project folder; no change set to show</p>'
        : !gd ? `<p class="mt-empty">${g && g.error ? esc(g.error) : 'Reading the worktree…'}</p>`
        : gd.stat.length ? gd.stat.slice(0, 20).map((e) => `<div class="mt-file"><div><b>${esc(e.file.split('/').pop())}</b><span>${esc(e.file.includes('/') ? e.file.replace(/\/[^/]*$/, '') : '.')}</span></div><span><b class="add">+${e.add}</b> <b class="del">−${e.del}</b></span></div>`).join('')
          + `<button class="btn secondary sm" style="margin-top:8px;width:100%" data-act="git-review" data-id="${esc(r.id)}">Review changes</button>`
        : '<p class="mt-empty">No file changes yet</p>'}
    </div>`;
}
/* GRAPH tab: how this session runs. Main agent (the first session of its chain) → each stage /
   branch down to this one → what this one started: next pipeline stages (waiting ones folded),
   branches, subagents, background processes. Built from what is already loaded: session rows
   (parent), the chat's pipeline state, its subagent calls, and the background list. */
const runsMap = () => window.__liveRuns || new Map();
function gSnip(id) {
  const c = CHAT[id];
  const t = c && c.loaded ? [...c.ev.values()].filter((e) => e.kind === 'text').sort((a, b) => b.id - a.id)[0] : null;
  return t ? String(t.data.text).replace(/[#*`>_|]/g, '').replace(/\s+/g, ' ').trim().slice(0, 140) : '';
}
function gState(r) {
  if (!r) return ['wait', 'Waiting'];
  if (r.id && chatBusy(r.id)) return ['run', 'Working'];
  if (r.status === 'running' && bubbleChat(r.id)) return ['ok', 'Idle'];   // its terminal is open, nothing is being answered
  return { running: ['run', 'Working'], starting: ['run', 'Starting'], waiting: ['ask', 'Needs your OK'], failed: ['err', 'Failed'], stopped: ['err', 'Stopped'], hibernated: ['idle', 'Hibernated'], done: ['ok', 'Done'] }[r.status] || ['ok', 'Idle'];
}
function gActivity(id) {
  const c = CHAT[id];
  if (!c || !c.loaded) return '';
  const ev = [...c.ev.values()], turn = Math.max(0, ...ev.map((e) => e.turn)), cur = ev.filter((e) => e.turn === turn);
  if (c.busy && c.note) return c.note;
  const tools = cur.filter((e) => e.kind === 'tool' && !e.data.parent && !isSubCall(e)).length, subs = cur.filter(isSubCall).length;
  const bits = [tools ? `${tools} tool call${tools === 1 ? '' : 's'}` : '', subs ? `${subs} subagent call${subs === 1 ? '' : 's'}` : '', cur.some((e) => e.kind === 'text') ? 'answered' : ''].filter(Boolean);
  return bits.length ? `Last turn: ${bits.join(', ')}` : '';
}
/* The graph as a tree: Pipeline / Main agent at the top, each stage or branch under the one before,
   what this session started fanned out under it. Laid out once per paint (fixed card size), drawn
   on a canvas you drag and zoom; the view (pan, zoom) is kept per session. */
const GW = 210, GH = 124, GX = 22, GY = 52;
function gTree(id) {
  const runs = runsMap(), me = runs.get(id);
  if (!me) return null;
  const c = CHAT[id], pl = c && c.pipeline;
  const sess = (r, label) => ({ key: r.id, kind: 'sess', label, title: r.title || r.id, snip: gSnip(r.id) || `${AGENT_NAMES[r.agent] || r.agent || 'shell'} · ${r.branch || r.cwd || ''}`, st: gState(r), foot: r.id === id ? gActivity(id) : '', id: r.id, me: r.id === id, kids: [] });
  let root, tip;
  const hang = (n) => { if (!root) root = n; else tip.kids.push(n); tip = n; };
  const tm = c && c.team;
  const TASK_ST = { running: ['run', 'Working'], done: ['ok', 'Continuable'], failed: ['err', 'Failed'], todo: ['wait', 'Waiting'] };
  if (tm) {
    const lead = runs.get(tm.lead);
    const ln = lead ? sess(lead, 'Main agent · Lead') : { key: tm.lead, kind: 'sess', label: 'Main agent · Lead', title: 'Lead', st: ['wait', 'Gone'], kids: [] };
    if (lead && tm.state === 'planning') ln.foot = 'Planning the tasks';
    if (lead && tm.state === 'review') ln.foot = 'Reviewing the results';
    if (tm.state === 'failed') { ln.st = ['err', 'Failed']; ln.foot = tm.error || 'Team failed'; }
    hang(ln);
    for (const t of tm.tasks) {
      const r = t.session && runs.get(t.session);
      const st = TASK_ST[t.status] || TASK_ST.todo;
      const live = r && r.status === 'waiting' ? ['ask', 'Needs your OK'] : r && chatBusy(r.id) ? ['run', 'Working'] : st;
      ln.kids.push(r ? { ...sess(r, 'Teammate'), st: live, title: t.title, foot: `${t.id} · ${t.owner}`, owner: t.owner, detail: { brief: t.brief, result: t.result } }
        : { key: `t:${tm.lead}:${t.id}`, kind: 'sess', label: 'Teammate', title: t.title, snip: t.brief, st, foot: `${t.id} · ${t.owner}`, owner: t.owner, detail: { brief: t.brief, result: t.result }, kids: [] });
    }
  } else if (pl && pl.stages) {
    hang({ key: `pl:${id}`, kind: 'pipe', label: 'Pipeline', title: pl.task || 'Pipeline', snip: pl.stages.map((x) => x.name).join(' → '), st: pl.state === 'done' ? ['ok', 'Done'] : pl.state === 'failed' ? ['err', 'Failed'] : ['run', `Stage ${Math.min(pl.step + 1, pl.stages.length)} of ${pl.stages.length}`], kids: [] });
    const started = pl.stages.map((x, n) => ({ x, r: pl.ids[n] ? runs.get(pl.ids[n]) : null })).filter((v) => v.r);
    started.forEach((v, n) => hang(sess(v.r, `${n === 0 ? 'Main agent · ' : ''}Stage ${n + 1} · ${v.x.name}`)));
    const waiting = pl.stages.slice(started.length);
    if (waiting.length && pl.state === 'running') tip.kids.push({ key: `wait:${id}`, kind: 'group', label: `${waiting.length} waiting`, title: waiting.map((x) => x.name).join(', '), st: ['wait', 'Waiting'], rows: waiting.map((x) => ({ title: x.name, meta: AGENT_NAMES[x.agent] || x.agent, st: ['wait', 'Waiting'] })), kids: [] });
  } else {
    const chain = [];
    for (let r = me, n = 0; r && n < 12; r = r.parent ? runs.get(r.parent) : null, n++) chain.unshift(r);
    chain.forEach((r, n) => hang(sess(r, n === 0 ? 'Main agent' : 'Branch')));
  }
  const at = (function find(n) { if (n.id === id) return n; for (const k of n.kids) { const f = find(k); if (f) return f; } return null; })(root) || tip;
  for (const r of [...runs.values()].filter((x) => x.parent === id && !(pl && pl.ids.includes(x.id)) && !(tm && tm.tasks.some((t) => t.session === x.id)))) at.kids.push(sess(r, 'Branch'));
  for (const a of gSubs(id)) at.kids.push({ key: `sa:${a.key}`, owner: a.model || a.type, detail: { brief: a.brief, result: a.out }, kind: 'sub', label: a.type, title: a.title, snip: a.out != null ? String(a.out).replace(/\s+/g, ' ').slice(0, 120) : a.brief.replace(/\s+/g, ' ').slice(0, 120), st: a.run ? ['run', 'Running'] : a.err ? ['err', 'Failed'] : ['ok', 'Completed'], foot: a.run ? a.act : `${a.steps ? `${a.steps} steps · ` : ''}${a.secs}s${a.model ? ` · ${a.model}` : ''}`, kids: [] });
  return root;
}
function gSubs(id) {
  const c = CHAT[id];
  if (!c || !c.loaded) return [];
  const ev = [...c.ev.values()];
  return ev.filter(isSubCall).sort((a, b) => a.id - b.id).slice(-16).flatMap((e) => subsOf(e, ev.filter((k) => k.data.parent === e.id), !c.busy, ev));
}
function gLayout(root) {
  const open = state.graphOpen || (state.graphOpen = new Set()), nodes = [], edges = [];
  const h = (n) => (n.kind === 'group' && open.has(n.key) ? 74 + n.rows.length * 26 : n.kind === 'group' ? 96 : GH);
  const width = (n) => Math.max(GW, n.kids.reduce((w, k) => w + width(k), 0) + GX * Math.max(0, n.kids.length - 1));
  (function place(n, left, y) {
    const w = width(n), x = left + w / 2 - GW / 2;
    nodes.push({ ...n, x, y, h: h(n) });
    let kl = left + (w - (n.kids.reduce((s2, k) => s2 + width(k), 0) + GX * Math.max(0, n.kids.length - 1))) / 2;
    for (const k of n.kids) {
      const kw = width(k), kx = kl + kw / 2 - GW / 2, ky = y + h(n) + GY;
      edges.push({ x1: x + GW / 2, y1: y + h(n), x2: kx + GW / 2, y2: ky });
      place(k, kl, ky); kl += kw + GX;
    }
  })(root, 0, 0);
  return { nodes, edges, w: width(root), h: Math.max(...nodes.map((n) => n.y + n.h)) };
}
function gCard(n) {
  const open = (state.graphOpen || new Set()).has(n.key);
  const go = n.kind === 'group' ? '' : ` data-act="graph-card" data-key="${esc(n.key)}" role="button" tabindex="0" title="Details"`;
  const body = n.kind === 'group'
    ? `<b class="gr-title">${esc(n.title)}</b>${open ? `<div class="gr-rows">${n.rows.map((r) => `<div class="gr-row ${r.st[0]}"><i class="gr-dot"></i><span>${esc(r.title)}</span><em>${esc(r.meta)}</em></div>`).join('')}</div>` : ''}
      <button class="gr-more" data-act="graph-group" data-key="${esc(n.key)}">${ic(open ? 'caret-up' : 'caret-down')}${open ? 'Collapse' : 'Expand'}</button>`
    : `<b class="gr-title">${esc(n.title)}</b>${n.snip ? `<p class="gr-snip">${esc(n.snip)}</p>` : ''}<div class="gr-foot"><i class="gr-dot"></i><span>${esc(n.foot || n.st[1])}</span></div>`;
  return `<div class="gr-node ${n.kind} ${n.st[0]}${n.me ? ' me' : ''}" style="left:${n.x}px;top:${n.y}px;width:${GW}px;height:${n.h}px"${go}>
    <div class="gr-top"><span class="gr-lbl">${esc(n.label)}</span>${n.kind === 'sub' || n.kind === 'sess' ? `<span class="gr-st">${esc(n.st[1])}</span>` : ''}</div>${body}</div>`;
}
function graphTab(id) {
  const root = gTree(id);
  if (!root) return '<div class="dim" style="font-size:11.5px;padding:14px">Open a session to see its graph.</div>';
  const c = CHAT[id], pl = c && c.pipeline, subs = gSubs(id), bg = SESS_BG[id] || [];
  const owners0 = [...new Set(tasksOf(id).map((t) => t.who))], who0 = owners0.includes(state.gOwner) ? state.gOwner : '';
  /* A member picked on the board: the graph keeps that member's cards and the chain above them. */
  const prune = (n, top) => { n.kids = n.kids.map((k) => prune(k, false)).filter(Boolean); return top || n.owner === who0 || n.kids.length ? n : null; };
  if (who0) prune(root, true);
  const L = gLayout(root);
  GNODES.clear(); for (const n of L.nodes) GNODES.set(n.key, n);
  const v = (state.gview || (state.gview = {}))[id] || { x: 0, y: 0, z: 1, fit: true };
  const edge = (e) => `<path d="M${e.x1} ${e.y1} C${e.x1} ${e.y1 + GY / 2} ${e.x2} ${e.y2 - GY / 2} ${e.x2} ${e.y2}"/>`;
  /* Task board: the subagents, or else the pipeline's stages; filter by who does them. */
  const tm = c && c.team;
  const tasks = tasksOf(id);
  const owners = [...new Set(tasks.map((t) => t.who))], who = owners.includes(state.gOwner) ? state.gOwner : '';
  const boardOpen = state.gBoard !== false, bgOpen = state.gBg !== false;
  return `<div class="gr-wrap" id="graph-tab" data-sid="${esc(id)}">
    ${tasks.length ? `<div class="gr-board${boardOpen ? '' : ' shut'}"><button class="gr-bhead" data-act="graph-board">${ic('list-checks')}<b>${tm ? 'Team task board' : 'Task board'}</b><span>${tm ? `Team ${owners.length + 1} members · ` : ''}${tasks.length} task${tasks.length === 1 ? '' : 's'}${!tm && owners.length > 1 ? ` · ${owners.length} members` : ''}</span>${ic(boardOpen ? 'caret-up' : 'caret-down')}</button>
      ${boardOpen ? `${owners.length > 1 ? `<div class="gr-chips"><button class="${who ? '' : 'on'}" data-act="graph-owner" data-v="">All</button>${owners.map((o) => `<button class="${who === o ? 'on' : ''}" data-act="graph-owner" data-v="${esc(o)}">${esc(o)}</button>`).join('')}</div>` : ''}
      <div class="gr-tasks">${tasks.filter((t) => !who || t.who === who).map((t) => `<div class="gr-task ${t.st[0]}"${t.id ? ` data-session="${esc(t.id)}" role="button" tabindex="0"` : ''}><i class="gr-dot"></i><span>${esc(t.title)}</span><code>${esc(t.who)}</code><em>${esc(t.st[1])}</em></div>`).join('')}</div>` : ''}</div>` : ''}
    <div class="gr-canvas" data-fit="${v.fit ? 1 : 0}">
      <div class="gr-world" style="width:${L.w}px;height:${L.h}px;transform:translate(${v.x}px,${v.y}px) scale(${v.z})">
        <svg class="gr-edges" width="${L.w}" height="${L.h}" aria-hidden="true">${L.edges.map(edge).join('')}</svg>${L.nodes.map(gCard).join('')}</div>
      <div class="gr-tools"><span class="gr-mode">${ic('tree-structure')}Tree</span><button class="sh-btn" data-act="graph-zoom" data-z="-1" title="Zoom out" aria-label="Zoom out">${ic('minus')}</button><span class="gr-z">${Math.round(v.z * 100)}%</span><button class="sh-btn" data-act="graph-zoom" data-z="1" title="Zoom in" aria-label="Zoom in">${ic('plus')}</button><button class="sh-btn" data-act="graph-fit" title="Fit to view" aria-label="Fit to view">${ic('corners-out')}</button><button class="sh-btn" data-act="graph-wide" title="${state.gWide ? 'Narrow panel' : 'Widen panel'}" aria-label="Widen panel">${ic(state.gWide ? 'arrows-in-line-horizontal' : 'arrows-out-line-horizontal')}</button></div>
    </div>
    ${bg.length ? `<div class="gr-bg${bgOpen ? '' : ' shut'}"><button class="gr-bhead" data-act="graph-bg">${ic('terminal-window')}<b>Background jobs</b><span class="gr-count">${bg.length}</span><span>${bg.length} running</span>${ic(bgOpen ? 'caret-down' : 'caret-up')}</button>
      ${bgOpen ? `<div class="gr-jobs">${bg.map((x) => { const open = (state.gJobs || new Set()).has(x.pid); return `<div class="gr-job${open ? ' open' : ''}" data-act="graph-job" data-pid="${+x.pid}" role="button" tabindex="0" title="${open ? 'Hide details' : 'Details'}"><i class="gr-dot"></i><code class="gr-jname">${esc(x.name.replace(/\.exe$/i, ''))}</code><span>${esc(x.cmd)}</span><em>Running</em><b>${x.at ? bgDur(Date.now() - x.at) : ''}</b></div>
        ${open ? `<div class="gr-jdetail"><div><span>pid</span><b>${+x.pid}</b><span>parent</span><b>${+x.ppid}</b>${x.at ? `<span>started</span><b>${esc(new Date(x.at).toLocaleTimeString())}</b>` : ''}</div><pre class="tool-full">${esc(x.cmd)}</pre>
          <div class="gr-jact"><button class="btn secondary xs" data-act="copy-text" data-text="${esc(x.cmd)}">${ic('copy')}Copy</button><button class="btn secondary xs danger-text" data-act="bg-stop" data-id="${esc(id)}" data-pid="${+x.pid}">${ic('stop', 'fill')}Stop</button></div></div>` : ''}`; }).join('')}</div>` : ''}</div>` : ''}
  </div>`;
}
/* The board's rows: a team's tasks, else this session's subagents, else its pipeline's stages. */
function tasksOf(id) {
  const c = CHAT[id], tm = c && c.team, pl = c && c.pipeline, subs = gSubs(id), runs = runsMap();
  const TB = { running: ['run', 'Running'], done: ['ok', 'Completed'], failed: ['err', 'Failed'], todo: ['wait', 'Waiting'] };
  if (tm && tm.tasks.length) return tm.tasks.map((t) => { const r = t.session && runs.get(t.session); return { title: `${t.id} — ${t.title}`, who: t.owner, st: r && r.status === 'waiting' ? ['ask', 'Needs your OK'] : TB[t.status] || TB.todo, id: t.session }; });
  if (subs.length) return subs.map((a) => ({ title: a.title, who: a.model || a.type, st: a.run ? ['run', 'Running'] : a.err ? ['err', 'Failed'] : ['ok', 'Completed'] }));
  if (pl && pl.stages) return pl.stages.map((x, n) => { const r = pl.ids[n] && runs.get(pl.ids[n]); return { title: `S${n + 1} — ${x.name}`, who: AGENT_NAMES[x.agent] || x.agent, st: r ? gState(r) : ['wait', 'Waiting'], id: r && r.id }; });
  return [];
}
/* A card's detail: what it was asked, what it reported, its status; a session opens from here. */
const GNODES = new Map();
function popGraphCard(el, key) {
  const n = GNODES.get(key);
  if (!n) return;
  const d = n.detail || {}, last = n.id ? gLast(n.id) : '';
  popover.className = 'popover gr-pop';
  popover.style.maxHeight = '70vh';
  popover.innerHTML = `<div class="pop-head"><span class="gr-lbl">${esc(n.label)}</span><span class="grow"></span><span class="gr-st ${n.st[0]}">${esc(n.st[1])}</span></div>
    <div class="pop-body gr-detail"><b class="gr-dtitle">${esc(n.title)}</b>${n.foot ? `<span class="dim">${esc(n.foot)}</span>` : ''}
      ${d.brief ? `<h6>Task</h6><div class="gr-dtext">${esc(d.brief)}</div>` : ''}
      ${d.result != null && d.result !== '' ? `<h6>Reported</h6><div class="msg-text gr-dtext">${mdLite(String(d.result).slice(0, 8000))}</div>` : ''}
      ${!d.result && last ? `<h6>Last answer</h6><div class="msg-text gr-dtext">${mdLite(last.slice(0, 8000))}</div>` : ''}
      ${n.id && !n.me ? `<button class="btn primary sm" data-session="${esc(n.id)}">${ic('arrow-square-out')}Open session</button>` : ''}</div>`;
  const r = zRect(el), w = Math.min(380, VW() - 16);
  popover.style.width = `${w}px`;
  popover.style.left = `${Math.round(r.left - w - 10 > 8 ? r.left - w - 10 : Math.min(r.right + 10, VW() - w - 8))}px`;
  popover.style.top = `${Math.round(Math.max(8, Math.min(r.top, VH() - 320)))}px`;
  popover.hidden = false;
}
function gLast(id) {
  const c = CHAT[id];
  const t = c && c.loaded ? [...c.ev.values()].filter((e) => e.kind === 'text').sort((a, b) => b.id - a.id)[0] : null;
  return t ? String(t.data.text) : '';
}
/* Pan + zoom: drag the canvas, wheel to zoom at the cursor, buttons, fit. The view is per session. */
function gView(id) { const g = state.gview || (state.gview = {}); return g[id] || (g[id] = { x: 0, y: 0, z: 1, fit: true }); }
function gApply(id) {
  const el = document.querySelector('#graph-tab .gr-world'), v = gView(id), z = document.querySelector('#graph-tab .gr-z');
  if (el) el.style.transform = `translate(${v.x}px,${v.y}px) scale(${v.z})`;
  if (z) z.textContent = `${Math.round(v.z * 100)}%`;
}
function gFit(id) {
  const cv = document.querySelector('#graph-tab .gr-canvas'), w = document.querySelector('#graph-tab .gr-world');
  if (!cv || !w) return;
  const v = gView(id), W = cv.clientWidth, H = cv.clientHeight, ww = w.offsetWidth, wh = w.offsetHeight;
  v.z = Math.max(0.3, Math.min(1.2, Math.min((W - 32) / ww, (H - 56) / wh)));
  v.x = (W - ww * v.z) / 2; v.y = Math.max(16, (H - 40 - wh * v.z) / 2); v.fit = true;
  gApply(id);
}
function gZoomAt(id, k, cx, cy) {
  const v = gView(id), z = Math.max(0.3, Math.min(2.5, v.z * k));
  v.x = cx - (cx - v.x) * (z / v.z); v.y = cy - (cy - v.y) * (z / v.z); v.z = z; v.fit = false;
  gApply(id);
}
let GDRAG = null;
document.addEventListener('pointerdown', (e) => {
  const cv = e.target.closest('#graph-tab .gr-canvas');
  if (!cv || e.button !== 0 || e.target.closest('.gr-tools, button')) return;
  const id = document.getElementById('graph-tab').dataset.sid, v = gView(id);
  GDRAG = { id, sx: e.clientX, sy: e.clientY, x: v.x, y: v.y, moved: false, cv, pid: e.pointerId };   // captured only once it moves: a plain click must still reach the card
});
document.addEventListener('pointermove', (e) => {
  if (!GDRAG) return;
  const dx = (e.clientX - GDRAG.sx) / ZM(), dy = (e.clientY - GDRAG.sy) / ZM();
  if (!GDRAG.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
  if (!GDRAG.moved) try { GDRAG.cv.setPointerCapture(GDRAG.pid); } catch { /* pointer gone */ }
  GDRAG.moved = true;
  const v = gView(GDRAG.id); v.x = GDRAG.x + dx; v.y = GDRAG.y + dy; v.fit = false;
  document.querySelector('#graph-tab .gr-canvas')?.classList.add('dragging');
  gApply(GDRAG.id);
});
document.addEventListener('pointerup', () => {
  if (!GDRAG) return;
  const moved = GDRAG.moved; GDRAG = null;
  document.querySelector('#graph-tab .gr-canvas')?.classList.remove('dragging');
  /* A drag that ends on a card is not a click on it. */
  if (moved) document.addEventListener('click', (ev) => { ev.stopPropagation(); ev.preventDefault(); }, { capture: true, once: true });
});
document.addEventListener('wheel', (e) => {
  const cv = e.target.closest('#graph-tab .gr-canvas');
  if (!cv) return;
  e.preventDefault();
  const r = cv.getBoundingClientRect();
  gZoomAt(document.getElementById('graph-tab').dataset.sid, Math.exp(-e.deltaY * 0.0015), (e.clientX - r.left) / ZM(), (e.clientY - r.top) / ZM());
}, { passive: false });
/* Live parts change without a full render (that would drop what is typed in the composer). */
function graphPaint(id) {
  const el = document.getElementById('graph-tab');
  if (!el || GDRAG || state.activeTab !== id || state.sideTab !== 'graph') return;
  const html = graphTab(id);
  if (html === graphPaint.last) return;
  graphPaint.last = html;
  el.outerHTML = html;
  if (gView(id).fit) gFit(id);
}
/* MODEL tab: who runs this session, its context window, where it runs, what it changed.
   Usage comes from 9router's byModel row for the selected model; context is the session meter. */
/* The context window of a model on the saved endpoint, asked once per model. */
const WINDOW = {};
function modelWindow(model, then) {
  if (!model) return null;
  if (!(model in WINDOW)) {
    WINDOW[model] = undefined;
    fetch(`/api/llm/model-info?model=${encodeURIComponent(model)}`).then((r) => r.json())
      .then((j) => { WINDOW[model] = j.context_length || null; then(); }).catch(() => { WINDOW[model] = null; });
  }
  return WINDOW[model];
}
/* Usage and context of a bubble chat, from what the agent reported at the end of each turn.
   One wrapper (#mt-usage) holds both cards, so a poll replaces them instead of adding more. */
function usageCard(id) {
  const kv = (k, v, em = '') => `<div class="mt-kv"><span>${k}</span><b class="num">${v}</b>${em ? `<em>${em}</em>` : ''}</div>`;
  const bar = (label, p, val) => `<div class="mt-q"><span>${label}</span><i style="--w:${Math.max(0, Math.min(100, p))}%"></i><b class="num">${val}</b></div>`;
  const wrap = (html) => `<div id="mt-usage" class="mt-usage">${html}</div>`;
  const empty = (t) => wrap(`<div class="mt-card"><div class="mt-h">Usage</div><p class="mt-empty">${t}</p></div>`);
  const repaint = () => { const el = document.getElementById('mt-usage'); if (el && state.activeTab === id) el.outerHTML = usageCard(id); };
  if (!bubbleChat(id)) return empty('Tokens are reported only in bubble chats; this session runs in a terminal.');
  const c = CHAT[id];
  if (!c || !c.loaded) chatPull(id).then(repaint);
  const done = c ? [...c.ev.values()].filter((e) => e.kind === 'done').sort((a, b) => a.id - b.id) : [];
  const withT = done.filter((e) => e.data.tokens);
  if (!withT.length) return empty(done.length ? 'This agent did not report tokens' : 'No turns yet. Numbers show after the first answer.');
  const sum = (k) => withT.reduce((n, e) => n + (e.data.tokens[k] || 0), 0);
  const last = withT[withT.length - 1].data.tokens;
  /* omp (context set) counts input without the cache; hermes counts it in. Hit rate on the whole prompt. */
  const inp = withT.reduce((n, e) => n + (e.data.tokens.input || 0) + (e.data.tokens.context != null ? e.data.tokens.cache_read || 0 : 0), 0), out = sum('output'), cache = sum('cache_read');
  const hit = inp ? Math.round((cache / inp) * 100) : 0;
  const secs = done.reduce((n, e) => n + (e.data.ms || 0), 0) / 1000;

  /* Context now: omp gives the size after its last call; hermes gives the last turn's input
     (exact for a turn with one call, more when it called tools). Split into what was cached,
     what was new and what it wrote, against the model's window when the endpoint lists it. */
  const run = (window.__liveRuns && window.__liveRuns.get(id)) || {};
  const model = (run.model || '').split(' · ')[0];
  const win = modelWindow(model, repaint);
  const cached = Math.min(last.cache_read || 0, last.input || 0);
  const fresh = last.context != null ? (last.input || 0) : Math.max(0, (last.input || 0) - cached);
  const wrote = last.output || 0;
  const used = cached + fresh + wrote;
  const pct = (n) => (win ? `${((n / win) * 100).toFixed(1)}%` : '');
  const parts = [['Cached prompt', cached, 'var(--accent)'], ['New input', fresh, 'var(--warning)'], ['Output', wrote, 'var(--success)']];
  const seg = (n, color) => (win && n ? `<i style="width:${(n / win) * 100}%;background:${color}"></i>` : '');
  return wrap(`<div class="mt-card">
      <div class="mt-h">Usage · ${done.length} turn${done.length === 1 ? '' : 's'} · ${secs < 60 ? `${secs.toFixed(1)}s` : `${(secs / 60).toFixed(1)} min`}</div>
      ${bar('Cache hit', hit, `${hit}%`)}
      ${kv('Input tokens', uShort(inp))}
      ${kv('Cache read', uShort(cache))}
      ${kv('Output tokens', uShort(out))}
    </div>
    <div class="mt-card ctx">
      <div class="mt-h">Context</div>
      <div class="ctx-top"><b>${win ? `${Math.round((used / win) * 100)}% used` : `${uShort(used)} used`}</b><span class="num">${uShort(used)}${win ? ` / ${uShort(win)}` : ''}</span></div>
      ${win ? `<div class="ctx-bar">${parts.map(([, n, c]) => seg(n, c)).join('')}</div>` : ''}
      ${parts.map(([k, n, c]) => `<div class="ctx-row"><i style="background:${c}"></i><span>${k}</span><b class="num">${uShort(n)}</b><em>${pct(n)}</em></div>`).join('')}
      ${win ? `<div class="ctx-row free"><i></i><span>Free space</span><b class="num">${uShort(Math.max(0, win - used))}</b><em>${pct(Math.max(0, win - used))}</em></div>` : ''}
      <p class="mt-empty">${esc(model || 'model unknown')}${win ? ` · ${uShort(win)} window` : model && WINDOW[model] === null ? ' · window not listed by the endpoint' : ''}${last.context == null ? ' · from the last turn' : ''}</p>
    </div>`);
}

/* MODEL tab: only what the hub knows about this session. No token or context meter: agents
   keep that to themselves, and a made-up number is worse than none. */
function modelTab(S, liveRun) {
  const r = liveRun || {};
  const llm = (window.LIVE && LIVE.llm) || {};
  const viaHub = (llm.agents || []).includes(r.agent);
  const g = r.branch ? GIT[r.id] : null;
  if (r.branch && !g) gitLoad(r.id).then(() => { if (state.page === 'session' && state.sideTab !== 'files' && state.sideTab !== 'terminal') render(); });
  const gd = g && g.data;
  const kv = (k, v, title = '') => `<div class="mt-kv"><span>${k}</span><b${title ? ` title="${esc(title)}"` : ''}>${v}</b></div>`;
  return `<div class="tab-scroll mt">
    ${typeof townPreview === 'function' ? townPreview(S.id) : ''}
    <div class="mt-card mt-who">
      <button class="sh-av" data-grainient data-act="town-open" data-id="${esc(S.id)}" title="Show in Town" aria-label="Show in Town">${agentLogo(r.agent || 'shell')}</button>
      <div><b>${esc(AGENT_NAMES[r.agent] || r.agent || 'Shell')}</b><span>${esc(r.status || 'idle')}</span><span>${ic('desktop')}${esc(r.device === 'local' || !r.device ? 'this hub' : r.device)}</span></div>
    </div>
    ${usageCard(r.id || S.id)}
    <div class="mt-card">
      <div class="mt-h">Session</div>
      ${kv('Started', r.created_at ? esc(new Date(r.created_at).toLocaleString()) : '—')}
      ${kv('Folder', esc(r.cwd || '—'), r.cwd)}
      ${kv('Branch', r.branch ? esc(r.branch) + (gd ? ` ← ${esc(gd.base)}` : '') : 'project folder, no branch')}
    </div>
    ${changesCard(r)}
  </div>`;
}

/* BROWSER tab: the session's headless tabs as a screencast over /browser (ws); input goes by POST.
   Fit = the page viewport is the panel's own size; presets emulate a device. */
const BR = { id: null, ws: null, img: '', url: '', w: 1280, h: 800, focused: false, tab: null, tabs: [], views: {}, tool: null, sent: '', pick: false };
/* ?brpop=<session>: this window shows only that session's browser (Open in new window). */
const BR_POP = new URLSearchParams(location.search).get('brpop');
/* A picked element goes into the chat composer as text, its screenshot as an attachment. */
function brPickText(i) {
  const st = Object.entries(i.styles || {}).map(([k, v]) => `  ${k}: ${v};`).join('\n');
  return [`Element on ${i.url}`, `selector: ${i.selector}`, i.react ? `React component: ${i.react}` : '', i.text ? `text: ${i.text}` : '',
    'html:', '```html', i.html, '```', st ? `styles:
${st}` : ''].filter(Boolean).join('\n');
}
window.brInsertPick = (text, png) => {
  const c = document.getElementById('composer');
  if (!c) return false;
  if (png) state.attached.push({ name: 'element.png', size: `${Math.max(1, Math.round(png.length * 0.75 / 1024))} KB`, img: `data:image/png;base64,${png}` });
  const typed = c.value;
  render();
  const c2 = document.getElementById('composer');
  c2.value = (typed ? typed + '\n\n' : '') + text + '\n\n';
  c2.focus(); c2.selectionStart = c2.selectionEnd = c2.value.length;
  return true;
};
const BR_PRESETS = { fit: ['Fit panel', 0, 0, false], mobile: ['Mobile', 390, 844, true], tablet: ['Tablet', 820, 1180, true], desktop: ['Desktop', 1280, 800, false], wide: ['Wide', 1920, 1080, false] };
const brView = (id) => BR.views[id] || (BR.views[id] = { mode: 'fit', w: 1280, h: 800, dark: null });
function brClose() { if (BR.ws) { BR.ws.onclose = null; BR.ws.close(); } BR.ws = null; }
const brPost = (id, body) => fetch(`/api/sessions/${id}/browser/input`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(() => {});
const brAct = (id, action, args = []) => fetch('/api/browser', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, args, session: id }) }).then((r) => r.json()).catch(() => ({}));
const brApi = (id, path, body) => fetch(`/api/sessions/${id}/browser/${path}`, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : { cache: 'no-store' }).then((r) => r.json()).catch((e) => ({ error: e.message }));
function brPanelHTML(id) {
  const v = brView(id);
  const theme = v.dark == null ? ['circle-half', 'Page theme: as the site sets it'] : v.dark ? ['moon', 'Page theme: dark'] : ['sun', 'Page theme: light'];
  return `<section class="pane br-panel" id="br-panel" data-sid="${esc(id)}">
    <div class="br-top"><div class="br-tabs" id="br-tabs">${brTabsHTML()}</div>
      <div class="br-tools">
      <button class="btn ghost xs br-vp" id="br-vp" title="Viewport" aria-label="Viewport">${ic(v.mode === 'mobile' ? 'device-mobile' : v.mode === 'tablet' ? 'device-tablet' : v.mode === 'fit' ? 'arrows-out' : 'monitor')}<span>${v.mode === 'fit' ? 'Fit' : `${v.w}×${v.h}`}</span></button>
      <button class="btn ghost xs" id="br-theme" title="${theme[1]}" aria-label="${theme[1]}">${ic(theme[0])}</button>
      <button class="btn ghost xs ${BR.pick ? 'active' : ''}" id="br-pick" title="Select an element: sends its screenshot, HTML, styles and selector to the chat" aria-label="Select an element" aria-pressed="${!!BR.pick}">${ic('cursor-click')}</button>
      <button class="btn ghost xs" id="br-shot" title="Screenshot" aria-label="Screenshot">${ic('camera')}</button>
      <button class="btn ghost xs ${BR.tool ? 'active' : ''}" id="br-tools" title="Console, network and page text" aria-label="Console, network and page text" aria-pressed="${!!BR.tool}">${ic('code')}</button>
      </div></div>
    <div class="br-bar">
      <button class="btn ghost xs" id="br-back" title="Back" aria-label="Back">${ic('arrow-left')}</button>
      <button class="btn ghost xs" id="br-fwd" title="Forward" aria-label="Forward">${ic('arrow-right')}</button>
      <button class="btn ghost xs" id="br-reload" title="Reload" aria-label="Reload">${ic('arrow-clockwise')}</button>
      <input class="br-url mono" id="br-url" placeholder="Address or port, Enter to open" aria-label="Address" spellcheck="false">
      ${BR_POP ? '' : `<button class="btn ghost xs" id="br-pop" title="Open in new window" aria-label="Open in new window">${ic('copy-simple')}</button>`}
      <button class="btn ghost xs" id="br-ext" title="Open in system browser" aria-label="Open in system browser">${ic('arrow-square-out')}</button>
    </div>
    <div class="br-stage ${v.mode === 'fit' ? 'fit' : ''} ${BR.pick ? 'picking' : ''}" id="br-stage">
      <img id="br-img" class="br-img" tabindex="0" alt="Browser tab" hidden>
      <div class="br-empty dim" id="br-empty">Type an address above. Agents use <code>xb browser --session ${esc(id)}</code></div>
    </div>
    ${BR.tool ? `<div class="br-tool">
      <div class="br-tool-head"><div class="seg">${[['console', 'Console'], ['net', 'Network'], ['text', 'Page text']].map(([k, l]) => `<button class="${BR.tool === k ? 'on' : ''}" data-brtool="${k}">${l}</button>`).join('')}</div>
        <span class="grow"></span><button class="btn ghost xs" data-brtool="close" title="Close" aria-label="Close">${ic('x')}</button></div>
      <div class="br-tool-body mono" id="br-tool-body"><div class="dim">Reading…</div></div></div>` : ''}
  </section>`;
}
function brTabsHTML() {
  return BR.tabs.map((t) => `<div class="br-tab ${t.key === BR.tab ? 'on' : ''}" data-brtab="${esc(t.key)}" title="${esc(t.url)}">
      <span>${esc(t.title || (t.url === 'about:blank' ? 'New tab' : t.url.replace(/^https?:\/\//, '')))}</span>
      ${BR.tabs.length > 1 ? `<button class="br-tab-x" data-brtabx="${esc(t.key)}" aria-label="Close tab">${ic('x')}</button>` : ''}</div>`).join('')
    + `<button class="br-tab-new" id="br-tab-new" title="New tab" aria-label="New tab">${ic('plus')}</button>`;
}
async function brTabsLoad(id) {
  const r = await brApi(id, 'tabs');
  if (r.error || BR.id !== id) return;
  const changed = r.active !== BR.tab;
  BR.tabs = r.tabs; BR.tab = r.active;
  const el = $('#br-tabs'); if (el) el.innerHTML = brTabsHTML();
  if (changed) brConnect(id, true);
}
/* The view goes to the hub only when it changed: fit sends the stage's own size. */
function brSendView(id, force) {
  const v = brView(id), st = $('#br-stage');
  if (!st) return;
  const p = BR_PRESETS[v.mode];
  const w = v.mode === 'fit' ? st.clientWidth : v.mode === 'custom' ? v.w : p[1];
  const h = v.mode === 'fit' ? st.clientHeight : v.mode === 'custom' ? v.h : p[2];
  if (w < 50 || h < 50) return;
  const body = { w, h, mobile: v.mode === 'custom' ? false : p[3], dark: v.dark, dpr: window.devicePixelRatio || 1 };
  const key = `${BR.tab}|${JSON.stringify(body)}`;
  if (!force && key === BR.sent) return;
  BR.sent = key; v.w = w; v.h = h;
  /* One resize in flight at a time; the newest size waits and goes as soon as it lands. */
  if (BR.viewBusy) { BR.viewNext = true; return; }
  BR.viewBusy = true;
  brApi(id, 'view', body).finally(() => { BR.viewBusy = false; if (BR.viewNext) { BR.viewNext = false; brSendView(id); } });
}
function brConnect(id, fresh) {
  if (fresh) { brClose(); BR.img = ''; const i = $('#br-img'); if (i) i.hidden = true; const e = $('#br-empty'); if (e) e.hidden = false; }
  if (BR.ws && BR.ws.readyState <= 1) return;
  const ws = BR.ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/browser?session=${encodeURIComponent(id)}${BR.tab ? `&tab=${encodeURIComponent(BR.tab)}` : ''}`);
  /* A socket that says nothing within 3 s (or reports an error) is replaced, so the panel never sits blank. */
  let heard = false;
  const retry = () => { if (BR.ws !== ws || BR.id !== id) return; brClose(); setTimeout(() => { if (BR.id === id && $('#br-panel')) brConnect(id); }, 300); };
  ws.onopen = () => { brSendView(id, true); setTimeout(() => { if (!heard) retry(); }, 3000); };
  ws.onclose = () => { if (BR.ws === ws) { BR.ws = null; setTimeout(() => { if (BR.id === id && $('#br-panel') && !BR.ws) brConnect(id); }, 1000); } };
  ws.onmessage = (e) => {
    heard = true;
    const m = JSON.parse(e.data);
    if (m.type === 'frame') { BR.img = `data:image/jpeg;base64,${m.data}`; BR.w = m.w || BR.w; BR.h = m.h || BR.h; const i = $('#br-img'); if (i) { i.src = BR.img; i.hidden = false; $('#br-empty').hidden = true; } }
    if (m.type === 'url') { BR.url = m.url; const u = $('#br-url'); if (u && document.activeElement !== u) u.value = m.url === 'about:blank' ? '' : m.url; setTimeout(() => brTabsLoad(id), 600); }
    if (m.type === 'error') { toast(`Browser: ${m.error}`, 'warning'); retry(); }
  };
}
/* Console / network / page text, refreshed while open. */
async function brToolPaint(id) {
  const body = $('#br-tool-body');
  if (!body || !BR.tool) return;
  const near = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
  const tm = (t) => new Date(t).toTimeString().slice(0, 8);
  if (BR.tool === 'text') { const r = await brAct(id, 'text'); body.innerHTML = `<pre class="br-text">${esc(r.text || r.error || '')}</pre>`; return; }
  const r = await brApi(id, 'logs');
  if (r.error) { body.innerHTML = `<div class="dim">${esc(r.error)}</div>`; return; }
  body.innerHTML = BR.tool === 'console'
    ? (r.console.map((l) => `<div class="br-log ${esc(l.level)}"><time>${tm(l.t)}</time><b>${esc(l.level)}</b><span>${esc(l.text)}</span></div>`).join('') || '<div class="dim">No console output yet</div>')
    : (r.net.map((n) => `<div class="br-net ${n.status === 'failed' || n.status >= 400 ? 'bad' : ''}"><b>${esc(n.method)}</b><em>${esc(n.status ?? '…')}</em><span title="${esc(n.url)}">${esc(n.url)}</span><i>${esc(n.type || '')}</i><i>${n.ms != null ? `${n.ms}ms` : ''}</i></div>`).join('') || '<div class="dim">No requests yet</div>');
  if (near) body.scrollTop = body.scrollHeight;
}
setInterval(() => { if (BR.tool && BR.tool !== 'text' && BR.id && $('#br-tool-body') && !document.hidden) brToolPaint(BR.id); }, 1500);
function brViewMenu(anchor, id) {
  const v = brView(id);
  popover.innerHTML = `<div class="pop-head"><span style="flex:1">Viewport</span></div><div class="pop-body" style="padding:4px">
    ${Object.entries(BR_PRESETS).map(([k, [l, w, h]]) => `<button class="pop-row ${v.mode === k ? 'sel' : ''}" data-brview="${k}"><span style="flex:1">${l}</span><span class="meta">${k === 'fit' ? 'panel size' : `${w}×${h}`}</span></button>`).join('')}
    <div class="pop-row br-custom" style="cursor:default"><span style="flex:1">Custom</span>
      <span class="input" style="width:64px;height:26px"><input type="number" id="br-cw" min="200" max="3840" value="${v.w}" aria-label="Width"></span>×
      <span class="input" style="width:64px;height:26px"><input type="number" id="br-ch" min="200" max="2160" value="${v.h}" aria-label="Height"></span>
      <button class="btn secondary xs" data-brview="custom">Set</button></div></div>`;
  placePopover(popover, anchor, 280);
  popover.hidden = false;
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-brview]');
  if (!b || !BR.id) return;
  const v = brView(BR.id);
  v.mode = b.dataset.brview;
  if (v.mode === 'custom') { v.w = +$('#br-cw').value || v.w; v.h = +$('#br-ch').value || v.h; }
  popover.hidden = true;
  render(); brSendView(BR.id, true);
}, true);
function brMount() {
  const root = $('#br-panel');
  if (!root) { brClose(); if (BR.ro) { BR.ro.disconnect(); BR.ro = null; } if (popover.querySelector('[data-brview]')) popover.hidden = true; BR.pick = false; return; }   // left the tab: the screencast stops with the socket
  const id = root.dataset.sid;
  if (BR.id !== id) { brClose(); Object.assign(BR, { id, img: '', url: '', tab: null, tabs: [], sent: '' }); brTabsLoad(id); }
  const img = $('#br-img'), urlIn = $('#br-url');
  img.hidden = !BR.img; $('#br-empty').hidden = !!BR.img; if (BR.img) img.src = BR.img;
  if (document.activeElement !== urlIn) urlIn.value = BR.url === 'about:blank' ? '' : BR.url;
  brConnect(id);
  if (BR.ro) BR.ro.disconnect();
  /* Follows a drag live: every size change goes out (one in flight, newest wins). */
  BR.ro = new ResizeObserver(() => brSendView(id));
  BR.ro.observe($('#br-stage'));
  const go = (action) => brAct(id, action);
  $('#br-back').onclick = () => go('back'); $('#br-fwd').onclick = () => go('forward'); $('#br-reload').onclick = () => go('reload');
  $('#br-ext').onclick = () => BR.url && BR.url !== 'about:blank' && window.open(BR.url, '_blank', 'noopener');
  /* A second click on the button closes its menu (read on pointerdown, before any outside-click handler runs). */
  const vp = $('#br-vp');
  vp.onpointerdown = () => { BR.vpOpen = !popover.hidden && !!popover.querySelector('[data-brview]'); };
  vp.onclick = (e) => { if (BR.vpOpen) { popover.hidden = true; BR.vpOpen = false; return; } brViewMenu(e.currentTarget, id); };
  $('#br-theme').onclick = () => { const v = brView(id); v.dark = v.dark == null ? false : v.dark === false ? true : null; render(); brSendView(id, true); };
  $('#br-shot').onclick = async () => {
    const r = await brAct(id, 'screenshot');
    if (!r.png) { toast(`Screenshot failed: ${r.error || 'no image'}`, 'warning'); return; }
    const a = document.createElement('a'); a.href = `data:image/png;base64,${r.png}`; a.download = `screenshot-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.png`; a.click();
    toast('Screenshot saved', 'camera');
  };
  if ($('#br-pop')) $('#br-pop').onclick = () => window.open(`${location.pathname}?brpop=${encodeURIComponent(id)}`, `xb-browser-${id}`, 'popup,width=1280,height=860');
  $('#br-pick').onclick = () => { BR.pick = !BR.pick; if (!BR.pick) brAct(id, 'unhighlight'); render(); };
  $('#br-tools').onclick = () => { BR.tool = BR.tool ? null : 'console'; render(); brToolPaint(id); };
  root.querySelectorAll('[data-brtool]').forEach((b) => { b.onclick = () => { BR.tool = b.dataset.brtool === 'close' ? null : b.dataset.brtool; render(); brToolPaint(id); }; });
  $('#br-tabs').onclick = async (e) => {
    const x = e.target.closest('[data-brtabx]'), tb = e.target.closest('[data-brtab]');
    if (e.target.closest('#br-tab-new')) { const r = await brApi(id, 'tabs', { op: 'new' }); if (!r.error) { BR.tabs = r.tabs; BR.tab = r.active; $('#br-tabs').innerHTML = brTabsHTML(); brConnect(id, true); urlIn.value = ''; urlIn.focus(); } return; }
    if (x) { const r = await brApi(id, 'tabs', { op: 'close', key: x.dataset.brtabx }); if (!r.error) { const ch = r.active !== BR.tab; BR.tabs = r.tabs; BR.tab = r.active; $('#br-tabs').innerHTML = brTabsHTML(); if (ch) brConnect(id, true); } return; }
    if (tb && tb.dataset.brtab !== BR.tab) { const r = await brApi(id, 'tabs', { op: 'activate', key: tb.dataset.brtab }); if (!r.error) { BR.tabs = r.tabs; BR.tab = r.active; BR.url = ''; $('#br-tabs').innerHTML = brTabsHTML(); brConnect(id, true); } }
  };
  urlIn.onkeydown = (e) => { if (e.key === 'Enter' && urlIn.value.trim()) { brAct(id, 'open', [urlIn.value.trim()]).then((r) => { if (r.error) toast(r.error, 'warning'); brTabsLoad(id); }); img.focus(); } };
  /* Pointer position on the frame -> page coordinates (the img letterboxes: object-fit contain). */
  /* Fit fills from the top left (object-fit: cover); presets letterbox (contain). */
  const at = (e) => {
    const r = img.getBoundingClientRect(), fit = brView(id).mode === 'fit';
    const k = fit ? Math.max(r.width / BR.w, r.height / BR.h) : Math.min(r.width / BR.w, r.height / BR.h);
    const ox = fit ? 0 : (r.width - BR.w * k) / 2, oy = fit ? 0 : (r.height - BR.h * k) / 2;
    const x = (e.clientX - r.left - ox) / k, y = (e.clientY - r.top - oy) / k;
    return x < 0 || y < 0 || x > BR.w || y > BR.h ? null : { x, y };
  };
  img.onmousedown = () => img.focus();
  img.onclick = async (e) => {
    const p = at(e);
    if (!p) return;
    if (!BR.pick) { brPost(id, { type: 'click', ...p, button: 'left' }); return; }
    BR.pick = false; render();
    const r = await brAct(id, 'pick', [p.x, p.y]);
    if (!r.info) { toast(`Nothing picked: ${r.error || 'no element'}`, 'warning'); return; }
    const text = brPickText(r.info);
    const sent = window.brInsertPick(text, r.png) || (window.opener && window.opener.brInsertPick && window.opener.brInsertPick(text, r.png));
    if (!sent) { copyText(text).catch(() => {}); toast('Element copied: paste it in a chat', 'clipboard'); }
    else toast(`<${r.info.tag}> added to the message`, 'cursor-click');
  };
  img.oncontextmenu = (e) => { e.preventDefault(); const p = at(e); if (p) brPost(id, { type: 'click', ...p, button: 'right' }); };
  let last = 0;
  img.onmousemove = (e) => { const tt = Date.now(), p = at(e); if (p && tt - last > 80) { last = tt; if (BR.pick) brAct(id, 'highlight', [p.x, p.y]); else brPost(id, { type: 'move', ...p }); } };
  img.onwheel = (e) => { e.preventDefault(); const p = at(e); if (p) brPost(id, { type: 'wheel', ...p, deltaX: e.deltaX, deltaY: e.deltaY }); };
  img.onkeydown = (e) => {
    if (BR.pick && e.key === 'Escape') { BR.pick = false; brAct(id, 'unhighlight'); render(); return; }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    e.preventDefault(); brPost(id, { type: 'key', key: e.key });
  };
  img.onpaste = (e) => { e.preventDefault(); brPost(id, { type: 'text', text: e.clipboardData.getData('text') }); };
  img.onfocus = () => { BR.focused = true; };
  img.onblur = () => setTimeout(() => { if (img.isConnected) BR.focused = false; }, 0);   // a re-render removes the node: keep focus intent
  if (BR.focused) img.focus();
  if (BR.tool) brToolPaint(id);
}

/* FILES viewer: one file of the session folder, from /api/sessions/:id/file. */
const FILEV = {};
const fileKind = (p) => {
  const e = (p.split('.').pop() || '').toLowerCase();
  return ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(e) ? 'img' : e === 'pdf' ? 'pdf' : ['mp4', 'webm'].includes(e) ? 'video' : ['mp3', 'wav'].includes(e) ? 'audio'
    : ['zip', 'gz', 'tar', 'exe', 'dll', 'bin', 'so', 'dylib', 'wasm', 'ico', 'woff', 'woff2', 'ttf', 'otf', 'db', 'sqlite', 'node'].includes(e) ? 'none' : 'text';
};
function fileViewer(id, path) {
  const url = `/api/sessions/${encodeURIComponent(id)}/file?path=${encodeURIComponent(path)}`, kind = fileKind(path), key = `${id}:${path}`;
  const head = `<div class="repo-row"><button class="btn ghost xs" data-act="file-back" title="Back to the file tree" aria-label="Back to the file tree">${ic('arrow-left')}</button><span class="mono" title="${esc(path)}">${esc(path.split('/').pop())}</span></div>`;
  let body;
  if (kind === 'img') body = `<div class="fv-media"><img src="${url}" alt="${esc(path)}"></div>`;
  else if (kind === 'pdf') body = `<iframe class="fv-pdf" src="${url}" title="${esc(path)}"></iframe>`;
  else if (kind === 'video') body = `<div class="fv-media"><video src="${url}" controls></video></div>`;
  else if (kind === 'audio') body = `<div class="fv-media"><audio src="${url}" controls></audio></div>`;
  else if (kind === 'none') body = `<div class="dim fv-none">No preview. <a href="${url}" download>Download</a></div>`;
  else {
    const f = FILEV[key];
    if (!f) {
      FILEV[key] = { loading: true };
      fetch(url, { cache: 'no-store' }).then(async (r) => {
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
        const buf = await r.arrayBuffer(), cut = buf.byteLength > 524288;
        const text = new TextDecoder().decode(buf.slice(0, 524288));
        FILEV[key] = text.includes('\0') ? { binary: true } : { text, cut };
      }).catch((err) => { FILEV[key] = { error: err.message }; }).then(() => { if (state.viewFile === path && state.sideTab === 'files') render(); });
    }
    if (!f || f.loading) body = '<div class="dim fv-none">Reading…</div>';
    else if (f.error) body = `<div class="dim fv-none">${esc(f.error)}</div>`;
    else if (f.binary) body = `<div class="dim fv-none">No preview. <a href="${url}" download>Download</a></div>`;
    else {
      const lines = f.text.split('\n');
      body = `<div class="fv-code"><pre class="fv-nums" aria-hidden="true">${lines.map((_, i) => i + 1).join('\n')}</pre><pre class="fv-text">${esc(f.text)}</pre></div>${f.cut ? '<div class="dim fv-none">Showing the first 512 KB. <a href="' + url + '" download>Download</a></div>' : ''}`;
    }
  }
  return `${head}<div class="fv-body">${body}</div>`;
}

function viewSession() {
  syncModel();
  const liveRun = window.__liveRuns && window.__liveRuns.get(state.activeTab || '');
  const panelOpen = state.filesOpen !== false;
  const tab = ['terminal', 'browser', 'files', 'graph'].includes(state.sideTab) ? state.sideTab : 'model';
  const S = sessionFor(state.activeTab || SESSION.id);

  /* A real shell for this session, on the session's device and folder. Created on first open,
     reused after; the composer's Send types into it. */
  const shellRow = ((window.LIVE && LIVE.shells) || []).find((s) => s.id === shellMap[state.activeTab]);
  const termTab = `
      <section class="pane term-panel">
        <div class="term-head">
          ${ic('terminal-window')}<span class="mono">${esc((liveRun && liveRun.device) || 'local')} · ${esc((shellRow && shellRow.cwd) || (liveRun && liveRun.cwd) || 'hub folder')}</span>
          <span class="grow"></span>
          <button class="btn ghost xs" data-act="sess-term-new" title="Start a fresh shell" aria-label="Start a fresh shell">${ic('arrow-clockwise')}</button>
        </div>
        <div class="runterm sess-term" id="sess-term"><div class="term-empty"><span>…</span></div></div>
      </section>`;

  /* FILES: the session's own worktree, read live. No branch of its own = nothing to show here. */
  const g = liveRun && liveRun.branch ? GIT[liveRun.id] : null;
  if (tab === 'files' && liveRun && liveRun.branch && !g) gitLoad(liveRun.id).then(() => { if (state.sideTab === 'files') render(); });
  const gd = g && g.data;
  const brTab = liveRun ? brPanelHTML(liveRun.id) : '<div class="dim" style="font-size:11.5px;padding:14px">Open a session to use its browser.</div>';
  const viewing = tab === 'files' && state.viewFile && liveRun;
  const filesTab = viewing ? fileViewer(liveRun.id, state.viewFile) : !liveRun || !liveRun.branch
    ? `<div class="dim" style="font-size:11.5px;padding:14px">This session works in ${esc((liveRun && liveRun.cwd) || 'the project folder')}, not on a branch of its own, so there is no change set to show.</div>`
    : !gd ? `<div class="dim" style="font-size:11.5px;padding:14px">${g && g.error ? esc(g.error) : 'Reading the worktree…'}</div>`
    : `
      <div class="repo-row">${ic('git-branch')}<span class="mono" title="${esc(liveRun.cwd)}">${esc(gd.branch)} ← ${esc(gd.base)}</span><span class="grow"></span>
        <span class="dim">${gd.stat.length} changed</span><button class="btn ghost xs" data-act="git-review" data-id="${esc(liveRun.id)}">Review</button></div>
      <div class="file-tree">${fileRows({ tree: treeFromPaths(gd.files, new Set(gd.stat.map((x) => x.file))) })}</div>
      <div class="panel-foot"><span>${gd.files.length} files${gd.dirty ? ' · uncommitted changes' : ''}${gd.ahead ? ` · ${gd.ahead} commit${gd.ahead === 1 ? '' : 's'}` : ''}</span><span class="grow"></span>
        <button class="btn ghost xs" data-act="git-refresh" data-id="${esc(liveRun.id)}" title="Read again" aria-label="Read again">${ic('arrow-clockwise')}</button></div>`;

  const side = panelOpen ? `
    <div class="splitter" role="separator" aria-orientation="vertical" title="Drag to resize"></div>
    <section class="side-panel" style="width:${state.sideW}px">
      <div class="panel-tabs">
        <button class="ptab ${tab === 'model' ? 'active' : ''}" data-ptab="model">MODEL</button>
        <button class="ptab ${tab === 'terminal' ? 'active' : ''}" data-ptab="terminal">TERMINAL</button>
        <button class="ptab ${tab === 'browser' ? 'active' : ''}" data-ptab="browser">BROWSER</button>
        <button class="ptab ${tab === 'files' ? 'active' : ''}" data-ptab="files">FILES</button>
        <button class="ptab ${tab === 'graph' ? 'active' : ''}" data-ptab="graph">GRAPH</button>
        <span class="grow"></span>
        <button class="panel-toggle" data-act="toggle-files" title="Hide panel">${ic('sidebar-simple', 'bold')}</button>
      </div>
      <div class="tab-body">
        ${tab === 'terminal' ? termTab : tab === 'browser' ? brTab : tab === 'files' ? filesTab : tab === 'graph' ? graphTab(S.id) : modelTab(S, liveRun)}
      </div>
    </section>` : '';

  const subs = bubbleChat(S.id) ? liveSubs(S.id) : [];
  const subsRun = subs.filter((a) => a.run);
  const st = subsRun.length ? 'running' : sessionStatus(S.id);
  const pct = ctxPct(S.meter);
  const busy = chatBusy(S.id) || st === 'running';
  return `<div class="session-body">
      <section class="chat-panel">
        ${sessionTabs(S)}
        ${sessHead(S, st, pct, panelOpen)}
        ${chatFindBar(S.id)}
        ${bubbleChat(S.id) ? `<div class="chat-msgs" id="chat-bubbles" ${state.chatView === 'term' ? 'hidden' : ''}>${bubblesHTML(S.id)}</div>` : ''}
        ${bubbleChat(S.id) && (state.chatView === 'term' || TERM_SEEN.has(S.id)) ? `<div class="chat-msgs chat-live" id="chat-live" ${state.chatView === 'term' ? '' : 'hidden'}><div class="runterm chat-term" id="chat-term" data-sid="${esc(S.id)}"></div></div>` : ''}
        ${agentChat(S.id) ? `<div class="chat-msgs chat-live"><div class="runterm chat-term" id="chat-term"><div class="term-empty"><span>Starting ${esc(S.agent)}…</span></div></div></div>` : ''}
        <div class="chat-msgs" ${agentChat(S.id) || bubbleChat(S.id) ? 'hidden' : ''}>${S.id === SESSION.id || !state.sent.length ? (S.id === SESSION.id ? '' : '<div class="dim" style="font-size:12px;margin:auto">Type below. This session runs a plain shell; its output is in the TERMINAL tab.</div>') : ''}
          ${S.id === SESSION.id ? `
          <div class="msg-user-block">
            <span class="msg-meta">you · 12m ago</span>
            <div class="msg-bubble">Our main deploy image is 118 MB and pushes take 3+ min. Can you shrink it without touching runtime behavior? Target is under 80 MB.</div>
          </div>

          <div class="msg-agent"><div class="msg-content">
            <p>Plan: multi-stage build, drop dev dependencies from the final layer, and prune the image after install. No runtime flags change.</p>
            <ol class="plan">${['Inspect Dockerfile + lockfile', 'Rewrite as multi-stage (builder → runner)', 'Add prune step for dev deps', 'Rebuild, compare size, run checks']
              .map((s, i) => `<li><span class="idx">${i + 1}</span>${s}</li>`).join('')}</ol>
          </div></div>

          ${worked('Worked for 1m 13s', `${3 + EDITS.length} steps · ${EDITS.length} files`, `

          <div class="msg-agent"><div class="msg-content"><div class="trace">
            ${think(9, [
              'Two stages is enough here: the runtime layer only needs node_modules and the built app, so the dev toolchain never has to ship.',
              'Pruning after install keeps the lockfile honest — pnpm --prod would also drop packages the build script imports.',
              'I will not touch the entrypoint or the healthcheck; those are the two things that break staging when they move.'
            ])}
            ${traceGroup('Ran 3 commands', [
              tool({ glyph: 'file-code', verb: 'Read', args: 'Dockerfile', meta: '12ms', out: [['1  FROM node:20', 'dim'], ['2  WORKDIR /app', 'dim'], ['3  COPY . .', 'dim'], ['4  RUN npm install', 'dim'], ['5  CMD ["node","server.js"]', 'dim']] }),
              tool({ glyph: 'terminal', verb: 'Ran', args: 'docker build -t xblabs/web .', meta: 'exit 0 · 22.4s', out: [['#4 [build 2/6] RUN pnpm install --prod', 'dim'], ['  removed 2,140 packages in 34.2s', 'dim'], ['#8 exporting to image', 'dim'], ['DONE 22.4s → 69.1MB (was 118.3MB)', 'add']] }),
              tool({ glyph: 'file-code', verb: 'Read', args: 'docker-compose.yml', meta: '9ms', out: [['18  image: xblabs/web:main', 'dim'], ['19  build: .', 'dim']] })
            ])}
          </div></div></div>

          <div class="msg-agent"><div class="msg-content"><div class="trace">
            ${EDITS.map((e) => editCard(e)).join('')}
          </div></div></div>`)}

          <div class="msg-agent"><div class="msg-content">
            <p>Edited 2 files. Runtime image now installs production deps only, and the build stage is thrown away.</p>
          </div></div>

          <div class="msg-agent"><div class="msg-content">
            <div class="size-result">
              <div class="size-col"><span class="dim">before</span><b>118.3 MB</b></div>
              ${ic('arrow-right', 'regular', 'dim')}
              <div class="size-col"><span class="dim">after</span><b class="ok">69.1 MB</b></div>
              <span class="delta-pill">-41.6%</span>
            </div>
            <p>All checks pass except e2e, still running.</p>
            <div class="reply-actions">
              <button class="btn secondary sm" data-act="view-diff">Show diff</button>
              <button class="btn secondary sm" data-act="focus">Keep exploring</button>
            </div>
          </div></div>` : ''}
          ${state.sent.map((m) => `
          <div class="msg-user-block msg-new">
            <span class="msg-meta">you · now</span>
            <div class="msg-bubble">${esc(m.text)}</div>
            ${m.files.length ? `<div class="attach-list">${m.files.map((n) => `<span class="atch">${ic('file-code')}<span>${esc(n)}</span></span>`).join('')}</div>` : ''}
          </div>`).join('')}
        </div>
        ${saStrip(S.id)}
        ${bubbleChat(S.id) && state.chatView !== 'term' ? planBox(S.id) : ''}
        <div class="composer" ${showSessionComposer(S.id) ? '' : 'style="display:none"'}>
          ${state.attached.length ? `<div class="attach-list">${state.attached.map((f, i) => `
            <span class="atch${f.img ? ' img' : ''}">${f.img ? `<img src="${f.img}" alt="">` : ic(/[.](pdf|md|txt|docx?)$/i.test(f.name) ? 'file-text' : 'file-code')}<span>${esc(f.name)}</span><b>${f.size}</b>
              <button class="atch-x" data-unattach="${i}" title="Remove">${ic('x')}</button></span>`).join('')}</div>` : ''}
          ${bubbleChat(S.id) ? approveHTML(S.id) + pickHTML(S.id) : ''}
          ${queueHTML(S.id)}
          <div class="composer-input">
            <textarea id="composer" rows="2" placeholder="${composerHint(busy)}"></textarea>
          </div>
          <div class="composer-tools">
            <button class="cicon" data-act="attach" title="Attach" aria-label="Attach">${ic('plus', 'bold')}</button>
            <button class="ctool me-btn" data-act="model-effort" title="Model and effort">${meLabel()}</button>
            <button class="ctool" data-choice-btn="approval:approval" title="${esc(APPR_HINT)}">${ic('shield-check')}<span>${esc(apprLabel(S.id))}</span>${ic('caret-down')}</button>
            <span class="grow"></span>
            ${state.attached.length ? `<span class="cmeta">${state.attached.length} attached</span>` : ''}
            ${sendBtnHTML(busy)}
          </div>
        </div>
      </section>
      ${side}
    </div>`;
}

const VIEWS = { overview: viewOverview, sessions: viewSessions, jobs: () => viewJobs(), goa: () => viewGoa(), devices: viewDevices, usage: viewUsage, logs: viewLogs, notes: viewNotes, focus: viewFocus, session: viewSession, town: () => viewTown() };

function render() {
  if (BR_POP) {
    const app = $('.app');
    if (!app.dataset.pop) { app.dataset.pop = '1'; app.innerHTML = '<main class="main brpop" id="brpop"></main>'; document.title = 'Browser · XBLabs'; }
    $('#brpop').innerHTML = brPanelHTML(BR_POP);
    brMount();
    return;
  }
  /* A tab whose session is gone (deleted, project forgotten) never falls back to the design's demo session. */
  if (state.page === 'session' && window.LIVE?.ready && !DB.sessions.some((s) => s.id === state.activeTab)) state.page = state.backPage && state.backPage !== 'session' ? state.backPage : 'sessions';
  renderTitlebar();
  renderSidebar();
  /* Only a page change animates in; poll re-renders and in-page updates stay still. */
  const entered = render.last !== state.page || render.lastTab !== state.activeTab;
  /* Opening a bubble session shows Chat; its native terminal starts hidden behind it, so switching
     is instant. Not while it is answering: the terminal cannot open on a busy conversation. */
  if (entered && state.page === 'session' && bubbleChat(state.activeTab)) {
    const r = window.__liveRuns.get(state.activeTab);
    state.chatView = 'chat';
    if (TUI_AGENTS.has(r.agent) && r.status !== 'running' && !chatBusy(state.activeTab)) TERM_SEEN.add(state.activeTab);
  }
  /* The page a session was opened from, to go back to when that session is deleted. */
  if (state.page === 'session' && render.last && render.last !== 'session') state.backPage = render.last;
  render.last = state.page; render.lastTab = state.activeTab; render.bubble = state.page === 'session' && bubbleChat(state.activeTab);
  /* A page change rebuilds (it animates in). Every other render (a poll, a filter, a tab) patches
     the page in place so nothing on it restarts or blinks. the Terminal and Focus pages keep the rebuild: their
     shells are torn down and remounted on each render. */
  const cur = $('#main .content');
  /* The chat keeps its place across re-renders; a session just opened starts at its newest message. */
  const ob = $('#chat-bubbles'), oTop = ob ? ob.scrollTop : 0, oNear = !ob || ob.scrollHeight - ob.scrollTop - ob.clientHeight < 120;
  if (entered && state.page === 'session') state.chatBottom = state.activeTab;
  if (entered || !cur || ['logs', 'focus'].includes(state.page)) $('#main').innerHTML = `<div class="content${entered ? ' enter' : ''}">${VIEWS[state.page]()}</div>`;
  else morph(cur, VIEWS[state.page]());
  if (entered && typeof pageEnter === 'function') pageEnter($('#main .content'));
  /* Drop .enter once the entrance has played: its fill-mode animations keep every card on its own
     GPU layer for as long as the class stays, and patched renders now keep the class forever. */
  if (entered) { const c = $('#main .content'); clearTimeout(render.enterT); render.enterT = setTimeout(() => c.classList.remove('enter'), 1900); }
  if (typeof alistMount === 'function') alistMount();
  if (typeof townMount === 'function') townMount();
  const nb = $('#chat-bubbles');
  if (nb) nb.scrollTo({ top: state.chatBottom === state.activeTab || oNear ? nb.scrollHeight : oTop, behavior: 'instant' });
  if (nb && CHAT[state.activeTab] && CHAT[state.activeTab].loaded) state.chatBottom = null;
  if (state.page === 'session') requestAnimationFrame(recallMark);
  if (state.page === 'session' && state.sideTab === 'graph' && gView(state.activeTab).fit) requestAnimationFrame(() => gFit(state.activeTab));
  brMount();
  /* Terminal page: each tab is one shell; mount whichever tab is active. */
  if (state.page === 'logs') {
    const el = $('#term-main');
    const id = el && !el.classList.contains('term-empty') && typeof termActive === 'function' ? termActive() : null;
    if (el && id && typeof mountTerminal === 'function') mountTerminal(id, el);
  } else if (state.page === 'session' && ($('#sess-term') || $('#chat-term')) && typeof mountTerminal === 'function') {
    /* Chat <-> Terminal only hides the terminal: a live one stays attached, nothing is replayed. */
    const chatTerm = $('#chat-term'), shell = $('#sess-term');
    const keepChat = !!chatTerm && chatTerm.__live === state.activeTab, keepShell = !!shell?.__live;
    if (!keepChat && !keepShell && window.__ptyCleanup) { window.__ptyCleanup(); window.__ptyCleanup = null; }
    if (chatTerm && !keepChat) {
      const id = state.activeTab;
      chatTerm.innerHTML = '';
      /* A hidden preload that fails is dropped quietly; the Terminal button tries again in view. */
      mountTerminal(id, chatTerm, { keep: keepShell })?.catch(() => { if (chatTerm.closest('[hidden]')) { TERM_SEEN.delete(id); render(); } });
    }
    if (!keepShell) mountSessionTerm().catch(() => {});
  } else if (state.page === 'focus' && typeof mountTerminal === 'function') {
    if (window.__ptyCleanup) { window.__ptyCleanup(); window.__ptyCleanup = null; }
    $$('[data-mount]').forEach((el) => mountTerminal(el.dataset.mount, el, { keep: true }));
  } else if (window.__ptyCleanup && overlay.hidden) {
    /* Leaving a terminal page closes its sockets; a run dialog keeps its own. */
    window.__ptyCleanup(); window.__ptyCleanup = null;
  }
}

/* ---------- overlays ---------- */
const overlay = $('#overlay');
const popover = $('#popover');
function closeAll() {
  if (window.__ptyCleanup) { window.__ptyCleanup(); window.__ptyCleanup = null; }
  overlay.hidden = true; popover.hidden = true; overlay.innerHTML = '';
}

function showModal(html, width = 520) {
  overlay.innerHTML = `<div class="modal" style="width:${width}px">${html}</div>`;
  overlay.hidden = false;
}

/* Settings → Devices popups. Cancel goes back to the Devices tab, not out of Settings. */
function modalAddHost() {
  const ts = (window.LIVE && LIVE.ts) || {};
  const peers = (ts.devices || []).filter((d) => !d.self && d.ip);
  showModal(`
    <div class="modal-head"><div class="tb"><h2>Add remote host</h2></div><button class="close-x" data-act="settings-devices">${ic('x')}</button></div>
    <div class="modal-body">
      <p class="dim" style="margin:0 0 12px;font-size:12px;line-height:1.5">A machine this hub can ssh into. Shells and runs open over ssh; for worktrees and the file browser run the XBLabs agent on it instead (Setup guide).</p>
      <div class="field"><label>Host</label><span class="input"><input id="host-addr" placeholder="hostname or IP[:port]" autocomplete="off"></span></div>
      <div class="field"><label>Act as</label><span class="input"><input id="host-user" placeholder="your user there" autocomplete="off"></span></div>
      <div class="field"><label>Name</label><span class="input"><input id="host-name" placeholder="shown in Devices · defaults to the host" autocomplete="off"></span></div>
      ${peers.length ? `<div class="s-header" style="padding:10px 0 4px">On your tailnet</div>${peers.map((d) => `
        <div class="pop-row" data-act="host-pick" data-host="${esc(d.ip)}" data-name="${esc(d.name)}">${ic('hard-drives')}<span style="flex:1" class="mono">${esc(d.name)}</span><span class="meta">${esc(d.os || '')} · ${esc(d.ip)}${d.online ? '' : ' · offline'}</span></div>`).join('')}` : ''}
    </div>
    <div class="modal-foot"><span class="sp"></span>
      <button class="btn secondary sm" data-act="settings-devices">Cancel</button>
      <button class="btn primary sm" data-act="host-save">Connect</button></div>`, 460);
  setTimeout(() => document.getElementById('host-addr')?.focus(), 30);
}
/* Connect / Update / up to date for one device. Update reuses the login that worked last time
   (user, port, key) and starts at once; the form is there to change them only if it fails. */
function conButton(name, host, online) {
  const dev = (DB.devices || []).find((x) => x.name.toLowerCase() === String(name).toLowerCase()) || {};
  const attached = hasAgent(name);
  if (attached && !dev.outdated) return `<span class="chip active" title="This device runs the same XBLabs agent this hub would install">${ic('check')}up to date</span>`;
  return `<button class="btn ${attached ? 'secondary' : 'ghost'} sm" data-act="con-open" data-name="${esc(name)}" data-host="${esc(dev.sshHost || host)}" data-port="${dev.sshPort || 22}"
    data-user="${esc(dev.sshUser || '')}" data-key="${esc(dev.sshKey || '')}" data-auto="${attached && dev.sshUser ? '1' : ''}" ${online ? '' : 'disabled'}
    title="${attached ? 'This device runs older agent code than this hub: install the new one' : 'Install the XBLabs agent over ssh'}">${ic(attached ? 'arrow-clockwise' : 'plugs-connected')}${attached ? 'Update' : 'Connect'}</button>`;
}
const hasAgent = (n) => (DB.devices || []).some((x) => x.name.toLowerCase() === String(n).toLowerCase() && x.agent === 'agent attached');
/* Connect a device from the hub: it ssh-es in and runs the one-line installer. The modal reads
   what ssh server answers first, so the form asks only what that one needs. */
const CON_KIND = {
  tailscale: ['Tailscale SSH', 'Logs in with your tailnet identity, no key. If Tailscale asks for a check, an approve button shows up here.'],
  openssh: ['OpenSSH · Linux or macOS', 'Logs in with a key from this hub (~/.ssh). Password logins are not used.'],
  windows: ['OpenSSH for Windows', 'Logs in with a key from this hub. Installs under the user, starts at logon.'],
  none: ['No ssh server on that port', 'Paste the one-line install on the device instead (Setup guide).'],
};
function modalConnect(dev) {
  const c0 = window.__con = { ...dev, id: null };
  if (!window.__sshKeys) fetch('/api/ssh/keys').then((r) => r.json()).then((k) => { window.__sshKeys = Array.isArray(k) ? k : []; }).catch(() => {});
  showModal(`
    <div class="modal-head"><div class="tb"><h2>Connect ${esc(dev.name)}</h2></div><button class="close-x" data-act="settings-devices">${ic('x')}</button></div>
    <div class="modal-body">
      <div class="kv" id="con-kind"><div class="kt"><b>Looking at ${esc(dev.host)}:${dev.port || 22}…</b><small>Reading which ssh server answers</small></div></div>
      <p class="dim" style="margin:10px 0 12px;font-size:12px;line-height:1.5">The hub logs in over ssh, installs the XBLabs agent as a service and leaves. The agent then connects back on its own. Nothing to type on the device.</p>
      <div class="row-2">
        <div class="field"><label>Log in as</label><span class="input"><input id="con-user" value="${esc(dev.user || '')}" placeholder="root, ubuntu, your user…" autocomplete="off"></span></div>
        <div class="field"><label>Key</label><span class="input"><input id="con-key" data-combo="__sshKeys" value="${esc(dev.key || '')}" placeholder="auto: tries every key in ~/.ssh" autocomplete="off"></span></div>
      </div>
      <div id="con-url"></div>
      <div class="codeblock" id="con-log" hidden style="margin-top:10px;max-height:220px;overflow:auto;white-space:pre-wrap;word-break:break-all;font-size:11px"></div>
    </div>
    <div class="modal-foot"><span class="dim" id="con-state" style="font-size:11.5px"></span><span class="sp"></span>
      <button class="btn secondary sm" data-act="settings-devices">Close</button>
      <button class="btn primary sm" data-act="con-go" id="con-go">${ic('plugs-connected')}Connect</button></div>`, 520);
  fetch(`/api/ssh/probe?host=${encodeURIComponent(dev.host)}&port=${dev.port || 22}`).then((r) => r.json()).then((j) => {
    const [t, sub] = CON_KIND[j.kind] || CON_KIND.none;
    const box = $('#con-kind');
    if (box) box.innerHTML = `<div class="kt"><b>${esc(t)}</b><small>${esc(sub)}</small></div>${j.banner ? `<span class="wsbadge mono" title="${esc(j.banner)}">${esc(j.banner.replace(/^SSH-2\.0-/, '').slice(0, 24))}</span>` : ''}`;
    if (j.kind === 'none') { const b = $('#con-go'); if (b) b.disabled = true; }
    if (j.kind === 'tailscale') { const u = $('#con-user'); if (u && !u.value) u.value = 'root'; }
    /* Update with a login that worked before: go straight away. */
    if (dev.auto && j.kind !== 'none' && window.__con === c0) $('#con-go')?.click();
  }).catch(() => {});
}
async function conPoll() {
  const c = window.__con;
  if (!c || !c.id || !$('#con-log')) return;   // modal closed: stop
  const j = await fetch(`/api/devices/connect/${c.id}`).then((r) => r.json()).catch(() => null);
  if (!j) return;
  const log = $('#con-log');
  log.hidden = false; log.textContent = j.lines.join('\n') || '…'; log.scrollTop = log.scrollHeight;
  const u = $('#con-url');
  if (u && j.url && !u.innerHTML) u.innerHTML = `<div class="kv" style="margin-top:10px"><div class="kt"><b>Tailscale wants a check</b><small>Approve this login once in the browser; the install carries on.</small></div><a class="btn primary sm" href="${esc(j.url)}" target="_blank" rel="noopener">${ic('arrow-square-out')}Approve</a></div>`;
  const st = $('#con-state');
  if (j.state === 'running') { if (st) st.textContent = 'Installing…'; setTimeout(conPoll, 1000); return; }
  const denied = j.state === 'failed' && j.lines.some((l) => /Permission denied/.test(l));
  if (st) st.textContent = j.state === 'done' ? `Agent installed${j.key ? ` · logged in with ${j.key}` : ''}`
    : denied ? 'No key in ~/.ssh is accepted for this user: check the user, or pick a key' : `Failed (exit ${j.code})`;
  const b = $('#con-go');
  if (b) {
    b.disabled = false;
    /* Done closes back to Devices; only a failure offers another go. */
    if (j.state === 'done') { b.dataset.act = 'settings-devices'; b.innerHTML = `${ic('check', 'bold')}Done`; b.previousElementSibling?.remove(); }
    else b.innerHTML = `${ic('arrow-clockwise')}Try again`;
  }
  if (j.state === 'done') { toast(`${c.name} connected`, 'check-circle'); setTimeout(() => liveLoad().then(() => render()), 2500); }
}

function modalDevGuide() {
  const ts = (window.LIVE && LIVE.ts) || {};
  const self = (ts.devices || []).find((d) => d.self);
  const hub = (self && self.ip) || '<hub tailscale ip>';
  const cmd = (c) => `<div class="codeblock" style="display:flex;align-items:center;gap:8px;margin:6px 0"><span style="flex:1;white-space:pre-wrap;word-break:break-all">${esc(c)}</span><button class="cbtn" data-act="copy-text" data-text="${esc(c)}" aria-label="Copy" title="Copy">${ic('copy')}</button></div>`;
  const step = (n, title, body) => `<div style="margin:0 0 14px"><b style="font-size:12.5px">${n}. ${title}</b><div class="dim" style="font-size:12px;line-height:1.55;margin-top:4px">${body}</div></div>`;
  showModal(`
    <div class="modal-head"><div class="tb"><h2>Set up a device</h2></div><button class="close-x" data-act="settings-devices">${ic('x')}</button></div>
    <div class="modal-body pop-scroll" style="max-height:min(70vh,640px)">
      <div class="s-header" style="padding:0 0 8px">With Tailscale (recommended)</div>
      ${step(1, 'Tailscale on both machines', 'Install Tailscale on this hub and on the device, signed in to the same account. On the hub use <b>Sign in with browser</b> in Settings → Devices.')}
      ${step(2, 'Paste one line on the device', `It fetches the agent from this hub (no git, no repo), Node.js when the device has none, and keeps the agent running as a service. No token, no open port. Run it again later to update.<br>Linux / macOS:${cmd(`curl -fsSL http://${hub}:5200/install.sh | sh`)}Windows (PowerShell):${cmd(`irm http://${hub}:5200/install.ps1 | iex`)}`)}
      ${step(3, 'Done', 'The device shows up under Devices with the agent CLIs it has (claude, hermes, …). Sign those in on the device as usual. Another name than the hostname: set <span class="mono">XBLABS_NAME</span> before the line.')}
      <div class="s-header" style="padding:4px 0 8px">Over ssh, no agent</div>
      ${step(1, 'Turn on the ssh server', `Windows (admin PowerShell):${cmd('Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0; Start-Service sshd; Set-Service sshd -StartupType Automatic')}Linux:${cmd('sudo systemctl enable --now ssh')}macOS: System Settings → General → Sharing → Remote Login.`)}
      ${step(2, 'Key login from the hub', `So runs start without a password prompt:${cmd('ssh-keygen -t ed25519')}then add the hub's public key to <span class="mono">~/.ssh/authorized_keys</span> on the device.`)}
      ${step(3, 'Add it here', 'Settings → Devices → <b>Add remote host</b>: its address and your user there.')}
      <div class="s-header" style="padding:4px 0 8px">Other networks (LAN), no Tailscale</div>
      ${step(1, 'Hub', `Listen on every interface with a shared secret. Plain ws: keep it on a network you trust.${cmd("$env:XBLABS_HOST='0.0.0.0'; $env:XBLABS_TOKEN='<secret>'; npm run dev")}`)}
      ${step(2, 'Device', `Linux / macOS:${cmd('curl -fsSL http://<hub lan ip>:5200/install.sh | XBLABS_TOKEN=<secret> sh')}Windows (PowerShell):${cmd("$env:XBLABS_TOKEN='<secret>'; irm http://<hub lan ip>:5200/install.ps1 | iex")}`)}
    </div>
    <div class="modal-foot"><span class="sp"></span><button class="btn primary sm" data-act="settings-devices">Done</button></div>`, 580);
}

function settingsTabs() {
  /* [key, label, icon, group]: the nav shows a group heading where the group changes. */
  return [['general', 'General', 'sliders-horizontal', 'App'], ['appearance', 'Appearance', 'paint-brush', 'App'],
    ['notifications', 'Notifications', 'bell', 'App'], ['commands', 'Commands', 'terminal-window', 'App'], ['privacy', 'Privacy', 'shield-check', 'App'],
    ['agents', 'Agents', 'robot', 'Agents'], ['configs', 'Accounts & configs', 'users-three', 'Agents'], ['models', 'Models & keys', 'key', 'Agents'],
    ['environment', 'Environment', 'brackets-curly', 'Agents'], ['decisions', 'Decisions', 'gavel', 'Agents'], ['goa', 'GOA', 'crown-simple', 'Agents'], ['automations', 'Automations', 'clock-clockwise', 'Agents'],
    ['devices', 'Devices', 'desktop', 'Hub'], ['storage', 'Storage', 'hard-drives', 'Hub'], ['diagnostics', 'Diagnostics', 'stethoscope', 'Hub']];
}
/* A row's title is its preference key. Switches and option buttons read their value from
   prefs and write it back on click, so every row here is either persisted or acts at once. */
function settingRow(title, sub, control) {
  const key = esc(title);
  const v = prefs[title];
  if (control.includes('data-toggle="1"')) {
    const on = v ?? control.includes('class="toggle on');
    control = toggle(on).replace('data-toggle="1"', `data-toggle="1" data-pref="${key}" aria-label="${key}"`);
  } else if (control.includes('data-opts=')) {
    if (v != null) control = control.replace(/>[^<]*(<i|<\/button>)/, `>${esc(v)}$1`);
    control = control.replace('data-opts=', `data-pref="${key}" data-opts=`);
  } else if (control.includes('<input')) {
    const def = (control.match(/value="([^"]*)"/) || [])[1] || '';
    control = control.replace('<input', `<input data-pref="${key}" aria-label="${key}"`).replace(/value="[^"]*"/, `value="${esc(v ?? def)}"`);
  }
  return `<div class="kv"><div class="kt"><b>${title}</b><small>${sub}</small></div>${control}</div>`;
}
function toggle(on) { return `<button class="toggle ${on ? 'on' : ''}" type="button" role="switch" aria-checked="${on}" data-toggle="1"></button>`; }
const opts = (list, extra = '') => `<button class="select" data-opts="${list.join('|')}"${extra}>${list[0]}${ic('caret-down')}</button>`;

/* Saved shell commands: name + command line, run in a local shell from Settings or Quick commands. */
const savedCommands = () => (Array.isArray(prefs.commands) ? prefs.commands : []);

/* Each tile renders in its own theme: scoped data-theme/data-mode give it that theme's ramp,
   accent and heading face, so the tile previews the character, not just a dot of color. */
function themeTile(p) {
  const glassOn = !!(prefs.glass && prefs.glass.on);
  return `<button class="theme-tile ${document.documentElement.dataset.theme === p.key && !glassOn ? 'active' : ''}" data-palette="${p.key}" data-theme="${p.key}" data-mode="${p.light ? 'light' : 'dark'}"
      style="--tile-bg:var(--bg-base);--tile-fg:var(--text-primary);--tile-font:var(--font-head);--tile-size:${['midnight', 'teal', 'orchid', 'porcelain', 'sage'].includes(p.key) ? '13px' : '19px'};border-radius:var(--radius-md)">
      <span class="tt-name">${p.name}</span><span class="tt-row"><i style="background:var(--accent)"></i>${p.note}</span></button>`;
}

function modalSettings(tab = state.settingsTab) {
  state.settingsTab = tab;
  if (!window.__appVer) fetch('/api/health', { cache: 'no-store' }).then((r) => r.json()).then((j) => { window.__appVer = j.version; const v = document.getElementById('app-ver'); if (v) v.textContent = `XBLabs ${j.version}`; }).catch(() => {});
  const alive = (st) => ['running', 'starting', 'waiting'].includes(st);
  const running = DB.sessions.filter((s) => s.live && alive(s.live.status)).length
    + ((window.LIVE && LIVE.shells) || []).filter((s) => alive(s.status) && !DB.sessions.some((x) => x.id === s.id)).length;
  const bodies = {
    general: `<div class="s-header" style="padding:0 0 4px">Startup and workspace</div>
      ${settingRow('Workspace name', 'Shown first in the title bar breadcrumb', '<span class="input" style="width:190px"><input value="XBLabs"></span>')}
      ${settingRow('Start page', 'Where XBLabs opens on launch', opts(Object.keys(START_PAGES)))}
      ${settingRow('Data folder', `<span class="mono" id="data-path">${esc(window.__dbPath || 'data/xblabs.db')}</span>`, '<button class="btn secondary sm" data-act="reveal">Copy path</button>')}`,
    devices: (() => {
      const ts = (window.LIVE && LIVE.ts) || { mode: 'cli', devices: [], connected: false };
      const devs = ts.devices || [];
      const on = devs.filter((d) => d.online).length;
      /* A host saved by Connect is a tailnet device: it shows (with its saved login) in that list. */
      const manual = (DB.devices || []).filter((d) => d.manual && !devs.some((t) => t.name.toLowerCase() === d.name.toLowerCase() || t.ip === d.sshHost));
      return `<div class="s-header" style="padding:0 0 6px;display:flex;align-items:center;gap:8px">Device list comes from Tailscale
        <button class="btn secondary sm" style="margin-left:auto" data-act="dev-guide">${ic('book-open')}Setup guide</button></div>
      <div class="dim" style="font-size:11.5px;margin:-2px 0 10px">Every machine in the tailnet shows up under Devices, online or not. Sign in with the Tailscale client on this hub, or paste a tailnet API key when the hub runs elsewhere.</div>
      <div class="kv"><div class="kt"><b>${ts.connected ? 'Connected' : 'Not connected'}</b>
        <small>${ts.connected ? `${esc(ts.backend || 'running')} · ${esc(ts.tailnet || 'tailnet')} · ${on}/${devs.length} online` : esc(ts.error || 'no tailnet session yet')}</small></div>
        <div style="display:flex;gap:6px;align-items:center">${ts.mode !== 'api' ? `<button class="btn ${ts.connected ? 'ghost' : 'primary'} sm" data-act="ts-login">${ic('sign-in')}${ts.connected ? 'Switch account' : 'Sign in with browser'}</button>` : ''}
        <span class="wsbadge">${ts.mode === 'api' ? 'api key' : 'cli'}</span></div></div>
      <div class="row-2" style="margin-top:10px">
        <div class="field"><label>Mode</label>
          <div class="segment" style="background:var(--bg-sunken)">
            <button class="${ts.mode !== 'api' ? 'active' : ''}" data-act="ts-mode-cli">Local client</button>
            <button class="${ts.mode === 'api' ? 'active' : ''}" data-act="ts-mode-api">API key</button>
          </div></div>
        <div class="field"><label>Tailnet</label><span class="input"><input id="ts-tailnet" placeholder="-" value="${esc(ts.tailnet === '-' ? '' : ts.tailnet || '')}"></span></div>
      </div>
      <div class="row-2">
        <div class="field"><label>SSH user</label><span class="input"><input id="ts-ssh-user" placeholder="${esc(ts.ssh_user || 'current user')}" value="${esc(ts.ssh_user || '')}"></span></div>
        <div class="field"><label>&nbsp;</label><small class="dim" style="font-size:10.5px;line-height:1.4">Shells to tailnet hosts without an agent run <b class="mono">ssh user@100.x.y.z</b> from this hub — the host just needs an sshd.</small></div>
      </div>
      <div class="row-2">
        <div class="field"><label>API key</label><span class="input"><input id="ts-key" type="password" autocomplete="off" placeholder="${ts.has_key ? esc(ts.key_hint) + ' saved — type to replace' : 'tskey-api-…'}"></span></div>
        <div class="field"><label>&nbsp;</label><div style="display:flex;gap:8px">
          <button class="btn primary sm" data-act="ts-save">Connect</button>
          <button class="btn secondary sm" data-act="ts-test">Test</button>
          <button class="btn ghost sm" data-act="ts-clear">Disconnect</button></div></div>
      </div>
      <div id="ts-status" class="dim" style="font-size:11.5px">${ts.connected ? `${devs.length} devices · ${on} online` : 'Type is saved on the hub; the API key never leaves the server.'}</div>
      <div class="s-header" style="padding:14px 0 6px">Tailnet devices</div>
      <div class="tslist">${devs.length ? devs.map((d) => `
        <div class="kv"><div class="kt"><b>${esc(d.name)}</b><small>${esc(d.os || 'unknown')} · ${esc(d.ip || 'no ip')}${d.self ? ' · this hub' : ''}</small></div>
          <div style="display:flex;gap:6px;align-items:center">${d.self || !d.ip ? '' : `${hasAgent(d.name) ? '<span class="wsbadge">agent</span>' : ''}
            ${conButton(d.name, d.ip, d.online)}`}
          <span class="chip ${d.online ? 'active' : ''}">${d.online ? 'online' : 'offline'}</span></div></div>`).join('')
        : '<div class="dim" style="font-size:11.5px">No devices yet — connect Tailscale above.</div>'}</div>
      <div class="s-header" style="padding:14px 0 6px;display:flex;align-items:center">Added by hand
        <button class="btn secondary sm" style="margin-left:auto" data-act="host-add">${ic('plus')}Add remote host</button></div>
      <div class="tslist">${manual.length ? manual.map((d) => `
        <div class="kv"><div class="kt"><b>${esc(d.name)}</b><small class="mono">${esc(d.sshUser ? d.sshUser + '@' : '')}${esc(d.sshHost)}:${d.sshPort} · ssh</small></div>
          <div style="display:flex;gap:6px;align-items:center">${hasAgent(d.name) ? '<span class="wsbadge">agent</span>' : ''}
            ${conButton(d.name, d.sshHost, true)}
          <span class="chip ${d.status === 'online' ? 'active' : ''}">${d.status === 'online' ? 'reachable' : 'unreachable'}</span>
          <button class="cbtn" data-act="host-del" data-host="${esc(d.name)}" aria-label="Remove ${esc(d.name)}" title="Remove">${ic('trash')}</button></div></div>`).join('')
        : '<div class="dim" style="font-size:11.5px">A machine reachable over ssh from this hub, with or without Tailscale.</div>'}</div>`;
    })(),
    agents: hubTab(() => {
      const H = window.__hub;
      const ids = ((window.LIVE && LIVE.llm && LIVE.llm.agent_ids) || []).filter((a) => a !== 'shell');
      return `<div class="s-header" style="padding:0 0 4px">New sessions</div>
      ${hubRow('Default agent', 'Preselected in New session and Dispatch', `<span class="input" style="width:150px"><select data-hs="session.agent" style="flex:1;border:0;background:none;color:inherit;font:inherit"><option value="">first installed</option>${ids.map((a) => `<option ${H.session.agent === a ? 'selected' : ''}>${esc(a)}</option>`).join('')}</select></span>`)}
      ${hubRow('Own worktree and branch', 'Default for new agent chats; each session can still choose', hubCheck('session.worktree', H.session.worktree))}
      ${hubRow('Hibernate after (minutes)', 'Idle sessions stop their agent to free memory and resume when opened. 0 = never', `<span class="input" style="width:80px"><input type="number" min="0" max="10080" data-hs="session.hibernateAfter" value="${H.session.hibernateAfter}"></span>`)}
      ${hubRow('Max agents at once', 'New sessions and wakes are refused above this many running agents. 0 = no limit', `<span class="input" style="width:80px"><input type="number" min="0" max="64" data-hs="session.maxAgents" value="${H.session.maxAgents}"></span>`)}
      ${hubRow('Skip permission prompts', 'Starts agents with their own flag for it (--yolo and alike). They then run commands and edit files without asking.', hubCheck('session.skipPerms', H.session.skipPerms))}
      <div class="s-header" style="padding:14px 0 4px">Agents</div>
      <div class="dim" style="font-size:11.5px;margin:-2px 0 8px">Off hides an agent everywhere. Binary replaces the command name; extra flags go after every start.</div>
      ${ids.map((a) => { const c = H.agents[a] || {}; return `<div class="kv" style="gap:8px"><div class="kt" style="min-width:90px"><b>${esc(a)}</b></div>
        ${hubCheck(`agents.${a}.enabled`, c.enabled !== false, 'On')}
        <span class="input" style="flex:1"><input data-hs="agents.${esc(a)}.bin" value="${esc(c.bin || '')}" placeholder="binary (default ${esc(a)})"></span>
        <span class="input" style="flex:1"><input data-hs="agents.${esc(a)}.flags" value="${esc(c.flags || '')}" placeholder="extra flags"></span></div>`; }).join('')}
      ${agentRegistry()}
      <div class="s-header" style="padding:14px 0 4px">Any terminal program</div>
      <div class="dim" style="font-size:11.5px;margin:-2px 0 8px">One agent per line: <span class="mono">id | Name | command</span>. It opens in the session's folder and gets the prompt typed in. Agents listed above are the ones found installed.</div>
      <span class="input" style="width:100%;height:auto"><textarea id="custom-agents" rows="3" spellcheck="false" placeholder="mycli | My CLI | mycli --fast" style="flex:1;border:0;background:none;color:inherit;font:12px var(--font-mono);resize:vertical">${esc(Object.entries(H.custom || {}).map(([id, c]) => `${id} | ${c.name} | ${c.command}`).join('\n'))}</textarea></span>
      <div style="display:flex;justify-content:flex-end;padding-top:8px"><button class="btn secondary sm" data-act="custom-save">Save custom agents</button></div>

`;
    }) + `
      ${settingRow('Kill all running agents', running ? `Stops ${running} live session${running === 1 ? '' : 's'} now` : 'Nothing is running', `<button class="btn danger sm" data-act="kill-all" ${running ? '' : 'disabled'}>Kill all</button>`)}`,
    configs: hubTab(() => {
      const H = window.__hub;
      const ids = allAgentIds();
      return `<div class="dim" style="font-size:11.5px;margin:0 0 8px">Other accounts or model APIs an agent can run on. A session on a limited config can move to the next one; the agent as installed is always first.</div>
      ${hubRow('Fall back to the next config at a limit', 'Off: a limit is only reported. On: the session moves on and carries on. <b>An API config may cost money.</b>', hubCheck('accounts.fallback', (H.accounts || {}).fallback === true))}
      ${ids.map(cfgBlock).join('')}
`;
    }),
    models: `<div class="s-header" style="padding:0 0 6px">One endpoint, for the agents you pick</div>
      <div class="dim" style="font-size:11.5px;margin:-2px 0 10px">Saved on the hub. An agent starts with its own login and config unless it is switched on below; then its runs get this endpoint as env, on local and remote devices alike.</div>
      <div class="row-2">
        <div class="field"><label>Base URL</label><span class="input"><input id="llm-base" placeholder="https://api.openai.com/v1" value="${esc((window.LIVE && LIVE.llm && LIVE.llm.base_url) || '')}"></span></div>
        <div class="field"><label>API key</label><span class="input"><input id="llm-key" type="password" autocomplete="off" placeholder="${(window.LIVE && LIVE.llm && LIVE.llm.has_key) ? esc(LIVE.llm.key_hint) + ' saved — type to replace' : 'sk-…'}"></span></div>
      </div>
      <div class="row-2">
        <div class="field"><label>Default model</label><span class="input"><input id="llm-model" data-combo="__llmAvail" autocomplete="off" placeholder="pick or type a model" value="${esc((window.LIVE && LIVE.llm && LIVE.llm.model) || '')}"></span></div>
        <div class="field"><label>&nbsp;</label><div style="display:flex;gap:8px">
          <button class="btn primary sm" data-act="llm-save">Save</button>
          <button class="btn secondary sm" data-act="llm-test">Test</button>
          <button class="btn ghost sm" data-act="llm-clear">Clear key</button></div></div>
      </div>
      <div id="llm-status" class="dim llm-status"></div>
      ${llmAgentChips()}
      ${llmEnvList()}
      <div class="mcat-head">
        <div class="mcat-title"><b>Models</b><small>Customized model catalog</small></div>
        <button class="btn ghost sm" data-act="mcat-test-all">${ic('play-circle')}Test all</button>
        <button class="btn ghost sm" data-act="mcat-reset">Restore defaults</button>
        <button class="btn ghost sm" data-act="mcat-fetch">Fetch available models</button>
      </div>
      <div class="mcat-list" id="mcat-list">${mcatRows()}</div>
      <button class="btn secondary sm mcat-add" data-act="mcat-add">${ic('plus')}Add model</button>`,
    commands: `<div class="s-header" style="padding:0 0 4px">Saved commands run in a local shell</div>
      ${savedCommands().map((c, i) => `<div class="kv" style="padding:8px 0"><div class="kt"><b>${esc(c.name)}</b><small class="mono">${esc(c.cmd)}</small></div>
          <button class="btn secondary sm" data-act="run-command" data-i="${i}">${ic('play')}Run</button>
          <button class="btn ghost sm" data-act="del-command" data-i="${i}" title="Delete command" aria-label="Delete ${esc(c.name)}">${ic('trash')}</button></div>`).join('')
        || '<div class="dim" style="font-size:11.5px;padding:6px 0 10px">No saved commands yet</div>'}
      <div class="row-2" style="margin-top:8px">
        <div class="field"><label for="cmd-name">Name</label><span class="input"><input id="cmd-name" placeholder="git status"></span></div>
        <div class="field"><label for="cmd-line">Command</label><span class="input"><input id="cmd-line" class="mono" placeholder="git status --short"></span></div>
      </div>
      <div style="display:flex;align-items:center;gap:8px;margin-top:4px"><button class="btn secondary sm" data-act="new-command">${ic('plus')}Add command</button>
        <small class="dim" style="font-size:10.5px">Also listed under Quick commands, Ctrl J</small></div>`,
    appearance: `<div class="s-header" style="padding:0 0 6px">Mode</div>
      <div class="theme-cards">${[['dark', 'Dark', 'moon'], ['light', 'Light', 'sun'], ['system', 'System', 'desktop']].map(([k, t, i]) => `<button class="theme-card ${state.themeMode === k ? 'active' : ''}" data-theme-mode="${k}">${ic(i)}${t}</button>`).join('')}</div>
      <div class="s-header" style="padding:14px 0 6px">${isLight() ? 'Light themes' : 'Dark themes'}</div>
      <div class="palette-grid" style="grid-template-columns:repeat(3,1fr)">${DB.palette.filter((p) => !!p.light === isLight()).map(themeTile).join('')}</div>
      <button class="theme-tile ${prefs.glass && prefs.glass.on ? 'active' : ''}" data-act="glass" style="width:100%;margin-top:8px;height:48px;flex-direction:row;align-items:center;justify-content:flex-start;gap:10px">
        ${ic('image')}<span class="tt-name">Liquid Glass</span><span class="dim" style="margin-left:auto;font-size:11px">${isLight() ? 'Light' : 'Dark'} · ${prefs.glass && prefs.glass.on ? 'on with your photo' : 'use a photo as wallpaper'}</span></button>
      ${settingRow('Monospace font', 'Used for terminals, logs and code', opts(['JetBrains Mono', 'Cascadia Code', 'Consolas']))}
      ${settingRow('UI scale', 'Whole window, including text · 75–150%', opts(['100%', '75%', '80%', '85%', '90%', '95%', '110%', '125%', '150%'], ' style="min-width:88px"'))}
      ${settingRow('Chat font size', 'Message text in pixels · headings and code follow this size', opts(['12px', '11px', '12.5px', '13px', '14px', '15px', '16px', '18px'], ' style="min-width:88px"'))}
      ${settingRow('Reduce motion', 'Turn off transitions and animations', toggle(false))}
      ${settingRow('Sound effects', 'Play a short sound on clicks, different for each kind of button', toggle(true))}
      ${settingRow('Sound volume', 'How loud the click sounds play', '<span class="vol-range"><input type="range" min="0" max="100" step="5" value="70"><output>' + (prefs['Sound volume'] ?? '70') + '%</output></span>')}`,
    environment: hubTab(() => `<div class="dim" style="font-size:11.5px;margin:0 0 10px;line-height:1.5">One NAME=value per line. Given to every session started on this hub, local and remote. Values are kept in the hub's database, in plain text.</div>
      <span class="input" style="height:auto;align-items:flex-start;padding:8px 10px"><textarea data-hs-env rows="10" spellcheck="false" class="mono" style="flex:1;border:0;background:none;outline:none;resize:vertical;font:inherit;font-size:12px;color:inherit" placeholder="GITHUB_TOKEN=…">${esc(Object.entries(window.__hub.env).map(([k, v]) => `${k}=${v}`).join('\n'))}</textarea></span>
`),
    goa: hubTab(() => { const G = window.__hub.goa; return `
      ${hubRow('Busy workers at most', 'More tasks wait in the queue', `<span class="input" style="width:80px"><input type="number" min="1" max="16" data-hs="goa.max" value="${G.max}"></span>`)}
      ${hubRow('Stalled after (minutes)', 'A worker that prints nothing this long is reported to the head', `<span class="input" style="width:80px"><input type="number" min="1" max="240" data-hs="goa.stallMin" value="${G.stallMin}"></span>`)}
      <div class="s-header" style="padding:14px 0 4px">My rules for GOA</div>
      <div class="dim" style="font-size:11.5px;margin:-2px 0 8px">Added under its built-in rules in AGENTS.md / CLAUDE.md. A running head reads them on its next start, or when you tell it to read AGENTS.md again.</div>
      <span class="input" style="height:auto;align-items:flex-start;padding:8px 10px"><textarea data-hs="goa.rules" rows="6" style="flex:1;border:0;background:none;outline:none;resize:vertical;font:inherit;color:inherit" placeholder="Prefer omp for frontend work. Every task ends with the tests passing.">${esc(G.rules)}</textarea></span>
`; }),
    decisions: hubTab(() => { const D = window.__hub.decide || {}, X = window.__dec; if (!X) decLoad();
      /* Same source as Models & keys, so a new default model shows here at once. */
      const L = (window.LIVE && LIVE.llm) || (X && X.llm) || null, ok = L && L.base_url && L.model; return `
      ${hubRow('Answer approvals', 'A cheap model says yes to routine, safe prompts. Dangerous commands, paths outside the session folder and anything unclear stay for you. Never the GOA head', hubCheck('decide.approve', D.approve))}
      ${hubRow('Stop loops', 'Interrupts a chat that repeats the same tool call 4 times in 8', hubCheck('decide.loop', D.loop))}
      ${hubRow('Judge', 'The LLM from Models & keys', `<span class="dim" style="font-size:12px">${!L ? 'Reading…' : ok ? esc(L.model) : 'No LLM configured — set one in Settings → Models & keys. Decisions does nothing until then'}</span>`)}

      <div class="s-header" style="padding:14px 0 4px">Last decisions</div>
      ${X && X.list.length ? X.list.map((r) => `<div class="kv"><div class="kt"><b>${esc(r.kind)} · ${esc(r.verdict || '')}</b><small>${esc((r.summary || '').replace(/\s+/g, ' ').slice(0, 90))} — ${esc(r.reason || '')}</small></div><span class="dim" style="font-size:11px">${new Date(r.at).toLocaleTimeString()}</span></div>`).join('') : `<div class="dim" style="font-size:11.5px">${X ? 'Nothing decided yet' : ''}</div>`}`; }),
    notifications: hubTab(() => `
      ${settingRow('Desktop notifications', 'A banner when a session asks for input, finishes or fails, while XBLabs is in the background', toggle(false))}
      <div class="s-header" style="padding:14px 0 4px">Sounds</div>
      ${hubRow('Notification sounds', 'A short tone when a session needs you, finishes, fails or replies. Silent in the session you are looking at', `<button class="toggle ${prefs.sound === false ? '' : 'on'}" type="button" role="switch" aria-checked="${prefs.sound !== false}" data-toggle="1" data-pref="sound" aria-label="Notification sounds"></button>`)}
      ${hubRow('Volume', 'How loud these tones play', `<span class="vol-range"><input type="range" min="0" max="100" step="5" data-pref="soundVolume" aria-label="Volume" value="${esc(prefs.soundVolume ?? 60)}"></span>`)}
      ${hubRow('Quiet hours', 'No sound between these times; may cross midnight. Leave empty for none', `<span class="input" style="width:88px"><input type="time" data-pref="quietFrom" aria-label="Quiet from" value="${esc(prefs.quietFrom || '')}"></span><span class="input" style="width:88px"><input type="time" data-pref="quietTo" aria-label="Quiet to" value="${esc(prefs.quietTo || '')}"></span>`)}
      ${hubRow('Try a sound', 'Plays at the current volume', ['done', 'input', 'error', 'chat'].map((k) => `<button class="btn secondary sm" data-snd-test="${k}">${k}</button>`).join(''))}
      <div class="s-header" style="padding:14px 0 4px">Phone</div>
      ${hubRow('Push URL', 'The hub POSTs a line here for the same events. An ntfy topic works: https://ntfy.sh/your-topic', `<span class="input" style="width:260px"><input data-hs="notify.push" value="${esc(window.__hub.notify.push)}" placeholder="https://ntfy.sh/…"></span>`)}
      <div style="display:flex;justify-content:flex-end;gap:8px;padding-top:8px"><button class="btn secondary sm" data-act="hub-test-push">Send test</button></div>`),
    diagnostics: (() => {
      const D = window.__diag;
      if (!D) { fetch('/api/health', { cache: 'no-store' }).then((r) => r.json()).then((j) => { window.__diag = j; if (state.settingsTab === 'diagnostics') openSettings('diagnostics'); }).catch(() => {}); return '<div class="dim" style="font-size:11.5px">Asking the hub…</div>'; }
      const up = D.uptimeS < 3600 ? `${Math.round(D.uptimeS / 60)} min` : `${(D.uptimeS / 3600).toFixed(1)} h`;
      return [['Hub version', D.version], ['Node', D.node], ['Process', `pid ${D.pid} · port ${D.port}`], ['Up', up], ['Running sessions', String(D.live)], ['Database', D.db], ['XBLabs folder', D.home]]
        .map(([k, v]) => `<div class="kv"><div class="kt"><b>${k}</b></div><span class="mono" style="font-size:11.5px">${esc(v)}</span></div>`).join('')
        + `<div class="s-header" style="padding:14px 0 4px">Last events</div><div class="term-body" style="max-height:200px">${((window.LIVE && LIVE.logs) || []).slice(0, 20).map((l) => `<div class="tl ${l.lvl === 'error' ? 'err' : l.lvl === 'warn' ? '' : 'd'}">${esc(`${l.t} ${l.src} ${l.msg}`)}</div>`).join('') || '<div class="tl d">nothing logged yet</div>'}</div>`;
    })(),
    automations: (() => {
      const A = window.__aut, E = window.__autEdit;
      if (!A) { autLoad(); return '<div class="dim" style="font-size:11.5px">Reading automations…</div>'; }
      if (A.error) return `<div class="dim" style="font-size:11.5px">${esc(A.error)}</div>`;
      const ok = [...TUI_AGENTS].filter((a) => agentState('local', a) !== 'missing');
      const editor = E ? `<div class="aut-edit card">
        <div class="aut-grid">
          <label>Name<span class="input"><input id="aut-name" value="${esc(E.name)}" maxlength="60" placeholder="Nightly dependency bump"></span></label>
          <label>Agent<span class="input"><select id="aut-agent">${ok.map((a) => `<option value="${a}" ${a === E.agent ? 'selected' : ''}>${esc(AGENT_NAMES[a] || a)}</option>`).join('')}</select></span></label>
          <label class="aut-wide">Project folder<button class="select" data-act="aut-folder" style="width:100%;min-width:0" title="${esc(E.cwd)}"><span style="flex:1;text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(E.cwd || 'Pick a folder on this hub')}</span>${ic('folder-open')}</button></label>
          <div class="aut-wide"><span class="aut-l">Days</span><div class="aut-days">${AUT_DAYS.map((n, i) => `<button class="picker ${E.days.includes(i) ? 'on' : ''}" data-act="aut-day" data-day="${i}" aria-pressed="${E.days.includes(i)}">${n}</button>`).join('')}</div></div>
          <label>Time <small class="dim">(hub clock)</small><span class="input"><input id="aut-time" type="time" value="${esc(E.time)}"></span></label>
          <label class="aut-wide">Prompt<span class="input" style="height:84px;align-items:flex-start;padding:8px 10px"><textarea id="aut-prompt" maxlength="8000" style="flex:1;border:0;background:none;outline:none;resize:none;font:inherit;color:inherit" placeholder="What the agent does on every run">${esc(E.prompt)}</textarea></span></label>
        </div>
        <div style="display:flex;gap:6px;justify-content:flex-end"><button class="btn secondary sm" data-act="aut-cancel">Cancel</button><button class="btn primary sm" data-act="aut-save">${ic('check')}Save</button></div></div>` : '';
      return `<div class="s-header" style="padding:0 0 4px;display:flex;align-items:center;gap:8px;min-height:30px">Scheduled prompts<span class="grow"></span>${E ? '' : `<button class="btn secondary xs" data-act="aut-new">${ic('plus')}New automation</button>`}</div>
      <div class="dim" style="font-size:11.5px;margin:2px 0 10px;line-height:1.5">Each run is a new session on its own branch of the project (Git with a first commit needed), so you review and merge it like any other. A run missed while the hub is off is skipped.</div>
      ${editor}
      ${A.list.map((a) => settingRow(esc(a.name),
        `${autWhen(a)} · ${esc(AGENT_NAMES[a.agent] || a.agent)} · <span class="mono">${esc(a.cwd)}</span>${a.last ? ` · ${a.last.error ? `<span style="color:var(--danger)">not started: ${esc(a.last.error)}</span>` : `last run ${new Date(a.last.at).toLocaleString()}`}` : ''}`,
        `<button class="toggle ${a.enabled ? 'on' : ''}" type="button" role="switch" aria-checked="${a.enabled}" aria-label="${esc(a.name)} on" data-act="aut-on" data-id="${a.id}"></button>
         <button class="btn secondary sm" data-act="aut-run" data-id="${a.id}" title="Start a run now, whatever the schedule">${ic('play')}Run now</button>
         <button class="btn ghost sm icon-only" data-act="aut-edit" data-id="${a.id}" title="Edit" aria-label="Edit ${esc(a.name)}">${ic('pencil-simple')}</button>
         <button class="btn ghost sm icon-only" data-act="aut-del" data-id="${a.id}" title="Delete" aria-label="Delete ${esc(a.name)}">${ic('trash')}</button>`)).join('')
        || (E ? '' : '<div class="dim" style="font-size:11.5px">No automations yet.</div>')}`;
    })(),
    storage: (() => {
      const W = window.__worktrees;
      if (!W) { wtLoad(); return '<div class="dim" style="font-size:11.5px">Reading worktrees…</div>'; }
      if (W.error) return `<div class="dim" style="font-size:11.5px">${esc(W.error)}</div>`;
      const orphans = W.list.filter((w) => !w.session);
      return `<div class="s-header" style="padding:0 0 4px">Folder</div>
      ${settingRow('Session worktrees', `New ones go to <span class="mono">${esc(W.home)}</span>${W.custom ? '' : ' (default)'}. Ones made before a change stay where they are and stay listed.`,
        `<button class="btn secondary sm" data-act="wt-root">${ic('folder-open')}Change…</button>${W.custom ? '<button class="btn ghost sm" data-act="wt-root-default">Use default</button>' : ''}`)}
      <div class="s-header" style="padding:14px 0 4px;display:flex;align-items:center;gap:8px;min-height:30px">Worktrees<span class="grow"></span>${orphans.length ? `<button class="btn danger xs" data-act="wt-orphans" title="Delete the folder and branch of every worktree whose session is gone">${ic('trash')}Remove ${orphans.length} without a session</button>` : ''}</div>
      <div class="dim" style="font-size:11.5px;margin:6px 0 10px;line-height:1.5">One folder and branch per session. Removing one deletes its folder and its xb/ branch, and any work in it that was not merged or pushed. Commits already merged into your project stay.</div>
      ${W.list.map((w) => settingRow(
        w.session ? `${esc(w.session.title)}` : `${esc(w.id)} · no session`,
        `<span class="mono">${esc(w.repo)} / xb/${esc(w.id)}</span> · ${w.session ? `${esc(w.session.agent)} · ${esc(w.session.status)} · ` : ''}${new Date(w.modified).toLocaleDateString()}`,
        w.session && w.session.live ? '<span class="dim" style="font-size:11px">running</span>'
          : `<button class="btn danger sm" data-act="wt-remove" data-id="${esc(w.id)}">Remove</button>`)).join('')
        || '<div class="dim" style="font-size:11.5px">No worktrees yet.</div>'}`;
    })(),
    privacy: `<div class="s-header" style="padding:0 0 4px">What this hub keeps</div>
      <div class="dim" style="font-size:11.5px;margin:-2px 0 10px;line-height:1.5">Sessions, terminal output and notes live in the hub's sqlite file. Nothing leaves this machine except the runs you dispatch and calls to the LLM endpoint you set.</div>
      ${settingRow('Clear all local data', 'Removes every session, terminal log, note and log event on this hub', '<button class="btn danger sm" data-act="clear-data">Clear</button>')}`
  };
  const resettable = ['general', 'agents', 'appearance'].includes(tab);
  return `<div class="modal settings">
    <div class="settings-nav">
      <div class="stitle">Settings</div>
      ${settingsTabs().map(([k, l, i, g], n, all) => `${n === 0 || all[n - 1][3] !== g ? `<div class="snav-group">${g}</div>` : ''}<button class="snav ${tab === k ? 'active' : ''}" data-stab="${k}">${ic(i, tab === k ? 'fill' : 'regular')}${l}</button>`).join('')}
      <div class="plan-card"><small>App version</small><b id="app-ver">XBLabs ${esc(window.__appVer || '…')}</b></div>
    </div>
    <div class="settings-pane">
      <div class="settings-head"><div><b>${settingsTabs().find((t) => t[0] === tab)[1]}</b><small>${{
        general: 'Startup and workspace',
        agents: 'How runs behave across this workspace', configs: 'Other accounts and model APIs per agent', devices: 'The tailnet is the device list', models: 'One LLM endpoint inherited by every run',
        commands: 'Saved shell commands',
        appearance: 'Mode, theme and type', storage: 'Session worktrees on this hub', privacy: 'Local data on this hub',
        environment: 'Variables for every session on this hub', goa: 'The head agent and its workers',
        notifications: 'When an agent needs you or is done', decisions: 'A cheap model answers safe approvals, every call logged', diagnostics: 'This hub, now'
      }[tab]}</small></div><button class="close-x" data-act="close" aria-label="Close settings">${ic('x')}</button></div>
      <div class="settings-body">${bodies[tab]}</div>
      <div class="settings-foot"><span>Changes apply at once and stay on this machine</span><span class="sp"></span>
        ${resettable ? `<button class="btn secondary sm" data-act="reset-tab" data-reset="${tab}">Reset this tab</button>` : ''}${['agents', 'configs', 'environment', 'goa', 'decisions', 'notifications'].includes(tab) ? '<button class="btn primary sm" data-act="hub-save">Save</button>' : '<button class="btn primary sm" data-act="close">Done</button>'}</div>
    </div>
  </div>`;
}

/* Re-opening Settings while it is open (a tile or switch was clicked) keeps it still and keeps
   the body's scroll; only a fresh open animates. */
/* Hub-side settings (Sessions, Agents, Environment, GOA, Notifications): loaded once, saved by
   the tab's Save button from every [data-hs] field. */
/* Only a real settings object is kept: an error reply (an older hub) must never stand in for
   settings, or every reader of window.__hub.session breaks. A failure is remembered so the tab
   says why instead of asking again on every render. */
async function hubLoad() {
  try {
    const r = await fetch('/api/hub-settings', { cache: 'no-store' });
    const j = await r.json().catch(() => ({}));
    if (r.ok && j && j.session) { window.__hub = j; window.__hubErr = null; }
    else window.__hubErr = r.status === 404 || j.error === 'no such endpoint' ? OLD_HUB : (j.error || `HTTP ${r.status}`);
  } catch (err) { window.__hubErr = String(err.message || err); }
  if (overlay.querySelector('.modal.settings')) openSettings(state.settingsTab);
}
const OLD_HUB = 'The running hub is older than this page. Restart it (stop it, then npm run dev) and reload.';
const hubTab = (body) => (window.__hub ? body()
  : window.__hubErr ? `<div class="dim" style="font-size:11.5px">${esc(window.__hubErr)}</div>`
  : (hubLoad(), '<div class="dim" style="font-size:11.5px">Reading hub settings…</div>'));
const hubRow = (title, sub, control) => `<div class="kv"><div class="kt"><b>${title}</b><small>${sub}</small></div>${control}</div>`;
const hubCheck = (path, on, label = '') => `<label style="display:flex;align-items:center;gap:6px;font-size:12px"><input type="checkbox" data-hs="${esc(path)}" ${on ? 'checked' : ''}>${esc(label)}</label>`;
async function hubSave() {
  const patch = {};
  for (const el of overlay.querySelectorAll('[data-hs]')) {
    const path = el.dataset.hs.split('.');
    let o = patch;
    for (const k of path.slice(0, -1)) o = o[k] ??= {};
    o[path.at(-1)] = el.type === 'checkbox' ? el.checked : el.value;
  }
  const env = overlay.querySelector('[data-hs-env]');
  if (env) {
    patch.env = {};
    for (const line of env.value.split('\n')) {
      const i = line.indexOf('=');
      if (line.trim() && i > 0) patch.env[line.slice(0, i).trim()] = line.slice(i + 1);
    }
  }
  const r = await fetch('/api/hub-settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) })
    .then((x) => x.json()).catch((err) => ({ error: err.message }));
  if (r.error) { toast(`Not saved: ${r.error}`, 'warning'); return; }
  window.__hub = r;
  toast('Saved on the hub');
  return true;
  await liveLoad();
  openSettings(state.settingsTab);
}

/* Every agent XBLabs can start, installed or not: what is here and how each one runs. */
function regCard() {
  const list = window.__reg || [], on = list.filter((a) => a.installed);
  return `<div class="card ov-reg"><div class="card-body" style="display:flex;flex-direction:column;gap:10px;padding:14px">
    <div style="display:flex;align-items:center;gap:8px;height:22px"><b style="font-size:14px;font-weight:600">Agents</b>
      <span class="wsbadge">${window.__reg ? `${on.length} / ${list.length}` : '…'}</span><span style="flex:1"></span>
      <span class="link" data-act="open-agents" style="color:var(--text-secondary);font-size:11px">Registry ${ic('caret-right')}</span></div>
    <div class="reg-chips">${list.map((a) => `<span class="reg-chip ${a.installed ? '' : 'off'}" title="${esc(a.bin)} · ${a.installed ? esc(a.version || 'installed') : 'not installed'}">${agentLogo(a.id)}${esc(a.name)}</span>`).join('') || `<span class="dim" style="font-size:11.5px">${window.__reg ? 'No agents known.' : 'Reading…'}</span>`}</div>
  </div></div>`;
}
function agentRegistry() {
  const R = window.__reg;
  if (!R) { fetch('/api/agents/registry', { cache: 'no-store' }).then((r) => r.json()).then((j) => { window.__reg = Array.isArray(j) ? j : []; if (state.settingsTab === 'agents' && overlay.querySelector('.modal.settings')) openSettings('agents'); }).catch(() => { window.__reg = []; }); }
  const list = R || [], on = list.filter((a) => a.installed).length;
  const tag = (ok, label, tip) => (ok ? `<span class="wsbadge" title="${tip}">${label}</span>` : '');
  return `<details class="reg" open><summary><span class="s-header" style="padding:0">Agent registry</span><span class="dim">${R ? `${list.length} known · ${on} installed here` : 'Reading…'}</span>${ic('caret-down')}</summary>
    <div class="dim" style="font-size:11.5px;margin:4px 0 8px">Every agent XBLabs can start. Install one and it shows up in New session and Dispatch on its own.</div>
    <div class="reg-list">${list.map((a) => `<div class="reg-row ${a.installed ? 'on' : ''}"><i class="reg-dot"></i>${agentLogo(a.id)}<span class="reg-nm"><b>${esc(a.name)}</b><span class="mono dim">${esc(a.bin)}</span></span>
      <span class="reg-tags">${tag(a.oneShot, 'one-shot', 'Runs a single prompt and exits (jobs)')}${tag(a.typed, 'typed', 'Opens bare; XBLabs types the prompt in')}${tag(a.endpoint, 'endpoint', 'Can use the hub LLM endpoint')}${tag(a.custom, 'custom', 'Added by you')}</span>
      <span class="reg-st">${a.installed ? esc(a.version || 'installed') : 'not installed'}</span></div>`).join('')}</div></details>`;
}
/* Agent configs (other accounts / model APIs), official first per agent. The hub never sends a key. */
async function cfgLoad() {
  window.__cfgs = await fetch('/api/agent-configs', { cache: 'no-store' }).then((r) => r.json()).then((j) => (Array.isArray(j) ? j : [])).catch(() => []);
  if (['agents', 'configs'].includes(state.settingsTab) && overlay.querySelector('.modal.settings')) openSettings(state.settingsTab);
  nsConfigs();
}
const cfgsOf = (a) => (window.__cfgs || []).filter((c) => c.agent === a);
const cfgName = (a, id) => (id ? (cfgsOf(a).find((c) => c.id === id) || {}).name || '' : '');
const cfgCall = (path, method, body) => fetch(path, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) }).then((r) => r.json()).catch((err) => ({ error: err.message }));
const hhmm = (t) => new Date(t).toTimeString().slice(0, 5);
function cfgBlock(a) {
  if (!window.__cfgs) cfgLoad();
  const rows = cfgsOf(a), can = ['claude', 'codex'].includes(a), idf = (k) => `cfg-${a}-${k}`;
  const lim = (c) => (c.limited_until > Date.now() ? `<span class="wsbadge" style="color:var(--warning)">limited until ${hhmm(c.limited_until)}</span><button class="btn ghost sm" data-act="cfg-clear" data-id="${esc(c.id)}" data-agent="${esc(a)}">Clear</button>` : '');
  const own = rows.filter((c) => c.id);
  return `<div class="kv" style="gap:8px;align-items:flex-start"><div class="kt cfg-ag ${agentInstalled(a) ? '' : 'off'}" style="min-width:150px"><b>${agentLogo(a)}${esc(AGENT_NAMES[a] || a)}</b><small>${own.length ? `${own.length} config${own.length === 1 ? '' : 's'}` : agentInstalled(a) ? 'as installed only' : 'not installed'}</small></div>
    <div style="flex:1;display:flex;flex-direction:column;gap:6px">
      ${rows.map((c) => `<div style="display:flex;align-items:center;gap:6px;font-size:12px">
        <b>${esc(c.name)}</b><span class="wsbadge">${c.id ? esc(c.kind) : 'as installed'}</span><span class="dim" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(c.model || c.config_dir || c.base_url || '')}</span>${lim(c)}
        ${c.id ? `<button class="btn ghost sm icon-only" data-act="cfg-up" data-id="${esc(c.id)}" data-agent="${esc(a)}" aria-label="Higher priority" ${own[0] === c ? 'disabled' : ''}>${ic('arrow-up')}</button>
        <button class="btn ghost sm icon-only" data-act="cfg-down" data-id="${esc(c.id)}" data-agent="${esc(a)}" aria-label="Lower priority" ${own.at(-1) === c ? 'disabled' : ''}>${ic('caret-down')}</button>
        <input type="checkbox" data-act="cfg-toggle" data-id="${esc(c.id)}" ${c.enabled ? 'checked' : ''} aria-label="Enabled" title="Enabled">
        <button class="btn ghost sm icon-only" data-act="cfg-del" data-id="${esc(c.id)}" aria-label="Delete config">${ic('trash')}</button>` : ''}</div>`).join('')}
      <details class="cfg-add"><summary>${ic('plus')}Add config</summary><div style="display:flex;gap:6px;flex-wrap:wrap;padding-top:6px">
        <span class="input" style="width:100px"><input id="${idf('name')}" placeholder="name"></span>
        <span class="input" style="width:90px"><select id="${idf('kind')}" style="flex:1;border:0;background:none;color:inherit;font:inherit"><option value="api">api</option>${can ? '<option value="account">account</option>' : ''}</select></span>
        <span class="input" style="flex:1;min-width:140px"><input id="${idf('url')}" placeholder="base URL (api)"></span>
        <span class="input" style="width:110px"><input id="${idf('model')}" placeholder="model"></span>
        <span class="input" style="width:110px"><input id="${idf('key')}" type="password" autocomplete="off" placeholder="API key"></span>
        <span class="input" style="flex:1;min-width:140px"><input id="${idf('dir')}" placeholder="config dir (account)"></span>
        <button class="btn secondary sm" data-act="cfg-add" data-agent="${esc(a)}">Add</button></div></details>
    </div></div>`;
}
async function decLoad() {
  try {
    const [llm, list] = await Promise.all(['/api/llm', '/api/decisions?limit=20'].map((u) => fetch(u, { cache: 'no-store' }).then((r) => r.json())));
    window.__dec = { llm: llm || {}, list: Array.isArray(list) ? list : [] };
  } catch { window.__dec = { llm: {}, list: [] }; }
  if (state.settingsTab === 'decisions' && overlay.querySelector('.modal.settings')) openSettings('decisions');
}
async function wtLoad() {
  try { window.__worktrees = await fetch('/api/worktrees', { cache: 'no-store' }).then((r) => r.json()); }
  catch (err) { window.__worktrees = { error: err.message }; }
  if (state.settingsTab === 'storage' && overlay.querySelector('.modal.settings')) openSettings('storage');
}
/* Automations: the list lives on the hub (it runs them); the editor is a draft until Save. */
const AUT_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function autWhen(a) {
  const d = a.days.join();
  return `${d === '1,2,3,4,5' ? 'Weekdays' : d === '0,1,2,3,4,5,6' ? 'Every day' : d === '0,6' ? 'Weekends' : a.days.map((i) => AUT_DAYS[i]).join(', ')} ${esc(a.time)}`;
}
async function autLoad() {
  try { window.__aut = await fetch('/api/automations', { cache: 'no-store' }).then((r) => r.json()); }
  catch (err) { window.__aut = { error: err.message }; }
  if (state.settingsTab === 'automations' && overlay.querySelector('.modal.settings')) openSettings('automations');
}
function autRead() {
  const E = window.__autEdit;
  if (!E || !$('#aut-name')) return;
  Object.assign(E, { name: $('#aut-name').value.trim(), agent: $('#aut-agent').value, time: $('#aut-time').value, prompt: $('#aut-prompt').value.trim() });
}
async function autPut(list, said) {
  const r = await fetch('/api/automations', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ list }) })
    .then((x) => x.json()).catch((err) => ({ error: err.message }));
  if (r.error) { toast(`Not saved · ${r.error}`, 'warning'); return false; }
  window.__aut = { list: r.list }; window.__autEdit = null;
  if (said) toast(said, 'check');
  openSettings('automations');
  return true;
}
/* Every worktree whose session is gone, one after another; a second click confirms. */
async function wtOrphans(btn) {
  const ids = ((window.__worktrees || {}).list || []).filter((w) => !w.session).map((w) => w.id);
  if (!ids.length) return;
  if (!btn.dataset.armed) { btn.dataset.armed = '1'; btn.innerHTML = `${ic('trash')}Click again: deletes ${ids.length} folders and branches`; return; }
  btn.disabled = true;
  let ok = 0; const bad = [];
  for (const id of ids) {
    btn.innerHTML = `${ic('spinner-gap')}Removing ${ok + bad.length + 1} / ${ids.length}`;
    const r = await fetch(`/api/worktrees/${encodeURIComponent(id)}`, { method: 'DELETE' }).then((x) => x.json()).catch((err) => ({ error: err.message }));
    if (r.error) bad.push(`${id}: ${r.error}`); else ok++;
  }
  toast(bad.length ? `Removed ${ok}, ${bad.length} not removed · ${bad[0]}` : `Removed ${ok} worktrees and their branches`, bad.length ? 'warning' : 'check-circle');
  window.__worktrees = null; openSettings('storage');
}
/* Where new worktrees go: picked with the folder browser, checked by the hub. */
async function wtRoot(path) {
  const r = await fetch('/api/storage', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ worktrees: path }) })
    .then((x) => x.json()).catch((err) => ({ error: err.message }));
  toast(r.error ? `Folder not changed: ${r.error}` : `New worktrees go to ${r.root}`, r.error ? 'warning' : 'check-circle');
  window.__worktrees = null; openSettings('storage');
}
async function wtRemove(btn) {
  if (!btn.dataset.armed) { btn.dataset.armed = '1'; btn.textContent = 'Click again to delete'; return; }
  btn.disabled = true;
  const r = await fetch(`/api/worktrees/${encodeURIComponent(btn.dataset.id)}`, { method: 'DELETE' }).then((x) => x.json()).catch((err) => ({ error: err.message }));
  toast(r.error ? `Not removed: ${r.error}` : r.said, r.error ? 'warning' : 'check-circle');
  delete GIT[btn.dataset.id];
  await liveLoad();
  wtLoad();
}

function openSettings(tab) {
  const open = overlay.querySelector('.modal.settings');
  const sameTab = open && state.settingsTab === (tab || state.settingsTab);
  const scroll = sameTab ? (overlay.querySelector('.settings-body') || {}).scrollTop || 0 : 0;
  overlay.innerHTML = modalSettings(tab || state.settingsTab);
  overlay.hidden = false;
  /* Models & keys shows what the hub holds now, not what this page loaded: a stale form saved back would overwrite it. */
  /* The Default model field offers the catalog plus what the endpoint serves (data-combo list). */
  if (state.settingsTab === 'models' && !sameTab) fetch('/api/llm/models/available', { cache: 'no-store' }).then((r) => r.json()).then((j) => {
    const cat = ((window.LIVE && LIVE.llm && LIVE.llm.models) || []).map((m) => m && m.id).filter(Boolean);
    window.__llmAvail = [...new Set([...cat, ...(Array.isArray(j.models) ? j.models : [])])];
    const f = document.activeElement;
    if (f && f.dataset && f.dataset.combo === '__llmAvail') comboOpen(f);   // focused before the list arrived
  }).catch(() => {});
  if (state.settingsTab === 'models' && !sameTab) fetch('/api/llm', { cache: 'no-store' }).then((r) => r.json()).then((j) => {
    if (window.LIVE && JSON.stringify(j) !== JSON.stringify(LIVE.llm)) { LIVE.llm = j; if (state.settingsTab === 'models') openSettings('models'); }
  }).catch(() => {});
  if (open) overlay.querySelector('.modal').classList.add('stay');
  if (scroll) overlay.querySelector('.settings-body').scrollTop = scroll;
}
/* Theme and mode changes reveal from the last click point where View Transitions exist. */
document.addEventListener('pointerdown', (e) => { const r = document.documentElement.style; r.setProperty('--vx', e.clientX / ZM() + 'px'); r.setProperty('--vy', e.clientY / ZM() + 'px'); }, true);
function withTransition(fn) {
  const root = document.documentElement;
  if (document.startViewTransition && !root.hasAttribute('data-reduce-motion') && !root.hasAttribute('data-glass')) document.startViewTransition(fn);
  else fn();
}

/* Liquid Glass: the user's photo behind the shell, panels frosted over it. The image is
   downscaled to 2560px JPEG before it is stored, so it fits in localStorage. */
let glassDraft = null;
const GLASS_FIT = { Fill: 'cover', Fit: 'contain', Stretch: '100% 100%' };
function modalGlass(draft) {
  glassDraft = draft || { on: true, panel: 72, blur: 18, dim: 24, fit: 'Fill', ...(prefs.glass || {}) };
  const g = glassDraft;
  const range = (k, label, min, max, unit) => `<label class="glass-range"><span>${label}<output id="gv-${k}">${g[k]}${unit}</output></span>
    <input type="range" min="${min}" max="${max}" value="${g[k]}" data-glass-range="${k}" data-unit="${unit}"></label>`;
  showModal(`
    <div class="modal-head"><div class="tb"><h2>Liquid Glass</h2><p>Your photo behind the app, panels frosted over it</p></div>
      <button class="close-x" data-act="close" aria-label="Close">${ic('x')}</button></div>
    <div class="modal-body" style="flex-direction:row;gap:20px">
      <div style="width:360px;flex:none;display:flex;flex-direction:column;gap:10px">
        <div class="s-header" style="padding:0">Preview</div>
        <div id="glass-preview" style="flex:1;min-height:260px;border-radius:var(--radius-lg);border:1px solid var(--border);display:flex;align-items:center;justify-content:center;padding:24px;background:var(--bg-sunken) center no-repeat">
          <div id="glass-sample" class="card" style="width:100%;padding:14px;display:flex;flex-direction:column;gap:8px">
            <b style="font-size:12px">Runs per day</b><div style="display:flex;align-items:flex-end;gap:6px;height:48px">${[30, 52, 24, 70, 44, 90].map((h, i) => `<i style="flex:1;height:${h}%;background:${i === 5 ? 'var(--accent)' : 'color-mix(in srgb, var(--text-primary) 18%, transparent)'};border-radius:2px"></i>`).join('')}</div>
          </div>
        </div>
      </div>
      <div style="flex:1;display:flex;flex-direction:column;gap:14px">
        <div class="s-header" style="padding:0">Photo</div>
        <div style="display:flex;gap:10px;align-items:center">
          <div class="glass-thumb" style="${g.img ? `background-image:url('${g.img}')` : ''}"></div>
          <div style="flex:1;display:flex;flex-direction:column;gap:4px"><b style="font-size:12px">${esc(g.name || (g.img ? 'Saved photo' : 'No photo yet'))}</b>
            <small class="dim" style="font-size:10.5px">JPG, PNG or WebP · stored on this machine</small>
            <div style="display:flex;gap:6px;margin-top:2px"><button class="btn xs secondary" data-act="glass-replace">${g.img ? 'Replace' : 'Choose photo'}</button>${g.img ? '<button class="btn xs ghost" data-act="glass-remove">Remove</button>' : ''}</div></div>
        </div>
        ${range('panel', 'Panel opacity', 30, 95, '%')}
        ${range('blur', 'Blur', 0, 40, ' px')}
        ${range('dim', 'Photo dim', 0, 70, '%')}
        <div class="s-header" style="padding:2px 0 0">Photo fit</div>
        <div class="segment" style="align-self:flex-start;background:var(--bg-sunken)">${Object.keys(GLASS_FIT).map((t) => `<button data-glass-fit="${t}" class="${g.fit === t ? 'active' : ''}">${t}</button>`).join('')}</div>
      </div>
    </div>
    <div class="modal-foot"><small class="dim" style="font-size:10.5px">Tint follows the current theme's accent</small><span class="sp"></span>
      ${prefs.glass && prefs.glass.on ? '<button class="btn secondary sm" data-act="glass-off">Turn off</button>' : ''}
      <button class="btn primary sm" data-act="glass-save" ${g.img ? '' : 'disabled'}>Use as wallpaper</button></div>`, 820);
  glassPreview();
}
function glassPreview() {
  const g = glassDraft;
  const pv = $('#glass-preview'), sm = $('#glass-sample');
  if (!g || !pv || !sm) return;
  pv.style.backgroundImage = g.img ? `url('${g.img}')` : '';
  pv.style.backgroundSize = GLASS_FIT[g.fit];
  pv.style.boxShadow = `inset 0 0 0 999px rgba(0,0,0,${g.dim / 100})`;
  sm.style.background = `color-mix(in srgb, var(--surface-1) ${g.panel}%, transparent)`;
  sm.style.backdropFilter = `blur(${g.blur}px)`;
}
function glassPick() {
  const input = Object.assign(document.createElement('input'), { type: 'file', accept: 'image/jpeg,image/png,image/webp' });
  input.onchange = () => {
    const file = input.files && input.files[0];
    if (!file) return;
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, 2560 / img.width);
      const c = Object.assign(document.createElement('canvas'), { width: Math.round(img.width * scale), height: Math.round(img.height * scale) });
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(img.src);
      modalGlass({ ...glassDraft, img: c.toDataURL('image/jpeg', 0.85), name: file.name });
    };
    img.onerror = () => toast('That file is not an image this app can read', 'warning');
    img.src = URL.createObjectURL(file);
  };
  input.click();
}

/* popovers */
/* Centered dialog-style popover: dim backdrop + box in the middle of the window. Used by the
   four title-bar actions (search, quick commands, new session, update) — anchoring them under
   the buttons left them floating in a corner once the old topbar was merged into the title bar. */
function centerPop(el, width, extra = '') {
  el.className = `popover centered ${extra}`.trim();
  /* The popover element is shared, so inline left/top from a previous anchored popover would
     override the .centered CSS and park this one in the corner. Clear them before showing. */
  el.style.left = '';
  el.style.top = '';
  el.style.width = width + 'px';
  el.style.maxHeight = Math.min(VH() - 48, 900) + 'px';
  overlay.innerHTML = '';
  overlay.hidden = false;
  el.hidden = false;
}
function placePopover(el, anchor, width, align = 'right') {
  // Accepts a selector or the element itself — callers already hold the button they clicked.
  const a = anchor && (typeof anchor === 'string' ? $(anchor) : anchor);
  el.className = 'popover';
  el.style.maxHeight = '';
  el.style.width = width + 'px';
  const M = 12;
  if (a) {
    const r = zRect(a);
    el.style.top = Math.round(r.bottom + 8) + 'px';
    /* Right-aligned to a button on the right half, left-aligned to one on the left; never past an edge. */
    const want = align === 'right' && r.right > VW() / 2 ? r.right - width : r.left;
    el.style.left = Math.round(Math.max(M, Math.min(want, VW() - width - M))) + 'px';
  } else {
    el.style.top = '96px';
    el.style.left = Math.round((VW() - width) / 2) + 'px';
  }
  /* Fit vertically. Measuring synchronously here reads a stale height (the caller unhides the
     popover after this returns, and the icon font may still be swapping), so fit once now and
     again on the next frame + after fonts settle. */
  const wasHidden = el.hidden;
  el.hidden = false;
  fitPopover(el);
  el.hidden = wasHidden;
  requestAnimationFrame(() => fitPopover(el));
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => fitPopover(el));
}

/* Keep a popover inside the viewport: pull it up until its last row is reachable, then cap the
   height so an over-tall menu scrolls instead of disappearing past the bottom edge. */
function fitPopover(el) {
  if (el.hidden) return;
  const M = 12;
  const limit = VH() - M * 2;
  el.style.maxHeight = '';
  const h = el.offsetHeight;
  if (h > limit) el.style.maxHeight = limit + 'px';
  const used = Math.min(h, limit);
  const top = parseFloat(el.style.top) || 0;
  if (top + used > VH() - M) {
    el.style.top = Math.round(Math.max(M, VH() - M - used)) + 'px';
  }
}
/* Search reads the same data the pages show: pages, sessions, notes and devices, filtered as you
   type. Chat messages come from the hub (/api/search) and land under them a moment later.
   Enter opens the first hit; rows are ordinary click targets. */
function searchRows(q) {
  q = q.trim().toLowerCase();
  const hit = (s) => !q || String(s).toLowerCase().includes(q);
  const pages = q ? NAV.filter(([, label]) => hit(label)) : [];
  const sessions = DB.sessions.filter((s) => hit(`${s.title} ${s.ws} ${s.agent || ''} ${AGENT_NAMES[s.agent] || ''}`)).slice(0, 6);
  const notes = DB.notes.map((n, i) => [n, i]).filter(([n]) => hit(`${n.title} ${n.body}`)).slice(0, 4);
  const devices = DB.devices.map((d, i) => [d, i]).filter(([d]) => hit(`${d.name} ${d.ip || ''}`)).slice(0, 4);
  const body = (pages.length ? `<div class="pop-group">Pages</div>${pages.map(([id, label, icon]) => `<div class="pop-row" data-nav="${id}">${ic(icon)}<span style="flex:1">${esc(label)}</span></div>`).join('')}` : '')
    + (sessions.length ? `<div class="pop-group">Sessions</div>${sessions.map((s) => `<div class="pop-row" data-session="${esc(s.id)}">${ic('chats-circle')}<span style="flex:1">${esc(s.title)}</span><span class="meta">${esc(AGENT_NAMES[s.agent] || s.agent || '')} · ${esc(s.ws)}</span></div>`).join('')}` : '')
    + (notes.length ? `<div class="pop-group">Notes</div>${notes.map(([n, i]) => `<div class="pop-row" data-note="${esc(n.id)}" data-nav="notes">${ic('notebook')}<span style="flex:1">${esc(n.title)}</span><span class="meta">${esc(n.ws)}</span></div>`).join('')}` : '')
    + (devices.length ? `<div class="pop-group">Devices</div>${devices.map(([d, i]) => `<div class="pop-row" data-device="${esc(d.name)}" data-nav="devices">${ic('desktop')}<span style="flex:1">${esc(d.name)}</span><span class="meta">${esc(d.status)}</span></div>`).join('')}` : '')
    + '<div id="search-msgs"></div>';
  const n = pages.length + sessions.length + notes.length + devices.length;
  return { body: n || q.length >= 2 ? body : `<div class="jempty" style="padding:16px">Nothing matches “${esc(q)}”</div>`, counts: `${sessions.length} sessions · ${notes.length} notes · ${devices.length} devices` };
}
/* Chat messages that hold q: one row each, a snippet around the match. Last request wins. */
function msgSnippet(text, q) {
  const t = String(text || '').replace(/\s+/g, ' ');
  const at = Math.max(0, t.toLowerCase().indexOf(q.toLowerCase()));
  const from = Math.max(0, at - 40);
  const cut = (from ? '…' : '') + t.slice(from, at + q.length + 180);
  const i = cut.toLowerCase().indexOf(q.toLowerCase());
  return i < 0 ? esc(cut) : `${esc(cut.slice(0, i))}<mark>${esc(cut.slice(i, i + q.length))}</mark>${esc(cut.slice(i + q.length))}`;
}
let searchSeq = 0;
function searchMsgs(q, { session = '', who = '' } = {}) {
  const seq = ++searchSeq;
  q = q.trim();
  if (q.length < 2) return Promise.resolve(null);
  return fetch(`/api/search?q=${encodeURIComponent(q)}&session=${encodeURIComponent(session)}&who=${who}`, { cache: 'no-store' })
    .then((r) => r.json()).then((j) => (seq === searchSeq ? j.hits || [] : null)).catch(() => (seq === searchSeq ? [] : null));
}
function msgRow(h, q, withSession) {
  const s = DB.sessions.find((x) => x.id === h.session_id);
  const who = h.kind === 'user' ? 'You' : AGENT_NAMES[s && s.agent] || 'Agent';
  const me = h.kind === 'user';
  return `<div class="pop-row msg-hit ${me ? 'me' : 'ag'}" data-session="${esc(h.session_id)}" data-jump="${h.id}">
    <span class="msg-hit-av">${me ? ic('user') : agentLogo((s && s.agent) || 'shell')}</span>
    <span class="msg-hit-txt"><span class="msg-hit-who"><b>${esc(who)}</b>${withSession ? `<em>${esc(s ? s.title : h.session_id)}</em>` : ''}</span><span class="msg-hit-snip">${msgSnippet(h.text, q)}</span></span>
    ${ic('arrow-elbow-down-left', 'regular', 'msg-hit-go')}</div>`;
}
function popSearch() {
  const r = searchRows('');
  popover.innerHTML = `
    <div class="pop-head">${ic('magnifying-glass')}<input id="search-q" placeholder="Search pages, sessions, chats, notes, devices" aria-label="Search"><kbd class="kbdcap">esc</kbd></div>
    <div class="pop-body" id="search-body">${r.body}</div>
    <div class="pop-foot"><span>Enter opens the first result</span><span class="grow"></span><span id="search-count">${r.counts}</span></div>`;
  centerPop(popover, 560);
  setTimeout(() => $('#search-q')?.focus(), 30);
}
/* Quick commands: the built-in actions plus the commands saved in Settings → Commands. */
function popCommands() {
  const saved = savedCommands();
  popover.innerHTML = `
    <div class="pop-head">${ic('lightning', 'fill')}<span style="flex:1">Quick commands</span><kbd class="kbdcap">Ctrl J</kbd></div>
    <div class="pop-body">${DB.commands.map((g) => `<div class="pop-group">${g.g}</div>` +
      g.rows.map(([l, k, i]) => `<div class="pop-row" data-cmd="${esc(l)}">${ic(i || 'arrow-right')}<span style="flex:1">${l}</span>${k ? `<span class="meta">${k}</span>` : ''}</div>`).join('')).join('')}
      ${saved.length ? `<div class="pop-group">Saved commands</div>${saved.map((c, i) => `<div class="pop-row" data-act="run-command" data-i="${i}">${ic('terminal')}<span style="flex:1">${esc(c.name)}</span><span class="meta mono">${esc(c.cmd)}</span></div>`).join('')}` : ''}</div>
    <div class="pop-foot"><span>Click to run · esc closes</span><span class="grow"></span><span class="link" data-act="cmd-settings">Edit saved commands</span></div>`;
  centerPop(popover, 520);
}
/* Agent logos from lobe-icons (MIT, app/assets/agents). Mono ones are masks so they take the
   text color; omp has no published logo, so it gets its letter. */
const AGENT_IDS = ['claude', 'codex', 'gemini', 'opencode', 'hermes', 'omp'];
const AGENT_NAMES = { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini CLI', opencode: 'OpenCode', hermes: 'Hermes', omp: 'OMP' };
/* A session row's agent, as its logo at the row's right end. */
const brAgent = (s) => { const a = ((window.__liveRuns && window.__liveRuns.get(s.id)) || {}).agent || s.agent; return a ? `<span class="br-ag" title="${esc(AGENT_NAMES[a] || a)}">${agentLogo(a)}</span>` : ''; };
/* Registry agents with a lobe-icons logo; forks and variants borrow their parent's. The rest get a letter. */
const AGENT_LOGOS = new Set('amp antigravity claude cline codebuddy codex command-code copilot cursor deepseek devin gemini goose grok hermes kilo kimi kiro mimo openclaw opencode qoder qwen trae vibe zcode'.split(' '));
const AGENT_LOGO_ALIAS = { 'claude-teams': 'claude', openclaude: 'claude', opencode2: 'opencode', 'qoder-cn': 'qoder' };
/* The registry names every agent the hub knows (45+, custom ones too): pickers and labels use it. */
fetch('/api/agents/registry', { cache: 'no-store' }).then((r) => r.json()).then((j) => {
  if (!Array.isArray(j)) return;
  window.__reg = j;
  j.forEach((a) => { if (!AGENT_NAMES[a.id]) AGENT_NAMES[a.id] = a.name; });
  if (overlay.querySelector('.modal.settings')) openSettings(state.settingsTab);
}).catch(() => {});
/* Every registry agent, installed on this hub first; before the registry loads, the hub's known ids. */
function allAgentIds() {
  const R = window.__reg;
  return R && R.length ? R.map((a) => a.id) : ((window.LIVE && LIVE.llm && LIVE.llm.agent_ids) || AGENT_IDS).filter((a) => a !== 'shell');
}
const agentInstalled = (id) => !window.__reg || window.__reg.some((a) => a.id === id && a.installed);
function agentLogo(id) {
  if (id === 'shell') return ic('terminal');
  /* All flat, in the text color: the SVG is a mask. The url sits in the inline style itself,
     since a url() inside a custom property resolves against the stylesheet (css/) instead. */
  const f = AGENT_LOGO_ALIAS[id] || id;
  if (AGENT_LOGOS.has(f))
    return `<i class="alogo mono" style="-webkit-mask-image:url(assets/agents/${f}.svg);mask-image:url(assets/agents/${f}.svg)" aria-hidden="true"></i>`;
  return `<i class="alogo letter" aria-hidden="true">${esc(id[0].toUpperCase())}</i>`;
}
/* ok: installed there. missing: the device looked and it is not on PATH. away: the device is
   offline or has no XBLabs agent to look, so nobody knows. */
const STATE_RANK = { ok: 0, away: 1, missing: 2 };
const AGENT_STATE_SHORT = { ok: 'Connected', away: 'Not connected', missing: 'Not installed' };
const AGENT_STATE_TEXT = { ok: 'Installed', missing: 'Not installed on this device', away: 'Device disconnected or not reporting' };
function agentState(device, id) {
  const d = (DB.devices || []).find((x) => x.name === device);
  if (!d || d.status === 'offline' || !d.agents) return 'away';
  return id === 'shell' || d.agents.some((a) => a.id === id) ? 'ok' : 'missing';
}

/* A device in New session: ok = this hub or an attached XBLabs agent, ssh = on the tailnet with
   no agent (starts over ssh, folders typed by hand), off = offline. */
function deviceState(d) {
  if (d.name === 'local') return 'ok';
  if (d.status === 'offline') return 'off';
  return d.agents ? 'ok' : 'ssh';
}
const DEVICE_STATE_TEXT = { ok: 'Connected', ssh: 'No XBLabs agent: starts over ssh, type the folder path', off: 'Offline' };

function popNewSession() {
  const wss = DB.workspaces.filter((w) => w.id !== 'all');
  const cur = state.ws !== 'all' ? state.ws : (wss[0] || {}).id || 'xblabs-web';
  const dev = state.nsDevice || 'local';
  const devs = (DB.devices || []).filter((d, i, all) => all.findIndex((x) => x.name === d.name) === i);
  /* The folder this workspace's earlier runs used; the browser opens there. */
  const pick = state.nsPick && state.nsPick.device === dev ? state.nsPick.cwd : '';
  state.nsPick = null;
  /* The project's root folder: the shortest one its sessions used (a worktree counts as its
     origin). GOA's own folder lives under ~/.xblabs, so only worktrees are skipped. */
  const wsDir = (id) => ([...((window.LIVE && LIVE.runs) || new Map()).values(), ...((window.LIVE && LIVE.projects) || [])]
    .filter((r) => r.ws === id && r.kind !== 'shell' && (r.device || 'local') === dev).map((r) => r.origin || r.cwd)
    .filter((c) => /[\\/:]/.test(c || '') && !/[\\/]\.xblabs[\\/]worktrees[\\/]/.test(c) && !/[\\/]ses_[0-9a-f]{12}$/i.test(c))
    .sort((a, b) => a.length - b.length)[0]) || '';
  const curCwd = pick || (prefs.goaMode && dev === 'local' ? wsDir('GOA') : '');   // only a folder's own "New session" picks for you (GOA has one folder)
  popover.innerHTML = `
    <div class="pop-head"><span style="flex:1">New session</span><kbd class="kbdcap">esc</kbd></div>
    <div class="pop-scroll">
    <div class="pop-sec"><h5>Device</h5>
      <div style="display:flex;gap:6px;flex-wrap:wrap">${devs.map((d) => { const st = deviceState(d); return `
        <button class="picker ${d.name === dev ? 'on' : ''}" data-nsdev="${esc(d.name)}" aria-pressed="${d.name === dev}" ${st === 'off' ? 'disabled' : ''} title="${DEVICE_STATE_TEXT[st]}">
          <i class="astate ${st === 'ok' ? 'ok' : st === 'off' ? 'missing' : ''}" aria-hidden="true"></i>${ic(d.name === 'local' ? 'laptop' : 'desktop')}${d.name === 'local' ? 'This hub' : esc(d.name)}</button>`; }).join('')}</div></div>
    <div class="pop-sec"><h5>Workspace</h5>
      <button id="ns-ws" class="select" style="min-width:0;width:100%" data-fb-open data-value="${curCwd ? esc(cur) : ''}" data-cwd="${esc(curCwd)}" title="${esc(curCwd)}"><span style="flex:1;text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(curCwd || 'Pick a folder')}</span>${ic('folder-open')}</button></div>
    <div class="pop-sec"><h5>Agent <small class="dim" style="font-weight:400">· on ${dev === 'local' ? 'this hub' : esc(dev)}</small></h5>
      <div class="ns-list" role="listbox" aria-label="Agent">${(() => {
        const d = (DB.devices || []).find((x) => x.name === dev);
        /* What the device reports as installed; a device that reports nothing gets the common ones (unknown state). */
        const have = d && d.agents ? d.agents.map((a) => a.id) : [];
        const ids = [...new Set([...have, ...allAgentIds()])].filter((k) => k !== 'shell').concat('shell')
          .sort((x, y) => STATE_RANK[agentState(dev, x)] - STATE_RANK[agentState(dev, y)]);   // connected, not connected, not installed
        const ok = ids.filter((k) => agentState(dev, k) !== 'missing');
        const pick = window.__hub && ok.includes(window.__hub.session && window.__hub.session.agent) ? window.__hub.session.agent : ok[0];
        return ids.map((k) => { const st = agentState(dev, k), on = k === pick; return `
        <button class="picker ${on ? 'on' : ''}" data-agentpick="${k}" aria-pressed="${on}" ${st === 'missing' ? 'disabled' : ''} title="${AGENT_STATE_TEXT[st]}">
          <i class="astate ${st}" aria-hidden="true"></i>${agentLogo(k)}<span class="ns-name">${k === 'shell' ? 'Plain shell' : esc(AGENT_NAMES[k] || k)}</span><small class="ns-st ${st}">${AGENT_STATE_SHORT[st]}</small>${ic('check', 'bold', 'ns-check')}</button>`; }).join('');
      })()}</div></div>
    <div class="pop-sec" id="ns-cfg-sec" hidden><h5>Config</h5><input type="hidden" id="ns-config" value="auto"><div class="ns-grid" id="ns-cfgs"></div></div>
    <div class="pop-sec" id="ns-model-sec" hidden><h5>Model <small class="dim" style="font-weight:400" id="ns-model-note"></small></h5>
      <div class="ns-models" id="ns-models"></div>
      <span class="input"><input id="ns-model" data-combo="__nsModels" autocomplete="off" spellcheck="false" maxlength="200" placeholder="Default"></span></div>
    <div class="pop-sec"><h5>Prompt</h5>
      <div class="input" style="height:84px;align-items:flex-start;padding:8px 10px"><textarea id="ns-prompt" maxlength="8000" style="flex:1;border:0;background:none;outline:none;resize:none;font:inherit;color:inherit" placeholder="Describe the task"></textarea></div>
      <div style="display:flex;font-size:10.5px;color:var(--text-tertiary)"><span>Ctrl Enter to start</span><span style="margin-left:auto" id="ns-count">0 / 8000</span></div></div>
    <div class="pop-sec" style="flex-direction:row;align-items:center"><span style="font-size:11.5px;color:var(--text-secondary)" title="The same prompt to several agents, each on its own branch; their changes open side by side">Compare agents <small class="dim" id="ns-fan-n"></small></span>${toggle(false).replace('data-toggle="1"', 'data-toggle="1" id="ns-fan" aria-label="Compare agents"')}</div>
    <div class="pop-sec" style="flex-direction:row;align-items:center"><span style="font-size:11.5px;color:var(--text-secondary)" title="Stages one after another on one branch; each stage gets the task and the previous stage's answer">Pipeline <small class="dim" id="ns-pipe-n"></small></span>${toggle(false).replace('data-toggle="1"', 'data-toggle="1" id="ns-pipe" aria-label="Pipeline"')}</div>
    <div class="pop-sec" id="ns-stages" hidden></div>
    <div class="pop-sec" style="flex-direction:row;align-items:center"><span style="font-size:11.5px;color:var(--text-secondary)" title="The agent you picked leads: it splits the goal into tasks, a teammate per task runs them side by side, then the lead reviews">Team <small class="dim" id="ns-team-n"></small></span>${toggle(false).replace('data-toggle="1"', 'data-toggle="1" id="ns-team" aria-label="Team"')}</div>
    <div class="pop-sec" id="ns-team-box" hidden></div>
    <div class="pop-sec" style="flex-direction:row;align-items:center"><span style="font-size:11.5px;color:var(--text-secondary)" title="A worktree and branch under the XBLabs folder; the project folder is not written to">Own worktree and branch</span>${toggle(!window.__hub || window.__hub.session.worktree).replace('data-toggle="1"', 'data-toggle="1" id="ns-wt" aria-label="Own worktree and branch"')}</div>
    </div>
    <div class="pop-foot"><span>Runs on ${dev === 'local' ? 'this hub' : esc(dev)}</span><span class="grow"></span>
      <button class="btn secondary xs" data-act="close">Cancel</button><button class="btn primary xs" data-act="started">Start session</button></div>`;
  centerPop(popover, 520);
  NS_MODELS.length = 0; NS_STAGES.length = 0;
  nsConfigs(); cfgLoad(); nsModels();
  /* Only the catalog from Settings → Models & keys: the endpoint serves hundreds, the catalog is what I chose. */
  window.__nsModels = ((window.LIVE && LIVE.llm && LIVE.llm.models) || []).map((m) => m && m.id).filter(Boolean);
  setTimeout(() => $('#ns-prompt')?.focus(), 30);
}
/* The config select follows the picked agent: Auto (official, or the next when it is limited), Official, each config. */
function nsConfigs() {
  const sel = $('#ns-config'), sec = $('#ns-cfg-sec');
  if (!sel || !sec) return;
  const a = (($('#popover [data-agentpick].on') || {}).dataset || {}).agentpick, rows = cfgsOf(a).filter((c) => c.id && c.enabled);
  sec.hidden = !rows.length || !!$('#ns-fan.on') || !!$('#ns-pipe.on') || !!$('#ns-team.on');   // a comparison or pipeline uses each agent's Auto config
  const opts = [['auto', 'Auto', 'shuffle', 'Picks a config that still has quota'], ['official', 'Official', 'seal-check', 'The agent as installed, its own login'],
    ...rows.map((c) => [c.id, c.name, 'key', c.limited_until > Date.now() ? 'Rate limited for now' : 'Your config', c.limited_until > Date.now()])];
  if (!opts.some(([v]) => v === sel.value)) sel.value = 'auto';
  $('#ns-cfgs').innerHTML = opts.map(([v, l, i, tip, lim]) => `<button class="picker ${v === sel.value ? 'on' : ''}" data-nscfg="${esc(v)}" aria-pressed="${v === sel.value}" title="${esc(tip)}">${ic(i)}<span>${esc(l)}</span>${lim ? '<i class="astate missing" aria-hidden="true"></i>' : ''}</button>`).join('');
}
/* Model on the hub's endpoint, for agents that use it (Settings → Models & keys). One model normally;
   with Compare agents on, each pick adds a chip and every endpoint agent runs once per model. */
const NS_MODELS = [];
const MODEL_ID = /^[\w.:/@+-]{1,200}$/;
const usesEndpoint = (a) => !!(window.LIVE && LIVE.llm && LIVE.llm.base_url && (LIVE.llm.agents || []).includes(a));
function nsPicked() { return [...$$('#popover [data-agentpick].on')].map((x) => x.dataset.agentpick); }
function nsTargets() {
  const fan = !!$('#ns-fan.on'), typed = (($('#ns-model') || {}).value || '').trim();
  const models = fan && NS_MODELS.length ? NS_MODELS : [typed];
  return nsPicked().flatMap((a) => (usesEndpoint(a) ? models : ['']).map((m) => ({ agent: a, model: m })));
}
function nsModels() {
  const sec = $('#ns-model-sec');
  if (!sec) return;
  const fan = !!$('#ns-fan.on');
  sec.hidden = !nsPicked().some(usesEndpoint) || !!$('#ns-pipe.on') || !!$('#ns-team.on');   // pipeline stages: each agent's default model
  $('#ns-model-note').textContent = fan ? '· every endpoint agent runs once per model' : '· for agents on the hub endpoint';
  $('#ns-models').innerHTML = fan ? NS_MODELS.map((m) => `<button class="chip active" data-nsmodel-del="${esc(m)}" title="Remove">${esc(m)}${ic('x')}</button>`).join('') : '';
  $('#ns-model').placeholder = fan ? 'Add a model (Enter)' : `Default · ${(window.LIVE && LIVE.llm && LIVE.llm.model) || 'hub endpoint'}`;
}
function nsModelAdd() {
  const inp = $('#ns-model'), v = ((inp && inp.value) || '').trim();
  if (!$('#ns-fan.on') || !v) return;
  if (!MODEL_ID.test(v)) { toast('Not a model id', 'warning'); return; }
  if (!NS_MODELS.includes(v)) NS_MODELS.push(v);
  inp.value = ''; nsFan();
}
document.addEventListener('change', (e) => { if (e.target.id === 'ns-model') nsModelAdd(); });
document.addEventListener('keydown', (e) => { if (e.target.id === 'ns-model' && e.key === 'Enter' && !e.ctrlKey && $('#ns-fan.on') && !glideState) { e.preventDefault(); nsModelAdd(); } });
/* Pipeline: stages run one after another on one branch, each its own session with any chat agent.
   Compare and Pipeline exclude each other; both need the worktree. */
const NS_STAGES = [];
const PIPE_DEFAULT = [['Plan', 'Read the code and write a short step-by-step plan. Do not edit files.'],
  ['Build', 'Carry out the plan. Run the tests you can.'],
  ['Review', 'Review this branch against its base (git diff). Fix real bugs; list what is left.']];
function nsStagesRead() {
  return [...$$('#ns-stages .ns-stage')].map((r) => ({ name: r.querySelector('[data-st="name"]').value.trim(), agent: r.querySelector('[data-st="agent"]').value, prompt: r.querySelector('[data-st="prompt"]').value.trim() }));
}
const nsOff = (id, then) => { const x = $(`#${id}.on`); if (x) { x.classList.remove('on'); x.setAttribute('aria-checked', 'false'); then(); } };
/* Team: the picked agent leads; teammates run one agent with a chat mode. On this hub, one worktree. */
function nsTeam() {
  const on = !!$('#ns-team.on'), box = $('#ns-team-box');
  if (!box) return;
  if (on) { nsOff('ns-fan', nsFan); nsOff('ns-pipe', nsPipe); }
  const wt = $('#ns-wt');
  if (wt) { if (on) { wt.classList.add('on'); wt.setAttribute('aria-checked', 'true'); } wt.disabled = on || !!$('#ns-fan.on') || !!$('#ns-pipe.on'); }
  box.hidden = !on;
  nsConfigs(); nsModels();
  const b = $('#popover [data-act="started"]');
  if (!on) { $('#ns-team-n').textContent = ''; if (b && !$('#ns-fan.on') && !$('#ns-pipe.on')) b.textContent = 'Start session'; return; }
  const ok = [...TUI_AGENTS].filter((a) => agentState('local', a) !== 'missing');
  const cur = $('#ns-mate')?.value || (ok.includes(nsPicked()[0]) ? nsPicked()[0] : ok[0]);
  box.innerHTML = `<h5>Team <small class="dim" style="font-weight:400">· on this hub, one branch</small></h5>
    <p class="dim" style="margin:0;font-size:11.5px;line-height:1.5">The agent picked above leads: it splits the goal into 2 to 6 tasks. A teammate per task runs them side by side, then the lead gets every result to review. Teammates stay as sessions you can continue.</p>
    <div style="display:flex;align-items:center;gap:8px"><span style="font-size:11.5px;color:var(--text-secondary)">Teammates</span><span class="input" style="flex:1"><select id="ns-mate" aria-label="Teammate agent">${ok.map((a) => `<option value="${a}" ${a === cur ? 'selected' : ''}>${esc(AGENT_NAMES[a] || a)}</option>`).join('')}</select></span></div>`;
  $('#ns-team-n').textContent = '· lead + up to 6';
  if (b) b.textContent = 'Start team';
}
function nsPipe() {
  const on = !!$('#ns-pipe.on'), box = $('#ns-stages');
  if (!box) return;
  if (on) nsOff('ns-team', nsTeam);
  const fan = $('#ns-fan.on');
  if (on && fan) { fan.classList.remove('on'); fan.setAttribute('aria-checked', 'false'); nsFan(); }
  const wt = $('#ns-wt');
  if (wt) { if (on) { wt.classList.add('on'); wt.setAttribute('aria-checked', 'true'); } wt.disabled = on || !!$('#ns-fan.on'); }
  box.hidden = !on;
  if (!$('#ns-fan.on')) { nsConfigs(); nsModels(); }
  const b = $('#popover [data-act="started"]');
  if (!on) { $('#ns-pipe-n').textContent = ''; if (b && !$('#ns-fan.on')) b.textContent = 'Start session'; return; }
  const ok = [...TUI_AGENTS].filter((a) => agentState('local', a) !== 'missing');
  if (!NS_STAGES.length) {
    const first = nsPicked()[0], a = ok.includes(first) ? first : ok[0] || 'omp';
    PIPE_DEFAULT.forEach(([name, prompt]) => NS_STAGES.push({ name, agent: a, prompt }));
  }
  box.innerHTML = `<h5>Stages <small class="dim" style="font-weight:400">· on this hub, one branch</small></h5>${NS_STAGES.map((s, i) => `
    <div class="ns-stage"><span class="ns-stage-n">${i + 1}</span>
      <span class="input"><input data-st="name" value="${esc(s.name)}" maxlength="40" aria-label="Stage ${i + 1} name"></span>
      <span class="input"><select data-st="agent" aria-label="Stage ${i + 1} agent">${ok.map((a) => `<option value="${a}" ${a === s.agent ? 'selected' : ''}>${esc(AGENT_NAMES[a] || a)}</option>`).join('')}</select></span>
      <button class="btn ghost xs icon-only" data-stage-del="${i}" ${NS_STAGES.length <= 2 ? 'disabled' : ''} title="Remove stage" aria-label="Remove stage ${i + 1}">${ic('x')}</button>
      <span class="input ns-stage-p"><input data-st="prompt" value="${esc(s.prompt)}" maxlength="4000" placeholder="What this stage does" aria-label="Stage ${i + 1} instruction"></span></div>`).join('')}
    <button class="btn ghost xs" data-stage-add="1" ${NS_STAGES.length >= 6 ? 'disabled' : ''} style="align-self:flex-start">${ic('plus')}Add stage</button>`;
  $('#ns-pipe-n').textContent = `· ${NS_STAGES.length} stages`;
  if (b) b.textContent = 'Start pipeline';
}
/* Compare agents: the agent list picks several, each gets its own worktree (required), no plain shell. */
function nsFan() {
  const on = !!$('#ns-fan.on'), picks = [...$$('#popover [data-agentpick]')];
  if (on) nsOff('ns-team', nsTeam);
  const pipe = $('#ns-pipe.on');
  if (on && pipe) { pipe.classList.remove('on'); pipe.setAttribute('aria-checked', 'false'); nsPipe(); }
  const wt = $('#ns-wt');
  if (wt) { if (on) { wt.classList.add('on'); wt.setAttribute('aria-checked', 'true'); } wt.disabled = on; }
  picks.forEach((x) => {
    if (x.dataset.agentpick === 'shell') { x.disabled = on; if (on) x.classList.remove('on'); }
  });
  if (!on) { const keep = picks.find((x) => x.classList.contains('on')); picks.forEach((x) => { x.classList.toggle('on', x === keep); x.setAttribute('aria-pressed', String(x === keep)); }); }
  const n = nsTargets().length, na = nsPicked().length;
  $('#ns-fan-n').textContent = on ? `· ${na} agent${na === 1 ? '' : 's'}${NS_MODELS.length ? ` × ${NS_MODELS.length} model${NS_MODELS.length === 1 ? '' : 's'}` : ''}` : '';
  const b = $('#popover [data-act="started"]'); if (b) b.textContent = on ? `Start ${n} session${n === 1 ? '' : 's'}` : 'Start session';
  if (on) $('#ns-cfg-sec').hidden = true; else nsConfigs();
  nsModels();
}

/* ---------- compare: one prompt, several agents, their branches side by side ----------
   Each column is the session's own worktree diff (the hub reads it). Merge and discard stay in
   that session's Changes dialog, where they ask twice. Remote sessions show why they cannot be read. */
const FANOUTS_MAX = 12;
function fanSave(title, ids) {
  prefs.fanouts = [{ title, ids, at: Date.now() }, ...(prefs.fanouts || []).filter((g) => g.ids.join() !== ids.join())].slice(0, FANOUTS_MAX);
  savePrefs();
}
function modalCompareList() {
  const groups = (prefs.fanouts || []).map((g) => ({ ...g, ids: g.ids.filter((id) => DB.sessions.some((s) => s.id === id)) })).filter((g) => g.ids.length > 1);
  showModal(`<div class="modal-head"><div class="tb"><h2>Compare</h2><p>Runs started with Compare agents in New session</p></div><button class="close-x" data-act="close">${ic('x')}</button></div>
    <div class="modal-body">${groups.length ? groups.map((g) => `<button class="cmp-group" data-act="compare-open" data-ids="${esc(g.ids.join(','))}">
        <b>${esc(g.title)}</b><span>${g.ids.map((id) => esc(AGENT_NAMES[(DB.sessions.find((s) => s.id === id) || {}).agent] || (DB.sessions.find((s) => s.id === id) || {}).agent || id)).join(' · ')}</span><small>${new Date(g.at).toLocaleString()}</small></button>`).join('')
      : `<div class="dim" style="font-size:12px">Nothing to compare yet. In New session, turn on Compare agents and pick two or more agents.</div>`}</div>
    <div class="modal-foot"><span class="sp"></span><button class="btn secondary sm" data-act="close">Close</button><button class="btn primary sm" data-act="new-session">${ic('plus', 'bold')}New comparison</button></div>`, 560);
}
async function modalCompare(ids) {
  const head = (sub) => `<div class="modal-head"><div class="tb"><h2>Compare · ${ids.length} agents</h2><p>${sub}</p></div>
    <button class="btn ghost xs" data-act="compare-open" data-ids="${esc(ids.join(','))}" title="Read the branches again">${ic('arrow-clockwise')}Refresh</button><button class="close-x" data-act="close">${ic('x')}</button></div>`;
  const width = Math.min(1280, VW() - 48);
  showModal(`${head('Reading each worktree…')}<div class="modal-body"></div>`, width);
  const gits = await Promise.all(ids.map((id) => gitLoad(id)));
  if (overlay.hidden) return;
  const cls = (l) => (l.startsWith('+++') || l.startsWith('---') || l.startsWith('diff ') || l.startsWith('index ') || l.startsWith('@@') ? 'd' : l[0] === '+' ? 'ok' : l[0] === '-' ? 'err' : '');
  const col = (id, g) => {
    const S = DB.sessions.find((s) => s.id === id) || { id, agent: '?', title: id };
    const st = sessionStatus(id) || 'idle', d = g.data;
    const add = d ? d.stat.reduce((a, x) => a + x.add, 0) : 0, del = d ? d.stat.reduce((a, x) => a + x.del, 0) : 0;
    const lines = d && d.patch ? d.patch.split('\n').slice(0, 1500) : [];
    return `<section class="cmp-col">
      <header>${agentLogo(S.agent)}<b>${esc(AGENT_NAMES[S.agent] || S.agent)}</b><span class="sh-st ${esc(st)}"><i></i>${SESS_ST[st] || 'Idle'}</span></header>
      <div class="cmp-meta">${d ? `<span class="mono">${esc(d.branch)}</span> · ${d.stat.length} file${d.stat.length === 1 ? '' : 's'} · <b class="ok">+${add}</b> <b class="err">−${del}</b>${d.dirty ? ' · uncommitted' : ''}` : esc(g.error || 'not readable')}</div>
      ${d && d.stat.length ? `<div class="cmp-files">${d.stat.map((f) => `<span title="${esc(f.file)}">${esc(f.file)}<small><b class="ok">+${f.add}</b> <b class="err">−${f.del}</b></small></span>`).join('')}</div>` : ''}
      <div class="term-body cmp-diff">${lines.length ? lines.map((l) => `<div class="tl ${cls(l)}">${esc(l) || ' '}</div>`).join('') : `<div class="tl d">${d ? 'No changes yet.' : 'The hub cannot read this branch.'}</div>`}${d && (d.cut || lines.length === 1500) ? '<div class="tl d">… cut here, open the session for the rest</div>' : ''}</div>
      <footer><button class="btn secondary xs" data-session="${esc(id)}">${ic('arrow-square-out')}Open</button>${d ? `<button class="btn primary xs" data-act="compare-review" data-id="${esc(id)}" title="Commit, merge or discard this branch">${ic('git-merge')}Review &amp; merge</button>` : ''}</footer>
    </section>`;
  };
  const prompt = (DB.sessions.find((s) => s.id === ids[0]) || {}).prompt;
  showModal(`${head(esc(prompt ? chatTitle(prompt) : 'Same prompt, own branches'))}
    <div class="modal-body cmp-grid" style="--cols:${ids.length}">${ids.map((id, i) => col(id, gits[i])).join('')}</div>`, width);
}
/* ---------- folder browser ----------
   New session's workspace: walk this hub's folders and pick one. The pick fills #ns-ws with the
   folder (data-cwd) and its name as the workspace (data-value); the popover stays open. */
const FB = { path: '~', hidden: false, data: null, err: null, device: 'local' };
/* Its own layer: the New session popover sits above the shared overlay, so a modal there would
   open behind it. */
function fbLayer() {
  let el = document.getElementById('fb-layer');
  if (!el) { el = document.createElement('div'); el.id = 'fb-layer'; el.className = 'overlay fb-layer'; document.body.appendChild(el); }
  return el;
}
const fbClose = () => { const el = document.getElementById('fb-layer'); if (el) el.hidden = true; };
async function fbGo(path) {
  try {
    const r = await fetch(`/api/fs?device=${encodeURIComponent(FB.device)}&path=${encodeURIComponent(path)}&hidden=${FB.hidden ? 1 : 0}`, { cache: 'no-store' });
    const j = await r.json();
    if (j.error) FB.err = j.error; else { FB.data = j; FB.path = j.path; FB.err = null; }
  } catch (err) { FB.err = err.message; }
  fbPaint();
}
/* The picker's search filters the open folder as I type, without repainting (focus stays). */
document.addEventListener('input', (e) => {
  if (e.target.id !== 'fb-q') return;
  FB.q = e.target.value.trim();
  $$('#fb-layer .fb-row').forEach((r) => { r.hidden = !!FB.q && !r.dataset.name.toLowerCase().includes(FB.q.toLowerCase()); });
});
function fbPaint() {
  const d = FB.data;
  const layer = fbLayer();
  layer.hidden = false;
  layer.innerHTML = `<div class="modal" style="width:480px">
    <div class="modal-head"><div class="tb"><h2>${esc(FB.title || 'Open a folder')}</h2><p>On ${FB.device === 'local' ? 'this hub' : esc(FB.device)}</p></div><button class="close-x" data-fb="cancel" aria-label="Close">${ic('x')}</button></div>
    <div class="modal-body fb">
      <div class="fb-bar">
        <button class="btn secondary sm icon-only" data-fb="up" ${d && d.parent ? '' : 'disabled'} title="Up one folder" aria-label="Up one folder">${ic('arrow-up')}</button>
        <button class="btn secondary sm icon-only" data-fb="home" title="Home folder" aria-label="Home folder">${ic('house')}</button>
        <span class="input" style="flex:1"><input id="fb-path" value="${esc(d ? d.path : FB.path)}" spellcheck="false" aria-label="Folder path"></span>
        <button class="btn secondary sm icon-only${FB.search ? ' on' : ''}" data-fb="search" title="Search this folder" aria-label="Search this folder" aria-pressed="${!!FB.search}">${ic('magnifying-glass')}</button>
      </div>
      ${FB.search ? `<span class="input">${ic('magnifying-glass')}<input id="fb-q" value="${esc(FB.q || '')}" placeholder="Filter folders by name" spellcheck="false" autocomplete="off" aria-label="Filter folders"></span>` : ''}
      ${d && !FB.onPick ? `<div class="fb-here ${d.git && d.commit === false ? 'warn' : ''}">${!d.git ? `${ic('folder-dashed')}Not a Git repository · Compare agents needs one`
        : d.commit === false ? `${ic('warning')}Git repository with no commit yet · Compare agents needs a first commit` : `${ic('git-branch')}This folder is a Git repository`}</div>` : ''}
      ${FB.err ? `<div class="pf-hint" style="color:var(--warning);margin:0">${esc(FB.err)}</div>` : ''}
      <div class="fb-list">${d ? d.dirs.map((n) => { const git = (d.repos || []).includes(n); return `<button class="fb-row" data-fb="in" data-name="${esc(n)}" ${FB.q && !n.toLowerCase().includes(FB.q.toLowerCase()) ? 'hidden' : ''}>${ic('folder')}<span>${esc(n)}</span>${git ? `<i class="fb-git" title="Git repository">${ic('git-branch')}</i>` : ''}${ic('caret-right')}</button>`; }).join('') || '<div class="dim" style="padding:12px;font-size:12px">No folders here</div>' : '<div class="dim" style="padding:12px;font-size:12px">Reading…</div>'}</div>
    </div>
    <div class="modal-foot">
      <label class="fb-hidden"><input type="checkbox" data-fb="hidden" ${FB.hidden ? 'checked' : ''}> Hidden folders</label>
      <span class="sp"></span>
      ${FB.onPick ? '' : `<button class="btn secondary sm" data-fb="clone" ${d ? '' : 'disabled'} title="Clone a project from its Git URL into a new folder here">${ic('git-fork')}Clone…</button>`}
      ${FB.device === 'local' ? '<button class="btn secondary sm" data-fb="mkdir">New folder</button>' : ''}
      <button class="btn secondary sm" data-fb="cancel">Cancel</button>
      <button class="btn primary sm" data-fb="open" ${d ? '' : 'disabled'}>Open</button>
    </div></div>`;
}
document.addEventListener('click', async (e) => {
  const opener = e.target.closest('[data-fb-open]');
  if (opener) { e.stopPropagation(); FB.data = null; FB.err = null; FB.onPick = null; FB.title = ''; FB.device = state.nsDevice || 'local'; fbPaint(); fbGo(opener.dataset.cwd || '~'); return; }
  const nsdev = e.target.closest('[data-nsdev]');
  if (nsdev) {
    /* Another device: rebuild the popover for it, keeping what was typed. */
    e.stopPropagation();
    if (nsdev.disabled) return;
    const prompt = ($('#ns-prompt') || {}).value || '', wt = !!$('#ns-wt.on');
    state.nsDevice = nsdev.dataset.nsdev;
    popNewSession();
    $('#ns-prompt').value = prompt;
    const t = $('#ns-wt'); if (t && t.classList.contains('on') !== wt) t.click();
    return;
  }
  const b = e.target.closest('[data-fb]');
  if (!b) return;
  e.stopPropagation();
  const d = FB.data, act = b.dataset.fb, sep = d && d.path.includes('\\') ? '\\' : '/';
  if (act === 'cancel') { FB.onPick = null; FB.title = ''; fbClose(); return; }
  if (act === 'up' && d && d.parent) fbGo(d.parent);
  if (act === 'home') fbGo('~');
  if (act === 'in' && d) { FB.q = ''; fbGo(d.path.replace(/[\\/]$/, '') + sep + b.dataset.name); }
  if (act === 'hidden') { FB.hidden = b.checked; fbGo(FB.path); }
  if (act === 'search') { FB.search = !FB.search; FB.q = ''; fbPaint(); $('#fb-q')?.focus(); }
  if (act === 'clone' && d) {
    const url = (prompt(`Git URL to clone into ${d.path}`) || '').trim();
    if (!url) return;
    b.disabled = true; b.textContent = 'Cloning…';
    const r = await fetch('/api/fs/clone', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ device: FB.device, path: d.path, url }) })
      .then((x) => x.json()).catch((err) => ({ error: err.message }));
    if (r.error) { toast(`Not cloned: ${r.error}`, 'warning'); fbPaint(); } else { toast(r.said, 'check-circle'); fbGo(r.path); }
    return;
  }
  if (act === 'mkdir' && d) {
    const name = (prompt('New folder name') || '').trim();
    if (!name) return;
    const r = await fetch('/api/fs/mkdir', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: d.path, name }) }).then((x) => x.json());
    if (r.error) toast(`Not created: ${r.error}`, 'warning'); else fbGo(r.path);
  }
  if (act === 'open' && d && FB.onPick) { const pick = FB.onPick; FB.onPick = null; FB.title = ''; fbClose(); pick(d.path); return; }
  if (act === 'open' && d) {
    const ws = $('#ns-ws');
    if (ws) {
      ws.dataset.cwd = d.path;
      ws.dataset.value = d.path.split(/[\\/]/).filter(Boolean).pop() || d.path;
      /* A folder inside a project I already work in (XBLabs/1 under XBLabs) joins that project. */
      const home = DB.sessions.map((s) => s.live).filter((r) => r && r.ws !== 'GOA' && (r.device || 'local') === (state.nsDevice || 'local') && r.cwd && inFolder(d.path, r.cwd))
        .sort((a, b) => a.cwd.length - b.cwd.length)[0];
      if (home) ws.dataset.value = home.ws;
      ws.title = d.path;
      ws.dataset.git = d.git ? (d.commit === false ? 'empty' : '1') : '0';
      ws.querySelector('span').innerHTML = `${d.git ? ic('git-branch', 'regular', 'ns-git') : ''}${esc(d.path)}`;
    }
    fbClose();
  }
}, true);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.id === 'fb-path') { e.preventDefault(); fbGo(e.target.value.trim() || '~'); }
  if (e.key === 'Escape' && document.getElementById('fb-layer') && !document.getElementById('fb-layer').hidden) { e.stopImmediatePropagation(); fbClose(); }
}, true);

/* Right-click on a session row or a project row opens its menu at the cursor (the "..." buttons
   are gone). An anchor at the pointer stands in for the button the menus used to sit under. */
document.addEventListener('contextmenu', (e) => {
  const sess = e.target.closest('[data-session]');
  const ws = !sess && e.target.closest('.ws-row[data-ws]');
  if (!sess && !ws) return;
  e.preventDefault();
  const at = (w) => ({ getBoundingClientRect: () => ({ bottom: e.clientY, top: e.clientY, left: e.clientX, right: e.clientX + w * ZM() }) });
  if (sess) popSessionMenu(at(216), sess.dataset.session);
  else popWsMenu(at(268), ws.dataset.ws);
});

/* Per-session actions from the sidebar: rename or delete. The row itself is a button that
   opens the session, so the kebab is a sibling — nesting buttons is invalid HTML and would
   make one swallow the other's click. */
function popSessionMenu(el, id) {
  const s = DB.sessions.find((x) => x.id === id);
  if (!s) return;
  popover.className = 'popover';
  popover.style.maxHeight = '';
  popover.innerHTML = `
    <div class="pop-head"><span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(s.title)}</span></div>
    <div class="pop-body" style="padding:4px">
      <div class="pop-row" data-act="rename-session" data-id="${id}">${ic('pencil-simple')}<span style="flex:1">Rename session</span></div>
      ${s.live && s.live.status === 'hibernated' ? `<div class="pop-row" data-act="wake-session" data-id="${id}">${ic('sun')}<span style="flex:1">Wake</span></div>`
        : s.live && !['done', 'failed', 'stopped', 'rejected'].includes(s.live.status) ? `<div class="pop-row" data-act="hibernate-session" data-id="${id}">${ic('moon')}<span style="flex:1">Hibernate</span></div>` : ''}
      ${(() => {
        const cs = s.agent && s.agent !== 'shell' ? cfgsOf(s.agent) : [], cur = (s.live || {}).config_id || '';
        if (!window.__cfgs) cfgLoad();
        return cs.length > 1 ? '<div class="pop-group">Switch config…</div>' + cs.map((c) => `<div class="pop-row" data-act="switch-config" data-id="${id}" data-cfg="${esc(c.id || 'official')}"><span style="flex:1">${esc(c.name)}</span>${(c.id || '') === cur ? ic('check') : ''}</div>`).join('') : '';
      })()}
      <div class="pop-row" data-act="delete-session" data-id="${id}" style="color:var(--danger)">${ic('trash')}<span style="flex:1">Delete session</span></div>
    </div>`;
  const r = zRect(el);
  popover.style.width = '216px';
  popover.style.top = Math.round(r.bottom + 6) + 'px';
  popover.style.left = Math.round(Math.max(8, Math.min(r.right - 216, VW() - 232))) + 'px';
  popover.hidden = false;
}

function modalRenameSession(id) {
  const s = DB.sessions.find((x) => x.id === id);
  if (!s) return;
  showModal(`
    <div class="modal-head"><div class="tb"><h2>Rename session</h2><p>${esc(s.id)} · ${esc(s.ws)}</p></div>
      <button class="close-x" data-act="close">${ic('x')}</button></div>
    <div class="modal-body">
      <div class="field"><label for="rename-input">Session name</label>
        <div class="input">${ic('chat-circle')}<input id="rename-input" value="${esc(s.title)}" maxlength="80"></div>
        <small>Shown in the sidebar, board and session header.</small></div>
    </div>
    <div class="modal-foot"><span class="sp"></span>
      <button class="btn secondary sm" data-act="close">Cancel</button>
      <button class="btn primary sm" data-act="rename-save" data-id="${id}">Save name</button></div>`, 420);
  const input = $('#rename-input');
  setTimeout(() => { input.focus(); input.select(); }, 40);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); $('[data-act="rename-save"]').click(); }
  });
}

/* Shared destructive-action confirm so every dangerous button asks the same way. */
function modalConfirm(title, body, label, act) {
  showModal(`
    <div class="modal-head"><div class="tb"><h2>${esc(title)}</h2></div>
      <button class="close-x" data-act="close">${ic('x')}</button></div>
    <div class="modal-body"><p style="margin:0;font-size:12.5px;line-height:1.55;color:var(--text-secondary)">${esc(body)}</p></div>
    <div class="modal-foot"><span class="sp"></span>
      <button class="btn secondary sm" data-act="close">Cancel</button>
      <button class="btn danger sm" data-act="${act}">${ic('trash')}${esc(label)}</button></div>`, 440);
}

function modalShortcuts() {
  const rows = [['Search sessions', 'Ctrl K'], ['Quick commands', 'Ctrl K'], ['Focus mode', 'Ctrl F'],
    ['New session', 'Ctrl N'], ['Toggle sidebar', 'Ctrl B'], ['Settings', 'Ctrl ,'],
    ['Send message', 'Enter'], ['Close overlay', 'Esc']];
  showModal(`
    <div class="modal-head"><div class="tb"><h2>Keyboard shortcuts</h2><p>Everything you can do without the mouse</p></div>
      <button class="close-x" data-act="close">${ic('x')}</button></div>
    <div class="modal-body" style="gap:0">
      ${rows.map(([l, k]) => `<div class="kv" style="padding:7px 0"><div class="kt"><b style="font-size:12px;font-weight:400">${l}</b></div>
        <kbd class="kbd neutral">${k}</kbd></div>`).join('')}
    </div>
    <div class="modal-foot"><span class="sp"></span><button class="btn secondary sm" data-act="close">Close</button></div>`, 420);
}

/* The session's change set against the branch it came from, and the git actions on it.
   Merge and discard touch the real checkout or delete work, so each asks again. */
async function modalDiff(id) {
  if (!id) return;
  showModal(`<div class="modal-head"><div class="tb"><h2>Changes</h2><p>Reading the worktree…</p></div><button class="close-x" data-act="close">${ic('x')}</button></div><div class="modal-body"></div>`, 760);
  const g = await gitLoad(id);
  if (overlay.hidden) return;
  if (g.error) {
    showModal(`<div class="modal-head"><div class="tb"><h2>Changes</h2><p>${esc(g.error)}</p></div><button class="close-x" data-act="close">${ic('x')}</button></div>
      <div class="modal-foot"><span class="sp"></span><button class="btn secondary sm" data-act="close">Close</button></div>`, 520);
    return;
  }
  const d = g.data;
  const add = d.stat.reduce((a, x) => a + x.add, 0), del = d.stat.reduce((a, x) => a + x.del, 0);
  const cls = (l) => (l.startsWith('+++') || l.startsWith('---') || l.startsWith('diff ') || l.startsWith('index ') || l.startsWith('@@') ? 'd' : l[0] === '+' ? 'ok' : l[0] === '-' ? 'err' : '');
  const lines = d.patch ? d.patch.split('\n').slice(0, 4000) : [];
  /* Each added or kept line knows its file and new line number, so a click can quote it. */
  let file = '', n = 0;
  const refs = lines.map((l) => {
    if (l.startsWith('+++ ')) { file = l.slice(4).replace(/^b\//, ''); return ''; }
    const h = l.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
    if (h) { n = +h[1]; return ''; }
    if (!file || l.startsWith('diff ') || l.startsWith('index ') || l.startsWith('--- ') || l[0] === '-') return '';
    return `${file}:${n++}`;
  });
  const talk = agentChat(id) && window.__liveRuns.get(id)?.status !== 'done';
  showModal(`
    <div class="modal-head"><div class="tb"><h2>Changes · <span class="mono">${esc(d.branch)}</span></h2>
      <p>${d.device ? `On ${esc(d.device)} · ` : ''}${d.stat.length} file${d.stat.length === 1 ? '' : 's'} · +${add} −${del} vs ${esc(d.base)}${d.ahead ? ` · ${d.ahead} commit${d.ahead === 1 ? '' : 's'}` : ''}${d.dirty ? ' · uncommitted changes' : ''}</p></div>
      <button class="close-x" data-act="close">${ic('x')}</button></div>
    <div class="modal-body" style="padding:0">
      ${(d.overlap || []).length ? `<div class="pf-hint" style="margin:10px 14px 0;color:var(--warning)">${ic('warning')} Also changed in another session: ${d.overlap.map((o) => `<b>${esc(o.title)}</b> (${o.files.slice(0, 4).map(esc).join(', ')}${o.files.length > 4 ? ' …' : ''})`).join('; ')}. Merge one, then look again before the next.</div>` : ''}
      <div class="term-body" style="max-height:420px">${lines.length ? lines.map((l, i) => `<div class="tl ${cls(l)}"${talk && refs[i] ? ` data-diffref="${esc(refs[i])}" title="Click to quote ${esc(refs[i])} in the note" style="cursor:pointer"` : ''}>${esc(l) || ' '}</div>`).join('')
        : '<div class="tl d">No changes against the base branch.</div>'}${d.cut || lines.length === 4000 ? '<div class="tl d">… cut here, the full diff is in the worktree</div>' : ''}</div>
      ${talk ? `<div style="display:flex;gap:6px;padding:10px 14px;border-top:1px solid var(--border-subtle)">
        <span class="input" style="flex:1"><textarea id="git-note" rows="2" maxlength="4000" style="flex:1;border:0;background:none;outline:none;resize:none;font:inherit;color:inherit" placeholder="Note for the agent. Click a diff line to quote it."></textarea></span>
        <button class="btn secondary sm" data-act="git-note" data-id="${esc(id)}">Send to agent</button></div>` : ''}
    </div>
    <div class="modal-foot" style="flex-wrap:wrap;gap:6px">
      ${d.dirty ? `<span class="input" style="flex:1;min-width:200px"><input id="git-msg" placeholder="Commit message" maxlength="200"></span>
      <button class="btn primary sm" data-act="git-act" data-git="commit" data-id="${esc(id)}">Commit</button>` : '<span class="sp"></span>'}
      <button class="btn secondary sm" data-act="git-act" data-git="push" data-id="${esc(id)}" ${d.ahead ? '' : 'disabled'} title="Push ${esc(d.branch)} to origin">Push</button>
      <button class="btn secondary sm" data-act="git-act" data-git="pr" data-id="${esc(id)}" ${d.ahead ? '' : 'disabled'} title="Open a pull request with gh">Open PR</button>
      <button class="btn secondary sm" data-act="git-act" data-git="merge" data-id="${esc(id)}" ${d.ahead && !d.dirty ? '' : 'disabled'} title="Merge into ${esc(d.base)} in the project folder${d.device ? ` on ${esc(d.device)}` : ''}">${d.device ? `Merge on ${esc(d.device)}` : `Merge into ${esc(d.base)}`}</button>
      ${d.device ? `<button class="btn secondary sm" data-act="git-act" data-git="hub" data-id="${esc(id)}" ${d.ahead && !d.dirty ? '' : 'disabled'} title="Copy ${esc(d.branch)} into the project on this hub${d.hubRepo ? ` (${esc(d.hubRepo)})` : ''}; commit first">${ic('download-simple')}Bring to hub</button>
      <button class="btn secondary sm" data-act="git-act" data-git="hub-merge" data-id="${esc(id)}" ${d.ahead && !d.dirty ? '' : 'disabled'} title="Bring it to this hub and merge it into ${esc(d.base)} there">Bring &amp; merge on hub</button>` : ''}
      <button class="btn danger sm" data-act="git-act" data-git="discard" data-id="${esc(id)}" title="Delete the worktree and its branch">Discard</button>
    </div>`, 760);
}
async function gitAct(btn) {
  const { git: action, id } = btn.dataset;
  /* Irreversible or outward-facing: a second click confirms. */
  if (['merge', 'discard', 'push', 'pr', 'hub-merge'].includes(action) && !btn.dataset.armed) {
    btn.dataset.armed = '1';
    btn.textContent = { merge: 'Click again to merge', discard: 'Click again: deletes the work', push: 'Click again to push', pr: 'Click again to open PR', 'hub-merge': 'Click again to merge on this hub' }[action];
    return;
  }
  const message = ($('#git-msg') || {}).value || '';
  /* Bring to hub: the branch comes over as a bundle into this hub's checkout of the project. */
  const hub = action === 'hub' || action === 'hub-merge';
  btn.disabled = true;
  if (hub) btn.textContent = 'Bringing…';
  const r = await fetch(`/api/sessions/${id}/git`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(hub ? { action: 'hub', merge: action === 'hub-merge', repo: btn.dataset.repo || undefined } : { action, message }) })
    .then((x) => x.json()).catch((err) => ({ error: err.message }));
  if (r.needRepo) {
    /* No checkout of this project on the hub yet: pick it once, it is remembered per project. */
    btn.disabled = false; btn.textContent = 'Pick the folder…';
    FB.data = null; FB.err = null; FB.device = 'local'; FB.title = 'This project on the hub'; FB.onPick = (path) => { btn.dataset.repo = path; btn.dataset.armed = '1'; gitAct(btn); };
    fbPaint(); fbGo('~');
    return;
  }
  if (r.error) { btn.disabled = false; toast(`${action}: ${r.error}`, 'warning'); return; }
  toast(r.said || `${action} done`, 'check-circle', action === 'merge' ? { ms: 8000, action: { label: 'Remove worktree', fn: () => {
    fetch(`/api/sessions/${id}/git`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'discard' }) })
      .then((x) => x.json()).then((j) => { toast(j.error ? `Not removed: ${j.error}` : j.said, j.error ? 'warning' : 'check-circle'); delete GIT[id]; closeAll(); return liveLoad(); }).then(() => render());
  } } } : {});
  await liveLoad();
  if (r.removed) { delete GIT[id]; closeAll(); render(); return; }
  modalDiff(id);
}

/* A note from the review goes into the agent like a typed message: text, then Enter apart. */
async function gitNote(id) {
  const box = $('#git-note');
  const text = (box && box.value || '').trim();
  if (!text) { box && box.focus(); return; }
  const put = (data) => fetch(`/api/sessions/${id}/input`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data }) });
  await put(`Review note: ${text.replace(/\s*\n\s*/g, ' ')}`);
  await new Promise((r) => setTimeout(r, 200));
  await put('\r');
  box.value = '';
  toast('Sent to the agent');
}
document.addEventListener('click', (e) => {
  const ref = e.target.closest('[data-diffref]');
  const box = ref && $('#git-note');
  if (!box) return;
  box.value = `${box.value.trimEnd()}${box.value.trim() ? ' ' : ''}${ref.dataset.diffref} `;
  box.focus();
});

function popWsMenu(anchor, id) {
  const w = DB.workspaces.find((x) => x.id === id) || { id, dir: id, hosts: '' };
  const n = DB.sessions.filter((s) => s.ws === id).length;
  popover.className = 'popover';
  popover.style.maxHeight = '';
  popover.innerHTML = `
    <div class="pop-head"><span style="flex:1">${esc(w.dir)}</span><small class="dim">${n} session(s)</small></div>
    <div class="pop-body" style="padding:4px">
      <div class="pop-row" data-act="ws-new-session" data-id="${esc(id)}">${ic('plus')}<span style="flex:1">New session</span><small class="dim">in this folder</small></div>
      <div class="pop-row" data-act="ws-clear" data-id="${esc(id)}" style="color:var(--danger)">${ic('trash')}<span style="flex:1">Clear session list</span><small class="dim">keeps the folder</small></div>
      <div class="pop-row" data-act="ws-delete" data-id="${esc(id)}" style="color:var(--danger)">${ic('trash-simple')}<span style="flex:1">Delete project</span><small class="dim">keeps files on disk</small></div>
    </div>`;
  const r = zRect(anchor);
  popover.style.width = '268px';
  popover.style.top = Math.round(Math.min(r.bottom + 6, VH() - 200)) + 'px';
  popover.style.left = Math.round(Math.max(8, Math.min(r.right - 268, VW() - 276))) + 'px';
  popover.hidden = false;
}

/* Clearing a workspace removes session rows only — the directory and its branches stay. */
function modalWsClear(id) {
  const w = DB.workspaces.find((x) => x.id === id) || { id, dir: id };
  const n = DB.sessions.filter((s) => s.ws === id).length;
  showModal(`
    <div class="modal-head"><div class="tb"><h2>Clear ${esc(w.dir)}?</h2><p>${n} session(s) will disappear from the sidebar, board and usage.</p></div>
      <button class="close-x" data-act="close">${ic('x')}</button></div>
    <div class="modal-body">
      <p style="margin:0;font-size:12.5px;line-height:1.55;color:var(--text-secondary)">
        Only the session records go. The folder on disk, its git branches and any running agent process stay exactly where they are.</p>
    </div>
    <div class="modal-foot"><span class="sp"></span>
      <button class="btn secondary sm" data-act="close">Cancel</button>
      <button class="btn danger sm" data-act="ws-clear-confirm" data-id="${esc(id)}">${ic('trash')}Clear ${n}</button></div>`, 440);
}

/* Deleting a project removes the row and its sessions — never anything under the folder. */
function modalWsDelete(id) {
  const w = DB.workspaces.find((x) => x.id === id) || { id, dir: id };
  const n = DB.sessions.filter((s) => s.ws === id).length;
  showModal(`
    <div class="modal-head"><div class="tb"><h2>Delete ${esc(w.dir)}?</h2><p>${n} session(s) and the workspace row go away.</p></div>
      <button class="close-x" data-act="close">${ic('x')}</button></div>
    <div class="modal-body">
      <p style="margin:0 0 10px;font-size:12.5px;line-height:1.55;color:var(--text-secondary)">
        Nothing on disk is touched: <b style="color:var(--text-primary)">${esc(w.dir)}</b> stays exactly where it is,
        with its git branches, its database files and everything else inside it. XBLabs only forgets that it
        managed this folder.</p>
      <p style="margin:0;font-size:11.5px;line-height:1.5;color:var(--text-tertiary)">
        Starting a new run in that folder later brings it back to the list.</p>
    </div>
    <div class="modal-foot"><span class="sp"></span>
      <button class="btn secondary sm" data-act="close">Cancel</button>
      <button class="btn danger sm" data-act="ws-delete-confirm" data-id="${esc(id)}">${ic('trash')}Delete project</button></div>`, 480);
}

function modalDeleteSession(id) {
  const s = DB.sessions.find((x) => x.id === id);
  if (!s) return;
  showModal(`
    <div class="modal-head"><div class="tb"><h2>Delete session?</h2><p>${esc(s.id)} · ${esc(s.ws)}</p></div>
      <button class="close-x" data-act="close">${ic('x')}</button></div>
    <div class="modal-body">
      <p style="margin:0;font-size:12.5px;line-height:1.55;color:var(--text-secondary)">
        <b style="color:var(--text-primary)">${esc(s.title)}</b> will be removed from the sidebar and the board.
        Its branch <span class="mono">${esc(s.branch)}</span> stays untouched on the device.</p>
    </div>
    <div class="modal-foot"><span class="sp"></span>
      <button class="btn secondary sm" data-act="close">Cancel</button>
      <button class="btn danger sm" data-act="delete-confirm" data-id="${id}">${ic('trash')}Delete session</button></div>`, 460);
}

/* One filter popover, facets picked by the page you're on. Every control writes real state, so
   closing it is enough — the list behind already re-rendered. */
function popFilter(anchor) {
  const page = state.page;
  const wsFacet = `<div class="pop-sec"><h5>Workspace</h5>
      ${[['all', 'All', DB.sessions.length], ...DB.workspaces.slice(0, 3).map((w) => [w.id, w.dir, DB.sessions.filter((s) => s.ws === w.id).length])]
        .map(([k, l, n]) => `<button class="pop-row" data-ws="${k}" style="height:26px">
          <span style="flex:1">${esc(l)}</span><span class="meta">${n}</span>
          ${(state.ws === k) || (state.ws === 'all' && k === 'all') ? ic('check', 'bold', 'ok') : ''}</button>`).join('')}</div>`;

  const facet = page === 'notes'
    ? `<div class="pop-sec"><h5>Show</h5>
        <div class="segment" style="background:var(--bg-sunken)">
          ${[['all', 'All'], ['pinned', 'Pinned'], ['mine', 'Mine'], ['shared', 'Shared']]
            .map(([k, l]) => `<button class="${state.noteFilter === k ? 'active' : ''}" data-nf="${k}" style="flex:1">${l}</button>`).join('')}
        </div></div>`
    : `<div class="pop-sec"><h5>Status</h5>
        <div class="segment" style="background:var(--bg-sunken)">
          ${[['all', 'All'], ['online', 'Online'], ['idle', 'Idle'], ['offline', 'Offline']]
            .map(([k, l]) => `<button class="${state.devStatus === k ? 'active' : ''}" data-devst="${k}" style="flex:1">${l}</button>`).join('')}
        </div></div>`;

  const count = page === 'notes' ? DB.notes.length : DB.devices.length;
  popover.className = 'popover';
  popover.style.maxHeight = '';
  popover.innerHTML = `
    <div class="pop-head"><span style="flex:1">Filter</span>
      <button class="link" style="font-size:11px" data-act="filter-reset">Reset</button></div>
    ${wsFacet}
    ${facet}
    <div class="pop-foot"><span style="font-size:11px;color:var(--text-tertiary)">${count} total</span>
      <span class="grow"></span><button class="btn primary xs" data-act="filter-close">Done</button></div>`;
  placePopover(popover, anchor || '.page-head .btn.secondary', 320);
  popover.hidden = false;
}

/* Window chrome. Packaged in Tauri these are real; in the browser preview they can't be, and
   silently doing nothing would read as a broken button. */
/* Desktop build: the title bar drags the window and a double-click maximizes, except on its controls.
   (-webkit-app-region is Electron's; the Tauri webview needs the call.) */
document.addEventListener('mousedown', (e) => {
  const w = window.__TAURI__?.window?.getCurrentWindow?.();
  if (!w || e.button !== 0 || !e.target.closest('#titlebar') || e.target.closest('button, a, input, select, [data-win]')) return;
  if (e.detail === 2) w.toggleMaximize(); else w.startDragging();
});
async function windowAction(kind) {
  const api = window.__TAURI__?.window;
  const w = api?.getCurrentWindow?.() || api?.getCurrent?.();
  if (!w) { toast('Window controls work in the desktop build', 'info'); return; }
  try {
    if (kind === 'min') await w.minimize();
    else if (kind === 'max') { if (await w.isMaximized()) await w.unmaximize(); else await w.maximize(); }
    else if (kind === 'close') await w.close();
  } catch (err) { toast(`Window action failed: ${err.message || err}`, 'warning'); }
}
/* Small chooser used by the focus pane pickers. Picking closes the menu and names the button. */
function popPick(anchor, title, items) {
  popover.className = 'popover';
  popover.style.maxHeight = '';
  popover.innerHTML = `
    <div class="pop-head"><span style="flex:1">${esc(title)}</span></div>
    <div class="pop-body" style="padding:4px;max-height:260px;overflow:auto">
      ${items.map((i) => `<div class="pop-row" data-pick="${esc(i)}">${esc(i)}</div>`).join('')}
    </div>`;
  const r = zRect(anchor);
  popover.style.width = '240px';
  popover.style.top = Math.round(Math.min(r.bottom + 6, VH() - 280)) + 'px';
  popover.style.left = Math.round(Math.max(8, Math.min(r.left, VW() - 250))) + 'px';
  popover.hidden = false;
  popover.querySelectorAll('[data-pick]').forEach((row) => row.addEventListener('click', () => {
    const label = row.dataset.pick;
    anchor.innerHTML = `${label} ${ic('caret-down')}`;
    closeAll();
  }));
}


/* ---------- composer pickers + attachments ----------
   The attach menu drives real <input type=file> elements, so the chosen names come from the OS
   dialog rather than being faked. Pickers write to state and re-render, keeping the chat head in sync. */
/* Model names come from the catalog in Settings → Models & keys. The built-in three are only a
   fallback for a hub with no endpoint and no catalog yet. */
/* The env vars every run receives, grouped by what they carry, one row per group. */
function llmEnvList() {
  const names = (window.LIVE && LIVE.llm && LIVE.llm.env_names) || [];
  if (!names.length) return '<div class="llm-env-empty">Nothing saved yet. Every run starts with its own default endpoint.</div>';
  const groups = [['Endpoint', /_BASE_URL$/], ['Key', /_(API_KEY|AUTH_TOKEN)$/], ['Model', /_MODEL$/]];
  const rest = names.filter((n) => !groups.some(([, re]) => re.test(n)));
  return `<div class="llm-env"><div class="llm-env-title">Set for those runs</div>${
    [...groups.map(([label, re]) => [label, names.filter((n) => re.test(n))]), ['Other', rest]]
      .filter(([, list]) => list.length)
      .map(([label, list]) => `<div class="llm-env-row"><span>${label}</span><div>${list.map((n) => `<code>${esc(n)}</code>`).join('')}</div></div>`).join('')
  }</div>`;
}
/* One chip per agent: on = that agent's runs get the endpoint env. Saved on click. */
function llmAgentChips() {
  const llm = (window.LIVE && LIVE.llm) || {};
  const on = llm.agents || [];
  return `<div class="field"><label>Use this endpoint for</label><div style="display:flex;flex-wrap:wrap;gap:6px">${
    [...allAgentIds(), 'shell'].map((a) => `<button class="chip ag-chip ${on.includes(a) ? 'active' : ''} ${a === 'shell' || agentInstalled(a) ? '' : 'off'}" data-llm-agent="${esc(a)}" aria-pressed="${on.includes(a)}" ${a === 'shell' || agentInstalled(a) || on.includes(a) ? '' : 'disabled'} title="${a === 'shell' || agentInstalled(a) ? 'Installed' : 'Not installed on this hub'}">${agentLogo(a)}${esc(a === 'shell' ? 'Plain shell' : AGENT_NAMES[a] || a)}</button>`).join('')
  }</div></div>`;
}
function modelChoices() {
  const llm = (window.LIVE && LIVE.llm) || {};
  const cat = (llm.models || []).map((m) => m.name || modelShort(m.id));
  if (cat.length) return [...new Set(cat)];
  return llm.model ? [modelShort(llm.model)] : ['Sonnet 4.5', 'Opus 4.5', 'Haiku 4.0'];
}
/* The composer always shows a model that exists: the endpoint's default, else the first. */
function syncModel() {
  const list = modelChoices();
  if (list.includes(state.model)) return;
  const llm = (window.LIVE && LIVE.llm) || {};
  const def = (llm.models || []).find((m) => m.id === llm.model);
  state.model = def ? def.name || modelShort(def.id) : list[0];
}
/* Approval mode: what a tool call the agent's own rules stopped gets. Per session on the hub;
   teammates and pipeline stages take their lead's. */
const APPR = { 'Auto-approve': 'auto', 'Ask every time': 'ask', 'Read-only': 'read' };
const APPR_HINT = 'Auto-approve: blocked commands run without asking · Ask: a card waits for you · Read-only: blocked commands are refused';
function apprLabel(id) {
  const r = window.__liveRuns && window.__liveRuns.get(id);
  const m = r ? r.approval || 'ask' : APPR[state.approval];
  return Object.keys(APPR).find((k) => APPR[k] === m) || 'Ask every time';
}
const CHOICES = {
  get model() { return modelChoices(); },
  reasoning: ['Off', 'Low', 'Medium', 'High'],
  approval: ['Auto-approve', 'Ask every time', 'Read-only'],
};

function popChoice(anchor, spec) {
  const [key, field] = spec.split(':');
  const items = CHOICES[key];
  popover.className = 'popover';
  popover.style.maxHeight = '';
  popover.innerHTML = `
    <div class="pop-head"><span style="flex:1">${key === 'model' ? 'Model' : key === 'reasoning' ? 'Reasoning effort' : 'Approval mode'}</span></div>
    <div class="pop-body" style="padding:4px">
      ${items.map((i) => `<div class="pop-row${state[field] === i ? ' sel' : ''}" data-choice="${key}" data-val="${esc(i)}">
        <span style="flex:1">${esc(i)}</span>${state[field] === i ? ic('check', 'bold', 'ok') : ''}</div>`).join('')}
    </div>`;
  positionComposerMenu(popover);
}

function popAttach(anchor) {
  const rows = [
    ['file', 'Upload file', 'file-code', 'multiple'],
    ['image', 'Upload image', 'image', 'multiple'],
    ['folder', 'Upload folder', 'folder-open', 'folder'],
    ['clip', 'Paste from clipboard', 'clipboard', ''],
  ];
  popover.className = 'popover';
  popover.style.maxHeight = '';
  popover.innerHTML = `
    <div class="pop-head"><span style="flex:1">Add context</span></div>
    <div class="pop-body" style="padding:4px">
      ${rows.map(([k, l, i]) => `<div class="pop-row" data-attach="${k}">${ic(i)}<span style="flex:1">${l}</span></div>`).join('')}
    </div>
    <div class="pop-foot"><span style="font-size:10.5px;color:var(--text-disabled)">Files stay on this machine</span></div>`;
  positionComposerMenu(popover);
}

/* An image pasted into the composer is attached like a picked one. */
document.addEventListener('paste', (e) => {
  if (e.target.id !== 'composer') return;
  const imgs = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/')).slice(0, 12);
  if (!imgs.length) return;
  e.preventDefault();
  const typed = e.target.value;
  imgs.forEach((f, i) => state.attached.push({ name: f.name || `pasted-${i + 1}.png`, size: `${Math.max(1, Math.round(f.size / 1024))} KB`, img: URL.createObjectURL(f), file: f }));
  render(); const c = $('#composer'); if (c) { c.value = typed; c.focus(); }
});
/* Clicking an attached image shows it full size; any click or Esc closes it. */
document.addEventListener('click', (e) => {
  const img = e.target.closest('.atch.img img');
  if (!img) return;
  const z = document.createElement('div');
  z.className = 'img-zoom';
  z.innerHTML = `<img src="${img.src}" alt="">`;
  const close = () => { z.remove(); document.removeEventListener('keydown', esc1); };
  const esc1 = (k) => { if (k.key === 'Escape') close(); };
  z.addEventListener('click', close);
  document.addEventListener('keydown', esc1);
  document.body.append(z);
});
/* One file dialog per kind; the element is created on demand so no stray inputs in the DOM. */
function pickFiles(kind) {
  if (kind === 'clip') {
    navigator.clipboard?.readText?.().then((t) => {
      const input = $('#composer');
      if (input && t) input.value = (input.value + ' ' + t).trim();
      closeAll();
    }).catch(() => { closeAll(); toast('Clipboard is empty or blocked', 'warning'); });
    return;
  }
  closeAll(); // menu closes before the OS dialog takes focus
  const el = document.createElement('input');
  el.type = 'file';
  el.multiple = true;
  if (kind === 'image') el.accept = 'image/*';
  if (kind === 'folder') el.webkitdirectory = true;
  el.addEventListener('change', () => {
    const files = [...el.files].slice(0, 12);
    files.forEach((f) => state.attached.push({ name: f.name, size: `${Math.max(1, Math.round(f.size / 1024))} KB`, img: f.type.startsWith('image/') ? URL.createObjectURL(f) : '', file: f }));
    closeAll();
    render();
    if (files.length) toast(`${files.length} file(s) attached`, 'paperclip');
  });
  el.click();
}

/* Anchor a popover under a control, clamped into the viewport. */
function positionUnder(el, anchor, width) {
  const r = zRect(anchor);
  el.style.width = width + 'px';
  el.style.top = Math.round(Math.min(r.bottom + 6, VH() - 260)) + 'px';
  el.style.left = Math.round(Math.max(8, Math.min(r.left, VW() - width - 12))) + 'px';
  el.hidden = false;
}

/* Every composer menu opens from the same place: above the composer box, left edge aligned to it,
   bottom edge pinned 8px above it. Anchoring each one to its own button made them jump around —
   the four controls sit on different rows and their own y offsets differ by tens of pixels. */
function positionComposerMenu(el, width = 260) {
  const cmp = document.querySelector('.composer'), box = cmp && zRect(cmp);
  if (!box) return positionUnder(el, document.body, width);
  el.style.width = width + 'px';
  el.style.maxHeight = '';
  el.hidden = false;
  const h = zRect(el).height;
  el.style.left = Math.round(Math.max(8, Math.min(box.left, VW() - width - 12))) + 'px';
  el.style.top = Math.round(Math.max(8, box.top - h - 8)) + 'px';
}

function popLogFilter(anchor) {
  const srcs = [...new Set(DB.logs.map((l) => l.src))];
  popover.className = 'popover';
  popover.style.maxHeight = '';
  popover.innerHTML = `
    <div class="pop-head"><span style="flex:1">Filter stream</span>
      <button class="link" style="font-size:11px" data-act="log-filter-reset">Reset</button></div>
    <div class="pop-sec"><h5>Source</h5>
      ${['all', ...srcs].map((s) => `<button class="pop-row" data-logfilter="${s}" style="height:26px">
        <span style="flex:1">${esc(s === 'all' ? 'All sources' : s)}</span>
        ${state.logFilter === s ? ic('check', 'bold', 'ok') : ''}</button>`).join('')}</div>
    <div class="pop-sec"><h5>Level</h5>
      <div class="segment" style="background:var(--bg-sunken)">
        ${['all', 'info', 'warn', 'error'].map((l) => `<button class="${state.logLevel === l ? 'active' : ''}" data-level="${l}" style="flex:1">${l}</button>`).join('')}
      </div></div>
    <div class="pop-foot"><span class="grow"></span><button class="btn primary xs" data-act="close">Done</button></div>`;
  placePopover(popover, anchor, 300);
  popover.hidden = false;
}

function popProfile() {
  popover.innerHTML = `
    <div class="profile-head" data-act="edit-profile" title="Edit profile"><div class="avatar">${avatarHTML()}</div>
      <div class="id"><b>${esc(DB.user.name)}</b><small>${esc(DB.user.email)}</small></div></div>
    <div class="pop-body" style="padding:6px">
      ${[['Edit profile', '', 'user-circle', 'edit-profile'], ['Settings', 'Ctrl ,', 'gear-six', 'settings'], ['Keyboard shortcuts', 'Ctrl /', 'keyboard', 'shortcuts']]
        .map(([l, k, i, act]) => `<div class="pop-row" data-act="${act}">${ic(i)}<span style="flex:1">${l}</span>${k ? `<span class="right">${k}</span>` : ''}</div>`).join('')}
    </div>
    <div class="usage-mini"><span>Dashboard runtime · opened ${openedAt()}</span><b class="num" style="font-size:12px;color:var(--text-primary)" data-uptime>${uptime()}</b></div>`;
  const r = zRect($('.profile'));
  popover.className = 'popover';
  popover.style.width = '352px';
  popover.style.left = '12px';
  popover.hidden = false;
  /* Opens upward off the profile strip; measured, not guessed. */
  const h = popover.offsetHeight;
  popover.style.top = Math.round(Math.max(12, Math.min(r.top - 8 - h, VH() - 12 - h))) + 'px';
}
/* Command palette (Ctrl K): type to filter, Enter runs the first visible row. */
const PALETTE = [
  ['New session', 'chat-circle-plus'], ['Go to Overview', 'squares-four'], ['Go to Sessions', 'chats-circle'],
  ['Go to Jobs', 'kanban'], ['Go to Devices', 'desktop'], ['Go to Usage', 'chart-line-up'], ['Go to Terminal', 'terminal-window'],
  ['Go to Notes', 'notebook'], ['Enter focus mode', 'corners-out'], ['New shell', 'terminal'], ['Dispatch job', 'paper-plane-tilt'],
  ['Pair a device', 'qr-code'], ['Open settings', 'gear-six'], ['Toggle theme', 'moon']
];
function paletteRows(q) {
  q = q.trim().toLowerCase();
  const rows = PALETTE.filter(([l]) => !q || l.toLowerCase().includes(q));
  return rows.map(([l, i], k) => `<div class="palette-row ${k === 0 ? 'sel' : ''}" data-cmd="${l}">${ic(i)}<span>${l}</span></div>`).join('')
    || `<div class="jempty" style="padding:16px">No command matches “${esc(q)}”</div>`;
}
function popPalette() {
  popover.innerHTML = `
    <div class="pop-head">${ic('magnifying-glass')}<input id="palette-q" placeholder="Type a command" aria-label="Command"><kbd class="kbdcap">esc</kbd></div>
    <div class="pop-body" id="palette-body">${paletteRows('')}</div>
    <div class="pop-foot"><span>Enter runs the first row</span><span class="grow"></span><span>${PALETTE.length} commands</span></div>`;
  centerPop(popover, 640, 'palette');
  setTimeout(() => $('#palette-q')?.focus(), 30);
}

/* ---------- events ---------- */
/* ---------- rail tooltip ----------
   The sidebar clips its own overflow, so a ::after tooltip would be cut off. One fixed element
   outside the sidebar is the smallest thing that survives the clip. */
const railTip = () => $('#railtip');
document.addEventListener('mouseover', (e) => {
  const t = railTip();
  if (!t) return; // a mouseover can land before the parser reaches #railtip
  const row = e.target.closest('.sidebar.collapsed .navitem[data-label], .sidebar.collapsed .ws-row[data-label], .sidebar.collapsed .ws-all[data-label]');
  if (!row) { t.hidden = true; return; }
  t.textContent = row.dataset.label;
  t.hidden = false;
  const r = zRect(row);
  const rail = document.querySelector('.sidebar');
  // Anchor to the rail's outer edge, not the row's: rows sit inside 12px of padding and the tip
  // would otherwise overlap the rail.
  t.style.left = Math.round((rail ? zRect(rail).right : r.right) + 8) + 'px';
  t.style.top = Math.round(Math.max(6, Math.min(r.top + r.height / 2 - t.offsetHeight / 2, VH() - t.offsetHeight - 6))) + 'px';
});
document.addEventListener('mouseout', (e) => {
  if (e.target.closest('.navitem, .ws-row, .ws-all')) railTip().hidden = true;
});

/* Profile card: bound in the capture phase so it opens even if `data-act` is missing (a stale
   build shipped a bare <button class="profile">) and so the delegated handler below cannot
   close it in the same click. */
document.addEventListener('click', (e) => {
  if (!e.target.closest('.profile')) return;
  e.stopPropagation();
  popProfile();
}, true);

document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-nav],[data-view],[data-ws],[data-device],[data-session],[data-note],[data-act],[data-stab],[data-palette],[data-logtab],[data-level],[data-status],[data-cmd],[data-ptab],[data-sessmenu],[data-tab],[data-tabclose],[data-win],[data-devst],[data-nf],[data-range],[data-group],[data-sort],[data-follow],[data-theme-mode],[data-settings-tab],[data-toggle],[data-logfilter],[data-glass-palette],[data-glass-fit],[data-file],[data-folder],[data-agentpick],[data-opts],[data-fold],[data-choice-btn],[data-unattach],[data-attach],[data-nscfg],[data-choice],[data-run-terminal],[data-termtab],[data-termtab-close],[data-termhost],[data-devmenu],[data-wsmenu],[data-newchat],[data-snd-test],[data-stage-del],[data-stage-add]');
  if (!t) {
    if (!e.target.closest('#popover, .btn.search, .tb-search, .glide')) {
      /* A popover holding a form (new session, search) stays until Esc: a stray click used to
         throw away a typed prompt. */
      const holdsForm = !!popover.querySelector('textarea, input');
      if (!popover.hidden && !holdsForm) {
        popover.hidden = true;
        if (!overlay.hidden && !overlay.querySelector('.modal')) overlay.hidden = true;
      }
    }
    return;
  }
  const d = t.dataset;
  if (d.newchat) { closeAll(); newChatIn(d.newchat); return; }

  if (d.nav) { state.page = d.nav; closeAll(); render(); }
  if (d.view) { state.view = d.view; render(); }
  if (d.ws && !d.act) {
    // A project row is both a filter and a disclosure: first click opens its session list,
    // second click closes it. Filter state (state.ws) and disclosure (state.openWs) are separate
    // on purpose — the row stays highlighted while its list is collapsed.
    if (d.ws === 'all') { state.ws = 'all'; state.openWs = null; render(); return; }
    state.ws = d.ws;
    state.openWs = state.openWs === d.ws ? null : d.ws;
    render();
  }
  if (d.device) { state.selectedDevice = d.device; render(); }
  if (d.ptab) { state.sideTab = d.ptab; render(); return; }
  if (d.sessmenu) { e.stopPropagation(); popSessionMenu(t, d.sessmenu); return; }
  if (d.wsmenu) { e.stopPropagation(); popWsMenu(t, d.wsmenu); return; }
  // Window chrome: real Tauri calls when packaged, a clear no-op message in the browser preview.
  if (d.win) { windowAction(d.win); return; }
  if (d.devst) { state.devStatus = d.devst; render(); return; }
  if (d.sndTest) { playSound(d.sndTest, true); return; }
  if (d.nf) { state.noteFilter = d.nf; render(); return; }
  if (d.range) { state.range = +d.range; render(); return; }
  if (d.group !== undefined) { state.group = !state.group; render(); return; }
  if (d.sort) { state.sort = d.sort; render(); return; }
  if (d.follow !== undefined) { state.logFollow = !state.logFollow; toast(state.logFollow ? 'Following new output' : 'Follow paused', 'arrow-down'); render(); return; }
  if (d.toggle !== undefined) {
    const on = t.classList.toggle('on');
    t.setAttribute('aria-checked', String(on));
    if (d.pref) { prefs[d.pref] = on; savePrefs(); applyPrefs(); }
    if (t.id === 'ns-fan') nsFan();
    if (t.id === 'ns-pipe') nsPipe();
    if (t.id === 'ns-team') nsTeam();
    return;
  }
  if (d.themeMode) { state.themeMode = prefs.mode = d.themeMode; savePrefs(); withTransition(() => { applyPrefs(); render(); openSettings('appearance'); }); return; }
  if (d.runTerminal) { e.stopPropagation(); modalRun(d.runTerminal); return; }
  if (d.devmenu !== undefined) { e.stopPropagation(); popDeviceMenu(t, DB.devices.find((x) => x.name === d.devmenu)); return; }
  if (d.termtabClose) { e.stopPropagation(); termClose(d.termtabClose); return; }
  if (d.termtab) { e.stopPropagation(); termSelect(d.termtab); return; }
  if (d.tab) { state.activeTab = d.tab; state.sessionTitle = (DB.sessions.find((s) => s.id === d.tab) || {}).title || state.sessionTitle; render(); return; }
  if (d.tabclose) {
    e.stopPropagation();
    const ws = (DB.sessions.find((s) => s.id === d.tabclose) || {}).ws;
    const bucket = tabsOf(ws);
    const i = bucket.indexOf(d.tabclose);
    const rest = bucket.filter((id) => id !== d.tabclose);
    state.openTabs = { ...state.openTabs, [ws]: rest };
    // Closing the active tab hands focus to the neighbour on its left; emptying the bucket
    // leaves the session view instead of showing a shell with no tabs.
    if (state.activeTab === d.tabclose) state.activeTab = rest[Math.max(0, i - 1)] || null;
    if (!rest.length) { state.page = 'sessions'; state.activeTab = null; }
    render(); return;
  }
  if (d.session) {
    state.selectedSession = d.session;
    state.activeTab = d.session;
    state.sessionTitle = (DB.sessions.find((s) => s.id === d.session) || {}).title || SESSION.title;
    const ws = (DB.sessions.find((s) => s.id === d.session) || {}).ws;
    const bucket = tabsOf(ws);
    if (!bucket.includes(d.session)) state.openTabs = { ...state.openTabs, [ws]: [...bucket, d.session] };
    state.page = 'session'; closeAll();
    if (d.jump) { state.jumpEv = +d.jump; if (bubbleChat(d.session)) state.chatView = 'chat'; }
    render(); chatJump(); if (state.chatFindOpen) chatFind();
  }
  if (d.note) { state.selectedNote = d.note; render(); }
  if (d.stab) { window.__hubErr = null; if (d.stab === 'storage') window.__worktrees = null; if (d.stab === 'diagnostics') window.__diag = null; state.settingsTab = d.stab; openSettings(d.stab); }
  if (d.palette) {
    /* A light tile sets the light theme and switches to light mode; a dark tile does the reverse. */
    if (DB.palette.find((p) => p.key === d.palette)?.light) { state.lightPalette = prefs.lightPalette = d.palette; if (!isLight()) state.themeMode = prefs.mode = 'light'; }
    else { state.palette = prefs.palette = d.palette; if (isLight()) state.themeMode = prefs.mode = 'dark'; }
    if (prefs.glass) prefs.glass.on = false;
    savePrefs();
    withTransition(() => { applyPrefs(); render(); openSettings('appearance'); });
    return;
  }
  if (d.logfilter) { state.logFilter = d.logfilter; render(); return; }
  if (d.opts) {
    /* Option buttons open a glide select instead of cycling blindly through values. */
    glideSelect(t, {
      options: d.opts.split('|'), value: t.textContent.trim(), label: d.pref || 'Select', width: Math.max(176, t.offsetWidth),
      onPick: (next) => {
        t.innerHTML = `${esc(next)}${ic('caret-down')}`;
        if (d.pref) {
          prefs[d.pref] = next; savePrefs(); applyPrefs();
        }
      },
    });
    return;
  }
  if (d.choiceBtn) {
    const [key, field] = d.choiceBtn.split(':');
    glideSelect(t, {
      options: CHOICES[key], value: state[field], width: 200,
      label: key === 'model' ? 'Model' : key === 'reasoning' ? 'Reasoning effort' : 'Approval mode',
      onPick: (v) => { state[field] = v; render(); },
    });
    return;
  }
  if (d.choice === 'approval' && state.page === 'session' && window.__liveRuns?.has(state.activeTab)) {
    const id = state.activeTab, mode = APPR[d.val] || 'ask';
    state.approval = d.val; closeAll();
    fetch(`/api/sessions/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ approval: mode }) })
      .then((x) => x.json()).then((r) => { if (r && r.id) window.__liveRuns.set(id, { ...window.__liveRuns.get(id), approval: r.approval }); render(); toast(`${d.val} for this session`, 'shield-check'); })
      .catch((err) => toast(`Not saved · ${err.message}`, 'warning'));
    return;
  }
  if (d.choice) { state[d.choice] = d.val; closeAll(); render(); return; }
  if (d.attach) { pickFiles(d.attach); return; }
  if (d.nscfg) { $('#ns-config').value = d.nscfg; nsConfigs(); return; }
  if (d.unattach !== undefined) { const [x] = state.attached.splice(+d.unattach, 1); if (x && x.img) URL.revokeObjectURL(x.img); render(); return; }
  if (d.fold) {
    // Fold in place: a re-render here would lose the scroll position inside a long transcript.
    t.classList.toggle('open');
    return;
  }
  if (d.file) { state.selFile = d.file; state.viewFile = d.file; render(); return; }
  if (d.folder) {
    state.folders = { ...(state.folders || {}) };
    const cur = state.folders[d.folder] ?? (SESSION.tree.find((f) => f.n === d.folder)?.open ?? false);
    state.folders[d.folder] = !cur;
    render(); return;
  }
  if (d.stageDel !== undefined || d.stageAdd !== undefined) {
    const cur = nsStagesRead();
    NS_STAGES.splice(0, NS_STAGES.length, ...cur);
    if (d.stageAdd !== undefined && NS_STAGES.length < 6) NS_STAGES.push({ name: `Stage ${NS_STAGES.length + 1}`, agent: (cur[cur.length - 1] || {}).agent || 'omp', prompt: '' });
    else if (d.stageDel !== undefined && NS_STAGES.length > 2) NS_STAGES.splice(+d.stageDel, 1);
    nsPipe(); return;
  }
  if (d.nsmodelDel !== undefined) { NS_MODELS.splice(NS_MODELS.indexOf(d.nsmodelDel), 1); nsFan(); return; }
  if (d.agentpick !== undefined) {
    if (t.disabled) return;
    if ($('#ns-fan.on')) { t.classList.toggle('on'); t.setAttribute('aria-pressed', String(t.classList.contains('on'))); nsFan(); return; }
    t.parentElement.querySelectorAll('[data-agentpick]').forEach((x) => { x.classList.toggle('on', x === t); x.setAttribute('aria-pressed', String(x === t)); });
    nsConfigs(); nsModels();
    return;
  }
  if (d.glassFit) {
    t.parentElement.querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === t));
    if (glassDraft) { glassDraft.fit = d.glassFit; glassPreview(); }
    return;
  }
  if (d.logtab) { state.logTab = d.logtab; render(); }
  if (d.level) { state.logLevel = d.level; render(); }
  if (d.cmd) {
    const m = { 'Go to Overview': 'overview', 'Go to Sessions': 'sessions', 'Go to Jobs': 'jobs', 'Go to Devices': 'devices', 'Go to Usage': 'usage', 'Go to Terminal': 'logs', 'Go to Notes': 'notes' }[d.cmd];
    closeAll();
    if (m) { state.page = m; render(); return; }
    if (d.cmd === 'Dispatch job') { modalDispatch(); return; }
    if (d.cmd === 'New session') { popNewSession(); return; }
    if (d.cmd === 'Resume last session') {
      const last = [...DB.sessions].filter((s) => s.live).sort((a, b) => b.live.created_at - a.live.created_at)[0];
      if (!last) { toast('No sessions yet', 'info'); return; }
      state.activeTab = state.selectedSession = last.id; state.sessionTitle = last.title; state.page = 'session'; render(); return;
    }
    if (d.cmd === 'Enter focus mode') { state.page = 'focus'; render(); return; }
    if (d.cmd === 'New shell') { state.page = 'logs'; termOpen('local'); return; }
    if (d.cmd === 'Open settings') { openSettings(); return; }
    if (d.cmd === 'Pair a device') { openSettings('devices'); return; }
    if (d.cmd === 'Toggle theme') {
      const dark = document.documentElement.dataset.mode !== 'light';
      state.themeMode = prefs.mode = dark ? 'light' : 'dark'; savePrefs(); applyPrefs(); render();
      toast(dark ? 'Light mode' : 'Dark mode', dark ? 'sun' : 'moon'); return;
    }
    return;
  }

  switch (d.act) {
    case 'toggle-ws-list':
      state.wsCollapsed = !state.wsCollapsed; renderSidebar(); break;
    case 'toggle-sidebar': state.sidebar = !state.sidebar; render(); break;
    case 'dev-sort':
      glideSelect(t, { options: DEV_SORTS, value: state.devSort, label: 'Sort devices', width: 150,
        onPick: (v) => { state.devSort = v; render(); } });
      break;
    case 'focus': state.page = 'focus'; closeAll(); render(); break;
    case 'exit-focus': state.page = 'overview'; closeAll(); render(); break;
    case 'search': popSearch(); break;
    case 'commands': popCommands(); break;
    case 'new-session': closeAll(); popNewSession(); break;
    case 'compare': modalCompareList(); break;
    case 'compare-open': modalCompare(d.ids.split(',').filter(Boolean)); break;
    case 'compare-review': modalDiff(d.id); break;
    case 'started': {
      /* A chat session. Nothing is typed into its terminal: the side shell opens on its own when the
         session page mounts and is only for what the user runs there. */
      const prompt = ($('#ns-prompt') || {}).value || '';
      const ws = prefs.goaMode ? 'GOA' : ($('#ns-ws') || {}).dataset?.value || 'xblabs-web';   // in GOA mode every session is GOA's
      const cwd = ($('#ns-ws') || {}).dataset?.cwd || undefined;
      const device = state.nsDevice || 'local';
      /* No folder picked: nothing is created. A session in a guessed folder is worse than none. */
      if (!cwd) { toast(`Pick a folder on ${device === 'local' ? 'this hub' : device} first`, 'warning'); break; }
      const agent = ($('#popover [data-agentpick].on') || {}).dataset?.agentpick || 'shell';
      const isolate = !!$('#ns-wt.on');
      const title = chatTitle(prompt) || 'New session';
      const btn = t;
      if ($('#ns-team.on')) {
        if (device !== 'local') { toast('Teams run on this hub only for now', 'warning'); break; }
        const gitState = $('#ns-ws')?.dataset.git;
        if (gitState === '0' || gitState === 'empty') { toast('A team works on its own branch: this folder needs Git with a first commit (git init, commit, then try again).', 'warning', { ms: 9000 }); break; }
        if (!prompt.trim()) { toast('A team needs a goal', 'warning'); $('#ns-prompt')?.focus(); break; }
        if (!TUI_AGENTS.has(agent)) { toast('The lead needs an agent with a chat mode (Hermes, OMP, Claude)', 'warning'); break; }
        const mate = ($('#ns-mate') || {}).value;
        btn.disabled = true; btn.textContent = 'Starting…';
        (async () => {
          const s = await fetch('/api/sessions', { method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ title: `${title} · lead`, prompt, ws, cwd, device, agent, team: { agent: mate }, approval: APPR[state.approval] }) }).then((r) => r.json());
          if (s.error) throw new Error(s.error);
          await liveLoad();
          closeAll();
          state.openTabs = { ...state.openTabs, [ws]: [...tabsOf(ws).filter((x) => x !== s.id), s.id] };
          state.activeTab = state.selectedSession = s.id; state.sessionTitle = s.title; state.sideTab = 'graph';
          state.filesOpen = true; state.openWs = ws; state.page = 'session'; render();
          toast('Team started · the lead plans the tasks, then the teammates start', 'check');
        })().catch((err) => { btn.disabled = false; nsTeam(); toast(`Start failed: ${err.message}`, 'warning'); });
        break;
      }
      if ($('#ns-pipe.on')) {
        const stages = nsStagesRead();
        if (device !== 'local') { toast('Pipelines run on this hub only for now', 'warning'); break; }
        const gitState = $('#ns-ws')?.dataset.git;
        if (gitState === '0' || gitState === 'empty') { toast('A pipeline works on its own branch: this folder needs Git with a first commit (git init, commit, then try again).', 'warning', { ms: 9000 }); break; }
        if (!prompt.trim()) { toast('A pipeline needs a task', 'warning'); $('#ns-prompt')?.focus(); break; }
        if (stages.some((s) => !s.agent)) { toast('Every stage needs an agent with a chat mode (Hermes, OMP, Claude)', 'warning'); break; }
        btn.disabled = true; btn.textContent = 'Starting…';
        (async () => {
          const s = await fetch('/api/sessions', { method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ title: `${title} · 1/${stages.length} ${stages[0].name || 'Stage 1'}`, prompt, ws, cwd, device, pipeline: stages, approval: APPR[state.approval] }) }).then((r) => r.json());
          if (s.error) throw new Error(s.error);
          await liveLoad();
          closeAll();
          state.openTabs = { ...state.openTabs, [ws]: [...tabsOf(ws).filter((x) => x !== s.id), s.id] };
          state.activeTab = state.selectedSession = s.id; state.sessionTitle = s.title; state.sideTab = 'model';
          state.filesOpen = true; state.openWs = ws; state.page = 'session'; render();
          toast(`Pipeline started · the next stage opens in the sidebar when ${stages[0].name || 'stage 1'} answers`, 'check');
        })().catch((err) => { btn.disabled = false; nsPipe(); toast(`Start failed: ${err.message}`, 'warning'); });
        break;
      }
      if ($('#ns-fan.on')) {
        /* One session per agent, same prompt, each on its own branch; a failed one is reported, the rest go on. */
        const targets = nsTargets();
        if (targets.length < 2) { toast('Pick two or more agents or models to compare', 'warning'); break; }
        const gitState = $('#ns-ws')?.dataset.git;
        if (gitState === '0') { toast('This folder is not a Git repository. Compare agents gives each agent its own branch, so run git init and make a first commit.', 'warning', { ms: 9000 }); break; }
        if (gitState === 'empty') { toast('This Git repository has no commit yet. Add a file and commit once so each agent has something to branch from.', 'warning', { ms: 9000 }); break; }
        if (targets.length > 8) { toast(`${targets.length} sessions at once is too many · 8 at most`, 'warning'); break; }
        if (!prompt.trim()) { toast('Compare needs a prompt', 'warning'); $('#ns-prompt')?.focus(); break; }
        btn.disabled = true; btn.textContent = 'Starting…';
        (async () => {
          const ids = [], failed = [];
          for (const { agent: a, model: m } of targets) {
            const who = `${AGENT_NAMES[a] || a}${m ? ` · ${m.split('/').pop()}` : ''}`;
            const s = await fetch('/api/sessions', { method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ title: `${title} · ${who}`, prompt, ws, agent: a, kind: 'chat', isolate: true, requireIsolation: true, cwd, device, approval: APPR[state.approval], ...(m ? { llm_model: m } : {}) }) })
              .then((r) => r.json()).catch((err) => ({ error: err.message }));
            if (s.error) failed.push([who, s.error]); else ids.push(s.id);
            if (s.error && /not a Git repository/.test(s.error)) break;   // same folder: the rest would fail the same way
          }
          /* One reason is said once (no repo is the usual one); different reasons are listed per target. */
          const why = [...new Set(failed.map(([, e]) => e))];
          if (failed.length) toast(why.length === 1 ? `Not started · ${why[0]}` : `Not started · ${failed.map(([w, e]) => `${w}: ${e}`).join(' · ')}`, 'warning', { ms: 12000 });
          if (!ids.length) { btn.disabled = false; nsFan(); return; }
          fanSave(title, ids);
          await liveLoad();
          closeAll(); render();
          if (ids.length > 1) modalCompare(ids);
        })().catch((err) => { btn.disabled = false; nsFan(); toast(`Start failed: ${err.message}`, 'warning'); });
        break;
      }
      btn.disabled = true; btn.textContent = 'Starting…';
      (async () => {
        const s = await fetch('/api/sessions', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          /* The agent starts in the folder this workspace's earlier runs used; the hub's own otherwise. */
          body: JSON.stringify({ title, prompt, ws, agent, kind: 'chat', isolate, cwd, device, approval: APPR[state.approval], config: ($('#ns-config') || {}).value || undefined,
            ...(usesEndpoint(agent) && MODEL_ID.test((($('#ns-model') || {}).value || '').trim()) ? { llm_model: $('#ns-model').value.trim() } : {}) }),
        }).then((r) => r.json());
        if (s.error) throw new Error(s.error);
        await liveLoad();
        closeAll();
        const bucket = tabsOf(ws);
        state.openTabs = { ...state.openTabs, [ws]: [...bucket.filter((x) => x !== s.id), s.id] };
        state.activeTab = state.selectedSession = s.id; state.sessionTitle = title; state.sideTab = 'model';
        state.filesOpen = true; state.openWs = ws; state.page = 'session'; render();
      })().catch((err) => { btn.disabled = false; btn.textContent = 'Start session'; toast(`Start failed: ${err.message}`, 'warning'); });
      break;
    }
    case 'privacy': prefs.privacy = !prefs.privacy; savePrefs(); applyPrefs(); render(); toast(prefs.privacy ? 'Privacy mode on: sensitive data blurred' : 'Privacy mode off'); break;
    case 'notifs': if (!popover.hidden && popover.classList.contains('pop-notif')) popover.hidden = true; else popNotifs(t); break;
    case 'town-open': TOWN.focus = t.dataset.id; state.page = 'town'; render(); break;
    case 'town-close': TOWN.focus = null; render(); break;
    case 'profile': popProfile(); break;
    case 'edit-profile': closeAll(); modalEditProfile(); break;
    case 'pf-save': {
      const name = $('#pf-name').value.trim() || DB.user.name;
      DB.user.name = name;
      DB.user.initials = initialsOf(name);
      DB.user.username = ($('#pf-user').value || '').trim().replace(/^@/, '');
      DB.user.email = $('#pf-email').value.trim() || DB.user.email;
      DB.user.bio = $('#pf-bio').value.trim();
      DB.user.pfp = modalPfp;
      saveProfile(); closeAll(); render(); toast('Profile updated', 'check');
      break;
    }
    case 'pf-clear':
      modalPfp = null;
      $('#pf-av').innerHTML = initialsOf($('#pf-name').value || DB.user.name);
      break;
    case 'settings': closeAll(); openSettings(); break;
    case 'open-agents': closeAll(); state.settingsTab = 'agents'; openSettings('agents'); setTimeout(() => { const r = overlay.querySelector('details.reg'); if (r) { r.open = true; r.scrollIntoView({ block: 'start' }); } }, 60); break;
    case 'pair': closeAll(); openSettings('devices'); break;
    case 'settings-devices': openSettings('devices'); break;
    case 'dev-guide': modalDevGuide(); break;
    case 'con-open': modalConnect({ name: d.name, host: d.host, port: +d.port || 22, user: d.user || '', key: d.key || '', auto: d.auto === '1' }); break;
    case 'con-go': {
      const c = window.__con;
      if (!c) break;
      t.disabled = true;
      const log = $('#con-log'); if (log) { log.hidden = false; log.textContent = 'Starting…'; }
      const u = $('#con-url'); if (u) u.innerHTML = '';
      fetch('/api/devices/connect', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: c.name, host: `${c.host}:${c.port || 22}`, user: ($('#con-user') || {}).value || '', key: ($('#con-key') || {}).value || '' }) })
        .then(async (r) => { const j = await r.json(); if (!r.ok) throw new Error(j.error || r.status); return j; })
        .then((j) => { c.id = j.id; conPoll(); })
        .catch((err) => { t.disabled = false; if (log) log.textContent = err.message; toast(`Connect: ${err.message}`, 'warning'); });
      break;
    }
    case 'host-add': modalAddHost(); break;
    case 'host-pick': {
      const a = $('#host-addr'), n = $('#host-name');
      if (a) a.value = d.host; if (n && !n.value) n.value = d.name;
      $('#host-user')?.focus();
      break;
    }
    case 'host-save': {
      const body = { host: ($('#host-addr') || {}).value || '', user: ($('#host-user') || {}).value || '', name: ($('#host-name') || {}).value || '' };
      t.disabled = true;
      fetch('/api/hosts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
        .then(async (r) => { const j = await r.json(); if (!r.ok) throw new Error(j.error || r.status); return j; })
        .then(async (j) => { toast(`${j.name} added · ${j.reachable ? 'ssh port answers' : 'ssh port not reachable yet'}`, j.reachable ? 'check-circle' : 'warning'); await liveLoad(); openSettings('devices'); })
        .catch((err) => { t.disabled = false; toast(`Add host: ${err.message}`, 'warning'); });
      break;
    }
    case 'host-del':
      fetch(`/api/hosts/${encodeURIComponent(d.host)}`, { method: 'DELETE' })
        .then(() => liveLoad()).then(() => { toast(`${d.host} removed`); openSettings('devices'); });
      break;
    case 'ts-login':
      t.disabled = true;
      fetch('/api/tailscale/login', { method: 'POST' }).then(async (r) => { const j = await r.json(); if (!r.ok) throw new Error(j.error || r.status); return j; })
        .then((j) => {
          t.disabled = false;
          if (!j.url) { toast('Tailscale is signed in'); return liveLoad().then(() => openSettings('devices')); }
          window.open(j.url, '_blank', 'noopener');
          toast('Finish signing in in the browser, then press Test', 'sign-in');
        })
        .catch((err) => { t.disabled = false; toast(`Tailscale: ${err.message}`, 'warning'); });
      break;
    case 'copy-text':
      copyText(d.text || '').then(() => toast('Copied', 'copy'), () => toast('Clipboard is blocked here', 'warning'));
      break;
    case 'glass': closeAll(); modalGlass(); break;
    case 'close': closeAll(); break;
    case 'filter': popFilter(t); break;
    case 'filter-close': closeAll(); break;
    case 'filter-reset': state.devStatus = 'all'; state.noteFilter = 'all'; state.ws = 'all'; closeAll(); render(); break;
    case 'log-filter': popLogFilter(t); break;
    case 'log-filter-reset': state.logFilter = 'all'; state.logLevel = 'all'; closeAll(); render(); break;

    case 'kill-all': {
      closeAll();
      modalConfirm('Kill all running agents?', 'Every live shell and run on this hub stops now. Work that was not saved inside those processes is lost.', 'Kill all', 'kill-confirm');
      break;
    }
    case 'goa-mode': {
      closeAll();
      const on = !!prefs.goaMode;
      showModal(`
        <div class="modal-head"><div class="tb"><h2>${on ? 'Leave GOA mode?' : 'Enter GOA mode?'}</h2></div>
          <button class="close-x" data-act="close">${ic('x')}</button></div>
        <div class="modal-body"><p style="margin:0;font-size:12.5px;line-height:1.55;color:var(--text-secondary)">${on
          ? 'You go back to your own sessions, workspaces and jobs. GOA and its workers keep running; enter GOA mode again to see them.'
          : 'GOA mode is its own space: only GOA, the workers it spawns and their tasks show. Your own sessions, workspaces and jobs are hidden until you leave.'}</p></div>
        <div class="modal-foot"><span class="sp"></span>
          <button class="btn secondary sm" data-act="close">Cancel</button>
          <button class="btn primary sm" data-act="goa-mode-go">${ic(on ? 'sign-out' : 'crown-simple', 'bold')}${on ? 'Leave GOA' : 'Enter GOA'}</button></div>`, 440);
      break;
    }
    case 'goa-mode-go': {
      closeAll();
      prefs.goaMode = !prefs.goaMode; savePrefs();
      state.ws = 'all'; state.openWs = prefs.goaMode ? 'GOA' : null; state.activeTab = null;
      state.page = prefs.goaMode ? 'goa' : 'overview';
      (async () => { await liveLoad(); if (typeof loadJobs === 'function') await loadJobs({ quiet: true }); render(); })();
      toast(prefs.goaMode ? 'GOA mode' : 'Back to your sessions');
      break;
    }
    case 'kill-confirm':
      closeAll();
      fetch('/api/sessions/kill-all', { method: 'POST' }).then((r) => r.json())
        .then((r) => { toast(`${r.killed} session${r.killed === 1 ? '' : 's'} stopped`, 'stop-circle'); return liveLoad(); })
        .then(() => render()).catch((err) => toast(`Kill failed: ${err.message}`, 'warning'));
      break;
    case 'clear-data': {
      closeAll();
      modalConfirm('Clear all local data?', 'Every session, terminal log, note and log event on this hub is deleted and cannot be restored. Project folders on disk and the Tailscale and LLM settings are kept.', 'Clear data', 'clear-confirm');
      break;
    }
    case 'clear-confirm': {
      closeAll();
      (async () => {
        const del = (u) => fetch(u, { method: 'DELETE' });
        const wss = [...new Set(DB.sessions.map((s) => s.ws).concat(((window.LIVE && LIVE.shells) || []).map((s) => s.ws)).filter(Boolean))];
        for (const w of wss) await del(`/api/sessions?ws=${encodeURIComponent(w)}`);
        for (const n of DB.notes) if (n.id) await del(`/api/notes/${n.id}`);
        await del('/api/logs');
        await liveLoad(); render();
        toast('Local data cleared', 'trash');
      })().catch((err) => toast(`Clear failed: ${err.message}`, 'warning'));
      break;
    }
    case 'reset-tab': {
      const keys = {
        general: ['Workspace name', 'Start page'], agents: [],
        appearance: ['palette', 'lightPalette', 'mode', 'Monospace font', 'UI scale', 'Chat font size', 'Reduce motion', 'Sound effects', 'Sound volume', 'glass'],
      }[d.reset] || [];
      keys.forEach((k) => delete prefs[k]);
      savePrefs();
      if (d.reset === 'appearance') { state.palette = 'midnight'; state.lightPalette = 'paper'; state.themeMode = 'dark'; }
      if (d.reset === 'agents') state.model = 'Sonnet 4.5';
      applyPrefs(); render(); openSettings(d.reset);
      toast('Tab reset to defaults', 'arrow-counter-clockwise');
      break;
    }
    case 'view-diff': modalDiff(state.activeTab); break;
    case 'git-review': modalDiff(d.id); break;
    case 'git-act': gitAct(t); break;
    case 'git-note': gitNote(d.id); break;
    case 'recall': state.jumpEv = +d.ev; chatJump(); break;
    case 'tui-pick': $$('[data-act="tui-pick"]').forEach((b) => { b.disabled = true; }); fetch(`/api/sessions/${d.id}/chat/pick`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ n: +d.n }) }).then((x) => x.json()).then((j) => { if (j.error) toast(j.error, 'warning'); return chatPull(d.id); }).then(() => chatPaint(d.id)); break;
    case 'graph-zoom': { const cv = document.querySelector('#graph-tab .gr-canvas'); if (cv) gZoomAt(state.activeTab, +d.z > 0 ? 1.2 : 1 / 1.2, cv.clientWidth / 2, cv.clientHeight / 2); break; }
    case 'graph-fit': gFit(state.activeTab); break;
    case 'graph-card': popGraphCard(t, d.key); break;
    case 'graph-job': { const o = state.gJobs || (state.gJobs = new Set()), n = +d.pid; o.has(n) ? o.delete(n) : o.add(n); graphPaint.last = ''; graphPaint(state.activeTab); break; }
    case 'graph-wide': state.gWide = !state.gWide; if (state.gWide) { state.gNarrow = state.sideW; state.sideW = Math.max(state.sideW, Math.round(VW() * 0.55)); } else state.sideW = state.gNarrow || 420; gView(state.activeTab).fit = true; render(); break;
    case 'graph-board': state.gBoard = state.gBoard === false; graphPaint.last = ''; graphPaint(state.activeTab); break;
    case 'graph-bg': state.gBg = state.gBg === false; graphPaint.last = ''; graphPaint(state.activeTab); break;
    case 'graph-owner': state.gOwner = d.v; graphPaint.last = ''; graphPaint(state.activeTab); break;
    case 'graph-group': { const o = state.graphOpen || (state.graphOpen = new Set()); o.has(d.key) ? o.delete(d.key) : o.add(d.key); graphPaint.last = ''; graphPaint(state.activeTab); break; }
    case 'bg-procs': popBg(t, d.id); break;
    case 'bg-more': { const o = popBg.open || (popBg.open = new Set()), n = +d.pid; o.has(n) ? o.delete(n) : o.add(n); popBg(null, d.id); break; }
    case 'bg-stop': {
      t.disabled = true;
      fetch(`/api/sessions/${d.id}/procs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pid: +d.pid }) }).then((x) => x.json())
        .then((j) => { toast(j.error || `Stopped process ${d.pid}`, j.error ? 'warning' : 'stop'); return sessPoll(d.id); })
        .catch((err) => toast(`Stop failed · ${err.message}`, 'warning'));
      break;
    }
    case 'msg-copy': copyText(turnText(d.id, +d.turn)).then(() => toast('Copied', 'copy'), () => toast('Clipboard is blocked here', 'warning')); break;
    case 'msg-pin': pinToggle(d.id, +d.ev); chatPaint(d.id); break;
    case 'msg-branch': branchFrom(d.id, +d.turn); break;
    case 'notif-pick': $$('[data-act="notif-pick"]').forEach((x) => { if (x.dataset.id === d.id) x.disabled = true; }); bubbleSend(d.id, d.v).then(() => afterDecision(d.id)); break;
    case 'chat-pick': $$('[data-act="chat-pick"]').forEach((b) => { b.disabled = true; }); bubbleSend(d.id, d.v); break;
    case 'chat-approve': t.disabled = true; fetch(`/api/sessions/${d.id}/chat/approve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision: d.dec }) }).then((x) => x.json()).then((j) => { if (j.error) toast(j.error, 'warning'); return afterDecision(d.id); }); break;
    case 'chat-stop': fetch(`/api/sessions/${d.id}/chat/stop`, { method: 'POST' }).then(() => chatPull(d.id)).then(() => chatPaint(d.id)); break;
    case 'wt-remove': wtRemove(t); break;
    case 'wt-orphans': wtOrphans(t); break;
    case 'aut-new': {
      const ok = [...TUI_AGENTS].filter((a) => agentState('local', a) !== 'missing');
      window.__autEdit = { name: '', prompt: '', cwd: '', agent: ok[0] || 'omp', days: [1, 2, 3, 4, 5], time: '09:00', enabled: true };
      openSettings('automations'); setTimeout(() => $('#aut-name')?.focus(), 30); break;
    }
    case 'aut-edit': window.__autEdit = { ...((window.__aut || {}).list || []).find((a) => a.id === d.id) }; openSettings('automations'); break;
    case 'aut-cancel': window.__autEdit = null; openSettings('automations'); break;
    case 'aut-day': { autRead(); const E = window.__autEdit, n = +d.day; E.days = E.days.includes(n) ? E.days.filter((x) => x !== n) : [...E.days, n].sort(); openSettings('automations'); break; }
    case 'aut-folder': autRead(); FB.data = null; FB.err = null; FB.device = 'local'; FB.title = 'Project for this automation';
      FB.onPick = (path) => { window.__autEdit.cwd = path; window.__autEdit.ws = ''; openSettings('automations'); }; fbPaint(); fbGo(window.__autEdit.cwd || '~'); break;
    case 'aut-save': {
      autRead();
      const E = window.__autEdit, list = [...(window.__aut.list || [])];
      const i = list.findIndex((a) => a.id === E.id);
      if (i >= 0) list[i] = E; else list.push(E);
      autPut(list, `${E.name || 'Automation'} saved · ${autWhen({ ...E, days: [...E.days].sort() })}`);
      break;
    }
    case 'aut-on': autPut(window.__aut.list.map((a) => a.id === d.id ? { ...a, enabled: !a.enabled } : a)); break;
    case 'aut-del':
      if (!t.dataset.armed) { t.dataset.armed = '1'; t.classList.add('danger'); t.title = 'Click again to delete'; toast('Click delete again to remove this automation (its past sessions stay)', 'info'); break; }
      autPut(window.__aut.list.filter((a) => a.id !== d.id), 'Automation deleted'); break;
    case 'aut-run': {
      t.disabled = true;
      fetch(`/api/automations/${d.id}/run`, { method: 'POST' }).then((r) => r.json()).then(async (r) => {
        toast(r.error ? `Not started · ${r.error}` : 'Run started · it is in the sidebar as a new session', r.error ? 'warning' : 'check', r.error ? { ms: 9000 } : undefined);
        await liveLoad(); window.__aut = null; autLoad();
      }).catch((err) => { t.disabled = false; toast(`Not started · ${err.message}`, 'warning'); });
      break;
    }
    case 'wt-root': FB.data = null; FB.err = null; FB.device = 'local'; FB.onPick = wtRoot; FB.title = 'Folder for session worktrees'; fbPaint(); fbGo(((window.__worktrees || {}).home || '~').replace(/[\\/]worktrees$/, '') || '~'); break;
    case 'wt-root-default': wtRoot(''); break;
    case 'hub-save': hubSave().then((ok) => { if (ok && t.closest('.settings-foot')) closeAll(); }); break;
    case 'custom-save': {
      const custom = {};
      for (const line of (($('#custom-agents') || {}).value || '').split('\n')) {
        if (!line.trim()) continue;
        const [id, name, ...cmd] = line.split('|').map((x) => x.trim());
        custom[(id || '').toLowerCase()] = { name: name || id, command: cmd.join('|') };
      }
      fetch('/api/hub-settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ custom }) })
        .then((r) => r.json()).then(async (s) => {
          if (s.error) return toast(s.error, 'warning');
          window.__hub = s; if (typeof liveLoad === 'function') await liveLoad();
          toast(`${Object.keys(custom).length} custom agent${Object.keys(custom).length === 1 ? '' : 's'} saved`); openSettings('agents');
        });
      break;
    }
    case 'cfg-add': {
      const a = d.agent, v = (k) => (($('#cfg-' + a + '-' + k) || {}).value || '').trim();
      cfgCall('/api/agent-configs', 'POST', { agent: a, name: v('name'), kind: v('kind'), base_url: v('url'), model: v('model'), api_key: v('key'), config_dir: v('dir') })
        .then((r) => { if (r.error) toast(r.error, 'warning'); else cfgLoad(); });
      break;
    }
    case 'cfg-del': if (confirm('Delete this config? Sessions on it go back to the official account.')) cfgCall('/api/agent-configs/' + d.id, 'DELETE').then(cfgLoad); break;
    case 'cfg-toggle': cfgCall('/api/agent-configs/' + d.id, 'PATCH', { enabled: t.checked }).then((r) => { if (r.error) toast(r.error, 'warning'); cfgLoad(); }); break;
    case 'cfg-clear': cfgCall('/api/agent-configs/' + (d.id || 'official'), 'PATCH', { agent: d.agent, clear_limit: true }).then(cfgLoad); break;
    case 'cfg-up': case 'cfg-down': {
      const own = cfgsOf(d.agent).filter((c) => c.id), i = own.findIndex((c) => c.id === d.id), j = i + (d.act === 'cfg-up' ? -1 : 1);
      if (i < 0 || !own[j]) break;
      [own[i], own[j]] = [own[j], own[i]];
      Promise.all(own.map((c, k) => cfgCall('/api/agent-configs/' + c.id, 'PATCH', { priority: k }))).then(cfgLoad);
      break;
    }
    case 'switch-config': closeAll(); (async () => {
      let r = await cfgCall(`/api/sessions/${d.id}/switch`, 'POST', { config: d.cfg });
      if (r.error && /newConversation/.test(r.error) && confirm(r.error.replace(/ Send newConversation:true.*/, '') + '\n\nStart a new conversation on it?'))
        r = await cfgCall(`/api/sessions/${d.id}/switch`, 'POST', { config: d.cfg, newConversation: true });
      if (r.error) toast(r.error, 'warning'); else toast('Switched config', 'check');
      await liveLoad();
    })(); break;
    case 'hub-test-push': fetch('/api/hub-settings/test-push', { method: 'POST' }).then((r) => r.json()).then((j) => toast(j.error ? `Push failed: ${j.error}` : 'Test sent', j.error ? 'warning' : 'check-circle')); break;
    case 'file-back': state.viewFile = null; render(); break;
    case 'git-refresh': gitLoad(d.id).then(() => render()); break;
    case 'glass-replace': glassPick(); break;
    case 'glass-remove': modalGlass({ ...glassDraft, img: null, name: null }); break;
    case 'glass-save':
      if (!glassDraft || !glassDraft.img) break;
      prefs.glass = { ...glassDraft, on: true };
      try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); }
      catch { prefs.glass.on = false; toast('Photo is too large to keep · try a smaller one', 'warning'); break; }
      uiPush('prefs', prefs);
      applyPrefs(); closeAll(); render(); toast('Liquid Glass on', 'image');
      break;
    case 'glass-off':
      if (prefs.glass) prefs.glass.on = false;
      savePrefs(); applyPrefs(); closeAll(); render(); toast('Liquid Glass off', 'image');
      break;
    case 'reveal': {
      const path = window.__dbPath || 'data/xblabs.db';
      copyText(path).then(() => toast('Data file path copied', 'copy'), () => toast(path, 'folder-open'));
      break;
    }
    case 'new-command': {
      const name = ($('#cmd-name') || {}).value?.trim();
      const cmd = ($('#cmd-line') || {}).value?.trim();
      if (!name || !cmd) { toast('Give the command a name and a command line', 'info'); break; }
      prefs.commands = [...savedCommands(), { name, cmd }]; savePrefs();
      openSettings('commands');
      break;
    }
    case 'del-command':
      prefs.commands = savedCommands().filter((_, i) => i !== +d.i); savePrefs();
      openSettings('commands');
      break;
    case 'run-command': {
      const c = savedCommands()[+d.i];
      if (!c) break;
      closeAll();
      (async () => {
        const id = await termEnsure('local');
        if (!id) return;
        await fetch(`/api/sessions/${id}/input`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data: c.cmd + '\r' }) });
        state.termTab = id; state.page = 'logs'; render();
      })().catch((err) => toast(`Run failed: ${err.message}`, 'warning'));
      break;
    }
    case 'cmd-settings': closeAll(); openSettings('commands'); break;
    case 'appearance': closeAll(); openSettings('appearance'); break;
    case 'shortcuts': closeAll(); modalShortcuts(); break;
    case 'pause': state.logsPaused = !state.logsPaused; render(); break;
    case 'copy': {
      const term = window.__term;
      if (!term) { toast('Open a shell first', 'info'); break; }
      term.selectAll();
      const text = term.getSelection();
      term.clearSelection();
      copyText(text).then(() => toast(`Copied ${text.split('\n').length} lines`, 'copy'), () => toast('Clipboard is blocked here', 'warning'));
      break;
    }
    case 'clear': {
      fetch('/api/logs', { method: 'DELETE' }).then(() => liveLoad()).then(() => {
        toast('Log ring cleared', 'trash'); render();
      });
      break;
    }
    case 'refresh':
      t.disabled = true;
      liveLoad().then(() => {
        window.__refreshedAt = new Date().toLocaleTimeString();
        render();
        toast(`Refreshed · ${DB.devices.filter((x) => x.status === 'online').length} online`, 'arrows-clockwise');
      }).catch((err) => { t.disabled = false; toast(`Refresh failed: ${err.message}`, 'warning'); });
      break;
    case 'term-open': state.page = 'logs'; termOpen(d.host); break;
    case 'export': {
      const u = (window.LIVE && LIVE.usage) || {};
      const rows = [['section', 'name', 'value']]
        .concat((u.perDay || []).map((x) => ['runs_per_day', x.d, x.n]))
        .concat((u.perDevice || []).map((x) => ['output_bytes_per_device', x.name, x.bytes]))
        .concat((u.perStatus || []).map((x) => ['runs_per_status', x.status, x.n]));
      const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\r\n');
      const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([csv], { type: 'text/csv' })), download: `xblabs-usage-${new Date().toISOString().slice(0, 10)}.csv` });
      a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      toast(`${a.download} saved`, 'download-simple');
      break;
    }
    case 'open-ws': state.page = 'sessions'; render(); break;
    case 'sess-term-new': {
      const old = shellMap[state.activeTab];
      if (old) fetch(`/api/sessions/${old}`, { method: 'DELETE' }).catch(() => {});
      if (window.__ptyCleanup) { window.__ptyCleanup(); window.__ptyCleanup = null; }
      const el = $('#sess-term'); if (el) el.innerHTML = '<div class="term-empty"><span>Starting a shell…</span></div>';
      mountSessionTerm(true).catch(() => {});
      break;
    }
    case 'new-note': liveNewNote(); break;
    case 'toggle-files': {
      /* The side panel slides: it shrinks away before the re-render, or grows in after it. */
      const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
      const shut = [{ width: '0px', opacity: 0, marginLeft: '0px' }];
      const anim = { duration: 260, easing: 'cubic-bezier(.2, 0, 0, 1)' };
      const p = $('.side-panel');
      if (p && p.dataset.sliding) break;
      if (state.filesOpen !== false && p && !still) {
        p.dataset.sliding = '1';
        p.animate([{ width: `${p.offsetWidth}px`, opacity: 1, marginLeft: '12px' }, ...shut], anim).finished.then(() => { state.filesOpen = false; render(); });
        break;
      }
      state.filesOpen = !state.filesOpen; render();
      const np = $('.side-panel');
      if (np && !still) np.animate([...shut, { width: `${np.offsetWidth}px`, opacity: 1, marginLeft: '12px' }], { ...anim, duration: 300 });
    } break;
    case 'ov-range': state.ovRange = d.v; liveLoad().then(render); break;
    case 'term-logs': state.termLogs = !state.termLogs; render(); break;
    case 'term-new': popDevices(t); break;
    case 'back-to-sessions': state.page = 'sessions'; render(); break;
    case 'attach': popAttach(t); break;
    case 'model-effort': popModelEffort(); break;
    case 'plan-toggle': state.planOpen = state.planOpen === false; { const pb = $('#plan-box'); if (pb) pb.outerHTML = planBox(state.activeTab); } break;
    case 'chat-halt': chatStop(state.activeTab); break;
    case 'unqueue': (QUEUE[state.activeTab] || []).splice(+d.i, 1); queuePaint(state.activeTab); break;
    case 'session-refresh': refreshSession(state.activeTab, t); break;
    case 'chat-view': if (bubbleChat(state.activeTab) && state.chatView !== d.v) {
      const id = state.activeTab;
      t.disabled = true;
      (async () => {
        /* The TUI keeps running behind Chat: chat messages go into it and its answers sync back. */
        if (d.v === 'term') TERM_SEEN.add(id);
        if (state.activeTab !== id) return;
        state.chatView = d.v; prefs.chatLayout = d.v; savePrefs(); render();
        const bx = $('#chat-bubbles'); if (bx) { await chatPull(id, true); chatPaint(id); bx.scrollTop = bx.scrollHeight; }
      })().catch(err => toast(err.message, 'warning')).finally(() => { t.disabled = false; });
    } break;
    case 'chat-search': state.chatFindOpen = !state.chatFindOpen; render(); if (state.chatFindOpen) { $('#chat-find-q')?.focus(); chatFind(); } break;
    case 'chat-find-who': state.chatFindWho = d.v; render(); $('#chat-find-q')?.focus(); chatFind(); break;
    case 'send': {
      const input = $('#composer');
      const text = (input?.value || '').trim();
      if (!text) { input?.focus(); toast('Type a message first', 'info'); break; }
      const firstMsg = state.sent.length === 0;
      const cur = DB.sessions.find((x) => x.id === state.activeTab);
      if (cur && bubbleChat(cur.id)) {
        /* A bubble chat: the hub runs the turn; the poll draws it. No full render, so the side
           terminal is not remounted. */
        const id = cur.id;
        if (chatBusy(id) && !d.queue) { toast('Still answering · Ctrl+Enter queues it', 'clock-countdown'); break; }
        if (chatBusy(id)) { (QUEUE[id] = QUEUE[id] || []).push(text); queuePaint(id); input.value = ''; input.style.height = ''; break; }
        withFiles(id, text).then((t) => bubbleSend(id, t));
        if (/^New session/.test(cur.title)) {
          const title = chatTitle(text);
          cur.title = state.sessionTitle = title;
          fetch(`/api/sessions/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title }) }).then(() => liveLoad()).then(() => renderTitlebar()).catch(() => {});
        }
        input.value = ''; input.style.height = '';
        break;
      }
      state.sent.push({ text, files: state.attached.map((f) => f.name) });
      if (firstMsg && cur && /^New session/.test(cur.title)) {
        const title = chatTitle(text);
        cur.title = title;
        state.sessionTitle = title;
        fetch(`/api/sessions/${cur.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title }) })
          .then(() => liveLoad()).then(() => render()).catch(() => {});
      }
      /* An agent session: the message is typed into the agent, Enter sent apart so a TUI does
         not take it as part of a paste. Other chats: the side shell is separate, nothing is sent. */
      if (cur && agentChat(cur.id)) {
        const put = (data) => fetch(`/api/sessions/${cur.id}/input`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data }) });
        withFiles(cur.id, text).then(put).then(() => new Promise((r) => setTimeout(r, 200))).then(() => put('\r'))
          .catch((err) => toast(`Not sent: ${err.message}`, 'warning'));
      }
      const n = agentChat(cur?.id) ? 0 : state.attached.splice(0).length;
      input.value = '';
      input.style.height = '';
      render();
      const box = $('.chat-msgs');
      if (box) box.scrollTop = box.scrollHeight;
      if (n) toast(`${n} file(s) sent`, 'paperclip');
      break;
    }

    case 'hibernate-session': case 'wake-session': closeAll(); (async () => {
      const wake = d.act === 'wake-session';
      let r = await fetch(`/api/sessions/${d.id}/${wake ? 'wake' : 'hibernate'}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then((x) => x.json()).catch((err) => ({ error: err.message }));
      if (r.error && !wake && /busy/.test(r.error) && confirm('The agent is busy. Hibernate anyway and stop it mid-turn?'))
        r = await fetch(`/api/sessions/${d.id}/hibernate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"force":true}' }).then((x) => x.json()).catch((err) => ({ error: err.message }));
      if (r.error) toast(r.error, 'warning'); else toast(wake ? 'Session woken' : 'Session hibernated', wake ? 'sun' : 'moon');
      await liveLoad();
    })(); break;
    case 'run-menu': popRunMenu(t, d.id); break;
    case 'run-cmd': closeAll(); runPost(d.id, { name: d.name }); break;
    case 'run-add': {
      closeAll();
      const command = (prompt('Command to run (saved to .xblabs.json):') || '').trim();
      const save = command && (prompt('Name for it (e.g. dev):') || '').trim();
      if (command && save) runPost(d.id, { command, save });
      break;
    }
    case 'open-port': if (+d.port > 0) window.open(`http://localhost:${+d.port}`, '_blank', 'noopener'); break;
    case 'rename-session': closeAll(); modalRenameSession(d.id); break;
    case 'delete-session': closeAll(); modalDeleteSession(d.id); break;
    case 'rename-save': {
      const s = DB.sessions.find((x) => x.id === d.id);
      const name = ($('#rename-input')?.value || '').trim();
      if (!s) break;
      if (!name) { toast('Name cannot be empty', 'warning'); break; }
      s.title = name;
      if (state.sessionTitle) state.sessionTitle = name;
      closeAll(); render(); toast('Session renamed', 'pencil-simple');
      break;
    }
    case 'delete-confirm': closeAll(); sessionDelete(d.id); break;
    case 'ws-new-session': {
      /* The project's own folder: where its sessions started (a worktree session's origin), the
         shortest one, on the device they ran on. */
      const runs = [...((window.LIVE && LIVE.runs) || new Map()).values()].filter((r) => r.ws === d.id && r.kind !== 'shell')
        .map((r) => ({ cwd: r.origin || r.cwd, device: r.device || 'local' })).filter((r) => /[\\/:]/.test(r.cwd || '') && !/[\\/]\.xblabs[\\/]/.test(r.cwd))
        .sort((a, b) => a.cwd.length - b.cwd.length);
      if (!runs.length) runs.push(...((window.LIVE && LIVE.projects) || []).filter((r) => r.ws === d.id));
      closeAll(); state.ws = d.id; state.nsDevice = (runs[0] && runs[0].device) || 'local'; state.nsPick = runs[0] || null;
      popNewSession(); break;
    }
    case 'ws-clear': closeAll(); modalWsClear(d.id); break;
    case 'ws-delete': closeAll(); modalWsDelete(d.id); break;
    case 'ws-delete-confirm': closeAll(); wsDelete(d.id); break;
    case 'ws-clear-confirm': closeAll(); wsClear(d.id); break;
  }
});

/* Backdrop clicks close popover-style overlays only. A dialog that owns an X button is modal:
   it must never vanish because the page behind it was clicked. */
overlay.addEventListener('click', (e) => {
  if (e.target !== overlay) return;
  if (overlay.querySelector('.modal')) return;            // dialogs close from their own X / Cancel / Esc
  if (popover.querySelector('textarea, input')) return;   // a typed prompt is not a stray click
  if (!popover.hidden) { popover.hidden = true; return; }
  closeAll();
});

/* Splitter between the chat and the side panel. The panel's width is derived from the pointer's
   distance to the right edge of the body, so the pane grows when dragged left. Chat never
   shrinks below 320 px; the panel is clamped to 240–720 px. */
function sideWFromPointer(clientX) {
  const body = document.querySelector('.session-body');
  if (!body) return state.sideW;
  const room = zRect(body).width;
  const wanted = Math.round(zRect(body).right - clientX / ZM());
  return Math.max(240, Math.min(Math.min(720, room - 320), wanted));
}

document.addEventListener('pointerdown', (e) => {
  const bar = e.target.closest('.splitter');
  if (!bar) return;
  e.preventDefault();
  const panel = document.querySelector('.side-panel');
  bar.classList.add('dragging');
  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none';
  // Direct style write on every move: only `width` changes, so the browser reflows one flex
  // child — no full re-render, and no rAF hop to stall when the tab is throttled.
  const move = (ev) => {
    const w = sideWFromPointer(ev.clientX);
    state.sideW = w;
    if (panel) panel.style.width = `${w}px`;
  };
  const up = () => {
    bar.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    render();
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
});

/* Composer grows with its content up to half the chat panel, then scrolls internally.
   Measured from scrollHeight (reset to auto first) because the element is re-created every render. */
document.addEventListener('input', (e) => {
  const el = e.target;
  /* Page filters (Find device, Search notes): re-render the list, then put the caret back. */
  if (el?.dataset?.q) {
    state[el.dataset.q] = el.value;
    const at = el.selectionStart;
    render();
    const again = $(`[data-q="${el.dataset.q}"]`);
    if (again) { again.focus(); again.setSelectionRange(at, at); }
    return;
  }
  if (el?.id === 'search-q') {
    const r = searchRows(el.value);
    $('#search-body').innerHTML = r.body; $('#search-count').textContent = r.counts;
    const q = el.value;
    searchMsgs(q).then((hits) => {
      const box = $('#search-msgs');
      if (!hits || !box) return;
      box.innerHTML = hits.length ? `<div class="pop-group">Chat messages</div>${hits.slice(0, 12).map((h) => msgRow(h, q.trim(), true)).join('')}` : '';
      const body = $('#search-body');
      if (!hits.length && body && !body.querySelector('.pop-row')) body.innerHTML = `<div class="jempty" style="padding:16px">Nothing matches “${esc(q.trim())}”</div>`;
      $('#search-count').textContent = `${r.counts} · ${hits.length} messages`;
    });
    return;
  }
  if (el?.id === 'chat-find-q') { chatFind(); return; }
  if (el?.id === 'palette-q') { $('#palette-body').innerHTML = paletteRows(el.value); return; }
  if (el?.id === 'ns-prompt') { const c = $('#ns-count'); if (c) c.textContent = `${el.value.length} / 8000`; return; }
  if (el?.dataset?.glassRange && glassDraft) {
    glassDraft[el.dataset.glassRange] = +el.value;
    $(`#gv-${el.dataset.glassRange}`).textContent = el.value + el.dataset.unit;
    glassPreview();
    return;
  }
  if (el?.id !== 'composer') return;
  if (/^\/[\w:-]*$/.test(el.value)) { if (!slashOpen()) state.slashSel = 0; popSlash(el.value); }
  else if (slashOpen()) { popover.hidden = true; popover.className = 'popover'; }
  const cap = Math.max(96, (el.closest('.chat-panel')?.clientHeight || 600) * 0.5);
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, cap) + 'px';
  el.style.overflowY = el.scrollHeight > cap ? 'auto' : 'hidden';
});

document.addEventListener('change', (e) => {
  if (e.target?.dataset && 'termhost' in e.target.dataset) { state.termHost = e.target.value; render(); }
  /* Text settings (Workspace name) save when the field is left or Enter is pressed. */
  if (e.target?.matches?.('input[data-pref]')) { prefs[e.target.dataset.pref] = e.target.value.trim(); savePrefs(); renderTitlebar(); }
});

/* Enter in the composer sends; Shift+Enter is left to the browser. */
document.addEventListener('keydown', (e) => {
  if (e.target?.id === 'composer' && slashOpen()) {
    const rows = [...popover.querySelectorAll('.slash-row')];
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      state.slashSel = (state.slashSel + (e.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length;
      popSlash(e.target.value); return;
    }
    if ((e.key === 'Enter' && !e.shiftKey && !e.ctrlKey) || e.key === 'Tab') { e.preventDefault(); slashPick(rows[state.slashSel || 0].dataset.slash); return; }
  }
  if (e.target?.id === 'composer' && e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    const id = state.activeTab;
    const send = document.createElement('button');
    send.dataset.act = 'send';
    /* Ctrl+Enter queues behind a running turn; with nothing running it sends now. */
    if (e.ctrlKey || e.metaKey) send.dataset.queue = '1';
    else if (chatBusy(id) && bubbleChat(id)) { toast('Still answering · Ctrl+Enter queues it', 'clock-countdown'); return; }
    document.body.appendChild(send); send.click(); send.remove();
    return;
  }
  const mod = e.ctrlKey || e.metaKey;
  /* Enter in search or the palette opens the first row; Ctrl Enter starts a new session. */
  if (e.key === 'Enter' && (e.target?.id === 'search-q' || e.target?.id === 'palette-q')) {
    e.preventDefault();
    popover.querySelector('.pop-body [data-nav]:not([data-note]):not([data-device]), .pop-body [data-session], .pop-body [data-note], .pop-body [data-device], .pop-body [data-cmd]')?.click();
    return;
  }
  if (e.key === 'Enter' && mod && e.target?.id === 'ns-prompt') { e.preventDefault(); $('#popover [data-act="started"]')?.click(); return; }
  if (e.key === 'Escape') { closeAll(); return; }
  if (mod && e.key === '/') { e.preventDefault(); closeAll(); modalShortcuts(); return; }
  if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); popPalette(); return; }
  if (mod && e.key.toLowerCase() === 'j') { e.preventDefault(); popCommands(); return; }
  if (mod && e.key.toLowerCase() === 'f') { e.preventDefault(); state.page = state.page === 'focus' ? 'overview' : 'focus'; render(); return; }
  if (mod && e.key === ',') { e.preventDefault(); openSettings(); return; }
  if (mod && e.key.toLowerCase() === 'b') { e.preventDefault(); state.sidebar = !state.sidebar; render(); }
});

/* Below 1280 px the sidebar becomes the 64 px icon rail. The user can still
   override it with the toggle at any width. */
const narrow = window.matchMedia('(max-width: 1279px)');
function syncSidebarWidth() { state.sidebar = !narrow.matches; renderSidebar(); }
narrow.addEventListener('change', syncSidebarWidth);
state.sidebar = !narrow.matches;

/* The data file path for Settings → General; the hub knows it, the browser does not. */
fetch('/api/health').then((r) => r.json()).then((h) => { window.__dbPath = h.db; }).catch(() => {});

render();
