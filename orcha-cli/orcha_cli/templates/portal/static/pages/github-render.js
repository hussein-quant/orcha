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
