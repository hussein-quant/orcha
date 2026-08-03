"""Outbound Slack (Feature B) — Block Kit message composers + the needs_verification
ping, IF the container has a slack_webhook_url configured.

This module is the ONE home for every Slack-facing Block Kit composer — the outbound
needs_verification ping AND the ephemeral replies slack_routes.py sends for its slash
commands. Keeping them together means one design language (header + mrkdwn section +
muted context line + button) and one place that escapes mrkdwn (`_mrkdwn_escape`) so a
title containing `<`, `>`, or `&` can never break a message's block structure.

Every composer here is a small PURE function: (data in) -> block array (out). No DB, no
network, no request object — trivially unit-testable against the JSON shape, and reused
identically whether the caller is the outbound webhook path or an inbound slash reply.

Outbound contract — non-fatal, by construction, exactly like push_outbox:
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
# The portal base URL for deep links. Slack buttons need an ABSOLUTE, externally
# reachable URL (Slack's servers fetch/redirect through it — unlike phone LAN pairing,
# there is no "derive from the inbound request host" that is safe here: a box behind a
# reverse proxy may see 127.0.0.1 or an internal container hostname on request.url).
# ORCHA_PORTAL_BASE_URL is the existing, documented config-based source for this
# (same channel as other deployment config, e.g. ORCHA_LLM_API_KEY). Optional: without
# it, messages still carry the task title — a button is a nicety, not a requirement.
PORTAL_BASE_URL_ENV = "ORCHA_PORTAL_BASE_URL"


def portal_base_url() -> str:
    """The configured portal base URL, or "" when unset. Single source every Slack
    composer/link builder in this module (and slack_routes.py) reads through."""
    return (os.environ.get(PORTAL_BASE_URL_ENV) or "").strip().rstrip("/")


def portal_task_link(container_id, task_id):
    """Absolute deep link to a task, or None without a configured base URL.

    NOTE: the served route is the extensionless `/tasks` (dashboard_routes.tasks_page)
    — static files are mounted at /assets, not at the site root, so `/tasks.html` 404s.
    The route reads `?cid=` + optional `?task=` (tasks-boot.js), matching the same
    `withCid`-built links the portal's own sidebar/cards use (app-shell.js).
    """
    base = portal_base_url()
    if not base:
        return None
    return f"{base}/tasks?cid={container_id}&task={task_id}"


# ---- mrkdwn escaping --------------------------------------------------------------

def _mrkdwn_escape(text: str) -> str:
    """Slack's mrkdwn requires literal `&`, `<`, `>` in message text to be entity-escaped
    (Slack's own documented escaping order: & first, then < and >) — otherwise a title
    containing those characters (e.g. "Fix <script> handling & the > operator") can be
    misread as a broken/expanded link/mention token by Slack's renderer."""
    text = text or ""
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _mrkdwn_link(url: str, text: str) -> str:
    """Slack mrkdwn link syntax `<url|text>` with the visible text escaped (the URL
    itself is not mrkdwn-escaped — Slack does not entity-decode URLs)."""
    return f"<{url}|{_mrkdwn_escape(text)}>"


# ---- shared block primitives -------------------------------------------------------

def _header(emoji: str, text: str) -> dict:
    return {"type": "header", "text": {"type": "plain_text", "text": f"{emoji} {text}"}}


def _section_mrkdwn(text: str) -> dict:
    return {"type": "section", "text": {"type": "mrkdwn", "text": text}}


def _context(text: str) -> dict:
    """A muted context line (Slack renders `context` blocks in a smaller, greyed style)."""
    return {"type": "context", "elements": [{"type": "mrkdwn", "text": text}]}


def _button(text: str, url: str, style: str = None) -> dict:
    button = {"type": "button", "text": {"type": "plain_text", "text": text}, "url": url}
    if style:
        button["style"] = style
    return {"type": "actions", "elements": [button]}


# ---- composers: outbound needs_verification ping -----------------------------------

def blocks_needs_verification(container_name: str, task_title: str, task_link,
                               project_name: str = None, agent_alias: str = None) -> list:
    """'Needs your verification' — ONE message: header, the task as a mrkdwn section,
    a muted context line (project + agent), and a single 'Verify in Orcha' button when
    we have a link. No channel noise beyond this one message."""
    blocks = [
        _header("🛡️", "Needs your verification"),
        _section_mrkdwn(_mrkdwn_link(task_link, task_title) if task_link
                        else _mrkdwn_escape(task_title)),
    ]
    ctx_parts = []
    if project_name:
        ctx_parts.append(_mrkdwn_escape(project_name))
    if agent_alias:
        ctx_parts.append(_mrkdwn_escape(agent_alias))
    if ctx_parts:
        blocks.append(_context(" · ".join(ctx_parts)))
    if task_link:
        blocks.append(_button("Verify in Orcha", task_link, style="primary"))
    return blocks


# ---- composers: /orcha start ... ----------------------------------------------------

def blocks_start_success(label: str, number: int, html_url, gh_title: str, task_link) -> list:
    """'🚀 Task started' — the GH item as a mrkdwn link (falls back to plain '#N' text
    when we couldn't resolve an html_url), a muted context line explaining routing +
    the verification gate, and an 'Open task in Orcha' button when we have a link."""
    item_text = (_mrkdwn_link(html_url, f"#{number} {gh_title}".strip()) if html_url
                else _mrkdwn_escape(f"#{number} {gh_title}".strip()))
    blocks = [
        _header("🚀", "Task started"),
        _section_mrkdwn(f"{label} {item_text}"),
        _context("assigned: Atlas routes it · a human verifies before anything merges"),
    ]
    if task_link:
        blocks.append(_button("Open task in Orcha", task_link))
    return blocks


def blocks_already_tracked(label: str, number: int, task_link) -> list:
    """'↩️ Already tracked' — this issue/PR already has an open Orcha task; the button
    goes straight to the existing task instead of creating a duplicate."""
    blocks = [
        _header("↩️", "Already tracked"),
        _section_mrkdwn(f"{label} #{number} already has an open Orcha task."),
    ]
    if task_link:
        blocks.append(_button("Open task in Orcha", task_link))
    return blocks


def blocks_unlinked_user() -> list:
    """Friendly explainer for a Slack caller with no linked Orcha member — never acts,
    just points them at Settings."""
    return [
        _header("🔗", "Link your Slack account"),
        _section_mrkdwn(
            "This Slack account isn't linked to an Orcha member yet, so `/orcha` "
            "commands can't act on your behalf."
        ),
        _context("ask an owner to link your Slack ID in Orcha → Settings → Members"),
    ]


def blocks_usage_help() -> list:
    """Compact usage block for bad/empty slash-command args — the three commands."""
    return [
        _header("❔", "Orcha commands"),
        _section_mrkdwn(
            "*`/orcha start issue <N>`*  —  start a task from GitHub issue #N\n"
            "*`/orcha start pr <N>`*  —  start a task from GitHub PR #N\n"
            "*`/orcha tasks`*  —  what needs you in this project"
        ),
    ]


# ---- composers: /orcha tasks ---------------------------------------------------------

_MAX_VERIFY_LINKS = 5


def blocks_tasks_summary(needs_verification: list, open_requests_count: int,
                          ready_unassigned_count: int, task_link_fn) -> list:
    """'🔔 Needs you' — up to 5 needs_verification task titles as links, then the
    open-requests / ready-unassigned counts. All-zero renders the portal's own
    zero-state phrasing (home-state.js) so the copy matches across surfaces.

    `needs_verification` is a list of {id, title} dicts — callers may pass the FULL set
    (no need to pre-cap at _MAX_VERIFY_LINKS themselves); this composer caps the LINKED
    list itself while still reporting the true total count in the "(n)" label.
    `task_link_fn(task_id) -> str|None` builds each deep link.
    """
    total = len(needs_verification) + open_requests_count + ready_unassigned_count
    blocks = [_header("🔔", "Needs you")]
    if total == 0:
        blocks.append(_section_mrkdwn("✓ Nothing needs you right now."))
        return blocks

    if needs_verification:
        lines = []
        for t in needs_verification[:_MAX_VERIFY_LINKS]:
            link = task_link_fn(t["id"])
            title = _mrkdwn_link(link, t["title"]) if link else _mrkdwn_escape(t["title"])
            lines.append(f"• {title}")
        blocks.append(_section_mrkdwn(
            f"*To verify ({len(needs_verification)})*\n" + "\n".join(lines)
        ))
    else:
        blocks.append(_section_mrkdwn("*To verify (0)*"))

    blocks.append(_context(
        f"Open requests ({open_requests_count}) · "
        f"Ready · unassigned ({ready_unassigned_count})"
    ))
    return blocks


# ---- outbound webhook plumbing -------------------------------------------------------

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
                """SELECT t.title, a.alias AS agent_alias
                     FROM tasks t
                     LEFT JOIN agent_tasks at ON at.task_id = t.id
                                              AND at.assignment_status IN
                                                  ('assigned','accepted','working','done')
                     LEFT JOIN agents a ON a.id = at.agent_id
                    WHERE t.id=%s AND t.container_id=%s AND t.status='needs_verification'
                    ORDER BY at.assignment_status = 'done' DESC
                    LIMIT 1""",
                (task_id, container_id),
            )
            trow = cur.fetchone()
            if not trow:
                return
            webhook = crow["slack_webhook_url"].strip()
            container_name = crow["name"] or "Orcha"
            title = trow["title"]
            agent_alias = trow.get("agent_alias")
        link = portal_task_link(container_id, task_id)
        payload = {
            "blocks": blocks_needs_verification(
                container_name, title, link,
                project_name=container_name, agent_alias=agent_alias,
            ),
            "text": f"Needs verification in {container_name}: {title}",
        }
        _post_webhook(webhook, payload)
    except Exception:
        pass  # best-effort by contract — Slack must never surface in the main flow
