"""GH #207 — PER-AGENT AUTONOMY OVERRIDES (mig 034) over the #298 slider (mig 021).

Two additive columns + ONE shared rule (portal_backend/autonomy.py):

    effective = container.autonomy_level              if container.autonomy_enforced
              else (agent.autonomy_override or container.autonomy_level)

The ONE engine-enforced gate (task completion) now resolves the EFFECTIVE level for the
ACTING agent (the agent marking /done); every exposure surface (get_container / /next /
wake-scan) carries the container level+enforced flag AND the per-agent effective level as
ADDITIVE fields — `autonomy_level` keeps its container meaning everywhere, so nothing
pre-034 shifts under an old consumer.

Safety floor (unchanged, and asserted here): an override can only take the SAME three enum
values the container slider already allows — it grants ONE agent what the container could
already grant EVERYONE; needs_verification stays the default; writes stay human-gated.
"""
from portal_backend.autonomy import effective_autonomy


async def _set_autonomy(client, cid, level, actor_id, *, enforced=None):
    body = {"level": level, "actor_agent_id": actor_id}
    if enforced is not None:
        body["autonomy_enforced"] = enforced
    return await client.post(f"/api/containers/{cid}/autonomy", json=body)


async def _set_override(client, aid, actor_id, value):
    return await client.patch(
        f"/api/agents/{aid}",
        json={"actor_agent_id": actor_id, "autonomy_override": value},
    )


# ---------------------------------------------------------------- the ONE shared rule (unit matrix)

def test_effective_level_truth_matrix():
    """The full inherit/override/enforced matrix of the ONE shared rule. Every consumer
    (completion gate + all exposure surfaces) routes through effective_autonomy(), so this
    matrix IS the engine contract. MUTATION: flip the enforced branch to honor the override
    (or the override branch to ignore it) and a row here goes RED."""
    for container_level in ("plan", "pr", "full"):
        # NULL override -> inherit, enforced or not (enforce is a no-op without overrides).
        assert effective_autonomy(container_level, False, None) == container_level
        assert effective_autonomy(container_level, True, None) == container_level
        for override in ("plan", "pr", "full"):
            # not enforced -> the override GOVERNS (widening AND narrowing both work) …
            assert effective_autonomy(container_level, False, override) == override
            # … enforced -> the override is IGNORED; the container level governs everyone.
            assert effective_autonomy(container_level, True, override) == container_level


# ---------------------------------------------------------------- the hard gate honors the ACTING agent

async def test_override_full_auto_completes_while_sibling_parks(
    client, container, make_agent, make_task, db, work_headers
):
    """THE feature tooth: container at 'plan', agent A overridden to 'full', sibling B inherits.
    A's /done AUTO-COMPLETES (same _complete_and_unblock path as a human verify); B's /done still
    parks at needs_verification. MUTATION: compute the gate off the container level (drop the
    per-agent resolve in task_done_routes) -> A's task parks too -> RED."""
    human = await make_agent("op", "operator", kind="human")
    a = await make_agent("ovr", "eng")
    b = await make_agent("sib", "eng")
    r = await _set_override(client, a["agent_id"], human["agent_id"], "full")
    assert r.status_code == 200, r.text

    ta = await make_task("a-work", "done", assignee_alias="ovr")
    ra = await client.post(f"/api/tasks/{ta['task_id']}/done",
                           json={"agent_id": a["agent_id"], "result": "x"},
                           headers=await work_headers(a["agent_id"]))
    assert ra.status_code == 200, ra.text
    assert ra.json()["status"] == "completed" and ra.json()["auto_completed"] is True
    rows = db.execute("SELECT status, completed_at FROM tasks WHERE id=%s", (ta["task_id"],))
    assert rows[0]["status"] == "completed" and rows[0]["completed_at"] is not None

    tb = await make_task("b-work", "done", assignee_alias="sib")
    rb = await client.post(f"/api/tasks/{tb['task_id']}/done",
                           json={"agent_id": b["agent_id"], "result": "x"},
                           headers=await work_headers(b["agent_id"]))
    assert rb.status_code == 200 and rb.json()["status"] == "needs_verification"


async def test_enforced_flips_override_back_to_container_level(
    client, container, make_agent, make_task, work_headers
):
    """The lock switch: same override='full' agent, but the container ENFORCES 'plan' -> the
    /done parks at needs_verification (override ignored). MUTATION: drop the enforced branch in
    effective_autonomy -> auto-complete -> RED."""
    human = await make_agent("op", "operator", kind="human")
    a = await make_agent("ovr", "eng")
    assert (await _set_override(client, a["agent_id"], human["agent_id"], "full")).status_code == 200
    r = await _set_autonomy(client, container["id"], "plan", human["agent_id"], enforced=True)
    assert r.status_code == 200 and r.json()["autonomy_enforced"] is True

    t = await make_task("locked", "done", assignee_alias="ovr")
    r = await client.post(f"/api/tasks/{t['task_id']}/done",
                          json={"agent_id": a["agent_id"], "result": "x"},
                          headers=await work_headers(a["agent_id"]))
    assert r.status_code == 200 and r.json()["status"] == "needs_verification"


