/* ============================================================================
   GH sidebar/iOS count mismatch — production screenshot: the Tasks page header
   read "62 tasks · quantal-health" while the LEFT SIDEBAR badge next to "Tasks"
   read "0", and "Requests" also read "0". Reads as broken.

   Root cause: the sidebar Tasks badge counted ONLY needs_verification tasks (a
   narrow "needs you" subset — legitimately 0 while the container has 62 tasks
   in other statuses), while the page header counted ALL tasks regardless of
   status. Two different numbers, same-looking UI slot.

   Fix: both the sidebar badge AND the page header now read taskOpenTotal() /
   requestOpenTotal() (app-data.js) — accessors that prefer the additive
   snapshot fields `task_open_total`/`request_open_total` (container_snapshot_
   routes.py: one extra COUNT(*) FILTER column per query, computed over the
   FULL table, not the capped/priority-ordered tasks[]/requests[] window) and
   fall back to a client-side filter over the loaded window when polling an
   older snapshot that predates the fields. The old needs-attention signal
   (needs_verification count) still lives in the "Needs you" card — no
   information lost, just no longer this badge's job.

   Dependency-free: loads the REAL production modules (app-state, app-text,
   app-ui, app-data, app-autonomy, app-shell) in a vm sandbox over a tiny fake
   DOM (mirrors seamless_nav.test.js PART E / notification_center.test.js),
   stubs only the leaf UI wiring this test doesn't exercise (notif pill,
   pairing modal — no fetch/EventSource machinery here), and drives the actual
   wired path: applySnapshot(fixture) → mountShell → read the rendered <nav>.

   Run:  node tests/portal/sidebar_task_counts.test.js
   ========================================================================== */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const MODULES = path.join(
  __dirname, "..", "..",
  "orcha-cli", "orcha_cli", "templates", "portal", "static", "modules"
);
const read = (f) => fs.readFileSync(path.join(MODULES, f), "utf8");

const APP_STATE = read("app-state.js");
const APP_TEXT = read("app-text.js");
const APP_UI = read("app-ui.js");
const APP_DATA = read("app-data.js");
const APP_AUTONOMY = read("app-autonomy.js");
const APP_SHELL = read("app-shell.js");

let failures = 0;
function assert(cond, msg) {
  if (cond) { console.log("  ✓ " + msg); }
  else { failures++; console.error("  ✗ " + msg); }
}

/* ---- tiny fake DOM (mirrors seamless_nav.test.js / notification_center.test.js) ---- */
function makeNode(id) {
  const n = {
    id: id || "", _class: "", _html: "", dataset: {},
    get className() { return n._class; },
    set className(v) { n._class = v || ""; },
    get innerHTML() { return n._html; },
    set innerHTML(v) { n._html = v == null ? "" : String(v); },
    setAttribute: () => {}, getAttribute: () => null, focus: () => {},
    appendChild: () => {}, insertAdjacentElement: () => {}, remove: () => {},
    addEventListener: () => {}, querySelector: () => null, querySelectorAll: () => [],
    classList: { add: () => {}, remove: () => {}, toggle: () => {}, contains: () => false },
  };
  return n;
}
function makeSandbox() {
  const reg = {};
  ["sidebar", "topbar", "sbToggle", "notifTop", "autTop", "pausebar", "resumeBtn"]
    .forEach((id) => { reg[id] = makeNode(id); });
  const document = {
    documentElement: makeNode("html"),
    body: makeNode("body"),
    getElementById: (id) => reg[id] || null,
    createElement: () => makeNode(""),
    addEventListener: () => {},
  };
  const store = {};
  const localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  };
  const sandbox = {
    window: { matchMedia: () => ({ matches: false }) },
    document, localStorage, console, URLSearchParams,
    location: { pathname: "/tasks", search: "?cid=proj1" },
    setTimeout: () => 0, clearTimeout: () => {},
    fetch: () => Promise.resolve({ ok: false }),
    // leaf UI wiring this test doesn't exercise (notif dropdown / pairing modal /
    // shell-cache priming) — stubbed no-ops, same convention as the other portal
    // vm-sandbox tests (stub only what genuinely can't run headless).
    wireNotifPill: () => {}, openPairingModal: () => {},
    saveShellCache: () => {}, primeShellFromCache: () => {},
  };
  sandbox.globalThis = sandbox;
  sandbox.window.document = document;
  sandbox.window.localStorage = localStorage;
  vm.createContext(sandbox);
  vm.runInContext(APP_STATE, sandbox);
  vm.runInContext(APP_TEXT, sandbox);
  vm.runInContext(APP_UI, sandbox);
  vm.runInContext(APP_DATA, sandbox);
  vm.runInContext(APP_AUTONOMY, sandbox);
  vm.runInContext(APP_SHELL, sandbox);
  return { sandbox, reg };
}

