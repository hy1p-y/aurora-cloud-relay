/**
 * Aurora Cloud Relay v2 — server-only bridge between the VANTA desktop exe
 * and YOUR OWN Telegram account (MTProto userbot via GramJS) + WhatsApp
 * (Baileys). Deploy on a free always-on host (Render / Koyeb / Railway /
 * Fly.io / HF Spaces). It holds the platform connections open 24/7, queues
 * incoming messages, relays actions from the desktop exe, and keeps session
 * backups the exe can restore after free-tier restarts.
 *
 * Telegram runs as the USER'S OWN ACCOUNT (userbot) — no BotFather bot.
 * WhatsApp links by QR code OR 8-digit phone pairing code.
 *
 * Runtime: Node 18+ with tsx (or Bun).
 */

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const RELAY_VERSION = '2.0.0'
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
      if (size > 4_000_000) { resolve(null); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) }
      catch { resolve(null) }
    })
    req.on('error', () => resolve(null))
  })
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const msg = (e: any) => String(e?.message || e?.errorMessage || e || '').slice(0, 300)

// QR matrix helper (shared by WhatsApp + Telegram QR)
let qrcodeLib: any = null
async function getQrcode(): Promise<any> {
  if (qrcodeLib !== null) return qrcodeLib
  try { qrcodeLib = await import('qrcode') } catch { qrcodeLib = false as any }
  return qrcodeLib
}
async function qrMatrix(text: string): Promise<number[][]> {
  const q = await getQrcode()
  if (!q) return []
  try {
    const created = q.create(text, { errorCorrectionLevel: 'M' })
    const size = created.modules.size
    const data = created.modules.data
    const m: number[][] = []
    for (let y = 0; y < size; y++) {
      const row: number[] = []
      for (let x = 0; x < size; x++) row.push(data[y * size + x] ? 1 : 0)
      m.push(row)
    }
    return m
  } catch { return [] }
}

// ------------------------------------------------------------- session rev
// rev increments whenever session data is written. The exe watches it and
// re-exports the session blob to its own disk — that's how sessions survive
// free-tier restarts (Render wipes DATA_DIR on redeploy/sleep).
let sessionRev = 1
let lastCredsBump = 0
function bumpSessionRev(why: string) {
  sessionRev++
  console.log(`[relay] session rev -> ${sessionRev} (${why})`)
}

// ====================================================== TELEGRAM (USERBOT)
// GramJS loaded lazily so a missing/broken dep never kills the whole relay.
let gramjs: any = null
async function loadGramjs(): Promise<any> {
  if (gramjs) return gramjs
  try {
    gramjs = await import('telegram')
    return gramjs
  } catch (e: any) {
    throw new Error(`gramjs (telegram package) unavailable: ${msg(e)}`)
  }
}

function relayCfgPath() { return path.join(DATA_DIR, 'relay-cfg.json') }
function loadRelayCfg() {
  try {
    const j = JSON.parse(fs.readFileSync(relayCfgPath(), 'utf8'))
    if (j.tgApiId) tg.apiId = Number(j.tgApiId) || 0
    if (j.tgApiHash) tg.apiHash = String(j.tgApiHash)
  } catch { /* fresh */ }
}
function saveRelayCfg() {
  try { fs.writeFileSync(relayCfgPath(), JSON.stringify({ tgApiId: tg.apiId, tgApiHash: tg.apiHash }, null, 2)) } catch { /* disk */ }
}

const tg = {
  apiId: Number(process.env.TG_API_ID || process.env.TELEGRAM_API_ID || 0) || 0,
  apiHash: process.env.TG_API_HASH || process.env.TELEGRAM_API_HASH || '',
  client: null as any,
  connected: false,        // MTProto transport up
  authorized: false,       // user session valid
  self: null as any,       // { id, username, firstName, phone }
  err: '',
  stage: 'idle' as 'idle' | 'code' | 'password' | 'qr' | 'ok',
  loginPhone: '',
  phoneCodeHash: '',
  codeSentAt: 0,
  loginBusy: false,
  qrOn: false,
  qr: null as { matrix: number[][]; text: string; at: number } | null,
}

const TG_SESSION_FILE = () => path.join(DATA_DIR, 'tg-session.txt')
const peerNames = new Map<string, string>()

function tgSaveSessionString(sess: string) {
  fs.writeFileSync(TG_SESSION_FILE(), sess)
  bumpSessionRev('tg session saved')
}

async function tgSelfInfo(): Promise<any> {
  try {
    const me = await tg.client.getMe()
    return {
      id: me.id?.toString?.() || '',
      username: me.username || '',
      firstName: me.firstName || '',
      phone: me.phone ? String(me.phone) : '',
    }
  } catch { return null }
}

