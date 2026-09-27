/**
 * dsh-session-alert - client plugin body (loaded as a DSH client bundle).
 *
 * Reminds the human when a session finished its work while they were looking
 * somewhere else, when a session is waiting on their input (approval, plan
 * review, answer), and - optionally - only after that session's subagents and
 * background jobs settle.
 *
 * Surfaces, all additive (neither DSH core nor the profile is patched):
 *   - a card stack docked inside the left session sidebar, right above the
 *     footer: the "sidebar.footer.action" seat supplies the anchor element and
 *     the wide/rail flag, a body portal does the exact fixed placement;
 *   - a slim top-center banner stack in the frame-wide floating layer
 *     ("shell.overlay");
 *   - a system notification while the page is not in front.
 *
 * Facts used (public client faces only, verified against dsh 0.1.7-rc.2):
 *   ctx.uiSession.sessionStatus   observable Map<SessionId, { running,
 *                                 pendingInteraction, completionUnread }>;
 *                                 completionUnread is the host's own "stopped
 *                                 while not the main view" fact.
 *   ctx.sessions.list.byId[id]    { displayTitle, running, origin, parentId,
 *                                 retainedBy.mainView, blank, updatedAt }
 *   ctx.get("jobs")               optional { state, watchRows(sessionId) }
 *   ctx.uiWorkspace.openSession(sessionId)
 *
 * The bundle is a classic script; this file is the factory body. Build with
 * "node scripts/build.mjs", publish with "node scripts/push.mjs".
 */

const react = require("react");
const reactDom = require("react-dom");

// The host's own state dot, when the primitives package is reachable.
let primitives = null;
try {
  primitives = require("@deepseek-ai/dsh-client-ui-primitives");
} catch (err) {
  primitives = null;
}

const h = react.createElement;
const NS = "dsh-session-alert";
const PLUGIN_ID = "dsh-session-alert";
const CSS_TAG = PLUGIN_ID + "/styles.css";

//#region config
/**
 * Runtime tunables. Deliberately source constants: the plugin has no settings
 * surface, so changing one means editing here and pushing again.
 */
const CONFIG = {
  /** Lifetime of one top-center banner, in ms. */
  bannerMs: 6000,
  /** Banners kept on screen at once. */
  bannerMax: 3,
  /** Sidebar cards kept on screen at once; the rest collapse into a counter. */
  cardMax: 4,
  /** Quiet period after a run stops before it counts as "finished". */
  debounceMs: 1500,
  /** Give up waiting for subagents/jobs after this long and notify anyway. */
  settleTimeoutMs: 15 * 60 * 1000,
  /** "unfocused" notifies only while the page is in the background; else "always" / "off". */
  systemNotification: "unfocused",
  /** Reminder kinds that also raise a system notification. */
  systemNotificationKinds: ["completed", "waiting"],
  /** Raise a native desktop card through the local dsh-desktop-alert bridge. */
  desktopAlert: true,
  /**
   * "always" raises a card for every reminder; "unfocused" only while this page
   * has no focus; "off" disables the desktop half.
   *
   * Default is "always": a reminder only exists for a session that is NOT the
   * main view, so the human is by definition not looking at that session - the
   * WorkBuddy focus early-return (its main window is the whole product) would
   * suppress exactly the case this plugin exists for. Set "unfocused" to get
   * that behaviour back.
   */
  desktopAlertWhen: "always",
  /** Reminder kinds that also raise a desktop card. */
  desktopAlertKinds: ["completed", "waiting"],
  /** Loopback ports the bridge may have taken, in probe order. */
  desktopAlertPorts: [41411, 41412, 41413],
  /** Re-probe period while the bridge is down, in ms. */
  desktopAlertRetryMs: 30000,
  /** Bridge surface: "card" (clickable popup), "toast" (Windows notification) or "both". */
  desktopAlertSurface: "card",
  /** Hold the completion notice until the session's running subagents settle. */
  aggregateChildren: true,
  /** The same for the session's background jobs (needs the optional jobs service). */
  aggregateJobs: true,
  /** Re-evaluation period in ms: ages the relative times and enforces the settle budget. */
  tickMs: 5000
};
//#endregion

//#region locales
/** Simplified Chinese dictionary. */
const zh = {
  "dot.completed": "已完成",
  "dot.waiting": "等待中",
  "reason.approval": "等待审批",
  "reason.plan-review": "等待计划确认",
  "reason.question": "等待你的回答",
  "reason.interaction": "等待你的操作",
  "settling": "收尾中",
  "settling.children": "{count} 个子代理运行中",
  "settling.jobs": "{count} 个后台任务运行中",
  "settling.both": "{children} 个子代理 / {jobs} 个后台任务运行中",
  "more": "另有 {count} 条",
  "time.now": "刚刚",
  "time.minutes": "{count} 分钟前",
  "time.hours": "{count} 小时前",
  "action.open": "打开会话",
  "action.dismiss": "关闭提醒",
  "banner.completed": "会话「{name}」已完成 · 点击查看",
  "banner.waiting": "会话「{name}」{reason} · 点击查看",
  "notify.completed.title": "DSH · 会话已完成",
  "notify.waiting.title": "DSH · 会话在等你",
  "notify.body": "{name} · {reason}",
  "notify.permission": "开启系统通知",
  "notify.hint": "点击打开会话",
  "notify.desktopOffline": "桌面提醒服务未启动（在 dsh-desktop-alert 目录运行 cli.mjs start 可开启）"
};

