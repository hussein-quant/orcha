"""Person, gate and watch steps, dry runs, and stalled workflows (Mobile App Release §4.1, §4.2,
§4.7, §4.8).

Nothing here routes on its own. A person's decision, a watch reading that settles and a dry-run
stub all finish a step through the engine's own path, in one transaction: an outside result
from the workflow owner, its review turn, the outcome, and the acceptance. So outcomes, routes,
repeat groups, history and the finish check behave exactly as for any other step.
"""

from __future__ import annotations

import datetime as _dt
import json
import logging
import os
import re
import shlex
import subprocess
import threading
import time
import urllib.request
from uuid import uuid4

from fastapi import HTTPException

from portal_backend import sql
from portal_backend.workflow_graph import ancestors, conflict

logger = logging.getLogger(__name__)

PEOPLE = frozenset({"person", "gate"})
NO_WORKER = frozenset({"person", "gate", "watch"})
STALL_DAYS = float(os.environ.get("ORCHA_WORKFLOW_STALL_DAYS", "3") or 3)
DRY_RUN_DELAY_S = float(os.environ.get("ORCHA_DRY_RUN_DELAY_S", "4") or 4)
ADAPTER_TIMEOUT_S = 120


# ---- reading a step ---------------------------------------------------------


def _load(value):
    if value is None or isinstance(value, (dict, list)):
        return value
    try:
        return json.loads(value)
    except (TypeError, ValueError):
        return None


def spec_of(task) -> dict | None:
    """The step's StepSpec, or None for a classic step."""
    spec = _load(task.get("step_spec"))
    return spec if isinstance(spec, dict) else None


def kind_of(task) -> str:
    spec = spec_of(task)
    if spec and spec.get("kind"):
        return spec["kind"]
    return "qa" if task.get("qa_step") else "agent"


def no_worker(task) -> bool:
    """Person, gate and watch steps never take a worker turn."""
    return kind_of(task) in NO_WORKER


def save_step(cur, tid, spec) -> None:
    cur.execute(
        "UPDATE tasks SET step_spec=%s WHERE id=%s",
        (json.dumps(spec, sort_keys=True), tid),
    )


def template_of(w) -> dict | None:
    ref = _load(w.get("template_ref"))
    return ref if isinstance(ref, dict) else None


def _ts(value) -> _dt.datetime | None:
    if value is None:
        return None
    if isinstance(value, _dt.datetime):
        return value if value.tzinfo else value.replace(tzinfo=_dt.timezone.utc)
    try:
        parsed = _dt.datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=_dt.timezone.utc)


# ---- validating a draft -----------------------------------------------------


def check_draft(tasks: list[dict]) -> None:
    """What the engine needs of the new step kinds, for preview and create alike.

    - A person, gate or watch step has no agent assignee.
    - A gate declares the outcome `go`; a watch step maps at least one state to an outcome.
    - An irreversible step (submit, promote, production deploy) waits on a gate (§4.8).
    """
    by_key = {t["client_key"]: t for t in tasks}
    deps = {t["client_key"]: list(t.get("depends_on") or []) for t in tasks}
    for t in tasks:
        spec = t.get("step") or {}
        kind = spec.get("kind") or "agent"
        key = t["client_key"]
        if kind in NO_WORKER and t.get("assignee_id"):
            conflict(
                "person_step_assignee",
                "A person, gate or watch step is not worked by an agent; leave its agent empty.",
                status=422,
                task_id=key,
            )
        names = {o["name"].strip().casefold() for o in t.get("outcomes") or []}
        if kind == "gate" and "go" not in names:
            conflict("gate_outcomes", "A gate needs the outcome go.", status=422, task_id=key)
        if kind == "watch":
            watch = spec.get("watch") or {}
            adapter = watch.get("adapter") or {}
            if not (adapter.get("command") or adapter.get("http")):
                conflict("watch_adapter", "A watch step needs a status command or URL.", status=422, task_id=key)
            unknown = sorted(
                {v for v in (watch.get("state_map") or {}).values()}
                - {o["name"] for o in t.get("outcomes") or []}
            )
            if not watch.get("state_map") or unknown:
                conflict(
                    "watch_states",
                    "Map the outside states to this step's outcomes.",
                    status=422,
                    task_id=key,
                    outcomes=unknown,
                )
        if spec.get("irreversible"):
            gates = [
                a
                for a in ancestors(key, deps)
                if ((by_key.get(a) or {}).get("step") or {}).get("kind") == "gate"
            ]
            if not gates:
                conflict(
                    "irreversible_without_gate",
                    f"{t['title']} can't be undone and nothing asks for a go before it. Add a go/no-go gate.",
                    status=422,
                    task_id=key,
                )


