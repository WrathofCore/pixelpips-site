// Online races. A room collects up to 8 signed-in players and their locked
// inputs; the server hands out one seed and a start time, every client runs
// the identical deterministic sim, and the server replays it to rank and to
// keep a race leaderboard. Nothing streams during the race itself.
import { redis, configured, limited, ip, isName } from './_kv.js';
import { addrFor } from './auth.js';
import { simulateRace } from './_sim.js';

const MAX = 8, COUNTDOWN_MS = 12000, ROOM_TTL = 1800, LOCK_GRACE_MS = 1500;
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const code = () => Array.from(crypto.getRandomValues(new Uint8Array(4))).map(b => ALPHA[b % ALPHA.length]).join('');

const key = (c) => 'race:' + c;
const load = async (c) => { const s = await redis('GET', key(c)); return s ? JSON.parse(s) : null; };
const save = (room) => redis('SET', key(room.code), JSON.stringify(room), 'EX', ROOM_TTL);

const publicRoom = (room, addr) => ({
  code: room.code, host: room.host, phase: room.phase, startAt: room.startAt || null, seed: room.seed ?? null,
  players: room.players.map(p => ({ name: p.name, locked: p.angle != null, me: p.addr === addr })),
  // inputs are only revealed once the countdown has expired
  inputs: (room.phase === 'running' || room.phase === 'done') ? room.players.map(p => ({ angle: p.angle, power: p.power })) : null,
  result: room.result || null,
  now: Date.now()
});