function tgSelfLabel(): string {
  if (!tg.self) return ''
  if (tg.self.username) return '@' + tg.self.username
  if (tg.self.firstName) return tg.self.firstName
  if (tg.self.phone) return '+' + tg.self.phone.replace(/^\+/, '')
  return tg.self.id || ''
}

async function tgAfterAuth() {
  const sess = tg.client.session.save()
  tgSaveSessionString(sess)
  tg.authorized = true
  tg.stage = 'ok'
  tg.qrOn = false
  tg.qr = null
  tg.self = await tgSelfInfo()
  pushEvent({ type: 'tg.status', platform: 'tg', chat: '', from: 'tg', fromName: 'Telegram', text: `logged in as ${tgSelfLabel()} — modules now run on your account` })
}

async function peerName(id: string): Promise<string> {
  const cached = peerNames.get(id)
  if (cached) return cached
  try {
    const ent = await tg.client.getEntity(id)
    const nm = String(ent.title || ent.username || ent.firstName || id)
    if (peerNames.size > 4000) peerNames.clear()
    peerNames.set(id, nm)
    return nm
  } catch { return id }
}

function attachTgHandlers(client: any) {
  const { events } = gramjs
  client.addEventHandler(async (event: any) => {
    try {
      if (!tg.authorized) return
      const m = event.message
      if (!m) return
      const chatId = event.chatId != null ? event.chatId.toString() : ''
      if (!chatId) return
      const text = String(m.text || m.message || m.caption || '')
      if (!text.trim()) return // skip media-only / service messages
      const senderId = event.senderId != null ? event.senderId.toString() : chatId
      let name = ''
      if (m.out) name = 'me'
      else {
        try { const s = await event.getSender(); name = String(s?.username || s?.firstName || senderId) } catch { name = senderId }
      }
      pushEvent({
        type: 'tg.message',
        platform: 'tg',
        chat: chatId,
        from: senderId,
        fromName: name,
        text: text.slice(0, 480),
        extra: { messageId: m.id, fromMe: !!m.out, chatType: '', isEdit: false },
      })
    } catch { /* malformed update */ }
  }, new events.NewMessage({}))
}

// supervisor: keeps the MTProto client connected & session restored
let tgSupervisorOn = false
async function tgSupervisor() {
  if (tgSupervisorOn) return
  tgSupervisorOn = true
  pushEvent({ type: 'tg.status', platform: 'tg', chat: '', from: 'tg', fromName: 'Telegram', text: 'userbot supervisor started' })
  while (true) {
    if (!tg.apiId || !tg.apiHash) { await sleep(3000); continue }
    try {
      if (!tg.client) {
        const { TelegramClient } = await loadGramjs()
        const { StringSession } = await import('telegram/sessions')
        const saved = fs.existsSync(TG_SESSION_FILE()) ? fs.readFileSync(TG_SESSION_FILE(), 'utf8').trim() : ''
        const session = new StringSession(saved)
        tg.client = new TelegramClient(session, tg.apiId, tg.apiHash, {
          connectionRetries: 5,
          retryDelay: 2000,
          autoReconnect: true,
          floodSleepThreshold: 30,
        })
        try { tg.client.setParseMode(undefined) } catch { /* older gramjs */ }
        attachTgHandlers(tg.client)
        pushEvent({ type: 'tg.status', platform: 'tg', chat: '', from: 'tg', fromName: 'Telegram', text: saved ? 'restoring saved session...' : 'no session — waiting for login (phone code or QR)' })
      }
      if (!tg.client.connected) await tg.client.connect()
      tg.connected = true
      tg.err = ''
      const authed = await tg.client.isUserAuthorized()
      if (authed && !tg.authorized) {
        await tgAfterAuth()
      } else if (!authed) {
        if (tg.authorized) {
          // session went bad (logged out elsewhere / revoked)
          tg.authorized = false
          tg.self = null
          tg.stage = 'idle'
          pushEvent({ type: 'tg.status', platform: 'tg', chat: '', from: 'tg', fromName: 'Telegram', text: 'session no longer authorized — log in again' })
          try { await tg.client.disconnect() } catch { /* noop */ }
          tg.client = null
        }
        if (tg.stage === 'ok') tg.stage = 'idle'
      }
    } catch (e: any) {
      tg.connected = false
      tg.err = msg(e)
      const s = tg.err
      if (/AUTH_KEY_UNREGISTERED|AUTH_KEY_DUPLICATED|SESSION_REVOKED|USER_DEACTIVATED/i.test(s)) {
        try { await tg.client?.disconnect?.() } catch { /* noop */ }
        tg.client = null
        tg.authorized = false
        tg.self = null
        tg.stage = 'idle'
        fs.rmSync(TG_SESSION_FILE(), { force: true })
        pushEvent({ type: 'tg.status', platform: 'tg', chat: '', from: 'tg', fromName: 'Telegram', text: 'session invalid — cleared, log in again' })
      } else if (!/already connected|disconnect/i.test(s)) {
        pushEvent({ type: 'tg.status', platform: 'tg', chat: '', from: 'tg', fromName: 'Telegram', text: `connection error: ${s.slice(0, 160)}` })
      }
      await sleep(6000)
    }
    await sleep(5000)
  }
}