# ---- eligibility (called by workflow_scheduling) ------------------------------


def turn_free(task, workflow) -> bool:
    """Steps that never hold a worker or a device do not wait for a worker's turn."""
    return no_worker(task) or bool(workflow.get("dry_run"))


def irreversible_blocker(task, tasks, dependencies, accepted) -> str | None:
    """§4.8: an irreversible step starts only after a gate of THIS run said go. A gate's
    acceptance is per work revision, so a send-back or a new round never carries one over."""
    spec = spec_of(task)
    if not spec or not spec.get("irreversible"):
        return None
    gates = [a for a in ancestors(task["id"], dependencies) if a in tasks and kind_of(tasks[a]) == "gate"]
    if not gates:
        return "Nothing asked for a go before this step."
    if not all(accepted(tasks[g]) for g in gates):
        return "Waiting for the go-ahead in this run."
    return None


# ---- finishing a step through the engine --------------------------------------


def _evidence_items(cur, sid):
    from portal_backend.workflow_evidence_service import evidence_reference

    current = evidence_reference(cur, sid)
    keys = ("item_id", "deliverable_id", "deliverable_version", "sha256")
    return [{k: item.get(k) for k in keys} for item in current["items"]]


def _send_back_to(svc, w, task, target):
    """Point the gate's send-back at the step the person chose (one of its loop's steps)."""
    from portal_backend import workflow_routing as routing

    flow = routing.load_flow(svc, w["id"])
    group = next((g for g in flow[2] if g["review_task"] == task["id"]), None)
    rule = next(
        (r for r in flow[1].get(task["id"], []) if r["destination"] == "return"),
        None,
    )
    if not group or not rule:
        conflict("send_back_unavailable", "This gate can't send work back.", status=422)
    if target is None:
        return rule["outcome"]
    if target == task["id"] or target not in group["member_tasks"]:
        conflict(
            "send_back_target",
            "Send work back to one of the steps before this gate.",
            status=422,
            choices=[m for m in group["member_tasks"] if m != task["id"]],
        )
    svc.cur.execute(
        "UPDATE workflow_step_routes SET destination_task_id=%s WHERE task_id=%s AND outcome_name=%s",
        (target, task["id"], rule["outcome"]),
    )
    return rule["outcome"]


def finish(svc, w, tid, actor, *, outcome: str | None, narrative: str, note: str = "", findings=None,
           produced_by: str = "person"):
    """Finish a ready person, gate, watch (or dry-run) step with `outcome`, through the
    engine's own path. Raises the engine's own conflicts; the caller's transaction rolls back."""
    cid = w["container_id"]
    key = uuid4().hex

    def fresh():
        return svc.workflow(w["id"]), svc.task(w["id"], tid)

    wf, t = fresh()
    if t["status"] != "ready":
        conflict(
            "step_not_waiting",
            "This step is not waiting for a decision yet." if t["status"] in {"pending", "not_ready"}
            else "This step was already decided.",
        )
    narrative = redact(narrative)[:200_000]
    svc.mutate(
        cid, actor, "external_result",
        {"expected_revision": wf["revision"], "expected_work_revision": t["work_revision"],
         "idempotency_key": f"{key}-result", "reason": "",
         "evidence": {"narrative": narrative, "task_revisions": {}, "evidence_sets": []},
         "produced_by": produced_by[:200]},
        wid=w["id"], tid=tid,
    )
    svc.reserve_turn(tid, actor)
    wf, t = fresh()
    if outcome is not None:
        svc.mutate(
            cid, actor, "report_outcome",
            {"expected_revision": wf["revision"], "expected_work_revision": t["work_revision"],
             "idempotency_key": f"{key}-outcome", "reason": "", "outcome": outcome,
             "findings": findings or [], "note": redact(note)[:4000]},
            wid=w["id"], tid=tid,
        )
        wf, t = fresh()
    turn = svc.live_turn(tid)
    sid = turn["current_evidence_set_id"]
    return svc.mutate(
        cid, actor, "accept",
        {"expected_revision": wf["revision"], "expected_work_revision": t["work_revision"],
         "idempotency_key": f"{key}-accept", "reason": "",
         "evidence": {"evidence_set_id": str(sid), "items": _evidence_items(svc.cur, sid)}},
        wid=w["id"], tid=tid,
    )


