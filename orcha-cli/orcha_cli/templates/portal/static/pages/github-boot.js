/* GitHub hub page controller: tab/filter/search wiring, row click delegation,
   the assignee dropdown, skeleton loading, and boot wiring. Mirrors
   tasks-boot.js's structure — the fetch/patch logic lives in github-render.js
   (this page's "-state.js" equivalent role), this file owns DOM wiring +
   the OrchaData.start poll. */

/* ---------- assignee dropdown ------------------------------------------
   app-shell's menuFloat/openMenu/closeMenu helper is module-private (not
   exported on window.Orcha), so this mirrors its visual idiom (.pmenu.float
   / .pm-row / .pm-head, styles/shell.css — same classes the project switcher
   and "acting as" menus use, so it reads identically in every skin) with
   page-local state. One floating host appended to <body> so the 3s/60s
   repaint of #ghlist never clobbers an open menu; closed on outside click,
   Escape, or a pick. */
let ddEl = null, ddOpenFor = null;
function ghDdHost() {
  if (ddEl) return ddEl;
  ddEl = document.createElement("div");
  ddEl.id = "ghAssignMenu"; ddEl.className = "pmenu float";
  document.body.appendChild(ddEl);
  document.addEventListener("click", (e) => {
    if (!ddOpenFor || ddEl.contains(e.target)) return;
    if (e.target.closest && e.target.closest("[data-gh-start-dd]")) return;   // toggle handles its own
    ghCloseDropdown();
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") ghCloseDropdown(); });
  ddEl.addEventListener("click", (e) => {
    const row = e.target.closest("[data-gh-assign]");
    if (!row) return;
    const agentId = row.getAttribute("data-gh-assign");
    const kind = row.getAttribute("data-gh-kind");
    const number = row.getAttribute("data-gh-number");
    ghCloseDropdown();
    postStart(kind, Number(number), agentId, null);
  });
  return ddEl;
}
function ghCloseDropdown() {
  ddOpenFor = null;
  if (ddEl) ddEl.classList.remove("show");
  document.querySelectorAll("[data-gh-start-dd][aria-expanded='true']").forEach((b) => b.setAttribute("aria-expanded", "false"));
}
function ghOpenDropdown(anchor, kind, number) {
  const el = ghDdHost();
  const key = kind + ":" + number;
  if (ddOpenFor === key) { ghCloseDropdown(); return; }
  ddOpenFor = key;
  el.innerHTML = `<div class="pm-head plain">Assign to</div>${GhS.agentRosterHtml(kind, number, (GhD() && GhD().agents) || [])}`;
  const r = anchor.getBoundingClientRect();
  el.style.top = Math.round(r.bottom + 6) + "px";
  el.style.left = Math.round(Math.max(8, r.right - 200)) + "px";
  el.style.right = "auto";
  el.classList.add("show");
  anchor.setAttribute("aria-expanded", "true");
}

/* ---------- row click delegation (Start / dropdown toggle) ------------- */
Gh$("ghlist").addEventListener("click", (ev) => {
  const start = ev.target.closest("[data-gh-start]");
  if (start) { postStart(start.getAttribute("data-gh-start"), Number(start.getAttribute("data-gh-number")), null, start); return; }
  const dd = ev.target.closest("[data-gh-start-dd]");
  if (dd) { ghOpenDropdown(dd, dd.getAttribute("data-gh-start-dd"), Number(dd.getAttribute("data-gh-number"))); return; }
});

/* ---------- tabs / filters / search ------------------------------------- */
const ghTabsBar = Gh$("ghTabs");
if (ghTabsBar) {
  ghTabsBar.addEventListener("click", (ev) => {
    const seg = ev.target.closest("[data-tab]");
    if (!seg) return;
    const next = seg.getAttribute("data-tab");
    if (!next || next === tab) return;
    tab = next; filter = "open";
    render(true);
    load(tab);
  });
}
const ghFiltersBar = Gh$("ghFilters");
if (ghFiltersBar) {
  ghFiltersBar.addEventListener("click", (ev) => {
    const f = ev.target.closest("[data-gh-filter]");
    if (!f) return;
    filter = f.getAttribute("data-gh-filter");
    render(true);
  });
}
const ghSearchIn = Gh$("ghSearch");
if (ghSearchIn) {
  ghSearchIn.addEventListener("input", () => { query = ghSearchIn.value || ""; render(true); });
}

/* ---------- boot ---------- */
// Perceived-lag fix: the portal is an MPA, so every sidebar click is a full
// navigation — this page boots empty until the first snapshot tick AND the
// issues/pulls fetch both land. Show a skeleton in #ghlist right away
// (OrchaSkeleton.show is delayed 120ms, so a fast local response never
// flashes one), then swap() it for the real render once the active tab's
// fetch settles (render()'s own booted[] gate — matches tasks-boot.js's
// pattern; renderList() — the #ghlist patch — lives in github-render.js,
// this render() owns shell mount + tab chrome + the skeleton swap itself).
if (window.OrchaSkeleton) {
  OrchaSkeleton.show(Gh$("ghlist"), "list-rows");
}
function render(force) {
  if (GhD() && GhD().container) {
    GhO.mountShell("github", { title: "GitHub", ctx: GhD().container.name });
  }
  const tabsEl = Gh$("ghTabs");
  if (tabsEl) {
    tabsEl.querySelectorAll("[data-tab]").forEach((seg) => {
      const on = seg.getAttribute("data-tab") === tab;
      seg.classList.toggle("on", on);
      seg.setAttribute("aria-selected", on ? "true" : "false");
    });
  }
  const filtersEl = Gh$("ghFilters");
  if (filtersEl) filtersEl.innerHTML = GhS.filterChipsHtml(tabKind(), filter);

  const key = tab === "pulls" ? "pulls" : "issues";
  const host = Gh$("ghlist");
  const settled = payload[key] != null || loadError[key] != null;
  if (!booted[key] && settled && window.OrchaSkeleton) {
    booted[key] = true;
    OrchaSkeleton.swap(host, () => renderList(force));
  } else {
    renderList(force);
  }
}
window.OrchaData.start(() => {
  render();
  if (!payload[tab] && !loading[tab] && !loadError[tab]) load(tab);
}, 3000);
// Shell chrome + agent roster ride the shared 3s snapshot poll (above);
// issues/pulls ride their own independent 60s timer (heavier, GitHub-backed,
// server-side cached) so a Start click's optimistic patch isn't immediately
// raced by a same-second background refetch.
if (typeof setInterval !== "undefined") setInterval(() => load(tab, true), 60000);
