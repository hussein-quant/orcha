"""Slack trigger seam (Feature B) — signature verification, command parsing, the
unlinked-user path, start-via-Slack producing an identical task to a hub start (shared
internals), and outbound needs_verification emission gated on a configured webhook.

Nothing external is hit: the Slack signature is computed locally with the test secret,
and the outbound webhook POST leaf (slack_notify._post_webhook) is monkeypatched — no
network. The routes, signature check, member mapping, and task-creation internals run
for real.
"""
import hashlib
import hmac
import time
import urllib.parse

import pytest

from portal_backend import slack_notify, slack_routes

SIGNING_SECRET = "shhh-test-secret"
BOT_TOKEN = "xoxb-test"


@pytest.fixture
def slack_enabled(monkeypatch):
    monkeypatch.setenv("SLACK_SIGNING_SECRET", SIGNING_SECRET)
    monkeypatch.setenv("SLACK_BOT_TOKEN", BOT_TOKEN)


def _sign(body: str, ts=None):
    """Return (headers, raw_body) with a valid v0 signature for `body`."""
    ts = str(int(time.time())) if ts is None else str(ts)
    base = f"v0:{ts}:{body}".encode()
    digest = hmac.new(SIGNING_SECRET.encode(), base, hashlib.sha256).hexdigest()
    return {
        "X-Slack-Request-Timestamp": ts,
        "X-Slack-Signature": "v0=" + digest,
        "Content-Type": "application/x-www-form-urlencoded",
    }, body


def _form(**fields) -> str:
    return urllib.parse.urlencode(fields)


async def _link_slack_member(client, container, make_agent, db, slack_user_id, alias="ops"):
    """Create a live human member and link their Slack user id (mig 044)."""
    agent = await make_agent(alias, kind="human")
    db.execute("UPDATE agents SET slack_user_id=%s WHERE id=%s",
               (slack_user_id, agent["agent_id"]))
    return agent["agent_id"]


# ------------------------- feature flag -------------------------

async def test_disabled_without_secrets_503(client, monkeypatch):
    monkeypatch.delenv("SLACK_SIGNING_SECRET", raising=False)
    monkeypatch.delenv("SLACK_BOT_TOKEN", raising=False)
    r = await client.post("/api/slack/commands", content="text=tasks")
    assert r.status_code == 503


async def test_disabled_with_only_one_secret(client, monkeypatch):
    monkeypatch.setenv("SLACK_SIGNING_SECRET", SIGNING_SECRET)
    monkeypatch.delenv("SLACK_BOT_TOKEN", raising=False)
    r = await client.post("/api/slack/commands", content="text=tasks")
    assert r.status_code == 503


# ------------------------- signature verification -------------------------

async def test_bad_signature_401(client, slack_enabled):
    headers, body = _sign(_form(user_id="U1", text="tasks"))
    headers["X-Slack-Signature"] = "v0=deadbeef"
    r = await client.post("/api/slack/commands", content=body, headers=headers)
    assert r.status_code == 401


async def test_missing_signature_401(client, slack_enabled):
    body = _form(user_id="U1", text="tasks")
    r = await client.post(
        "/api/slack/commands", content=body,
        headers={"Content-Type": "application/x-www-form-urlencoded"})
    assert r.status_code == 401


async def test_stale_timestamp_401(client, slack_enabled):
    # 10 minutes old → outside the ±300s replay window.
    headers, body = _sign(_form(user_id="U1", text="tasks"),
                          ts=int(time.time()) - 600)
    r = await client.post("/api/slack/commands", content=body, headers=headers)
    assert r.status_code == 401


