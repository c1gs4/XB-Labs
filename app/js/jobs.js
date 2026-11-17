/* Jobs board — the real control plane: one job fans out to N runs (device × agent), each with its
   own PTY on the server. Columns are run status, so approval shows up where the work is. */

state.jobs = [];
state.jobsErr = null;
state.jobsWaiting = 0;

const JOB_COLS = [
  ['queued', 'Queued', '#6fe0cd'],
  ['running', 'Running', '#5b7cff'],
  ['waiting', 'Waiting approval', '#f6c28b'],
  ['done', 'Done', '#3fb67a'],
];
const colOf = (st) => (st === 'starting' || st === 'queued' ? 'queued'
  : st === 'waiting' || st === 'needs_input' ? 'waiting'
  : st === 'running' ? 'running' : 'done');

const api = async (path, opts = {}) => {
  const res = await fetch(path, { headers: { 'content-type': 'application/json' }, ...opts });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
  return res.json();
};

async function loadJobs({ quiet = false } = {}) {
  try {
    const [jobs, goa] = await Promise.all([api('/api/jobs'), api('/api/goa').catch(() => null)]);
    /* GOA mode shows GOA's tasks only; outside it, only my own jobs. */
    state.jobs = prefs.goaMode ? [] : jobs;
    if (goa) state.goa = goa;
    state.jobsErr = null;
    state.jobsWaiting = prefs.goaMode ? ((goa && goa.tasks) || []).filter((t) => t.status === 'waiting').length
      : jobs.reduce((n, j) => n + j.runs.filter((r) => colOf(r.status) === 'waiting').length, 0);
  } catch (err) {
    state.jobsErr = String(err.message || err);
    if (!quiet) state.jobs = [];
  }
  if (state.page === 'jobs') {
    renderSidebar();
    const cur = $('#main .content');
    if (cur) morph(cur, viewJobs()); else $('#main').innerHTML = `<div class="content">${viewJobs()}</div>`;
  } else if (quiet) renderSidebar();
}

/* Poll only while the board is on screen and the window is focused. */
setInterval(() => {
  if (state.page === 'jobs' && !document.hidden) loadJobs({ quiet: true });
}, 3000);

/* A GOA task is a job the head gave a worker: it sits in the column of its state. Waiting on
   the head to check it (turn-ended, reported) still counts as running. */
