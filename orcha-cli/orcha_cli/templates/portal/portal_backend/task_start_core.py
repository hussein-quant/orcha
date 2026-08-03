"""The single source of truth for "start an Orcha task from an external trigger".

Feature A (the GitHub hub's POST /github/start) and Feature B (the Slack
`/orcha start ...` slash command) both create an Orcha task from a GitHub
issue/PR. Rather than duplicate the task-creation + assignment mechanics — or
worse, let the two drift — both call ONE function here: `start_task_from_github`.

It reuses the EXACT DB mechanics `task_creation_routes.create_task` uses (the same
`tasks` INSERT columns/defaults, the same `agent_tasks` 'working' row + no-bump +
`recompute_agent_status` + targeted `task_assigned` event, the same `events`
audit row), so a task born from the hub, from Slack, or from the tasks API is
indistinguishable downstream. The caller owns the transaction (passes the open
`cur`) and the commit — this function never commits, so it composes inside a
route handler's `db_cursor()` block and its writes roll back atomically with the
handler on any error.

Idempotency (spec): an OPEN task whose title already carries the `GH #<N>: `
prefix for the same (container, number) is returned with existing=True instead of
creating a duplicate — a double-click on Start, or a Slack retry, is a no-op.

GitHub round-trip comment (fresh starts only): once the task row lands, this posts
a short "🤖 Orcha started task ..." comment back on the source issue/PR — the ONE
place every dispatch path (hub Start/Fix, Slack start) goes through, so it fires
exactly once regardless of caller. It is deliberately posted from HERE, after the
INSERT but still inside the caller's transaction span (the comment itself is not
transactional — a GitHub POST cannot be rolled back — but it only fires once the
task row is built in-memory with a real id, and never on an `existing=True` hit).
Non-fatal by construction, same contract as slack_notify's outbound ping: any
failure (repo not bound, no installation token, GitHub 403/404/network error) is
caught and swallowed — a dead GitHub comment must never break task creation.
"""

import json
import urllib.error
import urllib.request

from portal_backend.agent_status import log_event, recompute_agent_status
from portal_backend.events import publish_event
from portal_backend.github_routes import _read_token, _read_token_map

GITHUB_API = "https://api.github.com"
GITHUB_COMMENT_TIMEOUT_SECONDS = 10

# The GitHub-hub / Slack task title prefix. `GH #<number>: <title>` — the prefix is
# also the idempotency key (a LIKE 'GH #N: %' probe over the container's open tasks).
GH_TITLE_PREFIX = "GH #"

# Non-terminal statuses that count as "already tracked" for idempotency. A task in any
# of these is live work for this issue/PR; a completed/cancelled one does NOT block a
# fresh start (you can re-trigger an issue after its first task closed).
_OPEN_STATUSES = ("pending", "ready", "not_ready", "in_progress", "needs_verification")

_ISSUE_DOD = (
    "Before implementing: post a triage comment on GH issue #{n} with codebase-grounded "
    "analysis — the specific modules/files involved, the most likely cause ranked "
    "against the actual code, and what logs/repro would confirm it. Then proceed to "
    "the fix. Fix GH #{n} per its description. Open a PR referencing #{n}. "
    "Fresh-session review, then human review. Never merge."
)
_PULL_DOD = (
    "Resolve CI failures / review feedback on PR #{n}. Push to its branch. "
    "NOT merged without human review."
)

# What the two kinds are called in copy. Keep in sync with the DoD templates above.
_KIND_LABEL = {"issue": "issue", "pull": "pull request"}


def build_task_fields(kind: str, number: int, gh_title: str, body_excerpt: str,
                      html_url: str, dod_override: str = None) -> dict:
    """Compose the {title, description, definition_of_done} an external GH trigger
    creates — the spec's templated shape. Pure (no DB), so tests can assert the copy
    directly and both trigger seams share one template. `kind` is 'issue' | 'pull'.

    `dod_override`, when given, REPLACES the generic static `_PULL_DOD`/`_ISSUE_DOD`
    template outright — the GitHub hub's PR "Fix" dispatch (github_hub_routes.py)
    passes a context-aware DoD composed from the PR's actual live state (failing
    checks by name, pending count, review-comment count, draft/mergeable_state) instead
    of this generic fallback; the Slack seam and issue dispatches never pass one, so
    their behavior is unchanged.
    """
    title = f"{GH_TITLE_PREFIX}{number}: {gh_title}".strip()
    dod = dod_override if dod_override else (_PULL_DOD if kind == "pull" else _ISSUE_DOD).format(n=number)
    excerpt = (body_excerpt or "").strip()
    parts = []
    if excerpt:
        parts.append(excerpt)
    if html_url:
        parts.append(html_url)
    parts.append("Triggered from the GitHub hub")
    description = "\n\n".join(parts)
    return {"title": title, "description": description, "definition_of_done": dod}