/** English dictionary (fallback for every other locale). */
const en = {
  "dot.completed": "completed",
  "dot.waiting": "waiting",
  "reason.approval": "waiting for approval",
  "reason.plan-review": "waiting for plan review",
  "reason.question": "waiting for your answer",
  "reason.interaction": "waiting for you",
  "settling": "settling",
  "settling.children": "{count} subagents running",
  "settling.jobs": "{count} background jobs running",
  "settling.both": "{children} subagents / {jobs} background jobs running",
  "more": "{count} more",
  "time.now": "just now",
  "time.minutes": "{count}m ago",
  "time.hours": "{count}h ago",
  "action.open": "Open session",
  "action.dismiss": "Dismiss reminder",
  "banner.completed": "Session \"{name}\" finished · click to open",
  "banner.waiting": "Session \"{name}\" {reason} · click to open",
  "notify.completed.title": "DSH · session finished",
  "notify.waiting.title": "DSH · session needs you",
  "notify.body": "{name} · {reason}",
  "notify.permission": "Enable system notifications",
  "notify.hint": "Click to open the session",
  "notify.desktopOffline": "Desktop alert service is not running (run cli.mjs start in the dsh-desktop-alert folder)"
};
//#endregion

//#region styles
/** Plugin stylesheet, injected once per page. Design tokens follow the host theme. */
const CSS = [
  ".dsa-anchor{display:block;width:0;height:0;flex:0 0 auto}",
  ".dsa-cards{position:fixed;z-index:60;display:flex;flex-direction:column;gap:8px;pointer-events:none}",
  ".dsa-card{pointer-events:auto;display:flex;gap:8px;align-items:flex-start;padding:9px 11px;border:1px solid var(--dsw-alias-border-l2,#e3e5e8);border-radius:10px;background:var(--dsw-specific-menu,#ffffff);color:var(--dsw-alias-label-primary,#1f2329);box-shadow:var(--dsw-shadow-lv3,0 6px 20px rgba(0,0,0,.12));cursor:pointer;font-size:12px;line-height:1.45;transition:border-color .15s ease,transform .15s ease}",
  ".dsa-card:hover{border-color:var(--dsw-alias-border-l1,#c9ced6);transform:translateY(-1px)}",
  ".dsa-card--wait{border-color:rgba(232,161,58,.55)}",
  ".dsa-body{min-width:0;flex:1 1 auto}",
  ".dsa-title{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
  ".dsa-sub{margin-top:2px;color:var(--dsw-alias-label-secondary,#8a9099);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
  ".dsa-dot{width:8px;height:8px;border-radius:50%;flex:0 0 auto;margin-top:4px}",
  ".dsa-dot--done{background:#34d399}",
  ".dsa-dot--wait{background:#e8a13a}",
  ".dsa-close{pointer-events:auto;flex:0 0 auto;border:0;background:transparent;color:var(--dsw-alias-label-secondary,#8a9099);cursor:pointer;font-size:14px;line-height:1;padding:0 2px}",
  ".dsa-close:hover{color:var(--dsw-alias-label-primary,#1f2329)}",
  ".dsa-more{pointer-events:none;padding:0 11px;color:var(--dsw-alias-label-secondary,#8a9099);font-size:11px}",
  ".dsa-perm{pointer-events:auto;margin-top:2px;border:1px solid var(--dsw-alias-border-l2,#e3e5e8);border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary,#8a9099);cursor:pointer;font-size:11px;padding:5px 8px}",
  ".dsa-banners{position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:70;display:flex;flex-direction:column;gap:8px;align-items:center;pointer-events:none}",
  ".dsa-banner{pointer-events:auto;display:flex;gap:8px;align-items:center;max-width:min(560px,calc(100vw - 48px));padding:8px 12px;border:1px solid var(--dsw-alias-border-l2,#e3e5e8);border-radius:999px;background:var(--dsw-specific-menu,#ffffff);color:var(--dsw-alias-label-primary,#1f2329);box-shadow:var(--dsw-shadow-lv3,0 6px 20px rgba(0,0,0,.12));font-size:12px;cursor:pointer;animation:dsa-in .18s ease-out}",
  ".dsa-banner-text{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
  ".dsa-offline{pointer-events:auto;padding:6px 10px;border:1px dashed var(--dsw-alias-border-l2,#e3e5e8);border-radius:10px;color:var(--dsw-alias-label-secondary,#8a9099);font-size:11px;line-height:1.45}",
  "@keyframes dsa-in{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:none}}"
].join("");

/** Install the stylesheet once; idempotent across plugin reloads. */
function installStyles() {
  if (typeof document === "undefined" || !document.head) return;
  if (document.querySelector('style[data-plugin-css="' + CSS_TAG + '"]')) return;
  const tag = document.createElement("style");
  tag.dataset.plugin = PLUGIN_ID;
  tag.dataset.pluginCss = CSS_TAG;
  tag.textContent = CSS;
  document.head.appendChild(tag);
}

