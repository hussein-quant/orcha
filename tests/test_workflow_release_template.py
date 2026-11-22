"""Mobile App Release: the template library, one Start, person/gate/watch steps, dry runs, the
proof pack, the board and stalled detection, end to end over HTTP on the real engine.
"""

from uuid import uuid4

import pytest

from portal_backend import workflow_service as ws
from portal_backend import workflow_steps as steps
from portal_backend import workflow_templates as templates
from portal_backend.database import db_cursor


def uid():
    return str(uuid4())


@pytest.fixture(autouse=True)
def local_lane(monkeypatch):
    monkeypatch.setattr(ws, "WORKFLOWS_INTEGRATED", True)
    monkeypatch.delenv("ORCHA_TRUST_PROXY_USER", raising=False)
    monkeypatch.delenv("ORCHA_BIND", raising=False)
    monkeypatch.setattr(steps, "DRY_RUN_DELAY_S", 0)
    steps._seen_ready.clear()


class Project:
    def __init__(self, client):
        self.client = client
        self.cid, self.owner, self.eng, self.rel, self.qa = uid(), uid(), uid(), uid(), uid()
        with db_cursor() as (_, cur):
            cur.execute("INSERT INTO containers(id,name) VALUES (%s,'Release')", (self.cid,))
            for aid, alias, kind, role in [
                (self.owner, "Owner", "human", "owner"),
                (self.eng, "Engineer", "ai", "member"),
                (self.rel, "Release", "ai", "member"),
                (self.qa, "QA", "ai", "member"),
            ]:
                cur.execute(
                    "INSERT INTO agents(id,container_id,alias,role,kind,member_role,github_login)"
                    " VALUES (%s,%s,%s,'test',%s,%s,%s)",
                    (aid, self.cid, alias, kind, role, alias.lower() if kind == "human" else None),
                )
        self.headers = {"X-Orcha-Local-Actor": self.owner}

    async def call(self, method, path, body=None, expect=200, headers=None):
        r = await self.client.request(method, path, json=body, headers=self.headers if headers is None else headers)
        assert r.status_code == expect, (path, r.status_code, r.text)
        return r.json()


PARAMS = {"platforms": ["ios", "android", "web", "api"], "version": "1.0.2", "build": "8",
          "android_version": "1.0.20", "android_version_code": "20",
          "release_type": "manual", "batch_summary": "Broker fee as a percentage"}


def by_key(detail):
    return {t["step"]["key"]: t for t in detail["tasks"] if t.get("step")}


@pytest.mark.asyncio
async def test_library_lists_mobile_app_release_first(client):
    p = Project(client)
    out = await p.call("GET", f"/api/containers/{p.cid}/workflow-templates")
    first = out["templates"][0]
    assert first["key"] == "mobile_app_release"
    assert first["gates"] == 2 and first["watches"] == 6 and first["outward"] == 5
    full = await p.call("GET", f"/api/containers/{p.cid}/workflow-templates/mobile_app_release")
    assert [s["key"] for s in full["stages"]][0] == "intake"


@pytest.mark.asyncio
async def test_compile_asks_for_every_required_parameter_and_keeps_required_steps(client):
    p = Project(client)
    out = await p.call("POST", f"/api/containers/{p.cid}/workflow-templates/mobile_app_release/compile",
                       {"params": {"platforms": ["ios"]}, "dry_run": True})
    missing = {x["param"] for x in out["problems"] if x["code"] == "parameter_required"}
    assert missing == {"version", "build", "release_type"}  # release type is asked, never defaulted
    out = await p.call("POST", f"/api/containers/{p.cid}/workflow-templates/mobile_app_release/compile",
                       {"params": PARAMS, "removed": ["gate", "qa_full_ios", "baseline"], "dry_run": True})
    locked = {x["task_id"] for x in out["problems"] if x["code"] == "step_required"}
    assert locked == {"gate", "qa_full_ios"}
    kept = {s["client_key"] for s in out["steps"] if not s["removed"]}
    assert "baseline" not in kept and "gate" in kept


@pytest.mark.asyncio
async def test_removing_a_platform_removes_its_steps_and_rewires(client):
    p = Project(client)
    out = await p.call("POST", f"/api/containers/{p.cid}/workflow-templates/mobile_app_release/compile",
                       {"params": {**PARAMS, "platforms": ["web", "api"]}, "dry_run": True})
    assert out["problems"] == [], out["problems"]
    tasks = {t["client_key"]: t for t in out["draft"]["tasks"]}
    assert "build_ios" not in tasks and "submit_ios" not in tasks and "bump" not in tasks
    assert tasks["gate"]["depends_on"] == ["triage_full"]
    gate = tasks["gate"]
    assert "send_back" not in {o["name"] for o in gate["outcomes"]}  # no loop before it: nowhere to send back
    assert all(len(t["depends_on"]) <= 3 for t in tasks.values())