async function boardTop() {
  const raw = await redis('ZRANGE', 'raceboard', 0, 19, 'REV', 'WITHSCORES');
  const out = []; for (let i = 0; i < (raw || []).length; i += 2) out.push({ name: raw[i], wins: Number(raw[i + 1]) });
  return out;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!configured()) return res.status(503).json({ ok: false, offline: true });

  try {
    if (req.method === 'GET') {
      const url = new URL(req.url, 'http://x');
      if (url.searchParams.get('board')) return res.status(200).json({ ok: true, board: await boardTop() });
      const c = String(url.searchParams.get('code') || '').toUpperCase();
      const room = await load(c);
      if (!room) return res.status(404).json({ ok: false, error: 'no-room' });
      // countdown expiry promotes the room to running so inputs become visible
      if (room.phase === 'countdown' && Date.now() >= room.startAt + LOCK_GRACE_MS) { room.phase = 'running'; await save(room); }
      const addr = await addrFor(req);
      return res.status(200).json({ ok: true, room: publicRoom(room, addr) });
    }

    if (req.method !== 'POST') { res.setHeader('Allow', 'GET, POST'); return res.status(405).json({ ok: false }); }

    const addr = await addrFor(req);
    if (!addr) return res.status(401).json({ ok: false, error: 'sign-in-required' });
    if (await redis('GET', 'banned:' + addr)) return res.status(403).json({ ok: false, error: 'banned' });
    const name = await redis('GET', 'addrname:' + addr);
    if (!isName(name || '')) return res.status(400).json({ ok: false, error: 'no-name' });
    if (await limited('race:' + addr, 60, 60) || await limited('raceip:' + ip(req), 120, 60)) return res.status(429).json({ ok: false, error: 'slow-down' });

    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const action = String(body.action || '');

    if (action === 'create' || action === 'open') {
      let c = action === 'open' ? 'OPEN' : code();
      let room = await load(c);
      if (room && action === 'open' && room.phase !== 'lobby') {
        // the OPEN room is mid-race; tell the client to wait, unless it is stale
        if (Date.now() - (room.updated || 0) < 240000) return res.status(409).json({ ok: false, error: 'in-progress', room: publicRoom(room, addr) });
        room = null;
      }
      if (!room) {
        room = { code: c, host: addr, phase: 'lobby', players: [], created: Date.now(), updated: Date.now() };
      }
      if (!room.players.find(p => p.addr === addr)) {
        if (room.players.length >= MAX) return res.status(409).json({ ok: false, error: 'full' });
        room.players.push({ addr, name, angle: null, power: null });
      }
      room.updated = Date.now();
      await save(room);
      return res.status(200).json({ ok: true, room: publicRoom(room, addr) });
    }

    const c = String(body.code || '').toUpperCase();
    const room = await load(c);
    if (!room) return res.status(404).json({ ok: false, error: 'no-room' });

    if (action === 'join') {
      if (room.phase !== 'lobby') return res.status(409).json({ ok: false, error: 'in-progress' });
      if (!room.players.find(p => p.addr === addr)) {
        if (room.players.length >= MAX) return res.status(409).json({ ok: false, error: 'full' });
        room.players.push({ addr, name, angle: null, power: null });
      }
      room.updated = Date.now(); await save(room);
      return res.status(200).json({ ok: true, room: publicRoom(room, addr) });
    }

    if (action === 'leave') {
      if (room.phase === 'lobby') {
        room.players = room.players.filter(p => p.addr !== addr);
        if (room.host === addr && room.players.length) room.host = room.players[0].addr;
        room.updated = Date.now();
        if (!room.players.length) await redis('DEL', key(c)); else await save(room);
      }
      return res.status(200).json({ ok: true });
    }

    if (action === 'start') {
      if (room.host !== addr) return res.status(403).json({ ok: false, error: 'host-only' });
      if (room.phase !== 'lobby') return res.status(409).json({ ok: false, error: 'already-started' });
      if (room.players.length < 2) return res.status(400).json({ ok: false, error: 'need-two' });
      room.phase = 'countdown';
      room.seed = crypto.getRandomValues(new Uint32Array(1))[0] >>> 0;
      room.startAt = Date.now() + COUNTDOWN_MS;
      room.updated = Date.now(); await save(room);
      return res.status(200).json({ ok: true, room: publicRoom(room, addr) });
    }

    if (action === 'lock') {
      if (room.phase !== 'countdown') return res.status(409).json({ ok: false, error: 'not-aiming' });
      if (Date.now() > room.startAt + LOCK_GRACE_MS) return res.status(409).json({ ok: false, error: 'too-late' });
      const me = room.players.find(p => p.addr === addr);
      if (!me) return res.status(403).json({ ok: false, error: 'not-in-room' });
      if (me.angle != null) return res.status(409).json({ ok: false, error: 'already-locked' });
      const angle = Number(body.angle), power = Number(body.power);
      if (!Number.isFinite(angle) || angle < 10 || angle > 60) return res.status(400).json({ ok: false, error: 'bad-angle' });
      if (!Number.isFinite(power) || power < 0 || power > 100) return res.status(400).json({ ok: false, error: 'bad-power' });
      me.angle = Math.round(angle); me.power = Math.round(power * 1000) / 1000;
      room.updated = Date.now(); await save(room);
      return res.status(200).json({ ok: true, room: publicRoom(room, addr) });
    }

    if (action === 'result') {
      // idempotent: first caller after the countdown settles the race
      if (room.phase === 'countdown' && Date.now() >= room.startAt + LOCK_GRACE_MS) room.phase = 'running';
      if (room.phase === 'done') return res.status(200).json({ ok: true, room: publicRoom(room, addr) });
      if (room.phase !== 'running') return res.status(409).json({ ok: false, error: 'not-finished' });
      const claim = await redis('SET', 'race:settle:' + c, addr, 'NX', 'EX', 60);
      if (!claim) { await new Promise(r => setTimeout(r, 400)); const again = await load(c); return res.status(200).json({ ok: true, room: publicRoom(again, addr) }); }
      const out = simulateRace(room.seed, room.players.map(p => ({ angle: p.angle, power: p.power })));
      room.result = out.map((r, i) => ({ name: room.players[i].name, ft: r.ft, how: r.how, place: r.place }));
      room.phase = 'done'; room.updated = Date.now();
      const winner = room.result.find(r => r.place === 1);
      if (winner) await redis('ZINCRBY', 'raceboard', 1, winner.name);
      await save(room);
      return res.status(200).json({ ok: true, room: publicRoom(room, addr) });
    }

    return res.status(400).json({ ok: false, error: 'bad-action' });
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'server' });
  }
}
