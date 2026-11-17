/* Pipeline: stages run one after another on one branch (the first stage's worktree). Each stage is
   its own chat session, any agent with a JSON mode; the next starts when the previous turn ends
   cleanly, with the task and that stage's last answer. A failed or stopped turn stops the pipeline.
   ponytail: hub-local only, one model per agent (its default); remote stages need chat-prepare on a shared worktree. */
import * as db from './db.mjs';

export const STAGE_MAX = 6;
const KEY = 'pipelines';
const all = () => { try { return JSON.parse(db.getSetting(KEY, '{}')) || {}; } catch { return {}; } };
const save = (p) => db.setSetting(KEY, JSON.stringify(p));

/* Stages from the client: [{ name, agent, prompt }]. Throws the reason a list is refused. */
export function clean(stages, canRun) {
  if (!Array.isArray(stages) || stages.length < 2 || stages.length > STAGE_MAX) throw new Error(`a pipeline has 2 to ${STAGE_MAX} stages`);
  return stages.map((s, i) => {
    const agent = String(s?.agent || ''), name = String(s?.name || '').trim().slice(0, 40) || `Stage ${i + 1}`;
    if (!canRun(agent)) throw new Error(`${name}: ${agent || 'no agent'} cannot run a pipeline stage (needs a chat mode on this hub)`);
    return { name, agent, prompt: String(s?.prompt || '').trim().slice(0, 4000) };
  });
}

/* What one stage is told: the task, its own job, and what the stage before it said. */
export function stagePrompt(stages, i, task, before = '') {
  const s = stages[i];
  return [
    `Task: ${task}`,
    `You are stage ${i + 1} of ${stages.length} (${s.name}) of a pipeline; every stage works on this same branch.${s.prompt ? `\n${s.prompt}` : ''}`,
    before ? `Stage ${i} (${stages[i - 1].name}, ${stages[i - 1].agent}) ended with:\n${before}` : '',
  ].filter(Boolean).join('\n\n');
}

export function begin(firstId, stages, task) {
  const p = all();
  p[firstId] = { stages, task, step: 0, at: firstId, ids: [firstId], state: 'running' };
  save(p);
}
export const get = (id) => Object.entries(all()).map(([first, v]) => ({ first, ...v })).find((v) => v.ids.includes(id)) || null;

/* The agent's own text in the session's latest turn. */
function lastTurnOf(id) {
  /* All its answers, not only the last turn's: a turn that stopped for approval leaves the real
     report in the turn before the approved one. */
  const all = db.listEvents(id, 0), t = db.lastTurn(id), ev = all.filter((e) => e.turn === t);
  return {
    text: all.filter((e) => e.kind === 'text').map((e) => e.data.text).join('\n').trim().slice(-12000),
    failed: ev.some((e) => e.kind === 'error' || (e.kind === 'done' && e.data.error)),
  };
}

/* A turn ended. If it was a pipeline's current stage, start the next (start(row, prompt) makes
   and runs the session, returning its id) or close the pipeline. Later turns of a stage do nothing. */
export async function onTurn(id, code, start) {
  const p = all(), first = Object.keys(p).find((k) => p[k].at === id && p[k].state === 'running');
  if (!first) return null;
  const pl = p[first], last = lastTurnOf(id);
  if (code !== 0 || last.failed) { pl.state = 'failed'; save(p); return { state: 'failed', stage: pl.stages[pl.step].name }; }
  if (++pl.step >= pl.stages.length) { pl.state = 'done'; save(p); return { state: 'done' }; }
  const prev = db.getSession(id), s = pl.stages[pl.step];
  pl.at = null; save(p);   // taken before the await: a second turn event cannot start it twice
  try {
    const next = await start({ ...prev, agent: s.agent, name: s.name, step: pl.step, total: pl.stages.length }, stagePrompt(pl.stages, pl.step, pl.task, last.text || '(no text answer)'));
    const q = all(); Object.assign(q[first], { step: pl.step, at: next, ids: [...pl.ids, next] }); save(q);
    return { state: 'next', id: next };
  } catch (err) {
    const q = all(); Object.assign(q[first], { step: pl.step, state: 'failed' }); save(q);
    return { state: 'failed', stage: s.name, error: String(err.message || err) };
  }
}