@pytest.mark.asyncio
async def test_irreversible_step_without_a_gate_is_refused(client):
    p = Project(client)
    draft = {
        "title": "Ship", "goal": "Ship", "idempotency_key": uid(), "semantics_version": 2,
        "tasks": [{"client_key": "submit", "title": "Submit", "definition_of_done": "submitted",
                   "assignee_id": p.rel, "step": {"kind": "agent", "irreversible": True, "outward": "App Store"}}],
    }
    out = await p.call("POST", f"/api/containers/{p.cid}/workflows", draft, 422)
    assert out["detail"]["code"] == "irreversible_without_gate"


@pytest.mark.asyncio
async def test_agent_cannot_be_assigned_a_person_step(client):
    p = Project(client)
    draft = {
        "title": "Gate", "goal": "Gate", "idempotency_key": uid(), "semantics_version": 2,
        "tasks": [{"client_key": "g", "title": "Go", "definition_of_done": "decided", "assignee_id": p.rel,
                   "outcomes": [{"name": "go", "kind": "success"}], "routes": [{"outcome": "go", "destination": "next"}],
                   "step": {"kind": "gate"}}],
    }
    out = await p.call("POST", f"/api/containers/{p.cid}/workflows", draft, 422)
    assert out["detail"]["code"] == "person_step_assignee"


async def drive(p, wid, decide, rounds=200):
    """Run the dry-run driver and answer people as their steps come up."""
    for _ in range(rounds):
        steps.tick_workflow(wid)
        detail = await p.call("GET", f"/api/workflows/{wid}")
        if detail["status"] != "active":
            return detail
        acted = False
        for t in detail["tasks"]:
            kind = (t.get("step") or {}).get("kind")
            if t["status"] == "ready" and kind in {"person", "gate"}:
                await decide(detail, t)
                acted = True
                break
            if t.get("awaiting_loop_decision") or (t["status"] == "ready" and (t.get("watch") or {}).get("needs_owner")):
                await decide(detail, t)
                acted = True
                break
        settled = all(t["status"] in {"completed", "cancelled"} or t.get("route_state") == "not_selected"
                      for t in detail["tasks"])
        if not acted and settled and not any(t.get("awaiting_loop_decision") for t in detail["tasks"]):
            return detail
    state = [(t["step"]["key"] if t.get("step") else t["title"], t["status"], t.get("route_state"),
              t.get("awaiting_loop_decision"), [b["code"] for b in t["blockers"]][:3]) for t in detail["tasks"]]
    raise AssertionError(f"the dry run did not settle: {state}")


