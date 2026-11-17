// Run: node server/omp-hook.check.mjs — no model or network calls.
import assert from 'node:assert/strict';
import hook from './hooks/omp.mjs';

const keys = ['LLM_BASE_URL', 'LLM_MODEL', 'XBLABS_SESSION', 'XBLABS_HUB'];
const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
const originalFetch = globalThis.fetch;
const providers = [];
const handlers = new Map();
const requests = [];
const pi = {
  registerProvider: (...args) => providers.push(args),
  on: (event, handler) => handlers.set(event, handler),
};
const reset = (baseUrl, model) => {
  for (const key of keys) delete process.env[key];
  if (baseUrl !== undefined) process.env.LLM_BASE_URL = baseUrl;
  if (model !== undefined) process.env.LLM_MODEL = model;
  providers.length = 0;
  handlers.clear();
};

try {
  globalThis.fetch = (...args) => { requests.push(args); return Promise.resolve(); };
  reset();
  hook(pi);
  assert.equal(providers.length, 0);
  assert.deepEqual([...handlers.keys()], ['session_start', 'agent_start', 'agent_end']);
  for (const handler of handlers.values()) handler();
  assert.equal(requests.length, 0);

  for (const baseUrl of ['http://localhost:1234/v1', 'https://gateway.example.test/v1']) {
    reset(baseUrl, 'vendor/raw-model');
    hook(pi);
    assert.deepEqual(providers, [['xblabs', {
      baseUrl, apiKey: 'LLM_API_KEY', api: 'openai-completions',
      models: [{
        id: 'vendor/raw-model', name: 'vendor/raw-model', reasoning: false, input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000, maxTokens: 8192,
      }],
    }]]);
  }

  process.env.XBLABS_SESSION = 'test-session';
  process.env.XBLABS_HUB = 'http://hub.example.test';
  for (const handler of handlers.values()) handler();
  assert.deepEqual(requests, ['idle', 'working', 'idle'].map(state => [
    'http://hub.example.test/api/sessions/test-session/status',
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ state }) },
  ]));
  globalThis.fetch = () => Promise.reject(new Error('offline'));
  handlers.get('agent_end')();
  await new Promise(resolve => setImmediate(resolve));

  for (const [baseUrl, model, message] of [
    ['', 'model', /LLM_BASE_URL/],
    ['not-a-url', 'model', /LLM_BASE_URL/],
    ['ftp://example.test', 'model', /LLM_BASE_URL/],
    ['https://example.test', undefined, /LLM_MODEL/],
    ['https://example.test', '', /LLM_MODEL/],
    ['https://example.test', ' \t ', /LLM_MODEL/],
  ]) {
    reset(baseUrl, model);
    assert.throws(() => hook(pi), message);
    assert.equal(providers.length, 0);
    assert.equal(handlers.size, 0);
  }
} finally {
  globalThis.fetch = originalFetch;
  for (const key of keys) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
}
console.log('omp hook checks passed');