/*
 * Pixel Pips DMG SFX v3
 * Procedural Game Boy interface audio. No external audio files.
 *
 * v3 models the DMG APU instead of generic WebAudio tones:
 *   - pulse channels with 12.5 / 25 / 50 / 75% duty (PeriodicWave)
 *   - 4-bit stepped volume envelopes (16 levels, no smooth ramps)
 *   - stepped frequency sweeps (period shifts, not glides)
 *   - LFSR noise channel, 15-bit and 7-bit (metallic) modes
 *   - one lowpass on the master to approximate the handheld speaker
 *
 * Settings persist across pages/tabs with localStorage + BroadcastChannel.
 * Public API is unchanged from v2: window.PixelPipsSFX.{hover,click,select,
 * toggle,input,expand,navigate,connect,pending,success,error,activation,
 * special,setEnabled,setVolume,init,state}.
 */
(() => {
  'use strict';

  const KEY = 'pixelpips-sfx-v2';
  const DEFAULT = { enabled: true, volume: 1 };
  const clamp = (n, a = 0, b = 1) => Math.max(a, Math.min(b, n));

  let state;
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || '{}');
    state = { ...DEFAULT, ...saved, volume: clamp(Number(saved.volume ?? DEFAULT.volume)) };
  } catch (_) {
    state = { ...DEFAULT };
  }

  let ctx = null;
  let master = null;
  let lastHoverAt = 0;
  let lastPointerSoundAt = 0;
  let channel = null;
  const waves = {};

  try {
    channel = new BroadcastChannel('pixelpips-sfx-settings');
    channel.onmessage = (e) => {
      if (!e.data || e.data.type !== 'settings') return;
      applyState(e.data.state, false);
    };
  } catch (_) {}

  function save(broadcast = true) {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (_) {}
    if (broadcast && channel) {
      try { channel.postMessage({ type: 'settings', state }); } catch (_) {}
    }
  }

  function init() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      try {
        ctx = new AC();
        master = ctx.createGain();
        master.gain.value = state.enabled ? state.volume : 0;
        // Handheld speaker: nothing above ~7 kHz gets out of a DMG.
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = 7000;
        lp.Q.value = 0.6;
        master.connect(lp);
        lp.connect(ctx.destination);
      } catch (_) { return false; }
    }
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return true;
  }

  function sync() {
    document.querySelectorAll('[data-sfx-toggle]').forEach(b => {
      b.textContent = state.enabled ? 'SFX ON' : 'SFX OFF';
      b.setAttribute('aria-pressed', String(state.enabled));
    });
    document.querySelectorAll('[data-sfx-volume]').forEach(x => {
      x.value = String(Math.round(state.volume * 100));
    });
  }

  function applyState(next, persist = true) {
    state.enabled = !!next.enabled;
    state.volume = clamp(Number(next.volume));
    if (master && ctx) master.gain.setTargetAtTime(state.enabled ? state.volume : 0, ctx.currentTime, 0.012);
    if (persist) save(true);
    sync();
  }

  // ---------------------------------------------------------------- DMG pieces

  // Pulse wave with a real duty cycle. DMG duties: 0.125, 0.25, 0.5, 0.75.
  function pulseWave(duty) {
    const k = String(duty);
    if (waves[k]) return waves[k];
    const N = 64;
    const real = new Float32Array(N);
    const imag = new Float32Array(N);
    for (let n = 1; n < N; n++) real[n] = (2 / (n * Math.PI)) * Math.sin(n * Math.PI * duty);
    waves[k] = ctx.createPeriodicWave(real, imag);
    return waves[k];
  }

  // 4-bit volume envelope. Starts at `start` (0..15), steps by `dir` every
  // `period` sixty-fourths of a second. period 0 holds the level. Returns the
  // time the envelope reaches silence (or Infinity if it never does).
  function envelope4(g, t, base, start = 15, dir = -1, period = 2) {
    const level = v => Math.max(0.0001, base * (v / 15));
    let v = clamp(start, 0, 15);
    g.gain.setValueAtTime(level(v), t);
    if (!period || dir === 0) return Infinity;
    const step = period / 64;
    let k = 0;
    while (dir < 0 ? v > 0 : v < 15) {
      v = Math.max(0, Math.min(15, v + dir)); k++;
      g.gain.setValueAtTime(level(v), t + k * step);
    }
    return v === 0 ? t + k * step : Infinity;
  }

  // Pulse note. freq in Hz, len in seconds (length counter), env = {start, dir, period},
  // sweep = {shift, dir, period} in DMG units (period in 1/128 s, shift 1..7).
  function pulse(freq, len, opts = {}) {
    if (!state.enabled || !init()) return;
    const { duty = 0.5, gain = 0.05, delay = 0, env = { start: 15, dir: -1, period: 2 }, sweep = null } = opts;
    const t = ctx.currentTime + delay;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    g.gain.value = 0.0001;
    o.setPeriodicWave(pulseWave(duty));
    o.frequency.setValueAtTime(freq, t);
    let end = t + len;
    if (sweep) {
      // DMG sweep shifts the period, so f' = f / (1 ± 2^-shift), stepped, never glided.
      const step = sweep.period / 128;
      const ratio = 1 / (1 - sweep.dir * Math.pow(2, -sweep.shift));
      let f = freq;
      for (let k = 1; t + k * step < end; k++) {
        f = Math.min(8000, Math.max(40, f * ratio));
        o.frequency.setValueAtTime(f, t + k * step);
      }
    }
    const silence = envelope4(g, t, gain, env.start, env.dir, env.period);
    end = Math.min(end, silence);
    o.connect(g);
    g.connect(master);
    o.start(t);
    o.stop(end + 0.002);
  }

  // Noise channel. clock in Hz (DMG range roughly 500 Hz to 500 kHz), short = 7-bit LFSR (metallic).
  function noise(len, opts = {}) {
    if (!state.enabled || !init()) return;
    const { clock = 32768, short = false, gain = 0.03, delay = 0, env = { start: 15, dir: -1, period: 1 } } = opts;
    const t = ctx.currentTime + delay;
    const sr = ctx.sampleRate;
    const n = Math.max(1, Math.floor(sr * len));
    const buf = ctx.createBuffer(1, n, sr);
    const d = buf.getChannelData(0);
    let lfsr = 0x7fff;
    const spc = sr / clock;
    let acc = spc;
    let out = 1;
    for (let i = 0; i < n; i++) {
      acc += 1;
      while (acc >= spc) {
        acc -= spc;
        const bit = (lfsr ^ (lfsr >> 1)) & 1;
        lfsr = (lfsr >> 1) | (bit << 14);
        if (short) lfsr = (lfsr & ~(1 << 6)) | (bit << 6);
        out = (lfsr & 1) ? -1 : 1;
      }
      d[i] = out;
    }
    const src = ctx.createBufferSource();
    const g = ctx.createGain();
    g.gain.value = 0.0001;
    src.buffer = buf;
    const silence = envelope4(g, t, gain, env.start, env.dir, env.period);
    src.connect(g);
    g.connect(master);
    src.start(t);
    src.stop(Math.min(t + len, silence) + 0.002);
  }

  // ---------------------------------------------------------------- sounds

  // Note table, roughly what the DMG frequency register lands on.
  const N = { C4: 262, E4: 330, G4: 392, A4: 440, C5: 523, D5: 587, E5: 659, G5: 784, A5: 880, B5: 988, C6: 1047, D6: 1175, E6: 1319, G6: 1568, A6: 1760, B6: 1976, C7: 2093 };

  const S = {
    // Cursor tick. One 12.5% pulse, two envelope steps, done.
    hover() {
      const now = performance.now();
      if (now - lastHoverAt < 90) return;
      lastHoverAt = now;
      pulse(N.B5, 0.05, { duty: 0.125, gain: 0.03, env: { start: 9, dir: -3, period: 1 } });
    },

    // Menu press. Single 50% blip with a fast 4-bit decay.
    click() {
      pulse(N.A5, 0.08, { duty: 0.5, gain: 0.05, env: { start: 15, dir: -4, period: 1 } });
    },

    // Selection. Two stepped notes, the classic confirm.
    select() {
      pulse(N.C6, 0.06, { duty: 0.25, gain: 0.045, env: { start: 14, dir: -4, period: 1 } });
      pulse(N.E6, 0.14, { duty: 0.25, gain: 0.045, delay: 0.05, env: { start: 15, dir: -2, period: 1 } });
    },

    // Toggle. Up two steps for on, down two steps for off. Stepped, never glided.
    toggle(on = state.enabled) {
      if (on) {
        pulse(N.C5, 0.05, { duty: 0.5, gain: 0.045, env: { start: 13, dir: -4, period: 1 } });
        pulse(N.C6, 0.14, { duty: 0.5, gain: 0.045, delay: 0.04, env: { start: 15, dir: -2, period: 1 } });
      } else {
        pulse(N.C6, 0.05, { duty: 0.5, gain: 0.045, env: { start: 13, dir: -4, period: 1 } });
        pulse(N.C5, 0.14, { duty: 0.5, gain: 0.045, delay: 0.04, env: { start: 15, dir: -2, period: 1 } });
      }
    },

    // Form input tick.
    input() {
      pulse(N.A5, 0.05, { duty: 0.125, gain: 0.03, env: { start: 10, dir: -4, period: 1 } });
    },

    // Details open. Low then high, 25% duty.
    expand() {
      pulse(N.G5, 0.05, { duty: 0.25, gain: 0.04, env: { start: 12, dir: -4, period: 1 } });
      pulse(N.C6, 0.12, { duty: 0.25, gain: 0.04, delay: 0.04, env: { start: 14, dir: -2, period: 1 } });
    },

    // Page change. Three quick steps up.
    navigate() {
      pulse(N.C5, 0.05, { duty: 0.25, gain: 0.042, env: { start: 12, dir: -4, period: 1 } });
      pulse(N.E5, 0.05, { duty: 0.25, gain: 0.042, delay: 0.035, env: { start: 12, dir: -4, period: 1 } });
      pulse(N.G5, 0.14, { duty: 0.25, gain: 0.045, delay: 0.07, env: { start: 15, dir: -2, period: 1 } });
    },

    // Wallet connect. The boot ding: two notes, second one rings out.
    connect() {
      pulse(N.C6, 0.097, { duty: 0.5, gain: 0.05, env: { start: 15, dir: 0, period: 0 } });
      pulse(N.C7, 0.72, { duty: 0.5, gain: 0.05, delay: 0.1, env: { start: 15, dir: -1, period: 3 } });
    },

    // Waiting on a tx. Two low pulses with a slow decay.
    pending() {
      pulse(N.C4, 0.2, { duty: 0.25, gain: 0.04, env: { start: 12, dir: -2, period: 2 } });
      pulse(N.C4, 0.2, { duty: 0.25, gain: 0.04, delay: 0.22, env: { start: 12, dir: -2, period: 2 } });
    },

    // Success. Arpeggio up, last note held with a long 4-bit decay.
    success() {
      [N.C5, N.E5, N.G5].forEach((f, i) => pulse(f, 0.06, { duty: 0.25, gain: 0.05, delay: i * 0.06, env: { start: 14, dir: -4, period: 1 } }));
      pulse(N.C6, 0.5, { duty: 0.25, gain: 0.05, delay: 0.18, env: { start: 15, dir: -1, period: 2 } });
    },

    // Error. Stepped sweep down on a 50% pulse, then a 7-bit noise buzz.
    error() {
      pulse(N.A4, 0.16, { duty: 0.5, gain: 0.05, env: { start: 15, dir: -1, period: 3 }, sweep: { shift: 3, dir: -1, period: 2 } });
      noise(0.1, { clock: 16384, short: true, gain: 0.035, delay: 0.14, env: { start: 12, dir: -2, period: 1 } });
    },

    // Activation. Static, then the antenna locks: stepped sweep up into a held high pulse.
    activation() {
      noise(0.12, { clock: 32768, short: false, gain: 0.03, env: { start: 12, dir: -2, period: 1 } });
      pulse(N.E4, 0.337, { duty: 0.25, gain: 0.05, delay: 0.1, env: { start: 15, dir: 0, period: 0 }, sweep: { shift: 3, dir: 1, period: 3 } });
      pulse(N.E6, 0.72, { duty: 0.5, gain: 0.05, delay: 0.44, env: { start: 15, dir: -1, period: 3 } });
      pulse(N.B6, 0.72, { duty: 0.125, gain: 0.03, delay: 0.44, env: { start: 13, dir: -1, period: 3 } });
    },

    // Specials. Metallic 7-bit noise sting under a rising 12.5% arpeggio.
    special() {
      noise(0.08, { clock: 65536, short: true, gain: 0.035, env: { start: 13, dir: -3, period: 1 } });
      [N.E6, N.G6, N.B6, N.E6 * 2].forEach((f, i) => pulse(f, i === 3 ? 0.5 : 0.07, { duty: 0.125, gain: 0.045, delay: 0.06 + i * 0.07, env: { start: 15, dir: i === 3 ? -1 : -4, period: i === 3 ? 2 : 1 } }));
    }
  };

  window.PixelPipsSFX = {
    state,
    init,
    ...S,
    setEnabled(v) {
      const next = !!v;
      state.enabled = next;
      if (init()) master.gain.setTargetAtTime(next ? state.volume : 0, ctx.currentTime, 0.012);
      save(true);
      sync();
    },
    setVolume(v) {
      state.volume = clamp(Number(v));
      if (init()) master.gain.setTargetAtTime(state.enabled ? state.volume : 0, ctx.currentTime, 0.012);
      save(true);
      sync();
    }
  };

  function isSfxControl(el) {
    return !!el?.closest?.('[data-sfx-toggle], [data-sfx-volume]');
  }

  function bind() {
    document.querySelectorAll('[data-sfx-toggle]').forEach(b => {
      b.addEventListener('click', () => {
        const next = !state.enabled;
        if (next) {
          init();
          applyState({ enabled: true, volume: state.volume }, true);
          S.toggle(true);
        } else {
          S.toggle(false);
          applyState({ enabled: false, volume: state.volume }, true);
        }
      });
    });

    document.querySelectorAll('[data-sfx-volume]').forEach(x => {
      x.addEventListener('input', e => window.PixelPipsSFX.setVolume(Number(e.target.value) / 100));
      x.addEventListener('change', e => window.PixelPipsSFX.setVolume(Number(e.target.value) / 100));
    });

    document.addEventListener('pointerdown', e => {
      init();
      const el = e.target.closest?.('button, .button, summary, input[type="checkbox"], input[type="radio"], select, [role="button"], [data-sfx-click], a[href]');
      if (!el || isSfxControl(el) || el.closest('[data-sfx-silent]')) return;
      if (el.matches('button') && el.disabled) return;
      const now = performance.now();
      if (now - lastPointerSoundAt < 40) return;
      lastPointerSoundAt = now;
      if (el.matches('summary')) S.expand();
      else if (el.matches('input[type="checkbox"], input[type="radio"], select')) S.select();
      else if (el.matches('a[href]')) {
        const href = el.getAttribute('href') || '';
        if (href && href !== '#' && !href.startsWith('javascript:')) S.navigate();
        else S.click();
      } else S.click();
    }, { passive: true });

    document.addEventListener('keydown', e => {
      init();
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const el = document.activeElement;
      if (!el || isSfxControl(el) || el.closest?.('[data-sfx-silent]')) return;
      if (el.matches('button, .button, [role="button"]')) S.click();
      else if (el.matches('a[href]')) S.navigate();
      else if (el.matches('summary')) S.expand();
    }, { passive: true });

    document.addEventListener('pointerover', e => {
      const el = e.target.closest?.('button, .button, summary, input, select, [role="button"], a[href]');
      if (!el || isSfxControl(el) || el.closest('[data-sfx-silent]')) return;
      if (el.contains(e.relatedTarget)) return;
      S.hover();
    }, { passive: true });

    ['pointerdown', 'keydown', 'touchstart'].forEach(t => document.addEventListener(t, init, { once: true, passive: true }));
    sync();
  }

  window.addEventListener('storage', e => {
    if (e.key !== KEY || !e.newValue) return;
    try { applyState(JSON.parse(e.newValue), false); } catch (_) {}
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();
})();
