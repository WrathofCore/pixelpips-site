import { redis, configured, limited, ip, clean, isName } from './_kv.js';
import { addrFor } from './auth.js';

const KEY = 'chat:msgs', KEEP = 120, MAXLEN = 200;

const read = async () => {
  const raw = await redis('LRANGE', KEY, 0, KEEP - 1);
  return (raw || []).map(s => { try { return JSON.parse(s); } catch { return null; } })
                    .filter(Boolean).reverse();
};

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!configured()) {
    return res.status(503).json({ ok: false, offline: true, reason: 'storage-not-configured', messages: [] });
  }

  try {
    if (req.method === 'GET') return res.status(200).json({ ok: true, messages: await read() });

    if (req.method === 'POST') {
      const addr = await addrFor(req);
      if (!addr) return res.status(401).json({ ok: false, error: 'sign-in-required' });
      if (await redis('GET', 'banned:' + addr)) return res.status(403).json({ ok: false, error: 'banned' });

      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      const text = clean(body.text, MAXLEN);
      if (!text) return res.status(400).json({ ok: false, error: 'empty' });

      const name = await redis('GET', 'addrname:' + addr);
      if (!isName(name || '')) return res.status(400).json({ ok: false, error: 'no-name' });

      if (await limited('chat:' + addr, 8, 60) || await limited('chatip:' + ip(req), 20, 60)) {
        return res.status(429).json({ ok: false, error: 'slow-down' });
      }

      const msg = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7), n: name, t: text, ts: Date.now() };
      await redis('LPUSH', KEY, JSON.stringify(msg));
      await redis('LTRIM', KEY, 0, KEEP - 1);
      return res.status(200).json({ ok: true, message: msg });
    }

    // moderation: DELETE /api/chat?id=…  or ?all=1, admin token only
    if (req.method === 'DELETE') {
      const admin = process.env.ADMIN_TOKEN;
      const given = String(req.headers['x-admin-token'] || '');
      if (!admin || given !== admin) return res.status(401).json({ ok: false, error: 'admin-only' });

      const url = new URL(req.url, 'http://x');
      if (url.searchParams.get('all')) { await redis('DEL', KEY); return res.status(200).json({ ok: true, cleared: true }); }
      const id = url.searchParams.get('id');
      if (!id) return res.status(400).json({ ok: false, error: 'need-id' });

      const raw = await redis('LRANGE', KEY, 0, KEEP - 1);
      const keep = (raw || []).filter(s => { try { return JSON.parse(s).id !== id; } catch { return true; } });
      await redis('DEL', KEY);
      if (keep.length) await redis('RPUSH', KEY, ...keep);
      return res.status(200).json({ ok: true, removed: (raw || []).length - keep.length, messages: await read() });
    }

    res.setHeader('Allow', 'GET, POST, DELETE');
    return res.status(405).json({ ok: false, error: 'method' });
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'server' });
  }
}
