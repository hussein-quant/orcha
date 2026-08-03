"""Slack trigger seam (Feature B) — slash commands that TRIGGER Orcha, feature-flagged
OFF unless both SLACK_SIGNING_SECRET and SLACK_BOT_TOKEN are configured.

Security model:
  * Every request's Slack signature is verified (v0 HMAC-SHA256 over
    `v0:{timestamp}:{raw_body}` keyed by SLACK_SIGNING_SECRET) with a ±300s timestamp
    window to stop replays. A bad/absent/stale signature is 401 — before any work.
  * The Slack caller (`user_id`) is mapped to an Orcha member via agents.slack_user_id
    (mig 044). An unknown/unlinked caller gets an EPHEMERAL "link your Slack in
    Settings" reply and never acts — Slack can trigger, but only for a linked member.

Commands (respond within Slack's 3s contract — task creation is fast, done inline):
  * /orcha start issue <N>   → start an Orcha task from GitHub issue #N
  * /orcha start pr <N>      → start an Orcha task from GitHub PR #N
        (both call the SAME start internals the hub uses — task_start_core — so a
         Slack-started task is byte-identical to a hub-started one. Unlike the hub —
         whose frontend already has the issue/PR row in hand from the list it just
         rendered — Slack gives us only a bare number, so this seam does the ONE
         extra live GitHub fetch the hub path gets for free from its caller, reusing
         github_hub_routes' token/GET leaves so both seams hit GitHub the same way.)
  * /orcha tasks             → what needs you: up to 5 needs_verification tasks
                                (linked), open-request and ready-unassigned counts.

External systems TRIGGER and OBSERVE Orcha; the verification/merge gates stay in Orcha.
A Slack start creates a task the same way the hub does — it never completes or merges.
"""

import hashlib
import hmac
import os
import re
import time
import urllib.parse

from fastapi import HTTPException, Request

from portal_backend import github_hub_routes as _hub
from portal_backend.application import app
from portal_backend.database import db_cursor
from portal_backend.github_hub_routes import _excerpt
from portal_backend.slack_notify import (
    blocks_already_tracked,
    blocks_start_success,
    blocks_tasks_summary,
    blocks_unlinked_user,
    blocks_usage_help,
    portal_task_link,
)
from portal_backend.task_start_core import start_task_from_github

SIGNING_SECRET_ENV = "SLACK_SIGNING_SECRET"
BOT_TOKEN_ENV = "SLACK_BOT_TOKEN"
SIGNATURE_MAX_SKEW_SECONDS = 300

_START_RE = re.compile(r"^start\s+(issue|pr)\s+#?(\d+)\s*$", re.IGNORECASE)
_TASKS_RE = re.compile(r"^tasks\s*$", re.IGNORECASE)


def _slack_enabled() -> bool:
    """The feature flag: BOTH secrets present. Read from the environment the same way
    other secrets are (os.environ, like ORCHA_LLM_API_KEY in provider_key_routes). With
    either unset, the endpoint is dark (503) and NO Slack behavior exists."""
    return bool((os.environ.get(SIGNING_SECRET_ENV) or "").strip()
                and (os.environ.get(BOT_TOKEN_ENV) or "").strip())


def _signing_secret() -> str:
    return (os.environ.get(SIGNING_SECRET_ENV) or "").strip()


def verify_slack_signature(raw_body: bytes, timestamp: str, signature: str) -> bool:
    """Slack request signing (v0). True iff the signature matches AND the timestamp is
    within ±300s. Constant-time compare; any missing/malformed field → False.

    basestring = 'v0:{timestamp}:{raw_body}', HMAC-SHA256 keyed by the signing secret,
    hex, prefixed 'v0='. (Slack's documented scheme — docs/slack-integration.md.)
    """
    secret = _signing_secret()
    if not secret or not timestamp or not signature:
        return False
    try:
        ts = int(timestamp)
    except (TypeError, ValueError):
        return False
    if abs(time.time() - ts) > SIGNATURE_MAX_SKEW_SECONDS:
        return False
    basestring = b"v0:" + timestamp.encode() + b":" + raw_body
    digest = hmac.new(secret.encode(), basestring, hashlib.sha256).hexdigest()
    expected = "v0=" + digest
    return hmac.compare_digest(expected, signature)


