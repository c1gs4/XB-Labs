// Run: node server/accounts.check.mjs — limit detection, config picking and env, and that the API never leaks a key.
import assert from 'node:assert/strict';
process.env.XBLABS_DB = ':memory:';
const { detectLimit, pickConfig, configEnv, sharesConversation, validateConfig, publicConfig } = await import('./accounts.mjs');
const db = await import('./db.mjs');

/* Limit messages: local time 3pm, so "resets 5:40am" is tomorrow and "resets 5pm" is today. */
const now = new Date(2026, 5, 10, 15, 0, 0).getTime();
const at = (d, h, m) => new Date(2026, 5, d, h, m, 0).getTime();
assert.equal(detectLimit("You've hit your 5-hour limit · resets 5:40am", now).until, at(11, 5, 40));   // across midnight
assert.equal(detectLimit("Claude AI usage limit reached. Your limit resets at 5pm", now).until, at(10, 17, 0));
assert.equal(detectLimit('Usage limit reached. Please try again in 3h 20m.', now).until, now + (3 * 60 + 20) * 60000);
assert.equal(detectLimit('Error: 429 Too Many Requests. Retry in 45m', now).until, now + 45 * 60000);
assert.equal(detectLimit('limit reached|try again in 3h', now).until, now + 3 * 3600000);
assert.equal(detectLimit("You've hit your usage limit. Try again at 12:05 AM.", now).until, at(11, 0, 5));
assert.equal(detectLimit('Error: Quota exceeded for metric generate_content_requests (RESOURCE_EXHAUSTED)', now).until, now + 3600000);   // no time: 60 min
assert.ok(detectLimit('rate limit exceeded', now));
assert.ok(detectLimit('You exceeded your current quota, please check your plan', now));
for (const t of ['limit the output to 10 lines', 'git log --limit 5 and set the memory limit option', 'add a rate limit middleware to the router', 'usage: tool [--limit N]', 'const MAX_LIMIT = 429;'])
  assert.equal(detectLimit(t, now), null, t);

/* pickConfig */
const mk = (id, priority, extra = {}) => ({ id, agent: 'claude', name: id, kind: 'api', priority, enabled: 1, limited_until: 0, created_at: priority, ...extra });
const off = (extra) => ({ id: '', agent: 'claude', enabled: 1, limited_until: 0, ...extra });
const cfgs = [off(), mk('b', 2), mk('a', 1), mk('x', 0, { enabled: 0 }), mk('o', 0, { agent: 'codex' })];
assert.equal(pickConfig(cfgs, 'claude', now).id, '');                                   // official first
assert.equal(pickConfig(cfgs, 'claude', now, 'b').id, 'b');                             // explicit
assert.equal(pickConfig(cfgs, 'claude', now, 'x').id, '');                              // explicit but disabled
const lim = [off({ limited_until: now + 1000 }), mk('b', 2), mk('a', 1), mk('x', 0, { enabled: 0 })];
assert.equal(pickConfig(lim, 'claude', now).id, 'a');                                   // priority, skips disabled
assert.equal(pickConfig([off({ limited_until: now + 1 }), mk('a', 1, { limited_until: now + 1 }), mk('b', 2)], 'claude', now).id, 'b');
assert.equal(pickConfig([off({ limited_until: now + 1 }), mk('a', 1, { limited_until: now + 1 })], 'claude', now), null);   // all limited
assert.equal(pickConfig([off({ limited_until: now - 1 })], 'claude', now).id, '');       // limit over

/* configEnv */
const api = { kind: 'api', base_url: 'http://h/v1', api_key: 'k', model: 'm' };
assert.deepEqual(configEnv(api, 'claude'), { LLM_BASE_URL: 'http://h/v1', OPENAI_BASE_URL: 'http://h/v1', ANTHROPIC_BASE_URL: 'http://h/v1', LLM_API_KEY: 'k', OPENAI_API_KEY: 'k', ANTHROPIC_AUTH_TOKEN: 'k', LLM_MODEL: 'm', OPENAI_MODEL: 'm', ANTHROPIC_MODEL: 'm' });
assert.deepEqual(configEnv({ kind: 'account', config_dir: 'C:/c2' }, 'claude'), { CLAUDE_CONFIG_DIR: 'C:/c2' });
assert.deepEqual(configEnv({ kind: 'account', config_dir: 'C:/x' }, 'codex'), { CODEX_HOME: 'C:/x' });
assert.throws(() => configEnv({ kind: 'account', config_dir: 'd' }, 'gemini'), /cannot use account/);
assert.throws(() => validateConfig({ agent: 'gemini', name: 'w', kind: 'account', config_dir: 'd' }), /cannot use account/);

/* sharesConversation */
assert.ok(sharesConversation(off(), mk('a', 1)));
assert.ok(sharesConversation(mk('a', 1), mk('b', 2)));
assert.ok(!sharesConversation(off(), { id: 'c', kind: 'account', config_dir: 'd' }));
assert.ok(!sharesConversation({ id: 'c', kind: 'account', config_dir: 'd' }, mk('a', 1)));

/* db: create, session env, never serialising the key */
const c = db.addAgentConfig({ agent: 'claude', name: 'work', kind: 'api', base_url: 'http://h', api_key: 'sekret', model: 'm' });
assert.throws(() => db.addAgentConfig({ agent: 'claude', name: 'work', kind: 'api', base_url: 'http://h' }), /already has/);
assert.ok(!('api_key' in publicConfig(c)) && publicConfig(c).has_key === true && !JSON.stringify(publicConfig(c)).includes('sekret'));
db.updateAgentConfig(c.id, { api_key: '' });                                              // empty key keeps the old one
assert.equal(db.getAgentConfig(c.id).api_key, 'sekret');
const s = db.createSession({ title: 't', cwd: '.', agent: 'claude', config: 'work' });
assert.equal(s.config_id, c.id);
assert.equal(db.sessionEnv(s).ANTHROPIC_AUTH_TOKEN, 'sekret');
assert.deepEqual(db.sessionEnv({ agent: 'claude', config_id: '' }), {});                  // no config: today's behaviour
db.setConfigLimit('claude', '', Date.now() + 60000);                                      // official limited: new sessions start on the next config
assert.equal(db.createSession({ title: 't', cwd: '.', agent: 'claude' }).config_id, c.id);
assert.throws(() => db.resolveConfigId('claude', 'nope'), /no config/);
console.log('accounts.check ok');
