/* GitHub hub page — pure formatters + view builders (no DOM, no fetch).
   Everything here is a deterministic payload -> HTML-string function so the JS
   harness (tests/portal/github_hub.test.js) can exercise the render from a
   fixture payload without a browser, mirroring metrics-state.js. DOM glue
   (fetch, patch, wiring, mountShell) lives in github-render.js/github-boot.js.

   Endpoint contract (github_hub_routes.py — verified against the SHIPPED
   routes, not the pre-implementation spec; the two landed in independent PRs
   and the field names drifted — see the root-cause note on issueRowHtml/
   pullRowHtml below):
     GET  /api/containers/{cid}/github/issues
       -> { available, repo: "owner/name"|null, issues: [{number, title,
            labels[], assignee, updated_at, html_url, body_excerpt}] }
     GET  /api/containers/{cid}/github/pulls
       -> { available, repo, pulls: [{number, title, head, draft, updated_at,
            html_url, requested_reviewers[], checks: null, mergeable_state}] }
       `checks` is ALWAYS null straight off this endpoint — the list route makes
       exactly ONE GitHub call (the perf fix: it used to build a full checks
       rollup INLINE per row, 2 extra GitHub calls per PR, ~52 round-trips for
       a 26-PR list). null means "not loaded yet," never a real rollup.
     GET  /api/containers/{cid}/github/checks?numbers=1,2,3   (max 30 numbers)
       -> { available, checks: { "<number>": {passed, failing, pending, total} } }
       The list's progressive-fill follow-up: github-render.js calls this right
       after the list paints, for the numbers currently on screen, and patches
       each row's checks chip in place (see maybeLoadChecks()/checksByNumber
       in github-render.js).
       A number absent from the response (closed/merged since, or simply not
       resolvable) just never gets patched — no error, no crash.
     POST /api/containers/{cid}/github/start
       body {kind: "issue"|"pull", number, assignee_agent_id?}
       -> {task_id, existing?: true}
   All three GETs 404 (repo not connected) or 403/429 (rate-limited) as clean
   JSON errors — {"error": "..."} shape assumed; the render layer treats ANY
   non-ok response the same way (friendly card / quiet chip degrade), so the
   exact error body isn't load bearing here. This also covers deploy-order: if
   the backend PR hasn't landed yet, the fetch 404s the same way an unconnected
   repo would, and the page degrades to the same friendly card instead of a
   blank/broken page.

   Labels: {name, color} objects (GitHub's own hex, no leading '#') everywhere
   labels appear — issues list AND issue detail — per the backend addition
   landed alongside this UI (github_hub_routes.py's _labels). labelChipHtml
   computes the tag's background/text color from that hex (or a deterministic
   fallback when color is absent); see the "label colors" section below.

   DETAIL endpoints (github_hub_routes.py, PR #95, merged/deployed):
     GET  /api/containers/{cid}/github/pulls/{number}
       -> { available, repo, pull: {number, title, state, draft,
            body_markdown (RAW), author_login, base, head, updated_at,
            created_at, html_url, mergeable_state, assignees[],
            requested_reviewers[], checks: {passed, failing, pending, total,
            runs:[{name, status, conclusion, html_url}]},
            files: {count, items:[{filename, additions, deletions, status}],
            truncated?}, comments_count, review_comments_count} }
     GET  /api/containers/{cid}/github/issues/{number}
       -> { available, repo, issue: {number, title, state, body_markdown,
            author_login, labels[{name,color}], assignee, assignees[],
            updated_at, created_at, html_url, comments_count,
            comments:[{author_login, body_markdown, created_at}]} }
   Errors: HTTP 200 {available:false, reason}. reason:"not_found" is DETAIL-
   ONLY (a specific issue/PR number 404s distinctly from "repo not connected");
   detailHtml's degrade ladder mirrors bodyHtml's (not_found -> not_connected
   -> rate_limited -> generic), so a missing PR/issue never blank-pages either. */
