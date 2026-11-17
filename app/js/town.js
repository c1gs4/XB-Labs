/* Town: every session is a resident of a small pixel town.
   running -> works at a desk in the Office, waiting for approval -> Mess hall,
   queued -> commuting on the road, idle (no live run) -> strolls in the Park.
   One static map canvas; each view (the Town page, the session's live preview) is a camera that
   scales it, then draws traffic, residents and crisp name tags at whole device pixels. */
const TW = 1024, TH = 640;
const TOWN = { map: null, W: TW, H: TH, mx: 0, my: 0, agents: new Map(), hover: null, focus: null, raf: 0, t: 0, cams: {} };
const TOWN_LABEL = { office: 'In the office', mess: 'Waiting in the mess hall', park: 'In the park', road: 'Commuting' };

function townRng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
function townHash(str) { let h = 2166136261; for (const c of String(str)) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; }

const T_ZONE = {
  office: { x: 60, y: 60, w: 380, h: 200, name: 'OFFICE' },
  mess: { x: 584, y: 60, w: 380, h: 200, name: 'MESS HALL' },
  park: { x: 60, y: 372, w: 380, h: 228 },
  homes: { x: 584, y: 372, w: 380, h: 104 },
  lot: { x: 584, y: 504, w: 380, h: 96 },
};
const T_DESKS = [];
for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) T_DESKS.push({ x: 96 + c * 86, y: 100 + r * 52 });
const T_HOMES = Array.from({ length: 6 }, (_, i) => ({ x: 596 + i * 62, y: 384 }));
const T_LAMPS = [[120, 292], [300, 292], [660, 292], [860, 292], [120, 340], [300, 340], [660, 340], [860, 340], [488, 120], [536, 200], [488, 460], [536, 560]];

