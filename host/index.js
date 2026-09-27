/**
 * dsh-session-alert - host half.
 *
 * The plugin's work happens in two places that are both outside the harness
 * process: the browser half (the client bundle in lib/client.js) decides when a
 * reminder is due, and the desktop half (~/.dsh/desktop-alert, a loopback
 * service) owns the native popup. Nothing host-side is needed - no RPC, no
 * session data, no configuration surface.
 *
 * This file is deliberately empty **but must exist**: the mount row in
 * cordis.patch.yml makes the loader resolve this package's main entry, and a
 * missing entry fails the whole plugin tree at boot. Empty is not optional.
 */

/** Host-side plugin body: intentionally does nothing. */
export function apply() {
  // Intentionally empty: reminders are client-side, the popup is a separate service.
}
