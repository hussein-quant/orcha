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
import { useToast } from "../../components/ui";
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
import { Breadcrumbs } from "./Breadcrumbs";
import { CodeSpaceLanding } from "./CodeSpaceLanding";
import type { CodeThreadSummary } from "./codespaceTypes";
import { ErrorBoundary } from "./ErrorBoundary";
import { isLineSelected, rangeFrom, singleLine, type LineSelection } from "./gutter";
import { MdRenderedPane } from "./MdRenderedPane";
import { recordFileView } from "./recentFiles";
import { RecentFilesDropdown } from "./RecentFilesDropdown";
import { IdentifierTokens } from "./symbols/IdentifierTokens";
import { SymbolSearch } from "./symbols/SymbolSearch";
import { ThreadRail, type RailTab } from "./ThreadRail";
import { usePaneWidths } from "./usePaneWidths";
import "./codespace.css";

// Item 1 — Markdown files render through the house Md component (esc-first,
// safe inline markdown) by default; a small Raw|Rendered toggle in the
// content-pane header lets a human drop back to line-anchored Raw mode.
//
// Item 2 (thread conversations on rendered markdown) — Rendered mode has no
// gutter lines (there's no 1:1 line mapping over rendered prose blocks), but
// it's NOT anchor-dead: a "Discuss this document" header affordance opens
// the composer with a FILE-LEVEL anchor (start_line=1, end_line=1), and each
// rendered heading gets its own hover affordance that resolves to that
// heading's SOURCE line (MdRenderedPane.tsx / mdHeadingAnchor.ts) — falling
// back to the file-level anchor, with an explanatory note, on any ambiguity.
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

// Item 3 — breadcrumb segment click: scroll that directory's tree row into
// view and give it a brief highlight pulse ("filters" the tree to it without
// hiding siblings — BrowseTree/browseTree.tsx is a SHARED component owned by
// the GitHub browse surface too, so this stays a self-contained DOM nudge in
// codespace/** rather than a new prop threaded through shared code). The dir
// row's title attribute already carries its full path (BrowseTree's own
// convention) — reused here rather than inventing a new data-attribute.
function pulseTreeRow(dirPath: string): void {
  const selector = dirPath
    ? `.cs-tree-pane .dfv-dir[title="${CSS.escape(dirPath)}"]`
    : ".cs-tree-pane .rb-tree-scroll";
  const el = document.querySelector(selector) as HTMLElement | null;
  if (!el) return;
  if (typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "center" });
  el.classList.add("cs-tree-row-pulse");
  window.setTimeout(() => el.classList.remove("cs-tree-row-pulse"), 900);
}

