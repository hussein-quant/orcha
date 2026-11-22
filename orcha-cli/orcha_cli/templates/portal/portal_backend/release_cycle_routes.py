"""Release cycles: two or three weeks of tickets on one release branch, then one release.

A cycle owns a `release/x.y.z` branch cut from main. Every ticket (a GitHub issue or one typed
here) runs as its own small workflow from the `release_ticket` template: a spec the owner approves
for a feature, a PR into the release branch, the owner's merge, a check on staging on the ticket's
platforms, and triage that sends real bugs back. The owner's merge is the decision that a ticket
ships: whatever is merged into the branch is in the release.

The cut freezes the cycle: the merged tickets ship in a Mobile App Release made in cycle mode
(it builds from the release branch and skips the batch stages the tickets already did), the
unmerged ones roll to the next cycle and its branch, with a note to their agents.

Nothing here changes the workflow engine: tickets and the release are ordinary templated
workflows, made through the same create and Start as the editor's.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
from typing import Any
from uuid import uuid4

from fastapi import Request
from pydantic import BaseModel, ConfigDict, Field

from portal_backend import sql
from portal_backend import workflow_release_routes as release
from portal_backend import workflow_service as service
from portal_backend import workflow_steps as steps
from portal_backend import workflow_templates as templates
from portal_backend.application import app
from portal_backend.database import db_cursor
from portal_backend.identity_routes import require_member_read
from portal_backend.workflow_graph import conflict
from portal_backend.workflow_routes import HOOKS, resolve_human_actor

TICKET_KEY = "release_ticket"
RELEASE_KEY = "mobile_app_release"
CLIENTS = ("ios", "android", "web")
COMMAND_TIMEOUT_S = 60


class _In(BaseModel):
    model_config = ConfigDict(extra="forbid")


class OpenCycleBody(_In):
    version: str = Field(min_length=1, max_length=40)
    branch: str | None = Field(default=None, max_length=120)
    base_branch: str = Field(default="main", max_length=120)
    milestone: str | None = Field(default=None, max_length=120)
    platforms: list[str] = Field(default_factory=lambda: list(templates.PLATFORMS), max_length=4)
    roles: dict[str, str | None] = Field(default_factory=dict)
    engineers: dict[str, str | None] = Field(default_factory=dict)
    create_branch: bool = True
    dry_run: bool = False


class SettingsBody(_In):
    roles: dict[str, str | None] | None = None
    engineers: dict[str, str | None] | None = None
    milestone: str | None = Field(default=None, max_length=120)


class TicketBody(_In):
    issue_number: int | None = Field(default=None, ge=1)
    title: str | None = Field(default=None, max_length=200)
    body: str = Field(default="", max_length=20_000)
    url: str | None = Field(default=None, max_length=500)
    kind: str | None = Field(default=None, pattern="^(bug|feature)$")
    platforms: list[str] = Field(default_factory=list, max_length=4)
    engineer_id: str | None = None
    labels: list[str] = Field(default_factory=list, max_length=40)
    source: str = Field(default="manual", pattern="^(manual|github)$")
    # Also open it as an issue on GitHub (with gh, in the cycle's milestone). Off unless a person ticks it.
    create_issue: bool = False
    # Screenshots and recording frames from the intake conversation: {conversation_id, id, name}.
    attachments: list[dict[str, str]] = Field(default_factory=list, max_length=20)


class CutBody(_In):
    params: dict[str, Any] = Field(default_factory=dict)
    removed: list[str] = Field(default_factory=list, max_length=200)
    added: list[dict[str, Any]] = Field(default_factory=list, max_length=40)
    roles: dict[str, str | None] = Field(default_factory=dict)
    next_version: str | None = Field(default=None, max_length=40)
    idempotency_key: str = Field(min_length=8, max_length=200)


# ---- outside commands (git and gh, from the project root, never a shell) ------------------


def _run(args: list[str], timeout: int = COMMAND_TIMEOUT_S) -> tuple[int, str, str]:
    """Run git or gh in the project folder. Tests replace this."""
    cwd = os.environ.get("ORCHA_LOCAL_REPO_DIR") or None
    if not cwd:
        return 127, "", "The portal doesn't know the project folder (ORCHA_LOCAL_REPO_DIR is unset)."
    try:
        proc = subprocess.run(args, cwd=cwd, capture_output=True, text=True, timeout=timeout)
        return proc.returncode, proc.stdout or "", proc.stderr or ""
    except FileNotFoundError:
        return 127, "", f"{args[0]} isn't installed on this machine."
    except subprocess.TimeoutExpired:
        return 124, "", f"{args[0]} took longer than {timeout} s."


def ensure_branch(branch: str, base: str) -> tuple[str, str]:
    """Make `branch` on origin from origin/`base`, unless it's there already. Touches no working
    tree: it fetches the base and pushes the remote-tracking ref."""
    rc, _, err = _run(["git", "ls-remote", "--exit-code", "--heads", "origin", branch])
    if rc == 0:
        return "existed", f"{branch} was already on origin."
    if rc not in (2,):
        return "failed", f"Couldn't read origin: {(err or 'git ls-remote failed').strip()[-300:]}"
    rc, _, err = _run(["git", "fetch", "origin", base])
    if rc != 0:
        return "failed", f"Couldn't fetch {base}: {(err or 'git fetch failed').strip()[-300:]}"
    rc, _, err = _run(["git", "push", "origin", f"refs/remotes/origin/{base}:refs/heads/{branch}"])
    if rc != 0:
        return "failed", f"Couldn't push {branch}: {(err or 'git push failed').strip()[-300:]}"
    return "created", f"{branch} was created on origin from {base}."


_PLATFORM_WORDS = {
    "ios": "ios", "iphone": "ios", "ipad": "ios", "android": "android", "web": "web", "website": "web",
    "frontend": "web", "api": "api", "backend": "api", "server": "api",
}
_FEATURE_WORDS = {"feature", "enhancement", "feature-request", "request"}


def labels_say(labels: list[str]) -> tuple[list[str], str | None]:
    """Platforms and kind from GitHub labels: `ios`, `platform:android`, `Web`, `enhancement`…"""
    platforms, kind = [], None
    for label in labels:
        low = str(label).casefold()
        for token in re.split(r"[^a-z0-9-]+", low):
            p = _PLATFORM_WORDS.get(token)
            if p and p not in platforms:
                platforms.append(p)
            if token in _FEATURE_WORDS or token.startswith("feature"):
                kind = "feature"
            elif token in {"bug", "defect", "regression"} and kind is None:
                kind = "bug"
    return [p for p in templates.PLATFORMS if p in platforms], kind


def _issue(raw: dict) -> dict:
    labels = [str(x.get("name") if isinstance(x, dict) else x) for x in raw.get("labels") or []]
    platforms, kind = labels_say(labels)
    return {"number": int(raw["number"]), "title": str(raw.get("title") or "")[:200],
            "body": str(raw.get("body") or "")[:20_000], "url": raw.get("html_url") or raw.get("url"), "labels": labels,
            "platforms": platforms, "kind": kind or "bug", "kind_from_labels": kind is not None}


# GitHub goes through the GitHub tab's own plumbing (github_hub_routes): the project's repo
# binding, the same token chain (App token, then the project's PAT), the same GET leaf.


def github_repo(cur, cid: str, request: Request) -> tuple[str, str]:
    """The project's GitHub repo and a token for it, as the GitHub tab resolves them."""
    from portal_backend import github_hub_routes as hub

    repo = hub._load_binding(cur, cid, request)
    if repo == hub.LOCAL_REPO:
        repo = hub._local_fallthrough_repo(cid)
    if not repo:
        conflict("github_not_connected", "No GitHub repo is connected to this project. Connect it in the GitHub tab.", status=422)
    token = hub._resolve_repo_token(repo, cid)
    if not token:
        conflict("github_no_token", f"No GitHub token can read {repo}. Add one in Settings → GitHub access.", status=422)
    return repo, token


