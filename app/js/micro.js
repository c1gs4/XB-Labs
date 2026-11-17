/* XBLabs — micro-interactions: swipe toast, glide select, swipe row, thought line, magic bento,
   animated list, click spark.
   Vanilla ports of the behaviour of React Bits' Swipe Toast, Glide Select and Swipe Row
   (reactbits.dev/micro), restyled with the app's tokens. Loaded after app.js. */

/* ---------- swipe toast ----------
   Bottom-centre stack. A thin fuse burns for the time left; hover pauses it; dragging down past
   48 px dismisses. `action` adds a button (Undo); `onExpire` runs when the toast ends any way
   other than that button (fuse ran out or swiped away). */
/* The icon says what kind of news it is: a warning is an error (red, stays longer, reads in full),
   a check is a success (green), anything else is information. */
const TOAST_ERR = /^(warning|warning-circle|warning-octagon|x-circle|prohibit)$/;
function toast(text, icon = 'check-circle', { action, ms, onExpire } = {}) {
  const wrap = document.getElementById('toasts');
  if (!wrap) return;
  while (wrap.children.length >= 3) wrap.firstElementChild.remove();
  const kind = TOAST_ERR.test(icon) ? 'err' : /^check/.test(icon) ? 'ok' : 'info';
  ms = ms || (kind === 'err' ? 7000 : 3200);
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.setAttribute('role', kind === 'err' ? 'alert' : 'status');
  el.innerHTML = `${ic(icon, 'fill')}<span class="toast-text">${esc(text)}</span>`
    + `${action ? `<button class="toast-act">${esc(action.label)}</button>` : ''}`
    + `<i class="toast-fuse" style="animation-duration:${ms}ms"></i>`;
  wrap.append(el);
  const fuse = el.querySelector('.toast-fuse');
  let done = false, drag = false, y0 = 0, dy = 0;
  const close = (how) => {
    if (done) return;
    done = true;
    el.classList.add(how === 'swipe' ? 'out-swipe' : 'out');
    setTimeout(() => el.remove(), 220);
    if (how !== 'action' && onExpire) onExpire();
  };
  const run = (on) => { fuse.style.animationPlayState = on ? 'running' : 'paused'; };
  fuse.addEventListener('animationend', () => close('time'));
  el.addEventListener('pointerenter', () => run(false));
  el.addEventListener('pointerleave', () => { if (!drag) run(true); });
  if (action) el.querySelector('.toast-act').addEventListener('click', (e) => { e.stopPropagation(); action.fn(); close('action'); });
  el.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.toast-act')) return;
    drag = true; y0 = e.clientY; dy = 0;
    el.setPointerCapture(e.pointerId);
    el.style.transition = 'none';
    run(false);
  });
  el.addEventListener('pointermove', (e) => {
    if (!drag) return;
    dy = e.clientY - y0;
    const d = dy < 0 ? dy * 0.25 : dy;              // resists upward, follows downward
    el.style.transform = `translateY(${d}px)`;
    el.style.opacity = String(Math.max(0, 1 - Math.max(0, dy) / 120));
  });
  const release = () => {
    if (!drag) return;
    drag = false;
    el.style.transition = '';
    if (dy > 48) { close('swipe'); return; }
    el.style.transform = ''; el.style.opacity = '';
    run(true);
  };
  el.addEventListener('pointerup', release);
  el.addEventListener('pointercancel', release);
  return { close: () => close('action') };
}

/* ---------- glide select ----------
   A menu that grows out of the chip's corner. One pill glides to the hovered row; the selected
   row rests on it at 60% and carries the check. Arrow keys move, Enter picks, Esc closes.
   It flips above the chip when there is no room below. */
