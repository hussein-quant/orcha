"""Define fail-safe wake-triage and routine-handoff decision policies."""

from __future__ import annotations

from typing import Callable, Optional

TRIAGE_SCHEMA = {
    "type": "object",
    "properties": {
        "wake": {
            "type": "boolean",
            "description": "Whether this event needs the agent to wake.",
        },
        "reason": {
            "type": "string",
            "description": "One short sentence justifying the decision.",
        },
    },
    "required": ["wake", "reason"],
}

_TRIAGE_SYSTEM = (
    "Decide whether an autonomous agent must be WOKEN for an incoming event. Wake if the event "
    "needs a response, changes task state, asks a question, or carries a review verdict. Review "
    "verdicts are workflow commands, not acknowledgements; they include CLEAN, APPROVED, PASS, "
    "LGTM, NEEDS CHANGES, REQUEST CHANGES, and BLOCKED, so return wake=true for them. "
    "Skip only pure acknowledgements or FYIs that need no action. When uncertain, prefer to WAKE."
)

HANDOFF_ACK_SCHEMA = {
    "type": "object",
    "properties": {
        "ack": {
            "type": "boolean",
            "description": "True only when a brief acknowledgement fully closes the loop.",
        },
        "text": {
            "type": "string",
            "description": "A short acknowledgement, meaningful only when ack is true.",
        },
    },
    "required": ["ack", "text"],
}

_HANDOFF_ACK_SYSTEM = (
    "Decide whether a routine handoff needs only a brief acknowledgement. Return ack=false if it "
    "asks for work, a change, a rebase, an answer, or a decision. Never auto-ack and close a "
    "review verdict. Verdicts include CLEAN, APPROVED, PASS, LGTM, NEEDS CHANGES, "
    "REQUEST CHANGES, and BLOCKED. When in "
    "doubt return ack=false so the full agent handles it."
)


def triage_wake(
    event_text: str,
    *,
    classify: Callable,
    log_failure: Callable,
    resolve_spec: Callable,
    system: Optional[str] = None,
    config: Optional[dict] = None,
    api_key: Optional[str] = None,
    provider=None,
) -> dict:
    """Classify an event, failing open toward a wake on every uncertainty."""
    spec = resolve_spec("triage", config=config)
    try:
        result = classify(
            "triage",
            system=system or _TRIAGE_SYSTEM,
            user=event_text,
            schema=TRIAGE_SCHEMA,
            config=config,
            api_key=api_key,
            provider=provider,
        )
        return {
            "wake": result.get("wake", True) is not False,
            "reason": str(result.get("reason", "")),
        }
    except Exception as exc:
        log_failure(
            use_case="triage",
            spec=spec,
            outcome="fail_open",
            latency_ms=0,
            error=str(exc),
        )
        return {"wake": True, "reason": f"fail-open: {exc}"}


REFINE_SLACK_ISSUE_SCHEMA = {
    "type": "object",
    "properties": {
        "title": {
            "type": "string",
            "description": "Imperative, professional issue title, at most 80 characters.",
        },
        "body": {
            "type": "string",
            "description": (
                "Markdown body with sections '## Summary', '## Observed', "
                "'## Expected', and '## Technical context', built ONLY from facts "
                "present in the reporter's message — never invented repro steps, "
                "versions, or root causes. Omit a section entirely (heading and all) "
                "when the source message has nothing to support it."
            ),
        },
    },
    "required": ["title", "body"],
}

_REFINE_SLACK_ISSUE_SYSTEM = (
    "Rewrite a raw Slack message into a professional technical GitHub issue. "
    "Title: imperative mood, at most 80 characters, no trailing punctuation. "
    "Body: markdown with '## Summary', '## Observed', '## Expected', and "
    "'## Technical context' sections — include ONLY a section the source message "
    "actually supports; omit sections (heading and all) it does not. NEVER invent "
    "repro steps, versions, environments, or root causes that are not stated or "
    "clearly implied in the source text — when in doubt, leave it out rather than "
    "guess. Do not include a reporter-quote section yourself; the caller appends the "
    "verbatim original separately."
)


def refine_slack_issue(
    raw_title: str,
    raw_body: str,
    *,
    classify: Callable,
    log_failure: Callable,
    resolve_spec: Callable,
    system: Optional[str] = None,
    config: Optional[dict] = None,
    api_key: Optional[str] = None,
    provider=None,
) -> Optional[dict]:
    """Rewrite a Slack-sourced issue title/body as a professional technical report.

    Fails CLOSED: any error (no key, provider error, timeout, malformed response)
    returns None so the caller degrades to filing the raw title/body unchanged —
    this is a wording pass, never a source of invented facts, so a failure must never
    block issue creation or silently fabricate content.
    """
    spec = resolve_spec("slack_issue_refine", config=config)
    user = f"Title: {raw_title}\n\nMessage:\n{raw_body}"
    try:
        result = classify(
            "slack_issue_refine",
            system=system or _REFINE_SLACK_ISSUE_SYSTEM,
            user=user,
            schema=REFINE_SLACK_ISSUE_SCHEMA,
            tool_name="refine_issue",
            config=config,
            api_key=api_key,
            provider=provider,
        )
        title = str(result.get("title") or "").strip()
        body = str(result.get("body") or "").strip()
        if not title or not body:
            raise ValueError("refine_slack_issue: empty title or body in model output")
        return {"title": title[:80], "body": body}
    except Exception as exc:
        log_failure(
            use_case="slack_issue_refine",
            spec=spec,
            outcome="fail_closed",
            latency_ms=0,
            error=str(exc),
        )
        return None


def handoff_ack(
    handoff_text: str,
    *,
    classify: Callable,
    log_failure: Callable,
    resolve_spec: Callable,
    system: Optional[str] = None,
    config: Optional[dict] = None,
    api_key: Optional[str] = None,
    provider=None,
) -> dict:
    """Classify a handoff, failing closed toward a full wake on uncertainty."""
    spec = resolve_spec("ack", config=config)
    try:
        result = classify(
            "ack",
            system=system or _HANDOFF_ACK_SYSTEM,
            user=handoff_text,
            schema=HANDOFF_ACK_SCHEMA,
            config=config,
            api_key=api_key,
            provider=provider,
        )
        text = (result.get("text") or "").strip()
        if result.get("ack") is True and text:
            return {"ack": True, "text": text}
    except Exception as exc:
        log_failure(
            use_case="ack",
            spec=spec,
            outcome="fail_closed",
            latency_ms=0,
            error=str(exc),
        )
    return {"ack": False, "text": ""}