async def test_override_narrows_a_full_container(
    client, container, make_agent, make_task, work_headers
):
    """The narrowing direction: container at 'full' but the acting agent is overridden to 'plan'
    -> its /done parks at needs_verification while the container would auto-complete. An override
    is a per-agent LEVEL, not a privilege escalator."""
    human = await make_agent("op", "operator", kind="human")
    a = await make_agent("careful", "eng")
    assert (await _set_autonomy(client, container["id"], "full", human["agent_id"])).status_code == 200
    assert (await _set_override(client, a["agent_id"], human["agent_id"], "plan")).status_code == 200

    t = await make_task("narrow", "done", assignee_alias="careful")
    r = await client.post(f"/api/tasks/{t['task_id']}/done",
                          json={"agent_id": a["agent_id"], "result": "x"},
                          headers=await work_headers(a["agent_id"]))
    assert r.status_code == 200 and r.json()["status"] == "needs_verification"


async def test_cleared_override_re_inherits(
    client, container, make_agent, make_task, work_headers
):
    """null CLEARS: after set-then-clear the agent inherits the container level again ('plan'
    parks). Distinguishes clear-to-null from omitted (the model_fields_set contract)."""
    human = await make_agent("op", "operator", kind="human")
    a = await make_agent("dev", "eng")
    assert (await _set_override(client, a["agent_id"], human["agent_id"], "full")).status_code == 200
    r = await _set_override(client, a["agent_id"], human["agent_id"], None)
    assert r.status_code == 200 and r.json()["autonomy_override"] is None

    t = await make_task("cleared", "done", assignee_alias="dev")
    r = await client.post(f"/api/tasks/{t['task_id']}/done",
                          json={"agent_id": a["agent_id"], "result": "x"},
                          headers=await work_headers(a["agent_id"]))
    assert r.status_code == 200 and r.json()["status"] == "needs_verification"


# ---------------------------------------------------------------- PATCH validation + write gates

async def test_patch_bad_override_value_is_422(client, container, make_agent, db):
    """A bad enum value is refused by the AgentUpdate schema Literal (422) BEFORE the route body
    runs — an unvalidated string must never reach the hard gate. And the DB did not move."""
    human = await make_agent("op", "operator", kind="human")
    a = await make_agent("dev", "eng")
    r = await _set_override(client, a["agent_id"], human["agent_id"], "yolo")
    assert r.status_code == 422, r.text
    rows = db.execute("SELECT autonomy_override FROM agents WHERE id=%s", (a["agent_id"],))
    assert rows[0]["autonomy_override"] is None


async def test_patch_override_on_human_target_rejected(client, container, make_agent, db):
    """Humans carry NO override (they never mark tasks done) — 400, mirroring the
    humans-carry-no-system_prompt guard. Clearing to null on a human is rejected too (one
    consistent contract)."""
    human = await make_agent("op", "operator", kind="human")
    human2 = await make_agent("op2", "operator", kind="human")
    r = await _set_override(client, human2["agent_id"], human["agent_id"], "full")
    assert r.status_code == 400, r.text
    r = await _set_override(client, human2["agent_id"], human["agent_id"], None)
    assert r.status_code == 400, r.text
    rows = db.execute("SELECT autonomy_override FROM agents WHERE id=%s", (human2["agent_id"],))
    assert rows[0]["autonomy_override"] is None


async def test_patch_override_is_human_gated(client, container, make_agent, db):
    """An AI actor cannot hand out autonomy — same human-authority gate as role/prompt edits
    (403 via require_kind). The level did NOT move."""
    ai = await make_agent("bot", "eng")
    target = await make_agent("dev", "eng")
    r = await _set_override(client, target["agent_id"], ai["agent_id"], "full")
    assert r.status_code == 403, r.text
    rows = db.execute("SELECT autonomy_override FROM agents WHERE id=%s", (target["agent_id"],))
    assert rows[0]["autonomy_override"] is None


async def test_patch_omitting_override_leaves_it_unchanged(client, container, make_agent, db):
    """OMITTING the field is 'unchanged' — a role-only PATCH never clears an override (the
    model_fields_set membership check, NOT `is not None`). MUTATION: test `is not None` in the
    route and a role edit silently wipes the override -> RED."""
    human = await make_agent("op", "operator", kind="human")
    a = await make_agent("dev", "eng")
    assert (await _set_override(client, a["agent_id"], human["agent_id"], "pr")).status_code == 200
    r = await client.patch(f"/api/agents/{a['agent_id']}",
                           json={"actor_agent_id": human["agent_id"], "role": "senior eng"})
    assert r.status_code == 200, r.text
    rows = db.execute("SELECT autonomy_override FROM agents WHERE id=%s", (a["agent_id"],))
    assert rows[0]["autonomy_override"] == "pr"


