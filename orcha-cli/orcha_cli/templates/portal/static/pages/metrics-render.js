/* Metrics page — DOM glue: shell mount, the 7/30-day range toggle, and the
   metrics fetch → OrchaMetrics.bodyHtml patch cycle. All view HTML comes from
   metrics-state.js; this file only owns fetching and patching.

   Cadence: the shared 3s snapshot poll (OrchaData.start) keeps the shell chrome
   live; the AGGREGATE endpoint is heavier and changes slowly, so it refreshes
   on load, on range toggle, and on a 60s timer — never on the 3s tick. */
(function () {
  const O = window.Orcha;
  const M = window.OrchaMetrics;
  let days = 7;
  let payload = null;
  let loading = false;
  let loadError = null;

  function cid() {
    return (window.OrchaData && window.OrchaData.currentCid())
      || (window.ORCHA && window.ORCHA.container && window.ORCHA.container.id) || null;
  }

  // Perceived-lag fix: #mxBody shows the M.bodyHtml "Loading…" text state on
  // every tick until the /metrics aggregate fetch settles (payload or
  // loadError set) — that plain-text wait is the visible lag on this page.
  // OrchaSkeleton.show (120ms-delayed, so a fast fetch never flashes it)
  // covers that gap; swap() fires once, the first render AFTER the fetch
  // actually settles, not merely once a container snapshot exists.
  if (window.OrchaSkeleton) OrchaSkeleton.show(document.getElementById("mxBody"), "stat-cards");
  let booted = false;

  function render(force) {
    if (window.ORCHA && window.ORCHA.container) {
      O.mountShell("metrics", { title: "Metrics", ctx: window.ORCHA.container.name });
    }
    const range = document.getElementById("mxRange");
    if (range) {
      range.querySelectorAll("[data-days]").forEach((seg) => {
        seg.classList.toggle("on", Number(seg.getAttribute("data-days")) === days);
        seg.setAttribute("aria-selected", Number(seg.getAttribute("data-days")) === days ? "true" : "false");
      });
    }
    const host = document.getElementById("mxBody");
    if (!host) return;
    const settled = payload != null || loadError != null;
    if (!booted && settled && window.OrchaSkeleton) {
      booted = true;
      OrchaSkeleton.swap(host, () => O.patch(host, M.bodyHtml(payload, { days, error: loadError }), force));
    } else {
      O.patch(host, M.bodyHtml(payload, { days, error: loadError }), force);
    }
  }

  function load(force) {
    const id = cid();
    if (!id || loading) return;
    loading = true;
    fetch("/api/containers/" + encodeURIComponent(id) + "/metrics?days=" + days)
      .then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then((d) => { payload = d; loadError = null; })
      .catch((e) => { if (!payload) loadError = e.message; })
      .then(() => { loading = false; render(force); });
  }

  const range = document.getElementById("mxRange");
  if (range) {
    range.addEventListener("click", (event) => {
      const seg = event.target.closest("[data-days]");
      if (!seg) return;
      const next = Number(seg.getAttribute("data-days"));
      if (!next || next === days) return;
      days = next;
      payload = null;                 // stale window — show Loading, not old numbers
      render(true);
      load(true);
    });
  }

  // Shell chrome rides the shared snapshot poll; the aggregate rides its own timer.
  window.OrchaData.start(() => { render(); if (!payload && !loading && !loadError) load(); });
  if (typeof setInterval !== "undefined") setInterval(() => load(), 60000);
})();
