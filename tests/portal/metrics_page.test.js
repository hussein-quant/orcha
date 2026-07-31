/* ============================================================================
   Metrics page — usage/cost visibility per agent.

   Part 1 (static): metrics.html follows the house page skeleton (D0 head +
   shell mounts + module load order), carries the 7/30-day range toggle and the
   #mxBody mount, and the page is registered where pages are enumerated —
   the app-shell nav list and the app-ui icon set.

   Part 2 (behavior): loads the REAL pages/metrics-state.js in a bare vm and
   pins the payload → HTML render: stat cards (incl. the honest "estimated,
   N of M runs reported cost" caption), the per-agent table (rows, ok/failed
   split, model tag, cost-proportion bar widths, cost-desc order preserved),
   the daily bar sparkline (a column per day, zero days honest), the empty
   state, and the formatters.

   Run: node tests/portal/metrics_page.test.js
   ========================================================================== */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const STATIC = path.join(
  __dirname, "..", "..",
  "orcha-cli", "orcha_cli", "templates", "portal", "static"
);
const HTML = fs.readFileSync(path.join(STATIC, "metrics.html"), "utf8");
const STATE_JS = fs.readFileSync(path.join(STATIC, "pages", "metrics-state.js"), "utf8");
const RENDER_JS = fs.readFileSync(path.join(STATIC, "pages", "metrics-render.js"), "utf8");
const CSS = fs.readFileSync(path.join(STATIC, "pages", "metrics.css"), "utf8");
const SHELL_JS = fs.readFileSync(path.join(STATIC, "modules", "app-shell.js"), "utf8");
const UI_JS = fs.readFileSync(path.join(STATIC, "modules", "app-ui.js"), "utf8");

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log("  ✓ " + msg);
  else { failures++; console.error("  ✗ " + msg); }
}

