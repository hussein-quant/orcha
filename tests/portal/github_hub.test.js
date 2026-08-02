/* ============================================================================
   GitHub hub page (Feature A frontend) — module contracts + wiring pins.

   Backend contract (github_hub_routes.py — VERIFIED against the shipped
   routes, not the pre-implementation spec; the page must degrade to a
   friendly card if an endpoint 404s, which also covers deploy-order if that
   PR lands after this one):
     GET  /api/containers/{cid}/github/issues -> {available, repo, issues:[...]}
     GET  /api/containers/{cid}/github/pulls  -> {available, repo, pulls:[...]}
     POST /api/containers/{cid}/github/start  {kind, number, assignee_agent_id?}
       -> {task_id, existing?: true}
   issue entries carry `assignee` (a bare login string); pull entries carry
   `head` (the branch ref string) — NOT `assignee_login`/`head_branch`, the
   pre-implementation spec's field names this suite originally pinned before
   a founder smoke test caught the drift (see the PR_LIVE_SHAPE_* fixtures
   and the item-1 regression block in behaviorTests below).

   Part 1 (static): github.html follows the house page skeleton (D0 head +
   shell mounts + module load order + skeleton.css placement), and the page is
   registered where pages are enumerated — the app-shell nav list (CONTROL
   ROOM group) and the app-ui icon set (an octocat-ish glyph in the same
   thin-stroke idiom as the rest of I, never the filled GitHub mark used
   elsewhere for real repo chips).

   Part 2 (behavior): loads the REAL pages/github-state.js in a bare vm and
   pins the payload -> HTML render: the checks-rollup chip math (pass/fail/
   pending priority, no-checks, ring/x/check glyphs), the merge chip
   (draft/clean/other), the mine-filter (issues: assignee; pulls:
   requested_reviewers), the needs-review filter (pulls only, excludes
   drafts), text search over title/number, the Start control (bare +
   dropdown split, already-tracked task-id chip with the {existing:true}
   label), the assignee roster dropdown markup, the row-kind iconography and
   compact Unassigned chip (items 3-4), and the three degrade states (not
   connected / rate-limited / generic error) driven off classifyError's
   {kind} in github-render.js.

   Part 3 (wiring, grep-level — mirrors metrics_page.test.js's house style for
   DOM-glue files that are fetch/event heavy rather than pure): github-boot.js
   wires OrchaSkeleton.show/.swap + OrchaData.start; github-render.js wires the
   POST body shape + classifyError status mapping; github.html carries no
   external script/stylesheet references.

   Run: node tests/portal/github_hub.test.js
   ========================================================================== */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const STATIC = path.join(
  __dirname, "..", "..",
  "orcha-cli", "orcha_cli", "templates", "portal", "static"
);
const read = (...p) => fs.readFileSync(path.join(STATIC, ...p), "utf8");

const HTML = read("github.html");
const STATE_JS = read("pages", "github-state.js");
const RENDER_JS = read("pages", "github-render.js");
const BOOT_JS = read("pages", "github-boot.js");
const CSS = read("pages", "github.css");
const SHELL_JS = read("modules", "app-shell.js");
const UI_JS = read("modules", "app-ui.js");
const DASH_ROUTES = read("..", "portal_backend", "dashboard_routes.py");

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log("  ✓ " + msg);
  else { failures++; console.error("  ✗ " + msg); }
}