/**
 * Current page URL - the desktop card's fallback target when no page is connected.
 */
function pageUrl() {
  try { return typeof location !== "undefined" ? String(location.href) : ""; } catch (err) { return ""; }
}

/** Document title - the card uses it to find the browser window to promote. */
function pageTitle() {
  try { return typeof document !== "undefined" ? String(document.title || "") : ""; } catch (err) { return ""; }
}

/** Preferred color scheme, so the native card matches the page. */
function pageTheme() {
  try {
    if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
      return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    }
  } catch (err) { /* fall through */ }
  return "dark";
}

/**
 * Client half of the dsh-desktop-alert bridge (see desktop/bridge.mjs).
 *
 * The bridge is a loopback service that owns the native popup; this half keeps
 * one EventSource open to it, forwards reminder payloads, and turns a card click
 * into a session jump inside this page. Everything here is best effort: a
 * missing bridge costs the desktop card, nothing else.
 */
function createDesktopAlert(options) {
  if (CONFIG.desktopAlert !== true) return null;
  if (typeof fetch !== "function") return null;
  const log = options.log || function () { /* noop */ };
  const ports = Array.isArray(options.ports) && options.ports.length > 0 ? options.ports : [41411];
  let port = 0;
  let source = null;
  let online = false;
  let stopped = false;
  let retryTimer = null;
  let probing = false;

  function base() { return "http://127.0.0.1:" + port; }

  function setOnline(value) {
    if (online === value) return;
    online = value;
    try { options.onState(value, port); } catch (err) { log(err); }
  }

  function schedule() {
    if (stopped || retryTimer !== null) return;
    retryTimer = setTimeout(function () { retryTimer = null; probe(); }, options.retryMs || 30000);
  }

  function drop() {
    if (source) { try { source.close(); } catch (err) { /* noop */ } source = null; }
    setOnline(false);
    schedule();
  }

  function subscribe() {
    if (typeof EventSource !== "function") return;
    let stream = null;
    try { stream = new EventSource(base() + "/events"); } catch (err) { log(err); drop(); return; }
    source = stream;
    stream.addEventListener("hello", function () { setOnline(true); });
    stream.addEventListener("open-session", function (event) {
      let payload = null;
      try { payload = JSON.parse(event.data); } catch (err) { payload = null; }
      if (!payload || !payload.sessionId) return;
      try { options.onOpen(String(payload.sessionId)); } catch (err) { log(err); }
    });
    stream.onopen = function () { setOnline(true); };
    stream.onerror = function () { if (source === stream) drop(); };
  }

  function timeoutSignal(ms) {
    try { return typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined; } catch (err) { return undefined; }
  }

  async function probe() {
    if (stopped || probing || online) return;
    probing = true;
    let found = 0;
    for (const candidate of ports) {
      try {
        const res = await fetch("http://127.0.0.1:" + candidate + "/health", { cache: "no-store", signal: timeoutSignal(1500) });
        const info = await res.json();
        if (info && info.service === "dsh-desktop-alert") { found = candidate; break; }
      } catch (err) { /* nothing on this port */ }
    }
    probing = false;
    if (stopped) return;
    if (found === 0) { schedule(); return; }
    port = found;
    setOnline(true);
    subscribe();
  }

  /** Ask the bridge to raise one desktop card. */
  function notify(payload) {
    if (stopped || port === 0) return;
    try {
      fetch(base() + "/notify", {
        method: "POST",
        mode: "cors",
        cache: "no-store",
        keepalive: true,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload)
      }).catch(function (err) { log(err); });
    } catch (err) { log(err); }
  }

  /** Tell the bridge the session jump happened (it keeps that as evidence). */
  function ack(sessionId) {
    if (stopped || port === 0) return;
    try {
      fetch(base() + "/ack", {
        method: "POST",
        mode: "cors",
        keepalive: true,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: sessionId })
      }).catch(function () { /* noop */ });
    } catch (err) { log(err); }
  }

  probe();
  return {
    notify: notify,
    ack: ack,
    online: function () { return online; },
    port: function () { return port; },
    stop: function () {
      stopped = true;
      if (retryTimer !== null) { clearTimeout(retryTimer); retryTimer = null; }
      if (source) { try { source.close(); } catch (err) { /* noop */ } source = null; }
    }
  };
}

/** Render through a body portal so no transformed ancestor can trap the fixed layer. */
function portal(node) {
  if (typeof document !== "undefined" && reactDom && typeof reactDom.createPortal === "function") {
    return reactDom.createPortal(node, document.body);
  }
  return node;
}
//#endregion

//#region model (pure)
/** Job statuses that still mean busy; any unknown status counts as settled. */
const LIVE_JOB_STATUS = { pending: true, running: true, stopping: true };

/** Whether one background job reached a terminal state. */
function isJobSettled(job) {
  return !(job && LIVE_JOB_STATUS[job.status] === true);
}

/** Read one session status from either a Map snapshot or a plain record. */
function readStatus(statuses, id) {
  if (!statuses) return undefined;
  if (typeof statuses.get === "function") return statuses.get(id);
  return statuses[id];
}

