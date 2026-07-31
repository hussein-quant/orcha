/* Settings page module: the collab-v1 Members card — who's on this project.
 *
 * Data:  GET    /api/containers/{cid}/members -> {members:[{agent_id, alias,
 *                github_login, member_role, grants, pending}], restricted:bool}
 *        POST   .../members {github_login, role}       (owner-or-manage_members)
 *        PATCH  .../members/{aid} {role}               (owner-or-manage_members;
 *                to/from owner stays owner-only)
 *        PATCH  .../members/{aid} {grants:[...]}       (owner-only)
 *        DELETE .../members/{aid}                      (owner-or-manage_members;
 *                removing an owner stays owner-only)
 * The acting identity comes from /api/me via data.js (D.identity); management
 * affordances key off Orcha.actingGrant("manage_members"), the owner-only extras
 * (role→owner, the Permissions expander, owner removal) off Orcha.actingOwner().
 * ROSTER PRIVACY: a non-manage_members member receives ONLY their own row plus
 * restricted:true — the card renders their membership + an explanatory note.
 * The LAST owner's row never offers demote/remove (the backend 400s both).
 * actor_agent_id rides every mutation as the trust-off fallback actor; with a
 * trusted proxy identity the server resolves the actor from the header instead. */

const MemO = window.Orcha;
const Mem$ = (id) => document.getElementById(id);

// The grantable permissions (mirror identity_routes.GRANTS) + human labels.
const MEM_GRANTS = [
  ["manage_keys", "API keys & model settings"],
  ["manage_members", "Members — invite, remove, see the roster"],
  ["manage_repo", "GitHub repo binding"],
  ["manage_autonomy", "Autonomy, notifier & wake switches"],
  ["manage_agents", "Agents — create, edit, retire"],
  ["assign_reviewers", "Assign task reviewers"],
];

let MEMBERS = null;      // [{agent_id, alias, github_login, member_role, grants, pending}] | null
let RESTRICTED = false;  // roster privacy: server sent only the viewer's own row
let memErr = false;
let memBusy = false;
let MEM_CID = null;
const memOpenPerms = new Set();   // aids with the Permissions expander open

async function memApi(method, path, body) {
  const init = { method, headers: { "Content-Type": "application/json" } };
  if (body !== undefined) init.body = JSON.stringify(body);
  try {
    const r = await fetch(path, init);
    let j = null;
    try { j = await r.json(); } catch (e) {}
    return { ok: r.ok, status: r.status, body: j };
  } catch (e) { return { ok: false, status: 0, body: null }; }
}

function memUrl(suffix) {
  return "/api/containers/" + encodeURIComponent(MEM_CID) + "/members" + (suffix || "");
}

async function loadMembers() {
  if (!MEM_CID) return;
  memErr = false;
  const res = await memApi("GET", memUrl());
  if (res.ok && res.body && Array.isArray(res.body.members)) {
    MEMBERS = res.body.members;
    RESTRICTED = !!res.body.restricted;
  } else { MEMBERS = null; RESTRICTED = false; memErr = true; }
  renderMembers(true);
}

/* ---- render ----------------------------------------------------------- */
function memFace(m) {
  const login = m.github_login;
  return login
    ? (typeof ghAvatar === "function" ? ghAvatar(login, "") : MemO.avatar(login, "human", ""))
    : MemO.avatar(m.alias, "human", "");
}

// The role control: a <select> over owner/member/viewer. Promoting TO owner (and
// touching an owner row at all) is owner-only server-side, so the option/control
// only renders where the actor could succeed.
function memRoleControl(m, isOwnerActor) {
  const ownerOpt = isOwnerActor
    ? `<option value="owner"${m.member_role === "owner" ? " selected" : ""}>owner</option>` : "";
  return `<select class="sc-inp mem-role-sel" data-mem-role="${MemO.esc(m.agent_id)}"
      title="Project role">${ownerOpt}
    <option value="member"${m.member_role === "member" ? " selected" : ""}>member</option>
    <option value="viewer"${m.member_role === "viewer" ? " selected" : ""}>viewer</option>
  </select>`;
}

