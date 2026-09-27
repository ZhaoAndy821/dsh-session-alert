#!/usr/bin/env node
/**
 * Bundle-level test for the desktop alert half of dsh-session-alert.
 *
 * Loads lib/client.js in a sandbox with a stubbed client environment, drives the
 * store through one real "session finished outside the main view" transition and
 * asserts the whole desktop path:
 *   probe /health  ->  EventSource /events  ->  POST /notify on completion
 *   SSE "open-session"  ->  uiWorkspace.openSession + POST /ack
 *
 * usage: node test/desktop-alert.mjs
 */
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const code = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const results = []
const ok = (name, pass, detail) => results.push({ name, pass, detail })

function until(predicate, timeoutMs, stepMs = 50) {
  return new Promise((resolve) => {
    const started = Date.now()
    const tick = () => {
      let value = false
      try { value = predicate() } catch { value = false }
      if (value) return resolve(true)
      if (Date.now() - started > timeoutMs) return resolve(false)
      setTimeout(tick, stepMs)
    }
    tick()
  })
}

// ---------------------------------------------------------------- environment
const state = { requests: [], notifications: [], acks: [], opened: [], sources: [], focused: false }
let listSubscribers = []
let statusSubscribers = []
let rows = {}
let statuses = {}

class FakeEventSource {
  constructor(url) { this.url = url; this.handlers = {}; this.closed = false; state.sources.push(this) }
  addEventListener(name, fn) { (this.handlers[name] = this.handlers[name] || []).push(fn) }
  close() { this.closed = true }
  emit(name, data) { for (const fn of this.handlers[name] || []) fn({ data: JSON.stringify(data) }) }
}

async function fakeFetch(url, options) {
  const target = String(url)
  state.requests.push({ url: target, method: (options && options.method) || 'GET' })
  if (target.endsWith('/health')) return { ok: true, status: 200, json: async () => ({ ok: true, service: 'dsh-desktop-alert', port: 41411 }) }
  if (target.endsWith('/notify')) { state.notifications.push(JSON.parse(options.body)); return { ok: true, status: 200, json: async () => ({ ok: true, slot: 0 }) } }
  if (target.endsWith('/ack')) { state.acks.push(JSON.parse(options.body)); return { ok: true, status: 200, json: async () => ({ ok: true }) } }
  return { ok: false, status: 404, json: async () => ({}) }
}

const react = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
  Fragment: 'Fragment',
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useLayoutEffect: () => {},
  useRef: () => ({ current: null })
}

const documentStub = {
  head: { appendChild: () => {} },
  body: {},
  title: 'DSH desktop alert test',
  visibilityState: 'hidden',
  hasFocus: () => false,
  createElement: () => ({ dataset: {}, style: {}, textContent: '' }),
  querySelector: () => null,
  addEventListener: () => {}
}

const sandbox = {
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  Promise,
  JSON,
  Date,
  Math,
  Object,
  Array,
  String,
  Number,
  Boolean,
  Error,
  Set,
  Map,
  AbortSignal,
  fetch: fakeFetch,
  EventSource: FakeEventSource,
  document: documentStub,
  location: { href: 'http://127.0.0.1:4115/?token=test' },
  navigator: { userAgent: 'node' },
  window: {
    __ModuleLoader__: { load: (registration) => { sandbox.__registration = registration } },
    matchMedia: () => ({ matches: true }),
    focus: () => { state.focused = true },
    innerHeight: 900,
    addEventListener: () => {},
    removeEventListener: () => {}
  }
}
sandbox.globalThis = sandbox
sandbox.window.document = documentStub
sandbox.window.location = sandbox.location
vm.createContext(sandbox)

// --------------------------------------------------------------------- run it
vm.runInContext(code, sandbox, { filename: 'client.js' })
const registration = sandbox.__registration
ok('bundle registers itself with the module loader', Boolean(registration && registration.id === 'dsh-session-alert'), registration && registration.id)

