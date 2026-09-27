# dsh-desktop-alert — desktop notifications for the DSH web UI

Turns "the session finished while you were looking at something else" into a
reminder that appears **over the whole desktop**, not just inside the browser
tab, and jumps back to that session when you click it.

This is the desktop half of `dsh-session-alert`: the client bundle decides
*when* a reminder is due, this service decides *how* it reaches the desktop.

## Why it exists (what was learned from Z-Code WorkBuddy)

WorkBuddy raises its task-completion reminders from its **Electron main
process**, not from the web page:

| WorkBuddy (`resources/app.asar` → `main/index.js`) | here |
| --- | --- |
| `showTaskNotification()` calls `new electron.Notification({ title, body, silent: true })` from the host process | `bridge.mjs` spawns a native presenter process; the page never draws the popup |
| returns early while `mainWindow.isFocused()` — no popup when the user is already looking at the app | the plugin only posts while `document.visibilityState !== "visible"` or the page has no focus (`desktopAlertWhen: "unfocused"`) |
| keeps a strong reference to the live `Notification` (`activeTaskNotifications`) so its `click` handler survives GC | the bridge owns each presenter process and frees its slot when it exits |
| `on("click")` → `windowManager.handleOpenUrl("workbuddy://chat/{id}")` → focuses the window and opens that session | click → `POST /click` → the bridge pushes `open-session` over SSE → the open tab calls `uiWorkspace.openSession(id)`; the presenter also promotes the browser window; if no tab is connected it opens the page URL |
| two kinds: `showTaskCompletedNotification` / `showTaskPendingNotification` | two kinds: `completed` / `waiting` |

The difference is packaging: WorkBuddy owns an installed app identity, so it can
use an Electron toast. A web page cannot spawn a process, and Windows will not
attribute a toast to a page. So the browser half talks to a small loopback
service, and that service owns both native surfaces.

## Architecture

```
  DSH page (client plugin)                 bridge (node, loopback only)          desktop
  ------------------------                 ---------------------------           -------
  probe GET /health   --------------->  adopt the port
  GET  /events (SSE)  <---------------  keep the page stream open
  POST /notify        --------------->  -- spawn --> present.ps1  --> always-on-top card
                                        -- spawn --> toast.ps1    --> Windows toast
  uiWorkspace.openSession(id) <--------  POST /click  <-- card click
  POST /ack           --------------->  evidence in bridge.log
```

- The bridge listens on `127.0.0.1:41411` (falls back to 41412/41413) and refuses
  any request whose `Origin` is not a localhost origin. No remote access, no
  credentials, nothing written outside `~/.dsh/desktop-alert`.
- One presenter process per card, up to `--max-cards` (default 3) slots; the
  oldest card is recycled when all slots are busy.
- The card is a WPF window: `Topmost`, `ShowActivated=False` (it never steals
  focus), bottom-right of the work area, fades in, auto-closes after
  `durationMs` (9 s default), pauses while hovered, closes on the close glyph.

![The always-on-top card](../docs/images/desktop-alert-card.png)

_The card as it actually renders: no taskbar entry, no focus steal, and a click
jumps the open DSH tab to that session._

## Install

```powershell
git clone https://github.com/ZhaoAndy821/dsh-session-alert.git
cd dsh-session-alert
node desktop/cli.mjs install              # copy into ~/.dsh/desktop-alert
node desktop/cli.mjs start                # start the bridge in the background
node desktop/cli.mjs install-autostart    # optional: start it at every logon
```

The client half is the plugin bundle in the parent repo:

```powershell
node scripts/build.mjs && node scripts/push.mjs
```

Both halves are needed: without the bridge the plugin still gives the in-page
cards/banners (and reports the offline line in the sidebar), without the plugin
nothing ever asks the bridge for a card.

## CLI

| command | what it does |
| --- | --- |
| `node cli.mjs install` | copy `bridge.mjs`, `present.ps1`, `toast.ps1`, `cli.mjs` into `~/.dsh/desktop-alert` |
| `node cli.mjs start` / `stop` / `status` | background lifecycle; `status` prints the live `/health` JSON and whether a supervisor is alive |
| `node cli.mjs supervise` | run the supervisor loop in the foreground (`supervise.mjs`: probes `/health` every 30 s and restarts a dead bridge). The autostart shortcut points here |
| `node cli.mjs test [--kind waiting] [--surface toast]` | raise one card or toast without any DSH page |
| `node cli.mjs logs [--lines 40]` | tail `~/.dsh/desktop-alert/bridge.log` |
| `node cli.mjs install-autostart` / `uninstall-autostart` | Startup-folder shortcut (`DSH Desktop Alert.lnk`, window style 7) |
| `node cli.mjs uninstall` | stop, remove autostart, delete the runtime copy **and write `~/.dsh/desktop-alert.disabled`** — without that marker the host half would respawn the bridge from its own shipped copy within 5 minutes. `cli install` removes the marker |