let glideEl = null, glideState = null;
function glideClose(instant) {
  if (!glideEl || glideEl.hidden) return;
  const el = glideEl;
  const anchor = glideState && glideState.anchor;
  glideState = null;
  if (anchor) anchor.setAttribute('aria-expanded', 'false');
  if (instant) { el.hidden = true; return; }
  el.classList.remove('in');
  el.classList.add('leaving');
  setTimeout(() => { el.hidden = true; el.classList.remove('leaving'); }, 120);
}
function glideSelect(anchor, { options, value, onPick, width = 176, label = 'Select', keep = false, scroll = false }) {
  if (!keep && glideState && glideState.anchor === anchor) { glideClose(); return; }
  if (!glideEl) {
    glideEl = document.createElement('div');
    glideEl.className = 'glide';
    glideEl.hidden = true;
    document.body.append(glideEl);
  }
  const opts = options.map((o) => (typeof o === 'string' ? { value: o, label: o } : o));
  const sel = Math.max(0, opts.findIndex((o) => o.value === value));
  glideEl.classList.toggle('scroll', scroll);
  glideEl.setAttribute('role', 'listbox');
  glideEl.setAttribute('aria-label', label);
  glideEl.innerHTML = `<i class="glide-pill" aria-hidden="true"></i>${opts.map((o, i) => `
    <div class="glide-row ${i === sel && opts[sel].value === value ? 'sel' : ''}" role="option" aria-selected="${o.value === value}" data-glide-i="${i}">
      ${o.icon || ''}<span class="glide-label">${esc(o.label)}</span>${o.tag ? `<span class="glide-tag">${esc(o.tag)}</span>` : ''}
      ${o.value === value ? ic('check', 'bold', 'glide-check') : ''}</div>`).join('')}`;
  const r = anchor.getBoundingClientRect();
  const w = Math.max(width, Math.round(r.width));
  glideEl.style.width = w + 'px';
  glideEl.hidden = false;
  glideEl.classList.remove('leaving');
  if (!keep) glideEl.classList.remove('in');
  const h = glideEl.offsetHeight;
  const up = r.bottom + 6 + h > window.innerHeight - 8 && r.top - 6 - h > 8;
  const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
  glideEl.style.left = left + 'px';
  glideEl.style.top = Math.round(up ? r.top - 6 - h : r.bottom + 6) + 'px';
  glideEl.style.transformOrigin = `${r.left - left + 12}px ${up ? '100%' : '0'}`;
  anchor.setAttribute('aria-expanded', 'true');
  glideState = { anchor, opts, onPick, hover: sel };
  const pill = glideEl.querySelector('.glide-pill');
  const rows = [...glideEl.querySelectorAll('.glide-row')];
  const moveTo = (i, rest) => {
    const row = rows[i];
    if (!row) return;
    glideState && (glideState.hover = i);
    pill.style.transform = `translateY(${row.offsetTop}px)`;
    pill.style.height = row.offsetHeight + 'px';
    pill.classList.toggle('rest', !!rest);
    rows.forEach((x) => x.classList.toggle('hot', x === row && !rest));
  };
  pill.style.transition = 'none';
  moveTo(sel, true);
  pill.offsetWidth;
  pill.style.transition = '';
  requestAnimationFrame(() => glideEl.classList.add('in'));
  glideEl.onpointermove = (e) => { const row = e.target.closest('.glide-row'); if (row) moveTo(+row.dataset.glideI); };
  glideEl.onclick = (e) => {
    const row = e.target.closest('.glide-row');
    if (!row || !glideState) return;
    e.stopPropagation();
    const o = glideState.opts[+row.dataset.glideI];
    const cb = glideState.onPick;
    glideClose();
    if (o.value !== value) cb(o.value, o);
  };
  glideState.move = moveTo;
}
document.addEventListener('pointerdown', (e) => {
  if (!glideState) return;
  if (e.target.closest('.glide') || e.target === glideState.anchor || glideState.anchor.contains(e.target)) return;
  glideClose();
}, true);
document.addEventListener('keydown', (e) => {
  if (!glideState) return;
  const n = glideState.opts.length;
  if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); glideClose(); glideState?.anchor?.focus(); return; }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    glideState.move((glideState.hover + (e.key === 'ArrowDown' ? 1 : n - 1)) % n);
  }
  if (e.key === 'Enter') { e.preventDefault(); glideEl.querySelector(`[data-glide-i="${glideState.hover}"]`)?.click(); }
}, true);
window.addEventListener('resize', () => glideClose(true));