const disposers = []
const ctx = {
  effect: (fn) => { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose); return () => {} },
  get: () => undefined,
  locale: { bind: () => (key, vars) => key + (vars ? ' ' + JSON.stringify(vars) : ''), register: () => () => {} },
  slots: { inject: () => () => {}, register: () => 'entry' },
  loader: {},
  sessions: {
    list: {
      getSnapshot: () => ({ byId: rows }),
      subscribe: (fn) => { listSubscribers.push(fn); return () => { listSubscribers = listSubscribers.filter((f) => f !== fn) } }
    }
  },
  uiSession: {
    sessionStatus: {
      getSnapshot: () => statuses,
      subscribe: (fn) => { statusSubscribers.push(fn); return () => { statusSubscribers = statusSubscribers.filter((f) => f !== fn) } }
    }
  },
  uiWorkspace: { openSession: (id) => state.opened.push(String(id)) }
}

const mod = registration.factory((id) => {
  if (id === 'react') return react
  if (id === 'react-dom') return { createPortal: (node) => node }
  throw new Error('unexpected require: ' + id)
})
ok('factory exposes apply/inject', typeof mod.apply === 'function' && Array.isArray(mod.inject), JSON.stringify(mod.inject))
mod.apply(ctx)

const connected = await until(() => state.sources.length > 0, 4000)
ok('plugin probes the bridge and opens an EventSource', connected, state.requests.map((r) => r.method + ' ' + r.url).join(', '))
ok('probe asked /health before subscribing', state.requests.some((r) => r.url.endsWith('/health')), JSON.stringify(state.requests))

// one real completion: the session stops while it is not the main view
rows = { s1: { displayTitle: 'Fix sidebar', running: true, origin: 'main', parentId: null, retainedBy: { mainView: false }, blank: false } }
statuses = { s1: { running: true } }
for (const fn of listSubscribers.slice()) fn()
for (const fn of statusSubscribers.slice()) fn()
await until(() => false, 300)

rows = { s1: { displayTitle: 'Fix sidebar', running: false, origin: 'main', parentId: null, retainedBy: { mainView: false }, blank: false } }
statuses = { s1: { running: false, completionUnread: true } }
for (const fn of listSubscribers.slice()) fn()
for (const fn of statusSubscribers.slice()) fn()

const notified = await until(() => state.notifications.length > 0, 12000)
ok('a finished session posts a desktop card to the bridge', notified, JSON.stringify(state.notifications))
const card = state.notifications[0] || {}
ok('card carries the completion kind and the session id', card.kind === 'completed' && card.sessionId === 's1', JSON.stringify(card))
ok('card carries the page url and title for the click fallback', String(card.url).includes('127.0.0.1:4115') && typeof card.windowTitle === 'string', card.url + ' | ' + card.windowTitle)
ok('card text is the localized completion notice', typeof card.title === 'string' && card.title.length > 0 && String(card.body).includes('Fix sidebar'), card.title + ' / ' + card.body)

// the card was clicked: the bridge pushes "open-session" down the stream
state.sources[0].emit('open-session', { type: 'open-session', sessionId: 's1', at: Date.now() })
const jumped = await until(() => state.opened.length > 0, 2000)
ok('a card click jumps this page to the session', jumped, JSON.stringify(state.opened))
ok('the jump is acknowledged to the bridge', state.acks.length > 0 && state.acks[0].sessionId === 's1', JSON.stringify(state.acks))

// teardown must close the stream
for (const dispose of disposers) { try { dispose() } catch { /* ignore */ } }
ok('teardown closes the EventSource', state.sources.every((source) => source.closed === true), state.sources.map((s) => s.closed).join(','))

// ------------------------------------------------------------------- report it
let failed = 0
for (const item of results) {
  if (!item.pass) failed += 1
  console.log((item.pass ? '  ok  ' : '  FAIL ') + item.name + (item.pass || item.detail === undefined ? '' : '  <- ' + item.detail))
}
console.log('')
console.log(results.length - failed + '/' + results.length + ' checks passed')
process.exit(failed === 0 ? 0 : 1)