GATE_OUTCOME = {"go": "go", "no_go": "no_go"}


def decide(svc, w, tid, actor, body) -> dict:
    """A person decides their step: a gate's Go / No-go / Send back, or a person step's outcome.
    No agent can: the actor is a verified person, and only the step's person or the workflow
    owner decides (§4.1)."""
    from portal_backend.workflow_service import WorkflowActor

    p = svc.actor(actor, w["container_id"])
    t = svc.task(w["id"], tid)
    kind = kind_of(t)
    if p["kind"] != "human":
        conflict("person_step", "Only a person decides this step.", status=403)
    if kind not in PEOPLE and not (kind == "watch" and body.get("outcome")):
        conflict("not_a_person_step", "This step is not decided by a person.", status=422)
    spec = spec_of(t) or {}
    owner_id = str(w["owner_human_id"])
    if str(p["id"]) not in {owner_id, str(spec.get("person_id") or owner_id)}:
        conflict("person_step_owner", "This step belongs to someone else.", status=403)
    reason = (body.get("reason") or "").strip()
    choice = body.get("choice")
    if kind == "gate":
        gate = spec.get("gate") or {}
        allowed = gate.get("choices") or ["go", "no_go", "send_back"]
        if choice not in allowed:
            conflict("gate_choice", "Choose Go, No-go or Send back.", status=422, choices=allowed)
        if choice in (gate.get("require_reason") or ["no_go", "send_back"]) and not reason:
            conflict("reason_required", "Say why, so the team knows what to change.", status=422)
        outcome = (
            _send_back_to(svc, w, t, body.get("send_back_to"))
            if choice == "send_back"
            else GATE_OUTCOME[choice]
        )
        words = {"go": "Go", "no_go": "No-go", "send_back": "Send back"}[choice]
    else:
        outcome = body.get("outcome")
        names = [o["name"] for o in _outcomes(svc, tid)]
        if names and outcome not in names:
            conflict("unknown_outcome", "Choose one of this step's outcomes.", status=422, outcomes=names)
        words = outcome or "Done"
    narrative = (
        f"{words}, decided by {p['alias']}."
        + (f"\nWhy: {reason}" if reason else "")
        + (f"\nProof seen: {body['proof_digest']}" if body.get("proof_digest") else "")
    )
    # The decision runs as the workflow owner (the engine's outside-result path is the
    # owner's); who decided is in the narrative, the audit and the decision record.
    owner = WorkflowActor(owner_id, True)
    result = finish(svc, w, tid, owner, outcome=outcome, narrative=narrative, note=reason,
                    produced_by=f"{kind}:{p['alias']}")
    if kind == "gate":
        _record_decision(svc.cur, w, t, p, choice, reason)
    return result


def _outcomes(svc, tid):
    return svc.rows("SELECT name, kind FROM workflow_step_outcomes WHERE task_id=%s", (tid,))


def _record_decision(cur, w, t, p, choice, reason):
    """The gate decision also lands in /api/decisions' table, as the brief asks (§4.1)."""
    try:
        cur.execute(
            "INSERT INTO decisions(id, container_id, subject_type, subject_id, decision, reason, actor_agent_id) "
            "VALUES (%s,%s,%s,%s,%s,%s,%s)",
            (str(uuid4()), w["container_id"], "workflow_gate", t["id"],
             "approve" if choice == "go" else "reject",
             reason or ("Go" if choice == "go" else str(choice)), p["id"]),
        )
    except Exception as error:  # noqa: BLE001 - the decisions table's shape is not ours
        logger.info("gate decision kept in history only: %s", error)


# ---- watch steps --------------------------------------------------------------


