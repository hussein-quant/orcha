"""GH #409 Talk: decisions made from the master chat, by voice or by typing.

Contract under test:
  * merge / deploy / publish / submit items name their sensitive words, so approve/accept
    needs the confirm phrase; the read-back says exactly what will happen;
  * a decision goes through the SAME route as a click (/api/decisions, /verify, /respond)
    with via='voice' + a recorded voice action, and the audit trail keeps the transcript;
    a click without `via` behaves exactly as before;
  * only items that still need someone, in this project, can be decided.
No test calls a model or the network.
"""
import json
import pathlib
import sys
import uuid

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / "orcha-cli"))

import main  # noqa: E402,F401
from portal_backend import voice_briefing, voice_intent  # noqa: E402
from portal_backend.database import db_cursor  # noqa: E402

def _detail(row):
    d = row["detail"]
    return json.loads(d) if isinstance(d, str) else d


PLAN = "1. Archive build 4\n2. Upload it to TestFlight\n3. Stop if the purchase scan fails."


@pytest.fixture(autouse=True)
def _no_cloud_speech(monkeypatch):
    """No cloud speech key leaks in from the environment."""
    for env in ("OPENAI_API_KEY", "DEEPGRAM_API_KEY", "GROQ_API_KEY"):
        monkeypatch.delenv(env, raising=False)


# --------------------------------------------------------------------------- rules


def test_sensitive_words_gate_approvals_only():
    assert voice_intent.sensitive_words("Merge PR 12", "then deploy to production") == ["merge", "deploy", "production"]
    assert voice_intent.sensitive_words("Fix the login crash") == []
    assert voice_intent.CONFIRMABLE == ("approve_plan", "accept")  # rejections are never gated


def test_read_back_says_what_will_happen():
    assert voice_intent._read_back("approve_plan", None) == "Approving the plan."
    assert voice_intent._read_back("send_back", "The Login screen still crashes.") == "Sending it back: The Login screen still crashes."
    assert voice_intent._read_back("answer", "port 8080") == "Answering: port 8080."


# --------------------------------------------------------------------------- seeding


async def _seed_plan(client, db, make_agent, make_task, body=PLAN):
    human = (await make_agent("Owner", "operator", kind="human"))["agent_id"]
    dev = (await make_agent("ReleaseEngineer"))["agent_id"]
    t = await make_task("Ship build 4", "uploaded", assignee_alias="ReleaseEngineer")
    db.execute("UPDATE tasks SET status='in_progress' WHERE id=%s", (t["id"],))
    db.execute("INSERT INTO task_messages (task_id, author_id, body) VALUES (%s,%s,%s)", (t["id"], dev, body))
    return human, dev, t["id"]


async def _seed_verify(make_agent, make_task, db):
    human = (await make_agent("Owner", "operator", kind="human"))["agent_id"]
    dev = (await make_agent("dev"))["agent_id"]
    t = await make_task("Fix login", "login works", assignee_alias="dev")
    db.execute("UPDATE tasks SET status='needs_verification' WHERE id=%s", (t["id"],))
    db.execute("UPDATE agent_tasks SET assignment_status='done' WHERE task_id=%s", (t["id"],))
    db.execute("INSERT INTO task_messages (task_id, author_id, body) VALUES (%s,%s,%s)",
               (t["id"], dev, "Fixed the crash on the login screen; tests pass."))
    return human, dev, t["id"]


async def _record(client, cid, human, kind, item_id, action, transcript, text=None, key=None):
    r = await client.post(f"/api/containers/{cid}/voice-first/actions", json={
        "actor_agent_id": human, "idempotency_key": key or str(uuid.uuid4()), "kind": kind,
        "item_id": item_id, "action": action, "transcript": transcript, "text": text,
    })
    assert r.status_code == 200, r.text
    return r.json()


# --------------------------------------------------------------------------- what can be decided


@pytest.mark.asyncio
async def test_the_item_is_loaded_as_it_stands(client, container, db, make_agent, make_task):
    _, _, tid = await _seed_plan(client, db, make_agent, make_task)
    with db_cursor(readonly=True) as (_, cur):
        ctx = voice_briefing.load_item(cur, container["id"], "plan", tid)
    assert (ctx.title, ctx.agent_alias) == ("Ship build 4", "ReleaseEngineer")
    assert "Upload it to TestFlight" in ctx.body and ctx.sensitive() == ["testflight"]


@pytest.mark.asyncio
async def test_only_items_that_still_need_someone_can_be_recorded(client, container, db, make_agent, make_task):
    human, _, tid = await _seed_plan(client, db, make_agent, make_task)
    cid = container["id"]

    async def record(item_id):
        return await client.post(f"/api/containers/{cid}/voice-first/actions", json={
            "actor_agent_id": human, "idempotency_key": str(uuid.uuid4()), "kind": "plan",
            "item_id": item_id, "action": "approve_plan", "transcript": "approve"})

    assert (await record(str(uuid.uuid4()))).status_code == 404
    db.execute("UPDATE tasks SET status='completed' WHERE id=%s", (tid,))
    assert (await record(tid)).status_code == 409


