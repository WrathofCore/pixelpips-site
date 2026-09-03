// Minimal Upstash Redis REST client. Two env vars, no npm dependency.
//   KV_REST_API_URL, KV_REST_API_TOKEN
// Vercel's own KV integration sets KV_REST_API_*, while the Upstash
// marketplace integration sets UPSTASH_REDIS_REST_*. Accept either, plus
// REDIS_* which some setups use, so whichever one gets connected just works.
const pick = (...names) => { for (const n of names) { const v = process.env[n]; if (v) return v; } return undefined; };
const URL_  = pick('KV_REST_API_URL',   'UPSTASH_REDIS_REST_URL',   'REDIS_REST_API_URL',   'STORAGE_REST_API_URL');
const TOKEN = pick('KV_REST_API_TOKEN', 'UPSTASH_REDIS_REST_TOKEN', 'REDIS_REST_API_TOKEN', 'STORAGE_REST_API_TOKEN');

export const configured = () => Boolean(URL_ && TOKEN);

// Which env var names are actually present. Values are never exposed.
export const envReport = () => ({
  url: ['KV_REST_API_URL','UPSTASH_REDIS_REST_URL','REDIS_REST_API_URL','STORAGE_REST_API_URL'].filter(n => process.env[n]),
  token: ['KV_REST_API_TOKEN','UPSTASH_REDIS_REST_TOKEN','REDIS_REST_API_TOKEN','STORAGE_REST_API_TOKEN'].filter(n => process.env[n]),
  admin: Boolean(process.env.ADMIN_TOKEN),
  redisLike: Object.keys(process.env).filter(k => /REDIS|KV_|UPSTASH|STORAGE/i.test(k)).sort()
});

export async function redis(...cmd) {
  if (!configured()) throw new Error('kv-not-configured');
  const r = await fetch(URL_, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd)
  });
  if (!r.ok) throw new Error('kv-' + r.status);
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j.result;
}

// Fixed-window rate limit. Returns true when the caller is over the limit.
export async function limited(key, max, windowSec) {
  const bucket = `rl:${key}:${Math.floor(Date.now() / 1000 / windowSec)}`;
  const n = await redis('INCR', bucket);
  if (n === 1) await redis('EXPIRE', bucket, windowSec);
  return n > max;
}

export const ip = (req) =>
  (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';

export function clean(s, max) {
  return String(s == null ? '' : s)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')   // control chars
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

export const isAddr = (a) => /^0x[a-fA-F0-9]{40}$/.test(String(a || ''));
export const isName = (n) => /^[A-Z0-9_]{3,14}$/.test(String(n || ''));
