/**
 * Workflows home (like Verdikt's RecipesBoard): a row per workflow with its steps thread, what is
 * waiting for you, the current stage and the last activity. Stalled ones sort first with a quiet
 * amber marker; finished ones fold away. Empty: the teaching scene and the template gallery.
 */
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useActingAuthority, useSnapshot } from "../../state/SnapshotProvider";
import { ChevronDown, ChevronUp, Clock, GitBranch, Layers, Plus, Rocket, TriangleAlert, Workflow } from "./icons";
import { ago, flowApi, PLATFORM_WORD, type Board as BoardData, type BoardRow, type Cycle, type TemplateSummary } from "./flowApi";
import { Gallery } from "./Gallery";
import { TeachScene, Thread } from "./kit";

export function flowHref(path: string, cid: string | null, extra?: Record<string, string>) {
  const q = new URLSearchParams({ ...(cid ? { cid } : {}), ...(extra ?? {}) });
  return `${path}?${q}`;
}

function Row({ row, i, cid }: { row: BoardRow; i: number; cid: string }) {
  const Icon = row.template?.key === "mobile_app_release" ? Rocket : row.template ? Layers : Workflow;
  const kind = row.template?.key === "mobile_app_release" ? "gate" : "agent";
  const state = row.status === "completed" ? "Finished" : row.status === "cancelled" ? "Stopped" : row.status === "paused" ? "Paused" : !row.launch_enabled ? "Draft" : row.stage ?? "Running";
  return (
    <li>
      <Link to={flowHref(`/workflows/${encodeURIComponent(row.id)}`, cid)} className="fl-row" data-kind={kind} data-stalled={!!row.stalled} style={{ ["--i" as string]: i }} data-workflow-row={row.id}>
        <span className="fl-row-icon" aria-hidden="true"><Icon size={18} /></span>
        <span className="fl-row-main">
          <span className="fl-row-title">
            <span>{row.title}</span>
            {row.dry_run ? <span className="fl-chip" data-tone="info">Dry run</span> : null}
            {row.stalled ? <span className="fl-chip" data-tone="warn"><TriangleAlert size={12} aria-hidden="true" />Stalled {Math.floor(row.stalled.days)} days</span> : null}
          </span>
          <Thread dots={row.thread} label={`${row.done} of ${row.total} steps done`} />
          <span className="fl-row-meta">
            {row.template ? <span>{row.template.name}</span> : <span>Hand-built</span>}
            <span>·</span><span>{state}</span>
            <span>·</span><span className="fl-mono">{row.done}/{row.total}</span>
          </span>
        </span>
        <span className="fl-row-side">
          {row.waiting_for_you > 0 ? <span className="fl-waiting">{row.waiting_for_you} waiting for you</span> : null}
          <span><Clock size={12} aria-hidden="true" /> {ago(row.last_activity ?? row.created_at)}</span>
        </span>
      </Link>
    </li>
  );
}

/** A release cycle on the home: its branch, its tickets in one line, and what waits for you. */
function CycleCard({ c, cid, i }: { c: Cycle; cid: string; i: number }) {
  const open = c.state === "open";
  return (
    <li>
      <Link to={flowHref("/workflows/cycle", cid, { cycle: c.id })} className="fl-row fl-cy-card" data-kind="gate" style={{ ["--i" as string]: i }} data-cycle={c.id}>
        <span className="fl-row-icon" aria-hidden="true"><GitBranch size={18} /></span>
        <span className="fl-row-main">
          <span className="fl-row-title">
            <span>Release {c.version}</span>
            {c.dry_run ? <span className="fl-chip" data-tone="info">Dry run</span> : null}
            <span className="fl-chip" data-tone={open ? "accent" : "muted"}>{open ? "Collecting" : "Releasing"}</span>
          </span>
          <span className="fl-cy-bar" role="img" aria-label={`${c.counts.merged} of ${c.counts.total} tickets in the branch`}>
            <i style={{ width: `${c.counts.total ? (c.counts.checked / c.counts.total) * 100 : 0}%` }} data-tone="ok" />
            <i style={{ width: `${c.counts.total ? ((c.counts.merged - c.counts.checked) / c.counts.total) * 100 : 0}%` }} data-tone="merged" />
          </span>
          <span className="fl-row-meta">
            <span className="fl-mono">{c.branch}</span><span>·</span>
            <span>{c.counts.total} {c.counts.total === 1 ? "ticket" : "tickets"}</span><span>·</span>
            <span>{c.counts.merged} in the branch</span>
            {c.cut.platforms.length ? <><span>·</span><span>{c.cut.platforms.map((p) => PLATFORM_WORD[p]).join(", ")}</span></> : null}
          </span>
        </span>
        <span className="fl-row-side">
          {c.counts.needs_you > 0 ? <span className="fl-waiting">{c.counts.needs_you} waiting for you</span> : null}
          <span><Clock size={12} aria-hidden="true" /> {ago(c.created_at)}</span>
        </span>
      </Link>
    </li>
  );
}