@pytest.mark.asyncio
async def test_workflow_results_are_accepted_on_screen(client, container, db, make_agent, make_task, monkeypatch):
    human, _, tid = await _seed_verify(make_agent, make_task, db)
    real = voice_briefing.load_item

    def as_workflow(cur, cid, kind, item_id):
        ctx = real(cur, cid, kind, item_id)
        ctx.extra["workflow"] = True
        return ctx

    monkeypatch.setattr(voice_briefing, "load_item", as_workflow)
    r = await client.post(f"/api/containers/{container['id']}/voice-first/propose",
                          json={"actor_agent_id": human, "action": "accept", "args": {"task": tid[:8]}})
    assert r.status_code == 200, r.text
    assert r.json()["say"] == voice_briefing.WORKFLOW_ACCEPT_ON_SCREEN


# --------------------------------------------------------------------------- decisions by voice


@pytest.mark.asyncio
async def test_plan_approved_by_voice_goes_through_decisions_and_is_audited(client, container, db, make_agent, make_task):
    cid = container["id"]
    human, dev, tid = await _seed_plan(client, db, make_agent, make_task)
    va = await _record(client, cid, human, "plan", tid, "approve_plan", "Approve. Confirm.")
    assert va["status"] == "pending" and va["created"] is True
    r = await client.post("/api/decisions", json={
        "subject_type": "plan_approval", "subject_id": tid, "decision": "approve",
        "actor_agent_id": human, "via": "voice", "voice_action_id": va["voice_action_id"],
    })
    assert r.status_code == 201, r.text
    row = db.execute("SELECT status, result FROM voice_actions WHERE id=%s", (va["voice_action_id"],))[0]
    assert row["status"] == "done" and r.json()["decision_id"] in row["result"]
    ev = db.execute("SELECT detail FROM events WHERE event_type='voice_decision' AND entity_id=%s", (tid,))
    assert len(ev) == 1
    assert _detail(ev[0])["via"] == "voice" and _detail(ev[0])["transcript"] == "Approve. Confirm."
    # the agent still sees the normal decision in its thread (format unchanged)
    msgs = db.execute("SELECT body FROM task_messages WHERE task_id=%s AND author_id=%s", (tid, human))
    assert msgs[-1]["body"] == "[DECISION · plan_approval = APPROVED by Owner]"
    # the same voice action cannot be used twice
    again = await client.post("/api/decisions", json={
        "subject_type": "plan_approval", "subject_id": tid, "decision": "approve",
        "actor_agent_id": human, "via": "voice", "voice_action_id": va["voice_action_id"],
    })
    assert again.status_code == 409


@pytest.mark.asyncio
async def test_recording_is_idempotent_and_scoped(client, container, db, make_agent, make_task):
    cid = container["id"]
    human, _, tid = await _seed_plan(client, db, make_agent, make_task)
    key = str(uuid.uuid4())
    a = await _record(client, cid, human, "plan", tid, "approve_plan", "approve", key=key)
    b = await _record(client, cid, human, "plan", tid, "approve_plan", "approve", key=key)
    assert a["voice_action_id"] == b["voice_action_id"] and b["created"] is False
    clash = await client.post(f"/api/containers/{cid}/voice-first/actions", json={
        "actor_agent_id": human, "idempotency_key": key, "kind": "plan", "item_id": tid,
        "action": "reject_plan", "transcript": "no",
    })
    assert clash.status_code == 409
    wrong = await client.post(f"/api/containers/{cid}/voice-first/actions", json={
        "actor_agent_id": human, "idempotency_key": str(uuid.uuid4()), "kind": "plan", "item_id": tid,
        "action": "send_back", "transcript": "x",
    })
    assert wrong.status_code == 422


@pytest.mark.asyncio
async def test_voice_ids_are_checked_by_the_decision_route(client, container, db, make_agent, make_task):
    cid = container["id"]
    human, dev, tid = await _seed_plan(client, db, make_agent, make_task)
    body = {"subject_type": "plan_approval", "subject_id": tid, "decision": "approve", "actor_agent_id": human}
    assert (await client.post("/api/decisions", json={**body, "via": "voice"})).status_code == 422
    va = await _record(client, cid, human, "plan", tid, "approve_plan", "approve")
    other = (await make_agent("Zed", "operator", kind="human"))["agent_id"]
    r = await client.post("/api/decisions", json={**body, "actor_agent_id": other, "via": "voice",
                                                   "voice_action_id": va["voice_action_id"]})
    assert r.status_code == 403
    # an AI can never make a decision, voice or not
    r = await client.post("/api/decisions", json={**body, "actor_agent_id": dev, "via": "voice",
                                                   "voice_action_id": va["voice_action_id"]})
    assert r.status_code in (400, 403)
    assert db.execute("SELECT count(*) AS n FROM decisions WHERE subject_id=%s", (tid,))[0]["n"] == 0


