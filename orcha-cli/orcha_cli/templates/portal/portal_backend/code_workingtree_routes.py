"""Working-tree changes + file history — Orcha Cloud local run, agentic-era IDE
features (docs/orcha-cloud-local-run.md addendum, Part B): "what have agents changed
that isn't committed yet" and "how did this file get here". Both are LOCAL-BINDING
ONLY — a GitHub-bound container has no working tree to read (the portal never clones
a GitHub repo to disk) and no meaningful uncommitted-changes concept, so every route
here degrades honestly to `{available:false, reason:"github_source"}` rather than
error, exactly like `github_hub_routes._local_source_unavailable`'s mirror-image
degrade for the hub surface.

Endpoints (all GETs, all gated exactly like the browse routes — membership via
`github_repo_browse_routes._load_binding`, which itself 400s a bad UUID and 403s a
trusted non-member of a MAPPED container):

  GET .../code/worktree/changes         — dirty-tree summary: every changed file
                                           (tracked + untracked) with per-file +/-
                                           counts and a repo-wide summary.
  GET .../code/worktree/diff?path=      — one file's unified diff text.
  GET .../code/file/history?path=&ref=&n= — commits that touched one file (`--follow`).

All three build on `portal_backend.local_git`'s working-tree helpers
(status_porcelain/diff_numstat/diff_unified/log_follow) — this module owns ONLY the
route/membership/shape layer, no git subprocess calls of its own; every git failure
mode already degrades to None/[] inside `local_git`, so the route layer's job is
purely: gate membership, branch on local-vs-github, shape the response, cap the diff.
"""

from fastapi import HTTPException, Query, Request

from portal_backend import local_git
from portal_backend.application import app
from portal_backend.database import db_cursor
from portal_backend.github_repo_browse_routes import LOCAL_REPO, _load_binding

# Unified diff text is capped the same spirit as browse/file's FILE_CONTENT_CAP_BYTES —
# an oversized diff is truncated with a marker, never silently dropped or left to blow
# up a response. ~200KB per the design doc.
WORKTREE_DIFF_MAX_BYTES = local_git.WORKTREE_DIFF_MAX_BYTES

# File-history default page size when the caller omits `n`.
DEFAULT_HISTORY_N = 20
# A hard ceiling on `n` regardless of what the caller asks for — mirrors every other
# bounded-list route in this portal (NAMES_SEARCH_MAX_RESULTS, GREP_MAX_RESULTS, …).
MAX_HISTORY_N = 200


def _github_source_unavailable() -> dict:
    """The container is bound to a real GitHub repo — working-tree/history surfaces
    have nothing to show there (the portal never checks out a GitHub repo to disk).
    Distinct `reason` ("github_source") from the hub's own "local_source" degrade
    (github_hub_routes._local_source_unavailable) since this is the EXACT MIRROR
    IMAGE: that one fires when local has no GitHub equivalent, this one fires when
    GitHub has no local-filesystem equivalent."""
    return {
        "available": False, "reason": "github_source",
        "detail": "working-tree changes and file history need a local repository — "
                   "this project is bound to a GitHub repo",
    }


def _require_local_binding(cur, cid: str, request: Request):
    """Shared preamble for every route below: validate + gate membership via the SAME
    `_load_binding` the browse routes use, then classify the bound repo into one of
    three shapes the caller handles: (True, None) — bound to local, proceed; (False,
    not_connected_payload) — no repo bound at all; (False, github_source_payload) —
    bound to a real GitHub repo. Returns (is_local: bool, degrade_payload: dict|None)
    so callers write `ok, degrade = _require_local_binding(...); if not ok: return
    degrade`, matching the browse routes' own `if not repo: return _not_connected()`
    idiom."""
    repo = _load_binding(cur, cid, request)
    if not repo:
        return False, {
            "available": False, "reason": "repo_not_connected",
            "detail": "no GitHub repo is connected to this project",
        }
    if repo != LOCAL_REPO:
        return False, _github_source_unavailable()
    return True, None


