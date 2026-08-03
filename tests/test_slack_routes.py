"""Slack trigger seam (Feature B) — signature verification, command parsing, the
unlinked-user path, start-via-Slack producing an identical task to a hub start (shared
internals), Block Kit composer coverage, and outbound needs_verification emission
gated on a configured webhook.

Nothing external is hit: the Slack signature is computed locally with the test secret,
the outbound webhook POST leaf (slack_notify._post_webhook) is monkeypatched, the
GitHub round-trip comment leaf (task_start_core._gh_post_comment) is stubbed
autouse (see test_task_start_core.py for its own dedicated coverage), and the
title-fetch leaf (github_hub_routes._gh_get) is stubbed per-test where the bug-fix
tests need a live-looking issue/PR title — no real network. The routes, signature
check, member mapping, and task-creation internals run for real.
"""
import hashlib
import hmac
import time
import urllib.parse

import pytest

from portal_backend import github_hub_routes as hub
from portal_backend import slack_notify, slack_routes
from portal_backend import task_start_core as core

SIGNING_SECRET = "shhh-test-secret"
BOT_TOKEN = "xoxb-test"


@pytest.fixture
def slack_enabled(monkeypatch):
    monkeypatch.setenv("SLACK_SIGNING_SECRET", SIGNING_SECRET)
    monkeypatch.setenv("SLACK_BOT_TOKEN", BOT_TOKEN)


@pytest.fixture(autouse=True)
def _stub_start_comment(monkeypatch):
    """No test in this file exercises the GitHub round-trip comment itself (that lives
    in test_task_start_core.py) — stub the leaf so a bound repo + working token never
    makes a real network call as a side effect of testing something else."""
    monkeypatch.setattr(core, "_gh_post_comment", lambda repo, number, token, body: None)


@pytest.fixture
def token_env(monkeypatch, tmp_path):
    """Wire a legacy single installation-token file so _resolve_repo_token yields a
    token (the multi-org map is absent). Mirrors test_github_hub_routes.py's fixture —
    needed here so the Slack start path's live title-fetch has a token to resolve."""
    token_file = tmp_path / "github-token"
    token_file.write_text("ghs_slacktoken\n")
    monkeypatch.setenv("ORCHA_GITHUB_TOKEN_FILE", str(token_file))
    monkeypatch.delenv("ORCHA_GITHUB_TOKENS_FILE", raising=False)
    return "ghs_slacktoken"


async def _bind_repo(client, cid, repo="acme/site"):
    r = await client.put(f"/api/containers/{cid}/github", json={"repo": repo})
    assert r.status_code == 200, r.text


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


async def _link_slack_member(client, container, make_agent, db, slack_user_id, alias="ops",
                             container_id=None):
    """Create a live human member and link their Slack user id (mig 044). Defaults to
    the `container` fixture's container; pass `container_id` to link a member into a
    DIFFERENT container (e.g. comparing a hub-started task in one container against a
    Slack-started task in another)."""
    agent = await make_agent(alias, kind="human", container_id=container_id or container["id"])
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
    assert "link" in j["text"].lower()
    # Block Kit body: header + explainer + the "ask an owner" context line.
    header = j["blocks"][0]
    assert header["type"] == "header" and "Link your Slack" in header["text"]["text"]
    joined = " ".join(
        el["text"] for b in j["blocks"] for el in b.get("elements", [b.get("text", {})])
        if el and "text" in el
    )
    assert "ask an owner to link your Slack ID" in joined


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


# ------------------------- title bug: GH #232: #232 (live regression) -------------------------
#
# Production bug: `/orcha start issue 232` created a task titled "GH #232: #232" — the
# Slack path substituted the issue NUMBER where the issue TITLE belongs (slack_routes
# used to hardcode gh_title=f"#{number}" with no GitHub fetch at all). The hub path
# always composed correctly because its FRONTEND already has the real title in hand
# from the issue/PR list it just rendered and passes it straight through
# (github_hub_routes.GithubStartBody). The fix: slack_routes._fetch_gh_item does the
# ONE live GitHub fetch the hub gets for free, before calling the shared
# task_start_core.start_task_from_github — so both paths land on the SAME title.