function memPermsPanel(m) {
  const held = m.grants || [];
  const boxes = MEM_GRANTS.map(([g, label]) => `<label class="mem-grant">
      <input type="checkbox" data-grant="${g}" data-grant-of="${MemO.esc(m.agent_id)}"
        ${held.indexOf(g) >= 0 ? "checked" : ""}>
      <span>${MemO.esc(label)}</span></label>`).join("");
  return `<div class="mem-perms" data-perms-panel="${MemO.esc(m.agent_id)}">
      <div class="sc-hint">Extra permissions on top of the ${MemO.esc(m.member_role)} role
        (viewers stay read-only regardless — only the roster grant affects them).</div>
      ${boxes}
      <button class="btn sm" data-perms-save="${MemO.esc(m.agent_id)}" type="button">Save permissions</button>
    </div>`;
}

function memberRowHtml(m, ctx) {
  const login = m.github_login;
  const roleChip = `<span class="tag role-${MemO.esc(m.member_role)}">${MemO.esc(m.member_role)}</span>`;
  const pending = m.pending ? '<span class="tag mem-pending">pending</span>' : "";
  const grants = (m.grants || []).length && m.member_role !== "owner"
    ? `<span class="tag mem-grants" title="${MemO.esc((m.grants || []).join(", "))}">+${(m.grants || []).length}</span>` : "";
  const you = ctx.meId && String(ctx.meId) === String(m.agent_id)
    ? '<span class="mem-you">you</span>' : "";
  // NEVER offer demote/remove on the LAST owner's row (the backend 400s both);
  // owner rows are only manageable by another OWNER (server carve-out mirrored).
  const lastOwner = m.member_role === "owner" && ctx.ownerCount <= 1;
  const rowManageable = ctx.canManage && !lastOwner
    && (m.member_role !== "owner" || ctx.isOwner);
  const acts = rowManageable ? `<span class="mem-acts">
      ${memRoleControl(m, ctx.isOwner)}
      ${ctx.isOwner && m.member_role !== "owner"
        ? `<button class="btn sm ghost" data-mem-perms="${MemO.esc(m.agent_id)}" type="button"
            title="Granular permissions">Permissions</button>` : ""}
      <button class="iconbtn" data-mem-remove="${MemO.esc(m.agent_id)}" title="Remove access">${MemO.icon("x", "")}</button>
    </span>` : "";
  const perms = rowManageable && ctx.isOwner && m.member_role !== "owner"
    && memOpenPerms.has(String(m.agent_id)) ? memPermsPanel(m) : "";
  return `<div class="mem-row">
    ${memFace(m)}
    <div class="grow" style="min-width:0">
      <div class="mem-name">${MemO.esc(login || m.alias)}${you}</div>
      ${login && login !== m.alias ? `<div class="mem-sub">${MemO.esc(m.alias)}</div>` : ""}
    </div>
    ${pending}${grants}${roleChip}${acts}</div>${perms}`;
}

// Roster privacy: the server sent only your own membership — render it as a card
// plus the explanation (no invite bar, no roster, no controls).
function restrictedRosterHtml(m) {
  return `<div class="mem-row">
      ${memFace(m)}
      <div class="grow" style="min-width:0">
        <div class="mem-name">${MemO.esc(m.github_login || m.alias)}<span class="mem-you">you</span></div>
      </div>
      ${m.pending ? '<span class="tag mem-pending">pending</span>' : ""}
      <span class="tag role-${MemO.esc(m.member_role)}">${MemO.esc(m.member_role)}</span>
    </div>
    <div class="sc-hint mem-restricted">Your membership on this project. The full member
      list is visible to owners and to members with the members permission.</div>`;
}

