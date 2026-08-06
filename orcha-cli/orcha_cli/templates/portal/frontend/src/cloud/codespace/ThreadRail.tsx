/**
 * The right rail: Threads (Phase 1, current-file scoped) / Live (Phase 2) /
 * Learn (Phase 4) / Outline (Phase 3) tabs. Threads-tab list polls on the
 * house 3s bump; anchor chips jump to lines, count badges optional via the
 * tree's fileBadge slot (CodeSpacePage wires that separately). Outline
 * (symbols/OutlineRail.tsx) is scoped to whatever file is currently open,
 * exactly like the Threads tab.
 *
 * Item 3 — when no file is open, the Threads tab's list is replaced by a
 * repo-wide "Recent" section (newest threads across every path); when a file
 * IS open, a compact "Recent" link sits above the per-file list so the
 * quick-jump is always one click away, not just on the empty-file state.
 *
 * Item 5 — posting a thread (or a raise-hand) swaps the rail straight into
 * that thread's ThreadView, seeded with the CreateThreadResponse the POST
 * already returned — no loading flash, no waiting for the next 3s poll.
 */
import { useEffect, useRef, useState } from "react";
import { useSnapshot } from "../../state/SnapshotProvider";
import type { Agent } from "../../types";
import { fetchRecentThreads, fetchThreads } from "./codespaceApi";
import {
  anchorLabel,
  kindLabel,
  shortSha,
  type CodeThreadDetailPayload,
  type CodeThreadSummary,
  type CreateThreadResponse,
} from "./codespaceTypes";
import { LearnTab } from "./LearnTab";
import { LivePanel } from "./LivePanel";
import { RecentThreadsList } from "./RecentThreadsList";
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
  // Item 3 — a Recent-tab row was clicked: open that thread's file at its
  // anchor with the thread selected. Optional so existing mounts/tests that
  // don't wire it still render (Recent rows simply no-op without it, matching
  // every other optional callback's convention in this file).
  onNavigateToThread?: (thread: CodeThreadSummary) => void;
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
  onNavigateToThread,
}: ThreadRailProps) {
  const { bump } = useSnapshot();
  const [threads, setThreads] = useState<CodeThreadSummary[]>([]);
  const [recentThreads, setRecentThreads] = useState<CodeThreadSummary[]>([]);
  const [showRecent, setShowRecent] = useState(false);
  // Item 5 — optimistic seed for the thread ThreadView is about to open
  // (set right when a composer's POST resolves; cleared once the rail moves
  // on to a DIFFERENT thread id, a fresh open thread has no stale seed).
  const [openSeed, setOpenSeed] = useState<CodeThreadDetailPayload | null>(null);
  const token = useRef(0);
  const recentToken = useRef(0);

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

  // Recent quick-jump: fetched whenever no file is open (it's the default
  // view then) OR the human explicitly toggled the compact "Recent" link
  // while a file IS open.
  const wantsRecent = !path || showRecent;
  useEffect(() => {
    if (!wantsRecent) return;
    const myToken = ++recentToken.current;
    fetchRecentThreads(cid, { n: 20 }).then((res) => {
      if (myToken !== recentToken.current) return;
      if (res.ok) setRecentThreads(res.data.threads);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cid, wantsRecent, bump]);

  const openCreatedThread = (created: CreateThreadResponse) => {
    setOpenSeed({ thread: created.thread, messages: [created.message] });
    onOpenThread(created.thread.id);
  };

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
            <ThreadView
              threadId={openThreadId}
              onBack={() => { onOpenThread(null); setOpenSeed(null); }}
              onJumpToPinnedSha={onJumpToPinnedSha}
              seed={openSeed && openSeed.thread.id === openThreadId ? openSeed : undefined}
            />
          ) : raiseHand ? (
            <ThreadComposer
              cid={cid}
              gitRef={gitRef}
              path={path}
              startLine={raiseHand.line}
              endLine={raiseHand.line}
              agents={agents}
              preTaggedAgentId={raiseHand.agentId}
              onCreated={(created) => { onRaiseHandDone(); openCreatedThread(created); }}
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
              onCreated={(created) => { onComposerClose(); openCreatedThread(created); }}
              onCancel={onComposerClose}
            />
          ) : path && !showRecent ? (
            <>
              <button type="button" className="cs-recent-link" onClick={() => setShowRecent(true)}>
                Recent threads (all files)
              </button>
              <ThreadList threads={threads} onOpen={onOpenThread} onJumpToLine={onJumpToLine} />
            </>
          ) : (
            <>
              {path ? (
                <button type="button" className="cs-recent-link" onClick={() => setShowRecent(false)}>
                  &larr; Back to {path}
                </button>
              ) : null}
              <RecentThreadsList threads={recentThreads} onOpen={onNavigateToThread} />
            </>
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