window.OrchaGithubHub = (function () {
  const esc = (s) => (window.Orcha && window.Orcha.esc)
    ? window.Orcha.esc(s)
    : String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  const trunc = (s, n) => (window.Orcha && window.Orcha.trunc)
    ? window.Orcha.trunc(s, n)
    : ((s || "").length > n ? (s || "").slice(0, n - 1) + "…" : (s || ""));
  const relTime = (iso) => (window.Orcha && window.Orcha.relTime)
    ? window.Orcha.relTime(iso)
    : (iso || "—");
  const avatar = (login) => (window.Orcha && window.Orcha.ghAvatar)
    ? window.Orcha.ghAvatar(login, "sm")
    : `<span class="av sm">${esc((login || "?").charAt(0).toUpperCase())}</span>`;
  const icon = (name, cls) => (window.Orcha && window.Orcha.icon) ? window.Orcha.icon(name, cls) : "";

  /* ---- checks rollup math ------------------------------------------------
     rollup: {passed, failing, pending, total} | null. Chip reads:
       null (not loaded yet) -> quiet "checks…" placeholder, patched in place
         once the batch GET .../github/checks response lands (github-render.js)
       any failing  -> red "n failing"
       else pending -> amber "n pending"
       else passed  -> green "n passed" (total===0 -> no chip, "no checks")
     Every non-colored state (loading placeholder AND the zero-total "No
     checks" case) uses its OWN modifier class (`.loading` / `.zero`) rather
     than the bare `.none` class components.css defines for full-panel empty
     states (a 22px-padded dashed box) — `.tag.gh-checks.none` used to ONLY
     override `color`, so that dashed-box border/padding/border-radius leaked
     straight through into this inline chip (the exact "giant dashed empty
     -state box" class of bug the Unassigned chip hit earlier — see
     .tag.gh-unassigned's note in github.css). Naming the modifier anything
     other than `none` sidesteps the collision entirely; github.css gives
     `.loading`/`.zero` their own small explicit rules. */
  function checksChipHtml(rollup) {
    if (rollup === null || rollup === undefined) {
      return '<span class="tag gh-checks loading">checks…</span>';
    }
    const r = rollup || {};
    const passed = r.passed || 0, failing = r.failing || 0, pending = r.pending || 0;
    const total = r.total != null ? r.total : passed + failing + pending;
    if (!total) return '<span class="tag gh-checks zero">No checks</span>';
    if (failing > 0) return `<span class="tag gh-checks fail">${icon("x", "gl")}${failing} failing</span>`;
    if (pending > 0) return `<span class="tag gh-checks pend">${icon("ring", "gl")}${pending} pending</span>`;
    return `<span class="tag gh-checks pass">${icon("check", "gl")}${passed} passed</span>`;
  }

  /* ---- merge chip --------------------------------------------------------
     "Checks passed" (green) when mergeable_state signals clean; "Merge"
     (neutral) otherwise — mirrors GitHub's own mergeable_state vocabulary
     (clean|unstable|blocked|dirty|behind|draft|unknown|…). */
  const CLEAN_STATES = { clean: 1, has_hooks: 1 };
  function mergeChipHtml(pr) {
    if (pr.draft) return '<span class="tag gh-merge draft">Draft</span>';
    const st = pr.mergeable_state || "unknown";
    if (CLEAN_STATES[st]) return `<span class="tag gh-merge ok">${icon("check", "gl")}Checks passed</span>`;
    return '<span class="tag gh-merge">Merge</span>';
  }

  // `.gh-reviewers.empty` (NOT `.gh-reviewers.none`) for the same reason as
  // checksChipHtml above: the bare global `.none` class (styles/components.css)
  // is a 22px-padded dashed empty-state box, and a `.gh-reviewers.none` rule
  // that only overrides `color` doesn't stop that box styling from applying —
  // it just leaks through. `empty` never collides with `.none`.
  function reviewersHtml(logins) {
    const l = Array.isArray(logins) ? logins : [];
    if (!l.length) return '<span class="gh-reviewers empty">—</span>';
    return `<span class="gh-reviewers">${l.slice(0, 3).map((r) => avatar(r)).join("")}${l.length > 3 ? `<span class="gh-more">+${l.length - 3}</span>` : ""}</span>`;
  }

  function repoChipHtml(repo) {
    return repo ? `<span class="tag gh-repo mono">${esc(repo)}</span>` : "";
  }

  /* ---- label colors -------------------------------------------------------
     GitHub-style tags: background = the repo's own label color at ~18% alpha,
     text = the color at full strength (dark themes) OR a luminance-adjusted
     shade for light themes (a pale label color like "fef2c0" on white is
     unreadable at full strength on a light background, so we darken it there).
     Deterministic fallback palette (hashed off the label name) when GitHub
     sends no color at all — every label still gets a stable, distinct hue
     rather than one flat generic chip. Works in classic/swiss/minimal since
     it's inline style (background/color), not a skin-scoped CSS class. */
  const LABEL_FALLBACK_PALETTE = [
    "d73a4a", "0075ca", "cfd3d7", "a2eeef", "7057ff", "008672",
    "e4e669", "d876e3", "fbca04", "0e8a16", "c5def5", "ff7619",
  ];
  function hueForLabel(name) {
    let h = 0;
    for (const c of String(name || "")) h = (h * 31 + c.charCodeAt(0)) % LABEL_FALLBACK_PALETTE.length;
    return h;
  }
  // Relative luminance (WCAG-ish, sRGB) — decides whether a color reads as
  // "light" (needs darkening for legible text on a light theme) or "dark".
  function hexLuminance(hex) {
    const h = (hex || "").replace(/[^0-9a-fA-F]/g, "").padEnd(6, "0").slice(0, 6);
    const r = parseInt(h.slice(0, 2), 16) / 255;
    const g = parseInt(h.slice(2, 4), 16) / 255;
    const b = parseInt(h.slice(4, 6), 16) / 255;
    const lin = (c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  }
  // Darken a hex color toward black by `amt` (0-1) — used ONLY for the
  // light-theme text color of a pale label, never for the background swatch
  // (the background stays the true GitHub color at low alpha regardless).
  function darkenHex(hex, amt) {
    const h = (hex || "").replace(/[^0-9a-fA-F]/g, "").padEnd(6, "0").slice(0, 6);
    const ch = (i) => Math.max(0, Math.round(parseInt(h.slice(i, i + 2), 16) * (1 - amt)));
    return [0, 2, 4].map((i) => ch(i).toString(16).padStart(2, "0")).join("");
  }
  // Strict 6-hex-digit sanitizer for anything landing in a style="" attribute
  // (GitHub's own label.color field should always already be clean hex, but
  // this is untrusted API data reaching an attribute value — validate rather
  // than trust, same posture as esc() for text content). Anything that isn't
  // EXACTLY 6 hex digits after stripping a leading '#' is rejected outright
  // (null), which sends the caller to the deterministic fallback palette
  // instead of ever interpolating an unvalidated string into style="".
  function sanitizeHexColor(color) {
    if (!color) return null;
    const h = String(color).replace(/^#/, "");
    return /^[0-9a-fA-F]{6}$/.test(h) ? h.toLowerCase() : null;
  }
  function labelChipHtml(label, theme) {
    const name = (label && label.name) || (typeof label === "string" ? label : "");
    const color = sanitizeHexColor(label && label.color) || LABEL_FALLBACK_PALETTE[hueForLabel(name)];
    // light theme + a pale label color (e.g. "fef2c0") needs darkened text to
    // stay legible on the app's light surfaces; dark theme always reads the
    // true color at full strength against the app's dark surfaces.
    const isLight = theme === "light";
    const textColor = isLight && hexLuminance(color) > 0.65 ? darkenHex(color, 0.45) : color;
    return `<span class="tag gh-label" style="background:#${color}2e;color:#${textColor};border-color:#${color}55">${esc(name)}</span>`;
  }

  /* ---- start-button + assignee dropdown ---------------------------------
     Rendered per row. `taskLink` (already-started state) takes precedence:
       - no linked task -> [Start ->][v] split button
       - linked task    -> a task-id chip (portal deeplink), "already tracked"
         label when the create call came back {existing:true}
     agents: the container's AI roster (kind==="ai") for the dropdown. */
  function agentRosterHtml(kind, number, agents) {
    const list = (agents || []).filter((a) => a.kind === "ai");
    if (!list.length) return '<div class="pm-row muted">No AI agents on this project</div>';
    return list.map((a) => `<button class="pm-row" type="button" data-gh-assign="${esc(a.id)}" data-gh-kind="${esc(kind)}" data-gh-number="${esc(number)}">
        <span class="b"><span class="t1">${esc(a.alias)}</span></span>
      </button>`).join("");
  }

  function startCellHtml(kind, item, taskState) {
    // taskState: null (not started) | {task_id, existing} (started this session or
    // resolved from a prior idempotent start — see github-render.js's local cache)
    if (taskState && taskState.task_id) {
      const href = "/tasks?task=" + encodeURIComponent(taskState.task_id);
      return `<a class="dlink gh-task-chip" href="${href}">${icon("tasks", "gl")}${esc(taskState.task_id)}${taskState.existing ? '<span class="gh-already">already tracked</span>' : ""}</a>`;
    }
    return `<div class="gh-start-split">
      <button class="btn approve sm gh-start" type="button" data-gh-start="${esc(kind)}" data-gh-number="${esc(item.number)}">Start ${icon("arrow", "gl")}</button>
      <button class="btn approve sm gh-start-dd" type="button" data-gh-start-dd="${esc(kind)}" data-gh-number="${esc(item.number)}" aria-haspopup="true" aria-expanded="false" title="Assign to an agent">${icon("chev", "gl")}</button>
    </div>`;
  }

  /* ---- rows --------------------------------------------------------------
     started: Map-like lookup fn(kind, number) -> taskState|null, injected so
     this stays a pure fn of (item, started-lookup) rather than owning state.

     Field names match the SHIPPED backend contract (github_hub_routes.py's
     _issue_entry/_pull_entry — already-flattened login/ref strings), not the
     header comment's originally-drafted spec: issues carry `assignee` (a
     login string, not `assignee_login`), pulls carry `head` (the branch ref
     string, not a nested {ref} object, and not `head_branch`). The two PRs
     landed against the spec independently and drifted; a founder smoke test
     caught the mismatch (rows rendered with a blank branch name / "always
     Unassigned" issues), so this reads straight off the real payload shape —
     see the fixtures ISSUE_OPEN/PR_CLEAN in github_hub.test.js.

     Row click = open the detail view (data-gh-open, wired in github-boot.js's
     delegated #ghlist click handler); Start / the assignee dropdown toggle
     call stopPropagation at the wiring layer so a Start click never also
     navigates. `theme` ("light"|"dark") drives labelChipHtml's text-color
     computation — threaded down from the render state (see bodyHtml below),
     never read off `window` here (this file stays DOM-free/pure per its own
     header contract, so it can run in the bare vm test harness). */
  function issueRowHtml(it, agents, startedFn, theme) {
    const started = startedFn ? startedFn("issue", it.number) : null;
    return `<div class="ghrow" data-gh-row="issue:${esc(it.number)}" data-gh-open="issue:${esc(it.number)}">
      ${icon("issueDot", "gl gh-kind-ico issue")}
      <span class="gh-num mono">#${esc(it.number)}</span>
      <span class="grow gh-main">
        <span class="gh-title">${esc(it.title)}</span>
        <span class="gh-meta">${(it.labels || []).slice(0, 4).map((l) => labelChipHtml(l, theme)).join("")}
          ${it.assignee ? `<span class="gh-assignee">${avatar(it.assignee)}<span>${esc(it.assignee)}</span></span>` : '<span class="tag gh-unassigned">Unassigned</span>'}</span>
      </span>
      <span class="gh-reviewers-col"></span>
      <span class="gh-checks-col"></span>
      <span class="gh-merge-col"></span>
      <span class="gh-updated">${esc(relTime(it.updated_at))}</span>
      <span class="gh-actions">${startCellHtml("issue", it, started)}</span>
    </div>`;
  }
  function pullRowHtml(pr, agents, startedFn, theme) {
    const started = startedFn ? startedFn("pull", pr.number) : null;
    return `<div class="ghrow" data-gh-row="pull:${esc(pr.number)}" data-gh-open="pull:${esc(pr.number)}">
      ${icon("pullArrow", "gl gh-kind-ico pull" + (pr.draft ? " draft" : ""))}
      <span class="gh-num mono">#${esc(pr.number)}</span>
      <span class="grow gh-main">
        <span class="gh-title">${pr.draft ? '<span class="tag gh-draft">Draft</span>' : ""}${esc(pr.title)}</span>
        <span class="gh-meta"><span class="gh-branch mono">${esc(pr.head || "")}</span></span>
      </span>
      <span class="gh-reviewers-col">${reviewersHtml(pr.requested_reviewers)}</span>
      <span class="gh-checks-col">${checksChipHtml(pr.checks)}</span>
      <span class="gh-merge-col">${mergeChipHtml(pr)}</span>
      <span class="gh-updated">${esc(relTime(pr.updated_at))}</span>
      <span class="gh-actions">${startCellHtml("pull", pr, started)}</span>
    </div>`;
  }

  /* ---- column-header row (wide viewports only, CSS-hidden below the same
     breakpoint .ghrow wraps at) — ID | TITLE/CONTEXT | REVIEWERS | CHECKS |
     MERGE | UPDATED, per the reference layout. Issues rows leave the
     reviewers/checks/merge columns empty (those are PR-only concepts), so
     one header serves both tabs without a conditional column set. */
  function columnHeaderHtml(tab) {
    return `<div class="ghhead-row" aria-hidden="true">
      <span class="ghh-ico"></span>
      <span class="ghh-num">ID</span>
      <span class="grow ghh-main">TITLE${tab === "pull" ? " / CONTEXT" : ""}</span>
      <span class="ghh-reviewers">REVIEWERS</span>
      <span class="ghh-checks">CHECKS</span>
      <span class="ghh-merge">MERGE</span>
      <span class="ghh-updated">UPDATED</span>
      <span class="ghh-actions"></span>
    </div>`;
  }

  /* ---- filtering -----------------------------------------------------------
     "Mine" = assigned to me (issues: assignee) OR requested-review-from
     me (pulls: requested_reviewers) where "me" is the signed-in member's
     github_login (from /api/me — identityHuman/identity().github_login).
     "Needs review" (pulls only) = I'm a requested reviewer AND it's not draft. */
  function matchesFilter(kind, item, filterKey, myLogin) {
    if (filterKey === "open") return true;   // both endpoints already return open-only
    if (filterKey === "mine") {
      if (kind === "issue") return !!myLogin && item.assignee === myLogin;
      return !!myLogin && (item.requested_reviewers || []).indexOf(myLogin) >= 0;
    }
    if (filterKey === "needs-review") {
      return kind === "pull" && !!myLogin && (item.requested_reviewers || []).indexOf(myLogin) >= 0 && !item.draft;
    }
    return true;
  }
  function matchesSearch(kind, item, q) {
    if (!q) return true;
    const needle = q.trim().toLowerCase();
    if (!needle) return true;
    const num = String(item.number || "");
    return (item.title || "").toLowerCase().indexOf(needle) >= 0
      || num.indexOf(needle.replace(/^#/, "")) >= 0;
  }

  /* ---- list body ----------------------------------------------------------
     Composes the full #ghlist innerHTML for one tab: loading / error / empty /
     rows. `state`: {loading, error, repo, items, tab, filter, query, agents,
     myLogin, startedOf(kind,number)}. */
  function emptyRepoHtml() {
    return `<div class="gh-empty card-empty">
      <div class="t1">No GitHub repo connected</div>
      <p>Connect this project to a repository to see its open issues and pull requests here.</p>
      <a class="btn subtle sm" href="/">Go to Dashboard -> Connect repo</a>
    </div>`;
  }
  function rateLimitHtml(detail) {
    return `<div class="gh-empty card-empty">
      <div class="t1">GitHub rate limit hit</div>
      <p>Backing off — this quietly retries on the next refresh.${detail ? " (" + esc(detail) + ")" : ""}</p>
    </div>`;
  }
  function genericErrorHtml(status, detail) {
    return `<div class="gh-empty card-empty">
      <div class="t1">Couldn't load ${status ? "(" + esc(String(status)) + ")" : ""}</div>
      <p>${detail ? esc(detail) : "Something went wrong talking to GitHub."}</p>
    </div>`;
  }

  function bodyHtml(state) {
    state = state || {};
    if (state.loading && !state.items) return '<div class="none" style="padding:20px">Loading…</div>';
    if (state.error) {
      if (state.error.kind === "not_connected") return emptyRepoHtml();
      if (state.error.kind === "rate_limited") return rateLimitHtml(state.error.detail);
      return genericErrorHtml(state.error.status, state.error.detail);
    }
    if (!state.repo) return emptyRepoHtml();
    const all = state.items || [];
    const filtered = all
      .filter((it) => matchesFilter(state.tab, it, state.filter, state.myLogin))
      .filter((it) => matchesSearch(state.tab, it, state.query));
    if (!filtered.length) {
      return `<div class="none" style="padding:20px">${all.length ? "No " + (state.tab === "pull" ? "pull requests" : "issues") + " match this filter." : "No open " + (state.tab === "pull" ? "pull requests" : "issues") + "."}</div>`;
    }
    const rowFn = state.tab === "pull" ? pullRowHtml : issueRowHtml;
    const header = columnHeaderHtml(state.tab);
    return header + filtered.map((it) => rowFn(it, state.agents, state.startedOf, state.theme)).join("");
  }

  function filterChipsHtml(tab, active) {
    const chips = [{ k: "open", label: "Open" }, { k: "mine", label: "Mine" }];
    if (tab === "pull") chips.push({ k: "needs-review", label: "Needs review" });
    return chips.map((c) => `<button class="${c.k === active ? "on" : ""}" data-gh-filter="${c.k}">${esc(c.label)}</button>`).join("");
  }

  /* ============================================================================
     DETAIL VIEWS — ?pr=N / ?issue=N within the github page. Pure payload -> HTML
     builders (same discipline as the list above): no DOM, no fetch. Consumed by
     github-render.js's route-aware render() + fetched via
     GET .../github/pulls/{n} | .../issues/{n} (github_hub_routes.py, PR #95).

     mdText: the portal's own markdown module (modules/app-text.js) — injected
     the same way esc/relTime/icon/ghAvatar are (a page-local fallback when
     window.Orcha isn't loaded, e.g. this bare-vm test harness), so body_markdown
     renders through the SAME renderer chat/task bodies use (headings, code,
     lists, blockquotes, tables, autolinks — the "Triggered-by" blockquote an
     agent's PR/issue body carries renders naturally, no special-casing here). */
  const mdText = (s) => (window.Orcha && window.Orcha.mdText) ? window.Orcha.mdText(s) : esc(s);

  function breadcrumbHtml(kind, number, repo) {
    // relative "?tab=..." replaces only the query string (keeps the path AND
    // gets combined with the current origin/path by the browser) — but it
    // would otherwise DROP a ?cid= a multi-project deep link needs, so
    // github-boot.js's readRouteFromUrl()/render() honor ?tab= on load AND
    // this stays a relative href (never absolute) so an in-flight ?cid= on
    // the CURRENT url... note: a bare relative "?query" replaces the whole
    // query string, so cid is only preserved via the JS history.back() path
    // (github-boot.js's data-gh-back handler) — the href is the no-JS/
    // right-click fallback and intentionally lands on the list's default tab.
    const backHref = "?" + (kind === "pull" ? "tab=pulls" : "tab=issues");
    const label = kind === "pull" ? "Pull requests" : "Issues";
    return `<div class="gh-crumb">
      <a class="gh-crumb-back" href="${esc(backHref)}" data-gh-back="1">${icon("arrow", "gl gh-crumb-ico")}<span>${esc(label)}</span></a>
      <span class="gh-crumb-sep">·</span>
      <span class="gh-crumb-repo mono">${esc(repo || "")}</span>
      <span class="gh-crumb-sep">·</span>
      <span class="gh-crumb-num">#${esc(number)}</span>
    </div>`;
  }

  function statePillHtml(kind, item) {
    if (kind === "pull") {
      if (item.draft) return '<span class="pill s-idle gh-state-pill">Draft</span>';
      if (item.state === "closed") return '<span class="pill s-bad gh-state-pill">Closed</span>';
      return '<span class="pill s-ok gh-state-pill">Open</span>';
    }
    return item.state === "closed"
      ? '<span class="pill s-acc gh-state-pill">Closed</span>'
      : '<span class="pill s-ok gh-state-pill">Open</span>';
  }

  function branchChipsHtml(base, head) {
    return `<span class="gh-branch-chips">
      <span class="tag gh-branch-tag mono">${esc(base || "?")}</span>
      <span class="gh-branch-arrow">${icon("arrow", "gl")}</span>
      <span class="tag gh-branch-tag mono">${esc(head || "?")}</span>
    </span>`;
  }

  function runRowHtml(run) {
    run = run || {};
    const completed = run.status === "completed";
    const conclusion = run.conclusion;
    let glyph = "ring", cls = "pend";
    if (completed) {
      if (conclusion === "success" || conclusion === "neutral" || conclusion === "skipped") { glyph = "check"; cls = "pass"; }
      else if (conclusion === "failure" || conclusion === "timed_out" || conclusion === "action_required"
        || conclusion === "cancelled" || conclusion === "stale" || conclusion === "startup_failure") { glyph = "x"; cls = "fail"; }
      else { glyph = "ring"; cls = "pend"; }
    }
    const name = run.name || "check";
    const link = run.html_url
      ? `<a class="gh-run-link" href="${esc(run.html_url)}" target="_blank" rel="noopener noreferrer">${icon("ext", "gl")}</a>` : "";
    return `<div class="gh-run-row ${cls}">
      <span class="gh-run-glyph ${cls}">${icon(glyph, "gl")}</span>
      <span class="grow gh-run-name">${esc(name)}</span>
      <span class="gh-run-state">${esc(completed ? (conclusion || "done") : (run.status || "queued"))}</span>
      ${link}
    </div>`;
  }

  function checksSectionHtml(checks) {
    const runs = (checks && checks.runs) || [];
    if (!runs.length) return '<div class="none" style="padding:14px">No checks reported.</div>';
    return `<div class="gh-runs">${runs.map(runRowHtml).join("")}</div>`;
  }

  function fileRowHtml(f) {
    f = f || {};
    const statusCls = f.status === "removed" ? "del" : f.status === "added" ? "add" : "mod";
    return `<div class="gh-file-row">
      <span class="tag gh-file-status ${statusCls}">${esc(f.status || "modified")}</span>
      <span class="grow gh-file-name mono">${esc(f.filename || "")}</span>
      <span class="gh-file-diff"><span class="add">+${esc(f.additions || 0)}</span> <span class="del">-${esc(f.deletions || 0)}</span></span>
    </div>`;
  }

  function filesSectionHtml(files) {
    const f = files || {};
    const items = f.items || [];
    if (!items.length) return '<div class="none" style="padding:14px">No files changed.</div>';
    return `<div class="gh-files">${items.map(fileRowHtml).join("")}
      ${f.truncated ? `<div class="gh-files-more muted">Showing the first ${items.length} of ${esc(f.count)} files.</div>` : ""}</div>`;
  }

  /* ---- Start / Open-on-GitHub actions (detail header) — same postStart flow
     as the list rows, reusing startCellHtml/agentRosterHtml verbatim so the
     already-tracked state and the assignee dropdown stay ONE implementation. */
  function detailActionsHtml(kind, item, taskState) {
    return `<div class="gh-detail-actions">
      ${startCellHtml(kind, item, taskState)}
      <a class="btn ghost sm gh-open-ext" href="${esc(item.html_url || "#")}" target="_blank" rel="noopener noreferrer">${icon("ext", "gl")}Open on GitHub</a>
    </div>`;
  }

  /* ---- right rail: status card + ASSIGNEES + REVIEWERS + checks summary --- */
  function personListHtml(logins) {
    const l = Array.isArray(logins) ? logins : [];
    if (!l.length) return '<div class="none" style="padding:10px 0">None</div>';
    return `<div class="gh-people">${l.map((login) => `<span class="gh-person">${avatar(login)}<span>${esc(login)}</span></span>`).join("")}</div>`;
  }
  function checksSummaryHtml(checks) {
    const r = checks || {};
    const total = r.total != null ? r.total : (r.passed || 0) + (r.failing || 0) + (r.pending || 0);
    if (!total) return '<div class="none" style="padding:10px 0">No checks</div>';
    return `<div class="gh-checks-summary">
      ${r.passed ? `<span class="gh-cs-row pass">${icon("check", "gl")}${esc(r.passed)} passed</span>` : ""}
      ${r.failing ? `<span class="gh-cs-row fail">${icon("x", "gl")}${esc(r.failing)} failing</span>` : ""}
      ${r.pending ? `<span class="gh-cs-row pend">${icon("ring", "gl")}${esc(r.pending)} pending</span>` : ""}
    </div>`;
  }
  function pullRailHtml(pull) {
    return `<aside class="gh-rail">
      <div class="card gh-rail-card">
        <div class="gh-rail-h">Status</div>
        ${statePillHtml("pull", pull)}
      </div>
      <div class="card gh-rail-card">
        <div class="gh-rail-h">Assignees</div>
        ${personListHtml(pull.assignees)}
      </div>
      <div class="card gh-rail-card">
        <div class="gh-rail-h">Reviewers</div>
        ${personListHtml(pull.requested_reviewers)}
      </div>
      <div class="card gh-rail-card">
        <div class="gh-rail-h">Checks</div>
        ${checksSummaryHtml(pull.checks)}
      </div>
    </aside>`;
  }

  /* ---- PR detail body ------------------------------------------------------
     tabs: Conversation (body_markdown) | Checks (n) | Files changed (n). Read
     + Start only — no approve/close/rerun controls, deliberate (per spec). */
  function prDetailHtml(state) {
    const pull = state.pull, repo = state.repo;
    const checks = pull.checks || {};
    const total = checks.total != null ? checks.total : (checks.passed || 0) + (checks.failing || 0) + (checks.pending || 0);
    const filesCount = (pull.files && pull.files.count) || 0;
    const activeSub = state.subTab || "conversation";
    const tabs = [
      { k: "conversation", label: "Conversation" },
      { k: "checks", label: `Checks (${total})` },
      { k: "files", label: `Files changed (${filesCount})` },
    ];
    return `${breadcrumbHtml("pull", pull.number, repo)}
    <div class="gh-detail-layout">
      <div class="gh-detail-main">
        <div class="gh-detail-head">
          <h1 class="gh-detail-title">${esc(pull.title)} <span class="gh-detail-num mono">#${esc(pull.number)}</span></h1>
          <div class="gh-detail-chips">
            ${statePillHtml("pull", pull)}
            ${branchChipsHtml(pull.base, pull.head)}
            <span class="gh-detail-updated">Updated ${esc(relTime(pull.updated_at))}</span>
          </div>
          ${detailActionsHtml("pull", pull, state.taskState)}
        </div>
        <nav class="aut gh-subtabs" role="tablist" aria-label="Pull request sections">
          ${tabs.map((t) => `<span class="seg${t.k === activeSub ? " on" : ""}" role="tab" tabindex="0" aria-selected="${t.k === activeSub}" data-gh-subtab="${t.k}">${esc(t.label)}</span>`).join("")}
        </nav>
        <div class="card gh-subtab-body">
          ${activeSub === "checks" ? checksSectionHtml(pull.checks)
            : activeSub === "files" ? filesSectionHtml(pull.files)
            : `<div class="md gh-conversation-body">${mdText(pull.body_markdown || "")}</div>`}
        </div>
      </div>
      ${pullRailHtml(pull)}
    </div>`;
  }

  /* ---- issue detail body ---------------------------------------------------
     labels in real colors, body markdown, assignees, recent comments (author
     is a GitHub login -> ghAvatar directly, not Orcha.face — comment authors
     aren't necessarily mapped Orcha members). */
  function commentRowHtml(c) {
    c = c || {};
    return `<div class="gh-comment">
      ${avatar(c.author_login)}
      <div class="gh-comment-body">
        <div class="gh-comment-head"><span class="gh-comment-author">${esc(c.author_login || "unknown")}</span><span class="gh-comment-when">${esc(relTime(c.created_at))}</span></div>
        <div class="md gh-comment-text">${mdText(c.body_markdown || "")}</div>
      </div>
    </div>`;
  }
  function issueDetailHtml(state) {
    const issue = state.issue, repo = state.repo, theme = state.theme;
    const comments = issue.comments || [];
    return `${breadcrumbHtml("issue", issue.number, repo)}
    <div class="gh-detail-layout">
      <div class="gh-detail-main">
        <div class="gh-detail-head">
          <h1 class="gh-detail-title">${esc(issue.title)} <span class="gh-detail-num mono">#${esc(issue.number)}</span></h1>
          <div class="gh-detail-chips">
            ${statePillHtml("issue", issue)}
            ${(issue.labels || []).map((l) => labelChipHtml(l, theme)).join("")}
            <span class="gh-detail-updated">Updated ${esc(relTime(issue.updated_at))}</span>
          </div>
          ${detailActionsHtml("issue", issue, state.taskState)}
        </div>
        <div class="card gh-subtab-body">
          <div class="md gh-conversation-body">${mdText(issue.body_markdown || "")}</div>
        </div>
        <div class="card" style="margin-top:14px">
          <div class="card-h"><h3>Comments</h3><span class="count">${comments.length ? "(" + comments.length + ")" : ""}</span></div>
          <div class="card-b" style="padding:14px 16px">
            ${comments.length ? comments.map(commentRowHtml).join("") : '<div class="none">No comments yet.</div>'}
          </div>
        </div>
      </div>
      <aside class="gh-rail">
        <div class="card gh-rail-card">
          <div class="gh-rail-h">Status</div>
          ${statePillHtml("issue", issue)}
        </div>
        <div class="card gh-rail-card">
          <div class="gh-rail-h">Assignees</div>
          ${personListHtml(issue.assignees && issue.assignees.length ? issue.assignees : (issue.assignee ? [issue.assignee] : []))}
        </div>
      </aside>
    </div>`;
  }

  /* ---- detail degrade states (loading / not_found / same errors as the list) */
  function detailNotFoundHtml(kind) {
    return `<div class="gh-empty card-empty">
      <div class="t1">${kind === "pull" ? "Pull request" : "Issue"} not found</div>
      <p>It may have been deleted, or the number doesn't exist in this repo.</p>
    </div>`;
  }
  function detailHtml(state) {
    state = state || {};
    if (state.error) {
      if (state.error.kind === "not_found") return detailNotFoundHtml(state.kind);
      if (state.error.kind === "not_connected") return emptyRepoHtml();
      if (state.error.kind === "rate_limited") return rateLimitHtml(state.error.detail);
      return genericErrorHtml(state.error.status, state.error.detail);
    }
    // No item yet (and no error) -> "Loading…", regardless of the `loading`
    // flag's exact timing. navigate() renders the detail route SYNCHRONOUSLY
    // (before loadDetail() has even been called, let alone set
    // detailLoading=true), so on a fresh item this runs with loading:false
    // AND pull/issue both null — the ORIGINAL `state.loading && ...` guard
    // missed that window and fell through to prDetailHtml/issueDetailHtml,
    // which dereference state.pull/state.issue unconditionally and threw a
    // TypeError (root cause of the live "row click does nothing, tabs
    // vanish" defect — the throw aborted navigate() before it reached
    // loadDetail(), leaving #ghHead/#ghFilters already toggled for the
    // detail route while #ghlist never repainted off the stale list).
    if (!state.pull && !state.issue) return '<div class="none" style="padding:20px">Loading…</div>';
    return state.kind === "pull" ? prDetailHtml(state) : issueDetailHtml(state);
  }

  return {
    checksChipHtml, mergeChipHtml, reviewersHtml, repoChipHtml, startCellHtml,
    agentRosterHtml, issueRowHtml, pullRowHtml, matchesFilter, matchesSearch,
    bodyHtml, filterChipsHtml, emptyRepoHtml, rateLimitHtml, genericErrorHtml,
    columnHeaderHtml, labelChipHtml,
    breadcrumbHtml, statePillHtml, branchChipsHtml, runRowHtml, checksSectionHtml,
    fileRowHtml, filesSectionHtml, detailActionsHtml, personListHtml, checksSummaryHtml,
    pullRailHtml, prDetailHtml, commentRowHtml, issueDetailHtml, detailNotFoundHtml, detailHtml,
  };
})();