def history_by_task(cur, wid) -> dict[str, list[dict]]:
    """Every outcome each step reported in this workflow, oldest first, with its loop round, so a
    step a later round skipped still shows what it found before (finding 4)."""
    # A round records each member at the work revision it started with; preparing and finishing
    # move the revision on, so a report belongs to the latest round started at or before it.
    cur.execute(
        "SELECT i.task_id, i.work_revision, g.round_number FROM workflow_step_instances i "
        "JOIN workflow_group_rounds g ON g.id=i.group_round_id WHERE g.workflow_id=%s",
        (wid,),
    )
    starts: dict[str, list[tuple[int, int]]] = {}
    for r in cur.fetchall():
        starts.setdefault(str(r["task_id"]), []).append((int(r["work_revision"]), int(r["round_number"])))
    cur.execute(
        "SELECT task_id, work_revision, outcome_name, findings, note, reporter_kind, reported_at "
        "FROM workflow_outcome_reports WHERE workflow_id=%s ORDER BY reported_at, work_revision",
        (wid,),
    )
    out: dict[str, list[dict]] = {}
    for r in cur.fetchall():
        tid = str(r["task_id"])
        rounds = [n for rev, n in sorted(starts.get(tid, [])) if rev <= int(r["work_revision"])]
        findings = _load(r["findings"]) or []
        out.setdefault(tid, []).append({
            "round": rounds[-1] if rounds else None, "work_revision": r["work_revision"],
            "outcome": r["outcome_name"], "note": redact(str(r["note"] or ""))[:600],
            "reporter_kind": r["reporter_kind"], "reported_at": r["reported_at"],
            "findings": [redact(str(f.get("text") if isinstance(f, dict) else f))[:300] for f in findings][:10],
        })
    return out


def watch_view(cur, task) -> dict:
    cur.execute(
        "SELECT state, terminal, summary, detail_url, data, source, error, observed_at, created_at "
        "FROM workflow_watch_observations WHERE task_id=%s ORDER BY created_at DESC LIMIT 30",
        (task["id"],),
    )
    rows = [dict(r) for r in cur.fetchall()]
    for r in rows:
        r["data"] = _load(r.get("data"))
        r["terminal"] = bool(r.get("terminal"))
    cur.execute("SELECT * FROM workflow_watch_state WHERE task_id=%s", (task["id"],))
    state = cur.fetchone()
    spec = spec_of(task) or {}
    latest = rows[0] if rows else None
    last_good = next((r for r in rows if r["state"] != "error"), None)
    return {
        "latest": latest,
        "observations": list(reversed(rows)),
        "next_check_at": state["next_check_at"] if state else None,
        "attempts": state["attempts"] if state else 0,
        # The adapter itself failed (crash, bad output, its own "error"): not a store state.
        "error": latest["error"] or latest["summary"] if latest and latest["state"] == "error" else None,
        "needs_owner": owner_reason(spec, last_good, task) if last_good and last_good["source"] != "manual" else None,
        "outcomes": sorted({v for v in ((spec.get("watch") or {}).get("state_map") or {}).values()}),
    }


def owner_reason(spec: dict, reading: dict | None, task: dict | None = None) -> str | None:
    """Why a watch stopped reading and asks a person instead: a state only a person can settle
    (Play's "unknown"), a final state the step doesn't route on, or a watch that timed out."""
    if not reading:
        return None
    watch = spec.get("watch") or {}
    st = str(reading.get("state") or "").casefold()
    if st in {x.casefold() for x in watch.get("owner_states") or []}:
        return watch.get("owner_hint") or f"The status says {st.replace('_', ' ')}. Only you can confirm what happened."
    final = bool(reading.get("terminal")) or st in {x.casefold() for x in watch.get("terminal_states") or []}
    if final and watch_outcome(spec, st) is None and st not in {"unknown", "error"}:
        return f"The store reported {st.replace('_', ' ')}, a final state this step doesn't route on. Tell Orcha what it means."
    if reading.get("timed_out"):
        return "Stopped reading after the time limit. Tell Orcha what you see."
    return None


def _last_json(text: str):
    """The JSON object that ends the output. Log lines may come before it, braces and all, so
    the first `{` is not where it starts: the outermost object that runs to the end is."""
    text = text.strip()
    decoder = json.JSONDecoder()
    for i, ch in enumerate(text):
        if ch != "{":
            continue
        try:
            value, end = decoder.raw_decode(text, i)
        except ValueError:
            continue
        if not text[end:].strip():
            return value
    raise ValueError("no JSON object at the end of the output")


def _error(summary: str, detail: str) -> dict:
    return {"state": "error", "terminal": False, "summary": summary, "error": redact(detail)[:600]}


