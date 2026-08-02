"""The GitHub hub: a container's connected repo's open issues + PRs (lists AND per-item
detail), and one-click "Start" that turns an issue/PR into an Orcha task (Feature A).

Endpoints (all GETs share the SAME grant model; the two writes are only /start):
  GET  .../github/issues            — open issues (list)
  GET  .../github/pulls             — open PRs (list)
  GET  .../github/pulls/{number}    — one PR's full detail (PR detail page)
  GET  .../github/issues/{number}   — one issue's full detail (issue detail page)
  POST .../github/start             — issue/PR -> Orcha task
The detail GETs are READ-ONLY: no approve/close/rerun write endpoints — deliberate; the
portal's only GitHub action stays Start.

Auth/token plumbing is SHARED with github_routes.py — the same GitHub App INSTALLATION
token the host-side refresh timer maintains (never a personal token). For a container's
bound `owner/name` repo we resolve the installation token for `owner` from the multi-org
token map, falling back to the legacy single-token file, exactly as github_routes does.

Network calls go through small monkeypatchable leaf functions (`_gh_get`) — tests stub
that leaf and NEVER hit live GitHub (mirroring github_routes._fetch_installation_repos).

A tiny in-module TTL cache (60s) shields GitHub's rate limit from the portal's polling UI:
lists keyed per (cid, 'issues'|'pulls'), detail keyed per (cid, 'pull'|'issue', number).
POST /start invalidates every cache entry for its container so a freshly tracked item's
state can refresh immediately.
"""

import json
import time
import urllib.error
import urllib.request

from fastapi import HTTPException, Request

from portal_backend.application import app
from portal_backend.database import db_cursor
from portal_backend.guards import require_container, valid_uuid
from portal_backend.github_routes import _read_token, _read_token_map
from portal_backend.identity_routes import require_member_read, trusted_actor
from portal_backend.schemas.github_hub import GithubStartBody
from portal_backend.task_start_core import start_task_from_github

GITHUB_API = "https://api.github.com"
GITHUB_TIMEOUT_SECONDS = 10
BODY_EXCERPT_CHARS = 200
CACHE_TTL_SECONDS = 60
# Detail-endpoint fetch caps. The PR files API is paginated; we take the first page of
# 100 and flag `files.truncated` when GitHub says there are more. Issue comments show the
# most-recent 20 (fetched newest-first via GitHub's sort/direction, then re-ordered oldest
# -first for display).
PR_FILES_PER_PAGE = 100
ISSUE_COMMENTS_LIMIT = 20

# In-module TTL cache. Deliberately a plain module dict — one portal process, tiny
# per-container footprint, invalidated on POST /start. Tests exercise TTL behavior by
# monkeypatching time.monotonic / clearing. Keys are a (cid, kind, *rest) tuple: the
# list routes cache per (cid, 'issues'|'pulls'); the detail routes cache per
# (cid, 'pull'|'issue', number) — cid is always key[0] so invalidation stays correct.
_CACHE: dict = {}


def _cache_key(cid: str, kind: str, number: int = None) -> tuple:
    return (cid, kind) if number is None else (cid, kind, number)


def _cache_get(cid: str, kind: str, number: int = None):
    hit = _CACHE.get(_cache_key(cid, kind, number))
    if hit and hit[0] > time.monotonic():
        return hit[1]
    return None


def _cache_put(cid: str, kind: str, payload, number: int = None) -> None:
    _CACHE[_cache_key(cid, kind, number)] = (time.monotonic() + CACHE_TTL_SECONDS, payload)


def _cache_invalidate(cid: str) -> None:
    # Drops every entry for this container — both list and detail caches (key[0] is cid).
    for key in [k for k in _CACHE if k[0] == cid]:
        _CACHE.pop(key, None)


def _resolve_repo_token(repo: str):
    """The installation token that can read `owner/name`, or None when the App isn't
    wired for this owner. Multi-org: prefer the per-owner token from the map; else the
    legacy single-token file (self-host default). Mirrors github_routes' resolution."""
    owner = (repo or "").split("/", 1)[0].lower()
    token_map = _read_token_map()
    if token_map and owner in token_map:
        return token_map[owner]
    return _read_token()


