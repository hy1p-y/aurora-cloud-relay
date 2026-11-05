/**
 * Aurora Cloud Relay — server-only bridge between AuroraSuite.exe (desktop)
 * and Telegram / WhatsApp accounts. Deploy this to a free always-on host
 * (Render / Koyeb / Railway / Fly.io / HF Spaces). It holds the platform
 * connections open 24/7, queues incoming messages, and relays actions from
 * the desktop exe. ZERO bot logic lives here — the PC exe is the brain.
 *
 * Runtime: Bun (preferred) or Node 18+ with tsx.
 */

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'

const RELAY_VERSION = '1.0.0'
const PORT = Number(process.env.PORT || 8080)
const DATA_DIR = process.env.DATA_DIR || './data'
const RELAY_NAME = process.env.RELAY_NAME || 'Aurora Cloud Relay'

fs.mkdirSync(DATA_DIR, { recursive: true })
fs.mkdirSync(path.join(DATA_DIR, 'wa-auth'), { recursive: true })

// ---------------------------------------------------------------- auth token
function loadToken(): string {
  const fromEnv = process.env.AUTH_TOKEN
  if (fromEnv && fromEnv.trim()) return fromEnv.trim()
  const f = path.join(DATA_DIR, 'token.txt')
  try {
    const t = fs.readFileSync(f, 'utf8').trim()
    if (t) return t
  } catch { /* first boot */ }
  const t = 'aur-' + Buffer.from(crypto.randomUUID()).toString('base64url').slice(0, 22)
  fs.writeFileSync(f, t)
  console.log(`[relay] generated AUTH_TOKEN (saved to ${f}): ${t}`)
  return t
}
const TOKEN = loadToken()
const startedAt = Date.now()

// pino-compatible silent logger (Baileys calls .error() etc on children)
const mkSilentLogger = (): any => ({
  level: 'silent',
  trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {},
  child: () => mkSilentLogger(),
})

// ------------------------------------------------------------ event buffer
interface Ev {
  seq: number
  ts: number
  type: string          // tg.message | tg.status | wa.message | wa.status | sys.log
  platform: string      // tg | wa | sys
  chat: string
  from: string
  fromName: string
  text: string
  extra?: any
}
const events: Ev[] = []
const MAX_EVENTS = 2000
let evSeq = 0
let droppedEvents = 0

function pushEvent(e: Omit<Ev, 'seq' | 'ts'>) {
  const ev: Ev = { seq: ++evSeq, ts: Date.now(), ...e }
  events.push(ev)
  if (events.length > MAX_EVENTS) {
    events.splice(0, events.length - MAX_EVENTS)
    droppedEvents++
  }
  notifyWaiters()
  const line = `[ev ${ev.seq}] ${ev.platform}/${ev.type} ${ev.chat || ''} ${ev.fromName || ev.from || ''}: ${(ev.text || '').slice(0, 120)}`
  console.log(line)
}

// long-poll waiters
interface Waiter { after: number; res: http.ServerResponse; timer: any }
const waiters: Waiter[] = []
function notifyWaiters() {
  for (let i = waiters.length - 1; i >= 0; i--) {
    const w = waiters[i]
    const pending = events.filter(e => e.seq > w.after)
    if (pending.length) {
      clearTimeout(w.timer)
      waiters.splice(i, 1)
      try { sendJson(w.res, 200, { ok: true, cursor: pending[pending.length - 1].seq, events: pending }) } catch { /* gone */ }
    }
  }
}

// ----------------------------------------------------------- rate counters
let actionsTotal = 0
let actionsFailed = 0
const actionTimes: number[] = []
function noteAction(ok: boolean) {
  actionsTotal++
  if (!ok) actionsFailed++
  const now = Date.now()
  actionTimes.push(now)
  while (actionTimes.length && actionTimes[0] < now - 60_000) actionTimes.shift()
}

// ------------------------------------------------------------------ helpers
function sendJson(res: http.ServerResponse, code: number, obj: any) {
  const body = JSON.stringify(obj)
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'authorization,content-type',
    'cache-control': 'no-store',
  })
  res.end(body)
}

function authorized(req: http.IncomingMessage, url: URL): boolean {
  const q = url.searchParams.get('token')
  if (q && timingSafeEq(q, TOKEN)) return true
  const h = req.headers.authorization || ''
  if (h.startsWith('Bearer ') && timingSafeEq(h.slice(7), TOKEN)) return true
  return false
}
function timingSafeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let r = 0
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return r === 0
}

async function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > 1_000_000) { resolve(null); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) }
      catch { resolve(null) }
    })
    req.on('error', () => resolve(null))
  })
}

