#!/usr/bin/env node
/**
 * dsh-desktop-alert - desktop notification bridge for the DSH web UI.
 *
 * Why this exists
 * ---------------
 * A web page can only raise a browser notification: it is attributed to the
 * browser, it needs the page's notification permission, and it is suppressed
 * whenever Windows or the browser decides to stay quiet. Z-Code WorkBuddy does
 * it the way a desktop app should - its Electron main process calls
 * "new Notification(...)" from the host, so the reminder shows up over the
 * whole desktop and a click jumps straight back to the task session.
 *
 * This bridge gives the DSH web UI the same shape inside the browser's limits:
 *
 *   DSH page (client plugin)  --POST /notify-->  bridge  --spawn-->  present.ps1
 *   DSH page <--SSE "open"----  bridge  <--POST /click--  card (user clicked)
 *
 * The card is a native topmost window (WinForms/WPF through powershell.exe), so
 * it appears above every application, needs no permission and no browser focus.
 * Clicking it asks the bridge to push "open <sessionId>" down the page's SSE
 * stream, so the already-open DSH tab jumps to that session; if no page is
 * connected the card falls back to opening the page URL in the default browser.
 *
 * Runtime layout (installed copy):
 *   ~/.dsh/desktop-alert/bridge.mjs        this file
 *   ~/.dsh/desktop-alert/supervise.mjs     keeps this process alive
 *   ~/.dsh/desktop-alert/present.ps1       the native card
 *   ~/.dsh/desktop-alert/bridge.log        append-only log (rotated at 512 KB)
 *   ~/.dsh/desktop-alert/tmp/*.json        one payload file per visible card
 *
 * No dependencies: node:http only. Loopback-only, browser origins restricted to
 * localhost, so a random web page cannot make the desktop pop reminders.
 *
 * usage: node bridge.mjs [--port 41411] [--max-cards 3] [--verbose]
 */
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const RUNTIME = process.env.DSH_DESKTOP_ALERT_DIR || path.join(HOME, 'desktop-alert')
const TMP = path.join(RUNTIME, 'tmp')
const LOG = path.join(RUNTIME, 'bridge.log')
const PRESENTER = path.join(HERE, 'present.ps1')
const TOASTER = path.join(HERE, 'toast.ps1')
const SERVICE = 'dsh-desktop-alert'
const VERSION = '1.0.0'
const PORTS = [41411, 41412, 41413]
const ORIGIN_RE = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/

const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}
const MAX_CARDS = Math.max(1, Number(flag('--max-cards', '3')) || 3)
const SURFACE = String(flag('--surface', 'card'))
const VERBOSE = argv.includes('--verbose')
const FORCED_PORT = argv.includes('--port') ? Number(flag('--port', '0')) : 0

fs.mkdirSync(TMP, { recursive: true })

/** Append one line to bridge.log, rotating once past 512 KB. */
function log(message) {
  const line = new Date().toISOString() + ' ' + message + '\n'
  if (VERBOSE) process.stdout.write(line)
  try {
    const stat = fs.statSync(LOG, { throwIfNoEntry: false })
    if (stat && stat.size > 512 * 1024) fs.renameSync(LOG, LOG + '.1')
  } catch { /* rotation is best effort */ }
  try { fs.appendFileSync(LOG, line) } catch { /* logging must never break a notification */ }
}

/** The Windows PowerShell 5.1 host; WPF/WinRT need it (pwsh 7 cannot load WinRT). */
function powershellExe() {
  const root = process.env.SystemRoot || 'C:\\Windows'
  const full = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return fs.existsSync(full) ? full : 'powershell.exe'
}

//#region card processes
/** slot -> { child, payload, sessionId, kind, startedAt } */
const cards = new Map()
let sequence = 0

/** Hand the lowest free slot to a new card, closing the oldest one if full. */
function takeSlot() {
  for (let slot = 0; slot < MAX_CARDS; slot += 1) if (!cards.has(slot)) return slot
  let oldest = null
  for (const [slot, entry] of cards) if (!oldest || entry.startedAt < oldest.entry.startedAt) oldest = { slot, entry }
  if (oldest) {
    log('slot ' + oldest.slot + ' recycled (all ' + MAX_CARDS + ' slots busy)')
    try { oldest.entry.child.kill() } catch { /* the child may be exiting already */ }
    cards.delete(oldest.slot)
  }
  return 0
}