/* ---------- static map ---------- */
function townDrawMap(W, H, mx, my) {
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  const rnd = townRng(7);
  const R = (c, x, y, w, h) => { g.fillStyle = c; g.fillRect(x, y, w, h); };

  // grass: base, two-tone speckle, a few flower dots
  R('#5b8a3a', 0, 0, W, H);
  for (let i = 0; i < (W * H) / 220; i++) R(rnd() < .5 ? '#66973f' : '#517d33', (rnd() * W) | 0, (rnd() * H) | 0, 2, 2);
  for (let i = 0; i < (W * H) / 4000; i++) R(['#f2e18a', '#f4f1ea', '#e79bb4'][(rnd() * 3) | 0], (rnd() * W) | 0, (rnd() * H) | 0, 2, 2);

  // roads with kerbs, sidewalks and centre dashes
  const road = (x, y, w, h, vert) => {
    R('#b3ae9f', x - (vert ? 8 : 0), y - (vert ? 0 : 8), w + (vert ? 16 : 0), h + (vert ? 0 : 16));
    g.fillStyle = '#9d988a';
    if (vert) for (let yy = y; yy < y + h; yy += 12) { g.fillRect(x - 8, yy, 8, 1); g.fillRect(x + w, yy, 8, 1); }
    else for (let xx = x; xx < x + w; xx += 12) { g.fillRect(xx, y - 8, 1, 8); g.fillRect(xx, y + h, 1, 8); }
    R('#393b40', x, y, w, h);
    R('#2f3135', vert ? x : x, vert ? y : y, vert ? 2 : w, vert ? h : 2);
    g.fillStyle = '#e2c95e';
    if (vert) for (let yy = y + 4; yy < y + h; yy += 20) g.fillRect(x + w / 2 - 1, yy, 2, 10);
    else for (let xx = x + 4; xx < x + w; xx += 20) g.fillRect(xx, y + h / 2 - 1, 10, 2);
  };
  road(0, 300 + my, W, 32, false);
  road(496 + mx, 0, 32, H, true);
  R('#393b40', 496 + mx, 300 + my, 32, 32);
  g.translate(mx, my);
  for (let i = 0; i < 6; i++) { R('#ece8dc', 470, 302 + i * 5, 20, 3); R('#ece8dc', 534, 302 + i * 5, 20, 3); R('#ece8dc', 498 + i * 5, 274, 3, 20); R('#ece8dc', 498 + i * 5, 338, 3, 20); }

  // building shell: drop shadow, thick wall with windows on the top edge, floor, door, sign
  const shell = (z, wall, floor) => {
    R('#00000038', z.x + 6, z.y + 8, z.w, z.h);
    R(wall, z.x, z.y, z.w, z.h);
    R('#ffffff14', z.x, z.y, z.w, 2);
    for (let x = z.x + 24; x < z.x + z.w - 24; x += 40) { R('#9fd4ef', x, z.y + 2, 18, 4); R('#d9f1ff', x, z.y + 2, 6, 4); }
    floor(z.x + 6, z.y + 8, z.w - 12, z.h - 14);
    R('#00000030', z.x + 6, z.y + 8, z.w - 12, 3); // wall shadow on floor
    R('#c9a86a', z.x + z.w / 2 - 14, z.y + z.h - 6, 28, 6);
    R('#d8b97c', z.x + z.w / 2 - 14, z.y + z.h, 28, 32);
    R('#bfa064', z.x + z.w / 2 - 14, z.y + z.h, 2, 32); R('#bfa064', z.x + z.w / 2 + 12, z.y + z.h, 2, 32);
    R('#1c1f26', z.x + 10, z.y - 14, z.name.length * 6 + 14, 13); R('#f2c94c', z.x + 10, z.y - 14, 3, 13);
    g.fillStyle = '#f4f1ea'; g.font = 'bold 8px monospace'; g.fillText(z.name, z.x + 18, z.y - 4);
  };
  const plant = (x, y) => { R('#00000030', x + 1, y + 11, 12, 3); R('#8a5a34', x + 2, y + 7, 10, 6); R('#2f7a3a', x, y, 14, 9); R('#46a04f', x + 2, y + 1, 7, 5); R('#6cc46a', x + 4, y + 2, 2, 2); };

  // office: carpet tiles with grain, desks, orange chairs, monitors, cooler, printer, rug
  const O = T_ZONE.office;
  shell(O, '#262b36', (x, y, w, h) => {
    R('#6e5a4c', x, y, w, h);
    for (let yy = y; yy < y + h; yy += 16) for (let xx = x; xx < x + w; xx += 16) R(((xx + yy) / 16) & 1 ? '#735e4f' : '#685447', xx, yy, 16, 16);
    for (let i = 0; i < w * h / 30; i++) R(rnd() < .5 ? '#7d6756' : '#5f4c40', x + ((rnd() * w) | 0), y + ((rnd() * h) | 0), 1, 1);
  });
  R('#a2492f', O.x + 160, O.y + 150, 70, 36); R('#c25a3a', O.x + 164, O.y + 154, 62, 28);
  T_DESKS.forEach((d) => {
    R('#00000033', d.x + 2, d.y + 3, 46, 18);
    R('#4b3423', d.x, d.y, 46, 17); R('#6c4a30', d.x, d.y, 46, 3);
    [8, 26].forEach((o) => { R('#14181f', d.x + o, d.y - 7, 13, 9); R('#2d3748', d.x + o + 1, d.y - 6, 11, 6); R('#14181f', d.x + o + 5, d.y + 2, 3, 2); });
    R('#c9ccd2', d.x + 10, d.y + 8, 10, 3); R('#c9ccd2', d.x + 28, d.y + 8, 10, 3);
    [4, 30].forEach((o) => { R('#00000030', d.x + o + 1, d.y + 23, 11, 3); R('#d9772f', d.x + o, d.y + 19, 11, 8); R('#f09445', d.x + o + 1, d.y + 19, 9, 2); });
  });
  plant(O.x + 10, O.y + 12); plant(O.x + O.w - 24, O.y + 12); plant(O.x + 10, O.y + O.h - 28); plant(O.x + O.w - 24, O.y + O.h - 28);
  R('#d8dde4', O.x + O.w - 44, O.y + 120, 12, 16); R('#7fc4ee', O.x + O.w - 42, O.y + 114, 8, 7);       // water cooler
  R('#3a3f4a', O.x + O.w - 52, O.y + 150, 22, 14); R('#e6e8ec', O.x + O.w - 48, O.y + 148, 14, 4);      // printer

  // mess hall: plank floor, long tables with stools, counter with food, rug, plants
  const M = T_ZONE.mess;
  shell(M, '#3a291d', (x, y, w, h) => {
    R('#b5844f', x, y, w, h);
    for (let yy = y; yy < y + h; yy += 7) { R('#a3743f', x, yy, w, 1); for (let xx = x + ((yy * 13) % 50); xx < x + w; xx += 50) R('#9a6c3a', xx, yy, 1, 7); }
  });
  R('#7c3b3b', M.x + 220, M.y + 70, 126, 92); R('#9a5151', M.x + 226, M.y + 76, 114, 80); R('#c9a24a', M.x + 268, M.y + 104, 30, 22);
  for (let i = 0; i < 3; i++) {
    R('#00000030', M.x + 32, M.y + 44 + i * 50, 140, 15);
    R('#5a3a22', M.x + 30, M.y + 40 + i * 50, 140, 15); R('#7a5236', M.x + 30, M.y + 40 + i * 50, 140, 3);
    for (let k = 0; k < 6; k++) { R('#e3e0d8', M.x + 40 + k * 22, M.y + 45 + i * 50, 6, 4); R('#6d4a2c', M.x + 36 + k * 22, M.y + 32 + i * 50, 10, 6); R('#6d4a2c', M.x + 36 + k * 22, M.y + 57 + i * 50, 10, 6); }
  }
  R('#4b4f57', M.x + 20, M.y + 12, 340, 13); R('#62666e', M.x + 20, M.y + 12, 340, 3);
  [['#d2d6de', 40], ['#e0763a', 90], ['#f2c94c', 120], ['#5ab88a', 150], ['#d2d6de', 200]].forEach(([c, x]) => R(c, M.x + x, M.y + 15, 16, 7));
  plant(M.x + M.w - 24, M.y + M.h - 28); plant(M.x + 10, M.y + M.h - 28);

  // park: lawn, paths, pond with lily pads, fountain, benches, flower beds
  const P = T_ZONE.park;
  R('#69993f', P.x, P.y, P.w, P.h); R('#5a8a36', P.x, P.y, P.w, 2);
  R('#d2bb85', P.x, P.y + P.h / 2 - 6, P.w, 12); R('#d2bb85', P.x + P.w / 2 - 6, P.y, 12, P.h);
  g.fillStyle = '#2f6e9c'; g.beginPath(); g.ellipse(P.x + 95, P.y + 62, 50, 30, 0, 0, 7); g.fill();
  g.fillStyle = '#3f86b8'; g.beginPath(); g.ellipse(P.x + 95, P.y + 60, 44, 25, 0, 0, 7); g.fill();
  g.fillStyle = '#6aaed8'; g.beginPath(); g.ellipse(P.x + 84, P.y + 52, 20, 7, 0, 0, 7); g.fill();
  [[70, 70], [112, 58], [100, 76]].forEach(([x, y]) => R('#4f9a46', P.x + x, P.y + y, 6, 4));
  R('#9ea4ad', P.x + P.w / 2 - 16, P.y + P.h / 2 - 16, 32, 32); R('#7f858e', P.x + P.w / 2 - 12, P.y + P.h / 2 - 12, 24, 24); R('#5fa6d6', P.x + P.w / 2 - 9, P.y + P.h / 2 - 9, 18, 18); R('#cfe9f8', P.x + P.w / 2 - 2, P.y + P.h / 2 - 2, 4, 4);
  [[P.x + 250, P.y + 92], [P.x + 112, P.y + 152], [P.x + 280, P.y + 172]].forEach(([x, y]) => { R('#00000030', x + 1, y + 8, 28, 3); R('#7a5434', x, y, 28, 4); R('#8f6440', x, y + 4, 28, 3); R('#4a3220', x + 2, y + 7, 2, 4); R('#4a3220', x + 24, y + 7, 2, 4); });
  [[P.x + 230, P.y + 20], [P.x + 20, P.y + 140]].forEach(([x, y]) => { R('#6b4a2c', x, y, 60, 18); for (let i = 0; i < 18; i++) R(['#e85d75', '#f2c94c', '#f4f1ea', '#b36be0'][i % 4], x + 4 + (i % 9) * 6, y + 3 + ((i / 9) | 0) * 7, 4, 4); });

  // homes: shingled roofs, chimney, windows, door, fence and a small garden
  const roofs = [['#b4483e', '#8f352d'], ['#3e6fb4', '#2f568f'], ['#b48a3e', '#8f6c2f'], ['#6b3eb4', '#532f8f'], ['#3e9a6b', '#2f7a54'], ['#b43e7a', '#8f2f60']];
  T_HOMES.forEach((h, i) => {
    R('#00000038', h.x + 4, h.y + 6, 50, 70);
    R('#ece2cc', h.x, h.y + 26, 50, 44); R('#d6cab0', h.x, h.y + 66, 50, 4);
    R(roofs[i][0], h.x - 3, h.y, 56, 28);
    for (let y = h.y + 4; y < h.y + 26; y += 5) R(roofs[i][1], h.x - 3, y, 56, 1);
    R('#00000030', h.x - 3, h.y + 25, 56, 3);
    R('#7a6a5a', h.x + 38, h.y - 6, 7, 10);
    R('#5a3a22', h.x + 20, h.y + 50, 10, 20); R('#f2c94c', h.x + 27, h.y + 60, 1, 2);
    [6, 35].forEach((o) => { R('#5b4a3a', h.x + o - 1, h.y + 35, 11, 10); R('#9fd4ef', h.x + o, h.y + 36, 9, 8); R('#d9f1ff', h.x + o, h.y + 36, 3, 3); });
    R('#d8b97c', h.x + 21, h.y + 70, 8, 8);
    for (let x = h.x - 3; x < h.x + 53; x += 4) { if (x < h.x + 19 || x > h.x + 29) R('#e9e4d6', x, h.y + 82, 2, 6); }
    R('#e9e4d6', h.x - 3, h.y + 84, 56, 1);
  });

  // parking lot
  const L = T_ZONE.lot;
  R('#45474d', L.x, L.y, L.w, L.h); R('#3a3c41', L.x, L.y, L.w, 2);
  for (let i = 0; i <= 10; i++) R('#d8d4c8', L.x + 10 + i * 36, L.y + 8, 2, 32);
  ['#c94f4f', '#4f7fc9', '#e0c04a', '#e8e8e8', '#4fc98a'].forEach((c, i) => {
    const x = L.x + 16 + [0, 2, 3, 6, 8][i] * 36;
    R('#00000040', x + 2, L.y + 14, 24, 24); R(c, x, L.y + 12, 24, 24); R('#ffffff30', x, L.y + 12, 24, 3);
    R('#1d2733', x + 3, L.y + 16, 18, 6); R('#1d2733', x + 3, L.y + 29, 18, 4);
  });

  // street lamps (glow is drawn per frame, at night)
  T_LAMPS.forEach(([x, y]) => { R('#00000030', x + 1, y + 1, 3, 3); R('#3d4048', x, y - 10, 2, 11); R('#e9e1b8', x - 1, y - 12, 4, 3); });

  // trees and bushes: never on anything built
  const solid = [O, M, P, T_ZONE.homes, L, { x: -mx, y: 284, w: W, h: 64 }, { x: 480, y: -my, w: 64, h: H }];
  const hit = (x, y) => solid.some((z) => x > z.x - 14 && x < z.x + z.w + 8 && y > z.y - 24 && y < z.y + z.h + 16);
  const tree = (x, y) => {
    g.fillStyle = '#00000038'; g.beginPath(); g.ellipse(x + 2, y + 7, 11, 4, 0, 0, 7); g.fill();
    R('#5e3f25', x - 1, y - 2, 4, 9);
    g.fillStyle = '#2c6a2e'; g.beginPath(); g.arc(x + 1, y - 10, 11, 0, 7); g.fill();
    g.fillStyle = '#3d8a39'; g.beginPath(); g.arc(x - 1, y - 12, 8, 0, 7); g.fill();
    g.fillStyle = '#5aa84c'; g.beginPath(); g.arc(x - 3, y - 15, 4, 0, 7); g.fill();
  };
  const bush = (x, y) => { g.fillStyle = '#2f7034'; g.beginPath(); g.arc(x, y, 5, 0, 7); g.arc(x + 6, y + 1, 4, 0, 7); g.fill(); R('#5aa84c', x - 2, y - 3, 2, 2); };
  for (let i = 0; i < (W * H) / 2600; i++) { const x = rnd() * W - mx, y = rnd() * H - my; if (!hit(x, y)) (rnd() < .78 ? tree : bush)(x | 0, y | 0); }
  [[P.x + 200, P.y + 48], [P.x + 336, P.y + 50], [P.x + 40, P.y + 200], [P.x + 230, P.y + 206], [P.x + 336, P.y + 130], [P.x + 160, P.y + 30]].forEach(([x, y]) => tree(x, y));
  return cv;
}

