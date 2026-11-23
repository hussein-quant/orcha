"""Release cycles: tickets on a release branch for weeks, each in its own small workflow, then
one cut into a Mobile App Release made from that branch. End to end over HTTP on the real engine,
in dry runs (no agent wakes) and with git and gh replaced.
"""

import json
from uuid import uuid4

import pytest

from portal_backend import release_cycle_routes as cycles
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


class Git:
    """Stands in for git: records every command, answers from a script."""

    def __init__(self, remote_has=(), fail=None):
        self.calls, self.remote_has, self.fail = [], set(remote_has), fail

    def __call__(self, args, timeout=60):
        self.calls.append(args)
        if self.fail and self.fail in args:
            return 1, "", f"{self.fail} refused"
        if args[:2] == ["git", "ls-remote"]:
            return (0, "abc\trefs/heads/x\n", "") if args[-1] in self.remote_has else (2, "", "")
        if args[:2] == ["git", "push"]:
            self.remote_has.add(args[-1].split(":refs/heads/")[-1])
            return 0, "", ""
        return 0, "", ""


class GitHub:
    """Stands in for the GitHub API behind the GitHub tab's plumbing."""

    def __init__(self, issues=(), milestones=("1.0.3",), labels=("bug",)):
        self.issues, self.milestones, self.created, self.gets = list(issues), list(milestones), [], []
        self.labels, self.new_labels, self.labelled, self.unlabelled = set(labels), [], [], []

    def install(self, monkeypatch):
        monkeypatch.setattr(cycles, "github_repo", lambda cur, cid, request: ("example/nyumba", "tok"))
        monkeypatch.setattr(cycles, "_gh_get", self.get)
        monkeypatch.setattr(cycles, "_gh_send", self.send)
        return self

    def get(self, path, token):
        self.gets.append(path)
        if path.startswith("/repos/example/nyumba/milestones"):
            return [{"number": i + 1, "title": t} for i, t in enumerate(self.milestones)]
        if "/labels/" in path:
            from urllib.parse import unquote
            name = unquote(path.rsplit("/", 1)[-1])
            if name not in self.labels:
                raise RuntimeError("GitHub said 404: Not Found")
            return {"name": name}
        if "/issues?milestone=" in path:
            return [{**i, "html_url": i["url"]} for i in self.issues]
        n = int(path.rsplit("/", 1)[-1])
        found = [i for i in self.issues if i["number"] == n]
        if not found:
            raise RuntimeError("GitHub said 404: Not Found")
        return {**found[0], "html_url": found[0]["url"]}

    def send(self, method, path, token, payload):
        if path.endswith("/nyumba/labels"):
            self.labels.add(payload["name"])
            self.new_labels.append(payload)
            return payload
        if "/issues/" in path and "/labels" in path:
            n = int(path.split("/issues/")[1].split("/")[0])
            if method == "DELETE":
                self.unlabelled.append((n, path.rsplit("/", 1)[-1]))
            else:
                self.labelled.append((n, payload["labels"]))
            return []
        if path.endswith("/rename"):
            if getattr(self, "refuse_rename", False):
                raise RuntimeError("GitHub said 403: Resource not accessible")
            self.renamed = (path, payload)
            return {"name": payload["new_name"]}
        self.created.append(payload)
        return {"number": 240, "html_url": "https://github.com/example/nyumba/issues/240"}


class Project:
    def __init__(self, client):
        self.client = client
        self.cid, self.owner, self.eng, self.ios, self.rel, self.qa = uid(), uid(), uid(), uid(), uid(), uid()
        with db_cursor() as (_, cur):
            cur.execute("INSERT INTO containers(id,name) VALUES (%s,'Cycle')", (self.cid,))
            for aid, alias, kind, role in [
                (self.owner, "Owner", "human", "owner"), (self.eng, "Engineer", "ai", "member"),
                (self.ios, "IosEngineer", "ai", "member"), (self.rel, "Release", "ai", "member"),
                (self.qa, "QA", "ai", "member"),
            ]:
                cur.execute(
                    "INSERT INTO agents(id,container_id,alias,role,kind,member_role,github_login)"
                    " VALUES (%s,%s,%s,'test',%s,%s,%s)",
                    (aid, self.cid, alias, kind, role, alias.lower() if kind == "human" else None),
                )
        self.headers = {"X-Orcha-Local-Actor": self.owner}

    async def call(self, method, path, body=None, expect=200):
        r = await self.client.request(method, path, json=body, headers=self.headers)
        assert r.status_code == expect, (path, r.status_code, r.text)
        return r.json()

    async def open(self, version="1.0.3", dry_run=True, **extra):
        body = {"version": version, "dry_run": dry_run,
                "roles": {"engineer": self.eng, "release": self.rel, "qa": self.qa},
                "engineers": {"ios": self.ios}, **extra}
        return await self.call("POST", f"/api/containers/{self.cid}/release-cycles", body)


