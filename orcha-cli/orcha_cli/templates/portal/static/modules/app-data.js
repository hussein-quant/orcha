/* Orcha shared portal module: time helpers, live snapshot accessors, and acting-human state. */
const shortId = (s) => (s ? String(s).slice(0, 8) : "—");
// S3 §3b: an agent's single-embodiment lease ∈ idle | ephemeral | resident | live.
// Forge's #141 exposes it on the agent read payload as `embodiment` (CASE active-lease →
// lease_kind ELSE 'idle'); the data adapter passes it through. Read that (plus lease_kind/
// lease as belt-and-suspenders) and default to "idle" when absent/unknown, so the terminal
// stays openable + the conversation stays unlocked until the backend ships it (graceful).
// Drives the lock/guard UX.
const LEASES = ["idle", "ephemeral", "resident", "live"];
const leaseOf = (agent) => {
  const v = agent && (agent.embodiment || agent.lease_kind || agent.lease);
  return v && LEASES.indexOf(v) >= 0 ? v : "idle";
};

function relTime(iso) {
  if (!iso) return "—";
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 5) return "just now";
  if (diff < 60) return Math.floor(diff) + "s ago";
  if (diff < 3600) return Math.floor(diff / 60) + "m ago";
  if (diff < 86400) return Math.floor(diff / 3600) + "h ago";
  return Math.floor(diff / 86400) + "d ago";
}
function clockTime(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}
// ISS-83 recency band: an item whose most-recent activity (created OR updated) is within
// RECENCY_WINDOW_MS floats ABOVE staler items regardless of priority, so fresh work surfaces.
// recencyTs() takes any number of ISO strings (created_at/started_at/last-post/responded_at…)
// and returns the newest in ms (0 if none parse). recencyBand() returns 0 (recent) | 1 (older)
// — use it as a sort key slotted between status and priority so existing tie-breaks still apply.
const RECENCY_WINDOW_MS = 12 * 60 * 60 * 1000;   // ~12h
function recencyTs() {
  let max = 0;
  for (let i = 0; i < arguments.length; i++) { const t = Date.parse(arguments[i] || ""); if (t > max) max = t; }
  return max;
}
function recencyBand() {
  const ts = recencyTs.apply(null, arguments);
  return ts && (Date.now() - ts) <= RECENCY_WINDOW_MS ? 0 : 1;
}

/* ---- multi-project: is a HOST-SIDE notifier serving this container? ---- *
 * The daemon's per-tick wake-scan poll stamps containers.last_wake_scan_at (mig 037,
 * throttled to one write/15s), so a stamp within the last ~2 minutes means "an
 * `orcha init`-bound workspace's daemon serves THIS project's wakes". NULL/stale ⇒
 * portal-only: full CRUD works, but nothing wakes agents until host-side glue binds
 * a workspace (the fleet provisioner). Drives the new-project dashboard notice. */
const WAKES_SERVED_WINDOW_MS = 2 * 60 * 1000;
function wakesServed(c) {
  const t = Date.parse((c && c.last_wake_scan_at) || "");
  return !!t && (Date.now() - t) <= WAKES_SERVED_WINDOW_MS;
}

/* ---- real-snapshot accessors (read fresh — keep live across refresh) -- */
function agents() { return D.agents || []; }
function tasks() { return D.tasks || []; }
function requests() { return D.requests || []; }
// GH sidebar/iOS count mismatch: task_open_total/request_open_total (additive snapshot
// fields — container_snapshot_routes.py) are the ONE authoritative "open" counts, computed
// server-side over the full table (not the capped tasks[]/requests[] window), so the sidebar
// badge and the page header can read the SAME number. Fall back to counting the loaded
// window client-side when polling an older cached snapshot that predates the field (still
// correct in the common case where the window isn't actually capped).
const TERMINAL_TASK_STATUSES = ["completed", "cancelled"];
function taskOpenTotal() {
  if (D.task_open_total != null) return D.task_open_total;
  return tasks().filter((t) => TERMINAL_TASK_STATUSES.indexOf(t.status) < 0).length;
}
function requestOpenTotal() {
  if (D.request_open_total != null) return D.request_open_total;
  return requests().filter((r) => r.status === "open").length;
}
function agentByAlias(alias) { return agents().find((a) => a.alias === alias) || null; }
function agentById(id) { return id == null ? null : agents().find((a) => String(a.id) === String(id)) || null; }
function aliasFor(id) { const a = agentById(id); return a ? a.alias : null; }
function taskById(id) { return tasks().find((t) => String(t.id) === String(id)) || null; }
function humans() { return agents().filter((a) => a.kind === "human"); }
// a request is "to the human" if its target resolves to a human agent, or it has
// no explicit target (the API routes those to the picked human). Robust to both the
// raw snapshot (target_id) and the D1 component shape (`to` = alias or "human").
// (D1 review: the mapped shape dropped target_id, so the id branch wrongly treated
// every open request as human-targeted; D1 now preserves target_id and we also handle
// the alias case — note a request sent to the human resolves `to` to the human's
// ALIAS, not the literal "human", so a plain `to === "human"` check is insufficient.)
function isToHuman(r) {
  if (r.target_id !== undefined) {            // raw or D1-preserved id (authoritative)
    if (!r.target_id) return true;            // null target -> the picked human
    const t = agentById(r.target_id);
    return !!t && t.kind === "human";
  }
  if (r.to === "human") return true;          // component-only: explicit "human"
  const a = agentByAlias(r.to);
  return !!(a && a.kind === "human");         // ...or an alias that is a human
}