export function CodeSpacePage() {
  const { snap, cid } = useSnapshot();
  const toast = useToast();
  const [searchParams, setSearchParams] = useSearchParams();

  const gitRef = searchParams.get("ref") || "HEAD";
  const path = searchParams.get("path") || "";
  const lineParam = searchParams.get("line");
  const threadParam = searchParams.get("thread");

  const { dirCache, expanded, rows, toggleDir, retryDir, filePayload, fileError, fileLoading } = useBrowseTree(cid || "", gitRef, path);

  const [selection, setSelection] = useState<LineSelection | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);
  // Item 2 — true when the open composer's {start:1,end:1} selection is the
  // Rendered view's FILE-LEVEL anchor ("Discuss this document" affordance, or
  // an ambiguous-heading fallback), not an actual Raw-mode line-1 click —
  // disambiguates the two so ThreadComposer never mislabels one as the other.
  const [composerWholeDocument, setComposerWholeDocument] = useState(false);
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

  // Item 2/3 — "recently viewed files": record on every file open, regardless
  // of entry point (tree click, breadcrumb, symbol nav, thread nav, recent-
  // files dropdown/landing card, deep link, or browser back/forward all
  // funnel through the SAME ?path= URL state) — a single effect keyed on
  // (cid, path) is the one place that's guaranteed to fire exactly once per
  // distinct file open, never on tab-switch/line-jump/thread-open (those
  // don't change path). recentFilesToken bumps so the header dropdown (a
  // separate mount reading its own localStorage snapshot) re-reads instead of
  // going stale for the component's lifetime.
  const [recentFilesToken, setRecentFilesToken] = useState(0);
  useEffect(() => {
    if (!cid || !path) return;
    recordFileView(cid, path);
    setRecentFilesToken((n) => n + 1);
  }, [cid, path]);

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

  // Item 2(c) — rendered blocks don't map 1:1 to source lines, so a thread
  // opened from the rail while Rendered is active switches to Raw AT THE
  // THREAD'S ANCHOR (the only mode that can actually show/highlight it), with
  // a small note explaining the jump. Only fires for an id belonging to a
  // thread ON THIS FILE (fileThreads, already loaded for the tree badge) —
  // closing (id=null), a raise-hand thread, or a just-created optimistic open
  // (openCreatedThread, always Raw already since the composer that made it
  // only ever anchors a real line) don't match any fileThreads row and no-op
  // harmlessly here.
  const openThread = useCallback((id: string | null) => {
    setOpenThreadId(id);
    navigate({ thread: id }, true);
    if (id && viewMode === "rendered") {
      const t = fileThreads.find((ft) => ft.id === id);
      if (t) {
        setViewMode("raw");
        toast("Switched to Raw to show this thread's anchor", "");
        scrollLineIntoView(t.start_line);
      }
    }
  }, [navigate, viewMode, fileThreads, toast]);

  const onGutterClick = useCallback((line: number, shiftKey: boolean) => {
    if (shiftKey && anchorLineRef.current != null) {
      setSelection(rangeFrom(anchorLineRef.current, line));
    } else {
      anchorLineRef.current = line;
      setSelection(singleLine(line));
    }
    setComposerWholeDocument(false);
    setComposerOpen(true);
    setRailTab("threads");
    setOpenThreadId(null);
    setRaiseHand(null);
  }, []);

  // Item 2 — Rendered mode's "Discuss this document" header affordance: opens
  // the SAME composer the gutter uses, anchored file-level (start=end=1),
  // clearly labeled by composerWholeDocument so it never reads as "line 1".
  const onDiscussDocument = useCallback(() => {
    setSelection(singleLine(1));
    setComposerWholeDocument(true);
    setComposerOpen(true);
    setRailTab("threads");
    setOpenThreadId(null);
    setRaiseHand(null);
  }, []);

  // Item 2 — a rendered heading resolved to its source line (mdHeadingAnchor
  // .ts): anchor the composer there, same as a Raw-mode gutter click on that
  // line, but never Raw's own state (Rendered stays Rendered — Raw is ONLY
  // entered explicitly by the toggle or a thread-rail jump).
  const onDiscussHeading = useCallback((line: number) => {
    setSelection(singleLine(line));
    setComposerWholeDocument(false);
    setComposerOpen(true);
    setRailTab("threads");
    setOpenThreadId(null);
    setRaiseHand(null);
  }, []);

  // Item 2 — a heading click that couldn't be confidently resolved to a
  // source line (count/text mismatch — see mdHeadingAnchor.ts) falls back to
  // the file-level anchor rather than risk anchoring to the wrong line; the
  // toast is the "tooltip saying so" the spec calls for, surfaced at the
  // moment of the click since a hover-only tooltip can't explain a decision
  // made at click time.
  const onAmbiguousHeading = useCallback(() => {
    toast("Couldn't match that heading to a source line — discussing the whole document instead", "warn");
    onDiscussDocument();
  }, [onDiscussDocument, toast]);

  // Usability sweep papercut: closing the composer (Escape, or its own
  // Cancel button) left the just-picked line's ".cs-line.selected" highlight
  // stuck in the code pane with no way to clear it short of clicking another
  // line — canceling should leave the pane exactly as if nothing had been
  // picked yet.
  const closeComposer = useCallback(() => {
    setComposerOpen(false);
    setComposerWholeDocument(false);
    setSelection(null);
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

  // Item 2 — landing state's "Search symbols" quick action: focuses/opens the
  // header SymbolSearch WITHOUT a prefill (a plain open, unlike identifier
  // click). Cmd/Ctrl+P already does this itself (SymbolSearch's own document
  // keydown listener) — this bumps the same open affordance via a prop so it
  // also works as a mouse-driven action from the landing card.
  const [symbolFocusToken, setSymbolFocusToken] = useState(0);
  const focusSymbolSearch = useCallback(() => {
    setSymbolFocusToken((n) => n + 1);
  }, []);

  // Item 3 — breadcrumb segment click: make sure that directory is expanded
  // in the tree (toggleDir is a TOGGLE, so only call it if not already open —
  // clicking a currently-open ancestor's crumb must never collapse it), then
  // scroll/pulse its row so the click has a visible destination.
  const openDirInTree = useCallback((dirPath: string) => {
    if (!expanded.has(dirPath)) toggleDir(dirPath);
    // scroll after the (possibly async) row exists — a microtask is enough
    // for already-cached dirs; freshly-expanded ones settle on the next
    // fetch-driven render, which re-queries by title and no-ops harmlessly
    // if the row isn't painted yet.
    requestAnimationFrame(() => pulseTreeRow(dirPath));
  }, [expanded, toggleDir]);

  // Item 4 — landing state's "Browse the file tree" quick action: scrolls the
  // first row into view with a brief highlight pulse. Deliberately NOT a
  // .focus() call (usability-sweep correction) — BrowseTree's rows
  // (cloud/shared/browseTree.tsx, owned by the GitHub browse surface too)
  // are plain unfocusable <div>s with no tabIndex, so calling .focus() on one
  // is a silent no-op that would have made this "quick action" a lie for
  // keyboard users; a visible pulse is honest about what it actually does.
  const focusTree = useCallback(() => {
    const el = document.querySelector(".cs-tree-pane .dfv-r") as HTMLElement | null;
    if (!el) return;
    el.scrollIntoView?.({ block: "center" });
    el.classList.add("cs-tree-row-pulse");
    window.setTimeout(() => el.classList.remove("cs-tree-row-pulse"), 900);
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

  // Panel improvements item 1 — resizable tree/code/rail panes. Native
  // Pointer Events via DOCUMENT-level listeners registered for the
  // duration of a drag (not React's onPointerMove/onPointerUp on the
  // divider itself) — the cursor routinely leaves the divider's own 6px hit
  // area mid-drag, and document listeners keep tracking it regardless,
  // without needing setPointerCapture (which jsdom doesn't implement — see
  // scrollLineIntoView's identical feature-detect precedent elsewhere in
  // this file for the general house convention). No drag library — this
  // codebase adds zero new dependencies for UI interactions like this.
  const { widths, dragTree, dragRail, resetTree, resetRail } = usePaneWidths();
  const dragStateRef = useRef<{ pane: "tree" | "rail"; startX: number } | null>(null);

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const st = dragStateRef.current;
      if (!st) return;
      const delta = e.clientX - st.startX;
      st.startX = e.clientX;
      // dragRail negates the delta INTERNALLY (usePaneWidths.ts's own doc
      // comment) — pass the raw pointer delta unmodified for both panes.
      if (st.pane === "tree") dragTree(delta);
      else dragRail(delta);
    };
    const onUp = () => {
      dragStateRef.current = null;
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    return () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
    };
  }, [dragTree, dragRail]);

  const startDrag = useCallback((pane: "tree" | "rail") => (e: React.PointerEvent<HTMLDivElement>) => {
    dragStateRef.current = { pane, startX: e.clientX };
  }, []);

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
            focusToken={symbolFocusToken}
            path={path}
          />
          {path ? (
            <RecentFilesDropdown
              cid={cid}
              currentPath={path}
              onOpenFile={selectFile}
              refreshToken={recentFilesToken}
            />
          ) : null}
        </div>
        <div className="cs-body">
          <div className="cs-tree-pane" style={{ width: widths.tree }}>
            <div className="rb-tree-scroll">
              <ErrorBoundary label="tree">
                <BrowseTree
                  rows={rows}
                  dirCache={dirCache}
                  expanded={expanded}
                  selectedPath={path}
                  onToggleDir={toggleDir}
                  onRetryDir={retryDir}
                  onSelectFile={selectFile}
                  fileBadge={(p) => {
                    const n = fileThreads.filter((t) => t.path === p).length;
                    return n ? <span className="cs-tree-badge">{n}</span> : null;
                  }}
                />
              </ErrorBoundary>
            </div>
          </div>

          <div
            className="cs-divider cs-divider-tree"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize file tree pane"
            title="Drag to resize, double-click to reset"
            onPointerDown={startDrag("tree")}
            onDoubleClick={resetTree}
          />

          <div className="cs-code-pane">
            <div className="cs-code-scroll">
              <ErrorBoundary label="content" key={path}>
              {!path ? (
                <CodeSpaceLanding
                  cid={cid}
                  onNavigateToThread={navigateToThread}
                  onOpenFile={selectFile}
                  onSearchSymbols={focusSymbolSearch}
                  onFocusTree={focusTree}
                />
              ) : fileLoading || (filePayload && filePayload.path !== path) ? (
                // BUG 3 root-cause fix — the old guard (fileLoading &&
                // !filePayload) only blocked stale content on the very
                // FIRST load. Switching files sets fileLoading=true but
                // filePayload still holds the PREVIOUS file until the fetch
                // resolves, so the previous file's lines/gutter rendered
                // under the NEW file's path/breadcrumb for one paint — a
                // gutter click in that window anchored a composer to the
                // wrong path/line. `fileLoading` ALONE now gates the
                // skeleton on every load, first or not; the
                // `filePayload.path !== path` clause is a second
                // independent guard against the same class of bug if
                // fileLoading and path ever race each other in the future.
                <BrowseSkeletonPane />
              ) : fileError ? (
                <BrowseErrorBody err={fileError} what="File" />
              ) : filePayload ? (
                <ContentPaneChrome
                  gitRef={gitRef}
                  payload={filePayload}
                  htmlUrl={htmlUrl}
                  headerExtra={
                    <>
                      <Breadcrumbs path={path} onOpenDir={openDirInTree} />
                      {isMd ? (
                        <>
                          {viewMode === "rendered" ? (
                            <button
                              type="button"
                              className="cs-discuss-doc-btn"
                              onClick={onDiscussDocument}
                              title="Start a thread anchored to this whole document"
                            >
                              Discuss this document
                            </button>
                          ) : null}
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
                        </>
                      ) : null}
                    </>
                  }
                >
                  {isMd && viewMode === "rendered" ? (
                    <MdRenderedPane
                      content={filePayload.content ?? ""}
                      onDiscussHeading={onDiscussHeading}
                      onAmbiguousHeading={onAmbiguousHeading}
                    />
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
              </ErrorBoundary>
            </div>
          </div>

          <div
            className="cs-divider cs-divider-rail"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize thread rail pane"
            title="Drag to resize, double-click to reset"
            onPointerDown={startDrag("rail")}
            onDoubleClick={resetRail}
          />

          <ErrorBoundary label="rail">
            <ThreadRail
              cid={cid}
              gitRef={gitRef}
              path={path}
              agents={agents}
              tab={railTab}
              onTabChange={setRailTab}
              composerSelection={composerOpen ? selection : null}
              composerWholeDocument={composerOpen ? composerWholeDocument : undefined}
              onComposerClose={closeComposer}
              onJumpToLine={jumpToLine}
              onJumpToPinnedSha={jumpToPinnedSha}
              openThreadId={openThreadId}
              onOpenThread={openThread}
              onThreadsLoaded={setFileThreads}
              raiseHand={raiseHand}
              onRaiseHandDone={() => setRaiseHand(null)}
              onRaiseHandRequested={onRaiseHand}
              onNavigateToThread={navigateToThread}
              width={widths.rail}
            />
          </ErrorBoundary>
        </div>
      </div>
    </Shell>
  );
}