/* ---------- residents ---------- */
function townPlace(s) {
  const st = (s.live && s.live.status) || '';
  if (s.col === 'waiting' || st === 'waiting') return 'mess';
  if (s.col === 'running') return 'office';
  if (s.col === 'queued') return 'road';
  return 'park';
}
function townSpot(a, rnd) {
  const pick = (z, pad = 16) => ({ x: z.x + pad + rnd() * (z.w - pad * 2), y: z.y + pad + rnd() * (z.h - pad * 2) });
  if (a.place === 'office') { const d = T_DESKS[a.slot % T_DESKS.length]; return { x: d.x + (a.slot >= T_DESKS.length ? 35 : 9), y: d.y + 25, sit: true }; }
  if (a.place === 'park') { // stroll the cross paths, clear of the fountain
    const P = T_ZONE.park, along = rnd() < .5, off = (rnd() < .5 ? -1 : 1) * (28 + rnd() * ((along ? P.w : P.h) / 2 - 44));
    return along ? { x: P.x + P.w / 2 + off, y: P.y + P.h / 2 + (rnd() - .5) * 6 } : { x: P.x + P.w / 2 + (rnd() - .5) * 6, y: P.y + P.h / 2 + off };
  }
  if (a.place === 'road') return { x: 512 + (rnd() - .5) * 12, y: 40 + rnd() * 540 };
  return pick(T_ZONE.mess, 34);
}
/* A spot no other resident is heading to or standing on, so two never stand stacked. */
function townTarget(a, rnd) {
  let g;
  for (let i = 0; i < 8; i++) {
    g = townSpot(a, rnd);
    if (g.sit) return g;
    const clash = [...TOWN.agents.values()].some((b) => b !== a && (Math.hypot((b.goal ? b.goal.x : b.x) - g.x, (b.goal ? b.goal.y : b.y) - g.y) < 14 || Math.hypot(b.x - g.x, b.y - g.y) < 14));
    if (!clash) return g;
  }
  return g;
}
function townSync() {
  const live = new Set();
  const bySlot = { office: 0, park: 0, mess: 0, road: 0 };
  (DB.sessions || []).forEach((s) => {
    live.add(s.id);
    let a = TOWN.agents.get(s.id);
    const place = townPlace(s);
    if (!a) {
      const h = townHash(s.id);
      a = { id: s.id, rnd: townRng(h), x: 512, y: 316, place: null,
        hair: ['#2b1d14', '#6b3f1f', '#d8b15a', '#1b1b1b', '#9c4a2e'][h % 5],
        skin: ['#f0c8a0', '#d9a77a', '#a8754c', '#f4d5b8'][(h >>> 5) % 4],
        shirt: ['#d65a4a', '#4a7fd6', '#e0b84a', '#5ab88a', '#a65ad6', '#e07a3a'][(h >>> 3) % 6] };
      TOWN.agents.set(s.id, a);
    }
    a.title = s.title; a.col = s.col; a.agent = s.agent;
    a.slot = bySlot[place]++;
    if (a.place !== place) { a.place = place; a.goal = townTarget(a, a.rnd); a.wait = 0; }
  });
  [...TOWN.agents.keys()].forEach((id) => { if (!live.has(id)) TOWN.agents.delete(id); });
  if (TOWN.focus && !TOWN.agents.has(TOWN.focus)) TOWN.focus = null;
}

