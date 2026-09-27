# What Z-Code WorkBuddy does (interoperability notes)

These notes record how the Z-Code WorkBuddy desktop app raises its
task-completion reminders, so the behaviour could be reproduced here. They were
taken from a local installation by parsing the app's Electron `resources/app.asar`
index and extracting only the relevant entries from the main-process bundle
(`main/index.js`). No application code is redistributed: the short excerpts
below are the minimum needed to document the behaviour, and the extract itself
was deleted after these notes were written.

## The mechanism

Two call sites, both inside `createElectronDesktopHost(windowManager)`:

```js
showTaskCompletedNotification(notification) {
  return showTaskNotification(windowManager, {
    title: ...getRendererTranslation("windowLifecycle.taskCompleted.title"),
    body:  ...getRendererTranslation("windowLifecycle.taskCompleted.body", { taskTitle: notification.taskTitle }),
    sessionId: notification.sessionId
  });
},
showTaskPendingNotification(notification) { /* same shape, "taskPending" strings */ },
```

The one function that matters, reduced to its behaviour:

```js
function showTaskNotification(windowManager, content) {
  const { title, body, sessionId } = content;
  if (!electron.Notification.isSupported()) return false;
  const mainWindow = windowManager.getMainWindow();
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused()) return false;   // no popup while the app has focus
  const systemNotification = new electron.Notification({ title, body, silent: true });   // raised by the host process
  activeTaskNotifications.add(systemNotification);                                       // strong ref: GC would kill .on("click")
  systemNotification.on("close", () => activeTaskNotifications.delete(systemNotification));
  systemNotification.on("click", () => {
    activeTaskNotifications.delete(systemNotification);
    windowManager.handleOpenUrl("workbuddy://chat/" + encodeURIComponent(sessionId));    // focus + open that session
  });
  systemNotification.show();
  return true;
}
```

Its own comments explain the strong-reference set: the notification object is a
local, so without an external reference V8 may collect it at any time; the
native notification stays on screen (the OS holds it) but the JavaScript
wrapper's `.on("click")` handlers die with it, which shows up as "clicking the
notification sometimes does nothing".

App identity: `product.win32AppUserModelId || "WorkBuddy.WorkBuddy"` is passed to
`electron.app.setAppUserModelId(...)` before any window is created. That is what
makes the toast render as "WorkBuddy" with its icon instead of as a nameless
host process.

## What was copied, and what could not be

| behaviour | how it is reproduced here |
| --- | --- |
| the reminder is raised by a **host process**, never by the web page | `desktop/bridge.mjs` spawns `present.ps1` / `toast.ps1`; the page only POSTs a request |
| no reminder while the user is looking at the app | plugin gate: `document.visibilityState !== "visible" \|\| !document.hasFocus()` |
| click focuses the app and opens that session | `POST /click` → SSE `open-session` → `uiWorkspace.openSession(id)` in the open tab, plus a Win32 window promotion; the page URL is opened only when no tab is connected |
| live notification objects are owned, not left to the GC | the bridge keeps a slot table; a slot is freed when its presenter process exits |
| an OS-level surface attributed to the product | `toast.ps1` uses AUMID `com.deepseek.dsh` (the id the installed DeepSeek Harness desktop app registers), so the toast reads "DeepSeek Harness" |
| completion vs. pending | `completed` / `waiting` reminder kinds in both halves |

Not reproducible: a toast **activation callback**. Electron registers a COM
activator for its AUMID, so WorkBuddy's toast click can call back into the app; a
script-raised toast cannot, so clicking our Windows toast does not jump. That is
why the topmost card - which does jump - is the default surface, and the toast is
an option (`--surface toast|both`).