/* ---------- combo: type freely or pick from a glide list (input[data-combo]) ----------
   Options are window[input.dataset.combo], an array of strings. Typing filters the list; the
   typed text stays when nothing is picked, so a value the list lacks can still be entered. */
function comboOpen(inp, keep) {
  const all = window[inp.dataset.combo] || [];
  const q = inp.value.trim().toLowerCase();
  const list = (q && !all.includes(inp.value) ? all.filter((m) => m.toLowerCase().includes(q)) : all).slice(0, 300);
  if (!list.length) { glideClose(true); return; }
  glideSelect(inp.closest('.input') || inp, { options: list, value: inp.value, width: 0, label: inp.placeholder || 'Options', keep, scroll: true,
    onPick: (v) => { inp.value = v; inp.dispatchEvent(new Event('change', { bubbles: true })); } });
  if (glideState && !list.includes(inp.value)) glideState.hover = -1;   // Enter keeps what was typed
}
document.addEventListener('focusin', (e) => { const i = e.target.closest && e.target.closest('input[data-combo]'); if (i) comboOpen(i); });
document.addEventListener('input', (e) => { const i = e.target.closest && e.target.closest('input[data-combo]'); if (i) comboOpen(i, !!glideState); });
document.addEventListener('focusout', (e) => {
  const i = e.target.closest && e.target.closest('input[data-combo]');
  if (i) setTimeout(() => { if (document.activeElement !== i && glideState && glideState.anchor.contains(i)) glideClose(); }, 150);
});

/* ---------- swipe row ----------
   Drag a session row left to reveal Rename and Delete; let go past the reveal and it snaps open.
   A full swipe deletes, but the row only leaves sqlite once the Undo toast's fuse runs out. */