/* Buildings have one door (bottom centre). Leave through it, enter through it. */
const townIn = (a, z) => a.x > z.x && a.x < z.x + z.w && a.y > z.y && a.y < z.y + z.h;
function townVia(a) {
  const cur = ['office', 'mess'].find((k) => townIn(a, T_ZONE[k]));
  if (cur && cur !== a.place) {
    const z = T_ZONE[cur], door = z.x + z.w / 2;
    return Math.abs(a.x - door) > 3 ? [door, z.y + z.h - 14] : [door, z.y + z.h + 20];
  }
  const z = !cur && T_ZONE[a.place];
  if (z && (a.place === 'office' || a.place === 'mess')) {
    const door = z.x + z.w / 2;
    return Math.abs(a.x - door) > 3 || a.y > z.y + z.h + 26 ? [door, z.y + z.h + 18] : [door, z.y + z.h - 16];
  }
  return [a.goal.x, a.goal.y];
}
function townStep(dt) {
  TOWN.agents.forEach((a) => {
    if (!a.goal) a.goal = townTarget(a, a.rnd);
    const [gx, gy] = townVia(a);
    const dx = gx - a.x, dy = gy - a.y, d = Math.hypot(dx, dy);
    const sp = (a.place === 'road' ? 34 : 22) * dt;
    if (d <= 1 && (gx !== a.goal.x || gy !== a.goal.y)) { a.x = gx; a.y = gy; return; } // waypoint reached
    if (d > 1) { a.x += (dx / d) * Math.min(sp, d); a.y += (dy / d) * Math.min(sp, d); a.moving = true; a.face = dx < 0 ? -1 : 1; return; }
    a.moving = false;
    if (a.goal.sit) return;
    if ([...TOWN.agents.values()].some((b) => b !== a && !b.moving && Math.hypot(b.x - a.x, b.y - a.y) < 8)) { a.wait = 0; a.goal = townTarget(a, a.rnd); return; }
    a.wait = (a.wait || 0) + dt;
    if (a.wait > 2 + a.rnd() * 4) { a.wait = 0; a.goal = townTarget(a, a.rnd); }
  });
}

