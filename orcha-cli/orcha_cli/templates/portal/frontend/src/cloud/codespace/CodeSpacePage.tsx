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
import { Md } from "../../components/ui";
import { useSnapshot } from "../../state/SnapshotProvider";
import { Shell } from "../../shell/Shell";
import { extOf } from "../github/browse/browseTypes";
import { highlightLine, type Token } from "../github/browse/highlight";
import {
  BrowseErrorBody,
  BrowseSkeletonPane,
  BrowseTree,
  ContentPaneChrome,
} from "../shared/browseTree";
import { useBrowseTree } from "../shared/useBrowseTree";
import type { CodeThreadSummary } from "./codespaceTypes";
import { isLineSelected, rangeFrom, singleLine, type LineSelection } from "./gutter";
import { IdentifierTokens } from "./symbols/IdentifierTokens";
import { SymbolSearch } from "./symbols/SymbolSearch";
import { ThreadRail, type RailTab } from "./ThreadRail";
import "./codespace.css";

// Item 1 — Markdown files render through the house Md component (esc-first,
// safe inline markdown) by default; a small Raw|Rendered toggle in the
// content-pane header lets a human drop back to line-anchored Raw mode
// (gutter selection is disabled in Rendered mode — there ARE no gutter lines
// to anchor against prose, so the tooltip is honest about why).
type ViewMode = "raw" | "rendered";
function isMarkdownPath(path: string): boolean {
  return extOf(path) === "md";
}

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
  // Identifier click (Phase 3, best-effort v1): prefills the header's
  // SymbolSearch with the clicked word — "Find symbol", never "go to
  // definition". prefillToken forces a re-trigger even on a repeat click of
  // the same word.
  const [symbolPrefill, setSymbolPrefill] = useState<string | undefined>(undefined);
  const [symbolPrefillToken, setSymbolPrefillToken] = useState(0);

  // Item 1 — Raw|Rendered toggle: Rendered is the default ONLY for .md files;
  // every other extension only ever sees Raw (the toggle itself is hidden for
  // them). Re-derives per file so navigating from a .md file to a non-.md
  // file (or vice versa) always lands on the right default instead of
  // carrying over the previous file's choice.
  const isMd = isMarkdownPath(path);
  const [viewMode, setViewMode] = useState<ViewMode>(isMd ? "rendered" : "raw");
  useEffect(() => {
    setViewMode(isMarkdownPath(path) ? "rendered" : "raw");
  }, [path]);

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

  // Workspace symbol search result navigation (header search AND identifier
  // click both land here): switch to the clicked file at the symbol's line.
  const navigateToSymbol = useCallback((symbolPath: string, line: number) => {
    setSelection(null);
    setComposerOpen(false);
    navigate({ path: symbolPath, line, thread: null }, false);
    scrollLineIntoView(line);
  }, [navigate]);

  const onIdentifierClick = useCallback((word: string) => {
    setSymbolPrefill(word);
    setSymbolPrefillToken((n) => n + 1);
  }, []);

  // Item 3 — Recent tab row click: open that thread's file at its anchor line
  // WITH the thread itself selected (unlike navigateToSymbol, which clears
  // ?thread= — here the whole point is landing straight in the thread view).
  const navigateToThread = useCallback((t: CodeThreadSummary) => {
    setSelection(null);
    setComposerOpen(false);
    setRailTab("threads");
    setOpenThreadId(t.id);
    navigate({ path: t.path, line: t.start_line, thread: t.id }, false);
    scrollLineIntoView(t.start_line);
  }, [navigate]);

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
        <div className="cs-head">
          <SymbolSearch
            cid={cid}
            gitRef={gitRef}
            onNavigate={navigateToSymbol}
            prefill={symbolPrefill}
            prefillToken={symbolPrefillToken}
          />
        </div>
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
                <ContentPaneChrome
                  gitRef={gitRef}
                  payload={filePayload}
                  htmlUrl={htmlUrl}
                  headerExtra={
                    isMd ? (
                      <div className="cs-view-toggle" role="group" aria-label="View mode">
                        <button
                          type="button"
                          className={"cs-view-toggle-btn" + (viewMode === "raw" ? " on" : "")}
                          onClick={() => setViewMode("raw")}
                        >
                          Raw
                        </button>
                        <button
                          type="button"
                          className={"cs-view-toggle-btn" + (viewMode === "rendered" ? " on" : "")}
                          onClick={() => setViewMode("rendered")}
                        >
                          Rendered
                        </button>
                      </div>
                    ) : null
                  }
                >
                  {isMd && viewMode === "rendered" ? (
                    <div
                      className="cs-md-rendered"
                      title="switch to Raw to anchor a thread"
                    >
                      <Md text={filePayload.content ?? ""} />
                    </div>
                  ) : (
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
                              <IdentifierTokens tokens={tokens} onIdentifierClick={onIdentifierClick} />
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  )}
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
            onNavigateToThread={navigateToThread}
          />
        </div>
      </div>
    </Shell>
  );
}