## Surfaces

`surface` is per notification and defaults to the bridge setting
(`--surface card`):

- `card` (default) — the clickable always-on-top popup. A click jumps the open
  DSH tab to that session; if no tab is connected (page closed, bridge
  restarted) it opens the page URL instead.
- `toast` — a real Windows toast under the AppUserModelID
  `com.deepseek.dsh`, so it is attributed to **DeepSeek Harness** with the app
  icon and stays in the Action Center. A script toast cannot carry an activation
  callback, so a toast click does not jump.
- `both` — both of the above. The card is then lifted by 140 DIP (`yOffset`) so the toast cannot cover the only clickable surface, and the plugin calls `POST /dismiss` once the waiting interaction is answered, so the Action Center does not keep a stale entry.

Set it per notification from the plugin (`CONFIG.desktopAlertSurface` in
`src/client/index.js`), or pass `--surface` to `cli.mjs test`.

## HTTP surface (loopback only)

| route | purpose |
| --- | --- |
| `GET /health` | `{ ok, service, version, port, pages, cards, maxCards, surface, uptimeMs }` |
| `GET /events` | SSE stream; sends `hello` on connect and `open-session` on a card click |
| `POST /notify` | `{ kind, title, body, hint, sessionId, url, windowTitle, theme, durationMs, surface, dryRun }` |
| `POST /click` | called by the card; answers `{ opened }` (`opened:false` means no page is connected, so the card falls back to the URL) |
| `POST /ack` | the page confirming it executed the jump (recorded in the log) |
| `POST /dismiss` | `{ sessionId }` - remove that session's Action Center toast (`dsh` + 13 chars tag); called when a waiting interaction is answered |
| `GET /recent` | the last 50 notifications |
| `POST /quit` | clean shutdown |

## Tests

```powershell
node test/desktop-alert.mjs   # 16 checks: bundle runs, probe, completion/waiting -> /notify, click -> openSession + /ack
node test/bridge.mjs          # 22 checks: real bridge on a private port, SSE, card spawn, click fan-out, origin guard, failure surface
node test/host.mjs            # 9 checks: api-session/error -> bridge, rate limit, a context without events
node test/supervise.mjs       # 17 checks: restart decision, loop with fakes, real probe, single-instance guard
node test/singleton.mjs       # 5 checks: two bridges started at once, exactly one survives (F1 regression)
node test/smoke.mjs           # 10 checks: the pure reminder projection (unchanged)
```

## Limits and troubleshooting

- **Windows only.** `present.ps1` / `toast.ps1` are WPF/WinRT; the bridge
  itself is portable but has no presenter elsewhere.
- Windows PowerShell 5.1 is required by both presenters (pwsh 7 cannot project
  the WinRT toast types); both scripts are ASCII-only on purpose, because 5.1
  reads BOM-less files as ANSI — localized text travels in the UTF-8 payload
  JSON instead.
- **The card does not appear**: `node cli.mjs status` (is it running?),
  `node cli.mjs test` (does the card show at all?), then `node cli.mjs logs`
  — every card, click and error is logged.
- **The bridge runs but `pages` is 0**: the page is not running the new
  bundle. The hot-plugin host refreshes in place, and that refresh can silently
  leave the old implementation running; reload the DSH tab once.
- **A click opened a second browser window instead of jumping**: that is the
  no-page fallback (`opened:false`). It happens when the bridge was restarted
  while the page stayed open — the page re-probes within
  `desktopAlertRetryMs` (30 s), or reload it.
- `DSH_ALERT_DEBUG=<path>` makes the presenter append a stage log (payload
  parsed, xaml parsed, content rendered, closed).
- `DSH_HOME` / `DSH_DESKTOP_ALERT_DIR` relocate the runtime directory;
  `--port` and `--max-cards` change the bridge defaults.

## Uninstall

```powershell
node desktop/cli.mjs uninstall     # bridge stopped, autostart removed, ~/.dsh/desktop-alert deleted
node scripts/push.mjs --rm         # and/or remove the client bundle
```
