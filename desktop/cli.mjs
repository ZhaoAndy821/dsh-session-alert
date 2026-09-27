#!/usr/bin/env node
/**
 * dsh-desktop-alert CLI - install, run and inspect the desktop alert bridge.
 *
 * usage:
 *   node cli.mjs install             copy this folder into ~/.dsh/desktop-alert
 *   node cli.mjs start               start the bridge in the background
 *   node cli.mjs stop                stop it
 *   node cli.mjs status              ask the running bridge what it sees
 *   node cli.mjs test [--kind K]     raise one card, no DSH page needed
 *   node cli.mjs logs [--lines N]    tail bridge.log
 *   node cli.mjs install-autostart   start the bridge at every logon
 *   node cli.mjs uninstall-autostart remove that logon entry
 *   node cli.mjs uninstall           stop, remove autostart and the runtime copy
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const RUNTIME = process.env.DSH_DESKTOP_ALERT_DIR || path.join(HOME, 'desktop-alert')
const PORTS = [41411, 41412, 41413]
const STARTUP = path.join(os.homedir(), 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup')
const SHORTCUT = path.join(STARTUP, 'DSH Desktop Alert.lnk')
const SUPERVISOR_PID = path.join(RUNTIME, 'supervisor.pid')
// 'uninstall' marks the service disabled here, in DSH_HOME - never beside
// RUNTIME. DSH_DESKTOP_ALERT_DIR can move the runtime, and the host half only
// knows DSH_HOME, so a marker that moved with the runtime would be invisible to
// the process that resurrects the bridge from its shipped copy.
const DISABLED = path.join(HOME, 'desktop-alert.disabled')

/** Stop a supervisor we started, so 'stop' really stops the service. */
function stopSupervisor() {
  if (!fs.existsSync(SUPERVISOR_PID)) return false
  const pid = Number(fs.readFileSync(SUPERVISOR_PID, 'utf8').trim())
  if (!pid) { fs.rmSync(SUPERVISOR_PID, { force: true }); return false }
  try {
    process.kill(pid, 0)                      // throws when the process is gone
    process.kill(pid, 'SIGTERM')
    fs.rmSync(SUPERVISOR_PID, { force: true })
    console.log('stopped the supervisor (pid ' + pid + ')')
    return true
  } catch {
    fs.rmSync(SUPERVISOR_PID, { force: true })  // stale file
    return false
  }
}

/** Is a supervisor alive right now? */
function supervisorAlive() {
  try {
    const pid = Number(fs.readFileSync(SUPERVISOR_PID, 'utf8').trim())
    if (!pid) return 0
    process.kill(pid, 0)
    return pid
  } catch { return 0 }
}
const argv = process.argv.slice(2)
const command = argv[0] || 'status'
const flag = (name, fallback) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}

function powershell(script) {
  const exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const result = spawnSync(fs.existsSync(exe) ? exe : 'powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { encoding: 'utf8', windowsHide: true })
  return { code: result.status, out: (result.stdout || '').trim(), err: (result.stderr || '').trim() }
}

async function health() {
  for (const port of PORTS) {
    try {
      const res = await fetch('http://127.0.0.1:' + port + '/health', { signal: AbortSignal.timeout(1200) })
      const body = await res.json()
      if (body && body.service === 'dsh-desktop-alert') return { port, body }
    } catch { /* not there */ }
  }
  return null
}

async function post(route, payload) {
  const live = await health()
  if (!live) throw new Error('bridge is not running (try: node cli.mjs start)')
  const res = await fetch('http://127.0.0.1:' + live.port + route, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload || {}),
    signal: AbortSignal.timeout(5000)
  })
  return { port: live.port, body: await res.json() }
}

/** Files that make up the installed runtime. */
const FILES = ['bridge.mjs', 'supervise.mjs', 'present.ps1', 'toast.ps1', 'cli.mjs', 'README.md', 'WORKBUDDY-NOTES.md']

function install() {
  fs.mkdirSync(RUNTIME, { recursive: true })
  fs.rmSync(DISABLED, { force: true })
  const copied = []
  for (const name of FILES) {
    const from = path.join(HERE, name)
    if (!fs.existsSync(from)) continue
    fs.copyFileSync(from, path.join(RUNTIME, name))
    copied.push(name)
  }
  console.log('installed into ' + RUNTIME + ': ' + copied.join(', '))
  console.log('bridge:   node "' + path.join(RUNTIME, 'bridge.mjs') + '"')
  console.log('presenter: ' + path.join(RUNTIME, 'present.ps1'))
}

function start() {
  const entry = path.join(RUNTIME, 'bridge.mjs')
  const target = fs.existsSync(entry) ? entry : path.join(HERE, 'bridge.mjs')
  const child = spawn(process.execPath, [target], { detached: true, stdio: 'ignore', windowsHide: true, cwd: path.dirname(target) })
  child.unref()
  return new Promise((resolve) => {
    let tries = 0
    const poll = async () => {
      tries += 1
      const live = await health()
      if (live) { console.log(JSON.stringify(live.body)); resolve(0); return }
      if (tries > 20) { console.error('bridge did not come up; see ' + path.join(RUNTIME, 'bridge.log')); resolve(1); return }
      setTimeout(poll, 250)
    }
    setTimeout(poll, 400)
  })
}