def _gh_get(path: str, token: str):
    """GET a GitHub REST path with the installation token; return parsed JSON.

    stdlib urllib (no httpx dependency), matching github_routes. Raises RuntimeError
    carrying the HTTP status on any GitHub/network failure — the route maps that to a
    clean JSON error the UI can render (rate limit / 403 / 404 not-connected). This is
    the ONLY network leaf; tests monkeypatch it, never the routes.
    """
    url = f"{GITHUB_API}{path}"
    request = urllib.request.Request(
        url,
        headers={
            "Authorization": f"token {token}",
            "Accept": "application/vnd.github+json",
            "User-Agent": "orcha-portal",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=GITHUB_TIMEOUT_SECONDS) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f"github_status:{exc.code}") from exc
    except Exception as exc:  # DNS, timeout, TLS, bad JSON — one graceful shape
        raise RuntimeError(f"github_unreachable:{exc}") from exc


def _error_payload(exc: RuntimeError) -> dict:
    """Map a _gh_get RuntimeError to the UI-renderable {available:false, ...} shape.

    403 → rate-limited/forbidden (quiet-retry note); 404 → the repo isn't reachable
    with this installation (treated as not-connected); anything else → a generic
    unreachable. `available` is false in every case; `detail` is a short string.
    """
    msg = str(exc)
    if msg.startswith("github_status:"):
        code = msg.split(":", 1)[1]
        if code == "403":
            return {"available": False, "reason": "rate_limited",
                    "detail": "GitHub rate limit or access forbidden (403)"}
        if code == "404":
            return {"available": False, "reason": "repo_not_connected",
                    "detail": "repo not reachable with this installation (404)"}
        return {"available": False, "reason": "github_error",
                "detail": f"GitHub returned {code}"}
    return {"available": False, "reason": "unreachable", "detail": "could not reach GitHub"}


def _detail_error_payload(exc: RuntimeError) -> dict:
    """Detail-route error mapping. Identical to `_error_payload` EXCEPT a 404 means the
    specific issue/PR *number* does not exist (not that the whole repo is unreachable):
    the detail pages want `reason:"not_found"` so they can render a distinct 'this item
    is gone' state. All other codes (403 rate-limit, generic, unreachable) reuse the
    shared mapping so the two surfaces stay consistent."""
    msg = str(exc)
    if msg == "github_status:404":
        return {"available": False, "reason": "not_found",
                "detail": "issue or pull request not found (404)"}
    return _error_payload(exc)


def _load_binding(cur, cid: str, request: Request):
    """Container exists + reader is authorized + the repo binding. Raises on a bad
    cid/unknown container/non-member; returns the bound `owner/name` or None."""
    if not valid_uuid(cid):
        raise HTTPException(400, "container_id is not a valid UUID")
    require_container(cur, cid)
    # Access model: reads are project-isolated (trusted non-member 403), like the other
    # container GET routes (github_routes.get_container_github, container_task_list).
    require_member_read(cur, request, cid)
    cur.execute("SELECT github_repo FROM containers WHERE id=%s", (cid,))
    return cur.fetchone()["github_repo"]


def _not_connected():
    """The container has no bound repo — a clean, renderable off state (not an error)."""
    return {"available": False, "reason": "repo_not_connected",
            "detail": "no GitHub repo is connected to this project"}


def _labels(issue: dict) -> list:
    return [lb.get("name") for lb in (issue.get("labels") or []) if lb.get("name")]


def _excerpt(body) -> str:
    return (body or "")[:BODY_EXCERPT_CHARS]


def _issue_entry(issue: dict) -> dict:
    assignee = issue.get("assignee") or {}
    return {
        "number": issue.get("number"),
        "title": issue.get("title"),
        "labels": _labels(issue),
        "assignee": assignee.get("login"),
        "updated_at": issue.get("updated_at"),
        "html_url": issue.get("html_url"),
        "body_excerpt": _excerpt(issue.get("body")),
    }


