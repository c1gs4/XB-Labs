/* One-line agent install, served by the hub: `curl -fsSL http://<hub>:5200/install.sh | sh` or
   `irm http://<hub>:5200/install.ps1 | iex`. The script pulls the agent's few files from this hub
   (no git, no repo), Node.js 22 from nodejs.org when the device has no Node 20+, installs the two
   npm deps, and starts the agent as a service that dials back to the hub that served it.
   Nothing secret is in a script: a token, when the hub needs one, comes from the device's own
   XBLABS_TOKEN env. Re-running a script updates the agent in place. */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER = dirname(fileURLToPath(import.meta.url));
export const FILES = ['server/agent.mjs', 'server/agents.mjs', 'server/worktree.mjs', 'server/hooks/report.mjs', 'server/hooks/omp.mjs', 'package.json'];
const NODE_V = 'v22.12.0';   // LTS fetched only when the device has no Node 20+

/* Host header lands inside a shell script, so it must be a plain host[:port]. */
export const okHost = (h) => /^[A-Za-z0-9][\w.-]{0,252}(:\d{1,5})?$/.test(String(h || ''));

/* node-pty ships no Linux prebuild (it would need python + g++ there); the homebridge fork is
   N-API with Linux prebuilds, and agent.mjs falls back to it. */
function agentPackage(os) {
  const { version } = JSON.parse(readFileSync(join(SERVER, '..', 'package.json'), 'utf8'));
  const pty = os === 'linux' ? { '@homebridge/node-pty-prebuilt-multiarch': '^0.15.0' } : { 'node-pty': '^1.1.0' };
  return JSON.stringify({ name: 'xblabs-agent', version, private: true, type: 'module', dependencies: { ws: '^8.22.2', ...pty } }, null, 2);
}

export function file(path, os) {
  if (!FILES.includes(path)) return null;
  if (path === 'package.json') return agentPackage(os);
  return readFileSync(join(SERVER, path.slice('server/'.length)), 'utf8');
}

/* The worker's code, hashed the same way the worker hashes its own copy (line endings ignored;
   package.json left out, it differs per OS). Equal = that worker runs this hub's code. */
export const BUILD_FILES = FILES.filter((f) => f !== 'package.json');
export function agentBuild() {
  const h = createHash('sha256');
  for (const f of BUILD_FILES) h.update(f).update('\0').update(readFileSync(join(SERVER, f.slice('server/'.length)), 'utf8').replace(/\r\n/g, '\n'));
  return h.digest('hex').slice(0, 16);
}

export function script(kind, host) {
  const tpl = kind === 'ps1' ? PS1 : SH;
  return tpl.replaceAll('__HOST__', host).replaceAll('__NODE_V__', NODE_V).replaceAll('__FILES__', FILES.join(kind === 'ps1' ? "','" : ' '));
}

const SH = `#!/bin/sh
# XBLabs agent installer, served by the hub at __HOST__. Re-run to update.
# Env: XBLABS_NAME (default: hostname), XBLABS_TOKEN, XBLABS_AGENT_DIR, XBLABS_NO_SERVICE=1 (run in foreground)
set -e
HUB_HTTP='http://__HOST__'
HUB_WS='ws://__HOST__'
NAME=$(printf '%s' "\${XBLABS_NAME:-$(hostname)}" | tr -cd 'A-Za-z0-9._-')
DIR="\${XBLABS_AGENT_DIR:-$HOME/.xblabs-agent}"
say() { printf '[xblabs] %s\\n' "$*"; }
fetch() { if command -v curl >/dev/null 2>&1; then curl -fsSL "$1" -o "$2"; else wget -qO "$2" "$1"; fi; }
OS=$(uname -s | tr 'A-Z' 'a-z')
case "$(uname -m)" in x86_64|amd64) ARCH=x64;; aarch64|arm64) ARCH=arm64;; armv7l) ARCH=armv7l;; *) ARCH=$(uname -m);; esac
mkdir -p "$DIR/server/hooks"

NODE=$(command -v node || true)
if [ -z "$NODE" ] || [ "$("$NODE" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -lt 20 ]; then
  if [ ! -x "$DIR/node/bin/node" ]; then
    say "Node.js 20+ not found, fetching __NODE_V__ into $DIR/node"
    T="node-__NODE_V__-$OS-$ARCH"
    fetch "https://nodejs.org/dist/__NODE_V__/$T.tar.gz" "$DIR/node.tgz"
    rm -rf "$DIR/node" && tar -xzf "$DIR/node.tgz" -C "$DIR" && mv "$DIR/$T" "$DIR/node" && rm -f "$DIR/node.tgz"
  fi
  NODE="$DIR/node/bin/node"
fi
BIN=$(dirname "$NODE")

say "Fetching the agent from $HUB_HTTP"
for f in __FILES__; do fetch "$HUB_HTTP/agent/pkg/$f?os=$OS" "$DIR/$f"; done
say "Installing dependencies"
(cd "$DIR" && PATH="$BIN:$PATH" "$BIN/npm" install --omit=dev --no-audit --no-fund --loglevel=error)

set -- "$DIR/server/agent.mjs" --hub "$HUB_WS" --name "$NAME"
[ -n "$XBLABS_TOKEN" ] && set -- "$@" --token "$XBLABS_TOKEN"
if [ -n "$XBLABS_NO_SERVICE" ]; then exec "$NODE" "$@"; fi

pkill -f "$DIR/server/agent.mjs" 2>/dev/null || true
if [ "$OS" = darwin ]; then
  P="$HOME/Library/LaunchAgents/com.xblabs.agent.plist"
  mkdir -p "$(dirname "$P")"
  { echo '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>Label</key><string>com.xblabs.agent</string><key>ProgramArguments</key><array>'
    echo "<string>$NODE</string>"; for a in "$@"; do echo "<string>$a</string>"; done
    echo '</array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/></dict></plist>'; } > "$P"
  launchctl unload "$P" 2>/dev/null || true; launchctl load "$P"
  WHO="launchd (com.xblabs.agent)"
elif command -v systemctl >/dev/null 2>&1 && [ "$(id -u)" = 0 ] && systemctl show-environment >/dev/null 2>&1; then
  U=/etc/systemd/system/xblabs-agent.service
  printf '[Unit]\\nDescription=XBLabs agent\\nAfter=network-online.target\\n[Service]\\nExecStart=%s\\nRestart=always\\nRestartSec=5\\n[Install]\\nWantedBy=multi-user.target\\n' "$NODE $*" > "$U"
  systemctl daemon-reload && systemctl enable --now xblabs-agent >/dev/null && systemctl restart xblabs-agent
  WHO="systemd (xblabs-agent)"
elif command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
  U="$HOME/.config/systemd/user/xblabs-agent.service"
  mkdir -p "$(dirname "$U")"
  printf '[Unit]\\nDescription=XBLabs agent\\n[Service]\\nExecStart=%s\\nRestart=always\\nRestartSec=5\\n[Install]\\nWantedBy=default.target\\n' "$NODE $*" > "$U"
  systemctl --user daemon-reload && systemctl --user enable --now xblabs-agent >/dev/null && systemctl --user restart xblabs-agent
  loginctl enable-linger "$(id -un)" 2>/dev/null || say "Note: without 'loginctl enable-linger' the agent stops when you log out"
  WHO="systemd --user (xblabs-agent)"
else
  nohup "$NODE" "$@" > "$DIR/agent.log" 2>&1 &
  (crontab -l 2>/dev/null | grep -v xblabs-agent; echo "@reboot $NODE $* > $DIR/agent.log 2>&1 # xblabs-agent") | crontab - 2>/dev/null || true
  WHO="nohup + @reboot cron"
fi
say "Agent '$NAME' runs under $WHO and connects to $HUB_WS"
`;

