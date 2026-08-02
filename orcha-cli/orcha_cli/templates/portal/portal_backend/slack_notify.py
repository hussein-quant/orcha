"""Outbound Slack (Feature B) — a compact Block Kit ping when a task parks at
needs_verification, IF the container has a slack_webhook_url configured.

Contract — non-fatal, by construction, exactly like push_outbox:
  * Called AFTER the route handler's own commit, outside its transaction. A Slack ping
    is advisory delivery, never domain state — the transition must land identically
    whether or not Slack is configured or reachable. Every path swallows EVERY exception
    (a missing column on a half-migrated stack, a dead webhook, a network timeout).
  * Cheapest gate first: no webhook configured → return without touching the network.
  * Re-reads the transition in its OWN connection (post-commit rows are visible) so it
    only pings a task that is genuinely at needs_verification.

The webhook URL is a container-level Slack Incoming Webhook (mig 044). We POST the Block
Kit JSON with stdlib urllib (no httpx dependency), a short timeout, and never raise.
"""

import json
import os
import urllib.error
import urllib.request

from portal_backend.database import db_cursor

SLACK_POST_TIMEOUT_SECONDS = 5
# The portal base URL for deep links, if the deployment exposes one. Optional: without it
# the message still carries the task title/id (a link is a nicety, not a requirement).
PORTAL_BASE_URL_ENV = "ORCHA_PORTAL_BASE_URL"


def _portal_task_link(container_id, task_id):
    base = (os.environ.get(PORTAL_BASE_URL_ENV) or "").strip().rstrip("/")
    if not base:
        return None
    return f"{base}/tasks.html?cid={container_id}&task={task_id}"


def _blocks(container_name: str, task_title: str, link):
    """Compact Block Kit: a header line + the task, and (when we have a portal URL) a
    'Verify in Orcha' button. Kept small — one section, optional actions."""
    text = f"*Needs verification* in *{container_name}*\n{task_title}"
    blocks = [{"type": "section", "text": {"type": "mrkdwn", "text": text}}]
    if link:
        blocks.append({
            "type": "actions",
            "elements": [{
                "type": "button",
                "text": {"type": "plain_text", "text": "Verify in Orcha"},
                "url": link,
            }],
        })
    return blocks


def _post_webhook(webhook_url: str, payload: dict) -> None:
    body = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        webhook_url,
        data=body,
        headers={"Content-Type": "application/json", "User-Agent": "orcha-portal"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=SLACK_POST_TIMEOUT_SECONDS) as response:
        response.read()  # drain; Slack replies 'ok'


def notify_task_needs_verification(container_id, task_id) -> None:
    """A task parked at needs_verification — ping the container's Slack webhook if set.

    Non-fatal and silent by contract: any failure (no column, no webhook, dead URL,
    network error) returns without surfacing. Mirrors push_outbox.push_task_verify.
    """
    try:
        with db_cursor() as (_, cur):
            cur.execute(
                "SELECT name, slack_webhook_url FROM containers WHERE id=%s",
                (container_id,),
            )
            crow = cur.fetchone()
            if not crow or not (crow.get("slack_webhook_url") or "").strip():
                return  # dormant default: no webhook → no network, ever
            cur.execute(
                "SELECT title FROM tasks WHERE id=%s AND container_id=%s "
                "AND status='needs_verification'",
                (task_id, container_id),
            )
            trow = cur.fetchone()
            if not trow:
                return
            webhook = crow["slack_webhook_url"].strip()
            container_name = crow["name"] or "Orcha"
            title = trow["title"]
        link = _portal_task_link(container_id, task_id)
        payload = {"blocks": _blocks(container_name, title, link),
                   "text": f"Needs verification in {container_name}: {title}"}
        _post_webhook(webhook, payload)
    except Exception:
        pass  # best-effort by contract — Slack must never surface in the main flow
