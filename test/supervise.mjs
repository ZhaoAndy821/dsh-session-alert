#!/usr/bin/env node
/**
 * Supervisor test.
 *
 * The bridge died once with no trace (03:19) and nothing brought it back, which
 * is the failure this file guards: the decision function, the restart loop driven
 * with fakes, and the real /health probe against a live stub server.
 *
 * Two rules hold for every case below:
 *   - a pid file is always injected under a temp dir, never the real
 *     <runtime>/supervisor.pid, so a supervisor running on this machine cannot
 *     make this file fail spuriously;
 *   - the 'disabled' marker is planted in a throwaway DSH_HOME, so the test also
 *     covers a runtime relocated with DSH_DESKTOP_ALERT_DIR.
 * The last case proves the first rule: it plants a live supervisor pid at the
 * default path of a throwaway DSH_HOME and runs this file again inside it.
 *
 * usage: node test/supervise.mjs
 */
import { spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { anotherSupervisorRunning, decide, probe, runSupervisor } from '../desktop/supervise.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.join(HERE, '..')
const results = []
const ok = (name, pass, detail) => results.push({ name, pass, detail })
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const scratchDirs = []
// Scratch directories are removed on exit as well, so an aborting run cannot leave
// them behind in %TEMP% (measured: they accumulated across review rounds).
process.on('exit', () => {
  for (const dir of scratchDirs) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
  }
})
const tempDir = (prefix) => {
  const dir = mkdtempSync(path.join(tmpdir(), prefix))
  scratchDirs.push(dir)
  return dir
}

/** The path a loop without an injected pidPath would use: the real runtime. */
const defaultPid = path.join(
  process.env.DSH_DESKTOP_ALERT_DIR || path.join(process.env.DSH_HOME || path.join(homedir(), '.dsh'), 'desktop-alert'),
  'supervisor.pid'
)

// --- the decision itself
ok('a healthy bridge is left alone', decide({ healthy: true, sinceLastSpawnMs: 999999 }) === 'idle', decide({ healthy: true, sinceLastSpawnMs: 999999 }))
ok('a dead bridge is restarted once the cooldown passed', decide({ healthy: false, sinceLastSpawnMs: 60000 }) === 'spawn', decide({ healthy: false, sinceLastSpawnMs: 60000 }))
ok('a dead bridge is not restarted inside the cooldown', decide({ healthy: false, sinceLastSpawnMs: 100 }) === 'wait', decide({ healthy: false, sinceLastSpawnMs: 100 }))

// --- the loop, driven with fakes so nothing is spawned
const loopDir = tempDir('dsh-loop-')
const loopPid = path.join(loopDir, 'loop.pid')
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
  rounds: 3,
  pidPath: loopPid
})
ok('the supervisor restarts a missing bridge exactly once', events.filter((e) => e === 'spawn').length === 1, JSON.stringify(events))
ok('it reports the recovery in its log', events.some((e) => String(e).includes('started the bridge (pid 4242)')), JSON.stringify(events))
ok('it notices when the bridge comes back', events.some((e) => String(e).includes('bridge is up on port 41411')), JSON.stringify(events))
ok('it returns the last observed state', healthy === true, String(healthy))
ok('the restart loop publishes its pid under the injected path', existsSync(loopPid) && readFileSync(loopPid, 'utf8').trim() === String(process.pid), loopPid + ' exists=' + existsSync(loopPid))
let realOwner = ''
try { realOwner = readFileSync(defaultPid, 'utf8').trim() } catch { realOwner = '' }
ok('the restart loop never adopts the real runtime pid file', realOwner !== String(process.pid), defaultPid + ' -> ' + JSON.stringify(realOwner))
rmSync(loopDir, { recursive: true, force: true })

// --- F4: the injected retry window must win over the module default
ok('an injected retry window is honoured', decide({ healthy: false, sinceLastSpawnMs: 250, retryMs: 100 }) === 'spawn', decide({ healthy: false, sinceLastSpawnMs: 250, retryMs: 100 }))
ok('and still blocks inside it', decide({ healthy: false, sinceLastSpawnMs: 50, retryMs: 100 }) === 'wait', decide({ healthy: false, sinceLastSpawnMs: 50, retryMs: 100 }))

// --- A2: the startup line must report the retry window the loop really uses
const retryDir = tempDir('dsh-retry-')
const retryLines = []
for (const injected of [0, 250]) {
  await runSupervisor({
    check: async () => 0,
    spawn: () => 0,
    log: (line) => retryLines.push(String(line)),
    sleep: async () => {},
    checkMs: 1,
    retryMs: injected,
    rounds: 1,
    pidPath: path.join(retryDir, 'retry-' + injected + '.pid')
  })
}
ok('the startup line logs the normalised retry window it uses (0 is not swallowed)',
  retryLines.some((line) => line.includes('retry 0ms')) && retryLines.some((line) => line.includes('retry 250ms')),
  JSON.stringify(retryLines))
rmSync(retryDir, { recursive: true, force: true })

// --- F2: ownership lives in the loop, so 'cli supervise' is guarded too
const ownDir = tempDir('dsh-own-')
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

