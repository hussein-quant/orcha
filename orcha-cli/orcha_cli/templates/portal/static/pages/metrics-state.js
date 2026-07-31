/* Metrics page — pure formatters + view builders (no DOM, no fetch).
   Everything here is a deterministic payload → HTML-string function so the JS
   harness (tests/portal/metrics_page.test.js) can exercise the render from a
   fixture payload without a browser. DOM glue lives in metrics-render.js.

   Chart discipline (dataviz): single-series magnitude everywhere → one hue (the
   token accent), no legend (the card title names the series), text in text
   tokens with tabular-nums only inside table columns, bars ≤24px with a 4px
   rounded data-end and a square baseline, 2px surface gaps, honest zero bars. */
window.OrchaMetrics = (function () {
  const esc = (s) => (window.Orcha && window.Orcha.esc)
    ? window.Orcha.esc(s)
    : String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  const avatar = (alias) => (window.Orcha && window.Orcha.avatar)
    ? window.Orcha.avatar(alias, "ai", "sm")
    : `<span class="av sm">${esc((alias || "?").charAt(0).toUpperCase())}</span>`;

  /* ---- formatters ------------------------------------------------------ */
  function fmtUsd(n) {
    n = Number(n) || 0;
    if (n !== 0 && n < 0.01) return "$" + n.toFixed(4);
    if (n < 1000) return "$" + n.toFixed(2);
    return "$" + Math.round(n).toLocaleString("en-US");
  }
  function fmtTokens(n) {
    n = Number(n) || 0;
    if (n < 1000) return String(n);
    if (n < 1e6) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "K";
    return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
  }
  function fmtDuration(secs) {
    secs = Math.round(Number(secs) || 0);
    if (secs <= 0) return "0s";
    const d = Math.floor(secs / 86400), h = Math.floor((secs % 86400) / 3600);
    const m = Math.floor((secs % 3600) / 60), s = secs % 60;
    if (d) return d + "d " + h + "h";
    if (h) return h + "h " + m + "m";
    if (m) return m + "m " + (s ? s + "s" : "");
    return s + "s";
  }
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function fmtDay(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || "");
    return m ? MONTHS[Number(m[2]) - 1] + " " + Number(m[3]) : String(iso || "");
  }
  function costCaption(totals) {
    const n = totals.runs_with_cost || 0, m = totals.runs || 0;
    if (!m) return "no runs in this window";
    return "estimated · " + n + " of " + m + " run" + (m === 1 ? "" : "s") + " reported cost";
  }

  /* ---- stat cards (KPI row) -------------------------------------------- */
  function statCardsHtml(d) {
    const t = d.totals;
    const tile = (label, value, sub) => `<div class="card mx-tile">
      <div class="l">${label}</div>
      <div class="v">${value}</div>
      <div class="s">${sub}</div>
    </div>`;
    return tile("Est. cost", esc(fmtUsd(t.est_cost_usd)), esc(costCaption(t)))
      + tile("Runs", esc(String(t.runs)),
        "last " + esc(String(d.days)) + " days")
      + tile("Sandbox compute", esc(fmtDuration(t.sandbox_seconds)),
        "container wall-clock")
      + tile("Tasks", esc(String(t.tasks_completed)) + " done",
        esc(String(t.tasks_verified)) + " human-verified");
  }

  /* ---- daily activity — CSS column sparkline (one series: runs) -------- */
  function dailyBarsHtml(d) {
    const days = d.daily || [];
    const max = days.reduce((m, x) => Math.max(m, x.runs), 0);
    const cols = days.map((x) => {
      const pct = max ? Math.round((x.runs / max) * 100) : 0;
      const tip = fmtDay(x.date) + " · " + x.runs + " run" + (x.runs === 1 ? "" : "s")
        + " · " + fmtUsd(x.est_cost_usd);
      return `<div class="mx-col" title="${esc(tip)}">` +
        (x.runs ? `<div class="mx-bar" style="height:${pct}%"></div>` : "") +
        `</div>`;
    }).join("");
    const first = days.length ? fmtDay(days[0].date) : "";
    const last = days.length ? fmtDay(days[days.length - 1].date) : "";
    return `<div class="mx-spark" role="img"
        aria-label="Runs per day over the last ${esc(String(d.days))} days">${cols}</div>
      <div class="mx-spark-x"><span>${esc(first)}</span><span>${esc(last)}</span></div>`;
  }

  /* ---- per-agent table -------------------------------------------------- */
  function agentTableHtml(d) {
    const rows = d.per_agent || [];
    const maxCost = rows.reduce((m, a) => Math.max(m, a.est_cost_usd), 0);
    const body = rows.map((a) => {
      const pct = maxCost ? Math.max(2, Math.round((a.est_cost_usd / maxCost) * 100)) : 0;
      const runsSplit = `${a.ok_runs} ok` + (a.failed_runs
        ? ` · <span class="bad">${a.failed_runs} failed</span>` : "");
      return `<tr data-agent="${esc(a.agent_id)}">
        <td><a class="mx-agent" href="/agents?agent=${encodeURIComponent(a.alias || "")}">
          ${avatar(a.alias)}<span class="nm">${esc(a.alias || "?")}</span></a></td>
        <td>${a.model ? `<span class="tag model">${esc(a.model)}</span>` : '<span class="mx-none">—</span>'}</td>
        <td class="tnum">${a.runs}<span class="mx-sub"> ${runsSplit}</span></td>
        <td class="tnum">${esc(fmtDuration(a.sandbox_seconds))}</td>
        <td class="tnum">${esc(fmtTokens(a.tokens_in))} in · ${esc(fmtTokens(a.tokens_out))} out</td>
        <td class="mx-cost tnum"><span class="mx-costbar" style="--w:${pct}%"></span>
          <span class="v">${esc(fmtUsd(a.est_cost_usd))}</span></td>
      </tr>`;
    }).join("");
    return `<thead><tr><th>Agent</th><th>Model</th><th>Runs</th><th>Compute</th>
      <th>Tokens</th><th>Est. cost</th></tr></thead><tbody>${body}</tbody>`;
  }

  /* ---- honest empty state ---------------------------------------------- */
  function emptyHtml(days) {
    return `<div class="card mx-empty">
      <div class="t1">No agent runs in the last ${esc(String(days))} days</div>
      <div class="t2">Metrics fill in as agents wake and work — cost and token figures
        come from each run's recorded usage, so a quiet window is honestly empty
        rather than estimated.</div>
    </div>`;
  }

  /* ---- whole-body composition (what metrics-render patches in) ---------- */
  function bodyHtml(payload, opts) {
    opts = opts || {};
    if (opts.error) {
      return `<div class="card mx-empty"><div class="t1">Couldn’t load metrics</div>
        <div class="t2">${esc(opts.error)}</div></div>`;
    }
    if (!payload) return '<div class="card mx-empty"><div class="t2">Loading…</div></div>';
    if (!payload.totals || !payload.totals.runs) return emptyHtml(payload ? payload.days : opts.days);
    return `<div class="mx-cards">${statCardsHtml(payload)}</div>
      <div class="card">
        <div class="card-h"><h2>Daily activity</h2>
          <span class="count">${esc(String(payload.totals.runs))} runs</span></div>
        <div class="card-b">${dailyBarsHtml(payload)}</div>
      </div>
      <div class="card">
        <div class="card-h"><h2>Cost &amp; activity by agent</h2>
          <span class="count">${esc(costCaption(payload.totals))}</span></div>
        <div class="card-b flush" style="overflow-x:auto">
          <table class="tbl mx-tbl">${agentTableHtml(payload)}</table>
        </div>
      </div>`;
  }

  return { fmtUsd, fmtTokens, fmtDuration, fmtDay, costCaption,
    statCardsHtml, dailyBarsHtml, agentTableHtml, emptyHtml, bodyHtml };
})();