const goaCol = (st) => (st === 'queued' ? 'queued' : st === 'waiting' ? 'waiting' : ['done', 'failed', 'stopped'].includes(st) ? 'done' : 'running');
function goaCard(t, color) {
  const w = t.session_id && window.LIVE && LIVE.runs.get(t.session_id);
  return `
        <article class="bcard jcard" data-goatask="${esc(t.id)}">
          <div class="bcard-top">
            <span class="sid num">${esc(t.id)}</span>
            <span class="badge"><i style="background:${color}"></i>GOA → ${esc(t.agent)}</span>
          </div>
          <h4>${esc(t.prompt.slice(0, 90))}</h4>
          <div class="bcard-chips">
            <span class="wschip">${ic('desktop')}${esc(t.device || 'local')}</span>
            <span class="branch" title="${esc(t.project)}">${esc((w && w.branch) || t.project)}</span>
          </div>
          ${t.note ? `<p class="dim" style="font-size:11px;margin:4px 0 0">${esc(t.note.slice(0, 140))}</p>` : ''}
          <div class="bcard-foot">
            <span class="meta">${esc(t.status)}${t.outcome ? ` · ${esc(t.outcome)}` : ''}</span>
            <span class="time">${new Date(t.updated_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
          </div>
        </article>`;
}
function viewJobs() {
  const runs = state.jobs.flatMap((j) => j.runs.map((r) => ({ ...r, jobTitle: j.title, jobId: j.id })));
  const tasks = prefs.goaMode ? (state.goa && state.goa.tasks) || [] : [];
  const cols = JOB_COLS.map(([key, label, color]) => {
    const rows = runs.filter((r) => colOf(r.status) === key);
    const goaRows = tasks.filter((t) => goaCol(t.status) === key);
    return `<div class="bcol">
      <div class="bcol-head"><i class="mark" style="background:${color}"></i><b>${label}</b><span class="cnt">${rows.length + goaRows.length}</span></div>
      <div class="bcards">${rows.map((r) => `
        <article class="bcard jcard" data-run="${r.id}">
          <div class="bcard-top">
            <span class="sid num">${r.id}</span>
            <span class="badge"><i style="background:${color}"></i>${r.agent}</span>
          </div>
          <h4>${esc(r.jobTitle)}</h4>
          <div class="bcard-chips">
            <span class="wschip">${ic('desktop')}${esc(r.device)}</span>
            <span class="branch" title="${esc(r.cwd)}">${esc(r.branch || r.cwd)}</span>
          </div>
          ${key === 'waiting' ? `<div class="jcard-actions">
            <button class="btn primary sm" data-approve="${r.id}">Approve</button>
            <button class="btn secondary sm" data-reject="${r.id}">Reject</button>
          </div>` : ''}
          <div class="bcard-foot">
            <span class="meta">${r.pid ? `pid ${r.pid}` : esc(r.status)}</span>
            <span class="time">${new Date(r.updated_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
          </div>
        </article>`).join('')}${goaRows.map((t) => goaCard(t, color)).join('')}${rows.length + goaRows.length ? '' : `<div class="jempty">No runs</div>`}</div>
    </div>`;
  }).join('');

  const err = state.jobsErr ? `<div class="jerr">${ic('warning')}server not reachable — run <code>npm run dev</code> (${esc(state.jobsErr)})</div>` : '';
  return pageHead('Jobs', 'multi-agent',
    `${state.jobs.length} jobs · ${runs.length} runs · ${tasks.length} GOA tasks · ${state.jobsWaiting} waiting on approval`,
    `<button class="btn secondary" data-act="jobs-refresh">${ic('arrows-clockwise')}Refresh</button>
     <button class="btn primary" data-act="dispatch">${ic('paper-plane-tilt', 'bold')}Dispatch</button>`)
    + err + `<div class="board jobs-board">${cols}</div>`;
}

/* ---------- dispatch ---------- */
/* Agents a device can run: what it reported as installed, plus a plain shell. A device that
   reports nothing (ssh only, no XBLabs agent) gets the full list, since nobody knows. */
function agentsFor(device) {
  const d = (DB.devices || []).find((x) => x.name === device);
  const list = [...(d && d.agents ? d.agents.map((a) => a.id) : ['claude', 'codex', 'gemini', 'opencode', 'hermes', 'omp']), 'shell'];
  const pick = window.__hub && window.__hub.session && window.__hub.session.agent;   // Settings → Agents → Default agent first
  return pick && list.includes(pick) ? [pick, ...list.filter((a) => a !== pick)] : list;
}
/* Runs before the chip's own click handler: the agent list follows the row's device. */
document.addEventListener('click', (e) => {
  const chip = e.target.closest('.dtarget [data-t=agent]');
  if (chip) chip.dataset.glide = agentsFor(chip.closest('.dtarget').querySelector('[data-t=device]').dataset.value).join('|');
}, true);

/* A device's folder for a new target: its home, else its root. */
function defaultCwd(device) {
  const d = (DB.devices || []).find((x) => x.name === device || (device === 'local' && x.icon === 'laptop'));
  return (d && (d.home || d.root)) || '';
}
function targetRow(i, t = {}) {
  const devs = [...new Set(['local', ...((DB.devices || []).map((d) => d.name))])];
  const agents = agentsFor(t.device || 'local');
  return `<div class="dtarget" data-trow="${i}">
    ${glideChip('device', devs, t.device || 'local', 'Device')}
    ${glideChip('agent', agents, t.agent || agents[0], 'Agent')}
    <input data-t="cwd" value="${esc(t.cwd || defaultCwd(t.device || 'local'))}" placeholder="working directory">
    <button class="btn ghost sm" data-trem="${i}" title="Remove">${ic('x')}</button>
  </div>`;
}

function modalDispatch() {
  const rows = targetRow(0);
  showModal(`
    <div class="modal-head"><div class="tb"><h2>Dispatch job</h2><p>One job, many runs — each row gets its own process</p></div>
      <button class="close-x" data-act="close">${ic('x')}</button></div>
    <div class="modal-body">
      <div class="field"><label>Job title</label><span class="input"><input id="dj-title" placeholder="What this job is"></span></div>
      <div class="field"><label>Prompt</label><span class="input"><textarea id="dj-prompt" rows="3" placeholder="What should every run do?"></textarea></span></div>
      <div class="field"><label>Targets</label><div id="dj-targets">${rows}</div>
        <button class="btn secondary sm" data-tadd="1">${ic('plus')}Add target</button></div>
    </div>
    <div class="modal-foot"><span class="hint">Runs start immediately in their own process.</span><span class="sp"></span>
      <button class="btn secondary sm" data-act="close">Cancel</button>
      <button class="btn primary sm" id="dj-go">Start runs</button></div>`, 560);

  $('#dj-go').onclick = async () => {
    const title = $('#dj-title').value.trim();
    const prompt = $('#dj-prompt').value.trim();
    const targets = [...document.querySelectorAll('#dj-targets .dtarget')].map((el) => ({
      device: el.querySelector('[data-t=device]').dataset.value,
      agent: el.querySelector('[data-t=agent]').dataset.value,
      cwd: el.querySelector('[data-t=cwd]').value.trim(),
    })).filter((t) => t.cwd);
    if (!title || !targets.length) { toast(title ? 'Add a target with a working directory' : 'Give the job a title', 'info'); return; }
    const btn = $('#dj-go'); btn.disabled = true; btn.textContent = 'Starting…';
    try {
      await api('/api/jobs', { method: 'POST', body: JSON.stringify({ title, prompt, targets }) });
      closeAll(); await loadJobs();
    } catch (err) {
      btn.disabled = false; btn.textContent = 'Start runs';
      toast(`Dispatch failed: ${err.message}`, 'warning');
    }
  };
}

/* ---------- GOA task detail ----------
   Same report as a job run: how it stands, the task, what the worker said, its last lines. */
async function modalGoaTask(id) {
  showModal(`
    <div class="modal-head"><div class="tb"><h2>GOA task</h2><p>${esc(id)}</p></div>
      <button class="close-x" data-act="close">${ic('x')}</button></div>
    <div class="modal-body run-sum" data-gsum="${esc(id)}"><div class="dim">Reading the task…</div></div>
    <div class="modal-foot"><span class="sp"></span><span id="goa-sum-acts"></span>
      <button class="btn primary sm" data-act="close">Close</button></div>`, 640);
  const paint = async () => {
    const box = document.querySelector(`[data-gsum="${CSS.escape(id)}"]`);
    if (!box) return false;
    let t;
    try { t = await api(`/api/goa/tasks/${encodeURIComponent(id)}`); } catch (err) { box.innerHTML = `<div class="dim">Could not read the task · ${esc(err.message)}</div>`; return false; }
    const w = t.worker || {};
    const open = !['done', 'failed', 'stopped'].includes(t.status);
    const tone = t.status === 'done' ? 'ok' : t.status === 'failed' ? 'dg' : t.status === 'waiting' ? 'wn' : '';
    const head = { queued: 'Queued', running: 'Worker is on it', waiting: 'Worker is asking a question', 'turn-ended': 'Worker stopped without a report · GOA checks it',
      reported: `Worker reported ${t.outcome || ''} · GOA checks it`, done: 'Done', failed: 'Failed', stopped: 'Stopped' }[t.status] || t.status;
    const busy = open && t.status !== 'queued';
    box.innerHTML = `
      <div class="rs-head ${tone}">${busy ? lattice(t.status === 'waiting' ? 'idle' : 'working') : ic(t.status === 'done' ? 'check-circle' : t.status === 'failed' ? 'x-circle' : 'stop-circle', 'fill')}<b>${esc(head)}</b></div>
      <div class="rs-sec"><span class="rs-k">Task</span><p>${esc(t.prompt)}</p></div>
      <div class="rs-sec"><span class="rs-k">Summary</span>${t.note ? `<p>${esc(t.note)}</p>` : '<p class="dim">Nothing reported yet.</p>'}</div>
      ${t.question ? `<div class="rs-sec"><span class="rs-k">Question</span><p>${esc(t.question)}</p></div>` : ''}
      ${(t.screen || []).length ? `<div class="rs-sec"><span class="rs-k">Last from the worker</span><ol class="rs-tail">${t.screen.slice(-14).map((l) => `<li>${esc(l)}</li>`).join('')}</ol></div>` : ''}
      <dl class="rs-facts">
        <div><dt>Agent</dt><dd>${esc(t.agent)}</dd></div><div><dt>Device</dt><dd>${esc(t.device || 'local')}</dd></div>
        <div><dt>Project</dt><dd class="mono">${esc(t.project)}</dd></div><div><dt>Status</dt><dd>${esc(t.status)}${t.outcome ? ` · ${esc(t.outcome)}` : ''}</dd></div>
        <div><dt>Given</dt><dd>${new Date(t.created_at).toLocaleString()}</dd></div><div><dt>Updated</dt><dd>${new Date(t.updated_at).toLocaleString()}</dd></div>
        ${w.branch ? `<div><dt>Branch</dt><dd class="mono">${esc(w.branch)}</dd></div>` : ''}
      </dl>`;
    $('#goa-sum-acts').innerHTML = (open ? `<button class="btn secondary sm" data-goa="settle" data-id="${esc(t.id)}" data-status="done">Mark done</button> <button class="btn secondary sm" data-goa="settle" data-id="${esc(t.id)}" data-status="stopped">Stop</button> ` : '')
      + (w.branch ? `<button class="btn secondary sm" data-act="git-review" data-id="${esc(w.id)}">Review changes</button> ` : '')
      + (w.id ? `<button class="btn secondary sm" data-goa-open data-session="${esc(w.id)}">Open session</button>` : '');
    return open;
  };
  const loop = async () => { if (await paint()) setTimeout(loop, 3000); };
  loop();
}
document.addEventListener('click', (e) => {
  if (e.target.closest('[data-goa-open]')) { closeAll(); return; }   // the session opens through data-session
  const card = e.target.closest('[data-goatask]');
  if (!card || e.target.closest('button, [data-session]')) return;
  e.stopPropagation();
  modalGoaTask(card.dataset.goatask);
}, true);

/* ---------- run detail ---------- */
async function modalRun(id) {
  /* Standalone shells (Terminal page) have no job, so look them up in the flat run map too. */
  const run = state.jobs.flatMap((j) => j.runs).find((r) => r.id === id)
    || (window.__liveRuns && window.__liveRuns.get(id));
  if (!run) return;
  if (run.job_id || run.kind === 'job') { modalRunSummary(run); return; }
  showModal(`
    <div class="modal-head"><div class="tb"><h2>${esc(run.title)}</h2><p>${esc(run.device)} · ${esc(run.agent)} · ${esc(run.cwd)}</p></div>
      <button class="close-x" data-act="close">${ic('x')}</button></div>
    <div class="modal-body">
      <div class="kv"><div class="kt"><b>${esc(run.device)} · ${esc(run.agent)}</b><small>${esc(run.cwd)}</small></div>
        <span class="badge"><i></i>${esc(run.status)}</span></div>
      ${run.prompt ? `<div class="pf-hint" style="margin:0">${esc(run.prompt)}</div>` : ''}
      <div class="runterm" id="runterm"></div>
    </div>
    <div class="modal-foot"><span class="hint">${run.pid ? `pid ${run.pid}` : 'process not running'}</span><span class="sp"></span>
      <button class="btn secondary sm" data-approve="${run.id}">Approve</button>
      <button class="btn secondary sm" data-reject="${run.id}">Reject</button>
      <button class="btn primary sm" data-act="close">Close</button></div>`, 820);
  mountTerminal(id, $('#runterm'));
}

/* A job run reads as a report, not a terminal: how it ended, the facts, and what it printed.
   The written summary comes from the LLM endpoint when one is saved; without it the dialog says
   so instead of inventing one. While the run is live the dialog refreshes every 3 s. */
const dur = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`; };
function runHeadline(r) {
  const took = dur((r.ended || Date.now()) - r.started);
  return {
    running: `Running for ${took}`, starting: 'Starting', queued: 'Queued', waiting: `Waiting for your approval · ${took}`,
    done: `Finished in ${took}`, failed: `Failed after ${took}`, stopped: `Stopped after ${took}`, rejected: `Rejected after ${took}`,
  }[r.status] || `${r.status} · ${took}`;
}
async function modalRunSummary(run) {
  const id = run.id;
  showModal(`
    <div class="modal-head"><div class="tb"><h2>${esc(run.jobTitle || state.jobs.find((j) => j.id === run.job_id)?.title || (window.__liveRuns && window.__liveRuns.get(id)?.jobTitle) || run.title)}</h2><p>Job run · ${esc(run.id)}</p></div>
      <button class="close-x" data-act="close">${ic('x')}</button></div>
    <div class="modal-body run-sum" id="run-sum" data-sum="${esc(id)}"><div class="dim">Reading the run…</div></div>
    <div class="modal-foot"><span class="hint" id="run-sum-hint"></span><span class="sp"></span>
      <span id="run-sum-acts"></span>
      <button class="btn primary sm" data-act="close">Close</button></div>`, 640);
  const paint = async () => {
    const box = document.querySelector(`[data-sum="${CSS.escape(id)}"]`);
    if (!box) return false;                              // dialog closed
    let r;
    try { r = await api(`/api/sessions/${id}/summary`); } catch (err) { box.innerHTML = `<div class="dim">Could not read the run · ${esc(err.message)}</div>`; return false; }
    const tone = r.status === 'done' ? 'ok' : r.status === 'failed' || r.status === 'rejected' ? 'dg' : r.status === 'waiting' ? 'wn' : '';
    const llmOff = !r.text && !r.textError && !r.live && r.lineCount;
    box.innerHTML = `
      <div class="rs-head ${tone}">${r.live ? lattice(r.status === 'waiting' ? 'idle' : 'working') : ic(r.status === 'done' ? 'check-circle' : r.status === 'failed' || r.status === 'rejected' ? 'x-circle' : 'stop-circle', 'fill')}<b>${esc(runHeadline(r))}</b></div>
      ${r.prompt ? `<div class="rs-sec"><span class="rs-k">Task</span><p>${esc(r.prompt)}</p></div>` : ''}
      <div class="rs-sec"><span class="rs-k">Summary</span>${
        r.text ? `<p>${esc(r.text)}</p>`
        : r.live ? '<p class="dim">Written when the run ends.</p>'
        : !r.lineCount ? `<p>${esc(r.agent)} printed nothing beyond the shell's own banner, so there is nothing to summarise.</p>`
        : r.textError ? `<p class="dim">The LLM endpoint did not answer (${esc(r.textError)}). The last lines are below.</p>`
        : '<p class="dim">No LLM endpoint saved, so there is no written summary. The last lines are below.</p>'}</div>
      ${r.tail.length ? `<div class="rs-sec"><span class="rs-k">Last output · ${r.lineCount} line${r.lineCount === 1 ? '' : 's'}</span><ol class="rs-tail">${r.tail.map((l) => `<li>${esc(l)}</li>`).join('')}</ol></div>` : ''}
      <dl class="rs-facts">
        <div><dt>Device</dt><dd>${esc(r.device)}</dd></div><div><dt>Agent</dt><dd>${esc(r.agent)}</dd></div>
        <div><dt>Folder</dt><dd class="mono">${esc(r.cwd)}</dd></div><div><dt>Started</dt><dd>${new Date(r.started).toLocaleString()}</dd></div>
        <div><dt>Output</dt><dd>${(r.bytes / 1024).toFixed(1)} KB</dd></div><div><dt>Status</dt><dd>${esc(r.status)}</dd></div>
        ${r.branch ? `<div><dt>Branch</dt><dd class="mono">${esc(r.branch)}</dd></div>` : ''}
      </dl>`;
    $('#run-sum-acts').innerHTML = (r.status === 'waiting'
      ? `<button class="btn secondary sm" data-approve="${esc(id)}">Approve</button> <button class="btn secondary sm" data-reject="${esc(id)}">Reject</button> ` : '')
      + (r.branch ? `<button class="btn secondary sm" data-act="git-review" data-id="${esc(id)}">Review changes</button>` : '');
    $('#run-sum-hint').innerHTML = llmOff ? '<span class="link" data-act="llm-settings">Set an LLM endpoint</span>' : '';
    return r.live;
  };
  const loop = async () => { if (await paint()) setTimeout(loop, 3000); };
  loop();
}
document.addEventListener('click', (e) => {
  if (!e.target.closest('[data-act="llm-settings"]')) return;
  e.stopPropagation(); closeAll(); openSettings('models');
}, true);

/* ---------- live terminal ---------- */
/* `keep` stacks this terminal on top of the ones already mounted (Focus mode shows several);
   without it, remounting (switching runs) first tears the previous socket down. */
function mountTerminal(id, el, { keep = false, readOnly = false } = {}) {
  if (!el || !window.Terminal) return;
  if (!keep && window.__ptyCleanup) { window.__ptyCleanup(); window.__ptyCleanup = null; }
  const css = getComputedStyle(document.documentElement);
  const v = (n, f) => (css.getPropertyValue(n).trim() || f);
  const term = new Terminal({
    fontFamily: `${v('--font-code', '') || v('--font-mono', 'monospace')}, ui-monospace, monospace`,
    fontSize: 12, lineHeight: 1.3, cursorBlink: !readOnly, disableStdin: readOnly, scrollback: 3000,
    theme: {
      background: v('--bg-sunken', '#161616'), foreground: v('--text-secondary', '#c9c9c9'),
      cursor: v('--accent', '#5b7cff'), selectionBackground: v('--accent-soft', '#5b7cff44'),
    },
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(el);
  const resize = () => { if (!el.offsetWidth) return; try { fit.fit(); } catch {} ; send({ type: 'resize', cols: term.cols, rows: term.rows }); };
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/pty?session=${id}`);
  const send = (m) => { if (ws.readyState === 1) ws.send(JSON.stringify(m)); };
  let readyResolve, readyReject, attached = false, replaying = false;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  ready.catch(() => {}); // render callers display errors here; Refresh also awaits failure.
  const timer = setTimeout(() => readyReject(new Error('Terminal connection timed out')), 20000);
  const fail = (text) => { clearTimeout(timer); if (el.__live === id) el.__live = null; term.write(`\r\n${text}\r\n`); readyReject(new Error(text)); };   // not live: the next render may mount again

  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'backlog') {
      replaying = true;
      term.reset(); term.write(msg.data, () => {
        replaying = false;
        send({ type: 'resize', cols: Math.max(2, term.cols - 1), rows: term.rows });
        resize(); attached = true; clearTimeout(timer); readyResolve();
      });
    }
    if (msg.type === 'data') term.write(msg.data);
    if (msg.type === 'error') fail(msg.error);
    if (msg.type === 'exit') term.write(`\r\n\x1b[2m— process exited (${msg.code}) —\x1b[0m\r\n`);
  };
  ws.onopen = resize;
  ws.onerror = () => fail('Terminal connection failed');
  ws.onclose = () => { if (!attached) fail('Terminal disconnected before attach'); };
  term.onData((d) => { if (!readOnly && !replaying && attached) send({ type: 'input', data: d }); });

  const ro = new ResizeObserver(() => resize());
  ro.observe(el);
  setTimeout(() => { resize(); term.focus(); }, 60);

  /* The session page sends composer text straight into this shell; Copy reads its buffer. */
  window.__ptySend = readOnly ? null : (data) => send({ type: 'input', data });
  window.__term = term;
  const prev = keep ? window.__ptyCleanup : null;
  el.__live = id;   // morph keeps a live terminal's DOM; cleanup clears it
  window.__ptyCleanup = () => {
    if (el.__live === id) el.__live = null;
    clearTimeout(timer); readyReject(new Error('Terminal view closed'));
    ro.disconnect(); ws.onclose = ws.onerror = ws.onmessage = null; try { ws.close(); } catch {} term.dispose();
    window.__ptySend = null; if (window.__term === term) window.__term = null;
    if (prev) prev();
  };
  return ready;
}

