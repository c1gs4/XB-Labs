// A real browser (Edge/Chrome, headless) that agents drive over CDP: `xb browser ...`; the UI watches it as a screencast.
// ponytail: one browser, tabs per session (plus 'hub'), tabs live until closed or the browser exits
// (upgrade: close a target when its session is deleted); local hub only (debug port bound to 127.0.0.1).
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { home } from './worktree.mjs';

const env = process.env;
const CANDIDATES = process.platform === 'win32' ? [
  join(env['ProgramFiles(x86)'] || '', 'Microsoft/Edge/Application/msedge.exe'),
  join(env.ProgramFiles || '', 'Microsoft/Edge/Application/msedge.exe'),
  join(env.ProgramFiles || '', 'Google/Chrome/Application/chrome.exe'),
  join(env['ProgramFiles(x86)'] || '', 'Google/Chrome/Application/chrome.exe'),
  join(env.LocalAppData || '', 'Google/Chrome/Application/chrome.exe'),
] : process.platform === 'darwin' ? [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
] : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge'];

export const findExe = () => CANDIDATES.find((p) => p && existsSync(p));

/* "5173", ":5173" -> localhost; no scheme -> http://. */
export function normUrl(u) {
  u = String(u || '').trim();
  if (!u) throw new Error('url required');
  if (/^:?\d{2,5}(\/.*)?$/.test(u)) return `http://localhost:${u.replace(/^:/, "")}`;   // 5173, :5173, :5173/path
  if (/^[a-z][a-z0-9+.-]*:/i.test(u) && !/^localhost:\d/i.test(u)) return u;
  return `http://${u}`;
}

/* 12 -> {ref:12}; anything else is a CSS selector. */
export const parseRef = (r) => /^\d+$/.test(String(r).trim()) ? { ref: Number(r) } : { css: String(r) };
const sel = (r) => { const p = parseRef(r); return p.css ?? `[data-xb-ref="${p.ref}"]`; };

/* Page-side snapshot: tags visible interactive elements with data-xb-ref=n. */
export const SNAPSHOT_JS = `(() => {
  document.querySelectorAll('[data-xb-ref]').forEach((e) => e.removeAttribute('data-xb-ref'));
  const vis = (e) => { const r = e.getBoundingClientRect(), s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const items = [];
  for (const e of document.querySelectorAll('a[href],button,input,select,textarea,[role=button]')) {
    if (!vis(e) || e.type === 'hidden') continue;
    const tag = e.tagName.toLowerCase(), role = e.getAttribute('role') || (tag === 'input' ? 'input:' + (e.type || 'text') : tag);
    const label = (e.getAttribute('aria-label') || e.innerText || e.value || e.placeholder || e.name || e.title || e.getAttribute('href') || '').trim().replace(/\\s+/g, ' ').slice(0, 80);
    e.setAttribute('data-xb-ref', items.length + 1);
    items.push('[' + (items.length + 1) + '] ' + role + ' "' + label + '"');
  }
  const text = (document.body ? document.body.innerText : '').trim().slice(0, 6000);
  return 'title: ' + document.title + '\\nurl: ' + location.href + '\\n\\n' + text + '\\n\\n' + (items.join('\\n') || '(no interactive elements)');
})()`;

let proc = null, port = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => {
  const s = createServer().once('error', rej).listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});
const alive = async () => {
  if (!port) return false;
  try { return (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) })).ok; } catch { return false; }
};

