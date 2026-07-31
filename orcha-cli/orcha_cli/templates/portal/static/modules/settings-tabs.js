/* Settings page tabs — regrouping chrome ONLY (no card content changes).
 *
 * Every card stays in the DOM in its original order (settings_key Case 15 pins
 * the Anthropic key card as the page's FIRST .lead); selecting a tab just sets
 * data-tab on .set-wrap and CSS (pages/settings.css) hides the other groups.
 * Deep-linkable without a router: #tab=collaboration selects the tab on load
 * and on hashchange; clicking a tab rewrites the hash via replaceState (no
 * history spam). Markup mirrors the topbar's .aut/.seg pill idiom (shell.css)
 * so dark/light and the swiss skin hold with no new tokens. Without JS no
 * data-tab is ever set and every card remains visible.
 *
 * Access model: the WORKSPACE tab (API keys + model settings) is hidden for a
 * trusted identity without the manage_keys permission (owners implicitly hold
 * it) — the server enforces regardless; this only removes a dead tab. Identity
 * lands async (/api/me), so visibility is re-applied on a light interval. */
(function () {
  const wrap = document.querySelector(".set-wrap");
  const bar = document.getElementById("setTabs");
  if (!wrap || !bar) return;
  const tabs = Array.prototype.slice.call(bar.querySelectorAll("[data-tab]"));
  const names = tabs.map((t) => t.getAttribute("data-tab"));

  function hiddenTabs() {
    const O = window.Orcha;
    // Hide keys/models ONLY when a trusted identity resolved and lacks the grant —
    // trust-off/self-host (no identity) keeps every tab.
    if (O && O.identity && O.identity() && O.actingGrant && !O.actingGrant("manage_keys")) {
      return ["workspace"];
    }
    return [];
  }

  function visibleNames() {
    const hidden = hiddenTabs();
    return names.filter((n) => hidden.indexOf(n) === -1);
  }

  function applyTabVisibility() {
    const hidden = hiddenTabs();
    tabs.forEach((t) => {
      const off = hidden.indexOf(t.getAttribute("data-tab")) !== -1;
      if (t.style) t.style.display = off ? "none" : "";
      t.classList.toggle("hidden", off);
    });
    // If the selected tab just vanished, fall to the first visible one.
    const current = wrap.getAttribute("data-tab");
    if (current && hidden.indexOf(current) !== -1) {
      const first = visibleNames()[0];
      if (first) select(first, true);
    }
  }

  function fromHash() {
    const m = /(?:^#|[#&])tab=([\w-]+)/.exec(window.location.hash || "");
    const want = m && names.indexOf(m[1]) !== -1 ? m[1] : null;
    const vis = visibleNames();
    if (want && vis.indexOf(want) !== -1) return want;
    return vis[0] || names[0];
  }

  function select(name, writeHash) {
    tabs.forEach((t) => {
      const on = t.getAttribute("data-tab") === name;
      t.classList.toggle("on", on);
      t.setAttribute("aria-selected", on ? "true" : "false");
    });
    wrap.setAttribute("data-tab", name);
    if (writeHash) {
      try { history.replaceState(null, "", "#tab=" + name); }
      catch (e) { window.location.hash = "tab=" + name; }
    }
  }

  tabs.forEach((t) => {
    const pick = () => select(t.getAttribute("data-tab"), true);
    t.addEventListener("click", pick);
    t.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(); }
    });
  });
  window.addEventListener("hashchange", () => select(fromHash(), false));
  select(fromHash(), false);
  applyTabVisibility();
  // /api/me resolves after first paint; keep visibility honest without a reload.
  if (typeof setInterval !== "undefined") setInterval(applyTabVisibility, 3000);
})();