/* 10x16 sprite with outline, two-frame walk, arms, and a typing pose at the desk. */
/* Drawn at 1x into the resident's own small canvas, foot at (fx, fy); views scale that canvas to a
   device-pixel position, so motion is sub-map-pixel smooth while the art stays crisp. */
function townDrawAgent(g, a, t, fx, fy) {
  if (a.ph == null) a.ph = a.rnd() * 6;
  const step = a.moving ? (Math.sin(t * 11 + a.ph) > 0 ? 1 : 0) : 0;
  const sit = a.goal && a.goal.sit && !a.moving;
  const x = fx - 5, y = fy - 16 + (sit ? 2 : 0);
  const R = (c, xx, yy, w, h) => { g.fillStyle = c; g.fillRect(x + xx, y + yy, w, h); };
  const f = a.face < 0;
  g.fillStyle = '#00000045'; g.beginPath(); g.ellipse(x + 5, y + 16 - (sit ? 2 : 0), 6, 2, 0, 0, 7); g.fill();
  R('#1a1c22', 0, 1, 10, 13);                                           // outline
  if (!sit) { R('#2b2f3a', 2, 12, 2, 3 + (step ? 0 : 1)); R('#2b2f3a', 6, 12, 2, 3 + step); R('#15171c', 2, 14 + (step ? 0 : 1), 2, 1); R('#15171c', 6, 14 + step, 2, 1); }
  R(a.shirt, 1, 7, 8, 6); R('#ffffff26', 1, 7, 8, 1);                   // body
  const arm = sit ? Math.round(Math.sin(t * 18 + a.ph)) : step ? 1 : 0;
  R(a.shirt, -1, 8 + arm, 2, 4); R(a.shirt, 9, 8 - arm, 2, 4);          // arms
  R(a.skin, -1, 12 + arm, 2, 1); R(a.skin, 9, 12 - arm, 2, 1);
  R(a.skin, 2, 2, 6, 5);                                                 // face
  R(a.hair, 1, 0, 8, 3); R(a.hair, f ? 7 : 1, 3, 2, 2);
  R('#1b1b1b', f ? 3 : 6, 4, 1, 1);
  if (a.col === 'waiting') { const b = Math.round(Math.sin(t * 4) * 1.5); R('#1a1c22', 3, -11 + b, 6, 9); R('#f2c94c', 4, -10 + b, 4, 7); R('#1b1b1b', 5, -9 + b, 2, 3); R('#1b1b1b', 5, -5 + b, 2, 1); }
}

