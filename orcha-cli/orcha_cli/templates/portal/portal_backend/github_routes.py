"""Bind a container to a GitHub repo and list the App installation's repositories."""

import json
import os
import urllib.error
import urllib.request

from fastapi import HTTPException

from portal_backend.agent_status import log_event
from portal_backend.application import app
from portal_backend.database import db_cursor
from portal_backend.guards import require_container, valid_uuid
from portal_backend.schemas import ContainerGithubBinding

# One page of 100 covers every realistic single-project installation; a >100-repo
# installation simply sees the first page (pagination can ride a later slice).
GITHUB_REPOS_URL = "https://api.github.com/installation/repositories?per_page=100"
GITHUB_TIMEOUT_SECONDS = 10


def _read_token():
    """Read the GitHub App INSTALLATION token the host-side refresh timer maintains.

    The compose template bind-mounts the stack dir read-only and points
    ORCHA_GITHUB_TOKEN_FILE at <stack>/github-token. Only this short-lived token ever
    reaches a container — the App's PEM stays on the host, always. Env unset, file
    missing/unreadable, or file empty all mean "the GitHub App isn't wired here"
    (a normal state for self-hosters) and resolve to None, never an error.
    """
    path = (os.environ.get("ORCHA_GITHUB_TOKEN_FILE") or "").strip()
    if not path:
        return None
    try:
        with open(path, encoding="utf-8") as fh:
            token = fh.read().strip()
    except OSError:
        return None
    return token or None


def _read_token_map():
    """Read the multi-installation token map the refresh timer maintains (multi-org).

    ORCHA_GITHUB_TOKENS_FILE points at a JSON object {"<owner-lowercase>": "<token>"}
    with one installation token per org/user the App is installed on
    (<project>/.orcha/github-tokens.json on the host). Env unset, file
    missing/unreadable, not a JSON object, or an empty/valueless map all resolve to
    None — the caller then falls back to the legacy single-token file. Never an error.
    """
    path = (os.environ.get("ORCHA_GITHUB_TOKENS_FILE") or "").strip()
    if not path:
        return None
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict):
        return None
    tokens = {
        str(owner).lower(): str(token).strip()
        for owner, token in data.items()
        if isinstance(token, str) and token.strip()
    }
    return tokens or None


def _fetch_installation_repos(token: str) -> list:
    """Fetch the repos this installation token can see (the App's installed repos).

    GET https://api.github.com/installation/repositories with the installation token
    lists exactly the repositories the App is installed on. stdlib urllib, matching the
    rest of the codebase (no httpx dependency). Raises RuntimeError with a short,
    user-showable detail string on any GitHub/network failure — the route maps that to
    the graceful {"available": false, "detail": ...} shape. Tests monkeypatch THIS
    function (the network leaf), never the route.
    """
    request = urllib.request.Request(
        GITHUB_REPOS_URL,
        headers={
            "Authorization": f"token {token}",
            "Accept": "application/vnd.github+json",
            "User-Agent": "orcha-portal",
        },
    )
    try:
        with urllib.request.urlopen(
            request, timeout=GITHUB_TIMEOUT_SECONDS
        ) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raise RuntimeError(
            f"GitHub returned {exc.code} for installation/repositories"
        ) from exc
    except Exception as exc:  # DNS, timeout, TLS, bad JSON — one graceful shape
        raise RuntimeError(f"could not reach GitHub: {exc}") from exc
    return payload.get("repositories") or []


def _repo_entry(repo: dict) -> dict:
    return {
        "full_name": repo.get("full_name"),
        "private": bool(repo.get("private")),
        "description": repo.get("description"),
        "html_url": repo.get("html_url"),
    }


@app.get("/api/github/repos")
def list_github_repos():
    """List the GitHub App's repos across ALL installations for the Connect-repo modal.

    Multi-org: when the token map (ORCHA_GITHUB_TOKENS_FILE) is present, every
    installation's repos are fetched and merged (deduped, sorted by full_name);
    `available` is true if ANY installation answered, and per-owner failures ride a
    `detail` string. Without the map, the legacy single-token file is used unchanged.

    No token at all (self-hosters without the App) → 200 {"available": false,
    "repos": []} — a graceful off state, deliberately NOT an error. A GitHub-side
    failure is likewise available:false plus a short `detail` string.
    """
    token_map = _read_token_map()
    if token_map:
        merged: dict = {}
        failures = []
        for owner in sorted(token_map):
            try:
                raw = _fetch_installation_repos(token_map[owner])
            except RuntimeError as exc:
                failures.append(f"{owner}: {exc}")
                continue
            for repo in raw:
                merged.setdefault(repo.get("full_name"), _repo_entry(repo))
        result = {
            "available": len(failures) < len(token_map),
            "repos": [merged[name] for name in sorted(merged, key=lambda n: n or "")],
        }
        if failures:
            result["detail"] = "; ".join(failures)
        return result

    token = _read_token()
    if not token:
        return {"available": False, "repos": []}
    try:
        raw = _fetch_installation_repos(token)
    except RuntimeError as exc:
        return {"available": False, "repos": [], "detail": str(exc)}
    return {"available": True, "repos": [_repo_entry(repo) for repo in raw]}


@app.get("/api/containers/{cid}/github")
def get_container_github(cid: str):
    """Read a container's GitHub repo binding: {"repo": "owner/name" | null}."""
    if not valid_uuid(cid):
        raise HTTPException(400, "container_id is not a valid UUID")
    with db_cursor() as (_, cur):
        require_container(cur, cid)
        cur.execute("SELECT github_repo FROM containers WHERE id=%s", (cid,))
        return {"repo": cur.fetchone()["github_repo"]}


@app.put("/api/containers/{cid}/github")
def put_container_github(cid: str, body: ContainerGithubBinding):
    """Bind (or with repo=null, unbind) a container's GitHub repo.

    The owner/name shape is enforced by the ContainerGithubBinding schema (422 on
    anything else). Returns the persisted binding in the same shape as GET. Audited
    to the container event log like other container-setting writes.
    """
    if not valid_uuid(cid):
        raise HTTPException(400, "container_id is not a valid UUID")
    with db_cursor() as (conn, cur):
        require_container(cur, cid)
        cur.execute(
            "UPDATE containers SET github_repo=%s WHERE id=%s RETURNING github_repo",
            (body.repo, cid),
        )
        repo = cur.fetchone()["github_repo"]
        log_event(
            cur,
            cid,
            "human",
            None,
            "container",
            cid,
            "github_repo_bound" if repo else "github_repo_unbound",
            {"repo": repo},
        )
        conn.commit()
    return {"repo": repo}
