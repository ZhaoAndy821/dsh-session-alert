#!/usr/bin/env node
/**
 * Smoke test: load the built bundle in a VM with stub globals, assert the
 * plugin contract, then exercise the pure projection that decides what to
 * remind about. No browser, no DSH host.
 *
 * usage: node scripts/build.mjs && node test/smoke.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const bundle = readFileSync(resolve(ROOT, 'lib/client.js'), 'utf8')

/** Values come out of the VM realm: compare them as plain data. */
const plain = (value) => JSON.parse(JSON.stringify(value === undefined ? null : value))

let captured = null
const sandbox = {
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  window: { __ModuleLoader__: { load: (mod) => { captured = mod } } }
}
sandbox.globalThis = sandbox
vm.createContext(sandbox)
vm.runInContext(bundle, sandbox)

assert.ok(captured, 'bundle never called window.__ModuleLoader__.load')
assert.equal(captured.id, 'dsh-session-alert', 'bundle id')

const reactStub = {
  Fragment: 'fragment',
  createElement: () => null,
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useLayoutEffect: () => {},
  useRef: () => ({ current: null })
}
const mod = captured.factory((name) => {
  if (name === 'react') return reactStub
  if (name === 'react-dom') return { createPortal: (node) => node }
  throw new Error('unexpected client module: ' + name)
})

assert.equal(typeof mod.apply, 'function', 'apply export')
assert.deepEqual(
  Array.from(mod.inject),
  ['sessions', 'slots', 'locale', 'uiSession', 'uiWorkspace'],
  'inject list'
)

const api = mod.__test
const config = Object.assign({}, api.CONFIG, { debounceMs: 0 })
const T0 = 1000000

const empty = { seeded: false, facts: {}, reminders: {} }
const row = (id, extra) => Object.assign({ id, displayTitle: 'Session ' + id, running: false, blank: false, retainedBy: {} }, extra || {})
const pass = (prev, rows, statuses, jobs, nowMs) => api.planState(prev, {
  rows,
  statuses,
  jobs: jobs || {},
  nowMs: nowMs || T0,
  config
})
const eventsOf = (result) => plain(result.events)

let checks = 0
const check = (label, fn) => { fn(); checks += 1; console.log('  ok  ' + label) }

// ---------------------------------------------------------------- transitions
const rowsA = { a: row('a') }
const idle = { a: { running: true, completionUnread: false } }
const done = { a: { running: false, completionUnread: true } }

check('seeding pass never notifies (no reload storm)', () => {
  const seeded = pass(empty, rowsA, done)
  assert.deepEqual(eventsOf(seeded), [])
  assert.equal(seeded.state.reminders.a.completed, true)
  assert.equal(seeded.state.reminders.a.notified, false)
})

check('run stop outside the main view fires exactly one completion event', () => {
  const s1 = pass(empty, rowsA, idle)
  assert.deepEqual(eventsOf(s1), [])
  assert.equal(s1.state.reminders.a, undefined)
  const s2 = pass(s1.state, rowsA, done)
  assert.deepEqual(eventsOf(s2), [{ type: 'completed', id: 'a' }])
  const s3 = pass(s2.state, rowsA, done)
  assert.deepEqual(eventsOf(s3), [], 'steady state must not repeat')
  s3.state.reminders.a.notified = true
  const s4 = pass(s3.state, rowsA, done)
  assert.equal(s4.state.reminders.a.notified, true, 'notified flag survives passes')
})

check('re-completion after the human opens the session is a fresh episode', () => {
  const s1 = pass(empty, rowsA, idle)
  const s2 = pass(s1.state, rowsA, done)
  s2.state.reminders.a.notified = true
  const cleared = pass(s2.state, rowsA, idle)
  assert.equal(cleared.state.reminders.a, undefined)
  const again = pass(cleared.state, rowsA, done, {}, T0 + 60000)
  assert.deepEqual(eventsOf(again), [{ type: 'completed', id: 'a' }])
  assert.equal(again.state.reminders.a.notified, false)
  assert.equal(again.state.reminders.a.at, T0 + 60000)
})

// ------------------------------------------------------------ waiting states
const askApproval = { a: { running: false, completionUnread: false, pendingInteraction: { kind: 'approval' } } }

check('a session on screen never produces a waiting reminder', () => {
  const onScreen = { a: row('a', { retainedBy: { mainView: 1 } }) }
  const result = pass(empty, onScreen, askApproval)
  assert.equal(result.state.reminders.a, undefined)
})