def _resolve_repo_token(repo: str):
    """The installation token that can read/write `owner/name`, or None when the App
    isn't wired for this owner. Duplicates github_hub_routes._resolve_repo_token's
    logic (rather than importing it) to avoid a circular import: github_hub_routes
    already imports THIS module. Same multi-org-then-legacy-file resolution."""
    owner = (repo or "").split("/", 1)[0].lower()
    token_map = _read_token_map()
    if token_map and owner in token_map:
        return token_map[owner]
    return _read_token()


def _gh_post_comment(repo: str, number: int, token: str, body: str) -> None:
    """POST a comment on a GitHub issue OR pull request. GitHub's REST API treats PR
    comments as issue comments on the SAME endpoint
    (`/repos/{repo}/issues/{number}/comments`) — no separate PR-comment call needed.
    Requires the App's Issues:write permission (docs/byoc-guide.md's permission table;
    already required for `gh issue create`). stdlib urllib, matching every other
    GitHub leaf in this codebase. Raises on failure; the caller swallows it — this
    function itself never degrades silently so tests can assert on the raise.
    """
    url = f"{GITHUB_API}/repos/{repo}/issues/{number}/comments"
    request = urllib.request.Request(
        url,
        data=json.dumps({"body": body}).encode("utf-8"),
        headers={
            "Authorization": f"token {token}",
            "Accept": "application/vnd.github+json",
            "Content-Type": "application/json",
            "User-Agent": "orcha-portal",
        },
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=GITHUB_COMMENT_TIMEOUT_SECONDS) as response:
        response.read()


def _compose_start_comment(task_id: str, assignee_alias) -> str:
    """The round-trip comment body: who's on it, and the standing verification gate.
    `assignee_alias` is None for an unassigned (Atlas-routed) start."""
    who = f"assigned to **{assignee_alias}**" if assignee_alias \
        else "unassigned — the orchestrator routes it"
    short_id = str(task_id)[:8]
    return (
        f"🤖 Orcha started task `{short_id}` for this — {who}.\n"
        "Work arrives as a PR; a human verifies before anything merges."
    )


def _post_start_comment(cur, container_id, kind: str, number: int, task_id: str,
                        assignee_agent_id) -> None:
    """Best-effort GitHub round-trip comment on a FRESH start (never on an
    existing=True re-click — the caller only invokes this after a real INSERT).
    Non-fatal by construction, same contract as slack_notify's outbound ping: no
    bound repo, no installation token, or any GitHub/network failure is caught and
    swallowed — a dead comment must never break task creation. Runs from the shared
    core so every dispatch path (hub, Slack) gets it exactly once.
    """
    try:
        cur.execute("SELECT github_repo FROM containers WHERE id=%s", (container_id,))
        row = cur.fetchone()
        repo = row["github_repo"] if row else None
        if not repo:
            return
        token = _resolve_repo_token(repo)
        if not token:
            return
        assignee_alias = None
        if assignee_agent_id:
            cur.execute("SELECT alias FROM agents WHERE id=%s", (assignee_agent_id,))
            arow = cur.fetchone()
            assignee_alias = arow["alias"] if arow else None
        body = _compose_start_comment(task_id, assignee_alias)
        _gh_post_comment(repo, number, token, body)
    except Exception:
        pass  # best-effort by contract — a GitHub comment failure never breaks the start


def find_open_gh_tasks(cur, container_id, numbers) -> dict:
    """Batched form of find_open_gh_task: the container's OPEN task id for EVERY number
    in `numbers`, in ONE query — {number: task_id} for numbers that have an open task
    (a number with none is simply absent from the dict, never a None entry). This is
    THE lookup GitHub-hub list/detail rows use to surface "tracked" state up front
    (github_hub_routes' `tracked_task_id` field) — sharing this helper with
    find_open_gh_task (below, which is just this batched form for one number) is
    deliberate: the idempotency check and the hub's "is this already tracked" display
    must use the IDENTICAL title-prefix/status rule or the two can silently drift (a
    row the idempotency check would treat as open but the hub UI doesn't show as
    tracked, or vice versa).

    Matches each number's `GH #<number>: ` title prefix (the exact string
    build_task_fields writes) via a single unnest()+LATERAL join — a LIKE-per-number
    loop would be N queries; this is one, regardless of how many numbers are asked
    about. Only non-terminal statuses count (mirrors find_open_gh_task). Numbers list
    may be empty (returns {} without a query).
    """
    numbers = [int(n) for n in (numbers or [])]
    if not numbers:
        return {}
    cur.execute(
        """SELECT v.number AS number, t.id AS task_id
             FROM (SELECT unnest(%s::int[]) AS number) v
             JOIN LATERAL (
               SELECT id FROM tasks
                WHERE container_id=%s
                  AND status = ANY(%s)
                  AND title LIKE %s || v.number::text || ': %%'
                ORDER BY created_at ASC, id ASC
                LIMIT 1
             ) t ON true""",
        (numbers, container_id, list(_OPEN_STATUSES), GH_TITLE_PREFIX),
    )
    return {int(row["number"]): str(row["task_id"]) for row in cur.fetchall()}


