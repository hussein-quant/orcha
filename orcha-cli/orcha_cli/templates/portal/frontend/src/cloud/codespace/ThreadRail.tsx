/**
 * The right rail: Threads (Phase 1, current-file scoped) / Live (Phase 2) /
 * Learn (Phase 4) / Outline (Phase 3) tabs. Threads-tab list polls on the
 * house 3s bump; anchor chips jump to lines, count badges optional via the
 * tree's fileBadge slot (CodeSpacePage wires that separately). Outline
 * (symbols/OutlineRail.tsx) is scoped to whatever file is currently open,
 * exactly like the Threads tab.
 */
import { useEffect, useRef, useState } from "react";
import { useSnapshot } from "../../state/SnapshotProvider";
import type { Agent } from "../../types";
import { fetchThreads } from "./codespaceApi";
import { anchorLabel, kindLabel, shortSha, type CodeThreadSummary } from "./codespaceTypes";
import { LearnTab } from "./LearnTab";
import { LivePanel } from "./LivePanel";
import { OutlineRail } from "./symbols/OutlineRail";
import { ThreadComposer } from "./ThreadComposer";
import { ThreadView } from "./ThreadView";

export type RailTab = "threads" | "live" | "learn" | "outline";

export interface ThreadRailProps {
  cid: string;
  // NOT named "ref" — that's a reserved JSX/React prop (element refs); see
  // RepoBrowser.tsx's identical convention/comment for `gitRef`.
  gitRef: string;
  path: string;
  agents: Agent[];
  tab: RailTab;
  onTabChange: (tab: RailTab) => void;
  // composer open state is driven by the code viewer's gutter click
  composerSelection: { start: number; end: number } | null;
  onComposerClose: () => void;
  onJumpToLine: (line: number) => void;
  onJumpToPinnedSha?: (sha: string) => void;
  openThreadId: string | null;
  onOpenThread: (id: string | null) => void;
  onThreadsLoaded?: (threads: CodeThreadSummary[]) => void;
  // Phase 2 raise-hand hands off a composer pre-tagged at a specific agent —
  // rendered in the Threads tab (same composer, no free @agent picker).
  raiseHand: { agentId: string; line: number } | null;
  onRaiseHandDone: () => void;
  // fired from the Live tab's patch-card "raise hand" button; the parent page
  // owns the raiseHand state (so it can also switch the rail to Threads).
  onRaiseHandRequested?: (agentId: string, line: number) => void;
}

export function ThreadRail({
  cid,
  gitRef,
  path,
  agents,
  tab,
  onTabChange,
  composerSelection,
  onComposerClose,
  onJumpToLine,
  onJumpToPinnedSha,
  openThreadId,
  onOpenThread,
  onThreadsLoaded,
  raiseHand,
  onRaiseHandDone,
  onRaiseHandRequested,
}: ThreadRailProps) {
  const { bump } = useSnapshot();
  const [threads, setThreads] = useState<CodeThreadSummary[]>([]);
  const token = useRef(0);

  useEffect(() => {
    if (!path) { setThreads([]); return; }
    const myToken = ++token.current;
    fetchThreads(cid, { ref: gitRef, path }).then((res) => {
      if (myToken !== token.current) return;
      if (res.ok) {
        setThreads(res.data.threads);
        onThreadsLoaded?.(res.data.threads);
      }
    });
    // house 3s bump — the rail's thread list rides the same poll cadence
    // every other mutation surface does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cid, gitRef, path, bump]);

  return (
    <aside className="cs-rail">
      <div className="cs-rail-tabs" role="tablist" aria-label="Code Space rail">
        <button type="button" role="tab" aria-selected={tab === "threads"} className={"cs-rail-tab" + (tab === "threads" ? " on" : "")} onClick={() => onTabChange("threads")}>
          Threads
        </button>
        <button type="button" role="tab" aria-selected={tab === "live"} className={"cs-rail-tab" + (tab === "live" ? " on" : "")} onClick={() => onTabChange("live")}>
          Live
        </button>
        <button type="button" role="tab" aria-selected={tab === "learn"} className={"cs-rail-tab" + (tab === "learn" ? " on" : "")} onClick={() => onTabChange("learn")}>
          Learn
        </button>
        <button type="button" role="tab" aria-selected={tab === "outline"} className={"cs-rail-tab" + (tab === "outline" ? " on" : "")} onClick={() => onTabChange("outline")}>
          Outline
        </button>
      </div>
      <div className="cs-rail-body">
        {tab === "threads" ? (
          openThreadId ? (
            <ThreadView threadId={openThreadId} onBack={() => onOpenThread(null)} onJumpToPinnedSha={onJumpToPinnedSha} />
          ) : raiseHand ? (
            <ThreadComposer
              cid={cid}
              gitRef={gitRef}
              path={path}
              startLine={raiseHand.line}
              endLine={raiseHand.line}
              agents={agents}
              preTaggedAgentId={raiseHand.agentId}
              onCreated={(id) => { onRaiseHandDone(); onOpenThread(id); }}
              onCancel={onRaiseHandDone}
            />
          ) : composerSelection ? (
            <ThreadComposer
              cid={cid}
              gitRef={gitRef}
              path={path}
              startLine={composerSelection.start}
              endLine={composerSelection.end}
              agents={agents}
              onCreated={(id) => { onComposerClose(); onOpenThread(id); }}
              onCancel={onComposerClose}
            />
          ) : (
            <ThreadList threads={threads} onOpen={onOpenThread} onJumpToLine={onJumpToLine} />
          )
        ) : null}
        {tab === "live" ? (
          <LivePanel cid={cid} agents={agents} onJumpToLine={onJumpToLine} onRaiseHand={onRaiseHandRequested} />
        ) : null}
        {tab === "learn" ? <LearnTab cid={cid} agents={agents} /> : null}
        {tab === "outline" ? <OutlineRail cid={cid} gitRef={gitRef} path={path} onJumpToLine={onJumpToLine} /> : null}
      </div>
    </aside>
  );
}

function ThreadList({
  threads,
  onOpen,
  onJumpToLine,
}: {
  threads: CodeThreadSummary[];
  onOpen: (id: string) => void;
  onJumpToLine: (line: number) => void;
}) {
  if (!threads.length) return <div className="none" style={{ padding: 10 }}>No threads on this file yet.</div>;
  return (
    <>
      {threads.map((t) => (
        <div key={t.id} className="cs-thread-chip" onClick={() => onOpen(t.id)}>
          <div className="row1">
            <span className={"kind-tag " + t.kind}>{kindLabel(t.kind)}</span>
            <span
              className="anchor mono"
              onClick={(e) => { e.stopPropagation(); onJumpToLine(t.start_line); }}
            >
              :{anchorLabel(t.start_line, t.end_line)}
            </span>
            <span className="grow" />
            <span className="status-tag">{t.status}</span>
          </div>
          {t.blob_match === false ? (
            <div className="outdated-chip">outdated — pinned to {shortSha(t.sha)}</div>
          ) : null}
        </div>
      ))}
    </>
  );
}
