"""GitHub hub (Feature A) — issues/pulls list, checks rollup, 60s cache, and Start
(task creation + idempotency + assignment + grant enforcement + repo-not-connected).

Per the test-teeth convention, the ONLY thing stubbed is the network leaf
(`github_hub_routes._gh_get`) plus the installation-token file read — the routes,
schema validation, task-creation internals, cache, and grant gate all run for real.
"""
import uuid

import pytest

from portal_backend import github_hub_routes as hub


@pytest.fixture(autouse=True)
def _clear_cache():
    """The 60s TTL cache is a module dict — reset it around every test so one test's
    cached payload never leaks into the next."""
    hub._CACHE.clear()
    yield
    hub._CACHE.clear()


@pytest.fixture
def token_env(monkeypatch, tmp_path):
    """Wire a legacy single installation-token file so _resolve_repo_token yields a
    token (the multi-org map is absent). Mirrors github_binding's token fixture."""
    token_file = tmp_path / "github-token"
    token_file.write_text("ghs_hubtoken\n")
    monkeypatch.setenv("ORCHA_GITHUB_TOKEN_FILE", str(token_file))
    monkeypatch.delenv("ORCHA_GITHUB_TOKENS_FILE", raising=False)
    return "ghs_hubtoken"


async def _bind_repo(client, cid, repo="acme/site"):
    r = await client.put(f"/api/containers/{cid}/github", json={"repo": repo})
    assert r.status_code == 200, r.text


# ------------------------- repo not connected -------------------------

async def test_issues_repo_not_connected(client, container):
    r = await client.get(f"/api/containers/{container['id']}/github/issues")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["available"] is False and body["reason"] == "repo_not_connected"


async def test_pulls_repo_not_connected(client, container):
    r = await client.get(f"/api/containers/{container['id']}/github/pulls")
    assert r.status_code == 200
    assert r.json()["reason"] == "repo_not_connected"


async def test_issues_bad_cid_400_and_unknown_404(client):
    r = await client.get("/api/containers/not-a-uuid/github/issues")
    assert r.status_code == 400
    r = await client.get(f"/api/containers/{uuid.uuid4()}/github/issues")
    assert r.status_code == 404


# ------------------------- issues shape -------------------------

async def test_issues_shape_filters_prs(client, container, token_env, monkeypatch):
    cid = container["id"]
    await _bind_repo(client, cid)

    def fake_get(path, token):
        assert token == "ghs_hubtoken"
        assert "/repos/acme/site/issues" in path
        return [
            {"number": 7, "title": "Bug: crash on boot",
             "labels": [{"name": "bug"}, {"name": "p1"}],
             "assignee": {"login": "octocat"},
             "updated_at": "2026-07-01T00:00:00Z",
             "html_url": "https://github.com/acme/site/issues/7",
             "body": "x" * 500},
            # A PR masquerading in the issues list — must be filtered out.
            {"number": 8, "title": "a pr", "pull_request": {"url": "..."},
             "html_url": "https://github.com/acme/site/pull/8"},
        ]

    monkeypatch.setattr(hub, "_gh_get", fake_get)
    r = await client.get(f"/api/containers/{cid}/github/issues")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["available"] is True and body["repo"] == "acme/site"
    assert len(body["issues"]) == 1
    issue = body["issues"][0]
    assert issue == {
        "number": 7, "title": "Bug: crash on boot", "labels": ["bug", "p1"],
        "assignee": "octocat", "updated_at": "2026-07-01T00:00:00Z",
        "html_url": "https://github.com/acme/site/issues/7",
        "body_excerpt": "x" * 200,   # first 200 chars only
    }


# ------------------------- pulls + checks rollup math -------------------------