def _checks_rollup(repo: str, sha: str, token: str, include_runs: bool = False) -> dict:
    """Combine the legacy commit-status API and the newer check-runs API for a head SHA
    into one {passed, failing, pending, total} rollup — the UI's checks chip.

    Both surfaces coexist on real repos (status = older CI like Travis; check-runs =
    GitHub Actions / Apps), so we sum both. A network failure on either surface degrades
    gracefully to zeros rather than failing the whole PR list.

    The list endpoint calls this with the default `include_runs=False` and reads only the
    four counts. The PR-DETAIL endpoint passes `include_runs=True` to additionally get a
    `runs:[{name,status,conclusion,html_url}]` list under the SAME classification math —
    so the aggregate chip on the detail page can never disagree with the per-run rows.
    The returned dict is freshly built on every call (no shared mutable default); callers
    may freely mutate/extend it — e.g. `_pull_detail` drops `runs` in when it wants them
    and the count-only callers simply ignore that absent key.
    """
    passed = failing = pending = 0
    runs_out = []
    # Legacy combined commit status: contexts each 'success' | 'failure'|'error' | 'pending'.
    try:
        combined = _gh_get(f"/repos/{repo}/commits/{sha}/status", token)
        for st in combined.get("statuses") or []:
            state = st.get("state")
            if state == "success":
                passed += 1
            elif state in ("failure", "error"):
                failing += 1
            else:
                pending += 1
            if include_runs:
                # Normalize a legacy status context into the same run row shape as a
                # check-run: its `state` is the conclusion, and it's always 'completed'.
                runs_out.append({
                    "name": st.get("context"),
                    "status": "completed",
                    "conclusion": state,
                    "html_url": st.get("target_url"),
                })
    except RuntimeError:
        pass
    # Check runs: status queued|in_progress|completed; conclusion success|failure|...
    try:
        runs = _gh_get(f"/repos/{repo}/commits/{sha}/check-runs", token)
        for run in runs.get("check_runs") or []:
            if run.get("status") != "completed":
                pending += 1
            else:
                conclusion = run.get("conclusion")
                if conclusion in ("success", "neutral", "skipped"):
                    passed += 1
                elif conclusion in ("failure", "timed_out", "action_required", "cancelled",
                                    "stale", "startup_failure"):
                    failing += 1
                else:
                    pending += 1
            if include_runs:
                runs_out.append({
                    "name": run.get("name"),
                    "status": run.get("status"),
                    "conclusion": run.get("conclusion"),
                    "html_url": run.get("html_url"),
                })
    except RuntimeError:
        pass
    rollup = {"passed": passed, "failing": failing, "pending": pending,
              "total": passed + failing + pending}
    if include_runs:
        rollup["runs"] = runs_out
    return rollup


def _pull_entry(repo: str, pull: dict, token: str) -> dict:
    reviewers = [r.get("login") for r in (pull.get("requested_reviewers") or [])
                 if r.get("login")]
    head = pull.get("head") or {}
    sha = head.get("sha")
    checks = _checks_rollup(repo, sha, token) if sha else {
        "passed": 0, "failing": 0, "pending": 0, "total": 0}
    return {
        "number": pull.get("number"),
        "title": pull.get("title"),
        "head": head.get("ref"),
        "draft": bool(pull.get("draft")),
        "updated_at": pull.get("updated_at"),
        "html_url": pull.get("html_url"),
        "requested_reviewers": reviewers,
        "checks": checks,
        "mergeable_state": pull.get("mergeable_state"),
    }


def _logins(items) -> list:
    """The `login` of each user object in a list, skipping any without one."""
    return [u.get("login") for u in (items or []) if u.get("login")]


