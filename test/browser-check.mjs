#!/usr/bin/env node
/**
 * Browser check: open the running DSH web UI in a headless Chromium and prove
 * the plugin really applied inside a real page - stylesheet injected, sidebar
 * seat occupied, no plugin console/page errors.
 *
 * The DSH web host gates the app behind a signed browser-session cookie. This
 * script mints that cookie locally from the durable signing secret in the
 * profile credentials file (same format the host writes), so no token URL and
 * no running browser window are needed.
 *
 * With --stage it also runs the end-to-end loop: send a tiny prompt in a fresh
 * session, switch the page away from it, wait for the completion banner and
 * sidebar card, then click the card.
 *
 * usage:
 *   node test/browser-check.mjs
 *   node test/browser-check.mjs --stage
 *   node test/browser-check.mjs --url http://127.0.0.1:4115 --headful --no-auth
 */
import assert from 'node:assert/strict'
import { createHash, createHmac } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const argv = process.argv.slice(2)
const has = (name) => argv.includes(name)
const flag = (name, fallback) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}

const PLAYWRIGHT_ROOT =
  process.env.PLAYWRIGHT_ROOT || 'D:/GitHub/dsh-cute-user-fold/node_modules/playwright-core'
const { chromium } = require(PLAYWRIGHT_ROOT)

const url = flag('--url', process.env.DSH_WEB_URL || 'http://127.0.0.1:4115')

/** Newest ms-playwright chromium build, unless CHROMIUM_PATH says otherwise. */
function findChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH
  const root = join(process.env.LOCALAPPDATA || '', 'ms-playwright')
  if (!existsSync(root)) return undefined
  for (const entry of readdirSync(root)) {
    if (!entry.startsWith('chromium-')) continue
    const exe = join(root, entry, 'chrome-win64', 'chrome.exe')
    if (existsSync(exe)) return exe
  }
  return undefined
}

/** base64url without padding - the host's own codec. */
const b64url = (value) =>
  Buffer.from(value).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')

/**
 * Mint the host's browser-session cookie for one authority, byte-for-byte the
 * format dsh-client-connection writes: v1.<base64url payload>.<hmac>.
 */
function mintCookie(authority, secretBase64Url, maxAgeMs) {
  const secret = Buffer.from(secretBase64Url.replaceAll('-', '+').replaceAll('_', '/'), 'base64')
  const now = Date.now()
  const payload = { version: 1, authority, issuedAt: now, expiresAt: now + maxAgeMs }
  const body = b64url(Buffer.from(JSON.stringify(payload), 'utf8'))
  return {
    name: 'dsh-auth-' + b64url(createHash('sha256').update(authority).digest()),
    value: 'v1.' + body + '.' + b64url(createHmac('sha256', secret).update(body).digest())
  }
}

/** Read the durable signing secret out of the profile credentials file. */
function readAuthSecret(credentialsPath) {
  const text = readFileSync(credentialsPath, 'utf8')
  const start = text.indexOf('client-connection/browser-session:')
  if (start < 0) return undefined
  const match = text.slice(start).match(/secret:\s*['"]?([A-Za-z0-9_-]{20,})['"]?/)
  return match ? match[1] : undefined
}

const browser = await chromium.launch({
  executablePath: findChromium(),
  headless: !has('--headful'),
  args: ['--no-sandbox']
})
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })

if (!has('--no-auth')) {
  const credentialsPath = flag('--credentials', join(homedir(), '.dsh', '.credentials.yaml'))
  const secret = existsSync(credentialsPath) ? readAuthSecret(credentialsPath) : undefined
  assert.ok(secret, 'no browser-session secret found in ' + credentialsPath)
  const authority = new URL(url).host
  const cookie = mintCookie(authority, secret, 3600000)
  await context.addCookies([{
    name: cookie.name,
    value: cookie.value,
    url: url,
    httpOnly: true,
    sameSite: 'Strict'
  }])
  console.log('auth: minted a browser-session cookie for ' + authority)
}

const page = await context.newPage()
const consoleErrors = []
const pageErrors = []
page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()) })
page.on('pageerror', (err) => pageErrors.push(String(err)))
const mine = (text) => String(text).includes('dsh-session-alert')