function renderMembers(force) {
  const host = Mem$("membersCard");
  if (!host) return;
  if (memErr) {
    MemO.patch(host, `<div class="sc-banner warn"><div class="bt">${MemO.icon("alert", "")}<span>Couldn't load members.</span></div>
      <button class="btn sm" id="memRetry" type="button">Retry</button></div>`, force);
    const rb = Mem$("memRetry");
    if (rb) rb.addEventListener("click", loadMembers);
    return;
  }
  if (!MEMBERS) {
    MemO.patch(host, '<div class="none">Loading members…</div>', force);
    return;
  }
  if (RESTRICTED) {
    MemO.patch(host, MEMBERS.length
      ? restrictedRosterHtml(MEMBERS[0])
      : '<div class="none">No membership found.</div>', force);
    return;
  }
  const isOwner = !!(MemO.actingOwner && MemO.actingOwner());
  const canManage = !memBusy && !((MemO.viewerRole && MemO.viewerRole()))
    && !!(isOwner || (MemO.actingGrant && MemO.actingGrant("manage_members")));
  const ident = MemO.identity ? MemO.identity() : null;
  const ctx = {
    canManage, isOwner,
    meId: ident ? ident.agent_id : null,
    ownerCount: MEMBERS.filter((m) => m.member_role === "owner").length,
  };
  const rows = MEMBERS.map((m) => memberRowHtml(m, ctx)).join("");
  const invite = canManage ? `<div class="mem-invite">
      <input id="memLogin" class="sc-inp" spellcheck="false" autocomplete="off"
        placeholder="GitHub username to invite…" maxlength="39">
      <select id="memRole" class="sc-inp mem-role-sel">
        <option value="member" selected>member</option>
        <option value="viewer">viewer</option>
        ${isOwner ? '<option value="owner">owner</option>' : ""}
      </select>
      <button class="btn sm" id="memInvite" type="button">${MemO.icon("plus", "")}Invite</button>
    </div>
    <div class="sc-hint">Invited members appear as <b>pending</b> until they first sign in.
      The cloud front door (perimeter allowlist) follows this roster — a background sync
      applies invites and removals within a couple of minutes.</div>` : "";
  MemO.patch(host, `<div class="mem-list">${rows || '<div class="none">No human members yet.</div>'}</div>${invite}`, force);
  wireMembers();
}

/* ---- mutations (server re-validates every gate) ----------------------- */
function memActor() { return MemO.actingHuman ? MemO.actingHuman() : null; }

function wireMembers() {
  const host = Mem$("membersCard");
  if (!host || !host.querySelectorAll) return;
  const inv = Mem$("memInvite");
  if (inv) inv.addEventListener("click", doInvite);
  const li = Mem$("memLogin");
  if (li && li.addEventListener) li.addEventListener("keydown", (e) => { if (e.key === "Enter") doInvite(); });
  host.querySelectorAll("[data-mem-role]").forEach((s) => s.addEventListener("change", () =>
    doRole(s.getAttribute("data-mem-role"), s.value)));
  host.querySelectorAll("[data-mem-perms]").forEach((b) => b.addEventListener("click", () => {
    const aid = String(b.getAttribute("data-mem-perms"));
    if (memOpenPerms.has(aid)) memOpenPerms.delete(aid); else memOpenPerms.add(aid);
    renderMembers(true);
  }));
  host.querySelectorAll("[data-perms-save]").forEach((b) => b.addEventListener("click", () =>
    doGrants(b.getAttribute("data-perms-save"))));
  host.querySelectorAll("[data-mem-remove]").forEach((b) => b.addEventListener("click", () =>
    doRemove(b.getAttribute("data-mem-remove"))));
}

