/**
 * Working-tree changes + file history — fetch wrappers over
 * code_workingtree_routes.py's CONTRACT (docs/orcha-cloud-local-run.md
 * addendum, agentic-era IDE features). Local-binding only; every route
 * degrades honestly to {available:false, reason:"github_source"} on a
 * GitHub-bound container — callers render that as "hidden" (History) or a
 * disabled-state card (Changes tab), never an error.
 *
 *   GET /api/containers/{cid}/code/worktree/changes
 *   GET /api/containers/{cid}/code/worktree/diff?path=
 *   GET /api/containers/{cid}/code/file/history?path=&ref=&n=
 */
export type WorktreeFileStatus = "M" | "A" | "D" | "R" | "??";

export interface WorktreeChangedFile {
  path: string;
  status: WorktreeFileStatus;
  additions: number | null;
  deletions: number | null;
  orig_path?: string | null;
}

export interface WorktreeChangesSummary {
  files: number;
  additions: number;
  deletions: number;
}

export interface WorktreeChangesPayload {
  available: boolean;
  reason?: string;
  detail?: string;
  dirty?: boolean;
  files?: WorktreeChangedFile[];
  summary?: WorktreeChangesSummary;
}

export interface WorktreeDiffPayload {
  available: boolean;
  reason?: string;
  detail?: string;
  path?: string;
  diff?: string;
  binary?: boolean;
  truncated?: boolean;
}

export interface FileHistoryCommit {
  sha: string;
  short: string;
  summary: string;
  author: string;
  committed_at: string;
}

export interface FileHistoryPayload {
  available: boolean;
  reason?: string;
  detail?: string;
  path?: string;
  commits?: FileHistoryCommit[];
}

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url);
  return (await r.json()) as T;
}

export function fetchWorktreeChanges(cid: string): Promise<WorktreeChangesPayload> {
  return getJson<WorktreeChangesPayload>(
    "/api/containers/" + encodeURIComponent(cid) + "/code/worktree/changes",
  );
}

export function fetchWorktreeDiff(cid: string, path: string): Promise<WorktreeDiffPayload> {
  const q = new URLSearchParams({ path });
  return getJson<WorktreeDiffPayload>(
    "/api/containers/" + encodeURIComponent(cid) + "/code/worktree/diff?" + q.toString(),
  );
}

export function fetchFileHistory(
  cid: string,
  path: string,
  opts: { ref?: string; n?: number } = {},
): Promise<FileHistoryPayload> {
  const q = new URLSearchParams({ path });
  if (opts.ref) q.set("ref", opts.ref);
  if (opts.n != null) q.set("n", String(opts.n));
  return getJson<FileHistoryPayload>(
    "/api/containers/" + encodeURIComponent(cid) + "/code/file/history?" + q.toString(),
  );
}
