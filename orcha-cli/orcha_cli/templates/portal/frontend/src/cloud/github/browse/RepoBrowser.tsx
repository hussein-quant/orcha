/**
 * RepoBrowser — the GitHub repo file browser's "Files" sub-view: an
 * IDE-style three-part surface (lazy directory tree, Names/Contents search,
 * line-numbered content pane) mounted by GitHubPage under ?browse=1&ref=&path=.
 *
 * Owns ONLY this directory (src/cloud/github/browse/**) plus one integration
 * point in GitHubPage.tsx (see that file's diff). Talks to the browse/{tree,
 * file,search} endpoints (CONTRACT — browseTypes.ts doc, implemented on a
 * parallel branch) through browseApi.ts, which classifies every failure
 * through the SAME ghlib.ts error ladder the rest of the hub uses — so
 * not_connected/rate_limited/not_found degrade through the page's existing
 * GhErrorBody-style components (mirrored locally since GhErrorBody itself is
 * private to GitHubPage.tsx; same class names / copy).
 *
 * State lives here (not in GitHubPage) — the tree's expanded-dir set, the
 * search mode/query, and the selected file all reset only when `ref` changes,
 * never on the 3s snapshot poll (this component doesn't ride that poll at
 * all: it only fetches on mount / ref change / user interaction).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../../../components/ui";
import type { GhError } from "../ghlib";
import { fetchFile, fetchSearch, fetchTree } from "./browseApi";
import {
  parentOf,
  type BrowseContentResult,
  type BrowseEntry,
  type BrowseFilePayload,
  type BrowseNameResult,
  type BrowseSearchMode,
} from "./browseTypes";
import { highlightLine, type Token } from "./highlight";
import { useDebouncedValue } from "./useDebounce";
import "./browse.css";

/* ---- error degrade (mirrors GitHubPage's GhErrorBody — same class names) - */
function BrowseEmptyRepo() {
  return (
    <div className="gh-empty card-empty">
      <div className="t1">No GitHub repo connected</div>
      <p>Connect this project to a repository to browse its files here.</p>
    </div>
  );
}
function BrowseRateLimit({ detail }: { detail?: string | null }) {
  return (
    <div className="gh-empty card-empty">
      <div className="t1">GitHub rate limit hit</div>
      <p>Backing off — this quietly retries on the next refresh.{detail ? " (" + detail + ")" : ""}</p>
    </div>
  );
}
function BrowseNotFound({ what }: { what: string }) {
  return (
    <div className="gh-empty card-empty">
      <div className="t1">{what} not found</div>
      <p>It may not exist at this ref, or may have been moved or deleted.</p>
    </div>
  );
}
function BrowseGenericError({ status, detail }: { status?: number; detail?: string | null }) {
  return (
    <div className="gh-empty card-empty">
      <div className="t1">Couldn&#39;t load {status ? "(" + String(status) + ")" : ""}</div>
      <p>{detail ? detail : "Something went wrong talking to GitHub."}</p>
    </div>
  );
}
function BrowseErrorBody({ err, what }: { err: GhError; what: string }) {
  if (err.kind === "not_found") return <BrowseNotFound what={what} />;
  if (err.kind === "not_connected") return <BrowseEmptyRepo />;
  if (err.kind === "rate_limited") return <BrowseRateLimit detail={err.detail} />;
  return <BrowseGenericError status={err.status} detail={err.detail} />;
}

/* ---- skeleton (ork-sk-* shared shimmer classes, GhSkeleton's markup) ------ */
function BrowseSkeletonRows() {
  return (
    <div className="ork-sk-wrap" aria-hidden="true">
      {Array.from({ length: 5 }, (_, i) => (
        <div key={i} className="ork-sk-row">
          <div className="ork-sk ork-sk-pill"></div>
          <div className="ork-sk-col"><div className="ork-sk-line w60 sm"></div></div>
        </div>
      ))}
    </div>
  );
}
function BrowseSkeletonPane() {
  return (
    <div className="ork-sk-wrap" aria-hidden="true">
      <div className="ork-sk-line w50 lg"></div>
      <div className="ork-sk-line w80"></div>
      <div className="ork-sk-line w70"></div>
      <div className="ork-sk-block"></div>
      <div className="ork-sk-line w60"></div>
    </div>
  );
}