try {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
  // The seat element is zero-sized by design, so wait for attachment, not visibility.
  await page.waitForSelector('style[data-plugin-css="dsh-session-alert/styles.css"]', { state: 'attached', timeout: 30000 })
  await page.waitForSelector('.dsa-anchor', { state: 'attached', timeout: 15000 })

  const facts = await page.evaluate(() => ({
    style: !!document.querySelector('style[data-plugin-css="dsh-session-alert/styles.css"]'),
    anchor: !!document.querySelector('.dsa-anchor'),
    dock: !!document.querySelector('.dsa-dock'),
    // A stack mounted straight into <body> is the failure this guards: a second
    // portal used to leave the dock empty and drop the stack below the app.
    strayStack: !!document.querySelector('body > .dsa-cards'),
    cards: document.querySelectorAll('.dsa-card').length,
    banners: document.querySelectorAll('.dsa-banner').length,
    title: document.title
  }))

  assert.equal(facts.style, true, 'plugin stylesheet missing: apply() did not run')
  assert.equal(facts.anchor, true, 'sidebar.footer.action seat not rendered')
  assert.equal(facts.strayStack, false, 'the card stack was portalled into <body> instead of the sidebar dock')

  // The dock only exists while the sidebar is wide (the rail keeps the fixed
  // placement), so assert it conditionally - and assert it for real, not just
  // collect the flag (review F5).
  const dockState = await page.evaluate(() => {
    const anchor = document.querySelector('.dsa-anchor')
    const footer = anchor ? anchor.closest('[class*="_footArea"]') : null
    return {
      footerWidth: footer ? Math.round(footer.getBoundingClientRect().width) : 0,
      dock: !!document.querySelector('.dsa-dock')
    }
  })
  assert.ok(dockState.footerWidth < 160 || dockState.dock, 'the sidebar is wide but no dock element exists: ' + JSON.stringify(dockState))
  console.log('structure: dock: ' + JSON.stringify(dockState))
  assert.deepEqual(consoleErrors.filter(mine), [], 'plugin logged console errors')
  assert.deepEqual(pageErrors.filter(mine), [], 'plugin threw in the page')
  console.log('structure ok: ' + JSON.stringify(facts))

  if (has('--stage')) await stage(page)
  console.log('\nBROWSER CHECK PASSED')
} catch (err) {
  console.error('\nconsole errors:\n' + consoleErrors.slice(0, 12).join('\n'))
  console.error('page errors:\n' + pageErrors.slice(0, 12).join('\n'))
  throw err
} finally {
  await browser.close()
}

/**
 * End-to-end stage: send a tiny prompt in a fresh session, leave that session
 * (so its completion counts as "outside the main view"), and wait for the
 * plugin's two surfaces.
 */
async function stage(page) {
  const prompt = flag('--prompt', 'dsh-session-alert self-test: reply with OK only')
  const editor = page.locator('[contenteditable="true"]').first()
  await editor.waitFor({ timeout: 20000 })
  await editor.click()
  await page.keyboard.type(prompt)
  await page.keyboard.press('Enter')
  console.log('stage: prompt sent; waiting for the run to start')
  await page.waitForTimeout(5000)

  // Leave the running session: the reminder needs it to stop OUTSIDE the main view.
  // The New Session control is the stable way to switch away.
  const switched = await page.evaluate(() => {
    const nodes = Array.from(document.querySelectorAll('button, [role="button"], [aria-label]'))
    const target = nodes.find((node) => {
      const label = (node.getAttribute('aria-label') || '') + ' ' + (node.textContent || '')
      return /new session|新建会话/i.test(label) && !node.className.includes('dsa')
    })
    if (!target) return null
    target.click()
    return ((target.getAttribute('aria-label') || '') + (target.textContent || '')).trim().slice(0, 60)
  })
  console.log('stage: page switched away from the running session: ' + JSON.stringify(switched))

  await page.waitForSelector('.dsa-banner', { state: 'attached', timeout: 240000 })
  const surface = await page.evaluate(() => ({
    banners: document.querySelectorAll('.dsa-banner').length,
    cards: document.querySelectorAll('.dsa-card').length,
    banner: (document.querySelector('.dsa-banner') || {}).textContent || '',
    card: (document.querySelector('.dsa-card') || {}).textContent || ''
  }))
  assert.ok(surface.banners >= 1, 'no completion banner appeared')
  assert.ok(surface.cards >= 1, 'no sidebar card appeared')

  // "A card exists" cannot catch a stack that fell out of the sidebar: Playwright
  // scrolls it into view either way. Assert where it actually is (review finding,
  // 2026-09-27).
  const docked = await page.evaluate(() => {
    const dock = document.querySelector('.dsa-dock')
    const card = document.querySelector('.dsa-card')
    const anchor = document.querySelector('.dsa-anchor')
    const column = anchor ? anchor.closest('[class*="_root"]') : null
    if (!dock || !card) return { inDock: false, insideColumn: null, reason: !dock ? 'no dock element' : 'no card element' }
    const rect = card.getBoundingClientRect()
    const columnRect = column ? column.getBoundingClientRect() : null
    return {
      inDock: dock.contains(card),
      insideColumn: columnRect === null ? null : (rect.left >= columnRect.left - 2 && rect.right <= columnRect.right + 2),
      left: Math.round(rect.left),
      right: Math.round(rect.right)
    }
  })
  assert.equal(docked.inDock, true, 'the card stack is not inside the sidebar dock: ' + JSON.stringify(docked))
  assert.notEqual(docked.insideColumn, false, 'the card stack overhangs the sidebar column: ' + JSON.stringify(docked))

  // A docked stack must not still be the fixed overlay: that variant is the
  // original defect (a floating card on top of the cost panel) and the one
  // assertion above cannot see it.
  const stackPosition = await page.evaluate(() => {
    const stack = document.querySelector('.dsa-cards')
    return stack ? getComputedStyle(stack).position : null
  })
  assert.equal(stackPosition, 'static', 'the docked stack is still the fixed overlay (position=' + stackPosition + ')')
  console.log('stage: dock placement: ' + JSON.stringify(docked))
  console.log('stage: surfaces appeared: ' + JSON.stringify(surface))

  await page.click('.dsa-card')
  await page.waitForTimeout(3000)
  const after = await page.evaluate(() => ({
    cards: document.querySelectorAll('.dsa-card').length,
    banners: document.querySelectorAll('.dsa-banner').length
  }))
  console.log('stage: after clicking the card: ' + JSON.stringify(after))
}
