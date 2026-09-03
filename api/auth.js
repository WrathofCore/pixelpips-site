// Wallet sign-in. Two steps:
//   POST {addr}                -> {nonce, message}   the text to sign
//   POST {addr, nonce, sig}    -> {token, name}      a session bound to that address
// The signature proves the caller controls the private key, so a name can no
// longer be claimed by simply typing someone else's address into the client.
import { verifyMessage } from 'viem';
import { redis, configured, limited, ip, isAddr } from './_kv.js';

const NONCE_TTL = 300;            // seconds a nonce stays valid
const SESSION_TTL = 60 * 60 * 24 * 7;
const hex = (n) => [...crypto.getRandomValues(new Uint8Array(n))]
  .map(b => b.toString(16).padStart(2, '0')).join('');

export const message = (addr, nonce) =>
  `pixelpips.cash\n\nSign in to Pip Cannon.\n\nAddress: ${addr}\nNonce: ${nonce}\n\nThis is free and does not send a transaction.`;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!configured()) return res.status(503).json({ ok: false, offline: true, reason: 'storage-not-configured' });
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ ok: false }); }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const addr = String(body.addr || '').toLowerCase();
    if (!isAddr(addr)) return res.status(400).json({ ok: false, error: 'bad-address' });

    if (await limited('auth:' + ip(req), 30, 60)) return res.status(429).json({ ok: false, error: 'slow-down' });

    // step 1: hand out a nonce
    if (!body.sig) {
      const nonce = hex(16);
      await redis('SET', 'nonce:' + addr, nonce, 'EX', NONCE_TTL);
      return res.status(200).json({ ok: true, nonce, message: message(addr, nonce) });
    }

    // step 2: verify the signature over that exact nonce
    const nonce = String(body.nonce || '');
    const saved = await redis('GET', 'nonce:' + addr);
    if (!saved || saved !== nonce) return res.status(400).json({ ok: false, error: 'bad-nonce' });
    await redis('DEL', 'nonce:' + addr);

    let valid = false;
    try {
      valid = await verifyMessage({ address: addr, message: message(addr, nonce), signature: body.sig });
    } catch (_) { valid = false; }
    if (!valid) return res.status(401).json({ ok: false, error: 'bad-signature' });

    const token = hex(24);
    await redis('SET', 'sess:' + token, addr, 'EX', SESSION_TTL);
    const name = await redis('GET', 'addrname:' + addr);
    return res.status(200).json({ ok: true, token, addr, name: name || null });
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'server' });
  }
}

// Shared by the other routes: turn a bearer token into a verified address.
export async function addrFor(req) {
  const h = String(req.headers.authorization || '');
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!/^[a-f0-9]{48}$/.test(token)) return null;
  try { return await redis('GET', 'sess:' + token); } catch (_) { return null; }
}