/** Number of running direct subagent children of one session. */
function countRunningChildren(rows, id) {
  let count = 0;
  for (const key of Object.keys(rows)) {
    const row = rows[key];
    if (row && row.origin === "subagent" && row.parentId === id && row.running === true) count += 1;
  }
  return count;
}

/** Number of live (non-settled) background jobs recorded for one session. */
function countLiveJobs(jobRows, id) {
  const list = jobRows ? jobRows[id] : null;
  if (!list || typeof list.length !== "number") return 0;
  let count = 0;
  for (const job of list) if (!isJobSettled(job)) count += 1;
  return count;
}

/** Normalized waiting-interaction kind; unknown domains read as "interaction". */
function waitingKind(pending) {
  if (!pending) return null;
  const kind = typeof pending === "string" ? pending : pending.kind;
  return typeof kind === "string" && kind !== "" ? kind : "interaction";
}

/**
 * Project the public snapshots onto the reminder set and the edge events.
 *
 * The reminder list is a projection, not a queue: a reminder exists exactly
 * while its fact holds, so anything the host clears (the session starts
 * running again, the human opens it, the interaction is answered) disappears
 * by itself and nothing can go stale.
 *
 * @param prev - previous plan state, or an empty object on the first pass.
 * @param input - { statuses, rows, jobs, nowMs, config }.
 * @returns { state, events } - the new plan state and this pass's edge events:
 *   "completed" (a run just stopped outside the main view), "waiting" (an
 *   interaction appeared), "settled" (a previously settling reminder's
 *   subagents/jobs finished, or the settle budget expired).
 */
function planState(prev, input) {
  const config = (input && input.config) || CONFIG;
  const nowMs = input.nowMs;
  const rows = (input && input.rows) || {};
  const statuses = (input && input.statuses) || {};
  const jobRows = (input && input.jobs) || {};
  const before = prev && prev.reminders ? prev : { seeded: false, facts: {}, reminders: {} };
  const state = { seeded: true, facts: {}, reminders: {} };
  const events = [];

  for (const id of Object.keys(rows)) {
    const row = rows[id];
    if (!row || row.blank === true || row.origin === "subagent") continue;
    const status = readStatus(statuses, id) || {};
    const mainView = !!(row.retainedBy && row.retainedBy.mainView > 0);
    const completed = status.completionUnread === true;
    // A waiting interaction is only reminder-worthy when it is not on screen.
    const waiting = mainView ? null : waitingKind(status.pendingInteraction);
    const children = config.aggregateChildren ? countRunningChildren(rows, id) : 0;
    const liveJobs = config.aggregateJobs ? countLiveJobs(jobRows, id) : 0;
    const previousFact = before.facts[id] || { completed: false, waiting: null };
    state.facts[id] = { completed: completed, waiting: waiting };
    if (!completed && waiting === null) continue;

    const prior = before.reminders[id];
    const fresh = !prior || prior.completed !== completed || prior.waiting !== waiting;
    let settling = children > 0 || liveJobs > 0;
    let settleAt = settling ? (prior && prior.settling === true && prior.settleAt ? prior.settleAt : nowMs) : null;
    let timedOut = fresh ? false : prior.timedOut === true;
    if (settling && settleAt !== null && nowMs - settleAt >= config.settleTimeoutMs) {
      settling = false;
      settleAt = null;
      timedOut = true;
    }
    state.reminders[id] = {
      id: id,
      title: row.displayTitle || id,
      completed: completed,
      waiting: waiting,
      at: fresh ? nowMs : prior.at,
      notified: fresh ? false : prior.notified === true,
      settling: settling,
      settleAt: settleAt,
      timedOut: timedOut,
      children: children,
      jobs: liveJobs
    };

    if (!before.seeded) continue; // the first pass only seeds: no notification storm on reload
    if (completed && previousFact.completed !== true) events.push({ type: "completed", id: id });
    if (waiting !== null && previousFact.waiting !== waiting) events.push({ type: "waiting", id: id, kind: waiting });
    if (prior && prior.settling === true && !settling && completed) {
      events.push({ type: "settled", id: id, timedOut: timedOut });
    }
  }
  return { state: state, events: events };
}

/** Map a pending-interaction kind onto a dictionary key. */
function reasonKey(kind) {
  if (kind === "approval") return "reason.approval";
  if (kind === "plan-review") return "reason.plan-review";
  if (kind === "question") return "reason.question";
  return "reason.interaction";
}

/** Human reason for one reminder: the interaction it waits for, else "completed". */
function reminderReason(reminder, t) {
  if (reminder.waiting) return t(reasonKey(reminder.waiting));
  return t("dot.completed");
}

/** The settling detail line (children / jobs still running). */
function settlingText(reminder, t) {
  if (reminder.children > 0 && reminder.jobs > 0) {
    return t("settling.both", { children: reminder.children, jobs: reminder.jobs });
  }
  if (reminder.children > 0) return t("settling.children", { count: reminder.children });
  return t("settling.jobs", { count: reminder.jobs });
}

/** The card's second line: reason (and settling state) plus relative time. */
function reminderSubtitle(reminder, t, nowMs) {
  const parts = [];
  if (reminder.waiting) parts.push(t(reasonKey(reminder.waiting)));
  else if (reminder.settling) parts.push(t("settling") + " · " + settlingText(reminder, t));
  else parts.push(t("dot.completed"));
  parts.push(formatRelative(t, reminder.at, nowMs));
  return parts.join(" · ");
}

