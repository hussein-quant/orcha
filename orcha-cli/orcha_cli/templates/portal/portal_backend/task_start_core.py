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
"""

from portal_backend.agent_status import log_event, recompute_agent_status
from portal_backend.events import publish_event

# The GitHub-hub / Slack task title prefix. `GH #<number>: <title>` — the prefix is
# also the idempotency key (a LIKE 'GH #N: %' probe over the container's open tasks).
GH_TITLE_PREFIX = "GH #"

# Non-terminal statuses that count as "already tracked" for idempotency. A task in any
# of these is live work for this issue/PR; a completed/cancelled one does NOT block a
# fresh start (you can re-trigger an issue after its first task closed).
_OPEN_STATUSES = ("pending", "ready", "not_ready", "in_progress", "needs_verification")

_ISSUE_DOD = (
    "Fix GH #{n} per its description. Open a PR referencing #{n}. "
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


def find_open_gh_task(cur, container_id, number: int):
    """The container's OPEN task already tracking GH #<number>, or None.

    Matches on the `GH #<number>: ` title prefix (the exact string build_task_fields
    writes) so the probe cannot false-match `GH #12` against `GH #123`. Only
    non-terminal tasks count — a finished/cancelled prior task never blocks a
    re-trigger. Returns the task id (str) or None.
    """
    cur.execute(
        """SELECT id FROM tasks
             WHERE container_id=%s
               AND status = ANY(%s)
               AND title LIKE %s
             ORDER BY created_at ASC, id ASC
             LIMIT 1""",
        (container_id, list(_OPEN_STATUSES), f"{GH_TITLE_PREFIX}{number}: %"),
    )
    row = cur.fetchone()
    return str(row["id"]) if row else None


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
    return {"task_id": tid, "existing": False}
