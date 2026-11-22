/**
 * Bring in existing tasks: every task in the project, not a five-result search. The list comes
 * from the project snapshot the page already has (live). Who can join follows the classic picker's
 * rules exactly; Orcha's preview still checks membership, workers and the whole connected
 * dependency group before anything is saved.
 */
import { useMemo, useState } from "react";
import { useSnapshot } from "../../state/SnapshotProvider";
import type { ImportChoice } from "../workflows/WorkflowImport";
import { Check, ChevronDown, ChevronUp, Search, X } from "./icons";

type Row = ImportChoice & { assignee: string | null; reason: string | null; note: string };

const STATUS_WORD: Record<string, string> = {
  pending: "To do", ready: "Ready", not_ready: "Not ready", blocked: "Blocked", in_progress: "In progress",
  needs_verification: "Ready to verify", completed: "Done", cancelled: "Cancelled",
};
const STATUS_TONE: Record<string, string> = { completed: "ok", needs_verification: "info", in_progress: "accent", cancelled: "muted", blocked: "warn" };

/** The classic picker's rules, word for word. */
export function joinReason(task: Pick<ImportChoice, "status" | "is_root" | "workflow_id">): string | null {
  if (task.workflow_id) return "Already in a workflow";
  if (task.is_root) return "Project objectives can't join a workflow";
  if (["in_progress", "needs_verification"].includes(task.status)) return "Wait for its current work and review to end";
  if (task.status === "cancelled") return "Retry it before bringing it in";
  return null;
}

export function TaskShelf({ selected, onChange, onClose, onSelectedChoices }: {
  selected: string[]; onChange: (ids: string[]) => void; onClose: () => void; onSelectedChoices: (rows: ImportChoice[]) => void;
}) {
  const { snap } = useSnapshot();
  const [q, setQ] = useState("");
  const [showBlocked, setShowBlocked] = useState(false);
  const alias = (name: string | null | undefined) => (name ? snap?.agents.find((a) => a.alias === name || a.id === name)?.alias ?? name : null);
  const rows: Row[] = useMemo(() => (snap?.tasks ?? []).map((t) => {
    const choice: ImportChoice = { id: t.id, title: t.title, status: t.status, is_root: !!t.is_root, workflow_id: t.workflow_id ?? null };
    const reason = joinReason(choice);
    return { ...choice, assignee: alias((t as { assignee?: string | null }).assignee), reason,
      note: reason ?? (t.status === "completed" ? "Done: you'll review its saved result" : "Stays held until you release it") };
  }).sort((a, b) => a.title.localeCompare(b.title)), [snap?.tasks, snap?.agents]);

  const term = q.trim().toLowerCase();
  const match = (r: Row) => !term || r.title.toLowerCase().includes(term) || (r.assignee ?? "").toLowerCase().includes(term);
  const chosen = new Set(selected);
  const open = rows.filter((r) => !r.reason && r.status !== "completed" && match(r));
  const done = rows.filter((r) => !r.reason && r.status === "completed" && match(r));
  const blocked = rows.filter((r) => r.reason && !chosen.has(r.id) && match(r));
  const picked = rows.filter((r) => chosen.has(r.id));

  const set = (ids: string[]) => {
    onChange(ids);
    onSelectedChoices(ids.map((id) => rows.find((r) => r.id === id)).filter((r): r is Row => !!r));
  };
  const toggle = (r: Row) => set(chosen.has(r.id) ? selected.filter((id) => id !== r.id) : [...selected, r.id]);
  const allIn = (list: Row[]) => list.length > 0 && list.every((r) => chosen.has(r.id));
  const toggleAll = (list: Row[]) => set(allIn(list) ? selected.filter((id) => !list.some((r) => r.id === id)) : [...new Set([...selected, ...list.map((r) => r.id)])]);

  const row = (r: Row, i: number) => {
    const on = chosen.has(r.id);
    return (
      <li key={r.id} style={{ ["--i" as string]: Math.min(i, 12) }}>
        <button type="button" className="fl-shelf-row" role="checkbox" aria-checked={on} disabled={!on && !!r.reason} onClick={() => toggle(r)} data-task={r.id}>
          <span className="fl-shelf-box" aria-hidden="true">{on ? <Check size={12} strokeWidth={3} /> : null}</span>
          <span className="fl-shelf-main">
            <span className="fl-shelf-title">{r.title}</span>
            <span className="fl-shelf-note">{r.note}</span>
          </span>
          {r.assignee ? <span className="fl-shelf-who">{r.assignee}</span> : null}
          <span className="fl-chip" data-tone={STATUS_TONE[r.status] ?? "muted"}>{STATUS_WORD[r.status] ?? r.status.replace(/_/g, " ")}</span>
        </button>
      </li>
    );
  };
  const group = (title: string, list: Row[], selectable = true) => list.length ? (
    <section className="fl-shelf-group" aria-label={title}>
      <div className="fl-shelf-head">
        <span className="fl-section-title">{title} <span className="fl-mono fl-muted">{list.length}</span></span>
        {selectable && list.length > 1 ? <button type="button" className="fl-linkbtn" onClick={() => toggleAll(list)}>{allIn(list) ? "Clear these" : `Select all ${list.length}`}</button> : null}
      </div>
      <ul className="fl-shelf-list">{list.map(row)}</ul>
    </section>
  ) : null;

  return (
    <div className="fl-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="fl-dialog fl fl-shelf" role="dialog" aria-modal="true" aria-labelledby="fl-shelf-title" onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}>
        <div className="fl-head">
          <div>
            <h2 id="fl-shelf-title" className="fl-h2">Bring in existing tasks</h2>
            <p className="fl-sub">{rows.length} tasks in this project. They join as steps; Orcha checks each one again before saving.</p>
          </div>
          <button type="button" className="fl-btn" data-variant="ghost" onClick={onClose} aria-label="Close"><X size={15} /></button>
        </div>
        <label className="fl-shelf-search">
          <Search size={14} aria-hidden="true" />
          <input autoFocus type="search" placeholder="Filter by name or agent" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter tasks"
            autoComplete="off" data-1p-ignore data-lpignore="true" />
        </label>
        <div className="fl-shelf-body">
          {group("Selected", picked, false)}
          {group("Can join", open.filter((r) => !chosen.has(r.id)))}
          {group("Finished", done.filter((r) => !chosen.has(r.id)))}
          {!open.length && !done.length && !picked.length ? <p className="fl-muted" style={{ margin: "6px 2px" }}>{term ? "Nothing that can join matches." : "No task can join right now."}</p> : null}
          {blocked.length ? (
            <section className="fl-shelf-group">
              <button type="button" className="fl-shelf-fold" aria-expanded={showBlocked || !!term} onClick={() => setShowBlocked((s) => !s)}>
                {showBlocked || term ? <ChevronUp size={13} /> : <ChevronDown size={13} />}Can't join yet <span className="fl-mono fl-muted">{blocked.length}</span>
                <span className="fl-help">already in a workflow, under review, or cancelled</span>
              </button>
              {showBlocked || term ? <ul className="fl-shelf-list">{blocked.map(row)}</ul> : null}
            </section>
          ) : null}
        </div>
        <div className="fl-shelf-foot">
          <span className="fl-help" aria-live="polite">{selected.length ? `${selected.length} selected` : "Nothing selected"}</span>
          <div className="fl-head-actions">
            {selected.length ? <button type="button" className="fl-btn" data-variant="ghost" onClick={() => set([])}>Clear</button> : null}
            <button type="button" className="fl-btn" data-variant="primary" onClick={onClose}>{selected.length ? `Bring in ${selected.length}` : "Done"}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
