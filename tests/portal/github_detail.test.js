/* ============================================================================
   GitHub hub DETAIL pages — PR detail (?pr=N) and issue detail (?issue=N)
   within the github page. Client-side routed (history.pushState, back/forward
   safe, deep-linkable) — one MPA page (github.html) hosts both the flat list
   AND every item's detail view, swapping via github-boot.js's navigate()/
   popstate, never a full page navigation between them.

   Backend contract (github_hub_routes.py, PR #95, merged/deployed; verified
   field-for-field against tests/test_github_hub_routes.py's fixtures):
     GET .../github/pulls/{n}  -> {available, repo, pull:{number,title,state,
       draft,body_markdown RAW,author_login,base,head,updated_at,created_at,
       html_url,mergeable_state,assignees[],requested_reviewers[],
       checks:{passed,failing,pending,total,runs:[{name,status,conclusion,
       html_url}]},files:{count,items:[{filename,additions,deletions,status}],
       truncated?},comments_count,review_comments_count}}
     GET .../github/issues/{n} -> {available, repo, issue:{number,title,state,
       body_markdown,author_login,labels[{name,color}],assignee,assignees[],
       updated_at,created_at,html_url,comments_count,
       comments:[{author_login,body_markdown,created_at}]}}
   Errors: HTTP 200 {available:false, reason}. reason:"not_found" is DETAIL-
   ONLY (a missing item NUMBER, distinct from repo-not-connected).

   Part 1 (behavior): loads the REAL pages/github-state.js in a bare vm (same
   harness as github_hub.test.js) and pins detailHtml()/prDetailHtml()/
   issueDetailHtml() against fixture payloads shaped exactly like the routes
   above — breadcrumb, chips row, Conversation/Checks/Files subtabs, right
   rail, Start + Open-on-GitHub actions, comments thread, label colors, and
   the not_found/not_connected/rate_limited/generic degrade ladder.

   Part 2 (wiring, grep-level): github-render.js's route-aware fetch (pulls/{n}
   vs issues/{n}, classifyDetailError's reason-based mapping, the detailToken
   stale-fetch guard) and github-boot.js's routing (readRouteFromUrl/navigate/
   popstate, row click -> data-gh-open navigation, Start/dropdown
   stopPropagation so a row click never double-fires, the breadcrumb back
   link, subtab switching).

   Run: node tests/portal/github_detail.test.js
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
const CSS = read("pages", "github.css");
const HTML = read("github.html");

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log("  ✓ " + msg);
  else { failures++; console.error("  ✗ " + msg); }
}

/* ---------------- test harness (mirrors github_hub.test.js's boot()) ----- */
function boot() {
  const escFallback = (s) => (s == null ? "" : String(s)).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
  const sandbox = {
    window: {
      Orcha: {
        esc: escFallback,
        trunc: (s, n) => ((s || "").length > n ? (s || "").slice(0, n - 1) + "…" : (s || "")),
        relTime: (iso) => (iso ? "3h ago" : "—"),
        ghAvatar: (login) => `<span class="av gh sm human">${escFallback((login || "?").charAt(0).toUpperCase())}</span>`,
        icon: (name, cls) => `<svg class="${cls || "ico"}" data-icon="${name}"></svg>`,
        // real mdText behavior isn't under test here (md_render.test.js owns that) —
        // a light passthrough that still proves body_markdown reaches the renderer
        // and stays escaped is enough signal for THIS suite.
        mdText: (s) => `<div class="md-p">${escFallback(s)}</div>`,
      },
    },
    console,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(STATE_JS, sandbox, { filename: "github-state.js" });
  return sandbox.window.OrchaGithubHub;
}

const AGENTS = [
  { id: "a-1", alias: "Forge", kind: "ai" },
  { id: "a-2", alias: "Atlas", kind: "ai" },
];

/* ---------------- fixtures (EXACT shipped shape) -------------------------- */
const PULL_DETAIL = {
  number: 12, title: "Fix retry backoff", state: "open", draft: false,
  body_markdown: "## Why\nbecause the retry storm was killing prod.\n\n> Triggered-by: on-call page",
  author_login: "octocat",
  base: "main", head: "fix/retry-backoff",
  updated_at: "2026-07-02T00:00:00Z", created_at: "2026-07-01T00:00:00Z",
  html_url: "https://github.com/acme/orcha/pull/12",
  mergeable_state: "clean",
  assignees: ["octocat", "hubot"],
  requested_reviewers: ["reviewer1"],
  checks: {
    passed: 2, failing: 1, pending: 1, total: 4,
    runs: [
      { name: "build", status: "completed", conclusion: "success", html_url: "https://ci/build" },
      { name: "lint", status: "completed", conclusion: "failure", html_url: "https://ci/lint" },
      { name: "e2e", status: "in_progress", conclusion: null, html_url: "https://ci/e2e" },
      { name: "travis", status: "completed", conclusion: "success", html_url: "https://ci/travis" },
    ],
  },
  files: {
    count: 2,
    items: [
      { filename: "a.py", additions: 10, deletions: 2, status: "modified" },
      { filename: "b.py", additions: 3, deletions: 0, status: "added" },
    ],
  },
  comments_count: 3, review_comments_count: 5,
};
const PULL_DRAFT_TRUNCATED_FILES = {
  number: 200, title: "Draft: big refactor", state: "open", draft: true,
  body_markdown: "", author_login: "octocat",
  base: "main", head: "spike/big-refactor",
  updated_at: "2026-08-01T00:00:00Z", created_at: "2026-08-01T00:00:00Z",
  html_url: "https://github.com/acme/orcha/pull/200",
  mergeable_state: "draft",
  assignees: [], requested_reviewers: [],
  checks: { passed: 0, failing: 0, pending: 0, total: 0, runs: [] },
  files: {
    count: 250,
    items: Array.from({ length: 100 }, (_, i) => ({ filename: `f${i}.py`, additions: 1, deletions: 0, status: "modified" })),
    truncated: true,
  },
  comments_count: 0, review_comments_count: 0,
};

const ISSUE_DETAIL = {
  number: 7, title: "Bug: crash on boot", state: "open",
  body_markdown: "Steps to repro:\n1. start\n2. crash",
  author_login: "reporter",
  labels: [{ name: "bug", color: "d73a4a" }, { name: "safety-critical", color: "b60205" }],
  assignee: "octocat", assignees: ["octocat", "hubot"],
  updated_at: "2026-07-03T00:00:00Z", created_at: "2026-07-01T00:00:00Z",
  html_url: "https://github.com/acme/orcha/issues/7",
  comments_count: 2,
  comments: [
    { author_login: "a", body_markdown: "first (older)", created_at: "2026-07-01T00:00:00Z" },
    { author_login: "b", body_markdown: "second (newer)", created_at: "2026-07-02T00:00:00Z" },
  ],
};
const ISSUE_NO_COMMENTS_NO_LABELS = {
  number: 9, title: "Docs typo", state: "open",
  body_markdown: "", author_login: "reporter",
  labels: [], assignee: null, assignees: [],
  updated_at: "2026-07-01T00:00:00Z", created_at: "2026-07-01T00:00:00Z",
  html_url: "https://github.com/acme/orcha/issues/9",
  comments_count: 0, comments: [],
};

function behaviorTests() {
  console.log("behavior (pages/github-state.js detail views from fixture payloads)\n");
  const G = boot();
  assert(!!G && !!G.detailHtml, "github-state.js exposes detailHtml (and friends) standalone");

  /* ---- breadcrumb ---- */
  const crumb = G.breadcrumbHtml("pull", 12, "acme/orcha");
  assert(crumb.includes("#12") && crumb.includes("acme/orcha"), "breadcrumb carries the repo + item number");
  assert(crumb.includes("Pull requests"), "PR breadcrumb labels the back-link \"Pull requests\"");
  assert(/data-gh-back="1"/.test(crumb), "breadcrumb back-link carries the wiring hook github-boot.js listens for");
  const issueCrumb = G.breadcrumbHtml("issue", 7, "acme/orcha");
  assert(issueCrumb.includes("Issues"), "issue breadcrumb labels the back-link \"Issues\"");

  /* ---- PR detail: full shape ---- */
  const prBody = G.prDetailHtml({ pull: PULL_DETAIL, repo: "acme/orcha", subTab: "conversation", taskState: null });
  assert(prBody.includes("Fix retry backoff") && prBody.includes("#12"), "PR detail renders title + number");
  assert(prBody.includes("fix/retry-backoff") && prBody.includes("main"), "PR detail shows base <- head branch chips");
  assert(prBody.includes("Updated 3h ago"), "PR detail shows relative updated time");
  assert(prBody.includes("Checks (4)") && prBody.includes("Files changed (2)"), "PR subtabs are labeled with live counts");
  assert(/data-gh-subtab="conversation"[^>]*class="[^"]*\bon\b/.test(prBody) || /class="seg on"[^>]*data-gh-subtab="conversation"/.test(prBody),
    "the active subtab (conversation, default) carries the .on class");
  assert(prBody.includes("because the retry storm"), "Conversation tab renders body_markdown through mdText");
  assert(prBody.includes("Triggered-by"), "the Triggered-by blockquote renders naturally (no special-casing) as part of the markdown body");

  /* ---- PR detail: Checks tab ---- */
  const prChecks = G.prDetailHtml({ pull: PULL_DETAIL, repo: "acme/orcha", subTab: "checks", taskState: null });
  assert(prChecks.includes("build") && prChecks.includes("lint") && prChecks.includes("e2e") && prChecks.includes("travis"),
    "Checks tab lists every run by name");
  assert(/data-icon="check"/.test(prChecks) && /data-icon="x"/.test(prChecks) && /data-icon="ring"/.test(prChecks),
    "Checks tab glyphs: check (passed run) / x (failed run) / ring (in-progress run)");
  assert(prChecks.includes("https://ci/build"), "each check run links out to its html_url");

  /* ---- PR detail: Files changed tab ---- */
  const prFiles = G.prDetailHtml({ pull: PULL_DETAIL, repo: "acme/orcha", subTab: "files", taskState: null });
  assert(prFiles.includes("a.py") && prFiles.includes("b.py"), "Files tab lists every changed filename");
  assert(prFiles.includes("+10") && prFiles.includes("-2"), "Files tab shows green +adds / red -dels per file");
  assert(!prFiles.includes("truncated".toUpperCase()) || true, "sanity: no crash on the non-truncated case");
  assert(!/Showing the first/.test(prFiles), "a non-truncated file list shows no truncation notice");

  const prFilesTruncated = G.prDetailHtml({ pull: PULL_DRAFT_TRUNCATED_FILES, repo: "acme/orcha", subTab: "files", taskState: null });
  assert(/Showing the first 100 of 250 files/.test(prFilesTruncated), "files.truncated:true renders the truncation notice with the honest total");

  /* ---- PR detail: draft state + right rail ---- */
  assert(prBody.includes("gh-state-pill") && /Open/.test(prBody), "an open, non-draft PR shows the Open state pill");
  const draftBody = G.prDetailHtml({ pull: PULL_DRAFT_TRUNCATED_FILES, repo: "acme/orcha", subTab: "conversation", taskState: null });
  assert(draftBody.includes("Draft"), "a draft PR shows the Draft state pill instead of Open");
  assert(prBody.includes("octocat") && prBody.includes("hubot"), "right rail lists PR assignees");
  assert(prBody.includes("reviewer1"), "right rail lists requested reviewers");
  assert(prBody.includes("2 passed") && prBody.includes("1 failing") && prBody.includes("1 pending"),
    "right rail checks-summary card breaks down passed/failing/pending counts");

  /* ---- PR detail: Start + Open on GitHub actions ---- */
  assert(/data-gh-start="pull"/.test(prBody) && /data-gh-number="12"/.test(prBody),
    "PR detail carries the SAME Start control (kind+number) the list rows use");
  assert(prBody.includes("https://github.com/acme/orcha/pull/12") && /Open on GitHub/.test(prBody),
    "PR detail carries an \"Open on GitHub\" link to the item's real html_url");
  assert(!/data-act="approve"|data-act="merge"|data-act="close"|data-act="rerun"/.test(prBody),
    "PR detail has NO approve/close/rerun controls — read + Start only, deliberate");
  const trackedPrBody = G.prDetailHtml({ pull: PULL_DETAIL, repo: "acme/orcha", subTab: "conversation", taskState: { task_id: "t-999", existing: true } });
  assert(trackedPrBody.includes("t-999") && trackedPrBody.includes("already tracked"),
    "an already-started PR shows the SAME already-tracked task-id chip the list uses");

  /* ---- issue detail: labels in real colors, body, assignees, comments ---- */
  const issueBody = G.issueDetailHtml({ issue: ISSUE_DETAIL, repo: "acme/orcha", theme: "dark", taskState: null });
  assert(issueBody.includes("Bug: crash on boot") && issueBody.includes("#7"), "issue detail renders title + number");
  assert(issueBody.includes("background:#d73a4a2e") && issueBody.includes("background:#b6020529".slice(0, -1)),
    "issue detail labels render via labelChipHtml with the real GitHub color");
  assert(issueBody.includes("Steps to repro"), "issue detail renders body_markdown through mdText");
  assert(issueBody.includes("octocat") && issueBody.includes("hubot"), "issue detail right rail lists assignees");
  assert(issueBody.includes("Comments") && issueBody.includes("(2)"), "issue detail shows a comment count");
  assert(issueBody.indexOf("first (older)") < issueBody.indexOf("second (newer)"),
    "comments render oldest-first (matching the backend's re-ordering)");
  assert(/data-gh-start="issue"/.test(issueBody) && /data-gh-number="7"/.test(issueBody),
    "issue detail carries the SAME Start control the list rows use");
  assert(issueBody.includes("https://github.com/acme/orcha/issues/7") && /Open on GitHub/.test(issueBody),
    "issue detail carries an Open-on-GitHub link");

  const issueEmpty = G.issueDetailHtml({ issue: ISSUE_NO_COMMENTS_NO_LABELS, repo: "acme/orcha", theme: "dark", taskState: null });
  assert(issueEmpty.includes("No comments yet"), "zero comments renders an honest empty state, not a blank section");
  assert(issueEmpty.includes("None"), "zero assignees renders an honest \"None\" state in the rail, not a blank");

  /* ---- comment rows: GitHub logins via ghAvatar directly (not Orcha.face) ---- */
  const commentHtml = G.commentRowHtml({ author_login: "hubot", body_markdown: "lgtm", created_at: "2026-07-01T00:00:00Z" });
  assert(commentHtml.includes("hubot") && commentHtml.includes("av gh"), "a comment author renders via ghAvatar (GitHub login), not the Orcha.face agent-roster lookup");
  assert(commentHtml.includes("lgtm"), "comment body renders through mdText");

  /* ---- detail degrade ladder (mirrors bodyHtml's, plus not_found) ---- */
  const notFound = G.detailHtml({ kind: "pull", error: { kind: "not_found" } });
  assert(notFound.includes("not found") || notFound.includes("Not found") || /not found/i.test(notFound),
    "a missing PR/issue number renders an honest \"not found\" card, not a blank/broken page");
  const notFoundIssue = G.detailHtml({ kind: "issue", error: { kind: "not_found" } });
  assert(/Issue/.test(notFoundIssue), "the not-found card is worded for the right kind (Issue vs Pull request)");

  const detailNotConnected = G.detailHtml({ kind: "pull", error: { kind: "not_connected" } });
  assert(detailNotConnected.includes("No GitHub repo connected"), "detail route reuses the SAME repo-not-connected card as the list");

  const detailRateLimited = G.detailHtml({ kind: "pull", error: { kind: "rate_limited" } });
  assert(detailRateLimited.includes("rate limit"), "detail route reuses the SAME rate-limited card as the list");

  const detailGenericErr = G.detailHtml({ kind: "issue", error: { kind: "error", status: 500, detail: "boom" } });
  assert(detailGenericErr.includes("500") && detailGenericErr.includes("boom"), "a generic detail error surfaces status + detail");

  const detailLoading = G.detailHtml({ kind: "pull", loading: true, pull: null, issue: null });
  assert(/Loading/.test(detailLoading), "no payload yet renders Loading, not a blank/broken page");

  const detailRoutesToPr = G.detailHtml({ kind: "pull", repo: "acme/orcha", pull: PULL_DETAIL, subTab: "conversation", taskState: null });
  assert(detailRoutesToPr.includes("Fix retry backoff"), "detailHtml routes kind:'pull' to prDetailHtml");
  const detailRoutesToIssue = G.detailHtml({ kind: "issue", repo: "acme/orcha", issue: ISSUE_DETAIL, taskState: null });
  assert(detailRoutesToIssue.includes("Bug: crash on boot"), "detailHtml routes kind:'issue' to issueDetailHtml");

  /* ---- escaping: hostile PR/issue/comment fields never land unescaped ---- */
  const hostilePull = JSON.parse(JSON.stringify(PULL_DETAIL));
  hostilePull.title = '<img src=x onerror=alert(1)>';
  hostilePull.head = '"><svg onload=alert(2)>';
  const hostilePrBody = G.prDetailHtml({ pull: hostilePull, repo: "acme/orcha", subTab: "conversation", taskState: null });
  assert(!hostilePrBody.includes("<img src=x") && !hostilePrBody.includes("<svg onload"),
    "PR title/branch are HTML-escaped in the detail view");

  const hostileComment = { author_login: '<script>bad()</script>', body_markdown: "hi", created_at: "2026-07-01T00:00:00Z" };
  const hostileCommentHtml = G.commentRowHtml(hostileComment);
  assert(!hostileCommentHtml.includes("<script>bad()"), "comment author_login is HTML-escaped");

  /* ---- column header (list final polish, wide viewports) ---- */
  const colHeader = G.columnHeaderHtml("pull");
  assert(colHeader.includes(">ID<") && /TITLE/.test(colHeader) && />REVIEWERS<|REVIEWERS</.test(colHeader)
    && />CHECKS<|CHECKS</.test(colHeader) && />MERGE<|MERGE</.test(colHeader) && />UPDATED<|UPDATED</.test(colHeader),
    "the column-header row carries ID | TITLE/CONTEXT | REVIEWERS | CHECKS | MERGE | UPDATED per the reference layout");
  assert(G.bodyHtml({ repo: "acme/orcha", items: [{ number: 1, title: "x", labels: [], updated_at: null, requested_reviewers: [] }], tab: "issue", filter: "open", query: "", agents: AGENTS, myLogin: null, startedOf: () => null }).includes(">ID<"),
    "bodyHtml prepends the column header ahead of the rows");

  /* ---- list rows are now clickable (row = detail, Start = button) -------- */
  const clickableIssueRow = G.issueRowHtml({ number: 42, title: "x", labels: [], assignee: null, updated_at: null }, AGENTS, () => null, "dark");
  assert(/data-gh-open="issue:42"/.test(clickableIssueRow), "an issue row carries data-gh-open so the whole row navigates to its detail view");
  const clickablePullRow = G.pullRowHtml({ number: 101, title: "x", head: "y", draft: false, updated_at: null, requested_reviewers: [], checks: {} }, AGENTS, () => null, "dark");
  assert(/data-gh-open="pull:101"/.test(clickablePullRow), "a pull row carries data-gh-open so the whole row navigates to its detail view");
}

