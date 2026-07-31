/* Orcha shared portal module: sidebar, topbar, global search, and navigation chrome. */

/* ---- shared floating menu (house dropdown idiom, mirrors ncFloat) ----- *
 * One floating host per menu id, appended to <body> so the 3s shell re-render never
 * clobbers an OPEN menu (mountShell rebuilds the sidebar/topbar markup wholesale);
 * positioned from the trigger's rect on open. Outside-click + Escape close, with the
 * anchor looked up FRESH by id so the re-rendered trigger still counts as "inside". */
const _menus = {};
function menuFloat(id) {
  let el = document.getElementById(id);
  if (!el) {
    el = document.createElement("div");
    el.id = id; el.className = "pmenu float";
    document.body.appendChild(el);
    document.addEventListener("click", (e) => {
      const st = _menus[id];
      if (!st || !st.open || el.contains(e.target)) return;
      const anchor = st.anchorId ? document.getElementById(st.anchorId) : null;
      if (anchor && anchor.contains(e.target)) return;
      closeMenu(id);
    });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeMenu(id); });
  }
  return el;
}
function openMenu(id, anchor, html, align) {
  const el = menuFloat(id);
  _menus[id] = { open: true, anchorId: anchor ? anchor.id : null };
  el.innerHTML = html;
  const r = anchor && anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : null;
  if (r) {
    el.style.top = Math.round(r.bottom + 8) + "px";
    if (align === "right") {
      el.style.right = Math.round(Math.max(8, window.innerWidth - r.right)) + "px";
      el.style.left = "auto";
    } else {
      el.style.left = Math.round(Math.max(8, r.left)) + "px";
      el.style.right = "auto";
    }
  }
  el.classList.add("show");
  return el;
}
function closeMenu(id) {
  if (_menus[id]) _menus[id].open = false;
  const el = document.getElementById(id);
  if (el) el.classList.remove("show");
}
function menuIsOpen(id) { return !!(_menus[id] && _menus[id].open); }

/* ---- shell ----------------------------------------------------------- */
/* ---- collapsible sidebar (icon rail) --------------------------------- *
 * Browser-local, same contract as the theme/skin picks: persisted in
 * localStorage "orcha:sidebar" and applied pre-paint by each page's <head>
 * script as data-sidebar="collapsed" on <html>, so the rail never flashes
 * at the wrong width. CSS owns both layouts; the toggle just flips state
 * (no re-render needed — the same DOM serves both). */
function sidebarCollapsed() {
  try { return localStorage.getItem("orcha:sidebar") === "collapsed"; } catch (e) { return false; }
}
function toggleSidebar() {
  const collapsed = !sidebarCollapsed();
  try { localStorage.setItem("orcha:sidebar", collapsed ? "collapsed" : "expanded"); } catch (e) {}
  const d = document.documentElement;
  if (collapsed) d.setAttribute("data-sidebar", "collapsed");
  else d.removeAttribute("data-sidebar");
  const btn = document.getElementById("sbToggle");
  if (btn) {
    const t = collapsed ? "Expand sidebar" : "Collapse sidebar";
    btn.title = t;
    btn.setAttribute("aria-label", t);
    btn.setAttribute("aria-expanded", collapsed ? "false" : "true");
  }
}

/* Collab v1: the topbar "acting as" chip. When /api/me resolved a verified GitHub
 * identity, the actor IS that user — circular GitHub avatar (letter-tile fallback on
 * image error) + the login. Otherwise keep the pre-collab fallback: the picked local
 * human, or the "no human registered" nudge. Extracted so the harness can pin it. */
function actingChipHtml() {
  const ident = identity();
  if (ident && ident.github_login) {
    return `${ghAvatar(ident.github_login, "sm")}<span class="gh-login">${esc(ident.github_login)}</span>`;
  }
  // Per-project identity: a TRUSTED sign-in that resolved no member of this project
  // is a VIEWER — a neutral chip, never another member's avatar/name (and never the
  // project's default human, the exact fallback this state exists to prevent).
  if (viewerOnly()) {
    return `<span class="muted viewer-chip">viewer · not a member</span>`;
  }
  const who = actingHuman();
  return who
    ? `${avatar(who.alias, "human", "sm")}${esc(who.alias)}`
    : `<span class="muted">no human registered</span>`;
}