def _fake_issue_get(number, title):
    def fake_get(path, token):
        assert path == f"/repos/acme/site/issues/{number}"
        return {"number": number, "title": title, "html_url": f"https://github.com/acme/site/issues/{number}",
                "body": "the issue body"}
    return fake_get


def _fake_pull_get(number, title):
    def fake_get(path, token):
        assert path == f"/repos/acme/site/pulls/{number}"
        return {"number": number, "title": title, "html_url": f"https://github.com/acme/site/pulls/{number}",
                "body": "the pr body"}
    return fake_get


async def test_slack_start_issue_uses_real_title_not_number(
        client, container, make_agent, db, slack_enabled, token_env, monkeypatch):
    """The regression test: a slack-started issue task's title carries the real GitHub
    title ('Clinician dashboard: …'), never the bare number-as-title
    ('GH #232: #232') the production bug produced. Revert the _fetch_gh_item wiring
    in slack_routes._handle_command and this goes red."""
    await _bind_repo(client, container["id"])
    monkeypatch.setattr(hub, "_gh_get", _fake_issue_get(232, "Clinician dashboard: add filters"))
    await _link_slack_member(client, container, make_agent, db, "U-linked")
    headers, body = _sign(_form(user_id="U-linked", text="start issue 232"))
    r = await client.post("/api/slack/commands", content=body, headers=headers)
    assert r.status_code == 200, r.text

    listed = (await client.get(f"/api/containers/{container['id']}/tasks")).json()["tasks"]
    t = [x for x in listed if x["title"].startswith("GH #232:")][0]
    assert t["title"] == "GH #232: Clinician dashboard: add filters"
    assert t["title"] != "GH #232: #232"  # the exact production bug shape


async def test_slack_started_title_matches_hub_started_title_same_issue(
        client, container, make_agent, db, slack_enabled, token_env, monkeypatch):
    """Test-teeth for the bug: for the SAME fixture issue, a hub start (which gets the
    title from its request body, as the frontend would supply it) and a Slack start
    (which now live-fetches it) land on the IDENTICAL title. Different container so the
    hub 'client-supplied title' and the Slack 'live-fetched title' are the two ONLY
    sources of truth being compared — both must agree because both ultimately describe
    GH issue #232 in this fixture repo."""
    cid = container["id"]
    await _bind_repo(client, cid)
    real_title = "Clinician dashboard: add filters"
    monkeypatch.setattr(hub, "_gh_get", _fake_issue_get(232, real_title))

    # Hub start: the frontend already fetched the issue list and supplies the title.
    hub_r = await client.post(f"/api/containers/{cid}/github/start",
                              json={"kind": "issue", "number": 232, "title": real_title})
    assert hub_r.status_code == 201, hub_r.text

    # A fresh container for the Slack side so idempotency doesn't merge the two hits
    # on the SAME GH #232 (both would resolve to the same open-task probe otherwise).
    # additional=true is required past the first container (Orcha#28's 1:1:1 stack
    # contract; the portal's own "New project" flow passes this too).
    c2 = await client.post("/api/containers", json={"name": "slack-side", "additional": True})
    assert c2.status_code == 201, c2.text
    cid2 = c2.json()["container_id"]
    await _bind_repo(client, cid2)
    await _link_slack_member(client, container, make_agent, db, "U-linked2", alias="ops2",
                             container_id=cid2)
    headers, body = _sign(_form(user_id="U-linked2", text="start issue 232"))
    slack_r = await client.post("/api/slack/commands", content=body, headers=headers)
    assert slack_r.status_code == 200, slack_r.text

    hub_listed = (await client.get(f"/api/containers/{cid}/tasks")).json()["tasks"]
    slack_listed = (await client.get(f"/api/containers/{cid2}/tasks")).json()["tasks"]
    hub_t = [x for x in hub_listed if x["title"].startswith("GH #232:")][0]
    slack_t = [x for x in slack_listed if x["title"].startswith("GH #232:")][0]
    assert hub_t["title"] == slack_t["title"] == "GH #232: Clinician dashboard: add filters"


