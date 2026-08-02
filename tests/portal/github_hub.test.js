/* ============================================================================
   GitHub hub page (Feature A frontend) — module contracts + wiring pins.

   Backend contract (github_hub_routes.py, sibling worktree — coded against the
   spec's shapes, not the live routes; the page must degrade to a friendly card
   if an endpoint 404s, which also covers deploy-order if that PR lands after
   this one):
     GET  /api/containers/{cid}/github/issues -> {repo, issues:[...]}
     GET  /api/containers/{cid}/github/pulls  -> {repo, pulls:[...]}
     POST /api/containers/{cid}/github/start  {kind, number, assignee_agent_id?}
       -> {task_id, existing?: true}

   Part 1 (static): github.html follows the house page skeleton (D0 head +
   shell mounts + module load order + skeleton.css placement), and the page is
   registered where pages are enumerated — the app-shell nav list (CONTROL
   ROOM group) and the app-ui icon set (an octocat-ish glyph in the same
   thin-stroke idiom as the rest of I, never the filled GitHub mark used
   elsewhere for real repo chips).

   Part 2 (behavior): loads the REAL pages/github-state.js in a bare vm and
   pins the payload -> HTML render: the checks-rollup chip math (pass/fail/
   pending priority, no-checks), the merge chip (draft/clean/other), the
   mine-filter (issues: assignee_login; pulls: requested_reviewers), the
   needs-review filter (pulls only, excludes drafts), text search over
   title/number, the Start control (bare + dropdown split, already-tracked
   task-id chip with the {existing:true} label), the assignee roster dropdown
   markup, and the three degrade states (not connected / rate-limited /
   generic error) driven off classifyError's {kind} in github-render.js.

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

const ISSUE_OPEN = { number: 42, title: "Flaky retry on cold start", labels: ["bug", "P1"],
  assignee_login: "octocat", updated_at: "2026-07-31T01:00:00+00:00",
  html_url: "https://github.com/acme/orcha/issues/42", body_excerpt: "Retries fail on cold start…" };
const ISSUE_UNASSIGNED = { number: 7, title: "Docs: onboarding typo", labels: [],
  assignee_login: null, updated_at: "2026-07-30T01:00:00+00:00",
  html_url: "https://github.com/acme/orcha/issues/7", body_excerpt: "" };

const PR_CLEAN = { number: 101, title: "Fix retry backoff", head_branch: "fix/retry-backoff",
  draft: false, updated_at: "2026-07-31T02:00:00+00:00",
  html_url: "https://github.com/acme/orcha/pull/101",
  requested_reviewers: ["octocat", "hubot"], checks: { passed: 5, failing: 0, pending: 0, total: 5 },
  mergeable_state: "clean" };
const PR_FAILING = { number: 102, title: "WIP: new onboarding flow", head_branch: "feat/onboarding",
  draft: false, updated_at: "2026-07-31T03:00:00+00:00",
  html_url: "https://github.com/acme/orcha/pull/102",
  requested_reviewers: [], checks: { passed: 2, failing: 1, pending: 1, total: 4 },
  mergeable_state: "unstable" };
const PR_DRAFT = { number: 103, title: "Draft: spike", head_branch: "spike/x",
  draft: true, updated_at: "2026-07-31T04:00:00+00:00",
  html_url: "https://github.com/acme/orcha/pull/103",
  requested_reviewers: ["octocat"], checks: { passed: 0, failing: 0, pending: 0, total: 0 },
  mergeable_state: "draft" };

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
  assert(issueRow.includes("octocat"), "issue row shows the assignee login");
  const unassignedRow = G.issueRowHtml(ISSUE_UNASSIGNED, AGENTS, () => null);
  assert(unassignedRow.includes("Unassigned"), "unassigned issue shows the honest Unassigned state, not a blank");

  // ---- row render: pulls (checks + merge + reviewers) ----
  const prRow = G.pullRowHtml(PR_CLEAN, AGENTS, () => null);
  assert(prRow.includes("#101") && prRow.includes("fix/retry-backoff"), "PR row carries number + head branch");
  assert(prRow.includes("5 passed") && prRow.includes("Checks passed"), "PR row composes both the checks chip and merge chip");
  assert((prRow.match(/av gh/g) || []).length === 2, "PR row renders one avatar per requested reviewer (capped at 3)");
  const draftRow = G.pullRowHtml(PR_DRAFT, AGENTS, () => null);
  assert(draftRow.includes("Draft"), "draft PR row is visually marked draft");

  // ---- start control: bare Start + dropdown split ----
  const startHtml = G.startCellHtml("issue", ISSUE_OPEN, null);
  assert(/data-gh-start="issue"/.test(startHtml) && /data-gh-number="42"/.test(startHtml),
    "bare Start button carries kind+number for the unassigned POST");
  assert(/data-gh-start-dd="issue"/.test(startHtml), "the split [v] carries its own dropdown trigger data attrs");
  assert(startHtml.includes("Start"), "bare Start reads \"Start\" (unassigned — Atlas routes it per the spec)");

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
    "mine/issues: matches when assignee_login === my github_login");
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
  hostile.assignee_login = '"><svg onload=alert(2)>';
  const hostileRow = G.issueRowHtml(hostile, AGENTS, () => null);
  assert(!hostileRow.includes("<img src=x") && !hostileRow.includes("<script>bad()") && !hostileRow.includes("<svg onload"),
    "title, labels, and assignee_login are all HTML-escaped");
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
  // issues/pulls refresh — never every 3s tick (heavier, GitHub-backed).
  assert(/OrchaData\.start\(/.test(BOOT_JS), "github-boot.js drives the page off the shared OrchaData.start poll");
  assert(/setInterval\(\(\)\s*=>\s*load\(tab,\s*true\),\s*60000\)/.test(BOOT_JS),
    "issues/pulls refresh on their own 60s timer, independent of the 3s snapshot tick");

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
