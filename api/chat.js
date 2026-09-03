import { redis, configured, limited, ip, clean, isAddr, isName } from './_kv.js';

const KEY = 'chat:msgs';
const KEEP = 120;          // messages retained
const MAXLEN = 200;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (!configured()) {
    return res.status(503).json({ ok: false, offline: true, reason: 'storage-not-configured', messages: [] });
  }

  try {
    if (req.method === 'GET') {
      const raw = await redis('LRANGE', KEY, 0, KEEP - 1);
      const messages = (raw || []).map(s => { try { return JSON.parse(s); } catch { return null; } })
                                  .filter(Boolean).reverse();
      return res.status(200).json({ ok: true, messages });
    }

    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      const addr = String(body.addr || '').toLowerCase();
      const name = String(body.name || '').toUpperCase();
      const text = clean(body.text, MAXLEN);

      if (!isAddr(addr)) return res.status(400).json({ ok: false, error: 'bad-address' });
      if (!isName(name)) return res.status(400).json({ ok: false, error: 'bad-name' });
      if (!text)         return res.status(400).json({ ok: false, error: 'empty' });

      // the name must belong to this address, first claim wins
      const owner = await redis('GET', 'name:' + name);
      if (owner && owner !== addr) return res.status(409).json({ ok: false, error: 'name-taken' });
      if (!owner) await redis('SET', 'name:' + name, addr);

      if (await limited('chat:' + addr, 8, 60) || await limited('chat:' + ip(req), 20, 60)) {
        return res.status(429).json({ ok: false, error: 'slow-down' });
      }

      const msg = { n: name, a: addr.slice(0, 6) + '…' + addr.slice(-4), t: text, ts: Date.now() };
      await redis('LPUSH', KEY, JSON.stringify(msg));
      await redis('LTRIM', KEY, 0, KEEP - 1);
      return res.status(200).json({ ok: true, message: msg });
    }

    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ ok: false, error: 'method' });
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'server' });
  }
}
