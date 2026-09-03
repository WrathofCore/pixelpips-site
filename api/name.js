// Claim a display name. Requires a signed-in session, so a name is permanently
// bound to a wallet that proved ownership.
import { redis, configured, isName } from './_kv.js';
import { addrFor } from './auth.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!configured()) return res.status(503).json({ ok: false, offline: true });
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ ok: false }); }

  const addr = await addrFor(req);
  if (!addr) return res.status(401).json({ ok: false, error: 'sign-in-required' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const name = String(body.name || '').toUpperCase();
    if (!isName(name)) return res.status(400).json({ ok: false, error: 'bad-name' });
    if (await redis('GET', 'banned:' + addr)) return res.status(403).json({ ok: false, error: 'banned' });

    const owner = await redis('GET', 'name:' + name);
    if (owner && owner !== addr) return res.status(409).json({ ok: false, error: 'name-taken' });

    const prev = await redis('GET', 'addrname:' + addr);
    if (prev && prev !== name) await redis('DEL', 'name:' + prev);
    await redis('SET', 'name:' + name, addr);
    await redis('SET', 'addrname:' + addr, name);
    return res.status(200).json({ ok: true, name });
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'server' });
  }
}