/** Normalize whatever the page sent into the payload present.ps1 expects. */
function normalize(body) {
  const kind = body.kind === 'waiting' ? 'waiting' : body.kind === 'info' ? 'info' : body.kind === 'failed' ? 'failed' : 'completed'
  const defaults = kind === 'waiting'
    ? { glyph: '\u23F3', accent: '#FFE8A13A' }
    : kind === 'info'
      ? { glyph: '\u2139', accent: '#FF3B82F6' }
      : kind === 'failed'
        ? { glyph: '\u2715', accent: '#FFEF4444' }
        : { glyph: '\u2713', accent: '#FF22C55E' }
  return {
    kind,
    title: String(body.title || 'DSH'),
    body: String(body.body || ''),
    hint: String(body.hint || ''),
    glyph: String(body.glyph || defaults.glyph),
    accent: String(body.accent || defaults.accent),
    theme: body.theme === 'light' ? 'light' : 'dark',
    durationMs: Math.min(60000, Math.max(3000, Number(body.durationMs) || 9000)),
    sessionId: body.sessionId ? String(body.sessionId) : '',
    url: body.url ? String(body.url) : '',
    windowTitle: body.windowTitle ? String(body.windowTitle) : ''
  }
}

/**
 * Short, stable toast tag for one session: Windows caps a tag at 16 characters
 * and the removal call must produce the same string.
 */
function toastTag(sessionId) {
  const compact = String(sessionId || '').replace(/[^A-Za-z0-9]/g, '')
  return ('dsh' + compact.slice(0, 13)) || 'dsh-desktop-alert'
}

