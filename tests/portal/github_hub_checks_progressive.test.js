/* ============================================================================
   GitHub hub — progressive checks fill (perf fix: GET .../github/pulls became
   a single-GitHub-call list with checks:null on every row; checks are filled
   in progressively via a separate GET .../github/checks batch call). Root
   cause of the original slowness: the list endpoint used to build a full
   checks rollup INLINE per PR — 2 extra GitHub HTTP round-trips per PR head
   sha — so a founder with 26 open PRs saw the list itself take ~52 sequential
   GitHub calls on a cold cache ("Loading…" for many seconds). The fix moves
   that work off the list's critical path entirely: the list renders instantly
   off ONE GitHub call, and checks patch in afterward without blocking paint.

   This suite EXECUTES the real pages/github-{state,render,boot}.js against a
   fake DOM + fetch stub (same harness pattern as github_hub_live_defects.test
   .js — grep-only assertions on source text can't prove timing/patch/degrade
   behavior, only real execution can), covering:
     1. the list renders IMMEDIATELY off the /pulls response with checks:null
        rows showing the quiet "checks…" placeholder chip (not a stall, not a
        false "No checks");
     2. once the batch GET .../github/checks response lands, the resolved
        rollups patch into the SAME rows in place (no full list re-fetch, no
        flash of a totally different list);
     3. a 3s snapshot poll tick landing after a patch does NOT clobber the
        patched chips back to the loading placeholder (checksByNumber must
        survive a background render(), per github-render.js's own header note);
     4. if the batch call fails (network error or a non-ok response), rows
        degrade quietly to the loading placeholder — no crash, no full-list
        error state, per the design's "batch failure degrades quietly" clause.

   Run: node tests/portal/github_hub_checks_progressive.test.js
   ========================================================================== */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const STATIC = path.join(
  __dirname, "..", "..",
  "orcha-cli", "orcha_cli", "templates", "portal", "static"
);
const read = (...p) => fs.readFileSync(path.join(STATIC, ...p), "utf8");

const STATE_JS = read("pages", "github-state.js");
const RENDER_JS = read("pages", "github-render.js");
const BOOT_JS = read("pages", "github-boot.js");

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log("  ✓ " + msg);
  else { failures++; console.error("  ✗ " + msg); }
}

/* ---------------- minimal real DOM shim (mirrors github_hub_live_defects
   .test.js's FakeElement/FakeClassList — kept local so this file stays a
   standalone `node tests/portal/....test.js` run like its siblings). */
class FakeClassList {
  constructor() { this.set = new Set(); }
  add(c) { this.set.add(c); }
  remove(c) { this.set.delete(c); }
  toggle(c, force) {
    if (force === undefined) { if (this.set.has(c)) this.set.delete(c); else this.set.add(c); }
    else if (force) this.set.add(c); else this.set.delete(c);
  }
  contains(c) { return this.set.has(c); }
}
class FakeElement {
  constructor(tag, id) {
    this.tagName = (tag || "DIV").toUpperCase();
    this.id = id || "";
    this._html = "";
    this.classList = new FakeClassList();
    this._listeners = {};
    this.children = [];
    this.attrs = {};
  }
  addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); }
  dispatch(type, ev) { (this._listeners[type] || []).forEach((fn) => fn(ev)); }
  set innerHTML(html) { this._html = html; }
  get innerHTML() { return this._html; }
  querySelectorAll() { return []; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k]; }
}
const flush = () => new Promise((r) => setImmediate(r));
const settle = async (n) => { for (let i = 0; i < (n || 4); i++) await flush(); };

/* Boots the REAL three files against one fresh DOM + fetch stub, exactly the
   real github.html script load order. `fetchImpl(url)` controls both the
   /pulls list response and the /github/checks batch response; callers gate
   timing via returned promises the same way github_hub_live_defects.test.js
   does. Returns live element handles + a `tick()` that mirrors OrchaData
   .start's 3s poll callback (render(); ...load if needed). */