def _pr_files(repo: str, number: int, token: str, changed_files) -> dict:
    """The PR's changed files (first page of 100), as {count, items[, truncated]}.

    `count` is GitHub's OWN `changed_files` total from the PR object (the honest total,
    not the length of the page we fetched); `items` carries the per-file rows WITHOUT
    patches (list only — the detail page shows names + add/del, not diffs). `truncated`
    is set true only when that honest total exceeds what we returned. A network failure
    fetching the files page degrades to an empty list rather than failing the whole PR.
    """
    try:
        raw = _gh_get(
            f"/repos/{repo}/pulls/{number}/files?per_page={PR_FILES_PER_PAGE}", token)
    except RuntimeError:
        raw = []
    items = [{
        "filename": f.get("filename"),
        "additions": f.get("additions"),
        "deletions": f.get("deletions"),
        "status": f.get("status"),
    } for f in raw]
    # Prefer GitHub's declared total; fall back to what we actually fetched if it's absent.
    count = changed_files if isinstance(changed_files, int) else len(items)
    out = {"count": count, "items": items}
    if count > len(items):
        out["truncated"] = True
    return out


def _pull_detail(repo: str, pull: dict, token: str) -> dict:
    """Assemble the PR-detail payload from the fetched PR object + its files + checks.

    body_markdown is the RAW markdown straight from GitHub (`body`) — the frontend renders
    it with the portal's own markdown renderer; we deliberately do NOT html-render server
    -side. Checks reuse the SHARED `_checks_rollup` (with include_runs=True) so the chip
    math is identical to the list endpoint, plus a per-run breakdown for the detail page.
    """
    head = pull.get("head") or {}
    base = pull.get("base") or {}
    sha = head.get("sha")
    checks = _checks_rollup(repo, sha, token, include_runs=True) if sha else {
        "passed": 0, "failing": 0, "pending": 0, "total": 0, "runs": []}
    return {
        "number": pull.get("number"),
        "title": pull.get("title"),
        "state": pull.get("state"),
        "draft": bool(pull.get("draft")),
        "body_markdown": pull.get("body") or "",
        "author_login": (pull.get("user") or {}).get("login"),
        "base": base.get("ref"),
        "head": head.get("ref"),
        "updated_at": pull.get("updated_at"),
        "created_at": pull.get("created_at"),
        "html_url": pull.get("html_url"),
        "mergeable_state": pull.get("mergeable_state"),
        "assignees": _logins(pull.get("assignees")),
        "requested_reviewers": _logins(pull.get("requested_reviewers")),
        "checks": checks,
        "files": _pr_files(repo, pull.get("number"), token, pull.get("changed_files")),
        "comments_count": pull.get("comments"),
        "review_comments_count": pull.get("review_comments"),
    }


def _issue_comment(comment: dict) -> dict:
    return {
        "author_login": (comment.get("user") or {}).get("login"),
        "body_markdown": comment.get("body") or "",
        "created_at": comment.get("created_at"),
    }


def _issue_comments(repo: str, number: int, token: str) -> list:
    """The issue's most-recent ISSUE_COMMENTS_LIMIT comments, oldest-first for display.

    We ask GitHub for the newest ones (sort=created&direction=desc, capped at the limit)
    then reverse to oldest-first so the detail thread reads top-to-bottom. A fetch failure
    degrades to an empty list rather than failing the whole issue."""
    try:
        raw = _gh_get(
            f"/repos/{repo}/issues/{number}/comments"
            f"?per_page={ISSUE_COMMENTS_LIMIT}&sort=created&direction=desc",
            token)
    except RuntimeError:
        return []
    newest_first = [_issue_comment(c) for c in raw[:ISSUE_COMMENTS_LIMIT]]
    newest_first.reverse()  # -> oldest-first
    return newest_first


def _issue_detail(repo: str, issue: dict, token: str) -> dict:
    """Assemble the issue-detail payload from the fetched issue object + its comments.

    body_markdown is the RAW markdown (`body`); the frontend renders it. `assignee` is the
    single primary assignee's login (GitHub's legacy field); `assignees` is the full list.
    """
    assignee = issue.get("assignee") or {}
    return {
        "number": issue.get("number"),
        "title": issue.get("title"),
        "state": issue.get("state"),
        "body_markdown": issue.get("body") or "",
        "author_login": (issue.get("user") or {}).get("login"),
        "labels": _labels(issue),
        "assignee": assignee.get("login"),
        "assignees": _logins(issue.get("assignees")),
        "updated_at": issue.get("updated_at"),
        "created_at": issue.get("created_at"),
        "html_url": issue.get("html_url"),
        "comments_count": issue.get("comments"),
        "comments": _issue_comments(repo, issue.get("number"), token),
    }


