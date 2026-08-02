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
         Slack-started task is byte-identical to a hub-started one.)
  * /orcha tasks             → a summary of this project's needs-attention counts.

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

from portal_backend.application import app
from portal_backend.database import db_cursor
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


def _ephemeral(text: str) -> dict:
    """A private (ephemeral) Slack slash-command reply — only the caller sees it."""
    return {"response_type": "ephemeral", "text": text}


def _needs_attention_summary(cur, container_id) -> dict:
    """Counts for `/orcha tasks`: tasks parked at needs_verification, ready-unassigned
    work, and open requests targeting a human — the same "needs you" signals the portal
    surfaces. Read-only OBSERVE; no state change."""
    cur.execute(
        "SELECT count(*) AS n FROM tasks WHERE container_id=%s AND status='needs_verification'",
        (container_id,),
    )
    needs_verification = cur.fetchone()["n"]
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
        result = start_task_from_github(
            cur,
            cid,
            kind=kind,
            number=number,
            gh_title=f"#{number}",   # Slack has no title; the DoD + link carry the detail
            body_excerpt="",
            html_url="",
            created_by_agent_id=str(member["id"]),
            assignee_agent_id=None,  # Slack start is unassigned — Atlas routes it
            source="slack",
        )
        label = "PR" if kind == "pull" else "issue"
        if result["existing"]:
            return _ephemeral(
                f"Already tracked: {label} #{number} has an open Orcha task "
                f"(task {result['task_id']}). Nothing new created."
            )
        return _ephemeral(
            f"Started an Orcha task for {label} #{number} (task {result['task_id']}). "
            "A human still verifies before anything merges."
        )

    if _TASKS_RE.match(text):
        s = _needs_attention_summary(cur, cid)
        return _ephemeral(
            "Needs attention in this project:\n"
            f"• {s['needs_verification']} task(s) awaiting your verification\n"
            f"• {s['ready_unassigned']} ready task(s) with no assignee\n"
            f"• {s['open_requests']} open request(s) for you"
        )

    return _ephemeral(
        "Unknown command. Try:\n"
        "• `/orcha start issue <N>`\n"
        "• `/orcha start pr <N>`\n"
        "• `/orcha tasks`"
    )


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
                "Your Slack account isn't linked to an Orcha member yet. "
                "Open Orcha → Settings → link your Slack, then try again."
            )
        response = _handle_command(cur, member, text)
        conn.commit()
    return response