/* ---------------- part 1: static structure + registration ---------------- */
function staticTests() {
  console.log("static structure (metrics.html + registration)\n");

  // house page skeleton: shell mounts + shared assets in load order
  assert(/<aside class="sidebar" id="sidebar">/.test(HTML), "sidebar shell mount");
  assert(/<header class="topbar" id="topbar">/.test(HTML), "topbar shell mount");
  assert(/styles\/tokens\.css/.test(HTML) && /styles\/shell\.css/.test(HTML),
    "token + shell stylesheets loaded");
  const order = ["modules/app-state.js", "modules/app-shell.js", "app.js", "data.js",
    "pages/metrics-state.js", "pages/metrics-render.js"];
  let last = -1, ordered = true;
  order.forEach((f) => {
    const at = HTML.indexOf('src="/assets/' + f + '"');
    if (at < 0 || at < last) ordered = false;
    last = at;
  });
  assert(ordered, "shared modules then metrics page modules, in browser load order");
  assert(/data-days="7"/.test(HTML) && /data-days="30"/.test(HTML) && /id="mxRange"/.test(HTML),
    "7/30-day range toggle present (aut/seg idiom)");
  assert(/id="mxBody"/.test(HTML), "single payload-driven #mxBody mount");
  assert(/pages\/metrics\.css/.test(HTML), "page stylesheet loaded");
  assert(!/cdn|unpkg|jsdelivr|chart\.js|d3\./i.test(HTML), "no external chart libs");

  // registration: nav entry + icon everywhere pages are enumerated
  assert(/href: withCid\("\/metrics"\), ico: "metrics", label: "Metrics"/.test(SHELL_JS),
    "app-shell nav registers the Metrics entry (cid-carrying, like every in-project link)");
  assert(/metrics: '<path/.test(UI_JS), "app-ui icon set carries the metrics glyph");

  // chart CSS: token-driven (theme safe), bar mark specs
  assert(!/#[0-9a-fA-F]{3,8}\b/.test(CSS), "metrics.css uses tokens only (no hardcoded colors)");
  assert(/max-width: 24px/.test(CSS), "sparkline columns cap at 24px (house mark spec)");
  assert(/border-radius: 4px 4px 0 0/.test(CSS), "bars round the data-end, square at baseline");
  assert(/--w/.test(CSS) && /accent-soft/.test(CSS),
    "cost-proportion bar is pure CSS via --w on the soft accent");
}

/* ---------------- part 2: behavior (pages/metrics-state.js) -------------- */
function boot() {
  const sandbox = { window: {}, console };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(STATE_JS, sandbox, { filename: "metrics-state.js" });
  return sandbox.window.OrchaMetrics;
}

const FIXTURE = {
  container_id: "c-1", days: 7,
  totals: { runs: 6, sandbox_seconds: 8100, est_cost_usd: 3.5, tokens_in: 1200,
    tokens_out: 45000, runs_with_cost: 4, tasks_completed: 5, tasks_verified: 3 },
  per_agent: [
    { agent_id: "a-1", alias: "Spendy", model: "claude-sonnet-4-5", runs: 4, ok_runs: 3,
      failed_runs: 1, sandbox_seconds: 8100, est_cost_usd: 3.0, tokens_in: 1000,
      tokens_out: 40000, last_active: "2026-07-31T01:00:00+00:00" },
    { agent_id: "a-2", alias: "Cheap", model: null, runs: 2, ok_runs: 2,
      failed_runs: 0, sandbox_seconds: 0, est_cost_usd: 0.5, tokens_in: 200,
      tokens_out: 5000, last_active: "2026-07-30T01:00:00+00:00" },
  ],
  daily: [
    { date: "2026-07-25", runs: 0, est_cost_usd: 0, sandbox_seconds: 0 },
    { date: "2026-07-26", runs: 2, est_cost_usd: 1.0, sandbox_seconds: 100 },
    { date: "2026-07-27", runs: 0, est_cost_usd: 0, sandbox_seconds: 0 },
    { date: "2026-07-28", runs: 0, est_cost_usd: 0, sandbox_seconds: 0 },
    { date: "2026-07-29", runs: 0, est_cost_usd: 0, sandbox_seconds: 0 },
    { date: "2026-07-30", runs: 0, est_cost_usd: 0, sandbox_seconds: 0 },
    { date: "2026-07-31", runs: 4, est_cost_usd: 2.5, sandbox_seconds: 8000 },
  ],
};

function behaviorTests() {
  console.log("\nbehavior (pages/metrics-state.js render from a fixture payload)\n");
  const M = boot();
  assert(!!M, "metrics-state.js exposes window.OrchaMetrics standalone (no app.js needed)");

  // formatters
  assert(M.fmtUsd(3.5) === "$3.50" && M.fmtUsd(0.0042) === "$0.0042" && M.fmtUsd(0) === "$0.00",
    "fmtUsd: cents for normal figures, 4dp for sub-cent, $0.00 for zero");
  assert(M.fmtTokens(999) === "999" && M.fmtTokens(45000) === "45K" && M.fmtTokens(1200000) === "1.2M",
    "fmtTokens compacts to K/M");
  assert(M.fmtDuration(8100) === "2h 15m" && M.fmtDuration(45) === "45s" && M.fmtDuration(0) === "0s",
    "fmtDuration humanizes seconds");
  assert(M.costCaption(FIXTURE.totals) === "estimated · 4 of 6 runs reported cost",
    "the honest N-of-M cost caption");

  // stat cards
  const cards = M.statCardsHtml(FIXTURE);
  assert(cards.includes("$3.50") && cards.includes("estimated · 4 of 6 runs reported cost"),
    "cost card carries the total + the N-of-M caption");
  assert(/>6</.test(cards) && cards.includes("2h 15m"),
    "runs + humanized sandbox compute cards");
  assert(cards.includes("5 done") && cards.includes("3 human-verified"),
    "tasks card shows completed and verified");

  // per-agent table
  const tbl = M.agentTableHtml(FIXTURE);
  const rows = tbl.split("<tr").slice(2);              // drop thead row
  assert(rows.length === 2 && rows[0].includes("Spendy") && rows[1].includes("Cheap"),
    "one row per agent, payload (cost-desc) order preserved");
  assert(rows[0].includes('class="tag model"') && rows[0].includes("claude-sonnet-4-5"),
    "model rides the house .tag.model chip");
  assert(rows[0].includes("3 ok") && rows[0].includes("1 failed"),
    "runs cell splits ok/failed");
  assert(rows[1].includes("2 ok") && !rows[1].includes("failed"),
    "clean agent shows no failed fragment");
  assert(rows[0].includes("--w:100%") && rows[1].includes("--w:17%"),
    "cost-proportion bars scale to the max agent cost");
  assert(tbl.includes("$3.00") && tbl.includes("$0.50") && tbl.includes("1K in · 40K out"),
    "cost + compact token figures per row");

  // daily sparkline
  const spark = M.dailyBarsHtml(FIXTURE);
  assert((spark.match(/mx-col/g) || []).length === 7, "one column per day of the window");
  assert((spark.match(/mx-bar/g) || []).length === 2, "zero days render as honest empty columns");
  assert(spark.includes('height:100%') && spark.includes('height:50%'),
    "bar heights proportional to the max day");
  assert(spark.includes("Jul 26 · 2 runs · $1.00"), "per-column tooltip: date, runs, cost");
  assert(spark.includes("Jul 25") && spark.includes("Jul 31"),
    "x-extent labels bracket the window");

  // whole body + empty state
  const body = M.bodyHtml(FIXTURE, { days: 7 });
  assert(body.includes("mx-cards") && body.includes("Daily activity")
    && body.includes("Cost &amp; activity by agent"), "bodyHtml composes cards + both cards");
  const empty = M.bodyHtml({ days: 30, totals: { runs: 0 }, per_agent: [], daily: [] }, { days: 30 });
  assert(empty.includes("No agent runs in the last 30 days"),
    "zero-run window renders the honest empty state");
  assert(M.bodyHtml(null, {}).includes("Loading"), "no payload yet renders Loading");
  assert(M.bodyHtml(null, { error: "HTTP 500" }).includes("HTTP 500"),
    "fetch failure surfaces the error, not a blank page");

  // escaping: attacker-controlled alias/model never lands unescaped
  const hostile = JSON.parse(JSON.stringify(FIXTURE));
  hostile.per_agent[0].alias = '<img src=x onerror=alert(1)>';
  hostile.per_agent[0].model = '<script>bad()</script>';
  const out = M.agentTableHtml(hostile);
  assert(!out.includes("<img src=x") && !out.includes("<script>bad()"),
    "alias and model are HTML-escaped");

  // render glue sanity: metrics-render fetches the endpoint and patches #mxBody
  assert(/\/metrics\?days=/.test(RENDER_JS) && /mxBody/.test(RENDER_JS)
    && /mountShell\("metrics"/.test(RENDER_JS),
    "metrics-render.js wires fetch → bodyHtml patch + shell mount");
}

staticTests();
behaviorTests();

if (failures) { console.error("\n" + failures + " failure(s)"); process.exit(1); }
console.log("\nall metrics page tests passed");