/** Raise (or remove) one native Windows toast, attributed to the DSH app id. */
function showToast(payload, remove) {
  sequence += 1
  const payloadPath = path.join(TMP, (remove ? 'untoast-' : 'toast-') + process.pid + '-' + sequence + '.json')
  fs.writeFileSync(payloadPath, JSON.stringify({
    appId: payload.appId,
    title: payload.title,
    body: payload.body,
    tag: toastTag(payload.sessionId)
  }, null, 2), 'utf8')
  const child = spawn(powershellExe(), [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
    '-File', TOASTER, '-Payload', payloadPath
  ].concat(remove ? ['-Remove'] : []), { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', (chunk) => { if (stderr.length < 2000) stderr += String(chunk) })
  child.on('exit', (code) => {
    if (stderr.trim()) log('toast stderr: ' + stderr.trim().replace(/\s+/g, ' ').slice(0, 300))
    try { fs.rmSync(payloadPath, { force: true }) } catch { /* ignore */ }
    log('toast done code=' + code + ' session=' + (payload.sessionId || '-'))
  })
  child.on('error', (err) => log('toast spawn failed: ' + (err && err.message ? err.message : String(err))))
  log((remove ? 'toast removed' : 'toast shown') + ' kind=' + payload.kind + ' session=' + (payload.sessionId || '-'))
}

/** Which surfaces one notification should use. */
function surfacesOf(value) {
  const wanted = String(value || SURFACE)
  if (wanted === 'none') return []
  if (wanted === 'toast') return ['toast']
  if (wanted === 'both') return ['card', 'toast']
  return ['card']
}

/** Show one desktop card; returns the slot it landed in. */
function showCard(payload) {
  const slot = takeSlot()
  sequence += 1
  const payloadPath = path.join(TMP, 'card-' + process.pid + '-' + sequence + '.json')
  const card = {
    ...payload,
    bridgeUrl: 'http://127.0.0.1:' + server.address().port,
    durationMs: payload.durationMs
  }
  fs.writeFileSync(payloadPath, JSON.stringify(card, null, 2), 'utf8')
  const child = spawn(powershellExe(), [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
    '-File', PRESENTER, '-Payload', payloadPath, '-Slot', String(slot)
  ], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', (chunk) => { if (stderr.length < 4000) stderr += String(chunk) })
  const entry = { child, payloadPath, sessionId: card.sessionId, kind: card.kind, startedAt: Date.now() }
  cards.set(slot, entry)
  child.on('exit', (code) => {
    if (stderr.trim()) log('presenter stderr: ' + stderr.trim().replace(/\s+/g, ' ').slice(0, 500))
    if (cards.get(slot) === entry) cards.delete(slot)
    try { fs.rmSync(payloadPath, { force: true }) } catch { /* ignore */ }
    log('card closed slot=' + slot + ' code=' + code + ' session=' + (card.sessionId || '-'))
  })
  child.on('error', (err) => log('presenter spawn failed: ' + (err && err.message ? err.message : String(err))))
  log('card shown slot=' + slot + ' kind=' + card.kind + ' session=' + (card.sessionId || '-') + ' title=' + card.title)
  return slot
}
//#endregion

//#region page connections (SSE)
/** Live EventSource responses from DSH pages. */
const pages = new Set()

function broadcast(event) {
  const frame = 'event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n'
  let delivered = 0
  for (const res of pages) {
    try { res.write(frame); delivered += 1 } catch { pages.delete(res) }
  }
  return delivered
}
//#endregion

//#region http
function cors(req, res) {
  const origin = req.headers.origin
  if (origin && ORIGIN_RE.test(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
  } else if (!origin) {
    res.setHeader('Access-Control-Allow-Origin', '*')
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'content-type')
  res.setHeader('Access-Control-Max-Age', '600')
}

function json(res, code, value) {
  const text = JSON.stringify(value)
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text) })
  res.end(text)
}

async function readJson(req, limit = 64 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('body too large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  let text = Buffer.concat(chunks).toString('utf8')
  // A UTF-8 BOM is legal on the wire and fatal to JSON.parse; strip it (and any
  // stray leading whitespace) instead of silently dropping one notification.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  return JSON.parse(text.trim())
}

/** Recent notifications, newest last - the CLI and tests read this back. */
const recent = []
function remember(entry) {
  recent.push(entry)
  if (recent.length > 50) recent.shift()
}

let lastFire = { key: '', at: 0 }
/** sessionId -> { kind, at }: a failure explains the completion that follows it. */
const lastBySession = new Map()
const FAILURE_WINS_MS = 8000

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1')
  cors(req, res)
  const origin = req.headers.origin
  if (origin && !ORIGIN_RE.test(origin)) {
    log('rejected origin ' + origin + ' for ' + url.pathname)
    return json(res, 403, { ok: false, error: 'origin not allowed' })
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    return res.end()
  }

  try {
    if (req.method === 'GET' && url.pathname === '/health') {
      return json(res, 200, {
        ok: true,
        service: SERVICE,
        version: VERSION,
        port: server.address().port,
        pages: pages.size,
        cards: cards.size,
        maxCards: MAX_CARDS,
        surface: SURFACE,
        uptimeMs: Math.round(process.uptime() * 1000),
        platform: process.platform
      })
    }

    if (req.method === 'GET' && url.pathname === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no'
      })
      res.write('retry: 3000\n\n')
      res.write('event: hello\ndata: ' + JSON.stringify({ type: 'hello', service: SERVICE, version: VERSION, at: Date.now() }) + '\n\n')
      pages.add(res)
      log('page connected (pages=' + pages.size + ')')
      const beat = setInterval(() => { try { res.write(': ping\n\n') } catch { /* closed */ } }, 25000)
      req.on('close', () => {
        clearInterval(beat)
        pages.delete(res)
        log('page disconnected (pages=' + pages.size + ')')
      })
      return undefined
    }

    if (req.method === 'POST' && url.pathname === '/notify') {
      const body = await readJson(req)
      const payload = normalize(body)
      const key = payload.kind + ':' + payload.sessionId + ':' + payload.title
      const now = Date.now()
      if (key === lastFire.key && now - lastFire.at < 2500) {
        log('deduplicated repeat notify ' + key)
        return json(res, 200, { ok: true, deduplicated: true })
      }
      lastFire = { key, at: now }
      const surfaces = surfacesOf(body.surface)
      // A run that fails usually also stops, so the client half raises its
      // "completed" card moments later. The failure is the truthful one.
      const previous = payload.sessionId ? lastBySession.get(payload.sessionId) : null
      if (previous && previous.kind === 'failed' && payload.kind === 'completed' && now - previous.at < FAILURE_WINS_MS) {
        log('suppressed the completion card after a failure for session=' + payload.sessionId)
        return json(res, 200, { ok: true, suppressed: 'after-failure' })
      }
      if (payload.sessionId) lastBySession.set(payload.sessionId, { kind: payload.kind, at: now })
      // A toast and a card land in the same corner; without this the toast hides
      // the clickable card for the first seconds, exactly when the eye arrives.
      if (surfaces.indexOf('card') >= 0 && surfaces.indexOf('toast') >= 0 && !payload.yOffset) payload.yOffset = 140
      if (body.dryRun === true) return json(res, 200, { ok: true, dryRun: true, surfaces, payload })
      const slot = surfaces.indexOf('card') >= 0 ? showCard(payload) : null
      if (surfaces.indexOf('toast') >= 0) showToast(payload)
      remember({ at: now, kind: payload.kind, title: payload.title, sessionId: payload.sessionId, slot, surfaces })
      return json(res, 200, { ok: true, slot, surfaces })
    }

    if (req.method === 'POST' && url.pathname === '/click') {
      const body = await readJson(req)
      const sessionId = body.sessionId ? String(body.sessionId) : ''
      const delivered = pages.size > 0
      if (delivered) broadcast({ type: 'open-session', sessionId, at: Date.now() })
      log('card click session=' + (sessionId || '-') + ' pages=' + pages.size + ' delivered=' + delivered)
      return json(res, 200, { ok: true, opened: delivered, url: delivered ? '' : String(body.url || '') })
    }

    if (req.method === 'POST' && url.pathname === '/dismiss') {
      // The page calls this when a waiting interaction is answered: the Action
      // Center entry for that session must not outlive the thing it announced.
      const body = await readJson(req)
      const sessionId = body.sessionId ? String(body.sessionId) : ''
      showToast({ kind: 'dismiss', sessionId, title: '', body: '' }, true)
      log('toast dismissal requested session=' + (sessionId || '-'))
      return json(res, 200, { ok: true, tag: toastTag(sessionId) })
    }

    if (req.method === 'POST' && url.pathname === '/ack') {
      const body = await readJson(req)
      log('page ack open session=' + (body.sessionId ? String(body.sessionId) : '-'))
      return json(res, 200, { ok: true })
    }

    if (req.method === 'GET' && url.pathname === '/recent') {
      return json(res, 200, { ok: true, recent })
    }

    if (req.method === 'POST' && url.pathname === '/quit') {
      log('quit requested')
      json(res, 200, { ok: true })
      setTimeout(() => shutdown(0), 50)
      return undefined
    }

    return json(res, 404, { ok: false, error: 'not found' })
  } catch (err) {
    log('request failed ' + url.pathname + ': ' + (err && err.message ? err.message : String(err)))
    return json(res, 400, { ok: false, error: err && err.message ? err.message : String(err) })
  }
})
//#endregion

