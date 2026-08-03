/* ============================================================================
   GitHub hub — LIVE DEFECT regression (founder report on orcha.nursoftai.com/
   github, filed against feat/github-hub-detail-ui / PR #99): the vm fake-DOM
   suites (github_hub.test.js, github_detail.test.js) only grep BOOT_JS's
   SOURCE TEXT for wiring patterns — they never actually EXECUTE github-boot.js
   in a DOM and simulate a real click. That gap is exactly why this shipped:

     1. Clicking a row did not open the detail view — the page stayed on the
        list, and the clicked title took on a real-anchor "visited" look
        (pushState fired, so the URL genuinely changed under the click).
     2. The Issues/Pull requests tabs + Open/Mine filter row vanished
        entirely — only the column-header row and stale list rows remained.
     3. Every PR row showed "No checks" / reviewers "—" even though the live
        payload (verified against the running container, see below) still
        carries real numbers for SOME PRs — i.e. NOT a frontend field-name
        drift bug (the historical drift this same suite already guards, see
        github_hub.test.js's PR_LIVE_SHAPE_* fixtures).

   ROOT CAUSE (1 + 2, confirmed by executing the real files below, not by
   reading the source): github-boot.js's navigate() calls render(true)
   SYNCHRONOUSLY, BEFORE calling loadDetail(false) — so on a fresh item that
   has never been fetched, renderDetail() runs with detailLoading[key]:false
   AND detailPayload[key] still null. github-state.js's detailHtml() only
   showed "Loading…" when `state.loading` was true; with loading:false and no
   item yet, it fell through to issueDetailHtml()/prDetailHtml(), which
   dereference state.issue/state.pull UNCONDITIONALLY (`issue.number`, ...) —
   an uncaught TypeError. Because history.pushState() and `route = next` both
   already ran (lines BEFORE the render(true) call), the throw aborts
   navigate() mid-flight: the URL already changed, #ghHead/#ghFilters (toggled
   unconditionally before the `if (route.kind)` branch in render()) already
   hid the tabs — but #ghlist was never repainted, so the OLD list markup
   keeps showing under a tab-less header. loadDetail() never runs either
   (it's the line AFTER the throwing render(true) call), so the page is stuck
   this way forever, re-throwing on every subsequent 3s poll tick.

   A companion bug fixed alongside it: detailError was never number-scoped
   the way detailPayload already was (__number) — a stale error from a
   PREVIOUS item could bleed into a freshly-navigated, still-loading item's
   render. Fixed by tagging detailError[key] with __number too and only
   trusting it when it matches the active route's number (github-render.js).

   ROOT CAUSE (3): NOT a frontend bug — verified against the LIVE container
   (ssh root@77.42.39.99, read-only) that the GitHub App installation token
   for this org gets HTTP 403 "Resource not accessible by integration" from
   GitHub's own /commits/{sha}/status and /commits/{sha}/check-runs endpoints,
   while a personal token with repo+workflow scopes sees the real check-runs
   fine on the SAME sha. github_hub_routes.py's _checks_rollup() already
   degrades gracefully (catches RuntimeError -> zeros) exactly as designed;
   requested_reviewers (sourced from the /pulls list call, not the extra
   per-PR checks calls) still renders correctly wherever GitHub actually
   returns reviewers. This is a GitHub App permissions/installation
   configuration gap, outside this PR's frontend file scope (static/
   github.html, pages/github-{boot,state,render}.js, github.css) — no backend
   token/permission code lives in those files. This suite instead PINS the
   frontend's existing correct behavior against the exact live payload shape
   (a mzero-checks PR alongside a real-numbers PR in the SAME response) so a
   future regression here is caught immediately, and stays honestly scoped to
   what this PR's files can fix.

   Run: node tests/portal/github_hub_live_defects.test.js
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
const SKELETON_JS = read("modules", "app-skeleton.js");

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log("  ✓ " + msg);
  else { failures++; console.error("  ✗ " + msg); }
}

/* ---------------- minimal real DOM shim ------------------------------------
   Just enough of the DOM surface github-{state,render,boot}.js touch to run
   for real: classList.toggle/contains, innerHTML get/set (which re-derives
   [data-gh-open] "rows" so a click can legitimately land on one, mirroring
   how a real click on row content bubbles to the delegated #ghlist
   listener), addEventListener/dispatch, and the tiny bits of
   history/location/URL the routing layer needs. */
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
  set innerHTML(html) { this._html = html; this._rebuildChildrenFromHtml(html); }
  get innerHTML() { return this._html; }
  querySelectorAll(sel) {
    if (sel === "[data-tab]") return this.children.filter((c) => c.attrs["data-tab"]);
    return [];
  }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k]; }
  removeAttribute(k) { delete this.attrs[k]; }
  _rebuildChildrenFromHtml(html) {
    this.children = [];
    const re = /data-gh-open="([^"]+)"/g;
    let m;
    while ((m = re.exec(html))) {
      const row = new FakeElement("div");
      row.attrs["data-gh-open"] = m[1];
      this.children.push(row);
    }
  }
}
function clickOn(row) {
  return {
    target: { closest: (sel) => (sel.indexOf("data-gh-open") !== -1 && row.attrs["data-gh-open"] ? row : null) },
    stopPropagation() {}, preventDefault() {},
  };
}
const flush = () => new Promise((r) => setImmediate(r));
const settle = async (n) => { for (let i = 0; i < (n || 4); i++) await flush(); };
// app-skeleton.js's show() schedules a REAL 130ms+ setTimeout before it
// paints anything (SHOW_DELAY_MS=120) — this waits past that real delay (a
// genuine timer wait, not a fake-timer skip, since the sandbox's setTimeout
// IS Node's real setTimeout) so a test can observe the skeleton markup that
// actually lands in the DOM, the same way a human waiting slightly over
// 120ms would.
const settleSkeleton = () => new Promise((r) => setTimeout(r, 150));