def keys(detail):
    return {t["step"]["key"]: t for t in detail["tasks"] if t.get("step")}


async def settle(p, wid, merge=True, approve=True, rounds=60):
    """Tick the dry run; merge and approve as those steps come up (or leave them waiting)."""
    for _ in range(rounds):
        steps.tick_workflow(wid)
        d = await p.call("GET", f"/api/workflows/{wid}")
        ready = [t for t in d["tasks"] if t["status"] == "ready" and (t.get("step") or {}).get("kind") == "person"]
        if not ready:
            if all(t["status"] in {"completed", "cancelled"} or t.get("route_state") == "not_selected" for t in d["tasks"]):
                return d
            continue
        t = ready[0]
        key = t["step"]["key"]
        if (key == "review_merge" and not merge) or (key == "approve_spec" and not approve):
            return d
        outcome = "merged" if key == "review_merge" else "approved"
        await p.call("POST", f"/api/workflows/{wid}/steps/{t['id']}/decide", {"outcome": outcome})
    return d


# ---- templates ---------------------------------------------------------------------


def test_release_template_from_a_cycle_builds_from_the_branch_and_merges_it_back():
    base = {"platforms": ["ios", "web"], "version": "1.0.3", "build": "9", "release_type": "manual"}
    batch = templates.compile_template(templates.mobile_app_release(), base, dry_run=True)
    kept = {t["client_key"] for t in batch["draft"]["tasks"]}
    assert {"batch", "implement", "review_merge", "triage_subset"} <= kept
    assert not {"merge_back", "merge_back_review"} & kept
    bump = next(t for t in batch["draft"]["tasks"] if t["client_key"] == "bump")
    assert "merged on main" in bump["definition_of_done"]  # the default reads exactly as before

    cycle = templates.compile_template(templates.mobile_app_release(), {
        **base, "source": "cycle", "release_branch": "release/1.0.3", "next_release_branch": "release/1.0.4",
        "batch_summary": "- #212 Login spinner (bug, iOS)"}, dry_run=True)
    tasks = {t["client_key"]: t for t in cycle["draft"]["tasks"]}
    assert not {"batch", "implement", "review_merge", "qa_subset_ios", "triage_subset"} & set(tasks)
    assert {"baseline", "coverage", "bump", "gate", "merge_back", "merge_back_review", "close"} <= set(tasks)
    assert "release/1.0.3" in tasks["bump"]["definition_of_done"]
    assert "release/1.0.4" in tasks["merge_back"]["description"]
    assert tasks["close"]["depends_on"] == ["merge_back_review"]
    assert not cycle["problems"]
    assert [g["name"] for g in cycle["draft"]["repeat_groups"]] == ["Regression loop", "Approval loop", "Resubmit loop"]


def test_a_bug_ticket_has_no_spec_and_checks_only_its_platforms():
    c = templates.compile_template(templates.release_ticket(), {
        "platforms": ["ios"], "kind": "bug", "issue_ref": "#212", "issue_title": "Login spinner",
        "release_branch": "release/1.0.3", "cycle_version": "1.0.3"}, dry_run=True)
    tasks = {t["client_key"]: t for t in c["draft"]["tasks"]}
    assert list(tasks) == ["implement", "review_merge", "qa_ios", "triage"]
    assert "release/1.0.3" in tasks["implement"]["description"] and "never main" in tasks["implement"]["description"]
    assert tasks["qa_ios"]["depends_on"] == ["review_merge"]
    assert c["draft"]["title"] == "#212 Login spinner"
    loops = c["draft"]["repeat_groups"]
    assert [g["name"] for g in loops] == ["Fix loop"] and loops[0]["member_tasks"] == ["implement", "review_merge", "qa_ios", "triage"]