async function ensure() {
  if (await alive()) return;
  const exe = findExe();
  if (!exe) throw new Error('no Edge or Chrome found');
  const dir = join(home(), 'browser-profile'); mkdirSync(dir, { recursive: true });
  port = await freePort();
  proc = spawn(exe, [`--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, '--headless=new', '--window-size=1280,800', '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' });
  proc.on('exit', () => { proc = null; });
  proc.unref();
  for (let i = 0; i < 50; i++) { if (await alive()) return; await sleep(200); }
  throw new Error('browser did not start');
}

/* Tabs: each session has its own list of browser tabs. A tab's key is the session id for the
   first one, then id~2, id~3...; each key maps to one CDP page target. */
const targets = new Map();   // tab key -> CDP targetId
const tabs = new Map();      // session -> { keys: [], active, n }
const pages = new Map();     // tab key -> { conn, subs:Set<fn>, last, logs:[], net:[], view }
const LOG_MAX = 300;
const tabsOf = (session) => {
  const s = session || 'hub';
  if (!tabs.has(s)) tabs.set(s, { keys: [s], active: s, n: 1 });
  return tabs.get(s);
};
export const activeKey = (session) => tabsOf(session).active;
const ownTab = (session, key) => tabsOf(session).keys.includes(key);

/* Opens a CDP websocket; send() awaits the reply, on(method, fn) takes events. */
async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('cdp connect failed')); });
  let id = 0; const wait = new Map(), handlers = new Map();
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.method) return handlers.get(d.method)?.(d.params);
    const w = wait.get(d.id);
    if (!w) return; wait.delete(d.id);
    d.error ? w.rej(new Error(d.error.message)) : w.res(d.result);
  };
  const send = (method, params = {}) => new Promise((res, rej) => {
    const n = ++id; wait.set(n, { res, rej }); ws.send(JSON.stringify({ id: n, method, params }));
    setTimeout(() => wait.delete(n) && rej(new Error(`${method} timed out`)), 20000);
  });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  return { send, evaluate, on: (method, fn) => handlers.set(method, fn), close: () => ws.close(), onclose: (fn) => { ws.onclose = fn; } };
}

const listPages = async () => (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).filter((t) => t.type === 'page');

/* The page target for a tab key; creates it (Target.createTarget) on first use. */
async function targetFor(key) {
  await ensure();
  const all = await listPages();
  const known = all.find((t) => t.id === targets.get(key));
  if (known) return known;
  if (key === 'hub' && all.length && ![...targets.values()].includes(all[0].id)) { targets.set(key, all[0].id); return all[0]; }
  const bc = await connect((await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl);
  try {
    const { targetId } = await bc.send('Target.createTarget', { url: 'about:blank' });
    targets.set(key, targetId);
  } finally { bc.close(); }
  return (await listPages()).find((t) => t.id === targets.get(key));
}

const push = (arr, x) => { arr.push(x); if (arr.length > LOG_MAX) arr.splice(0, arr.length - LOG_MAX); };
const argText = (a) => (a.value !== undefined ? (typeof a.value === 'string' ? a.value : JSON.stringify(a.value)) : a.description || a.type);

/* One lasting connection per tab: console and network are kept from the first use on; the
   screencast runs only while someone watches. */
const opening = new Map();   // tab key -> promise of its page, so callers at once share one connection
function page(key) {
  if (pages.has(key)) return Promise.resolve(pages.get(key));
  if (!opening.has(key)) opening.set(key, openPage(key).finally(() => opening.delete(key)));
  return opening.get(key);
}
async function openPage(key) {
  let w;
  const conn = await connect((await targetFor(key)).webSocketDebuggerUrl);
  w = { conn, subs: new Set(), last: null, logs: [], net: [], view: null };
  pages.set(key, w);
  const emit = (m) => w.subs.forEach((f) => f(m));
  conn.on('Page.screencastFrame', (p) => {
    w.last = { type: 'frame', data: p.data, w: p.metadata.deviceWidth, h: p.metadata.deviceHeight };
    conn.send('Page.screencastFrameAck', { sessionId: p.sessionId }).catch(() => {});
    emit(w.last);
  });
  conn.on('Page.frameNavigated', (p) => {
    if (p.frame.parentId) return;
    w.net.length = 0;
    push(w.logs, { t: Date.now(), level: 'nav', text: p.frame.url });
    emit({ type: 'url', url: p.frame.url });
  });
  conn.on('Runtime.consoleAPICalled', (p) => push(w.logs, { t: Date.now(), level: p.type, text: (p.args || []).map(argText).join(' ').slice(0, 2000) }));
  conn.on('Runtime.exceptionThrown', (p) => push(w.logs, { t: Date.now(), level: 'error', text: String(p.exceptionDetails.exception?.description || p.exceptionDetails.text).slice(0, 2000) }));
  conn.on('Log.entryAdded', (p) => push(w.logs, { t: Date.now(), level: p.entry.level === 'verbose' ? 'debug' : p.entry.level, text: `${p.entry.text}${p.entry.url ? ` · ${p.entry.url}` : ''}`.slice(0, 2000) }));
  const req = new Map();
  conn.on('Network.requestWillBeSent', (p) => { const r = { t: Date.now(), method: p.request.method, url: p.request.url.slice(0, 500), type: p.type || '', status: null }; req.set(p.requestId, r); push(w.net, r); });
  conn.on('Network.responseReceived', (p) => { const r = req.get(p.requestId); if (r) { r.status = p.response.status; r.mime = p.response.mimeType; } });
  conn.on('Network.loadingFinished', (p) => { const r = req.get(p.requestId); if (r) { r.ms = Date.now() - r.t; r.size = p.encodedDataLength; req.delete(p.requestId); } });
  conn.on('Network.loadingFailed', (p) => { const r = req.get(p.requestId); if (r) { r.status = 'failed'; r.error = p.errorText; req.delete(p.requestId); } });
  conn.onclose(() => { if (pages.get(key) === w) pages.delete(key); });
  await conn.send('Page.enable');
  await Promise.all(['Runtime.enable', 'Network.enable', 'Log.enable'].map((m) => conn.send(m).catch(() => {})));
  /* Headless paints only the front tab, and stops painting an unfocused one: without these the screencast freezes. */
  await conn.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
  return w;
}

/* Frames at the viewer's pixel density, so a HiDPI screen gets sharp text instead of an upscaled 1x frame. */
/* A fixed cap well above any panel: a resize then needs no screencast restart, the next frame just comes at the new size. */
const castSize = () => ({ maxWidth: 3840, maxHeight: 3840 });
async function startCast(w) {
  await w.conn.send('Page.bringToFront').catch(() => {});
  await w.conn.send('Page.startScreencast', { format: 'jpeg', quality: 85, everyNthFrame: 1, ...castSize(w) });
}

/* Runs fn on a session's active tab. */
async function cdp(session, fn) {
  const w = await page(activeKey(session));
  await w.conn.send('Page.bringToFront').catch(() => {});
  return fn(w.conn);
}

/* Screencast of a tab (the session's active one by default) while a UI client watches. cb gets
   {type:'frame', data(base64 jpeg), w, h} and {type:'url', url}. Returns unwatch(). */
export async function watch(session, cb, tab) {
  const key = tab && ownTab(session, tab) ? tab : activeKey(session);
  const w = await page(key);
  if (!w.subs.size) await startCast(w);
  w.subs.add(cb);
  if (w.last) cb(w.last);
  cb({ type: 'url', url: await w.conn.evaluate('location.href').catch(() => '') });
  return () => {
    w.subs.delete(cb);
    if (!w.subs.size) w.conn.send('Page.stopScreencast').catch(() => {});
  };
}

/* Viewport of the active tab: size in CSS px (the panel's own size when it fits), mobile, color scheme. */
export async function setView(session, v = {}) {
  const w = await page(activeKey(session));
  const view = {
    w: Math.max(200, Math.min(3840, Math.round(num(v.w) || 1280))), h: Math.max(200, Math.min(2160, Math.round(num(v.h) || 800))),
    mobile: !!v.mobile, dark: v.dark === true ? true : v.dark === false ? false : null, dpr: Math.max(1, Math.min(3, num(v.dpr) || 1)),
  };
  w.view = view;
  const { send } = w.conn;
  await send('Emulation.setDeviceMetricsOverride', { width: view.w, height: view.h, deviceScaleFactor: view.dpr, mobile: view.mobile, screenWidth: view.w, screenHeight: view.h });
  await send('Emulation.setTouchEmulationEnabled', { enabled: view.mobile }).catch(() => {});
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: view.dark == null ? '' : view.dark ? 'dark' : 'light' }] }).catch(() => {});
  return view;
}

/* Tabs of a session with their address and title. */
export async function listTabs(session) {
  const t = tabsOf(session);
  const all = port && await alive() ? await listPages() : [];
  return { active: t.active, tabs: t.keys.map((key) => { const p = all.find((x) => x.id === targets.get(key)); return { key, url: p ? p.url : 'about:blank', title: p ? p.title : '' }; }) };
}
export async function newTab(session, url) {
  const t = tabsOf(session);
  const key = `${session || 'hub'}~${++t.n}`;
  t.keys.push(key); t.active = key;
  const w = await page(key);
  if (url) { const r = await w.conn.send('Page.navigate', { url: normUrl(url) }); if (r.errorText) throw new Error(r.errorText); }
  return listTabs(session);
}
export async function closeTab(session, key) {
  const t = tabsOf(session);
  if (!ownTab(session, key)) throw new Error('no such tab');
  const id = targets.get(key);
  pages.get(key)?.conn.close(); pages.delete(key); targets.delete(key);
  if (id && port) await fetch(`http://127.0.0.1:${port}/json/close/${id}`).catch(() => {});
  t.keys = t.keys.filter((k) => k !== key);
  if (!t.keys.length) t.keys = [`${session || 'hub'}~${++t.n}`];   // a session always has one tab
  if (t.active === key) t.active = t.keys[t.keys.length - 1];
  return listTabs(session);
}
export function activateTab(session, key) {
  if (!ownTab(session, key)) throw new Error('no such tab');
  tabsOf(session).active = key;
  return listTabs(session);
}
/* Console and network of the active tab, oldest first. */
export async function logs(session) {
  const w = await page(activeKey(session));
  return { console: w.logs, net: w.net };
}

const VK = { Enter: 13, Backspace: 8, Tab: 9, Escape: 27, Delete: 46, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Home: 36, End: 35, PageUp: 33, PageDown: 34 };
const num = (v) => Number.isFinite(+v) ? +v : 0;

/* UI pointer/keyboard -> the page. x,y are page coordinates. */
export async function input(session, ev = {}) {
  const x = num(ev.x), y = num(ev.y), button = ['left', 'middle', 'right'].includes(ev.button) ? ev.button : 'left';
  return cdp(session || 'hub', async ({ send }) => {
    switch (ev.type) {
      case 'click':
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: 1 });
        return send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: 1 });
      case 'move': return send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      case 'wheel': return send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: num(ev.deltaX), deltaY: num(ev.deltaY) });
      case 'text': return send('Input.insertText', { text: String(ev.text ?? '') });
      case 'key': {
        const key = String(ev.key ?? ''); if (!key) throw new Error('key required');
        const text = key.length === 1 ? key : key === 'Enter' ? '\r' : undefined;
        const base = { key, windowsVirtualKeyCode: VK[key] ?? (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0) };
        await send('Input.dispatchKeyEvent', { ...base, type: text ? 'keyDown' : 'rawKeyDown', text });
        return send('Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
      }
      default: throw new Error(`unknown input type: ${ev.type}`);
    }
  });
}

