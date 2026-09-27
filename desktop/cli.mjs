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
const FILES = ['bridge.mjs', 'present.ps1', 'toast.ps1', 'cli.mjs', 'README.md', 'WORKBUDDY-NOTES.md']

function install() {
  fs.mkdirSync(RUNTIME, { recursive: true })
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
  const entry = path.join(RUNTIME, 'bridge.mjs')
  const target = fs.existsSync(entry) ? entry : path.join(HERE, 'bridge.mjs')
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
    try { console.log(JSON.stringify((await post('/quit', {})).body)) } catch (err) { console.error(String(err.message || err)) }
    break
  }
  case 'status': {
    const live = await health()
    console.log(live ? JSON.stringify(live.body, null, 2) : 'bridge is not running')
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
    try { await post('/quit', {}) } catch { /* it may already be down */ }
    uninstallAutostart()
    if (fs.existsSync(RUNTIME)) { fs.rmSync(RUNTIME, { recursive: true, force: true }); console.log('removed ' + RUNTIME) }
    break
  }
  default:
    console.log('unknown command: ' + command)
    console.log('install | start | stop | status | test | logs | install-autostart | uninstall-autostart | uninstall')
}