/* ---------- actions ---------- */
async function decide(id, decision) {
  try {
    await api(`/api/sessions/${id}/approve`, { method: 'POST', body: JSON.stringify({ decision }) });
    await Promise.all([loadJobs(), afterDecision(id)]);
  } catch (err) { toast(`Failed: ${err.message}`, 'warning'); }
}

document.addEventListener('click', (e) => {
  const ap = e.target.closest('[data-approve]');
  const rj = e.target.closest('[data-reject]');
  const card = e.target.closest('[data-run]');
  const dispatch = e.target.closest('[data-act="dispatch"]');
  const refresh = e.target.closest('[data-act="jobs-refresh"]');
  const addT = e.target.closest('[data-tadd]');
  const remT = e.target.closest('[data-trem]');

  if (ap) { e.stopPropagation(); decide(ap.dataset.approve, 'y'); return; }
  if (rj) { e.stopPropagation(); decide(rj.dataset.reject, 'n'); return; }
  if (dispatch) { modalDispatch(); return; }
  if (refresh) { loadJobs(); return; }
  if (addT) {
    const box = $('#dj-targets');
    box.insertAdjacentHTML('beforeend', targetRow(box.children.length));
    return;
  }
  if (remT) {
    const box = $('#dj-targets');
    if (box.children.length > 1) box.querySelector(`[data-trow="${remT.dataset.trem}"]`).remove();
    return;
  }
  if (card && !e.target.closest('button')) modalRun(card.dataset.run);
});

