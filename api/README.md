# Pip Cannon API

Vercel serverless functions. Storage is Upstash Redis via two env vars.

| Env var | Purpose |
|---|---|
| `KV_REST_API_URL` | set automatically when you connect Upstash in the Vercel dashboard |
| `KV_REST_API_TOKEN` | same |
| `ADMIN_TOKEN` | set this yourself, any long random string. Enables moderation. |

Without the KV vars every route returns 503 with `{"ok":false,"offline":true}` and
the site shows the panels as offline. Nothing breaks.

## Routes

- `POST /api/auth` `{addr}` → `{nonce, message}`; then `{addr, nonce, sig}` → `{token}`
- `POST /api/name` `{name}` with `Authorization: Bearer <token>`
- `GET  /api/chat` → `{messages}` · `POST /api/chat` `{text}` with bearer token
- `GET  /api/board` → `{board}` · `POST /api/board` `{seed, angle, power}` with bearer token
- `DELETE /api/chat?id=…` or `?all=1` — header `x-admin-token`
- `DELETE /api/board?name=NAME[&ban=1]` — header `x-admin-token`

## Moderation from the terminal

    # delete one message
    curl -X DELETE "https://pixelpips.cash/api/chat?id=MESSAGE_ID" -H "x-admin-token: $ADMIN_TOKEN"

    # wipe the chat
    curl -X DELETE "https://pixelpips.cash/api/chat?all=1" -H "x-admin-token: $ADMIN_TOKEN"

    # remove a score, and ban the wallet behind it
    curl -X DELETE "https://pixelpips.cash/api/board?name=SOMENAME&ban=1" -H "x-admin-token: $ADMIN_TOKEN"

Message ids are in the `GET /api/chat` response.

## Why scores can't be faked

The client never sends a distance. It sends the three inputs of the run
(`seed`, `angle`, `power`) and `_sim.js` replays the same deterministic physics
server side to compute the distance itself. A seed can only be scored once per
wallet. `_sim.js` must stay in lockstep with the physics in `pipcannon.html`:
if you change gravity, bounce, hazard behaviour or spawn rules, change both.

## Online races: `/api/race`

All POSTs need a signed-in session and a claimed name.

- `POST {action:'open'}` join the standing OPEN room (created if missing)
- `POST {action:'create'}` new private room, returns a 4-letter code
- `POST {action:'join', code}` · `{action:'leave', code}`
- `POST {action:'start', code}` host only, needs 2+ players. Sets seed + startAt (12s).
- `POST {action:'lock', code, angle, power}` during the countdown, once per player
- `GET  /api/race?code=XXXX` room state. Inputs are hidden until the countdown ends.
- `POST {action:'result', code}` first caller after the countdown triggers the server replay. Idempotent.
- `GET  /api/race?board=1` race leaderboard, wins per name.

The seed is server-chosen and inputs are locked before it is revealed to clients. Ranking always comes from `simulateRace` in `_sim.js`, never from a client.