/* Max 15s for the page to finish loading. */
async function loaded(evaluate) {
  await sleep(300);
  for (let i = 0; i < 50; i++) {
    try { if (await evaluate('document.readyState') === 'complete') return; } catch { /* navigating */ }
    await sleep(300);
  }
}

const snap = (evaluate) => evaluate(SNAPSHOT_JS);

/* Element picking: an outline drawn in the page under the pointer, and the element's details. */
const HL_ID = '__xb_hl';
export const highlightJS = (x, y) => `(() => {
  const el = document.elementFromPoint(${x}, ${y}); let b = document.getElementById('${HL_ID}');
  if (!el || el.id === '${HL_ID}') return '';
  if (!b) { b = document.createElement('div'); b.id = '${HL_ID}'; b.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;border:2px solid #4f8cff;background:rgba(79,140,255,.15);border-radius:2px;font:11px/1.4 monospace;color:#fff'; b.appendChild(document.createElement('span')).style.cssText = 'position:absolute;left:-2px;top:-20px;background:#4f8cff;padding:1px 5px;border-radius:3px;white-space:nowrap'; document.documentElement.appendChild(b); }
  const r = el.getBoundingClientRect();
  Object.assign(b.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
  b.firstChild.textContent = el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + ' ' + Math.round(r.width) + '×' + Math.round(r.height);
  return el.tagName;
})()`;
export const PICK_JS = (x, y) => `(() => {
  document.getElementById('${HL_ID}')?.remove();
  const el = document.elementFromPoint(${x}, ${y});
  if (!el) return null;
  const part = (e) => { if (e.id) return '#' + CSS.escape(e.id); let s = e.tagName.toLowerCase(); const c = [...e.classList].slice(0, 2).map((k) => '.' + CSS.escape(k)).join(''); s += c;
    const p = e.parentElement; if (p) { const same = [...p.children].filter((k) => k.tagName === e.tagName); if (same.length > 1) s += ':nth-of-type(' + (same.indexOf(e) + 1) + ')'; } return s; };
  const path = []; for (let e = el; e && e.nodeType === 1 && path.length < 5; e = e.parentElement) { path.unshift(part(e)); if (e.id) break; }
  const cs = getComputedStyle(el), keys = ['display', 'position', 'width', 'height', 'margin', 'padding', 'color', 'background-color', 'font-family', 'font-size', 'font-weight', 'line-height', 'border', 'border-radius', 'gap', 'flex-direction', 'justify-content', 'align-items'];
  const styles = {}; for (const k of keys) { const v = cs.getPropertyValue(k); if (v && !['none', 'normal', 'auto', '0px', 'rgba(0, 0, 0, 0)'].includes(v)) styles[k] = v; }
  /* React: the nearest component name from the fiber, when the page is a React app. */
  let react = ''; const fk = Object.keys(el).find((k) => k.startsWith('__reactFiber' + '$'));
  for (let f = fk && el[fk]; f && !react; f = f.return) if (typeof f.type === 'function') react = f.type.displayName || f.type.name || '';
  const r = el.getBoundingClientRect();
  return { selector: path.join(' > '), tag: el.tagName.toLowerCase(), html: el.outerHTML.slice(0, 2000), text: (el.innerText || '').trim().slice(0, 300),
    styles, react, url: location.href, rect: { x: r.left, y: r.top, w: r.width, h: r.height } };
})()`;

