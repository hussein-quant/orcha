"""Templates, one Start, people's decisions, watch steps, the proof pack and the board
(Mobile App Release §3.1, §4.1–§4.7, §5, §6.3). Same trust lanes as workflow_routes: a person
through the local actor or the proxy login; agents read and preview, and never decide a
person's step.
"""

from __future__ import annotations

import json
from typing import Any, Literal
from uuid import uuid4

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field

from portal_backend import sql
from portal_backend import workflow_proof as proof
from portal_backend import workflow_service as service
from portal_backend import workflow_steps as steps
from portal_backend import workflow_templates as templates
from portal_backend.application import app
from portal_backend.database import db_cursor
from portal_backend.identity_routes import require_member_read
from portal_backend.schemas import workflows as model
from portal_backend.workflow_graph import conflict
from portal_backend.workflow_routes import HOOKS, _workflow_action, resolve_actor, resolve_human_actor


class _In(BaseModel):
    model_config = ConfigDict(extra="forbid")


class CompileBody(_In):
    params: dict[str, Any] = Field(default_factory=dict)
    removed: list[str] = Field(default_factory=list, max_length=200)
    added: list[dict[str, Any]] = Field(default_factory=list, max_length=40)
    roles: dict[str, str | None] = Field(default_factory=dict)
    dry_run: bool = False


class FromTemplateBody(CompileBody):
    key: str = Field(max_length=80)
    start: bool = True
    title: str | None = Field(default=None, max_length=200)
    idempotency_key: str = Field(min_length=8, max_length=200)


class SaveTemplateBody(_In):
    """Save a project's copy: a whole template (import), or a built-in with this project's
    parameters, removals and additions baked in."""

    template: dict[str, Any] | None = None
    from_key: str | None = Field(default=None, max_length=80)
    key: str | None = Field(default=None, max_length=80)
    name: str | None = Field(default=None, max_length=120)
    params: dict[str, Any] = Field(default_factory=dict)
    removed: list[str] = Field(default_factory=list, max_length=200)
    added: list[dict[str, Any]] = Field(default_factory=list, max_length=40)
    roles: dict[str, str | None] = Field(default_factory=dict)


class DecideBody(_In):
    choice: Literal["go", "no_go", "send_back"] | None = None
    outcome: str | None = Field(default=None, max_length=40)
    reason: str = Field(default="", max_length=4000)
    send_back_to: str | None = None
    proof_digest: str | None = Field(default=None, max_length=64)


class ResolveBody(_In):
    state: str = Field(min_length=1, max_length=60)
    note: str = Field(default="", max_length=2000)


class SnoozeBody(_In):
    days: float = Field(default=3, gt=0, le=60)


class CloseBody(_In):
    note: str = Field(default="", max_length=4000)


# ---- templates -------------------------------------------------------------------


def _variants(cur, cid) -> list[dict]:
    cur.execute("SELECT * FROM workflow_templates WHERE container_id=%s ORDER BY name", (cid,))
    out = []
    for r in cur.fetchall():
        body = steps._load(r["body"]) or {}
        body.update(key=r["key"], name=r["name"], version=r["version"],
                    base_key=r["base_key"], base_version=r["base_version"])
        out.append(body)
    return out


def _find(cur, cid, key) -> tuple[dict, str]:
    for t in templates.builtins():
        if t["key"] == key:
            return t, "builtin"
    for t in _variants(cur, cid):
        if t["key"] == key:
            return t, "project"
    conflict("template_unavailable", "Template not found.", status=404)


@app.get("/api/containers/{cid}/workflow-templates", tags=["workflow templates"])
def list_templates(cid: str, request: Request):
    """Built-in templates (Mobile App Release first) and this project's own copies."""
    with db_cursor(readonly=True) as (_, cur):
        require_member_read(cur, request, cid)
        builtin = templates.builtins()
        latest = {t["key"]: t.get("version", 1) for t in builtin}
        mine = []
        for t in _variants(cur, cid):
            s = templates.summary(t, "project")
            base = latest.get(t.get("base_key"))
            s["update_available"] = bool(base and t.get("base_version") and base > t["base_version"])
            mine.append(s)
        return {"templates": [templates.summary(t) for t in builtin] + mine}


@app.get("/api/containers/{cid}/workflow-templates/{key}", tags=["workflow templates"])
def get_template(cid: str, key: str, request: Request):
    with db_cursor(readonly=True) as (_, cur):
        require_member_read(cur, request, cid)
        t, source = _find(cur, cid, key)
        return {**t, "source": source}