async def test_pulls_checks_rollup_math(client, container, token_env, monkeypatch):
    cid = container["id"]
    await _bind_repo(client, cid)

    def fake_get(path, token):
        if path.endswith("/pulls?state=open&per_page=100"):
            return [{
                "number": 12, "title": "Add feature", "draft": False,
                "updated_at": "2026-07-02T00:00:00Z",
                "html_url": "https://github.com/acme/site/pull/12",
                "head": {"ref": "feat/x", "sha": "deadbeef"},
                "requested_reviewers": [{"login": "hubot"}],
                "mergeable_state": "clean",
            }]
        if path == "/repos/acme/site/commits/deadbeef/status":
            return {"statuses": [
                {"state": "success"}, {"state": "failure"}, {"state": "pending"},
            ]}
        if path == "/repos/acme/site/commits/deadbeef/check-runs":
            return {"check_runs": [
                {"status": "completed", "conclusion": "success"},
                {"status": "completed", "conclusion": "failure"},
                {"status": "in_progress", "conclusion": None},
                {"status": "completed", "conclusion": "skipped"},   # counts as passed
            ]}
        raise AssertionError(f"unexpected path {path}")

    monkeypatch.setattr(hub, "_gh_get", fake_get)
    r = await client.get(f"/api/containers/{cid}/github/pulls")
    assert r.status_code == 200, r.text
    pull = r.json()["pulls"][0]
    # combined status: 1 pass / 1 fail / 1 pending; check-runs: 2 pass / 1 fail / 1 pending
    assert pull["checks"] == {"passed": 3, "failing": 2, "pending": 2, "total": 7}
    assert pull["head"] == "feat/x"
    assert pull["requested_reviewers"] == ["hubot"]
    assert pull["mergeable_state"] == "clean"


# ------------------------- cache TTL behavior -------------------------

async def test_issues_cached_60s(client, container, token_env, monkeypatch):
    cid = container["id"]
    await _bind_repo(client, cid)
    calls = {"n": 0}

    def fake_get(path, token):
        calls["n"] += 1
        return []

    monkeypatch.setattr(hub, "_gh_get", fake_get)
    await client.get(f"/api/containers/{cid}/github/issues")
    await client.get(f"/api/containers/{cid}/github/issues")
    assert calls["n"] == 1  # second read served from the 60s cache

    # Advance past the TTL → GitHub is hit again.
    base = hub.time.monotonic()
    monkeypatch.setattr(hub.time, "monotonic", lambda: base + hub.CACHE_TTL_SECONDS + 1)
    await client.get(f"/api/containers/{cid}/github/issues")
    assert calls["n"] == 2


# ------------------------- error mapping (rate limit / 404) -------------------------

async def test_issues_rate_limited_403(client, container, token_env, monkeypatch):
    cid = container["id"]
    await _bind_repo(client, cid)

    def fake_get(path, token):
        raise RuntimeError("github_status:403")

    monkeypatch.setattr(hub, "_gh_get", fake_get)
    r = await client.get(f"/api/containers/{cid}/github/issues")
    assert r.status_code == 200  # graceful, never a 5xx
    assert r.json()["reason"] == "rate_limited"


async def test_pulls_404_reads_as_not_connected(client, container, token_env, monkeypatch):
    cid = container["id"]
    await _bind_repo(client, cid)
    monkeypatch.setattr(hub, "_gh_get",
                        lambda p, t: (_ for _ in ()).throw(RuntimeError("github_status:404")))
    r = await client.get(f"/api/containers/{cid}/github/pulls")
    assert r.json()["reason"] == "repo_not_connected"


# ------------------------- start: creation + idempotency + assignment -------------------------