def _member_for_slack_user(cur, slack_user_id: str):
    """The LIVE human member linked to this Slack user id (mig 044.slack_user_id), or
    None. Matches on the exact id (Slack ids are opaque + case-stable). A container_id
    scoping is not needed for the lookup — but the returned row carries container_id so
    the command acts in that member's project."""
    if not slack_user_id:
        return None
    cur.execute(
        """SELECT id, container_id, alias, github_login FROM agents
           WHERE kind='human' AND terminated_at IS NULL AND slack_user_id=%s
           LIMIT 1""",
        (slack_user_id,),
    )
    return cur.fetchone()


def _ephemeral(blocks: list, fallback_text: str) -> dict:
    """A private (ephemeral) Slack slash-command reply — only the caller sees it.
    `fallback_text` is Slack's plain-text notification-preview fallback (required
    whenever `blocks` is present; never rendered when the client can show blocks)."""
    return {"response_type": "ephemeral", "blocks": blocks, "text": fallback_text}


def _fetch_gh_item(cur, container_id, kind: str, number: int):
    """Live-fetch a GitHub issue/PR's {title, html_url, body_excerpt} for the Slack
    start path — Slack gives us only a bare number, unlike the hub whose frontend
    already has the row (title, html_url, body_excerpt) in hand from the list it just
    rendered and passes straight through (github_hub_routes.GithubStartBody). Reuses
    the SAME token/GET leaves the hub uses (github_hub_routes._resolve_repo_token /
    _gh_get) so both seams hit GitHub identically.

    Returns None on ANY failure (no bound repo, no installation token, GitHub
    unreachable/rate-limited/404) — the caller degrades to the bare '#N' title rather
    than fail the whole command; Slack's 3s contract has no room for a retry loop.

    NOTE: calls `_hub._resolve_repo_token` / `_hub._gh_get` through the MODULE (not a
    direct `from ... import` of the names) so that tests monkeypatching
    `github_hub_routes._gh_get` (the established convention in test_github_hub_routes.py)
    transparently cover this seam too — a direct-name import would have frozen a
    reference to the pre-patch function at import time.
    """
    cur.execute("SELECT github_repo FROM containers WHERE id=%s", (container_id,))
    row = cur.fetchone()
    repo = row["github_repo"] if row else None
    if not repo:
        return None
    token = _hub._resolve_repo_token(repo)
    if not token:
        return None
    path = f"/repos/{repo}/pulls/{number}" if kind == "pull" else f"/repos/{repo}/issues/{number}"
    try:
        raw = _hub._gh_get(path, token)
    except RuntimeError:
        return None
    return {
        "title": raw.get("title") or "",
        "html_url": raw.get("html_url") or "",
        "body_excerpt": _excerpt(raw.get("body")),
    }


def _needs_attention_summary(cur, container_id) -> dict:
    """Data for `/orcha tasks`: up to 5 needs_verification tasks (id + title, for
    linking), plus ready-unassigned and open-request counts — the same "needs you"
    signals the portal surfaces. Read-only OBSERVE; no state change."""
    cur.execute(
        """SELECT id, title FROM tasks
           WHERE container_id=%s AND status='needs_verification'
           ORDER BY started_at ASC NULLS LAST, created_at ASC
           LIMIT 5""",
        (container_id,),
    )
    needs_verification = [{"id": str(r["id"]), "title": r["title"]} for r in cur.fetchall()]
    cur.execute(
        """SELECT count(*) AS n FROM tasks t
           WHERE t.container_id=%s AND t.status='ready' AND t.is_root=false
             AND NOT EXISTS (SELECT 1 FROM agent_tasks at WHERE at.task_id=t.id
                              AND at.assignment_status IN ('assigned','accepted','working'))""",
        (container_id,),
    )
    ready_unassigned = cur.fetchone()["n"]
    cur.execute(
        """SELECT count(*) AS n FROM requests r
           JOIN agents tg ON tg.id=r.target_id
           WHERE r.container_id=%s AND r.status='open' AND tg.kind='human'""",
        (container_id,),
    )
    open_requests = cur.fetchone()["n"]
    return {"needs_verification": needs_verification,
            "ready_unassigned": ready_unassigned,
            "open_requests": open_requests}