def test_a_feature_ticket_starts_with_a_spec_you_approve():
    c = templates.compile_template(templates.release_ticket(), {
        "platforms": ["ios", "android", "web", "api"], "kind": "feature", "issue_ref": "#219",
        "issue_title": "Referrals", "release_branch": "release/1.0.3"}, dry_run=True)
    order = [t["client_key"] for t in c["draft"]["tasks"]]
    assert order[:3] == ["spec", "approve_spec", "implement"]
    assert {"deploy_api_staging", "deploy_web_staging", "qa_ios", "qa_android", "qa_web"} <= set(order)
    assert [g["name"] for g in c["draft"]["repeat_groups"]] == ["Spec loop", "Fix loop"]


def test_labels_name_the_platforms_and_the_kind():
    assert cycles.labels_say(["iOS", "bug"]) == (["ios"], "bug")
    assert cycles.labels_say(["platform:android", "Web", "enhancement"]) == (["android", "web"], "feature")
    assert cycles.labels_say(["backend", "feature request"]) == (["api"], "feature")
    assert cycles.labels_say(["docs"]) == ([], None)


# ---- the cycle ------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_the_gallery_never_offers_a_ticket(client):
    p = Project(client)
    out = await p.call("GET", f"/api/containers/{p.cid}/workflow-templates")
    assert "release_ticket" not in [t["key"] for t in out["templates"]]


@pytest.mark.asyncio
async def test_opening_a_real_cycle_makes_its_branch_from_main(client, monkeypatch):
    p = Project(client)
    git = Git()
    monkeypatch.setattr(cycles, "_run", git)
    c = await p.open(dry_run=False)
    assert c["branch"] == "release/1.0.3" and c["branch_state"] == "created"
    assert ["git", "push", "origin", "refs/remotes/origin/main:refs/heads/release/1.0.3"] in git.calls
    # One open cycle at a time.
    await p.call("POST", f"/api/containers/{p.cid}/release-cycles", {"version": "1.0.4"}, expect=409)
    listed = await p.call("GET", f"/api/containers/{p.cid}/release-cycles")
    assert listed["open"] == c["id"] and listed["suggested"]["version"] == "1.0.4"


@pytest.mark.asyncio
async def test_a_branch_already_on_origin_is_kept_and_a_failure_can_be_retried(client, monkeypatch):
    p = Project(client)
    monkeypatch.setattr(cycles, "_run", Git(remote_has={"release/1.0.3"}))
    c = await p.open(dry_run=False)
    assert c["branch_state"] == "existed"
    with db_cursor() as (_, cur):
        cur.execute("UPDATE release_cycles SET state='closed' WHERE id=%s", (c["id"],))
    monkeypatch.setattr(cycles, "_run", Git(fail="push"))
    c = await p.open(version="1.0.5", dry_run=False)
    assert c["branch_state"] == "failed" and "refused" in c["branch_note"]
    monkeypatch.setattr(cycles, "_run", Git())
    c = await p.call("POST", f"/api/release-cycles/{c['id']}/branch")
    assert c["branch_state"] == "created"


