// Run: node src-tauri/prep.mjs — gathers what the desktop build ships next to the shell: this
// Node binary (the hub's runtime), server/ without its self-checks, app/, package.json and the
// two runtime packages (ws, node-pty's own prebuilt binaries). Output: src-tauri/runtime/.
import { cpSync, existsSync, mkdirSync, rmSync, copyFileSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'src-tauri', 'runtime');
const plat = `${process.platform}-${process.arch}`;

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
copyFileSync(process.execPath, join(OUT, basename(process.execPath)));   // node.exe: the exact runtime the hub was tested on
/* Never ship local state: a data/ folder (sqlite, notes) left by a hub started from inside server/ or app/. */
const skip = (src) => !/\.check\.mjs$|\.pdb$|\.map$|\.test\.js$/.test(src) && !/[\\/]data([\\/]|$)/.test(src.slice(ROOT.length));
cpSync(join(ROOT, 'server'), join(OUT, 'server'), { recursive: true, filter: skip });
cpSync(join(ROOT, 'app'), join(OUT, 'app'), { recursive: true, filter: skip });
copyFileSync(join(ROOT, 'package.json'), join(OUT, 'package.json'));
cpSync(join(ROOT, 'node_modules', 'ws'), join(OUT, 'node_modules', 'ws'), { recursive: true });
const pty = join(ROOT, 'node_modules', 'node-pty');
for (const part of ['package.json', 'lib', join('prebuilds', plat)]) {
  if (!existsSync(join(pty, part))) throw new Error(`node-pty is missing ${part}: run npm install`);
  cpSync(join(pty, part), join(OUT, 'node_modules', 'node-pty', part), { recursive: true, filter: skip });
}
console.log(`runtime ready: ${OUT} (node ${process.version}, ${plat})`);