/* Returns { text } or { png } (base64). Throws on failure. */
export async function act(action, args = [], session) {
  const a = args.map(String);
  return cdp(session || 'hub', async ({ send, evaluate }) => {
    switch (action) {
      case 'open': {
        const url = normUrl(a[0]);
        const r = await send('Page.navigate', { url });
        if (r.errorText) throw new Error(`${url}: ${r.errorText}`);
        await loaded(evaluate); return { text: `opened ${url}` };
      }
      case 'snapshot': return { text: await snap(evaluate) };
      case 'highlight': return { text: await evaluate(highlightJS(num(a[0]), num(a[1]))) };
      case 'unhighlight': await evaluate(`document.getElementById('${HL_ID}')?.remove()`); return { text: 'ok' };
      case 'pick': {
        const info = await evaluate(PICK_JS(num(a[0]), num(a[1])));
        if (!info) throw new Error('no element there');
        const pad = 8, r = info.rect;
        const clip = { x: Math.max(0, r.x - pad), y: Math.max(0, r.y - pad), width: Math.max(1, r.w + pad * 2), height: Math.max(1, r.h + pad * 2), scale: 1 };
        const shot = await send('Page.captureScreenshot', { format: 'png', clip }).catch(() => null);
        return { info, png: shot && shot.data };
      }
      case 'text': return { text: [await evaluate('document.title'), await evaluate('location.href'), '', await evaluate('document.body ? document.body.innerText : ""')].join('\n').slice(0, 50000) };
      case 'click': {
        if (!a[0]) throw new Error('click REF');
        const ok = await evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel(a[0]))}); if (!e) return false; e.scrollIntoView({ block: 'center' }); e.click(); return true; })()`);
        if (!ok) throw new Error(`no element ${a[0]} (run snapshot first)`);
        await loaded(evaluate); return { text: `clicked ${a[0]}` };
      }
      case 'fill': {
        if (!a[0]) throw new Error('fill REF TEXT');
        const ok = await evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel(a[0]))}); if (!e) return false; e.scrollIntoView({ block: 'center' }); e.focus();
          const proto = e instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : e instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
          const set = Object.getOwnPropertyDescriptor(proto, 'value'); set && set.set ? set.set.call(e, ${JSON.stringify(a.slice(1).join(' '))}) : (e.value = ${JSON.stringify(a.slice(1).join(' '))});
          e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
        if (!ok) throw new Error(`no element ${a[0]} (run snapshot first)`);
        return { text: `filled ${a[0]}` };
      }
      case 'screenshot': {
        const r = await send('Page.captureScreenshot', { format: 'png' });
        if (a[0]) { writeFileSync(a[0], Buffer.from(r.data, 'base64')); return { text: `saved ${a[0]}` }; }
        return { png: r.data };
      }
      case 'eval': {
        if (!a.length) throw new Error('eval JS');
        const v = await evaluate(a.join(' '));
        return { text: typeof v === 'string' ? v : JSON.stringify(v) ?? 'undefined' };
      }
      case 'back': case 'forward': case 'reload': {
        if (action === 'reload') await send('Page.reload');
        else await evaluate(`history.${action}()`);
        await loaded(evaluate); return { text: await evaluate('location.href') };
      }
      default: throw new Error(`unknown browser action: ${action}. open|snapshot|text|pick|click|fill|screenshot|eval|back|forward|reload`);
    }
  });
}

/* Kills the browser this process launched (tests, hub shutdown). */
export function close() { for (const w of pages.values()) w.conn.close(); pages.clear(); targets.clear(); tabs.clear(); if (proc) { proc.kill(); proc = null; } port = 0; }