// ---- login steps (called from /api/tg/login)
async function tgLoginPhone(phoneRaw: string) {
  phoneRaw = String(phoneRaw || '').replace(/[\s\-()]/g, '')
  if (!phoneRaw) throw new Error('phone required (international format, e.g. +989123456789)')
  if (!tg.client || !tg.client.connected) throw new Error('telegram not connected — save api id/hash first')
  if (tg.authorized) throw new Error('already logged in — logout first')
  if (tg.loginBusy) throw new Error('another login step is running, wait a moment')
  tg.loginBusy = true
  try {
    const { phoneCodeHash } = await tg.client.sendCode({ apiId: tg.apiId, apiHash: tg.apiHash }, phoneRaw)
    tg.phoneCodeHash = phoneCodeHash
    tg.loginPhone = phoneRaw
    tg.stage = 'code'
    tg.codeSentAt = Date.now()
    tg.qrOn = false
    tg.qr = null
    pushEvent({ type: 'tg.status', platform: 'tg', chat: '', from: 'tg', fromName: 'Telegram', text: `login code sent to ${phoneRaw}` })
    return { stage: 'code', phone: phoneRaw }
  } finally { tg.loginBusy = false }
}

async function tgLoginCode(code: string) {
  if (tg.stage !== 'code' || !tg.phoneCodeHash) throw new Error('no code was requested — send code first')
  if (tg.authorized) return { stage: 'ok' }
  if (tg.loginBusy) throw new Error('another login step is running, wait a moment')
  tg.loginBusy = true
  try {
    const { Api } = await loadGramjs()
    await tg.client.invoke(new Api.auth.SignIn({
      phoneNumber: tg.loginPhone,
      phoneCodeHash: tg.phoneCodeHash,
      phoneCode: String(code || '').trim(),
    }))
    await tgAfterAuth()
    return { stage: 'ok' }
  } catch (e: any) {
    const em = String(e?.errorMessage || e?.message || e)
    if (em.includes('SESSION_PASSWORD_NEEDED')) {
      tg.stage = 'password'
      pushEvent({ type: 'tg.status', platform: 'tg', chat: '', from: 'tg', fromName: 'Telegram', text: '2FA password required' })
      return { stage: 'password', needsPassword: true }
    }
    throw e
  } finally { tg.loginBusy = false }
}

async function tgLoginPassword(password: string) {
  if (tg.stage !== 'password') throw new Error('no password was asked for')
  if (tg.loginBusy) throw new Error('another login step is running, wait a moment')
  tg.loginBusy = true
  try {
    const { Api } = await loadGramjs()
    const { computeCheck } = await import('telegram/Password')
    const pwdInfo = await tg.client.invoke(new Api.account.GetPassword())
    const check = await computeCheck(pwdInfo, String(password || ''))
    await tg.client.invoke(new Api.auth.CheckPassword({ password: check }))
    await tgAfterAuth()
    return { stage: 'ok' }
  } finally { tg.loginBusy = false }
}

async function tgQrLoop() {
  // Runs while QR login is wanted. Telegram QR: encode tg://login?token=...
  // Scanning: Telegram app -> Settings -> Devices -> Link Desktop Device.
  try {
    await loadGramjs()
  } catch (e: any) {
    tg.qrOn = false
    tg.err = msg(e)
    return
  }
  while (tg.qrOn && !tg.authorized && tg.client && tg.client.connected) {
    try {
      const { Api } = gramjs
      let resp: any = await tg.client.invoke(new Api.auth.ExportLoginToken({ apiId: tg.apiId, apiHash: tg.apiHash, exceptIds: [] }))
      if (resp instanceof Api.auth.LoginTokenSuccess) {
        await tgAfterAuth()
        break
      } else if (resp instanceof Api.auth.LoginTokenMigrateTo) {
        await (tg.client as any)._switchDC(resp.dcId)
        resp = await tg.client.invoke(new Api.auth.ImportLoginToken({ token: resp.token }))
        if (resp instanceof Api.auth.LoginTokenSuccess) {
          await tgAfterAuth()
          break
        }
        continue
      } else if (resp instanceof Api.auth.LoginToken) {
        const tokenUrl = 'tg://login?token=' + Buffer.from(resp.token).toString('base64url')
        tg.qr = { matrix: await qrMatrix(tokenUrl), text: tokenUrl, at: Date.now() }
        tg.stage = 'qr'
      }
    } catch (e: any) {
      tg.err = msg(e)
      await sleep(3000)
    }
    await sleep(4000)
  }
  if (!tg.qrOn) tg.qr = null
}

