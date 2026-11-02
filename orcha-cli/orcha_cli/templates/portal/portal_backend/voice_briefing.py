"""The "needs you" items Talk decides on (GH #409): a plan to approve, work to verify, or an
agent's question, loaded and checked before a decision is proposed or recorded.

``load_item`` returns the item as it stands now — 404 when it is not in this project, 409 when it
no longer needs anyone (decided elsewhere meanwhile) — with the words that make approving it
sensitive (merge, deploy, publish…), so a risky approval needs the spoken confirm phrase.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Optional

from fastapi import HTTPException

from portal_backend import voice_intent
from portal_backend.task_list_query import PLAN_CUTOFF_SQL, PLAN_ROUND_ORDER_SQL, plan_candidate_sql

WORKFLOW_ACCEPT_ON_SCREEN = ("Accepting a workflow step's result needs the saved evidence picked on screen. "
                             "Say show me to open it, send it back, or later.")


@dataclass
class ItemContext:
    kind: str
    item_id: str
    title: str
    agent_alias: Optional[str]
    body: str  # the plan, the work summary, or the question
    extra: dict = field(default_factory=dict)

    def sensitive(self) -> list[str]:
        return voice_intent.sensitive_words(self.title, self.body, self.extra.get("definition_of_done"))


def _payload_text(payload) -> str:
    if payload is None:
        return ""
    if isinstance(payload, (dict, list)):
        doc = payload
    else:
        try:
            doc = json.loads(payload)
        except (TypeError, ValueError):
            return str(payload)
    if isinstance(doc, dict):
        for key in ("question", "summary", "title", "body", "message", "text"):
            if isinstance(doc.get(key), str) and doc[key].strip():
                return doc[key]
        return json.dumps(doc)[:2000]
    return str(doc)


def _alias(cur, agent_id) -> Optional[str]:
    if not agent_id:
        return None
    cur.execute("SELECT alias FROM agents WHERE id=%s", (str(agent_id),))
    row = cur.fetchone()
    return row["alias"] if row else None


def load_item(cur, container_id: str, kind: str, item_id: str) -> ItemContext:
    """The item as it stands now. 404 when it is not in this project; 409 when it no longer
    needs anyone (decided elsewhere meanwhile)."""
    if kind in ("plan", "verify"):
        cur.execute(
            "SELECT id, container_id, title, description, definition_of_done, status, autonomy, workflow_id "
            "FROM tasks WHERE id=%s", (item_id,))
        t = cur.fetchone()
        if not t or str(t["container_id"]) != str(container_id):
            raise HTTPException(404, "task not found in this project")
        cur.execute(
            "SELECT a.id FROM agent_tasks at JOIN agents a ON a.id=at.agent_id "
            "WHERE at.task_id=%s AND a.kind <> 'human' ORDER BY a.alias LIMIT 1", (item_id,))
        owner = cur.fetchone()
        extra = {"definition_of_done": t["definition_of_done"], "workflow": bool(t["workflow_id"])}
        if kind == "plan":
            if t["status"] != "in_progress":
                raise HTTPException(409, "this plan no longer needs a decision")
            cur.execute(
                f"""SELECT m.author_id, m.body FROM tasks t
                    CROSS JOIN (SELECT {PLAN_CUTOFF_SQL} AS c FROM tasks t WHERE t.id=%s) pc
                    JOIN task_messages m ON m.task_id=t.id
                    JOIN agents ma ON ma.id=m.author_id
                    WHERE t.id=%s AND ma.kind <> 'human' AND {plan_candidate_sql('m')}
                      AND m.created_at > pc.c
                    ORDER BY {PLAN_ROUND_ORDER_SQL} LIMIT 1""",
                (item_id, item_id),
            )
            plan = cur.fetchone()
            if not plan:
                raise HTTPException(409, "this task has no plan waiting for a decision")
            alias = _alias(cur, plan["author_id"])
            body = plan["body"]
        else:
            if t["status"] != "needs_verification":
                raise HTTPException(409, "this work no longer needs verifying")
            alias = _alias(cur, owner["id"] if owner else None)
            cur.execute(
                "SELECT m.body FROM task_messages m JOIN agents a ON a.id=m.author_id "
                "WHERE m.task_id=%s AND a.kind <> 'human' ORDER BY m.created_at DESC LIMIT 1", (item_id,))
            last = cur.fetchone()
            body = (last["body"] if last else "") or (t["description"] or "")
        return ItemContext(kind, str(item_id), t["title"] or "a task", alias, body or "", extra)
    if kind == "request":
        cur.execute(
            "SELECT id, container_id, type, requester_id, status, payload, detail FROM requests WHERE id=%s",
            (item_id,))
        r = cur.fetchone()
        if not r or str(r["container_id"]) != str(container_id):
            raise HTTPException(404, "request not found in this project")
        if r["status"] not in ("open", "accepted"):
            raise HTTPException(409, "this request no longer needs an answer")
        alias = _alias(cur, r["requester_id"])
        question = _payload_text(r["payload"])
        detail = _payload_text(r["detail"]) if r["detail"] else ""
        title = question.splitlines()[0][:120] if question else "a question"
        return ItemContext("request", str(item_id), title, alias,
                           question + (f"\n\n{detail}" if detail else ""), {"type": r["type"]})
    raise HTTPException(422, "kind must be plan, verify or request")

