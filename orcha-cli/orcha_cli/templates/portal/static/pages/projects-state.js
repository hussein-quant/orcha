/* Projects landing — PURE builders (harness-pinned by projects_landing.test.js).
 *
 * Data: GET /api/containers → {containers:[{id, name, description, status,
 *   github_repo, agents, tasks, needs_you, member_count, members|null,
 *   last_wake_scan_at, ...}]} — already MEMBERSHIP-FILTERED server-side under the
 *   trusted proxy lane, and `members` is null wherever roster privacy applies
 *   (non-manage_members viewers get the count, never the names/avatars).
 * Every card's actions are cid-scoped: Open navigates to /?cid=<id>, and the QR
 * button opens the existing pairing modal AGAINST THAT PROJECT
 * (Orcha.openPairingModal({cid, name}) → GET /api/containers/<cid>/pairing). */

const PrjO = window.Orcha;

/* one member-avatar strip, privacy-aware: named avatars only when the server sent
 * the roster; otherwise a plain "N members" count. */
function projMembersHtml(c) {
  const n = c.member_count != null ? Number(c.member_count) : null;
  if (Array.isArray(c.members) && c.members.length) {
    const shown = c.members.slice(0, 5);
    const faces = shown.map((m) => (m.github_login
      ? PrjO.ghAvatar(m.github_login, "sm")
      : PrjO.avatar(m.alias || "?", "human", "sm"))).join("");
    const extra = c.members.length > shown.length
      ? `<span class="more">+${c.members.length - shown.length}</span>` : "";
    return `<span class="pmembers" title="${PrjO.esc(c.members.map((m) => m.github_login || m.alias).join(", "))}">${faces}${extra}</span>`;
  }
  if (n != null) return `<span class="pmembers"><span class="more">${n} member${n === 1 ? "" : "s"}</span></span>`;
  return "";
}

/* per-user default star (mig 040) — rendered ONLY when server prefs are active
 * (opts.stars), so self-host/trust-off keeps the pre-040 card byte-identical.
 * The mark is COSMETIC-plus-tiebreak: data.js resolveCid consults it solely
 * where "/" would otherwise fall back to the active/first project. Toggleable —
 * clicking the starred card's star clears the mark. */
function defStarHtml(c, opts) {
  if (!opts || !opts.stars) return "";
  const on = opts.defaultCid != null && String(opts.defaultCid) === String(c.id);
  return `<button class="defstar${on ? " on" : ""}" type="button" data-def-cid="${PrjO.esc(c.id)}"
      aria-pressed="${on ? "true" : "false"}"
      title="${on ? "Default project — click to unset" : "Make this your default project"}">
      <svg viewBox="0 0 20 20" fill="${on ? "currentColor" : "none"}" stroke="currentColor" stroke-width="1.5"
        stroke-linejoin="round"><path d="M10 2.8l2.2 4.5 4.9.7-3.6 3.5.9 4.9-4.4-2.3-4.4 2.3.9-4.9L3 8l4.9-.7z"/></svg>
    </button>`;
}

function projectCardHtml(c, opts) {
  const needs = Number(c.needs_you || 0);
  const openHref = "/?cid=" + encodeURIComponent(c.id);
  return `<div class="pcard" data-proj-card="${PrjO.esc(c.id)}">
    <div class="ph">
      <span class="pdot${c.status === "active" ? " on" : ""}"></span>
      <span class="pname">${PrjO.esc(c.name)}</span>
      ${defStarHtml(c, opts)}
      ${needs ? `<span class="needs" title="Verifications + requests waiting on a human">Needs you · ${needs}</span>` : ""}
    </div>
    <div class="pdesc">${PrjO.esc(c.description || "No description yet.")}</div>
    ${c.github_repo ? `<span class="prepo" title="${PrjO.esc(c.github_repo)}">${PrjO.icon("link", "")}${PrjO.esc(c.github_repo)}</span>` : ""}
    <div class="pstats">
      <span><b>${Number(c.agents || 0)}</b> agent${Number(c.agents) === 1 ? "" : "s"}</span>
      <span><b>${Number(c.tasks || 0)}</b> task${Number(c.tasks) === 1 ? "" : "s"}</span>
      ${projMembersHtml(c)}
    </div>
    <div class="pfoot">
      <a class="btn sm" href="${openHref}">${PrjO.icon("arrow", "")}Open</a>
      <span class="grow"></span>
      <button class="btn sm ghost" type="button" data-pair-cid="${PrjO.esc(c.id)}"
        data-pair-name="${PrjO.esc(c.name)}" title="Pair a phone to this project">
        ${PrjO.icon("phone", "")}Pair phone</button>
    </div>
  </div>`;
}

function newProjectCardHtml() {
  return `<div class="pcard new" id="projNew" role="button" tabindex="0" title="Create a project">
    <span class="plus">+</span><span>New project</span>
  </div>`;
}

function projectsGridHtml(list, opts) {
  list = list || [];
  if (!list.length) {
    return `<div class="proj-empty">
      <div class="t1">No projects yet</div>
      <div>You're not a member of any project on this Orcha — create one, or ask an
      owner for an invite.</div>
    </div>${newProjectCardHtml()}`;
  }
  return list.map((c) => projectCardHtml(c, opts)).join("") + newProjectCardHtml();
}

/* top chrome: brand · account (viewer identity if resolved) · theme toggle */
function projTopHtml(me) {
  const ident = me && me.identity;
  const acct = ident && ident.github_login
    ? `<span class="acct">${PrjO.ghAvatar(ident.github_login, "sm")}${PrjO.esc(ident.github_login)}</span>`
    : "";
  return `<a class="brand" href="/projects"><span class="mark">${PrjO.orcaSVG()}</span>
      <span class="word">Orcha</span></a>
    <span class="grow"></span>${acct}
    <button class="iconbtn" id="projTheme" title="Theme — click to cycle">
      ${PrjO.icon("sun", "sun")}${PrjO.icon("moon", "moon")}</button>`;
}