/* ---------------- part 1: static structure + registration ---------------- */
function staticTests() {
  console.log("static structure (github.html + registration)\n");

  assert(/<aside class="sidebar" id="sidebar">/.test(HTML), "sidebar shell mount");
  assert(/<header class="topbar" id="topbar">/.test(HTML), "topbar shell mount");
  assert(/styles\/tokens\.css/.test(HTML) && /styles\/shell\.css/.test(HTML),
    "token + shell stylesheets loaded");
  const order = ["modules/app-state.js", "modules/app-shell.js", "modules/app-skeleton.js",
    "app.js", "data.js", "pages/github-state.js", "pages/github-render.js", "pages/github-boot.js"];
  let last = -1, ordered = true;
  order.forEach((f) => {
    const at = HTML.indexOf('src="/assets/' + f + '"');
    if (at < 0 || at < last) ordered = false;
    last = at;
  });
  assert(ordered, "shared modules then github-state -> github-render -> github-boot, in browser load order");
  assert(/id="ghTabs"/.test(HTML) && /data-tab="issues"/.test(HTML) && /data-tab="pulls"/.test(HTML),
    "Issues / PRs tabs present (aut/seg idiom, matches metrics' 7/30-day toggle)");
  assert(/id="ghFilters"/.test(HTML), "filter-chip mount present");
  assert(/id="ghSearch"/.test(HTML), "client-side title/number search input present");
  assert(/id="ghlist"/.test(HTML), "single payload-driven #ghlist mount");
  assert(/pages\/github\.css/.test(HTML), "page stylesheet loaded");

  // house skeleton placement convention (page_skeletons.test.js PART G): right
  // after skin-minimal.css.
  const skinIdx = HTML.indexOf('href="/assets/styles/skin-minimal.css"');
  const skelIdx = HTML.indexOf('href="/assets/styles/skeleton.css"');
  assert(skinIdx !== -1 && skelIdx !== -1 && skelIdx > skinIdx && skelIdx - skinIdx < 120,
    "github.html loads skeleton.css immediately after skin-minimal.css");

  // no external refs: every script/stylesheet is same-origin /assets/...
  const scriptSrcs = [...HTML.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]);
  const linkHrefs = [...HTML.matchAll(/<link[^>]+href="([^"]+)"/g)].map((m) => m[1]);
  assert(scriptSrcs.length > 0 && scriptSrcs.every((s) => s.startsWith("/assets/")),
    "every <script src> is a same-origin /assets/ path (no CDN/external JS)");
  assert(linkHrefs.every((h) => h.startsWith("/assets/")), "every <link href> is a same-origin /assets/ path");
  assert(!/cdn\.|unpkg\.|jsdelivr\./i.test(HTML), "no CDN references");

  // registration: nav entry + icon everywhere pages are enumerated
  assert(/href: withCid\("\/github"\), ico: "github", label: "GitHub"/.test(SHELL_JS),
    "app-shell nav registers the GitHub entry (cid-carrying, like every in-project link, CONTROL ROOM group)");
  assert(/github: '<path/.test(UI_JS), "app-ui icon set carries the github glyph");
  // the octocat glyph must be a stroke path like its siblings, never the filled
  // GitHub mark (that one is ghMarkSVG() in home-github.js, reused for real repo
  // chips/badges — mixing the two would read as two different GitHub logos).
  assert(!/fill="currentColor"[^}]*github:/.test(UI_JS), "the sidebar glyph stays in the thin-stroke family (not a filled mark)");

  // page route: /github serves github.html (dashboard_routes.py — disjoint from
  // the backend worktree's new github_hub_routes.py API file).
  assert(/@app\.get\("\/github"/.test(DASH_ROUTES) && /serve_page\("github\.html"\)/.test(DASH_ROUTES),
    "GET /github route serves github.html");

  // CSS: token-driven only (skin-safe: classic, swiss, minimal all read correctly)
  assert(!/#[0-9a-fA-F]{3,8}\b/.test(CSS.replace(/\/\*[\s\S]*?\*\//g, "")), "github.css uses tokens only (no hardcoded hex colors)");
  assert(!/rgba?\(/.test(CSS.replace(/\/\*[\s\S]*?\*\//g, "")), "github.css has no raw rgb()/rgba() literals either");

  // ---- item 2: tab selected state ----
  // #ghTabs reuses shell.css's .aut/.seg idiom, but every .seg.on rule there is
  // scoped to a modifier class (.run/.paused/.lvl/.lock) the tabs never carry —
  // bare .seg.on was inert (no background/color/border-color), so the founder
  // couldn't tell which tab was active. Mirror the Open/Mine filter chip's own
  // .on treatment (line "filters button.on") on the tabs specifically.
  assert(/#ghTabs\.aut \.seg\.on\s*\{[^}]*background:\s*var\(--accent-soft\)[^}]*color:\s*var\(--accent\)[^}]*border-color:\s*var\(--accent-line\)/.test(CSS),
    "the active GitHub tab gets the same accent-soft/accent/accent-line treatment as the active filter chip");
  const filterOnRule = CSS.match(/\.filters button\.on\s*\{([^}]*)\}/);
  const tabOnRule = CSS.match(/#ghTabs\.aut \.seg\.on\s*\{([^}]*)\}/);
  assert(!!filterOnRule && !!tabOnRule && filterOnRule[1].replace(/\s+/g, " ").trim() === tabOnRule[1].replace(/\s+/g, " ").trim(),
    "the tab .on rule body is IDENTICAL to the filter chip .on rule body — one active-state idiom, not a near-miss");

  // ---- item 3: compact rows + inline-SVG iconography (no external assets) ----
  assert(/\.ghrow\s*\{[^}]*padding:\s*9px 10px/.test(CSS),
    "row padding matches the tasks list's .trow density (9px 10px), not the old sparse 12px 12px");
  assert(/\.gh-kind-ico\b/.test(CSS), "row-kind icon class (.gh-kind-ico) is styled — issue dot-circle / PR arrow glyphs");
  assert(/issueDot:\s*'<circle/.test(UI_JS) && /pullArrow:\s*'<circle/.test(UI_JS),
    "the issue dot-circle and PR arrow glyphs are inline SVG paths in app-ui.js's shared icon set, not external image assets");
  assert(/ring:\s*'<circle/.test(UI_JS), "the checks-pending glyph (○) is an inline SVG path too");

  // ---- item 4: compact "Unassigned" chip ----
  assert(/\.tag\.gh-unassigned\s*\{[^}]*border-style:\s*dashed/.test(CSS),
    "Unassigned is a .tag-sized chip with (at most) a subtle dashed border, not the shared 22px-padded .none empty-state block");
  assert(!/\.gh-assignee\.none\s*\{/.test(CSS), "the old .gh-assignee.none rule (which collided with the global oversized .none block) is gone");

  // ---- founder regression: checks/reviewers placeholder chips must not
  // collide with the bare global .none empty-state class (styles/
  // components.css: a 22px-padded dashed box) the same way Unassigned once
  // did. Every one of these three states now has its OWN modifier class name
  // (.loading / .zero / .empty) that never equals "none" — a mutation that
  // renames any of them back to `none` (in EITHER github.css's rule or
  // github-state.js's class string, item above) breaks this CSS-side
  // guard AND the render-side guard above. ----
  assert(!/\.tag\.gh-checks\.none\s*\{/.test(CSS),
    "no .tag.gh-checks.none rule exists in github.css (renamed to .zero/.loading, no collision with the global .none block)");
  assert(/\.tag\.gh-checks\.zero\s*\{/.test(CSS), "the zero-total checks chip has its own .zero rule");
  assert(/\.tag\.gh-checks\.loading\s*\{/.test(CSS), "the loading-placeholder checks chip has its own .loading rule");
  assert(!/\.gh-reviewers\.none\s*\{/.test(CSS),
    "no .gh-reviewers.none rule exists in github.css (renamed to .empty, no collision with the global .none block)");
  assert(/\.gh-reviewers\.empty\s*\{/.test(CSS), "the empty-reviewers chip has its own .empty rule");
}

/* ---------------- part 2: behavior (pages/github-state.js) --------------- */
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
  { id: "h-1", alias: "Kedar", kind: "human" },
];

// Fixture field names match the SHIPPED backend (github_hub_routes.py's
// _issue_entry/_pull_entry), NOT the header comment's originally-drafted
// spec — issues carry `assignee` (a bare login string), pulls carry `head`
// (the branch ref string). BUG ROOT CAUSE (item 1): the two PRs (#93 UI,
// #94 API) landed independently against that draft spec and drifted; the
// UI kept reading `assignee_login`/`head_branch`, fields the real API never
// sends, so a founder smoke test against the live route (GET .../pulls ->
// {available:true, pulls:[26 items]}, confirmed healthy, ~58ms) rendered
// pull rows with the branch name silently blank and every issue's real
// assignee dropped to "Unassigned" — the OLD fixtures below (pre-fix) had
// hand-coded the WRONG field names too, so this test suite never caught the
// mismatch against a browser. issueRowHtml/pullRowHtml now read `assignee`/
// `head`; matchesFilter's mine/issues branch was fixed the same way.
// Labels are {name, color} objects (github_hub_routes.py's _labels — GitHub's
// own hex, no leading '#'), the backend addition landed alongside this UI so
// tags render in their real repo colors (labelChipHtml, item below).
const ISSUE_OPEN = { number: 42, title: "Flaky retry on cold start",
  labels: [{ name: "bug", color: "d73a4a" }, { name: "P1", color: "e99695" }],
  assignee: "octocat", updated_at: "2026-07-31T01:00:00+00:00",
  html_url: "https://github.com/acme/orcha/issues/42", body_excerpt: "Retries fail on cold start…" };
const ISSUE_UNASSIGNED = { number: 7, title: "Docs: onboarding typo", labels: [],
  assignee: null, updated_at: "2026-07-30T01:00:00+00:00",
  html_url: "https://github.com/acme/orcha/issues/7", body_excerpt: "" };

const PR_CLEAN = { number: 101, title: "Fix retry backoff", head: "fix/retry-backoff",
  draft: false, updated_at: "2026-07-31T02:00:00+00:00",
  html_url: "https://github.com/acme/orcha/pull/101",
  requested_reviewers: ["octocat", "hubot"], checks: { passed: 5, failing: 0, pending: 0, total: 5 },
  mergeable_state: "clean" };
const PR_FAILING = { number: 102, title: "WIP: new onboarding flow", head: "feat/onboarding",
  draft: false, updated_at: "2026-07-31T03:00:00+00:00",
  html_url: "https://github.com/acme/orcha/pull/102",
  requested_reviewers: [], checks: { passed: 2, failing: 1, pending: 1, total: 4 },
  mergeable_state: "unstable" };
const PR_DRAFT = { number: 103, title: "Draft: spike", head: "spike/x",
  draft: true, updated_at: "2026-07-31T04:00:00+00:00",
  html_url: "https://github.com/acme/orcha/pull/103",
  requested_reviewers: ["octocat"], checks: { passed: 0, failing: 0, pending: 0, total: 0 },
  mergeable_state: "draft" };

// EXACT founder-reported live shape from GET /api/containers/{cid}/github/pulls
// (available:true, 58ms, 26 real items) — the regression fixture for item 1,
// deliberately field-for-field identical to what the founder pasted: {checks,
// draft, head, html_url, mergeable_state, number, requested_reviewers, title,
// updated_at} and nothing else (no head_branch, no id, no user object — just
// the flattened shape the route actually returns). One draft PR + one with an
// empty requested_reviewers, per the task's ask.
const PR_LIVE_SHAPE_DRAFT = {
  checks: { passed: 0, failing: 0, pending: 0, total: 0 },
  draft: true,
  head: "spike/founder-repro",
  html_url: "https://github.com/acme/orcha/pull/200",
  mergeable_state: "draft",
  number: 200,
  requested_reviewers: [],
  title: "Draft: founder-reported repro",
  updated_at: "2026-08-01T12:00:00+00:00",
};
const PR_LIVE_SHAPE_READY = {
  checks: { passed: 3, failing: 0, pending: 0, total: 3 },
  draft: false,
  head: "fix/founder-repro",
  html_url: "https://github.com/acme/orcha/pull/201",
  mergeable_state: "clean",
  number: 201,
  requested_reviewers: [],
  title: "Fix: founder-reported repro",
  updated_at: "2026-08-01T13:00:00+00:00",
};

function behaviorTests() {
  console.log("\nbehavior (pages/github-state.js render from fixture payloads)\n");
  const G = boot();
  assert(!!G, "github-state.js exposes window.OrchaGithubHub standalone (no app.js needed)");

  // ---- checks rollup math ----
  assert(G.checksChipHtml({ passed: 5, failing: 0, pending: 0, total: 5 }).includes("5 passed")
    && G.checksChipHtml({ passed: 5, failing: 0, pending: 0, total: 5 }).includes("gh-checks pass"),
    "all-green rollup -> N passed, green chip class");
  assert(G.checksChipHtml({ passed: 2, failing: 1, pending: 1, total: 4 }).includes("1 failing")
    && G.checksChipHtml({ passed: 2, failing: 1, pending: 1, total: 4 }).includes("gh-checks fail"),
    "any failing takes priority over pending/passed -> N failing, red chip class");
  assert(G.checksChipHtml({ passed: 2, failing: 0, pending: 3, total: 5 }).includes("3 pending")
    && G.checksChipHtml({ passed: 2, failing: 0, pending: 3, total: 5 }).includes("gh-checks pend"),
    "no failures but pending checks -> N pending, amber chip class");
  assert(G.checksChipHtml({ passed: 0, failing: 0, pending: 0, total: 0 }).includes("No checks"),
    "zero-total rollup renders the honest no-checks state, not \"0 passed\"");

  // ---- checks rollup: null placeholder (progressive-fill "not loaded yet") ----
  assert(G.checksChipHtml(null).includes("checks…") && /class="tag gh-checks loading"/.test(G.checksChipHtml(null)),
    "checks:null (not loaded yet) renders a quiet loading placeholder chip, distinct from a real zero-total rollup");
  assert(G.checksChipHtml(undefined).includes("checks…"),
    "checksChipHtml treats undefined the same as null (not loaded yet)");
  assert(!G.checksChipHtml(null).includes("No checks"),
    "the null placeholder never reads as an honest \"No checks\" result — those are two different facts");

  // ---- founder regression: NO placeholder/degraded chip may borrow the bare
  // global .none empty-state class (styles/components.css — a 22px-padded
  // dashed box meant for full-panel empty states). This is the SAME class of
  // bug the Unassigned chip hit earlier (see that regression assertion
  // below): a `.foo.none` rule that only overrides `color` does not stop the
  // bare `.none` selector's border/padding/border-radius from applying too
  // (CSS classes are additive), so the chip renders oversized. Mutation: if a
  // future change reintroduces `class="... none"` on any of these three
  // chips, this assertion goes red. ----
  assert(!/class="tag gh-checks none"/.test(G.checksChipHtml(null)),
    "the loading placeholder chip does not carry the bare .none class");
  assert(!/class="tag gh-checks none"/.test(G.checksChipHtml({ passed: 0, failing: 0, pending: 0, total: 0 })),
    "the zero-total \"No checks\" chip does not carry the bare .none class either (renamed to .zero)");
  assert(/class="tag gh-checks zero"/.test(G.checksChipHtml({ passed: 0, failing: 0, pending: 0, total: 0 })),
    "the zero-total chip carries its own .zero modifier class");
  assert(!/class="gh-reviewers none"/.test(G.reviewersHtml([])),
    "the empty-reviewers em-dash chip does not carry the bare .none class either (renamed to .empty)");
  assert(/class="gh-reviewers empty"/.test(G.reviewersHtml([])),
    "the empty-reviewers chip carries its own .empty modifier class");

  // ---- merge chip ----
  assert(G.mergeChipHtml({ draft: false, mergeable_state: "clean" }).includes("Checks passed")
    && G.mergeChipHtml({ draft: false, mergeable_state: "clean" }).includes("gh-merge ok"),
    "mergeable_state clean -> green \"Checks passed\" chip");
  assert(G.mergeChipHtml({ draft: false, mergeable_state: "unstable" }).includes(">Merge<")
    && !G.mergeChipHtml({ draft: false, mergeable_state: "unstable" }).includes("gh-merge ok"),
    "non-clean mergeable_state -> neutral \"Merge\" chip");
  assert(G.mergeChipHtml({ draft: true, mergeable_state: "draft" }).includes("Draft"),
    "draft PR shows a Draft chip ahead of the merge state");

  // ---- row render: issues ----
  const issueRow = G.issueRowHtml(ISSUE_OPEN, AGENTS, () => null);
  assert(issueRow.includes("#42") && issueRow.includes("Flaky retry on cold start"),
    "issue row carries number + title");
  assert(issueRow.includes("bug") && issueRow.includes("P1"), "issue row carries labels");
  assert(issueRow.includes("octocat"), "issue row shows the assignee login (reads item.assignee, the real API field)");
  assert(/class="gl gh-kind-ico issue"/.test(issueRow), "issue row carries the open-issue dot-circle glyph (item 3)");
  const unassignedRow = G.issueRowHtml(ISSUE_UNASSIGNED, AGENTS, () => null);
  assert(unassignedRow.includes("Unassigned"), "unassigned issue shows the honest Unassigned state, not a blank");
  assert(/class="tag gh-unassigned"/.test(unassignedRow), "Unassigned renders as a small tag chip (item 4), not the shared 22px-padded .none empty-state block");
  assert(!/class="gh-assignee none"/.test(unassignedRow) && !/<span class="none"/.test(unassignedRow),
    "Unassigned no longer borrows the bare .none class (styles/components.css) that made the label read as an oversized dashed box");

  // ---- row render: pulls (checks + merge + reviewers) ----
  const prRow = G.pullRowHtml(PR_CLEAN, AGENTS, () => null);
  assert(prRow.includes("#101") && prRow.includes("fix/retry-backoff"), "PR row carries number + head branch (reads pr.head, the real API field)");
  assert(prRow.includes("5 passed") && prRow.includes("Checks passed"), "PR row composes both the checks chip and merge chip");
  assert((prRow.match(/av gh/g) || []).length === 2, "PR row renders one avatar per requested reviewer (capped at 3)");
  assert(/class="gl gh-kind-ico pull"/.test(prRow),
    "non-draft PR row carries the pull-request arrow glyph without the draft (grey) modifier");
  const draftRow = G.pullRowHtml(PR_DRAFT, AGENTS, () => null);
  assert(draftRow.includes("Draft"), "draft PR row is visually marked draft");
  assert(/class="gl gh-kind-ico pull draft"/.test(draftRow),
    "draft PR row's kind glyph carries the draft (grey) modifier — green is reserved for ready-to-review (item 3)");

  // ---- progressive fill: a pull row with checks:null (the list's fresh,
  // not-yet-batch-resolved shape) renders the loading placeholder, not a
  // crash and not a false "No checks" ----
  const PR_LOADING_CHECKS = Object.assign({}, PR_CLEAN, { number: 104, checks: null });
  const loadingRow = G.pullRowHtml(PR_LOADING_CHECKS, AGENTS, () => null);
  assert(loadingRow.includes("checks…"), "a pull with checks:null renders the loading placeholder chip in its row");
  assert(!loadingRow.includes("No checks"), "checks:null never renders as a false \"No checks\" result");
  assert(!/class="tag gh-checks none"/.test(loadingRow), "the in-row loading placeholder avoids the bare .none class too");

  // ---- founder regression: uniform compact row height in every checks/
  // reviewers state (the "giant dashed empty-state box" symptom broke this).
  // ghrow itself sets no explicit height (by design — a content-sized flex
  // row), so the real guarantee is that NONE of the state chips inside it can
  // pull in the oversized box-model rule; assert every chip variant renders
  // at the same compact .tag/.gh-reviewers shape (no dashed borders, no extra
  // block-level wrapper) across all three checks states + both reviewers
  // states, so the row's rendered height only ever varies with its own
  // padding/line-height, never a chip's. ----
  const checksVariants = [
    G.checksChipHtml(null),                                             // loading
    G.checksChipHtml({ passed: 0, failing: 0, pending: 0, total: 0 }),  // zero
    G.checksChipHtml({ passed: 3, failing: 0, pending: 0, total: 3 }),  // pass
    G.checksChipHtml({ passed: 0, failing: 1, pending: 0, total: 1 }),  // fail
    G.checksChipHtml({ passed: 0, failing: 0, pending: 2, total: 2 }),  // pending
  ];
  assert(checksVariants.every((html) => /^<span class="tag gh-checks \w+">/.test(html)),
    "every checks-chip state (loading/zero/pass/fail/pending) renders as the SAME compact <span class=\"tag gh-checks ...\"> shape — one inline element, no block-level empty-state wrapper");
  const reviewersVariants = [G.reviewersHtml([]), G.reviewersHtml(["octocat"])];
  assert(reviewersVariants.every((html) => /^<span class="gh-reviewers/.test(html)),
    "both reviewers states (empty em-dash / populated) render as the same compact <span class=\"gh-reviewers...\"> shape");

  // ---- BUG REGRESSION (item 1): render the pulls tab from the EXACT founder-
  // verified live payload shape. GET /api/containers/{cid}/github/pulls was
  // confirmed healthy (available:true, 26 items, 58ms) with each pull shaped
  // exactly {checks, draft, head, html_url, mergeable_state, number,
  // requested_reviewers, title, updated_at} — no head_branch, no
  // assignee_login-style field anywhere on a pull. Root cause: github-state.js
  // read pr.head_branch (issueRowHtml read it.assignee_login on the issues
  // side), a field name from the pre-implementation spec in this file's own
  // header comment, never the shipped route — two independently-landed PRs
  // (#93 UI, #94 API) drifted from that shared draft. Exercising bodyHtml with
  // this literal fixture (a draft PR + an empty requested_reviewers, per the
  // task) is the regression net: any future re-drift on these field names
  // fails loudly here instead of silently blanking the branch/reviewer info
  // in production. */
  const liveShapeBody = G.bodyHtml({
    repo: "acme/orcha",
    items: [PR_LIVE_SHAPE_DRAFT, PR_LIVE_SHAPE_READY],
    tab: "pull", filter: "open", query: "", agents: AGENTS, myLogin: null, startedOf: () => null,
  });
  assert(liveShapeBody.includes("#200") && liveShapeBody.includes("#201"),
    "live-shape regression: both pulls render from the founder-verified payload shape");
  assert(liveShapeBody.includes("Draft: founder-reported repro") && liveShapeBody.includes("Fix: founder-reported repro"),
    "live-shape regression: both PR titles render");
  assert(liveShapeBody.includes("spike/founder-repro") && liveShapeBody.includes("fix/founder-repro"),
    "live-shape regression: the branch name (pr.head) renders — this is exactly what silently blanked under the old pr.head_branch read");
  assert(/tag gh-draft/.test(liveShapeBody), "live-shape regression: the draft PR (draft:true) shows its Draft badge");
  assert((liveShapeBody.match(/gh-reviewers empty/g) || []).length === 2,
    "live-shape regression: both PRs' empty requested_reviewers render the honest em-dash state, not a crash");
  assert(liveShapeBody.includes("3 passed") && liveShapeBody.includes("Checks passed"),
    "live-shape regression: the ready PR's checks/merge chips compose correctly off the real checks/mergeable_state shape");

  // ---- start control: bare Start + dropdown split ----
  const startHtml = G.startCellHtml("issue", ISSUE_OPEN, null);
  assert(/data-gh-start="issue"/.test(startHtml) && /data-gh-number="42"/.test(startHtml),
    "bare Start button carries kind+number for the unassigned POST");
  assert(/data-gh-start-dd="issue"/.test(startHtml), "the split [v] carries its own dropdown trigger data attrs");
  assert(startHtml.includes("Start"), "bare Start reads \"Start\" (unassigned — Atlas routes it per the spec)");

  // ---- dispatch-button label split (founder decision): PR reads "Fix", issue stays
  // "Start" — same data-gh-start POST wiring either way, label/tooltip only. Mutation
  // note: swapping the two labels in dispatchLabel() flips both assertions below to RED.
  const issueStartHtml = G.startCellHtml("issue", ISSUE_OPEN, null);
  assert(/gh-start"[^>]*>Start\s/.test(issueStartHtml), "an ISSUE's dispatch button reads \"Start\"");
  assert(!/gh-start"[^>]*>Fix\s/.test(issueStartHtml), "an ISSUE's dispatch button does NOT read \"Fix\"");
  assert(/title="Dispatch an agent to work on this issue"/.test(issueStartHtml),
    "an ISSUE's dispatch button carries the issue-specific tooltip/aria copy");

  const pullFixHtml = G.startCellHtml("pull", PR_CLEAN, null);
  assert(/gh-start"[^>]*>Fix\s/.test(pullFixHtml), "a PR's dispatch button reads \"Fix\" (not \"Start\")");
  assert(!/gh-start"[^>]*>Start\s/.test(pullFixHtml), "a PR's dispatch button does NOT read \"Start\"");
  assert(/title="Dispatch an agent to fix checks\/review feedback on this PR"/.test(pullFixHtml),
    "a PR's dispatch button carries the PR-specific tooltip/aria copy");
  assert(/data-gh-start="pull"/.test(pullFixHtml) && /data-gh-number="101"/.test(pullFixHtml),
    "the PR Fix button still carries the SAME data-gh-start=\"pull\"+number wiring — label-only change, same POST /github/start behavior");

  // the already-tracked task-id chip state is label-agnostic (same chip for both kinds)
  const pullTrackedHtml = G.startCellHtml("pull", PR_CLEAN, { task_id: "t-999", existing: true });
  assert(pullTrackedHtml.includes("t-999") && pullTrackedHtml.includes("already tracked"),
    "a PR's already-tracked state renders the SAME task-id chip an issue's does (label split only touches the un-started button)");

  // ---- already-tracked / existing state ----
  const trackedHtml = G.startCellHtml("issue", ISSUE_OPEN, { task_id: "t-abc123", existing: false });
  assert(trackedHtml.includes("t-abc123") && trackedHtml.includes('href="/tasks?task=t-abc123"'),
    "a started task renders as a linked task-id chip (portal task deeplink convention)");
  assert(!trackedHtml.includes("already tracked"), "a freshly created task (existing:false) does NOT show the already-tracked label");
  const existingHtml = G.startCellHtml("issue", ISSUE_OPEN, { task_id: "t-abc123", existing: true });
  assert(existingHtml.includes("already tracked"),
    "idempotent re-Start ({existing:true} from the backend) shows the \"already tracked\" state instead of a duplicate button");

  // ---- assignee roster dropdown ----
  const roster = G.agentRosterHtml("issue", 42, AGENTS);
  assert(roster.includes("Forge") && roster.includes("Atlas"), "dropdown lists the container's AI agents");
  assert(!roster.includes("Kedar"), "dropdown excludes human members (assignee_agent_id targets an AI agent)");
  assert(/data-gh-assign="a-1"/.test(roster) && /data-gh-kind="issue"/.test(roster) && /data-gh-number="42"/.test(roster),
    "each dropdown row carries the agent id + kind + number needed to fire the assigned Start POST");
  const emptyRoster = G.agentRosterHtml("issue", 42, []);
  assert(emptyRoster.includes("No AI agents"), "an empty roster shows an honest empty state, not a blank menu");

  // ---- mine filter ----
  assert(G.matchesFilter("issue", ISSUE_OPEN, "mine", "octocat") === true,
    "mine/issues: matches when item.assignee === my github_login (the real API field, not assignee_login)");
  assert(G.matchesFilter("issue", ISSUE_OPEN, "mine", "someone-else") === false,
    "mine/issues: excludes issues assigned to someone else");
  assert(G.matchesFilter("issue", ISSUE_UNASSIGNED, "mine", "octocat") === false,
    "mine/issues: excludes unassigned issues");
  assert(G.matchesFilter("pull", PR_CLEAN, "mine", "hubot") === true,
    "mine/pulls: matches when I'm a requested reviewer");
  assert(G.matchesFilter("pull", PR_FAILING, "mine", "hubot") === false,
    "mine/pulls: excludes PRs where I'm not a requested reviewer");
  assert(G.matchesFilter("issue", ISSUE_OPEN, "mine", null) === false,
    "mine filter with no resolved github_login (identity not yet loaded) matches nothing, never a false positive");

  // ---- needs-review filter (pulls only) ----
  assert(G.matchesFilter("pull", PR_CLEAN, "needs-review", "octocat") === true,
    "needs-review: matches a non-draft PR where I'm a requested reviewer");
  assert(G.matchesFilter("pull", PR_DRAFT, "needs-review", "octocat") === false,
    "needs-review: excludes drafts even if I'm a requested reviewer");
  assert(G.matchesFilter("issue", ISSUE_OPEN, "needs-review", "octocat") === false,
    "needs-review is a pulls-only concept — issues never match it");

  // ---- open filter (default) ----
  assert(G.matchesFilter("issue", ISSUE_OPEN, "open", null) === true,
    "open filter passes everything (both endpoints already return open-only)");

  // ---- text search over title/number ----
  assert(G.matchesSearch("issue", ISSUE_OPEN, "retry") === true, "search matches on title substring, case-insensitive-ish");
  assert(G.matchesSearch("issue", ISSUE_OPEN, "RETRY") === true, "search is case-insensitive");
  assert(G.matchesSearch("issue", ISSUE_OPEN, "42") === true, "search matches on bare issue number");
  assert(G.matchesSearch("issue", ISSUE_OPEN, "#42") === true, "search matches on #-prefixed issue number");
  assert(G.matchesSearch("issue", ISSUE_OPEN, "nope") === false, "search excludes non-matching queries");
  assert(G.matchesSearch("issue", ISSUE_OPEN, "") === true, "empty query matches everything");

  // ---- filter chips ----
  const issueChips = G.filterChipsHtml("issue", "open");
  assert(issueChips.includes("Open") && issueChips.includes("Mine") && !issueChips.includes("Needs review"),
    "issues tab shows Open/Mine only (no Needs review — that's PR-specific)");
  const pullChips = G.filterChipsHtml("pull", "mine");
  assert(pullChips.includes("Needs review"), "pulls tab adds the Needs review chip");
  assert(/data-gh-filter="mine"[^>]*>\s*Mine|class="on" data-gh-filter="mine"/.test(pullChips) || pullChips.includes('class="on" data-gh-filter="mine"'),
    "the active filter carries the .on class");

  // ---- whole-body composition + degrade states ----
  const listBody = G.bodyHtml({ repo: "acme/orcha", items: [ISSUE_OPEN, ISSUE_UNASSIGNED], tab: "issue", filter: "open", query: "", agents: AGENTS, myLogin: null, startedOf: () => null });
  assert(listBody.includes("#42") && listBody.includes("#7"), "bodyHtml composes one row per item for the active tab");

  const filteredEmpty = G.bodyHtml({ repo: "acme/orcha", items: [ISSUE_OPEN], tab: "issue", filter: "mine", query: "", agents: AGENTS, myLogin: "nobody", startedOf: () => null });
  assert(filteredEmpty.includes("No issues match this filter"), "a filter that excludes every item shows an honest \"no match\" message, not a blank list");

  const zeroOpen = G.bodyHtml({ repo: "acme/orcha", items: [], tab: "pull", filter: "open", query: "", agents: AGENTS, myLogin: null, startedOf: () => null });
  assert(zeroOpen.includes("No open pull requests"), "zero open PRs renders the honest zero state");

  const notConnected = G.bodyHtml({ repo: null, error: { kind: "not_connected" } });
  assert(notConnected.includes("No GitHub repo connected") && /href="\/"/.test(notConnected),
    "repo-not-connected renders the friendly card linking to the Dashboard connect flow (home.html's #ctxbar Connect-repo affordance — Settings has no GitHub tab today)");

  const rateLimited = G.bodyHtml({ repo: "acme/orcha", error: { kind: "rate_limited" } });
  assert(rateLimited.includes("rate limit") && !rateLimited.includes("Connect"), "rate-limited renders a quiet retry note, distinct from the not-connected card");

  const genericErr = G.bodyHtml({ repo: "acme/orcha", error: { kind: "error", status: 500, detail: "boom" } });
  assert(genericErr.includes("500") && genericErr.includes("boom"), "a generic error surfaces the status + detail, not a blank page");

  const loadingState = G.bodyHtml({ loading: true, items: null });
  assert(loadingState.includes("Loading"), "no payload yet (first fetch in flight) renders Loading, not an empty list");

  // ---- escaping: attacker-controlled title/label/login never lands unescaped ----
  const hostile = JSON.parse(JSON.stringify(ISSUE_OPEN));
  hostile.title = '<img src=x onerror=alert(1)>';
  hostile.labels = ['<script>bad()</script>'];
  hostile.assignee = '"><svg onload=alert(2)>';
  const hostileRow = G.issueRowHtml(hostile, AGENTS, () => null);
  assert(!hostileRow.includes("<img src=x") && !hostileRow.includes("<script>bad()") && !hostileRow.includes("<svg onload"),
    "title, labels, and assignee are all HTML-escaped");

  // ---- checks chip glyph (item 3): leading check/x/ring icon per rollup state ----
  assert(/data-icon="check"/.test(G.checksChipHtml({ passed: 5, failing: 0, pending: 0, total: 5 })),
    "all-passed checks chip carries the check glyph");
  assert(/data-icon="x"/.test(G.checksChipHtml({ passed: 2, failing: 1, pending: 1, total: 4 })),
    "any-failing checks chip carries the x glyph");
  assert(/data-icon="ring"/.test(G.checksChipHtml({ passed: 2, failing: 0, pending: 3, total: 5 })),
    "pending checks chip carries the open-ring (○) glyph, not a clock — pending here means \"in progress/undetermined,\" not \"waiting on time\"");
  assert(/data-icon="check"/.test(G.mergeChipHtml({ draft: false, mergeable_state: "clean" })),
    "clean-merge chip carries the check glyph ahead of \"Checks passed\"");

  // ---- label colors (standout tags, item 2 of the deliverable) -------------
  const redLabel = G.labelChipHtml({ name: "bug", color: "d73a4a" }, "dark");
  assert(redLabel.includes("background:#d73a4a2e") && redLabel.includes("border-color:#d73a4a55"),
    "a colored label's background/border derive from GitHub's own hex at low alpha");
  assert(redLabel.includes("color:#d73a4a"), "dark theme reads the label color at full strength for text");
  assert(redLabel.includes(">bug<"), "the label name renders as the chip text");

  // light theme: a PALE label color (fef2c0, near-white) needs darkened text to
  // stay legible — the background swatch still uses the TRUE color, only the
  // text color is luminance-adjusted.
  const paleLight = G.labelChipHtml({ name: "docs", color: "fef2c0" }, "light");
  assert(paleLight.includes("background:#fef2c02e"), "light theme still swatches the TRUE label color as background");
  assert(!paleLight.includes("color:#fef2c0\""), "light theme darkens a pale label's TEXT color so it stays legible (not the raw near-white hex)");
  const paleDark = G.labelChipHtml({ name: "docs", color: "fef2c0" }, "dark");
  assert(paleDark.includes("color:#fef2c0"), "dark theme reads even a pale label at full strength (dark surfaces don't need the light-theme adjustment)");

  // a saturated/dark label color (e.g. a near-black custom label) needs NO
  // light-theme adjustment — luminance is already low.
  const darkLabelLight = G.labelChipHtml({ name: "critical", color: "1a1a2e" }, "light");
  assert(darkLabelLight.includes("color:#1a1a2e"), "an already-dark label color is used as-is on light theme (no darkening needed)");

  // deterministic fallback palette when GitHub sends no color at all.
  const noColor1 = G.labelChipHtml({ name: "triage" }, "dark");
  const noColor2 = G.labelChipHtml({ name: "triage" }, "dark");
  assert(/background:#[0-9a-f]{6}2e/.test(noColor1), "a colorless label still gets a real hex swatch from the fallback palette");
  assert(noColor1 === noColor2, "the fallback palette is DETERMINISTIC — the same label name always gets the same color");
  const noColorOther = G.labelChipHtml({ name: "completely-different-name" }, "dark");
  assert(noColorOther !== noColor1, "different label names land on different fallback colors (not one flat generic chip)");

  // bare-string label (legacy/defensive — the shipped payload always sends
  // {name,color}, but a bare string must never crash the renderer).
  const bareString = G.labelChipHtml("legacy-string-label", "dark");
  assert(bareString.includes(">legacy-string-label<"), "a bare-string label (no {name,color} wrapper) still renders its name safely");

  // escaping: a hostile label name never lands unescaped.
  const hostileLabel = G.labelChipHtml({ name: '<img src=x onerror=alert(1)>', color: "d73a4a" }, "dark");
  assert(!hostileLabel.includes("<img src=x"), "label name is HTML-escaped in labelChipHtml");

  // escaping: a hostile/malformed label COLOR can never break out of the
  // style="" attribute — GitHub's own color field is untrusted API data
  // reaching an attribute value, so it's validated (strict 6-hex-digit),
  // never trusted verbatim. An invalid color falls back to the deterministic
  // palette instead of being interpolated.
  const hostileColor = G.labelChipHtml({ name: "bug", color: '"><script>alert(1)</script>' }, "dark");
  assert(!hostileColor.includes("<script>alert(1)</script>"),
    "a malicious label.color value cannot break out of the style attribute (rejected -> fallback palette used instead)");
  assert(/style="background:#[0-9a-f]{6}2e/.test(hostileColor),
    "an invalid color falls back to a real 6-hex-digit swatch from the deterministic palette");
  const shortColor = G.labelChipHtml({ name: "bug", color: "abc" }, "dark");
  assert(/style="background:#[0-9a-f]{6}2e/.test(shortColor),
    "a color that ISN'T exactly 6 hex digits (e.g. CSS 3-digit shorthand) also falls back rather than being trusted as-is");

  // issue rows/detail compose labelChipHtml per label, in real colors.
  const coloredIssueRow = G.issueRowHtml(ISSUE_OPEN, AGENTS, () => null, "dark");
  assert(coloredIssueRow.includes("background:#d73a4a2e"), "issue row labels render via labelChipHtml (real GitHub color), not a flat chip");
}

/* ---------------- part 3: wiring (grep-level, DOM-glue files) ------------ */
function wiringTests() {
  console.log("\nwiring (github-render.js POST contract + github-boot.js skeleton/poll)\n");

  // Start POST: same kind/number/assignee_agent_id shape for both the bare
  // button and the dropdown pick (single code path — postStart), hitting the
  // spec's exact endpoint.
  assert(/\/github\/start/.test(RENDER_JS), "postStart hits POST .../github/start");
  assert(/kind:\s*kind/.test(RENDER_JS) && /number:\s*number/.test(RENDER_JS) && /assignee_agent_id:\s*assigneeAgentId/.test(RENDER_JS),
    "POST body carries {kind, number, assignee_agent_id} per the spec's contract");
  assert(/existing/.test(RENDER_JS) && /task_id/.test(RENDER_JS),
    "the Start response's {task_id, existing} is read and cached (already-tracked state)");

  // GET issues/pulls + degrade-on-error (repo-not-connected / rate-limited /
  // generic) — the page must never blank-page when the backend PR hasn't
  // landed yet (404) or GitHub rate-limits (403/429).
  assert(/"\/github\/"\s*\+\s*key/.test(RENDER_JS) && /key\s*=\s*which\s*===\s*"pulls"\s*\?\s*"pulls"\s*:\s*"issues"/.test(RENDER_JS),
    "load() builds the GET url as .../github/<key>, tab-keyed to issues|pulls");
  assert(/status === 404/.test(RENDER_JS) && /not_connected/.test(RENDER_JS),
    "a 404 (repo not connected OR the endpoint doesn't exist yet) classifies as not_connected, not a raw error");
  assert(/403|429/.test(RENDER_JS) && /rate_limited/.test(RENDER_JS),
    "403/429 classifies as rate_limited (quiet retry), distinct from a hard failure");

  // Skeleton wiring (mirrors page_skeletons.test.js PART E's per-page pins).
  assert(/OrchaSkeleton\.show\(/.test(BOOT_JS), "github-boot.js calls OrchaSkeleton.show(...)");
  assert(/OrchaSkeleton\.swap\(/.test(BOOT_JS), "github-boot.js calls OrchaSkeleton.swap(...)");
  assert(BOOT_JS.indexOf('"list-rows"') !== -1, 'github-boot.js uses the "list-rows" skeleton kind (Conductor-style rows, not a detail pane)');
  assert(/window\.OrchaSkeleton/.test(BOOT_JS), "github-boot.js guards the calls behind window.OrchaSkeleton (safe if unloaded)");

  // Shared snapshot poll (shell chrome + agent roster) + independent
  // issues/pulls refresh — never every 3s tick (heavier, GitHub-backed). The
  // detail route (github_detail.test.js) rides the SAME 60s interval, calling
  // loadDetail(true) instead of load(tab,true) while a ?pr=/?issue= route is
  // active — one setInterval, route-gated, not two competing timers.
  assert(/OrchaData\.start\(/.test(BOOT_JS), "github-boot.js drives the page off the shared OrchaData.start poll");
  assert(/setInterval\(\(\)\s*=>\s*\{[\s\S]*?load\(tab,\s*true\)[\s\S]*?\},\s*60000\)/.test(BOOT_JS),
    "issues/pulls refresh on their own 60s timer, independent of the 3s snapshot tick");
  assert(/setInterval\(\(\)\s*=>\s*\{[\s\S]*?loadDetail\(true\)[\s\S]*?\},\s*60000\)/.test(BOOT_JS),
    "the detail route rides the SAME 60s timer (loadDetail(true)), not a second independent interval");

  // Row click delegation: Start / dropdown-toggle, on the persistent #ghlist
  // container (survives repaints — same delegation idiom as tasks/requests).
  assert(/data-gh-start\]/.test(BOOT_JS) && /data-gh-start-dd\]/.test(BOOT_JS),
    "boot delegates both the bare-Start and dropdown-toggle clicks off #ghlist");
}

function run() {
  staticTests();
  behaviorTests();
  wiringTests();
  if (failures) { console.error("\n" + failures + " failure(s)"); process.exit(1); }
  console.log("\nall github hub tests passed");
}

run();
