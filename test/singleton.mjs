#!/usr/bin/env node
/**
 * Singleton test: two bridges started at the same moment must not leave two
 * live services.
 *
 * Independent review F1 (2026-09-27) reproduced the opposite: the loser's
 * pre-bind /health probe missed the winner, the bind failed with EADDRINUSE, and
 * the old code moved on to the next port - two bridges, two ports, one of them
 * an orphan. This test starts two processes in the same tick on a private port
 * and asserts exactly one survives.
 *
 * usage: node test/singleton.mjs
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BRIDGE = path.join(HERE, '..', 'desktop', 'bridge.mjs')
const PORT = 41471
const runtime = mkdtempSync(path.join(tmpdir(), 'dsh-singleton-'))
const results = []
const ok = (name, pass, detail) => results.push({ name, pass, detail })
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function startBridge() {
  const child = spawn(process.execPath, [BRIDGE, '--port', String(PORT)], {
    env: { ...process.env, DSH_DESKTOP_ALERT_DIR: runtime },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let out = ''
  child.stdout.on('data', (chunk) => { out += String(chunk) })
  child.stderr.on('data', (chunk) => { out += String(chunk) })
  return { child, output: () => out }
}

async function healthAnswers() {
  try {
    const response = await fetch('http://127.0.0.1:' + PORT + '/health', { signal: AbortSignal.timeout(1200) })
    const body = await response.json()
    return body && body.service === 'dsh-desktop-alert' ? body : null
  } catch { return null }
}

const first = startBridge()
const second = startBridge()
await sleep(4500)

const alive = [first, second].filter((item) => item.child.exitCode === null && item.child.signalCode === null)
const dead = [first, second].filter((item) => !alive.includes(item))
const health = await healthAnswers()

ok('exactly one of two simultaneous bridges stays alive', alive.length === 1, 'alive=' + alive.length + ' outputs=' + JSON.stringify([first.output(), second.output()]).slice(0, 400))
ok('exactly one of them exited', dead.length === 1, 'exited=' + dead.length)
ok('the service answers on the port once', health !== null && health.port === PORT, JSON.stringify(health))
ok('the loser says why instead of opening a second service', dead.length === 1 && dead[0].output().includes('alreadyRunning'), JSON.stringify(dead.map((d) => d.output()).join('|')).slice(0, 400))

for (const item of [first, second]) { try { item.child.kill() } catch { /* ignore */ } }
await sleep(500)
const after = await healthAnswers()
ok('the service is down once both are stopped', after === null, JSON.stringify(after))
rmSync(runtime, { recursive: true, force: true })

let failed = 0
for (const item of results) {
  if (!item.pass) failed += 1
  console.log((item.pass ? '  ok  ' : '  FAIL ') + item.name + (item.pass ? '' : '  <- ' + item.detail))
}
console.log('')
console.log(results.length - failed + '/' + results.length + ' checks passed')
process.exitCode = failed === 0 ? 0 : 1
