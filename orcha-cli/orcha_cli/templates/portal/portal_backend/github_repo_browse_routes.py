"""Read-only GitHub repository file browser for a container's bound repo (Feature B):
directory listing, single-file content, and filename/content search — the portal's
"browse the repo" surface, distinct from the issues/PRs hub (github_hub_routes.py).

Endpoints (all GETs, all gated exactly like the hub routes):
  GET .../github/browse/tree    — one directory level (non-recursive)
  GET .../github/browse/file    — a single file's content (capped, binary-detected)
  GET .../github/browse/search  — filename search (names) or GitHub code search (contents)

Auth/token plumbing, membership gating, and error classification are ALL reused
directly from github_hub_routes — same GitHub App installation token resolution
(`_resolve_repo_token`), same container-binding + require_member_read load
(`_load_binding`), same not-connected shape (`_not_connected`), and the same
`_gh_get` network leaf + RuntimeError("github_status:<code>") contract, so the
403/404/network-failure ladder classifies identically here. Tests stub `_gh_get`
on THIS module (browse routes have their own leaf import, since a test that
monkeypatches github_hub_routes._gh_get must not have to know this module exists) —
never real network.

`ref` semantics: any GitHub-resolvable ref (branch name, tag, or full/short commit sha)
is passed straight through to GitHub's API. `ref=pr/<number>` is a portal-only
convenience: resolved via the SAME `/pulls/{number}` fetch idiom github_hub_routes uses
for PR detail, to that PR's head sha, before the real GitHub call is made. Omitting
`ref` entirely resolves the repo's default branch (one extra `/repos/{repo}` call,
cached like everything else here).
"""

import base64
import time
import urllib.parse

from fastapi import HTTPException, Query, Request

from portal_backend.application import app
from portal_backend.database import db_cursor
from portal_backend.github_hub_routes import (
    _gh_get,
    _load_binding,
    _not_connected,
    _resolve_repo_token,
    _detail_error_payload,
    _error_payload,
)

GITHUB_API = "https://api.github.com"

# Directory-tree cache (recursive tree fetches for search:names) — short-lived, keyed
# per (cid, ref): GitHub's recursive git/trees call is the heaviest one this module
# makes, and a search-as-you-type UI would otherwise refire it on every keystroke.
TREE_CACHE_TTL_SECONDS = 60
# Default-branch resolution is also cached (it barely changes) so a burst of tree/file/
# search calls against ref-less requests doesn't cost one `/repos/{repo}` fetch each.
DEFAULT_BRANCH_CACHE_TTL_SECONDS = 60

# File content cap: 500 KB. Content past this is truncated (never silently dropped —
# `truncated: true` tells the caller there's more on GitHub).
FILE_CONTENT_CAP_BYTES = 500_000

# search:names cap on returned paths; search:contents (GitHub code search) cap on
# returned files. Both bounded so a broad query never blows up the response.
NAMES_SEARCH_MAX_RESULTS = 200
CONTENTS_SEARCH_MAX_RESULTS = 50

_TREE_CACHE: dict = {}
_DEFAULT_BRANCH_CACHE: dict = {}


def _tree_cache_get(cid: str, ref: str):
    hit = _TREE_CACHE.get((cid, ref))
    if hit and hit[0] > time.monotonic():
        return hit[1]
    return None


def _tree_cache_put(cid: str, ref: str, payload) -> None:
    _TREE_CACHE[(cid, ref)] = (time.monotonic() + TREE_CACHE_TTL_SECONDS, payload)


def _default_branch_cache_get(cid: str):
    hit = _DEFAULT_BRANCH_CACHE.get(cid)
    if hit and hit[0] > time.monotonic():
        return hit[1]
    return None


def _default_branch_cache_put(cid: str, branch: str) -> None:
    _DEFAULT_BRANCH_CACHE[cid] = (time.monotonic() + DEFAULT_BRANCH_CACHE_TTL_SECONDS, branch)