async function tgLogout() {
  try {
    if (tg.client) {
      if (tg.authorized && gramjs?.Api) { try { await tg.client.invoke(new gramjs.Api.auth.LogOut()) } catch { /* noop */ } }
      try { await tg.client.disconnect() } catch { /* noop */ }
    }
  } catch { /* noop */ }
  tg.client = null
  tg.connected = false
  tg.authorized = false
  tg.self = null
  tg.stage = 'idle'
  tg.qrOn = false
  tg.qr = null
  tg.loginPhone = ''
  tg.phoneCodeHash = ''
  fs.rmSync(TG_SESSION_FILE(), { force: true })
  bumpSessionRev('tg logout')
  pushEvent({ type: 'tg.status', platform: 'tg', chat: '', from: 'tg', fromName: 'Telegram', text: 'logged out' })
}

// ---- telegram actions (as the USER's account)
async function tgSend(a: any): Promise<any> {
  if (!tg.client || !tg.authorized) throw new Error('telegram user account not logged in')
  const { Api } = gramjs
  const chat = String(a.chat || '')
  if (!chat) throw new Error('chat required')
  const type = String(a.type || 'send')

  if (type === 'typing') {
    await tg.client.invoke(new Api.messages.SetTyping({ peer: chat, action: new Api.SendMessageTypingAction() }))
    return { sent: true }
  }
  if (type === 'read') {
    const ids = Array.isArray(a.ids) ? a.ids.map(Number).filter(Boolean) : []
    if (ids.length) await tg.client.invoke(new Api.messages.ReadMessageContents({ id: ids }))
    else await tg.client.invoke(new Api.messages.ReadHistory({ peer: chat, maxId: 0 }))
    return { read: true }
  }
  if (type === 'delete') {
    const ids = (Array.isArray(a.ids) ? a.ids : [a.messageId]).map(Number).filter(Boolean)
    if (!ids.length) throw new Error('ids required for delete')
    await tg.client.deleteMessages(chat, ids, { revoke: true })
    return { deleted: ids.length }
  }
  if (type === 'edit') {
    const mid = Number(a.messageId || 0)
    if (!mid) throw new Error('messageId required for edit')
    await tg.client.editMessage(chat, { message: mid, text: String(a.text || ''), linkPreview: false })
    return { edited: true }
  }
  if (type === 'react') {
    const mid = Number(a.replyTo || a.messageId || 0)
    if (mid) {
      try {
        await tg.client.invoke(new Api.messages.SendReaction({
          peer: chat, msgId: mid,
          reaction: [new Api.ReactionEmoji({ emoticon: String(a.text || '👍') })],
        }))
        return { reacted: true }
      } catch { /* older layer — fall through to text */ }
    }
  }
  // plain send (as the user)
  const params: any = { message: String(a.text || ''), linkPreview: false }
  if (a.replyTo) params.replyTo = Number(a.replyTo)
  return await tg.client.sendMessage(chat, params)
}

// ========================================================== WHATSAPP (Baileys)
const wa = {
  connected: false,
  phone: '',
  pairing: false,
  pairingCode: '',
  pairPhone: '',           // phone for pairing-code flow (optional)
  pairingCodeAsked: false, // requested once per socket generation
  err: '',
  sock: null as any,
  qr: null as { matrix: number[][]; text: string; at: number; gen: number } | null,
  gen: 0,                  // socket generation — exe uses it to drop stale QRs
  attempts: 0,
}

function waCredsPresent(): boolean {
  try {
    const dir = path.join(DATA_DIR, 'wa-auth')
    return fs.existsSync(dir) && fs.readdirSync(dir).some(f => f.endsWith('.json'))
  } catch { return false }
}