async def test_slack_start_pull_uses_real_title(
        client, container, make_agent, db, slack_enabled, token_env, monkeypatch):
    await _bind_repo(client, container["id"])
    monkeypatch.setattr(hub, "_gh_get", _fake_pull_get(55, "Fix retry backoff"))
    await _link_slack_member(client, container, make_agent, db, "U-linked")
    headers, body = _sign(_form(user_id="U-linked", text="start pr 55"))
    r = await client.post("/api/slack/commands", content=body, headers=headers)
    assert r.status_code == 200, r.text
    listed = (await client.get(f"/api/containers/{container['id']}/tasks")).json()["tasks"]
    t = [x for x in listed if x["title"].startswith("GH #55:")][0]
    assert t["title"] == "GH #55: Fix retry backoff"


async def test_slack_started_task_shows_tracked_on_hub_list_without_a_click(
        client, container, make_agent, db, slack_enabled, token_env, monkeypatch):
    """Founder-caught gap, closed: issue #232 started via Slack must show as tracked on
    the hub's OWN list endpoint immediately — not just after a hub click that would
    itself bounce off {existing:true}. Proves the cross-seam link: a Slack start
    populates tracked_task_id on github_hub_routes' list route, which never even ran
    task creation itself — only task_start_core.find_open_gh_tasks did, and both
    seams share that ONE function."""
    cid = container["id"]
    await _bind_repo(client, cid)
    real_title = "Clinician dashboard: add filters"

    def fake_get(path, token):
        # Serves BOTH shapes _gh_get is asked for here: the Slack start's single-item
        # detail fetch, and the hub list's bulk fetch — a real GitHub token would
        # equally answer either path against the same underlying issue.
        if path == "/repos/acme/site/issues/232":
            return {"number": 232, "title": real_title,
                    "html_url": "https://github.com/acme/site/issues/232", "body": ""}
        return [{"number": 232, "title": real_title,
                "html_url": "https://github.com/acme/site/issues/232"}]

    monkeypatch.setattr(hub, "_gh_get", fake_get)
    await _link_slack_member(client, container, make_agent, db, "U-linked")
    headers, body = _sign(_form(user_id="U-linked", text="start issue 232"))
    r = await client.post("/api/slack/commands", content=body, headers=headers)
    assert r.status_code == 200, r.text

    # The hub's OWN issues list — a completely separate route from /orcha start —
    # must already show #232 as tracked, no Start click required.
    list_r = await client.get(f"/api/containers/{cid}/github/issues")
    assert list_r.status_code == 200, list_r.text
    by_number = {it["number"]: it for it in list_r.json()["issues"]}
    assert by_number[232]["tracked_task_id"] is not None

    listed = (await client.get(f"/api/containers/{cid}/tasks")).json()["tasks"]
    t = [x for x in listed if x["title"].startswith("GH #232:")][0]
    assert by_number[232]["tracked_task_id"] == t["id"]


async def test_slack_start_falls_back_to_bare_number_when_github_unreachable(
        client, container, make_agent, db, slack_enabled, token_env, monkeypatch):
    """The live fetch failing (rate-limited / 404 / network) must never break the
    3s-contract slash command — it degrades to the old '#N' placeholder title rather
    than erroring the whole dispatch."""
    await _bind_repo(client, container["id"])

    def boom(path, token):
        raise RuntimeError("github_status:403")

    monkeypatch.setattr(hub, "_gh_get", boom)
    await _link_slack_member(client, container, make_agent, db, "U-linked")
    headers, body = _sign(_form(user_id="U-linked", text="start issue 909"))
    r = await client.post("/api/slack/commands", content=body, headers=headers)
    assert r.status_code == 200, r.text
    listed = (await client.get(f"/api/containers/{container['id']}/tasks")).json()["tasks"]
    t = [x for x in listed if x["title"].startswith("GH #909:")][0]
    assert t["title"] == "GH #909: #909"  # degraded fallback, not a failure


async def test_slack_start_without_bound_repo_falls_back_to_bare_number(
        client, container, make_agent, db, slack_enabled):
    """No repo bound at all (the common case pre-GitHub-hub-setup) — same graceful
    fallback, no crash, no GitHub call attempted."""
    await _link_slack_member(client, container, make_agent, db, "U-linked")
    headers, body = _sign(_form(user_id="U-linked", text="start issue 5"))
    r = await client.post("/api/slack/commands", content=body, headers=headers)
    assert r.status_code == 200, r.text
    listed = (await client.get(f"/api/containers/{container['id']}/tasks")).json()["tasks"]
    t = [x for x in listed if x["title"].startswith("GH #5:")][0]
    assert t["title"] == "GH #5: #5"


