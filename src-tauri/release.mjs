// Run after `npm run tauri:build` (with TAURI_SIGNING_PRIVATE_KEY set): node src-tauri/release.mjs [notes]
// Writes src-tauri/target/release/bundle/latest.json, the file the app's updater reads from
// https://github.com/<repo>/releases/latest/download/latest.json. Upload it together with the
// installer to a GitHub release tagged v<version>.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = 'c1gs4/XB-Labs';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const BUNDLE = join(ROOT, 'src-tauri', 'target', 'release', 'bundle');
const exe = `XBLabs_${version}_x64-setup.exe`;
const sig = join(BUNDLE, 'nsis', `${exe}.sig`);
if (!existsSync(sig)) throw new Error(`${sig} is missing: build with TAURI_SIGNING_PRIVATE_KEY set`);

const latest = {
  version,
  notes: process.argv[2] || `XBLabs ${version}`,
  pub_date: new Date().toISOString(),
  platforms: {
    'windows-x86_64': {
      signature: readFileSync(sig, 'utf8').trim(),
      url: `https://github.com/${REPO}/releases/download/v${version}/${exe}`,
    },
  },
};
writeFileSync(join(BUNDLE, 'latest.json'), `${JSON.stringify(latest, null, 2)}\n`);
console.log(`latest.json for v${version}: upload ${join(BUNDLE, 'nsis', exe)} and ${join(BUNDLE, 'latest.json')} to release v${version}`);
