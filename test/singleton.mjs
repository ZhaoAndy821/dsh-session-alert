#!/usr/bin/env node
/**
 * Singleton test: two bridges started in the same tick must not leave two live
 * services.
 *
 * Independent review F1 (2026-09-27) reproduced the opposite on the pre-fix
 * bridge: the loser's pre-bind /health probe missed the winner, the bind failed
 * with EADDRINUSE, and the old code moved on to the next port - two bridges, two
 * ports, one of them an orphan.
 *
 * Two cases, because they reach different code paths:
 *
 *   1. forced port (--port <p>): the candidate list is one port long, so the
 *      loser's bind fails and it must recognise the winner and exit with
 *      alreadyRunning instead of "no free port among ...".
 *   2. multi-port (3-port list): the shipped default list is remapped to three
 *      free ports and copied into the private runtime dir; both processes run
 *      that copy in the same tick, so the loser hits EADDRINUSE *with a next
 *      port still available* - the exact path F1 was about. Review R2: case 1
 *      alone forced --port and therefore never reached it, so "exactly one
 *      survives" also passed on the pre-fix bridge. Case 2 is repeated over
 *      several rounds because the race is timing dependent: the reviewer
 *      measured the pre-fix bridge leaving two live bridges in 2 of 3 rounds,
 *      i.e. a single round can pass by luck.
 *
 * The live bridge on 127.0.0.1:41411 is never touched: every port is taken from
 * the OS ephemeral range, and the test refuses to run if a shipped default port
 * (41411-41413) is ever handed to it.
 *
 * usage: node test/singleton.mjs
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BRIDGE = path.join(HERE, '..', 'desktop', 'bridge.mjs')
/** The shipped default list; this test must never bind one of these. */
const SHIPPED_PORTS = [41411, 41412, 41413]
/** Rounds of the F1 race; >1 because one round can pass on the pre-fix code. */
const ROUNDS = 4
const runtime = mkdtempSync(path.join(tmpdir(), 'dsh-singleton-'))
const results = []
const ok = (name, pass, detail) => results.push({ name, pass, detail })
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Reserve `count` distinct free loopback ports and release them again. */
async function freePorts(count) {
  const servers = []
  try {
    for (let i = 0; i < count; i += 1) {
      const server = net.createServer()
      servers.push(server)
      await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', resolve)
      })
    }
    return servers.map((server) => server.address().port)
  } finally {
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))))
  }
}

const ports = await freePorts(1 + 3)
const forcedPort = ports[0]
const listPorts = ports.slice(1)
if (new Set(ports).size !== ports.length || ports.some((port) => SHIPPED_PORTS.includes(port))) {
  console.error('refusing to run: the OS handed out a duplicate or a shipped default port: ' + ports.join(', '))
  process.exit(2)
}

/**
 * Write a copy of the shipped bridge whose candidate list is `list`. The copy is
 * byte-identical except for that one line, and the rewrite is verified: if the
 * line ever changes shape, this fails loudly instead of silently running the
 * bridge on 41411-41413 (where the live bridge is).
 */
function bridgeCopyWithPorts(list, file) {
  const source = readFileSync(BRIDGE, 'utf8')
  const line = source.match(/const PORTS = \[[^\]]*\]/u)
  const patchedLine = 'const PORTS = [' + list.join(', ') + ']'
  if (!line) {
    throw new Error('cannot remap the bridge port list in ' + BRIDGE + ': no "const PORTS = [...]" line')
  }
  const patched = source.replace(line[0], patchedLine)
  if (patched === source || !patched.includes(patchedLine) || patched.includes(line[0])) {
    throw new Error('port-list rewrite did not take effect; refusing to start bridges on the shipped ports')
  }
  writeFileSync(file, patched, 'utf8')
  return file
}

