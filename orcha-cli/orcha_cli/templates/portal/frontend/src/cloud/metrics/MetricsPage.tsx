/**
 * Metrics page — React port of static/metrics.html + pages/metrics-state.js
 * (pure formatters/builders) + pages/metrics-render.js (fetch/patch glue).
 *
 * Data: GET /api/containers/{cid}/metrics?days=7|30 — the one aggregate
 * endpoint added for this page (container_metrics_routes). Cadence: the shared
 * 3s snapshot poll keeps the shell chrome live; the AGGREGATE endpoint is
 * heavier and changes slowly, so it refreshes on load, on range toggle, and on
 * a 60s timer — never on the 3s tick.
 *
 * Chart discipline (dataviz): single-series magnitude everywhere → one hue (the
 * token accent), no legend, text in text tokens with tabular-nums only inside
 * table columns, bars ≤24px with a 4px rounded data-end and a square baseline,
 * 2px surface gaps, honest zero bars.
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { Shell } from "../../shell/Shell";
import { Avatar } from "../../components/ui";
import { useSnapshot } from "../../state/SnapshotProvider";
import "./metrics.css";

/* ---- payload shape (container_metrics_routes) --------------------------- */
export interface MxTotals {
  runs: number;
  runs_with_cost: number;
  est_cost_usd: number;
  sandbox_seconds: number;
  tokens_in: number;
  tokens_out: number;
  tasks_completed: number;
  tasks_verified: number;
}
export interface MxDay { date: string; runs: number; est_cost_usd: number }
export interface MxAgent {
  agent_id: string;
  alias: string | null;
  model: string | null;
  runs: number;
  ok_runs: number;
  failed_runs: number;
  sandbox_seconds: number;
  tokens_in: number;
  tokens_out: number;
  est_cost_usd: number;
}
export interface MxPayload {
  days: number;
  totals: MxTotals;
  daily: MxDay[];
  per_agent: MxAgent[];
}

/* ---- formatters (metrics-state.js, verbatim behavior) ------------------- */
export function fmtUsd(n: unknown): string {
  const v = Number(n) || 0;
  if (v !== 0 && v < 0.01) return "$" + v.toFixed(4);
  if (v < 1000) return "$" + v.toFixed(2);
  return "$" + Math.round(v).toLocaleString("en-US");
}
export function fmtTokens(n: unknown): string {
  const v = Number(n) || 0;
  if (v < 1000) return String(v);
  if (v < 1e6) return (v / 1e3).toFixed(1).replace(/\.0$/, "") + "K";
  return (v / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
}
export function fmtDuration(secs: unknown): string {
  let s0 = Math.round(Number(secs) || 0);
  if (s0 <= 0) return "0s";
  const d = Math.floor(s0 / 86400), h = Math.floor((s0 % 86400) / 3600);
  const m = Math.floor((s0 % 3600) / 60), s = s0 % 60;
  if (d) return d + "d " + h + "h";
  if (h) return h + "h " + m + "m";
  if (m) return m + "m " + (s ? s + "s" : "");
  return s + "s";
}
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function fmtDay(iso: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || "");
  return m ? MONTHS[Number(m[2]) - 1] + " " + Number(m[3]) : String(iso || "");
}
export function costCaption(totals: MxTotals): string {
  const n = totals.runs_with_cost || 0, m = totals.runs || 0;
  if (!m) return "no runs in this window";
  return "estimated · " + n + " of " + m + " run" + (m === 1 ? "" : "s") + " reported cost";
}

/* ---- stat cards (KPI row) ------------------------------------------------ */
function StatCards({ d }: { d: MxPayload }) {
  const t = d.totals;
  const tile = (label: string, value: string, sub: string) => (
    <div className="card mx-tile">
      <div className="l">{label}</div>
      <div className="v">{value}</div>
      <div className="s">{sub}</div>
    </div>
  );
  return (
    <>
      {tile("Est. cost", fmtUsd(t.est_cost_usd), costCaption(t))}
      {tile("Runs", String(t.runs), "last " + String(d.days) + " days")}
      {tile("Sandbox compute", fmtDuration(t.sandbox_seconds), "container wall-clock")}
      {tile("Tasks", String(t.tasks_completed) + " done", String(t.tasks_verified) + " human-verified")}
    </>
  );
}

/* ---- daily activity — CSS column sparkline (one series: runs) ----------- */
function DailyBars({ d }: { d: MxPayload }) {
  const days = d.daily || [];
  const max = days.reduce((m, x) => Math.max(m, x.runs), 0);
  const first = days.length ? fmtDay(days[0].date) : "";
  const last = days.length ? fmtDay(days[days.length - 1].date) : "";
  return (
    <>
      <div className="mx-spark" role="img" aria-label={`Runs per day over the last ${d.days} days`}>
        {days.map((x, i) => {
          const pct = max ? Math.round((x.runs / max) * 100) : 0;
          const tip = fmtDay(x.date) + " · " + x.runs + " run" + (x.runs === 1 ? "" : "s")
            + " · " + fmtUsd(x.est_cost_usd);
          return (
            <div key={i} className="mx-col" title={tip}>
              {x.runs ? <div className="mx-bar" style={{ height: pct + "%" }} /> : null}
            </div>
          );
        })}
      </div>
      <div className="mx-spark-x"><span>{first}</span><span>{last}</span></div>
    </>
  );
}