/** Relative time for a reminder age. */
function formatRelative(t, at, nowMs) {
  const minutes = Math.floor(Math.max(0, nowMs - at) / 60000);
  if (minutes < 1) return t("time.now");
  if (minutes < 60) return t("time.minutes", { count: minutes });
  return t("time.hours", { count: Math.floor(minutes / 60) });
}

/** Banner copy for one queued banner. */
function bannerText(banner, t) {
  if (banner.kind === "waiting") {
    return t("banner.waiting", { name: banner.title, reason: t(reasonKey(banner.waiting)) });
  }
  return t("banner.completed", { name: banner.title });
}
//#endregion

//#region runtime store
/**
 * The one store both seats render from: subscriptions, debounce timers, the
 * dismissal set, the banner queue and the immutable snapshot handed to React.
 */
function createStore(ctx) {
  const listeners = new Set();
  const timers = new Map();
  const bannerTimers = new Set();
  const watches = new Map();
  const hidden = new Set();
  const log = (err) => { try { console.warn("[" + PLUGIN_ID + "]", err); } catch (e) { /* noop */ } };

  const jobsService = typeof ctx.get === "function" ? ctx.get("jobs") : undefined;
  const t = ctx.locale && typeof ctx.locale.bind === "function" ? ctx.locale.bind(NS) : function (key) { return key; };
  const supported = typeof Notification !== "undefined";
  let permission = supported ? Notification.permission : "unsupported";
  let desktopOnline = false;
  const desktop = createDesktopAlert({
    ports: CONFIG.desktopAlertPorts,
    retryMs: CONFIG.desktopAlertRetryMs,
    log: log,
    onOpen: function (sessionId) {
      try { if (typeof window !== "undefined" && typeof window.focus === "function") window.focus(); } catch (err) { /* noop */ }
      actions.open(sessionId);
      if (desktop) desktop.ack(sessionId);
    },
    onState: function (value) { desktopOnline = value; publish(); }
  });
  let plan = { seeded: false, facts: {}, reminders: {} };
  let banners = [];
  let bannerSeq = 0;
  let snapshot = {
    reminders: [], more: 0, banners: [], permission: permission, supported: supported,
    desktop: { enabled: desktop !== null, online: false, port: 0 }, nowMs: Date.now()
  };

  /** Current session rows, keyed by id. */
  function listRows() {
    try {
      const state = ctx.sessions && ctx.sessions.list ? ctx.sessions.list.getSnapshot() : null;
      return (state && state.byId) || {};
    } catch (err) { log(err); return {}; }
  }

  /** Current per-session UI status (a Map in this version). */
  function statusSnapshot() {
    try {
      const source = ctx.uiSession && ctx.uiSession.sessionStatus;
      return source && typeof source.getSnapshot === "function" ? source.getSnapshot() : {};
    } catch (err) { log(err); return {}; }
  }

  /** Current job rosters, when the optional jobs service is present. */
  function jobRows() {
    try {
      const source = jobsService && jobsService.state;
      const state = source && typeof source.getSnapshot === "function" ? source.getSnapshot() : null;
      return (state && state.rows) || {};
    } catch (err) { log(err); return {}; }
  }

  /** Visible reminders, newest first. */
  function orderedReminders() {
    const items = [];
    for (const id of Object.keys(plan.reminders)) {
      if (!hidden.has(id)) items.push(plan.reminders[id]);
    }
    items.sort((a, b) => b.at - a.at);
    return items;
  }

  /** Publish a fresh snapshot to every mounted seat. */
  function publish() {
    const all = orderedReminders();
    const shown = all.slice(0, CONFIG.cardMax);
    snapshot = {
      reminders: shown,
      more: all.length - shown.length,
      banners: banners.slice(),
      permission: permission,
      supported: supported,
      desktop: { enabled: desktop !== null, online: desktopOnline, port: desktop ? desktop.port() : 0 },
      nowMs: Date.now()
    };
    for (const listener of Array.from(listeners)) {
      try { listener(); } catch (err) { log(err); }
    }
  }

  /** Hook over the store snapshot (the seat's inject face). */
  function useStore() {
    const pair = react.useState(snapshot);
    const value = pair[0];
    const setValue = pair[1];
    react.useEffect(function () {
      const listener = function () { setValue(snapshot); };
      listeners.add(listener);
      listener();
      return function () { listeners.delete(listener); };
    }, []);
    return value;
  }

  /** Show one banner and schedule its fade-out. */
  function pushBanner(reminder, kind) {
    bannerSeq += 1;
    const banner = {
      key: bannerSeq,
      id: reminder.id,
      kind: kind,
      title: reminder.title,
      waiting: reminder.waiting,
      at: reminder.at
    };
    banners = banners.concat([banner]).slice(-CONFIG.bannerMax);
    const timer = setTimeout(function () {
      bannerTimers.delete(timer);
      banners = banners.filter(function (item) { return item.key !== banner.key; });
      publish();
    }, CONFIG.bannerMs);
    bannerTimers.add(timer);
    publish();
  }

  /** Raise the system notification, when allowed and wanted. */
  function pushSystemNotification(reminder, kind) {
    if (!supported || CONFIG.systemNotification === "off") return;
    if (CONFIG.systemNotificationKinds.indexOf(kind) < 0) return;
    if (permission !== "granted") return;
    const background = typeof document === "undefined" || document.visibilityState !== "visible";
    if (CONFIG.systemNotification === "unfocused" && !background) return;
    try {
      const title = kind === "waiting" ? t("notify.waiting.title") : t("notify.completed.title");
      const body = t("notify.body", { name: reminder.title, reason: reminderReason(reminder, t) });
      const notification = new Notification(title, {
        body: body,
        tag: PLUGIN_ID + ":" + reminder.id + ":" + kind,
        silent: true
      });
      notification.onclick = function () {
        try { window.focus(); } catch (err) { /* noop */ }
        actions.open(reminder.id);
        try { notification.close(); } catch (err) { /* noop */ }
      };
    } catch (err) { log(err); }
  }

  /**
   * Raise the native desktop card. Unlike the browser notification this one is
   * drawn by a local process, so it appears above every application and needs no
   * page permission; it is skipped while this page still holds the user's focus.
   */
  function pushDesktopCard(reminder, kind) {
    if (!desktop || CONFIG.desktopAlertWhen === "off") return;
    if (CONFIG.desktopAlertKinds.indexOf(kind) < 0) return;
    let background = true;
    try {
      background = typeof document === "undefined"
        || document.visibilityState !== "visible"
        || (typeof document.hasFocus === "function" && document.hasFocus() === false);
    } catch (err) { background = true; }
    if (CONFIG.desktopAlertWhen === "unfocused" && background === false) return;
    desktop.notify({
      kind: kind,
      title: kind === "waiting" ? t("notify.waiting.title") : t("notify.completed.title"),
      body: t("notify.body", { name: reminder.title, reason: reminderReason(reminder, t) }),
      hint: t("notify.hint"),
      sessionId: reminder.id,
      surface: CONFIG.desktopAlertSurface,
      url: pageUrl(),
      windowTitle: pageTitle(),
      theme: pageTheme()
    });
  }

  /** Mark one reminder notified and raise both surfaces. */
  function notify(id, kind) {
    const reminder = plan.reminders[id];
    if (!reminder) return;
    reminder.notified = true;
    pushBanner(reminder, kind);
    pushSystemNotification(reminder, kind);
    pushDesktopCard(reminder, kind);
  }

  /** Fire the completion notice for one id, unless it settled away or is still settling. */
  function fire(id) {
    const reminder = plan.reminders[id];
    if (!reminder || !reminder.completed || reminder.notified) return;
    if (reminder.settling) return; // the settle edge notifies later
    notify(id, "completed");
  }

  /** Apply one edge event from planState. */
  function handleEvent(event) {
    if (event.type === "completed") {
      if (timers.has(event.id)) return;
      const timer = setTimeout(function () {
        timers.delete(event.id);
        fire(event.id);
      }, CONFIG.debounceMs);
      timers.set(event.id, timer);
      return;
    }
    if (event.type === "waiting") {
      notify(event.id, "waiting");
      return;
    }
    if (event.type === "settled") {
      const reminder = plan.reminders[event.id];
      if (reminder && reminder.completed && !reminder.notified) notify(event.id, "completed");
    }
  }

  /** Keep job rosters open for sessions that are running or carry a reminder. */
  function syncWatches(rows) {
    if (!jobsService || typeof jobsService.watchRows !== "function") return;
    const wanted = new Set();
    for (const id of Object.keys(rows)) {
      const row = rows[id];
      if (!row || row.blank === true || row.origin === "subagent") continue;
      if (row.running === true || plan.reminders[id]) wanted.add(id);
    }
    for (const entry of Array.from(watches)) {
      if (wanted.has(entry[0])) continue;
      try { entry[1](); } catch (err) { log(err); }
      watches.delete(entry[0]);
    }
    for (const id of wanted) {
      if (watches.has(id)) continue;
      let off = function () { /* noop */ };
      try {
        const result = jobsService.watchRows(id);
        if (typeof result === "function") off = result;
      } catch (err) { log(err); }
      watches.set(id, off);
    }
  }

  /** One evaluation pass: project, prune, watch, notify, publish. */
  function tick() {
    try {
      const rows = listRows();
      const result = planState(plan, {
        rows: rows,
        statuses: statusSnapshot(),
        jobs: jobRows(),
        nowMs: Date.now(),
        config: CONFIG
      });
      plan = result.state;
      for (const id of Array.from(hidden)) if (!plan.reminders[id]) hidden.delete(id);
      for (const entry of Array.from(timers)) {
        if (plan.reminders[entry[0]]) continue;
        clearTimeout(entry[1]);
        timers.delete(entry[0]);
      }
      syncWatches(rows);
      for (const event of result.events) handleEvent(event);
    } catch (err) {
      log(err);
    }
    publish();
  }

  /** Subscribe to the public sources; returns the teardown. */
  function start() {
    const disposers = [];
    const statusSource = ctx.uiSession && ctx.uiSession.sessionStatus;
    if (statusSource && typeof statusSource.subscribe === "function") disposers.push(statusSource.subscribe(tick));
    const listSource = ctx.sessions && ctx.sessions.list;
    if (listSource && typeof listSource.subscribe === "function") disposers.push(listSource.subscribe(tick));
    if (jobsService && jobsService.state && typeof jobsService.state.subscribe === "function") {
      disposers.push(jobsService.state.subscribe(tick));
    }
    const interval = setInterval(tick, CONFIG.tickMs);
    tick();
    return function () {
      clearInterval(interval);
      for (const dispose of disposers) {
        try { dispose(); } catch (err) { log(err); }
      }
      for (const timer of Array.from(timers.values())) clearTimeout(timer);
      timers.clear();
      for (const timer of Array.from(bannerTimers)) clearTimeout(timer);
      bannerTimers.clear();
      if (desktop) desktop.stop();
      for (const off of Array.from(watches.values())) {
        try { off(); } catch (err) { log(err); }
      }
      watches.clear();
      listeners.clear();
    };
  }

  const actions = {
    /** Jump to the session (the host clears its own unread fact on arrival). */
    open: function (id) {
      const sessionId = String(id);
      banners = banners.filter(function (banner) { return banner.id !== sessionId; });
      publish();
      try {
        if (ctx.uiWorkspace && typeof ctx.uiWorkspace.openSession === "function") ctx.uiWorkspace.openSession(sessionId);
        else log("uiWorkspace.openSession is unavailable");
      } catch (err) { log(err); }
    },
    /** Hide one reminder until its fact clears and appears again. */
    dismiss: function (id) {
      hidden.add(String(id));
      publish();
    },
    /** Drop one banner early. */
    dismissBanner: function (key) {
      banners = banners.filter(function (banner) { return banner.key !== key; });
      publish();
    },
    /** Ask for the notification permission from a user gesture. */
    requestPermission: function () {
      if (!supported || typeof Notification.requestPermission !== "function") return;
      try {
        const result = Notification.requestPermission();
        if (result && typeof result.then === "function") {
          result.then(function (value) { permission = value; publish(); }, log);
        }
      } catch (err) { log(err); }
    }
  };

  return { start: start, useStore: useStore, actions: actions };
}
//#endregion

