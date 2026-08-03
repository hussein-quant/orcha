"""task_start_core — the shared GitHub-start internals both the hub and Slack seams
call. This file's focus: the GitHub round-trip comment ("🤖 Orcha started task ...")
that fires once per FRESH start, from the ONE shared function, regardless of caller.

Per the test-teeth convention, only the network leaf (`task_start_core._gh_post_comment`)
is stubbed — repo binding, token resolution, task creation, and the fresh-vs-existing
branch all run for real through the actual `POST /github/start` route.
"""
import pytest

from portal_backend import github_hub_routes as hub
from portal_backend import task_start_core as core


@pytest.fixture
def token_env(monkeypatch, tmp_path):
    token_file = tmp_path / "github-token"
    token_file.write_text("ghs_starttoken\n")
    monkeypatch.setenv("ORCHA_GITHUB_TOKEN_FILE", str(token_file))
    monkeypatch.delenv("ORCHA_GITHUB_TOKENS_FILE", raising=False)
    return "ghs_starttoken"


async def _bind_repo(client, cid, repo="acme/site"):
    r = await client.put(f"/api/containers/{cid}/github", json={"repo": repo})
    assert r.status_code == 200, r.text


def _capture_comment(monkeypatch):
    calls = []

    def fake_post(repo, number, token, body):
        calls.append({"repo": repo, "number": number, "token": token, "body": body})

    monkeypatch.setattr(core, "_gh_post_comment", fake_post)
    return calls


# ------------------------- composition -------------------------

def test_compose_start_comment_assigned():
    text = core._compose_start_comment("abcdef1234567890", "atlas")
    assert text.startswith("🤖 Orcha started task `abcdef12` for this")
    assert "assigned to **atlas**" in text
    assert "Work arrives as a PR; a human verifies before anything merges." in text


def test_compose_start_comment_unassigned():
    text = core._compose_start_comment("abcdef1234567890", None)
    assert "unassigned — the orchestrator routes it" in text
    assert "assigned to **" not in text


# ------------------------- fresh start: posts the comment -------------------------

async def test_comment_posted_on_fresh_issue_start(
        client, container, token_env, monkeypatch):
    cid = container["id"]
    await _bind_repo(client, cid)
    calls = _capture_comment(monkeypatch)

    r = await client.post(f"/api/containers/{cid}/github/start",
                          json={"kind": "issue", "number": 232, "title": "Clinician dashboard"})
    assert r.status_code == 201, r.text
    tid = r.json()["task_id"]

    assert len(calls) == 1
    c = calls[0]
    assert c["repo"] == "acme/site"
    assert c["number"] == 232
    assert c["token"] == "ghs_starttoken"
    assert c["body"].startswith(f"🤖 Orcha started task `{tid[:8]}` for this")
    assert "unassigned — the orchestrator routes it" in c["body"]
    assert "Work arrives as a PR; a human verifies before anything merges." in c["body"]


async def test_comment_posted_on_fresh_pull_start(
        client, container, token_env, monkeypatch):
    cid = container["id"]
    await _bind_repo(client, cid)
    calls = _capture_comment(monkeypatch)

    r = await client.post(f"/api/containers/{cid}/github/start",
                          json={"kind": "pull", "number": 55, "title": "Fix retry"})
    assert r.status_code == 201, r.text

    assert len(calls) == 1
    assert calls[0]["number"] == 55
    # PR comments ride the SAME issues/{number}/comments endpoint — task_start_core
    # never branches on kind for the comment call itself.


async def test_comment_names_the_assignee(
        client, container, make_agent, token_env, monkeypatch):
    cid = container["id"]
    await _bind_repo(client, cid)
    agent = await make_agent("worker-1", kind="ai")
    aid = agent["agent_id"]
    calls = _capture_comment(monkeypatch)

    r = await client.post(f"/api/containers/{cid}/github/start",
                          json={"kind": "issue", "number": 8, "title": "assign me",
                                "assignee_agent_id": aid})
    assert r.status_code == 201, r.text

    assert len(calls) == 1
    assert "assigned to **worker-1**" in calls[0]["body"]


# ------------------------- existing=True: never comments -------------------------