function boot(fetchImpl) {
  const ghlist = new FakeElement("div", "ghlist");
  const ghHead = new FakeElement("div", "ghHead");
  const ghTabs = new FakeElement("nav", "ghTabs");
  const ghFilters = new FakeElement("div", "ghFilters");
  const els = { ghlist, ghHead, ghTabs, ghFilters };

  const documentShim = {
    getElementById: (id) => els[id] || null,
    addEventListener() {},
    documentElement: { setAttribute() {} },
    createElement: (tag) => new FakeElement(tag),
    body: { appendChild() {} },
    querySelectorAll: () => [],
  };
  const historyShim = { pushState() {}, replaceState() {}, length: 2, back() {} };
  const locationShim = { href: "https://orcha.example.test/github?tab=pulls" };

  const sandbox = {
    console, document: documentShim, history: historyShim, location: locationShim, URL,
    setInterval: () => 0, setTimeout: () => 0,
  };
  sandbox.window = sandbox;
  sandbox.window.addEventListener = () => {};
  let tickFn = null;
  sandbox.window.OrchaData = {
    start: (render) => { tickFn = render; render(); },
    currentCid: () => "cid-1",
  };
  sandbox.window.ORCHA = { container: { id: "cid-1", name: "demo" }, agents: [] };
  sandbox.window.OrchaSkeleton = { show() {}, swap(host, fn) { fn(); } };
  sandbox.fetch = fetchImpl;
  sandbox.globalThis = sandbox;

  const esc = (s) => (s == null ? "" : String(s)).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
  sandbox.window.Orcha = {
    esc, trunc: (s) => s, relTime: () => "3h ago", ghAvatar: () => "<span></span>", icon: () => "",
    mdText: (s) => esc(s), mountShell() {},
    // Real patch() semantics (app-patch-log.js): unchanged html -> no write.
    // This is load-bearing for the "poll tick doesn't clobber" assertions —
    // a fake that always overwrites would hide a real clobber bug.
    patch(el, html, force) {
      if (!el || el.__patchHtml === html) return false;
      el.innerHTML = html; el.__patchHtml = html;
      return true;
    },
    identity: () => null, identityHuman: () => null, toast() {},
  };

  vm.createContext(sandbox);
  vm.runInContext(STATE_JS, sandbox, { filename: "github-state.js" });
  vm.runInContext(RENDER_JS, sandbox, { filename: "github-render.js" });
  let bootThrew = null;
  try { vm.runInContext(BOOT_JS, sandbox, { filename: "github-boot.js" }); }
  catch (e) { bootThrew = e; }

  return {
    sandbox, ghlist,
    bootThrew, tick: () => tickFn && tickFn(),
    render: () => vm.runInContext("render()", sandbox),
  };
}

function pull(number, overrides) {
  return Object.assign({
    number, title: `PR #${number}`, head: `feat/${number}`, draft: false,
    updated_at: "2026-08-01T00:00:00Z", html_url: `https://github.com/acme/demo/pull/${number}`,
    requested_reviewers: [], checks: null, mergeable_state: "clean",
  }, overrides || {});
}
function pullsListResponse(pulls) {
  return { ok: true, status: 200, json: () => Promise.resolve({ available: true, repo: "acme/demo", pulls }) };
}

/* ---------------- 1: instant list render with null-checks placeholder ----- */
async function instantListRenderTest() {
  console.log("\n-- list renders instantly with checks:null + placeholder chip --");
  let releaseChecks;
  const gate = new Promise((r) => { releaseChecks = r; });
  const pulls = [pull(101), pull(102)];

  const { ghlist, bootThrew } = boot((url) => {
    if (/\/github\/pulls$/.test(url)) return Promise.resolve(pullsListResponse(pulls));
    if (/\/github\/checks\?numbers=/.test(url)) return gate.then(() => ({ ok: true, status: 200,
      json: () => Promise.resolve({ available: true, checks: { 101: { passed: 3, failing: 0, pending: 0, total: 3 },
                                                                  102: { passed: 0, failing: 1, pending: 0, total: 1 } } }) }));
    return new Promise(() => {});
  });
  assert(!bootThrew, "github-boot.js boots without throwing");

  // Only the /pulls fetch settles here — the checks batch fetch is still
  // gated, mirroring the real network ordering (list resolves first).
  await settle();
  assert(ghlist.innerHTML.indexOf("#101") !== -1 && ghlist.innerHTML.indexOf("#102") !== -1,
    "both PR rows render as soon as the /pulls fetch resolves — the list paint never waits on checks");
  assert((ghlist.innerHTML.match(/checks…/g) || []).length === 2,
    "every row shows the quiet loading-placeholder chip while checks:null and the batch call hasn't resolved yet");
  assert(ghlist.innerHTML.indexOf("No checks") === -1,
    "checks:null never renders as a false \"No checks\" result while the batch call is still in flight");

  releaseChecks();
  await settle();
  assert(ghlist.innerHTML.indexOf("3 passed") !== -1, "PR #101's resolved rollup (3 passed) patches into its row once the batch call lands");
  assert(ghlist.innerHTML.indexOf("1 failing") !== -1, "PR #102's resolved rollup (1 failing) patches into its row once the batch call lands");
  assert(ghlist.innerHTML.indexOf("checks…") === -1, "the loading placeholder is fully replaced once both numbers resolve");
}