@app.get("/api/containers/{cid}/github/issues")
def list_github_issues(cid: str, request: Request):
    """Open issues of the container's connected repo — the hub's Issues tab.

    Returns {available, repo, issues:[{number,title,labels,assignee,updated_at,
    html_url,body_excerpt}]}. Not-connected / rate-limited / GitHub error all resolve
    to a clean {available:false, reason, detail} the UI renders (never a 5xx). Cached
    60s per (cid,'issues')."""
    with db_cursor() as (_, cur):
        repo = _load_binding(cur, cid, request)
    if not repo:
        return _not_connected()
    cached = _cache_get(cid, "issues")
    if cached is not None:
        return cached
    token = _resolve_repo_token(repo)
    if not token:
        return _not_connected()
    # GitHub's issues list includes PRs; filter them out (PRs carry pull_request).
    path = f"/repos/{repo}/issues?state=open&per_page=100"
    try:
        raw = _gh_get(path, token)
    except RuntimeError as exc:
        return {**_error_payload(exc), "repo": repo}
    issues = [_issue_entry(i) for i in raw if "pull_request" not in i]
    payload = {"available": True, "repo": repo, "issues": issues}
    _cache_put(cid, "issues", payload)
    return payload


@app.get("/api/containers/{cid}/github/pulls")
def list_github_pulls(cid: str, request: Request):
    """Open PRs of the container's connected repo — the hub's PRs tab.

    Returns {available, repo, pulls:[{number,title,head,draft,updated_at,html_url,
    requested_reviewers,checks:{passed,failing,pending,total},mergeable_state}]}. The
    checks rollup sums the combined-status + check-runs surfaces for each PR's head sha.
    Same clean-error contract + 60s cache as the issues route."""
    with db_cursor() as (_, cur):
        repo = _load_binding(cur, cid, request)
    if not repo:
        return _not_connected()
    cached = _cache_get(cid, "pulls")
    if cached is not None:
        return cached
    token = _resolve_repo_token(repo)
    if not token:
        return _not_connected()
    try:
        raw = _gh_get(f"/repos/{repo}/pulls?state=open&per_page=100", token)
    except RuntimeError as exc:
        return {**_error_payload(exc), "repo": repo}
    pulls = [_pull_entry(repo, p, token) for p in raw]
    payload = {"available": True, "repo": repo, "pulls": pulls}
    _cache_put(cid, "pulls", payload)
    return payload


@app.get("/api/containers/{cid}/github/pulls/{number}")
def get_github_pull(cid: str, number: int, request: Request):
    """One PR's full detail — the PR detail page.

    Returns {available, repo, pull:{number,title,state,draft,body_markdown,author_login,
    base,head,updated_at,created_at,html_url,mergeable_state,assignees,requested_reviewers,
    checks:{passed,failing,pending,total,runs:[{name,status,conclusion,html_url}]},
    files:{count,items:[{filename,additions,deletions,status}][,truncated]},comments_count,
    review_comments_count}}. body_markdown is RAW markdown (rendered client-side). Checks
    reuse the SHARED list-endpoint rollup helper (with per-run breakdown). A GitHub 404 for
    the number → {available:false, reason:"not_found"}; not-connected / rate-limited resolve
    to the same clean {available:false,...} shape (never a 5xx). Cached 60s per
    (cid,'pull',number)."""
    with db_cursor() as (_, cur):
        repo = _load_binding(cur, cid, request)
    if not repo:
        return _not_connected()
    cached = _cache_get(cid, "pull", number)
    if cached is not None:
        return cached
    token = _resolve_repo_token(repo)
    if not token:
        return _not_connected()
    try:
        raw = _gh_get(f"/repos/{repo}/pulls/{number}", token)
    except RuntimeError as exc:
        return {**_detail_error_payload(exc), "repo": repo}
    payload = {"available": True, "repo": repo, "pull": _pull_detail(repo, raw, token)}
    _cache_put(cid, "pull", payload, number)
    return payload