async def test_comment_skipped_on_existing_task(
        client, container, token_env, monkeypatch):
    """A double-click / retry that hits the idempotency short-circuit must NOT post a
    second comment — only the FRESH creation gets the round-trip comment."""
    cid = container["id"]
    await _bind_repo(client, cid)
    calls = _capture_comment(monkeypatch)

    r1 = await client.post(f"/api/containers/{cid}/github/start",
                           json={"kind": "issue", "number": 12, "title": "first"})
    assert r1.status_code == 201 and r1.json()["existing"] is False
    r2 = await client.post(f"/api/containers/{cid}/github/start",
                           json={"kind": "issue", "number": 12, "title": "first"})
    assert r2.status_code == 201 and r2.json()["existing"] is True

    assert len(calls) == 1  # only the fresh start commented, not the re-click


# ------------------------- non-fatal by construction -------------------------

async def test_comment_failure_never_breaks_task_creation(
        client, container, token_env, monkeypatch):
    def boom(repo, number, token, body):
        raise RuntimeError("github_status:403 (Issues:write not granted)")

    monkeypatch.setattr(core, "_gh_post_comment", boom)
    cid = container["id"]
    await _bind_repo(client, cid)

    r = await client.post(f"/api/containers/{cid}/github/start",
                          json={"kind": "issue", "number": 900, "title": "still works"})
    assert r.status_code == 201, r.text
    assert r.json()["existing"] is False
    listed = (await client.get(f"/api/containers/{cid}/tasks")).json()["tasks"]
    assert any(t["title"] == "GH #900: still works" for t in listed)


async def test_no_comment_attempted_without_bound_repo(client, container, monkeypatch):
    """No repo bound at all — the common pre-GitHub-hub-setup case. No comment attempt,
    no crash; task creation proceeds exactly as before this feature existed."""
    calls = _capture_comment(monkeypatch)
    cid = container["id"]
    r = await client.post(f"/api/containers/{cid}/github/start",
                          json={"kind": "issue", "number": 3, "title": "no repo bound"})
    assert r.status_code == 201, r.text
    assert calls == []


async def test_no_comment_attempted_without_token(client, container, monkeypatch):
    """Repo bound but no installation token resolvable (App not wired here) — same
    graceful no-op; matches slack_notify's "cheapest gate first" contract."""
    calls = _capture_comment(monkeypatch)
    cid = container["id"]
    await _bind_repo(client, cid)
    r = await client.post(f"/api/containers/{cid}/github/start",
                          json={"kind": "issue", "number": 4, "title": "no token"})
    assert r.status_code == 201, r.text
    assert calls == []


# ------------------------- shared internals: both dispatch paths -------------------------

async def test_comment_fires_once_from_shared_core_regardless_of_caller(
        client, container, make_agent, db, token_env, monkeypatch):
    """The comment is posted from task_start_core itself (not duplicated per-caller) —
    a Slack-triggered start goes through the exact same start_task_from_github call the
    hub uses, so it gets exactly one comment too, never two."""
    import hashlib
    import hmac
    import time
    import urllib.parse

    cid = container["id"]
    await _bind_repo(client, cid)
    monkeypatch.setattr(hub, "_gh_get", lambda p, t: {
        "number": 300, "title": "from slack", "html_url": "https://github.com/acme/site/issues/300",
        "body": "",
    })
    calls = _capture_comment(monkeypatch)

    agent = await make_agent("ops", kind="human")
    db.execute("UPDATE agents SET slack_user_id=%s WHERE id=%s",
               ("U-1", agent["agent_id"]))

    secret = "shhh"
    monkeypatch.setenv("SLACK_SIGNING_SECRET", secret)
    monkeypatch.setenv("SLACK_BOT_TOKEN", "xoxb-1")
    text_body = urllib.parse.urlencode({"user_id": "U-1", "text": "start issue 300"})
    ts = str(int(time.time()))
    base = f"v0:{ts}:{text_body}".encode()
    sig = "v0=" + hmac.new(secret.encode(), base, hashlib.sha256).hexdigest()
    r = await client.post(
        "/api/slack/commands", content=text_body,
        headers={"X-Slack-Request-Timestamp": ts, "X-Slack-Signature": sig,
                "Content-Type": "application/x-www-form-urlencoded"},
    )
    assert r.status_code == 200, r.text

    assert len(calls) == 1
    assert calls[0]["number"] == 300