@pytest.mark.asyncio
async def test_dry_run_release_end_to_end(client):
    p = Project(client)
    created = await p.call("POST", f"/api/containers/{p.cid}/workflows/from-template", {
        "key": "mobile_app_release", "params": PARAMS, "removed": ["baseline"], "dry_run": True,
        "idempotency_key": uid(),
    })
    wid = created["id"]
    assert created["launch_enabled"] and created["dry_run"]
    assert created["template"]["key"] == "mobile_app_release"
    assert not any(t["assignee_ids"] for t in created["tasks"])  # a rehearsal wakes no agent
    seen = {"gate": 0, "rejected": 0, "resubmit_gate": 0, "play": 0, "released": 0}

    async def decide(detail, t):
        key = t["step"]["key"]
        url = f"/api/workflows/{wid}/steps/{t['id']}/decide"
        if (t.get("watch") or {}).get("needs_owner"):
            # Google Play says "unknown": only the owner can settle it (finding 5).
            assert key == "review_android" and t["watch"]["latest"]["state"] == "unknown"
            assert "Play Console" in t["watch"]["needs_owner"]
            seen["play"] += 1
            await p.call("POST", f"/api/workflows/{wid}/steps/{t['id']}/resolve", {"state": "live"})
            return
        if t.get("awaiting_loop_decision"):
            assert key == "review_ios"
            seen["rejected"] += 1
            # Fix and resubmit: back through a new build, QA and a go-ahead (finding 2).
            await p.call("POST", f"/api/workflows/{wid}/decisions", {
                "expected_revision": detail["revision"], "idempotency_key": uid(), "reason": "",
                "kind": "pick_outcome", "task_id": t["id"], "outcome": "resubmit", "note": "Guideline 2.1: fix it.",
            })
            return
        if key == "gate_resubmit":
            seen["resubmit_gate"] += 1
            assert any(b["code"] in {"gate_required", "prerequisites"} for b in by_key(detail)["resubmit_ios"]["blockers"])
            await p.call("POST", url, {"choice": "go"})
            return
        if key == "gate":
            seen["gate"] += 1
            submit = by_key(detail)["submit_ios"]
            assert any(b["code"] == "gate_required" or b["code"] == "prerequisites" for b in submit["blockers"])
            proof = await p.call("GET", f"/api/workflows/{wid}/proof?step={t['id']}")
            assert {x["platform"] for x in proof["platforms"]} >= {"ios", "android", "web"}
            if seen["gate"] == 1:
                out = await p.call("POST", url, {"choice": "send_back"}, 422)
                assert out["detail"]["code"] == "reason_required"
                await p.call("POST", url, {"choice": "send_back", "reason": "The Android build is the old one.",
                                           "send_back_to": by_key(detail)["build_android"]["id"]})
            else:
                await p.call("POST", url, {"choice": "go", "proof_digest": proof["digest"]})
            return
        if key == "release_ios":
            seen["released"] += 1
            # Manual release: approved is not live until the owner releases it (finding 3).
            assert by_key(detail)["live_ios"]["status"] != "completed"
        outcome = {"batch": "ready", "review_merge": "merged", "coverage_review": "covered",
                   "testflight_owner": "ok", "merge_fix": "merged", "release_ios": "released"}[key]
        await p.call("POST", url, {"outcome": outcome})

    final = await drive(p, wid, decide)
    keys = by_key(final)
    assert seen == {"gate": 2, "rejected": 1, "resubmit_gate": 1, "play": 1, "released": 1}
    assert keys["resubmit_ios"]["status"] == "completed" and keys["live_ios"]["status"] == "completed"
    assert keys["review_android"]["step"]["watch"]["adapter"]["command"].endswith("--version-code 20")
    # The round history keeps what an earlier round found (finding 4).
    assert [h["outcome"] for h in keys["qa_subset_ios"]["history"]] == ["fail", "pass"]
    assert [h["round"] for h in keys["qa_subset_ios"]["history"]] == [1, 2]
    with db_cursor() as (_, cur):
        cur.execute("SELECT outcome_name FROM workflow_outcome_reports WHERE task_id=%s ORDER BY reported_at",
                    (keys["qa_subset_ios"]["id"],))
        assert [r["outcome_name"] for r in cur.fetchall()] == ["fail", "pass"]  # fail, triage, fix, pass
        cur.execute("SELECT count(*) AS n FROM workflow_watch_observations WHERE task_id=%s",
                    (keys["review_ios"]["id"],))
        assert cur.fetchone()["n"] == 3
        cur.execute("SELECT decision FROM decisions WHERE subject_type='workflow_gate' ORDER BY created_at")
        assert [r["decision"] for r in cur.fetchall()] == ["reject", "approve", "approve"]
    assert keys["submit_ios"]["status"] == "completed"
    assert keys["build_android"]["work_revision"] > keys["build_ios"]["work_revision"] - 5
    closed = await p.call("POST", f"/api/workflows/{wid}/close", {"note": "Dry run complete."})
    assert closed["status"] == "completed"
    board = await p.call("GET", f"/api/containers/{p.cid}/workflow-board?include_finished=true")
    assert board["workflows"][0]["id"] == wid and board["workflows"][0]["finished"]
    again = await p.call("GET", f"/api/workflows/{wid}/next-release")
    # A dry run never feeds the next release (finding 8): with no real release yet, nothing moves.
    assert again["based_on"] == "dry_run" and again["params"]["build"] == "8" and "release_type" not in again["params"]


@pytest.mark.asyncio
async def test_no_go_stops_the_release_before_any_store(client):
    p = Project(client)
    created = await p.call("POST", f"/api/containers/{p.cid}/workflows/from-template", {
        "key": "mobile_app_release", "params": {**PARAMS, "platforms": ["web"]}, "dry_run": True,
        "idempotency_key": uid(),
    })
    wid = created["id"]

    async def decide(detail, t):
        key = t["step"]["key"]
        url = f"/api/workflows/{wid}/steps/{t['id']}/decide"
        if key == "gate":
            assert t["step"]["gate"]["choices"] == ["go", "no_go"]
            await p.call("POST", url, {"choice": "no_go", "reason": "Not this week."})
            return
        await p.call("POST", url, {"outcome": {"batch": "ready", "review_merge": "merged",
                                               "coverage_review": "covered"}[key]})

    final = await drive(p, wid, decide)
    keys = by_key(final)
    assert keys["deploy_web_prod"]["route_state"] == "not_selected"
    assert keys["deploy_web_prod"]["status"] != "completed"


