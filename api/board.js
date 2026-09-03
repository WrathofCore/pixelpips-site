// Scores are never trusted. The client submits the inputs of its run and the
// server replays the same deterministic physics to compute the distance itself.
import { redis, configured, limited, ip, isName } from './_kv.js';
import { addrFor } from './auth.js';
import { simulate } from './_sim.js';

const KEY = 'board:pipcannon', TOP = 20, MAX_FT = 500000;

const readBoard = async () => {
  const raw = await redis('ZRANGE', KEY, 0, TOP - 1, 'REV', 'WITHSCORES');
  const board = [];
  for (let i = 0; i < (raw || []).length; i += 2) board.push({ name: raw[i], ft: Number(raw[i + 1]) });
  return board;
};

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!configured()) {
    return res.status(503).json({ ok: false, offline: true, reason: 'storage-not-configured', board: [] });
  }

  try {
    if (req.method === 'GET') return res.status(200).json({ ok: true, board: await readBoard() });

    if (req.method === 'POST') {
      const addr = await addrFor(req);
      if (!addr) return res.status(401).json({ ok: false, error: 'sign-in-required' });
      if (await redis('GET', 'banned:' + addr)) return res.status(403).json({ ok: false, error: 'banned' });

      const name = await redis('GET', 'addrname:' + addr);
      if (!isName(name || '')) return res.status(400).json({ ok: false, error: 'no-name' });

      if (await limited('board:' + addr, 20, 60) || await limited('boardip:' + ip(req), 40, 60)) {
        return res.status(429).json({ ok: false, error: 'slow-down' });
      }

      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      const seed = Number(body.seed) >>> 0;
      const angle = Number(body.angle);
      const power = Number(body.power);
      if (!Number.isFinite(angle) || angle < 10 || angle > 60) return res.status(400).json({ ok: false, error: 'bad-angle' });
      if (!Number.isFinite(power) || power < 0 || power > 100) return res.status(400).json({ ok: false, error: 'bad-power' });

      // a seed may only be scored once, so a good run cannot be replayed for free
      const fresh = await redis('SET', 'used:' + addr + ':' + seed, '1', 'NX', 'EX', 604800);
      if (!fresh) return res.status(409).json({ ok: false, error: 'seed-already-used' });

      const { ft, how } = simulate(seed, angle, power);
      if (!Number.isFinite(ft) || ft <= 0 || ft > MAX_FT) return res.status(400).json({ ok: false, error: 'bad-score' });

      await redis('ZADD', KEY, 'GT', ft, name);
      return res.status(200).json({ ok: true, ft, how, board: await readBoard() });
    }

    // moderation: DELETE /api/board?name=…  optional &ban=1
    if (req.method === 'DELETE') {
      const admin = process.env.ADMIN_TOKEN;
      if (!admin || String(req.headers['x-admin-token'] || '') !== admin) {
        return res.status(401).json({ ok: false, error: 'admin-only' });
      }
      const url = new URL(req.url, 'http://x');
      const name = String(url.searchParams.get('name') || '').toUpperCase();
      if (!isName(name)) return res.status(400).json({ ok: false, error: 'bad-name' });
      await redis('ZREM', KEY, name);
      if (url.searchParams.get('ban')) {
        const owner = await redis('GET', 'name:' + name);
        if (owner) await redis('SET', 'banned:' + owner, '1');
      }
      return res.status(200).json({ ok: true, board: await readBoard() });
    }

    res.setHeader('Allow', 'GET, POST, DELETE');
    return res.status(405).json({ ok: false, error: 'method' });
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'server' });
  }
}
