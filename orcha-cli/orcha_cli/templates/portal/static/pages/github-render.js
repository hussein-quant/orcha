/* GitHub hub page — fetch + patch logic: issues/pulls loading state, the
   Start (+ assignee dropdown) POST flow, and renderList() — the #ghlist patch
   for the ACTIVE tab, turning current state into a GhS.bodyHtml() render.
   All view HTML comes from github-state.js; the top-level render() orchestrator
   (shell mount, tab/filter chrome, skeleton swap), click wiring, and
   OrchaData.start boot live in github-boot.js (mirrors the tasks-state.js /
   tasks-boot.js split: renderList lives here, render() lives in boot).

   Cadence: the shared 3s snapshot poll (OrchaData.start, wired in boot) keeps
   the shell chrome + agent roster live; issues/pulls are a heavier
   GitHub-backed fetch (server-side 60s TTL cache per the spec) so they refresh
   on load, on tab switch, and on a 60s timer — never on the 3s tick.

   PERFORMANCE (progressive checks fill): GET .../github/pulls returns each
   pull with `checks: null` ("not loaded yet" — see github_hub_routes.py's
   PERFORMANCE note; the list route now makes exactly ONE GitHub call). Once
   that list paints, maybeLoadChecks() fires a SEPARATE GET .../github/checks
   batch call for the pull numbers just rendered and patches the results into
   `checksByNumber` (number -> rollup, keyed independently of `payload.pulls`
   so it survives the 3s snapshot tick's re-render — that tick only calls
   render(), never load()/maybeLoadChecks(), so it must read whatever's already in
   checksByNumber rather than resetting it). renderList() merges
   checksByNumber onto each pull's `checks: null` before handing the state to
   GhS.bodyHtml(), so a patched chip shows up on the VERY NEXT render without
   needing a fresh /pulls fetch. A pull already resolved (real rollup, not
   null) is left alone — maybeLoadChecks() only asks the batch endpoint about
   numbers still missing from the map. If the batch call fails outright, the
   chips simply stay on checksChipHtml's null branch ("checks…") — no crash,
   no full-list error state (see maybeLoadChecks()'s .catch). */
const GhO = window.Orcha;
const GhS = window.OrchaGithubHub;
const Gh$ = (id) => document.getElementById(id);
const GhD = () => window.ORCHA;

let tab = "issues";              // "issues" | "pulls" (endpoint/url form)
let filter = "open";
let query = "";
let payload = { issues: null, pulls: null };   // per-tab last-loaded payload
let loading = { issues: false, pulls: false };
let loadError = { issues: null, pulls: null };
let booted = { issues: false, pulls: false };
// number -> {passed,failing,pending,total}, patched in by maybeLoadChecks() below.
// Deliberately OUTSIDE `payload` so a background render (3s tick) never wipes
// it, and so a fresh /pulls refetch (60s timer) doesn't need to carry checks
// itself — the next maybeLoadChecks() call re-fills whatever's missing.
let checksByNumber = {};
// Batch-checks requests already in flight or served this session, so a rapid
// sequence of renders (each one calling maybeLoadChecks) never fires the same
// numbers twice while a request is still pending.
let checksRequested = {};

/* ---- detail route state (?pr=N / ?issue=N) --------------------------------
   One payload/loading/error slot at a time — a route change (row click, back/
   forward, or a fresh deep link) resets these before fetching, so a slow
   in-flight fetch for the PREVIOUS number can never land after navigation and
   render stale detail under a new number (guarded by `detailToken`, bumped on
   every route change; a settling fetch checks its own token before writing).
   `detailSubTab` is the PR-only Conversation/Checks/Files toggle — reset to
   "conversation" on every route change, never persisted across items. */
let detailPayload = { pull: null, issue: null };
let detailLoading = { pull: false, issue: false };
let detailError = { pull: null, issue: null };
let detailToken = 0;
let detailSubTab = "conversation";
// "kind:number" -> true once that item's detail route has been swapped past
// its skeleton at least once (github-boot.js's render(), mirroring `booted`
// above for the list tabs). Keyed per ITEM (not just per kind) so navigating
// from an already-settled #12 to a fresh #99 shows the skeleton again for
// #99 rather than reusing #12's "already booted" state — a new number is a
// new fetch with its own loading gap. Never explicitly cleared: an old
// number's entry simply stops being read once route.number moves on, and a
// revisit within the same page session correctly skips the skeleton (the
// payload is likely still cached from `detailPayload`'s own number check).
let detailBooted = {};
// route: {kind: null|"pull"|"issue", number: null|int} — derived from the URL
// (?pr=N / ?issue=N) at boot and on every popstate; owned/updated by
// github-boot.js's navigate()/readRouteFromUrl(), read here by loadDetail/
// renderDetail. null kind = the list view (no detail route active).
let route = { kind: null, number: null };
// Started-task memory for THIS page view's own Start clicks: number ->
// {task_id, existing}. Purely a same-session instant-feedback cache (a Start
// click's response paints the chip immediately, no wait for the next fetch) —
// NOT the source of truth for "is this tracked", see startedOf() below.
const startedIssue = {};
const startedPull = {};