@app.get("/api/containers/{cid}/workflow-templates/{key}/export", tags=["workflow templates"])
def export_template(cid: str, key: str, request: Request):
    with db_cursor(readonly=True) as (_, cur):
        require_member_read(cur, request, cid)
        t, _ = _find(cur, cid, key)
    return JSONResponse(t, headers={"Content-Disposition": f'attachment; filename="{key}.workflow-template.json"'})


def _people(cur, cid) -> list[dict]:
    cur.execute(
        "SELECT id, alias, kind, member_role FROM agents WHERE container_id=%s AND terminated_at IS NULL ORDER BY kind, alias",
        (cid,),
    )
    return [{"id": str(r["id"]), "alias": r["alias"], "kind": r["kind"], "role": r["member_role"]} for r in cur.fetchall()]


def _compile(cur, cid, template, body, owner_id):
    compiled = templates.compile_template(
        template, body.params, body.removed, body.added, dry_run=body.dry_run,
        roles={k: v for k, v in body.roles.items() if v}, owner_id=owner_id,
    )
    if not any(p["code"] in {"parameter_required", "step_required"} for p in compiled["problems"]):
        try:
            service.WorkflowService(cur, HOOKS).preview_draft(cid, compiled["draft"])
        except HTTPException as error:
            d = error.detail if isinstance(error.detail, dict) else {"message": str(error.detail)}
            compiled["problems"].append({"code": d.get("code", "invalid"), "message": d.get("message", ""),
                                         "task_id": d.get("task_id"), "group": d.get("group")})
    return compiled


@app.post("/api/containers/{cid}/workflow-templates/{key}/compile", tags=["workflow templates"])
def compile_template(cid: str, key: str, body: CompileBody, request: Request):
    """The live check behind the editor: the workflow this template, these parameters and
    these removals would make, and every problem with it (never a dialog)."""
    with db_cursor(readonly=True) as (_, cur):
        require_member_read(cur, request, cid)
        t, source = _find(cur, cid, key)
        owner = None
        try:
            owner = resolve_human_actor(cur, request, cid).id
        except HTTPException:
            pass
        compiled = _compile(cur, cid, t, body, owner)
        compiled["template"] = templates.summary(t, source)
        compiled["people"] = _people(cur, cid)
        compiled["ready"] = not compiled["problems"]
        return compiled


@app.post("/api/containers/{cid}/workflow-templates", tags=["workflow templates"])
def save_template(cid: str, body: SaveTemplateBody, request: Request):
    """Import a template JSON, or save a customised copy of one for this project."""
    with db_cursor() as (_, cur):
        actor = resolve_human_actor(cur, request, cid)
        if body.template:
            t = dict(body.template)
            t.pop("source", None)
            base_key, base_version = t.get("base_key"), t.get("base_version")
        else:
            if not body.from_key:
                conflict("template_required", "Send a template, or the key to copy.", status=422)
            src, _ = _find(cur, cid, body.from_key)
            t = _bake(src, body)
            base_key = src.get("base_key") or src["key"]
            base_version = src.get("base_version") or src.get("version", 1)
        if body.key:
            t["key"] = body.key
        if body.name:
            t["name"] = body.name
        templates.validate_template(t)
        if any(b["key"] == t["key"] for b in templates.builtins()):
            conflict("template_key_taken", "Pick a key that isn't a built-in template's.", status=422)
        cur.execute("SELECT id, version FROM workflow_templates WHERE container_id=%s AND key=%s", (cid, t["key"]))
        row = cur.fetchone()
        version = (row["version"] + 1) if row else int(t.get("version") or 1)
        t["version"] = version
        stored = json.dumps({k: v for k, v in t.items() if k not in {"base_key", "base_version"}})
        if row:
            cur.execute(
                "UPDATE workflow_templates SET name=%s, version=%s, body=%s, base_key=%s, base_version=%s, updated_at=%s WHERE id=%s",
                (t["name"], version, stored, base_key, base_version, sql.ts(sql.utcnow()), row["id"]),
            )
        else:
            cur.execute(
                "INSERT INTO workflow_templates(id, container_id, key, name, version, base_key, base_version, body, created_by) "
                "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                (str(uuid4()), cid, t["key"], t["name"], version, base_key, base_version, stored, actor.id),
            )
        return templates.summary({**t, "base_key": base_key, "base_version": base_version}, "project")


