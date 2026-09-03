import { redis, configured, limited, ip, isAddr, isName } from './_kv.js';

const KEY = 'board:pipcannon';
const TOP = 20;
const MAX_FT = 500000;     // anything past this is not a real run

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (!configured()) {
    return res.status(503).json({ ok: false, offline: true, reason: 'storage-not-configured', board: [] });
  }

  try {
    if (req.method === 'GET') {
      const raw = await redis('ZRANGE', KEY, 0, TOP - 1, 'REV', 'WITHSCORES');
      const board = [];
      for (let i = 0; i < (raw || []).length; i += 2) {
        board.push({ name: raw[i], ft: Number(raw[i + 1]) });
      }
      return res.status(200).json({ ok: true, board });
    }

    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      const addr = String(body.addr || '').toLowerCase();
      const name = String(body.name || '').toUpperCase();
      const ft = Math.floor(Number(body.ft));

      if (!isAddr(addr)) return res.status(400).json({ ok: false, error: 'bad-address' });
      if (!isName(name)) return res.status(400).json({ ok: false, error: 'bad-name' });
      if (!Number.isFinite(ft) || ft <= 0 || ft > MAX_FT) {
        return res.status(400).json({ ok: false, error: 'bad-score' });
      }

      const owner = await redis('GET', 'name:' + name);
      if (owner && owner !== addr) return res.status(409).json({ ok: false, error: 'name-taken' });
      if (!owner) await redis('SET', 'name:' + name, addr);

      if (await limited('board:' + addr, 20, 60) || await limited('board:' + ip(req), 40, 60)) {
        return res.status(429).json({ ok: false, error: 'slow-down' });
      }

      // one row per name, keeps that name's best
      await redis('ZADD', KEY, 'GT', ft, name);
      const raw = await redis('ZRANGE', KEY, 0, TOP - 1, 'REV', 'WITHSCORES');
      const board = [];
      for (let i = 0; i < (raw || []).length; i += 2) board.push({ name: raw[i], ft: Number(raw[i + 1]) });
      return res.status(200).json({ ok: true, board });
    }

    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ ok: false, error: 'method' });
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'server' });
  }
}
