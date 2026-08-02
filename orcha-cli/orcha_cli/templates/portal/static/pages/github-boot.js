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

/* ---------- routing (?pr=N / ?issue=N) ----------------------------------
   Client-side only — one MPA page (github.html) hosts both the list and every
   item's detail view, swapping via history.pushState so back/forward and a
   fresh deep link (a founder pasting /github?pr=42) all resolve to the same
   render without a full navigation. readRouteFromUrl() is the single source
   of truth for `route` (github-render.js's module-level state); navigate()
   is the only writer during a session (pushState + immediate render), while
   popstate re-derives route from the URL the browser already changed to
   (never pushes again — that would double an entry per back/forward step). */
function readRouteFromUrl() {
  const params = new URL(location.href).searchParams;
  const pr = params.get("pr");
  if (pr && /^\d+$/.test(pr)) return { kind: "pull", number: Number(pr) };
  const issue = params.get("issue");
  if (issue && /^\d+$/.test(issue)) return { kind: "issue", number: Number(issue) };
  return { kind: null, number: null };
}
function navigate(next, replace) {
  const u = new URL(location.href);
  u.searchParams.delete("pr"); u.searchParams.delete("issue");
  if (next.kind === "pull") u.searchParams.set("pr", String(next.number));
  else if (next.kind === "issue") u.searchParams.set("issue", String(next.number));
  if (replace) history.replaceState(null, "", u);
  else history.pushState(null, "", u);
  route = next;
  detailSubTab = "conversation";
  render(true);
  if (next.kind) loadDetail(false);
}
window.addEventListener("popstate", () => {
  route = readRouteFromUrl();
  detailSubTab = "conversation";
  render(true);
  if (route.kind) loadDetail(false);
});

/* ---------- row click delegation (Start / dropdown toggle / open detail) - */
Gh$("ghlist").addEventListener("click", (ev) => {
  const start = ev.target.closest("[data-gh-start]");
  if (start) { ev.stopPropagation(); postStart(start.getAttribute("data-gh-start"), Number(start.getAttribute("data-gh-number")), null, start); return; }
  const dd = ev.target.closest("[data-gh-start-dd]");
  if (dd) { ev.stopPropagation(); ghOpenDropdown(dd, dd.getAttribute("data-gh-start-dd"), Number(dd.getAttribute("data-gh-number"))); return; }
  const ext = ev.target.closest("a.gh-open-ext, a.gh-crumb-back, a.dlink");
  if (ext) return;   // real external/back/task links — let the browser handle them
  const subtab = ev.target.closest("[data-gh-subtab]");
  if (subtab) { detailSubTab = subtab.getAttribute("data-gh-subtab"); renderDetail(true); return; }
  const open = ev.target.closest("[data-gh-open]");
  if (open) {
    const [kind, numStr] = open.getAttribute("data-gh-open").split(":");
    navigate({ kind, number: Number(numStr) });
  }
});
// Breadcrumb back: a real <a href="?tab=..."> for right-click/open-in-tab, but
// a plain click uses history.back() when we arrived FROM the list this
// session (nicer than a hard navigation) — falls through to the href (a fresh
// pushState) when there's no page history to go back to (a deep-linked pr=N
// with no prior /github visit in this tab's history).
Gh$("ghlist").addEventListener("click", (ev) => {
  const back = ev.target.closest("[data-gh-back]");
  if (!back) return;
  if (window.history.length > 1) { ev.preventDefault(); history.back(); }
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
    if (route.kind) navigate({ kind: null, number: null }, true);
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
// initial route from whatever URL the page loaded with (deep link or a bare
// /github visit) — read BEFORE the first render so a pr=/issue= deep link
// skips the list entirely on first paint, never flashing the list first.
route = readRouteFromUrl();
if (route.kind === "pull") tab = "pulls";
else if (route.kind === "issue") tab = "issues";
// ?tab=pulls|issues (the breadcrumb back-link's no-JS/right-click fallback
// href, github-state.js's breadcrumbHtml) also seeds the initial tab on a
// bare list load, so that href genuinely lands on the right tab even without
// the JS history.back() path.
else {
  const initialTab = new URL(location.href).searchParams.get("tab");
  if (initialTab === "pulls" || initialTab === "issues") tab = initialTab;
}

function render(force) {
  if (GhD() && GhD().container) {
    GhO.mountShell("github", { title: "GitHub", ctx: GhD().container.name });
  }
  const headEl = Gh$("ghHead");
  if (headEl) headEl.classList.toggle("hidden", !!route.kind);
  const listHost = Gh$("ghlist");
  if (listHost) listHost.classList.toggle("gh-detail-mode", !!route.kind);
  const tabsEl = Gh$("ghTabs");
  if (tabsEl) {
    tabsEl.querySelectorAll("[data-tab]").forEach((seg) => {
      const on = seg.getAttribute("data-tab") === tab;
      seg.classList.toggle("on", on);
      seg.setAttribute("aria-selected", on ? "true" : "false");
    });
  }
  const filtersEl = Gh$("ghFilters");
  if (filtersEl) filtersEl.innerHTML = route.kind ? "" : GhS.filterChipsHtml(tabKind(), filter);

  if (route.kind) {
    renderDetail(force);
    return;
  }

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
  if (route.kind) { if (!detailLoading[detailKey()]) loadDetail(false); }
  else if (!payload[tab] && !loading[tab] && !loadError[tab]) load(tab);
}, 3000);
// Shell chrome + agent roster ride the shared 3s snapshot poll (above);
// issues/pulls ride their own independent 60s timer (heavier, GitHub-backed,
// server-side cached) so a Start click's optimistic patch isn't immediately
// raced by a same-second background refetch. The detail route rides the SAME
// 60s cadence (re-fetches only the one open item, not the whole list).
if (typeof setInterval !== "undefined") {
  setInterval(() => { if (route.kind) loadDetail(true); else load(tab, true); }, 60000);
}
