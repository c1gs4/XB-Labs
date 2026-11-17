// Run: node server/agents.check.mjs — a binary on PATH is found, a missing one is not, and
// every registry entry builds a one-shot command that carries the prompt.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AGENTS, findBin, detect, hookFlags, applySettings } from './agents.mjs';
import { existsSync, readFileSync } from 'node:fs';
/* A throwaway database: pty.mjs opens db.mjs, and this check writes settings. */
process.env.XBLABS_DB = ':memory:';
const { jobArgv, chatArgv } = await import('./pty.mjs');

const dir = mkdtempSync(join(tmpdir(), 'xbag-'));
try {
  const WIN = process.platform === 'win32';
  writeFileSync(join(dir, WIN ? 'fakeagent.cmd' : 'fakeagent'), '');
  writeFileSync(join(dir, 'bashonly'), '');                                   // no extension
  const env = { PATH: dir, PATHEXT: '.EXE;.CMD' };
  assert.equal(findBin('fakeagent', env), join(dir, WIN ? 'fakeagent.cmd' : 'fakeagent'));
  assert.equal(findBin('nope', env), null);
  if (WIN) assert.equal(findBin('bashonly', env), null);                      // cmd cannot start it

  for (const [id, a] of Object.entries(AGENTS)) {
    const argv = jobArgv({ kind: 'job', agent: id, prompt: ' do it ' });
    assert.equal(argv[0], a.bin, id);
    assert.ok(argv.includes('do it') || a.typePrompt, id);   // typePrompt agents get it typed in
  }
  assert.equal(jobArgv({ kind: 'job', agent: 'shell', prompt: 'x' }), null);
  assert.equal(jobArgv({ kind: 'job', agent: 'constructor', prompt: 'x' }), null);   // not a registry key
  assert.equal(jobArgv({ kind: 'chat', agent: 'claude', prompt: 'x' }), null);

  /* Chat: the interactive agent, on the prompt the first time, on its last conversation after. */
  assert.deepEqual(chatArgv({ kind: 'chat', agent: 'claude', prompt: 'fix it' }), ['claude', 'fix it']);
  assert.deepEqual(chatArgv({ kind: 'chat', agent: 'hermes', prompt: '' }), ['hermes', 'chat']);
  assert.deepEqual(chatArgv({ kind: 'chat', agent: 'omp', prompt: 'fix it' }, true), ['omp', '--continue']);
  assert.deepEqual(chatArgv({ kind: 'chat', agent: 'gemini', prompt: 'fix it' }, true), ['gemini']);   // no resume flag: new, prompt not repeated
  assert.equal(chatArgv({ kind: 'chat', agent: 'shell', prompt: 'x' }), null);
  assert.equal(chatArgv({ kind: 'job', agent: 'claude', prompt: 'x' }), null);

  /* Status hooks are per-run flags pointing at files that exist; agents without one get none. */
  const [flag, file] = hookFlags('omp');
  assert.equal(flag, '--hook'); assert.ok(existsSync(file), file);
  const settings = JSON.parse(readFileSync(hookFlags('claude')[1], 'utf8'));
  assert.match(settings.hooks.Stop[0].hooks[0].command, /report\.mjs" idle$/);
  assert.deepEqual(hookFlags('hermes'), []);
  assert.deepEqual(hookFlags('constructor'), []);

  const here = await detect();
  for (const a of here) assert.ok(AGENTS[a.id] && a.path, a.id);
  console.log('agents.check ok ·', here.map((a) => `${a.id} ${a.version || '?'}`).join(', ') || 'none installed');
} finally {
  rmSync(dir, { recursive: true, force: true });
}

/* Endpoint env is opt-in per agent: nothing unless the agent is switched on. */
const db = await import('./db.mjs');
db.setSetting('llm.base_url', 'http://x/v1');
assert.deepEqual(db.llmEnv('claude'), {});
assert.ok(db.llmEnv().OPENAI_BASE_URL);                 // no agent given: the full set, for Settings
db.setLlmAgents(['omp', 'omp']);
assert.deepEqual(db.llmAgents(), ['omp']);
assert.equal(db.llmEnv('omp').OPENAI_BASE_URL, 'http://x/v1');
assert.deepEqual(db.llmEnv('shell'), {});
db.setLlmAgents(['omp', 'hermes']);
assert.equal(db.sessionEnv({ agent: 'hermes' }).CUSTOM_BASE_URL, 'http://x/v1');
assert.equal(db.sessionEnv({ agent: 'omp' }).CUSTOM_BASE_URL, undefined);
console.log('llm opt-in ok');

/* Bubble chat: each agent's JSON lines become the same events (lines as the agents printed them here). */
const { AGENTS: A } = await import('./agents.mjs');
assert.deepEqual(A.hermes.json.parse({ type: 'tool_use', name: 'search_files', tool_call_id: 'c1', input: { pattern: '*' } }), [{ kind: 'tool', id: 'c1', name: 'search_files', input: { pattern: '*' } }]);
assert.deepEqual(A.hermes.json.parse({ type: 'text', text: 'Folder has' }), [{ kind: 'text', delta: 'Folder has' }]);
assert.equal(A.hermes.json.parse({ type: 'result', exit_code: 0, duration_ms: 5 })[0].kind, 'done');
assert.deepEqual(A.hermes.json.argv('hi', { sid: 's1' }).slice(-3), ['--continue', 'xblabs-s1', '--create-if-missing']);
assert.deepEqual(A.omp.json.parse({ type: 'session', id: 'u1' }), [{ kind: 'resume', id: 'u1' }]);
assert.deepEqual(A.omp.json.parse({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Fo' } }), [{ kind: 'text', delta: 'Fo' }]);
assert.deepEqual(A.omp.json.parse({ type: 'tool_execution_end', toolCallId: 't', result: { content: [{ type: 'text', text: 'a.txt' }] } }), [{ kind: 'tool_result', id: 't', output: 'a.txt', error: false }]);
assert.deepEqual(A.omp.json.argv('hi', { resume: 'u1' }), ['omp', '-p', 'hi', '--mode', 'json', '--resume', 'u1']);
assert.ok(A.claude.json.stdin && !A.claude.json.argv('secret', {}).includes('secret'));   // prompt never on the command line
/* A subagent's steps keep the Task call that started them; its own text stays out of the chat. */
assert.deepEqual(A.claude.json.parse({ type: 'assistant', parent_tool_use_id: 'T1', message: { content: [{ type: 'text', text: 'inner' }, { type: 'tool_use', id: 'u2', name: 'Bash', input: {} }] } }), [{ kind: 'tool', id: 'u2', name: 'Bash', input: {}, parent: 'T1' }]);
assert.equal(A.claude.json.parse({ type: 'assistant', message: { content: [{ type: 'text', text: 'top' }] } })[0].delta, 'top');
console.log('bubble parsers ok');

/* Approval: the block texts hermes and omp print here are recognised; ordinary errors are not. */
const { NEEDS_APPROVAL } = await import('./agents.mjs');
assert.ok(NEEDS_APPROVAL.test('BLOCKED: Command flagged as dangerous (recursive delete) but single-query mode'));
assert.ok(NEEDS_APPROVAL.test('Tool "bash" requires approval but no interactive UI available.'));
assert.ok(!NEEDS_APPROVAL.test('ls: cannot access sub: No such file or directory'));
assert.deepEqual(A.hermes.json.approveArgv('go', { sid: 's1' }), ['hermes', '-z', 'go', '--continue', 'xblabs-s1']);
console.log('approval ok');
{
  /* Hermes selects custom via CLI; endpoint/key stay in the child environment. */
  const { applySettings } = await import('./agents.mjs');
  const env = { LLM_BASE_URL: 'http://gw.example/v1', LLM_MODEL: 'm1', LLM_API_KEY: 'k' };
  const h = applySettings(['hermes', 'chat'], 'hermes', {}, env);
  assert.deepEqual(h.slice(2), ['--provider', 'custom', '-m', 'm1']);
  assert.ok(!h.includes('--base-url') && !h.includes(env.LLM_BASE_URL));
  assert.ok(!h.includes('k'));
  assert.deepEqual(applySettings(['hermes', 'chat'], 'hermes', {}, {}), ['hermes', 'chat']);
  assert.deepEqual(applySettings(['claude'], 'claude', {}, env), ['claude']);   // claude reads ANTHROPIC_* itself
  console.log('endpoint flags ok');
}
{
  const { AGENTS, splitCommand, registerCustom } = await import('./agents.mjs');
  assert.ok(Object.keys(AGENTS).length >= 45, `registry has ${Object.keys(AGENTS).length}`);
  for (const [id, a] of Object.entries(AGENTS)) {
    assert.ok(a.name && a.bin && typeof a.chat === 'function', id);
    assert.ok(Array.isArray(a.chat('do x')) && a.chat('do x').length, id);
    if (a.run) assert.ok(a.run('do x').includes('do x'), `${id} run carries the prompt`);
    if (!a.run && !a.chat('do x').includes('do x')) assert.ok(a.typePrompt, `${id}: prompt reaches it somehow`);
  }
  assert.deepEqual(splitCommand(`my-cli --name "two words" ''`), ['my-cli', '--name', 'two words', '']);
  registerCustom({ mine: { name: 'Mine', command: 'mycli --fast' }, claude: { name: 'x', command: 'evil' } });
  assert.deepEqual(AGENTS.mine.chat('p'), ['mycli', '--fast']);
  assert.ok(AGENTS.mine.typePrompt && AGENTS.claude.bin === 'claude');   // a custom one never replaces a built-in
  registerCustom({});
  assert.ok(!AGENTS.mine);
  console.log('registry ok ·', Object.keys(AGENTS).length, 'agents');
}
/* Hermes freezes provider/model per thread: a resume must not name them again (the hub default may have moved). */
{
  const env = { LLM_BASE_URL: 'http://gw/v1', LLM_MODEL: 'new-model' };
  const tui = AGENTS.hermes.json.tui({ sid: 's' });
  assert.deepEqual(applySettings(tui, 'hermes', {}, env).slice(-4), ['--provider', 'custom', '-m', 'new-model']);
  assert.ok(!applySettings(tui, 'hermes', {}, env, { resume: true }).includes('--provider'));
  assert.ok(applySettings(['omp'], 'omp', {}, env, { resume: true }).length >= 1);
  console.log('hermes resume ok · no endpoint flags on an existing thread');
}