state.pendingDel = state.pendingDel || new Set();
let swipe = null;
const REVEAL = 64, FULL = 150;
function swipeCloseAll(except) {
  document.querySelectorAll('.swipe.open').forEach((r) => {
    if (r === except) return;
    r.classList.remove('open');
    r.querySelector('.swipe-face').style.transform = '';
  });
}
document.addEventListener('pointerdown', (e) => {
  const face = e.target.closest('.swipe-face');
  if (!face || e.button !== 0) { if (!e.target.closest('.swipe')) swipeCloseAll(); return; }
  const row = face.closest('.swipe');
  const reveal = +row.dataset.reveal || REVEAL;
  swipe = { row, face, reveal, x0: e.clientX, y0: e.clientY, base: row.classList.contains('open') ? -reveal : 0, dx: 0, live: false, id: e.pointerId };
});
document.addEventListener('pointermove', (e) => {
  if (!swipe || e.pointerId !== swipe.id) return;
  const dx = e.clientX - swipe.x0, dy = e.clientY - swipe.y0;
  if (!swipe.live) {
    if (Math.abs(dy) > 6 && Math.abs(dy) > Math.abs(dx)) { swipe = null; return; }   // a scroll, not a swipe
    if (Math.abs(dx) < 6) return;
    swipe.live = true;
    swipe.face.setPointerCapture(e.pointerId);
    swipeCloseAll(swipe.row);
    swipe.row.classList.add('dragging');
  }
  let x = Math.min(0, swipe.base + dx);
  if (x < -FULL) x = -FULL - (-x - FULL) * 0.3;                                       // rubber past the end
  swipe.dx = x;
  swipe.face.style.transform = `translateX(${x}px)`;
  swipe.row.classList.toggle('commit', x <= -FULL);
});
document.addEventListener('pointerup', (e) => {
  if (!swipe || e.pointerId !== swipe.id) return;
  const s = swipe;
  swipe = null;
  if (!s.live) return;
  s.row.classList.remove('dragging');
  /* The click that ends a drag must not open the session. */
  const eat = (ev) => { ev.stopPropagation(); ev.preventDefault(); };
  window.addEventListener('click', eat, { capture: true, once: true });
  setTimeout(() => window.removeEventListener('click', eat, { capture: true }), 0);
  if (s.dx <= -FULL) { if (s.row.dataset.swipeWs) swipeDeleteWs(s.row.dataset.swipeWs, s.row); else swipeDelete(s.row.dataset.swipe, s.row); return; }
  const open = s.dx < -s.reveal / 2;
  s.row.classList.toggle('open', open);
  s.row.classList.remove('commit');
  s.face.style.transform = open ? `translateX(${-s.reveal}px)` : '';
});
function swipeDelete(id, row) {
  if (!id) return;
  const sess = DB.sessions.find((x) => x.id === id);
  state.pendingDel.add(id);
  if (row) {
    row.classList.add('leaving');
    row.querySelector('.swipe-face').style.transform = 'translateX(-110%)';
  }
  setTimeout(() => render(), 240);
  toast(`Deleted “${sess ? sess.title : id}”`, 'trash', {
    ms: 5000,
    action: { label: 'Undo', fn: () => { state.pendingDel.delete(id); render(); } },
    onExpire: () => { state.pendingDel.delete(id); sessionDelete(id); },
  });
}
document.addEventListener('click', (e) => {
  const wsDel = e.target.closest('[data-swipe-ws-del]');
  if (wsDel) { e.stopPropagation(); swipeDeleteWs(wsDel.dataset.swipeWsDel, wsDel.closest('.swipe')); return; }
  const del = e.target.closest('[data-swipe-del]');
  if (!del) return;
  e.stopPropagation();
  swipeDelete(del.dataset.swipeDel, del.closest('.swipe'));
}, true);

/* A chip that stands in for a native <select>: data-value holds the pick, so forms read
   el.dataset.value. Used by the dispatch dialog's device and agent columns. */
function glideChip(field, options, value, label) {
  return `<button type="button" class="select glide-chip" data-t="${esc(field)}" data-glide="${esc(options.join('|'))}" data-value="${esc(value)}" aria-label="${esc(label)}" aria-haspopup="listbox" aria-expanded="false">${glideFace(field, value)}${ic('caret-down')}</button>`;
}
/* An agent chip shows the agent's logo and name; other chips their raw value. */
const agentOpt = (v) => ({ value: v, label: v === 'shell' ? 'Plain shell' : (AGENT_NAMES[v] || v), icon: agentLogo(v) });
function glideFace(field, v) {
  if (field !== 'agent') return `<span>${esc(v)}</span>`;
  const o = agentOpt(v);
  return `<b class="glide-face">${o.icon}<span>${esc(o.label)}</span></b>`;
}
document.addEventListener('click', (e) => {
  const chip = e.target.closest('[data-glide]');
  if (!chip) return;
  e.stopPropagation();
  glideSelect(chip, {
    options: chip.dataset.glide.split('|').map((v) => (chip.dataset.t === 'agent' ? agentOpt(v) : v)), value: chip.dataset.value, label: chip.getAttribute('aria-label') || 'Select',
    onPick: (v) => { chip.dataset.value = v; chip.firstElementChild.outerHTML = glideFace(chip.dataset.t, v); },
  });
});

/* Full swipe on a project header: the project leaves the sidebar now and is forgotten on the
   hub (its session rows go, files on disk stay) only when the Undo toast runs out. */
