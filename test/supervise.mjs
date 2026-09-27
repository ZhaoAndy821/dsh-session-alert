#!/usr/bin/env node
/**
 * Supervisor test.
 *
 * The bridge died once with no trace (03:19) and nothing brought it back, which
 * is the failure this file guards: the decision function, the restart loop driven
 * with fakes, and the real /health probe against a live stub server.
 *
 * usage: node test/supervise.mjs
 */
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { anotherSupervisorRunning, decide, probe, runSupervisor } from '../desktop/supervise.mjs'

const results = []
const ok = (name, pass, detail) => results.push({ name, pass, detail })

// --- the decision itself
ok('a healthy bridge is left alone', decide({ healthy: true, sinceLastSpawnMs: 999999 }) === 'idle', decide({ healthy: true, sinceLastSpawnMs: 999999 }))
ok('a dead bridge is restarted once the cooldown passed', decide({ healthy: false, sinceLastSpawnMs: 60000 }) === 'spawn', decide({ healthy: false, sinceLastSpawnMs: 60000 }))
ok('a dead bridge is not restarted inside the cooldown', decide({ healthy: false, sinceLastSpawnMs: 100 }) === 'wait', decide({ healthy: false, sinceLastSpawnMs: 100 }))

// --- the loop, driven with fakes so nothing is spawned
const events = []
const checks = [0, 0, 41411]
let checkIndex = 0
const healthy = await runSupervisor({
  check: async () => checks[Math.min(checkIndex++, checks.length - 1)],
  spawn: () => { events.push('spawn'); return 4242 },
  log: (line) => events.push(line),
  sleep: async () => {},
  checkMs: 1,
  retryMs: 15000,
  rounds: 3
})
ok('the supervisor restarts a missing bridge exactly once', events.filter((e) => e === 'spawn').length === 1, JSON.stringify(events))
ok('it reports the recovery in its log', events.some((e) => String(e).includes('started the bridge (pid 4242)')), JSON.stringify(events))
ok('it notices when the bridge comes back', events.some((e) => String(e).includes('bridge is up on port 41411')), JSON.stringify(events))
ok('it returns the last observed state', healthy === true, String(healthy))

// --- F4: the injected retry window must win over the module default
ok('an injected retry window is honoured', decide({ healthy: false, sinceLastSpawnMs: 250, retryMs: 100 }) === 'spawn', decide({ healthy: false, sinceLastSpawnMs: 250, retryMs: 100 }))
ok('and still blocks inside it', decide({ healthy: false, sinceLastSpawnMs: 50, retryMs: 100 }) === 'wait', decide({ healthy: false, sinceLastSpawnMs: 50, retryMs: 100 }))

// --- F2: ownership lives in the loop, so 'cli supervise' is guarded too
const ownDir = mkdtempSync(path.join(tmpdir(), 'dsh-own-'))
const ownPid = path.join(ownDir, 'supervisor.pid')
const owned = await runSupervisor({ check: async () => 41411, spawn: () => 0, log: () => {}, sleep: async () => {}, rounds: 1, pidPath: ownPid })
ok('the loop publishes its own pid file', owned === true && existsSync(ownPid) && readFileSync(ownPid, 'utf8').trim() === String(process.pid), String(existsSync(ownPid)))
const foreignPid = path.join(ownDir, 'foreign.pid')
writeFileSync(foreignPid, String(process.ppid), 'utf8')
const refusal = []
const refused = await runSupervisor({ check: async () => 41411, spawn: () => 0, log: (line) => refusal.push(line), sleep: async () => {}, rounds: 1, pidPath: foreignPid })
ok('a live foreign supervisor makes the loop refuse to run', refused === false && refusal.some((line) => String(line).includes('another supervisor is already running')), JSON.stringify(refusal))
rmSync(ownDir, { recursive: true, force: true })

// --- the real probe against a stub that does and does not identify itself
const good = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ ok: true, service: 'dsh-desktop-alert' }))
})
const impostor = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ ok: true, service: 'something-else' }))
})
await new Promise((resolve) => good.listen(41501, '127.0.0.1', resolve))
await new Promise((resolve) => impostor.listen(41502, '127.0.0.1', resolve))
const found = await probe([41500, 41501])
ok('the probe finds our service on the first answering port', found === 41501, String(found))
const foreign = await probe([41502])
ok('a foreign service on the port is not adopted', foreign === 0, String(foreign))
const none = await probe([41503])
ok('a silent port reports nothing', none === 0, String(none))
await new Promise((resolve) => good.close(resolve))
await new Promise((resolve) => impostor.close(resolve))

// --- one supervisor per machine: a second one would race the first
const dir = mkdtempSync(path.join(tmpdir(), 'dsh-supervise-'))
const selfPid = path.join(dir, 'self.pid')
writeFileSync(selfPid, String(process.pid), 'utf8')
ok('our own pid file is not "another supervisor"', (await anotherSupervisorRunning(selfPid)) === 0, String(await anotherSupervisorRunning(selfPid)))
const deadPid = path.join(dir, 'dead.pid')
writeFileSync(deadPid, '999999', 'utf8')
ok('a stale pid file is not "another supervisor"', (await anotherSupervisorRunning(deadPid)) === 0, String(await anotherSupervisorRunning(deadPid)))
ok('no pid file at all reads as none running', (await anotherSupervisorRunning(path.join(dir, 'missing.pid'))) === 0)
rmSync(dir, { recursive: true, force: true })

let failed = 0
for (const item of results) {
  if (!item.pass) failed += 1
  console.log((item.pass ? '  ok  ' : '  FAIL ') + item.name + (item.pass ? '' : '  <- ' + item.detail))
}
console.log('')
console.log(results.length - failed + '/' + results.length + ' checks passed')
// Set the code instead of calling process.exit: an abrupt exit races libuv's
// handle teardown on Windows and prints an assertion that looks like a failure.
process.exitCode = failed === 0 ? 0 : 1