//#region lifecycle
function listening(port) {
  return new Promise((resolve, reject) => {
    const onError = (err) => { server.removeListener('listening', onListening); reject(err) }
    const onListening = () => { server.removeListener('error', onError); resolve() }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, '127.0.0.1')
  })
}

/** Is another copy of this service already on the port? */
async function probe(port) {
  try {
    const res = await fetch('http://127.0.0.1:' + port + '/health', { signal: AbortSignal.timeout(800) })
    const body = await res.json()
    return body && body.service === SERVICE ? body : null
  } catch { return null }
}

function shutdown(code) {
  for (const entry of cards.values()) { try { entry.child.kill() } catch { /* ignore */ } }
  cards.clear()
  for (const res of pages) { try { res.end() } catch { /* ignore */ } }
  pages.clear()
  try { fs.rmSync(path.join(RUNTIME, 'bridge.pid'), { force: true }) } catch { /* ignore */ }
  log('bridge stopped')
  server.close(() => process.exit(code))
  setTimeout(() => process.exit(code), 500)
}

const candidates = FORCED_PORT ? [FORCED_PORT] : PORTS
let bound = 0
for (const port of candidates) {
  const running = await probe(port)
  if (running) {
    log('another bridge is already listening on ' + port + ' (pid unknown) - exiting')
    console.log(JSON.stringify({ ok: true, alreadyRunning: true, port, ...running }))
    process.exit(0)
  }
  try {
    await listening(port)
    bound = port
    break
  } catch (err) {
    if (err && err.code === 'EADDRINUSE') { log('port ' + port + ' busy, trying the next one'); continue }
    log('listen failed on ' + port + ': ' + (err && err.message ? err.message : String(err)))
    process.exit(1)
  }
}
if (!bound) {
  log('no free port among ' + candidates.join(', '))
  process.exit(1)
}

fs.writeFileSync(path.join(RUNTIME, 'bridge.pid'), String(process.pid), 'utf8')
// One file that answers "which port, which pid, since when" without guessing.
fs.writeFileSync(path.join(RUNTIME, 'endpoint.json'), JSON.stringify({
  service: SERVICE,
  version: VERSION,
  port: bound,
  pid: process.pid,
  startedAt: new Date().toISOString()
}, null, 2) + '\n', 'utf8')
log('bridge listening on http://127.0.0.1:' + bound + ' (pid ' + process.pid + ', maxCards ' + MAX_CARDS + ')')
console.log(JSON.stringify({ ok: true, listening: bound, pid: process.pid, service: SERVICE, version: VERSION }))

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))
process.on('uncaughtException', (err) => {
  // An uncaught exception must not look like the silent death of 03:19.
  log('uncaught: ' + (err && err.stack ? err.stack : String(err)))
  try { fs.rmSync(path.join(RUNTIME, 'bridge.pid'), { force: true }) } catch { /* ignore */ }
  process.exit(1)
})
process.on('unhandledRejection', (reason) => log('unhandled rejection: ' + String(reason)))
process.on('exit', (code) => {
  log('bridge exiting (code ' + code + ') - a running supervisor restarts it')
  try { fs.rmSync(path.join(RUNTIME, 'endpoint.json'), { force: true }) } catch { /* ignore */ }
})
//#endregion