/* ---- collab: the acting-as account menu (sign out) -------------------- *
 * The portal sits behind oauth2-proxy; GET /oauth2/sign_out clears the proxy session
 * (Caddy proxies the path) and rd= sends the signed-out user to the public landing
 * page. Plain <a> navigation on purpose — no fetch, the proxy owns the redirect. */
const SIGN_OUT_HREF = "/oauth2/sign_out?rd=%2Fwelcome";
// Pure builder (harness-pinned): the menu body — login header + the one action.
function actingMenuHtml() {
  const ident = identity();
  if (!ident || !ident.github_login) {
    // Viewer (trusted, non-member): there is still a proxy session to clear.
    if (viewerOnly()) {
      return `<div class="pm-head"><div class="b"><div class="t1">Not a member</div>
      <div class="t2">viewing only · GitHub</div></div></div>
    <a class="pm-row signout" href="${SIGN_OUT_HREF}">${icon("arrow", "")}<span>Sign out</span></a>`;
    }
    return "";
  }
  return `<div class="pm-head">${ghAvatar(ident.github_login, "sm")}
      <div class="b"><div class="t1">${esc(ident.github_login)}</div>
      <div class="t2">${esc(ident.member_role || "member")} · GitHub</div></div></div>
    <a class="pm-row signout" href="${SIGN_OUT_HREF}">${icon("arrow", "")}<span>Sign out</span></a>`;
}
// The chip is interactive with a proxy session — a resolved identity OR the trusted
// viewer state (sign out must stay reachable); self-host (trust off, identity null)
// keeps the informational chip untouched — there is no proxy session to clear.
function wireActingChip() {
  const chip = document.getElementById("actingChip");
  if (!chip || (!identity() && !viewerOnly())) return;
  chip.classList.add("menu-trigger");
  chip.setAttribute("role", "button");
  chip.setAttribute("aria-haspopup", "true");
  chip.title = "Signed in via GitHub — account menu";
  chip.addEventListener("click", () => {
    if (menuIsOpen("amFloat")) closeMenu("amFloat");
    else openMenu("amFloat", chip, actingMenuHtml(), "right");
  });
}

/* ---- per-project identity: the non-member VIEWER banner ---------------- *
 * Shown under the topbar on every page when a trusted sign-in resolved NO
 * membership in the current project (viewerOnly). Same idiom as the pausebar:
 * a pure builder the harness can pin + an idempotent ensure that toggles a
 * .show class, so the 3s shell re-render reconciles it cheaply. */
function viewerBannerHtml() {
  return `<span>You're viewing as a non-member — ask an owner for an invite to act.</span>`;
}
function ensureViewerBanner(topbar) {
  if (!topbar || typeof topbar.insertAdjacentElement !== "function") return;
  let bar = document.getElementById("viewerbar");
  if (!bar) {
    bar = document.createElement("div");
    bar.className = "viewerbar";
    bar.id = "viewerbar";
    bar.innerHTML = viewerBannerHtml();
    topbar.insertAdjacentElement("afterend", bar);
  }
  bar.classList[viewerOnly() ? "add" : "remove"]("show");
}

/* ---- multi-project: the sidebar project switcher ---------------------- *
 * Lives in the brand area (under the Orcha mark) — the project IS the workspace
 * context everything below it renders. Menu rows come FRESH from GET /api/containers
 * on open (name + status + live-agent count, per mig 037); selecting a row hands off
 * to OrchaData.switchProject (persist orcha:cid + reload on the new project). The
 * "＋ New project" row opens the house modal → POST /api/containers additional=true. */