loadJobs({ quiet: true });

/* ---------- GOA ----------
   The head agent and its task board. The head itself is a chat session (open it to talk to it);
   this page starts or stops it and shows what it handed to which worker. */
state.goa = { head: null, tasks: [] };
async function loadGoa() {
  try { state.goa = await api('/api/goa'); state.goaErr = null; }
  catch (err) { state.goaErr = /no such endpoint|not found/i.test(err.message) ? 'The running hub has no GOA yet: it is older than this page. Restart it (stop it, then npm run dev) and reload.' : String(err.message || err); }
  if (state.page === 'goa') {
    const cur = $('#main .content');
    if (cur) morph(cur, viewGoa()); else $('#main').innerHTML = `<div class="content">${viewGoa()}</div>`;
  }
}
setInterval(() => { if (state.page === 'goa' && !document.hidden) loadGoa(); }, 3000);

const GOA_PILL = { queued: 'waiting', running: 'running', waiting: 'waiting', failed: 'blocked' };
function viewGoa() {
  if (!state.goaLoaded) { state.goaLoaded = true; loadGoa(); }
  const { head, tasks } = state.goa;
  const agents = agentsFor('local').filter((a) => a !== 'shell');
  const headCard = head && head.live
    ? `<div class="kv"><div class="kt"><b>GOA is running · ${esc(head.agent)}</b><small>${esc(head.status)} · ${esc(head.cwd)}</small></div>
        <div style="display:flex;gap:6px"><button class="btn primary sm" data-session="${esc(head.id)}">${ic('chat-circle')}Open</button>
        <button class="btn secondary sm" data-goa="stop">Stop</button></div></div>`
    : `<div class="kv"><div class="kt"><b>GOA is not running</b><small>Pick the agent that leads. It plans and delegates; it does not edit project files.</small></div>
        <div style="display:flex;gap:6px">${agents.length ? glideChip('goa-agent', agents, agents[0], 'Head agent') : '<span class="dim">no agent installed on this hub</span>'}
        <button class="btn primary sm" data-goa="start" ${agents.length ? '' : 'disabled'}>Start GOA</button></div></div>`;
  const open = (t) => !['done', 'failed', 'stopped'].includes(t.status);
  const rows = tasks.map((t) => `
      <div class="trow" data-goatask="${esc(t.id)}" style="cursor:pointer">
        <div class="c-108 mono dim" style="text-align:left">${esc(t.id)}</div>
        <div class="c-96"><span class="pill ${GOA_PILL[t.status] || 'done'}"><i></i>${esc(t.status)}</span></div>
        <div class="c-84">${esc(t.agent)}</div>
        <div class="c-dev" style="min-width:0"><div class="dev-name" style="min-width:0"><b style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(t.prompt)}</b>
          <small class="mono">${esc(t.project)}${t.outcome ? ` · ${esc(t.outcome)}` : ''}${t.note ? ` · ${esc(t.note)}` : ''}</small></div></div>
        <div class="c-108" style="width:128px;text-align:left;overflow:hidden;text-overflow:ellipsis">${t.session_id ? `<span class="link" data-session="${esc(t.session_id)}">${esc(t.session_id)}</span>` : '<span class="dim">—</span>'}</div>
        <div class="c-108" style="display:flex;gap:4px;justify-content:flex-end">${open(t) ? `<button class="btn ghost xs" data-goa="settle" data-id="${esc(t.id)}" data-status="done">Done</button><button class="btn ghost xs" data-goa="settle" data-id="${esc(t.id)}" data-status="stopped">Stop</button>` : `<span class="dim">${new Date(t.updated_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>`}</div>
      </div>`).join('');
  return pageHead('GOA', 'head agent', `${tasks.filter(open).length} open task${tasks.filter(open).length === 1 ? '' : 's'} · ${tasks.length} total`,
    `<button class="btn secondary" data-goa="refresh">${ic('arrows-clockwise')}Refresh</button>`)
    + (state.goaErr ? `<div class="pf-hint" style="color:var(--warning)">${esc(state.goaErr)}</div>` : '')
    + `<div class="card" style="padding:12px 14px;margin-bottom:12px">${headCard}</div>
    <div class="card" style="display:flex;flex-direction:column;min-height:0;overflow:hidden">
    <div class="card-head"><h2>Tasks</h2><div class="grow"></div><span class="count-chip">${tasks.length}</span></div>
    <div class="table">
      <div class="thead"><div class="c-108" style="text-align:left">Task</div><div class="c-96">Status</div><div class="c-84">Agent</div><div class="c-dev">What</div><div class="c-108" style="width:128px;text-align:left">Worker</div><div class="c-108"></div></div>
      <div class="rows">${rows || '<div class="dim" style="padding:14px;font-size:12px">No tasks yet. Start GOA, open it and tell it what you want done.</div>'}</div>
    </div></div>`;
}
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-goa]');
  if (!b) return;
  e.stopPropagation();
  const act = b.dataset.goa;
  try {
    if (act === 'start') {
      const agent = document.querySelector('[data-t="goa-agent"]')?.dataset.value;
      b.disabled = true; b.textContent = 'Starting…';
      const h = await api('/api/goa/head', { method: 'POST', body: JSON.stringify({ agent }) });
      toast(`GOA started on ${h.agent}`);
      await liveLoad();
    }
    if (act === 'stop') { await api('/api/goa/head', { method: 'DELETE' }); toast('GOA stopped'); }
    if (act === 'settle') await api(`/api/goa/tasks/${b.dataset.id}`, { method: 'PATCH', body: JSON.stringify({ status: b.dataset.status, note: 'settled from the board' }) });
  } catch (err) { toast(`GOA: ${err.message}`, 'warning'); }
  await loadGoa();
}, true);