# ------------------------- Block Kit: start success / already tracked -------------------------

async def test_slack_start_success_block_shape(
        client, container, make_agent, db, slack_enabled, token_env, monkeypatch):
    await _bind_repo(client, container["id"])
    monkeypatch.setattr(hub, "_gh_get", _fake_issue_get(232, "Clinician dashboard"))
    monkeypatch.setenv("ORCHA_PORTAL_BASE_URL", "https://app.example.com")
    await _link_slack_member(client, container, make_agent, db, "U-linked")
    headers, body = _sign(_form(user_id="U-linked", text="start issue 232"))
    r = await client.post("/api/slack/commands", content=body, headers=headers)
    j = r.json()
    blocks = j["blocks"]
    assert blocks[0]["type"] == "header"
    assert blocks[0]["text"]["text"] == "🚀 Task started"
    section_text = blocks[1]["text"]["text"]
    assert "<https://github.com/acme/site/issues/232|#232 Clinician dashboard>" in section_text
    ctx_text = blocks[2]["elements"][0]["text"]
    assert "assigned: Atlas routes it" in ctx_text
    assert "a human verifies before anything merges" in ctx_text
    button = blocks[3]["elements"][0]
    assert button["text"]["text"] == "Open task in Orcha"
    assert button["url"].startswith("https://app.example.com/tasks?cid=")
    assert "task=" in button["url"]


async def test_slack_already_tracked_block_shape(
        client, container, make_agent, db, slack_enabled, token_env, monkeypatch):
    await _bind_repo(client, container["id"])
    monkeypatch.setattr(hub, "_gh_get", _fake_issue_get(70, "dup"))
    monkeypatch.setenv("ORCHA_PORTAL_BASE_URL", "https://app.example.com")
    await _link_slack_member(client, container, make_agent, db, "U-linked")
    for _ in range(2):
        headers, body = _sign(_form(user_id="U-linked", text="start issue 70"))
        r = await client.post("/api/slack/commands", content=body, headers=headers)
    j = r.json()
    assert j["blocks"][0]["text"]["text"] == "↩️ Already tracked"
    assert "already has an open Orcha task" in j["blocks"][1]["text"]["text"]
    button = j["blocks"][2]["elements"][0]
    assert button["text"]["text"] == "Open task in Orcha"


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
    j = r.json()
    assert j["blocks"][0]["text"]["text"] == "🔔 Needs you"
    body_text = j["blocks"][1]["text"]["text"]
    assert "To verify (1)" in body_text
    assert "ship" in body_text


async def test_tasks_summary_zero_state_matches_portal_phrasing(
        client, container, make_agent, db, slack_enabled):
    """Nothing needs attention → the exact phrasing home-state.js's own zero-state
    uses ('✓ Nothing needs you right now.') so the copy matches across surfaces."""
    await _link_slack_member(client, container, make_agent, db, "U-linked")
    headers, body = _sign(_form(user_id="U-linked", text="tasks"))
    r = await client.post("/api/slack/commands", content=body, headers=headers)
    assert r.status_code == 200
    j = r.json()
    assert j["blocks"][1]["text"]["text"] == "✓ Nothing needs you right now."


async def test_unknown_command_help(client, container, make_agent, db, slack_enabled):
    await _link_slack_member(client, container, make_agent, db, "U-linked")
    headers, body = _sign(_form(user_id="U-linked", text="frobnicate"))
    r = await client.post("/api/slack/commands", content=body, headers=headers)
    assert r.status_code == 200
    j = r.json()
    body_text = j["blocks"][1]["text"]["text"]
    assert "/orcha start issue <N>" in body_text
    assert "/orcha start pr <N>" in body_text
    assert "/orcha tasks" in body_text


# ------------------------- Block Kit composers: pure-function unit tests -------------------------
#
# Every composer in slack_notify.py is a pure function (data in -> block array out) —
# these tests assert the JSON structure directly, no client/DB/network involved.

