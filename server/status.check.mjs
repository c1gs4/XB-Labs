// Run: node server/status.check.mjs — retry / provider-error lines read from agent output, and how
// one turn's status card merges them (countdowns update in place, cut-short lines fold in).
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.XBLABS_DB = join(mkdtempSync(join(tmpdir(), 'xb-status-')), 'test.db');
const { statusLines } = await import('./pty.mjs');
const { mergeStatus } = await import('./chat.mjs');

const screen = [
  '⠋ Provider temporarily unavailable — retrying automatically in 72s (cycle 4/5); press Esc to stop',
  '▲ Attempt 1/3 failed: HTTP 500: database or disk is full',
  '⠋ waiting on provider — retrying in 3s (attempt 1/3) · 30s ─────────────',
  'Provider temporarily unavailable — retrying automatically in 35s (c...',
  'Automatic recovery gave up after 5 cycles — the provider is still unavailable.',
  'plain answer text',
].join('\n');
const got = statusLines(screen);
assert.equal(got.length, 5);
assert.equal(got[2], 'waiting on provider — retrying in 3s (attempt 1/3)', 'status bar timer and rule stripped');

const card = [];
assert.ok(mergeStatus(card, got));
assert.deepEqual(card, [
  'Provider temporarily unavailable — retrying automatically in 72s (cycle 4/5); press Esc to stop',
  'Attempt 1/3 failed: HTTP 500: database or disk is full',
  'waiting on provider — retrying in 3s (attempt 1/3)',
  'Automatic recovery gave up after 5 cycles — the provider is still unavailable.',
], 'the cut-short copy folds into the full line');
assert.ok(mergeStatus(card, ['Provider temporarily unavailable — retrying automatically in 70s (cycle 5/5); press Esc to stop']));
assert.match(card[0], /cycle 5\/5/, 'a countdown updates its line');
assert.equal(card.length, 4);
assert.equal(mergeStatus(card, ['Provider temporarily unavailable — retrying automatically in 9s (c...']), false, 'a shorter cut copy changes nothing');
console.log('status.check ok — retry lines read, countdowns update in place, cut lines fold in');
process.exit(0);