function startBridge(script, args) {
  const child = spawn(process.execPath, [script, ...args], {
    env: { ...process.env, DSH_DESKTOP_ALERT_DIR: runtime },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let out = ''
  child.stdout.on('data', (chunk) => { out += String(chunk) })
  child.stderr.on('data', (chunk) => { out += String(chunk) })
  return { child, output: () => out }
}

/** Which of these ports answer as our service right now. */
async function answeringPorts(candidatePorts) {
  const hits = await Promise.all(candidatePorts.map(async (port) => {
    try {
      const response = await fetch('http://127.0.0.1:' + port + '/health', { signal: AbortSignal.timeout(1200) })
      const body = await response.json()
      return body && body.service === 'dsh-desktop-alert' ? port : null
    } catch { return null }
  }))
  return hits.filter((port) => port !== null)
}

async function waitUntilFree(candidatePorts, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const answers = await answeringPorts(candidatePorts)
    if (answers.length === 0) return true
    if (Date.now() > deadline) return false
    await sleep(250)
  }
}

const listeningPort = (item) => {
  const match = item.output().match(/"listening":(\d+)/u)
  return match ? Number(match[1]) : null
}
const isAlive = (item) => item.child.exitCode === null && item.child.signalCode === null
const kill = (item) => { try { item.child.kill() } catch { /* already gone */ } }

//#region case 1 - forced port (--port): one candidate, the loser must explain itself
const first = startBridge(BRIDGE, ['--port', String(forcedPort)])
const second = startBridge(BRIDGE, ['--port', String(forcedPort)])
await sleep(4500)

const alive = [first, second].filter(isAlive)
const dead = [first, second].filter((item) => !isAlive(item))
const forcedHealth = await answeringPorts([forcedPort])
ok('forced port: exactly one of two simultaneous bridges stays alive', alive.length === 1, 'alive=' + alive.length + ' outputs=' + JSON.stringify([first.output(), second.output()]).slice(0, 400))
ok('forced port: exactly one of them exited', dead.length === 1, 'exited=' + dead.length)
ok('forced port: the service answers on the port once', forcedHealth.length === 1 && forcedHealth[0] === forcedPort, JSON.stringify(forcedHealth))
ok('forced port: the loser says why instead of opening a second service', dead.length === 1 && dead[0].output().includes('alreadyRunning'), JSON.stringify(dead.map((item) => item.output())).slice(0, 400))

for (const item of [first, second]) kill(item)
ok('forced port: the service is down once both are stopped', await waitUntilFree([forcedPort], 8000), JSON.stringify(await answeringPorts([forcedPort])))
//#endregion

//#region case 2 - the F1 race: two bridges, a 3-port list, one tick
const raceScript = bridgeCopyWithPorts(listPorts, path.join(runtime, 'bridge-3port.mjs'))
for (let round = 1; round <= ROUNDS; round += 1) {
  const tag = 'multi-port round ' + round + ' of ' + ROUNDS + ': '
  const a = startBridge(raceScript, [])
  const b = startBridge(raceScript, [])
  await sleep(4500)

  const running = [a, b].filter(isAlive)
  const exited = [a, b].filter((item) => !isAlive(item))
  const answered = await answeringPorts(listPorts)
  const reasons = [a, b].filter((item) => item.output().includes('alreadyRunning'))
  const outputs = JSON.stringify([a.output(), b.output()]).slice(0, 500)

  ok(tag + 'exactly one of two simultaneous bridges stays alive', running.length === 1, 'alive=' + running.length + ' ports=' + JSON.stringify(answered) + ' outputs=' + outputs)
  ok(tag + 'exactly one of them exited', exited.length === 1, 'exited=' + exited.length + ' outputs=' + outputs)
  ok(tag + 'the exit reason is alreadyRunning, exactly once', reasons.length === 1 && exited.length === 1 && exited[0].child.exitCode === 0, 'reasons=' + reasons.length + ' exitCode=' + JSON.stringify(exited.map((item) => item.child.exitCode)) + ' outputs=' + outputs)
  ok(tag + 'exactly one of the three ports answers the service', answered.length === 1, 'answering=' + JSON.stringify(answered) + ' outputs=' + outputs)
  const livePort = running.length === 1 ? listeningPort(running[0]) : null
  ok(tag + 'the live bridge is the one answering', running.length === 1 && answered.length === 1 && livePort === answered[0], 'listening=' + livePort + ' answering=' + JSON.stringify(answered) + ' outputs=' + outputs)

  for (const item of [a, b]) kill(item)
  const freed = await waitUntilFree(listPorts, 8000)
  ok(tag + 'all three ports are free again after teardown', freed, JSON.stringify(await answeringPorts(listPorts)))
}
//#endregion

rmSync(runtime, { recursive: true, force: true })

let failed = 0
for (const item of results) {
  if (!item.pass) failed += 1
  console.log((item.pass ? '  ok  ' : '  FAIL ') + item.name + (item.pass ? '' : '  <- ' + item.detail))
}
console.log('')
console.log(results.length - failed + '/' + results.length + ' checks passed')
process.exitCode = failed === 0 ? 0 : 1