@pytest.mark.asyncio
async def test_person_step_refuses_a_caller_without_a_person(client):
    p = Project(client)
    created = await p.call("POST", f"/api/containers/{p.cid}/workflows/from-template", {
        "key": "mobile_app_release", "params": {**PARAMS, "platforms": ["web"]}, "dry_run": True,
        "idempotency_key": uid(),
    })
    batch = by_key(created)["batch"]
    out = await p.call("POST", f"/api/workflows/{created['id']}/steps/{batch['id']}/decide", {"outcome": "ready"},
                       403, headers={})
    assert out["detail"]["code"] in {"human_required", "verified_member_required"}


@pytest.mark.asyncio
async def test_watch_resolved_by_hand_and_unknown_kept_honest(client, monkeypatch):
    p = Project(client)
    created = await p.call("POST", f"/api/containers/{p.cid}/workflows/from-template", {
        "key": "mobile_app_release", "params": {**PARAMS, "platforms": ["android"]}, "dry_run": False,
        "roles": {"engineer": p.eng, "release": p.rel, "qa": p.qa}, "idempotency_key": uid(),
    })
    review = by_key(created)["review_android"]
    assert review["step"]["watch"]["adapter"]["command"].startswith("python3 scripts/release-adapters/play_status.py")
    reading = steps.run_adapter({"command": "python3 -c \"print('{\\\"state\\\": \\\"unknown\\\", \\\"summary\\\": \\\"Play hides review state\\\"}')\""}, None)
    assert reading["state"] == "unknown" and reading["summary"] == "Play hides review state"
    # A broken adapter is an error, never a store state (finding 7).
    broken = steps.run_adapter({"command": "false"}, None)
    assert broken["state"] == "error" and broken["summary"].startswith("Couldn't read the status")


def test_template_compiles_inside_the_engine_limits():
    for platforms in (["ios"], ["android"], ["web"], ["api"], ["ios", "android"], ["web", "api"],
                      ["ios", "android", "web", "api"]):
        out = templates.compile_template(templates.mobile_app_release(), {**PARAMS, "platforms": platforms}, dry_run=True)
        assert not [x for x in out["problems"] if x["code"] != "role_unassigned"], (platforms, out["problems"])
        for g in out["draft"]["repeat_groups"]:
            assert 2 <= len(g["member_tasks"]) <= 10


def test_redaction_hides_tokens_but_keeps_commits():
    text = "token 12|abcdefghijklmnopqrstuvwxyzABCD commit 0123456789abcdef0123456789abcdef01234567"
    out = steps.redact(text)
    assert "abcdefghijklmnopqrstuvwxyz" not in out and "0123456789abcdef0123456789abcdef01234567" in out


def test_adapter_output_is_read_from_the_last_object_and_its_own_error_is_retried(tmp_path):
    script = tmp_path / "adapter.py"
    script.write_text(
        "import json, sys\n"
        "print('checking {version} for build {8}')\n"
        "print(json.dumps({'state': sys.argv[1], 'summary': 'x', 'data': {'nested': {'a': 1}}}))\n"
        "sys.exit(2 if sys.argv[1] == 'error' else 0)\n"
    )
    ok = steps.run_adapter({"command": f"python3 {script} in_review"}, None)
    assert ok["state"] == "in_review" and ok["data"] == {"nested": {"a": 1}}
    failed = steps.run_adapter({"command": f"python3 {script} error"}, None)
    assert failed["state"] == "error" and failed["summary"].startswith("Couldn't read the status")


def test_final_states_the_step_does_not_route_on_ask_the_owner():
    t = templates.compile_template(templates.mobile_app_release(), PARAMS, dry_run=True)
    spec = {x["client_key"]: x for x in t["draft"]["tasks"]}["review_ios"]["step"]
    assert steps.owner_reason(spec, {"state": "withdrawn", "terminal": True})
    assert steps.owner_reason(spec, {"state": "in_review", "terminal": False}) is None
    assert steps.owner_reason(spec, {"state": "approved", "terminal": True}) is None  # it routes
    assert steps.owner_reason(spec, {"state": "error", "terminal": False}) is None  # retried


