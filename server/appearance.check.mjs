// Run: node server/appearance.check.mjs — preference defaults, bounds and persistence; no hub/model.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const source = readFileSync(new URL('../app/js/app.js', import.meta.url), 'utf8');
const props = {}, style = { setProperty: (key, value) => { props[key] = value; } };
let saved;
const ctx = vm.createContext({ document: { documentElement: { dataset: {}, style, toggleAttribute() {} } }, localStorage: { setItem: (key, value) => { saved = JSON.parse(value); } } });
vm.runInContext(`const PREFS_KEY = 'xblabs.prefs'; const prefs = {}; const state = { palette: 'midnight' }; function isLight() { return false; } function uiPush() {}`, ctx);
vm.runInContext(source.slice(source.indexOf('function savePrefs()'), source.indexOf('/* Notification sounds:')), ctx);
vm.runInContext(source.slice(source.indexOf('function applyPrefs()'), source.indexOf('function isLight()')), ctx);
const apply = (values) => { ctx.values = values; vm.runInContext('Object.keys(prefs).forEach(k => delete prefs[k]); Object.assign(prefs, values); savePrefs(); applyPrefs();', ctx); };
apply({});
assert.equal(props['--chat-font-size'], '12px');
assert.equal(style.zoom, '');
apply({ 'UI scale': '85%', 'Chat font size': '12.5px', palette: 'custom' });
assert.equal(style.zoom, '0.85');
assert.equal(props['--chat-font-size'], '12.5px');
assert.equal(saved['Chat font size'], '12.5px');
assert.equal(saved.palette, 'custom');
for (const [scale, font, zoom, size] of [['bad', 'bad', '', '12px'], ['999%', '999px', '1.5', '18px'], ['1%', '1px', '0.75', '11px']]) {
  apply({ 'UI scale': scale, 'Chat font size': font });
  assert.equal(style.zoom, zoom);
  assert.equal(props['--chat-font-size'], size);
}
assert.match(source, /settingRow\('Chat font size'/);
console.log('appearance.check ok — defaults, independent scale/font, bounds, persistence');