def _gh_get(path: str, token: str):
    from portal_backend import github_hub_routes as hub

    return hub._gh_get(path, token)


def _gh_send(method: str, path: str, token: str, payload: dict):
    """The one GitHub write here (opening an issue a person asked for). Tests replace it."""
    import urllib.error
    import urllib.request

    from portal_backend import github_hub_routes as hub

    req = urllib.request.Request(
        f"{hub.GITHUB_API}{path}", data=json.dumps(payload).encode(), method=method,
        headers={"Authorization": f"token {token}", "Accept": "application/vnd.github+json",
                 "User-Agent": "orcha-portal", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=hub.GITHUB_TIMEOUT_SECONDS) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = ""
        try:
            detail = json.loads(exc.read().decode("utf-8")).get("message", "")
        except Exception:  # noqa: BLE001 - the status says enough
            pass
        raise RuntimeError(f"GitHub said {exc.code}{': ' + detail if detail else ''}") from exc
    except (urllib.error.URLError, TimeoutError) as exc:
        raise RuntimeError(f"GitHub didn't answer: {exc}") from exc


def _milestone_number(repo: str, token: str, title: str) -> int | None:
    for m in _gh_get(f"/repos/{repo}/milestones?state=open&per_page=100", token) or []:
        if str(m.get("title") or "").strip() == title.strip():
            return int(m["number"])
    return None


def read_issue(repo: str, token: str, number: int) -> dict:
    try:
        raw = _gh_get(f"/repos/{repo}/issues/{number}", token)
    except RuntimeError as exc:
        conflict("issue_unreadable", f"Couldn't read issue #{number}: {exc}", status=422)
    if not isinstance(raw, dict) or "number" not in raw or raw.get("pull_request"):
        conflict("issue_unreadable", f"#{number} isn't an issue.", status=422)
    return _issue(raw)


def milestone_issues(repo: str, token: str, milestone: str) -> tuple[list[dict], str | None]:
    try:
        number = _milestone_number(repo, token, milestone)
        if number is None:
            return [], f"{repo} has no open milestone named {milestone}."
        raw = _gh_get(f"/repos/{repo}/issues?milestone={number}&state=open&per_page=100", token)
    except RuntimeError as exc:
        return [], str(exc)
    return [_issue(x) for x in raw or [] if not x.get("pull_request")], None


def open_issue(repo: str, token: str, cid: str, title: str, body: str, milestone: str | None) -> tuple[int | None, str | None, str | None]:
    """Open an issue: (number, url, problem). In the milestone when it exists."""
    from portal_backend import github_hub_routes as hub

    try:
        number = _milestone_number(repo, token, milestone) if milestone else None
        payload = {"title": title[:200], "body": (body or title)[:60_000]}
        if number is not None:
            payload["milestone"] = number
        raw = _gh_send("POST", f"/repos/{repo}/issues", token, payload)
    except RuntimeError as exc:
        return None, None, f"Couldn't open the issue on GitHub: {exc}"
    hub._cache_invalidate(cid)  # the GitHub tab shows it on its next read
    return int(raw["number"]), raw.get("html_url"), None


# ---- reading a cycle -------------------------------------------------------------------


def _load(value, default):
    v = steps._load(value)
    return default if v is None else v


def _bump(version: str) -> str:
    return release._bump_patch(version)


def _branch_for(version: str) -> str:
    return f"release/{version}"


def _cycle(cur, cycle_id: str) -> dict:
    cur.execute("SELECT * FROM release_cycles WHERE id=%s", (cycle_id,))
    row = cur.fetchone()
    if not row:
        conflict("cycle_not_found", "Release cycle not found.", status=404)
    return dict(row)


def _qa_platforms(ticket_platforms: list[str], cycle_platforms: list[str]) -> list[str]:
    """Where a ticket is checked: its own platforms, and every client when it changes the API."""
    out = set(ticket_platforms)
    if "api" in out:
        out |= set(CLIENTS) & set(cycle_platforms)
    return [p for p in templates.PLATFORMS if p in out]


_WORD = {
    "spec": ("Writing the spec", "running"),
    "approve_spec": ("Spec waiting for you", "asking"),
    "implement": ("Building", "running"),
    "review_merge": ("Waiting for your merge", "asking"),
    "deploy_api_staging": ("Checking on staging", "running"),
    "deploy_web_staging": ("Checking on staging", "running"),
    "qa_ios": ("Checking on staging", "running"),
    "qa_android": ("Checking on staging", "running"),
    "qa_web": ("Checking on staging", "running"),
    "triage": ("Sorting what QA found", "running"),
}


def ticket_view(svc, ticket: dict, workflow: dict | None) -> dict:
    """Where one ticket is, in the owner's words, from its workflow's steps."""
    base = {
        "id": ticket["id"], "issue_number": ticket["issue_number"], "issue_url": ticket["issue_url"],
        "title": ticket["title"], "kind": ticket["kind"], "platforms": _load(ticket["platforms"], []),
        "source": ticket["source"], "state": ticket["state"], "workflow_id": ticket["workflow_id"],
        "rolled_from_cycle_id": ticket.get("rolled_from_cycle_id"), "created_at": ticket["created_at"],
    }
    if not workflow:
        return {**base, "word": "Not started", "tone": "muted", "merged": False, "checked": False,
                "needs_you": False, "step": None, "thread": [], "done": 0, "total": 0, "workflow_status": None}
    tasks = svc.rows(
        "SELECT id, title, status, route_state, withdrawn_at, awaiting_loop_decision, awaiting_owner_decision, "
        "step_spec, qa_step FROM tasks WHERE workflow_id=%s ORDER BY priority, created_at, id", (workflow["id"],),
    )
    history = steps.history_by_task(svc.cur, workflow["id"])
    key_of = {t["id"]: (steps.spec_of(t) or {}).get("key") for t in tasks}
    merged = any(h["outcome"] == "merged" for t in tasks if key_of[t["id"]] == "review_merge"
                 for h in history.get(t["id"], []))
    thread, current = [], None
    for t in tasks:
        word = release._state_word(t)
        kind = steps.kind_of(t)
        thread.append({"id": t["id"], "title": t["title"], "kind": kind, "state": word, "outward": False})
        if current is None and word in {"ready", "running", "review", "asking"}:
            current = (t, word)
    triage = next((t for t in tasks if key_of[t["id"]] == "triage"), None)
    last = (history.get(triage["id"]) or [{}])[-1].get("outcome") if triage else None
    checked = merged and (workflow["status"] == "completed" or bool(
        triage and triage["status"] == "completed" and last == "clear"))
    needs_you = False
    if workflow["status"] == "cancelled":
        word, tone = "Stopped", "muted"
    elif workflow["status"] == "paused":
        word, tone = "Paused", "muted"
    elif current:
        t, state = current
        key = key_of[t["id"]] or ""
        word, tone = _WORD.get(key, (t["title"], "running"))
        if key == "implement" and merged:
            word = "Fixing what QA found"
        needs_you = (steps.kind_of(t) in steps.PEOPLE and state == "ready") or state == "asking" or bool(
            t.get("awaiting_owner_decision"))
        if needs_you:
            tone = "asking"
        elif state == "ready" and steps.kind_of(t) not in steps.PEOPLE:
            word = f"{word}: waiting for its agent" if not workflow.get("dry_run") else word
    elif checked:
        word, tone = "In the branch, checked", "ok"
    elif merged:
        word, tone = "In the branch", "ok"
    else:
        word, tone = "Not started", "muted"
    return {
        **base, "word": word, "tone": tone, "merged": merged, "checked": checked, "needs_you": needs_you,
        "step": {"id": current[0]["id"], "title": current[0]["title"], "state": current[1]} if current else None,
        "thread": thread, "done": sum(1 for x in thread if x["state"] == "done"),
        "total": sum(1 for x in thread if x["state"] != "skipped"), "workflow_status": workflow["status"],
    }


def _tickets(cur, cycle_id: str) -> list[dict]:
    cur.execute("SELECT * FROM release_cycle_tickets WHERE cycle_id=%s ORDER BY created_at, id", (cycle_id,))
    return [dict(r) for r in cur.fetchall()]


def _summary_line(t: dict) -> str:
    ref = f"#{t['issue_number']} " if t["issue_number"] else ""
    words = ", ".join(templates.PLATFORM_WORD.get(p, p) for p in t["platforms"])
    return f"- {ref}{t['title']} ({t['kind']}, {words})"


def cycle_view(cur, cycle: dict, *, with_tickets: bool = True) -> dict:
    svc = service.WorkflowService(cur, HOOKS)
    platforms = _load(cycle["platforms"], list(templates.PLATFORMS))
    views = []
    for t in _tickets(cur, cycle["id"]):
        w = svc.one("SELECT * FROM workflows WHERE id=%s", (t["workflow_id"],)) if t["workflow_id"] else None
        views.append(ticket_view(svc, t, w))
    # Counted: what's still in the cycle (active, or shipped once it was cut), not what was taken out.
    live = [t for t in views if t["state"] in {"active", "shipped"} and t["workflow_status"] != "cancelled"]
    active = [t for t in live if t["state"] == "active"]
    ships = [t for t in active if t["merged"]] if cycle["state"] == "open" else [t for t in views if t["state"] == "shipped"]
    rolls = [t for t in active if not t["merged"]] if cycle["state"] == "open" else []
    ship_platforms: set[str] = set()
    for t in ships:
        ship_platforms |= set(_qa_platforms(t["platforms"], platforms))
    next_version = _bump(cycle["version"])
    release_wf = None
    if cycle.get("release_workflow_id"):
        w = svc.one("SELECT id, title, status, dry_run FROM workflows WHERE id=%s", (cycle["release_workflow_id"],))
        release_wf = dict(w) if w else None
    next_cycle = None
    if cycle.get("next_cycle_id"):
        cur.execute("SELECT id, version, branch FROM release_cycles WHERE id=%s", (cycle["next_cycle_id"],))
        n = cur.fetchone()
        next_cycle = dict(n) if n else None
    previous = None
    if cycle.get("previous_cycle_id"):
        cur.execute("SELECT id, version FROM release_cycles WHERE id=%s", (cycle["previous_cycle_id"],))
        n = cur.fetchone()
        previous = dict(n) if n else None
    out = {
        "id": cycle["id"], "container_id": cycle["container_id"], "version": cycle["version"],
        "branch": cycle["branch"], "base_branch": cycle["base_branch"], "milestone": cycle["milestone"],
        "state": cycle["state"], "platforms": platforms, "roles": _load(cycle["roles"], {}),
        "engineers": _load(cycle["engineers"], {}), "dry_run": bool(cycle["dry_run"]),
        "branch_state": cycle["branch_state"], "branch_note": cycle["branch_note"],
        "created_at": cycle["created_at"], "cut_at": cycle["cut_at"],
        "release_workflow": release_wf, "next_cycle": next_cycle, "previous_cycle": previous,
        "counts": {
            "total": len(live), "merged": sum(1 for t in live if t["merged"]),
            "checked": sum(1 for t in live if t["checked"]), "needs_you": sum(1 for t in live if t["needs_you"]),
            "building": sum(1 for t in live if not t["merged"]),
        },
        "cut": {
            "ships": [t["id"] for t in ships], "rolls": [t["id"] for t in rolls],
            "platforms": [p for p in templates.PLATFORMS if p in ship_platforms],
            "unchecked": [t["id"] for t in ships if not t["checked"]],
            "next_version": next_version, "next_branch": _branch_for(next_version),
        },
        "release_params": {
            "source": "cycle", "version": cycle["version"], "release_branch": cycle["branch"],
            "next_release_branch": _branch_for(next_version),
            "platforms": [p for p in templates.PLATFORMS if p in ship_platforms],
            "batch_summary": "\n".join(_summary_line(t) for t in ships),
        },
    }
    if with_tickets:
        out["tickets"] = views
    return out


# ---- routes ------------------------------------------------------------------------------


@app.get("/api/containers/{cid}/release-cycles", tags=["release cycles"])
def list_cycles(cid: str, request: Request):
    """Every cycle of the project, newest first, with the version the next one would take."""
    with db_cursor(readonly=True) as (_, cur):
        require_member_read(cur, request, cid)
        cur.execute("SELECT * FROM release_cycles WHERE container_id=%s ORDER BY created_at DESC LIMIT 50", (cid,))
        rows = [dict(r) for r in cur.fetchall()]
        cycles = [cycle_view(cur, r, with_tickets=False) for r in rows]
        real = [r for r in rows if not r["dry_run"]]
        suggested = _bump(real[0]["version"]) if real else None
        return {
            "cycles": cycles,
            "open": next((c["id"] for c in cycles if c["state"] == "open" and not c["dry_run"]), None),
            "open_dry_run": next((c["id"] for c in cycles if c["state"] == "open" and c["dry_run"]), None),
            "suggested": {"version": suggested, "branch": _branch_for(suggested) if suggested else None},
        }


def _open_cycle(cur, cid, actor_id, *, version, branch, base, milestone, platforms, roles, engineers,
                create_branch, dry_run, previous=None) -> dict:
    cur.execute("SELECT id, version FROM release_cycles WHERE container_id=%s AND state='open' AND dry_run=%s",
                (cid, bool(dry_run)))
    other = cur.fetchone()
    if other:
        conflict("cycle_open", f"Release {other['version']} is still open. Cut it first.", status=409,
                 cycle_id=str(other["id"]))
    version = version.strip()
    branch = (branch or "").strip() or _branch_for(version)
    if not re.fullmatch(r"[A-Za-z0-9._/-]{1,120}", branch) or ".." in branch or branch.startswith(("-", "/")):
        conflict("branch_invalid", "A branch name is letters, digits, . _ / and -.", status=422)
    platforms = [p for p in templates.PLATFORMS if p in platforms]
    if not platforms:
        conflict("platforms_required", "Choose at least one platform.", status=422)
    if dry_run:
        state, note = "skipped", "Dry run: no branch is made and no agent wakes."
    elif create_branch:
        state, note = ensure_branch(branch, base)
    else:
        state, note = "pending", "Make the branch yourself, or ask for it here."
    cycle_id = str(uuid4())
    cur.execute(
        "INSERT INTO release_cycles(id, container_id, version, branch, base_branch, milestone, platforms, roles, "
        "engineers, dry_run, branch_state, branch_note, previous_cycle_id, created_by) "
        "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
        (cycle_id, cid, version, branch, base, (milestone or version).strip() or None, json.dumps(platforms),
         json.dumps({k: v for k, v in (roles or {}).items() if v}),
         json.dumps({k: v for k, v in (engineers or {}).items() if v and k in templates.PLATFORMS}),
         bool(dry_run), state, note, previous, actor_id),
    )
    return _cycle(cur, cycle_id)


@app.post("/api/containers/{cid}/release-cycles", tags=["release cycles"])
def open_cycle(cid: str, body: OpenCycleBody, request: Request):
    """Open a cycle: its version, its release branch (made on origin from the base branch unless
    told not to) and who does what for every ticket. One open cycle at a time (and one dry run)."""
    service.require_capability()
    with db_cursor() as (_, cur):
        actor = resolve_human_actor(cur, request, cid)
        c = _open_cycle(cur, cid, actor.id, version=body.version, branch=body.branch, base=body.base_branch,
                        milestone=body.milestone, platforms=body.platforms, roles=body.roles,
                        engineers=body.engineers, create_branch=body.create_branch, dry_run=body.dry_run)
        return cycle_view(cur, c)


def _readable(cur, request, cycle_id) -> dict:
    c = _cycle(cur, cycle_id)
    require_member_read(cur, request, c["container_id"])
    return c


@app.get("/api/release-cycles/{cycle_id}", tags=["release cycles"])
def get_cycle(cycle_id: str, request: Request):
    with db_cursor(readonly=True) as (_, cur):
        return cycle_view(cur, _readable(cur, request, cycle_id))


@app.patch("/api/release-cycles/{cycle_id}", tags=["release cycles"])
def change_cycle(cycle_id: str, body: SettingsBody, request: Request):
    """Who does what for the tickets added from now on, and the milestone to read."""
    with db_cursor() as (_, cur):
        c = _cycle(cur, cycle_id)
        resolve_human_actor(cur, request, c["container_id"])
        if body.roles is not None:
            cur.execute("UPDATE release_cycles SET roles=%s WHERE id=%s",
                        (json.dumps({k: v for k, v in body.roles.items() if v}), cycle_id))
        if body.engineers is not None:
            cur.execute("UPDATE release_cycles SET engineers=%s WHERE id=%s",
                        (json.dumps({k: v for k, v in body.engineers.items() if v and k in templates.PLATFORMS}), cycle_id))
        if body.milestone is not None:
            cur.execute("UPDATE release_cycles SET milestone=%s WHERE id=%s", (body.milestone.strip() or None, cycle_id))
        return cycle_view(cur, _cycle(cur, cycle_id))


@app.post("/api/release-cycles/{cycle_id}/branch", tags=["release cycles"])
def make_branch(cycle_id: str, request: Request):
    """Make the release branch on origin now (after a failure, or when it was left to a person)."""
    with db_cursor() as (_, cur):
        c = _cycle(cur, cycle_id)
        resolve_human_actor(cur, request, c["container_id"])
        if c["dry_run"]:
            conflict("dry_run", "A dry run makes no branch.", status=422)
        state, note = ensure_branch(c["branch"], c["base_branch"])
        cur.execute("UPDATE release_cycles SET branch_state=%s, branch_note=%s WHERE id=%s", (state, note, cycle_id))
        return cycle_view(cur, _cycle(cur, cycle_id))


@app.get("/api/release-cycles/{cycle_id}/github", tags=["release cycles"])
def github_candidates(cycle_id: str, request: Request):
    """The open issues in the cycle's GitHub milestone, each marked when a ticket already has it.
    Read only: nothing on GitHub changes."""
    with db_cursor(readonly=True) as (_, cur):
        c = _readable(cur, request, cycle_id)
        resolve_human_actor(cur, request, c["container_id"])
        cur.execute(
            "SELECT t.issue_number, c.version FROM release_cycle_tickets t JOIN release_cycles c ON c.id=t.cycle_id "
            "WHERE t.container_id=%s AND t.issue_number IS NOT NULL AND t.state<>'dropped' AND c.dry_run=%s",
            (c["container_id"], bool(c["dry_run"])),
        )
        taken = {int(r["issue_number"]): r["version"] for r in cur.fetchall()}
        milestone = c["milestone"] or c["version"]
        try:
            repo, token = github_repo(cur, c["container_id"], request)
        except Exception as exc:  # noqa: BLE001 - not connected is a state the panel shows, not an error
            detail = getattr(exc, "detail", None)
            return {"milestone": milestone, "issues": [], "repo": None,
                    "error": (detail.get("message") if isinstance(detail, dict) else None) or str(exc)}
    issues, error = milestone_issues(repo, token, milestone)
    for i in issues:
        i["in_cycle"] = taken.get(i["number"])
    return {"milestone": milestone, "issues": issues, "error": error, "repo": repo}


@app.get("/api/release-cycles/{cycle_id}/github/issues/{number}", tags=["release cycles"])
def github_issue(cycle_id: str, number: int, request: Request):
    with db_cursor(readonly=True) as (_, cur):
        c = _readable(cur, request, cycle_id)
        resolve_human_actor(cur, request, c["container_id"])
        repo, token = github_repo(cur, c["container_id"], request)
    return read_issue(repo, token, number)


def _engineer_for(cycle: dict, platforms: list[str], chosen: str | None) -> str | None:
    if chosen:
        return chosen
    engineers = _load(cycle["engineers"], {})
    own = {engineers.get(p) for p in platforms if engineers.get(p)}
    if len(own) == 1:
        return own.pop()
    return _load(cycle["roles"], {}).get("engineer")


def add_ticket(cur, cycle: dict, actor, body: TicketBody, request: Request | None = None) -> tuple[str, str | None]:
    if cycle["state"] != "open":
        conflict("cycle_closed", "This cycle was cut. Add tickets to the next one.", status=409)
    title, text, url, labels = (body.title or "").strip(), body.body, body.url, list(body.labels)
    if body.issue_number and not title:
        issue = read_issue(*github_repo(cur, cycle["container_id"], request), body.issue_number)
        title, text, url, labels = issue["title"], issue["body"], issue["url"], issue["labels"]
    if not title:
        conflict("title_required", "Give the ticket a title, or an issue number to read it from.", status=422)
    from_labels, kind_from_labels = labels_say(labels)
    platforms = [p for p in templates.PLATFORMS if p in (body.platforms or from_labels)]
    if not platforms:
        conflict("platforms_required", "Choose the platforms this ticket touches.", status=422)
    kind = body.kind or kind_from_labels or "bug"
    issue_number, notice = body.issue_number, None
    if body.create_issue and not issue_number:
        if cycle["dry_run"]:
            notice = "Dry run: no issue was opened on GitHub."
        else:
            words = ", ".join(templates.PLATFORM_WORD[p] for p in platforms)
            issue_body = f"{text.strip()}\n\n---\n{kind.capitalize()} · {words} · release {cycle['version']} (logged in Embodent)"
            repo, token = github_repo(cur, cycle["container_id"], request)
            issue_number, url, notice = open_issue(repo, token, cycle["container_id"], title, issue_body,
                                                   cycle["milestone"] or cycle["version"])
    if issue_number:
        cur.execute("SELECT id FROM release_cycle_tickets WHERE cycle_id=%s AND issue_number=%s AND state<>'dropped'",
                    (cycle["id"], issue_number))
        if cur.fetchone():
            conflict("ticket_exists", f"#{issue_number} is already in this cycle.", status=409)
    ticket_id = str(uuid4())
    roles = {**_load(cycle["roles"], {}), "owner": actor.id}
    roles["engineer"] = _engineer_for(cycle, platforms, body.engineer_id)
    ref = f"#{issue_number}" if issue_number else ""
    params = {
        "platforms": _qa_platforms(platforms, _load(cycle["platforms"], list(templates.PLATFORMS))),
        "kind": kind, "issue_ref": ref or "this ticket", "issue_title": title, "issue_url": url or "",
        "issue_body": text or "", "release_branch": cycle["branch"], "cycle_version": cycle["version"],
        "cycle_id": cycle["id"],
    }
    created = release.start_from_template(cur, cycle["container_id"], actor, release.FromTemplateBody(
        key=TICKET_KEY, params=params, roles=roles, dry_run=bool(cycle["dry_run"]), start=True,
        title=f"{ref} {title}".strip()[:200], idempotency_key=f"cycle-ticket:{ticket_id}",
    ))
    if body.attachments:
        _carry_attachments(cur, created["id"], actor.id, body.attachments)
    cur.execute(
        "INSERT INTO release_cycle_tickets(id, cycle_id, container_id, workflow_id, issue_number, issue_url, title, "
        "kind, platforms, source, added_by) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
        (ticket_id, cycle["id"], cycle["container_id"], created["id"], issue_number, url, title[:200], kind,
         json.dumps(platforms), body.source, actor.id),
    )
    return ticket_id, notice


def _carry_attachments(cur, wid: str, author: str, refs: list[dict]) -> None:
    """Copy the report's images from the intake conversation to the ticket's first step (and its
    build step, when that's another one) and post them there, so whoever works it sees them."""
    import shutil as _shutil

    from portal_backend.attachment_references import (
        attachment_ref, conversation_attachments_dir, resolve_stored_conv_attachment, task_attachments_dir,
    )
    from portal_backend.attachment_storage import contained_path

    cur.execute("SELECT id, step_spec FROM tasks WHERE workflow_id=%s ORDER BY priority, created_at, id", (wid,))
    rows = [dict(r) for r in cur.fetchall()]
    targets = [rows[0]["id"]] if rows else []
    build = next((r["id"] for r in rows if (steps.spec_of(r) or {}).get("key") == "implement"), None)
    if build and build not in targets:
        targets.append(build)
    for tid in targets:
        out = []
        for ref in refs[:10]:
            conv, stored = str(ref.get("conversation_id") or ""), str(ref.get("id") or "")
            try:
                conversation_attachments_dir(conv)
                src = resolve_stored_conv_attachment(conv, stored)
            except Exception:  # noqa: BLE001 - a bad ref is skipped, the ticket still lands
                src = None
            if src is None:
                continue
            tdir = task_attachments_dir(tid)
            tdir.mkdir(parents=True, exist_ok=True)
            dest = contained_path(tdir, stored)
            if dest is None:
                continue
            _shutil.copyfile(src, dest)
            out.append(attachment_ref(tid, stored, str(ref.get("name") or stored), dest.stat().st_size, dest))
        if out:
            cur.execute(
                "INSERT INTO task_messages (task_id, author_id, body, attachments) VALUES (%s,%s,%s,%s)",
                (tid, author, "Screenshots and recording frames from the report.", json.dumps(out)),
            )


@app.post("/api/release-cycles/{cycle_id}/tickets", tags=["release cycles"])
def create_ticket(cycle_id: str, body: TicketBody, request: Request):
    """Add a ticket and start it: an issue number (read with gh when no title is sent) or a title
    typed here. Platforms come from the body, else from the issue's labels."""
    service.require_capability()
    with db_cursor() as (_, cur):
        c = _cycle(cur, cycle_id)
        actor = resolve_human_actor(cur, request, c["container_id"])
        ticket_id, notice = add_ticket(cur, c, actor, body, request)
        return {**cycle_view(cur, _cycle(cur, cycle_id)), "added": ticket_id, "notice": notice}


@app.post("/api/release-cycles/{cycle_id}/tickets/{ticket_id}/drop", tags=["release cycles"])
def drop_ticket(cycle_id: str, ticket_id: str, request: Request):
    """Take a ticket out of the cycle and stop its workflow. A merged ticket can't be dropped:
    it's in the branch, so revert it there instead."""
    with db_cursor() as (_, cur):
        c = _cycle(cur, cycle_id)
        actor = resolve_human_actor(cur, request, c["container_id"])
        cur.execute("SELECT * FROM release_cycle_tickets WHERE id=%s AND cycle_id=%s", (ticket_id, cycle_id))
        t = cur.fetchone()
        if not t:
            conflict("ticket_not_found", "Ticket not found.", status=404)
        svc = service.WorkflowService(cur, HOOKS)
        w = svc.one("SELECT * FROM workflows WHERE id=%s", (t["workflow_id"],)) if t["workflow_id"] else None
        if ticket_view(svc, dict(t), w)["merged"]:
            conflict("ticket_merged", "It's merged into the release branch. Revert it there to take it out.", status=409)
        if w and w["status"] in {"active", "paused"}:
            svc.mutate(c["container_id"], actor, "cancel",
                       {"expected_revision": w["revision"], "idempotency_key": uuid4().hex,
                        "reason": f"Taken out of release {c['version']}."}, wid=w["id"])
        cur.execute("UPDATE release_cycle_tickets SET state='dropped', updated_at=%s WHERE id=%s",
                    (sql.ts(sql.utcnow()), ticket_id))
        return cycle_view(cur, _cycle(cur, cycle_id))


def _tell_rolled(cur, svc, ticket: dict, author: str, old: dict, new: dict) -> None:
    """Leave a note on the rolled ticket's open steps: its agent reads the new branch there."""
    if not ticket["workflow_id"]:
        return
    rows = svc.rows("SELECT id FROM tasks WHERE workflow_id=%s AND status NOT IN ('completed','cancelled')",
                    (ticket["workflow_id"],))
    note = (f"This ticket moved from release {old['version']} to {new['version']}. Its branch is now "
            f"{new['branch']}, not {old['branch']}: rebase onto origin/{new['branch']}, and retarget any open PR "
            f"(`gh pr edit <number> --base {new['branch']}`).")
    for r in rows[:20]:
        cur.execute("INSERT INTO task_messages (task_id, author_id, body) VALUES (%s,%s,%s)", (r["id"], author, note))
    # The run page links a ticket to its cycle from the template's parameters: point them at the new one.
    w = svc.one("SELECT template_ref FROM workflows WHERE id=%s", (ticket["workflow_id"],))
    ref = steps.template_of(w) if w else None
    if ref:
        ref["params"] = {**(ref.get("params") or {}), "cycle_id": new["id"], "cycle_version": new["version"],
                         "release_branch": new["branch"]}
        cur.execute("UPDATE workflows SET template_ref=%s WHERE id=%s", (json.dumps(ref), ticket["workflow_id"]))


@app.post("/api/release-cycles/{cycle_id}/cut", tags=["release cycles"])
def cut_cycle(cycle_id: str, body: CutBody, request: Request):
    """The cut: everything merged into the release branch ships in one Mobile App Release made
    from that branch; everything not merged rolls to the next cycle, which opens now with its own
    branch. Refused while nothing is merged."""
    service.require_capability()
    with db_cursor() as (_, cur):
        c = _cycle(cur, cycle_id)
        actor = resolve_human_actor(cur, request, c["container_id"])
        if c["state"] != "open":
            conflict("cycle_cut", "This cycle was already cut.", status=409)
        view = cycle_view(cur, c)
        if not view["cut"]["ships"]:
            conflict("nothing_merged", "Nothing is merged into the release branch yet.", status=422)
        next_version = (body.next_version or view["cut"]["next_version"]).strip()
        params = {**view["release_params"], **{k: v for k, v in body.params.items() if v not in (None, "")}}
        params.update(source="cycle", release_branch=c["branch"], next_release_branch=_branch_for(next_version),
                      batch_summary=view["release_params"]["batch_summary"], cycle_id=c["id"], cycle_version=c["version"])
        created = release.start_from_template(cur, c["container_id"], actor, release.FromTemplateBody(
            key=RELEASE_KEY, params=params, removed=body.removed, added=body.added, roles=body.roles,
            dry_run=bool(c["dry_run"]), start=True, idempotency_key=body.idempotency_key,
        ))
        now = sql.ts(sql.utcnow())
        cur.execute("UPDATE release_cycles SET state='cut', cut_at=%s, cut_by=%s, release_workflow_id=%s WHERE id=%s",
                    (now, actor.id, created["id"], cycle_id))
        nxt = _open_cycle(
            cur, c["container_id"], actor.id, version=next_version, branch=None, base=c["base_branch"],
            milestone=None, platforms=_load(c["platforms"], []), roles=_load(c["roles"], {}),
            engineers=_load(c["engineers"], {}), create_branch=True, dry_run=bool(c["dry_run"]), previous=c["id"],
        )
        svc = service.WorkflowService(cur, HOOKS)
        ships, rolls = set(view["cut"]["ships"]), set(view["cut"]["rolls"])
        for t in _tickets(cur, cycle_id):
            if t["id"] in ships:
                cur.execute("UPDATE release_cycle_tickets SET state='shipped', updated_at=%s WHERE id=%s", (now, t["id"]))
            elif t["id"] in rolls:
                cur.execute("UPDATE release_cycle_tickets SET cycle_id=%s, rolled_from_cycle_id=%s, updated_at=%s "
                            "WHERE id=%s", (nxt["id"], cycle_id, now, t["id"]))
                _tell_rolled(cur, svc, t, actor.id, c, nxt)
        cur.execute("UPDATE release_cycles SET next_cycle_id=%s WHERE id=%s", (nxt["id"], cycle_id))
        return {"cycle": cycle_view(cur, _cycle(cur, cycle_id)), "release_workflow_id": created["id"],
                "next_cycle_id": nxt["id"]}


def board_cycles(cur, cid: str) -> list[dict]:
    """The open cycles (and one cut whose release still runs) for the Workflows home."""
    cur.execute("SELECT * FROM release_cycles WHERE container_id=%s ORDER BY created_at DESC LIMIT 10", (cid,))
    out = []
    for r in cur.fetchall():
        r = dict(r)
        if r["state"] == "open":
            out.append(cycle_view(cur, r, with_tickets=False))
        elif r["state"] == "cut" and r["release_workflow_id"]:
            cur.execute("SELECT status FROM workflows WHERE id=%s", (r["release_workflow_id"],))
            w = cur.fetchone()
            if w and w["status"] in {"active", "paused"}:
                out.append(cycle_view(cur, r, with_tickets=False))
    return out