async function doInvite() {
  const li = Mem$("memLogin"), rs = Mem$("memRole");
  const login = li ? (li.value || "").trim() : "";
  if (!login || memBusy) return;
  const h = memActor();
  if (!h) { MemO.toast("Pick an acting human first.", "warn"); return; }
  memBusy = true;
  const res = await memApi("POST", memUrl(), {
    github_login: login,
    role: (rs && rs.value) || "member",
    actor_agent_id: h.id,
  });
  memBusy = false;
  if (res.ok) {
    MemO.toast("Invited " + login + " — pending until they first sign in.", "ok");
    loadMembers();
  } else if (res.status === 409) {
    MemO.toast(login + " is already a member.", "warn");
  } else {
    MemO.toast("Invite failed (" + res.status + ")" + (res.body && res.body.detail ? ": " + res.body.detail : ""), "danger");
  }
}

async function doRole(aid, to) {
  if (memBusy) return;
  const h = memActor();
  if (!h) { MemO.toast("Pick an acting human first.", "warn"); return; }
  memBusy = true;
  const res = await memApi("PATCH", memUrl("/" + encodeURIComponent(aid)), {
    role: to, actor_agent_id: h.id,
  });
  memBusy = false;
  if (res.ok) { MemO.toast("Role updated — " + to + ".", "ok"); loadMembers(); }
  else {
    MemO.toast("Role change failed (" + res.status + ")" + (res.body && res.body.detail ? ": " + res.body.detail : ""), "danger");
    loadMembers();   // reset the select to the server truth
  }
}

async function doGrants(aid, grantsOverride) {
  if (memBusy) return;
  const h = memActor();
  if (!h) { MemO.toast("Pick an acting human first.", "warn"); return; }
  let grants = grantsOverride;
  if (!Array.isArray(grants)) {
    grants = [];
    const host = Mem$("membersCard");
    if (host && host.querySelectorAll) {
      host.querySelectorAll('[data-grant-of="' + aid + '"]').forEach((c) => {
        if (c.checked) grants.push(c.getAttribute("data-grant"));
      });
    }
  }
  memBusy = true;
  const res = await memApi("PATCH", memUrl("/" + encodeURIComponent(aid)), {
    grants: grants, actor_agent_id: h.id,
  });
  memBusy = false;
  if (res.ok) { MemO.toast("Permissions saved.", "ok"); loadMembers(); }
  else MemO.toast("Permissions change failed (" + res.status + ")" + (res.body && res.body.detail ? ": " + res.body.detail : ""), "danger");
}

function doRemove(aid) {
  const m = (MEMBERS || []).find((x) => String(x.agent_id) === String(aid));
  const name = m ? (m.github_login || m.alias) : "this member";
  const h = memActor();
  if (!h) { MemO.toast("Pick an acting human first.", "warn"); return; }
  MemO.modal({
    title: "Remove access for " + name + "?", danger: true, primary: "Remove access",
    desc: "They lose access to this workspace: the member mapping is retired (their history and messages are kept), any task naming them as reviewer reverts to anyone, and the cloud front door drops them on the next allowlist sync.",
    onPrimary: async () => {
      MemO.closeModal();
      if (memBusy) return;
      memBusy = true;
      const res = await memApi("DELETE", memUrl("/" + encodeURIComponent(aid)), { actor_agent_id: h.id });
      memBusy = false;
      if (res.ok) { MemO.toast("Removed " + name + ".", "ok"); loadMembers(); }
      else MemO.toast("Remove failed (" + res.status + ")" + (res.body && res.body.detail ? ": " + res.body.detail : ""), "danger");
    },
  });
}

/* ---- boot: members fetched once; the light repaint keeps management
 * affordances in sync once /api/me resolves (identity can land after the
 * first paint — patch() dedupes, so an unchanged card is a no-op). ------- */
(async function memInit() {
  if (!window.OrchaData || !window.OrchaData.resolveCid) return;
  try { MEM_CID = await window.OrchaData.resolveCid(); } catch (e) { return; }
  loadMembers();
  if (typeof setInterval !== "undefined") setInterval(() => renderMembers(false), 3000);
})();