@pytest.mark.asyncio
async def test_tickets_from_the_milestone_read_their_platforms_from_labels(client, monkeypatch):
    p = Project(client)
    issues = [
        {"number": 212, "title": "Login spinner never stops", "body": "On slow networks", "url": "https://gh/212",
         "labels": [{"name": "bug"}, {"name": "ios"}]},
        {"number": 219, "title": "Tenant referrals", "body": "", "url": "https://gh/219",
         "labels": [{"name": "enhancement"}, {"name": "ios"}, {"name": "android"}, {"name": "api"}]},
    ]
    GitHub(issues).install(monkeypatch)
    c = await p.open()
    found = await p.call("GET", f"/api/release-cycles/{c['id']}/github")
    assert found["milestone"] == "1.0.3" and not found["error"]
    assert [(i["number"], i["platforms"], i["kind"], i["in_cycle"]) for i in found["issues"]] == [
        (212, ["ios"], "bug", None), (219, ["ios", "android", "api"], "feature", None)]
    c = await p.call("POST", f"/api/release-cycles/{c['id']}/tickets", {"issue_number": 212, "source": "github"})
    t = c["tickets"][0]
    assert (t["issue_number"], t["title"], t["platforms"], t["kind"]) == (212, "Login spinner never stops", ["ios"], "bug")
    found = await p.call("GET", f"/api/release-cycles/{c['id']}/github")
    assert found["issues"][0]["in_cycle"] == "1.0.3"
    await p.call("POST", f"/api/release-cycles/{c['id']}/tickets", {"issue_number": 212}, expect=409)
    # An iOS-only ticket goes to the iOS engineer.
    d = await p.call("GET", f"/api/workflows/{t['workflow_id']}")
    assert d["template"]["params"]["cycle_id"] == c["id"]
    # The API ticket is checked on every client the project ships.
    c = await p.call("POST", f"/api/release-cycles/{c['id']}/tickets", {"issue_number": 219})
    d = await p.call("GET", f"/api/workflows/{c['tickets'][1]['workflow_id']}")
    assert {"spec", "approve_spec", "qa_ios", "qa_android", "qa_web", "deploy_api_staging"} <= set(keys(d))


@pytest.mark.asyncio
async def test_an_ios_ticket_is_assigned_to_the_ios_engineer(client, monkeypatch):
    p = Project(client)
    monkeypatch.setattr(cycles, "_run", Git())
    c = await p.open(dry_run=False)
    c = await p.call("POST", f"/api/release-cycles/{c['id']}/tickets",
                     {"title": "Receipt shows the wrong month", "platforms": ["ios"]})
    d = await p.call("GET", f"/api/workflows/{c['tickets'][0]['workflow_id']}")
    assert keys(d)["implement"]["assignee_ids"] == [p.ios]
    c = await p.call("POST", f"/api/release-cycles/{c['id']}/tickets",
                     {"title": "Back button closes the app", "platforms": ["android"]})
    d = await p.call("GET", f"/api/workflows/{c['tickets'][1]['workflow_id']}")
    assert keys(d)["implement"]["assignee_ids"] == [p.eng]


