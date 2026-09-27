/**
 * Log-line redaction for the desktop bridge log.
 *
 * Lives apart from cli.mjs because cli.mjs is a command dispatcher: importing it
 * would execute a command. The shapes below are the ones the bridge and the host
 * really write - see every log() call in desktop/bridge.mjs, and the historical
 * composite line ('deduplicated repeat notify <kind>:<sessionId>:<title>') that
 * older rotated logs still contain.
 *
 * Rule of thumb: keep the diagnostic fields (kind, slot, code, pages, port), drop
 * everything that names a session or quotes request content.
 */

/** @param line - one raw log line. @returns the same line with identifying parts masked. */
export function redactLine(line) {
  return redactTrailingEcho(String(line)
    .replace(/session=[A-Za-z0-9-]{8,}/g, 'session=<redacted>')
    .replace(/session [0-9a-f][0-9a-f-]{6,}/gi, 'session <redacted>')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>')
    .replace(/title=.*$/i, 'title=<redacted>')
    .replace(/notify ([a-z]+):[^:\s]+:.*$/i, 'notify $1:<redacted>')
    // Quoted runs, escaped quotes included: JSON.parse echoes the offending body
    // with inner quotes escaped, and a naive [^"]* stops at the first of them.
    .replace(/"(\\.|[^"\\])*"/g, '"<redacted>"'))
}

/**
 * A truncated body echo can leave an unpaired quote behind (V8 prints a bounded
 * snippet). Keep the route, drop everything from the first quote on.
 * @param line - a line already passed through {@link redactLine}'s rules.
 */
export function redactTrailingEcho(line) {
  const text = String(line)
  if (!/request failed/i.test(text)) return text
  const quote = text.indexOf('"')
  return quote === -1 ? text : text.slice(0, quote) + '"<redacted>"'
}
