"""GH #409 Talk to Orcha: what one project gives the Mac app's master chat.

Contract under test:
  * /context names the team, open work, recently finished work and what needs the owner, with
    short refs the model says back and ids/links the app opens; it acts as the project's human;
  * /propose turns ONE suggested action into the exact request the portal's own button sends,
    with a read-back written by the server (not the model), and that request then works;
  * anything missing or unknown comes back as a short question, never a guessed action;
  * risky decisions carry their sensitive words, so the app asks for the confirm phrase;
  * work actions (create / assign / message) are recorded as voice actions like decisions.
No model runs here: the brain lives in the app.
"""
import pathlib
import sys
import uuid

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / "orcha-cli"))

import main  # noqa: E402,F401


async def _team(make_agent):
    human = (await make_agent("Owner", "operator", kind="human"))["agent_id"]
    dev = (await make_agent("ReleaseEngineer"))["agent_id"]
    return human, dev


async def _plan(db, make_task, dev, body="1. Fix the trip counter.\n2. Add a test."):
    t = await make_task("Fix trip counts", "counts match the sheet", assignee_alias="ReleaseEngineer")
    db.execute("UPDATE tasks SET status='in_progress' WHERE id=%s", (t["id"],))
    db.execute("INSERT INTO task_messages (task_id, author_id, body) VALUES (%s,%s,%s)", (t["id"], dev, body))
    return t["id"]


def _base(container):
    return f"/api/containers/{container['id']}/voice-first"


async def _propose(client, container, human, action, args):
    r = await client.post(_base(container) + "/propose", json={"actor_agent_id": human, "action": action, "args": args})
    assert r.status_code == 200, r.text
    return r.json()


async def _run(client, container, human, proposal, transcript):
    """What the app does once the owner confirms: record, send the request as the owner, finish."""
    va = await client.post(_base(container) + "/actions", json={
        "actor_agent_id": human, "idempotency_key": str(uuid.uuid4()), "kind": proposal["item_kind"],
        "item_id": proposal["item_id"], "action": proposal["action"], "transcript": transcript, "text": proposal["text"],
    })
    assert va.status_code == 200, va.text
    vid = va.json()["voice_action_id"]
    req = proposal["request"]
    body = dict(req["body"], **({"via": "voice", "voice_action_id": vid} if proposal["decision"] else {}))
    r = await client.request(req["method"], req["url"], json=body)
    if not proposal["decision"] and r.status_code < 300:
        await client.patch(_base(container) + f"/actions/{vid}",
                           json={"actor_agent_id": human, "status": "done", "result": {"status": r.status_code}})
    return r, vid


@pytest.mark.asyncio
async def test_context_names_the_team_open_work_and_what_needs_you(client, container, db, make_agent, make_task):
    human, dev = await _team(make_agent)
    tid = await _plan(db, make_task, dev)
    other = await make_task("Write release notes", "notes posted")
    r = await client.get(_base(container) + "/context")
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["actor"] == human and d["owner"] == "Owner" and d["cid"] == container["id"]
    assert [a["alias"] for a in d["agents"]] == ["ReleaseEngineer"]
    assert d["agents"][0]["working_on"] == "Fix trip counts"
    need = d["needs_you"][0]
    assert (need["kind"], need["id"], need["ref"], need["from"]) == ("plan", tid, tid[:8], "ReleaseEngineer")
    open_ = {t["title"]: t for t in d["open_tasks"]}
    assert open_["Write release notes"]["href"] == f"/tasks?task={other['id']}"
    assert d["recently_done"] == [] and d["watched"] == []
    r = await client.get(_base(container) + "/context", params={"watch": f"{tid},not-an-id"})
    assert [(w["id"], w["status"], w["assignee"]) for w in r.json()["watched"]] == [(tid, "in_progress", "ReleaseEngineer")]
    assert need["task_id"] == tid


@pytest.mark.asyncio
async def test_context_refuses_a_non_human_actor(client, container, make_agent):
    _, dev = await _team(make_agent)
    r = await client.get(_base(container) + "/context", params={"actor_agent_id": dev})
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_approve_a_plan_by_ref(client, container, db, make_agent, make_task):
    human, dev = await _team(make_agent)
    tid = await _plan(db, make_task, dev)
    d = await _propose(client, container, human, "approve_plan", {"task": tid[:8]})
    p = d["proposal"]
    assert p["read_back"] == "Approving ReleaseEngineer's plan." and p["decision"] and p["sensitive"] == []
    assert p["request"]["url"] == "/api/decisions"
    r, vid = await _run(client, container, human, p, "approve the trip counts plan")
    assert r.status_code == 201, r.text
    assert db.execute("SELECT status FROM voice_actions WHERE id=%s", (vid,))[0]["status"] == "done"


