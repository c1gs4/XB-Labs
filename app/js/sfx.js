/* XBLabs — click sounds. Five voices synthesised with Web Audio (no audio files), picked by
   what the button does: confirm, danger, switch, nav, tick. Off when Settings → Appearance →
   Sound effects is off. Plays on pointerdown so the sound lands with the press, and capture
   phase so handlers that stop propagation cannot swallow it. */
(() => {
  let ctx = null, master = null;
  /* Settings → Appearance → Sound volume, 0–100; saved as a string by the range input. */
  const volume = () => {
    const v = typeof prefs !== 'undefined' ? parseInt(prefs['Sound volume'] ?? '70', 10) : 70;
    return Number.isFinite(v) ? Math.min(100, Math.max(0, v)) / 100 : 0.7;
  };
  function audio() {
    if (!ctx) {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      master = ctx.createGain();
      /* Limiter after the boost so loud settings stay clean instead of clipping. */
      const limit = ctx.createDynamicsCompressor();
      limit.threshold.value = -6; limit.knee.value = 4; limit.ratio.value = 12;
      limit.attack.value = 0.002; limit.release.value = 0.08;
      master.connect(limit).connect(ctx.destination);
    }
    if (ctx.state === 'suspended') ctx.resume();   // created or left suspended until a gesture
    master.gain.value = volume() * 9;               // voices are mixed quiet; 100% ≈ 9× that mix
    return ctx;
  }

  /* One enveloped oscillator: quick attack, exponential decay, optional pitch glide. */
  function tone(f0, f1, dur, type = 'sine', gain = 0.06, delay = 0, lowpass = 0) {
    const a = audio(), t = a.currentTime + delay;
    const osc = a.createOscillator(), amp = a.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) osc.frequency.exponentialRampToValueAtTime(f1, t + dur);
    amp.gain.setValueAtTime(0.0001, t);
    amp.gain.exponentialRampToValueAtTime(gain, t + 0.006);
    amp.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    let out = osc.connect(amp);
    if (lowpass) { const lp = a.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = lowpass; out = out.connect(lp); }
    out.connect(master);
    osc.start(t); osc.stop(t + dur + 0.02);
  }

  const VOICES = {
    confirm: () => { tone(784, 784, 0.12, 'sine', 0.07); tone(1175, 1175, 0.18, 'sine', 0.06, 0.06); },
    danger: () => { tone(320, 140, 0.2, 'triangle', 0.11); },
    switchOn: () => { tone(620, 930, 0.07, 'sine', 0.06); },
    switchOff: () => { tone(930, 620, 0.07, 'sine', 0.05); },
    nav: () => { tone(540, 500, 0.05, 'triangle', 0.07); },
    tick: () => { tone(1600, 1400, 0.02, 'square', 0.025, 0, 2400); },
  };

  /* Order matters: the most specific role wins. */
  const RULES = [
    ['danger', '.btn.danger, .danger, [data-swipe-del], [data-swipe-ws-del], .wincontrol.close'],
    ['confirm', '.btn.primary, .btn.accent, .send-btn, .chat-input .send, [data-act="dispatch"], [data-act="glass-save"]'],
    ['switch', '.toggle, .theme-card, .theme-tile, .segment button, .chip'],
    ['nav', '.navitem, .ws-row, [data-stab], .tab, [role="tab"]'],
    ['tick', 'button, [data-act], [role="button"], .select, a[href]'],
  ];
  function sfxKind(el) {
    for (const [kind, sel] of RULES) {
      const hit = el.closest(sel);
      if (hit) return kind === 'switch' ? (hit.classList.contains('on') || hit.classList.contains('active') ? 'switchOff' : 'switchOn') : kind;
    }
    return null;
  }

  window.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || (typeof prefs !== 'undefined' && prefs['Sound effects'] === false) || !volume()) return;
    const kind = e.target instanceof Element && sfxKind(e.target);
    if (!kind || e.target.closest(':disabled, [aria-disabled="true"]')) return;
    try { VOICES[kind](); } catch { /* audio blocked or unavailable: stay silent */ }
  }, true);

  /* Moving the volume slider plays a sample at the new level. */
  document.addEventListener('input', (e) => {
    if (e.target.matches?.('input[data-pref="Sound volume"]')) {
      if (typeof prefs !== 'undefined') prefs['Sound volume'] = e.target.value;
      const out = e.target.closest('.kv')?.querySelector('output');
      if (out) out.textContent = `${e.target.value}%`;
    }
  });
  document.addEventListener('change', (e) => {
    if (e.target.matches?.('input[data-pref="Sound volume"]') && +e.target.value > 0) { try { VOICES.confirm(); } catch { /* silent */ } }
  });

  /* Self-check of the role mapping. */
  const mk = (html) => { const d = document.createElement('div'); d.innerHTML = html; return d.firstElementChild; };
  console.assert(sfxKind(mk('<button class="btn danger">x</button>')) === 'danger', 'sfx: danger');
  console.assert(sfxKind(mk('<button class="btn accent">x</button>')) === 'confirm', 'sfx: confirm');
  console.assert(sfxKind(mk('<button class="toggle on">x</button>')) === 'switchOff', 'sfx: switch off');
  console.assert(sfxKind(mk('<button class="toggle">x</button>')) === 'switchOn', 'sfx: switch on');
  console.assert(sfxKind(mk('<a class="navitem">x</a>')) === 'nav', 'sfx: nav');
  console.assert(sfxKind(mk('<button class="btn secondary">x</button>')) === 'tick', 'sfx: tick');
  console.assert(sfxKind(mk('<div>x</div>')) === null, 'sfx: none');
})();