def _bake(src: dict, body: SaveTemplateBody) -> dict:
    """A copy with this project's choices as its defaults and its removed steps gone."""
    import copy

    t = copy.deepcopy(src)
    t.pop("source", None)
    for p in t.get("parameters", []):
        if p["key"] in body.params and p["key"] not in {"version", "build", "release_type"}:
            p["default"] = body.params[p["key"]]
    removed = set(body.removed) - {s["client_key"] for s in templates.all_steps(t) if s.get("required") is True}
    by_key = {s["client_key"]: s for s in templates.all_steps(t)}
    for stage in t["stages"]:
        for s in stage["steps"]:
            # Reconnect a dependent to the removed step's own prerequisites.
            after = []
            for a in s.get("after") or []:
                stack = [a]
                while stack:
                    x = stack.pop()
                    if x in removed:
                        stack.extend((by_key.get(x) or {}).get("after") or [])
                    elif x not in after:
                        after.append(x)
            s["after"] = after
        stage["steps"] = [s for s in stage["steps"] if s["client_key"] not in removed]
    t["stages"] = [st for st in t["stages"] if st["steps"]]
    for g in t.get("repeat_groups") or []:
        g["member_tasks"] = [m for m in g["member_tasks"] if m not in removed]
    t["repeat_groups"] = [g for g in t.get("repeat_groups") or []
                          if g["review_task"] not in removed and len(g["member_tasks"]) >= 2]
    for a in body.added:
        a = dict(a)
        anchor = a.pop("insert_after", None)
        target = next((st for st in t["stages"] if any(s["client_key"] == anchor for s in st["steps"])), t["stages"][-1])
        for st in t["stages"]:
            for s in st["steps"]:
                if anchor and anchor in (s.get("after") or []):
                    s["after"] = [a["client_key"] if x == anchor else x for x in s["after"]]
        a["after"] = [anchor] if anchor else []
        target["steps"].append(a)
    if body.roles:
        t["default_roles"] = {k: v for k, v in body.roles.items() if v}
    return t


@app.delete("/api/containers/{cid}/workflow-templates/{key}", tags=["workflow templates"])
def delete_template(cid: str, key: str, request: Request):
    with db_cursor() as (_, cur):
        resolve_human_actor(cur, request, cid)
        cur.execute("DELETE FROM workflow_templates WHERE container_id=%s AND key=%s", (cid, key))
        return {"deleted": key}


@app.post("/api/containers/{cid}/workflows/from-template", tags=["workflow templates"])
def create_from_template(cid: str, body: FromTemplateBody, request: Request):
    """New workflow from a template, and (by default) Start, in one step. Refuses a shape with
    problems: the editor shows them inline before this is ever enabled."""
    service.require_capability()
    with db_cursor() as (_, cur):
        actor = resolve_human_actor(cur, request, cid)
        t, _ = _find(cur, cid, body.key)
        roles = {**(t.get("default_roles") or {}), **body.roles}
        compiled = _compile(cur, cid, t, CompileBody(params=body.params, removed=body.removed, added=body.added,
                                                     roles=roles, dry_run=body.dry_run), actor.id)
        if compiled["problems"]:
            conflict("template_problems", "Fix these before starting.", status=422, problems=compiled["problems"])
        draft = compiled["draft"]
        if body.title:
            draft["title"] = body.title
        svc = service.WorkflowService(cur, HOOKS)
        created = svc.mutate(cid, actor, "create", {**draft, "idempotency_key": body.idempotency_key})
        if not body.start or created.get("launch_enabled"):
            return created
        return svc.mutate(
            cid, actor, "launch",
            {"expected_revision": created["revision"], "idempotency_key": f"{body.idempotency_key}:launch", "reason": ""},
            wid=created["id"],
        )


# One Start for any workflow: prepare what isn't, then Start (§6.3, "Starting is one button").
_workflow_action("/api/workflows/{wid}/launch", "launch", model.Mutation)


# ---- people's decisions and watch steps ---------------------------------------------


def _step_context(cur, request, wid, tid):
    svc = service.WorkflowService(cur, HOOKS)
    w = svc.workflow(wid)
    t = svc.one("SELECT workflow_id FROM tasks WHERE id=%s", (tid,))
    if not t or str(t["workflow_id"]) != str(wid):
        conflict("workflow_task_required", "That step isn't in this workflow.", status=404)
    actor = resolve_actor(cur, request, w["container_id"], allow_agent=True)
    return svc, w, actor


