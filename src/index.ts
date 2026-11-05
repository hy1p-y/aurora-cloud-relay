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
 * v2.2.1 — "couldn't link device" + unreadable QR fixes:
 *   - requestPairingCode is no longer fired on the same tick as the QR event
 *     (2.5s delay — same-tick calls yield codes the phone rejects with
 *     "couldn't link device, check the phone number").
 *   - pairing codes now AUTO-REFRESH every ~100s on a live socket — WhatsApp
 *     kills codes after ~2-3 min, and every previously shown code was already
 *     dead by the time the user typed it in.
 *   - re-clicking "pair by code" with the same number no longer restarts the
 *     socket (which killed the code being typed) — a still-fresh code is
 *     simply re-shown.
 *   - phone-mode pairing never serves a QR matrix anymore (the exe shows the
 *     code card + the number the code was issued for).
 *   - QR: exe-side card now has a full 4-module quiet zone, pure-white panel
 *     and NO overlay drawn on the modules (the old translucent shimmer band
 *     made the code unscannable).
 *
 * v2.1.0 — pairing hardening:
 *   - phone numbers are normalized with libphonenumber (accepts +98…, 0098…,
 *     98…, and local 0917… when a country is selected; trunk zeros after the
 *     country code are stripped) — Baileys needs bare digits or it builds an
 *     invalid JID and the phone rejects the code with "wrong number/code".
 *   - a device that WhatsApp invalidates ("logged out / device removed") now
 *     wipes the stale noise keys and restarts pairing automatically — stale
 *     creds used to poison every reconnect forever.
 *   - pairing codes die when the socket reconnects; a fresh code is now
 *     requested automatically and the exe is told the old one expired.
 *   - pairing requests are single-flight + debounced (double clicks used to
 *     spawn two sockets on one auth folder → conflict → instant logout).
 *   - session backups only contain a WhatsApp blob once the account is really
 *     linked, so the exe can never restore a dead/poisoned session.
 *
 * Runtime: Node 18+ with tsx (or Bun).
 */

import http from 'node:http'
import https from 'node:https'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const RELAY_VERSION = '2.2.3'
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
// relay boot identity — the exe uses it to detect restarts and reset its
// event cursor (buffered events die with the process, so seq numbers reset)
const BOOT_ID = crypto.randomUUID().slice(0, 13)

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

// ============================================== CHAT DIRECTORY (exe pickers)
// Lists the account's real chats/groups/contacts so the exe can render a
// searchable picker instead of making the user type raw JIDs by hand.
interface ChatEntry { platform: 'wa' | 'tg'; id: string; name: string; type: 'user' | 'group' | 'channel'; ts: number }
const waChats = new Map<string, ChatEntry>()
const waLastSeenId = new Map<string, string>()  // newest message id per chat (read-all)
const WA_CHATS_FILE = path.join(DATA_DIR, 'wa-chats.json')

function loadWaChats() {
  try {
    if (fs.existsSync(WA_CHATS_FILE)) {
      const arr = JSON.parse(fs.readFileSync(WA_CHATS_FILE, 'utf8'))
      if (Array.isArray(arr)) {
        for (const item of arr) {
          if (item?.id) waChats.set(item.id, item)
        }
        console.log(`[relay] loaded ${waChats.size} contacts/chats from disk`)
      }
    }
  } catch { /* ignore corrupted file */ }
}

let saveWaChatsTimer: any = null
function scheduleSaveWaChats() {
  if (saveWaChatsTimer) return
  saveWaChatsTimer = setTimeout(() => {
    saveWaChatsTimer = null
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true })
      fs.writeFileSync(WA_CHATS_FILE, JSON.stringify([...waChats.values()], null, 2), 'utf8')
    } catch { /* noop */ }
  }, 2000)
}

let tgDialogs: ChatEntry[] = []
let tgDialogsAt = 0
// LID support (Baileys v6.7+): chats can arrive as <lid>@lid instead of the phone
// JID. We learn lid->jid pairs from contact events that carry both, so the
// picker shows the real number + saved name; unknown lids keep the push name
// WhatsApp gave us — never a fake "+number" entry.
const waLidMap = new Map<string, string>() // "<digits>@lid" -> phone JID
function recordLidPair(lid: any, jid: any) {
  try {
    const l = String(lid || ''), j = String(jid || '')
    if (!l || !j) return
    const lidJid = l.endsWith('@lid') ? l : `${l}@lid`
    const phoneJid = j.includes('@') && !j.endsWith('@lid') ? j : `${j.replace(/@.*$/, '')}@s.whatsapp.net`
    if (!lidJid.includes('@lid') || phoneJid.endsWith('@lid') || phoneJid === lidJid) return
    if (!waLidMap.get(lidJid)) waLidMap.set(lidJid, phoneJid)
  } catch { /* defensive */ }
}
function upsertWaChat(jidIn: string, name: string, ts: number) {
  if (!jidIn || jidIn === 'status@broadcast' || jidIn.endsWith('@newsletter')) return
  let jid = jidIn
  if (jid.endsWith('@lid')) {
    const real = waLidMap.get(jid)
    if (real) {
      // merge the LID identity into the real JID entry (one clean contact row)
      const prevReal = waChats.get(real)
      const prevLid = waChats.get(jid)
      const nm = (name || prevLid?.name || prevReal?.name || '').slice(0, 120)
      const t = Math.max(ts || 0, prevReal?.ts || prevLid?.ts || 0)
      waChats.set(real, { platform: 'wa', id: real, name: nm, type: 'user', ts: t })
      waChats.delete(jid)
      scheduleSaveWaChats()
      return
    }
  }
  const prev = waChats.get(jid)
  const type: ChatEntry['type'] = jid.endsWith('@g.us') ? 'group' : 'user'
  let nm = (name || prev?.name || '').slice(0, 120)
  if (!nm && type === 'user' && !jid.endsWith('@lid')) {
    const bare = jid.replace(/@.*$/, '')
    nm = bare.length >= 8 ? `+${bare}` : bare
  }
  if (!nm && jid.endsWith('@lid')) nm = 'WhatsApp user' // honest placeholder, never a fake number
  waChats.set(jid, { platform: 'wa', id: jid, name: nm, type, ts: Math.max(ts || 0, prev?.ts || 0) })
  scheduleSaveWaChats()
}
async function tgFetchDialogs() {
  if (!tg.client || !tg.authorized) return
  const out: ChatEntry[] = []
  try {
    for await (const d of tg.client.iterDialogs({ limit: 250 })) {
      try {
        const ent: any = d.entity
        const id = String((d as any).id?.value ?? ent?.id ?? '')
        if (!id) continue
        const cls = String(ent?.className || '')
        const type: ChatEntry['type'] = d.isGroup || cls.includes('Chat') ? 'group' : cls.includes('Channel') ? 'channel' : 'user'
        const name = String(d.title || ent?.title || ent?.username || ent?.firstName || id).slice(0, 120)
        out.push({ platform: 'tg', id, name, type, ts: Number(d.date || 0) * 1000 || 0 })
      } catch { /* one bad dialog */ }
    }
  } catch { /* session not ready */ }
  tgDialogs = out
  tgDialogsAt = Date.now()
}

