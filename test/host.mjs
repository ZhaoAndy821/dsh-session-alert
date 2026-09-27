#!/usr/bin/env node
/**
 * Host-half test: api-session/error -> loopback desktop bridge.
 *
 * The host half exists for the one failure the browser cannot see ("one Agent
 * failed outside a durable turn position"). This test drives it with a stubbed
 * cordis context and a stubbed fetch: probe order, payload shape, message
 * hygiene, per-session rate limiting, and a context without an event bus.
 *
 * usage: node test/host.mjs
 */
import { apply } from '../host/index.js'

const results = []
const ok = (name, pass, detail) => results.push({ name, pass, detail })

const calls = []
globalThis.fetch = async (url, init) => {
  const target = String(url)
  const entry = { url: target, method: (init && init.method) || 'GET', body: null }
  if (init && init.body) { try { entry.body = JSON.parse(init.body) } catch { entry.body = init.body } }
  calls.push(entry)
  if (target.endsWith('/health')) {
    if (target.includes('41411')) throw new Error('ECONNREFUSED')   // exercises the probe order
    return { ok: true, status: 200, json: async () => ({ ok: true, service: 'dsh-desktop-alert', port: 41412 }) }
  }
  return { ok: true, status: 200, json: async () => ({ ok: true, slot: 0 }) }
}
const notifyCalls = () => calls.filter((call) => call.url.endsWith('/notify'))

const handlers = new Map()
apply({ on: (name, handler) => handlers.set(name, handler) })
ok('host half subscribes to api-session/error', handlers.has('api-session/error'), [...handlers.keys()].join(', '))

handlers.get('api-session/error')('session-abc', 'fetch failed: ECONNRESET   while\nposting')
await new Promise((resolve) => setTimeout(resolve, 300))
ok('a failure is forwarded to the bridge', notifyCalls().length === 1, calls.map((c) => c.method + ' ' + c.url).join(' | '))
ok('the card carries the failed kind and the session id', notifyCalls()[0] && notifyCalls()[0].body.kind === 'failed' && notifyCalls()[0].body.sessionId === 'session-abc', JSON.stringify(notifyCalls()[0] && notifyCalls()[0].body))
ok('the failure text is collapsed and bounded', notifyCalls()[0] && notifyCalls()[0].body.body === 'fetch failed: ECONNRESET while posting', JSON.stringify(notifyCalls()[0] && notifyCalls()[0].body.body))
ok('the probe skips the dead port', calls.some((c) => c.url.includes('41411')) && calls.some((c) => c.url.includes('41412')), calls.map((c) => c.url).join(' | '))

handlers.get('api-session/error')('session-abc', 'the same link flaps again')
await new Promise((resolve) => setTimeout(resolve, 200))
ok('a flapping failure is rate-limited per session', notifyCalls().length === 1, String(notifyCalls().length))

handlers.get('api-session/error')('session-other', 'another session fails')
await new Promise((resolve) => setTimeout(resolve, 300))
ok('a different session is not suppressed', notifyCalls().length === 2, String(notifyCalls().length))

handlers.get('api-session/error')('session-empty', '   ')
await new Promise((resolve) => setTimeout(resolve, 150))
ok('an empty message raises nothing', notifyCalls().length === 2, String(notifyCalls().length))

try {
  apply({})
  ok('a context without an event bus does not throw', true)
} catch (error) {
  ok('a context without an event bus does not throw', false, String(error))
}

let failed = 0
for (const item of results) {
  if (!item.pass) failed += 1
  console.log((item.pass ? '  ok  ' : '  FAIL ') + item.name + (item.pass ? '' : '  <- ' + item.detail))
}
console.log('')
console.log(results.length - failed + '/' + results.length + ' checks passed')
process.exit(failed === 0 ? 0 : 1)
