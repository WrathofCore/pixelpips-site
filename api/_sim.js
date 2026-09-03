// Headless replay of a Pip Cannon run. Must stay in exact lockstep with the
// physics in pipcannon.html. Given (seed, angle, power) it returns the distance
// the client must have reached, so a submitted score can be recomputed rather
// than trusted.
const GROUND = 232, PX_PER_FT = 5;
const BAG = ['tnt','tnt','tnt','tramp','tramp','tramp','spikes','spikes','trap','trap','balloon','balloon'];
const W = 480, Z = 1.7, VW = Math.ceil(W / Z) + 10;

export function simulate(seed, angle, power) {
  let st = (seed >>> 0) || 1;
  const rnd = () => {
    st ^= st << 13; st >>>= 0;
    st ^= st >> 17;
    st ^= st << 5;  st >>>= 0;
    return st / 4294967296;
  };

  let bag = [], lastType = '', lastRun = 0;
  function nextType() {
    for (let guard = 0; guard < 40; guard++) {
      if (!bag.length) {
        bag = BAG.slice();
        for (let i = bag.length - 1; i > 0; i--) { const j = (rnd() * (i + 1)) | 0; [bag[i], bag[j]] = [bag[j], bag[i]]; }
      }
      const t = bag.pop();
      if (t === lastType && lastRun >= 2) { bag.unshift(t); continue; }
      lastRun = (t === lastType) ? lastRun + 1 : 1;
      lastType = t;
      return t;
    }
    return 'tramp';
  }

  let items = [], nextSpawnX = 200, cam = 0, pframes = 0, feet = 0;
  function spawnAhead() {
    while (nextSpawnX < cam + VW + 400) {
      const type = nextType();
      if (type === 'balloon') items.push({ type, x: nextSpawnX, y: GROUND - 64 - rnd() * 88, used: false });
      else items.push({ type, x: nextSpawnX, used: false });
      nextSpawnX += 90 + rnd() * 170;
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
        if (Math.abs(pip.x - (it.x + 11)) < 11 && Math.abs(pip.y - (GROUND - 27)) < 11) {
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
    if (pip.slow > 45 || pip.frames > 2700) end('STOPPED');

    cam = Math.max(0, pip.x - 70);
  }

  return { ft: feet, how };
}
