#!/usr/bin/env node
/**
 * dsh-desktop-alert supervisor.
 *
 * Why: the bridge process died once with no trace (03:19, no exit record, stale
 * pid file) and nothing brought it back - the logon shortcut starts it exactly
 * once per session. A notification daemon that can silently disappear is worse
 * than none, because the page only shows "not running" after the fact.
 *
 * This is a foreground loop that probes the bridge's /health and restarts it
 * when it is gone. The autostart shortcut points here instead of at the bridge,
 * so a crash costs at most one check interval.
 *
 * The decision itself is a pure function (see decide) so the test can drive it.
 *
 * usage: node supervise.mjs [--check-ms 30000] [--quiet]
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const RUNTIME = process.env.DSH_DESKTOP_ALERT_DIR || path.join(HOME, 'desktop-alert')
const LOG = path.join(RUNTIME, 'supervisor.log')
const PORTS = [41411, 41412, 41413]

const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}
const CHECK_MS = Math.max(5000, Number(flag('--check-ms', '30000')) || 30000)
const RETRY_MS = Math.max(3000, Number(flag('--retry-ms', '15000')) || 15000)
const QUIET = argv.includes('--quiet')

/** Append one line to supervisor.log, rotating once past 256 KB. */
function log(message) {
  const line = new Date().toISOString() + ' ' + message + '\n'
  if (!QUIET) process.stdout.write(line)
  try {
    const stat = fs.statSync(LOG, { throwIfNoEntry: false })
    if (stat && stat.size > 256 * 1024) fs.renameSync(LOG, LOG + '.1')
  } catch { /* rotation is best effort */ }
  try {
    fs.mkdirSync(RUNTIME, { recursive: true })
    fs.appendFileSync(LOG, line)
  } catch { /* logging must never break supervision */ }
}

/**
 * Pure decision for one check.
 * @param state - { healthy, sinceLastSpawnMs, sinceLastLogMs }
 * @returns "idle" | "wait" | "spawn"
 */
export function decide(state) {
  if (state.healthy) return 'idle'
  const retryMs = state.retryMs === undefined ? RETRY_MS : state.retryMs
  if (state.sinceLastSpawnMs < retryMs) return 'wait'
  return 'spawn'
}

/** One /health probe across the candidate ports; returns the port or 0. */
export async function probe(ports = PORTS) {
  for (const port of ports) {
    try {
      const response = await fetch('http://127.0.0.1:' + port + '/health', {
        cache: 'no-store',
        signal: AbortSignal.timeout(1500)
      })
      const body = await response.json()
      if (body && body.service === 'dsh-desktop-alert') return port
    } catch { /* nothing on this port */ }
  }
  return 0
}

/** The marker 'cli uninstall' leaves behind, so nothing respawns a removed service. */
export function disabledMarker() {
  return path.join(path.dirname(RUNTIME), 'desktop-alert.disabled')
}

/** Start the bridge detached; returns the pid or 0. */
export function spawnBridge(options = {}) {
  if (fs.existsSync(options.marker || disabledMarker())) {
    log('desktop alerts are disabled (' + (options.marker || disabledMarker()) + ') - not starting the bridge')
    return 0
  }
  const script = options.script || (fs.existsSync(path.join(RUNTIME, 'bridge.mjs'))
    ? path.join(RUNTIME, 'bridge.mjs')
    : path.join(HERE, 'bridge.mjs'))
  try {
    const child = spawn(options.node || process.execPath, [script], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      cwd: path.dirname(script)
    })
    // An 'error' event without a listener is an uncaught exception, not a
    // silent failure; the caller documents this path as never throwing.
    child.on('error', (error) => log('bridge process error: ' + (error && error.message ? error.message : String(error))))
    child.unref()
    return child.pid || 0
  } catch (error) {
    log('could not start the bridge: ' + (error && error.message ? error.message : String(error)))
    return 0
  }
}

/**
 * Drive the loop with injected dependencies, so tests can run it without
 * spawning anything.
 * @param deps - { probe, spawnBridge, log, sleep, checkMs, retryMs, rounds }
 */
/**
 * Take ownership of the singleton slot: refuse to run beside another supervisor,
 * otherwise write the pid file and clean it up on every way out.
 * @returns true when this process owns the slot.
 */
export async function acquireOwnership(pidPath, emit) {
  const running = await anotherSupervisorRunning(pidPath)
  if (running) {
    emit('another supervisor is already running (pid ' + running + ') - exiting')
    return false
  }
  try {
    fs.mkdirSync(path.dirname(pidPath), { recursive: true })
    fs.writeFileSync(pidPath, String(process.pid), 'utf8')
  } catch { /* the pid file is a convenience, not a requirement */ }
  const cleanUp = () => { try { fs.rmSync(pidPath, { force: true }) } catch { /* ignore */ } }
  process.on('exit', cleanUp)
  process.on('SIGTERM', () => { cleanUp(); process.exit(0) })
  process.on('SIGINT', () => { cleanUp(); process.exit(0) })
  return true
}

export async function runSupervisor(deps) {
  // Ownership lives HERE, not in main(): 'cli supervise' calls this function
  // directly, and a supervisor started that way used to be invisible to
  // 'cli stop' (and unguarded against a second one).
  const pidPath = deps.pidPath || path.join(RUNTIME, 'supervisor.pid')
  const emitEarly = deps.log || log
  if (deps.guard !== false && !(await acquireOwnership(pidPath, emitEarly))) return false
  const check = deps.check
  const start = deps.spawn
  const emit = deps.log || log
  const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  const rounds = deps.rounds === undefined ? Infinity : deps.rounds
  let lastSpawnAt = 0
  let lastHealthy = false
  emit('supervisor started (check ' + (deps.checkMs || CHECK_MS) + 'ms, retry ' + (deps.retryMs || RETRY_MS) + 'ms)')
  for (let round = 0; round < rounds; round += 1) {
    const port = await check()
    const healthy = port !== 0
    if (healthy !== lastHealthy) emit(healthy ? 'bridge is up on port ' + port : 'bridge is not answering')
    lastHealthy = healthy
    const action = decide({
      healthy,
      sinceLastSpawnMs: Date.now() - lastSpawnAt,
      retryMs: deps.retryMs === undefined ? RETRY_MS : deps.retryMs
    })
    if (action === 'spawn') {
      lastSpawnAt = Date.now()
      const pid = start()
      emit(pid ? 'started the bridge (pid ' + pid + ')' : 'bridge start failed')
    }
    if (round + 1 < rounds) await sleep(deps.checkMs || CHECK_MS)
  }
  return lastHealthy
}

/** Read supervisor.pid and say whether that process is alive (and not us). */
export async function anotherSupervisorRunning(pidPath = path.join(RUNTIME, 'supervisor.pid')) {
  try {
    const pid = Number(fs.readFileSync(pidPath, 'utf8').trim())
    if (!pid || pid === process.pid) return 0
    process.kill(pid, 0)                 // throws when the process is gone
    return pid
  } catch { return 0 }
}

async function main() {
  // The guard and the pid file are handled by runSupervisor.
  await runSupervisor({
    check: () => probe(),
    spawn: () => spawnBridge(),
    log,
    checkMs: CHECK_MS,
    retryMs: RETRY_MS
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    log('supervisor crashed: ' + (error && error.stack ? error.stack : String(error)))
    process.exit(1)
  })
}