@app.post("/api/workflows/{wid}/steps/{tid}/decide", tags=["workflow steps"])
def decide_step(wid: str, tid: str, body: DecideBody, request: Request):
    """A person's decision on their step: a gate's Go / No-go / Send back (reason required for
    the last two), or a person step's outcome. An agent gets 403 (§4.1)."""
    service.require_capability()
    with db_cursor() as (_, cur):
        svc, w, actor = _step_context(cur, request, wid, tid)
        return steps.decide(svc, w, tid, actor, body.model_dump())


@app.post("/api/workflows/{wid}/steps/{tid}/check-now", tags=["workflow steps"])
def check_now(wid: str, tid: str, request: Request):
    """Read a watch step's outside status now, instead of waiting for its next reading."""
    service.require_capability()
    with db_cursor() as (_, cur):
        svc, w, actor = _step_context(cur, request, wid, tid)
        p = svc.actor(actor, w["container_id"])
        if p["kind"] != "human":
            conflict("human_required", "A person asks for a reading.", status=403)
        out = steps.check_watch(svc, w, tid)
        return {"reading": out["reading"], "outcome": out["outcome"], "workflow": svc.detail(wid, actor)}


@app.post("/api/workflows/{wid}/steps/{tid}/resolve", tags=["workflow steps"])
def resolve_watch(wid: str, tid: str, body: ResolveBody, request: Request):
    """A person resolves a watch step by hand ("I see it's live"), when the adapter can't know."""
    service.require_capability()
    with db_cursor() as (_, cur):
        svc, w, actor = _step_context(cur, request, wid, tid)
        p = svc.actor(actor, w["container_id"])
        if p["kind"] != "human":
            conflict("human_required", "A person resolves a watch by hand.", status=403)
        t = svc.task(wid, tid)
        if not steps.watch_outcome(steps.spec_of(t) or {}, body.state):
            conflict("watch_state_unknown", "That state doesn't settle this step.", status=422,
                     states=sorted(((steps.spec_of(t) or {}).get("watch") or {}).get("state_map", {})))
        steps.check_watch(svc, w, tid, manual_state=body.state, by=p)
        return svc.detail(wid, actor)


@app.get("/api/workflows/{wid}/proof", tags=["workflow steps"])
def proof_pack(wid: str, request: Request, step: str | None = None):
    """The release page's read model; with `step` (a gate), the proof pack that gate shows."""
    with db_cursor(readonly=True) as (_, cur):
        svc = service.WorkflowService(cur, HOOKS)
        w = svc.workflow(wid)
        require_member_read(cur, request, w["container_id"])
        return proof.build(svc, wid, step)


@app.post("/api/workflows/{wid}/snooze", tags=["workflow steps"])
def snooze(wid: str, body: SnoozeBody, request: Request):
    """Quiet a stalled workflow for a few days (§4.7)."""
    with db_cursor() as (_, cur):
        svc = service.WorkflowService(cur, HOOKS)
        w = svc.workflow(wid)
        actor = resolve_human_actor(cur, request, w["container_id"])
        svc.owner(w, actor, project_owner=True)
        cur.execute("UPDATE workflows SET stall_snoozed_until=%s WHERE id=%s",
                    (sql.ts(sql.from_now(body.days * 86400)), wid))
        return svc.detail(wid, actor)


@app.post("/api/workflows/{wid}/close", tags=["workflow steps"])
def close_release(wid: str, body: CloseBody, request: Request):
    """Finish a workflow whose steps are done: accept its goal with the run as evidence, then
    finish. The same two engine actions as the classic screen, as one."""
    service.require_capability()
    with db_cursor() as (_, cur):
        svc = service.WorkflowService(cur, HOOKS)
        w = svc.workflow(wid)
        actor = resolve_human_actor(cur, request, w["container_id"])
        s = svc.snapshot(wid)
        done = [t for t in s["tasks"].values() if t["status"] == "completed"]
        narrative = (body.note.strip() or f"{w['title']}: every step that ran is done.") + "\n" + "\n".join(
            f"- {t['title']}" for t in done[:80])
        svc.mutate(w["container_id"], actor, "accept_goal",
                   {"expected_revision": w["revision"], "idempotency_key": uuid4().hex, "reason": "",
                    "evidence": {"narrative": narrative[:20000], "task_revisions": {}, "evidence_sets": []}},
                   wid=wid)
        w = svc.workflow(wid)
        return svc.mutate(w["container_id"], actor, "finish",
                          {"expected_revision": w["revision"], "idempotency_key": uuid4().hex, "reason": ""}, wid=wid)