function ghCid() {
  return (window.OrchaData && window.OrchaData.currentCid && window.OrchaData.currentCid())
    || (GhD() && GhD().container && GhD().container.id) || null;
}
function tabKind() { return tab === "pulls" ? "pull" : "issue"; }

// The server's own tracked_task_id for (kind, number) — present on every list row
// AND every detail payload as of github_hub_routes' tracked-state addition, computed
// server-side from the SAME open-task lookup POST /start's idempotency check uses.
// This is what makes a task started via ANY path (a hub click in a DIFFERENT
// session, or the Slack `/orcha start` slash command) show as tracked on this
// page's very first load — the client-side startedIssue/startedPull cache below
// only ever covers a Start click made in THIS session.
function serverTrackedTaskId(kind, number) {
  const listKey = kind === "pull" ? "pulls" : "issues";
  const listPayload = payload[listKey];
  const listItems = listPayload ? (listPayload.issues || listPayload.pulls || []) : null;
  if (listItems) {
    const row = listItems.find((it) => it.number === number);
    if (row && row.tracked_task_id) return row.tracked_task_id;
  }
  const detailPayloadForKind = detailPayload[kind];
  if (detailPayloadForKind && detailPayloadForKind.__number === number) {
    const item = detailPayloadForKind[kind];
    if (item && item.tracked_task_id) return item.tracked_task_id;
  }
  return null;
}

// started-task lookup for a row/detail's taskState: the LOCAL session cache (this
// session's own Start-click result, which also distinguishes a fresh create from an
// {existing:true} click) takes precedence when present; otherwise fall back to the
// server-supplied tracked_task_id (a task started elsewhere — a different session, a
// hub click before this page loaded, or the Slack `/orcha start` command — surfaces
// as "already tracked" with existing:true, since from THIS page's perspective it
// always was). Returns null (renders the Start/Fix split button) only when NEITHER
// source knows about a task for this item.
function startedOf(kind, number) {
  const m = kind === "pull" ? startedPull : startedIssue;
  if (m[number]) return m[number];
  const serverTaskId = serverTrackedTaskId(kind, number);
  return serverTaskId ? { task_id: serverTaskId, existing: true } : null;
}
function myLogin() {
  const id = GhO.identity && GhO.identity();
  if (id && id.github_login) return id.github_login;
  const h = GhO.identityHuman && GhO.identityHuman();
  return (h && h.github_login) || null;
}
function classifyError(status, body) {
  if (status === 404) return { kind: "not_connected", status, detail: (body && body.detail) || null };
  if (status === 403 || status === 429) return { kind: "rate_limited", status, detail: (body && body.detail) || null };
  return { kind: "error", status, detail: (body && (body.detail || body.error)) || null };
}
// resolved light/dark, mirroring app-state.js's own resolvedTheme() — github-
// state.js stays DOM-free (its own header contract), so the render layer
// resolves the visual theme here and threads it into the render state for
// labelChipHtml's light-theme text-color adjustment.
function ghResolvedTheme() {
  try {
    const t = localStorage.getItem("orcha:theme") || "auto";
    if (t === "dark" || t === "light") return t;
    return (window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches) ? "light" : "dark";
  } catch (e) { return "dark"; }
}

// Merge the patched-in checksByNumber map onto a pull-request list: a pull
// still carrying checks:null gets the resolved rollup if maybeLoadChecks() has
// already patched that number; a pull that already HAS a real rollup (e.g. a
// future backend revision that inlines it again, or a re-resolved value) is
// left untouched — checksByNumber only ever fills gaps, never overwrites.
function withPatchedChecks(pulls) {
  return pulls.map((p) => (
    p.checks == null && checksByNumber[p.number] != null
      ? Object.assign({}, p, { checks: checksByNumber[p.number] })
      : p
  ));
}

