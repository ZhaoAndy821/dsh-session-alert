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
 */
const BRIDGE_PORTS = [41411, 41412, 41413]
const RATE_LIMIT_MS = 60 * 1000
const BODY_LIMIT = 180

/** Session id -> wall-clock ms of the last card we raised for it. */
const lastSentAt = new Map()
let resolvedPort = 0

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