function installAutostart() {
  // The shortcut starts the SUPERVISOR, not the bridge: a bridge that dies (it
  // did once, silently) is then restarted instead of staying dead until logon.
  const supervisor = path.join(RUNTIME, 'supervise.mjs')
  const bridge = path.join(RUNTIME, 'bridge.mjs')
  const target = fs.existsSync(supervisor)
    ? supervisor
    : (fs.existsSync(bridge) ? bridge : path.join(HERE, 'supervise.mjs'))
  fs.mkdirSync(STARTUP, { recursive: true })
  // PowerShell single-quoted literals: double quotes inside a -Command string
  // are parsed by PowerShell itself, so JSON quoting would corrupt the script.
  const ps = (value) => "'" + String(value).replace(/'/g, "''") + "'"
  const script = [
    '$ws = New-Object -ComObject WScript.Shell',
    '$lnk = $ws.CreateShortcut(' + ps(SHORTCUT) + ')',
    '$lnk.TargetPath = ' + ps(process.execPath),
    '$lnk.Arguments = ' + ps('"' + target + '"'),
    '$lnk.WorkingDirectory = ' + ps(path.dirname(target)),
    '$lnk.WindowStyle = 7',
    '$lnk.Description = ' + ps('DSH desktop alert bridge'),
    '$lnk.Save()',
    '$check = $ws.CreateShortcut(' + ps(SHORTCUT) + ')',
    '"target=" + $check.TargetPath',
    '"args=" + $check.Arguments'
  ].join('; ')
  const result = powershell(script)
  console.log(result.out || result.err || 'no output')
  console.log('autostart shortcut: ' + SHORTCUT)
}

function uninstallAutostart() {
  if (fs.existsSync(SHORTCUT)) { fs.rmSync(SHORTCUT, { force: true }); console.log('removed ' + SHORTCUT) }
  else console.log('no autostart shortcut at ' + SHORTCUT)
}

function tail(lines) {
  const file = path.join(RUNTIME, 'bridge.log')
  if (!fs.existsSync(file)) { console.log('no log at ' + file); return }
  const all = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)
  console.log(all.slice(-lines).join('\n'))
}

switch (command) {
  case 'install': install(); break
  case 'start': process.exit(await start()); break
  case 'stop': {
    stopSupervisor()
    try { console.log(JSON.stringify((await post('/quit', {})).body)) } catch (err) { console.error(String(err.message || err)) }
    break
  }
  case 'supervise': {
    // Foreground loop: keeps the bridge alive and logs every start decision.
    const { runSupervisor, probe: probeBridge, spawnBridge } = await import('./supervise.mjs')
    await runSupervisor({
      check: () => probeBridge(),
      spawn: () => spawnBridge(),
      checkMs: Number(flag('--check-ms', '30000')) || 30000
    })
    break
  }
  case 'status': {
    const live = await health()
    console.log(live ? JSON.stringify(live.body, null, 2) : 'bridge is not running')
    const pid = supervisorAlive()
    console.log(pid ? 'supervisor: alive (pid ' + pid + ')' : 'supervisor: not running (a crash would not self-heal)')
    if (fs.existsSync(SUPERVISOR_PID) && !pid) console.log('note: stale ' + SUPERVISOR_PID)
    break
  }
  case 'test': {
    const kind = flag('--kind', 'completed')
    try {
      const result = await post('/notify', {
        kind,
        title: kind === 'waiting' ? 'DSH - session needs you' : 'DSH - session finished',
        body: 'dsh-desktop-alert self test',
        hint: 'Click to open the session',
        sessionId: flag('--session', ''),
        url: flag('--url', ''),
        windowTitle: flag('--window-title', ''),
        durationMs: 9000,
        surface: flag('--surface', undefined)
      })
      console.log(JSON.stringify(result.body))
    } catch (err) { console.error(String(err.message || err)) }
    break
  }
  case 'logs': tail(Number(flag('--lines', '30')) || 30); break
  case 'install-autostart': installAutostart(); break
  case 'uninstall-autostart': uninstallAutostart(); break
  case 'uninstall': {
    stopSupervisor()
    try { await post('/quit', {}) } catch { /* it may already be down */ }
    uninstallAutostart()
    // The host half ships its own bridge copy, so deleting the runtime alone
    // would let the next 5-minute check bring the service back.
    fs.writeFileSync(DISABLED, 'Removed by "cli.mjs uninstall". Delete this file (or run "cli.mjs install") to re-enable desktop alerts.\n', 'utf8')
    console.log('wrote ' + DISABLED)
    if (fs.existsSync(RUNTIME)) { fs.rmSync(RUNTIME, { recursive: true, force: true }); console.log('removed ' + RUNTIME) }
    break
  }
  default:
    console.log('unknown command: ' + command)
    console.log('install | start | stop | supervise | status | test | logs | install-autostart | uninstall-autostart | uninstall')
}