// #ghlist patch for the ACTIVE tab only — pure DOM patch, no shell/chrome, no
// skeleton awareness (the skeleton swap wraps THIS function; see render() in
// github-boot.js, mirroring OrchaSkeleton.swap(Tas$("tlist"), renderList) in
// tasks-boot.js).
function renderList(force) {
  const key = tab === "pulls" ? "pulls" : "issues";
  const rawItems = payload[key] ? (payload[key].issues || payload[key].pulls || []) : null;
  const items = key === "pulls" && rawItems ? withPatchedChecks(rawItems) : rawItems;
  const repo = payload[key] ? payload[key].repo : null;
  const state = {
    loading: loading[key], error: loadError[key], repo, items,
    tab: tabKind(), filter, query,
    agents: (GhD() && GhD().agents) || [],
    myLogin: myLogin(),
    startedOf,
    theme: ghResolvedTheme(),
  };
  const host = Gh$("ghlist");
  if (!host) return;
  GhO.patch(host, GhS.bodyHtml(state), force);
  // Progressive fill: once the list itself has painted, go fetch checks for
  // whichever pulls are still null. Runs AFTER the patch call above so the
  // list is never blocked on this — the instant-list requirement is the
  // patch() call itself, this is purely a follow-up.
  if (key === "pulls" && items) maybeLoadChecks(items);
}

function load(which, force) {
  const id = ghCid();
  const key = which === "pulls" ? "pulls" : "issues";
  if (!id || loading[key]) return;
  if (!force && payload[key]) return;   // already have this tab's data
  loading[key] = true;
  if (key === "pulls" && force) checksRequested = {};   // a fresh list deserves a fresh fill pass
  fetch("/api/containers/" + encodeURIComponent(id) + "/github/" + key)
    .then((r) => r.json().then((body) => ({ ok: r.ok, status: r.status, body })).catch(() => ({ ok: r.ok, status: r.status, body: null })))
    .then(({ ok, status, body }) => {
      if (!ok) { loadError[key] = classifyError(status, body); return; }
      payload[key] = body; loadError[key] = null;
    })
    .catch((e) => { loadError[key] = { kind: "error", status: 0, detail: e.message }; })
    .then(() => { loading[key] = false; render(true); });
}

/* ---- progressive checks fill (GET .../github/checks) ----------------------
   Fires right after the pulls list paints (called from renderList above),
   for whichever numbers on screen don't have a resolved rollup yet AND
   haven't already been requested this session. Capped at 30 numbers per call
   to match the backend's CHECKS_BATCH_MAX_NUMBERS — the list itself can carry
   up to 100 pulls (per_page=100), so a founder with a very large open-PR
   count simply fills the first 30 still-missing numbers per pass; the next
   render (e.g. after those resolve, or on the 60s refresh) picks up any
   remainder. */
const CHECKS_BATCH_CAP = 30;
function maybeLoadChecks(pulls) {
  const id = ghCid();
  if (!id) return;
  const wanted = pulls
    .filter((p) => p.checks == null && !checksRequested[p.number])
    .slice(0, CHECKS_BATCH_CAP)
    .map((p) => p.number);
  if (!wanted.length) return;
  wanted.forEach((n) => { checksRequested[n] = true; });
  fetch("/api/containers/" + encodeURIComponent(id) + "/github/checks?numbers=" + wanted.join(","))
    .then((r) => (r.ok ? r.json() : null))
    .then((body) => {
      if (!body || body.available === false || !body.checks) return;   // degrade quietly
      Object.keys(body.checks).forEach((numStr) => {
        checksByNumber[Number(numStr)] = body.checks[numStr];
      });
      renderList(true);   // patch the resolved chips in place, no full reload
    })
    .catch(() => { /* quiet degrade — chips stay on the "checks…" placeholder */ });
}

/* ---- detail route (?pr=N / ?issue=N) ---------------------------------------
   classifyDetailError distinguishes a 404 (a specific issue/PR NUMBER
   missing, per _detail_error_payload's `reason:"not_found"`) from the list
   endpoints' 404-means-not-connected reading — the backend contract already
   encodes this in the `reason` field, so the classifier trusts that over the
   raw HTTP status. */
function classifyDetailError(status, body) {
  const reason = body && body.reason;
  if (reason === "not_found") return { kind: "not_found", status, detail: (body && body.detail) || null };
  if (reason === "repo_not_connected") return { kind: "not_connected", status, detail: (body && body.detail) || null };
  if (reason === "rate_limited") return { kind: "rate_limited", status, detail: (body && body.detail) || null };
  if (status === 404) return { kind: "not_found", status, detail: (body && body.detail) || null };
  if (status === 403 || status === 429) return { kind: "rate_limited", status, detail: (body && body.detail) || null };
  return { kind: "error", status, detail: (body && (body.detail || body.error)) || null };
}

function detailKey() { return route.kind === "pull" ? "pull" : "issue"; }