//#region views
/** State dot: the host primitive when reachable, else an equivalent span. */
function Dot(props) {
  const wanted = props.kind === "waiting" ? "warning" : "done";
  if (primitives && typeof primitives.StateDot === "function") {
    return h(primitives.StateDot, { state: wanted, size: 8 });
  }
  return h("span", { className: "dsa-dot dsa-dot--" + (props.kind === "waiting" ? "wait" : "done") });
}

/**
 * Resolve the sidebar column box from the seat element: the highest ancestor
 * whose width still fits the column range (56px rail up to the 420px drag
 * ceiling, plus padding). The seat's own top is kept, because the cards dock
 * just above the footer row.
 */
function resolveSidebarBox(element, seatBox) {
  let box = seatBox;
  if (typeof document === "undefined") return box;
  let node = element;
  while (node && node !== document.body) {
    const rect = node.getBoundingClientRect();
    if (rect.width >= 40 && rect.width <= 480) {
      box = { left: rect.left, right: rect.right, top: seatBox.top, width: rect.width };
    }
    node = node.parentElement;
  }
  return box;
}

/** Fixed placement for the card stack: inside the sidebar, above its footer. */
function cardStackStyle(box, wide) {
  if (!box) return { left: "12px", bottom: "12px", width: "280px" };
  const viewportHeight = typeof window !== "undefined" ? window.innerHeight : 900;
  const bottom = Math.max(12, Math.round(viewportHeight - box.top + 8));
  if (wide === false) {
    return { left: Math.round(box.right + 8) + "px", bottom: bottom + "px", width: "280px" };
  }
  return {
    left: Math.round(box.left) + "px",
    bottom: bottom + "px",
    width: Math.max(220, Math.round(box.width)) + "px"
  };
}

