/* Settings page module: the collab-v1 Members card — who's on this project.
 *
 * Data:  GET    /api/containers/{cid}/members         -> {members:[{agent_id, alias,
 *                github_login, member_role, pending}]}
 *        POST   .../members {github_login, role}       (owner-only invite)
 *        PATCH  .../members/{aid} {role}               (owner-only re-role)
 *        DELETE .../members/{aid}                      (owner-only remove = retire)
 * The acting identity comes from /api/me via data.js (D.identity); owner-only
 * affordances key off Orcha.actingOwner() — non-owners see the list read-only.
 * The LAST owner's row never offers demote/remove (the backend 400s both), which
 * covers the common sole-owner-managing-themselves case.
 * actor_agent_id rides every mutation as the trust-off fallback actor; with a
 * trusted proxy identity the server resolves the actor from the header instead. */

const MemO = window.Orcha;
const Mem$ = (id) => document.getElementById(id);

let MEMBERS = null;      // [{agent_id, alias, github_login, member_role, pending}] | null
let memErr = false;
let memBusy = false;
let MEM_CID = null;

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
  if (res.ok && res.body && Array.isArray(res.body.members)) MEMBERS = res.body.members;
  else { MEMBERS = null; memErr = true; }
  renderMembers(true);
}

/* ---- render ----------------------------------------------------------- */
function memberRowHtml(m, canManage, meId, ownerCount) {
  const login = m.github_login;
  const face = login
    ? (typeof ghAvatar === "function" ? ghAvatar(login, "") : MemO.avatar(login, "human", ""))
    : MemO.avatar(m.alias, "human", "");
  const roleChip = `<span class="tag role-${MemO.esc(m.member_role)}">${MemO.esc(m.member_role)}</span>`;
  const pending = m.pending ? '<span class="tag mem-pending">pending</span>' : "";
  const you = meId && String(meId) === String(m.agent_id)
    ? '<span class="mem-you">you</span>' : "";
  // NEVER offer demote/remove on the LAST owner's row (the backend 400s both; the
  // UI must not dangle a dead control) — including the common case: yourself as the
  // sole owner. With another owner around, every row (self included) is manageable.
  const lastOwner = m.member_role === "owner" && ownerCount <= 1;
  const acts = canManage && !lastOwner ? `<span class="mem-acts">
      <button class="btn sm ghost" data-mem-role="${MemO.esc(m.agent_id)}" data-to="${m.member_role === "owner" ? "member" : "owner"}"
        title="${m.member_role === "owner" ? "Demote to member" : "Promote to owner"}">${m.member_role === "owner" ? "Make member" : "Make owner"}</button>
      <button class="iconbtn" data-mem-remove="${MemO.esc(m.agent_id)}" title="Remove access">${MemO.icon("x", "")}</button>
    </span>` : "";
  return `<div class="mem-row">
    ${face}
    <div class="grow" style="min-width:0">
      <div class="mem-name">${MemO.esc(login || m.alias)}${you}</div>
      ${login && login !== m.alias ? `<div class="mem-sub">${MemO.esc(m.alias)}</div>` : ""}
    </div>
    ${pending}${roleChip}${acts}</div>`;
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
  const canManage = !!(MemO.actingOwner && MemO.actingOwner()) && !memBusy;
  const ident = MemO.identity ? MemO.identity() : null;
  const meId = ident ? ident.agent_id : null;
  const ownerCount = MEMBERS.filter((m) => m.member_role === "owner").length;
  const rows = MEMBERS.map((m) => memberRowHtml(m, canManage, meId, ownerCount)).join("");
  const invite = canManage ? `<div class="mem-invite">
      <input id="memLogin" class="sc-inp" spellcheck="false" autocomplete="off"
        placeholder="GitHub username to invite…" maxlength="39">
      <select id="memRole" class="sc-inp mem-role-sel"><option value="member" selected>member</option><option value="owner">owner</option></select>
      <button class="btn sm" id="memInvite" type="button">${MemO.icon("plus", "")}Invite</button>
    </div>
    <div class="sc-hint">Invited members appear as <b>pending</b> until they first sign in.
      The cloud front door (perimeter allowlist) follows this roster — a background sync
      applies invites and removals within a couple of minutes.</div>` : "";
  MemO.patch(host, `<div class="mem-list">${rows || '<div class="none">No human members yet.</div>'}</div>${invite}`, force);
  wireMembers();
}

/* ---- mutations (owner-only; server re-validates) ---------------------- */
function memActor() { return MemO.actingHuman ? MemO.actingHuman() : null; }

function wireMembers() {
  const host = Mem$("membersCard");
  if (!host || !host.querySelectorAll) return;
  const inv = Mem$("memInvite");
  if (inv) inv.addEventListener("click", doInvite);
  const li = Mem$("memLogin");
  if (li && li.addEventListener) li.addEventListener("keydown", (e) => { if (e.key === "Enter") doInvite(); });
  host.querySelectorAll("[data-mem-role]").forEach((b) => b.addEventListener("click", () =>
    doRole(b.getAttribute("data-mem-role"), b.getAttribute("data-to"))));
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
  else MemO.toast("Role change failed (" + res.status + ")" + (res.body && res.body.detail ? ": " + res.body.detail : ""), "danger");
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

/* ---- boot: members fetched once; the light repaint keeps owner-only
 * affordances in sync once /api/me resolves (identity can land after the
 * first paint — patch() dedupes, so an unchanged card is a no-op). ------- */
(async function memInit() {
  if (!window.OrchaData || !window.OrchaData.resolveCid) return;
  try { MEM_CID = await window.OrchaData.resolveCid(); } catch (e) { return; }
  loadMembers();
  if (typeof setInterval !== "undefined") setInterval(() => renderMembers(false), 3000);
})();