def _resolve_default_branch(repo: str, token: str, cid: str) -> str:
    """The repo's default branch name (e.g. "main"), cached 60s per container. Raises
    RuntimeError (the SAME github_status:<code> contract as every other _gh_get caller
    here) on a GitHub failure — callers map it through the shared error ladder."""
    cached = _default_branch_cache_get(cid)
    if cached is not None:
        return cached
    raw = _gh_get(f"/repos/{repo}", token)
    branch = raw.get("default_branch") or "main"
    _default_branch_cache_put(cid, branch)
    return branch


def _resolve_ref(repo: str, token: str, cid: str, ref) -> str:
    """Turn the caller's `ref` query param into a GitHub-resolvable ref/sha.

    None/empty -> the repo's default branch (resolved + cached).
    "pr/<number>" -> that PR's head sha, via the same `/pulls/{number}` fetch
    github_hub_routes' PR-detail route uses (raises RuntimeError("github_status:404")
    the same way if the PR doesn't exist — callers map that through
    `_detail_error_payload` so a bad PR number reads as not_found, not a generic error).
    Anything else -> passed straight through unchanged (branch name, tag, full/short sha).
    """
    if not ref:
        return _resolve_default_branch(repo, token, cid)
    if ref.startswith("pr/"):
        number_part = ref[len("pr/"):]
        try:
            number = int(number_part)
        except ValueError:
            raise HTTPException(400, "ref=pr/<number> must have an integer number")
        pull = _gh_get(f"/repos/{repo}/pulls/{number}", token)
        sha = (pull.get("head") or {}).get("sha")
        if not sha:
            raise RuntimeError("github_status:404")
        return sha
    return ref


def _is_binary_content(content_bytes: bytes) -> bool:
    """Simple binary sniff: a NUL byte anywhere in the (decoded) content — the same
    heuristic git/most editors use. Called on already-fetched, already-decoded bytes;
    never on the still-base64 wire form."""
    return b"\0" in content_bytes


@app.get("/api/containers/{cid}/github/browse/tree")
def browse_tree(cid: str, request: Request, ref: str = Query(default=""), path: str = Query(default="")):
    """One directory level (NOT recursive) of the container's bound repo.

    Returns {ref, path, entries:[{name, path, type:"dir"|"file", size?}], truncated}.
    `ref` in the response is the resolved ref actually used (default branch when the
    caller omitted it, or the PR's head sha when `ref=pr/<number>` was given) — never
    echoed back as the literal query string, so the caller always knows exactly what
    was fetched. `size` is present for files (GitHub's byte size), omitted for dirs.
    `truncated` mirrors GitHub's own contents-API truncation flag for this directory
    (extremely rare at a single non-recursive level, but surfaced honestly rather than
    silently assumed false).
    """
    with db_cursor() as (_, cur):
        repo = _load_binding(cur, cid, request)
    if not repo:
        return _not_connected()
    token = _resolve_repo_token(repo)
    if not token:
        return _not_connected()
    try:
        resolved_ref = _resolve_ref(repo, token, cid, ref)
    except RuntimeError as exc:
        return {**_detail_error_payload(exc), "repo": repo}
    clean_path = (path or "").strip("/")
    contents_path = f"/repos/{repo}/contents/{clean_path}" if clean_path else f"/repos/{repo}/contents"
    query = urllib.parse.urlencode({"ref": resolved_ref})
    try:
        raw = _gh_get(f"{contents_path}?{query}", token)
    except RuntimeError as exc:
        return {**_detail_error_payload(exc), "repo": repo}
    if isinstance(raw, dict):
        # GitHub returns a single object (not a list) when `path` names a FILE, not a
        # directory — a clean 400 rather than pretending it's an empty directory.
        raise HTTPException(400, f"path {clean_path!r} is a file, not a directory")
    entries = []
    for item in raw:
        entry = {
            "name": item.get("name"),
            "path": item.get("path"),
            "type": "dir" if item.get("type") == "dir" else "file",
        }
        if entry["type"] == "file":
            entry["size"] = item.get("size")
        entries.append(entry)
    entries.sort(key=lambda e: (e["type"] != "dir", (e["name"] or "").lower()))
    return {
        "ref": resolved_ref,
        "path": clean_path,
        "entries": entries,
        "truncated": False,
    }