export function Board() {
  const { cid, bump, connection } = useSnapshot();
  const authority = useActingAuthority();
  const actor = authority.human?.id ?? null;
  const navigate = useNavigate();
  const [data, setData] = useState<BoardData | null>(null);
  const [templates, setTemplates] = useState<TemplateSummary[] | null>(null);
  const [error, setError] = useState("");
  const [showDone, setShowDone] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    if (!cid) return;
    const mine = ++seq.current;
    const ctrl = new AbortController();
    flowApi.board(cid, actor, showDone, ctrl.signal)
      .then((b) => { if (mine === seq.current) { setData(b); setError(""); } })
      .catch((e: Error) => { if (e.name !== "AbortError" && mine === seq.current) setError(e.message); });
    return () => ctrl.abort();
  }, [cid, actor, showDone, Math.floor(bump / (connection === "live" ? 5 : 2))]);

  useEffect(() => {
    if (!cid) return;
    const ctrl = new AbortController();
    flowApi.templates(cid, actor, ctrl.signal).then((t) => setTemplates(t.templates)).catch(() => setTemplates([]));
    return () => ctrl.abort();
  }, [cid, actor]);

  if (!cid) return <div className="fl-wrap"><p className="fl-muted">Choose a project to see its workflows.</p></div>;
  const rows = data?.workflows ?? [];
  const active = rows.filter((r) => !r.finished);
  const done = rows.filter((r) => r.finished);
  const empty = data && !active.length && !data.finished_count && !data.cycles?.length;
  const pick = (key: string) => navigate(flowHref("/workflows/new", cid, { template: key, ...(templates?.find((t) => t.key === key)?.has_inventory ? { home: "1" } : {}) }));

  return (
    <div className="fl-wrap">
      <header className="fl-head">
        <div>
          <h1 className="fl-h1">Workflows</h1>
          <p className="fl-sub">{active.length ? `${active.length} running · ${rows.reduce((n, r) => n + r.waiting_for_you, 0)} waiting for you` : "Releases and other runs, step by step."}</p>
        </div>
        <div className="fl-head-actions">
          <Link className="fl-btn" data-variant="ghost" to={flowHref("/workflows", cid, { classic: "1" })}>Classic list</Link>
          <Link className="fl-btn" to={flowHref("/workflows/cycle", cid)} data-release-cycle><GitBranch size={15} />Release cycle</Link>
          <button type="button" className="fl-btn" data-variant="primary" onClick={() => navigate(flowHref("/workflows/new", cid))}><Plus size={15} />New workflow</button>
        </div>
      </header>
      {error ? <p className="fl-problem" role="alert">{error}</p> : null}
      {!data && !error ? <p className="fl-muted" aria-busy="true">Loading workflows…</p> : null}
      {data?.cycles?.length ? (
        <section className="fl-board" aria-label="Release cycles">
          <ul className="fl-rows">{data.cycles.map((c, i) => <CycleCard key={c.id} c={c} cid={cid} i={i} />)}</ul>
        </section>
      ) : null}
      {active.length ? (
        <section className="fl-board" aria-label="Running workflows">
          <ul className="fl-rows">{active.map((r, i) => <Row key={r.id} row={r} i={i} cid={cid} />)}</ul>
        </section>
      ) : null}
      {data && data.finished_count > 0 ? (
        <section className="fl-board" aria-label="Finished workflows">
          <div className="fl-fold">
            <button type="button" className="fl-btn" data-variant="ghost" aria-expanded={showDone} onClick={() => setShowDone((v) => !v)}>
              {showDone ? <ChevronUp size={14} /> : <ChevronDown size={14} />}{data.finished_count} finished
            </button>
          </div>
          {showDone ? <ul className="fl-rows">{done.map((r, i) => <Row key={r.id} row={r} i={i} cid={cid} />)}</ul> : null}
        </section>
      ) : null}
      {empty || (data && !active.length) ? (
        <section aria-label="Start a workflow" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {empty ? <TeachScene /> : null}
          <h2 className="fl-h2">Start from a template</h2>
          {templates ? <Gallery templates={templates} onPick={pick} onBlank={() => navigate(flowHref("/workflows/new", cid, { blank: "1" }))}
            onImport={async (json) => { const s = await flowApi.importTemplate(cid, actor, json); pick(s.key); }} /> : null}
        </section>
      ) : null}
    </div>
  );
}