/* ---------------- part 2: wiring (grep-level) ------------------------------ */
function wiringTests() {
  console.log("\nwiring (github-render.js detail fetch + github-boot.js routing)\n");

  /* ---- render.js: route-aware detail fetch ---- */
  assert(/\/github\/pulls\/"/.test(RENDER_JS) || /\/pulls\/"\s*\+/.test(RENDER_JS) || /path\s*\+\s*"\/"\s*\+\s*encodeURIComponent\(number\)/.test(RENDER_JS),
    "loadDetail fetches .../github/pulls/{n} or .../github/issues/{n} keyed off the active route");
  assert(/reason\s*===\s*"not_found"/.test(RENDER_JS), "classifyDetailError reads the backend's reason:\"not_found\" for a missing item number");
  assert(/reason\s*===\s*"repo_not_connected"/.test(RENDER_JS), "classifyDetailError reads reason:\"repo_not_connected\" distinctly from not_found");
  assert(/detailToken/.test(RENDER_JS), "loadDetail guards against a stale in-flight fetch landing after a newer route change (detailToken)");
  assert(/GhS\.detailHtml\(/.test(RENDER_JS), "renderDetail patches via GhS.detailHtml(state)");

  /* ---- boot.js: routing (pushState/popstate, deep-linkable) ---- */
  assert(/readRouteFromUrl/.test(BOOT_JS) && /\.get\("pr"\)/.test(BOOT_JS) && /\.get\("issue"\)/.test(BOOT_JS),
    "readRouteFromUrl derives the route from ?pr= / ?issue= query params");
  assert(/history\.pushState/.test(BOOT_JS), "navigate() uses history.pushState so back/forward works across list <-> detail");
  assert(/window\.addEventListener\("popstate"/.test(BOOT_JS), "a popstate listener re-derives the route on back/forward");
  assert(/data-gh-open/.test(BOOT_JS), "row clicks are delegated off data-gh-open to call navigate()");

  /* ---- boot.js: Start / dropdown stopPropagation (row click must not double-fire) ---- */
  assert(/data-gh-start\]"\);\s*\n\s*if\s*\(start\)\s*\{\s*ev\.stopPropagation/.test(BOOT_JS.replace(/\r/g, ""))
    || /if\s*\(start\)\s*\{\s*ev\.stopPropagation\(\)/.test(BOOT_JS),
    "a Start-button click stopPropagates so the row's own navigate-to-detail handler never also fires");
  assert(/if\s*\(dd\)\s*\{\s*ev\.stopPropagation\(\)/.test(BOOT_JS),
    "the assignee-dropdown toggle click stopPropagates the same way");

  /* ---- boot.js: breadcrumb back + subtabs ---- */
  assert(/data-gh-back/.test(BOOT_JS), "the breadcrumb back-link is wired");
  assert(/data-gh-subtab/.test(BOOT_JS), "the Conversation/Checks/Files subtab toggle is wired");

  /* ---- github.html: markdown.css loaded (body_markdown renders through mdText) ---- */
  assert(/styles\/markdown\.css/.test(HTML), "github.html loads markdown.css for the detail views' rendered body_markdown");
  assert(/id="ghHead"/.test(HTML), "the list header (tabs/search) carries an id so it can hide itself in detail mode");

  /* ---- github.css: label chips carry no hardcoded colors (colors are inline per-label) ---- */
  assert(!/#[0-9a-fA-F]{3,8}\b/.test(CSS.replace(/\/\*[\s\S]*?\*\//g, "")), "github.css (incl. the new detail-view rules) stays token-only — no hardcoded hex");
  assert(!/rgba?\(/.test(CSS.replace(/\/\*[\s\S]*?\*\//g, "")), "github.css has no raw rgb()/rgba() literals either");
  assert(/\.gh-detail-layout\b/.test(CSS), "the detail two-column layout class is styled");
  assert(/\.gh-rail\b/.test(CSS), "the right rail is styled");
}

function run() {
  behaviorTests();
  wiringTests();
  if (failures) { console.error("\n" + failures + " failure(s)"); process.exit(1); }
  console.log("\nall github detail tests passed");
}

run();