def run_adapter(adapter: dict, cwd: str | None) -> dict:
    """Run a status adapter once and return its §4.2 JSON. Never raises: a failure is a
    reading with state `unknown` and the error."""
    try:
        if adapter.get("http"):
            with urllib.request.urlopen(adapter["http"], timeout=30) as resp:  # noqa: S310 - project-configured
                text = resp.read(1_000_000).decode("utf-8", "replace")
        else:
            proc = subprocess.run(
                shlex.split(adapter["command"]), cwd=cwd or None, capture_output=True,
                text=True, timeout=ADAPTER_TIMEOUT_S,
            )
            text = proc.stdout or ""
            if proc.returncode != 0 and not text.strip():
                return _error("Couldn't read the status: the command failed.",
                              (proc.stderr or f"exit code {proc.returncode}")[-600:])
        body = _last_json(text)
        if not isinstance(body, dict) or not isinstance(body.get("state"), str):
            raise ValueError("the output has no state")
        if body["state"].casefold() == "error":
            # The adapter's own failure (exit 2 with a contract JSON): retry, never route on it.
            return _error(f"Couldn't read the status: {body.get('summary') or 'the adapter reported an error'}",
                          str(body.get("error") or body.get("summary") or "error"))
        return body
    except Exception as error:  # noqa: BLE001 - a failed reading is an error, not a store state
        return _error("Couldn't read the status.", f"{type(error).__name__}: {error}")


def record_reading(cur, w, task, reading: dict, source: str) -> None:
    cur.execute(
        "INSERT INTO workflow_watch_observations(id,workflow_id,task_id,work_revision,state,terminal,summary,detail_url,data,source,error,observed_at) "
        "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
        (
            str(uuid4()), w["id"], task["id"], task["work_revision"],
            str(reading.get("state") or "unknown")[:60], bool(reading.get("terminal")),
            redact(str(reading.get("summary") or ""))[:500],
            (str(reading["detail_url"])[:1000] if reading.get("detail_url") else None),
            json.dumps(_redact_obj(reading.get("data") or {}))[:20_000],
            source, reading.get("error"),
            sql.ts(_ts(reading.get("observed_at")) or sql.utcnow()),
        ),
    )


def watch_outcome(spec: dict, state: str) -> str | None:
    mapping = {k.casefold(): v for k, v in ((spec.get("watch") or {}).get("state_map") or {}).items()}
    return mapping.get((state or "").casefold())


def _schedule(cur, task, spec, attempts, last_state, *, dry=False):
    watch = spec.get("watch") or {}
    base = float(watch.get("interval_s") or 300)
    delay = min(base * (float(watch.get("backoff") or 1) ** max(attempts - 1, 0)),
                float(watch.get("max_interval_s") or 3600))
    if dry:  # dry-run readings come a few seconds apart, not minutes
        delay = DRY_RUN_DELAY_S * 0.75
    nxt = sql.ts(sql.from_now(delay))
    cur.execute(
        "INSERT INTO workflow_watch_state(task_id,work_revision,next_check_at,attempts,started_at,last_state) "
        "VALUES (%s,%s,%s,%s,%s,%s) ON CONFLICT (task_id) DO UPDATE SET work_revision=excluded.work_revision,"
        "next_check_at=excluded.next_check_at,attempts=excluded.attempts,last_state=excluded.last_state",
        (task["id"], task["work_revision"], nxt, attempts, sql.ts(sql.utcnow()), last_state),
    )


