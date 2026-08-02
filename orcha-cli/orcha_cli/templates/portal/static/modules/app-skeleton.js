/* Orcha shared portal module: skeleton loading states for the primary content
   region of a page, plus a gentle fade when the real render swaps in.

   Why: the portal is an MPA (orcha-design.md) — every sidebar click is a full
   navigation, so each page boots empty, fetches its snapshot, then paints. The
   founder-reported "considerable lag" on Agents → Tasks is that empty gap: a
   blank/white shell until the first render lands (docs/orcha-issues-log.md).
   This module doesn't touch the fetch path — it only fills that gap with a
   token-styled skeleton, and softens the swap when content actually arrives.

   API (small on purpose — every page wires it the same way):
     OrchaSkeleton.show(container, kind)
       Schedules a skeleton for `container` after a 120ms delay — fast loads
       (the common case on a warm local snapshot) never flash a skeleton at
       all. `kind` picks the shape: "list-rows" | "roster" | "stat-cards" |
       "detail-pane". Calling show() again on the same container (e.g. a
       second boot tick before the first paint) is a no-op while one is
       already pending/showing.
     OrchaSkeleton.swap(container, renderFn)
       Cancels any pending/showing skeleton for `container`, calls
       `renderFn()` (the page's real render), then cross-fades the container
       in. Safe to call even when show() was never called (no skeleton to
       cancel) — it still applies the fade so the first paint isn't an abrupt
       pop. Returns renderFn()'s return value.
     OrchaSkeleton.cancel(container)
       Cancels a pending/showing skeleton without rendering anything (a page
       unmounting the container, or a boot() that found nothing to show).

   Design:
     - Token-driven only (var(--surface-2/-3), var(--border)) — reads correctly
       in classic, swiss, and the minimal skin without a single hex literal.
     - Shimmer is a single left-to-right sweep (mirrors the existing dormant
       `.sk` shimmer in styles/components.css — same gradient shape, kept in
       its own class here so this module has no CSS dependency on that file).
     - prefers-reduced-motion: reduce → the shimmer sweep and the swap fade
       both stop; the skeleton still shows (as a static pulseless block) and
       content still swaps in, just with no motion (mirrors tokens.css's own
       @view-transition reduced-motion branch).
     - The 120ms delay is a real setTimeout, not a CSS animation-delay, so a
       fast swap() before it fires cancels the timer outright — no skeleton
       node is ever created for a fast load.
   ========================================================================== */