function loadDetail(force) {
  const id = ghCid();
  const key = detailKey();
  const number = route.number;
  if (!id || !number) return;
  if (!force && detailPayload[key] && detailPayload[key].__number === number) return;   // already have it
  const myToken = ++detailToken;
  detailLoading[key] = true;
  const path = key === "pull" ? "pulls" : "issues";
  fetch("/api/containers/" + encodeURIComponent(id) + "/github/" + path + "/" + encodeURIComponent(number))
    .then((r) => r.json().then((body) => ({ ok: r.ok, status: r.status, body })).catch(() => ({ ok: r.ok, status: r.status, body: null })))
    .then(({ ok, status, body }) => {
      if (myToken !== detailToken) return;   // a newer route change superseded this fetch
      if (!ok || !body || body.available === false) {
        detailError[key] = Object.assign({ __number: number }, classifyDetailError(status, body));
        detailPayload[key] = null;
        return;
      }
      const item = key === "pull" ? body.pull : body.issue;
      detailPayload[key] = Object.assign({ __number: number }, body, { [key]: item });
      detailError[key] = null;
    })
    .catch((e) => {
      if (myToken !== detailToken) return;
      detailError[key] = { __number: number, kind: "error", status: 0, detail: e.message };
    })
    // route through render() (github-boot.js), NOT renderDetail() directly —
    // mirrors load()'s own render(true) call above. render() owns the
    // skeleton-swap gate (detailBooted[]) the same way it owns booted[] for
    // the list tabs; calling renderDetail() straight from here would patch
    // real content into #ghlist without ever flipping detailBooted or
    // running it through OrchaSkeleton.swap()'s cross-fade.
    .then(() => { if (myToken === detailToken) { detailLoading[key] = false; render(true); } });
}

// #ghlist patch for the ACTIVE detail route — mirrors renderList's role but
// for ?pr=/?issue=. taskState reads the SAME startedOf() the list Start button
// writes to (this session's own clicks) AND the server's tracked_task_id (any
// session, any dispatch path) — see startedOf()'s header comment. A Start click
// from the list still shows "already tracked" if the founder then opens that
// item's detail page in the same session (and vice versa), AND a task started
// via Slack or a different browser session shows tracked here too.
function renderDetail(force) {
  const key = detailKey();
  const number = route.number;
  const p = detailPayload[key] && detailPayload[key].__number === number ? detailPayload[key] : null;
  const item = p ? p[key] : null;
  // detailError is number-scoped the same way detailPayload is (__number) — a
  // navigate() to a NEW item must never show the PREVIOUS item's stale error
  // (e.g. a not_found on #7 bleeding into a fresh, valid #5) while its own
  // fetch is still in flight or hasn't started yet.
  const err = detailError[key] && detailError[key].__number === number ? detailError[key] : null;
  const state = {
    loading: detailLoading[key], error: p ? null : err,
    kind: route.kind, repo: p ? p.repo : null,
    [key]: item,
    taskState: startedOf(route.kind, number),
    subTab: detailSubTab,
    theme: ghResolvedTheme(),
  };
  const host = Gh$("ghlist");
  if (!host) return;
  GhO.patch(host, GhS.detailHtml(state), force);
}

/* ---- Start flow -----------------------------------------------------------
   bare Start = unassigned (Atlas routes it); dropdown pick = assign to that
   agent. Both call the same POST; the response {task_id, existing?} feeds the
   started-task cache so the row swaps to the task-id chip immediately (no
   wait for the next 60s refresh). */
function postStart(kind, number, assigneeAgentId, btn) {
  const id = ghCid();
  if (!id) return;
  if (btn) btn.disabled = true;
  fetch("/api/containers/" + encodeURIComponent(id) + "/github/start", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: kind, number: number, assignee_agent_id: assigneeAgentId || undefined }),
  })
    .then((r) => r.json().then((d) => ({ ok: r.ok, status: r.status, d })).catch(() => ({ ok: r.ok, status: r.status, d: {} })))
    .then(({ ok, status, d }) => {
      if (!ok) { GhO.toast("Start failed (" + status + ")" + (d && d.detail ? ": " + d.detail : ""), "danger"); if (btn) btn.disabled = false; return; }
      const map = kind === "pull" ? startedPull : startedIssue;
      map[number] = { task_id: d.task_id, existing: !!d.existing };
      GhO.toast(d.existing ? "Already tracked — " + d.task_id : "Task created", "ok");
      render(true);
    })
    .catch((e) => { GhO.toast("Start failed: " + e.message, "danger"); if (btn) btn.disabled = false; });
}