# ------------------------- find_open_gh_task(s): shared-helper mutation pin ----------
#
# github_hub_routes' list/detail endpoints (tracked_task_id) and
# start_task_from_github's idempotency check must use the IDENTICAL "which task is
# this GH number already tracked by" rule, or a hub page could show an item as
# untracked while a click on Start immediately bounces off {existing:true} (or the
# reverse: a stale tracked chip pointing at a task the idempotency check would no
# longer honor). find_open_gh_task is implemented as literally
# find_open_gh_tasks(...).get(number) — these tests pin that relationship so a future
# edit that reintroduces a SEPARATE single-number code path (drift risk) goes red.

async def test_find_open_gh_task_and_batched_form_agree_for_open_task(client, container):
    from portal_backend.database import db_cursor

    cid = container["id"]
    r = await client.post(f"/api/containers/{cid}/tasks", json={
        "title": "GH #42: seed", "description": "", "definition_of_done": "x",
    })
    tid = r.json()["task_id"]

    with db_cursor() as (_, cur):
        single = core.find_open_gh_task(cur, cid, 42)
        batched = core.find_open_gh_tasks(cur, cid, [42, 999])
    assert single == tid
    assert batched == {42: tid}   # 999 (no open task) is simply absent, not None-valued


def test_find_open_gh_task_is_the_single_number_case_of_the_batched_helper(monkeypatch):
    """Mutation-guard: find_open_gh_task's body must literally delegate to
    find_open_gh_tasks — proven by making the batched helper always return a
    recognizable sentinel and asserting the single-number function surfaces it
    unchanged. If a future edit reintroduces a separate/duplicated query for the
    single-number path, this goes red even without a live DB."""
    sentinel = {7: "task-from-batched-helper"}
    calls = []

    def fake_batched(cur, container_id, numbers):
        calls.append((container_id, list(numbers)))
        return sentinel

    monkeypatch.setattr(core, "find_open_gh_tasks", fake_batched)
    result = core.find_open_gh_task("fake-cur", "cid-1", 7)
    assert result == "task-from-batched-helper"
    assert calls == [("cid-1", [7])]


# ------------------------- DoD: codebase-triage-first clause (issue-kind only) -------------------------
#
# Founder ask, layered on top of the Slack AI-refine feature: the LLM refine pass
# (slack_routes._refine_issue_for_filing) makes an issue's WORDING professional in
# seconds, codebase-blind by design (it never sees the repo). The dispatched agent
# is the one with actual codebase access — so its DoD now requires it to open with a
# codebase-grounded triage comment on the GitHub issue BEFORE writing any code. This
# is pure division of labor: fast, cheap wording polish up front; real investigation
# from inside the repo once an agent picks the work up. Only ISSUE-kind tasks get
# this clause — a PR/Fix task is reacting to CI/review feedback on code that already
# exists, not triaging a fresh report, so _PULL_DOD (and any dod_override the hub's
# PR-Fix path supplies) is deliberately untouched.

def test_build_task_fields_issue_kind_includes_triage_clause():
    fields = core.build_task_fields("issue", 42, "Login button broken", "", "")
    dod = fields["definition_of_done"]
    assert "Before implementing: post a triage comment on GH issue #42" in dod
    assert "codebase-grounded analysis" in dod
    assert "the specific modules/files involved" in dod
    assert "what logs/repro would confirm it" in dod
    # The triage clause comes BEFORE the existing fix/PR/review clauses, not appended
    # after — "Before implementing" must be true of the DoD's own ordering.
    assert dod.index("Before implementing") < dod.index("Fix GH #42 per its description")
    # Pre-existing clauses (pinned by test_github_hub_routes.py/test_slack_routes.py's
    # substring asserts) survive unchanged.
    assert "Fix GH #42 per its description" in dod
    assert "Never merge" in dod


def test_build_task_fields_pull_kind_has_no_triage_clause():
    fields = core.build_task_fields("pull", 9, "Fix retry backoff", "", "")
    dod = fields["definition_of_done"]
    assert "triage comment" not in dod
    assert "Before implementing" not in dod
    assert "Resolve CI failures / review feedback on PR #9" in dod


def test_build_task_fields_dod_override_bypasses_triage_clause():
    """A PR-Fix dod_override (github_hub_routes' context-aware DoD) REPLACES the
    generic template outright — the triage clause is part of the generic _ISSUE_DOD
    template only, never injected into an override."""
    fields = core.build_task_fields(
        "issue", 42, "title", "", "", dod_override="Custom DoD with no triage clause.",
    )
    assert fields["definition_of_done"] == "Custom DoD with no triage clause."