@pytest.mark.asyncio
async def test_merged_tickets_ship_at_the_cut_and_the_rest_roll_to_the_next_branch(client):
    p = Project(client)
    c = await p.open()
    cid = c["id"]
    c = await p.call("POST", f"/api/release-cycles/{cid}/tickets", {"title": "Login spinner", "platforms": ["ios"], "issue_number": 212, "url": "https://gh/212"})
    c = await p.call("POST", f"/api/release-cycles/{cid}/tickets", {"title": "Referrals", "platforms": ["web"], "kind": "feature"})
    a, b = c["tickets"]
    assert a["word"] in {"Building", "Waiting for your merge"} and not a["merged"]

    # Nothing merged: no cut.
    await p.call("POST", f"/api/release-cycles/{cid}/cut", {"idempotency_key": uid(), "params": {"build": "9", "release_type": "manual"}}, expect=422)

    await settle(p, a["workflow_id"])                     # built, merged by you, checked on staging
    await settle(p, b["workflow_id"], approve=False)      # the spec waits for you
    c = await p.call("GET", f"/api/release-cycles/{cid}")
    a, b = c["tickets"]
    assert (a["merged"], a["checked"], a["word"], a["phase"]) == (True, True, "Ready to ship", "ready")
    assert b["phase"] == "spec"
    assert (b["merged"], b["needs_you"], b["word"]) == (False, True, "Spec waiting for you")
    assert c["counts"] == {"total": 2, "merged": 1, "checked": 1, "needs_you": 1, "building": 1}
    assert c["cut"]["ships"] == [a["id"]] and c["cut"]["rolls"] == [b["id"]] and c["cut"]["platforms"] == ["ios"]
    assert c["release_params"]["batch_summary"] == "- #212 Login spinner (bug, iOS)"

    out = await p.call("POST", f"/api/release-cycles/{cid}/cut",
                       {"idempotency_key": uid(), "params": {"build": "9", "release_type": "manual"}})
    rel = await p.call("GET", f"/api/workflows/{out['release_workflow_id']}")
    assert rel["template"]["params"]["source"] == "cycle" and rel["template"]["params"]["release_branch"] == "release/1.0.3"
    assert rel["dry_run"] is True and "merge_back" in keys(rel) and "implement" not in keys(rel)
    assert rel["title"] == "Release 1.0.3 (9)"
    cut = out["cycle"]
    assert cut["state"] == "cut" and cut["release_workflow"]["id"] == rel["id"]
    assert [t["state"] for t in cut["tickets"]] == ["shipped"]
    assert cut["counts"]["total"] == 1 and cut["counts"]["merged"] == 1

    nxt = await p.call("GET", f"/api/release-cycles/{out['next_cycle_id']}")
    assert (nxt["version"], nxt["branch"], nxt["state"]) == ("1.0.4", "release/1.0.4", "open")
    assert [t["id"] for t in nxt["tickets"]] == [b["id"]] and nxt["tickets"][0]["rolled_from_cycle_id"] == cid
    with db_cursor() as (_, cur):
        cur.execute("SELECT m.body FROM task_messages m JOIN tasks t ON t.id=m.task_id WHERE t.workflow_id=%s",
                    (b["workflow_id"],))
        notes = [r["body"] for r in cur.fetchall()]
    assert notes and all("release/1.0.4" in n and "gh pr edit" in n for n in notes)
    moved = await p.call("GET", f"/api/workflows/{b['workflow_id']}")
    assert moved["template"]["params"]["cycle_id"] == nxt["id"] and moved["template"]["params"]["release_branch"] == "release/1.0.4"

    await p.call("POST", f"/api/release-cycles/{cid}/cut", {"idempotency_key": uid()}, expect=409)
    await p.call("POST", f"/api/release-cycles/{cid}/tickets", {"title": "Late", "platforms": ["ios"]}, expect=409)

    # The board shows the cycles, not a row per ticket.
    board = await p.call("GET", f"/api/containers/{p.cid}/workflow-board")
    assert board["ticket_workflows"] == 2
    assert all(w["template"] is None or w["template"]["key"] != "release_ticket" for w in board["workflows"])
    assert {x["version"] for x in board["cycles"]} == {"1.0.3", "1.0.4"}


@pytest.mark.asyncio
async def test_a_ticket_can_be_dropped_until_it_is_merged(client):
    p = Project(client)
    c = await p.open()
    c = await p.call("POST", f"/api/release-cycles/{c['id']}/tickets", {"title": "One", "platforms": ["ios"]})
    c = await p.call("POST", f"/api/release-cycles/{c['id']}/tickets", {"title": "Two", "platforms": ["ios"]})
    one, two = c["tickets"]
    c = await p.call("POST", f"/api/release-cycles/{c['id']}/tickets/{one['id']}/drop")
    assert c["tickets"][0]["state"] == "dropped" and c["counts"]["total"] == 1
    d = await p.call("GET", f"/api/workflows/{one['workflow_id']}")
    assert d["status"] == "cancelled"
    await settle(p, two["workflow_id"])
    await p.call("POST", f"/api/release-cycles/{c['id']}/tickets/{two['id']}/drop", expect=409)


@pytest.mark.asyncio
async def test_a_ticket_without_platforms_or_title_is_refused(client, monkeypatch):
    p = Project(client)
    GitHub().install(monkeypatch)
    c = await p.open()
    await p.call("POST", f"/api/release-cycles/{c['id']}/tickets", {"title": "No platforms"}, expect=422)
    await p.call("POST", f"/api/release-cycles/{c['id']}/tickets", {"platforms": ["ios"]}, expect=422)
    await p.call("POST", f"/api/release-cycles/{c['id']}/tickets", {"issue_number": 999, "platforms": ["ios"]}, expect=422)


