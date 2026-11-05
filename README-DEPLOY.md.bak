# ☁️ Aurora Cloud Relay — Deployment Guide

**Aurora Cloud Relay** is a deliberately dumb, always-online pipe between the **AuroraSuite.exe** desktop app and your **Telegram / WhatsApp** accounts. It runs as one small Node.js process on free cloud hosting so your PC doesn't need to stay on. All the automation logic (auto-replies, commands, AI, scheduling) lives entirely inside the desktop exe — the relay holds the platform connections open 24/7, queues incoming messages in an in-memory event buffer while your PC is off, and forwards exe-issued actions (send / typing / read / react) back out to Telegram or WhatsApp. Nothing else. No database, no framework, no bot brain.

**Files in this folder:** `src/index.ts` (whole server), `package.json`, `Dockerfile`, `render.yaml` (Render blueprint), `.env.example`, `.gitignore`, this guide.

---

## 🤔 Why not Vercel?

You asked about Vercel — here's the honest, kind answer: **it won't work for this app.**

Vercel is a **serverless** platform. Functions spin up per-request, respond, and then **sleep**. There is no persistent process and no long-lived socket. That's fatal for a relay like this:

- ❌ **WhatsApp (Baileys)** needs a **persistent WebSocket** to Meta's servers plus session files on disk. Serverless functions can't hold either.
- ❌ **Telegram long-polling** (`getUpdates` with a 20 s timeout) needs one process that loops forever. Serverless invocations end after seconds.
- ❌ **Event buffering while your PC is off** needs memory that survives between requests. Serverless has none.
- ❌ Ephemeral, read-only-ish filesystems and 250 MB function limits make Baileys flaky at best.

So the relay needs a **"real" always-on container** — and that's exactly what the Dockerfile here targets. Good news: plenty of free hosts run it just fine.

> ✅ **Recommended instead:** Render → Koyeb → HF Spaces → Railway → Fly.io (details below).

---

## 🏆 Free tier pick order

| # | Platform | Free offering | Caveat |
|---|----------|---------------|--------|
| 1️⃣ | **Render** | Free web service (Docker) | Sleeps after ~15 min idle; **ephemeral disk** |
| 2️⃣ | **Koyeb** | One free instance | Ephemeral disk; occasional cold starts |
| 3️⃣ | **HF Spaces** | Free CPU Basic (Docker SDK) | Must set `PORT=7860`; ephemeral disk; public logs |
| 4️⃣ | **Railway** | $5 one-time trial credit | Credit runs out → pay; **volumes available** for persistence |
| 5️⃣ | **Fly.io** | Tiny free allowance (card often required) | CLI-heavy; volumes available |

**Honest caveats you should internalize before deploying:**

