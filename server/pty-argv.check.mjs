// Run: node server/pty-argv.check.mjs — how a job run's agent command is built per platform.
import assert from 'node:assert/strict';
import { jobArgv, shellArgs } from './pty.mjs';

const row = { kind: 'job', agent: 'claude', prompt: ' run the "smoke" suite\nand report ' };
assert.deepEqual(jobArgv(row), ['claude', '-p', 'run the "smoke" suite\nand report']);
assert.equal(jobArgv({ ...row, agent: 'shell' }), null);          // a shell job stays interactive
assert.equal(jobArgv({ ...row, kind: 'chat' }), null);            // chats never launch anything
assert.equal(jobArgv({ ...row, prompt: '  ' }), null);            // no task, no agent

// cmd.exe: /s strips the outer quotes; inner quotes become ' and newlines become spaces.
assert.equal(shellArgs(jobArgv(row), true), `/d /s /c "claude "-p" "run the 'smoke' suite and report""`);
// posix: every word single-quoted, embedded ' closed and escaped.
assert.deepEqual(shellArgs(['codex', 'exec', "it's"], false), ['-lc', String.raw`'codex' 'exec' 'it'\''s'`]);
assert.deepEqual(shellArgs(null, true), []);
// setup runs first and gates the agent; with no agent the shell stays open after it.
assert.equal(shellArgs(['omp'], true, 'npm ci'), '/d /s /c "npm ci && omp"');
assert.equal(shellArgs(null, true, 'npm ci'), '/d /s /k "npm ci"');
assert.deepEqual(shellArgs(['omp'], false, 'npm ci'), ['-lc', "npm ci && 'omp'"]);
console.log('pty argv ok');