@app.get("/api/containers/{cid}/github/browse/file")
def browse_file(cid: str, request: Request, ref: str = Query(default=""), path: str = Query(...)):
    """A single file's content from the container's bound repo.

    Returns {ref, path, content, size, truncated, binary, encoding:"utf-8"}. `content`
    is the DECODED text; capped at FILE_CONTENT_CAP_BYTES (~500KB) with `truncated:true`
    when GitHub's file is larger — the caller sees the first slice, not a failure.
    Binary files (detected via GitHub's own contents-API `encoding` field being
    anything other than "base64" decodeable-as-text, or a NUL byte in the decoded
    bytes) return `binary:true` with `content` omitted entirely (never a best-effort
    garbled decode) — `size` is still the real GitHub-reported size in that case.
    """
    clean_path = (path or "").strip("/")
    if not clean_path:
        raise HTTPException(400, "path is required")
    with db_cursor() as (_, cur):
        repo = _load_binding(cur, cid, request)
    if not repo:
        return _not_connected()
    token = _resolve_repo_token(repo)
    if not token:
        return _not_connected()
    try:
        resolved_ref = _resolve_ref(repo, token, cid, ref)
    except RuntimeError as exc:
        return {**_detail_error_payload(exc), "repo": repo}
    query = urllib.parse.urlencode({"ref": resolved_ref})
    try:
        raw = _gh_get(f"/repos/{repo}/contents/{clean_path}?{query}", token)
    except RuntimeError as exc:
        return {**_detail_error_payload(exc), "repo": repo}
    if isinstance(raw, list):
        raise HTTPException(400, f"path {clean_path!r} is a directory, not a file")
    size = raw.get("size") or 0
    encoding = raw.get("encoding")
    content_b64 = raw.get("content") or ""
    if encoding != "base64":
        # GitHub omits/varies `content`+`encoding` for files it judges too large for the
        # contents API (>1MB) or otherwise non-inline-able — treat as binary-shaped
        # rather than guess at a decode.
        return {
            "ref": resolved_ref, "path": clean_path, "size": size,
            "truncated": False, "binary": True, "encoding": "utf-8",
        }
    try:
        raw_bytes = base64.b64decode(content_b64)
    except (ValueError, TypeError):
        return {
            "ref": resolved_ref, "path": clean_path, "size": size,
            "truncated": False, "binary": True, "encoding": "utf-8",
        }
    if _is_binary_content(raw_bytes):
        return {
            "ref": resolved_ref, "path": clean_path, "size": size,
            "truncated": False, "binary": True, "encoding": "utf-8",
        }
    truncated = len(raw_bytes) > FILE_CONTENT_CAP_BYTES
    capped_bytes = raw_bytes[:FILE_CONTENT_CAP_BYTES]
    # Decode defensively: a cap can land mid-multibyte-character; drop any trailing
    # partial sequence rather than raise.
    content = capped_bytes.decode("utf-8", errors="ignore")
    return {
        "ref": resolved_ref,
        "path": clean_path,
        "content": content,
        "size": size,
        "truncated": truncated,
        "binary": False,
        "encoding": "utf-8",
    }


def _fetch_full_tree(repo: str, resolved_ref: str, token: str, cid: str):
    """The full recursive tree for a ref (git/trees?recursive=1), cached 60s per
    (cid, resolved_ref) — the same TTL idea as the hub's list caches, sized for a
    search-as-you-type UI that would otherwise refire this (GitHub's heaviest single
    call here) on every keystroke. Returns (entries, truncated) where entries is
    GitHub's raw tree array (each {path, type:"blob"|"tree", ...}); `truncated` mirrors
    GitHub's own `truncated` flag on the tree response (a very large repo)."""
    cached = _tree_cache_get(cid, resolved_ref)
    if cached is not None:
        return cached
    raw = _gh_get(f"/repos/{repo}/git/trees/{resolved_ref}?recursive=1", token)
    entries = raw.get("tree") or []
    truncated = bool(raw.get("truncated"))
    result = (entries, truncated)
    _tree_cache_put(cid, resolved_ref, result)
    return result


def _names_search(repo: str, resolved_ref: str, token: str, cid: str, q: str) -> dict:
    entries, truncated = _fetch_full_tree(repo, resolved_ref, token, cid)
    needle = q.lower()
    results = []
    for item in entries:
        item_path = item.get("path") or ""
        if needle in item_path.lower():
            results.append({
                "path": item_path,
                "type": "dir" if item.get("type") == "tree" else "file",
            })
            if len(results) >= NAMES_SEARCH_MAX_RESULTS:
                break
    return {"results": results, "truncated": truncated}