/* ---- tree node state (lazy-loaded per dir, keyed by dir path; "" = root) - */
interface DirState {
  loading: boolean;
  error: GhError | null;
  entries: BrowseEntry[] | null;
  truncated?: boolean;
}
interface TreeRow {
  entry: BrowseEntry;
  depth: number;
}

// Depth-first flattening for render: each dir row is immediately followed by
// its children (recursively) when expanded, by looking up the child dir's
// cached entries in dirCache — rootEntries seeds depth 0. Dirs sort before
// files within a level, both alphabetically (matches FilesChanged's tree).
function buildVisibleRows(
  dirCache: Record<string, DirState>,
  expanded: Set<string>,
  rootEntries: BrowseEntry[] | null,
): TreeRow[] {
  const rows: TreeRow[] = [];
  const visit = (entries: BrowseEntry[], depth: number) => {
    const dirs = entries.filter((e) => e.type === "dir").slice().sort((a, b) => a.name.localeCompare(b.name));
    const files = entries.filter((e) => e.type === "file").slice().sort((a, b) => a.name.localeCompare(b.name));
    dirs.forEach((d) => {
      rows.push({ entry: d, depth });
      if (expanded.has(d.path)) {
        const child = dirCache[d.path];
        if (child && child.entries) visit(child.entries, depth + 1);
      }
    });
    files.forEach((f) => rows.push({ entry: f, depth }));
  };
  if (rootEntries) visit(rootEntries, 0);
  return rows;
}

/* ---- search result row shapes --------------------------------------------- */
function isContentResult(r: BrowseNameResult | BrowseContentResult): r is BrowseContentResult {
  return Array.isArray((r as BrowseContentResult).matches);
}

export interface RepoBrowserProps {
  cid: string;
  // NOT named "ref" — that's a reserved JSX/React prop (element refs), so a
  // prop of that name never reaches the component; React swallows it and
  // throws "ref was specified as a string" instead.
  gitRef: string;
  path: string; // "" = no file selected
  htmlUrlBase?: string | null; // e.g. "https://github.com/acme/app" — for "view on GitHub" links
  onNavigate: (next: { ref?: string; path?: string }) => void;
}