async function waInit() {
  let baileys: any
  try {
    baileys = await import('@whiskeysockets/baileys')
  } catch (e: any) {
    wa.err = `baileys unavailable: ${msg(e).slice(0, 150)}`
    pushEvent({ type: 'wa.status', platform: 'wa', chat: '', from: 'wa', fromName: 'WhatsApp', text: wa.err })
    return
  }
  const makeWASocket = baileys.default
  wa.gen++
  const myGen = wa.gen

  const { state, saveCreds } = await baileys.useMultiFileAuthState(path.join(DATA_DIR, 'wa-auth'))
  const { version } = await baileys.fetchLatestBaileysVersion().catch(() => ({ version: [2, 3000, 1023222034] }))
  const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: baileys.makeCacheableSignalKeyStore(state.keys, mkSilentLogger()),
    },
    printQRInTerminal: false,
    browser: ['VANTA', 'Chrome', '4.0.0'],
    logger: mkSilentLogger(),
    markOnlineOnConnect: false,      // don't force "online" presence on free tier
    syncFullHistory: false,          // light footprint
    generateHighQualityLinkPreview: false,
  })
  wa.sock = sock

  sock.ev.on('creds.update', () => {
    saveCreds()
    const now = Date.now()
    if (now - lastCredsBump > 60_000) { // throttle: creds update fires often
      lastCredsBump = now
      bumpSessionRev('wa creds')
    }
  })

  sock.ev.on('connection.update', async (u: any) => {
    const { connection, lastDisconnect, qr } = u || {}
    if (qr) {
      if (wa.gen !== myGen) return // stale socket event
      wa.pairing = true
      // pairing-code flow takes precedence over QR
      if (wa.pairPhone && !wa.pairingCodeAsked) {
        wa.pairingCodeAsked = true
        try {
          const code = await sock.requestPairingCode(wa.pairPhone)
          if (code && wa.gen === myGen) {
            wa.pairingCode = String(code).toUpperCase()
            pushEvent({ type: 'wa.status', platform: 'wa', chat: '', from: 'wa', fromName: 'WhatsApp', text: `pairing code ready: ${wa.pairingCode}` })
          }
        } catch (e: any) {
          wa.err = `pairing code failed: ${msg(e)}`
          pushEvent({ type: 'wa.status', platform: 'wa', chat: '', from: 'wa', fromName: 'WhatsApp', text: wa.err })
        }
        return
      }
      const matrix = await qrMatrix(qr)
      if (wa.gen === myGen) {
        wa.qr = { matrix, text: qr, at: Date.now(), gen: myGen }
        pushEvent({ type: 'wa.status', platform: 'wa', chat: '', from: 'wa', fromName: 'WhatsApp', text: 'QR ready — scan from the exe (Cloud tab)' })
      }
    }
    if (connection === 'close') {
      if (wa.gen !== myGen) return
      const code = (lastDisconnect?.error as any)?.output?.statusCode
      const loggedOut = code === baileys.DisconnectReason?.loggedOut
      wa.connected = false
      wa.qr = null // never serve a QR from a dead socket
      if (loggedOut) {
        wa.pairing = false
        wa.pairingCode = ''
        wa.pairPhone = ''
        pushEvent({ type: 'wa.status', platform: 'wa', chat: '', from: 'wa', fromName: 'WhatsApp', text: 'logged out (device removed) — pair again' })
        return
      }
      wa.attempts++
      const delay = Math.min(3000 * wa.attempts, 15000)
      pushEvent({ type: 'wa.status', platform: 'wa', chat: '', from: 'wa', fromName: 'WhatsApp', text: `connection closed (${code}) — reconnect #${wa.attempts} in ${Math.round(delay / 1000)}s` })
      if (wa.attempts <= 12) {
        await sleep(delay)
        if (wa.gen === myGen) {
          try { sock.end?.(undefined) } catch { /* noop */ }
          const keepPhone = wa.pairPhone
          const keepAsked = wa.pairingCodeAsked
          waInit().then(() => {
            wa.pairPhone = keepPhone
            wa.pairingCodeAsked = keepAsked
          }).catch(() => { /* logged */ })
        }
      }
    } else if (connection === 'open') {
      if (wa.gen !== myGen) return
      wa.connected = true
      wa.pairing = false
      wa.qr = null
      wa.pairingCode = ''
      wa.pairPhone = ''
      wa.pairingCodeAsked = false
      wa.attempts = 0
      wa.err = ''
      wa.phone = String(sock.user?.id || '').split(':')[0]
      pushEvent({ type: 'wa.status', platform: 'wa', chat: '', from: 'wa', fromName: 'WhatsApp', text: `connected as ${wa.phone}` })
    }
  })

  sock.ev.on('messages.upsert', (m: any) => {
    if (m.type !== 'notify' && m.type !== 'append') return
    for (const message of m.messages || []) {
      try {
        const key = message.key || {}
        const jid = key.remoteJid || ''
        if (!jid || jid === 'status@broadcast') continue
        const c = message.message || {}
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
          fromName: message.pushName || '',
          text: String(text),
          extra: { id: key.id, fromMe: !!key.fromMe, ts: message.messageTimestamp },
        })
      } catch { /* malformed message */ }
    }
  })
}