@pytest.mark.asyncio
async def test_creates_a_filled_in_task(client, container, db, make_agent):
    human, _ = await _team(make_agent)
    d = await _propose(client, container, human, "create_task", {
        "title": "Fix trip counts", "definition_of_done": "The October dashboard matches the sheet",
        "description": "Ledger's dashboard shows 412 trips; the sheet has 398.", "assignee": "release engineer"})
    p = d["proposal"]
    assert p["read_back"] == "Creating “Fix trip counts” for ReleaseEngineer, done when the October dashboard matches the sheet."
    r, vid = await _run(client, container, human, p, "make a task for release engineer…")
    assert r.status_code == 201, r.text
    row = db.execute("SELECT description, definition_of_done, created_by_agent_id FROM tasks WHERE title='Fix trip counts'")[0]
    assert row["description"] == "Ledger's dashboard shows 412 trips; the sheet has 398."
    assert str(row["created_by_agent_id"]) == human
    va = db.execute("SELECT item_kind, item_id, action, status FROM voice_actions WHERE id=%s", (vid,))[0]
    assert (va["item_kind"], va["item_id"], va["action"], va["status"]) == ("task", None, "create_task", "done")


@pytest.mark.asyncio
async def test_missing_details_become_a_question(client, container, make_agent):
    human, _ = await _team(make_agent)
    assert (await _propose(client, container, human, "create_task", {"title": "Fix trip counts"})) == {"say": "How will we know it's done?"}
    assert (await _propose(client, container, human, "assign_task", {"task": "deadbeef", "assignee": "Nobody"})) == {
        "say": "I couldn't tell which task you mean."}
    assert (await _propose(client, container, human, "deploy", {})) == {"say": "I can't do that by voice yet."}


@pytest.mark.asyncio
async def test_assign_and_message_by_ref(client, container, db, make_agent, make_task):
    human, dev = await _team(make_agent)
    t = await make_task("Write release notes", "notes posted")
    ref = str(t["id"])[:8]
    p = (await _propose(client, container, human, "assign_task", {"task": ref, "assignee": "ReleaseEngineer"}))["proposal"]
    assert p["read_back"] == "Assigning “Write release notes” to ReleaseEngineer."
    r, _ = await _run(client, container, human, p, "...")
    assert r.status_code == 200, r.text
    assert db.execute("SELECT count(*) AS n FROM agent_tasks WHERE task_id=%s AND agent_id=%s", (t["id"], dev))[0]["n"] == 1
    p = (await _propose(client, container, human, "post_message", {"task": ref, "text": "Keep it short."}))["proposal"]
    assert p["read_back"] == "Posting on “Write release notes”: Keep it short."
    r, _ = await _run(client, container, human, p, "...")
    assert r.status_code == 201, r.text


@pytest.mark.asyncio
async def test_message_an_agent_in_its_own_chat(client, container, db, make_agent):
    human, dev = await _team(make_agent)
    ctx = (await client.get(_base(container) + "/context")).json()
    assert ctx["agents"][0]["id"] == dev
    assert (await _propose(client, container, human, "message_agent", {"agent": "nobody", "text": "hi"}))["say"]
    assert (await _propose(client, container, human, "message_agent", {"agent": "ReleaseEngineer"}))["say"] == "What should the message say?"
    p = (await _propose(client, container, human, "message_agent", {"agent": "@releaseengineer", "text": "How is the build going?"}))["proposal"]
    assert (p["item_kind"], p["item_id"], p["title"]) == ("agent", dev, "ReleaseEngineer")
    assert p["read_back"] == "Sending ReleaseEngineer a chat message: “How is the build going?”"
    # what the app does on confirm: open the agent's chat, then post the text as the owner
    req = p["request"]
    r = await client.request(req["method"], req["url"], json=req["body"])
    assert r.status_code in (200, 201), r.text
    conv = r.json().get("conversation") or r.json()
    r = await client.post(f"/api/conversations/{conv['id']}/turns",
                          json={"role": "human", "author_agent_id": human, "content": p["text"]})
    assert r.status_code == 201, r.text
    rows = db.execute("SELECT role, content FROM conversation_turns WHERE conversation_id=%s", (conv["id"],))
    assert [(t["role"], t["content"]) for t in rows] == [("human", "How is the build going?")]


@pytest.mark.asyncio
async def test_risky_decisions_carry_their_sensitive_words(client, container, db, make_agent, make_task):
    human, dev = await _team(make_agent)
    tid = await _plan(db, make_task, dev, body="Plan: merge PR 12 and deploy to production.")
    p = (await _propose(client, container, human, "approve_plan", {"task": tid[:8]}))["proposal"]
    assert {"merge", "deploy", "production"} <= set(p["sensitive"])
