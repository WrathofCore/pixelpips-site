// Diagnostic. Reports which storage env vars are visible and whether a real
// round trip to Redis works. Never returns any secret value.
import { redis, configured, envReport } from './_kv.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const env = envReport();
  if (!configured()) {
    return res.status(503).json({
      ok: false, storage: 'not-configured', env,
      hint: 'Connect a Redis database to this project in Vercel > Storage, then redeploy so the variables reach the build.'
    });
  }
  try {
    const stamp = 'health-' + Date.now();
    await redis('SET', 'health:probe', stamp, 'EX', 60);
    const back = await redis('GET', 'health:probe');
    return res.status(200).json({ ok: back === stamp, storage: 'connected', roundTrip: back === stamp, env });
  } catch (e) {
    return res.status(500).json({ ok: false, storage: 'error', error: String(e && e.message || e), env });
  }
}