// ============================================== MEDIA PIPELINE (view-once!)
// WhatsApp view-once media must be downloaded the instant it arrives —
// before the recipient opens it (and before any free-tier restart wipes it).
// The file lands in DATA_DIR/media and the exe pulls it via /api/media/:id.
const MEDIA_DIR = path.join(DATA_DIR, 'media')
const mediaMsgCache = new Map<string, { raw: any; mime: string; mediaType: string }>()   // recent raw messages (on-demand fetch)
const MEDIA_CACHE_MAX = 50

function extFromMime(mime: string, mediaType: string): string {
  const m = String(mime || '').toLowerCase()
  if (m.includes('jpeg') || m.includes('jpg')) return 'jpg'
  if (m.includes('png')) return 'png'
  if (m.includes('webp')) return 'webp'
  if (m.includes('gif')) return 'gif'
  if (m.includes('mp4')) return 'mp4'
  if (m.includes('webm')) return 'webm'
  if (m.includes('ogg') || m.includes('opus')) return 'ogg'
  if (m.includes('pdf')) return 'pdf'
  if (m.includes('mpeg') || m.includes('mp3')) return 'mp3'
  if (mediaType === 'image') return 'jpg'
  if (mediaType === 'video') return 'mp4'
  if (mediaType === 'audio') return 'ogg'
  if (mediaType === 'sticker') return 'webp'
  return 'bin'
}
function mediaFile(mediaId: string): string | null {
  const safe = String(mediaId || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 48)
  if (!safe) return null
  try {
    const files = fs.readdirSync(MEDIA_DIR).filter((f: string) => f.startsWith(safe + '.'))
    return files.length ? path.join(MEDIA_DIR, files[0]) : null
  } catch { return null }
}
function trimMediaDir() {
  try {
    const files = fs.readdirSync(MEDIA_DIR)
      .map((f: string) => ({ f, t: fs.statSync(path.join(MEDIA_DIR, f)).mtimeMs }))
      .sort((a: any, b: any) => b.t - a.t)
    for (const x of files.slice(MEDIA_CACHE_MAX)) fs.rmSync(path.join(MEDIA_DIR, x.f), { force: true })
  } catch { /* empty dir */ }
}

function unwrapMessage(msg: any): { inner: any; isViewOnce: boolean } {
  let content = msg?.message || msg || {}
  let isViewOnce = false
  for (let i = 0; i < 10; i++) {
    if (!content || typeof content !== 'object') break
    if (content.deviceSentMessage) {
      content = content.deviceSentMessage.message
      continue
    }
    if (content.ephemeralMessage) {
      content = content.ephemeralMessage.message
      continue
    }
    if (content.viewOnceMessage) {
      content = content.viewOnceMessage.message
      isViewOnce = true
      continue
    }
    if (content.viewOnceMessageV2) {
      content = content.viewOnceMessageV2.message
      isViewOnce = true
      continue
    }
    if (content.viewOnceMessageV2Extension) {
      content = content.viewOnceMessageV2Extension.message
      isViewOnce = true
      continue
    }
    if (content.documentWithCaptionMessage) {
      content = content.documentWithCaptionMessage.message
      continue
    }
    if (content.editedMessage) {
      content = content.editedMessage.message
      continue
    }
    break
  }
  return { inner: content || {}, isViewOnce }
}