@app.get("/api/containers/{cid}/github/issues/{number}")
def get_github_issue(cid: str, number: int, request: Request):
    """One issue's full detail — the issue detail page.

    Returns {available, repo, issue:{number,title,state,body_markdown,author_login,labels,
    assignee,assignees,updated_at,created_at,html_url,comments_count,
    comments:[{author_login,body_markdown,created_at}]}}. `comments` is the most-recent 20,
    oldest-first. body_markdown is RAW markdown (rendered client-side). A GitHub 404 →
    {available:false, reason:"not_found"}; not-connected / rate-limited resolve to the same
    clean shape. Cached 60s per (cid,'issue',number)."""
    with db_cursor() as (_, cur):
        repo = _load_binding(cur, cid, request)
    if not repo:
        return _not_connected()
    cached = _cache_get(cid, "issue", number)
    if cached is not None:
        return cached
    token = _resolve_repo_token(repo)
    if not token:
        return _not_connected()
    try:
        raw = _gh_get(f"/repos/{repo}/issues/{number}", token)
    except RuntimeError as exc:
        return {**_detail_error_payload(exc), "repo": repo}
    payload = {"available": True, "repo": repo, "issue": _issue_detail(repo, raw, token)}
    _cache_put(cid, "issue", payload, number)
    return payload


@app.post("/api/containers/{cid}/github/start", status_code=201)
def start_from_github(cid: str, body: GithubStartBody, request: Request):
    """Turn a GitHub issue/PR into an Orcha task (the [Start →] button).

    Reuses the SAME start internals the Slack seam uses (task_start_core) — one source
    of truth. Grant model MIRRORS task creation exactly: the trusted proxy login IS the
    creator (trusted_actor: 403 non-member, viewer refused); trust-off keeps the
    permissive body-actor convention. Idempotent: an OPEN task already tracking `GH #N:`
    for this number is returned with {existing:true}. Optional assignee_agent_id assigns
    a live AI agent so the wake machinery fires; bare start = an unassigned 'ready' task.
    Returns {task_id, existing}.
    """
    if not valid_uuid(cid):
        raise HTTPException(400, "container_id is not a valid UUID")
    with db_cursor() as (conn, cur):
        require_container(cur, cid)
        # Same identity/grant gate task creation requires today: the trusted login IS the
        # creator (non-member 403, viewer write-banned); trust-off passes the body actor
        # through unchanged (the self-host convention).
        created_by = trusted_actor(cur, request, cid, body.created_by_agent_id)

        assignee_id = None
        if body.assignee_agent_id:
            if not valid_uuid(body.assignee_agent_id):
                raise HTTPException(400, "assignee_agent_id is not a valid UUID")
            cur.execute(
                "SELECT kind, container_id, terminated_at FROM agents WHERE id=%s",
                (body.assignee_agent_id,),
            )
            a = cur.fetchone()
            if not a:
                raise HTTPException(404, f"agent {body.assignee_agent_id} not found")
            if str(a["container_id"]) != cid:
                raise HTTPException(409, "assignee is not in this container")
            if a["terminated_at"] is not None:
                raise HTTPException(409, "assignee is retired and cannot be assigned work")
            if a["kind"] != "ai":
                raise HTTPException(409, "can only assign GitHub work to AI agents")
            assignee_id = body.assignee_agent_id

        result = start_task_from_github(
            cur,
            cid,
            kind=body.kind,
            number=body.number,
            gh_title=body.title or "",
            body_excerpt=body.body_excerpt or "",
            html_url=body.html_url or "",
            created_by_agent_id=created_by,
            assignee_agent_id=assignee_id,
            source="github_hub",
        )
        conn.commit()
    # A newly-tracked item's issue/PR state may change (assignee, etc.); drop the cache
    # so the next poll reflects it. Cheap and outside the transaction.
    _cache_invalidate(cid)
    return result
