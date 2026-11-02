"""Talk to Orcha (GH #409): what the master chat in the Embodent app needs from one project.

The conversation itself lives in the Mac app, across every project on the machine; its brain is
the owner's own Claude Code (desktop/src/main/talk). Each project answers two questions:

    context   who is on the team, what is open, and what is waiting on the owner (with short
              refs the model can say back)
    propose   turn ONE action the model suggested into the exact request the portal's own
              button sends, plus a read-back written here (not by the model) — or a short
              question when something is missing

    decisions     approve_plan · reject_plan · accept · send_back · answer   (what "needs you")
    work          create_task · assign_task · post_message · message_agent (a line in the agent's own chat)

Nothing is performed here. The app shows the read-back, the owner confirms, and the app records
the action (voice_actions) and sends the request through the normal route as the owner
(decisions carry `via: "voice"`), so every human-only rule and gate applies as for a click.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Optional

from fastapi import HTTPException

from portal_backend import voice_briefing, voice_intent
from portal_backend.task_list_query import PLAN_CUTOFF_SQL, PLAN_GATE_OPEN_SQL, PLAN_ROUND_ORDER_SQL, plan_candidate_sql

MAX_TEXT = voice_intent.MAX_TEXT
REF_LEN = 8  # short ids the model sees and says back

DECISION_ACTIONS = {"approve_plan": "plan", "reject_plan": "plan", "accept": "verify", "send_back": "verify", "answer": "request"}
WORK_ACTIONS = ("create_task", "assign_task", "post_message", "message_agent")
ALL_ACTIONS = tuple(DECISION_ACTIONS) + WORK_ACTIONS


# --------------------------------------------------------------------------- proposals


@dataclass
class Proposal:
    action: str
    item_kind: str  # plan | verify | request | task (voice_actions.item_kind) | agent (not recorded)
    item_id: Optional[str]
    title: str
    text: Optional[str]
    read_back: str
    sensitive: list
    request: dict  # {"method", "url", "body"} — exactly what the portal's button sends

    def as_dict(self) -> dict:
        return {"action": self.action, "item_kind": self.item_kind, "item_id": self.item_id, "title": self.title,
                "text": self.text, "read_back": self.read_back, "sensitive": self.sensitive,
                "request": self.request, "decision": self.action in DECISION_ACTIONS}


# --------------------------------------------------------------------------- project context


def _short(i) -> str:
    return str(i)[:REF_LEN]


def needs_you(cur, cid: str, actor: str) -> list[dict]:
    """The items waiting on this person (same rule as the "Needs you" list): pending plans
    (task autonomy off), work to verify (not someone else's review), open questions to them."""
    cur.execute(
        """SELECT t.id, t.title, t.status, t.autonomy, t.reviewer_agent_id, t.created_at,
                  (SELECT ma.alias FROM (SELECT """ + PLAN_CUTOFF_SQL + """ AS c) pc
                    CROSS JOIN task_messages m JOIN agents ma ON ma.id = m.author_id
                    WHERE m.task_id = t.id AND ma.kind <> 'human' AND """ + plan_candidate_sql('m') + """
                      AND m.created_at > pc.c
                    ORDER BY """ + PLAN_ROUND_ORDER_SQL + """ LIMIT 1) AS plan_author,
                  (SELECT a.alias FROM agent_tasks at JOIN agents a ON a.id = at.agent_id
                    WHERE at.task_id = t.id AND a.kind <> 'human' ORDER BY a.alias LIMIT 1) AS assignee
             FROM tasks t
            WHERE t.container_id = %s AND NOT t.is_root
              AND (t.status = 'needs_verification' OR (t.status = 'in_progress' AND """ + PLAN_GATE_OPEN_SQL + """))
            ORDER BY t.created_at""",
        (cid,),
    )
    items = []
    for t in cur.fetchall():
        if t["status"] == "in_progress":
            if t["plan_author"] is None or t["autonomy"] == "on":
                continue
            kind, who = "plan", t["plan_author"]
        else:
            if t["reviewer_agent_id"] and str(t["reviewer_agent_id"]) != str(actor):
                continue
            kind, who = "verify", t["assignee"]
        items.append({"key": f"{kind}:{t['id']}", "kind": kind, "id": str(t["id"]), "ref": _short(t["id"]),
                      "title": t["title"], "from": who, "task_id": str(t["id"]), "href": "/tasks?task=" + str(t["id"])})
    cur.execute(
        """SELECT r.id, r.payload, r.target_id, r.originating_task_id, a.alias AS requester, ta.kind AS target_kind
             FROM requests r LEFT JOIN agents a ON a.id = r.requester_id
             LEFT JOIN agents ta ON ta.id = r.target_id
            WHERE r.container_id = %s AND r.status = 'open'
            ORDER BY r.created_at""",
        (cid,),
    )
    for r in cur.fetchall():
        if r["target_id"] is not None and (r["target_kind"] != "human" or str(r["target_id"]) != str(actor)):
            continue
        q = voice_briefing._payload_text(r["payload"])
        items.append({"key": f"request:{r['id']}", "kind": "request", "id": str(r["id"]), "ref": _short(r["id"]),
                      "title": (q.splitlines()[0] if q else "a question")[:160], "from": r["requester"],
                      "task_id": str(r["originating_task_id"]) if r["originating_task_id"] else None,
                      "href": "/requests?req=" + str(r["id"])})
    return items


def project_context(cur, cid: str, actor: str) -> dict:
    """Everything the chat's brain needs about this project, kept small: the team, open tasks,
    a few recently finished ones and what is waiting on the owner. `ref` is the short id the
    model says back; `id` / `href` let the app link straight to the item."""
    cur.execute("SELECT name FROM containers WHERE id=%s", (cid,))
    c = cur.fetchone()
    cur.execute("SELECT alias FROM agents WHERE id=%s", (actor,))
    me = cur.fetchone()
    cur.execute(
        """SELECT a.id, a.alias, a.role, a.kind, a.status,
                  (SELECT t.title FROM agent_tasks at JOIN tasks t ON t.id = at.task_id
                    WHERE at.agent_id = a.id AND t.status = 'in_progress' ORDER BY t.started_at DESC LIMIT 1) AS working_on
             FROM agents a WHERE a.container_id=%s AND a.terminated_at IS NULL ORDER BY a.alias""",
        (cid,))
    agents = [{"id": str(a["id"]), "alias": a["alias"], "role": a["role"], "status": a["status"], "working_on": a["working_on"]}
              for a in cur.fetchall() if a["kind"] != "human"]

    def tasks(where: str, order: str, limit: int) -> list[dict]:
        cur.execute(
            """SELECT t.id, t.title, t.status,
                      (SELECT a.alias FROM agent_tasks at JOIN agents a ON a.id = at.agent_id
                        WHERE at.task_id = t.id AND a.kind <> 'human' ORDER BY a.alias LIMIT 1) AS assignee
                 FROM tasks t WHERE t.container_id=%s AND NOT t.is_root AND """ + where + """
                ORDER BY """ + order + " LIMIT " + str(int(limit)),
            (cid,))
        return [{"id": str(t["id"]), "ref": _short(t["id"]), "title": t["title"], "status": t["status"],
                 "assignee": t["assignee"], "href": "/tasks?task=" + str(t["id"])} for t in cur.fetchall()]

    return {"project": c["name"] if c else "", "owner": me["alias"] if me else None, "agents": agents,
            "open_tasks": tasks("t.status NOT IN ('completed','cancelled')", "t.created_at DESC", 40),
            "recently_done": tasks("t.status = 'completed'", "t.completed_at DESC", 5),
            "needs_you": needs_you(cur, cid, actor)}


def watched(cur, cid: str, ids: list[str]) -> list[dict]:
    """Current status of the tasks the chat is following (in this project only)."""
    out = []
    for tid in ids:
        cur.execute(
            """SELECT t.id, t.title, t.status,
                      (SELECT a.alias FROM agent_tasks at JOIN agents a ON a.id = at.agent_id
                        WHERE at.task_id = t.id AND a.kind <> 'human' ORDER BY a.alias LIMIT 1) AS assignee
                 FROM tasks t WHERE t.id=%s AND t.container_id=%s""", (tid, cid))
        t = cur.fetchone()
        if t:
            out.append({"id": str(t["id"]), "title": t["title"], "status": t["status"], "assignee": t["assignee"],
                        "href": "/tasks?task=" + str(t["id"])})
    return out


def owner(cur, cid: str) -> Optional[str]:
    """The project's first live human: who the chat acts as when the app doesn't say."""
    cur.execute("SELECT id FROM agents WHERE container_id=%s AND kind='human' AND terminated_at IS NULL "
                "ORDER BY created_at LIMIT 1", (cid,))
    row = cur.fetchone()
    return str(row["id"]) if row else None


def _resolve(cur, cid: str, table: str, ref) -> Optional[str]:
    ref = str(ref or "").strip().lower()
    if len(ref) < 4 or not re.fullmatch(r"[0-9a-f-]+", ref):
        return None
    cur.execute(f"SELECT id FROM {table} WHERE container_id=%s AND lower(CAST(id AS TEXT)) LIKE %s LIMIT 2",
                (cid, ref + "%"))
    rows = cur.fetchall()
    return str(rows[0]["id"]) if len(rows) == 1 else None


def _agent(cur, cid: str, alias) -> Optional[dict]:
    alias = str(alias or "").strip().lstrip("@")
    if not alias:
        return None
    cur.execute(
        "SELECT id, alias FROM agents WHERE container_id=%s AND kind <> 'human' AND terminated_at IS NULL "
        "AND lower(alias)=lower(%s)", (cid, alias))
    row = cur.fetchone()
    if row:
        return {"id": str(row["id"]), "alias": row["alias"]}
    squashed = re.sub(r"[\s_-]", "", alias.lower())  # "release engineer" → ReleaseEngineer
    cur.execute("SELECT id, alias FROM agents WHERE container_id=%s AND kind <> 'human' AND terminated_at IS NULL",
                (cid,))
    for a in cur.fetchall():
        if re.sub(r"[\s_-]", "", a["alias"].lower()) == squashed:
            return {"id": str(a["id"]), "alias": a["alias"]}
    return None


def _clean(v, limit=MAX_TEXT) -> Optional[str]:
    v = re.sub(r"\s+", " ", str(v or "")).strip()
    return v[:limit] or None


def build_proposal(cur, cid: str, actor: str, action: str, args: dict) -> "Proposal | str":
    """A validated proposal, or a short spoken reason it can't be done."""
    args = args or {}
    if action not in ALL_ACTIONS:
        return "I can't do that by voice yet."
    if action in DECISION_ACTIONS:
        kind = DECISION_ACTIONS[action]
        table = "requests" if kind == "request" else "tasks"
        item_id = _resolve(cur, cid, table, args.get("request" if kind == "request" else "task"))
        if not item_id:
            return "I couldn't tell which item you mean."
        try:
            ctx = voice_briefing.load_item(cur, cid, kind, item_id)
        except HTTPException as exc:
            return {404: "I couldn't find that item.", 409: "That one doesn't need a decision any more."}.get(
                exc.status_code, "That item can't be decided right now.")
        text = _clean(args.get("text") or args.get("reason") or args.get("feedback") or args.get("note"))
        if action in voice_intent.NEEDS_TEXT and not text:
            return voice_intent.MISSING_TEXT[action]
        if action == "accept" and ctx.extra.get("workflow"):
            return voice_briefing.WORKFLOW_ACCEPT_ON_SCREEN
        if action in ("approve_plan", "reject_plan"):
            req = {"method": "POST", "url": "/api/decisions",
                   "body": {"subject_type": "plan_approval", "subject_id": item_id,
                            "decision": "approve" if action == "approve_plan" else "reject",
                            "reason": text, "actor_agent_id": actor}}
        elif action in ("accept", "send_back"):
            req = {"method": "POST", "url": f"/api/tasks/{item_id}/verify",
                   "body": {"approve": action == "accept", "feedback": text, "actor_agent_id": actor}}
        else:
            req = {"method": "POST", "url": f"/api/requests/{item_id}/respond",
                   "body": {"responder_agent_id": actor, "response": text}}
        read = voice_intent._read_back(action, text)
        who = f" from {ctx.agent_alias}" if ctx.agent_alias and kind != "request" else ""
        read = read.replace("the plan", f"{ctx.agent_alias}'s plan") if kind == "plan" and ctx.agent_alias else read
        return Proposal(action, kind, item_id, ctx.title, text, read + (who if kind == "verify" else ""),
                        ctx.sensitive() if action in voice_intent.CONFIRMABLE else [], req)

    if action == "create_task":
        title = _clean(args.get("title"), 200)
        dod = _clean(args.get("definition_of_done") or args.get("done_when"), 2000)
        if not title:
            return "What should the task be called?"
        if not dod:
            return "How will we know it's done?"
        desc = _clean(args.get("description"), 8000)
        agent = None
        if args.get("assignee"):
            agent = _agent(cur, cid, args.get("assignee"))
            if not agent:
                return f"I couldn't find an agent called {args.get('assignee')}. Who should own it?"
        body = {"title": title, "definition_of_done": dod, "description": desc,
                "created_by_agent_id": actor, "assignee_alias": agent["alias"] if agent else None}
        owner = f" for {agent['alias']}" if agent else ", unassigned"
        when = dod.rstrip(".")
        if len(when) > 1 and not when[1].isupper():  # "The October…" reads "the October…" mid-sentence
            when = when[0].lower() + when[1:]
        return Proposal("create_task", "task", None, title, desc, f"Creating “{title}”{owner}, done when {when}.",
                        voice_intent.sensitive_words(title, desc, dod),
                        {"method": "POST", "url": f"/api/containers/{cid}/tasks", "body": body})

    if action == "message_agent":
        # the request opens (get-or-create) the agent's chat; the app then posts the text there
        # as the owner (POST /api/conversations/{id}/turns) — the turn in that chat is the record
        agent = _agent(cur, cid, args.get("agent") or args.get("assignee"))
        if not agent:
            return "Which agent should I send it to?"
        text = _clean(args.get("text") or args.get("message"))
        if not text:
            return "What should the message say?"
        return Proposal("message_agent", "agent", agent["id"], agent["alias"], text,
                        f"Sending {agent['alias']} a chat message: “{text}”",
                        voice_intent.sensitive_words(text),
                        {"method": "POST", "url": f"/api/agents/{agent['id']}/conversations",
                         "body": {"actor_agent_id": actor}})

    task_id = _resolve(cur, cid, "tasks", args.get("task"))
    if not task_id:
        return "I couldn't tell which task you mean."
    cur.execute("SELECT title, status FROM tasks WHERE id=%s", (task_id,))
    t = cur.fetchone()
    if action == "assign_task":
        agent = _agent(cur, cid, args.get("assignee"))
        if not agent:
            return "Which agent should own it?"
        if t["status"] in ("completed", "cancelled"):
            return "That task is already closed."
        return Proposal("assign_task", "task", task_id, t["title"], agent["alias"],
                        f"Assigning “{t['title']}” to {agent['alias']}.", [],
                        {"method": "POST", "url": f"/api/tasks/{task_id}/assign",
                         "body": {"actor_agent_id": actor, "agent_id": agent["id"], "reassign": True}})
    text = _clean(args.get("text") or args.get("message"))
    if not text:
        return "What should the message say?"
    return Proposal("post_message", "task", task_id, t["title"], text,
                    f"Posting on “{t['title']}”: {text.rstrip('.')}.", [],
                    {"method": "POST", "url": f"/api/tasks/{task_id}/messages",
                     "body": {"author_agent_id": actor, "body": text}})