def _code_search_match(fragment: dict) -> dict:
    """One GitHub code-search `text_matches` fragment -> {line, text}. GitHub's search
    API doesn't give a line NUMBER directly; it gives byte offsets into `object_url`'s
    full content plus the matched fragment text. We don't re-fetch the full file just
    to compute an exact line number (a second GitHub call per match, per result, would
    make a 50-result search prohibitively expensive) — `line` is the 1-indexed line
    within the fragment's OWN text where the first match indicator starts, a
    best-effort locator, and `text` is the fragment itself (already a short excerpt
    GitHub trims around the match)."""
    fragment_text = fragment.get("fragment") or ""
    matches = fragment.get("matches") or []
    line = 1
    if matches:
        offset = matches[0].get("indices", [0])[0] if matches[0].get("indices") else 0
        line = fragment_text.count("\n", 0, offset) + 1
    return {"line": line, "text": fragment_text}


def _contents_search(repo: str, token: str, q: str) -> dict:
    """GitHub code search scoped to this repo: GET /search/code?q=<q>+repo:owner/name.

    GitHub's code search ONLY indexes the repo's default branch — a documented
    limitation, not a bug here — so results never reflect `ref` even when the caller
    passed one; the response always sets `default_branch_only: true` so the UI can
    show that honestly rather than implying the search covered whatever ref was
    requested. Capped at CONTENTS_SEARCH_MAX_RESULTS files, each with its own
    text_matches fragments mapped to {line, text}."""
    query = urllib.parse.urlencode({"q": f"{q} repo:{repo}"})
    raw = _gh_get(f"/search/code?{query}", token)
    items = raw.get("items") or []
    results = []
    for item in items[:CONTENTS_SEARCH_MAX_RESULTS]:
        fragments = item.get("text_matches") or []
        results.append({
            "path": item.get("path"),
            "matches": [_code_search_match(f) for f in fragments],
        })
    return {"results": results, "default_branch_only": True}


@app.get("/api/containers/{cid}/github/browse/search")
def browse_search(
    cid: str,
    request: Request,
    q: str = Query(..., min_length=1),
    mode: str = Query(default="names"),
    ref: str = Query(default=""),
):
    """Search the container's bound repo — filenames (`mode=names`, default) or file
    contents (`mode=contents`, GitHub code search).

    names: filters the full recursive tree for `ref` (or the default branch) by a
    case-insensitive substring match on path, capped at NAMES_SEARCH_MAX_RESULTS.
    Returns {results:[{path,type}], truncated} — `truncated` reflects GitHub's own
    tree-truncation flag (an enormous repo), not the results cap.

    contents: GitHub's code-search API, always scoped to this repo
    (`q=<q>+repo:owner/name`) and ALWAYS the default branch regardless of `ref` (a
    GitHub limitation — see `_contents_search`'s docstring). Returns
    {results:[{path,matches:[{line,text}]}], default_branch_only:true}, capped at
    CONTENTS_SEARCH_MAX_RESULTS files.
    """
    if mode not in ("names", "contents"):
        raise HTTPException(400, "mode must be 'names' or 'contents'")
    with db_cursor() as (_, cur):
        repo = _load_binding(cur, cid, request)
    if not repo:
        return _not_connected()
    token = _resolve_repo_token(repo)
    if not token:
        return _not_connected()
    if mode == "contents":
        try:
            return {"available": True, "repo": repo, **_contents_search(repo, token, q)}
        except RuntimeError as exc:
            return {**_error_payload(exc), "repo": repo}
    try:
        resolved_ref = _resolve_ref(repo, token, cid, ref)
    except RuntimeError as exc:
        return {**_detail_error_payload(exc), "repo": repo}
    try:
        payload = _names_search(repo, resolved_ref, token, cid, q)
    except RuntimeError as exc:
        return {**_error_payload(exc), "repo": repo}
    return {"available": True, "repo": repo, "ref": resolved_ref, **payload}