/** The docked reminder cards. */
function CardStack(props) {
  const reminders = props.reminders;
  const t = props.t;
  const actions = props.actions;
  const nowMs = props.nowMs;
  const children = reminders.map(function (reminder) {
    return h("div", {
      key: reminder.id,
      className: "dsa-card" + (reminder.waiting ? " dsa-card--wait" : ""),
      role: "button",
      tabIndex: 0,
      title: t("action.open"),
      onClick: function () { actions.open(reminder.id); },
      onKeyDown: function (event) {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          actions.open(reminder.id);
        }
      }
    }, [
      h(Dot, { key: "dot", kind: reminder.waiting ? "waiting" : "completed" }),
      h("div", { key: "body", className: "dsa-body" }, [
        h("div", { key: "title", className: "dsa-title" }, reminder.title),
        h("div", { key: "sub", className: "dsa-sub" }, reminderSubtitle(reminder, t, nowMs))
      ]),
      h("button", {
        key: "close",
        className: "dsa-close",
        type: "button",
        title: t("action.dismiss"),
        "aria-label": t("action.dismiss"),
        onClick: function (event) {
          event.stopPropagation();
          actions.dismiss(reminder.id);
        }
      }, "×")
    ]);
  });
  if (props.more > 0) {
    children.push(h("div", { key: "more", className: "dsa-more" }, t("more", { count: props.more })));
  }
  if (props.desktop && props.desktop.enabled === true && props.desktop.online === false) {
    children.push(h("div", { key: "desktop", className: "dsa-offline", title: t("notify.desktopOffline") }, t("notify.desktopOffline")));
  }
  if (props.supported && props.permission === "default") {
    children.push(h("button", {
      key: "permission",
      className: "dsa-perm",
      type: "button",
      onClick: function () { actions.requestPermission(); }
    }, t("notify.permission")));
  }
  return h("div", { className: "dsa-cards", style: cardStackStyle(props.box, props.wide) }, children);
}