async def test_verify_signature_unit_good_bad_stale():
    ts = str(int(time.time()))
    body = b"v0:x"
    good_base = b"v0:" + ts.encode() + b":" + body
    good_sig = "v0=" + hmac.new(SIGNING_SECRET.encode(), good_base,
                                hashlib.sha256).hexdigest()
    import os
    os.environ["SLACK_SIGNING_SECRET"] = SIGNING_SECRET
    try:
        assert slack_routes.verify_slack_signature(body, ts, good_sig) is True
        assert slack_routes.verify_slack_signature(body, ts, "v0=nope") is False
        stale = str(int(time.time()) - 999)
        stale_base = b"v0:" + stale.encode() + b":" + body
        stale_sig = "v0=" + hmac.new(SIGNING_SECRET.encode(), stale_base,
                                     hashlib.sha256).hexdigest()
        assert slack_routes.verify_slack_signature(body, stale, stale_sig) is False
    finally:
        del os.environ["SLACK_SIGNING_SECRET"]


# ------------------------- unlinked user -------------------------

async def test_unlinked_user_gets_ephemeral_link_prompt(client, slack_enabled):
    headers, body = _sign(_form(user_id="U-unknown", text="tasks"))
    r = await client.post("/api/slack/commands", content=body, headers=headers)
    assert r.status_code == 200, r.text
    j = r.json()
    assert j["response_type"] == "ephemeral"
    assert "link your Slack" in j["text"] or "link" in j["text"].lower()


# ------------------------- command parsing / start -------------------------

async def test_start_issue_via_slack(client, container, make_agent, db, slack_enabled):
    await _link_slack_member(client, container, make_agent, db, "U-linked")
    headers, body = _sign(_form(user_id="U-linked", text="start issue 42"))
    r = await client.post("/api/slack/commands", content=body, headers=headers)
    assert r.status_code == 200, r.text
    assert r.json()["response_type"] == "ephemeral"
    # A task GH #42 now exists in that member's container.
    listed = (await client.get(f"/api/containers/{container['id']}/tasks")).json()["tasks"]
    assert any(t["title"].startswith("GH #42:") for t in listed)


async def test_start_pr_via_slack(client, container, make_agent, db, slack_enabled):
    await _link_slack_member(client, container, make_agent, db, "U-linked")
    headers, body = _sign(_form(user_id="U-linked", text="start pr 9"))
    r = await client.post("/api/slack/commands", content=body, headers=headers)
    assert r.status_code == 200, r.text
    listed = (await client.get(f"/api/containers/{container['id']}/tasks")).json()["tasks"]
    t = [x for x in listed if x["title"].startswith("GH #9:")][0]
    assert "Resolve CI failures / review feedback on PR #9" in t["definition_of_done"]


async def test_slack_start_idempotent(client, container, make_agent, db, slack_enabled):
    await _link_slack_member(client, container, make_agent, db, "U-linked")
    for _ in range(2):
        headers, body = _sign(_form(user_id="U-linked", text="start issue 7"))
        r = await client.post("/api/slack/commands", content=body, headers=headers)
        assert r.status_code == 200
    listed = (await client.get(f"/api/containers/{container['id']}/tasks")).json()["tasks"]
    assert sum(1 for t in listed if t["title"].startswith("GH #7:")) == 1


async def test_slack_start_identical_to_hub_start(client, container, make_agent, db, slack_enabled):
    """The shared-internals proof: a Slack `start issue N` and the hub's POST /github/start
    for the same N produce a task with the SAME title + definition_of_done template. (Run
    against different numbers so idempotency doesn't merge them.)"""
    await _link_slack_member(client, container, make_agent, db, "U-linked")
    cid = container["id"]
    # hub start (#100)
    hub_r = await client.post(f"/api/containers/{cid}/github/start",
                              json={"kind": "issue", "number": 100})
    # slack start (#101)
    headers, body = _sign(_form(user_id="U-linked", text="start issue 101"))
    await client.post("/api/slack/commands", content=body, headers=headers)

    listed = (await client.get(f"/api/containers/{cid}/tasks")).json()["tasks"]
    hub_t = [t for t in listed if t["title"].startswith("GH #100:")][0]
    slk_t = [t for t in listed if t["title"].startswith("GH #101:")][0]
    # Same DoD TEMPLATE (differing only in the number).
    assert hub_t["definition_of_done"].replace("100", "N") == \
           slk_t["definition_of_done"].replace("101", "N")


