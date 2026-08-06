/**
 * Code Space — full-page route `/code` (docs/orcha-code-space-design.md):
 * three panes — directory tree + search | code viewer | thread rail — using
 * the FULL viewport height (the embedded GitHub browser's cramped-pane
 * complaint; see codespace.css's `.content:has(.cs-shell)` override), panes
 * independently scrollable. Deep links: `/code?ref=&path=&line=&thread=`.
 *
 * Reuses the shared tree/file-fetch state (cloud/shared/useBrowseTree.ts) and
 * tree/skeleton/error rendering (cloud/shared/browseTree.tsx) extracted from
 * RepoBrowser.tsx — the GitHub page's embedded browser keeps working
 * unchanged (see that file's test suite, still green). Only the code-viewer
 * BODY differs here: each line gets a gutter affordance (hover "+" to open
 * the thread composer, a persistent dot when a thread already anchors there)
 * instead of RepoBrowser's plain line-number gutter.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useSnapshot } from "../../state/SnapshotProvider";
import { Shell } from "../../shell/Shell";
import { highlightLine, type Token } from "../github/browse/highlight";
import {
  BrowseErrorBody,
  BrowseSkeletonPane,
  BrowseTree,
  ContentPaneChrome,
  TokenSpans,
} from "../shared/browseTree";
import { useBrowseTree } from "../shared/useBrowseTree";
import type { CodeThreadSummary } from "./codespaceTypes";
import { isLineSelected, rangeFrom, singleLine, type LineSelection } from "./gutter";
import { ThreadRail, type RailTab } from "./ThreadRail";
import "./codespace.css";

// jsdom has no scrollIntoView (RequestsPage.tsx / AgentsPage.tsx's same
// feature-detect precedent) — production browsers always have it.
function scrollLineIntoView(line: number): void {
  const el = document.querySelector(`[data-cs-line="${line}"]`);
  if (el && typeof (el as HTMLElement).scrollIntoView === "function") {
    (el as HTMLElement).scrollIntoView({ block: "center" });
  }
}

export function CodeSpacePage() {
  const { snap, cid } = useSnapshot();
  const [searchParams, setSearchParams] = useSearchParams();

  const gitRef = searchParams.get("ref") || "HEAD";
  const path = searchParams.get("path") || "";
  const lineParam = searchParams.get("line");
  const threadParam = searchParams.get("thread");

  const { dirCache, expanded, rows, toggleDir, filePayload, fileError, fileLoading } = useBrowseTree(cid || "", gitRef, path);

  const [selection, setSelection] = useState<LineSelection | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);
  const anchorLineRef = useRef<number | null>(null);
  const [railTab, setRailTab] = useState<RailTab>("threads");
  const [openThreadId, setOpenThreadId] = useState<string | null>(threadParam);
  const [fileThreads, setFileThreads] = useState<CodeThreadSummary[]>([]);
  const [raiseHand, setRaiseHand] = useState<{ agentId: string; line: number } | null>(null);

  // deep-linked ?line= scrolls to that line once the file paints.
  useEffect(() => {
    if (!filePayload || !lineParam) return;
    const ln = Number(lineParam);
    if (!Number.isFinite(ln)) return;
    scrollLineIntoView(ln);
  }, [filePayload, lineParam]);

  const navigate = useCallback((next: { ref?: string; path?: string; line?: number | null; thread?: string | null }, replace = false) => {
    setSearchParams((prev) => {
      const p = new URLSearchParams(prev);
      if (next.ref !== undefined) { if (next.ref) p.set("ref", next.ref); else p.delete("ref"); }
      if (next.path !== undefined) { if (next.path) p.set("path", next.path); else p.delete("path"); }
      if (next.line !== undefined) { if (next.line != null) p.set("line", String(next.line)); else p.delete("line"); }
      if (next.thread !== undefined) { if (next.thread) p.set("thread", next.thread); else p.delete("thread"); }
      return p;
    }, { replace });
  }, [setSearchParams]);

  const selectFile = useCallback((p: string) => {
    setSelection(null);
    setComposerOpen(false);
    navigate({ path: p, line: null, thread: null });
  }, [navigate]);

  const jumpToLine = useCallback((line: number) => {
    navigate({ line }, true);
    scrollLineIntoView(line);
  }, [navigate]);

  const jumpToPinnedSha = useCallback((sha: string) => {
    navigate({ ref: sha }, true);
  }, [navigate]);

  const openThread = useCallback((id: string | null) => {
    setOpenThreadId(id);
    navigate({ thread: id }, true);
  }, [navigate]);

  const onGutterClick = useCallback((line: number, shiftKey: boolean) => {
    if (shiftKey && anchorLineRef.current != null) {
      setSelection(rangeFrom(anchorLineRef.current, line));
    } else {
      anchorLineRef.current = line;
      setSelection(singleLine(line));
    }
    setComposerOpen(true);
    setRailTab("threads");
    setOpenThreadId(null);
    setRaiseHand(null);
  }, []);

  const onRaiseHand = useCallback((agentId: string, line: number) => {
    setRaiseHand({ agentId, line });
    setRailTab("threads");
    setOpenThreadId(null);
    setComposerOpen(false);
    setSelection(null);
  }, []);

  const agents = snap?.agents ?? [];
  const htmlUrl = null; // Code Space has no repo html_url context handy here; the file pane omits the GitHub link.

  const gutterDotsForLine = useMemo(() => {
    const m = new Map<number, CodeThreadSummary[]>();
    fileThreads.forEach((t) => {
      for (let ln = t.start_line; ln <= t.end_line; ln++) {
        const list = m.get(ln) || [];
        list.push(t);
        m.set(ln, list);
      }
    });
    return m;
  }, [fileThreads]);

  if (!cid) return null;

  return (
    <Shell page="code" title="Code Space" ctx={snap?.container?.name}>
      <div className="cs-shell">
        <div className="cs-body">
          <div className="cs-tree-pane">
            <div className="rb-tree-scroll">
              <BrowseTree
                rows={rows}
                dirCache={dirCache}
                expanded={expanded}
                selectedPath={path}
                onToggleDir={toggleDir}
                onSelectFile={selectFile}
                fileBadge={(p) => {
                  const n = fileThreads.filter((t) => t.path === p).length;
                  return n ? <span className="cs-tree-badge">{n}</span> : null;
                }}
              />
            </div>
          </div>

          <div className="cs-code-pane">
            <div className="cs-code-scroll">
              {!path ? (
                <div className="rb-empty-pane muted">Select a file to view its contents.</div>
              ) : fileLoading && !filePayload ? (
                <BrowseSkeletonPane />
              ) : fileError ? (
                <BrowseErrorBody err={fileError} what="File" />
              ) : filePayload ? (
                <ContentPaneChrome gitRef={gitRef} payload={filePayload} htmlUrl={htmlUrl}>
                  <div className="rb-code mono">
                    {(filePayload.content ?? "").split("\n").map((line, i) => {
                      const lineNo = i + 1;
                      const threadsHere = gutterDotsForLine.get(lineNo) || [];
                      const selected = isLineSelected(selection, lineNo);
                      const tokens: Token[] = highlightLine(line, filePayload.path);
                      return (
                        <div
                          key={lineNo}
                          className={"cs-line" + (selected ? " selected" : "")}
                          data-cs-line={lineNo}
                        >
                          <span
                            className="cs-gutter"
                            onClick={(e) => onGutterClick(lineNo, e.shiftKey)}
                            title="Click to start a thread, shift-click to extend the range"
                          >
                            <span className="cs-gutter-add" aria-hidden="true">+</span>
                            {threadsHere.length ? <span className="cs-gutter-dot" /> : null}
                            {lineNo}
                          </span>
                          <span className="cs-line-text">
                            <TokenSpans tokens={tokens} />
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </ContentPaneChrome>
              ) : (
                <BrowseSkeletonPane />
              )}
            </div>
          </div>

          <ThreadRail
            cid={cid}
            gitRef={gitRef}
            path={path}
            agents={agents}
            tab={railTab}
            onTabChange={setRailTab}
            composerSelection={composerOpen ? selection : null}
            onComposerClose={() => setComposerOpen(false)}
            onJumpToLine={jumpToLine}
            onJumpToPinnedSha={jumpToPinnedSha}
            openThreadId={openThreadId}
            onOpenThread={openThread}
            onThreadsLoaded={setFileThreads}
            raiseHand={raiseHand}
            onRaiseHandDone={() => setRaiseHand(null)}
            onRaiseHandRequested={onRaiseHand}
          />
        </div>
      </div>
    </Shell>
  );
}