/* ---------- frame ---------- */
function townViews() {
  return [document.getElementById('town-cv'), ...document.querySelectorAll('.town-mini')].filter(Boolean);
}
function townNight() {
  const d = new Date(), h = d.getHours() + d.getMinutes() / 60;
  return h < 6 || h > 19 ? .4 : h < 7 ? (7 - h) * .4 : h > 18 ? (h - 18) * .4 : 0;
}
const SPR_W = 22, SPR_H = 36, SPR_FX = 11, SPR_FY = 31;
function townSprite(a, t) {
  if (!a.spr) { a.spr = document.createElement('canvas'); a.spr.width = SPR_W; a.spr.height = SPR_H; }
  const g = a.spr.getContext('2d');
  g.clearRect(0, 0, SPR_W, SPR_H);
  townDrawAgent(g, a, t, SPR_FX, SPR_FY);
  return a.spr;
}

/* A view's camera eases toward its target: the whole town, or one resident up close. */
function townCam(cv, dt) {
  const key = cv.id || 'mini:' + cv.dataset.track;
  const mini = cv.classList.contains('town-mini');
  const follow = mini ? cv.dataset.track : TOWN.focus;
  const a = follow && TOWN.agents.get(follow);
  const fit = Math.min(cv.width / TW, cv.height / TH);
  const tz = mini ? cv.width / 210 : a ? fit * 3.2 : fit;
  const side = !mini && a ? (330 * (devicePixelRatio || 1)) / 2 / tz : 0; // keep the resident clear of the detail panel
  const tx = a ? a.x + TOWN.mx + side : TOWN.W / 2, ty = a ? a.y - 8 + TOWN.my : TOWN.H / 2;
  let c = TOWN.cams[key];
  if (!c || c.w !== cv.width || c.h !== cv.height) c = TOWN.cams[key] = { x: tx, y: ty, s: tz, w: cv.width, h: cv.height };
  const k = Math.min(1, dt * (a ? 9 : 5)); // follow tight so a walking resident does not drift off-centre
  c.x += (tx - c.x) * k; c.y += (ty - c.y) * k; c.s += (tz - c.s) * k;
  const hw = cv.width / (2 * c.s), hh = cv.height / (2 * c.s);
  c.x = TOWN.W > 2 * hw ? Math.min(Math.max(c.x, hw), TOWN.W - hw) : TOWN.W / 2;
  c.y = TOWN.H > 2 * hh ? Math.min(Math.max(c.y, hh), TOWN.H - hh) : TOWN.H / 2;
  return c;
}
function townBlit(cv, dt) {
  const c = townCam(cv, dt), ctx = cv.getContext('2d'), dpr = devicePixelRatio || 1, S = c.s;
  // whole device pixels for the map: a fractional offset makes nearest-neighbour scaling shimmer
  const ox = Math.round(cv.width / 2 - c.x * S), oy = Math.round(cv.height / 2 - c.y * S);
  const tx = ox + TOWN.mx * S, ty = oy + TOWN.my * S;           // town origin on screen
  const P = (x, y) => [Math.round(tx + x * S), Math.round(ty + y * S)];
  cv._cam = { s: S, ox, oy };
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = '#5b8a3a'; ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.drawImage(TOWN.map, ox, oy, TOWN.W * S, TOWN.H * S);
  const box = (col, x, y, w, h) => { const [a, b] = P(x, y), [c2, d] = P(x + w, y + h); ctx.fillStyle = col; ctx.fillRect(a, b, c2 - a, d - b); };

  // traffic
  [[0, '#e0c04a', 1], [.5, '#4f7fc9', -1], [.27, '#d65a4a', 1]].forEach(([o, col, dir]) => {
    const span = TOWN.W + 60, p = ((TOWN.t * .05 + o) % 1) * span - 30 - TOWN.mx;
    const x = dir > 0 ? p : TOWN.W - 2 * TOWN.mx - p, y = dir > 0 ? 318 : 303;
    const [sx, sy] = P(x, y), u = S;
    ctx.fillStyle = '#00000040'; ctx.fillRect(sx + u, sy + 2 * u, 24 * u, 11 * u);
    ctx.fillStyle = col; ctx.fillRect(sx, sy, 24 * u, 11 * u);
    ctx.fillStyle = '#ffffff30'; ctx.fillRect(sx, sy, 24 * u, 2 * u);
    ctx.fillStyle = '#1d2733'; ctx.fillRect(sx + (dir > 0 ? 14 : 3) * u, sy + 2 * u, 7 * u, 7 * u);
  });
  // monitors light up for residents at work, then residents back to front
  const list = [...TOWN.agents.values()].sort((a, b) => a.y - b.y);
  list.forEach((a) => {
    if (a.col !== 'running' || !a.goal || !a.goal.sit || a.moving) return;
    const d = T_DESKS[a.slot % T_DESKS.length], o = a.slot >= T_DESKS.length ? 26 : 8;
    box(Math.sin(TOWN.t * 5 + a.slot) > 0 ? '#7fd8ff' : '#58b6e6', d.x + o + 1, d.y - 6, 11, 6);
  });
  list.forEach((a) => {
    const [sx, sy] = P(a.x, a.y);
    ctx.drawImage(townSprite(a, TOWN.t), Math.round(sx - SPR_FX * S), Math.round(sy - SPR_FY * S), Math.round(SPR_W * S), Math.round(SPR_H * S));
  });
  // night: dim everything, then lamp glow
  const night = townNight();
  if (night) {
    ctx.fillStyle = `rgba(12,18,44,${night})`; ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.globalCompositeOperation = 'lighter';
    T_LAMPS.forEach(([x, y]) => {
      const [lx, ly] = P(x, y - 10), r = 34 * S, gr = ctx.createRadialGradient(lx, ly, 0, lx, ly, r);
      gr.addColorStop(0, `rgba(255,214,140,${night * .7})`); gr.addColorStop(1, 'rgba(255,214,140,0)');
      ctx.fillStyle = gr; ctx.fillRect(lx - r, ly - r, 2 * r, 2 * r);
    });
    ctx.globalCompositeOperation = 'source-over';
  }
  // selection box and name tags in screen space so text stays crisp at any zoom
  const mini = cv.classList.contains('town-mini');
  ctx.font = `600 ${10 * dpr}px Inter, system-ui, sans-serif`; ctx.textBaseline = 'middle';
  const isSel = (a) => (mini ? a.id === cv.dataset.track : a.id === TOWN.focus);
  // selected tag first, then hover, then the rest; a tag that would cover one already placed stacks above it
  const rank = (a) => (isSel(a) ? 0 : a.id === TOWN.hover ? 1 : 2);
  const placed = [];
  [...list].sort((a, b) => rank(a) - rank(b)).forEach((a) => {
    const sel = isSel(a);
    const [sx, sy] = P(a.x, a.y);
    if (sx < -60 || sy < -40 || sx > cv.width + 60 || sy > cv.height + 40) return;
    if (sel || a.id === TOWN.hover) {
      ctx.strokeStyle = sel ? '#a78bfa' : '#ffffffcc'; ctx.lineWidth = 2 * dpr;
      ctx.strokeRect(sx - 9 * S, sy - 20 * S, 18 * S, 23 * S);
    }
    if (!sel && S < 1.6 * dpr && a.id !== TOWN.hover) return; // zoomed out: tags only on hover and selection
    const label = a.title.length > 16 ? a.title.slice(0, 15) + '…' : a.title;
    const w = ctx.measureText(label).width + 12 * dpr, h = 16 * dpr, lx = sx - w / 2;
    let ly = sy - 20 * S - h - 3 * dpr;
    for (let hit = true; hit;) {
      hit = placed.some((p) => lx < p.x + p.w && lx + w > p.x && ly < p.y + p.h + 2 * dpr && ly + h + 2 * dpr > p.y);
      if (hit) ly -= 2 * dpr;
    }
    placed.push({ x: lx, y: ly, w, h });
    ctx.fillStyle = sel ? '#7c5cdc' : 'rgba(16,18,22,.82)';
    ctx.beginPath(); ctx.roundRect(lx, ly, w, h, 4 * dpr); ctx.fill();
    ctx.fillStyle = '#f4f1ea'; ctx.fillText(label, lx + 6 * dpr, ly + h / 2 + .5);
  });
}
/* Pixel art needs no 200 Hz: a frame every 33 ms (100 ms while another app has focus), and the
   loop stops when no canvas is on screen; townMount starts it again on the next render. */