@pytest.mark.asyncio
async def test_undo_window_cancels_the_decision(client, container, db, make_agent, make_task):
    cid = container["id"]
    human, _, tid = await _seed_plan(client, db, make_agent, make_task)
    va = await _record(client, cid, human, "plan", tid, "approve_plan", "approve")
    r = await client.patch(f"/api/containers/{cid}/voice-first/actions/{va['voice_action_id']}",
                           json={"actor_agent_id": human, "status": "undone"})
    assert r.status_code == 200 and r.json()["status"] == "undone"
    r = await client.post("/api/decisions", json={
        "subject_type": "plan_approval", "subject_id": tid, "decision": "approve", "actor_agent_id": human,
        "via": "voice", "voice_action_id": va["voice_action_id"]})
    assert r.status_code == 409
    assert db.execute("SELECT count(*) AS n FROM decisions WHERE subject_id=%s", (tid,))[0]["n"] == 0


@pytest.mark.asyncio
async def test_send_back_by_voice(client, container, db, make_agent, make_task):
    cid = container["id"]
    human, dev, tid = await _seed_verify(make_agent, make_task, db)
    va = await _record(client, cid, human, "verify", tid, "send_back",
                       "send it back because the logout button is gone", text="the logout button is gone")
    r = await client.post(f"/api/tasks/{tid}/verify", json={
        "approve": False, "feedback": "the logout button is gone", "actor_agent_id": human,
        "via": "voice", "voice_action_id": va["voice_action_id"]})
    assert r.status_code == 200, r.text
    assert db.execute("SELECT status FROM tasks WHERE id=%s", (tid,))[0]["status"] == "in_progress"
    ev = db.execute("SELECT detail FROM events WHERE event_type='verified' AND entity_id=%s", (tid,))
    assert _detail(ev[-1])["via"] == "voice" and _detail(ev[-1])["voice_action_id"] == va["voice_action_id"]
    assert db.execute("SELECT status FROM voice_actions WHERE id=%s", (va["voice_action_id"],))[0]["status"] == "done"


@pytest.mark.asyncio
async def test_accept_by_voice(client, container, db, make_agent, make_task):
    cid = container["id"]
    human, _, tid = await _seed_verify(make_agent, make_task, db)
    va = await _record(client, cid, human, "verify", tid, "accept", "looks good")
    r = await client.post(f"/api/tasks/{tid}/verify", json={
        "approve": True, "actor_agent_id": human, "via": "voice", "voice_action_id": va["voice_action_id"]})
    assert r.status_code == 200, r.text
    assert db.execute("SELECT status FROM tasks WHERE id=%s", (tid,))[0]["status"] == "completed"


@pytest.mark.asyncio
async def test_answer_by_voice(client, container, db, make_agent, make_request):
    cid = container["id"]
    human = (await make_agent("Owner", "operator", kind="human"))["agent_id"]
    dev = (await make_agent("dev"))["agent_id"]
    req = await make_request(dev, "Which port should staging use?", target_alias="Owner")
    with db_cursor(readonly=True) as (_, cur):
        ctx = voice_briefing.load_item(cur, cid, "request", req["id"])
    assert (ctx.title, ctx.agent_alias) == ("Which port should staging use?", "dev")
    va = await _record(client, cid, human, "request", req["id"], "answer", "answer: port 8080", text="port 8080")
    r = await client.post(f"/api/requests/{req['id']}/respond", json={
        "responder_agent_id": human, "response": "port 8080", "via": "voice",
        "voice_action_id": va["voice_action_id"]})
    assert r.status_code == 200, r.text
    assert db.execute("SELECT response FROM requests WHERE id=%s", (req["id"],))[0]["response"] == "port 8080"
    ev = db.execute("SELECT detail FROM events WHERE event_type='voice_decision' AND entity_id=%s", (req["id"],))
    assert len(ev) == 1 and _detail(ev[0])["transcript"] == "answer: port 8080"


@pytest.mark.asyncio
async def test_status_without_local_speech(client, container, monkeypatch):
    from portal_backend import voice_first_routes as vfr

    monkeypatch.setattr(vfr, "voice_runtime", None)
    d = (await client.get(f"/api/containers/{container['id']}/voice-first/status")).json()
    assert d["local"]["installed"] is False and "Mac" in d["local"]["reason"]
    assert d["cloud_stt_available"] is False and d["audio_retention"] == "none"
    r = await client.post(f"/api/containers/{container['id']}/voice-first/speak", json={"text": "hi"})
    assert r.status_code == 409 and r.json()["detail"]["code"] == "local_unavailable"
