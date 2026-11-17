/* Tailscale is where the device list comes from: the tailnet is the fleet.
   Two ways in — the local CLI (already logged in on this machine) or an API key
   for the tailnet, which is the only option when the hub runs somewhere else. */
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { getSetting, setSetting } from './db.mjs';

const TS_EXE = [
  'C:\\Program Files\\Tailscale\\tailscale.exe',
  'C:\\Program Files (x86)\\Tailscale\\tailscale.exe',
].find((p) => existsSync(p)) || 'tailscale';

const run = (args, timeout = 6000) => new Promise((resolve, reject) => {
  execFile(TS_EXE, args, { timeout, windowsHide: true }, (err, stdout, stderr) => {
    if (err) reject(new Error((stderr || err.message || '').trim() || 'tailscale failed'));
    else resolve(stdout);
  });
});

const shortName = (dns = '') => String(dns).replace(/\.$/, '').split('.')[0];
const firstIp = (ips = []) => ips.find((i) => /^\d+\./.test(i)) || ips[0] || '';

/* --- mode: local CLI ------------------------------------------------------ */
async function fromCli() {
  const raw = await run(['status', '--json']);
  const d = JSON.parse(raw);
  const suffix = (d.MagicDNSSuffix || '').replace(/\.$/, '');
  const self = d.Self || {};
  const devices = [{
    name: self.HostName || 'this-host', os: self.OS || 'windows',
    ip: firstIp(self.TailscaleIPs), dns: shortName(self.DNSName), online: d.BackendState === 'Running',
    self: true, key: self.ID || 'self', rx: 0, tx: 0, lastSeen: '',
  }];
  for (const [key, p] of Object.entries(d.Peer || {})) {
    devices.push({
      name: p.HostName || shortName(p.DNSName) || key, os: p.OS || '', ip: firstIp(p.TailscaleIPs),
      dns: shortName(p.DNSName), online: !!p.Online, self: false, key,
      rx: p.RxBytes || 0, tx: p.TxBytes || 0, lastSeen: p.LastSeen || '',
      exitNode: !!p.ExitNode, relay: p.Relay || '',
    });
  }
  return { mode: 'cli', connected: d.BackendState === 'Running', backend: d.BackendState || 'unknown',
    tailnet: suffix, host: self.HostName || '', ip: firstIp(self.TailscaleIPs), devices };
}

/* --- mode: API key ------------------------------------------------------- */
async function fromApi(key, tailnet = '-') {
  const auth = 'Basic ' + Buffer.from(`${key}:`).toString('base64');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const r = await fetch(`https://api.tailscale.com/api/v2/tailnet/${encodeURIComponent(tailnet)}/devices`, {
      headers: { Authorization: auth }, signal: ctrl.signal,
    });
    if (r.status === 401 || r.status === 403) throw new Error('API key rejected (401) — check the key and its scope');
    if (!r.ok) throw new Error(`tailscale api ${r.status}`);
    const body = await r.json();
    const devices = (body.devices || []).map((d) => ({
      name: d.hostname || d.name?.split('.')[0] || d.id, os: d.os || '',
      ip: firstIp(d.addresses || []), dns: (d.name || '').split('.')[0],
      online: !!d.connectedToControl, self: false, key: d.id,
      lastSeen: d.lastSeen || '', tags: d.tags || [],
    }));
    return { mode: 'api', connected: true, backend: 'api', tailnet: tailnet === '-' ? '' : tailnet,
      host: '', ip: '', devices };
  } finally { clearTimeout(timer); }
}

/* --- public -------------------------------------------------------------- */
export function config() {
  const key = getSetting('ts.api_key');
  return {
    mode: getSetting('ts.mode', 'cli'),
    tailnet: getSetting('ts.tailnet') || '-',
    has_key: !!key,
    key_hint: key ? `${key.slice(0, 6)}…${key.slice(-4)}` : '',
    ssh_user: getSetting('ts.ssh_user') || '',
    cli_found: TS_EXE !== 'tailscale' || existsSync('tailscale'),
  };
}

export async function status() {
  const c = config();
  /* XBLABS_TAILSCALE=off: no tailnet at all (demo hubs, CI); the fleet is this host and attached agents. */
  if (process.env.XBLABS_TAILSCALE === 'off') return { ...c, ok: false, connected: false, devices: [], error: 'Tailscale is off for this hub (XBLABS_TAILSCALE=off)' };
  try {
    const s = c.mode === 'api'
      ? await fromApi(getSetting('ts.api_key'), c.tailnet || '-')
      : await fromCli();
    return { ...c, ...s, tailnet: s.tailnet || c.tailnet, error: '', ok: true };
  } catch (err) {
    return { ...c, ok: false, connected: false, devices: [], error: String(err.message || err) };
  }
}

export async function connect({ mode, api_key: apiKey, tailnet }) {
  const m = mode === 'api' ? 'api' : 'cli';
  setSetting('ts.mode', m);
  if (tailnet !== undefined) setSetting('ts.tailnet', String(tailnet || '-').trim() || '-');
  if (apiKey) setSetting('ts.api_key', String(apiKey).trim());
  const s = await status();
  if (!s.ok) throw new Error(s.error);
  return s;
}

/* Browser sign-in: `tailscale login` prints an auth URL and waits until it is used. Resolve with
   the URL ('' when it finished without one) and leave the CLI waiting, killed after 10 minutes. */
let loginProc = null;
export function login() {
  if (loginProc) { loginProc.kill(); loginProc = null; }
  return new Promise((resolve, reject) => {
    const p = spawn(TS_EXE, ['login'], { windowsHide: true });
    loginProc = p;
    let out = '', done = false;
    const finish = (fn, v) => { if (!done) { done = true; clearTimeout(t); fn(v); } };
    const t = setTimeout(() => { p.kill(); finish(reject, new Error('tailscale login printed no sign-in link in 20 s')); }, 20000);
    const read = (d) => {
      out += d;
      const m = out.match(/https:\/\/login\.tailscale\.com\/[\w\/-]+/);
      if (m) finish(resolve, m[0]);
    };
    p.stdout.on('data', read); p.stderr.on('data', read);
    p.on('error', (err) => finish(reject, new Error(err.code === 'ENOENT' ? 'Tailscale is not installed on this hub · tailscale.com/download' : err.message)));
    p.on('exit', (code) => { if (loginProc === p) loginProc = null; finish(code ? reject : resolve, code ? new Error(out.trim().split('\n').pop() || 'tailscale login failed') : ''); });
    setTimeout(() => { if (loginProc === p) p.kill(); }, 600000).unref();
  });
}

export function disconnect() {
  setSetting('ts.api_key', '');
  setSetting('ts.mode', 'cli');
}

export async function devices() {
  const s = await status();
  return s.devices || [];
}