// (re)start WhatsApp linking: QR flow, or pairing-code when phone given
async function waRequestPair(opts: { phone?: string } = {}) {
  const phone = String(opts.phone || '').replace(/[\s\-()]/g, '')
  wa.qr = null
  wa.pairingCode = ''
  wa.pairingCodeAsked = false
  wa.pairPhone = phone
  wa.pairing = true
  wa.attempts = 0
  try { await wa.sock?.end?.(undefined) } catch { /* noop */ }
  await sleep(400)
  await waInit()
  pushEvent({ type: 'wa.status', platform: 'wa', chat: '', from: 'wa', fromName: 'WhatsApp', text: phone ? `requesting pairing code for ${phone}...` : 'new QR requested' })
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
  wa.gen++
  wa.connected = false
  wa.phone = ''
  wa.pairing = false
  wa.pairingCode = ''
  wa.pairPhone = ''
  wa.qr = null
  fs.rmSync(path.join(DATA_DIR, 'wa-auth'), { recursive: true, force: true })
  fs.mkdirSync(path.join(DATA_DIR, 'wa-auth'), { recursive: true })
  bumpSessionRev('wa logout')
  pushEvent({ type: 'wa.status', platform: 'wa', chat: '', from: 'wa', fromName: 'WhatsApp', text: 'session cleared — request new pairing' })
}

// ============================================== SESSION BACKUP (blob import/export)
function buildSessionExport() {
  const tgS = fs.existsSync(TG_SESSION_FILE()) ? fs.readFileSync(TG_SESSION_FILE(), 'utf8').trim() : ''
  const waFiles: Record<string, string> = {}
  const dir = path.join(DATA_DIR, 'wa-auth')
  try {
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith('.json')) waFiles[f] = fs.readFileSync(path.join(dir, f)).toString('base64')
    }
  } catch { /* empty */ }
  const blob = JSON.stringify({ v: 2, rev: sessionRev, tg: tgS, wa: waFiles })
  return { tg: tgS, wa: Object.keys(waFiles).length ? zlib.gzipSync(Buffer.from(blob)).toString('base64') : '', rev: sessionRev }
}

async function sessionImport(body: any): Promise<string[]> {
  const restored: string[] = []
  if (body?.tg && typeof body.tg === 'string' && body.tg.length > 20) {
    fs.writeFileSync(TG_SESSION_FILE(), body.tg)
    restored.push('tg')
    try { await tg.client?.disconnect?.() } catch { /* noop */ }
    tg.client = null
    tg.authorized = false
    tg.self = null
    tg.stage = 'idle'
    pushEvent({ type: 'tg.status', platform: 'tg', chat: '', from: 'tg', fromName: 'Telegram', text: 'telegram session restored from PC backup' })
  }
  if (body?.wa && typeof body.wa === 'string' && body.wa.length > 20) {
    const obj = JSON.parse(zlib.gunzipSync(Buffer.from(body.wa, 'base64')).toString('utf8'))
    if (obj?.wa && typeof obj.wa === 'object') {
      const dir = path.join(DATA_DIR, 'wa-auth')
      fs.mkdirSync(dir, { recursive: true })
      const cur = new Set(fs.readdirSync(dir))
      for (const [name, data] of Object.entries(obj.wa)) {
        fs.writeFileSync(path.join(dir, name), Buffer.from(String(data), 'base64'))
        cur.delete(name)
      }
      for (const f of cur) fs.rmSync(path.join(dir, f), { force: true })
      restored.push('wa')
      wa.gen++
      try { await wa.sock?.end?.(undefined) } catch { /* noop */ }
      wa.sock = null
      wa.connected = false
      wa.pairing = false
      pushEvent({ type: 'wa.status', platform: 'wa', chat: '', from: 'wa', fromName: 'WhatsApp', text: 'whatsapp session restored from PC backup' })
      setTimeout(() => waInit().catch(() => { /* logged */ }), 500)
    }
  }
  bumpSessionRev('import')
  return restored
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
  if (platform === 'tg') return await tgSend(a)
  if (platform === 'wa') return await waSend({ ...a, type })
  throw new Error(`unknown platform "${platform}" (use "tg" or "wa")`)
}

// -------------------------------------------------------------- status page
function esc(s: any): string { return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string)) }

