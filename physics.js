// Pip Cannon deterministic physics. One file, two consumers:
//   browser:  <script src="/physics.js">        (classic script, uses the global)
//   API:      import '../physics.js'            (side effect, uses the global)
// Both run byte-identical arithmetic, so a browser and the server replay cannot
// disagree about where a pip lands.
//
// Every quantity is an integer scaled by 2^16, held in a JS number. Positions
// exceed 2^31 at long distances, so bitwise operators are never used on values:
// `>>16` would silently truncate x past about 32,000 px. Scaling is always
// Math.floor(a*b/S). All intermediates stay under 2^53, and there is no float
// arithmetic anywhere in the step.
//
// Inputs: seed (uint32), angle (whole degrees 10..60), power (0..100 with up to
// three decimals). Power is converted once at the boundary by Math.round(p*1000),
// which is exact for three-decimal values, so accepting the existing wire format
// costs nothing in determinism.
//
// The optional fx callback exists so the game can splat, boom and beep from
// inside the step while the server passes nothing. fx receives float pixels and
// MUST NOT touch sim state or draw from the seeded stream.
(function () {
'use strict';

const S = 65536;
const f = (n) => Math.round(n * S);
const fmul = (a, b) => Math.floor(a * b / S);
const px = (v) => v / S;                 // fixed -> float pixels, for fx and rendering only

const GROUND = 232 * S, PX_PER_FT = 5;
const GRAVITY = 20316;      // 0.31
const FRICTION = 63701;     // 0.972
const BOUNCE_BASE = 36045;  // 0.55
const BOUNCE_RNG = 9175;    // 0.14
const TRAMP = 88474;        // 1.35
const VX_BOOST = 66847;     // 1.02
const NINE_TENTHS = 58982;  // 0.9

// The ten collection pips a racer can wear. The server reads this for room
// sprite claims; the client checks its PIPS art against it at load.
const SPRITES = [7, 12, 233, 395, 512, 1042, 2048, 2505, 2560, 2920];

const BAG = ['tnt','tnt','tnt','tnt','tnt','tnt','tramp','tramp','tramp','tramp','tramp','tramp','tramp','tramp','tramp','balloon','balloon','balloon','balloon','balloon','balloon','spikes','spikes','trap'];
const W = 480, VW = Math.ceil(W / 1.7) + 10, VW_F = VW * S;

// Launch angles are whole degrees, so the shot needs no general trig: the
// table is exact for 0..90.
const COS = [], SIN = [];
for (let d = 0; d <= 90; d++) { COS[d] = f(Math.cos(d * Math.PI / 180)); SIN[d] = f(Math.sin(d * Math.PI / 180)); }

// The balloon bob is the one arbitrary-argument sine. Table lookup with integer
// argument reduction; the table itself is constant, so it is identical everywhere.
const TAU = Math.round(2 * Math.PI * S), NSIN = 4096;
const SINTAB = [];
for (let i = 0; i < NSIN; i++) SINTAB[i] = f(Math.sin(i * 2 * Math.PI / NSIN));
function fsin(arg) {
  let a = arg % TAU; if (a < 0) a += TAU;
  return SINTAB[Math.floor(a * NSIN / TAU) % NSIN];
}

function rngFixed(seed) {
  let st = (seed >>> 0) || 1;
  return () => {
    st ^= st << 13; st >>>= 0;
    st ^= st >> 17;
    st ^= st << 5;  st >>>= 0;
    return st >>> 16;               // 0..65535: 0..1 in fixed point
  };
}

const pmOf = (power) => Math.max(0, Math.min(100000, Math.round(Number(power) * 1000)));

function makeWorld(rnd) {
  return { rnd, bag: [], lastType: '', lastRun: 0, prevPair: false, nextSpawnX: 200 * S, items: [] };
}
function refill(w) {
  const add = BAG.slice();
  for (let i = add.length - 1; i > 0; i--) {
    const j = Math.floor(w.rnd() * (i + 1) / S);
    const t = add[i]; add[i] = add[j]; add[j] = t;
  }
  w.bag = w.bag.concat(add);
}
function pickIdx(w, blocked) {
  for (let k = w.bag.length - 1; k >= 0; k--) if (blocked === null || w.bag[k] !== blocked) return k;
  return -1;
}
function nextType(w) {
  if (!w.bag.length) refill(w);
  const blocked = (w.lastRun >= 2 || (w.prevPair && w.lastRun >= 1)) ? w.lastType : null;
  let i = pickIdx(w, blocked);
  if (i < 0) { refill(w); i = pickIdx(w, blocked); }
  if (i < 0) i = w.bag.length - 1;
  const t = w.bag.splice(i, 1)[0];
  if (t === w.lastType) w.lastRun++;
  else { w.prevPair = (w.lastRun === 2); w.lastRun = 1; w.lastType = t; }
  return t;
}
function spawn(w, aheadOf) {
  while (w.nextSpawnX < aheadOf + VW_F + 400 * S) {
    const type = nextType(w);
    const it = { type, x: w.nextSpawnX, used: false };
    if (type === 'balloon') it.y = GROUND - 64 * S - w.rnd() * 88;
    // rx/ry are render mirrors in float px; the sim never reads them
    it.rx = px(it.x); it.ry = it.y != null ? px(it.y) : 0;
    w.items.push(it);
    w.nextSpawnX += 60 * S + w.rnd() * 120;
  }
}

function launch(angle, pm) {
  const a = Math.max(0, Math.min(90, Math.round(angle)));
  const sp = 8 * S + Math.floor(pm * 13 * S / 100000);
  return {
    x: 33 * S + COS[a] * 62,
    y: GROUND - 24 * S - SIN[a] * 62,
    vx: fmul(COS[a], sp),
    vy: -fmul(SIN[a], sp)
  };
}

const feetOf = (x) => Math.floor((x - 44 * S) / (PX_PER_FT * S));

// Render helper: where the balloon is drawn must be where it collides, so the
// bob comes from the same fixed table, converted to float pixels at the edge.
const bobY = (it, pframes) => px(it.y + fsin(Math.floor(pframes * S / 22) + it.x) * 2);

// One 60Hz step for one pip against a shared world. onEnd(pip, how) is called
// at most once, when the run ends. fx(event, data) is decoration only.
function stepPip(p, w, pframes, onEnd, fx) {
  if (p.dead) return;
  p.vy += GRAVITY; p.x += p.vx; p.y += p.vy;
  const ft = feetOf(p.x); if (ft > p.feet) p.feet = ft;

  for (const it of w.items) {
    if (p.dead) break;
    if (it.type === 'balloon') {
      if (it.used) continue;
      const by = it.y + fsin(Math.floor(pframes * S / 22) + it.x) * 2;
      if (Math.abs(p.x - (it.x + 9 * S)) < 22 * S && p.y > by - 10 * S && p.y < by + 28 * S) {
        it.used = true;
        p.vy = -(12 * S + p.rnd() * 5);
        p.vx = Math.max(fmul(p.vx, NINE_TENTHS), 4 * S) + 3 * S + p.rnd() * 3;
        if (fx) fx('balloon', { x: px(p.x), y: px(p.y), by: px(by), it });
      }
      continue;
    }
    if (it.type === 'trap') {
      if (Math.abs(p.x - (it.x + 11 * S)) < 11 * S && Math.abs(p.y - (GROUND - 27 * S)) < 9 * S) {
        p.x = it.x + 11 * S; p.y = GROUND - 27 * S; p.stuck = true;
        if (fx) fx('trap', { x: px(p.x), y: px(p.y), it });
        onEnd(p, 'EATEN');
      }
      continue;
    }
    const wd = (it.type === 'spikes') ? 24 * S : (it.type === 'tramp' ? 26 * S : (it.type === 'tnt' ? 15 * S : 18 * S));
    if (p.x < it.x || p.x > it.x + wd) continue;
    if (it.type === 'tnt' && !it.used && p.y > GROUND - 22 * S) {
      it.used = true;
      p.vx = Math.max(p.vx, 5 * S) + 4 * S + p.rnd() * 4;
      p.vy = -(13 * S + p.rnd() * 5);
      if (fx) fx('tnt', { x: px(p.x), y: px(p.y), it });
    } else if (it.type === 'tramp' && p.vy > 0 && p.y > GROUND - 18 * S) {
      p.y = GROUND - 18 * S;
      p.vy = -Math.max(12 * S, fmul(Math.abs(p.vy), TRAMP));
      p.vx = fmul(p.vx, VX_BOOST);
      if (fx) fx('tramp', { x: px(p.x), y: px(p.y), it });
    } else if (it.type === 'spikes' && p.y > GROUND - 18 * S) {
      p.x = it.x + 12 * S; p.y = GROUND - 16 * S; p.stuck = true;
      if (fx) fx('spikes', { x: px(p.x), y: px(p.y), it });
      onEnd(p, 'IMPALED');
    }
  }
  if (p.dead) return;

  if (!p.stuck && p.y >= GROUND - 9 * S) {
    p.y = GROUND - 9 * S;
    const impact = px(Math.abs(p.vy));
    p.vy = -fmul(p.vy, BOUNCE_BASE + fmul(p.rnd(), BOUNCE_RNG));
    p.vx = fmul(p.vx, FRICTION);
    if (fx) fx('bounce', { x: px(p.x), y: px(p.y), impact });
    if (Math.abs(p.vy) < NINE_TENTHS && Math.abs(p.vx) < S / 2) onEnd(p, 'STOPPED');
  }
  if (p.dead) return;

  p.frames++;
  if (Math.abs(p.vx) < 26214 && Math.abs(p.vy) < 78643) p.slow++; else p.slow = 0;   // 0.4, 1.2
  if (p.slow > 45 || p.frames > 12000) onEnd(p, 'STOPPED');
}

function newPipState(L, rnd) {
  return { ...L, rnd, stuck: false, slow: 0, frames: 0, feet: 0, dead: false, how: '' };
}
function endPip(q, how) {
  if (q.dead) return;
  q.dead = true; q.how = how;
  const ft = feetOf(q.x); if (ft > q.feet) q.feet = ft;
}

// Setup is shared between batch simulation and the frame-stepped game so there
// is exactly one code path that decides launch state, streams and null inputs.
function soloSetup(seed, angle, power) {
  const rnd = rngFixed(seed);
  const w = makeWorld(rnd);
  const p = newPipState(launch(angle, pmOf(power)), rnd);
  return { w, p };
}

function raceSetup(seed, inputs) {
  const w = makeWorld(rngFixed(seed));
  const pips = inputs.map((inp, i) => {
    const rnd = rngFixed((seed ^ Math.imul(i + 1, 0x9E3779B9)) >>> 0);
    let angle = inp.angle, pm = (inp.power == null) ? null : pmOf(inp.power);
    if (angle == null) angle = 10 + Math.floor(rnd() * 51 / S);
    if (pm == null) pm = Math.floor(rnd() * 100000 / S);
    const p = newPipState(launch(angle, pm), rnd);
    p.slot = i; p.angle = angle; p.pm = pm; p.place = 0;
    return p;
  });
  return { w, pips };
}

function simulate(seed, angle, power) {
  const { w, p } = soloSetup(seed, angle, power);
  let pframes = 0;
  while (!p.dead) {
    pframes++;
    stepPip(p, w, pframes, endPip);
    if (p.dead) break;
    spawn(w, p.x - 70 * S);
    if (w.items.length > 4000) w.items = w.items.slice(-2000);
  }
  return { ft: p.feet, how: p.how };
}

function simulateRace(seed, inputs) {
  const { w, pips } = raceSetup(seed, inputs);
  let pframes = 0;
  while (pips.some(p => !p.dead)) {
    pframes++;
    for (const p of pips) stepPip(p, w, pframes, endPip);
    let lead = -Infinity; for (const p of pips) if (p.x > lead) lead = p.x;
    spawn(w, lead - 70 * S);
    if (w.items.length > 4000) w.items = w.items.slice(-2000);
    if (pframes > 20000) break;
  }
  const ranked = pips.slice().sort((a, b) => b.feet - a.feet);
  ranked.forEach((p, i) => { p.place = i + 1; });
  return pips.map(p => ({ slot: p.slot, ft: p.feet, how: p.how, place: p.place, angle: p.angle, power: p.pm / 1000 }));
}

const PIPPHYS = { S, px, fmul, rngFixed, pmOf, launch, stepPip, spawn, soloSetup, raceSetup, bobY,
                  simulate, simulateRace, feetOf, endPip, GROUND, PX_PER_FT, SPRITES };
if (typeof globalThis !== 'undefined') globalThis.PIPPHYS = PIPPHYS;
})();
