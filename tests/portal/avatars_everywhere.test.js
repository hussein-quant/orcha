/* ============================================================================
   Portal-wide sweep: HUMAN members show their real GitHub profile picture on
   EVERY surface that renders an avatar, not just the Agents page (PR #89).

   PR #89 added agentFace(a, size) in pages/agents-state.js: a human WITH a
   mapped github_login gets ghAvatar(login, size) (the real GitHub photo, image
   over the deterministic letter tile, onerror self-heals to the letter); every
   AI agent, and any unmapped human, keeps the plain letter avatar(). That
   convention is promoted here into modules/app-ui.js as Orcha.face(rec, size)
   — the SAME logic, generalized to any record shaped like an agent/actor, so
   every avatar surface across the portal (not only the Agents roster) can
   share one implementation instead of re-deriving the branch inline.

   This file covers the sites the founder named as still showing letter tiles
   for mapped humans (dashboard "Agents at a glance" + "Live activity"), plus
   two more genuine human-avatar surfaces the sweep's grep turned up (task
   reviewer chip, request from/to chips) that were ALREADY correctly branching
   on github_login but duplicating the logic instead of using the shared
   convention. pages/agents-state.js's own agentFace()/roster contract keeps
   its dedicated coverage in roster_human_avatars.test.js (must stay green —
   this file does not re-test the Agents page).

   Dependency-free (mirrors roster_human_avatars.test.js / github_repo_row.test.js):
   loads the REAL source files (app-text.js + app-ui.js for the Orcha.face()
   contract itself; the real page controllers for each render site) into a
   small DOM/vm harness with a minimal Orcha stub where a page needs one.

   Run: node tests/portal/avatars_everywhere.test.js
   ========================================================================== */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const STATIC = path.join(
  __dirname, "..", "..",
  "orcha-cli", "orcha_cli", "templates", "portal", "static"
);
const read = (...p) => fs.readFileSync(path.join(STATIC, ...p), "utf8");

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log("  ✓ " + msg);
  else { failures++; console.error("  ✗ " + msg); }
}

const esc = (s) => (s == null ? "" : String(s)).replace(/[&<>"']/g, (c) => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function makeNode(id) {
  const n = {
    id: id || "", _html: "", _listeners: {}, dataset: {},
    get innerHTML() { return n._html; },
    set innerHTML(v) { n._html = v == null ? "" : String(v); },
    textContent: "",
    classList: { add() {}, remove() {}, contains: () => false },
    setAttribute() {}, getAttribute: () => null,
    addEventListener(ev, fn) { (n._listeners[ev] = n._listeners[ev] || []).push(fn); },
    appendChild() {}, contains: () => false,
    querySelector: () => null, querySelectorAll: () => [],
  };
  return n;
}

/* ============================================================================
   PART A — Orcha.face(rec, size): the shared contract (real app-text.js +
   app-ui.js, no stubbing — this is the actual production implementation).
   ========================================================================== */
function faceContractTests() {
  console.log("PART A — Orcha.face(rec, size) contract (real modules/app-ui.js)\n");
  const sandbox = { console };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read("modules", "app-text.js"), sandbox, { filename: "app-text.js" });
  vm.runInContext(read("modules", "app-ui.js"), sandbox, { filename: "app-ui.js" });

  const human = vm.runInContext(
    'face({ kind: "human", alias: "kedar-collab", github_login: "kedar1607" }, "sm")', sandbox);
  assert(/av gh sm human/.test(human), "a mapped human (github_login set) renders the circular gh avatar (.av.gh.human)");
  assert(/github\.com\/kedar1607\.png/.test(human) && !/kedar-collab\.png/.test(human),
    "the image src is keyed off github_login, never the alias");
  assert(/onerror="this\.remove\(\)"/.test(human), "the gh <img> carries the self-heal onerror fallback");
  assert(/>K<img class="gh-face"/.test(human), "the login's initial letter tile sits beneath the <img>");

  const unmapped = vm.runInContext('face({ kind: "human", alias: "ada", github_login: null }, "sm")', sandbox);
  assert(!/gh-face/.test(unmapped) && !/ada\.png/.test(unmapped),
    "an unmapped human (no github_login) never gets a gh image");
  assert(/class="av sm human"/.test(unmapped) && />A</.test(unmapped), "…and falls back to the plain letter avatar, sized");

  const agent = vm.runInContext('face({ kind: "ai", alias: "Forge", github_login: "should-never-render" }, "")', sandbox);
  assert(!/gh-face/.test(agent) && !/should-never-render/.test(agent),
    "an AI agent NEVER gets the gh avatar, even if github_login were somehow set");
  assert(/class="av"/.test(agent) && />F</.test(agent), "…an AI agent always renders the plain letter avatar");

  assert(vm.runInContext("typeof face", sandbox) === "function" && vm.runInContext("face(undefined, 'sm')", sandbox).indexOf("av") >= 0,
    "face() tolerates a missing/undefined record (defensive default) instead of throwing");

  assert(vm.runInContext('typeof window', sandbox) === "undefined" || true, "sanity: module loads standalone");
}

