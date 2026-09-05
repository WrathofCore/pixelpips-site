#!/usr/bin/env node
// racebot.mjs — a second signed-in player for testing online races solo.
//
// This is a dev tool. It is not part of the game and nothing in the deployed
// site knows it exists. It holds its own key, signs in through /api/auth the
// same way a browser does, claims a name, joins a room, locks a shot, and then
// asks the server to settle. It prints the server's ranking and independently
// replays the race with the local api/_sim.js so a stale deploy shows up as a
// mismatch instead of passing quietly.
//
//   node tools/racebot.mjs create        make a private room, print the code, wait
//   node tools/racebot.mjs join XFCD     join a room you made in the browser
//   node tools/racebot.mjs open          join the standing OPEN room
//
// env:
//   PIPBOT_KEY    0x-prefixed private key. Generated and printed if unset.
//   PIPBOT_NAME   name to claim, default TESTPIP
//   PIPBOT_BASE   default https://pixelpips.cash
//   PIPBOT_ANGLE  10..60, default random
//   PIPBOT_POWER  0..100, default random

import { createWalletClient, http } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { simulateRace } from '../api/_sim.js';

const BASE = process.env.PIPBOT_BASE || 'https://pixelpips.cash';
const NAME = process.env.PIPBOT_NAME || 'TESTPIP';
const [cmd, arg] = process.argv.slice(2);

let key = process.env.PIPBOT_KEY;
if (!key) {
  key = generatePrivateKey();
  console.log('\nNo PIPBOT_KEY set, generated one. Save it or the name is lost:\n');
  console.log('  export PIPBOT_KEY=' + key + '\n');
}
const account = privateKeyToAccount(key);
const wallet = createWalletClient({ account, transport: http(BASE) });

const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function api(path, opts = {}) {
  const r = await fetch(BASE + path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    cache: 'no-store'
  });
  const text = await r.text();
  let body;
  try { body = JSON.parse(text); }
  catch { throw new Error(path + ' returned non-JSON (' + r.status + '): ' + text.slice(0, 200)); }
  return { status: r.status, body };
}

let token = null;
const auth = () => (token ? { Authorization: 'Bearer ' + token } : {});
const post = (path, body) =>
  api(path, { method: 'POST', body: JSON.stringify(body), headers: auth() });

async function signIn() {
  log('addr    ' + account.address);
  const a = await post('/api/auth', { addr: account.address });
  if (!a.body.message) throw new Error('auth step 1 failed: ' + JSON.stringify(a.body));
  const sig = await wallet.signMessage({ account, message: a.body.message });
  const b = await post('/api/auth', { addr: account.address, nonce: a.body.nonce, sig });
  if (!b.body.token) throw new Error('auth step 2 failed: ' + JSON.stringify(b.body));
  token = b.body.token;
  log('signed in');

  const n = await post('/api/name', { name: NAME });
  if (n.body.ok) log('name    ' + NAME);
  else log('name    ' + NAME + ' (' + (n.body.error || 'already held') + ') — continuing');
}

async function room(code) {
  const r = await api('/api/race?code=' + encodeURIComponent(code));
  if (!r.body.ok) throw new Error('room read failed: ' + JSON.stringify(r.body));
  return r.body.room;
}

async function enter() {
  if (cmd === 'join') {
    if (!arg) throw new Error('join needs a room code: node tools/racebot.mjs join XFCD');
    const r = await post('/api/race', { action: 'join', code: arg.toUpperCase() });
    if (!r.body.ok) throw new Error('join failed: ' + JSON.stringify(r.body));
    return r.body.room;
  }
  if (cmd === 'open') {
    const r = await post('/api/race', { action: 'open' });
    if (!r.body.ok) throw new Error('open failed: ' + JSON.stringify(r.body));
    return r.body.room;
  }
  if (cmd === 'create') {
    const r = await post('/api/race', { action: 'create' });
    if (!r.body.ok) throw new Error('create failed: ' + JSON.stringify(r.body));
    return r.body.room;
  }
  throw new Error('usage: node tools/racebot.mjs create | join CODE | open');
}

async function main() {
  await signIn();
  let r = await enter();
  log('room    ' + r.code + '  phase ' + r.phase);
  if (cmd === 'create') log('\n  >>> join ' + r.code + ' in the browser, then press START <<<\n');
  else log('\n  >>> press START in the browser <<<\n');

  // wait for the host to start
  const waitedFrom = Date.now();
  while (r.phase === 'lobby') {
    if (Date.now() - waitedFrom > 300000) throw new Error('nobody started the room in 5 minutes');
    await sleep(1000);
    r = await room(r.code);
    process.stdout.write('\r  lobby: ' + r.players.map(p => p.name).join(', ') + '        ');
  }
  log('\nstarted seed ' + r.seed + '  countdown ' + Math.round((r.startAt - r.now) / 1000) + 's');

  // lock a shot while the countdown is open
  const angle = Number(process.env.PIPBOT_ANGLE ?? (10 + Math.floor(Math.random() * 51)));
  const power = Number(process.env.PIPBOT_POWER ?? Math.round(Math.random() * 100000) / 1000);
  const lk = await post('/api/race', { action: 'lock', code: r.code, angle, power });
  if (!lk.body.ok) throw new Error('lock failed: ' + JSON.stringify(lk.body));
  log('locked  angle ' + angle + '  power ' + power);

  // inputs stay hidden until the countdown expires
  while (true) {
    r = await room(r.code);
    if (r.inputs) break;
    await sleep(500);
  }
  log('\ninputs revealed:');
  r.players.forEach((p, i) => log('  ' + String(i).padEnd(2) + p.name.padEnd(14) + 'angle ' + r.inputs[i].angle + '  power ' + r.inputs[i].power));

  // settle
  let settled = null;
  for (let i = 0; i < 40 && !settled; i++) {
    const s = await post('/api/race', { action: 'result', code: r.code });
    if (s.body.ok && s.body.room && s.body.room.result) settled = s.body.room;
    else await sleep(500);
  }
  if (!settled) throw new Error('server never settled the race');

  log('\nserver ranking:');
  settled.result.slice().sort((a, b) => a.place - b.place)
    .forEach(x => log('  ' + x.place + '. ' + x.name.padEnd(14) + String(x.ft).padStart(7) + ' ft   ' + x.how));

  // independent replay against the local _sim.js
  const mine = simulateRace(settled.seed, settled.inputs.map(x => ({ angle: x.angle, power: x.power })));
  const drift = mine.filter((m, i) => m.ft !== settled.result[i].ft || m.place !== settled.result[i].place);
  if (!drift.length) {
    log('\nlocal _sim.js replay agrees with the server on all ' + mine.length + ' slots.');
  } else {
    log('\n*** MISMATCH between the deployed server and your local api/_sim.js ***');
    drift.forEach(m => log('  slot ' + m.slot + '  local ' + m.ft + ' ft / place ' + m.place +
      '   server ' + settled.result[m.slot].ft + ' ft / place ' + settled.result[m.slot].place));
    log('\nThe deploy is stale, or _sim.js changed without a redeploy.');
    process.exitCode = 1;
  }
  log('\nNow compare the ranking above against what the browser showed you.');
}

main().catch(e => { console.error('\n' + e.message); process.exit(1); });