function statusPage(): string {
  const tgLabel = tg.authorized ? tgSelfLabel() : tg.apiId ? (tg.stage === 'code' || tg.stage === 'password' || tg.stage === 'qr' ? `login: ${tg.stage}` : 'login pending') : 'api keys needed'
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
.m{color:#68738a}
</style></head><body>
<div class="card"><h1>⚡ ${esc(RELAY_NAME)}</h1><small>v${RELAY_VERSION} · up ${Math.round((Date.now() - startedAt) / 1000)}s · ${agentConnected() ? '<span class="ok">VANTA.exe CONNECTED</span>' : '<span class="warn">exe offline (messages are queueing)</span>'}</small>
<div class="grid">
<span class="pill">Telegram <span class="${tg.authorized ? 'ok' : 'warn'}">${esc(tgLabel)}</span></span>
<span class="pill">WhatsApp ${wa.connected ? `<span class="ok">${esc(wa.phone)}</span>` : wa.pairing ? '<span class="warn">pairing pending</span>' : '<span class="warn">disconnected</span>'}</span>
<span class="pill">sessions rev ${sessionRev}${tg.authorized ? ' · tg✓' : ''}${waCredsPresent() ? ' · wa✓' : ''}</span>
<span class="pill">events ${events.length}/${MAX_EVENTS}${droppedEvents ? ` (dropped ${droppedEvents})` : ''}</span>
<span class="pill">actions ${actionsTotal}${actionsFailed ? ` · failed ${actionsFailed}` : ''} · ${actionTimes.length}/min</span>
</div>
<div style="margin-top:14px;color:#68738a">Telegram runs as <b>your own account</b> (userbot). Link it from the VANTA desktop app: Cloud tab → Telegram. WhatsApp pairs by QR or 8-digit code from the same tab. All API routes require the auth token.</div></div>
<div class="card"><b>Relay Activity</b><div style="margin-top:8px;color:#68738a">Message traffic, QR codes and login flows are token-gated. Connect the VANTA desktop client to pair accounts and view live events.</div></div>
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
      telegram: {
        mode: 'user',
        connected: tg.connected,
        configured: !!(tg.apiId && tg.apiHash),
        authorized: tg.authorized,
        self: tg.self || {},
        login: {
          stage: tg.authorized ? 'ok' : tg.stage,
          phone: tg.loginPhone,
          codeAgeSec: tg.codeSentAt ? Math.round((Date.now() - tg.codeSentAt) / 1000) : 0,
        },
        err: tg.err,
      },
      whatsapp: {
        connected: wa.connected,
        phone: wa.phone,
        pairing: wa.pairing,
        pairingCode: wa.pairingCode,
        qrPending: !!wa.qr,
        qrGen: wa.gen,
        credsPresent: waCredsPresent(),
        err: wa.err,
      },
      sessions: { rev: sessionRev, tgPresent: fs.existsSync(TG_SESSION_FILE()), waPresent: waCredsPresent() },
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
      sendJson(res, 502, { ok: false, error: msg(e) })
    }
    return
  }

  // ---- qr (both platforms)
  if (url.pathname === '/api/qr' && req.method === 'GET') {
    const plat = url.searchParams.get('platform') || 'wa'
    if (plat === 'tg') {
      if (!tg.qr) { sendJson(res, 200, { ok: true, pending: false, stage: tg.authorized ? 'ok' : tg.stage }); return }
      sendJson(res, 200, {
        ok: true, pending: true,
        qrMatrix: tg.qr.matrix, qrText: tg.qr.text,
        expiresSec: Math.max(0, 90 - Math.round((Date.now() - tg.qr.at) / 1000)),
      })
      return
    }
    if (!wa.qr) { sendJson(res, 200, { ok: true, pending: false, pairing: wa.pairing, connected: wa.connected, pairingCode: wa.pairingCode, gen: wa.gen }); return }
    sendJson(res, 200, {
      ok: true, pending: true, pairing: true, connected: wa.connected,
      qrMatrix: wa.qr.matrix, qrText: wa.qr.text,
      gen: wa.qr.gen,
      pairingCode: wa.pairingCode,
      expiresSec: Math.max(0, 55 - Math.round((Date.now() - wa.qr.at) / 1000)),
    })
    return
  }

  // ---- telegram login flow
  if (url.pathname === '/api/tg/login' && req.method === 'POST') {
    const body = await readBody(req)
    if (!body) { sendJson(res, 400, { ok: false, error: 'invalid JSON body' }); return }
    const step = String(body.step || '')
    try {
      if (step === 'phone') {
        const r = await tgLoginPhone(String(body.phone || ''))
        sendJson(res, 200, { ok: true, ...r })
      } else if (step === 'code') {
        const r = await tgLoginCode(String(body.code || ''))
        sendJson(res, 200, { ok: true, ...r })
      } else if (step === 'password') {
        const r = await tgLoginPassword(String(body.password || ''))
        sendJson(res, 200, { ok: true, ...r })
      } else if (step === 'qr-start') {
        if (tg.authorized) throw new Error('already logged in')
        if (!tg.client || !tg.client.connected) throw new Error('telegram not connected — save api id/hash first')
        tg.qrOn = true
        tg.stage = 'qr'
        tg.qr = null
        tgQrLoop().catch(() => { /* logged in loop */ })
        sendJson(res, 200, { ok: true, stage: 'qr' })
      } else if (step === 'qr-stop') {
        tg.qrOn = false
        tg.qr = null
        if (tg.stage === 'qr') tg.stage = 'idle'
        sendJson(res, 200, { ok: true, stage: tg.authorized ? 'ok' : tg.stage })
      } else if (step === 'logout') {
        await tgLogout()
        sendJson(res, 200, { ok: true, stage: 'idle' })
      } else {
        sendJson(res, 400, { ok: false, error: 'unknown step (phone|code|password|qr-start|qr-stop|logout)' })
      }
    } catch (e: any) {
      sendJson(res, 502, { ok: false, error: msg(e) })
    }
    return
  }

  // ---- config
  if (url.pathname === '/api/config' && req.method === 'POST') {
    const body = await readBody(req)
    if (!body) { sendJson(res, 400, { ok: false, error: 'invalid JSON body' }); return }
    const changed: string[] = []
    if (body.tgApiId != null || body.tgApiHash != null) {
      const newId = body.tgApiId != null ? (Number(String(body.tgApiId).replace(/[^0-9]/g, '')) || 0) : tg.apiId
      const newHash = body.tgApiHash != null ? String(body.tgApiHash).trim() : tg.apiHash
      if (newId && newHash && (newId !== tg.apiId || newHash !== tg.apiHash)) {
        if (tg.authorized || tg.client) await tgLogout().catch(() => { /* noop */ })
        tg.apiId = newId
        tg.apiHash = newHash
        saveRelayCfg()
        changed.push('tgApi')
        pushEvent({ type: 'tg.status', platform: 'tg', chat: '', from: 'tg', fromName: 'Telegram', text: `api credentials set (id ${newId}) — ready for login` })
      } else if (!newId || !newHash) {
        changed.push('tgApiInvalid')
      }
    }
    if (body.whatsappAction === 'pair') { await waRequestPair({}); changed.push('whatsappPair') }
    if (body.whatsappAction === 'paircode') {
      if (!body.waPhone) { sendJson(res, 400, { ok: false, error: 'waPhone required for paircode' }); return }
      await waRequestPair({ phone: String(body.waPhone) })
      changed.push('whatsappPairCode')
    }
    if (body.whatsappAction === 'logout') { await waLogout(); changed.push('whatsappLogout') }
    sendJson(res, 200, { ok: true, changed, pairingCode: wa.pairingCode || '' })
    return
  }

  // ---- session export / import (survives free-tier restarts)
  if (url.pathname === '/api/session/export' && req.method === 'GET') {
    const ex = buildSessionExport()
    sendJson(res, 200, { ok: true, rev: ex.rev, tg: ex.tg, wa: ex.wa })
    return
  }
  if (url.pathname === '/api/session/import' && req.method === 'POST') {
    const body = await readBody(req)
    if (!body) { sendJson(res, 400, { ok: false, error: 'invalid JSON body' }); return }
    try {
      const restored = await sessionImport(body)
      sendJson(res, 200, { ok: true, restored, rev: sessionRev })
    } catch (e: any) {
      sendJson(res, 502, { ok: false, error: msg(e) })
    }
    return
  }

  sendJson(res, 404, { ok: false, error: 'unknown api route' })
})