- 💤 **Free tiers sleep.** Render free web services spin down after ~15 minutes without inbound HTTP traffic. When the relay sleeps, Telegram/WhatsApp go offline until the next request wakes it (the exe's long-poll `/api/events` calls keep it awake while your PC is on).
- 🧹 **Free disks are ephemeral.** Every redeploy, restart, or sleep-wake cycle wipes the container filesystem. That means the **WhatsApp pairing session is lost** → the relay shows a fresh QR and you re-scan it. That takes **~10 seconds**, so it's annoying, not fatal.
- 🤖 **Telegram survives instantly.** The bot is just a token — no files, no pairing — so Telegram reconnects the moment the container boots.
- 💎 **Want a stable always-on WhatsApp session?** Move to a paid tier (Render Starter is a few $/mo), or attach a **persistent volume** (Railway volumes, Fly volumes, Render disk on paid plans) and point `DATA_DIR` at it. Then one QR scan lasts basically forever.

---

## 🚀 Deploy, step by step

The same 4 files deploy everywhere. **Push this `cloud/` folder's contents to a GitHub repo first** (Render, Koyeb and Railway all build from GitHub):

```bash
cd cloud
git init && git add . && git commit -m "aurora cloud relay"
git remote add origin https://github.com/YOURNAME/aurora-cloud-relay.git
git push -u origin main
```

### 1️⃣ Render (recommended — easiest)

1. Push the files to GitHub (above). Make sure `Dockerfile` and `render.yaml` are in the repo root.
2. Go to **https://dashboard.render.com** and log in (GitHub login is fine).
3. Click **New +** (top right) → **Web Service**.
4. **Connect a repository** → pick your `aurora-cloud-relay` repo → **Connect**.
5. Fill in the form:
   - **Name:** `aurora-cloud-relay`
   - **Language / Runtime:** leave it on **Docker** (Render auto-detects the Dockerfile — do *not* pick Node/Bun, you want the container build).
   - **Region:** whatever is closest.
   - **Instance type:** **Free**.
6. **Environment variables** — click **Add environment variable** and add:
   - `AUTH_TOKEN` → a long random secret (e.g. output of `openssl rand -hex 32`). If you skip it, the relay auto-generates one and shows it on the status page.
   - `TELEGRAM_BOT_TOKEN` → optional now; you can also set it later from the exe via `POST /api/config`.
   - `RELAY_NAME` → optional display name (defaults to `Aurora Cloud Relay`).
7. Click **Create Web Service**. Render builds the Docker image (npm install + copy — usually 2–4 min).
8. Watch the **Events / Logs** tab. When it prints `listening on :8080`, open your URL:
   `https://aurora-cloud-relay-xxxx.onrender.com/` → you should see the ⚡ status page.

> 📋 **Blueprint alternative:** the included `render.yaml` lets Render pre-fill all of this. In the dashboard choose **New → Blueprint**, select the repo, and Render creates the service with `healthCheckPath: /health` and prompts you to fill `AUTH_TOKEN` / `TELEGRAM_BOT_TOKEN` (marked `sync: false`). Then just click Apply.

### 2️⃣ Koyeb

1. Push to GitHub (same as above).
2. **https://app.koyeb.com** → **Create Service** → **GitHub** → authorize & pick the repo.
3. Builder: **Dockerfile** (auto-detected). Choose the **Free** instance type.
4. Under **Environment variables**, add `AUTH_TOKEN` (and optionally `TELEGRAM_BOT_TOKEN`, `RELAY_NAME`) as *secret* or *plaintext* entries.
5. Exposed port stays `8080`; Koyeb assigns you an `*.koyeb.app` URL. Health checks can point at `/health`.

### 3️⃣ Hugging Face Spaces

1. Go to **https://huggingface.co/new-space**.
2. Space name: `aurora-cloud-relay`; SDK: **Docker**; visibility: ideally **Private** (free CPU Basic).
3. Either upload the files via the web UI, or push with git:
   `git clone https://huggingface.co/spaces/YOURNAME/aurora-cloud-relay` → copy files in → commit → push.
4. **Critical:** HF Spaces serves on port **7860**. In the Space **Settings → Variables and secrets**, add repository variable `PORT=7860`, plus secrets `AUTH_TOKEN` and optionally `TELEGRAM_BOT_TOKEN`.
5. The Space builds the Dockerfile and your URL is `https://YOURNAME-aurora-cloud-relay.hf.space/`.

### 4️⃣ Railway

1. **https://railway.app** → **New Project** → **Deploy from GitHub repo** → pick the repo.
2. Railway detects the Dockerfile automatically. In the service **Variables** tab, add `AUTH_TOKEN`, `TELEGRAM_BOT_TOKEN` (optional), `RELAY_NAME` (optional).
3. Settings → **Networking → Generate Domain** to get a public URL. Health check path: `/health`.
4. Free $5 trial credit runs the container; after that you need the Hobby plan.
5. 💾 **Bonus:** Settings → **Volumes → New Volume**, mount it at `/data` (which matches `DATA_DIR=/app/data` in the Dockerfile) and your WhatsApp session survives redeploys — one QR scan, done.

### 5️⃣ Fly.io

1. Install the `flyctl` CLI and `fly auth login`.
2. From this folder: `fly launch --name aurora-cloud-relay --region fra` → it detects the Dockerfile.
3. Set secrets: `fly secrets set AUTH_TOKEN=<hex> TELEGRAM_BOT_TOKEN=<optional>`.
4. `fly deploy`, then `fly status` / `fly logs`. Your URL: `https://aurora-cloud-relay.fly.dev`.
5. 💾 Persistence: `fly volumes create relay_data --size 1` and add a `[mounts]` section pointing at `/app/data`.

---

## 🔑 First-run setup (connecting AuroraSuite.exe)

1. **Open the relay root URL** — `https://your-app.onrender.com/` (no auth needed). The ⚡ status page shows the **AUTH_TOKEN**. (If you set `AUTH_TOKEN` yourself as an env var, use that value instead.)
2. **Paste the URL + token into AuroraSuite.exe → Cloud tab.** The exe starts long-polling `/api/events` and the status page flips to `AuroraSuite.exe CONNECTED`.
3. **Telegram:** send the bot token from [@BotFather](https://t.me/BotFather) to the exe (it `POST`s it to `/api/config`), **or** set `TELEGRAM_BOT_TOKEN` as an env var on the host. The relay connects within seconds — no pairing needed.
4. **WhatsApp:** click **"Request pairing QR"** in the exe Cloud tab (it `POST`s `{"whatsappAction":"pair"}`), then open the exe's QR view (pulls `GET /api/qr`). Scan the code with your phone: **WhatsApp → Settings → Linked devices → Link a device**. When the status page shows `wa: connected`, you're live.

---

## 📡 API reference

All `/api/*` routes require auth: **`?token=` query param** or **`Authorization: Bearer <token>`** header, matched against `AUTH_TOKEN`. `/` and `/health` are open.

| Method & path | Auth | Description |
|---|---|---|
| `GET /` | none | HTML status page: relay name, uptime, platform connection state, exe connectivity, AUTH_TOKEN |
| `GET /health` | none | `{ok:true}` — for container health checks |
| `GET /api/status?token=` | token | Relay + platform connection status, event buffer stats, agent (exe) connectivity |
| `GET /api/events?after=N&wait=25&limit=200` | token | **Long-poll** for incoming events (`tg.message` / `wa.message` / `tg.status` / `wa.status` / `sys.log`). `seq` is a monotonically increasing cursor — pass the last seen `seq` as `after` |
| `POST /api/actions` | token | Relay an action to a platform. Body: `{"action":{"platform":"tg"\|"wa","type":"send"\|"typing"\|"read"\|"react","chat":"...","text":"...","replyTo":123}}` |
| `GET /api/qr` | token | WhatsApp pairing QR as a 2D module matrix (`qrMatrix`) + raw `qrText`, for rendering inside the exe |
| `POST /api/config` | token | Set config at runtime. Body: `{"telegramBotToken":"123:abc"}` or `{"whatsappAction":"pair"\|"logout"}` |

Example — send a Telegram message with curl:

```bash
curl -X POST https://your-app.onrender.com/api/actions \
  -H "Authorization: Bearer $AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"action":{"platform":"tg","type":"send","chat":"111222333","text":"hello from the relay"}}'
```

---

## ⚙️ Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | HTTP listen port (set to `7860` on HF Spaces) |
| `AUTH_TOKEN` | auto-generated | Shared secret for the exe ↔ relay. If unset → generated at boot, saved to `data/token.txt`, shown on the status page |
| `TELEGRAM_BOT_TOKEN` | — | Optional; can also be set later from the exe via `POST /api/config` |
| `RELAY_NAME` | `Aurora Cloud Relay` | Display name on the status page |
| `DATA_DIR` | `./data` | WhatsApp auth session (`wa-auth/`) + `token.txt` live here. **Mount a persistent volume on paid tiers to survive redeploys** |

---

## 💻 Local run

```bash
# Node 18+ (recommended — matches the Docker image)
npm install
npm start            # or: npm run dev for hot reload
```

Copy `.env.example` → `.env` for local settings. The status page is at `http://localhost:8080/`.

---

## 🔧 Troubleshooting

| Symptom | Cause & fix |
|---|---|
| **WhatsApp asks for a QR after every redeploy/sleep** | Expected on free tiers — the disk is **ephemeral**, so `wa-auth/` session files vanish. Re-scan (10 s). For persistence: paid tier or a volume at `DATA_DIR` |
| **Telegram `getUpdates` returns 409 Conflict** | Another poller is using the same bot token (old relay instance still running, or you polled it yourself with curl). **One bot token = one relay.** Kill the other instance, or issue a fresh token from @BotFather |
| **Health check failing on HF Spaces** | HF serves on port 7860. Set the `PORT=7860` env var in Space settings and redeploy |
| **Render service goes to sleep / Telegram goes quiet** | Free Render sleeps after ~15 min without traffic. Keep the exe running (its `/api/events` long-polls keep it awake), ping `/health` with a cron, or upgrade the plan |
| **Status page says `exe offline (messages are queueing)`** | Normal while your PC is off — events buffer in the relay and the exe catches up via the `seq` cursor when it reconnects |
| **QR renders but scan times out** | QRs expire ~60 s. Request a fresh one and scan promptly; if it repeats, redeploy (fresh Baileys session state) |
| **Baileys fails to install/build** | Use the provided Dockerfile (node-based) — it's the tested path. Local installs may need build tools for native deps |

---

## ⚖️ Legal & safety note

⚠️ This relay automates **personal messaging accounts**. That can violate platform **Terms of Service** — especially unofficial WhatsApp clients (Baileys is reverse-engineered, not an official API) and any user-token automation on other platforms. Possible consequences include **rate limits or permanent account bans**. Use it only for **personal use, on your own accounts, at your own risk**. Don't spam, don't automate accounts you don't own, and check each platform's ToS before you connect. The authors of this software accept no liability for banned accounts or lost messages.