def find_open_gh_task(cur, container_id, number: int):
    """The container's OPEN task already tracking GH #<number>, or None.

    Matches on the `GH #<number>: ` title prefix (the exact string build_task_fields
    writes) so the probe cannot false-match `GH #12` against `GH #123`. Only
    non-terminal tasks count — a finished/cancelled prior task never blocks a
    re-trigger. Returns the task id (str) or None.

    Implemented as the single-number case of find_open_gh_tasks (the batched helper
    the hub's list/detail endpoints use) so the idempotency check and the "tracked"
    display can never drift apart — one SQL shape, two call shapes.
    """
    return find_open_gh_tasks(cur, container_id, [number]).get(number)


def start_task_from_github(cur, container_id, *, kind: str, number: int,
                           gh_title: str, body_excerpt: str, html_url: str,
                           created_by_agent_id, assignee_agent_id=None,
                           source: str = "github_hub", dod_override: str = None):
    """Create (or idempotently return) the Orcha task for a GitHub issue/PR.

    Reuses create_task's DB mechanics verbatim. Returns
    {"task_id": <str>, "existing": <bool>}:
      * existing=True  → an OPEN task already tracked GH #number; nothing was written.
      * existing=False → a new task was created (and, if assignee_agent_id was given,
                         assigned + the assignee woken via a targeted task_assigned).

    `created_by_agent_id` is the resolved acting member (the hub/Slack route resolves
    it through the same identity gate task creation uses); it is attributed as the
    creator and audited. `assignee_agent_id`, when present, must be a live AI agent in
    THIS container — the caller validates that before calling (mirroring create_task's
    assignee_alias resolution, but by id since the hub dropdown/Slack carry agent ids).
    `source` is a free-text provenance tag ('github_hub' | 'slack') recorded on the
    audit + wake events so the two seams are distinguishable in the log. `dod_override`
    passes straight through to build_task_fields — see that function's docstring.

    The caller owns the commit. Never commits or opens its own connection.
    """
    if kind not in ("issue", "pull"):
        raise ValueError(f"kind must be 'issue' or 'pull', got {kind!r}")

    existing = find_open_gh_task(cur, container_id, number)
    if existing:
        return {"task_id": existing, "existing": True}

    fields = build_task_fields(kind, number, gh_title, body_excerpt, html_url, dod_override)

    # Mirror create_task: an explicitly-assigned task starts 'in_progress' with
    # started_at stamped; an unassigned one lands 'ready' (Atlas routes it). No deps
    # and no protocol on an externally-triggered task, so the branchy create_task logic
    # collapses to exactly these two cases.
    assignee_id = str(assignee_agent_id) if assignee_agent_id else None
    initial_status = "in_progress" if assignee_id else "ready"
    started_clause = "now()" if assignee_id else "NULL"

    cur.execute(
        f"""INSERT INTO tasks
              (container_id, title, description, definition_of_done,
               status, priority, created_by_agent_id, started_at)
            VALUES (%s, %s, %s, %s, %s, %s, %s, {started_clause})
            RETURNING id""",
        (
            container_id,
            fields["title"],
            fields["description"],
            fields["definition_of_done"],
            initial_status,
            100,
            created_by_agent_id,
        ),
    )
    tid = str(cur.fetchone()["id"])

    if assignee_id:
        # Same as create_task: a 'working' agent_tasks row, NO bump_agent (that would
        # shrink idle_seconds and suppress the wake), recompute_agent_status off the
        # row, then a targeted task_assigned so the wake machinery fires.
        cur.execute(
            """INSERT INTO agent_tasks (agent_id, task_id, assignment_status)
               VALUES (%s, %s, 'working')""",
            (assignee_id, tid),
        )
        recompute_agent_status(cur, assignee_id)
        publish_event(
            cur,
            str(container_id),
            assignee_id,
            "task_assigned",
            {"task_id": tid, "title": fields["title"], "via": f"{source} start"},
        )

    actor_type = "ai" if created_by_agent_id else "human"
    log_event(
        cur,
        str(container_id),
        actor_type,
        created_by_agent_id,
        "task",
        tid,
        "created",
        {
            "title": fields["title"],
            "status": initial_status,
            "source": source,
            "gh_kind": kind,
            "gh_number": number,
            "assignee_agent_id": assignee_id,
        },
    )
    # Fresh start only (never on an existing=True hit, which returns above before this
    # point) — the round-trip "Orcha started this" comment. Best-effort; see
    # _post_start_comment's docstring for the non-fatal contract.
    _post_start_comment(cur, container_id, kind, number, tid, assignee_id)
    return {"task_id": tid, "existing": False}