def check_watch(svc, w, tid, *, manual_state: str | None = None, by=None) -> dict:
    """Take one reading of a ready watch step and, when it settles, finish the step with the
    mapped outcome. `manual_state` is a person resolving it by hand ("I see it's live")."""
    from portal_backend.workflow_service import WorkflowActor

    t = svc.task(w["id"], tid)
    spec = spec_of(t) or {}
    if kind_of(t) != "watch":
        conflict("not_a_watch_step", "This step does not watch an outside status.", status=422)
    if t["status"] != "ready":
        conflict("step_not_waiting", "This step is not watching yet.")
    cur = svc.cur
    cur.execute("SELECT * FROM workflow_watch_state WHERE task_id=%s", (tid,))
    row = cur.fetchone()
    attempts = (row["attempts"] if row and row["work_revision"] == t["work_revision"] else 0) + 1
    if manual_state:
        if watch_outcome(spec, manual_state) is None:
            conflict("state_not_routed", "That state doesn't lead anywhere from this step.", status=422,
                     states=sorted(((spec.get("watch") or {}).get("state_map") or {}).keys()))
        reading = {"state": manual_state, "terminal": True,
                   "summary": f"Resolved by hand by {by['alias'] if by else 'the owner'}."}
        source = "manual"
    elif w.get("dry_run"):
        states = (spec.get("watch") or {}).get("dry_run_states") or ["unknown"]
        state = states[min(attempts - 1, len(states) - 1)]
        reading = {"state": state, "terminal": watch_outcome(spec, state) is not None
                   or state in ((spec.get("watch") or {}).get("owner_states") or []),
                   "summary": f"Dry run: the store reports {state.replace('_', ' ')}."}
        source = "dry_run"
    else:
        reading = run_adapter((spec.get("watch") or {}).get("adapter") or {}, os.environ.get("ORCHA_LOCAL_REPO_DIR"))
        source = "adapter"
    record_reading(cur, w, t, reading, source)
    outcome = watch_outcome(spec, reading.get("state"))
    started = _ts(row["started_at"]) if row and row["work_revision"] == t["work_revision"] else sql.utcnow()
    timeout_h = float((spec.get("watch") or {}).get("timeout_h") or 72)
    timed_out = (sql.utcnow() - (started or sql.utcnow())).total_seconds() > timeout_h * 3600
    _schedule(cur, t, spec, attempts, reading.get("state"), dry=bool(w.get("dry_run")))
    if timed_out and not outcome:
        reading["timed_out"] = True
    asks = None if outcome or reading.get("state") == "error" else owner_reason(spec, reading)
    if asks:
        # Stop reading: only a person can settle this (finding 5, 6). The card asks them.
        cur.execute(
            "UPDATE workflow_watch_state SET next_check_at=%s WHERE task_id=%s",
            (sql.ts(sql.from_now(365 * 86400)), tid),
        )
        reading["needs_owner"] = asks
    from portal_backend.events import publish_event

    publish_event(cur, w["container_id"], None, "workflow_watch_reading",
                  {"workflow_id": w["id"], "task_id": tid, "state": reading.get("state")})
    if asks:
        publish_event(cur, w["container_id"], str(w["owner_human_id"]), "workflow_watch_needs_owner",
                      {"workflow_id": w["id"], "task_id": tid, "state": reading.get("state"), "why": asks})
    if outcome:
        owner = WorkflowActor(str(w["owner_human_id"]), True)
        finish(svc, w, tid, owner, outcome=outcome,
               narrative=f"Watched {t['title']}: {reading.get('state')}. {reading.get('summary') or ''}".strip(),
               note=str(reading.get("summary") or ""), produced_by=f"watch:{source}")
    return {"reading": reading, "outcome": outcome}


# ---- secrets (§4.8) -------------------------------------------------------------

_SECRETS = [
    re.compile(r"\b\d+\|[A-Za-z0-9]{24,}\b"),  # Laravel Sanctum id|secret
    re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b"),  # JWT
    re.compile(r"\b(?:sk|pk|rk|ghp|gho|ghs|xox[abprs])[-_][A-Za-z0-9_-]{16,}\b"),
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----"),
    re.compile(r"(?i)\b(password|passwd|secret|token|api[_-]?key|authorization)\s*[:=]\s*\S+"),
    # Long base64-ish runs, but not a commit SHA (all hex).
    re.compile(r"\b(?![0-9a-fA-F]+\b)[A-Za-z0-9+/]{40,}={0,2}"),
]


def redact(text: str) -> str:
    """Hide anything that looks like a token or key before it is stored or shown."""
    out = str(text or "")
    for pattern in _SECRETS:
        out = pattern.sub(lambda m: (m.group(1) + "=[hidden]") if m.groups() else "[hidden]", out)
    return out


def _redact_obj(value):
    if isinstance(value, str):
        return redact(value)
    if isinstance(value, list):
        return [_redact_obj(v) for v in value]
    if isinstance(value, dict):
        return {k: _redact_obj(v) for k, v in value.items()}
    return value


# ---- stalled workflows (§4.7) ---------------------------------------------------


def stalled_view(svc, w) -> dict | None:
    if w["status"] != "active" or not w.get("launch_enabled"):
        return None
    row = svc.one(
        "SELECT MAX(created_at) AS at FROM workflow_history WHERE workflow_id=%s", (w["id"],)
    )
    last = _ts(row["at"] if row else None)
    if not last:
        return None
    idle = (sql.utcnow() - last).total_seconds() / 86400
    snoozed = _ts(w.get("stall_snoozed_until"))
    if idle < STALL_DAYS or (snoozed and snoozed > sql.utcnow()):
        return None
    return {"since": sql.ts(last), "days": round(idle, 1), "threshold_days": STALL_DAYS}