export function RepoBrowser({ cid, gitRef, path, htmlUrlBase, onNavigate }: RepoBrowserProps) {
  const [dirCache, setDirCache] = useState<Record<string, DirState>>({});
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([""]));
  const [searchMode, setSearchMode] = useState<BrowseSearchMode>("names");
  const [query, setQuery] = useState("");
  const debouncedQuery = useDebouncedValue(query, 300);
  const [searchResults, setSearchResults] = useState<(BrowseNameResult | BrowseContentResult)[] | null>(null);
  const [searchError, setSearchError] = useState<GhError | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [defaultBranchOnly, setDefaultBranchOnly] = useState(false);
  const searchToken = useRef(0);

  const [filePayload, setFilePayload] = useState<BrowseFilePayload | null>(null);
  const [fileError, setFileError] = useState<GhError | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const fileToken = useRef(0);

  // ---- tree: fetch a dir's entries (lazy — only on first expand, or ref change)
  const loadDir = useCallback((dirPath: string) => {
    setDirCache((prev) => ({ ...prev, [dirPath]: { loading: true, error: null, entries: prev[dirPath]?.entries ?? null } }));
    fetchTree(cid, gitRef, dirPath).then((res) => {
      if (!res.ok) {
        setDirCache((prev) => ({ ...prev, [dirPath]: { loading: false, error: res.error, entries: null } }));
        return;
      }
      setDirCache((prev) => ({
        ...prev,
        [dirPath]: { loading: false, error: null, entries: res.data.entries, truncated: res.data.truncated },
      }));
    });
  }, [cid, gitRef]);

  // root loads on mount + whenever ref changes; expansion/selection resets too
  useEffect(() => {
    setDirCache({});
    setExpanded(new Set([""]));
    loadDir("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cid, gitRef]);

  // deep-linked path: ensure every ancestor dir is expanded + loaded so the
  // selected file's row is visible in the tree on first paint.
  useEffect(() => {
    if (!path) return;
    const ancestors: string[] = [];
    let p = parentOf(path);
    while (true) {
      ancestors.unshift(p);
      if (!p) break;
      p = parentOf(p);
    }
    setExpanded((prev) => {
      const next = new Set(prev);
      ancestors.forEach((a) => next.add(a));
      return next;
    });
    ancestors.forEach((a) => {
      setDirCache((prev) => {
        if (prev[a]) return prev;
        loadDir(a);
        return prev;
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, cid, gitRef]);

  const toggleDir = useCallback((dirPath: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(dirPath)) {
        next.delete(dirPath);
      } else {
        next.add(dirPath);
        setDirCache((cache) => {
          if (!cache[dirPath]) loadDir(dirPath);
          return cache;
        });
      }
      return next;
    });
  }, [loadDir]);

  const rows = useMemo(
    () => buildVisibleRows(dirCache, expanded, dirCache[""]?.entries ?? null),
    [dirCache, expanded],
  );

  // ---- file content load (on path change)
  useEffect(() => {
    if (!path) { setFilePayload(null); setFileError(null); return; }
    const myToken = ++fileToken.current;
    setFileLoading(true);
    fetchFile(cid, gitRef, path).then((res) => {
      if (myToken !== fileToken.current) return;
      setFileLoading(false);
      if (!res.ok) { setFileError(res.error); setFilePayload(null); return; }
      setFileError(null);
      setFilePayload(res.data);
    });
  }, [cid, gitRef, path]);

  // ---- search (debounced; names filters paths, contents shows match lines)
  useEffect(() => {
    const q = debouncedQuery.trim();
    if (!q) { setSearchResults(null); setSearchError(null); setSearchLoading(false); return; }
    const myToken = ++searchToken.current;
    setSearchLoading(true);
    fetchSearch(cid, gitRef, q, searchMode).then((res) => {
      if (myToken !== searchToken.current) return;
      setSearchLoading(false);
      if (!res.ok) { setSearchError(res.error); setSearchResults(null); return; }
      setSearchError(null);
      setSearchResults(res.data.results || []);
      setDefaultBranchOnly(!!res.data.default_branch_only);
    });
  }, [cid, gitRef, debouncedQuery, searchMode]);

  const selectFile = useCallback((p: string, line?: number) => {
    onNavigate({ path: p });
    if (line != null) {
      // jump to line once the pane renders it (see the effect below)
      pendingLineRef.current = line;
    }
  }, [onNavigate]);

  const pendingLineRef = useRef<number | null>(null);
  useEffect(() => {
    if (filePayload && pendingLineRef.current != null) {
      const ln = pendingLineRef.current;
      pendingLineRef.current = null;
      const el = document.querySelector(`[data-browse-line="${ln}"]`);
      if (el) el.scrollIntoView({ block: "center" });
    }
  }, [filePayload]);

  const htmlUrl = htmlUrlBase && path ? `${htmlUrlBase}/blob/${encodeURIComponent(gitRef)}/${path}` : htmlUrlBase;

  return (
    <div className="rb-wrap">
      <div className="rb-side">
        <div className="rb-search">
          <div className="rb-search-tabs" role="tablist" aria-label="Search mode">
            <button
              type="button"
              role="tab"
              aria-selected={searchMode === "names"}
              className={"rb-search-tab" + (searchMode === "names" ? " on" : "")}
              onClick={() => setSearchMode("names")}
            >
              Names
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={searchMode === "contents"}
              className={"rb-search-tab" + (searchMode === "contents" ? " on" : "")}
              onClick={() => setSearchMode("contents")}
            >
              Contents
            </button>
          </div>
          <input
            className="rb-search-in"
            type="search"
            placeholder={searchMode === "names" ? "Search file paths…" : "Search file contents…"}
            spellCheck={false}
            autoComplete="off"
            value={query}
            aria-label="Search repo files"
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        <div className="rb-tree-scroll">
          {query.trim() ? (
            <SearchResults
              loading={searchLoading}
              error={searchError}
              results={searchResults}
              defaultBranchOnly={defaultBranchOnly}
              onPick={selectFile}
            />
          ) : (
            <Tree rows={rows} dirCache={dirCache} expanded={expanded} selectedPath={path} onToggleDir={toggleDir} onSelectFile={(p) => selectFile(p)} />
          )}
        </div>
      </div>

      <div className="rb-main">
        <ContentPane
          gitRef={gitRef}
          path={path}
          loading={fileLoading}
          error={fileError}
          payload={filePayload}
          htmlUrl={htmlUrl}
        />
      </div>
    </div>
  );
}

/* ---- tree rendering (FilesChanged's .dfv-* row idiom, browse-scoped) ------ */
function Tree({
  rows,
  dirCache,
  expanded,
  selectedPath,
  onToggleDir,
  onSelectFile,
}: {
  rows: TreeRow[];
  dirCache: Record<string, DirState>;
  expanded: Set<string>;
  selectedPath: string;
  onToggleDir: (path: string) => void;
  onSelectFile: (path: string) => void;
}) {
  const root = dirCache[""];
  if (root && root.loading && !root.entries) return <BrowseSkeletonRows />;
  if (root && root.error) return <BrowseErrorBody err={root.error} what="Repository" />;
  if (!rows.length) return <div className="none" style={{ padding: 14 }}>No files.</div>;
  return (
    <div className="dfv-tree rb-dfv-tree">
      {rows.map((r) => {
        const isDir = r.entry.type === "dir";
        const open = expanded.has(r.entry.path);
        if (isDir) {
          const state = dirCache[r.entry.path];
          return (
            <div key={"d:" + r.entry.path}>
              <div
                className="dfv-r dfv-dir"
                style={{ paddingLeft: 10 + r.depth * 14 }}
                title={r.entry.path}
                onClick={() => onToggleDir(r.entry.path)}
              >
                <span className="dfv-c">{open ? "▾" : "▸"}</span>
                <DirIcon />
                <span className="dfv-nm">{r.entry.name}</span>
              </div>
              {open && state && state.loading && !state.entries ? (
                <div style={{ paddingLeft: 24 + r.depth * 14 }} className="rb-dir-loading muted">Loading…</div>
              ) : null}
              {open && state && state.error ? (
                <div style={{ paddingLeft: 24 + r.depth * 14 }} className="rb-dir-loading muted">Couldn&#39;t load this folder.</div>
              ) : null}
            </div>
          );
        }
        return (
          <div
            key={"f:" + r.entry.path}
            className={"dfv-r dfv-f" + (r.entry.path === selectedPath ? " on" : "")}
            style={{ paddingLeft: 24 + r.depth * 14 }}
            title={r.entry.path}
            onClick={() => onSelectFile(r.entry.path)}
          >
            <FileIcon />
            <span className="dfv-nm">{r.entry.name}</span>
          </div>
        );
      })}
    </div>
  );
}

const DirIcon = () => (
  <svg className="dfv-i" viewBox="0 0 16 16" width={14} height={14} fill="currentColor">
    <path d="M1.75 2.5h4.19l1.55 1.5h6.76c.69 0 1.25.56 1.25 1.25v7c0 .69-.56 1.25-1.25 1.25H1.75c-.69 0-1.25-.56-1.25-1.25v-8.5c0-.69.56-1.25 1.25-1.25Z" />
  </svg>
);
const FileIcon = () => (
  <svg className="dfv-i" viewBox="0 0 16 16" width={14} height={14} fill="none" stroke="currentColor" strokeWidth={1.3}>
    <path d="M3.5 1.75h6l3 3v9.5a1 1 0 0 1-1 1h-8a1 1 0 0 1-1-1V2.75a1 1 0 0 1 1-1Z" />
    <path d="M9.5 1.75v3h3" />
  </svg>
);

/* ---- search results -------------------------------------------------------- */
function SearchResults({
  loading,
  error,
  results,
  defaultBranchOnly,
  onPick,
}: {
  loading: boolean;
  error: GhError | null;
  results: (BrowseNameResult | BrowseContentResult)[] | null;
  defaultBranchOnly: boolean;
  onPick: (path: string, line?: number) => void;
}) {
  if (loading && !results) return <BrowseSkeletonRows />;
  if (error) return <BrowseErrorBody err={error} what="Search" />;
  if (!results || !results.length) return <div className="none" style={{ padding: 14 }}>No matches.</div>;
  return (
    <div className="rb-search-results">
      {defaultBranchOnly ? (
        <div className="rb-search-note muted">Contents search runs against the default branch only.</div>
      ) : null}
      {results.map((r) =>
        isContentResult(r) ? (
          <div key={r.path} className="rb-result-file">
            <div className="rb-result-path mono" title={r.path} onClick={() => onPick(r.path)}>
              <FileIcon /> {r.path}
            </div>
            {r.matches.map((m, i) => (
              <div key={i} className="rb-result-match" onClick={() => onPick(r.path, m.line)}>
                <span className="rb-result-line mono">{m.line}</span>
                <span className="rb-result-text mono">{m.text}</span>
              </div>
            ))}
          </div>
        ) : (
          <div key={r.path} className="rb-result-name mono" title={r.path} onClick={() => onPick(r.path)}>
            {r.type === "dir" ? <DirIcon /> : <FileIcon />} {r.path}
          </div>
        ),
      )}
    </div>
  );
}

/* ---- content pane: sticky header + line-numbered, tokenized content ------- */
function ContentPane({
  gitRef,
  path,
  loading,
  error,
  payload,
  htmlUrl,
}: {
  gitRef: string;
  path: string;
  loading: boolean;
  error: GhError | null;
  payload: BrowseFilePayload | null;
  htmlUrl?: string | null;
}) {
  if (!path) {
    return <div className="rb-empty-pane muted">Select a file to view its contents.</div>;
  }
  if (loading && !payload) return <BrowseSkeletonPane />;
  if (error) return <BrowseErrorBody err={error} what="File" />;
  if (!payload) return <BrowseSkeletonPane />;

  return (
    <>
      <div className="rb-file-head">
        <span className="tag rb-ref-chip mono">{gitRef}</span>
        <span className="rb-file-path mono" title={payload.path}>{payload.path}</span>
        <span className="rb-file-size muted">{formatSize(payload.size)}</span>
      </div>
      {payload.binary ? (
        <div className="rb-binary muted">
          Binary file not shown.
          {htmlUrl ? <> <a href={htmlUrl} target="_blank" rel="noopener noreferrer">View on GitHub <Icon name="ext" cls="gl" /></a></> : null}
        </div>
      ) : (
        <>
          {payload.truncated ? (
            <div className="rb-truncated-note muted">
              File truncated — showing a partial view.
              {htmlUrl ? <> <a href={htmlUrl} target="_blank" rel="noopener noreferrer">View on GitHub <Icon name="ext" cls="gl" /></a></> : null}
            </div>
          ) : null}
          <CodeLines content={payload.content ?? ""} path={payload.path} />
        </>
      )}
    </>
  );
}

function CodeLines({ content, path }: { content: string; path: string }) {
  // defensive: a malformed/partial payload (e.g. content missing) renders as
  // an empty file rather than crashing the page.
  const lines = useMemo(() => (typeof content === "string" ? content.split("\n") : []), [content]);
  return (
    <div className="rb-code mono">
      {lines.map((line, i) => {
        const lineNo = i + 1;
        const tokens: Token[] = highlightLine(line, path);
        return (
          <div key={lineNo} className="rb-line" data-browse-line={lineNo}>
            <span className="rb-lineno">{lineNo}</span>
            <span className="rb-line-text">
              {tokens.length
                ? tokens.map((t, ti) => (
                    <span key={ti} className={t.kind === "plain" ? undefined : "rb-tok-" + t.kind}>
                      {t.text}
                    </span>
                  ))
                : " "}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}