window.OrchaSkeleton = (function () {
  "use strict";

  var SHOW_DELAY_MS = 120;
  var FADE_MS = 150;
  var MARK = "data-orcha-skeleton";

  // container -> { timer, showing }. Keyed off the element itself (a WeakMap
  // avoids leaking an id/attribute scheme onto every host element).
  var pending = typeof WeakMap !== "undefined" ? new WeakMap() : null;
  var fallback = [];   // {el, state} pairs, used only if WeakMap is unavailable

  function stateFor(el, create) {
    if (pending) {
      var s = pending.get(el);
      if (!s && create) { s = {}; pending.set(el, s); }
      return s;
    }
    for (var i = 0; i < fallback.length; i++) if (fallback[i].el === el) return fallback[i].state;
    if (create) { var st = {}; fallback.push({ el: el, state: st }); return st; }
    return undefined;
  }
  function clearState(el) {
    if (pending) { pending.delete(el); return; }
    for (var i = 0; i < fallback.length; i++) if (fallback[i].el === el) { fallback.splice(i, 1); return; }
  }

  function reducedMotion() {
    try {
      return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    } catch (e) { return false; }
  }

  var esc = (window.Orcha && window.Orcha.esc) || function (s) {
    return (s == null ? "" : String(s)).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  };

  /* ---- skeleton shapes -------------------------------------------------- */
  function bar(cls) { return '<div class="ork-sk ' + (cls || "") + '"></div>'; }
  function row(kind) {
    if (kind === "roster") {
      return '<div class="ork-sk-row">' +
        bar("ork-sk-avatar") +
        '<div class="ork-sk-col"><div class="ork-sk-line w60"></div><div class="ork-sk-line w40 sm"></div></div>' +
        '</div>';
    }
    // list-rows (tasks/requests): a status pill + title + meta line
    return '<div class="ork-sk-row">' +
      bar("ork-sk-pill") +
      '<div class="ork-sk-col"><div class="ork-sk-line w80"></div><div class="ork-sk-line w30 sm"></div></div>' +
      '</div>';
  }
  function listRowsHtml(n) {
    n = n || 6;
    var out = '<div class="ork-sk-wrap" aria-hidden="true">';
    for (var i = 0; i < n; i++) out += row("list-rows");
    return out + "</div>";
  }
  function rosterHtml(n) {
    n = n || 6;
    var out = '<div class="ork-sk-wrap" aria-hidden="true">';
    for (var i = 0; i < n; i++) out += row("roster");
    return out + "</div>";
  }
  function statCardsHtml() {
    var tile = '<div class="ork-sk-tile">' +
      '<div class="ork-sk-line w40 sm"></div>' +
      '<div class="ork-sk-line w60 lg"></div>' +
      '<div class="ork-sk-line w30 sm"></div>' +
      '</div>';
    var tableRow = '<div class="ork-sk-trow">' +
      bar("ork-sk-avatar sm") + bar("ork-sk-cell") + bar("ork-sk-cell") + bar("ork-sk-cell") + bar("ork-sk-cell") +
      '</div>';
    var rows = "";
    for (var i = 0; i < 5; i++) rows += tableRow;
    return '<div class="ork-sk-wrap" aria-hidden="true">' +
      '<div class="ork-sk-cards">' + tile + tile + tile + tile + '</div>' +
      '<div class="ork-sk-table">' + rows + '</div>' +
      '</div>';
  }
  function detailPaneHtml() {
    return '<div class="ork-sk-wrap" aria-hidden="true">' +
      '<div class="ork-sk-line w50 lg"></div>' +
      '<div class="ork-sk-line w80"></div>' +
      '<div class="ork-sk-line w70"></div>' +
      '<div class="ork-sk-block"></div>' +
      '<div class="ork-sk-line w60"></div>' +
      '<div class="ork-sk-line w40"></div>' +
      '</div>';
  }
  var BUILDERS = {
    "list-rows": listRowsHtml,
    "roster": rosterHtml,
    "stat-cards": statCardsHtml,
    "detail-pane": detailPaneHtml,
  };

  function htmlFor(kind) {
    var build = BUILDERS[kind];
    if (!build) throw new Error("OrchaSkeleton: unknown kind " + esc(String(kind)));
    return build();
  }

  /* ---- public API --------------------------------------------------------
     show(container, kind): after SHOW_DELAY_MS with nothing else happening,
     paints the skeleton markup for `kind` into `container` and marks it
     data-orcha-skeleton="1" so swap()/CSS can find it. */
  function show(container, kind) {
    if (!container) return;
    htmlFor(kind);   // validate the kind eagerly (a typo should fail at call time, not 120ms later)
    var st = stateFor(container, true);
    if (st.timer || st.showing) return;   // already pending or already showing — no-op
    st.timer = setTimeout(function () {
      st.timer = null;
      st.showing = true;
      container.innerHTML = htmlFor(kind);
      container.setAttribute(MARK, "1");
    }, SHOW_DELAY_MS);
  }

  /* cancel(container): stop a pending timer and/or clear a showing skeleton's
     marker (does not touch innerHTML — swap()/the page's own render owns
     that). Safe to call with nothing pending. */
  function cancel(container) {
    if (!container) return;
    var st = stateFor(container, false);
    if (!st) return;
    if (st.timer) { clearTimeout(st.timer); st.timer = null; }
    st.showing = false;
    clearState(container);
    if (container.getAttribute(MARK)) container.removeAttribute(MARK);
  }

  /* swap(container, renderFn): cancel any pending/showing skeleton, run the
     real render, then cross-fade the (now real) content in. Runs the fade
     whether or not a skeleton was ever shown, so a fast first paint still
     gets the same gentle entrance instead of an abrupt pop — and reduced
     motion drops the fade entirely (no class, no animation). */
  function swap(container, renderFn) {
    if (!container) return renderFn ? renderFn() : undefined;
    cancel(container);
    var result = renderFn ? renderFn() : undefined;
    if (!reducedMotion()) {
      container.classList.remove("ork-fade-in");
      // force reflow so re-adding the class restarts the animation even if
      // swap() is called again before the previous fade finished.
      void container.offsetWidth;
      container.classList.add("ork-fade-in");
    }
    return result;
  }

  return { show: show, swap: swap, cancel: cancel, SHOW_DELAY_MS: SHOW_DELAY_MS, FADE_MS: FADE_MS };
})();