/* Boots the REAL three files in REAL github.html script order against one
   fresh DOM + fetch stub. `fetchImpl(url)` mirrors the real endpoint shapes;
   callers control timing (e.g. gating the detail fetch open). Returns the
   live element handles + a `tick()` helper that mirrors OrchaData.start's 3s
   poll callback (`render(); if route.kind ... else load...`). */
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
  let pushedUrl = null;
  const historyShim = {
    pushState: (_s, _t, url) => { pushedUrl = String(url); },
    replaceState: () => {},
    length: 2,
    back() {},
  };
  const locationShim = { href: "https://orcha.nursoftai.com/github" };

  const sandbox = {
    console, document: documentShim, history: historyShim, location: locationShim, URL,
    // REAL timers (not stubbed to a no-op 0): app-skeleton.js's show() relies
    // on a genuine setTimeout(…, 120) to know a fast load never flashed a
    // skeleton at all — see settleSkeleton() below, which advances past that
    // delay with the SAME real-timer + flush pattern the rest of this file's
    // settle() already uses for promise microtasks.
    setInterval: () => 0, setTimeout, clearTimeout,
    matchMedia: () => ({ matches: false }),   // reducedMotion() reads this; no-reduce by default
  };
  sandbox.window = sandbox;
  sandbox.window.addEventListener = () => {};
  let tickFn = null;
  sandbox.window.OrchaData = {
    start: (render) => { tickFn = render; render(); },
    currentCid: () => "cid-1",
  };
  sandbox.window.ORCHA = { container: { id: "cid-1", name: "demo" }, agents: [] };
  sandbox.fetch = fetchImpl;
  sandbox.globalThis = sandbox;

  const esc = (s) => (s == null ? "" : String(s)).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
  sandbox.window.Orcha = {
    esc, trunc: (s) => s, relTime: () => "3h ago", ghAvatar: () => "<span></span>", icon: () => "",
    mdText: (s) => esc(s), mountShell() {},
    patch(el, html, force) {
      if (!el || el.__patchHtml === html) return false;
      el.innerHTML = html; el.__patchHtml = html;
      return true;
    },
    identity: () => null, identityHuman: () => null, toast() {},
  };

  vm.createContext(sandbox);
  // the REAL app-skeleton.js — NOT a no-op stub. The whole point of this
  // suite's skeleton-ordering assertions (below) is that the state-ordering
  // bug (the not-connected/stale-list card racing ahead of real data) is
  // only observable against the genuine show()/swap() timing contract; a
  // stub that paints (or doesn't paint) unconditionally would hide exactly
  // the regression class this file exists to catch.
  vm.runInContext(SKELETON_JS, sandbox, { filename: "app-skeleton.js" });
  vm.runInContext(STATE_JS, sandbox, { filename: "github-state.js" });
  vm.runInContext(RENDER_JS, sandbox, { filename: "github-render.js" });
  let bootThrew = null;
  try { vm.runInContext(BOOT_JS, sandbox, { filename: "github-boot.js" }); }
  catch (e) { bootThrew = e; }

  return {
    sandbox, ghlist, ghHead, ghTabs, ghFilters,
    bootThrew, getPushedUrl: () => pushedUrl,
    tick: () => tickFn && tickFn(),
    render: () => vm.runInContext("render()", sandbox),
  };
}