check('a waiting interaction elsewhere fires once and names its kind', () => {
  const quiet = { a: { running: false, completionUnread: false } }
  const seeded = pass(empty, rowsA, quiet)
  const asked = pass(seeded.state, rowsA, askApproval)
  assert.deepEqual(eventsOf(asked), [{ type: 'waiting', id: 'a', kind: 'approval' }])
  assert.equal(asked.state.reminders.a.waiting, 'approval')
  assert.deepEqual(eventsOf(pass(asked.state, rowsA, askApproval)), [])
})

// ---------------------------------------------------------------- filtering
check('blank rows and subagent rows never produce cards', () => {
  const mixed = {
    a: row('a'),
    child: row('child', { origin: 'subagent', parentId: 'a', running: true }),
    blankRow: row('blankRow', { blank: true })
  }
  const statuses = {
    child: { running: false, completionUnread: true },
    blankRow: { running: false, completionUnread: true },
    a: { running: true, completionUnread: false }
  }
  const result = pass(empty, mixed, statuses)
  assert.deepEqual(plain(Object.keys(result.state.reminders)), [])
})

// -------------------------------------------------------- settle aggregation
const busyRows = { a: row('a'), c1: row('c1', { origin: 'subagent', parentId: 'a', running: true }) }
const calmRows = { a: row('a'), c1: row('c1', { origin: 'subagent', parentId: 'a', running: false }) }
const aDone = { a: { running: false, completionUnread: true } }

check('running subagents hold the completion in "settling"', () => {
  const seeded = pass(empty, busyRows, { a: { running: true, completionUnread: false } })
  const held = pass(seeded.state, busyRows, aDone)
  assert.deepEqual(eventsOf(held), [{ type: 'completed', id: 'a' }])
  assert.equal(held.state.reminders.a.settling, true)
  assert.equal(held.state.reminders.a.children, 1)
  const settled = pass(held.state, calmRows, aDone, {}, T0 + 3000)
  assert.deepEqual(eventsOf(settled), [{ type: 'settled', id: 'a', timedOut: false }])
  assert.equal(settled.state.reminders.a.settling, false)
})

check('live background jobs hold the completion too', () => {
  const live = { a: [{ id: 'bash-1', status: 'running' }] }
  const gone = { a: [{ id: 'bash-1', status: 'completed' }] }
  const held = pass(empty, rowsA, aDone, live)
  assert.equal(held.state.reminders.a.settling, true)
  assert.equal(held.state.reminders.a.jobs, 1)
  const settled = pass(held.state, rowsA, aDone, gone, T0 + 2000)
  assert.deepEqual(eventsOf(settled), [{ type: 'settled', id: 'a', timedOut: false }])
})

check('the settle budget expires into a completion notice', () => {
  const tight = Object.assign({}, config, { settleTimeoutMs: 10000 })
  const first = api.planState(empty, { rows: busyRows, statuses: aDone, jobs: {}, nowMs: 5000000, config: tight })
  assert.equal(first.state.reminders.a.settling, true)
  const expired = api.planState(first.state, {
    rows: busyRows,
    statuses: aDone,
    jobs: {},
    nowMs: 5000000 + 10001,
    config: tight
  })
  assert.deepEqual(eventsOf(expired), [{ type: 'settled', id: 'a', timedOut: true }])
  assert.equal(expired.state.reminders.a.settling, false)
  assert.equal(expired.state.reminders.a.timedOut, true)
})

// ------------------------------------------------------------------ helpers
check('helpers behave', () => {
  const tStub = (key, params) => key + (params && params.count !== undefined ? ':' + params.count : '')
  assert.equal(api.formatRelative(tStub, T0, T0 + 30000), 'time.now')
  assert.equal(api.formatRelative(tStub, T0, T0 + 5 * 60000), 'time.minutes:5')
  assert.equal(api.formatRelative(tStub, T0, T0 + 3 * 3600000), 'time.hours:3')
  assert.equal(api.isJobSettled({ status: 'killed' }), true)
  assert.equal(api.isJobSettled({ status: 'stopping' }), false)
  assert.equal(api.isJobSettled(undefined), true)
  assert.equal(api.reasonKey('plan-review'), 'reason.plan-review')
  assert.equal(api.reasonKey('unknown-domain'), 'reason.interaction')
})

console.log('\n' + checks + ' checks passed')