def _handle_command(cur, member, text: str) -> dict:
    """Route a verified, linked member's command text to its handler. Returns the Slack
    ephemeral response dict. The caller commits (task creation writes)."""
    cid = str(member["container_id"])
    text = (text or "").strip()

    m = _START_RE.match(text)
    if m:
        kind_word, number = m.group(1).lower(), int(m.group(2))
        kind = "pull" if kind_word == "pr" else "issue"
        # The title-bug fix: fetch the REAL issue/PR title before composing the task,
        # exactly like the hub does (there, the frontend already has it in hand from
        # the list it just rendered and passes it straight through). Slack only gives
        # us a bare number, so this is the one extra live fetch the hub gets for free.
        gh_item = _fetch_gh_item(cur, cid, kind, number)
        gh_title = (gh_item or {}).get("title") or f"#{number}"
        html_url = (gh_item or {}).get("html_url") or ""
        body_excerpt = (gh_item or {}).get("body_excerpt") or ""
        result = start_task_from_github(
            cur,
            cid,
            kind=kind,
            number=number,
            gh_title=gh_title,
            body_excerpt=body_excerpt,
            html_url=html_url,
            created_by_agent_id=str(member["id"]),
            assignee_agent_id=None,  # Slack start is unassigned — Atlas routes it
            source="slack",
        )
        label = "PR" if kind == "pull" else "issue"
        task_link = portal_task_link(cid, result["task_id"])
        if result["existing"]:
            return _ephemeral(
                blocks_already_tracked(label, number, task_link),
                f"Already tracked: {label} #{number} has an open Orcha task.",
            )
        return _ephemeral(
            blocks_start_success(label, number, html_url, gh_title, task_link),
            f"Started an Orcha task for {label} #{number}: {gh_title}",
        )

    if _TASKS_RE.match(text):
        s = _needs_attention_summary(cur, cid)
        blocks = blocks_tasks_summary(
            s["needs_verification"], s["open_requests"], s["ready_unassigned"],
            lambda task_id: portal_task_link(cid, task_id),
        )
        return _ephemeral(blocks, "Needs you in this project")

    return _ephemeral(blocks_usage_help(), "Orcha commands")


@app.post("/api/slack/commands")
async def slack_commands(request: Request):
    """Slack slash-command endpoint (Feature B). Dark (503) unless both Slack secrets
    are set; otherwise: verify signature (401 on bad/stale), map the caller to a member
    (ephemeral "link your Slack" when unlinked), then run the command inline and reply
    within Slack's 3s window.
    """
    if not _slack_enabled():
        raise HTTPException(503, "Slack integration is not configured")

    raw = await request.body()
    if not verify_slack_signature(
        raw,
        request.headers.get("X-Slack-Request-Timestamp", ""),
        request.headers.get("X-Slack-Signature", ""),
    ):
        raise HTTPException(401, "invalid Slack signature")

    # Slack posts application/x-www-form-urlencoded; parse the standard slash fields.
    form = dict(urllib.parse.parse_qsl(raw.decode("utf-8"), keep_blank_values=True))
    slack_user_id = form.get("user_id", "")
    text = form.get("text", "")

    with db_cursor() as (conn, cur):
        member = _member_for_slack_user(cur, slack_user_id)
        if member is None:
            # 200 with an ephemeral body — Slack shows the text; never a 4xx (that would
            # surface a red error in the channel instead of a helpful nudge).
            return _ephemeral(
                blocks_unlinked_user(),
                "Your Slack account isn't linked to an Orcha member yet.",
            )
        response = _handle_command(cur, member, text)
        conn.commit()
    return response