@pytest.mark.asyncio
async def test_a_logged_ticket_can_open_its_github_issue(client, monkeypatch):
    p = Project(client)
    monkeypatch.setattr(cycles, "_run", Git())
    gh = GitHub(milestones=("1.0.2",)).install(monkeypatch)
    c = await p.open(dry_run=False)
    out = await p.call("POST", f"/api/release-cycles/{c['id']}/tickets", {
        "title": "Payments screen freezes", "body": "Tapping Pay twice freezes it.", "platforms": ["android"],
        "create_issue": True})
    t = next(x for x in out["tickets"] if x["id"] == out["added"])
    assert (t["issue_number"], t["issue_url"]) == (240, "https://github.com/example/nyumba/issues/240")
    created = gh.created[0]
    assert "milestone" not in created  # no open 1.0.3 milestone: opened without one
    assert created["title"] == "Payments screen freezes" and "Tapping Pay twice freezes it." in created["body"]
    assert created["labels"] == ["release-1.0.3", "bug", "android", "embodent"]
    made = {l["name"]: l for l in gh.new_labels}
    assert "bug" not in made and made["release-1.0.3"]["color"] == "5b5bd6" and made["android"]["description"] == "Android app"
    d = await p.call("GET", f"/api/workflows/{t['workflow_id']}")
    assert d["title"] == "#240 Payments screen freezes"
    # Not ticked: nothing is opened on GitHub.
    await p.call("POST", f"/api/release-cycles/{c['id']}/tickets", {"title": "Quiet one", "platforms": ["ios"]})
    assert len(gh.created) == 1


@pytest.mark.asyncio
async def test_a_dry_run_never_opens_a_github_issue(client, monkeypatch):
    p = Project(client)
    gh = GitHub().install(monkeypatch)
    c = await p.open()
    out = await p.call("POST", f"/api/release-cycles/{c['id']}/tickets", {"title": "X", "platforms": ["ios"], "create_issue": True})
    assert out["notice"] == "Dry run: no issue was opened on GitHub."
    assert not gh.created


@pytest.mark.asyncio
async def test_a_hotfix_takes_the_next_patch_and_moves_the_planned_release_up(client):
    p = Project(client)
    planned = await p.open(version="1.0.2")
    planned = await p.call("POST", f"/api/release-cycles/{planned['id']}/tickets", {"title": "Referrals", "platforms": ["web"], "kind": "feature"})
    hot = await p.call("POST", f"/api/containers/{p.cid}/release-cycles", {
        "kind": "hotfix", "version": "1.0.2", "base_branch": "ios/1.0.1-7", "dry_run": True,
        "roles": {"engineer": p.eng, "release": p.rel, "qa": p.qa}})
    assert (hot["kind"], hot["branch"], hot["base_branch"]) == ("hotfix", "hotfix/1.0.2", "ios/1.0.1-7")
    moved = await p.call("GET", f"/api/release-cycles/{planned['id']}")
    assert (moved["version"], moved["branch"], moved["milestone"]) == ("1.0.3", "release/1.0.3", "1.0.3")
    d = await p.call("GET", f"/api/workflows/{moved['tickets'][0]['workflow_id']}")
    assert d["template"]["params"]["release_branch"] == "release/1.0.3"
    # One hotfix at a time; a planned release and a hotfix side by side.
    await p.call("POST", f"/api/containers/{p.cid}/release-cycles", {"kind": "hotfix", "version": "1.0.9", "dry_run": True}, expect=409)
    listed = await p.call("GET", f"/api/containers/{p.cid}/release-cycles")
    assert listed["open_dry_run"] == planned["id"] and listed["open_hotfix_dry_run"] == hot["id"]
    # The hotfix ships what's merged and hands the rest to the planned release, which stays open.
    hot = await p.call("POST", f"/api/release-cycles/{hot['id']}/tickets", {"title": "Crash on login", "platforms": ["ios"]})
    hot = await p.call("POST", f"/api/release-cycles/{hot['id']}/tickets", {"title": "Not ready", "platforms": ["ios"]})
    fix, late = hot["tickets"]
    await settle(p, fix["workflow_id"])
    hot = await p.call("GET", f"/api/release-cycles/{hot['id']}")
    assert hot["cut"]["next_branch"] == "release/1.0.3" and hot["release_params"]["next_release_branch"] == "release/1.0.3"
    out = await p.call("POST", f"/api/release-cycles/{hot['id']}/cut", {"idempotency_key": uid(), "params": {"build": "9", "release_type": "manual"}})
    assert out["next_cycle_id"] == planned["id"]
    rel = await p.call("GET", f"/api/workflows/{out['release_workflow_id']}")
    assert rel["template"]["params"]["release_branch"] == "hotfix/1.0.2" and rel["template"]["params"]["next_release_branch"] == "release/1.0.3"
    planned = await p.call("GET", f"/api/release-cycles/{planned['id']}")
    assert planned["state"] == "open" and {t["title"] for t in planned["tickets"]} == {"Referrals", "Not ready"}
    listed = await p.call("GET", f"/api/containers/{p.cid}/release-cycles")
    assert len([c for c in listed["cycles"] if c["state"] == "open"]) == 1