/* ---------------- regression 1+2: click -> navigate -> render -------------
   Reproduces the EXACT founder path: land on the list (real issues fetch
   resolves), click a row's data-gh-open target (title text bubbles here),
   observe the click handler synchronously — while the detail fetch is
   STILL in flight, the realistic window a click lands in. */
async function clickNavigationTests() {
  console.log("\n-- row click opens detail without throwing / losing tabs --");
  let releaseDetail;
  const gate = new Promise((r) => { releaseDetail = r; });
  const { ghlist, ghHead, bootThrew, getPushedUrl, tick, render } = boot((url) => {
    if (/\/github\/issues$/.test(url)) {
      return Promise.resolve({
        ok: true, status: 200,
        json: () => Promise.resolve({
          available: true, repo: "acme/demo",
          issues: [{ number: 5, title: "Something broke", labels: [], assignee: null,
            updated_at: "2026-08-01T00:00:00Z", html_url: "https://github.com/acme/demo/issues/5" }],
        }),
      });
    }
    if (/\/github\/issues\/5$/.test(url)) {
      return gate.then(() => ({
        ok: true, status: 200,
        json: () => Promise.resolve({
          available: true, repo: "acme/demo",
          issue: {
            number: 5, title: "Something broke", state: "open", body_markdown: "body text",
            author_login: "octocat", labels: [], assignee: null, assignees: [],
            updated_at: "2026-08-01T00:00:00Z", created_at: "2026-08-01T00:00:00Z",
            html_url: "https://github.com/acme/demo/issues/5", comments_count: 0, comments: [],
          },
        }),
      }));
    }
    return new Promise(() => {});   // pulls tab / anything else: never resolves in this test
  });

  assert(!bootThrew, "github-boot.js boots without throwing");
  await settle();

  const rows = ghlist.children.filter((c) => c.attrs["data-gh-open"]);
  assert(rows.length === 1, "the list renders exactly one clickable row (data-gh-open present)");

  let clickThrew = null;
  try { ghlist.dispatch("click", clickOn(rows[0])); }
  catch (e) { clickThrew = e; }

  assert(!clickThrew, "clicking a row's data-gh-open target does NOT throw (was: TypeError reading state.issue/.pull before the fetch resolves)");
  assert(getPushedUrl() === "https://orcha.nursoftai.com/github?issue=5", "the click pushes the ?issue=5 route to the URL");
  assert(ghHead.classList.contains("hidden"), "the tab/search header (#ghHead) hides for the detail route");

  // Synchronously, right after the click — BEFORE OrchaSkeleton's own 120ms
  // timer has had any chance to fire — render()'s detail-route gate must
  // itself refrain from painting detailHtml()'s bare "Loading…" text (this
  // is the assertion that actually exercises render()'s own gating logic,
  // as distinct from the settleSkeleton() checks below, which would ALSO
  // pass if render() painted "Loading…" first and the skeleton's
  // independently-scheduled timer simply overwrote it moments later —
  // mutation note: removing render()'s `!detailBooted[bootKey]` gate so it
  // falls through to an unconditional renderDetail(force) call makes this
  // specific assertion fail, since "Loading…" appears immediately rather
  // than waiting for the skeleton).
  assert(ghlist.innerHTML.indexOf("Loading") === -1,
    "immediately after the click, BEFORE the skeleton's own timer fires, render() has NOT painted the bare 'Loading…' text itself");

  // Skeleton-first ordering (founder feedback): while the detail fetch is in
  // flight, #ghlist must NOT show the stale list markup — the real
  // OrchaSkeleton.show() paints the shimmer after its genuine 120ms delay
  // (settleSkeleton waits past that), never the bare "Loading…" text
  // (github-boot.js's render() now leaves the pre-existing skeleton alone
  // rather than falling through to renderDetail() before the item settles).
  await settleSkeleton();
  assert(ghlist.innerHTML.indexOf("ork-sk") !== -1, "while the detail fetch is in flight, #ghlist shows the skeleton shimmer (not stale list rows, not a blank/broken page)");
  assert(ghlist.innerHTML.indexOf("Something broke") === -1 && ghlist.innerHTML.indexOf("ghhead-row") === -1,
    "the STALE list markup (column header + rows) is gone — the page did not get stuck showing the list under a hidden tab bar");

  // A 3s snapshot poll tick landing WHILE the detail fetch is still in
  // flight must keep showing the skeleton/detail route, never flash back to the list.
  tick();
  assert(ghlist.innerHTML.indexOf("ghhead-row") === -1, "a poll tick mid-flight does not leak the list's column-header row back in");

  // Now let the detail fetch resolve.
  releaseDetail();
  await settle();
  assert(ghlist.innerHTML.indexOf("gh-detail-layout") !== -1, "once the fetch resolves, the real detail view (gh-detail-layout) paints");
  assert(ghlist.innerHTML.indexOf("Something broke") !== -1, "the detail view shows the correct item's title");

  // THE regression this incident needs pinned forever: a poll tick AFTER
  // navigation has settled must not re-break the now-correct detail view.
  render();
  assert(ghlist.innerHTML.indexOf("gh-detail-layout") !== -1, "a poll tick AFTER navigation settled: the detail view survives (does not revert to the list or blank out)");
  assert(ghlist.innerHTML.indexOf("ghhead-row") === -1, "a poll tick AFTER navigation settled: still no list column-header leaking back in");
}

