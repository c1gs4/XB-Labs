/* Pure decisions for hibernate and the agent limit; index.mjs does the killing and the waking. */

/* Live sessions the idle timer may hibernate: idle (not running, not asking), has a process,
   quiet for afterMin minutes, not the GOA head, no turn in flight. afterMin 0 = never. */
export function idleToHibernate(rows, { now, afterMin, headId = null, live, busy = new Set(), quiet = () => 0 }) {
  if (!(afterMin > 0)) return [];
  const ms = afterMin * 60000;
  /* An agent without status hooks stays 'running' for good; its terminal going quiet is the idle sign.
     ponytail: a command silent for afterMin would count as idle too; agents print while they work. */
  const idleEnough = (s) => (s.status === 'idle' ? now - s.updated_at >= ms : s.status === 'running' && s.kind === 'chat' && quiet(s.id) >= ms);
  return rows.filter((s) => live.has(s.id) && !busy.has(s.id) && s.id !== headId && idleEnough(s)).map((s) => s.id);
}

/* Error text when one more agent process would pass maxAgents (0 = no limit), else ''. */
export const limitError = (max, liveCount) => (max > 0 && liveCount >= max
  ? `agent limit reached: ${liveCount} of ${max} running; hibernate or stop a session first` : '');