function swipeDeleteWs(ws, row) {
  if (!ws) return;
  const key = `ws:${ws}`;
  const n = DB.sessions.filter((s) => s.ws === ws).length;
  state.pendingDel.add(key);
  if (row) { row.classList.add('leaving'); row.querySelector('.swipe-face').style.transform = 'translateX(-110%)'; }
  setTimeout(() => render(), 240);
  toast(`Forgot ${ws} · ${n} session${n === 1 ? '' : 's'}`, 'trash', {
    ms: 5000,
    action: { label: 'Undo', fn: () => { state.pendingDel.delete(key); render(); } },
    onExpire: () => { state.pendingDel.delete(key); wsDelete(ws); },
  });
}

/* ---------- thought line ----------
   Port of React Bits' Thought Line. While working: a breathing glyph, a shimmering "Thinking…",
   a live clock and the trace beneath it. When it settles the label crossfades to
   "Thought for 4.1s" and the trace folds into the line; the line then toggles it. */

/* ---------- magic bento ----------
   Port of React Bits' Magic Bento for the overview cards: a spotlight that follows the cursor
   across the grid, a border glow on the cards near it and a ripple from the click point.
   Particles left out on purpose. No tilt or magnetism: moving a blurred glass card makes
   its backdrop render late. */
const BENTO = '.bento > .stat, .bento .card';
const BENTO_NEAR = 80, BENTO_FAR = 120;
let bentoSpot = null, bentoRaf = 0, bentoEv = null;
const stillMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches || document.documentElement.hasAttribute('data-reduce-motion');
function bentoFrame() {
  bentoRaf = 0;
  const e = bentoEv;
  const cards = document.querySelectorAll(BENTO);
  if (!cards.length) { if (bentoSpot) bentoSpot.style.opacity = '0'; return; }
  if (!bentoSpot) {
    bentoSpot = document.createElement('div');
    bentoSpot.className = 'bento-spot';
    bentoSpot.setAttribute('aria-hidden', 'true');
    document.body.append(bentoSpot);
  }
  let min = Infinity;
  cards.forEach((c) => {
    const r = c.getBoundingClientRect();
    const d = Math.max(0, Math.hypot(e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2)) - Math.max(r.width, r.height) / 2);
    min = Math.min(min, d);
    const k = d <= BENTO_NEAR ? 1 : d <= BENTO_FAR ? (BENTO_FAR - d) / (BENTO_FAR - BENTO_NEAR) : 0;
    // Only touch cards the glow reaches: writing three properties to every card on every
    // pointer move repainted all of them each frame, which flickered on the GPU.
    if (!k && c._glow === 0) return;
    c._glow = k;
    if (k) {
      c.style.setProperty('--glow-x', `${((e.clientX - r.left) / r.width) * 100}%`);
      c.style.setProperty('--glow-y', `${((e.clientY - r.top) / r.height) * 100}%`);
    }
    c.style.setProperty('--glow-intensity', k.toFixed(3));
  });
  bentoSpot.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`;
  bentoSpot.style.opacity = min <= BENTO_NEAR ? '.8' : min <= BENTO_FAR ? String(((BENTO_FAR - min) / (BENTO_FAR - BENTO_NEAR)) * .8) : '0';
}
document.addEventListener('pointermove', (e) => {
  bentoEv = e;
  if (!bentoRaf) bentoRaf = requestAnimationFrame(bentoFrame);
}, { passive: true });
document.documentElement.addEventListener('pointerleave', () => { if (bentoSpot) bentoSpot.style.opacity = '0'; });
document.addEventListener('click', (e) => {
  const card = e.target.closest(BENTO);
  if (!card || stillMotion()) return;
  const r = card.getBoundingClientRect();
  const x = e.clientX - r.left, y = e.clientY - r.top;
  const d = Math.max(Math.hypot(x, y), Math.hypot(x - r.width, y), Math.hypot(x, y - r.height), Math.hypot(x - r.width, y - r.height));
  const rip = document.createElement('i');
  rip.className = 'bento-ripple';
  rip.setAttribute('aria-hidden', 'true');
  rip.style.cssText = `left:${x - d}px;top:${y - d}px;width:${d * 2}px;height:${d * 2}px`;
  card.append(rip);
  setTimeout(() => rip.remove(), 820);
});

/* ---------- animated list ----------
   Port of React Bits' Animated List: rows scale and fade in as they enter view and out as they
   leave, the scroller fades at whichever edge has more, arrows move a selection and Enter opens
   it. Rows already seen skip the entrance, so the poll re-render does not replay it. */
const alistSeen = new Set(), alistSel = {};
let alistIO = null;
function alistMount() {
  if (alistIO) alistIO.disconnect();
  alistIO = new IntersectionObserver((ents) => ents.forEach((en) => {
    en.target.classList.toggle('al-in', en.isIntersecting);
    if (en.isIntersecting) alistSeen.add(en.target.dataset.al);
  }), { threshold: .5 });
  document.querySelectorAll('[data-alist]').forEach((list) => {
    list.querySelectorAll('[data-al]').forEach((it) => {
      if (alistSeen.has(it.dataset.al)) it.classList.add('al-in', 'al-now');
      it.classList.toggle('al-sel', alistSel[list.dataset.alist] === it.dataset.al);
      alistIO.observe(it);
    });
    alistEdges(list);
  });
  requestAnimationFrame(() => requestAnimationFrame(() => document.querySelectorAll('.al-now').forEach((it) => it.classList.remove('al-now'))));
}
function alistEdges(list) {
  const sc = list.scrollHeight > list.clientHeight + 1;
  list.classList.toggle('al-fade-t', sc && list.scrollTop > 2);
  list.classList.toggle('al-fade-b', sc && list.scrollTop + list.clientHeight < list.scrollHeight - 2);
}
document.addEventListener('scroll', (e) => { if (e.target.dataset && e.target.dataset.alist) alistEdges(e.target); }, true);
function alistPick(list, it) {
  list.querySelectorAll('.al-sel').forEach((x) => x.classList.remove('al-sel'));
  if (!it) return;
  it.classList.add('al-sel');
  alistSel[list.dataset.alist] = it.dataset.al;
}
document.addEventListener('pointerover', (e) => {
  const it = e.target.closest && e.target.closest('[data-alist] [data-al]');
  if (it) alistPick(it.closest('[data-alist]'), it);
});
document.addEventListener('keydown', (e) => {
  const list = e.target.closest && e.target.closest('[data-alist]');
  if (!list || e.target !== list || !['ArrowDown', 'ArrowUp', 'Enter'].includes(e.key)) return;
  const items = [...list.querySelectorAll('[data-al]')];
  if (!items.length) return;
  const cur = items.findIndex((x) => x.classList.contains('al-sel'));
  e.preventDefault();
  if (e.key === 'Enter') { const it = items[cur]; if (it) (it.querySelector('[data-session]') || it).click(); return; }
  const next = items[Math.max(0, Math.min(items.length - 1, cur < 0 ? 0 : cur + (e.key === 'ArrowDown' ? 1 : -1)))];
  alistPick(list, next);
  next.scrollIntoView({ block: 'nearest', behavior: stillMotion() ? 'auto' : 'smooth' });
});

/* ---------- click spark ----------
   Port of React Bits' Click Spark: eight short strokes burst from every click, in the accent.
   One fixed canvas over the window, drawn only while sparks are alive. */
(() => {
  const cv = document.createElement('canvas');
  cv.className = 'click-spark';
  cv.setAttribute('aria-hidden', 'true');
  document.body.append(cv);
  const ctx = cv.getContext('2d');
  const DUR = 400, RADIUS = 15, SIZE = 10, COUNT = 8;
  let bursts = [], raf = 0;
  const fit = () => { const d = window.devicePixelRatio || 1; cv.width = innerWidth * d; cv.height = innerHeight * d; ctx.setTransform(d, 0, 0, d, 0, 0); };
  fit();
  window.addEventListener('resize', fit);
  const draw = (now) => {
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    bursts = bursts.filter((b) => now - b.t < DUR);
    for (const b of bursts) {
      const p = (now - b.t) / DUR, ease = p * (2 - p);
      const dist = ease * RADIUS, len = SIZE * (1 - ease);
      ctx.strokeStyle = b.c; ctx.lineWidth = 2; ctx.lineCap = 'round';
      for (let i = 0; i < COUNT; i++) {
        const a = (2 * Math.PI * i) / COUNT;
        ctx.beginPath();
        ctx.moveTo(b.x + dist * Math.cos(a), b.y + dist * Math.sin(a));
        ctx.lineTo(b.x + (dist + len) * Math.cos(a), b.y + (dist + len) * Math.sin(a));
        ctx.stroke();
      }
    }
    raf = bursts.length ? requestAnimationFrame(draw) : 0;
  };
  document.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || stillMotion()) return;
    const c = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#fff';
    bursts.push({ x: e.clientX, y: e.clientY, t: performance.now(), c });
    if (!raf) raf = requestAnimationFrame(draw);
  }, true);
})();

/* ---------- button tooltip ----------
   Same chip as the collapsed rail's tooltip, for every other button that has a title: it sits
   above the button (below when there is no room) with an arrow pointing at it. The native title
   moves to data-tip on first hover so the browser's own tooltip never doubles it; aria-label
   keeps the accessible name. Buttons whose visible text already says the same thing are skipped. */
(() => {
  const tip = document.createElement('div');
  tip.className = 'railtip btntip';
  tip.hidden = true;
  tip.setAttribute('role', 'tooltip');
  document.body.append(tip);
  const RAIL = '.sidebar.collapsed .navitem, .sidebar.collapsed .ws-row, .sidebar.collapsed .ws-all';
  let cur = null, timer = 0;
  const hide = () => { clearTimeout(timer); cur = null; tip.hidden = true; };
  const show = (el) => {
    const text = el.dataset.tip;
    if (!text || !el.isConnected) return;
    tip.textContent = text;
    tip.hidden = false;
    const r = el.getBoundingClientRect();
    const w = tip.offsetWidth, h = tip.offsetHeight;
    const below = r.top - h - 10 < 4;
    tip.classList.toggle('below', below);
    const left = Math.max(6, Math.min(r.left + r.width / 2 - w / 2, window.innerWidth - w - 6));
    tip.style.left = Math.round(left) + 'px';
    tip.style.top = Math.round(below ? r.bottom + 8 : r.top - h - 8) + 'px';
    tip.style.setProperty('--arrow-x', Math.round(r.left + r.width / 2 - left) + 'px');
  };
  document.addEventListener('mouseover', (e) => {
    const el = e.target.closest && e.target.closest('button[title], [role="button"][title], .link[title], button[data-tip], [data-tip]');
    if (el === cur) return;
    hide();
    if (!el || el.closest(RAIL) || el.closest('.xterm, .glide')) return;
    if (el.hasAttribute('title')) {
      const t = el.getAttribute('title');
      el.removeAttribute('title');
      if (!t.trim() || t.trim() === el.textContent.trim()) return;
      el.dataset.tip = t;
      if (!el.hasAttribute('aria-label') && !el.textContent.trim()) el.setAttribute('aria-label', t);
    }
    cur = el;
    timer = setTimeout(() => show(el), 120);
  });
  document.addEventListener('mouseout', (e) => { if (cur && !cur.contains(e.relatedTarget)) hide(); });
  document.addEventListener('pointerdown', hide, true);
  document.addEventListener('scroll', hide, true);
  window.addEventListener('blur', hide);
})();

/* Page enter, Kindra-style. CSS does the motion; this sets the block order (--ci, document order)
   and counts stat numbers up from zero with an expo ease. Called by render() on navigation only. */
const ENTER_BLOCKS = '.page-head, .ov-actions, .ov-search, .ov-hero, .ov-quick, .stat, .card, .toolbar, .board, .split > :not(:has(.card, .stat))';
function pageEnter(root) {
  if (!root) return;
  root.querySelectorAll(ENTER_BLOCKS).forEach((el, i) => el.style.setProperty('--ci', Math.min(i, 12)));
  if (!stillMotion()) root.querySelectorAll('.stat .val b').forEach(countUp);
}
/* "~$18478.50" → ["~$", 18478.5, 2 decimals, no commas, ""]; null when there is no number. */
function parseCount(text) {
  const m = String(text).match(/^(\D*?)(\d[\d,]*(?:\.\d+)?)(.*)$/s);
  return m && { pre: m[1], n: parseFloat(m[2].replace(/,/g, '')), dec: (m[2].split('.')[1] || '').length, comma: m[2].includes(','), post: m[3] };
}
const fmtCount = (c, v) => c.pre + (c.comma ? v.toLocaleString('en-US', { minimumFractionDigits: c.dec, maximumFractionDigits: c.dec }) : v.toFixed(c.dec)) + c.post;
function countUp(el) {
  const c = parseCount(el.textContent);
  if (!c || !c.n) return;
  const t0 = performance.now(), dur = 1100;
  const step = (t) => {
    const p = Math.min(1, Math.max(0, (t - t0) / dur));   // a frame stamp can predate t0: never count below zero
    el.textContent = fmtCount(c, p === 1 ? c.n : c.n * (1 - 2 ** (-10 * p)));
    if (p < 1 && el.isConnected) requestAnimationFrame(step);
  };
  el.textContent = fmtCount(c, 0);
  requestAnimationFrame(step);
}
console.assert(fmtCount(parseCount('~$18478.50'), 18478.5) === '~$18478.50', 'countUp: cost');
console.assert(fmtCount(parseCount('16,198,625,202'), 16198625202) === '16,198,625,202', 'countUp: commas');
console.assert(fmtCount(parseCount('294K'), 294) === '294K' && parseCount('—') === null, 'countUp: suffix / none');

/* Grainient drift: one Web Animation per gradient element, all started at page time 0, so every
   gradient is in phase and a node created by a later render picks up where the others are. */
const GRAIN = '[data-grainient], .btn.accent, .send-btn, .chat-input .send, .titlebar .logo, .avatar:not(:has(img))';
const GRAIN_KF = [{ backgroundPosition: '0 0, 0% 30%' }, { backgroundPosition: '0 0, 100% 70%' }];
function grainOne(el) {
  if (el._grain || stillMotion()) return;
  el._grain = el.animate(GRAIN_KF, { duration: 14000, iterations: Infinity, direction: 'alternate', easing: 'ease-in-out' });
  el._grain.pause();
  el._grain.currentTime = performance.now();
}
/* A paused animation asks for no frames; this steps every gradient on the page clock 10 times a
   second (a 14 s drift looks the same), and not at all while the window is hidden or unfocused. */
setInterval(() => {
  if (document.hidden || !document.hasFocus()) return;
  const t = performance.now();
  document.querySelectorAll(GRAIN).forEach((el) => { if (el._grain) el._grain.currentTime = t; });
}, 100);
function grainSync(root) {
  if (root.nodeType !== 1) return;
  if (root.matches(GRAIN)) grainOne(root);
  root.querySelectorAll(GRAIN).forEach(grainOne);
}
grainSync(document.body);
new MutationObserver((list) => list.forEach((m) => {
  if (m.type === 'attributes') grainSync(m.target);
  else m.addedNodes.forEach(grainSync);
})).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'data-grainient'] });
