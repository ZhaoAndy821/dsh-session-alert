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
import { mkdtempSync, rmSync } from 'node:fs'
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