server.listen(PORT, () => {
  console.log(`[relay] ${RELAY_NAME} v${RELAY_VERSION} listening on :${PORT}`)
  console.log(`[relay] status page: http://localhost:${PORT}/`)
  console.log(`[relay] AUTH_TOKEN: ${TOKEN}`)
  pushEvent({ type: 'sys.log', platform: 'sys', chat: '', from: 'relay', fromName: 'Relay', text: `Aurora Cloud Relay v${RELAY_VERSION} booted (telegram userbot + whatsapp)` })
  loadRelayCfg()
  if (tg.apiId && tg.apiHash) {
    pushEvent({ type: 'tg.status', platform: 'tg', chat: '', from: 'tg', fromName: 'Telegram', text: `api credentials present (id ${tg.apiId}) — starting userbot` })
  } else {
    pushEvent({ type: 'tg.status', platform: 'tg', chat: '', from: 'tg', fromName: 'Telegram', text: 'no api credentials — set them from the exe (Cloud tab → Telegram → save keys)' })
  }
  if (process.env.TELEGRAM_BOT_TOKEN) {
    pushEvent({ type: 'sys.log', platform: 'sys', chat: '', from: 'relay', fromName: 'Relay', text: 'note: TELEGRAM_BOT_TOKEN is ignored — this relay runs Telegram as the user account (userbot)' })
  }
  tgSupervisor().catch(() => { /* logged in loop */ })
  waInit().catch((e) => pushEvent({ type: 'wa.status', platform: 'wa', chat: '', from: 'wa', fromName: 'WhatsApp', text: `init failed: ${msg(e)}` }))
})

// graceful shutdown keeps WA session files consistent
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    console.log(`[relay] ${sig} — shutting down`)
    try { await wa.sock?.end?.(undefined) } catch { /* noop */ }
    try { await tg.client?.disconnect?.() } catch { /* noop */ }
    process.exit(0)
  })
}