const PS1 = `# XBLabs agent installer, served by the hub at __HOST__. Re-run to update.
# Env: XBLABS_NAME (default: computer name), XBLABS_TOKEN, XBLABS_AGENT_DIR, XBLABS_NO_SERVICE=1 (run in foreground)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$HubHttp = 'http://__HOST__'; $HubWs = 'ws://__HOST__'
$Name = $(if ($env:XBLABS_NAME) { $env:XBLABS_NAME } else { $env:COMPUTERNAME }) -replace '[^A-Za-z0-9._-]', ''
$Dir = $(if ($env:XBLABS_AGENT_DIR) { $env:XBLABS_AGENT_DIR } else { Join-Path $env:LOCALAPPDATA 'xblabs-agent' })
function Say($m) { Write-Host "[xblabs] $m" }
New-Item -ItemType Directory -Force (Join-Path $Dir 'server\\hooks') | Out-Null

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
$ok = $false
if ($node) { $ok = [int](& $node -p "process.versions.node.split('.')[0]") -ge 20 }
if (-not $ok) {
  $node = Join-Path $Dir 'node\\node.exe'
  if (-not (Test-Path $node)) {
    $arch = $(if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' })
    $t = "node-__NODE_V__-win-$arch"
    Say "Node.js 20+ not found, fetching __NODE_V__ into $Dir\\node"
    $zip = Join-Path $Dir 'node.zip'
    Invoke-WebRequest "https://nodejs.org/dist/__NODE_V__/$t.zip" -OutFile $zip -UseBasicParsing
    Expand-Archive $zip -DestinationPath $Dir -Force; Remove-Item $zip
    Rename-Item (Join-Path $Dir $t) 'node'
  }
}
$bin = Split-Path $node

Say "Fetching the agent from $HubHttp"
foreach ($f in @('__FILES__')) { Invoke-WebRequest "$HubHttp/agent/pkg/$($f)?os=win32" -OutFile (Join-Path $Dir $f) -UseBasicParsing }
Say 'Installing dependencies'
$env:PATH = "$bin;$env:PATH"
Push-Location $Dir
& (Join-Path $bin 'npm.cmd') install --omit=dev --no-audit --no-fund --loglevel=error
$code = $LASTEXITCODE
Pop-Location
if ($code) { throw 'npm install failed' }

$agentArgs = @((Join-Path $Dir 'server\\agent.mjs'), '--hub', $HubWs, '--name', $Name)
if ($env:XBLABS_TOKEN) { $agentArgs += @('--token', $env:XBLABS_TOKEN) }
if ($env:XBLABS_NO_SERVICE) { & $node @agentArgs; return }

Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like "*$Dir*agent.mjs*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
# Starts hidden at every logon. ponytail: a crashed agent waits for the next logon; the agent's own reconnect loop covers hub restarts.
$cmd = (@($node) + $agentArgs | ForEach-Object { '"' + $_ + '"' }) -join ' '
$vbs = Join-Path $Dir 'start.vbs'
Set-Content $vbs ('CreateObject("WScript.Shell").Run "' + ($cmd -replace '"', '""') + '", 0, False') -Encoding ASCII
$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('"' + $vbs + '"')
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Seconds 0)
Register-ScheduledTask -TaskName 'XBLabs Agent' -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName 'XBLabs Agent'
Say "Agent '$Name' runs at every logon (task 'XBLabs Agent') and connects to $HubWs"
`;