def test_release_type_decides_whether_you_release_by_hand():
    def tasks(release_type):
        out = templates.compile_template(templates.mobile_app_release(), {**PARAMS, "release_type": release_type}, dry_run=True)
        return {x["client_key"]: x for x in out["draft"]["tasks"]}

    manual, auto = tasks("manual"), tasks("after_approval")
    review = {r["outcome"]: (r["destination"], r.get("destination_task")) for r in manual["review_ios"]["routes"]}
    assert review["approved"] == ("step", "release_ios") and review["resubmit"] == ("step", "fix_rejection")
    assert "release_ios" not in auto
    review = {r["outcome"]: (r["destination"], r.get("destination_task")) for r in auto["review_ios"]["routes"]}
    assert review["approved"] == ("step", "live_ios")
    # Approved is never live by itself: only ready_for_sale is.
    assert manual["review_ios"]["step"]["watch"]["state_map"]["approved"] == "approved"
    assert manual["live_ios"]["step"]["watch"]["state_map"] == {"ready_for_sale": "live", "live": "live"}
    # Each platform keeps its own version and build (finding 1).
    assert manual["promote_android"]["description"].count("20") >= 1 and "(8)" not in manual["promote_android"]["title"]
    assert manual["qa_full_android"]["step"]["build"]["build"] == "20"
    assert manual["qa_full_ios"]["step"]["build"]["build"] == "8"


@pytest.mark.asyncio
async def test_next_release_skips_dry_runs_and_moves_the_version_after_a_live_release(client):
    p = Project(client)
    real = await p.call("POST", f"/api/containers/{p.cid}/workflows/from-template", {
        "key": "mobile_app_release", "params": PARAMS, "dry_run": False, "start": False,
        "roles": {"engineer": p.eng, "release": p.rel, "qa": p.qa}, "idempotency_key": uid(),
    })
    dry = await p.call("POST", f"/api/containers/{p.cid}/workflows/from-template", {
        "key": "mobile_app_release", "params": {**PARAMS, "build": "40"}, "dry_run": True, "start": False,
        "idempotency_key": uid(),
    })
    out = await p.call("GET", f"/api/workflows/{dry['id']}/next-release")
    assert out["based_on"] == "last_real_release" and out["params"]["build"] == "9"  # not the dry run's 40
    assert out["params"]["version"] == "1.0.2"  # the real one never went live: only the builds go up
    with db_cursor() as (_, cur):
        cur.execute("UPDATE workflows SET status='completed' WHERE id=%s", (real["id"],))
        cur.execute("UPDATE tasks SET status='completed' WHERE id=%s", (by_key(real)["live_check"]["id"],))
    out = await p.call("GET", f"/api/workflows/{dry['id']}/next-release")
    assert (out["params"]["version"], out["params"]["build"]) == ("1.0.3", "9")
    assert (out["params"]["android_version"], out["params"]["android_version_code"]) == ("1.0.21", "21")


@pytest.mark.asyncio
async def test_release_home_reads_the_project_inventory(client, monkeypatch, tmp_path):
    from portal_backend import workflow_release_routes as routes

    routes._INVENTORY.clear()
    script = tmp_path / "scripts" / "release-adapters" / "release_inventory.py"
    script.parent.mkdir(parents=True)
    script.write_text(
        "import json\n"
        "print('fetching {tags}')\n"
        "print(json.dumps({'state': 'ready', 'summary': 'ios: 2 changes', 'data': {\n"
        "  'platforms': {'ios': {'last_release': {'tag': 'ios/1.0.1-7'}, 'changes': [{'sha': 'abc', 'pr': 96, 'title': 'Fee'}],\n"
        "                        'next': {'version': '1.0.2', 'build': 8}}},\n"
        "  'release_params': {'platforms': ['ios', 'android'], 'version': '1.0.2', 'build': '8',\n"
        "                     'android_version': '1.0.20', 'android_version_code': '20', 'batch_summary': '#96 Fee'}}}))\n"
    )
    monkeypatch.setenv("ORCHA_LOCAL_REPO_DIR", str(tmp_path))
    p = Project(client)
    url = f"/api/containers/{p.cid}/workflow-templates/mobile_app_release/inventory"
    await p.call("GET", url, expect=403, headers={})  # a person asks for it
    out = await p.call("GET", url)
    assert out["state"] == "ready" and not out["cached"]
    rp = out["data"]["release_params"]
    # The release params compile with nothing typed but the iOS release type.
    compiled = await p.call("POST", f"/api/containers/{p.cid}/workflow-templates/mobile_app_release/compile",
                            {"params": {**rp, "release_type": "manual"}, "dry_run": True})
    assert compiled["problems"] == [] and compiled["draft"]["title"] == "Release iOS 1.0.2 (8) · Android 1.0.20 (20)"
    assert (await p.call("GET", url))["cached"]
    script.write_text("import sys\nsys.exit(3)\n")
    broken = await p.call("GET", url + "?refresh=true")
    assert broken["state"] == "error" and broken["summary"].startswith("Couldn't read the status")
