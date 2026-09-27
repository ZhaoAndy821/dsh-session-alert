#!/usr/bin/env node
/**
 * Build the bundle and publish it into the running DSH hot-plugin directory,
 * then ask the host whether it actually loaded. No dsh web restart, no page
 * refresh: dsh-hot-plugin-host watches the directory and refreshes every open
 * page within about 1.5s.
 *
 * usage:
 *   node scripts/push.mjs                 # build + publish + report host status
 *   node scripts/push.mjs --status        # report host status only
 *   node scripts/push.mjs --rm            # uninstall (delete the hot bundle)
 *   node scripts/push.mjs --port 4115 --dir <hot dir>
 */
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { build, BUNDLE_ID } from './build.mjs'

const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}
const has = (name) => argv.includes(name)

const port = Number(flag('--port', process.env.DSH_PORT || '4115'))
const hotDir = flag('--dir', process.env.DSH_HOT_PLUGINS || join(homedir(), '.dsh', 'hot-plugins'))
const target = join(hotDir, BUNDLE_ID, 'client.js')

/** Ask the host plugin what it currently sees in the hot directory. */
async function hostStatus() {
  try {
    const res = await fetch('http://127.0.0.1:' + port + '/hot-plugins/status', { signal: AbortSignal.timeout(3000) })
    if (!res.ok) return { ok: false, reason: 'HTTP ' + res.status }
    return { ok: true, body: await res.json() }
  } catch (err) {
    return { ok: false, reason: err && err.message ? err.message : String(err) }
  }
}

if (has('--rm')) {
  const dir = dirname(target)
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true })
    console.log('removed ' + dir)
  } else {
    console.log('nothing to remove at ' + dir)
  }
  process.exit(0)
}

if (!has('--status')) {
  const result = build()
  mkdirSync(dirname(target), { recursive: true })
  copyFileSync(result.out, target)
  console.log('pushed ' + result.bytes + ' bytes -> ' + target)
}

const status = await hostStatus()
if (!status.ok) {
  console.log('host status unavailable (' + status.reason + '): is dsh web running on port ' + port + '?')
  process.exit(1)
}
const body = status.body && typeof status.body === 'object' ? status.body : {}
const known = Array.isArray(body.known) ? body.known : []
const errors = body.errors && typeof body.errors === 'object' ? body.errors : {}
const connections = typeof body.connections === 'number' ? body.connections : 0
console.log('host sees: ' + JSON.stringify(body))
if (errors[BUNDLE_ID]) {
  console.error('bundle reported a load error: ' + JSON.stringify(errors[BUNDLE_ID]))
  process.exit(2)
}
if (!known.includes(BUNDLE_ID)) {
  console.log('bundle not listed yet — the host polls the directory; re-run --status in a moment')
  process.exit(0)
}
console.log('bundle ' + BUNDLE_ID + ' is live in ' + connections + ' open page(s)')