def test_mrkdwn_escape_angle_brackets_and_ampersand():
    """A title containing <, >, & must not corrupt Slack's mrkdwn link/mention syntax."""
    raw = "Fix <script> handling & the > operator"
    escaped = slack_notify._mrkdwn_escape(raw)
    assert escaped == "Fix &lt;script&gt; handling &amp; the &gt; operator"
    assert "<" not in escaped and ">" not in escaped
    # & must be escaped FIRST (Slack's documented order) or a literal '&amp;' would
    # itself get re-escaped into '&amp;amp;' — assert the escape ran exactly once.
    assert "&amp;amp;" not in escaped


def test_mrkdwn_link_escapes_visible_text_not_url():
    link = slack_notify._mrkdwn_link("https://x.test/1", "Fix <a> & <b>")
    assert link == "<https://x.test/1|Fix &lt;a&gt; &amp; &lt;b&gt;>"


def test_blocks_start_success_structure():
    blocks = slack_notify.blocks_start_success(
        "issue", 232, "https://github.com/acme/site/issues/232",
        "Clinician dashboard", "https://app.example.com/tasks?cid=c1&task=t1",
    )
    assert blocks[0] == {"type": "header",
                         "text": {"type": "plain_text", "text": "🚀 Task started"}}
    assert blocks[1]["type"] == "section"
    assert blocks[1]["text"]["type"] == "mrkdwn"
    assert "<https://github.com/acme/site/issues/232|#232 Clinician dashboard>" \
        in blocks[1]["text"]["text"]
    assert blocks[2]["type"] == "context"
    ctx = blocks[2]["elements"][0]["text"]
    assert "assigned: Atlas routes it" in ctx and "a human verifies before anything merges" in ctx
    assert blocks[3]["type"] == "actions"
    button = blocks[3]["elements"][0]
    assert button["type"] == "button"
    assert button["text"]["text"] == "Open task in Orcha"
    assert button["url"] == "https://app.example.com/tasks?cid=c1&task=t1"


def test_blocks_start_success_escapes_title_with_angle_brackets():
    blocks = slack_notify.blocks_start_success(
        "issue", 1, "https://github.com/acme/site/issues/1",
        "Handle <input> & fix", None,
    )
    assert "&lt;input&gt;" in blocks[1]["text"]["text"]
    assert "<input>" not in blocks[1]["text"]["text"]


def test_blocks_start_success_no_link_omits_button_and_falls_back_to_plain_text():
    blocks = slack_notify.blocks_start_success("issue", 909, "", "#909", None)
    assert not any(b["type"] == "actions" for b in blocks)
    assert "#909" in blocks[1]["text"]["text"]
    assert "<" not in blocks[1]["text"]["text"] or "|" not in blocks[1]["text"]["text"]


def test_blocks_already_tracked_structure():
    blocks = slack_notify.blocks_already_tracked("PR", 9, "https://app.example.com/tasks?cid=c&task=t")
    assert blocks[0]["text"]["text"] == "↩️ Already tracked"
    assert "PR #9" in blocks[1]["text"]["text"]
    assert blocks[2]["elements"][0]["url"] == "https://app.example.com/tasks?cid=c&task=t"


def test_blocks_unlinked_user_structure():
    blocks = slack_notify.blocks_unlinked_user()
    assert blocks[0]["text"]["text"] == "🔗 Link your Slack account"
    assert blocks[-1]["type"] == "context"
    assert "ask an owner to link your Slack ID" in blocks[-1]["elements"][0]["text"]


def test_blocks_usage_help_lists_three_commands():
    blocks = slack_notify.blocks_usage_help()
    text = blocks[1]["text"]["text"]
    assert "/orcha start issue <N>" in text
    assert "/orcha start pr <N>" in text
    assert "/orcha tasks" in text


def test_blocks_tasks_summary_zero_state():
    blocks = slack_notify.blocks_tasks_summary([], 0, 0, lambda tid: None)
    assert blocks[0]["text"]["text"] == "🔔 Needs you"
    assert blocks[1]["text"]["text"] == "✓ Nothing needs you right now."


def test_blocks_tasks_summary_lists_up_to_five_links_and_counts():
    tasks = [{"id": f"t{i}", "title": f"task {i}"} for i in range(7)]
    blocks = slack_notify.blocks_tasks_summary(
        tasks, open_requests_count=3, ready_unassigned_count=2,
        task_link_fn=lambda tid: f"https://app.example.com/tasks?task={tid}",
    )
    body = blocks[1]["text"]["text"]
    assert "To verify (7)" in body   # the COUNT reflects the full set…
    for i in range(5):
        assert f"<https://app.example.com/tasks?task=t{i}|task {i}>" in body
    for i in range(5, 7):
        assert f"task {i}" not in body   # …but only the first 5 are LINKED/listed
    ctx = blocks[2]["elements"][0]["text"]
    assert "Open requests (3)" in ctx
    assert "Ready · unassigned (2)" in ctx


