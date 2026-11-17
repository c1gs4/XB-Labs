/* Team mode: one lead session plans a task board, the hub starts a teammate session per task
   (a child of the lead, in the lead's worktree, any agent with a JSON mode), they run side by side,
   and when every task has an answer the lead gets the results to review and integrate.
   Teammates stay ordinary sessions afterwards: open one to continue it.
   States: planning → working → review → done (failed: the lead's plan never came, or it failed).
   ponytail: hub-local, one shared worktree (teammates are told to keep to their own files); no
   messages between teammates yet, the lead is the only one who sees all results. */
import * as db from './db.mjs';

export const TASK_MAX = 6;
const KEY = 'teams';
const all = () => { try { return JSON.parse(db.getSetting(KEY, '{}')) || {}; } catch { return {}; } };
const save = (t) => db.setSetting(KEY, JSON.stringify(t));
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24);

/* What the lead is told first: the goal, and the one format the hub reads its plan from. */
export function planPrompt(goal, max = TASK_MAX) {
  return [
    `Goal: ${goal}`,
    `You lead a team. Split the goal into 2 to ${max} independent tasks that can run at the same time, each for one teammate. Do not do the tasks yourself yet.`,
    'Teammates share this folder: give each task its own files so they do not edit the same file.',
    'End your answer with exactly one fenced block in this format and nothing after it:',
    '```team-tasks\n[{"title": "short task title", "owner": "short-role-name", "brief": "what to do, which files, how to check it"}]\n```',
  ].join('\n\n');
}

/* The lead's plan from its answer: the last ```team-tasks block. Throws the reason it is refused. */
export function parsePlan(text, max = TASK_MAX) {
  const blocks = [...String(text || '').matchAll(/```team-tasks\s*\n([\s\S]*?)```/g)];
  if (!blocks.length) throw new Error('the lead gave no team-tasks block');
  let list;
  try { list = JSON.parse(blocks[blocks.length - 1][1]); } catch { throw new Error('the team-tasks block is not valid JSON'); }
  if (!Array.isArray(list) || !list.length) throw new Error('the team-tasks block has no tasks');
  const seen = new Set();
  return list.slice(0, max).map((t, i) => {
    const title = String(t?.title || '').trim().slice(0, 120);
    if (!title) throw new Error(`task ${i + 1} has no title`);
    let owner = slug(t?.owner) || `mate-${i + 1}`;
    while (seen.has(owner)) owner = `${owner}-${i + 1}`;
    seen.add(owner);
    return { id: `T${i + 1}`, title, owner, brief: String(t?.brief || '').trim().slice(0, 4000), status: 'todo', session: null, result: '' };
  });
}

/* What one teammate is told. */
export function taskPrompt(goal, task, tasks) {
  const others = tasks.filter((t) => t.id !== task.id).map((t) => `${t.id} ${t.title} (${t.owner})`).join('; ');
  return [
    `Team goal: ${goal}`,
    `You are teammate "${task.owner}". Your task: ${task.id} — ${task.title}`,
    task.brief,
    others ? `Others work on: ${others}. Do not edit their files.` : '',
    'Do your task only, check it works, then end with a short report of what you changed and how you checked it.',
  ].filter(Boolean).join('\n\n');
}

/* What the lead gets once every task has an answer. */
export function reviewPrompt(team) {
  return [
    `Your team finished. Goal: ${team.goal}`,
    ...team.tasks.map((t) => `## ${t.id} — ${t.title} (${t.owner}, ${t.status})\n${t.result || '(no answer)'}`),
    'Review the results together: check the pieces fit, fix what does not, run the checks, and report the outcome.',
  ].join('\n\n');
}

export function begin(leadId, { goal, agent }) {
  const t = all();
  t[leadId] = { goal, agent, state: 'planning', tasks: [], error: '' };
  save(t);
}
/* The team a session belongs to (as its lead or a teammate), with the lead's id. */
export function get(id) {
  const t = all();
  if (t[id]) return { lead: id, ...t[id] };
  const lead = Object.keys(t).find((k) => t[k].tasks.some((x) => x.session === id));
  return lead ? { lead, ...t[lead] } : null;
}

/* Every session in a team: id -> { role: 'lead' | 'mate', lead }. Teammates work in the background:
   the sidebar shows the lead, the lead's graph and board reach each teammate. */
export function roles() {
  const t = all(), out = new Map();
  for (const [lead, v] of Object.entries(t)) {
    out.set(lead, { role: 'lead', lead, mates: v.tasks.filter((x) => x.session).length, state: v.state });
    for (const x of v.tasks) if (x.session) out.set(x.session, { role: 'mate', lead });
  }
  return out;
}
/* The agent's own text in the session's latest turn, and whether that turn failed. */
function lastTurnOf(id) {
  /* All its answers, not only the last turn's: a turn that stopped for approval leaves the real
     report (or the lead's plan) in the turn before the approved one. */
  const all = db.listEvents(id, 0), n = db.lastTurn(id), ev = all.filter((e) => e.turn === n);
  return {
    text: all.filter((e) => e.kind === 'text').map((e) => e.data.text).join('\n').trim(),
    failed: ev.some((e) => e.kind === 'error' || (e.kind === 'done' && e.data.error)),
  };
}

/* A turn ended. start(lead, task, prompt) makes and runs a teammate session, returning its id;
   send(id, text) sends the lead a message. Returns what happened, or null when it was no team's turn. */
export async function onTurn(id, code, { start, send }) {
  const t = all();
  /* The lead's planning turn: read the board and start a teammate per task. */
  if (t[id] && t[id].state === 'planning') {
    const team = t[id], last = lastTurnOf(id);
    if (code !== 0 || last.failed) { team.state = 'failed'; team.error = 'the lead\'s planning turn failed'; save(t); return { state: 'failed', error: team.error }; }
    try { team.tasks = parsePlan(last.text); } catch (err) { team.state = 'failed'; team.error = err.message; save(t); return { state: 'failed', error: err.message }; }
    team.state = 'working'; save(t);   // before the awaits: a second turn event cannot plan twice
    const lead = db.getSession(id);
    for (const task of team.tasks) {
      try {
        const sid = await start(lead, task, taskPrompt(team.goal, task, team.tasks));
        const q = all(), x = q[id].tasks.find((y) => y.id === task.id);
        Object.assign(x, { session: sid, status: 'running' }); save(q);
      } catch (err) {
        const q = all(), x = q[id].tasks.find((y) => y.id === task.id);
        Object.assign(x, { status: 'failed', result: `not started: ${err.message}` }); save(q);
      }
    }
    return { state: 'working', tasks: team.tasks.length };
  }
  /* The lead's review turn ends the team's run. */
  if (t[id] && t[id].state === 'review') { t[id].state = 'done'; save(t); return { state: 'done' }; }
  /* A teammate's first answer settles its task; later turns of it are its own conversation. */
  const lead = Object.keys(t).find((k) => t[k].state === 'working' && t[k].tasks.some((x) => x.session === id && x.status === 'running'));
  if (!lead) return null;
  const team = t[lead], task = team.tasks.find((x) => x.session === id), last = lastTurnOf(id);
  Object.assign(task, { status: code !== 0 || last.failed ? 'failed' : 'done', result: (last.text || '').slice(-6000) });
  const open = team.tasks.some((x) => x.status === 'running' || x.status === 'todo');
  if (!open) team.state = 'review';
  save(t);
  if (!open) await send(lead, reviewPrompt(team), { from: 'team' });
  return { state: open ? 'task' : 'review', task: task.id, status: task.status };
}
