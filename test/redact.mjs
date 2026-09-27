#!/usr/bin/env node
/**
 * Redactor test.
 *
 * The functional review of 499705c found that 'logs --redact' still printed a
 * full session title: the bridge logged its deduplication key
 * (kind:sessionId:title) verbatim, a shape no prefix rule matches. The leak is
 * fixed at the source, and this file is the check the original change was missing
 * altogether - every shape below is copied from what the bridge and the host
 * really write.
 *
 * usage: node test/redact.mjs
 */
import { redactLine } from '../desktop/redact.mjs'

const results = []
const ok = (name, pass, detail) => results.push({ name, pass, detail })

// Synthetic values only: a real session id or title here would publish which
// sessions this machine ran, and a redactor test needs nothing but a shape.
const ID = 'session-00000000-0000-4000-8000-000000000001'
const UUID = '00000000-0000-4000-8000-000000000001'
const TITLE = 'example session title'

/** A redacted line must keep the diagnostic fields and lose the identifying ones. */
function check(name, line, keeps, drops) {
  const out = redactLine(line)
  const keptOk = keeps.every((token) => out.includes(token))
  const droppedOk = drops.every((token) => !out.includes(token))
  ok(name, keptOk && droppedOk, JSON.stringify(out))
}

check('a card line keeps the kind and loses id and title',
  '2026-09-27T07:36:57Z card shown slot=0 kind=completed session=' + ID + ' title=' + TITLE,
  ['kind=completed', 'slot=0', 'session=<redacted>', 'title=<redacted>'], [UUID, TITLE, ID])

check('a closed card loses the id',
  'card closed slot=0 code=0 session=' + ID, ['code=0', 'session=<redacted>'], [UUID, ID])

check('a click line keeps pages and loses the id',
  'card click session=' + ID + ' pages=1 delivered=true', ['pages=1', 'delivered=true', 'session=<redacted>'], [UUID, ID])

check('a toast line loses the id',
  'toast shown kind=waiting session=' + ID, ['kind=waiting', 'session=<redacted>'], [UUID, ID])

check('an ack line loses the id',
  'page ack open session=' + ID, ['page ack open', 'session=<redacted>'], [UUID, ID])

check('the historical deduplication key is masked (the defect the review found)',
  'deduplicated repeat notify completed:' + ID + ':' + TITLE,
  ['deduplicated repeat notify', '<redacted>'], [UUID, TITLE, ID])

check('a request-failure line does not echo the body',
  'request failed /notify: Unexpected token \'x\', "{\\"kind\\":\\"' + TITLE + '\\"}" is not valid JSON',
  ['request failed /notify'], [TITLE])

check('a bare uuid is masked',
  'session failure for ' + UUID, ['<id>'], [UUID])

check('a failure line keeps the kind and drops the id',
  'card shown slot=1 kind=failed session=' + ID + ' title=' + TITLE,
  ['kind=failed', 'session=<redacted>', 'title=<redacted>'], [UUID, TITLE])

// The tightening that came from the same review: prose must survive.
const prose = 'a session finished outside the main view'
ok('english prose is not mangled', redactLine(prose).includes('session finished'), JSON.stringify(redactLine(prose)))

let failed = 0
for (const item of results) {
  if (!item.pass) failed += 1
  console.log((item.pass ? '  ok  ' : '  FAIL ') + item.name + (item.pass ? '' : '  <- ' + item.detail))
}
console.log('')
console.log(results.length - failed + '/' + results.length + ' checks passed')
process.exitCode = failed === 0 ? 0 : 1