// --- A1: the 'disabled' marker is <DSH_HOME>/desktop-alert.disabled, even when
// DSH_DESKTOP_ALERT_DIR moves the runtime somewhere else.
const markerRoot = tempDir('dsh-marker-')
const markerHome = path.join(markerRoot, 'home')
const markerRuntime = path.join(markerRoot, 'relocated-runtime')
mkdirSync(markerHome, { recursive: true })
const markerFile = path.join(markerHome, 'desktop-alert.disabled')
writeFileSync(markerFile, 'disabled by test\n', 'utf8')
const dummyBridge = path.join(markerRoot, 'dummy-bridge.mjs')
writeFileSync(dummyBridge, 'process.exit(0)\n', 'utf8')

const savedHome = process.env.DSH_HOME
const savedRuntime = process.env.DSH_DESKTOP_ALERT_DIR
process.env.DSH_HOME = markerHome
process.env.DSH_DESKTOP_ALERT_DIR = markerRuntime
let movedSupervise
let movedHost
try {
  const stamp = '?marker=' + process.pid + '-' + Date.now()
  movedSupervise = await import('../desktop/supervise.mjs' + stamp)
  movedHost = await import('../host/index.js' + stamp)
} finally {
  if (savedHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = savedHome
  if (savedRuntime === undefined) delete process.env.DSH_DESKTOP_ALERT_DIR; else process.env.DSH_DESKTOP_ALERT_DIR = savedRuntime
}
const expectedMarker = path.join(markerHome, 'desktop-alert.disabled')
const hostMarker = typeof movedHost.disabledMarker === 'function' ? movedHost.disabledMarker() : '(host half exports no disabledMarker)'
ok('a relocated runtime does not move the disabled marker out of DSH_HOME',
  movedSupervise.disabledMarker() === expectedMarker,
  'supervisor=' + movedSupervise.disabledMarker() + ' expected=' + expectedMarker)
ok('the host half and the supervisor resolve the disabled marker to the same file',
  typeof movedHost.disabledMarker === 'function' && hostMarker === movedSupervise.disabledMarker() && hostMarker === expectedMarker,
  'host=' + hostMarker + ' supervisor=' + movedSupervise.disabledMarker())
const gated = movedSupervise.spawnBridge({ node: process.execPath, script: dummyBridge })
ok('with the marker in DSH_HOME no bridge is started (the runtime is relocated)', gated === 0, 'pid=' + gated)
rmSync(markerFile, { force: true })
const ungated = movedSupervise.spawnBridge({ node: process.execPath, script: dummyBridge })
ok('control: without the marker the same call does start the bridge', ungated > 0, 'pid=' + ungated)
await sleep(150)
rmSync(markerRoot, { recursive: true, force: true })

// --- A1, the writer's side: 'cli install' clears the DSH_HOME marker, so a
// marker next to a relocated runtime is not the one the CLI owns.
const cliRoot = tempDir('dsh-cli-marker-')
const cliHome = path.join(cliRoot, 'home')
const cliRuntime = path.join(cliRoot, 'relocated-runtime')
mkdirSync(cliHome, { recursive: true })
const cliHomeMarker = path.join(cliHome, 'desktop-alert.disabled')
const cliStrayMarker = path.join(cliRoot, 'desktop-alert.disabled')   // dirname(relocated runtime)
writeFileSync(cliHomeMarker, 'disabled\n', 'utf8')
writeFileSync(cliStrayMarker, 'stray marker of the old layout\n', 'utf8')
const installed = spawnSync(process.execPath, [path.join(REPO, 'desktop', 'cli.mjs'), 'install'], {
  env: { ...process.env, DSH_HOME: cliHome, DSH_DESKTOP_ALERT_DIR: cliRuntime },
  encoding: 'utf8',
  windowsHide: true,
  timeout: 30000
})
ok('"cli install" clears the DSH_HOME marker, not one beside a relocated runtime',
  installed.status === 0 && !existsSync(cliHomeMarker) && existsSync(cliStrayMarker),
  'status=' + installed.status + ' dshHomeMarkerGone=' + !existsSync(cliHomeMarker) + ' strayMarkerKept=' + existsSync(cliStrayMarker))
rmSync(cliRoot, { recursive: true, force: true })

// --- A5: the rule at the top of this file, executed. A live supervisor owns the
// default pid path of a throwaway DSH_HOME; this file must still pass there.
if (process.env.DSH_SUPERVISE_NESTED !== '1') {
  const nestedRoot = tempDir('dsh-nested-')
  const nestedHome = path.join(nestedRoot, 'home')
  const nestedRuntime = path.join(nestedHome, 'desktop-alert')
  mkdirSync(nestedRuntime, { recursive: true })
  writeFileSync(path.join(nestedRuntime, 'supervisor.pid'), String(process.pid), 'utf8')
  const nested = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
    env: { ...process.env, DSH_HOME: nestedHome, DSH_DESKTOP_ALERT_DIR: nestedRuntime, DSH_SUPERVISE_NESTED: '1' },
    encoding: 'utf8',
    windowsHide: true,
    timeout: 120000
  })
  const lines = String(nested.stdout || '').split(/\r?\n/).filter(Boolean)
  const summary = lines.length ? lines[lines.length - 1].trim() : ''
  const childFailures = lines.filter((line) => line.includes('FAIL')).join(' | ')
  ok('a live supervisor on the default pid path cannot make this file fail',
    nested.status === 0 && /^\d+\/\d+ checks passed$/.test(summary),
    'status=' + nested.status + ' summary=' + JSON.stringify(summary) + ' failures=' + childFailures.slice(0, 300) + ' stderr=' + String(nested.stderr || '').slice(0, 200))
  rmSync(nestedRoot, { recursive: true, force: true })
}

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
