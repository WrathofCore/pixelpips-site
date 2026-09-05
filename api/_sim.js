// Headless replay of a Pip Cannon run. Must stay in exact lockstep with the
// physics in pipcannon.html. Given (seed, angle, power) it returns the distance
// the client must have reached, so a submitted score can be recomputed rather
// than trusted.
const GROUND = 232, PX_PER_FT = 5;
const BAG = ['tnt','tnt','tnt','tnt','tnt','tnt','tramp','tramp','tramp','tramp','tramp','tramp','tramp','tramp','tramp','balloon','balloon','balloon','balloon','balloon','balloon','spikes','spikes','trap'];
const W = 480, Z = 1.7, VW = Math.ceil(W / Z) + 10;

export function simulate(seed, angle, power) {
  let st = (seed >>> 0) || 1;
  const rnd = () => {
    st ^= st << 13; st >>>= 0;
    st ^= st >> 17;
    st ^= st << 5;  st >>>= 0;
    return st / 4294967296;
  };

  let bag = [], lastType = '', lastRun = 0, prevPair = false;
  function refillBag() {
    const add = BAG.slice();
    for (let i = add.length - 1; i > 0; i--) { const j = (rnd() * (i + 1)) | 0; [add[i], add[j]] = [add[j], add[i]]; }
    bag = bag.concat(add);
  }
  function pickIdx(blocked) {
    for (let k = bag.length - 1; k >= 0; k--) { if (blocked === null || bag[k] !== blocked) return k; }
    return -1;
  }
  function nextType() {
    if (!bag.length) refillBag();
    const blocked = (lastRun >= 2 || (prevPair && lastRun >= 1)) ? lastType : null;
    let i = pickIdx(blocked);
    if (i < 0) { refillBag(); i = pickIdx(blocked); }
    if (i < 0) i = bag.length - 1;
    const t = bag.splice(i, 1)[0];
    if (t === lastType) { lastRun++; }
    else { prevPair = (lastRun === 2); lastRun = 1; lastType = t; }
    return t;
  }

  let items = [], nextSpawnX = 200, cam = 0, pframes = 0, feet = 0;
  function spawnAhead() {
    while (nextSpawnX < cam + VW + 400) {
      const type = nextType();
      if (type === 'balloon') items.push({ type, x: nextSpawnX, y: GROUND - 64 - rnd() * 88, used: false });
      else items.push({ type, x: nextSpawnX, used: false });
      nextSpawnX += 60 + rnd() * 120;
    }
  }

  const a = angle * Math.PI / 180, sp = 8 + (power / 100) * 13;
  const pip = {
    x: 33 + Math.cos(a) * 62,
    y: GROUND - 24 - Math.sin(a) * 62,
    vx: Math.cos(a) * sp,
    vy: -Math.sin(a) * sp,
    stuck: false, slow: 0, frames: 0
  };
  let done = false, how = '';

  const end = (msg) => { if (!done) { done = true; how = msg; feet = Math.max(feet, Math.floor((pip.x - 44) / PX_PER_FT)); } };

  while (!done) {
    pframes++;
    pip.vy += 0.31;
    pip.x += pip.vx; pip.y += pip.vy;
    feet = Math.max(feet, Math.floor((pip.x - 44) / PX_PER_FT));

    for (const it of items) {
      if (done) break;
      if (it.type === 'balloon') {
        if (it.used) continue;
        const by = it.y + Math.sin(pframes / 22 + it.x) * 2;
        if (Math.abs(pip.x - (it.x + 9)) < 22 && pip.y > by - 10 && pip.y < by + 28) {
          it.used = true;
          pip.vy = -(12 + rnd() * 5);
          pip.vx = Math.max(pip.vx * 0.9, 4) + 3 + rnd() * 3;
        }
        continue;
      }
      if (it.type === 'trap') {
        if (Math.abs(pip.x - (it.x + 11)) < 11 && Math.abs(pip.y - (GROUND - 27)) < 9) {
          pip.x = it.x + 11; pip.y = GROUND - 27; pip.stuck = true;
          end('EATEN');
        }
        continue;
      }
      const w = (it.type === 'spikes') ? 24 : (it.type === 'tramp' ? 26 : (it.type === 'tnt' ? 15 : 18));
      if (pip.x < it.x || pip.x > it.x + w) continue;
      if (it.type === 'tnt' && !it.used && pip.y > GROUND - 22) {
        it.used = true;
        pip.vx = Math.max(pip.vx, 5) + 4 + rnd() * 4;
        pip.vy = -(13 + rnd() * 5);
      } else if (it.type === 'tramp' && pip.vy > 0 && pip.y > GROUND - 18) {
        pip.y = GROUND - 18;
        pip.vy = -Math.max(12, Math.abs(pip.vy) * 1.35);
        pip.vx *= 1.02;
      } else if (it.type === 'spikes' && pip.y > GROUND - 18) {
        pip.x = it.x + 12; pip.y = GROUND - 16; pip.stuck = true;
        end('IMPALED');
      }
    }
    if (done) break;

    if (!pip.stuck && pip.y >= GROUND - 9) {
      pip.y = GROUND - 9;
      pip.vy *= -(0.55 + rnd() * 0.14);
      pip.vx *= 0.972;
      if (Math.abs(pip.vy) < 0.9 && Math.abs(pip.vx) < 0.5) end('STOPPED');
    }
    if (done) break;

    spawnAhead();
    if (items.length > 4000) items = items.slice(-2000);

    pip.frames++;
    if (Math.abs(pip.vx) < 0.4 && Math.abs(pip.vy) < 1.2) pip.slow++; else pip.slow = 0;
    if (pip.slow > 45 || pip.frames > 12000) end('STOPPED');

    cam = Math.max(0, pip.x - 70);
  }

  return { ft: feet, how };
}