function projSwitchHtml() {
  const c = D.container;
  const name = (c && c.name) || "—";
  return `<button class="proj-switch" id="projSwitch" type="button" aria-haspopup="true"
      title="Project: ${esc(name)} — switch project">
      <span class="pdot${c && c.status === "active" ? " on" : ""}"></span>
      <span class="pname">${esc(name)}</span>${icon("chev", "chev")}</button>`;
}
// Pure builder (harness-pinned): the menu body from a containers list + current cid.
function projMenuHtml(list, cid) {
  const rows = (list || []).map((c) => {
    const cur = String(c.id) === String(cid);
    const agentsN = c.agents != null ? ` · ${c.agents} agent${Number(c.agents) === 1 ? "" : "s"}` : "";
    return `<button class="pm-row proj${cur ? " on" : ""}" type="button" data-proj="${esc(c.id)}">
      <span class="pdot${c.status === "active" ? " on" : ""}"></span>
      <span class="b"><span class="t1">${esc(c.name)}</span>
      <span class="t2">${esc(c.status)}${agentsN}</span></span>
      ${cur ? icon("check", "chk") : ""}</button>`;
  }).join("");
  return `<div class="pm-head plain">Projects</div>${rows}
    <button class="pm-row new" type="button" data-proj-new="1">${icon("plus", "")}<span>New project</span></button>`;
}
function currentCid() {
  if (window.OrchaData && window.OrchaData.currentCid) return window.OrchaData.currentCid();
  return D.container ? D.container.id : null;
}
function switchProject(cid) {
  closeMenu("psFloat");
  if (D.container && String(D.container.id) === String(cid)) return;   // already here
  if (window.OrchaData && window.OrchaData.switchProject) window.OrchaData.switchProject(cid);
}
function wireProjMenuRows(el) {
  el.querySelectorAll("[data-proj]").forEach((row) => {
    row.addEventListener("click", () => switchProject(row.getAttribute("data-proj")));
  });
  el.querySelectorAll("[data-proj-new]").forEach((row) => {
    row.addEventListener("click", () => { closeMenu("psFloat"); openNewProjectModal(); });
  });
}
function openProjectMenu(anchor) {
  if (menuIsOpen("psFloat")) { closeMenu("psFloat"); return; }
  openMenu("psFloat", anchor, `<div class="pm-head plain">Projects</div>
    <div class="pm-row muted">Loading…</div>`);
  fetch("/api/containers")
    .then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
    .then((d) => {
      if (!menuIsOpen("psFloat")) return;   // closed while loading
      const el = document.getElementById("psFloat");
      el.innerHTML = projMenuHtml((d && d.containers) || [], currentCid());
      wireProjMenuRows(el);
    })
    .catch((e) => { closeMenu("psFloat"); toast("Could not load projects: " + e.message, "danger"); });
}

/* ---- multi-project: the New-project modal ----------------------------- */
function openNewProjectModal() {
  modal({
    title: "New project",
    desc: "Adds another project to this stack. Portal-only until a host workspace is "
      + "bound to it — agents and tasks work, but nothing wakes agents yet.",
    body: `<label class="np-f"><span>Name</span>
        <input id="npName" maxlength="200" placeholder="e.g. api-gateway" spellcheck="false"></label>
      <label class="np-f"><span>Description</span>
        <textarea id="npDesc" class="ta" placeholder="What is this project about? (optional)"></textarea></label>`,
    primary: "Create project",
    onPrimary: () => {
      const name = ((document.getElementById("npName") || {}).value || "").trim();
      const desc = ((document.getElementById("npDesc") || {}).value || "").trim();
      if (!name) { toast("A project name is required.", "danger"); return; }
      postNewProject(name, desc);
    },
  });
}
function postNewProject(name, desc) {
  fetch("/api/containers", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: name, description: desc || null, additional: true }),
  })
    .then((r) => r.json().then((d) => ({ ok: r.ok, status: r.status, d })).catch(() => ({ ok: r.ok, status: r.status, d: {} })))
    .then(({ ok, status, d }) => {
      if (!ok) {
        toast("Create failed" + (d && d.detail ? ": " + d.detail : " (" + status + ")"), "danger");
        return;
      }
      closeModal();
      // One-time dashboard notice on the NEW project (home-state.renderProjNotice):
      // flagged here, shown only while no host-side notifier serves it (wakesServed).
      try { localStorage.setItem("orcha:projNotice:" + d.container_id, "1"); } catch (e) {}
      toast("Project created — switching…", "ok");
      switchProject(d.container_id);
    })
    .catch((e) => toast("Create failed: " + e.message, "danger"));
}