// ================================================================== TELEGRAM
let tgAbort: AbortController | null = null

const tg = {
  connected: false,
  botToken: process.env.TELEGRAM_BOT_TOKEN || '',
  botUsername: '',
  botId: 0,
  err: '',
  offset: 0,
  loopOn: false,
}

async function tgApi(method: string, payload: any): Promise<any> {
  const signal = tgAbort ? tgAbort.signal : AbortSignal.timeout(25_000)
  const r = await fetch(`https://api.telegram.org/bot${tg.botToken}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  })
  const j: any = await r.json().catch(() => ({}))
  if (!j.ok) throw new Error(j.description || `HTTP ${r.status}`)
  return j.result
}

async function tgLoop() {
  if (tg.loopOn) return
  tg.loopOn = true
  tg.connected = false
  tg.err = ''
  tgAbort = new AbortController()
  pushEvent({ type: 'tg.status', platform: 'tg', chat: '', from: 'tg', fromName: 'Telegram', text: 'polling loop starting' })
  while (tg.loopOn && tg.botToken) {
    try {
      if (!tg.connected) {
        const me = await tgApi('getMe', {})
        tg.botUsername = me.username || ''
        tg.botId = me.id || 0
        tg.connected = true
        tg.err = ''
        pushEvent({ type: 'tg.status', platform: 'tg', chat: '', from: 'tg', fromName: 'Telegram', text: `connected as @${tg.botUsername}` })
      }
      const ups = await tgApi('getUpdates', { offset: tg.offset, timeout: 20, allowed_updates: ['message', 'edited_message'] })
      for (const u of ups) {
        tg.offset = Math.max(tg.offset, (u.update_id || 0) + 1)
        const m = u.message || u.edited_message
        if (!m) continue
        pushEvent({
          type: 'tg.message',
          platform: 'tg',
          chat: String(m.chat?.id ?? ''),
          from: String(m.from?.id ?? m.chat?.id ?? ''),
          fromName: m.from?.username || m.from?.first_name || m.chat?.title || '',
          text: m.text || m.caption || '',
          extra: {
            messageId: m.message_id,
            chatType: m.chat?.type,
            chatTitle: m.chat?.title,
            isEdit: !!u.edited_message,
            replyTo: m.reply_to_message?.message_id,
          },
        })
      }
    } catch (e: any) {
      if (e?.name === 'AbortError') break
      tg.connected = false
      tg.err = String(e?.message || e)
      pushEvent({ type: 'tg.status', platform: 'tg', chat: '', from: 'tg', fromName: 'Telegram', text: `error: ${tg.err.slice(0, 200)}` })
      await new Promise(r => setTimeout(r, 5000))
    }
  }
  tg.loopOn = false
  tg.connected = false
  pushEvent({ type: 'tg.status', platform: 'tg', chat: '', from: 'tg', fromName: 'Telegram', text: tg.botToken ? 'polling loop stopped' : 'no bot token configured' })
}

async function tgSend(a: any): Promise<any> {
  if (!tg.botToken) throw new Error('no TELEGRAM_BOT_TOKEN configured')
  const p: any = { chat_id: a.chat, text: String(a.text || '') }
  if (a.replyTo) p.reply_to_message_id = a.replyTo
  if (a.parseMode) p.parse_mode = a.parseMode
  return await tgApi('sendMessage', p)
}

// ================================================================== WHATSAPP
const wa = {
  connected: false,
  phone: '',
  pairing: false,
  err: '',
  sock: null as any,
  qr: null as { matrix: number[][]; text: string; svg: string; at: number } | null,
}

async function waInit() {
  let baileys: any
  try {
    baileys = await import('@whiskeysockets/baileys')
  } catch (e: any) {
    wa.err = `baileys unavailable: ${String(e?.message || e).slice(0, 150)}`
    pushEvent({ type: 'wa.status', platform: 'wa', chat: '', from: 'wa', fromName: 'WhatsApp', text: wa.err })
    return
  }
  const makeWASocket = baileys.default
  let qrcode: any = null
  try { qrcode = await import('qrcode') } catch { qrcode = null }

  const { state, saveCreds } = await baileys.useMultiFileAuthState(path.join(DATA_DIR, 'wa-auth'))
  const { version } = await baileys.fetchLatestBaileysVersion().catch(() => ({ version: [2, 3000, 1022906387] }))
  const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: baileys.makeCacheableSignalKeyStore(state.keys, mkSilentLogger()),
    },
    printQRInTerminal: false,
    browser: ['AuroraSuite', 'Chrome', '1.0.0'],
    logger: mkSilentLogger(),
  })
  wa.sock = sock

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async (u: any) => {
    const { connection, lastDisconnect, qr } = u || {}
    if (qr) {
      wa.pairing = true
      let matrix: number[][] | null = null
      let svg = ''
      try {
        if (qrcode) {
          const created = qrcode.create(qr, { errorCorrectionLevel: 'M' })
          const size = created.modules.size
          const data = created.modules.data
          matrix = []
          for (let y = 0; y < size; y++) {
            const row: number[] = []
            for (let x = 0; x < size; x++) row.push(data[y * size + x] ? 1 : 0)
            matrix.push(row)
          }
          svg = await qrcode.toString(qr, { type: 'svg', margin: 1, width: 220 })
        }
      } catch { /* matrix optional */ }
      wa.qr = { matrix: matrix || [], text: qr, svg, at: Date.now() }
      pushEvent({ type: 'wa.status', platform: 'wa', chat: '', from: 'wa', fromName: 'WhatsApp', text: 'QR pairing pending — scan from AuroraSuite.exe (Cloud tab) or the status page' })
    }
    if (connection === 'close') {
      const code = (lastDisconnect?.error as any)?.output?.statusCode
      const loggedOut = code === baileys.DisconnectReason?.loggedOut
      wa.connected = false
      wa.pairing = !loggedOut
      pushEvent({ type: 'wa.status', platform: 'wa', chat: '', from: 'wa', fromName: 'WhatsApp', text: `connection closed (${code})${loggedOut ? ' — logged out' : ' — reconnecting'}` })
      if (!loggedOut) {
        await new Promise(r => setTimeout(r, 3000))
        try { wa.sock?.end?.(undefined) } catch {}
        try { waInit() } catch { /* retry next tick */ }
      }
    } else if (connection === 'open') {
      wa.connected = true
      wa.pairing = false
      wa.qr = null
      wa.phone = String(sock.user?.id || '').split(':')[0]
      wa.err = ''
      pushEvent({ type: 'wa.status', platform: 'wa', chat: '', from: 'wa', fromName: 'WhatsApp', text: `connected as ${wa.phone}` })
    }
  })

  sock.ev.on('messages.upsert', (m: any) => {
    if (m.type !== 'notify' && m.type !== 'append') return
    for (const msg of m.messages || []) {
      try {
        const key = msg.key || {}
        const jid = key.remoteJid || ''
        if (!jid || jid === 'status@broadcast') continue
        const c = msg.message || {}
        const text =
          c.conversation ||
          c.extendedTextMessage?.text ||
          c.imageMessage?.caption ||
          c.videoMessage?.caption ||
          c.buttonsResponseMessage?.selectedButtonId ||
          c.listResponseMessage?.singleSelectReply?.selectedRowId ||
          ''
        if (!text && !key.fromMe) continue // skip empty media-only
        pushEvent({
          type: 'wa.message',
          platform: 'wa',
          chat: jid,
          from: key.participant || jid,
          fromName: msg.pushName || '',
          text: String(text),
          extra: { id: key.id, fromMe: !!key.fromMe, ts: msg.messageTimestamp },
        })
      } catch { /* malformed message */ }
    }
  })
}

async function waSend(a: any): Promise<any> {
  if (!wa.sock || !wa.connected) throw new Error('whatsapp not connected')
  const jid = String(a.chat)
  if (a.type === 'typing') { await wa.sock.sendPresenceUpdate('composing', jid); return { sent: true } }
  if (a.type === 'read' && a.messageIds) { await wa.sock.readMessages(a.messageIds.map((id: string) => ({ key: { remoteJid: jid, id } }))); return { sent: true } }
  if (a.type === 'react' && a.replyTo) {
    return await wa.sock.sendMessage(jid, { react: { text: String(a.text || '👍'), key: { remoteJid: jid, id: a.replyTo, fromMe: false } } })
  }
  return await wa.sock.sendMessage(jid, { text: String(a.text || '') })
}

async function waLogout() {
  try { await wa.sock?.logout?.() } catch { /* already out */ }
  try { await wa.sock?.end?.(undefined) } catch { /* noop */ }
  wa.sock = null
  wa.connected = false
  wa.phone = ''
  fs.rmSync(path.join(DATA_DIR, 'wa-auth'), { recursive: true, force: true })
  fs.mkdirSync(path.join(DATA_DIR, 'wa-auth'), { recursive: true })
  pushEvent({ type: 'wa.status', platform: 'wa', chat: '', from: 'wa', fromName: 'WhatsApp', text: 'session cleared — request new pairing QR' })
}

// ---------------------------------------------------------------- agent info
let lastAgentSeen = 0
let agentVersion = ''
function agentConnected() { return lastAgentSeen > 0 && Date.now() - lastAgentSeen < 30_000 }

// ------------------------------------------------------------------ actions
async function doAction(a: any): Promise<any> {
  if (!a || typeof a !== 'object') throw new Error('bad action body')
  const platform = String(a.platform || '')
  const type = String(a.type || 'send')
  if (platform === 'tg') {
    if (type === 'typing') return { queued: true, note: 'telegram bots cannot send typing status' }
    return await tgSend(a)
  }
  if (platform === 'wa') return await waSend({ ...a, type })
  throw new Error(`unknown platform "${platform}" (use "tg" or "wa")`)
}

// -------------------------------------------------------------- status page
function esc(s: any): string { return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string)) }

function statusPage(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(RELAY_NAME)}</title><style>
:root{color-scheme:dark}
body{background:#0b0e14;color:#d7dce5;font:14px/1.5 ui-monospace,Consolas,monospace;margin:0;padding:32px}
.card{background:#12161f;border:1px solid #232a38;border-radius:12px;padding:20px;margin:0 auto 16px;max-width:860px}
h1{font-size:18px;margin:0 0 4px;color:#7ee0a3}small{color:#68738a}
.ok{color:#7ee0a3}.bad{color:#ff6b6b}.warn{color:#f0c674}
.grid{display:flex;gap:12px;flex-wrap:wrap;margin-top:10px}
.pill{border:1px solid #232a38;border-radius:99px;padding:4px 12px;font-size:12px}
code{background:#1a2030;padding:2px 8px;border-radius:6px;user-select:all}
table{width:100%;border-collapse:collapse;margin-top:10px}td{padding:4px 8px;border-top:1px solid #1a2030}
.m{color:#68738a}
</style></head><body>
<div class="card"><h1>⚡ ${esc(RELAY_NAME)}</h1><small>v${RELAY_VERSION} · up ${Math.round((Date.now() - startedAt) / 1000)}s · ${agentConnected() ? '<span class="ok">AuroraSuite.exe CONNECTED</span>' : '<span class="warn">exe offline (messages are queueing)</span>'}</small>
<div class="grid">
<span class="pill">Telegram ${tg.connected ? `<span class="ok">@${esc(tg.botUsername)}</span>` : `<span class="warn">${tg.botToken ? 'reconnecting…' : 'not configured'}</span>`}</span>
<span class="pill">WhatsApp ${wa.connected ? `<span class="ok">${esc(wa.phone)}</span>` : wa.pairing ? '<span class="warn">QR pairing pending</span>' : '<span class="warn">disconnected</span>'}</span>
<span class="pill">events buffered ${events.length}/${MAX_EVENTS}${droppedEvents ? ` (dropped ${droppedEvents})` : ''}</span>
<span class="pill">actions ${actionsTotal}${actionsFailed ? ` · failed ${actionsFailed}` : ''} · ${actionTimes.length}/min</span>
</div>
<div style="margin-top:14px;color:#68738a">Authentication: <span class="ok">Protected</span> (token auth active)</div></div>
<div class="card"><b>Relay Activity</b><div style="margin-top:8px;color:#68738a">Message traffic and WhatsApp pairing QR codes are authenticated. Connect with the VANTA desktop client to pair devices and view live events.</div></div>
</body></html>`
}

// ---------------------------------------------------------------- http loop
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://localhost`)
  if (req.method === 'OPTIONS') { sendJson(res, 204, {}); return }

  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(statusPage())
    return
  }
  if (url.pathname === '/health') { sendJson(res, 200, { ok: true, v: RELAY_VERSION }); return }

  if (!url.pathname.startsWith('/api/')) { sendJson(res, 404, { ok: false, error: 'not found' }); return }
  if (!authorized(req, url)) { sendJson(res, 401, { ok: false, error: 'bad or missing token' }); return }

  lastAgentSeen = Date.now()

  // ---- status
  if (url.pathname === '/api/status' && req.method === 'GET') {
    sendJson(res, 200, {
      ok: true,
      relay: RELAY_NAME, relayVersion: RELAY_VERSION, uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      telegram: { connected: tg.connected, botUsername: tg.botUsername, botId: tg.botId, configured: !!tg.botToken, err: tg.err },
      whatsapp: { connected: wa.connected, phone: wa.phone, pairing: wa.pairing, qrPending: !!wa.qr, err: wa.err },
      events: { cursor: evSeq, buffered: events.length, cap: MAX_EVENTS, dropped: droppedEvents },
      actions: { processed: actionsTotal, failed: actionsFailed, perMin: actionTimes.length },
      agent: { connected: agentConnected(), lastSeenSecAgo: lastAgentSeen ? Math.round((Date.now() - lastAgentSeen) / 1000) : -1, version: agentVersion },
    })
    return
  }

  // ---- events long-poll
  if (url.pathname === '/api/events' && req.method === 'GET') {
    const after = Number(url.searchParams.get('after') || 0)
    const limit = Math.min(Number(url.searchParams.get('limit') || 200), 500)
    const wait = Math.min(Number(url.searchParams.get('wait') || 25), 30)
    const pending = events.filter(e => e.seq > after).slice(0, limit)
    if (pending.length) { sendJson(res, 200, { ok: true, cursor: pending[pending.length - 1].seq, events: pending }); return }
    const w: Waiter = { after, res, timer: setTimeout(() => {
      const i = waiters.indexOf(w); if (i >= 0) waiters.splice(i, 1)
      try { sendJson(res, 200, { ok: true, cursor: evSeq, events: [] }) } catch { /* gone */ }
    }, wait * 1000) }
    waiters.push(w)
    return
  }

  // ---- actions
  if (url.pathname === '/api/actions' && req.method === 'POST') {
    const body = await readBody(req)
    if (!body) { sendJson(res, 400, { ok: false, error: 'invalid JSON body' }); return }
    if (typeof body.version === 'string') agentVersion = body.version
    try {
      const result = await doAction(body.action || body)
      noteAction(true)
      sendJson(res, 200, { ok: true, result })
    } catch (e: any) {
      noteAction(false)
      sendJson(res, 502, { ok: false, error: String(e?.message || e).slice(0, 300) })
    }
    return
  }

  // ---- qr
  if (url.pathname === '/api/qr' && req.method === 'GET') {
    if (!wa.qr) { sendJson(res, 200, { ok: true, pending: false, pairing: wa.pairing, connected: wa.connected }); return }
    sendJson(res, 200, {
      ok: true, pending: true, pairing: true, connected: wa.connected,
      qrMatrix: wa.qr.matrix, qrText: wa.qr.text,
      expiresSec: Math.max(0, 60 - Math.round((Date.now() - wa.qr.at) / 1000)),
    })
    return
  }

  // ---- config
  if (url.pathname === '/api/config' && req.method === 'POST') {
    const body = await readBody(req)
    if (!body) { sendJson(res, 400, { ok: false, error: 'invalid JSON body' }); return }
    const changed: string[] = []
    if (typeof body.telegramBotToken === 'string' && body.telegramBotToken.trim()) {
      const newToken = body.telegramBotToken.trim()
      if (newToken !== tg.botToken) {
        tg.botToken = newToken
        tg.loopOn = false
        tg.offset = 0
        if (tgAbort) {
          try { tgAbort.abort() } catch {}
          tgAbort = null
        }
        changed.push('telegramBotToken')
        setTimeout(() => tgLoop().catch(() => { /* logged in loop */ }), 200)
      }
    }
    if (body.whatsappAction === 'pair') { wa.qr = null; wa.pairing = true; await waInit().catch(() => { /* logged */ }); changed.push('whatsappPair') }
    if (body.whatsappAction === 'logout') { await waLogout(); changed.push('whatsappLogout') }
    sendJson(res, 200, { ok: true, changed })
    return
  }

  sendJson(res, 404, { ok: false, error: 'unknown api route' })
})

server.listen(PORT, () => {
  console.log(`[relay] ${RELAY_NAME} v${RELAY_VERSION} listening on :${PORT}`)
  console.log(`[relay] status page: http://localhost:${PORT}/`)
  console.log(`[relay] AUTH_TOKEN: ${TOKEN}`)
  pushEvent({ type: 'sys.log', platform: 'sys', chat: '', from: 'relay', fromName: 'Relay', text: `Aurora Cloud Relay v${RELAY_VERSION} booted` })
  if (tg.botToken) tgLoop().catch(() => { /* logged in loop */ })
  else pushEvent({ type: 'tg.status', platform: 'tg', chat: '', from: 'tg', fromName: 'Telegram', text: 'no bot token — send one via POST /api/config {telegramBotToken} from the exe' })
  waInit().catch((e) => pushEvent({ type: 'wa.status', platform: 'wa', chat: '', from: 'wa', fromName: 'WhatsApp', text: `init failed: ${String(e?.message || e).slice(0, 200)}` }))
})

// graceful shutdown keeps WA session files consistent
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    console.log(`[relay] ${sig} — shutting down`)
    try { await wa.sock?.end?.(undefined) } catch { /* noop */ }
    process.exit(0)
  })
}