// message → { raw, mediaType, mime, size, viewOnce, caption, secs } or null
function mediaOf(message: any) {
  const { inner, isViewOnce } = unwrapMessage(message)
  const holders: Array<[string, string]> = [
    ['imageMessage', 'image'],
    ['videoMessage', 'video'],
    ['audioMessage', 'audio'],
    ['stickerMessage', 'sticker'],
    ['documentMessage', 'document'],
  ]
  for (const [k, mediaType] of holders) {
    const m = inner[k]
    if (m) {
      let mime = String(m.mimetype || '')
      if (!mime) {
        if (mediaType === 'image') mime = 'image/jpeg'
        else if (mediaType === 'video') mime = 'video/mp4'
        else if (mediaType === 'audio') mime = 'audio/ogg'
        else mime = 'application/octet-stream'
      }
      return {
        raw: m,
        mediaType,
        viewOnce: isViewOnce,
        mime,
        size: Number(m.fileLength || 0) || 0,
        caption: String(m.caption || ''),
        secs: Number(m.seconds || 0) || 0,
      }
    }
  }
  return null
}
async function downloadWaMedia(rawMedia: any, mediaId: string, mime: string, mediaType: string): Promise<{ file: string; size: number }> {
  const baileys: any = await import('@whiskeysockets/baileys')
  let buf: Buffer
  try {
    const stream = await baileys.downloadContentFromMessage(rawMedia, mediaType, {})
    const chunks: Buffer[] = []
    for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    buf = Buffer.concat(chunks)
  } catch (errStream: any) {
    // fallback: wrap into simulated Baileys message
    const dlMsg = { message: { [mediaType + 'Message']: rawMedia } }
    buf = await baileys.downloadMediaMessage(dlMsg, 'buffer', {})
  }
  fs.mkdirSync(MEDIA_DIR, { recursive: true })
  const safe = String(mediaId || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 48) || 'media'
  const file = path.join(MEDIA_DIR, `${safe}.${extFromMime(mime, mediaType)}`)
  fs.writeFileSync(file, buf)
  trimMediaDir()
  return { file, size: buf.length }
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

// ------------------------------------------------- phone normalization (WA)
// Baileys' requestPairingCode builds `<phone>@s.whatsapp.net` VERBATIM — a
// leading +, a 00 prefix or a trunk zero after the country code produces an
// invalid JID, WhatsApp issues the code for a number that does not exist and
// the phone then rejects it ("wrong number/code"). Normalize here, always.
let libphone: any = null
async function getLibphone(): Promise<any> {
  if (libphone !== null) return libphone
  try { libphone = await import('libphonenumber-js') } catch { libphone = false as any }
  return libphone
}
interface NormPhone { ok: boolean; digits?: string; pretty?: string; err?: string }
async function normalizeWaPhone(raw: string, country?: string): Promise<NormPhone> {
  const s = String(raw || '').trim()
  if (!s) return { ok: false, err: 'enter a phone number' }
  let cleaned = s.replace(/[\s\-().]/g, '')
  if (cleaned.startsWith('00')) cleaned = '+' + cleaned.slice(2)
  const lp = await getLibphone()
  const cc = (country || '').toUpperCase()
  let pn: any = null
  // 1) international (+… or plain digits that already carry the country code)
  try { if (lp) pn = lp.parsePhoneNumberFromString(cleaned) } catch { /* try more */ }
  // 2) trunk-zero fix: +98 0917… → +98 917… (classic mistake libphonenumber may not auto-fix)
  if ((!pn || !pn.isValid()) && cleaned.startsWith('+') && lp) {
    const body = cleaned.slice(1)
    for (const cut of [1, 2, 3]) {
      if (body.length > cut + 8 && body[cut] === '0') {
        const cand = body.slice(0, cut) + body.slice(cut + 1)
        try {
          const t = lp.parsePhoneNumberFromString('+' + cand)
          if (t && t.isValid()) { pn = t; break }
        } catch { /* next */ }
      }
    }
  }
  // 3) local format (0917…) with the country picked in the exe
  if ((!pn || !pn.isValid()) && cc && lp) {
    try { pn = lp.parsePhoneNumberFromString(cleaned, cc) } catch { /* fallthrough */ }
  }
  if (pn && pn.isValid && pn.isValid()) {
    return { ok: true, digits: String(pn.number).replace(/^\+/, ''), pretty: pn.formatInternational() }
  }
  // last resort: bare digits sanity (10-15) so we never regress below old behavior.
  // A leading 0 can never be part of an E.164 number — that's a local format.
  const digits = cleaned.replace(/^\+/, '').replace(/\D/g, '')
  if (digits.startsWith('0')) {
    return { ok: false, err: 'this looks like a local number (starts with 0) — include the country code (e.g. +98 917 123 4567) or pick your country next to the input' }
  }
  if (digits.length >= 10 && digits.length <= 15) {
    return { ok: true, digits, pretty: '+' + digits }
  }
  return { ok: false, err: `not a valid WhatsApp number — use the full international format, e.g. +98 917 123 4567${cc ? ` (or a local number with ${cc} selected)` : ''}` }
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
  pairPhone: '',           // normalized digits for the pairing-code flow
  pairPhonePretty: '',     // "+98 917 …" for display in the exe
  pairingCodeAsked: false, // requested once per socket generation
  pairingCodeAt: 0,        // when the current code was issued
  pairBusy: false,         // a requestPairingCode call is scheduled / in flight
  err: '',
  sock: null as any,
  qr: null as { matrix: number[][]; text: string; at: number; gen: number } | null,
  gen: 0,                  // socket generation — exe uses it to drop stale QRs
  attempts: 0,
  initBusy: false,         // single-flight guard: never two sockets on one auth folder
  lastPairReqAt: 0,        // debounce for repeated pair requests
  lastPairReqKey: '',
}

function waCredsPresent(): boolean {
  try {
    const dir = path.join(DATA_DIR, 'wa-auth')
    return fs.existsSync(dir) && fs.readdirSync(dir).some(f => f.endsWith('.json'))
  } catch { return false }
}

async function waInit(opts: { force?: boolean } = {}) {
  // single-flight: a second concurrent socket on the same auth folder causes
  // a 401 conflict. waRequestPair passes force because it OWNS the busy flag
  // for the whole teardown+init sequence (no gap while it runs).
  if (wa.initBusy && !opts.force) return
  const owner = !opts.force
  if (owner) wa.initBusy = true
  try {
    await waInitInner()
  } finally {
    if (owner) wa.initBusy = false
  }
}

async function waInitInner() {
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
  wa.pairingCodeAsked = false // a fresh socket may request a fresh pairing code
  wa.pairBusy = false

  const { state, saveCreds } = await baileys.useMultiFileAuthState(path.join(DATA_DIR, 'wa-auth'))
  const { version } = await baileys.fetchLatestBaileysVersion().catch(() => ({ version: [2, 3000, 1023222034] }))
  const browserProfile = baileys.Browsers ? baileys.Browsers.windows('Desktop') : ['Windows', 'Desktop', '10.0.22631']
  const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: baileys.makeCacheableSignalKeyStore(state.keys, mkSilentLogger()),
    },
    printQRInTerminal: false,
    browser: browserProfile,
    logger: mkSilentLogger(),
    markOnlineOnConnect: false,      // don't force "online" presence on free tier
    syncFullHistory: false,          // don't require full sync in companion registration (avoids 428 disconnects)
    shouldSyncHistoryMessage: () => true, // accept and process WhatsApp history sync chunks
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
      // pairing-code flow takes precedence over QR — in this mode NO matrix
      // is ever served (the exe shows the code card only)
      if (wa.pairPhone) {
        if (!wa.pairingCodeAsked && !wa.pairBusy) {
          wa.pairingCodeAsked = true
          wa.pairBusy = true
          setTimeout(() => {
            if (wa.gen !== myGen || !wa.pairPhone || !wa.sock) { wa.pairBusy = false; return }
            sock.requestPairingCode(wa.pairPhone).then((code: any) => {
              wa.pairBusy = false
              if (wa.gen !== myGen || !code) return
              wa.pairingCode = String(code).toUpperCase()
              wa.pairingCodeAt = Date.now()
              pushEvent({ type: 'wa.status', platform: 'wa', chat: '', from: 'wa', fromName: 'WhatsApp', text: `pairing code for ${wa.pairPhonePretty || wa.pairPhone}: ${wa.pairingCode}` })
            }).catch((e: any) => {
              wa.pairBusy = false
              if (wa.gen !== myGen) return
              wa.err = `pairing code failed: ${msg(e)}`
              wa.pairingCodeAsked = false // allow retry if failed
              pushEvent({ type: 'wa.status', platform: 'wa', chat: '', from: 'wa', fromName: 'WhatsApp', text: wa.err })
            })
          }, 1500)
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
        // ROOT FIX: WhatsApp invalidated this device (removed / bad keys).
        // Keeping the old noise keys poisons EVERY future handshake (the old
        // behavior died here permanently). Wipe and auto-restart pairing.
        try { sock.end?.(undefined) } catch { /* noop */ }
        wa.sock = null
        wipeWaAuth()
        wa.pairingCode = ''
        wa.pairingCodeAsked = false
        wa.pairBusy = false
        wa.phone = ''
        wa.err = ''
        wa.attempts = 0
        wa.pairing = !!wa.pairPhone // phone pairing resumes automatically
        bumpSessionRev('wa device reset')
        pushEvent({ type: 'wa.status', platform: 'wa', chat: '', from: 'wa', fromName: 'WhatsApp', text: 'device was removed from the account — session keys reset, restarting pairing' })
        setTimeout(() => waInit().catch(() => { /* logged */ }), 1500)
        return
      }
      // a plain reconnect invalidates any issued pairing code — say so and
      // let the new socket request a fresh one automatically
      wa.pairBusy = false
      if (wa.pairingCode) {
        wa.pairingCode = ''
        pushEvent({ type: 'wa.status', platform: 'wa', chat: '', from: 'wa', fromName: 'WhatsApp', text: 'pairing code expired (connection restarted) — a fresh code will appear automatically' })
      }
      wa.attempts++
      const delay = Math.min(3000 * wa.attempts, 15000)
      pushEvent({ type: 'wa.status', platform: 'wa', chat: '', from: 'wa', fromName: 'WhatsApp', text: `connection closed (${code}) — reconnect #${wa.attempts} in ${Math.round(delay / 1000)}s` })
      if (wa.attempts <= 12) {
        await sleep(delay)
        if (wa.gen === myGen) {
          try { sock.end?.(undefined) } catch { /* noop */ }
          waInit().catch(() => { /* logged */ })
        }
      }
    } else if (connection === 'open') {
      if (wa.gen !== myGen) return
      wa.connected = true
      wa.pairing = false
      wa.qr = null
      wa.pairingCode = ''
      wa.pairPhone = ''
      wa.pairPhonePretty = ''
      wa.pairingCodeAsked = false
      wa.pairBusy = false
      wa.pairingCodeAt = 0
      wa.attempts = 0
      wa.err = ''
      wa.phone = String(sock.user?.id || '').split(':')[0]
      bumpSessionRev('wa linked')
      pushEvent({ type: 'wa.status', platform: 'wa', chat: '', from: 'wa', fromName: 'WhatsApp', text: `connected as +${wa.phone} — linked successfully` })
      // prime the chat directory with all groups and group participants
      try {
        sock.groupFetchAllParticipating().then((gs: any) => {
          let n = 0
          for (const id of Object.keys(gs || {})) {
            const g = gs[id]
            upsertWaChat(id, g?.subject || '', 0)
            n++
            for (const p of g?.participants || []) {
              const pn = String(p?.name || p?.notify || '')
              if (p?.id && pn) upsertWaChat(p.id, pn, 0) // named participants only — kills the number-spam flood
            }
          }
          if (n) pushEvent({ type: 'wa.status', platform: 'wa', chat: '', from: 'wa', fromName: 'WhatsApp', text: `chat directory ready (${waChats.size} chats)` })
        }).catch(() => { /* not critical */ })
      } catch { /* not critical */ }
      // request full app state resync for contacts from WhatsApp servers
      try {
        if (baileys.ALL_WA_PATCH_NAMES) {
          sock.resyncAppState(baileys.ALL_WA_PATCH_NAMES, true).catch(() => {})
        }
      } catch { /* not critical */ }
    }
  })

  sock.ev.on('messages.upsert', (m: any) => {
    if (m.type !== 'notify' && m.type !== 'append') return
    for (const message of m.messages || []) {
      try {
        const key = message.key || {}
        let jid = key.remoteJid || ''
        if (!jid && message.message?.deviceSentMessage?.destinationJid) {
          jid = message.message.deviceSentMessage.destinationJid
        }
        if (!jid || jid === 'status@broadcast') continue
        const { inner } = unwrapMessage(message)
        // chat directory: every message teaches us a chat + a display name
        upsertWaChat(jid, message.pushName || '', Date.now())
        if (key.participant) upsertWaChat(key.participant, message.pushName || '', 0)
        if (key.id) waLastSeenId.set(jid, String(key.id))

        // if message contains vcards/contacts, extract them to chat directory
        if (inner.contactMessage) {
          const vcard = String(inner.contactMessage.vcard || '')
          const fnMatch = vcard.match(/FN:(.+)/i)
          const telMatch = vcard.match(/waid=(\d+)/i) || vcard.match(/TEL.*:([+0-9]+)/i)
          if (telMatch) {
            const clean = telMatch[1].replace(/[^0-9]/g, '')
            if (clean.length >= 8) upsertWaChat(`${clean}@s.whatsapp.net`, fnMatch ? fnMatch[1].trim() : '', 0)
          }
        }

        // ---- media / view-once extraction
        const med = mediaOf(message)
        if (med) {
          const mediaId = String(key.id || '') || ('m' + Date.now())
          if (med.viewOnce) {
            // download NOW — before the recipient opens it / before it expires
            downloadWaMedia(med.raw, mediaId, med.mime, med.mediaType)
              .then((r) => pushEvent({ type: 'wa.media', platform: 'wa', chat: jid, from: key.participant || jid, fromName: message.pushName || '',
                text: `[view-once ${med.mediaType}${med.secs ? ` ${med.secs}s` : ''}] ${med.caption}`.trim(),
                extra: { id: mediaId, fromMe: !!key.fromMe, ts: message.messageTimestamp, mediaId, mime: med.mime, size: r.size, viewOnce: true, mediaType: med.mediaType } }))
              .catch((e: any) => pushEvent({ type: 'wa.status', platform: 'wa', chat: jid, from: 'wa', fromName: 'WhatsApp', text: `view-once download failed: ${msg(e).slice(0, 140)}` }))
          } else {
            // regular media: cache the raw message, pull bytes on demand
            mediaMsgCache.set(mediaId, { raw: med.raw, mime: med.mime, mediaType: med.mediaType })
            if (mediaMsgCache.size > MEDIA_CACHE_MAX) {
              const first = mediaMsgCache.keys().next().value as string
              mediaMsgCache.delete(first)
            }
            pushEvent({ type: 'wa.media', platform: 'wa', chat: jid, from: key.participant || jid, fromName: message.pushName || '',
              text: `[media ${med.mediaType}${med.secs ? ` ${med.secs}s` : ''}] ${med.caption}`.trim(),
              extra: { id: mediaId, fromMe: !!key.fromMe, ts: message.messageTimestamp, mediaId, mime: med.mime, size: med.size, viewOnce: false, mediaType: med.mediaType } })
          }
          // media messages never fall through to the text path
          continue
        }
        const text =
          inner.conversation ||
          inner.extendedTextMessage?.text ||
          inner.buttonsResponseMessage?.selectedButtonId ||
          inner.listResponseMessage?.singleSelectReply?.selectedRowId ||
          ''
        if (!text && !key.fromMe) continue // skip empty
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

  // chat directory feeds (modern Baileys v6 events)
  sock.ev.on('messaging-history.set', (h: any) => {
    for (const ch of h?.chats || []) upsertWaChat(ch.id, ch.name || '', ch.conversationTimestamp || 0)
    for (const ct of h?.contacts || []) {
      recordLidPair(ct.lid || (String(ct.id || '').endsWith('@lid') ? ct.id : ''), ct.jid || (!String(ct.id || '').endsWith('@lid') ? ct.id : ''))
      upsertWaChat(ct.id || ct.jid, ct.name || ct.notify || ct.verifiedName || '', 0)
    }
  })
  sock.ev.on('contacts.upsert', (cts: any[]) => {
    for (const ct of cts || []) {
      recordLidPair(ct.lid || (String(ct.id || '').endsWith('@lid') ? ct.id : ''), ct.jid || (!String(ct.id || '').endsWith('@lid') ? ct.id : ''))
      upsertWaChat(ct.id || ct.jid, ct.name || ct.notify || ct.verifiedName || '', 0)
    }
  })
  sock.ev.on('contacts.update', (updates: any[]) => {
    for (const ct of updates || []) {
      recordLidPair(ct.lid || (String(ct.id || '').endsWith('@lid') ? ct.id : ''), ct.jid || (!String(ct.id || '').endsWith('@lid') ? ct.id : ''))
      upsertWaChat(ct.id || ct.jid, ct.name || ct.notify || ct.verifiedName || '', 0)
    }
  })
  sock.ev.on('chats.upsert', (chs: any[]) => {
    for (const ch of chs || []) upsertWaChat(ch.id, ch.name || '', ch.conversationTimestamp || 0)
  })
  sock.ev.on('chats.update', (updates: any[]) => {
    for (const ch of updates || []) upsertWaChat(ch.id, ch.name || '', ch.conversationTimestamp || 0)
  })
  sock.ev.on('chats.set', (u: any) => { for (const ch of u?.chats || []) upsertWaChat(ch.id, ch.name || '', 0) })
  sock.ev.on('contacts.set', (u: any) => { for (const ct of u?.contacts || []) { recordLidPair(ct.lid || (String(ct.id || '').endsWith('@lid') ? ct.id : ''), ct.jid || (!String(ct.id || '').endsWith('@lid') ? ct.id : '')); upsertWaChat(ct.id || ct.jid, ct.name || ct.notify || '', 0) } })
  sock.ev.on('groups.upsert', (gs: any[]) => { for (const g of gs || []) upsertWaChat(g.id, g.subject || '', 0) })
  sock.ev.on('groups.update', (updates: any[]) => { for (const g of updates || []) upsertWaChat(g.id, g.subject || '', 0) })
}

function wipeWaAuth() {
  try { fs.rmSync(path.join(DATA_DIR, 'wa-auth'), { recursive: true, force: true }) } catch { /* noop */ }
  try { fs.mkdirSync(path.join(DATA_DIR, 'wa-auth'), { recursive: true }) } catch { /* noop */ }
}

// (re)start WhatsApp linking: QR flow, or pairing-code when a phone is given.
// Single-flight + debounced + always validated + always fresh keys.
async function waRequestPair(opts: { phone?: string; country?: string; pretty?: string } = {}) {
  // validate FIRST — bad input must never kill a running pairing session
  let phone = '', pretty = opts.pretty || ''
  if (opts.phone) {
    const norm = await normalizeWaPhone(opts.phone, opts.country)
    if (!norm.ok) throw new Error(norm.err || 'invalid phone number')
    phone = String(norm.digits)
    pretty = String(norm.pretty)
  }
  // debounce identical requests (double clicks / impatient retries)
  const key = `${opts.phone || ''}|${opts.country || ''}`
  if (key && key === wa.lastPairReqKey && Date.now() - wa.lastPairReqAt < 5000) {
    return // same request is already running
  }
  wa.lastPairReqAt = Date.now()
  wa.lastPairReqKey = key

  // same number + still-fresh code + live pairing session → just re-show the
  // current code. Restarting the socket here would kill a code the user may
  // be entering on their phone RIGHT NOW ("couldn't link device" on their end).
  if (
    phone && phone === wa.pairPhone && wa.pairingCode &&
    wa.pairingCodeAt && Date.now() - wa.pairingCodeAt < 90_000 &&
    !wa.connected && wa.pairing
  ) {
    pushEvent({ type: 'wa.status', platform: 'wa', chat: '', from: 'wa', fromName: 'WhatsApp', text: `pairing code for ${pretty || phone}: ${wa.pairingCode} (still valid — no restart needed)` })
    return
  }

  if (wa.initBusy) throw new Error('pairing is already starting — wait a few seconds')
  if (wa.connected) throw new Error(`already linked as +${wa.phone} — log out first to pair again`)
  wa.initBusy = true
  try {
    try { await wa.sock?.end?.(undefined) } catch { /* noop */ }
    wa.sock = null
    wa.gen++
    wipeWaAuth() // fresh noise identity per attempt — stale keys poison reconnects
    wa.qr = null
    wa.pairingCode = ''
    wa.pairingCodeAsked = false
    wa.pairBusy = false
    wa.pairingCodeAt = 0
    wa.pairPhone = phone
    wa.pairPhonePretty = pretty
    wa.pairing = true
    wa.attempts = 0
    wa.err = ''
    wa.connected = false
    wa.phone = ''
    bumpSessionRev('wa pair start')
    await sleep(400)
    await waInit({ force: true })
    pushEvent({ type: 'wa.status', platform: 'wa', chat: '', from: 'wa', fromName: 'WhatsApp', text: phone ? `requesting pairing code for ${pretty || phone}…` : 'new QR requested' })
  } finally {
    wa.initBusy = false
  }
}

async function waSend(a: any): Promise<any> {
  if (!wa.sock || !wa.connected) throw new Error('whatsapp not connected')
  // lenient chat addressing: bare digits → real JID; chat names → directory lookup
  let jid = String(a.chat || '')
  if (jid && !jid.includes('@')) {
    const bare = jid.replace(/[^0-9]/g, '')
    if (bare.length >= 8) jid = `${bare}@s.whatsapp.net`
    else {
      const hit = [...waChats.values()].find((c) => c.name.toLowerCase() === jid.toLowerCase())
      if (hit) jid = hit.id
      else throw new Error(`unknown chat "${a.chat}" — pick a chat from the exe picker or use a JID / phone number`)
    }
  }
  if (a.type === 'status' || jid === 'status@broadcast') {
    return await wa.sock.sendMessage('status@broadcast', { text: String(a.text || '') })
  }
  if (a.type === 'typing') { await wa.sock.sendPresenceUpdate('composing', jid); return { sent: true } }
  if (a.type === 'presence') {
    const st = String(a.text || 'available')
    await wa.sock.sendPresenceUpdate(st === 'unavailable' ? 'unavailable' : st === 'composing' ? 'composing' : 'available', jid)
    return { sent: true }
  }
  if (a.type === 'poll' && a.text) {
    const parts = String(a.text).split('|').map((s: string) => s.trim()).filter(Boolean)
    const question = parts.shift() || 'poll'
    if (!parts.length) throw new Error('poll needs options: "question|opt1|opt2"')
    return await wa.sock.sendMessage(jid, { poll: { name: question, values: parts.slice(0, 12), selectableCount: 1 } })
  }
  if (a.type === 'read') {
    const ids = (Array.isArray(a.messageIds) ? a.messageIds : a.messageId ? [a.messageId] : []).filter(Boolean)
    if (ids.length) await wa.sock.readMessages(ids.map((id: string) => ({ key: { remoteJid: jid, id } })))
    else {
      // mark the whole chat read via an empty read on the newest message we saw
      const last = waLastSeenId.get(jid)
      if (last) await wa.sock.readMessages([{ key: { remoteJid: jid, id: last } }])
    }
    return { sent: true }
  }
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
  wipeWaAuth()
  wa.connected = false
  wa.phone = ''
  wa.pairing = false
  wa.pairingCode = ''
  wa.pairPhone = ''
  wa.pairPhonePretty = ''
  wa.pairingCodeAsked = false
  wa.pairBusy = false
  wa.pairingCodeAt = 0
  wa.qr = null
  bumpSessionRev('wa logout')
  pushEvent({ type: 'wa.status', platform: 'wa', chat: '', from: 'wa', fromName: 'WhatsApp', text: 'session cleared — request new pairing' })
}

// ============================================== SESSION BACKUP (blob import/export)
function buildSessionExport() {
  const tgS = fs.existsSync(TG_SESSION_FILE()) ? fs.readFileSync(TG_SESSION_FILE(), 'utf8').trim() : ''
  const waFiles: Record<string, string> = {}
  if (wa.connected) { // ONLY export a really-linked session — never poison the exe backup
    const dir = path.join(DATA_DIR, 'wa-auth')
    try {
      for (const f of fs.readdirSync(dir)) {
        if (f.endsWith('.json')) waFiles[f] = fs.readFileSync(path.join(dir, f)).toString('base64')
      }
    } catch { /* empty */ }
  }
  const waOk = wa.connected && Object.keys(waFiles).length > 0
  const blob = JSON.stringify({ v: 3, rev: sessionRev, waOk, tg: tgS, wa: waFiles })
  return { tg: tgS, wa: waOk ? zlib.gzipSync(Buffer.from(blob)).toString('base64') : '', rev: sessionRev }
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
      if (obj.waOk !== true) {
        // v3 guard: this blob was exported from an unlinked/stale session —
        // restoring it would poison the relay forever. Skip it.
        pushEvent({ type: 'wa.status', platform: 'wa', chat: '', from: 'wa', fromName: 'WhatsApp', text: 'skipped stale whatsapp backup (not linked when exported)' })
      } else {
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
        wa.pairing = false
        wa.qr = null
        try { await wa.sock?.end?.(undefined) } catch { /* noop */ }
        wa.sock = null
        wa.connected = false
        pushEvent({ type: 'wa.status', platform: 'wa', chat: '', from: 'wa', fromName: 'WhatsApp', text: 'whatsapp session restored from PC backup' })
        setTimeout(() => waInit().catch(() => { /* logged */ }), 500)
      }
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
<span class="pill">WhatsApp ${wa.connected ? `<span class="ok">${esc(wa.phone)}</span>` : wa.pairing ? `<span class="warn">pairing${wa.pairPhonePretty ? ' ' + esc(wa.pairPhonePretty) : ''}</span>` : '<span class="warn">disconnected</span>'}</span>
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
      bootId: BOOT_ID,
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
        pairPhone: wa.pairPhone,
        pairPhonePretty: wa.pairPhonePretty,
        pairingCodeAgeSec: wa.pairingCodeAt ? Math.round((Date.now() - wa.pairingCodeAt) / 1000) : 0,
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
  // ---- chat directory (exe pickers)
  if (url.pathname === '/api/chats' && req.method === 'GET') {
    const plat = (url.searchParams.get('platform') || 'all').toLowerCase()
    const refresh = url.searchParams.get('refresh') === '1'
    if (refresh && wa.sock && wa.connected) {
      try {
        import('@whiskeysockets/baileys').then((baileys: any) => {
          wa.sock?.groupFetchAllParticipating().then((gs: any) => {
            for (const id of Object.keys(gs || {})) {
              const g = gs[id]
              upsertWaChat(id, g?.subject || '', 0)
              for (const p of g?.participants || []) {
                const pn = String(p?.name || p?.notify || '')
                if (p?.id && pn) upsertWaChat(p.id, pn, 0) // named participants only
              }
            }
          }).catch(() => {})
          if (baileys.ALL_WA_PATCH_NAMES) wa.sock?.resyncAppState(baileys.ALL_WA_PATCH_NAMES, true).catch(() => {})
        }).catch(() => {})
      } catch { /* best effort */ }
    }
    if ((plat === 'tg' || plat === 'all') && tg.authorized && (refresh || Date.now() - tgDialogsAt > 120_000)) {
      tgDialogsAt = Date.now() // claim BEFORE fetching (avoid parallel storms)
      await tgFetchDialogs().catch(() => { /* best effort */ })
    }
    let list: ChatEntry[] = []
    if (plat === 'wa' || plat === 'all') list = list.concat([...waChats.values()])
    if (plat === 'tg' || plat === 'all') list = list.concat(tgDialogs)
    list.sort((a, b) => (b.ts || 0) - (a.ts || 0))
    if (list.length > 500) list = list.slice(0, 500)
    sendJson(res, 200, { ok: true, chats: list, count: list.length, wa: wa.connected, tg: tg.authorized })
    return
  }

  // ---- media bytes (view-once saver + manual saves)
  if (url.pathname.startsWith('/api/media/') && req.method === 'GET') {
    const mediaId = decodeURIComponent(url.pathname.slice('/api/media/'.length)).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 48)
    if (!mediaId) { sendJson(res, 400, { ok: false, error: 'media id required' }); return }
    let file = mediaFile(mediaId)
    if (!file && mediaMsgCache.has(mediaId)) {
      // on-demand download for regular (non view-once) media
      try {
        const cached = mediaMsgCache.get(mediaId)
        if (cached?.raw) {
          const r = await downloadWaMedia(cached.raw, mediaId, cached.mime, cached.mediaType)
          file = r.file
        }
      } catch (e: any) { sendJson(res, 502, { ok: false, error: `download failed: ${msg(e).slice(0, 140)}` }); return }
    }
    if (!file) { sendJson(res, 404, { ok: false, error: 'media expired (free-tier restart?) — view-once files are only kept briefly' }); return }
    try {
      const buf = fs.readFileSync(file)
      const ext = path.extname(file).slice(1).toLowerCase()
      const mime = ext === 'jpg' ? 'image/jpeg' : ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp'
        : ext === 'mp4' ? 'video/mp4' : ext === 'webm' ? 'video/webm' : ext === 'ogg' ? 'audio/ogg'
        : ext === 'mp3' ? 'audio/mpeg' : ext === 'pdf' ? 'application/pdf' : 'application/octet-stream'
      res.writeHead(200, { 'content-type': mime, 'content-length': buf.length, 'cache-control': 'no-store' })
      res.end(buf)
    } catch (e: any) { sendJson(res, 500, { ok: false, error: msg(e) }) }
    return
  }

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
    if (!wa.qr) { sendJson(res, 200, { ok: true, pending: false, pairing: wa.pairing, connected: wa.connected, pairingCode: wa.pairingCode, pairPhone: wa.pairPhone, pairPhonePretty: wa.pairPhonePretty, gen: wa.gen }); return }
    sendJson(res, 200, {
      ok: true, pending: true, pairing: true, connected: wa.connected,
      qrMatrix: wa.qr.matrix, qrText: wa.qr.text,
      gen: wa.qr.gen,
      pairingCode: wa.pairingCode,
      pairPhone: wa.pairPhone,
      pairPhonePretty: wa.pairPhonePretty,
      expiresSec: Math.max(0, 20 - Math.round((Date.now() - wa.qr.at) / 1000)),
    })
    return
  }

  // ---- browser-scannable QR page (authenticated via token)
  if (url.pathname === '/api/qr/view' && req.method === 'GET') {
    const q = await getQrcode()
    const text = wa.qr?.text || tg.qr?.text || ''
    if (!text || !q) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(`<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="3"><style>body{background:#0b0e14;color:#d7dce5;font-family:sans-serif;text-align:center;padding:50px}</style></head><body><h2>Waiting for QR code...</h2><p>Page refreshes automatically every 3 seconds.</p></body></html>`)
      return
    }
    const svg = await q.toString(text, { type: 'svg', margin: 2, color: { dark: '#000000', light: '#ffffff' } })
    const tokenParam = url.searchParams.get('token') || ''
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(`<!doctype html><html><head><meta charset="utf-8"><title>Scan QR Code</title><meta http-equiv="refresh" content="6;url=/api/qr/view?token=${encodeURIComponent(tokenParam)}"><style>body{background:#0b0e14;color:#fff;font-family:sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;margin:0}.card{background:#fff;padding:24px;border-radius:16px;box-shadow:0 8px 32px rgba(0,0,0,0.5);display:flex;justify-content:center;align-items:center}svg{width:320px;height:320px;display:block}h2{color:#7ee0a3;margin-top:0}p{color:#8892b0;font-size:14px;margin-top:16px}</style></head><body><h2>Scan with WhatsApp or Telegram</h2><div class="card">${svg}</div><p>Open WhatsApp &gt; Linked Devices &gt; Link a Device. Auto-refreshes every 6s.</p></body></html>`)
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
    if (body.whatsappAction === 'pair') {
      try {
        await waRequestPair({})
        changed.push('whatsappPair')
      } catch (e: any) { sendJson(res, 502, { ok: false, error: msg(e) }); return }
    }
    if (body.whatsappAction === 'paircode') {
      if (!body.waPhone) { sendJson(res, 400, { ok: false, error: 'waPhone required for paircode' }); return }
      const norm = await normalizeWaPhone(String(body.waPhone), body.waPhoneCountry ? String(body.waPhoneCountry) : undefined)
      if (!norm.ok) { sendJson(res, 400, { ok: false, error: `invalid phone number: ${norm.err}` }); return }
      try {
        await waRequestPair({ phone: String(norm.digits), country: body.waPhoneCountry ? String(body.waPhoneCountry) : undefined, pretty: String(norm.pretty) })
        changed.push('whatsappPairCode')
      } catch (e: any) { sendJson(res, 502, { ok: false, error: msg(e) }); return }
    }
    if (body.whatsappAction === 'logout') { await waLogout(); changed.push('whatsappLogout') }
    sendJson(res, 200, { ok: true, changed, pairingCode: wa.pairingCode || '', waPhone: wa.pairPhone || '', waPhonePretty: wa.pairPhonePretty || '' })
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

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[relay] ${RELAY_NAME} v${RELAY_VERSION} listening on 0.0.0.0:${PORT}`)
  console.log(`[relay] status page: http://localhost:${PORT}/`)
  console.log(`[relay] AUTH_TOKEN: ${TOKEN}`)
  pushEvent({ type: 'sys.log', platform: 'sys', chat: '', from: 'relay', fromName: 'Relay', text: `Aurora Cloud Relay v${RELAY_VERSION} booted (telegram userbot + whatsapp · pairing hardening)` })
  loadWaChats()
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

  // keep-alive: prevents Render free tier from sleeping after 15 min inactivity
  const keepAliveUrl = process.env.KEEP_ALIVE_URL || process.env.RENDER_EXTERNAL_URL
  if (keepAliveUrl) {
    const target = keepAliveUrl.replace(/\/$/, '')
    console.log(`[relay] keep-alive active for ${target} (pings every 10 min)`)
    setInterval(() => {
      try {
        const u = new URL(`${target}/health`)
        const mod = u.protocol === 'https:' ? https : http
        mod.get(u, (r) => { r.resume() }).on('error', () => { /* best effort */ })
      } catch { /* invalid url */ }
    }, 10 * 60 * 1000)
  }
})

// process crash guards: background socket hiccups must never crash the service
process.on('uncaughtException', (err) => {
  console.error('[relay] uncaughtException (handled):', (err as any)?.message || err)
})
process.on('unhandledRejection', (reason) => {
  console.error('[relay] unhandledRejection (handled):', (reason as any)?.message || reason)
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
