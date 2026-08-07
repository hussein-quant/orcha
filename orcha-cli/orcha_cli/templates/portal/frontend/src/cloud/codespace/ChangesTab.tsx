/**
 * Changes tab — "what have agents changed that isn't committed yet" (the
 * flagship working-tree view, docs/orcha-cloud-local-run.md addendum). Lists
 * every dirty file (status-lettered rows + per-file +/- counts, summary
 * header); clicking a row asks the parent (CodeSpacePage) to open that
 * file's unified diff in the center pane. Polls
 * code_workingtree_routes.get_worktree_changes every ~5s while mounted (the
 * tab is only mounted while active — ThreadRail unmounts non-active tab
 * bodies — so "while the tab is active" falls out of normal React lifecycle,
 * no visibility bookkeeping needed). Reports the dirty count back to
 * ThreadRail (onDirtyCountChange) so the tab-strip badge can render it —
 * that badge is therefore only known once the Changes tab has been opened
 * at least once in this mount (no background poll from other tabs); an
 * acceptable v1 tradeoff given the endpoint is only cheap to poll while the
 * tab a human is actually looking at.
 */
import { useEffect, useRef, useState } from "react";
import { fetchWorktreeChanges, type WorktreeChangedFile, type WorktreeChangesPayload } from "./worktreeApi";

const POLL_MS = 5000;

export interface ChangesTabProps {
  cid: string;
  selectedPath?: string | null;
  onOpenChange: (path: string) => void;
  // Reports the current dirty-file count on every poll (including the very
  // first fetch) so the parent (ThreadRail) can render a tab-strip badge
  // without duplicating the fetch/poll itself. Optional — a caller that
  // doesn't care about the badge (e.g. a test mounting ChangesTab standalone)
  // simply omits it.
  onDirtyCountChange?: (count: number) => void;
}

function statusLabel(status: WorktreeChangedFile["status"]): string {
  switch (status) {
    case "M": return "Modified";
    case "A": return "Added";
    case "D": return "Deleted";
    case "R": return "Renamed";
    default: return "Untracked";
  }
}

function CountBadge({ additions, deletions }: { additions: number | null; deletions: number | null }) {
  if (additions == null && deletions == null) return <span className="muted cs-wt-bin">binary</span>;
  return (
    <>
      {additions ? <span className="a">+{additions}</span> : null}
      {deletions ? <span className="d">−{deletions}</span> : null}
    </>
  );
}

export function ChangesTab({ cid, selectedPath, onOpenChange, onDirtyCountChange }: ChangesTabProps) {
  const [payload, setPayload] = useState<WorktreeChangesPayload | null>(null);
  const token = useRef(0);
  const onDirtyCountChangeRef = useRef(onDirtyCountChange);
  onDirtyCountChangeRef.current = onDirtyCountChange;

  useEffect(() => {
    let cancelled = false;
    const myToken = ++token.current;
    const poll = () => {
      fetchWorktreeChanges(cid).then((data) => {
        if (cancelled || myToken !== token.current) return;
        setPayload(data);
        onDirtyCountChangeRef.current?.(data.available ? (data.files ?? []).length : 0);
      });
    };
    poll();
    const id = window.setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [cid]);

  if (!payload) {
    return <div className="none" style={{ padding: 10 }}>Loading working-tree changes…</div>;
  }

  if (!payload.available) {
    if (payload.reason === "github_source") {
      return (
        <div className="none" style={{ padding: 10 }}>
          Working-tree changes need a local repository — this project is using a
          connected GitHub repo as its code source.
        </div>
      );
    }
    return <div className="none" style={{ padding: 10 }}>{payload.detail || "Working-tree changes are unavailable."}</div>;
  }

  const files = payload.files ?? [];
  const summary = payload.summary ?? { files: 0, additions: 0, deletions: 0 };

  if (!files.length) {
    return <div className="none" style={{ padding: 10 }}>Working tree clean — everything is committed.</div>;
  }

  return (
    <div className="cs-changes">
      <div className="cs-changes-summary">
        <span>{summary.files} file{summary.files === 1 ? "" : "s"} changed</span>
        <span className="a">+{summary.additions}</span>
        <span className="d">−{summary.deletions}</span>
      </div>
      <div className="cs-changes-list">
        {files.map((f) => (
          <div
            key={f.path}
            className={"cs-changes-row" + (f.path === selectedPath ? " on" : "")}
            onClick={() => onOpenChange(f.path)}
            title={statusLabel(f.status)}
          >
            <span className={"cs-changes-badge " + f.status.replace("?", "u")}>{f.status}</span>
            <span className="cs-changes-path mono">{f.path}</span>
            <span className="grow" />
            <CountBadge additions={f.additions} deletions={f.deletions} />
          </div>
        ))}
      </div>
    </div>
  );
}