/* ---- collab v1: the proxy-resolved GitHub identity (GET /api/me) ------- *
 * data.js stashes the /api/me answer on D.identity:
 *   {agent_id, alias, github_login, member_role, avatar_url} | null
 * ...and the envelope's `trusted` flag on D.identityTrusted. identity null with
 * trusted FALSE = untrusted header / trust env off — every consumer falls back to
 * the pre-collab behavior, so self-hosters see no change. identity null with
 * trusted TRUE = the verified GitHub user is NOT a member of THIS project — the
 * honest VIEWER state: they can look but never act, and must never be shown as
 * (or attributed to) another member, least of all the project's default human. */
function identity() { return D.identity || null; }
function identityTrusted() { return !!D.identityTrusted; }
function viewerOnly() { return identityTrusted() && !identity(); }
function identityHuman() {
  const id = identity();
  if (!id || !id.agent_id) return null;
  return humans().find((h) => String(h.id) === String(id.agent_id)) || null;
}
// Owner check for owner-gated affordances (invite, role menus, reviewer picker).
// With an identity, its member_role decides; without one (trust off) the acting
// human's snapshot member_role decides — permissive when the field is absent
// (old snapshot in flight), mirroring the backend's trust-off fallback.
function actingOwner() {
  const id = identity();
  if (id) return id.member_role === "owner";
  const h = actingHuman();
  return !!(h && (h.member_role === "owner" || h.member_role == null));
}
// Access model (mig 039): does the acting identity hold a permission grant?
// Mirrors the server's has_grant(): owners implicitly hold everything; members
// need it in their grants list (/api/me now carries the viewer's own set).
// Trust off falls back to actingOwner()'s permissive convention — the server
// stays the enforcer either way; this only gates AFFORDANCES.
function actingGrant(grant) {
  const id = identity();
  if (id) {
    if (id.member_role === "owner") return true;
    return (id.grants || []).indexOf(grant) >= 0;
  }
  return actingOwner();
}
// The read-only states: a trusted NON-member (viewerOnly) OR a member whose project
// role is 'viewer' (mig 039 — can look at everything, every write 403s). Action
// senders/disabled states key off this superset; the banner distinguishes the copy.
function viewerRole() {
  const id = identity();
  return !!(id && id.member_role === "viewer");
}
function actingReadOnly() { return viewerOnly() || viewerRole(); }

/* ---- acting-as: the real human authority, persisted (NOT hardcoded) --- */
function actingKey() { const c = D.container && D.container.id; return "orcha:actingHuman:" + (c || "_"); }
function actingHuman() {
  // collab v1: the verified GitHub identity IS the actor whenever the proxy
  // resolved one — verify/approve/decisions all attribute to this agent.
  // Per-project identity: when the TRUSTED proxy lane is live, the resolved
  // member (or nothing) is the ONLY possible actor — a signed-in non-member of
  // this project must NEVER fall through to the local/default human; action
  // senders see null and disable instead.
  if (identityTrusted()) return identityHuman();
  const bound = identityHuman();
  if (bound) return bound;
  const hs = humans();
  if (!hs.length) return null;
  let saved = null; try { saved = localStorage.getItem(actingKey()); } catch (e) {}
  if (saved) { const m = hs.find((h) => String(h.id) === String(saved)); if (m) return m; }
  return hs[0]; // sole/first human is the common case (1 human per container)
}
function setActingHuman(id) { try { localStorage.setItem(actingKey(), String(id)); } catch (e) {} }