/** Seat A: an invisible anchor in the sidebar footer, plus the portal'd cards. */
function CardAnchor(props) {
  const wide = props.wide;
  const t = props.t;
  const actions = props.actions;
  const useStore = props.useStore;
  const snapshot = useStore();
  const seatRef = react.useRef(null);
  const pair = react.useState(null);
  const box = pair[0];
  const setBox = pair[1];

  react.useLayoutEffect(function () {
    const element = seatRef.current;
    if (!element) return undefined;
    const measure = function () {
      const seat = element.getBoundingClientRect();
      setBox(resolveSidebarBox(element, { left: seat.left, right: seat.right, top: seat.top, width: seat.width }));
    };
    measure();
    let observer = null;
    if (typeof ResizeObserver === "function") {
      observer = new ResizeObserver(measure);
      observer.observe(element);
    }
    window.addEventListener("resize", measure);
    return function () {
      if (observer) observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [wide]);

  const deck = snapshot.desktop || { enabled: false, online: true, port: 0 };
  const offlineHint = deck.enabled === true && deck.online === false;
  const stack = (snapshot.reminders.length > 0 || offlineHint)
    ? portal(h(CardStack, {
      reminders: snapshot.reminders,
      more: snapshot.more,
      permission: snapshot.permission,
      supported: snapshot.supported,
      desktop: deck,
      nowMs: snapshot.nowMs,
      box: box,
      wide: wide,
      t: t,
      actions: actions
    }))
    : null;

  return h(react.Fragment, null, h("div", { ref: seatRef, className: "dsa-anchor", "aria-hidden": "true" }), stack);
}

/** Seat B: the top-center banner stack. */
function BannerHost(props) {
  const t = props.t;
  const actions = props.actions;
  const useStore = props.useStore;
  const snapshot = useStore();
  if (snapshot.banners.length === 0) return null;
  return h("div", { className: "dsa-banners" }, snapshot.banners.map(function (banner) {
    return h("div", {
      key: banner.key,
      className: "dsa-banner",
      role: "button",
      tabIndex: 0,
      title: t("action.open"),
      onClick: function () { actions.open(banner.id); },
      onKeyDown: function (event) {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          actions.open(banner.id);
        }
      }
    }, [
      h(Dot, { key: "dot", kind: banner.kind }),
      h("span", { key: "text", className: "dsa-banner-text" }, bannerText(banner, t)),
      h("button", {
        key: "close",
        className: "dsa-close",
        type: "button",
        title: t("action.dismiss"),
        "aria-label": t("action.dismiss"),
        onClick: function (event) {
          event.stopPropagation();
          actions.dismissBanner(banner.key);
        }
      }, "×")
    ]);
  }));
}
//#endregion

//#region plugin body
/** Services the plugin needs; "jobs" is optional and read through ctx.get. */
const inject = ["sessions", "slots", "locale", "uiSession", "uiWorkspace"];

/**
 * Register the dictionaries and both seats; every registration rides an effect
 * so a hot reload tears the previous one down instead of stacking.
 * @param ctx - client root context.
 */
function apply(ctx) {
  installStyles();
  const store = createStore(ctx);
  ctx.effect(function () { return store.start(); }, PLUGIN_ID + ": watchers");
  ctx.effect(function () { return ctx.locale.register(NS, { zh: zh, en: en }); }, PLUGIN_ID + ": dictionaries");
  ctx.effect(function () {
    return ctx.slots.inject("sidebar.footer.action", function () {
      return ctx.slots.register({
        name: "sidebar.footer.action",
        id: PLUGIN_ID + ":cards",
        order: 5,
        registrant: PLUGIN_ID,
        locale: NS,
        inject: function () { return { useStore: store.useStore, actions: store.actions }; }
      }, CardAnchor);
    });
  }, PLUGIN_ID + ": sidebar cards");
  ctx.effect(function () {
    return ctx.slots.inject("shell.overlay", function () {
      return ctx.slots.register({
        name: "shell.overlay",
        id: PLUGIN_ID + ":banners",
        order: 90,
        registrant: PLUGIN_ID,
        locale: NS,
        inject: function () { return { useStore: store.useStore, actions: store.actions }; }
      }, BannerHost);
    });
  }, PLUGIN_ID + ": banners");
}

exports.apply = apply;
exports.inject = inject;
exports.__test = {
  CONFIG: CONFIG,
  planState: planState,
  formatRelative: formatRelative,
  isJobSettled: isJobSettled,
  reasonKey: reasonKey,
  createDesktopAlert: createDesktopAlert,
  pageTitle: pageTitle
};
//#endregion