function townFrame(now) {
  const views = townViews().filter((cv) => cv.offsetParent);
  if (!views.length) { TOWN.raf = 0; TOWN.last = 0; return; }
  TOWN.raf = setTimeout(() => requestAnimationFrame(townFrame), document.hasFocus() ? 33 : 100);
  const dt = Math.min(.12, (now - (TOWN.last || now)) / 1000); TOWN.last = now; TOWN.t += dt;
  townStep(dt);
  views.forEach((cv) => townBlit(cv, dt));
}

/* The map is sized from the Town page frame (or the bare town when only a preview exists),
   so grass, roads and trees run to every edge. */
function townSize(cv) {
  const dpr = devicePixelRatio || 1, r = cv.getBoundingClientRect();
  const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
  if (TOWN.map && cv.width === w && cv.height === h) return; // assigning width clears the canvas even when unchanged
  cv.width = w; cv.height = h;
  let W = TW, H = TH;
  if (cv.id === 'town-cv') { const k = Math.min(cv.width / TW, cv.height / TH); W = Math.ceil(cv.width / k); H = Math.ceil(cv.height / k); }
  if (!TOWN.map || (cv.id === 'town-cv' && (W !== TOWN.W || H !== TOWN.H))) {
    TOWN.W = W; TOWN.H = H; TOWN.mx = (W - TW) >> 1; TOWN.my = (H - TH) >> 1;
    TOWN.map = townDrawMap(W, H, TOWN.mx, TOWN.my);
  }
  // Repaint now: a resized (or freshly mounted) canvas is blank until the next frame, which reads as a blink.
  townBlit(cv, 0);
}
function townPick(cv, e) {
  const r = cv.getBoundingClientRect(), dpr = cv.width / r.width, c = cv._cam;
  if (!c) return null;
  const mx = ((e.clientX - r.left) * dpr - c.ox) / c.s - TOWN.mx, my = ((e.clientY - r.top) * dpr - c.oy) / c.s - TOWN.my;
  let best = null, bd = 12;
  TOWN.agents.forEach((a) => { const d = Math.hypot(a.x - mx, a.y - 8 - my); if (d < bd) { bd = d; best = a; } });
  return best;
}
function townMount() {
  const views = townViews();
  if (!views.length) return;
  townSync();
  views.forEach(townSize);
  if (TOWN.ro) TOWN.ro.disconnect();
  TOWN.ro = new ResizeObserver(() => townViews().forEach(townSize));
  views.forEach((cv) => TOWN.ro.observe(cv));
  const cv = document.getElementById('town-cv');
  if (cv && !cv._bound) { // a patched render keeps the same canvas: bind once
    cv._bound = true;
    cv.addEventListener('pointermove', (e) => { const a = townPick(cv, e); TOWN.hover = a && a.id; cv.style.cursor = a ? 'pointer' : ''; });
    cv.addEventListener('pointerleave', () => { TOWN.hover = null; });
    cv.addEventListener('click', (e) => { const a = townPick(cv, e); const next = a ? a.id : null; if (next !== TOWN.focus) { TOWN.focus = next; render(); } });
  }
  if (!TOWN.raf) TOWN.raf = requestAnimationFrame(townFrame);
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && TOWN.focus && state.page === 'town') { TOWN.focus = null; render(); } });

