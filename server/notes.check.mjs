// Run: node server/notes.check.mjs — notes are .txt files in their own folder, both ways.
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'xbl-notes-'));
process.env.XBLABS_DB = join(dir, 'xblabs.db');
const db = await import('./db.mjs');
const N = join(dir, 'Notes');
try {
  const a = db.createNote({ title: 'Deploy: checklist?', body: 'one' });
  assert.equal(a.file, 'Deploy- checklist-.txt');                       // unsafe characters replaced
  assert.equal(readFileSync(join(N, a.file), 'utf8'), 'one');

  const b = db.updateNote(a.id, { title: 'Deploy', body: 'two' });       // rename follows the title
  assert.equal(b.file, 'Deploy.txt');
  assert.ok(!existsSync(join(N, a.file)));
  assert.equal(readFileSync(join(N, 'Deploy.txt'), 'utf8'), 'two');

  const c = db.createNote({ title: 'deploy' });                          // same name on a case-blind disk
  assert.match(c.file, /^deploy \(\w+\)\.txt$/);

  writeFileSync(join(N, 'Deploy.txt'), 'edited outside');                // edit made in another editor
  utimesSync(join(N, 'Deploy.txt'), new Date(), new Date(Date.now() + 5000));
  writeFileSync(join(N, 'Dropped in.txt'), 'hello');                     // file added to the folder
  const list = db.listNotes();
  assert.equal(list.find((n) => n.id === a.id).body, 'edited outside');
  assert.equal(list.find((n) => n.title === 'Dropped in')?.body, 'hello');

  db.deleteNote(a.id);
  assert.ok(!existsSync(join(N, 'Deploy.txt')));
  console.log('notes files ok');
} finally {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* sqlite still holds the file on Windows; the OS temp cleanup takes it */ }
}