function mountShell(page, opts) {
  opts = opts || {};
  const a = attnItems();
  // hrefs are the served FastAPI routes (extensionless), NOT the *.html filenames —
  // the portal serves /, /agents, /tasks, /requests (review P2: *.html would 404).
  const nv = [
    { key: "home", href: "/", ico: "home", label: "Dashboard" },
    { key: "agents", href: "/agents", ico: "agents", label: "Agents", count: agents().length },
    { key: "tasks", href: "/tasks", ico: "tasks", label: "Tasks",
      count: tasks().filter((t) => t.status === "needs_verification").length, attn: true },
    { key: "requests", href: "/requests", ico: "requests", label: "Requests",
      count: requests().filter((r) => r.status === "open").length },
    // Metrics page — usage/cost visibility per agent. No count badge (an
    // aggregate page has no "N waiting" semantics).
    { key: "metrics", href: "/metrics", ico: "metrics", label: "Metrics" },
    // SPEC-SETTINGS §5: 5th control-room entry — the Settings page (API key +,
    // later, per-use-case model selection). No count badge.
    { key: "settings", href: "/settings", ico: "sliders", label: "Settings" },
  ];

  const sidebar = document.getElementById("sidebar");
  if (sidebar) {
    const sbT0 = sidebarCollapsed() ? "Expand sidebar" : "Collapse sidebar";
    sidebar.innerHTML = `
      <div class="brand-row">
        <a class="brand" href="/" style="color:inherit">
          <span class="mark">${orcaSVG()}</span>
          <span class="word">Orcha<small>orchestration portal</small></span>
        </a>
        <button class="sb-toggle" id="sbToggle" type="button" title="${sbT0}" aria-label="${sbT0}"
          aria-expanded="${sidebarCollapsed() ? "false" : "true"}">${icon("chev", "ico")}</button>
      </div>
      ${projSwitchHtml()}
      <nav class="nav">
        <div class="lbl">Control room</div>
        ${nv.map((n) => `<a href="${n.href}" class="${n.key === page ? "active" : ""}" title="${n.label}${n.count != null ? " · " + n.count : ""}">
          ${icon(n.ico, "ico")}<span class="grow">${n.label}</span>
          ${n.count != null ? `<span class="ncount${n.attn && n.count ? " attn" : ""}">${n.count}</span>` : ""}
        </a>`).join("")}
        <div class="lbl">Live</div>
        <a href="/agents" class="" title="Run feed">
          ${icon("live", "ico")}<span class="grow">Run feed</span>
        </a>
      </nav>
      <div class="sb-spacer"></div>
      <div class="attn-card">
        <div class="h">${icon("bell", "")}<span>Needs you</span></div>
        <div class="big tnum">${a.count}</div>
        <div class="sub">${a.verifs.length} to verify · ${a.escs.length} escalation${a.escs.length === 1 ? "" : "s"}</div>
        <a class="go" href="/#needs">Open action queue ${icon("arrow", "")}</a>
      </div>
      <a class="attn-mini" href="/#needs" title="Needs you · ${a.count} — open action queue">
        ${icon("bell", "")}<span class="n tnum">${a.count}</span>
      </a>`;
    const sbT = document.getElementById("sbToggle");
    if (sbT) sbT.addEventListener("click", toggleSidebar);
    const ps = document.getElementById("projSwitch");
    if (ps) ps.addEventListener("click", () => openProjectMenu(ps));
  }

  const topbar = document.getElementById("topbar");
  if (topbar) {
    const actingHTML = actingChipHtml();
    // Two logical lines: identity/search/alerts, then the controls. They sit on one row when
    // the topbar is wide and collapse to two balanced rows when it's too narrow to fit (CSS).
    topbar.innerHTML = `
      <div class="tb-line tb-line-1">
        <div class="crumbs">
          <span class="page">${esc(opts.title || "")}</span>
          ${opts.ctx ? `<span class="ctx">${opts.ctx}</span>` : ""}
        </div>
        <div class="search">
          ${icon("search", "")}
          <input id="globalSearch" placeholder="Search agents, tasks, requests…" spellcheck="false" autocomplete="off">
          <span class="kbd">/</span>
        </div>
        <a class="attn-pill" id="attnPill" href="/#needs" title="Notifications — approvals, verifications & activity" aria-haspopup="true">
          ${icon("bell", "bell")}<span>Needs you</span><span class="n tnum">${a.count}</span>
        </a>
      </div>
      <div class="tb-line tb-line-2">
        <!-- GH #148: two orthogonal controls, not one fused slider. Notifier = the power
             switch (wakes_enabled); Autonomy = the gearbox (autonomy_level). A divider keeps
             them reading as two separate things; both keep the acting-human lock. -->
        <div class="ctl-wrap" id="ctlWrap">
          <div class="ctl-group" id="notifGroup">
            <span class="aut-lab">Notifier</span>
            <div class="aut notif" id="notifTop" role="group" aria-label="Event notifier — pause or resume all agent wakes"></div>
          </div>
          <span class="ctl-div" aria-hidden="true"></span>
          <div class="ctl-group" id="autGroup">
            <span class="aut-lab">Autonomy</span>
            <div class="aut" id="autTop" role="radiogroup" aria-label="Container autonomy level"></div>
          </div>
        </div>
        <div class="acting" id="actingChip" title="You are the human authority on this container">
          <span class="lbl">acting as</span>
          <span class="who" id="actingWho">${actingHTML}</span>
        </div>
        <button class="btn sm subtle pair-top" id="pairPhoneBtn" type="button" title="Pair a phone on this Wi-Fi network">
          ${icon("phone", "")}Pair phone
        </button>
        <button class="iconbtn" id="themeBtn" title="Theme: ${currentTheme()} — click to cycle">
          ${icon("sun", "sun")}${icon("moon", "moon")}
        </button>
      </div>`;
    const tb = document.getElementById("themeBtn");
    if (tb) tb.addEventListener("click", cycleTheme);
    const pb = document.getElementById("pairPhoneBtn");
    if (pb) pb.addEventListener("click", openPairingModal);
    // SPEC-1: ensure the paused micro-banner element sits between topbar and content,
    // then render the autonomy switch from the current snapshot. Injected here (not in
    // each *.html) so the control is identical on every page.
    ensurePausebar(topbar);
    // Per-project identity: surface the honest non-member state on every page.
    ensureViewerBanner(topbar);
    paintAutonomy();
    // SPEC-3: turn the "Needs you" pill into the notification-center dropdown trigger.
    wireNotifPill();
    // Collab: with a proxy-verified identity the acting chip opens the account menu
    // (sign out); identity null (self-host) leaves it informational, untouched.
    wireActingChip();
    const gs = document.getElementById("globalSearch");
    if (gs) document.addEventListener("keydown", (e) => {
      // the "/" shortcut focuses search — but NOT while the user is typing in a field
      // (composer, reason box, any input/textarea/select/contenteditable), or it would
      // steal the "/" keystroke + the focus mid-typing.
      if (e.key === "/" && !isEditableTarget(document.activeElement)) { e.preventDefault(); gs.focus(); }
      if (e.key === "Escape") gs.blur();
    });
  }
}

/* ---- GH #148: two orthogonal topbar controls ------------------------- */
// The topbar carries TWO independent controls, NOT one fused slider:
//   NOTIFIER  — the LIVE binary kill-switch, containers.wakes_enabled
//               (POST /api/containers/{cid}/wakes). Paused(red) vs Running(green).
//               "The power switch": do agents wake AT ALL?
//   AUTONOMY  — the engine LEVEL, containers.autonomy_level
//               (#298: POST /api/containers/{cid}/autonomy, level ∈ plan|pr|full).
//               "The gearbox": how far agents may go WHEN they act.
// They are orthogonal: pausing the notifier does NOT change the level, so the active
// level keeps rendering whether the notifier is Running or Paused (dimmed while paused,
// but still legible + editable so you can pre-set the level before resuming). The active