/* ---------- views ---------- */
function townDetail(id) {
  const s = (DB.sessions || []).find((x) => x.id === id), a = TOWN.agents.get(id);
  if (!s || !a) return '';
  const L = s.live || {};
  const row = (k, v, cls = '') => v ? `<div class="td-row"><span>${k}</span><b class="${cls}">${esc(String(v))}</b></div>` : '';
  return `<aside class="town-detail" aria-label="Resident details">
    <div class="td-head">
      <span class="sh-av" data-grainient>${ic('robot', 'fill')}</span>
      <div><b>${esc(s.title)}</b><span>${esc(s.agent || 'agent')} · ${esc(L.model || state.model)}</span></div>
      <button class="sh-btn" data-act="town-close" title="Close (Esc)" aria-label="Close">${ic('x')}</button>
    </div>
    <div class="td-status ${esc(s.col)}"><i></i>${esc(TOWN_LABEL[a.place])}<span>${esc(SESS_ST[s.col] || 'Idle')}</span></div>
    <div class="td-rows">
      ${row('Workspace', s.ws)}${row('Branch', s.branch, 'mono')}${row('Device', L.device)}${row('Folder', L.cwd, 'mono')}
      ${row('Elapsed', s.elapsed, 'num')}${row('Messages', s.msgs, 'num')}${row('Tokens', s.tokens, 'num')}
    </div>
    <div class="td-actions">
      <button class="btn primary sm" data-session="${esc(id)}">${ic('chat-circle')}Open session</button>
      <button class="btn secondary sm" data-act="town-close">Back to town</button>
    </div>
  </aside>`;
}
function viewTown() {
  townSync();
  const n = { office: 0, mess: 0, park: 0, road: 0 };
  TOWN.agents.forEach((a) => { n[a.place]++; });
  const working = (DB.sessions || []).filter((s) => s.col === 'running').length;
  const R = window.LIVE && LIVE.router && LIVE.router.stats;
  const now = new Date();
  return `<div class="town ${TOWN.focus ? 'focus' : ''}">
    <canvas id="town-cv" aria-label="Town map: each session is a resident. Click one to follow it."></canvas>
    <div class="town-top">
      <span><b class="num">${TOWN.agents.size}</b>agents</span>
      <span class="on"><i></i><b class="num">${n.office}</b>in the office</span>
      <span><b class="num">${n.mess}</b>in the mess</span>
      <span><b class="num">${n.park}</b>in the park</span>
      <span><b class="num">${n.road}</b>commuting</span>
    </div>
    ${TOWN.focus ? townDetail(TOWN.focus) : ''}
    <div class="town-hud">
      <span class="town-name">${ic('buildings', 'fill')}XB Town</span>
      <span>${ic('clock')}<b class="num">${now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</b>${now.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })}</span>
      <span>${ic('users')}<b class="num">${TOWN.agents.size}</b><em>${working} working</em></span>
      ${R ? `<span>${ic('coins')}<b class="num sens">${uCost(R.totalCost)}</b>${esc(LIVE.router.period || '')}</span>` : ''}
      <span class="grow"></span>
      <button class="btn ghost xs" data-act="new-session">${ic('plus', 'bold')}New resident</button>
    </div>
  </div>`;
}
/* Live preview for a session's side panel: a camera that follows that one resident. */
function townPreview(id) {
  return `<button class="town-live" data-act="town-open" data-id="${esc(id)}" title="Open in Town">
    <canvas class="town-mini" data-track="${esc(id)}" aria-label="Live view of this session in Town"></canvas>
    <span class="town-live-badge"><i></i>Live in Town</span>
  </button>`;
}

console.assert(townPlace({ col: 'running' }) === 'office' && townPlace({ col: 'running', live: { status: 'waiting' } }) === 'mess' && townPlace({ col: 'waiting' }) === 'mess' && townPlace({ col: 'done' }) === 'park' && townPlace({ col: 'queued' }) === 'road', 'townPlace');
