/**
 * dsh-session-alert - host half.
 *
 * The client half (lib/client.js) decides when a run that ended *normally*
 * deserves a reminder - it watches session status and the session list. One
 * failure never reaches it: the host's \`api-session/error\` event, documented as
 * "one Agent failed outside a durable turn position" - a dropped connection, a
 * provider error before a turn opens, a rejected prompt RPC. No turn boundary
 * exists, so no client-side status transition is guaranteed, and the page may
 * not even be open.
 *
 * So the host half listens for that event and forwards it to the loopback
 * desktop bridge, which owns the native popup. That is the whole job: no RPC,
 * no session data, no configuration surface.
 *
 * Failure flapping (an unstable connection retrying every few seconds) is
 * rate-limited per session so one bad link cannot turn into a card storm.
 *
 * It also supervises the bridge from here. The bridge died once with no trace
 * and nothing restarted it (the logon shortcut only fires at logon), so the host
 * - which is alive exactly while the human is working - brings it back: one
 * check at load, then every few minutes. A standalone supervisor
 * (desktop/supervise.mjs) covers the same ground when the harness is not running;
 * both probe /health first, and the bridge refuses to bind twice, so they cannot
 * fight over the port.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const BRIDGE_PORTS = [41411, 41412, 41413]
const WATCHDOG_MS = 5 * 60 * 1000
const SPAWN_COOLDOWN_MS = 60 * 1000
const RATE_LIMIT_MS = 60 * 1000
const BODY_LIMIT = 180

/** Session id -> wall-clock ms of the last card we raised for it. */
const lastSentAt = new Map()
let resolvedPort = 0
let lastSpawnAt = 0

const HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
// The marker lives in DSH_HOME, not next to a relocated runtime: every process
// that can respawn the bridge must find the same file, and this half only knows
// DSH_HOME (desktop/cli.mjs and desktop/supervise.mjs use the same expression).
const DISABLED = path.join(HOME, 'desktop-alert.disabled')

/** Where the bridge script lives: the installed runtime first, the package second. */
function bridgeScript() {
  const installed = path.join(HOME, 'desktop-alert', 'bridge.mjs')
  if (fs.existsSync(installed)) return installed
  const shipped = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'desktop', 'bridge.mjs')
  return fs.existsSync(shipped) ? shipped : ''
}

/**
 * The marker 'cli uninstall' leaves behind; the shipped copy must not undo it.
 * Exported so test/supervise.mjs can assert that all three halves resolve the
 * same path - the split between them is exactly where this bug lived.
 */
export function disabledMarker() {
  return DISABLED
}

/** Bring the bridge up when it is not answering; never throws, never storms. */
async function ensureBridge() {
  try {
    if (fs.existsSync(disabledMarker())) return false
    if (await findBridge()) return true
    if (Date.now() - lastSpawnAt < SPAWN_COOLDOWN_MS) return false
    const script = bridgeScript()
    if (!script) { log('bridge script not found; desktop reminders stay off'); return false }
    lastSpawnAt = Date.now()
    const child = spawn(process.execPath, [script], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      cwd: path.dirname(script)
    })
    child.on('error', (error) => log('could not start the bridge process: ' + (error && error.message ? error.message : String(error))))
    child.unref()
    log('desktop bridge was not running - started it (pid ' + (child.pid || '?') + ')')
    return true
  } catch (error) {
    log('could not ensure the bridge: ' + (error && error.message ? error.message : String(error)))
    return false
  }
}

function log(message) {
  try { console.warn('[dsh-session-alert] ' + message) } catch { /* logging must never break the host */ }
}

/** First bridge port that answers /health with our service identity, else 0. */
async function findBridge() {
  for (const port of BRIDGE_PORTS) {
    try {
      const response = await fetch('http://127.0.0.1:' + port + '/health', {
        cache: 'no-store',
        signal: AbortSignal.timeout(1200)
      })
      const body = await response.json()
      if (body && body.service === 'dsh-desktop-alert') return port
    } catch { /* nothing on this port */ }
  }
  return 0
}

/** Raise one failure card; silent (logged once per attempt path) when the bridge is down. */
async function notifyFailure(sessionId, message) {
  const text = String(message || '').replace(/\s+/g, ' ').trim()
  if (!text) return
  if (!resolvedPort) resolvedPort = await findBridge()
  if (!resolvedPort) return
  const payload = {
    kind: 'failed',
    title: 'DSH · 会话运行失败',
    body: text.slice(0, BODY_LIMIT),
    hint: '点击打开会话',
    sessionId: String(sessionId || ''),
    source: 'host'
  }
  try {
    const response = await fetch('http://127.0.0.1:' + resolvedPort + '/notify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(2000)
    })
    if (!response.ok) log('bridge rejected a failure card: HTTP ' + response.status)
  } catch (error) {
    // The bridge may have restarted on another port; re-resolve next time.
    resolvedPort = 0
    log('could not reach the desktop bridge: ' + (error && error.message ? error.message : String(error)))
  }
}

/**
 * Host-side plugin body.
 * @param ctx - cordis context of the host process.
 */
export function apply(ctx) {
  // Supervision first: a failure reminder is useless if the bridge is down.
  void ensureBridge()
  try {
    if (ctx && typeof ctx.effect === 'function') {
      ctx.effect(() => {
        const timer = setInterval(() => { void ensureBridge() }, WATCHDOG_MS)
        return () => clearInterval(timer)
      }, 'dsh-session-alert: bridge watchdog')
    } else {
      // No teardown hook, so no repeating timer: an interval nobody can clear
      // would keep a disposed host alive. One check at load is enough here.
      log('host context has no effect(); the periodic bridge check stays off')
    }
  } catch (error) {
    log('watchdog could not start: ' + (error && error.message ? error.message : String(error)))
  }
  if (!ctx || typeof ctx.on !== 'function') {
    log('host context cannot subscribe to api-session/error; failure reminders are off')
    return
  }
  ctx.on('api-session/error', (sessionId, message) => {
    const id = String(sessionId || '')
    const now = Date.now()
    const previous = lastSentAt.get(id) || 0
    if (now - previous < RATE_LIMIT_MS) {
      log('failure for ' + id + ' suppressed by the rate limit (' + Math.round((now - previous) / 1000) + 's since the last card)')
      return
    }
    lastSentAt.set(id, now)
    if (lastSentAt.size > 200) {
      for (const [key, at] of lastSentAt) if (now - at > RATE_LIMIT_MS) lastSentAt.delete(key)
    }
    log('session failed: ' + id + ' - ' + String(message || '').slice(0, 120))
    void notifyFailure(id, message)
  })
}
