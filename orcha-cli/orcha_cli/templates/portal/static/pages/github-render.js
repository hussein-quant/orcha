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
   on load, on tab switch, and on a 60s timer — never on the 3s tick. */
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
// route: {kind: null|"pull"|"issue", number: null|int} — derived from the URL
// (?pr=N / ?issue=N) at boot and on every popstate; owned/updated by
// github-boot.js's navigate()/readRouteFromUrl(), read here by loadDetail/
// renderDetail. null kind = the list view (no detail route active).
let route = { kind: null, number: null };
// Started-task memory for this page view: number -> {task_id, existing}. Not
// persisted — a reload re-derives "already tracked" only insofar as the
// backend's own idempotency (same {existing:true} reply) resends it on the
// next Start click; this cache just avoids a re-POST loop within the same
// session and reflects the Start response instantly (no 60s wait).
const startedIssue = {};
const startedPull = {};

function ghCid() {
  return (window.OrchaData && window.OrchaData.currentCid && window.OrchaData.currentCid())
    || (GhD() && GhD().container && GhD().container.id) || null;
}
function tabKind() { return tab === "pulls" ? "pull" : "issue"; }
function startedOf(kind, number) {
  const m = kind === "pull" ? startedPull : startedIssue;
  return m[number] || null;
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

// #ghlist patch for the ACTIVE tab only — pure DOM patch, no shell/chrome, no
// skeleton awareness (the skeleton swap wraps THIS function; see render() in
// github-boot.js, mirroring OrchaSkeleton.swap(Tas$("tlist"), renderList) in
// tasks-boot.js).
function renderList(force) {
  const key = tab === "pulls" ? "pulls" : "issues";
  const items = payload[key] ? (payload[key].issues || payload[key].pulls || []) : null;
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
}

function load(which, force) {
  const id = ghCid();
  const key = which === "pulls" ? "pulls" : "issues";
  if (!id || loading[key]) return;
  if (!force && payload[key]) return;   // already have this tab's data
  loading[key] = true;
  fetch("/api/containers/" + encodeURIComponent(id) + "/github/" + key)
    .then((r) => r.json().then((body) => ({ ok: r.ok, status: r.status, body })).catch(() => ({ ok: r.ok, status: r.status, body: null })))
    .then(({ ok, status, body }) => {
      if (!ok) { loadError[key] = classifyError(status, body); return; }
      payload[key] = body; loadError[key] = null;
    })
    .catch((e) => { loadError[key] = { kind: "error", status: 0, detail: e.message }; })
    .then(() => { loading[key] = false; render(true); });
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
    .then(() => { if (myToken === detailToken) { detailLoading[key] = false; renderDetail(true); } });
}

// #ghlist patch for the ACTIVE detail route — mirrors renderList's role but
// for ?pr=/?issue=. taskState reads the SAME started-task cache the list Start
// button writes to, so a Start click from the list still shows "already
// tracked" if the founder then opens that item's detail page in the same
// session (and vice versa — Start from detail feeds the list's cache too).
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
