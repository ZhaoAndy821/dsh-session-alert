#!/usr/bin/env node
/**
 * Integration test for the dsh-desktop-alert bridge.
 *
 * Starts a private bridge instance (its own port and runtime dir), then drives
 * the real HTTP surface:
 *   /health            -> service identity, counters, surface
 *   POST /notify       -> a real card process is spawned and counted
 *   GET  /events       -> Server-Sent Events stream stays open for pages
 *   POST /click        -> "open-session" is pushed to that stream
 *   POST /quit         -> clean shutdown
 *
 * The card window really appears for a moment; that is the point of the test.
 *
 * usage: node test/bridge.mjs
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BRIDGE = path.join(HERE, '..', 'desktop', 'bridge.mjs')
const PORT = 41499
const runtime = mkdtempSync(path.join(tmpdir(), 'dsh-alert-test-'))
const results = []
const ok = (name, pass, detail) => results.push({ name, pass, detail })

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(predicate, timeoutMs, stepMs = 100) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return true
    await sleep(stepMs)
  }
  return false
}

const health = async () => {
  try {
    const res = await fetch('http://127.0.0.1:' + PORT + '/health', { signal: AbortSignal.timeout(1500) })
    const body = await res.json()
    return body && body.service === 'dsh-desktop-alert' ? body : null
  } catch { return null }
}

const child = spawn(process.execPath, [BRIDGE, '--port', String(PORT)], {
  env: { ...process.env, DSH_DESKTOP_ALERT_DIR: runtime },
  stdio: ['ignore', 'ignore', 'pipe']
})
let bridgeErr = ''
child.stderr.on('data', (chunk) => { bridgeErr += String(chunk) })

try {
  const up = await waitFor(async () => (await health()) !== null, 8000)
  ok('bridge starts and answers /health', up, bridgeErr.slice(0, 300))
  const identity = await health()
  ok('health reports the service identity and the card surface', Boolean(identity) && identity.surface === 'card' && identity.maxCards >= 1, JSON.stringify(identity))

  // page side: keep one SSE stream open, collect the frames
  const frames = []
  const stream = await fetch('http://127.0.0.1:' + PORT + '/events', { headers: { origin: 'http://127.0.0.1:4115' } })
  ok('GET /events answers as text/event-stream', String(stream.headers.get('content-type')).includes('text/event-stream'), String(stream.headers.get('content-type')))
  ok('the stream is CORS-readable from the DSH origin', stream.headers.get('access-control-allow-origin') === 'http://127.0.0.1:4115', String(stream.headers.get('access-control-allow-origin')))
  const reader = stream.body.getReader()
  const pump = (async () => {
    const decoder = new TextDecoder()
    for (;;) {
      const { value, done } = await reader.read()
      if (done) return
      frames.push(decoder.decode(value))
    }
  })()

  const counted = await waitFor(async () => { const h = await health(); return h && h.pages === 1 }, 4000)
  ok('the bridge counts the connected page', counted, JSON.stringify(await health()))

  // a dry run must not spawn anything
  const dry = await (await fetch('http://127.0.0.1:' + PORT + '/notify', {
    method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:4115' },
    body: JSON.stringify({ kind: 'completed', title: 'dry', sessionId: 's-dry', dryRun: true })
  })).json()
  ok('dryRun reports the surfaces without showing a card', dry.ok === true && dry.dryRun === true && Array.isArray(dry.surfaces), JSON.stringify(dry))
  const afterDry = await health()
  ok('dryRun spawned no card process', afterDry.cards === 0, JSON.stringify(afterDry))

  // a real notification: the presenter process must appear and be counted
  const shown = await (await fetch('http://127.0.0.1:' + PORT + '/notify', {
    method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:4115' },
    body: JSON.stringify({ kind: 'waiting', title: 'bridge test', body: 'integration', hint: 'click', sessionId: 's-live', durationMs: 4000 })
  })).json()
  ok('POST /notify accepts a card request', shown.ok === true && shown.slot === 0, JSON.stringify(shown))

  // The raw log must be safe on its own - only --redact used to save it. A review
  // found a malformed body echoing its title verbatim: the snippet is printed
  // verbatim, so the body's own quote closed a naive character class early and
  // everything after it survived.
  // The marker is short on purpose: V8 echoes a bounded snippet of the body, and a
  // marker outside that snippet is truncated, which makes the check pass even
  // against the leaky bridge (a review measured exactly that).
  const marker = 'AB12XY'
  const hostileBody = '[\uFEFF"' + marker + '"]'
  // Self-guard derived from V8 itself rather than from a guessed offset or length:
  // the echoed snippet is the only channel that could carry the marker into the raw
  // log, so if JSON.parse does not echo the marker this check cannot fail and must
  // not pass silently. Measured rule on Node 24: a body of at most 20 characters is
  // echoed whole; a longer body echoes the window [token - 10, token + 10), with
  // "..." marking whichever side was actually cut - which only looks like a prefix
  // here because this body puts the offending token at index 1. An offset-only
  // threshold misses a long marker.
  {
    let echoed = ''
    try {
      JSON.parse(hostileBody)
    } catch (error) {
      echoed = String((error && error.message) || '')
    }
    if (!echoed.includes(marker)) {
      console.error('raw-log check would be vacuous: JSON.parse did not echo the marker ' + marker + ' from ' + JSON.stringify(hostileBody) + ' (message: ' + echoed + ')')
      process.exit(1)
    }
  }
  await fetch('http://127.0.0.1:' + PORT + '/notify', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:4115' },
    body: hostileBody
  }).catch(() => { /* 400 is the expected answer */ })
  await sleep(400)
  const rawLog = readFileSync(path.join(runtime, 'bridge.log'), 'utf8')
  const failedLine = rawLog.split('\n').filter((line) => line.includes('request failed')).slice(-1)[0] || 'no request-failed line'
  // The <redacted> clause is a positive control: without it, a bridge that stopped
  // logging the parse error at all would leave this assertion passing while the
  // redactor it is meant to exercise never runs.
  ok('a malformed request body does not survive in the raw bridge log', failedLine.includes('request failed') && failedLine.includes('<redacted>') && !rawLog.includes(marker), failedLine)
  const cardUp = await waitFor(async () => { const h = await health(); return h && h.cards === 1 }, 6000)
  ok('the native card process is running', cardUp, JSON.stringify(await health()))

  // the card click callback
  const click = await (await fetch('http://127.0.0.1:' + PORT + '/click', {
    method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:4115' },
    body: JSON.stringify({ sessionId: 's-live', url: 'http://127.0.0.1:4115/' })
  })).json()
  ok('a click is delivered to the connected page', click.opened === true, JSON.stringify(click))
  const pushed = await waitFor(() => Promise.resolve(frames.join('').includes('open-session')), 3000)
  ok('the page receives an open-session frame', pushed, frames.join('').slice(-200))
  ok('the frame names the clicked session', frames.join('').includes('s-live'), frames.join('').slice(-200))

  // a failure gets the red surface without the caller spelling out glyph/accent
  const failedKind = await (await fetch('http://127.0.0.1:' + PORT + '/notify', {
    method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:4115' },
    body: JSON.stringify({ kind: 'failed', title: 'boom', sessionId: 's-fail', dryRun: true })
  })).json()
  ok('a failed notification gets the red card defaults', failedKind.ok === true && failedKind.payload.accent === '#FFEF4444' && failedKind.payload.glyph === '✕', JSON.stringify(failedKind.payload))

  // card + toast for one reminder: the card is lifted clear of the toast area
  const both = await (await fetch('http://127.0.0.1:' + PORT + '/notify', {
    method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:4115' },
    body: JSON.stringify({ kind: 'waiting', title: 'needs you', sessionId: 's-both', surface: 'both', dryRun: true })
  })).json()
  ok('card+toast lifts the card above the toast area', both.ok === true && both.payload.yOffset === 140 && both.surfaces.length === 2, JSON.stringify(both.payload.yOffset) + ' / ' + JSON.stringify(both.surfaces))
  const cardOnly = await (await fetch('http://127.0.0.1:' + PORT + '/notify', {
    method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:4115' },
    body: JSON.stringify({ kind: 'completed', title: 'done', sessionId: 's-cardonly', surface: 'card', dryRun: true })
  })).json()
  ok('a card-only reminder is not lifted', cardOnly.ok === true && cardOnly.payload.yOffset === undefined, JSON.stringify(cardOnly.payload.yOffset))

  // a completion that follows a failure for the same session is suppressed
  const afterFailure = await (await fetch('http://127.0.0.1:' + PORT + '/notify', {
    method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:4115' },
    body: JSON.stringify({ kind: 'completed', title: 'done after failing', sessionId: 's-fail', dryRun: true })
  })).json()
  ok('a completion right after a failure is suppressed', afterFailure.ok === true && afterFailure.suppressed === 'after-failure', JSON.stringify(afterFailure))
  const otherSession = await (await fetch('http://127.0.0.1:' + PORT + '/notify', {
    method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:4115' },
    body: JSON.stringify({ kind: 'completed', title: 'unrelated', sessionId: 's-other', dryRun: true })
  })).json()
  ok('another session still gets its completion card', otherSession.ok === true && otherSession.dryRun === true, JSON.stringify(otherSession))

  // a UTF-8 BOM in the body must not silently drop a notification
  const bomResponse = await fetch('http://127.0.0.1:' + PORT + '/notify', {
    method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:4115' },
    body: '﻿' + JSON.stringify({ kind: 'completed', title: 'bom', sessionId: 's-bom', dryRun: true })
  })
  const bom = await bomResponse.json()
  ok('a body with a UTF-8 BOM is still parsed', bomResponse.status === 200 && bom.ok === true && bom.dryRun === true, JSON.stringify(bom))

  // Action Center cleanup: one stable, session-scoped toast tag
  const dismissOne = await (await fetch('http://127.0.0.1:' + PORT + '/dismiss', {
    method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:4115' },
    body: JSON.stringify({ sessionId: 'session-11111111-1111-4111-8111-111111111111' })
  })).json()
  const dismissTwo = await (await fetch('http://127.0.0.1:' + PORT + '/dismiss', {
    method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:4115' },
    body: JSON.stringify({ sessionId: 'session-22222222-2222-4222-8222-222222222222' })
  })).json()
  ok('POST /dismiss answers with a session-scoped toast tag', dismissOne.ok === true && String(dismissOne.tag).startsWith('dsh') && String(dismissOne.tag).length <= 16, JSON.stringify(dismissOne))
  ok('two sessions never share a toast tag', dismissOne.tag !== dismissTwo.tag, dismissOne.tag + ' vs ' + dismissTwo.tag)

  // notification history is a diagnostics surface, not part of the default API
  const hiddenRecent = await fetch('http://127.0.0.1:' + PORT + '/recent', { headers: { origin: 'http://127.0.0.1:4115' } })
  ok('GET /recent is hidden unless the bridge runs with --verbose', hiddenRecent.status === 404, String(hiddenRecent.status))

  // A gate needs both directions: without this, a route that always answered 404
  // would pass the suite (review X3).
  const verbosePort = 41498
  const verboseRuntime = mkdtempSync(path.join(tmpdir(), 'dsh-alert-verbose-'))
  const verboseChild = spawn(process.execPath, [BRIDGE, '--port', String(verbosePort), '--verbose'], {
    env: { ...process.env, DSH_DESKTOP_ALERT_DIR: verboseRuntime },
    stdio: 'ignore'
  })
  let verboseUp = false
  for (let attempt = 0; attempt < 40 && !verboseUp; attempt += 1) {
    try {
      const res = await fetch('http://127.0.0.1:' + verbosePort + '/health', { signal: AbortSignal.timeout(1000) })
      const body = await res.json()
      verboseUp = Boolean(body && body.service === 'dsh-desktop-alert')
    } catch { /* not up yet */ }
    if (!verboseUp) await sleep(150)
  }
  const servedRecent = verboseUp ? await fetch('http://127.0.0.1:' + verbosePort + '/recent') : null
  ok('a --verbose bridge serves /recent (200)', servedRecent !== null && servedRecent.status === 200, servedRecent ? String(servedRecent.status) : 'the verbose bridge did not start')
  try { verboseChild.kill() } catch { /* ignore */ }
  rmSync(verboseRuntime, { recursive: true, force: true })

  // foreign origins are refused
  const foreign = await fetch('http://127.0.0.1:' + PORT + '/notify', {
    method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
    body: JSON.stringify({ title: 'nope' })
  })
  ok('a non-localhost origin is rejected', foreign.status === 403, String(foreign.status))

  await fetch('http://127.0.0.1:' + PORT + '/quit', { method: 'POST' })
  const stopped = await waitFor(async () => (await health()) === null, 5000)
  ok('POST /quit stops the service', stopped, bridgeErr.slice(0, 200))
  reader.cancel().catch(() => {})
  await pump.catch(() => {})
} finally {
  try { child.kill() } catch { /* ignore */ }
  await sleep(300)
  try { rmSync(runtime, { recursive: true, force: true }) } catch { /* ignore */ }
}

let failed = 0
for (const item of results) {
  if (!item.pass) failed += 1
  console.log((item.pass ? '  ok  ' : '  FAIL ') + item.name + (item.pass ? '' : '  <- ' + item.detail))
}
console.log('')
console.log(results.length - failed + '/' + results.length + ' checks passed')
process.exit(failed === 0 ? 0 : 1)