async def test_db_check_rejects_bad_override(db, container, client, make_agent):
    """Belt-and-suspenders: the mig-034 column CHECK refuses an out-of-enum value even via raw
    SQL (mirrors the mig-021 CHECK tooth)."""
    import psycopg
    a = await make_agent("dev", "eng")
    try:
        db.execute("UPDATE agents SET autonomy_override='nope' WHERE id=%s", (a["agent_id"],))
        assert False, "DB CHECK should have rejected 'nope'"
    except psycopg.errors.CheckViolation:
        pass


async def test_enforce_write_is_human_gated_and_optional(client, container, make_agent, db):
    """The enforce switch rides the SAME human-only /autonomy endpoint: an AI actor is 403 and
    nothing moves; a human flips it on and OFF; omitting the field leaves the switch unchanged
    (partial update)."""
    ai = await make_agent("bot", "eng")
    human = await make_agent("op", "operator", kind="human")
    r = await _set_autonomy(client, container["id"], "plan", ai["agent_id"], enforced=True)
    assert r.status_code == 403, r.text
    rows = db.execute("SELECT autonomy_enforced FROM containers WHERE id=%s", (container["id"],))
    assert rows[0]["autonomy_enforced"] is False          # mig-034 default: NOT enforced

    r = await _set_autonomy(client, container["id"], "pr", human["agent_id"], enforced=True)
    assert r.status_code == 200 and r.json()["autonomy_enforced"] is True
    # level-only write (enforced omitted) -> the switch stays where it was
    r = await _set_autonomy(client, container["id"], "plan", human["agent_id"])
    assert r.status_code == 200 and r.json()["autonomy_enforced"] is True
    r = await _set_autonomy(client, container["id"], "plan", human["agent_id"], enforced=False)
    assert r.status_code == 200 and r.json()["autonomy_enforced"] is False


# ---------------------------------------------------------------- exposure (additive fields, all surfaces)

async def test_get_container_exposes_enforced_and_per_agent_effective(
    client, container, make_agent
):
    """get_container carries the container's autonomy_enforced AND, per agent, the raw
    autonomy_override + server-computed effective_autonomy (the roster badge + 'acts as' label
    read these). `autonomy_level` keeps its container meaning — additive only. MUTATION: drop
    the effective_autonomy annotation loop in container_snapshot_routes -> RED."""
    human = await make_agent("op", "operator", kind="human")
    a = await make_agent("ovr", "eng")
    assert (await _set_override(client, a["agent_id"], human["agent_id"], "full")).status_code == 200
    r = await client.get(f"/api/containers/{container['id']}")
    assert r.status_code == 200
    body = r.json()
    assert body["container"]["autonomy_level"] == "plan"           # unchanged container meaning
    assert body["container"]["autonomy_enforced"] is False
    by_alias = {x["alias"]: x for x in body["agents"]}
    assert by_alias["ovr"]["autonomy_override"] == "full"
    assert by_alias["ovr"]["effective_autonomy"] == "full"         # override governs
    assert by_alias["op"]["autonomy_override"] is None
    assert by_alias["op"]["effective_autonomy"] == "plan"          # inherit

    # flip the lock: every effective level snaps to the container level; overrides still visible
    assert (await _set_autonomy(client, container["id"], "plan", human["agent_id"],
                                enforced=True)).status_code == 200
    body = (await client.get(f"/api/containers/{container['id']}")).json()
    assert body["container"]["autonomy_enforced"] is True
    by_alias = {x["alias"]: x for x in body["agents"]}
    assert by_alias["ovr"]["autonomy_override"] == "full"          # the parked override stays visible
    assert by_alias["ovr"]["effective_autonomy"] == "plan"         # …but no longer governs


async def test_next_payload_carries_enforced_and_effective(
    client, container, make_agent, make_task, work_headers
):
    """/next tells the claiming worker the level IT acts under: autonomy_level keeps the
    container meaning (pre-034 consumers unbroken) while autonomy_enforced + effective_autonomy
    ride beside it. The worker keys its advisory gh/git behavior off effective_autonomy."""
    human = await make_agent("op", "operator", kind="human")
    dev = await make_agent("dev", "eng")
    assert (await _set_override(client, dev["agent_id"], human["agent_id"], "full")).status_code == 200
    t = await make_task("loose", "done")    # unassigned -> ready
    ar = await client.post(f"/api/tasks/{t['id']}/assign",
                           json={"actor_agent_id": human["agent_id"], "agent_id": dev["agent_id"]})
    assert ar.status_code == 200, ar.text
    r = await client.post(f"/api/agents/{dev['agent_id']}/next",
                          headers=await work_headers(dev["agent_id"]))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["autonomy_level"] == "plan"        # the CONTAINER level, meaning unchanged
    assert body["autonomy_enforced"] is False
    assert body["effective_autonomy"] == "full"    # what THIS worker acts under