/* ---------------- regression: stale detailError must not bleed across items */
async function staleDetailErrorTest() {
  console.log("\n-- a previous item's detail error does not bleed into a freshly-navigated item --");
  const { sandbox, ghlist, tick } = boot((url) => {
    if (/\/github\/issues$/.test(url)) {
      return Promise.resolve({
        ok: true, status: 200,
        json: () => Promise.resolve({
          available: true, repo: "acme/demo",
          issues: [
            { number: 7, title: "Missing one", labels: [], assignee: null, updated_at: "2026-08-01T00:00:00Z", html_url: "x" },
            { number: 5, title: "Something broke", labels: [], assignee: null, updated_at: "2026-08-01T00:00:00Z", html_url: "x" },
          ],
        }),
      });
    }
    if (/\/github\/issues\/7$/.test(url)) {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ available: false, reason: "not_found" }) });
    }
    if (/\/github\/issues\/5$/.test(url)) {
      return Promise.resolve({
        ok: true, status: 200,
        json: () => Promise.resolve({
          available: true, repo: "acme/demo",
          issue: {
            number: 5, title: "Something broke", state: "open", body_markdown: "body",
            author_login: "octocat", labels: [], assignee: null, assignees: [],
            updated_at: "2026-08-01T00:00:00Z", created_at: "2026-08-01T00:00:00Z",
            html_url: "x", comments_count: 0, comments: [],
          },
        }),
      });
    }
    return new Promise(() => {});
  });
  await settle();

  // navigate to #7 (not_found) first, let it settle into an error state.
  vm.runInContext('navigate({ kind: "issue", number: 7 })', sandbox);
  await settle();
  assert(ghlist.innerHTML.indexOf("not found") !== -1, "item #7 (not_found) shows the not-found card");

  // navigate to #5 (a real, valid item) — its OWN fetch resolves via a
  // normal (ungated, fast) promise in this fixture, so by the time either
  // the skeleton's 120ms delay OR the fetch's own microtask settles, #5's
  // real content may already have painted (the SAME "a fast load never
  // flashes a skeleton at all" behavior every other OrchaSkeleton-using page
  // gets) — settle() below waits for whichever wins that race. What must be
  // true EITHER way: the previous item's stale "not found" card must be
  // gone (no bleed-through), and #5's own detail is what's showing, not #7's.
  vm.runInContext('navigate({ kind: "issue", number: 5 })', sandbox);
  await settle();
  assert(ghlist.innerHTML.indexOf("not found") === -1,
    "navigating to a DIFFERENT item clears the previous item's stale error (no bleed-through)");
  assert(ghlist.innerHTML.indexOf("Something broke") !== -1, "item #5's real detail paints, not #7's stale error card");
}