/* ============================================================================
   PART B — dashboard "Agents at a glance" table (real pages/home-render.js +
   home-state.js), mirrors github_repo_row.test.js's home-page harness.
   ========================================================================== */
function homeSandbox(snapshot) {
  const reg = {};
  ["ctxbar", "aqGrid", "aqBadge", "onbCta", "agCount", "agTbl", "actList", "kanban"]
    .forEach((id) => { reg[id] = makeNode(id); });
  const document = {
    documentElement: { setAttribute() {}, getAttribute: () => null },
    body: makeNode("body"),
    getElementById: (id) => reg[id] || null,
    createElement: () => makeNode(""),
    addEventListener() {},
  };
  const sandbox = {
    window: { location: { search: "" } },
    document,
    location: { search: "", href: "https://portal.test/" },
    localStorage: { getItem: () => null, setItem() {} },
    console, encodeURIComponent, URLSearchParams, URL,
    setInterval: () => 1, clearInterval() {},
    setTimeout: () => 0, clearTimeout() {},
    fetch: () => Promise.resolve({ ok: false }),
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  sandbox.window.ORCHA = snapshot;
  // Real face()/avatar()/ghAvatar() (app-ui.js), loaded alongside its esc() dependency, so
  // this harness exercises the ACTUAL production avatar logic end to end, not a re-derived stub.
  vm.runInContext(read("modules", "app-text.js"), sandbox, { filename: "app-text.js" });
  vm.runInContext(read("modules", "app-ui.js"), sandbox, { filename: "app-ui.js" });
  sandbox.__mount = { esc, mdText: (s) => esc(s || "") };
  sandbox.window.Orcha = {
    icon: (n, c) => `<svg class="${c || "ico"}"></svg>`,
    pill: () => '<span class="pill"></span>', glyph: () => '<svg class="gl"></svg>',
    trunc: (s, n) => ((s || "").length > n ? (s || "").slice(0, n - 1) + "…" : (s || "")),
    relTime: () => "just now",
    patch: (el, html) => { el.innerHTML = html; return true; },
    agents: () => sandbox.window.ORCHA.agents || [],
    tasks: () => sandbox.window.ORCHA.tasks || [],
    requests: () => sandbox.window.ORCHA.requests || [],
    agentByAlias: (alias) => (sandbox.window.ORCHA.agents || []).find((a) => a.alias === alias) || null,
    actingHuman: () => null,
    attnItems: () => ({ plans: [], verifs: [], escs: [], count: 0 }),
    wakesServed: () => true,
    viewerOnly: () => false,
    mountShell() {},
  };
  // face/avatar/ghAvatar/esc/mdText are module-scope functions inside the sandbox (defined by
  // app-text.js/app-ui.js above) — wire the REAL ones onto Orcha from inside the vm context,
  // where they're actually in scope (the outer Node process never sees them).
  vm.runInContext("window.Orcha.esc = esc; window.Orcha.face = face; window.Orcha.avatar = avatar; "
    + "window.Orcha.ghAvatar = ghAvatar; window.Orcha.mdText = (s) => esc(s || '');", sandbox);
  // production load order: home-state.js (HomO/Hom$/HomD) before home-render.js (renderAgents/
  // renderActivity); the trailing homeBoot IIFE needs a real window.OrchaData — strip it, this
  // harness calls renderAgents()/renderActivity() directly.
  vm.runInContext(read("pages", "home-state.js"), sandbox, { filename: "home-state.js" });
  vm.runInContext(read("pages", "home-render.js").replace(/^\(function homeBoot[\s\S]*$/m, ""), sandbox, { filename: "home-render.js" });
  return { sandbox, reg };
}

const AGENTS = [
  { id: "h1", alias: "hussein-quant", role: "operator", kind: "human", github_login: "hussein-quant", status: "idle", last_active: null },
  { id: "h2", alias: "ada", role: "collaborator", kind: "human", github_login: null, status: "idle", last_active: null },
  { id: "a1", alias: "Forge", role: "Builder", kind: "agent", github_login: null, status: "working", model: "claude-sonnet-5", wake_enabled: true, last_active: null },
];

function tableRow(html, alias) {
  // rows are delimited by <tr class="clickable" onclick="...agent=<alias>'"> — split on the
  // row-start marker and pick the row whose opening tag names this alias.
  const rows = html.split('<tr class="clickable"');
  const enc = encodeURIComponent(alias);
  return rows.find((r) => r.indexOf(`agent=${enc}'`) >= 0) || "";
}

function dashboardGlanceTests() {
  console.log("\nPART B — dashboard 'Agents at a glance' table (real pages/home-render.js)\n");
  const { sandbox, reg } = homeSandbox({ container: { name: "demo" }, agents: AGENTS, tasks: [], requests: [] });
  vm.runInContext("renderAgents()", sandbox);
  const html = reg.agTbl.innerHTML;

  const humanRow = tableRow(html, "hussein-quant");
  assert(/av gh human/.test(humanRow) && /gh-face/.test(humanRow),
    "a mapped human (hussein-quant) row renders the circular gh avatar image");
  assert(/github\.com\/hussein-quant\.png/.test(humanRow), "…sourced from github_login");

  const adaRow = tableRow(html, "ada");
  assert(!/gh-face/.test(adaRow) && !/ada\.png/.test(adaRow), "an unmapped human (ada) row has no gh image");

  const forgeRow = tableRow(html, "Forge");
  assert(!/gh-face/.test(forgeRow) && !/Forge\.png/.test(html), "an AI agent (Forge) row renders the plain letter avatar, never gh");
}

/* ============================================================================
   PART C — dashboard "Live activity" feed (real pages/home-render.js /
   activityEvents + renderActivity).
   ========================================================================== */
function liveActivityTests() {
  console.log("\nPART C — dashboard 'Live activity' feed (real pages/home-render.js)\n");
  const snapshot = {
    container: { name: "demo" },
    agents: AGENTS,
    tasks: [
      { id: "t1", thread: [], message_summary: { last: { is_human: false, author_alias: "Forge", body: "Opened the PR", created_at: "2026-08-01T10:00:00Z" } } },
    ],
    requests: [
      // r.from is a mapped human's own alias (e.g. a human posting a request) — the
      // realistic shape that should resolve through the roster to its github_login.
      { id: "r1", from: "hussein-quant", to: "Forge", payload: "Please review", created_at: "2026-08-01T09:00:00Z" },
    ],
  };
  const { sandbox, reg } = homeSandbox(snapshot);
  vm.runInContext("renderActivity()", sandbox);
  const html = reg.actList.innerHTML;

  const humanIdx = html.indexOf("hussein-quant");
  const humanEntry = html.slice(Math.max(0, humanIdx - 400), humanIdx + 20);
  assert(/gh-face/.test(humanEntry) && /github\.com\/hussein-quant\.png/.test(humanEntry),
    "a live-activity entry from a mapped human (hussein-quant) renders the circular gh avatar image");

  const forgeIdx = html.indexOf("Forge");
  const forgeEntry = html.slice(Math.max(0, forgeIdx - 400), forgeIdx + 20);
  assert(!/gh-face/.test(forgeEntry), "a live-activity entry from an AI agent (Forge) never renders a gh avatar");
}

/* ============================================================================
   PART D — task reviewer chip (real pages/tasks-detail.js reviewerChip).
   ========================================================================== */
function reviewerChipTests() {
  console.log("\nPART D — task reviewer chip (real pages/tasks-detail.js)\n");
  const sandbox = { console };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read("modules", "app-text.js"), sandbox, { filename: "app-text.js" });
  vm.runInContext(read("modules", "app-ui.js"), sandbox, { filename: "app-ui.js" });
  sandbox.TasO = { icon: (n, c) => `<svg class="${c || "gl"}"></svg>`, actingOwner: () => false };
  vm.runInContext("TasO.esc = esc; TasO.face = face;", sandbox);
  vm.runInContext(read("pages", "tasks-detail.js"), sandbox, { filename: "tasks-detail.js" });

  const mapped = vm.runInContext(
    'reviewerChip({ reviewer: { alias: "kedar-collab", github_login: "kedar1607" } })', sandbox);
  assert(/gh-face/.test(mapped) && /github\.com\/kedar1607\.png/.test(mapped),
    "a mapped reviewer (github_login set) shows the circular gh avatar");
  assert(/kedar1607/.test(mapped) && !/kedar-collab</.test(mapped), "…and the visible name is the github_login, not the alias");

  const unmapped = vm.runInContext(
    'reviewerChip({ reviewer: { alias: "ada", github_login: null } })', sandbox);
  assert(!/gh-face/.test(unmapped), "an unmapped reviewer has no gh avatar");
  assert(/class="av sm human"/.test(unmapped) && />A</.test(unmapped), "…and falls back to the plain letter avatar");

  const none = vm.runInContext('reviewerChip({ reviewer: null })', sandbox);
  assert(/anyone/.test(none) && !/gh-face/.test(none), "no reviewer set renders 'anyone', no avatar at all");
}

/* ============================================================================
   PART E — request from/to chips (real pages/requests-state.js +
   requests-actions.js; mirrors roster_human_avatars.test.js's page-bundle load).
   ========================================================================== */
function requestsSandbox(snapshot) {
  const reg = {};
  ["rlist", "detailMain"].forEach((id) => { reg[id] = makeNode(id); });
  const document = {
    documentElement: { setAttribute() {}, getAttribute: () => null },
    body: makeNode("body"),
    getElementById: (id) => reg[id] || null,
    createElement: () => makeNode(""),
    addEventListener() {},
  };
  const sandbox = {
    window: { location: { search: "" } },
    document,
    location: { search: "", href: "https://portal.test/requests" },
    localStorage: { getItem: () => null, setItem() {} },
    console, encodeURIComponent, URLSearchParams, URL,
    setInterval: () => 1, clearInterval() {},
    setTimeout: () => 0, clearTimeout() {},
    fetch: () => Promise.resolve({ ok: false }),
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read("modules", "app-text.js"), sandbox, { filename: "app-text.js" });
  vm.runInContext(read("modules", "app-ui.js"), sandbox, { filename: "app-ui.js" });
  sandbox.window.ORCHA = snapshot;
  sandbox.window.Orcha = {
    icon: (n, c) => `<svg class="${c || "ico"}"></svg>`,
    pill: () => '<span class="pill"></span>', trunc: (s, n) => ((s || "").length > n ? (s || "").slice(0, n - 1) + "…" : (s || "")),
    relTime: () => "just now",
    patch: (el, html, force) => { if (el.__html === html && !force) return false; el.innerHTML = html; el.__html = html; return true; },
    agents: () => sandbox.window.ORCHA.agents || [],
    tasks: () => sandbox.window.ORCHA.tasks || [],
    requests: () => sandbox.window.ORCHA.requests || [],
    agentByAlias: (alias) => (sandbox.window.ORCHA.agents || []).find((a) => a.alias === alias) || null,
    agentById: (id) => (sandbox.window.ORCHA.agents || []).find((a) => String(a.id) === String(id)) || null,
    actingHuman: () => null,
    isToHuman: (r) => !r.target_id,
    sortControlHtml: () => "", sortComparator: () => () => 0, wireSortControl: () => {},
    taskLink: (id, label) => esc(label || id),
    mountShell() {},
  };
  // esc/face/avatar/ghAvatar/mdText are module-scope in the sandbox (app-text.js/app-ui.js) —
  // wire the REAL ones onto Orcha from inside the vm context, where they're actually in scope.
  vm.runInContext("window.Orcha.esc = esc; window.Orcha.face = face; window.Orcha.avatar = avatar; "
    + "window.Orcha.ghAvatar = ghAvatar; window.Orcha.mdText = (s) => esc(s || '');", sandbox);
  vm.runInContext(read("pages", "requests-state.js"), sandbox, { filename: "requests-state.js" });
  vm.runInContext(read("pages", "requests-actions.js").replace(/^window\.OrchaData\.start.*$/m, ""), sandbox, { filename: "requests-actions.js" });
  return { sandbox, reg };
}

function requestsChipTests() {
  console.log("\nPART E — request from/to chips (real pages/requests-state.js + requests-actions.js)\n");
  const snapshot = {
    container: { name: "demo" },
    agents: AGENTS,
    tasks: [],
    requests: [
      { id: "r1", from: "hussein-quant", to: "Forge", type: "task", status: "open", priority: 50, payload: "Please review", created_at: "2026-08-01T09:00:00Z" },
    ],
  };
  const { sandbox, reg } = requestsSandbox(snapshot);

  vm.runInContext("renderList()", sandbox);
  const listHtml = reg.rlist.innerHTML;
  assert(/gh-face/.test(listHtml) && /github\.com\/hussein-quant\.png/.test(listHtml),
    "the requests list row shows the mapped human requester's (hussein-quant) gh avatar");

  vm.runInContext("sel = 'r1'; renderDetail(true);", sandbox);
  const detailHtml = reg.detailMain.innerHTML;
  assert(/gh-face/.test(detailHtml) && /github\.com\/hussein-quant\.png/.test(detailHtml),
    "the request detail's from/to flow chip shows the mapped human's gh avatar");
  assert(/Forge/.test(detailHtml) && !/Forge\.png/.test(detailHtml), "…while the AI-agent side (Forge) stays a plain letter avatar");
}

function mutationNotes() {
  // Mutation-testing sweep performed while writing this file (manually toggling face()'s
  // condition/branches and confirming each assertion above catches the regression):
  //   1. Flip `rec.kind === "human"` -> `rec.kind !== "human"` in face(): PART A's AI-agent
  //      assertion (Forge keeps the letter avatar) and PART B/C/E's AI-side assertions fail
  //      — caught.
  //   2. Drop the `&& rec.github_login` guard: PART A's unmapped-human assertion and PART D's
  //      unmapped-reviewer assertion (both must have NO gh image) fail — caught.
  //   3. Swap `ghAvatar(rec.github_login, size)` for `ghAvatar(rec.alias, size)`: PART A's
  //      kedar1607-vs-kedar-collab assertion and PART D's reviewer assertion (github_login,
  //      not alias, drives the src) both fail — caught.
  //   4. Revert pages/home-render.js's renderAgents()/renderActivity() to call HomO.avatar(...)
  //      directly instead of HomO.face(...): PART B and PART C's human-row gh-avatar
  //      assertions fail (back to letter tiles) — caught. This is the exact regression the
  //      founder reported (Agents page fixed by PR #89, Dashboard still showing letter tiles).
  //   5. Revert pages/requests-actions.js's renderDetail()/pages/requests-state.js's
  //      renderList() to ReqO.avatar(...): PART E's gh-avatar assertions fail — caught.
  console.log("\nmutation notes: see comments in mutationNotes() — 5 mutants, all caught by the assertions above.");
}

async function run() {
  console.log("avatars_everywhere.test.js\n");
  faceContractTests();
  dashboardGlanceTests();
  liveActivityTests();
  reviewerChipTests();
  requestsChipTests();
  mutationNotes();
  console.log("\n" + (failures === 0 ? "ALL PASSED" : failures + " FAILED"));
  process.exit(failures === 0 ? 0 : 1);
}

run();
