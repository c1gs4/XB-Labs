// Run: node server/settings.check.mjs — hub settings are validated, and reach the commands and
// env a session starts with.
import assert from 'node:assert/strict';
process.env.XBLABS_DB = ':memory:';
const db = await import('./db.mjs');
const { jobArgv, chatArgv, ompEndpoint } = await import('./pty.mjs');
const { enabled } = await import('./agents.mjs');

const s0 = db.hubSettings();
assert.deepEqual(s0.session, { agent: '', worktree: true, skipPerms: false, hibernateAfter: 30, maxAgents: 0 });   // defaults
assert.deepEqual(jobArgv({ kind: 'job', agent: 'omp', prompt: 'x' }), ['omp', '-p', 'x', '--mode', 'json']);

db.setHubSettings({ session: { skipPerms: true }, agents: { omp: { bin: 'C:/tools/omp.exe', flags: '--model opus' }, gemini: { enabled: false } } });
assert.deepEqual(jobArgv({ kind: 'job', agent: 'omp', prompt: 'x' }), ['C:/tools/omp.exe', '-p', 'x', '--auto-approve', '--model', 'opus', '--mode', 'json']);
assert.deepEqual(chatArgv({ kind: 'chat', agent: 'hermes', prompt: '' }), ['hermes', 'chat', '--yolo']);
assert.deepEqual(chatArgv({ kind: 'chat', agent: 'opencode', prompt: '' }), ['opencode']);       // no skip flag known
assert.equal(db.hubSettings().session.worktree, true);                                           // untouched key kept
assert.ok(!enabled('gemini', db.hubSettings()) && enabled('omp', db.hubSettings()));

assert.throws(() => db.setHubSettings({ env: { 'BAD NAME': 'x' } }), /bad variable name/);
db.setHubSettings({ env: { GITHUB_TOKEN: 'abc' } });
assert.deepEqual(db.hubSettings().env, { GITHUB_TOKEN: 'abc' });
assert.throws(() => db.setHubSettings({ notify: { push: 'ftp://x' } }), /http/);
assert.deepEqual(db.setHubSettings({ goa: { max: 99, stallMin: 0 } }).goa, { max: 16, stallMin: 10, rules: '' });   // clamped / kept
assert.deepEqual(db.hubSettings().decide, { approve: false, loop: false });                      // both off by default
assert.deepEqual(db.setHubSettings({ decide: { approve: 'yes', loop: true } }).decide, { approve: false, loop: true });   // only true turns it on
assert.deepEqual(db.setHubSettings({ decide: { approve: true } }).decide, { approve: true, loop: true });
assert.deepEqual(db.hubSettings().accounts, { fallback: false });                   // fallback may spend money: off by default
assert.deepEqual(db.setHubSettings({ accounts: { fallback: 'yes' } }).accounts, { fallback: false });   // only true turns it on
assert.deepEqual(db.setHubSettings({ accounts: { fallback: true } }).accounts, { fallback: true });
db.addDecision({ session_id: 's1', kind: 'ask', summary: 'x', verdict: 'ask' });
assert.equal(db.listDecisions(5)[0].kind, 'ask');
/* A model picked at New session runs on the hub endpoint instead of the hub default; the rest keep the default. */
db.setSetting('llm.base_url', 'http://gw/v1'); db.setSetting('llm.model', 'hub-default'); db.setLlmAgents(['hermes']);
const picked = db.createSession({ title: 'p', agent: 'hermes', cwd: '.', llm_model: 'other/model-x' });
assert.equal(db.sessionEnv(picked).LLM_MODEL, 'other/model-x');
assert.equal(picked.model, 'other/model-x');
assert.equal(db.sessionEnv(db.createSession({ title: 'd', agent: 'hermes', cwd: '.' })).LLM_MODEL, 'hub-default');
/* Local OMP chat/TUI reaches the endpoint (and the picked model) only through the xblabs extension. */
const ep = { LLM_BASE_URL: 'http://gw/v1', LLM_MODEL: 'other/model-x' };
const omp = ompEndpoint({ agent: 'omp', device: 'local' }, ['omp', '-p', 'x'], ep);
assert.deepEqual(omp.slice(-2), ['--model', 'xblabs/other/model-x']);
assert.equal(omp[omp.indexOf('--extension') + 1].endsWith('omp.mjs'), true);
assert.deepEqual(ompEndpoint({ agent: 'hermes', device: 'local' }, ['hermes'], ep), ['hermes']);
console.log('settings.check ok');
