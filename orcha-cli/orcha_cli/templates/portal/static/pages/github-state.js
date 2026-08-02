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
            html_url, requested_reviewers[], checks: {passed, failing, pending,
            total}, mergeable_state}] }
     POST /api/containers/{cid}/github/start
       body {kind: "issue"|"pull", number, assignee_agent_id?}
       -> {task_id, existing?: true}
   Both GETs 404 (repo not connected) or 403/429 (rate-limited) as clean JSON
   errors — {"error": "..."} shape assumed; the render layer treats ANY non-ok
   response the same way (friendly card), so the exact error body isn't load
   bearing here. This also covers deploy-order: if the backend PR hasn't landed
   yet, the fetch 404s the same way an unconnected repo would, and the page
   degrades to the same friendly card instead of a blank/broken page. */
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
     rollup: {passed, failing, pending, total}. Chip reads:
       any failing  -> red "n failing"
       else pending -> amber "n pending"
       else passed  -> green "n passed" (total===0 -> no chip, "no checks") */
  function checksChipHtml(rollup) {
    const r = rollup || {};
    const passed = r.passed || 0, failing = r.failing || 0, pending = r.pending || 0;
    const total = r.total != null ? r.total : passed + failing + pending;
    if (!total) return '<span class="tag gh-checks none">No checks</span>';
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

  function reviewersHtml(logins) {
    const l = Array.isArray(logins) ? logins : [];
    if (!l.length) return '<span class="gh-reviewers none">—</span>';
    return `<span class="gh-reviewers">${l.slice(0, 3).map((r) => avatar(r)).join("")}${l.length > 3 ? `<span class="gh-more">+${l.length - 3}</span>` : ""}</span>`;
  }

  function repoChipHtml(repo) {
    return repo ? `<span class="tag gh-repo mono">${esc(repo)}</span>` : "";
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
     see the fixtures ISSUE_OPEN/PR_CLEAN in github_hub.test.js. */
  function issueRowHtml(it, agents, startedFn) {
    const started = startedFn ? startedFn("issue", it.number) : null;
    return `<div class="ghrow" data-gh-row="issue:${esc(it.number)}">
      ${icon("issueDot", "gl gh-kind-ico issue")}
      <span class="gh-num mono">#${esc(it.number)}</span>
      <span class="grow gh-main">
        <span class="gh-title">${esc(it.title)}</span>
        <span class="gh-meta">${(it.labels || []).slice(0, 4).map((l) => `<span class="tag gh-label">${esc(l)}</span>`).join("")}
          ${it.assignee ? `<span class="gh-assignee">${avatar(it.assignee)}<span>${esc(it.assignee)}</span></span>` : '<span class="tag gh-unassigned">Unassigned</span>'}</span>
      </span>
      <span class="gh-updated">${esc(relTime(it.updated_at))}</span>
      <span class="gh-actions">${startCellHtml("issue", it, started)}</span>
    </div>`;
  }
  function pullRowHtml(pr, agents, startedFn) {
    const started = startedFn ? startedFn("pull", pr.number) : null;
    return `<div class="ghrow" data-gh-row="pull:${esc(pr.number)}">
      ${icon("pullArrow", "gl gh-kind-ico pull" + (pr.draft ? " draft" : ""))}
      <span class="gh-num mono">#${esc(pr.number)}</span>
      <span class="grow gh-main">
        <span class="gh-title">${pr.draft ? '<span class="tag gh-draft">Draft</span>' : ""}${esc(pr.title)}</span>
        <span class="gh-meta"><span class="gh-branch mono">${esc(pr.head || "")}</span>${reviewersHtml(pr.requested_reviewers)}</span>
      </span>
      ${checksChipHtml(pr.checks)}
      ${mergeChipHtml(pr)}
      <span class="gh-updated">${esc(relTime(pr.updated_at))}</span>
      <span class="gh-actions">${startCellHtml("pull", pr, started)}</span>
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
    return filtered.map((it) => rowFn(it, state.agents, state.startedOf)).join("");
  }

  function filterChipsHtml(tab, active) {
    const chips = [{ k: "open", label: "Open" }, { k: "mine", label: "Mine" }];
    if (tab === "pull") chips.push({ k: "needs-review", label: "Needs review" });
    return chips.map((c) => `<button class="${c.k === active ? "on" : ""}" data-gh-filter="${c.k}">${esc(c.label)}</button>`).join("");
  }

  return {
    checksChipHtml, mergeChipHtml, reviewersHtml, repoChipHtml, startCellHtml,
    agentRosterHtml, issueRowHtml, pullRowHtml, matchesFilter, matchesSearch,
    bodyHtml, filterChipsHtml, emptyRepoHtml, rateLimitHtml, genericErrorHtml,
  };
})();