/* ---- per-agent table ----------------------------------------------------- */
function AgentTable({ d }: { d: MxPayload }) {
  const rows = d.per_agent || [];
  const maxCost = rows.reduce((m, a) => Math.max(m, a.est_cost_usd), 0);
  return (
    <table className="tbl mx-tbl">
      <thead>
        <tr><th>Agent</th><th>Model</th><th>Runs</th><th>Compute</th><th>Tokens</th><th>Est. cost</th></tr>
      </thead>
      <tbody>
        {rows.map((a) => {
          const pct = maxCost ? Math.max(2, Math.round((a.est_cost_usd / maxCost) * 100)) : 0;
          return (
            <tr key={a.agent_id} data-agent={a.agent_id}>
              <td>
                <a className="mx-agent" href={"/agents?agent=" + encodeURIComponent(a.alias || "")}>
                  <Avatar alias={a.alias} kind="ai" size="sm" />
                  <span className="nm">{a.alias || "?"}</span>
                </a>
              </td>
              <td>{a.model ? <span className="tag model">{a.model}</span> : <span className="mx-none">—</span>}</td>
              <td className="tnum">
                {a.runs}
                <span className="mx-sub"> {a.ok_runs} ok{a.failed_runs ? <> · <span className="bad">{a.failed_runs} failed</span></> : null}</span>
              </td>
              <td className="tnum">{fmtDuration(a.sandbox_seconds)}</td>
              <td className="tnum">{fmtTokens(a.tokens_in)} in · {fmtTokens(a.tokens_out)} out</td>
              <td className="mx-cost tnum">
                <span className="mx-costbar" style={{ "--w": pct + "%" } as CSSProperties} />
                <span className="v">{fmtUsd(a.est_cost_usd)}</span>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/* ---- honest empty state --------------------------------------------------- */
function EmptyState({ days }: { days: number }) {
  return (
    <div className="card mx-empty">
      <div className="t1">No agent runs in the last {days} days</div>
      <div className="t2">Metrics fill in as agents wake and work — cost and token figures
        come from each run's recorded usage, so a quiet window is honestly empty
        rather than estimated.</div>
    </div>
  );
}

/* ---- whole-body composition (metrics-state.js bodyHtml) ------------------- */
function MxBody({ payload, days, error }: { payload: MxPayload | null; days: number; error: string | null }) {
  if (error) {
    return (
      <div className="card mx-empty"><div className="t1">Couldn’t load metrics</div>
        <div className="t2">{error}</div></div>
    );
  }
  if (!payload) return <div className="card mx-empty"><div className="t2">Loading…</div></div>;
  if (!payload.totals || !payload.totals.runs) return <EmptyState days={payload.days ?? days} />;
  return (
    <>
      <div className="mx-cards"><StatCards d={payload} /></div>
      <div className="card">
        <div className="card-h"><h2>Daily activity</h2>
          <span className="count">{payload.totals.runs} runs</span></div>
        <div className="card-b"><DailyBars d={payload} /></div>
      </div>
      <div className="card">
        <div className="card-h"><h2>Cost &amp; activity by agent</h2>
          <span className="count">{costCaption(payload.totals)}</span></div>
        <div className="card-b flush" style={{ overflowX: "auto" }}>
          <AgentTable d={payload} />
        </div>
      </div>
    </>
  );
}

export function MetricsPage() {
  const { snap, cid } = useSnapshot();
  const [days, setDays] = useState(7);
  const [payload, setPayload] = useState<MxPayload | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const loading = useRef(false);
  const havePayload = useRef(false);
  havePayload.current = payload != null;

  const load = useCallback(async (id: string, d: number) => {
    if (loading.current) return;
    loading.current = true;
    try {
      const r = await fetch("/api/containers/" + encodeURIComponent(id) + "/metrics?days=" + d);
      if (!r.ok) throw new Error("HTTP " + r.status);
      const data = (await r.json()) as MxPayload;
      setPayload(data);
      setLoadError(null);
    } catch (e) {
      // keep showing the last good payload; only surface the error cold
      if (!havePayload.current) setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      loading.current = false;
    }
  }, []);

  // load on cid arrival + range change; refresh on a 60s timer (never the 3s tick).
  useEffect(() => {
    if (!cid) return;
    void load(cid, days);
    const iv = setInterval(() => void load(cid, days), 60000);
    return () => clearInterval(iv);
  }, [cid, days, load]);

  const toggle = (next: number) => {
    if (!next || next === days) return;
    setDays(next);
    setPayload(null); // stale window — show Loading, not old numbers
    setLoadError(null);
  };

  return (
    <Shell page="metrics" title="Metrics" ctx={snap?.container?.name}>
      <div className="mx-wrap">
        <div className="mx-head">
          <div>
            <h1>Metrics</h1>
            <p>Usage and estimated spend per agent — runs, sandbox compute, tokens and cost,
              parsed from each run&rsquo;s recorded usage. Dollar figures are estimates: only runs
              whose worker reported cost contribute (the caption says how many did).</p>
          </div>
          <div className="grow" />
          <nav className="aut" id="mxRange" role="radiogroup" aria-label="Metrics window">
            {[7, 30].map((d) => (
              <span
                key={d}
                className={"seg" + (days === d ? " on" : "")}
                role="radio"
                tabIndex={0}
                aria-selected={days === d}
                data-days={d}
                onClick={() => toggle(d)}
              >
                {d} days
              </span>
            ))}
          </nav>
        </div>
        <div id="mxBody">
          <MxBody payload={payload} days={days} error={loadError} />
        </div>
      </div>
    </Shell>
  );
}
