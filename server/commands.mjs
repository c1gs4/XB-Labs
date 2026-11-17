/* Slash commands an agent's own install knows, read from that install (hub only).
   Hermes: its command registry plus its skills (each skill is a /command), via Hermes' own Python.
   An agent with no reader here keeps the hand-kept list in the app.
   ponytail: hub-local install only, global skills only (no per-project skills), cached 10 minutes. */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { findBin } from './agents.mjs';

const WIN = process.platform === 'win32';
const cache = new Map();   // agent -> { at, list }

/* Hermes' source folder: next to the hermes launcher, or the usual install homes. */
function hermesSrc() {
  const bin = findBin('hermes');
  const roots = [bin && dirname(dirname(bin)), process.env.HERMES_HOME, join(homedir(), '.hermes'), process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'hermes')].filter(Boolean);
  for (const r of roots) {
    const src = join(r, 'hermes-agent'), py = join(src, 'venv', WIN ? 'Scripts/python.exe' : 'bin/python');
    if (existsSync(join(src, 'hermes_cli', 'commands.py')) && existsSync(py)) return { src, py };
  }
  return null;
}

const HERMES_DUMP = `
import json
from hermes_cli.commands import COMMAND_REGISTRY
out = []
for c in COMMAND_REGISTRY:
    if c.gateway_only or c.desktop == 'hidden': continue
    out.append(['/' + c.name, c.describe(), c.category or 'Commands', c.args_hint or ''])
try:
    from agent.skill_commands import get_skill_commands
    for k, v in sorted(get_skill_commands().items()):
        out.append([k, (v.get('description') or '').strip(), 'Skills', ''])
except Exception:
    pass
print(json.dumps(out))
`;

const READERS = {
  hermes: () => new Promise((done, fail) => {
    const h = hermesSrc();
    if (!h) return fail(new Error('Hermes install not found on this hub'));
    execFile(h.py, ['-c', HERMES_DUMP], { cwd: h.src, timeout: 30000, maxBuffer: 8 << 20, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } },
      (err, out) => {
        if (err) return fail(err);
        try { done(JSON.parse(String(out).trim().split('\n').pop())); } catch (e) { fail(e); }
      });
  }),
};

/* [[command, description, group, argsHint]] or null when this hub cannot read that agent's list. */
export async function list(agent) {
  if (!Object.hasOwn(READERS, agent)) return null;
  const c = cache.get(agent);
  if (c && Date.now() - c.at < 600000) return c.list;
  const l = (await READERS[agent]()).filter((x) => Array.isArray(x) && /^\/[\w:.-]+$/.test(x[0]))
    .map(([cmd, desc, group, args]) => [cmd, String(desc || '').slice(0, 200), String(group || ''), String(args || '').slice(0, 60)]);
  cache.set(agent, { at: Date.now(), list: l });
  return l;
}
