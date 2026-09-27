#!/usr/bin/env node
/**
 * Register this plugin as a DSH profile bundle.
 *
 * Why: the web GUI's plugin panel lists the profile's bundles and dependencies.
 * A bundle served by dsh-hot-plugin-host is invisible there by design - it is a
 * runtime mount, not an installed package. This script performs the three edits
 * the official path performs
 *
 *   dsh plugin --profile web add link:<this repo>
 *
 * without running pnpm: dependency spec, bundle stack entry, node_modules link.
 * Nothing takes effect until the web server restarts, and nothing is written
 * outside the profile directory.
 *
 * usage:
 *   node scripts/install-profile.mjs                 # register into profile "web"
 *   node scripts/install-profile.mjs --dry-run       # print the plan only
 *   node scripts/install-profile.mjs --profile web   # pick another profile
 *   node scripts/install-profile.mjs --remove        # undo all three edits
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const NAME = PKG.name
const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}
const has = (name) => argv.includes(name)

const home = process.env.DSH_HOME || join(homedir(), '.dsh')
const profile = flag('--profile', 'web')
const profileDir = join(home, 'profiles', profile)
const manifestPath = join(profileDir, 'package.json')
const linkPath = join(profileDir, 'node_modules', NAME)
const remove = has('--remove')
const dryRun = has('--dry-run')

if (!existsSync(manifestPath)) {
  console.error('no profile manifest at ' + manifestPath)
  process.exit(2)
}

const spec = 'link:' + ROOT.replace(/\\/g, '/')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
manifest.dependencies = manifest.dependencies || {}
manifest.dsh = manifest.dsh || {}
manifest.dsh.profile = manifest.dsh.profile || {}
const bundles = Array.isArray(manifest.dsh.profile.bundles) ? manifest.dsh.profile.bundles.slice() : []

const changes = []
if (remove) {
  if (manifest.dependencies[NAME]) changes.push('remove dependency ' + NAME)
  if (bundles.includes(NAME)) changes.push('remove "' + NAME + '" from dsh.profile.bundles')
  if (existsSync(linkPath) || isLink(linkPath)) changes.push('remove node_modules link')
} else {
  if (manifest.dependencies[NAME] !== spec) changes.push('dependency ' + NAME + ' -> ' + spec)
  if (!bundles.includes(NAME)) changes.push('append "' + NAME + '" to dsh.profile.bundles')
  if (!(existsSync(linkPath) || isLink(linkPath))) changes.push('create node_modules link -> ' + ROOT)
}

function isLink(path) {
  try { return lstatSync(path).isSymbolicLink() } catch { return false }
}

console.log((dryRun ? '[dry-run] ' : '') + (remove ? 'unregister ' : 'register ') + NAME + ' in profile "' + profile + '"')
console.log('  profile: ' + profileDir)
for (const change of changes) console.log('  - ' + change)
if (changes.length === 0) console.log('  (already in the desired state)')
if (dryRun) process.exit(0)

if (remove) {
  delete manifest.dependencies[NAME]
  manifest.dsh.profile.bundles = bundles.filter((entry) => entry !== NAME)
  if (isLink(linkPath)) rmSync(linkPath, { force: true })
  else if (existsSync(linkPath)) rmSync(linkPath, { recursive: true, force: true })
} else {
  manifest.dependencies[NAME] = spec
  manifest.dsh.profile.bundles = bundles.includes(NAME) ? bundles : bundles.concat([NAME])
  if (!(existsSync(linkPath) || isLink(linkPath))) {
    mkdirSync(dirname(linkPath), { recursive: true })
    symlinkSync(ROOT, linkPath, 'junction')
  }
}

writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
JSON.parse(readFileSync(manifestPath, 'utf8'))   // fail loudly rather than leave a broken profile
console.log('  written: ' + manifestPath)

if (remove) {
  console.log('')
  console.log('The bundle is unregistered. Restart the web server to unload it;')
  console.log('until then the running instance keeps its copy of the plugin.')
} else {
  console.log('')
  console.log('Next:')
  console.log('  1. node scripts/build.mjs          # make sure lib/client.js exists (it is not committed)')
  console.log('  2. node scripts/push.mjs --rm      # drop the hot copy, so the bundle is not mounted twice')
  console.log('  3. restart the web server          # e.g. stop and re-run: dsh web')
  console.log('')
  console.log('Rollback: node scripts/install-profile.mjs --remove && node scripts/push.mjs')
}