async def test_wake_scan_carries_enforced_and_per_candidate_effective(
    client, container, make_agent
):
    """wake-scan (the daemon's contract): scan-wide autonomy_level+autonomy_enforced, plus each
    candidate's autonomy_override + effective_autonomy — the notifier's per-candidate T2 gate
    (notifier_wake_candidate) keys off the candidate field. MUTATION: drop the builder's
    effective_autonomy -> the daemon falls back to the scan-wide level and a per-agent 'full'
    never cheap-acts -> RED here first."""
    human = await make_agent("op", "operator", kind="human")
    a = await make_agent("ovr", "eng")
    assert (await _set_override(client, a["agent_id"], human["agent_id"], "full")).status_code == 200
    r = await client.get(f"/api/containers/{container['id']}/wake-scan",
                         params={"cooldown": 0, "min_idle": 0})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["autonomy_level"] == "plan" and body["autonomy_enforced"] is False
    cand = next(c for c in body["candidates"] if c["agent_id"] == a["agent_id"])
    assert cand["autonomy_override"] == "full" and cand["effective_autonomy"] == "full"

    # enforced -> every candidate's effective level recomputes to the container level
    assert (await _set_autonomy(client, container["id"], "plan", human["agent_id"],
                                enforced=True)).status_code == 200
    body = (await client.get(f"/api/containers/{container['id']}/wake-scan",
                             params={"cooldown": 0, "min_idle": 0})).json()
    assert body["autonomy_enforced"] is True
    cand = next(c for c in body["candidates"] if c["agent_id"] == a["agent_id"])
    assert cand["effective_autonomy"] == "plan"


async def test_full_override_audit_records_resolved_level(
    client, container, make_agent, make_task, db, work_headers
):
    """The auto-complete audit row records the RESOLVED level + auto_completed (mirrors the #298
    audit tooth) so a post-hoc reviewer can see the engine auto-completed under an override while
    the container itself sat at 'plan'."""
    human = await make_agent("op", "operator", kind="human")
    a = await make_agent("ovr", "eng")
    assert (await _set_override(client, a["agent_id"], human["agent_id"], "full")).status_code == 200
    t = await make_task("audited", "done", assignee_alias="ovr")
    await client.post(f"/api/tasks/{t['task_id']}/done",
                      json={"agent_id": a["agent_id"], "result": "x"},
                      headers=await work_headers(a["agent_id"]))
    rows = db.execute(
        "SELECT detail FROM events WHERE entity_id=%s AND event_type='status_changed' ORDER BY id",
        (t["task_id"],))
    last = rows[-1]["detail"]
    assert last["to"] == "completed" and last["autonomy_level"] == "full"
    assert last["auto_completed"] is True
    rows = db.execute("SELECT autonomy_level FROM containers WHERE id=%s", (container["id"],))
    assert rows[0]["autonomy_level"] == "plan"     # the container never moved


# ---------------------------------------------------------------- portal source contracts (UI teeth)

def test_agents_page_wires_override_control_and_roster_badge():
    """The agents page carries the per-agent autonomy control (Inherit/plan/pr/full chips PATCHing
    autonomy_override with an explicit null for Inherit) and the roster override badge (lock
    glyph while the container enforces). Source-contract teeth in the page-controller style."""
    from portal_source import page_source
    src = page_source("agents.html")
    assert "autOvrSeg" in src, "agent Controls card lost the autonomy override seg"
    assert 'data-ovr="null"' in src or "o.id==null?'null'" in src, \
        "the Inherit chip must PATCH an explicit null (clear-to-inherit)"
    assert "autonomy_override: ovr" in src, "the control no longer PATCHes autonomy_override"
    assert "effective_autonomy" in src, "the control no longer surfaces the EFFECTIVE level"
    assert "ovrBadge" in src and "rovr" in src, "roster lost the override badge"
    assert "🔒" in src, "the enforced state lost its lock glyph"


def test_topbar_slider_wires_enforce_switch():
    """The shared topbar autonomy module carries the 'Enforce for all agents' chip beside the
    3-level slider, POSTing autonomy_enforced through the SAME /autonomy endpoint."""
    from portal_source import script_source
    src = script_source("app.js")
    assert "data-enforce" in src, "the enforce chip is gone from the level slider host"
    assert "autonomy_enforced" in src, "the module no longer reads/writes autonomy_enforced"
    assert src.count("autonomy_enforced:") >= 1, "no POST body carries autonomy_enforced"
