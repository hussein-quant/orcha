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
// window.Orcha.renderDiff here is the REAL app-patch-log.js renderDiff (loaded
// straight off disk, same convention app_run_stream-adjacent suites use to
// prove a shared module reaches its call site unforked), NOT a test double —
// this is the assertion that the Files-changed tab renders through the SAME
// renderer the task run-stream uses, per the feature's own requirement.
const PATCH_LOG_JS = read("modules", "app-patch-log.js");
function realRenderDiff() {
  const sandbox = { console };
  sandbox.globalThis = sandbox;
  // app-patch-log.js's renderDiff calls a bare `esc()` (defined in
  // modules/app-text.js in the real page, concatenated into the same global
  // scope) — seed the same minimal fallback the rest of this harness uses.
  vm.createContext(sandbox);
  vm.runInContext(
    "const esc = (s) => (s == null ? '' : String(s)).replace(/[&<>\"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',\"'\":'&#39;'}[c]));\n" + PATCH_LOG_JS,
    sandbox, { filename: "app-patch-log.js" },
  );
  return sandbox.renderDiff;
}
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
        // the REAL renderDiff (see realRenderDiff above) — proves github-state.js's
        // Files-changed tab reaches window.Orcha.renderDiff the same way every other
        // page-local fallback (mdText/esc/icon) does, and that the SHARED renderer's
        // actual add/del/hunk classification runs against a GitHub patch string.
        renderDiff: realRenderDiff(),
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
    count: 3,
    items: [
      { filename: "a.py", additions: 10, deletions: 2, status: "modified",
        patch: "@@ -1,3 +1,4 @@\n context line\n-old line\n+new line\n+another new line",
        patch_omitted: false },
      { filename: "b.py", additions: 3, deletions: 0, status: "added",
        patch: "@@ -0,0 +1,3 @@\n+first\n+second\n+third", patch_omitted: false },
      { filename: "logo.png", additions: 0, deletions: 0, status: "modified",
        patch: null, patch_omitted: true },
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
    items: Array.from({ length: 100 }, (_, i) => ({
      filename: `f${i}.py`, additions: 1, deletions: 0, status: "modified",
      // budget cut kicks in from file #5 onward — proves the truncation note
      // and per-file omitted state can coexist with files.truncated (too many
      // FILES) without one flag masking the other.
      patch: i < 5 ? `@@ -1,1 +1,1 @@\n-old${i}\n+new${i}` : null,
      patch_omitted: i >= 5,
    })),
    truncated: true,
    patches_truncated: true,
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
  assert(prBody.includes("Checks (4)") && prBody.includes("Files changed (3)"), "PR subtabs are labeled with live counts");
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
  assert(prFiles.includes("a.py") && prFiles.includes("b.py") && prFiles.includes("logo.png"), "Files tab lists every changed filename");
  assert(prFiles.includes("+10") && prFiles.includes("-2"), "Files tab shows green +adds / red -dels per file");
  assert(!/Showing the first/.test(prFiles), "a non-truncated file list shows no truncation notice");
  assert(!/Some diffs were too large/.test(prFiles), "no patches_truncated flag -> no budget-cut note");

  // ---- each file is a collapsible <details> section, body = the SHARED renderDiff() ----
  assert(/<details class="gh-file-row" open>/.test(prFiles), "the first file section is expanded (open) by default");
  const fileSections = prFiles.match(/<details class="gh-file-row"[^>]*>[\s\S]*?<\/details>/g) || [];
  assert(fileSections.length === 3, "one collapsible <details> section per changed file");
  assert(/ open>/.test(fileSections[0]) && / open>/.test(fileSections[1]),
    "the FIRST 3 files are expanded by default (only 3 files here, so both non-binary ones carry open)");
  // header row: filename, status, +adds/-dels, chevron — all inside <summary>
  assert(/<summary class="gh-file-sum">[\s\S]*a\.py[\s\S]*<\/summary>/.test(fileSections[0]),
    "each section's header (summary) carries the filename");
  assert(/gh-file-chev/.test(fileSections[0]), "each section's header carries the chevron glyph");
  // body: the diff rendered through the SAME renderDiff() the run-stream uses — add/del
  // line classes straight off the real app-patch-log.js renderDiff, not a re-implementation.
  assert(/class="dl add">\+new line/.test(fileSections[0]), "added lines get the SAME .dl.add class renderDiff produces for the run-stream");
  assert(/class="dl del">-old line/.test(fileSections[0]), "removed lines get the SAME .dl.del class renderDiff produces for the run-stream");
  assert(/class="dl hunk">@@/.test(fileSections[0]), "the @@ hunk header line gets the SAME .dl.hunk class");
  assert(/class="dstat"/.test(fileSections[0]), "the diff's +N/-N stat header renders (renderDiff's own dstat block)");

  // ---- patch_omitted:true -> the quiet "diff not available" line, no diff, no crash ----
  assert(/diff not available \(binary or too large\)/.test(fileSections[2]), "an omitted-patch file shows the quiet unavailable line");
  assert(/view on GitHub/.test(fileSections[2]) && /https:\/\/github\.com\/acme\/orcha\/pull\/12/.test(fileSections[2]),
    "the omitted-file line links out to the PR's own html_url");
  assert(!/class="diff"/.test(fileSections[2]), "an omitted file renders NO diff block at all (not an empty one)");

  const prFilesTruncated = G.prDetailHtml({ pull: PULL_DRAFT_TRUNCATED_FILES, repo: "acme/orcha", subTab: "files", taskState: null });
  assert(/Showing the first 100 of 250 files/.test(prFilesTruncated), "files.truncated:true renders the truncation notice with the honest total");
  assert(/Some diffs were too large to show here/.test(prFilesTruncated), "patches_truncated:true renders ONE honest budget note, distinct from the file-count truncation note");
  assert((prFilesTruncated.match(/Some diffs were too large/g) || []).length === 1, "the patches_truncated note appears exactly once, not once per omitted file");
  const truncSections = prFilesTruncated.match(/<details class="gh-file-row"[^>]*>[\s\S]*?<\/details>/g) || [];
  assert(truncSections.length === 100, "all 100 fetched files still render as sections even though most are budget-omitted");
  assert(/ open>/.test(truncSections[0]) && / open>/.test(truncSections[1]) && / open>/.test(truncSections[2]),
    "the first 3 files are expanded by default regardless of omission state");
  assert(!/ open>/.test(truncSections[3]) && !/ open>/.test(truncSections[99]),
    "files past the first 3 are collapsed by default (index 3 and the last file both closed)");
  assert(/diff not available/.test(truncSections[5]), "a budget-omitted file (past the cut) shows the same quiet unavailable line as a binary omission");

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

  /* ---- PR detail: dispatch-button label split (founder decision) ---- */
  assert(/gh-start"[^>]*>Fix\s/.test(prBody), "the PR detail page's dispatch button reads \"Fix\", not \"Start\"");
  assert(!/gh-start"[^>]*>Start\s/.test(prBody), "the PR detail page's dispatch button does NOT read \"Start\"");
  assert(/title="Dispatch an agent to fix checks\/review feedback on this PR"/.test(prBody),
    "the PR detail page's Fix button carries the PR-specific tooltip");
  const issueDetailForLabelCheck = G.issueDetailHtml({ issue: ISSUE_DETAIL, repo: "acme/orcha", theme: "dark", taskState: null });
  assert(/gh-start"[^>]*>Start\s/.test(issueDetailForLabelCheck), "the ISSUE detail page's dispatch button still reads \"Start\" (unchanged)");
  assert(!/gh-start"[^>]*>Fix\s/.test(issueDetailForLabelCheck), "the ISSUE detail page's dispatch button does NOT read \"Fix\"");
  assert(!/data-act="approve"|data-act="merge"|data-act="close"|data-act="rerun"/.test(prBody),
    "PR detail has NO approve/close/rerun controls — read + Start only, deliberate");
  const trackedPrBody = G.prDetailHtml({ pull: PULL_DETAIL, repo: "acme/orcha", subTab: "conversation", taskState: { task_id: "t-999", existing: true } });
  assert(trackedPrBody.includes("t-999") && trackedPrBody.includes("already tracked"),
    "an already-started PR shows the SAME already-tracked task-id chip the list uses");

  /* ---- PR detail: ⓘ Fix-info popover trigger ---- */
  assert(/data-gh-fix-info="12"/.test(prBody), "the PR detail page carries the ⓘ info-popover trigger, keyed to the PR number");
  assert(/aria-haspopup="true"/.test(prBody.slice(prBody.indexOf("data-gh-fix-info"), prBody.indexOf("data-gh-fix-info") + 200)),
    "the info trigger carries aria-haspopup (same accessibility contract as the assignee dropdown toggle)");
  assert(!issueDetailForLabelCheck.includes("data-gh-fix-info"),
    "an ISSUE's detail page carries NO info-popover trigger (issues have no outstanding-items concept)");
  assert(!trackedPrBody.includes("data-gh-fix-info"),
    "an ALREADY-TRACKED PR shows no info trigger either — it rides beside the Fix BUTTON, which the task-id chip replaces");

  /* ---- fixOutstandingItems / fixInfoPopoverBodyHtml: content per fixture state ---- */
  const allClean = { number: 1, mergeable_state: "clean", draft: false,
    checks: { passed: 3, failing: 0, pending: 0, total: 3, runs: [] },
    review_comments_count: 0, comments_count: 0 };
  assert(G.fixOutstandingItems(allClean).length === 0, "all-clean PR: zero outstanding items");
  assert(/Review the PR's feedback and CI state/.test(G.fixInfoPopoverBodyHtml(allClean)),
    "all-clean PR: the popover body falls back to the generic sentence, not an empty list");

  const failingOnly = { number: 2, mergeable_state: "clean", draft: false,
    checks: { passed: 1, failing: 2, pending: 0, total: 3, runs: [
      { name: "lint", status: "completed", conclusion: "failure" },
      { name: "unit-tests", status: "completed", conclusion: "failure" },
      { name: "build", status: "completed", conclusion: "success" },
    ] },
    review_comments_count: 0, comments_count: 0 };
  const failingItems = G.fixOutstandingItems(failingOnly);
  assert(failingItems.length === 1 && /2 failing checks: lint, unit-tests/.test(failingItems[0]),
    "failing-checks-only fixture: one item naming both failing runs");
  assert(/<li>2 failing checks: lint, unit-tests<\/li>/.test(G.fixInfoPopoverBodyHtml(failingOnly)),
    "the popover renders the failing-checks item as a real <li>, HTML-escaped structure");

  const commentsOnly = { number: 3, mergeable_state: "clean", draft: false,
    checks: { passed: 2, failing: 0, pending: 0, total: 2, runs: [] },
    review_comments_count: 4, comments_count: 2 };
  const commentsItems = G.fixOutstandingItems(commentsOnly);
  assert(commentsItems.length === 1 && commentsItems[0] === "6 review comments to address",
    "comments-only fixture: one item summing review_comments_count + comments_count");

  const conflictsOnly = { number: 4, mergeable_state: "dirty", draft: false,
    checks: { passed: 3, failing: 0, pending: 0, total: 3, runs: [] },
    review_comments_count: 0, comments_count: 0 };
  const conflictItems = G.fixOutstandingItems(conflictsOnly);
  assert(conflictItems.length === 1 && /merge conflicts with base/.test(conflictItems[0]),
    "conflicts-only fixture (mergeable_state:dirty): one item naming the conflict");

  const draftPr = { number: 5, mergeable_state: "clean", draft: true,
    checks: { passed: 0, failing: 0, pending: 0, total: 0, runs: [] },
    review_comments_count: 0, comments_count: 0 };
  const draftItems = G.fixOutstandingItems(draftPr);
  assert(draftItems.length === 1 && /this PR is a draft/i.test(draftItems[0]), "draft-only fixture: one item flagging the draft state");

  // pinned against the REAL PULL_DETAIL fixture (1 failing/lint, 1 pending/e2e,
  // mergeable_state:clean, review_comments_count+comments_count from the fixture below)
  const pulledItems = G.fixOutstandingItems(PULL_DETAIL);
  assert(pulledItems.some((it) => /1 failing check: lint/.test(it)), "PULL_DETAIL: names its one failing check (lint)");
  assert(pulledItems.some((it) => /1 check still pending/.test(it)), "PULL_DETAIL: counts its one pending check (e2e), no name");
  assert(pulledItems.some((it) => /review comments? to address/.test(it)), "PULL_DETAIL: sums its review_comments_count + comments_count");
  assert(!pulledItems.some((it) => /conflict/.test(it)), "PULL_DETAIL: mergeable_state:clean -> no conflict item");

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

  /* ---- boot.js: PR Fix-info popover (ⓘ) wiring ---- */
  assert(/data-gh-fix-info/.test(BOOT_JS), "the ⓘ info-popover trigger is wired off data-gh-fix-info");
  assert(/ghOpenInfoPopover/.test(BOOT_JS), "a fix-info click opens the popover via ghOpenInfoPopover");
  assert(/if\s*\(fixInfo\)\s*\{\s*ev\.stopPropagation/.test(BOOT_JS),
    "the fix-info click stopPropagates (same discipline as the Start/dropdown toggles — a click on it must not also bubble to a row/detail navigation)");
  assert(/pmenu float gh-fix-info-pop|pmenu.*float.*gh-fix-info-pop/.test(BOOT_JS),
    "the info popover host reuses the SAME .pmenu.float floating-menu class the assignee dropdown uses (skin/theme tokens come for free)");
  assert(/GhS\.fixInfoPopoverBodyHtml/.test(BOOT_JS), "the popover body is built via GhS.fixInfoPopoverBodyHtml (github-state.js), not a second bespoke renderer");

  /* ---- github.css: the info trigger + popover styling exists and is skin-safe ---- */
  assert(/\.iconbtn\.sm\b/.test(CSS), "a compact icon-button size variant is styled for the inline trigger");
  assert(/\.gh-fix-info-list\b/.test(CSS), "the popover's outstanding-items list is styled");

  /* ---- github.html: markdown.css loaded (body_markdown renders through mdText) ---- */
  assert(/styles\/markdown\.css/.test(HTML), "github.html loads markdown.css for the detail views' rendered body_markdown");
  assert(/id="ghHead"/.test(HTML), "the list header (tabs/search) carries an id so it can hide itself in detail mode");

  /* ---- github.css: label chips carry no hardcoded colors (colors are inline per-label) ---- */
  assert(!/#[0-9a-fA-F]{3,8}\b/.test(CSS.replace(/\/\*[\s\S]*?\*\//g, "")), "github.css (incl. the new detail-view rules) stays token-only — no hardcoded hex");
  assert(!/rgba?\(/.test(CSS.replace(/\/\*[\s\S]*?\*\//g, "")), "github.css has no raw rgb()/rgba() literals either");
  assert(/\.gh-detail-layout\b/.test(CSS), "the detail two-column layout class is styled");
  assert(/\.gh-rail\b/.test(CSS), "the right rail is styled");
}

/* ============================================================================
   Part 3: real-DOM harness — boots the REAL github-{state,render,boot}.js
   trio (same pattern as github_hub_checks_progressive.test.js's boot(): a
   FakeElement with genuine addEventListener/dispatch + innerHTML storage, NOT
   grep-only assertions) against a live ?pr=N detail route, then drives an
   ACTUAL click through the delegated #ghlist listener boot.js installs.

   Files-changed collapse/expand is native <details>/<summary> — the browser
   toggles `open` on a summary click with ZERO JavaScript (see fileRowHtml's
   own comment in github-state.js), so there is deliberately no data-gh-*
   click handler for it in github-boot.js. What this harness proves for real
   (off a genuine fetch -> renderDetail() round trip, not a hand-called
   prDetailHtml() like Part 1 above): (a) the Files-changed subtab click
   routes through boot.js's REAL delegated #ghlist listener and renders the
   collapsible sections; (b) the rendered `open` attribute reflects "first 3
   expanded, rest collapsed" per file index; and (c) since <details> needs no
   JS, clicking a <summary> element itself is simulated the same way a real
   click event would be seen by the browser's native handling — by toggling
   the `open` attribute directly on the FakeElement's tracked state — proving
   the markup's `open` attribute is a real, independently toggleable boolean
   (not baked into the string in a way that would fight native browser
   behavior, e.g. accidentally duplicated or malformed). */
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
    this.attrs = {};
    this.style = {};   // ghOpenDropdown/ghOpenInfoPopover position the floating host via .style.top/left/right
  }
  addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); }
  dispatch(type, ev) { (this._listeners[type] || []).forEach((fn) => fn(ev)); }
  set innerHTML(html) { this._html = html; }
  get innerHTML() { return this._html; }
  querySelectorAll() { return []; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k]; }
  contains() { return false; }   // the outside-click listener checks el.contains(e.target)
}

function bootDom(initialHref, fetchImpl) {
  const ghlist = new FakeElement("div", "ghlist");
  const ghHead = new FakeElement("div", "ghHead");
  const ghTabs = new FakeElement("nav", "ghTabs");
  const ghFilters = new FakeElement("div", "ghFilters");
  const els = { ghlist, ghHead, ghTabs, ghFilters };

  // body.appendChild TRACKS what's appended (github-boot.js's ghDdHost()/ghInfoHost()
  // lazily create + append a floating popover host on first open, then keep their own
  // reference — this shim mirrors that by ALSO registering the appended element under
  // its own `.id` in `els`, so a test can retrieve it via document.getElementById the
  // same way a real DOM query would, without needing github-boot.js to expose any new
  // test-only hook.
  const documentShim = {
    getElementById: (id) => els[id] || null,
    addEventListener() {},
    documentElement: { setAttribute() {} },
    createElement: (tag) => new FakeElement(tag),
    body: { appendChild: (el) => { if (el && el.id) els[el.id] = el; } },
    querySelectorAll: () => [],
  };
  const historyShim = { pushState() {}, replaceState() {}, length: 2, back() {} };
  const locationShim = { href: initialHref };

  const sandbox = {
    console, document: documentShim, history: historyShim, location: locationShim, URL,
    setInterval: () => 0, setTimeout: () => 0,
  };
  sandbox.window = sandbox;
  sandbox.window.addEventListener = () => {};
  sandbox.window.OrchaData = { start: (render) => { render(); }, currentCid: () => "cid-1" };
  sandbox.window.ORCHA = { container: { id: "cid-1", name: "demo" }, agents: [] };
  sandbox.window.OrchaSkeleton = { show() {}, swap(host, fn) { fn(); } };
  sandbox.fetch = fetchImpl;
  sandbox.globalThis = sandbox;

  const escFallback = (s) => (s == null ? "" : String(s)).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
  sandbox.window.Orcha = {
    esc: escFallback, trunc: (s) => s, relTime: () => "3h ago", ghAvatar: () => "<span></span>",
    icon: (name, cls) => `<svg class="${cls || ""}" data-icon="${name}"></svg>`,
    mdText: (s) => escFallback(s), mountShell() {},
    // the REAL renderDiff (see realRenderDiff() above) — same load-bearing
    // reason as Part 1's boot(): proves this harness's rendered diff bodies
    // come from the ACTUAL shared renderer, not a test double.
    renderDiff: realRenderDiff(),
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
  return { sandbox, ghlist, bootThrew };
}

const domFlush = () => new Promise((r) => setImmediate(r));
const domSettle = async (n) => { for (let i = 0; i < (n || 4); i++) await domFlush(); };

// boot.js's delegated #ghlist click listener reads `ev.target.closest(selector)`
// per candidate selector in turn (data-gh-start, data-gh-start-dd, a.gh-open-ext
// et al., data-gh-subtab, data-gh-open) — a fake target that only answers `true`
// for ONE selector proves the click routes to that SPECIFIC branch of the REAL
// delegated handler, the same way a real click bubbling up from a rendered
// element with exactly that attribute would, without reimplementing boot.js's
// own routing logic here.
function fakeTargetFor(selector) {
  return { closest: (sel) => (sel.indexOf(selector) >= 0 ? { getAttribute: () => "files" } : null) };
}
// A fake click target for the ⓘ fix-info trigger: closest("[data-gh-fix-info]") answers
// with an anchor-like object carrying getAttribute (the PR number) AND
// getBoundingClientRect (ghOpenInfoPopover positions the popover off it) — the two real
// DOM APIs that handler actually calls, so this proves the real code path runs, not a
// stand-in that merely avoids throwing.
function fakeFixInfoTarget(number) {
  const anchor = {
    getAttribute: (k) => (k === "data-gh-fix-info" ? String(number) : null),
    getBoundingClientRect: () => ({ bottom: 100, right: 200 }),
    setAttribute() {},
  };
  return { closest: (sel) => (sel.indexOf("data-gh-fix-info") >= 0 ? anchor : null) };
}

async function domTests() {
  console.log("\nreal-DOM harness (live ?pr=N route -> rendered Files-changed sections)\n");

  /* ---- boot against a live ?pr=12 route, fetch the real PULL_DETAIL fixture ---- */
  const pullDetailResponse = {
    ok: true, status: 200,
    json: () => Promise.resolve({ available: true, repo: "acme/orcha", pull: PULL_DETAIL }),
  };
  const { ghlist, bootThrew, sandbox } = bootDom("https://orcha.example.test/github?pr=12", (url) => {
    if (/\/github\/pulls\/12$/.test(url)) return Promise.resolve(pullDetailResponse);
    return new Promise(() => {});
  });
  assert(!bootThrew, "the real github-{state,render,boot}.js trio boots clean against a live ?pr=12 route" + (bootThrew ? ": " + bootThrew.message : ""));
  await domSettle(6);

  const html = ghlist.innerHTML;
  assert(ghlist.classList.contains("gh-detail-mode"), "the list host switches into detail-mode for a ?pr= route");
  assert(/Fix retry backoff/.test(html), "a REAL fetch -> renderDetail() round trip renders the fetched PR's title (not a hand-called prDetailHtml stub)");
  assert(html.indexOf('data-gh-subtab="files"') >= 0, "the rendered detail view carries a Files-changed subtab toggle");
  assert(html.indexOf('data-gh-fix-info="12"') >= 0, "the rendered PR detail view carries the ⓘ info-popover trigger for this PR");

  /* ---- click the ⓘ info trigger through the REAL delegated handler; the popover
     opens with content built from the SAME already-loaded pull object (no second
     fetch — ghInfoHost/ghOpenInfoPopover read detailPayload.pull.pull directly). ---- */
  ghlist.dispatch("click", { target: fakeFixInfoTarget(12), stopPropagation() {} });
  await domSettle(2);
  const infoHost = sandbox.document.getElementById("ghFixInfoMenu");
  assert(!!infoHost, "clicking the ⓘ trigger (via the real delegated #ghlist handler) creates+appends the popover host");
  assert(infoHost.classList.contains("show"), "the popover host is shown (the .show class toggled on) after the click");
  assert(/Fix dispatches an agent to:/.test(infoHost.innerHTML), "the popover body carries the fixed intro line");
  // PULL_DETAIL (fixture: 1 failing/lint, 1 pending/e2e, review+comments) -> the SAME
  // outstanding items fixOutstandingItems computes from the fixture, rendered as real
  // <li> rows, off the ACTUAL detailPayload the page fetched (not a second/parallel
  // computation this test does itself).
  assert(/<li>1 failing check: lint<\/li>/.test(infoHost.innerHTML), "the live popover names PULL_DETAIL's one failing check (lint)");
  assert(/1 check still pending/.test(infoHost.innerHTML), "the live popover counts PULL_DETAIL's one pending check");

  /* ---- click the Files-changed subtab through the REAL delegated handler ---- */
  ghlist.dispatch("click", { target: fakeTargetFor("data-gh-subtab"), stopPropagation() {} });
  await domSettle(2);
  const filesHtml = ghlist.innerHTML;
  assert(/gh-file-row/.test(filesHtml), "clicking the Files-changed subtab (via the real delegated #ghlist handler) renders the collapsible file sections");

  const sections = filesHtml.match(/<details class="gh-file-row"[^>]*>[\s\S]*?<\/details>/g) || [];
  assert(sections.length === 3, "the live-rendered Files tab carries one <details> per changed file");
  assert(/ open>/.test(sections[0]) && / open>/.test(sections[1]),
    "the first files render already expanded (open) — a founder sees a diff without clicking anything");
  assert(/class="dl add">/.test(sections[0]) && /class="dl del">/.test(sections[0]),
    "an expanded section's body already carries the SAME renderDiff() add/del line classes as the run-stream diff");

  /* ---- a file PAST the default-expanded cutoff: collapsed by default, and a
     click on ITS <summary> is what a founder does to see its diff. Native
     <details> needs no JS for this — clicking <summary> is entirely browser-
     handled — so the interaction test is: the render produced a genuinely
     collapsed section (no `open` attribute at all, not `open="false"` or any
     other falsy-but-present form a real browser would ignore), so the
     browser's native click-to-toggle has something real to toggle. ---- */
  const manyFilesResponse = {
    ok: true, status: 200,
    json: () => Promise.resolve({ available: true, repo: "acme/orcha", pull: PULL_DRAFT_TRUNCATED_FILES }),
  };
  const { ghlist: ghlist2, bootThrew: bootThrew2 } = bootDom("https://orcha.example.test/github?pr=200", (url) => {
    if (/\/github\/pulls\/200$/.test(url)) return Promise.resolve(manyFilesResponse);
    return new Promise(() => {});
  });
  assert(!bootThrew2, "a second independent boot (a different PR, more than 3 files) also boots clean");
  await domSettle(6);
  ghlist2.dispatch("click", { target: fakeTargetFor("data-gh-subtab"), stopPropagation() {} });
  await domSettle(2);
  const manyFilesHtml = ghlist2.innerHTML;
  const manySections = manyFilesHtml.match(/<details class="gh-file-row"[^>]*>[\s\S]*?<\/details>/g) || [];
  assert(manySections.length === 100, "a 100-file live-rendered Files tab still carries one <details> per file");
  assert(/ open>/.test(manySections[0]) && / open>/.test(manySections[1]) && / open>/.test(manySections[2]),
    "the first 3 files render open (expanded) by default off a real fetch round trip");
  const collapsedSection = manySections[3];
  assert(!/ open>/.test(collapsedSection) && !/open="/.test(collapsedSection),
    "a collapsed file's <details> carries NO open attribute at all — the exact state a click on its <summary> toggles natively (no JS needed, per fileRowHtml's own contract)");
  assert(/<summary class="gh-file-sum">/.test(collapsedSection),
    "a collapsed section still renders its <summary> header (filename/status/+-/chevron) — visible and clickable even while collapsed");
}

function run() {
  behaviorTests();
  wiringTests();
  if (failures) { console.error("\n" + failures + " failure(s)"); process.exit(1); }
  domTests().then(() => {
    if (failures) { console.error("\n" + failures + " failure(s)"); process.exit(1); }
    console.log("\nall github detail tests passed");
  }).catch((e) => {
    console.error("domTests threw:", e);
    process.exit(1);
  });
}

run();