def test_blocks_tasks_summary_escapes_titles_with_angle_brackets():
    blocks = slack_notify.blocks_tasks_summary(
        [{"id": "t1", "title": "Fix <script> & tags"}], 0, 0,
        lambda tid: "https://app.example.com/tasks?task=t1",
    )
    body = blocks[1]["text"]["text"]
    assert "&lt;script&gt;" in body
    assert "<script>" not in body


def test_blocks_needs_verification_structure():
    blocks = slack_notify.blocks_needs_verification(
        "Acme", "Ship the thing", "https://app.example.com/tasks?cid=c&task=t",
        project_name="Acme", agent_alias="atlas",
    )
    assert blocks[0] == {"type": "header",
                         "text": {"type": "plain_text", "text": "🛡️ Needs your verification"}}
    assert "<https://app.example.com/tasks?cid=c&task=t|Ship the thing>" in blocks[1]["text"]["text"]
    ctx = blocks[2]["elements"][0]["text"]
    assert "Acme" in ctx and "atlas" in ctx
    button = blocks[3]["elements"][0]
    assert button["text"]["text"] == "Verify in Orcha"
    assert button["style"] == "primary"
    assert button["url"] == "https://app.example.com/tasks?cid=c&task=t"
    # ONE message: header + section + context + one actions block, nothing more.
    assert len(blocks) == 4


def test_blocks_needs_verification_escapes_title():
    blocks = slack_notify.blocks_needs_verification(
        "Acme", "Fix <b>bold</b> & such", None,
    )
    assert "&lt;b&gt;" in blocks[1]["text"]["text"]
    assert "<b>" not in blocks[1]["text"]["text"]


def test_portal_task_link_uses_extensionless_tasks_route_not_tasks_html():
    """Regression: the portal serves the extensionless /tasks route
    (dashboard_routes.tasks_page) — static files are mounted at /assets, not the site
    root, so a literal '/tasks.html' path 404s. A Slack button pointing at it would be
    dead on arrival."""
    import os
    old = os.environ.get(slack_notify.PORTAL_BASE_URL_ENV)
    os.environ[slack_notify.PORTAL_BASE_URL_ENV] = "https://app.example.com"
    try:
        link = slack_notify.portal_task_link("c1", "t1")
    finally:
        if old is None:
            os.environ.pop(slack_notify.PORTAL_BASE_URL_ENV, None)
        else:
            os.environ[slack_notify.PORTAL_BASE_URL_ENV] = old
    assert link == "https://app.example.com/tasks?cid=c1&task=t1"
    assert ".html" not in link


def test_portal_task_link_none_without_base_url(monkeypatch):
    monkeypatch.delenv(slack_notify.PORTAL_BASE_URL_ENV, raising=False)
    assert slack_notify.portal_task_link("c1", "t1") is None


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
    monkeypatch.setenv("ORCHA_PORTAL_BASE_URL", "https://app.example.com")
    cid = container["id"]
    db.execute("UPDATE containers SET slack_webhook_url=%s WHERE id=%s",
               ("https://hooks.slack.com/services/T/B/x", cid))
    _, tid = await _drive_task_to_needs_verification(client, container, make_agent, work_headers)
    assert posted.get("url") == "https://hooks.slack.com/services/T/B/x"
    assert "blocks" in posted["payload"]
    # the Block Kit message references the task and offers verification
    assert "Needs verification" in posted["payload"]["text"]
    blocks = posted["payload"]["blocks"]
    assert blocks[0]["text"]["text"] == "🛡️ Needs your verification"
    # the working agent's alias ("w1", from _drive_task_to_needs_verification) rides
    # the muted context line alongside the project name.
    ctx = blocks[2]["elements"][0]["text"]
    assert "w1" in ctx
    assert blocks[-1]["elements"][0]["text"]["text"] == "Verify in Orcha"


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