# ---- the driver: dry runs, watch readings, stall notices -------------------------

_driver_started = False
_seen_ready: dict[str, float] = {}


def _dry_outcome(svc, t):
    spec = spec_of(t) or {}
    names = [o["name"] for o in _outcomes(svc, t["id"])]
    if not names:
        return None
    script = ((spec.get("dry_run") or {}).get("outcomes")) or []
    if script:
        n = svc.one("SELECT count(*) AS n FROM workflow_outcome_reports WHERE task_id=%s", (t["id"],))["n"]
        pick = script[min(n, len(script) - 1)]
        if pick in names:
            return pick
    kinds = {o["name"]: o["kind"] for o in _outcomes(svc, t["id"])}
    return next((n for n in names if kinds.get(n) == "success"), names[0])


def tick_workflow(wid: str) -> None:
    """One pass over one workflow: stub its ready dry-run steps, read its due watch steps."""
    from portal_backend.database import db_cursor
    from portal_backend.workflow_integration import IntegratedWorkflowHooks
    from portal_backend.workflow_service import WorkflowActor, WorkflowService

    with db_cursor() as (_, cur):
        svc = WorkflowService(cur, IntegratedWorkflowHooks())
        w = svc.workflow(wid)
        if w["status"] != "active" or not w["launch_enabled"]:
            return
        ready = svc.rows(
            "SELECT * FROM tasks WHERE workflow_id=%s AND status='ready' AND withdrawn_at IS NULL "
            "ORDER BY priority, created_at", (wid,),
        )
    now = time.monotonic()
    for t in ready:
        kind = kind_of(t)
        if kind in PEOPLE:
            continue
        if kind == "watch":
            with db_cursor() as (_, cur):
                cur.execute("SELECT next_check_at, work_revision FROM workflow_watch_state WHERE task_id=%s", (t["id"],))
                row = cur.fetchone()
            due = (
                not row or row["work_revision"] != t["work_revision"]
                or (_ts(row["next_check_at"]) or sql.utcnow()) <= sql.utcnow()
            )
            if w.get("dry_run"):
                first = _seen_ready.setdefault(f"{t['id']}:{t['work_revision']}", now)
                due = due and now - first >= DRY_RUN_DELAY_S * 0.75
            if not due:
                continue
            try:
                with db_cursor() as (_, cur):
                    svc = WorkflowService(cur, IntegratedWorkflowHooks())
                    check_watch(svc, svc.workflow(wid), t["id"])
            except HTTPException as error:
                logger.info("watch %s: %s", t["id"], error.detail)
            continue
        if not w.get("dry_run"):
            continue
        first = _seen_ready.setdefault(f"{t['id']}:{t['work_revision']}", now)
        if now - first < DRY_RUN_DELAY_S:
            continue
        try:
            with db_cursor() as (_, cur):
                svc = WorkflowService(cur, IntegratedWorkflowHooks())
                wf = svc.workflow(wid)
                owner = WorkflowActor(str(wf["owner_human_id"]), True)
                outcome = _dry_outcome(svc, t)
                spec = spec_of(t) or {}
                note = (spec.get("dry_run") or {}).get("note") or ""
                finish(
                    svc, wf, t["id"], owner, outcome=outcome,
                    narrative=f"Dry run: {t['title']} reported {outcome or 'done'} with canned evidence. {note}".strip(),
                    note=note, produced_by="dry_run",
                    findings=[{"id": "dry-1", "text": "Dry run finding: the fee shows as an amount, not a percentage.",
                               "severity": "major"}] if outcome in {"fail", "fix"} else [],
                )
        except HTTPException as error:
            logger.info("dry run %s: %s", t["id"], error.detail)


def notify_stalled() -> None:
    """One notice per stall: the owner hears once, then again only after new progress."""
    from portal_backend.database import db_cursor
    from portal_backend.events import publish_event
    from portal_backend.workflow_integration import IntegratedWorkflowHooks
    from portal_backend.workflow_service import WorkflowService

    with db_cursor() as (_, cur):
        svc = WorkflowService(cur, IntegratedWorkflowHooks())
        for w in svc.rows("SELECT * FROM workflows WHERE status='active' AND launch_enabled", ()):
            view = stalled_view(svc, w)
            notified = _ts(w.get("stall_notified_at"))
            if not view or (notified and notified >= _ts(view["since"])):
                continue
            cur.execute("UPDATE workflows SET stall_notified_at=%s WHERE id=%s", (sql.ts(sql.utcnow()), w["id"]))
            publish_event(cur, w["container_id"], str(w["owner_human_id"]), "workflow_stalled",
                          {"workflow_id": w["id"], "title": w["title"], "days": view["days"],
                           "actions": ["resume", "cancel", "snooze"]})