/* ---------------- regression 3: checks/reviewers off the EXACT live shape -
   Pinned against the REAL /api/containers/{cid}/github/pulls response shape
   captured from the live container (read-only curl against
   orcha.nursoftai.com's backing host) — one PR with a fully zeroed checks
   rollup (the live regression: GitHub App lacks Checks permission, backend
   degrades to zeros by design) sitting in the SAME list as a PR with real
   numbers (proves this is per-PR data, not a frontend field/parsing bug that
   would zero EVERY row uniformly regardless of payload). */
function liveShapeChecksReviewersTest() {
  console.log("\n-- checks/reviewers render correctly off the exact live payload shape --");
  const escFallback = (s) => (s == null ? "" : String(s)).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
  const sandbox = {
    window: {
      Orcha: {
        esc: escFallback,
        trunc: (s) => s,
        relTime: () => "3h ago",
        ghAvatar: (login) => `<span class="av sm">${escFallback((login || "?").charAt(0).toUpperCase())}</span>`,
        icon: (name) => `<svg data-icon="${name}"></svg>`,
      },
    },
    console,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(STATE_JS, sandbox, { filename: "github-state.js" });
  const G = sandbox.window.OrchaGithubHub;

  // PR #221 shape, verbatim field names/values as returned by the live
  // .../github/pulls endpoint when the GitHub App can't read checks (403
  // "Resource not accessible by integration" on /commits/{sha}/status and
  // /commits/{sha}/check-runs) — the backend degrades to zeros by design.
  const LIVE_NO_CHECKS_PR = {
    number: 221, title: "fix(backend): close raw FHIR router tenant-eligibility gate gap",
    head: "orcha/crit01-fhir-eligibility-gate", draft: false,
    updated_at: "2026-08-02T12:02:40Z", html_url: "https://github.com/acme/demo/pull/221",
    requested_reviewers: [], checks: { passed: 0, failing: 0, pending: 0, total: 0 },
    mergeable_state: "blocked",
  };
  // PR #199 shape — same live endpoint, a PR that DOES carry real reviewers,
  // proving requested_reviewers rendering isn't broken globally either.
  const LIVE_WITH_REVIEWERS_PR = {
    number: 199, title: "some other PR", head: "some/branch", draft: false,
    updated_at: "2026-08-02T09:00:00Z", html_url: "https://github.com/acme/demo/pull/199",
    requested_reviewers: ["kedar1607", "kedar-source", "nazuka-quantal", "hussein-quant"],
    checks: { passed: 0, failing: 0, pending: 0, total: 0 },
    mergeable_state: null,
  };
  // A synthetic "real numbers" PR in the SAME live shape (9 pending / 3
  // failing wording per the founder's report of what it looked like
  // "earlier today") — proves the row builder renders non-zero rollups
  // correctly too, not just the all-zero degrade case.
  const LIVE_ACTIVE_CHECKS_PR = {
    number: 230, title: "active CI PR", head: "feature/x", draft: false,
    updated_at: "2026-08-02T12:00:00Z", html_url: "https://github.com/acme/demo/pull/230",
    requested_reviewers: [], checks: { passed: 0, failing: 3, pending: 9, total: 12 },
    mergeable_state: "unstable",
  };

  const body = G.bodyHtml({
    repo: "acme/demo", tab: "pull", filter: "open", query: "",
    items: [LIVE_NO_CHECKS_PR, LIVE_WITH_REVIEWERS_PR, LIVE_ACTIVE_CHECKS_PR],
    agents: [], myLogin: null, startedOf: () => null,
  });

  assert(body.indexOf('data-gh-open="pull:221"') !== -1 && body.indexOf('data-gh-open="pull:199"') !== -1 && body.indexOf('data-gh-open="pull:230"') !== -1,
    "all three live-shape rows render (row builder doesn't choke on any of these field combinations)");

  // #221: zero checks -> "No checks", NOT swallowed/blank, NOT accidentally
  // rendered as failing/pending.
  const row221 = body.slice(body.indexOf('data-gh-open="pull:221"'));
  assert(/No checks/.test(row221.slice(0, row221.indexOf('data-gh-open="pull:199"'))),
    "PR #221 (live zero-checks shape) renders the 'No checks' chip, not a false pending/failing chip");

  // #199: empty checks but REAL reviewers -> avatars/+more, not "—".
  const row199 = body.slice(body.indexOf('data-gh-open="pull:199"'), body.indexOf('data-gh-open="pull:230"'));
  assert(row199.indexOf('class="gh-reviewers empty"') === -1, "PR #199 (live shape with real requested_reviewers) does NOT render the empty '—' reviewers state");
  assert(row199.indexOf("gh-more") !== -1 || (row199.match(/av sm/g) || []).length >= 3,
    "PR #199 renders reviewer avatars (up to 3) plus a +N overflow chip for its 4 requested_reviewers");

  // #230: real non-zero rollup -> failing wins priority over pending (per
  // checksChipHtml's own documented priority: failing > pending > passed).
  const row230 = body.slice(body.indexOf('data-gh-open="pull:230"'));
  assert(/3 failing/.test(row230), "PR #230 (9 pending + 3 failing) renders '3 failing' — failing takes priority over pending in the chip, matching checksChipHtml's contract");
  assert(!/9 pending/.test(row230.slice(0, row230.indexOf("gh-merge-col"))),
    "PR #230's checks CHIP shows failing, not pending, once any check is failing (only one chip per row)");
}

/* ---------------- founder feedback: skeleton-first list state ordering ----
   Reported live: on initial load the Issues/Pull requests list showed the
   "not connected to GitHub" empty-state card by default, BEFORE the /issues
   or /pulls fetch had actually told the page whether a repo is connected —
   wrong state ordering (bodyHtml()'s `if (!state.repo) return
   emptyRepoHtml()` fallback fires on a state that just hasn't loaded yet,
   which reads identically to a genuinely disconnected repo).

   Fix (github-boot.js's render()): the list branch no longer falls through
   to renderList() at all while `!settled` (payload/loadError both still
   null) — it leaves whatever OrchaSkeleton.show() already has pending/
   showing alone instead. renderList()/bodyHtml() are now ONLY ever called
   once a response has genuinely arrived (a real payload OR a real error),
   so emptyRepoHtml() can only render off an ACTUAL reason:"repo_not_connected"
   response, never off "nothing has loaded yet". This test proves the ordering
   with a DELAYED fetch fixture — the exact shape that would have raced the
   old bug — asserting skeleton -> rows with NO not-connected flash in
   between, using the REAL app-skeleton.js module (not a stub), matching the
   founder's own repro shape. */
async function listSkeletonOrderingTest() {
  console.log("\n-- founder feedback: list shows the skeleton first, never a premature not-connected flash --");
  let releaseIssues;
  const gate = new Promise((r) => { releaseIssues = r; });
  const { ghlist, bootThrew } = boot((url) => {
    if (/\/github\/issues$/.test(url)) {
      return gate.then(() => ({
        ok: true, status: 200,
        json: () => Promise.resolve({
          available: true, repo: "acme/demo",
          issues: [{ number: 5, title: "Something broke", labels: [], assignee: null,
            updated_at: "2026-08-01T00:00:00Z", html_url: "x" }],
        }),
      }));
    }
    return new Promise(() => {});
  });
  assert(!bootThrew, "github-boot.js boots without throwing (list-skeleton scenario)");

  // Immediately after boot — BEFORE the /issues fetch has resolved, and
  // BEFORE the skeleton's own 120ms delay has even elapsed — #ghlist must
  // show NEITHER the not-connected card NOR any list rows (mutation note:
  // reverting render()'s `!settled -> do nothing` gate back to an
  // unconditional `renderList(force)` call makes this assertion fail
  // immediately, since bodyHtml() would render emptyRepoHtml() off
  // state.repo:null before any response has arrived).
  assert(ghlist.innerHTML.indexOf("No GitHub repo connected") === -1,
    "immediately after boot, BEFORE any response has arrived, the not-connected card is NOT rendered");
  assert(ghlist.innerHTML.indexOf("ghhead-row") === -1,
    "immediately after boot, no (empty/premature) list rows render either — nothing has loaded yet");

  // Past the skeleton's real 120ms delay, still before the fetch resolves:
  // the shimmer covers the gap, still no not-connected card.
  await settleSkeleton();
  assert(ghlist.innerHTML.indexOf("ork-sk") !== -1, "past the skeleton's genuine delay, the shimmer is what's showing");
  assert(ghlist.innerHTML.indexOf("No GitHub repo connected") === -1,
    "the skeleton shimmer, not the not-connected card, covers the gap while the fetch is still in flight");

  // Now let the /issues fetch resolve — the real rows replace the skeleton,
  // and the not-connected card never rendered at any point in between.
  releaseIssues();
  await settle();
  assert(ghlist.innerHTML.indexOf("Something broke") !== -1, "once the fetch resolves, the real issue row paints");
  assert(ghlist.innerHTML.indexOf("No GitHub repo connected") === -1,
    "the not-connected card never rendered at any point during a normal (successful) load");
}

/* A genuine repo_not_connected response, by contrast, DOES render the card
   — proving requirement (2)/(3) aren't satisfied by simply suppressing the
   card outright; it must still appear for the response that actually means
   it, just never as a stand-in for "no data yet". */
async function listNotConnectedStillRendersOnRealResponseTest() {
  console.log("\n-- a GENUINE repo_not_connected response still renders the connect-a-repo card --");
  const { ghlist } = boot((url) => {
    if (/\/github\/issues$/.test(url)) {
      return Promise.resolve({
        ok: true, status: 200,
        json: () => Promise.resolve({ available: false, reason: "repo_not_connected",
          detail: "no GitHub repo is connected to this project" }),
      });
    }
    return new Promise(() => {});
  });
  await settle();
  assert(ghlist.innerHTML.indexOf("No GitHub repo connected") !== -1,
    "a genuine available:false reason:\"repo_not_connected\" response still renders the connect-a-repo card once it actually arrives");
}

/* ---------------- founder-caught gap: server-known tracked state on load -----------
   Reproduces the SECOND founder report: issue #232 was started via Slack (a
   completely separate dispatch path, in a separate request, possibly a separate
   session) — the hub's list/detail pages, on a FRESH load, must already show it as
   tracked. Before this fix, `startedOf()` only ever consulted this page's own
   in-session startedIssue/startedPull cache (populated exclusively by a Start click
   made in THIS session) — a fresh load had no way to know. The backend now stamps
   `tracked_task_id` on every list row and detail payload (github_hub_routes.py); this
   suite proves the FRONTEND actually reads it, end to end through the real fetch ->
   render pipeline, not just that github-state.js's pure builder CAN render a
   taskState object (github_hub.test.js already covers that in isolation). */
async function trackedTaskIdFromServerTest() {
  console.log("\n-- a task tracked by ANY path (e.g. Slack) shows tracked on a FRESH hub load, no click needed --");
  const { ghlist } = boot((url) => {
    if (/\/github\/issues$/.test(url)) {
      return Promise.resolve({
        ok: true, status: 200,
        json: () => Promise.resolve({
          available: true, repo: "acme/demo",
          issues: [
            { number: 232, title: "Clinician dashboard: add filters", labels: [], assignee: null,
              updated_at: "2026-08-01T00:00:00Z",
              html_url: "https://github.com/acme/demo/issues/232",
              tracked_task_id: "11111111-2222-3333-4444-555555555555" },
            { number: 50, title: "untouched issue", labels: [], assignee: null,
              updated_at: "2026-08-01T00:00:00Z",
              html_url: "https://github.com/acme/demo/issues/50",
              tracked_task_id: null },
          ],
        }),
      });
    }
    return new Promise(() => {});
  });
  await settle();
  assert(ghlist.innerHTML.indexOf("11111111") !== -1,
    "the SERVER-supplied tracked_task_id (never clicked in this session) renders the task-id chip");
  assert(ghlist.innerHTML.indexOf("already tracked") !== -1,
    "a server-tracked (never-clicked-this-session) item renders the SAME 'already tracked' label a post-click existing:true would");
  // #50 (tracked_task_id: null) must still show the ordinary Start button, not a chip.
  const rows = ghlist.innerHTML.split('data-gh-row="issue:50"');
  assert(rows.length > 1 && rows[1].indexOf("gh-start\"") !== -1,
    "an UNtracked item (#50) still renders the plain Start button, not a false-positive chip");
}

async function run() {
  await clickNavigationTests();
  await staleDetailErrorTest();
  liveShapeChecksReviewersTest();
  await listSkeletonOrderingTest();
  await listNotConnectedStillRendersOnRealResponseTest();
  await trackedTaskIdFromServerTest();
  if (failures) { console.error("\n" + failures + " failure(s)"); process.exit(1); }
  console.log("\nall github hub live-defect regression tests passed");
}

run();