/* ---- fixture: the exact production shape — 62 tasks, all non-terminal
   statuses except a handful completed, ZERO needs_verification, plus some
   open/closed requests. This is what made the OLD badge read "0". ---- */
function taskRow(status) { return { id: "t-" + Math.random(), status }; }
function requestRow(status) { return { id: "r-" + Math.random(), status, target_id: null }; }

const FIXTURE_TASKS = []
  .concat(Array.from({ length: 40 }, () => taskRow("in_progress")))
  .concat(Array.from({ length: 15 }, () => taskRow("ready")))
  .concat(Array.from({ length: 5 }, () => taskRow("blocked")))
  .concat(Array.from({ length: 2 }, () => taskRow("completed")));
// 60 open (non-terminal) + 2 completed = 62 total, ZERO needs_verification.
const FIXTURE_REQUESTS = []
  .concat(Array.from({ length: 4 }, () => requestRow("open")))
  .concat(Array.from({ length: 3 }, () => requestRow("answered")))
  .concat(Array.from({ length: 1 }, () => requestRow("closed")));

const SNAPSHOT = {
  container: { id: "proj1", name: "quantal-health", autonomy_level: "plan" },
  agents: [],
  tasks: FIXTURE_TASKS,
  requests: FIXTURE_REQUESTS,
  task_total: 62,
  request_total: 8,
  task_open_total: 60,
  request_open_total: 4,
};

/* =====================================================================
   Case 1 — the reported bug, reproduced: WITHOUT the additive fields
   (an older cached snapshot), the sidebar and header must still agree —
   both fall back to counting the loaded window client-side.
   ===================================================================== */
console.log("Case 1 — fallback (no task_open_total/request_open_total on the snapshot)");
{
  const { sandbox, reg } = makeSandbox();
  const legacy = Object.assign({}, SNAPSHOT);
  delete legacy.task_open_total;
  delete legacy.request_open_total;
  vm.runInContext("applySnapshot(" + JSON.stringify(legacy) + ")", sandbox);
  vm.runInContext('mountShell("tasks", { title: "Tasks" })', sandbox);

  const sideHtml = reg.sidebar.innerHTML;
  const tasksBadge = sideHtml.match(/Tasks[\s\S]*?ncount[^>]*>(\d+)</);
  const requestsBadge = sideHtml.match(/Requests[\s\S]*?ncount[^>]*>(\d+)</);
  assert(!!tasksBadge, "sidebar renders a Tasks badge");
  assert(!!requestsBadge, "sidebar renders a Requests badge");
  assert(tasksBadge && tasksBadge[1] === "60",
    "Tasks badge falls back to counting non-terminal tasks in the loaded window (60), not needs_verification (0) — got " + (tasksBadge && tasksBadge[1]));
  assert(requestsBadge && requestsBadge[1] === "4",
    "Requests badge falls back to counting open requests in the loaded window (4) — got " + (requestsBadge && requestsBadge[1]));
}

/* =====================================================================
   Case 2 — the fixed path: WITH the additive snapshot fields, badge and
   header both read the SAME authoritative field. This is the actual
   production shape (a live backend always ships the fields now).
   ===================================================================== */
console.log("Case 2 — badge sourced from the additive snapshot fields");
{
  const { sandbox, reg } = makeSandbox();
  vm.runInContext("applySnapshot(" + JSON.stringify(SNAPSHOT) + ")", sandbox);
  vm.runInContext('mountShell("tasks", { title: "Tasks" })', sandbox);

  const sideHtml = reg.sidebar.innerHTML;
  const tasksBadge = sideHtml.match(/Tasks[\s\S]*?ncount[^>]*>(\d+)</);
  const requestsBadge = sideHtml.match(/Requests[\s\S]*?ncount[^>]*>(\d+)</);
  assert(tasksBadge && tasksBadge[1] === "60",
    "Tasks badge == task_open_total (60), NOT needs_verification (0, the old/broken reading) — got " + (tasksBadge && tasksBadge[1]));
  assert(requestsBadge && requestsBadge[1] === "4",
    "Requests badge == request_open_total (4) — got " + (requestsBadge && requestsBadge[1]));

  // the old semantics (needs_verification) must NOT be what's rendered — this is the
  // regression the bug report described: a badge of "0" next to a header of "62".
  assert(tasksBadge && tasksBadge[1] !== "0",
    "Tasks badge is NOT 0 (the reported-broken reading) despite zero needs_verification tasks");

  // no "attn" (warning-color) styling on the Tasks badge anymore — it's a routine
  // open-count now, not a needs-attention signal (that job moved to the Needs-you card).
  assert(!/Tasks[\s\S]*?ncount attn/.test(sideHtml),
    "Tasks badge no longer carries the 'attn' (warning-color) class — it's a routine count, not an alert");
}

