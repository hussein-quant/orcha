"""Voice-first decisions (GH #409): the audit row behind a decision made by voice.

A spoken answer is mapped to ONE structured action, recorded here (``voice_actions``) and
then sent to the SAME route the portal's buttons use (``/api/decisions``,
``/api/tasks/{id}/verify``, ``/api/requests/{id}/respond``) with ``via: "voice"`` and the
row's id. That route keeps every rule it already enforces (human-only, membership,
autonomy, workflow gates); this module only:

* records the action under an idempotency key (a retried voice decision never runs twice),
* checks the id a route receives belongs to this person, project and item, and
* marks the row done inside the route's own transaction and logs a ``voice_decision``
  event carrying the transcript — so the audit trail says the decision came by voice.
"""

from __future__ import annotations

import json
from typing import Optional
from uuid import uuid4

from fastapi import HTTPException

from portal_backend.agent_status import log_event
from portal_backend.guards import valid_uuid

VIA_VOICE = "voice"
ITEM_KINDS = ("plan", "verify", "request", "task")
MAX_TRANSCRIPT = 4000
EVENT_TRANSCRIPT = 1000  # the event row carries a preview; the voice_actions row keeps it all


def _row_out(row) -> dict:
    return {
        "voice_action_id": str(row["id"]),
        "item_kind": row["item_kind"],
        "item_id": str(row["item_id"]) if row["item_id"] else None,
        "action": row["action"],
        "status": row["status"],
        "transcript": row["transcript"],
        "intent": json.loads(row["intent"]) if row["intent"] else None,
        "result": json.loads(row["result"]) if row["result"] else None,
    }


def record(cur, container_id: str, actor_id: str, *, idempotency_key: str, item_kind: str,
           item_id: Optional[str], action: str, transcript: str, intent: dict) -> tuple[dict, bool]:
    """Insert the pending row, or return the existing one for the same key.
    Returns (row, created). The same key with a different item or action is refused."""
    if item_kind not in ITEM_KINDS:
        raise HTTPException(422, f"item_kind must be one of {', '.join(ITEM_KINDS)}")
    if item_id is None and not (item_kind == "task" and action == "create_task"):
        raise HTTPException(400, "item_id is required")
    if item_id is not None and not valid_uuid(item_id):
        raise HTTPException(400, "item_id is not a valid UUID")
    cur.execute(
        "SELECT * FROM voice_actions WHERE container_id=%s AND actor_agent_id=%s AND idempotency_key=%s",
        (container_id, actor_id, idempotency_key),
    )
    existing = cur.fetchone()
    if existing:
        same_item = (existing["item_id"] is None and item_id is None) or str(existing["item_id"]) == str(item_id)
        if existing["item_kind"] != item_kind or not same_item or existing["action"] != action:
            raise HTTPException(409, {"code": "idempotency_conflict",
                                      "message": "This voice decision was already recorded for a different item."})
        return _row_out(existing), False
    vid = str(uuid4())
    cur.execute(
        """INSERT INTO voice_actions (id, container_id, actor_agent_id, idempotency_key, item_kind,
                                      item_id, action, transcript, intent)
           VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)""",
        (vid, container_id, actor_id, idempotency_key, item_kind, item_id, action,
         transcript[:MAX_TRANSCRIPT], json.dumps(intent)),
    )
    cur.execute("SELECT * FROM voice_actions WHERE id=%s", (vid,))
    return _row_out(cur.fetchone()), True


def get(cur, container_id: str, voice_action_id: str) -> Optional[dict]:
    if not valid_uuid(voice_action_id):
        return None
    cur.execute("SELECT * FROM voice_actions WHERE id=%s AND container_id=%s", (voice_action_id, container_id))
    row = cur.fetchone()
    return _row_out(row) if row else None


def finish(cur, voice_action_id: str, status: str, result: Optional[dict]) -> None:
    """Close a pending row the route never consumed: undone in the undo window, or failed."""
    if status not in ("undone", "failed", "done"):
        raise HTTPException(422, "status must be 'undone', 'failed' or 'done'")
    cur.execute(
        "UPDATE voice_actions SET status=%s, result=%s, finished_at=now() WHERE id=%s AND status='pending'",
        (status, json.dumps(result) if result is not None else None, voice_action_id),
    )


def provenance(cur, container_id, actor_id: str, via: Optional[str], voice_action_id: Optional[str],
               *, item_kind: str, item_id: str) -> Optional[dict]:
    """Validate a decision route's ``via``/``voice_action_id`` pair. None for an ordinary
    click. A voice decision must name a pending row of this person, project and item."""
    if via is None and voice_action_id is None:
        return None
    if via != VIA_VOICE or not voice_action_id:
        raise HTTPException(422, "a voice decision sends via='voice' together with its voice_action_id")
    if not valid_uuid(voice_action_id):
        raise HTTPException(400, "voice_action_id is not a valid UUID")
    cur.execute("SELECT * FROM voice_actions WHERE id=%s", (voice_action_id,))
    row = cur.fetchone()
    if not row or str(row["container_id"]) != str(container_id):
        raise HTTPException(404, "voice action not found in this project")
    if str(row["actor_agent_id"]) != str(actor_id):
        raise HTTPException(403, "this voice action was recorded for another person")
    if row["item_kind"] != item_kind or str(row["item_id"]) != str(item_id):
        raise HTTPException(409, "this voice action was recorded for a different item")
    if row["status"] != "pending":
        raise HTTPException(409, f"this voice action is already {row['status']}")
    return {"via": VIA_VOICE, "voice_action_id": str(row["id"]), "action": row["action"],
            "transcript": row["transcript"]}


def mark_done(cur, container_id, actor_id: str, prov: Optional[dict], entity_type: str,
              entity_id: str, result: dict) -> None:
    """Inside the decision route's transaction: the row is done and the audit trail says so."""
    if not prov:
        return
    cur.execute(
        "UPDATE voice_actions SET status='done', result=%s, finished_at=now() WHERE id=%s AND status='pending'",
        (json.dumps(result), prov["voice_action_id"]),
    )
    log_event(
        cur, container_id, "human", actor_id, entity_type, entity_id, "voice_decision",
        {"via": VIA_VOICE, "voice_action_id": prov["voice_action_id"], "action": prov["action"],
         "transcript": prov["transcript"][:EVENT_TRANSCRIPT], **result},
    )


def detail(prov: Optional[dict]) -> dict:
    """Fields merged into an existing event's detail (e.g. ``verified``) for a voice decision."""
    return {"via": VIA_VOICE, "voice_action_id": prov["voice_action_id"]} if prov else {}