def driver_pass() -> None:
    from portal_backend.database import db_cursor

    with db_cursor(readonly=True) as (_, cur):
        cur.execute(
            "SELECT DISTINCT w.id FROM workflows w JOIN tasks t ON t.workflow_id=w.id "
            "WHERE w.status='active' AND w.launch_enabled AND t.status='ready' "
            "AND (w.dry_run OR t.step_spec LIKE %s)",
            ('%"kind": "watch"%',),
        )
        ids = [str(r["id"]) for r in cur.fetchall()]
    for wid in ids:
        try:
            tick_workflow(wid)
        except Exception as error:  # noqa: BLE001 - one workflow never stops the others
            logger.warning("workflow driver %s: %s: %s", wid, type(error).__name__, error)


def start_driver() -> None:
    """Daemon thread: dry runs and watch steps every couple of seconds, stalls every ten minutes."""
    global _driver_started
    if _driver_started or os.environ.get("ORCHA_WORKFLOW_DRIVER", "1") in {"0", "off", "false"}:
        return
    _driver_started = True

    def _loop() -> None:
        time.sleep(3)
        last_stall = 0.0
        while True:
            try:
                driver_pass()
                if time.monotonic() - last_stall > 600:
                    last_stall = time.monotonic()
                    notify_stalled()
            except Exception as error:  # noqa: BLE001
                print(f"[workflow-driver] {type(error).__name__}: {error}", flush=True)
            time.sleep(2)

    threading.Thread(target=_loop, name="workflow-driver", daemon=True).start()


# ---- one Start ------------------------------------------------------------------


def launch(svc, w, actor, body) -> None:
    """Prepare every unprepared step and Start, as one action. A person, gate or watch step
    (and every step of a dry run) is prepared as it is: it has no agent to choose. An agent
    step goes through the engine's own Prepare, so it still needs its agent and its criteria."""
    from portal_backend.workflow_service import _id  # noqa: F401 - keep the engine's id helper warm

    p = svc.owner(w, actor)
    svc.active(w)
    if w["launch_enabled"]:
        conflict("already_started", "The workflow was already started.")
    missing = []
    for t in svc.rows(
        "SELECT * FROM tasks WHERE workflow_id=%s AND withdrawn_at IS NULL ORDER BY priority, created_at",
        (w["id"],),
    ):
        if t["status"] in {"completed", "cancelled"} or t["preparation_state"] == "prepared":
            continue
        if not str(t["definition_of_done"] or "").strip():
            missing.append({"task_id": t["id"], "title": t["title"], "need": "done_when"})
            continue
        if no_worker(t) or w.get("dry_run"):
            svc.cur.execute(
                "UPDATE tasks SET preparation_state='prepared',work_revision=work_revision+1 WHERE id=%s",
                (t["id"],),
            )
            svc.audit(w, p, "workflow_task_prepared", {"work_revision": t["work_revision"] + 1}, t["id"], scope=True)
            continue
        try:
            svc.op_prepare(w, actor, {"expected_work_revision": t["work_revision"]}, t["id"])
        except HTTPException as error:
            detail = error.detail if isinstance(error.detail, dict) else {}
            missing.append({"task_id": t["id"], "title": t["title"],
                            "need": "agent" if detail.get("code") == "task_incomplete" else detail.get("code")})
    if missing:
        conflict(
            "launch_incomplete",
            "Some steps need an agent or a 'done when' before Start.",
            status=422,
            steps=missing,
        )
    prepared = svc.rows(
        "SELECT id, work_revision FROM tasks WHERE workflow_id=%s AND preparation_state='prepared' "
        "AND status NOT IN ('completed','cancelled') AND withdrawn_at IS NULL",
        (w["id"],),
    )
    svc.op_start(
        w, actor,
        {"task_ids": [r["id"] for r in prepared],
         "task_revisions": {r["id"]: r["work_revision"] for r in prepared}},
        None,
    )
