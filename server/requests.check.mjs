// node server/requests.check.mjs: request numbers and tokens survive deleting a session.
import assert from 'node:assert/strict';
process.env.XBLABS_DB = ':memory:';
const db = await import('./db.mjs');

const s = db.createSession({ title: 't', cwd: '.', agent: 'hermes' });
db.addEvent(s.id, 1, 'user', { text: 'hi' });
db.addEvent(s.id, 1, 'done', { tokens: { input: 100, output: 7, cache_read: 60, context: null } });
db.addEvent(s.id, 2, 'user', { text: 'again' });
db.addEvent(s.id, 2, 'done', { tokens: { input: 10, output: 3, cache_read: 40, context: 50 } });   // omp-style: input without cache

let st = db.sessionStats()[s.id];
assert.equal(st.msgs, 2);
assert.equal(st.tin, 100 + 10 + 40);
assert.equal(st.tout, 10);
assert.equal(st.ctx, 50);

const before = db.requestSummary(0);
assert.equal(before.n, 2);
db.deleteSession(s.id);
const after = db.requestSummary(0);
assert.equal(after.n, 2, 'rows stay after the session is gone');
assert.equal(after.lastNo, before.lastNo);
assert.equal(db.listEvents(s.id, 0).length, 0, 'the log itself is gone');

const s2 = db.createSession({ title: 'u', cwd: '.', agent: 'omp' });
db.addEvent(s2.id, 1, 'user', { text: 'x' });
assert.equal(db.requestSummary(0).lastNo, before.lastNo + 1, 'numbers never go back');
console.log('requests.check ok');