@app.get("/api/containers/{cid}/code/worktree/changes")
def get_worktree_changes(cid: str, request: Request):
    """The dirty working tree, summarized: every file that differs from HEAD (tracked
    modifications/adds/deletes/renames) PLUS every untracked file, each with its own
    +/- line counts, plus a repo-wide `summary`.

    Returns {available, dirty, files:[{path, status:"M"|"A"|"D"|"R"|"??",
    additions?, deletions?}], summary:{files, additions, deletions}}. `dirty` is
    `bool(files)` — a clean tree returns `available:true, dirty:false, files:[]`,
    the frontend's cue for "Working tree clean — everything is committed." `additions`/
    `deletions` are omitted (None) for a binary file, mirroring `local_git.diff_numstat`'s
    own binary handling (git's numstat prints "-" for a binary file's counts — never
    fabricated). Local-binding only; a GitHub-bound or unbound container gets the
    honest {available:false,...} degrade instead of a 404/500.
    """
    with db_cursor() as (_, cur):
        is_local, degrade = _require_local_binding(cur, cid, request)
    if not is_local:
        return degrade
    status_entries = local_git.status_porcelain()
    if status_entries is None:
        return {
            "available": False, "reason": "git_error",
            "detail": "could not read working-tree status from the local repository",
        }
    numstat_entries = local_git.diff_numstat() or []
    counts_by_path = {e["path"]: e for e in numstat_entries}
    files = []
    total_additions = 0
    total_deletions = 0
    for entry in status_entries:
        path = entry["path"]
        counts = counts_by_path.get(path, {})
        additions = counts.get("additions")
        deletions = counts.get("deletions")
        if additions is not None:
            total_additions += additions
        if deletions is not None:
            total_deletions += deletions
        row = {"path": path, "status": entry["status"], "additions": additions, "deletions": deletions}
        if entry["status"] == "R" and entry.get("orig_path"):
            row["orig_path"] = entry["orig_path"]
        files.append(row)
    return {
        "available": True,
        "dirty": bool(files),
        "files": files,
        "summary": {"files": len(files), "additions": total_additions, "deletions": total_deletions},
    }


@app.get("/api/containers/{cid}/code/worktree/diff")
def get_worktree_diff(cid: str, request: Request, path: str = Query(...)):
    """One file's unified diff against HEAD (or, for an untracked file, the
    synthesized whole-file-add form against `/dev/null` — see
    `local_git.diff_unified`'s docstring). Returns {path, diff, binary}. A binary
    file's diff is never decoded/rendered as text — `binary:true` with `diff` set to
    git's own short "Binary files a/... and b/... differ" summary line (or the
    `--no-index` equivalent for an untracked binary), matching how a `git diff` a
    human runs at a terminal already reads for a binary change, rather than inventing
    a separate placeholder string. Capped at WORKTREE_DIFF_MAX_BYTES with a truncation
    marker appended — never silently dropped. Local-binding only.
    """
    clean_path = (path or "").strip("/")
    if not clean_path:
        raise HTTPException(400, "path is required")
    with db_cursor() as (_, cur):
        is_local, degrade = _require_local_binding(cur, cid, request)
    if not is_local:
        return degrade
    diff_text = local_git.diff_unified(clean_path)
    if diff_text is None:
        return {
            "available": False, "reason": "not_found",
            "detail": f"path {clean_path!r} could not be diffed in the local repository",
        }
    binary = "Binary files " in diff_text and "\n+" not in diff_text and "\n-" not in diff_text
    truncated = False
    if len(diff_text.encode("utf-8", errors="ignore")) > WORKTREE_DIFF_MAX_BYTES:
        # Truncate on a UTF-8-safe boundary: encode, slice, decode-with-ignore drops
        # any trailing partial multibyte sequence rather than raising.
        diff_text = diff_text.encode("utf-8", errors="ignore")[:WORKTREE_DIFF_MAX_BYTES].decode(
            "utf-8", errors="ignore")
        diff_text += "\n\n… diff truncated (exceeds the display cap) …\n"
        truncated = True
    return {"available": True, "path": clean_path, "diff": diff_text, "binary": binary, "truncated": truncated}


@app.get("/api/containers/{cid}/code/file/history")
def get_file_history(
    cid: str, request: Request,
    path: str = Query(...), ref: str = Query(default=""), n: int = Query(default=DEFAULT_HISTORY_N),
):
    """The commits that touched `path` (`git log --follow`, newest first), local-
    binding only — GitHub-bound containers get the same honest
    {available:false, reason:"github_source"} degrade every route in this module
    uses; there is no cheap GitHub equivalent (the commits-for-a-path API exists but
    is a whole separate integration this module deliberately does not add — see the
    design doc's "GitHub-only surfaces degrade honestly" principle).

    Returns {available, commits:[{sha, short, summary, author, committed_at}]}. `n`
    is clamped to [1, MAX_HISTORY_N] (a caller-supplied 0/negative/huge value never
    reaches git). `ref` defaults to HEAD like every other ref param in this portal.
    """
    clean_path = (path or "").strip("/")
    if not clean_path:
        raise HTTPException(400, "path is required")
    n_clamped = max(1, min(n, MAX_HISTORY_N))
    with db_cursor() as (_, cur):
        is_local, degrade = _require_local_binding(cur, cid, request)
    if not is_local:
        return degrade
    commits = local_git.log_follow(clean_path, ref or None, n_clamped)
    if commits is None:
        return {
            "available": False, "reason": "not_found",
            "detail": f"could not resolve ref {ref!r} or path {clean_path!r} in the local repository",
        }
    return {"available": True, "path": clean_path, "commits": commits}