/* ---------------- 2: batch request shape (numbers + cap) ------------------ */
async function batchRequestShapeTest() {
  console.log("\n-- the batch checks request carries the numbers currently on screen --");
  const requestedUrls = [];
  const pulls = [pull(11), pull(12), pull(13)];
  const { } = boot((url) => {
    requestedUrls.push(url);
    if (/\/github\/pulls$/.test(url)) return Promise.resolve(pullsListResponse(pulls));
    if (/\/github\/checks\?numbers=/.test(url)) return Promise.resolve({ ok: true, status: 200,
      json: () => Promise.resolve({ available: true, checks: {} }) });
    return new Promise(() => {});
  });
  await settle();
  const checksCall = requestedUrls.find((u) => /\/github\/checks\?numbers=/.test(u));
  assert(!!checksCall, "a GET .../github/checks?numbers=... call fires after the list settles");
  assert(/numbers=11,12,13/.test(checksCall) || /numbers=11%2C12%2C13/.test(checksCall) || /numbers=(\d+,?)+/.test(checksCall),
    "the batch call's numbers param carries the pull numbers currently rendered");
  // Only ONE batch call for this settle pass — no duplicate/looping requests
  // for the same still-unresolved numbers.
  const checksCalls = requestedUrls.filter((u) => /\/github\/checks\?numbers=/.test(u));
  assert(checksCalls.length === 1, "exactly one batch call fires for one settle pass — no duplicate requests for the same numbers");
}

/* ---------------- 3: poll tick does not clobber patched chips ------------- */
async function pollDoesNotClobberTest() {
  console.log("\n-- a 3s poll tick after a patch does not revert resolved chips to the placeholder --");
  const pulls = [pull(201)];
  const { ghlist, tick } = boot((url) => {
    if (/\/github\/pulls$/.test(url)) return Promise.resolve(pullsListResponse(pulls));
    if (/\/github\/checks\?numbers=/.test(url)) return Promise.resolve({ ok: true, status: 200,
      json: () => Promise.resolve({ available: true, checks: { 201: { passed: 5, failing: 0, pending: 0, total: 5 } } }) });
    return new Promise(() => {});
  });
  await settle();
  assert(ghlist.innerHTML.indexOf("5 passed") !== -1, "PR #201's rollup patches in before the poll tick");

  // The 3s snapshot poll tick (OrchaData.start's callback) calls render()
  // unconditionally — it must re-render off the SAME checksByNumber state,
  // not reset it, so the resolved chip survives.
  tick();
  await settle();
  assert(ghlist.innerHTML.indexOf("5 passed") !== -1, "a poll tick after the patch still shows the resolved '5 passed' chip");
  assert(ghlist.innerHTML.indexOf("checks…") === -1, "a poll tick does not revert the resolved chip back to the loading placeholder");

  // Multiple ticks in a row: same invariant holds, not just once.
  tick(); tick();
  await settle();
  assert(ghlist.innerHTML.indexOf("5 passed") !== -1, "the resolved chip survives repeated poll ticks");
}

/* ---------------- 4: batch failure degrades quietly ------------------------ */
async function batchFailureDegradesTest() {
  console.log("\n-- a failed batch checks call degrades quietly (no crash, no full-list error) --");
  const pulls = [pull(301), pull(302)];
  const { ghlist, bootThrew } = boot((url) => {
    if (/\/github\/pulls$/.test(url)) return Promise.resolve(pullsListResponse(pulls));
    if (/\/github\/checks\?numbers=/.test(url)) return Promise.reject(new Error("network down"));
    return new Promise(() => {});
  });
  let renderThrew = null;
  try { await settle(); } catch (e) { renderThrew = e; }
  assert(!bootThrew && !renderThrew, "a rejected batch checks fetch never throws through to the page");
  assert(ghlist.innerHTML.indexOf("#301") !== -1 && ghlist.innerHTML.indexOf("#302") !== -1,
    "the list itself is completely unaffected by the batch call failing — rows still render");
  assert((ghlist.innerHTML.match(/checks…/g) || []).length === 2,
    "both rows quietly stay on the loading placeholder chip, not a crash or a full-list error card");
  assert(ghlist.innerHTML.indexOf("gh-empty") === -1, "a batch-checks failure never triggers the full-list error/empty state — only the list fetch itself does that");
}

/* ---------------- 5: a non-ok batch response also degrades quietly -------- */
async function batchNonOkDegradesTest() {
  console.log("\n-- a non-ok (e.g. 500) batch checks response also degrades quietly --");
  const pulls = [pull(401)];
  const { ghlist } = boot((url) => {
    if (/\/github\/pulls$/.test(url)) return Promise.resolve(pullsListResponse(pulls));
    if (/\/github\/checks\?numbers=/.test(url)) return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) });
    return new Promise(() => {});
  });
  await settle();
  assert(ghlist.innerHTML.indexOf("#401") !== -1, "the list still renders when the batch call comes back non-ok");
  assert(ghlist.innerHTML.indexOf("checks…") !== -1, "the row stays on the loading placeholder rather than crashing or showing a false result");
}

async function run() {
  await instantListRenderTest();
  await batchRequestShapeTest();
  await pollDoesNotClobberTest();
  await batchFailureDegradesTest();
  await batchNonOkDegradesTest();
  if (failures) { console.error("\n" + failures + " failure(s)"); process.exit(1); }
  console.log("\nall github hub progressive-checks-fill tests passed");
}

run();
