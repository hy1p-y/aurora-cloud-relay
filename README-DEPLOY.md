# Aurora Cloud Relay v2 — Deploy Guide

A tiny always-on bridge between the **VANTA desktop exe** and your
**own Telegram account (userbot)** + **WhatsApp**. It holds the messenger
connections open 24/7 on a free cloud host, buffers incoming messages, and
relays actions from your PC. Zero bot logic lives here — the exe is the brain.

```
VANTA.exe (your PC)  ←HTTPS poll/POST→  relay (free host)  ←MTProto/WS→  Telegram (YOUR account)
                                                                  ↘ WebSocket → WhatsApp (QR / pairing code)
```

## What's new in v2

- **Telegram runs as YOUR OWN ACCOUNT** (MTProto userbot via GramJS) —
  no BotFather bot. Login from the exe with phone + code (+ 2FA password
  if set) or by scanning a Telegram QR (Settings → Devices → Link Desktop
  Device). Modules then send/listen as you.
- **WhatsApp pairing by 8-digit phone code** in addition to QR — more
  reliable than QR on many networks (Settings → Linked devices → Link
  with phone number).
- **Session backup**: every login is exported to the exe
  (`vanta-session.bin`). When a free host restarts and wipes its disk,
  VANTA automatically re-uploads the sessions — logins survive restarts.
- Stale-QR bug fixed (socket generation tracking), smarter reconnects,
  lighter footprint for free tiers.

## Requirements

- A free host that keeps a process running: **Render** (recommended),
  Koyeb, Railway, Fly.io, HF Spaces…
- A GitHub account (repo used for deploys).

## Deploy on Render (~5 minutes)

1. **Push this folder to GitHub**
   ```powershell
   cd "aurora-cloud-server"
   git init
   git add .
   git commit -m "relay v2"
   git branch -M main
   git remote add origin https://github.com/<you>/aurora-cloud-relay.git
   git push -u origin main
   ```
   (`.gitignore` already excludes `.env`, `data/`, `node_modules/`.)

2. **Create the service**
   - render.com → **New → Web Service** → connect the repo
   - Runtime: **Docker** (uses the included `Dockerfile`)
   - Plan: **Free**
   - Environment variables:
     | Var | Value |
     |-----|-------|
     | `AUTH_TOKEN` | long random secret (the exe uses this) |
     | `TG_API_ID` / `TG_API_HASH` | *optional* — can be set later from the exe UI |
     | `RELAY_NAME` | optional pretty name |
   - Deploy.

3. **Verify**: open `https://<your-service>.onrender.com/health` →
   `{"ok":true,"v":"2.0.0"}`. The status page shows Telegram
   *api keys needed* and WhatsApp *disconnected* — that's normal until
   you link from the exe.

4. **Connect VANTA**: Cloud page → relay url + access token (`AUTH_TOKEN`)
   → CONNECT. Then:
   - **Telegram**: save your `api_id`/`api_hash` (my.telegram.org →
     API development tools) → phone → code → (2FA password) — done.
   - **WhatsApp**: scan the QR shown in the Cloud tab, or type your phone
     number and use **pair by code**.

## Upgrading an existing v1 deployment

Your relay already runs v1 (bot-token Telegram)? Upgrade:

1. Replace the files in this folder with the v2 ones
   (`src/index.ts`, `package.json`, `render.yaml`, `.env.example`,
   `README-DEPLOY.md`, `Dockerfile`).
2. Commit + push:
   ```powershell
   git add .
   git commit -m "v2: telegram userbot + pairing code + session backup"
   git push
   ```
   Render redeploys automatically (~2-3 min). `AUTH_TOKEN` and your
   WhatsApp session… note that Telegram **bot tokens are gone** in v2 —
   you log in with your own account instead (from the exe).
3. Verify `/health` shows `"v":"2.0.0"`.

## Local run (for testing)

```powershell
cd aurora-cloud-server
npm install
npm start          # needs Node 18+ (tsx runs src/index.ts directly)
```

Status page: `http://localhost:8080/` · API auth: `AUTH_TOKEN`
(auto-generated into `data/token.txt` if not set — it's printed in the
console on first boot).

## Environment variables

| Var | Required | Purpose |
|-----|----------|---------|
| `AUTH_TOKEN` | yes (on hosts) | shared secret the exe authenticates with |
| `TG_API_ID` | optional | Telegram api id — usually set from the exe UI instead |
| `TG_API_HASH` | optional | Telegram api hash — usually set from the exe UI instead |
| `RELAY_NAME` | no | display name on the status page |
| `DATA_DIR` | no | where sessions/token live (default `./data`) |
| `PORT` | no | HTTP port (hosts inject this automatically) |

## API surface (all token-gated)

| Route | Method | Purpose |
|-------|--------|---------|
| `/health` | GET | liveness probe (no auth) |
| `/api/status` | GET | relay + telegram + whatsapp + sessions state |
| `/api/events?after=` | GET | long-poll message/event feed |
| `/api/actions` | POST | send/typing/read/delete/edit/react on tg or wa |
| `/api/qr?platform=wa\|tg` | GET | current pairing QR (+ wa pairing code) |
| `/api/tg/login` | POST | login flow: phone → code → password (or QR) |
| `/api/config` | POST | set tg api keys, request wa pair/logout |
| `/api/session/export` | GET | session blob for PC backup |
| `/api/session/import` | POST | restore sessions (used by the exe) |

## Free-tier notes

- Render free sleeps after ~15 min idle; the exe's polling wakes it.
  First request after sleep can take ~30-60 s (cold start) — the exe UI
  stays responsive, jobs retry automatically.
- Free-tier disks are **ephemeral** — sessions vanish on restart. The exe
  re-uploads `vanta-session.bin` automatically whenever it's online, so
  keep the exe running occasionally (or use a paid tier / persistent disk).
- One relay = one Telegram account + one WhatsApp number.

## Security

- All `/api/*` routes require the `AUTH_TOKEN` (timing-safe compare).
- Never commit `.env` or `data/` (already in `.gitignore`).
- The Telegram session string = full account access. It lives on the
  relay host + your PC backup only.