@pytest.mark.asyncio
async def test_moving_the_planned_release_renames_its_branch_on_github_or_changes_nothing(client, monkeypatch):
    p = Project(client)
    monkeypatch.setattr(cycles, "_run", Git())
    gh = GitHub().install(monkeypatch)
    gh.refuse_rename = True
    planned = await p.open(version="1.0.2", dry_run=False)
    await p.call("POST", f"/api/containers/{p.cid}/release-cycles", {"kind": "hotfix", "version": "1.0.2", "base_branch": "ios/1.0.1-7"}, expect=422)
    still = await p.call("GET", f"/api/release-cycles/{planned['id']}")
    assert still["version"] == "1.0.2" and still["branch"] == "release/1.0.2"
    listed = await p.call("GET", f"/api/containers/{p.cid}/release-cycles")
    assert listed["open_hotfix"] is None
    gh.refuse_rename = False
    hot = await p.call("POST", f"/api/containers/{p.cid}/release-cycles", {"kind": "hotfix", "version": "1.0.2", "base_branch": "ios/1.0.1-7"})
    assert gh.renamed == ("/repos/example/nyumba/branches/release/1.0.2/rename", {"new_name": "release/1.0.3"})
    moved = await p.call("GET", f"/api/release-cycles/{planned['id']}")
    assert moved["branch"] == "release/1.0.3" and "GitHub renamed" in moved["branch_note"]
    assert hot["branch"] == "hotfix/1.0.2" and hot["branch_state"] == "created"


@pytest.mark.asyncio
async def test_issues_carry_the_release_labels_and_move_with_their_ticket(client, monkeypatch):
    p = Project(client)
    monkeypatch.setattr(cycles, "_run", Git())
    issues = [{"number": 212, "title": "Login spinner", "body": "", "url": "https://gh/212", "labels": [{"name": "ios"}]}]
    gh = GitHub(issues).install(monkeypatch)
    c = await p.open(dry_run=False)
    # An issue already on GitHub joins: it gets the release's labels, plus what the intake proposed.
    c = await p.call("POST", f"/api/release-cycles/{c['id']}/tickets", {"issue_number": 212, "labels": ["Area: Login", "severity: major", "iOS"]})
    assert gh.labelled == [(212, ["release-1.0.3", "bug", "ios", "embodent", "area-login", "severity-major"])]
    # A hotfix takes 1.0.3: the release moves to 1.0.4, and its issues' release label moves with it.
    await p.call("POST", f"/api/containers/{p.cid}/release-cycles", {"kind": "hotfix", "version": "1.0.3", "base_branch": "ios/1.0.2-8"})
    assert (212, "release-1.0.3") in gh.unlabelled
    assert gh.labelled[-1] == (212, ["release-1.0.4"])


@pytest.mark.asyncio
async def test_a_dry_run_never_labels_anything(client, monkeypatch):
    p = Project(client)
    issues = [{"number": 212, "title": "Login spinner", "body": "", "url": "https://gh/212", "labels": []}]
    gh = GitHub(issues).install(monkeypatch)
    c = await p.open()
    await p.call("POST", f"/api/release-cycles/{c['id']}/tickets", {"issue_number": 212, "platforms": ["ios"]})
    assert not gh.labelled and not gh.new_labels
