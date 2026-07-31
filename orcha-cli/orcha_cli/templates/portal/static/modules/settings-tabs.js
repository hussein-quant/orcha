/* Settings page tabs — regrouping chrome ONLY (no card content changes).
 *
 * Every card stays in the DOM in its original order (settings_key Case 15 pins
 * the Anthropic key card as the page's FIRST .lead); selecting a tab just sets
 * data-tab on .set-wrap and CSS (pages/settings.css) hides the other groups.
 * Deep-linkable without a router: #tab=collaboration selects the tab on load
 * and on hashchange; clicking a tab rewrites the hash via replaceState (no
 * history spam). Markup mirrors the topbar's .aut/.seg pill idiom (shell.css)
 * so dark/light and the swiss skin hold with no new tokens. Without JS no
 * data-tab is ever set and every card remains visible. */
(function () {
  const wrap = document.querySelector(".set-wrap");
  const bar = document.getElementById("setTabs");
  if (!wrap || !bar) return;
  const tabs = Array.prototype.slice.call(bar.querySelectorAll("[data-tab]"));
  const names = tabs.map((t) => t.getAttribute("data-tab"));

  function fromHash() {
    const m = /(?:^#|[#&])tab=([\w-]+)/.exec(window.location.hash || "");
    return m && names.indexOf(m[1]) !== -1 ? m[1] : names[0];
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
})();