// ---------------------------------------------------------------- race replay
// Mirrors the race loop in pipcannon.html exactly. Each pip has its own RNG
// stream, the world has its own, all derived from the race seed. Pips are
// stepped in slot order every frame and consumables go to the first to touch
// them. Returns per-slot distance and cause, plus placings.
function xorshift(seed) {
  let st = (seed >>> 0) || 1;
  return () => { st ^= st << 13; st >>>= 0; st ^= st >> 17; st ^= st << 5; st >>>= 0; return st / 4294967296; };
}
export function simulateRace(seed, inputs) {
  const wrng = xorshift(seed);
  const w = { rng: wrng, bag: [], lastType: '', lastRun: 0, prevPair: false, nextSpawnX: 200, items: [] };
  const refill = () => { const add = BAG.slice(); for (let i = add.length - 1; i > 0; i--) { const j = (w.rng() * (i + 1)) | 0; [add[i], add[j]] = [add[j], add[i]]; } w.bag = w.bag.concat(add); };
  const pick = (b) => { for (let k = w.bag.length - 1; k >= 0; k--) { if (b === null || w.bag[k] !== b) return k; } return -1; };
  const nextType = () => {
    if (!w.bag.length) refill();
    const blocked = (w.lastRun >= 2 || (w.prevPair && w.lastRun >= 1)) ? w.lastType : null;
    let i = pick(blocked); if (i < 0) { refill(); i = pick(blocked); } if (i < 0) i = w.bag.length - 1;
    const t = w.bag.splice(i, 1)[0];
    if (t === w.lastType) w.lastRun++; else { w.prevPair = (w.lastRun === 2); w.lastRun = 1; w.lastType = t; }
    return t;
  };
  const spawn = (leadX) => {
    while (w.nextSpawnX < leadX - 70 + VW + 400) {
      const type = nextType();
      if (type === 'balloon') w.items.push({ type, x: w.nextSpawnX, y: GROUND - 64 - w.rng() * 88, used: false });
      else w.items.push({ type, x: w.nextSpawnX, used: false });
      w.nextSpawnX += 60 + w.rng() * 120;
    }
  };
  const pips = inputs.map((inp, i) => {
    const rng = xorshift((seed ^ Math.imul(i + 1, 0x9E3779B9)) >>> 0);
    let angle = inp.angle, power = inp.power;
    if (angle == null) angle = 10 + Math.floor(rng() * 51);
    if (power == null) power = Math.round(rng() * 100000) / 1000;
    const sp = 8 + (power / 100) * 13, a = angle * Math.PI / 180;
    return { slot: i, rng, angle, power, x: 33 + Math.cos(a) * 62, y: GROUND - 24 - Math.sin(a) * 62,
      vx: Math.cos(a) * sp, vy: -Math.sin(a) * sp, stuck: false, slow: 0, frames: 0, feet: 0, dead: false, how: '' };
  });
  let pframes = 0;
  const end = (p, how) => { if (p.dead) return; p.dead = true; p.how = how; p.feet = Math.max(p.feet, Math.floor((p.x - 44) / PX_PER_FT)); };
  const step = (p) => {
    if (p.dead) return;
    p.vy += 0.31; p.x += p.vx; p.y += p.vy;
    p.feet = Math.max(p.feet, Math.floor((p.x - 44) / PX_PER_FT));
    for (const it of w.items) {
      if (p.dead) break;
      if (it.type === 'balloon') {
        if (it.used) continue;
        const by = it.y + Math.sin(pframes / 22 + it.x) * 2;
        if (Math.abs(p.x - (it.x + 9)) < 22 && p.y > by - 10 && p.y < by + 28) {
          it.used = true; p.vy = -(12 + p.rng() * 5); p.vx = Math.max(p.vx * 0.9, 4) + 3 + p.rng() * 3;
        }
        continue;
      }
      if (it.type === 'trap') {
        if (Math.abs(p.x - (it.x + 11)) < 11 && Math.abs(p.y - (GROUND - 27)) < 9) { p.x = it.x + 11; p.y = GROUND - 27; p.stuck = true; end(p, 'EATEN'); }
        continue;
      }
      const wdt = (it.type === 'spikes') ? 24 : (it.type === 'tramp' ? 26 : (it.type === 'tnt' ? 15 : 18));
      if (p.x < it.x || p.x > it.x + wdt) continue;
      if (it.type === 'tnt' && !it.used && p.y > GROUND - 22) { it.used = true; p.vx = Math.max(p.vx, 5) + 4 + p.rng() * 4; p.vy = -(13 + p.rng() * 5); }
      else if (it.type === 'tramp' && p.vy > 0 && p.y > GROUND - 18) { p.y = GROUND - 18; p.vy = -Math.max(12, Math.abs(p.vy) * 1.35); p.vx *= 1.02; }
      else if (it.type === 'spikes' && p.y > GROUND - 18) { p.x = it.x + 12; p.y = GROUND - 16; p.stuck = true; end(p, 'IMPALED'); }
    }
    if (p.dead) return;
    if (!p.stuck && p.y >= GROUND - 9) {
      p.y = GROUND - 9; p.vy *= -(0.55 + p.rng() * 0.14); p.vx *= 0.972;
      if (Math.abs(p.vy) < 0.9 && Math.abs(p.vx) < 0.5) end(p, 'STOPPED');
    }
    if (p.dead) return;
    p.frames++;
    if (Math.abs(p.vx) < 0.4 && Math.abs(p.vy) < 1.2) p.slow++; else p.slow = 0;
    if (p.slow > 45 || p.frames > 12000) end(p, 'STOPPED');
  };
  while (pips.some(p => !p.dead)) {
    pframes++;
    pips.forEach(step);
    spawn(Math.max(...pips.map(p => p.x)));
    if (w.items.length > 4000) w.items = w.items.slice(-2000);
    if (pframes > 20000) break;
  }
  const ranked = pips.slice().sort((a, b) => b.feet - a.feet);
  ranked.forEach((p, i) => { p.place = i + 1; });
  return pips.map(p => ({ slot: p.slot, ft: p.feet, how: p.how, place: p.place, angle: p.angle, power: p.power }));
}
