// Tells the hub what a session's agent is doing. Usage: node report.mjs working|waiting|idle
// Run by an agent's own hooks; the session and hub come from the env XBLabs starts it with.
const { XBLABS_SESSION: id, XBLABS_HUB: hub } = process.env;
if (id && hub && process.argv[2]) {
  await fetch(`${hub}/api/sessions/${id}/status`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ state: process.argv[2] }), signal: AbortSignal.timeout(3000),
  }).catch(() => {});   // a hub that is down must never fail the agent's turn
}