/* =====================================================================
   Case 3 — badge == header-source pin. Both READ THE SAME accessor
   function (taskOpenTotal/requestOpenTotal), not independently-derived
   numbers that merely happen to agree today. Source-level pin so a future
   edit to either call site trips this test.
   ===================================================================== */
console.log("Case 3 — badge and header source-pinned to the same accessor (can't re-diverge)");
{
  const tasksBootSrc = fs.readFileSync(
    path.join(__dirname, "..", "..", "orcha-cli", "orcha_cli", "templates",
      "portal", "static", "pages", "tasks-boot.js"),
    "utf8"
  );
  const requestsStateSrc = fs.readFileSync(
    path.join(__dirname, "..", "..", "orcha-cli", "orcha_cli", "templates",
      "portal", "static", "pages", "requests-state.js"),
    "utf8"
  );
  assert(/count:\s*taskOpenTotal\(\)/.test(APP_SHELL),
    "sidebar Tasks badge count: taskOpenTotal() (mutation: revert to a needs_verification filter → RED)");
  assert(/count:\s*requestOpenTotal\(\)/.test(APP_SHELL),
    "sidebar Requests badge count: requestOpenTotal()");
  assert(/ctx:\s*taskOpenTotal\(\)/.test(tasksBootSrc),
    "Tasks page header ctx: taskOpenTotal() — the SAME accessor as the sidebar badge (mutation: revert to (TasD().tasks||[]).length → RED)");
  assert(/const open = requestOpenTotal\(\);/.test(requestsStateSrc),
    "Requests page header reads requestOpenTotal() — the SAME accessor as the sidebar badge");
}

/* =====================================================================
   Case 4 — accessor unit behavior directly (app-data.js), incl. the
   graceful-absence fallback contract.
   ===================================================================== */
console.log("Case 4 — taskOpenTotal()/requestOpenTotal() accessor contract");
{
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(
    APP_STATE + "\n" + APP_TEXT + "\n" + APP_DATA +
    "\nthis.taskOpenTotal = taskOpenTotal; this.requestOpenTotal = requestOpenTotal; this.D = D;",
    sandbox
  );
  // field present -> used verbatim, even if it disagrees with the loaded window
  // (proves the server field wins, not a recompute over tasks()/requests()).
  sandbox.D.task_open_total = 999;
  sandbox.D.request_open_total = 999;
  sandbox.D.tasks = FIXTURE_TASKS;
  sandbox.D.requests = FIXTURE_REQUESTS;
  assert(sandbox.taskOpenTotal() === 999, "taskOpenTotal() prefers D.task_open_total when present");
  assert(sandbox.requestOpenTotal() === 999, "requestOpenTotal() prefers D.request_open_total when present");

  // field absent (older/cached snapshot) -> graceful client-side fallback.
  delete sandbox.D.task_open_total;
  delete sandbox.D.request_open_total;
  assert(sandbox.taskOpenTotal() === 60, "taskOpenTotal() falls back to filtering the loaded tasks[] when the field is absent");
  assert(sandbox.requestOpenTotal() === 4, "requestOpenTotal() falls back to filtering the loaded requests[] when the field is absent");

  // terminal statuses excluded, ALL non-terminal ones included (not just a hardcoded pair).
  sandbox.D.tasks = [
    { status: "pending" }, { status: "ready" }, { status: "in_progress" },
    { status: "blocked" }, { status: "needs_verification" },
    { status: "completed" }, { status: "cancelled" },
  ];
  assert(sandbox.taskOpenTotal() === 5, "5 non-terminal statuses counted open; completed+cancelled excluded");
}

/* ---- summary --------------------------------------------------------- */
if (failures) { console.error(`\n${failures} assertion(s) FAILED`); process.exit(1); }
console.log("\nAll sidebar/header task-count assertions passed.");