async def test_tasks_summary(client, container, make_agent, make_task, db, slack_enabled):
    await _link_slack_member(client, container, make_agent, db, "U-linked")
    t = await make_task("ship", "shipped")
    db.execute("UPDATE tasks SET status='needs_verification' WHERE id=%s", (t["id"],))
    headers, body = _sign(_form(user_id="U-linked", text="tasks"))
    r = await client.post("/api/slack/commands", content=body, headers=headers)
    assert r.status_code == 200
    assert "awaiting your verification" in r.json()["text"]


async def test_unknown_command_help(client, container, make_agent, db, slack_enabled):
    await _link_slack_member(client, container, make_agent, db, "U-linked")
    headers, body = _sign(_form(user_id="U-linked", text="frobnicate"))
    r = await client.post("/api/slack/commands", content=body, headers=headers)
    assert r.status_code == 200
    assert "Unknown command" in r.json()["text"]


# ------------------------- outbound on needs_verification -------------------------

async def _drive_task_to_needs_verification(client, container, make_agent, work_headers):
    """Create + assign + start + mark done a task so it parks at needs_verification
    (plan autonomy default). Returns (cid, tid)."""
    cid = container["id"]
    agent = await make_agent("w1", kind="ai")
    aid = agent["agent_id"]
    # create assigned → in_progress
    r = await client.post(f"/api/containers/{cid}/tasks",
                          json={"title": "do it", "definition_of_done": "done",
                                "assignee_alias": "w1"})
    tid = r.json()["task_id"]
    headers = await work_headers(aid)
    r = await client.post(f"/api/tasks/{tid}/done",
                          json={"agent_id": aid, "result": "ok"}, headers=headers)
    assert r.status_code == 200 and r.json()["status"] == "needs_verification", r.text
    return cid, tid


async def test_outbound_fires_when_webhook_configured(
        client, container, make_agent, work_headers, db, monkeypatch):
    posted = {}

    def fake_post(url, payload):
        posted["url"] = url
        posted["payload"] = payload

    monkeypatch.setattr(slack_notify, "_post_webhook", fake_post)
    cid = container["id"]
    db.execute("UPDATE containers SET slack_webhook_url=%s WHERE id=%s",
               ("https://hooks.slack.com/services/T/B/x", cid))
    _, tid = await _drive_task_to_needs_verification(client, container, make_agent, work_headers)
    assert posted.get("url") == "https://hooks.slack.com/services/T/B/x"
    assert "blocks" in posted["payload"]
    # the Block Kit message references the task and offers verification
    assert "Needs verification" in posted["payload"]["text"]


async def test_outbound_silent_without_webhook(
        client, container, make_agent, work_headers, db, monkeypatch):
    calls = {"n": 0}
    monkeypatch.setattr(slack_notify, "_post_webhook",
                        lambda url, payload: calls.__setitem__("n", calls["n"] + 1))
    # no slack_webhook_url configured → no POST
    await _drive_task_to_needs_verification(client, container, make_agent, work_headers)
    assert calls["n"] == 0


async def test_outbound_failure_never_breaks_transition(
        client, container, make_agent, work_headers, db, monkeypatch):
    def boom(url, payload):
        raise RuntimeError("slack is down")

    monkeypatch.setattr(slack_notify, "_post_webhook", boom)
    cid = container["id"]
    db.execute("UPDATE containers SET slack_webhook_url=%s WHERE id=%s",
               ("https://hooks.slack.com/services/T/B/x", cid))
    # The transition must still succeed (the /done returns needs_verification) despite
    # the webhook POST raising — proven by _drive_task_to_needs_verification's asserts.
    _, tid = await _drive_task_to_needs_verification(client, container, make_agent, work_headers)
    rows = db.execute("SELECT status FROM tasks WHERE id=%s", (tid,))
    assert rows[0]["status"] == "needs_verification"