async def test_start_issue_creates_task(client, container, make_task):
    cid = container["id"]
    r = await client.post(
        f"/api/containers/{cid}/github/start",
        json={"kind": "issue", "number": 42, "title": "Fix the thing",
              "body_excerpt": "it is broken",
              "html_url": "https://github.com/acme/site/issues/42"},
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["existing"] is False and body["task_id"]
    # The created task carries the templated shape.
    listed = (await client.get(f"/api/containers/{cid}/tasks")).json()["tasks"]
    t = [x for x in listed if x["id"] == body["task_id"]][0]
    assert t["title"] == "GH #42: Fix the thing"
    assert "Fix GH #42 per its description" in t["definition_of_done"]
    assert "Never merge" in t["definition_of_done"]
    assert t["status"] == "ready"  # unassigned → ready


async def test_start_pull_dod_template(client, container):
    cid = container["id"]
    r = await client.post(
        f"/api/containers/{cid}/github/start",
        json={"kind": "pull", "number": 9, "title": "WIP"},
    )
    assert r.status_code == 201, r.text
    tid = r.json()["task_id"]
    listed = (await client.get(f"/api/containers/{cid}/tasks")).json()["tasks"]
    t = [x for x in listed if x["id"] == tid][0]
    assert t["title"] == "GH #9: WIP"
    assert "Resolve CI failures / review feedback on PR #9" in t["definition_of_done"]
    assert "NOT merged without human review" in t["definition_of_done"]


async def test_start_idempotent_same_number(client, container):
    cid = container["id"]
    r1 = await client.post(f"/api/containers/{cid}/github/start",
                           json={"kind": "issue", "number": 42, "title": "A"})
    r2 = await client.post(f"/api/containers/{cid}/github/start",
                           json={"kind": "issue", "number": 42, "title": "A"})
    assert r1.json()["existing"] is False
    assert r2.json()["existing"] is True
    assert r2.json()["task_id"] == r1.json()["task_id"]
    # only ONE task exists for GH #42
    listed = (await client.get(f"/api/containers/{cid}/tasks")).json()["tasks"]
    assert sum(1 for t in listed if t["title"].startswith("GH #42:")) == 1


async def test_start_prefix_does_not_false_match(client, container):
    """GH #12 must not be mistaken for GH #123 (the LIKE probe uses the ': ' delimiter)."""
    cid = container["id"]
    await client.post(f"/api/containers/{cid}/github/start",
                      json={"kind": "issue", "number": 12, "title": "twelve"})
    r = await client.post(f"/api/containers/{cid}/github/start",
                          json={"kind": "issue", "number": 123, "title": "one-two-three"})
    assert r.json()["existing"] is False  # a distinct task, not a false idempotency hit


async def test_start_with_assignee_assigns_and_wakes(client, container, make_agent, db):
    cid = container["id"]
    agent = await make_agent("worker-1", kind="ai")
    aid = agent["agent_id"]
    r = await client.post(
        f"/api/containers/{cid}/github/start",
        json={"kind": "issue", "number": 5, "title": "assign me",
              "assignee_agent_id": aid},
    )
    assert r.status_code == 201, r.text
    tid = r.json()["task_id"]
    # A 'working' agent_tasks row exists (assignment happened) …
    rows = db.execute(
        "SELECT assignment_status FROM agent_tasks WHERE task_id=%s AND agent_id=%s",
        (tid, aid))
    assert rows and rows[0]["assignment_status"] == "working"
    # … the task is in_progress (assigned), and a targeted task_assigned wake fired.
    listed = (await client.get(f"/api/containers/{cid}/tasks")).json()["tasks"]
    t = [x for x in listed if x["id"] == tid][0]
    assert t["status"] == "in_progress"
    evs = db.execute(
        "SELECT 1 FROM agent_events WHERE event_key=%s AND event_name='task_assigned'",
        (aid,))
    assert evs, "assignee should have received a targeted task_assigned wake"


async def test_start_assignee_must_be_ai_in_container(client, container, make_agent):
    cid = container["id"]
    # a human is not a valid assignee
    human = await make_agent("ops", kind="human")
    r = await client.post(
        f"/api/containers/{cid}/github/start",
        json={"kind": "issue", "number": 5, "title": "x",
              "assignee_agent_id": human["agent_id"]},
    )
    assert r.status_code == 409
    # an unknown agent id 404s
    r = await client.post(
        f"/api/containers/{cid}/github/start",
        json={"kind": "issue", "number": 6, "title": "x",
              "assignee_agent_id": str(uuid.uuid4())},
    )
    assert r.status_code == 404


async def test_start_bad_kind_422(client, container):
    r = await client.post(f"/api/containers/{container['id']}/github/start",
                          json={"kind": "branch", "number": 1})
    assert r.status_code == 422


# ------------------------- grant enforcement (trusted proxy lane) -------------------------

OCTO = {"X-Auth-Request-User": "octocat"}
MALLORY = {"X-Auth-Request-User": "mallory"}


@pytest.fixture
def trust_proxy(monkeypatch):
    monkeypatch.setenv("ORCHA_TRUST_PROXY_USER", "1")


async def _bind_owner(client, container, make_agent):
    await make_agent("root", "operator", kind="human")
    r = await client.get(f"/api/me?cid={container['id']}", headers=OCTO)
    assert r.status_code == 200, r.text
    return r.json()["identity"]


async def test_start_trusted_non_member_403(client, container, make_agent, trust_proxy):
    """Start requires the same grant task creation does: under proxy trust a non-member
    is refused — exactly like POST .../tasks (trusted_actor)."""
    cid = container["id"]
    await _bind_owner(client, container, make_agent)  # now mapped to octocat
    r = await client.post(
        f"/api/containers/{cid}/github/start",
        json={"kind": "issue", "number": 1, "title": "x"},
        headers=MALLORY,
    )
    assert r.status_code == 403, r.text


async def test_start_trusted_member_ok(client, container, make_agent, trust_proxy):
    cid = container["id"]
    await _bind_owner(client, container, make_agent)
    r = await client.post(
        f"/api/containers/{cid}/github/start",
        json={"kind": "issue", "number": 2, "title": "x"},
        headers=OCTO,
    )
    assert r.status_code == 201, r.text