@app.get("/api/workflows/{wid}/next-release", tags=["workflow templates"])
def next_release(wid: str, request: Request):
    """What "Run again" pre-fills for a templated workflow: its template, parameters with the
    build bumped, and the same removals."""
    with db_cursor(readonly=True) as (_, cur):
        svc = service.WorkflowService(cur, HOOKS)
        w = svc.workflow(wid)
        require_member_read(cur, request, w["container_id"])
        ref = steps.template_of(w)
        if not ref:
            conflict("not_templated", "This workflow wasn't made from a template.", status=404)
        params = dict(ref.get("params") or {})
        if str(params.get("build", "")).isdigit():
            params["build"] = str(int(params["build"]) + 1)
        params.pop("release_type", None)  # asked every version, never carried over
        return {"key": ref["key"], "params": params, "removed": ref.get("removed") or [], "from": wid}


# ---- the board ------------------------------------------------------------------------


def _state_word(t) -> str:
    if t.get("withdrawn_at") or t.get("route_state") == "not_selected":
        return "skipped"
    if t.get("awaiting_loop_decision"):
        return "asking"
    return {"completed": "done", "in_progress": "running", "needs_verification": "review",
            "ready": "ready", "cancelled": "skipped"}.get(t["status"], "waiting")


@app.get("/api/containers/{cid}/workflow-board", tags=["workflow steps"])
def board(cid: str, request: Request, include_finished: bool = False):
    """The Workflows home in one light read: a row per workflow with its steps thread, what
    waits for a person, its stage, and whether it stalled. Stalled first, finished folded."""
    with db_cursor(readonly=True) as (_, cur):
        require_member_read(cur, request, cid)
        svc = service.WorkflowService(cur, HOOKS)
        me = None
        try:
            me = resolve_human_actor(cur, request, cid).id
        except HTTPException:
            pass
        rows = svc.rows(
            "SELECT * FROM workflows WHERE container_id=%s AND hidden_at IS NULL ORDER BY created_at DESC LIMIT 300",
            (cid,),
        )
        out = []
        for w in rows:
            finished = w["status"] in {"completed", "cancelled"}
            tasks = svc.rows(
                "SELECT id, title, status, route_state, withdrawn_at, awaiting_loop_decision, awaiting_owner_decision, "
                "step_spec, qa_step, preparation_state FROM tasks WHERE workflow_id=%s ORDER BY priority, created_at, id",
                (w["id"],),
            )
            last = svc.one("SELECT MAX(created_at) AS at FROM workflow_history WHERE workflow_id=%s", (w["id"],))
            thread, waiting, stage = [], 0, None
            for t in tasks:
                spec = steps.spec_of(t) or {}
                kind = steps.kind_of(t)
                word = _state_word(t)
                person = kind in steps.PEOPLE and word == "ready"
                if (person or word == "asking" or t.get("awaiting_owner_decision")) and w["status"] == "active":
                    if not me or str(spec.get("person_id") or w["owner_human_id"]) == me or str(w["owner_human_id"]) == me:
                        waiting += 1
                if not stage and word in {"ready", "running", "review", "asking"}:
                    stage = spec.get("stage_title") or None
                thread.append({"id": t["id"], "title": t["title"], "kind": kind, "state": word,
                               "outward": bool(spec.get("irreversible"))})
            ref = steps.template_of(w)
            out.append({
                "id": w["id"], "title": w["title"], "status": w["status"], "launch_enabled": bool(w["launch_enabled"]),
                "template": {"key": ref["key"], "name": ref["name"]} if ref else None,
                "dry_run": bool(w.get("dry_run")), "thread": thread, "waiting_for_you": waiting,
                "stage": stage, "created_at": w["created_at"], "last_activity": last["at"] if last else None,
                "stalled": steps.stalled_view(svc, w), "finished": finished,
                "done": sum(1 for x in thread if x["state"] == "done"),
                "total": sum(1 for x in thread if x["state"] != "skipped"),
            })
        active = [r for r in out if not r["finished"]]
        active.sort(key=lambda r: (not r["stalled"], -r["waiting_for_you"]))  # stable: newest first within
        done = [r for r in out if r["finished"]]
        return {"workflows": active + (done if include_finished else []), "finished_count": len(done),
                "stall_days": steps.STALL_DAYS}
