"""The proof pack and the release page's read model (Mobile App Release §4.3, §4.4, §5).

Assembled on read from what the run recorded: each QA step's latest round (its request's
result: scenarios, verdicts, frames, findings), the build under test, coverage per platform,
watch readings, people's decisions, and the timeline. Honest by construction:
- a step's headline is its LATEST round, so "3 of 3 passed after a fix" never reads "failed";
- a finding that was fixed and verified says so;
- a failure, a blocked check or a skipped scenario is listed with its reason, never folded away.
"""

from __future__ import annotations

import hashlib
import json

from portal_backend import workflow_steps as steps

PLATFORM_WORD = {"ios": "iOS", "android": "Android", "web": "Web", "api": "API"}
VERDICT = {"pass": "passed", "passed": "passed", "fail": "failed", "failed": "failed",
           "blocked": "blocked", "inconclusive": "blocked", "skip": "skipped", "skipped": "skipped"}


def _j(value, default=None):
    loaded = steps._load(value)
    return default if loaded is None else loaded


def _qa_result(cur, task) -> dict | None:
    cur.execute(
        "SELECT id, kind, platform, status, round, result, build, created_at, finished_at "
        "FROM qa_requests WHERE qa_task_id=%s ORDER BY created_at DESC LIMIT 1",
        (task["id"],),
    )
    row = cur.fetchone()
    return dict(row) if row else None


def _reported(cur, tid, revision):
    cur.execute(
        "SELECT outcome_name, findings, note, reporter_kind, reported_at FROM workflow_outcome_reports "
        "WHERE task_id=%s ORDER BY reported_at DESC",
        (tid,),
    )
    rows = [dict(r) for r in cur.fetchall()]
    return rows


def _rounds(cur, tid) -> int:
    cur.execute("SELECT count(*) AS n FROM workflow_outcome_reports WHERE task_id=%s", (tid,))
    return int(cur.fetchone()["n"] or 0)


def qa_step_view(svc, w, task) -> dict:
    """One QA step: scope, build under test, counts, failures with reasons, frames, its latest
    round's word, and the rounds it took."""
    cur = svc.cur
    spec = steps.spec_of(task) or {}
    qa = _j(task.get("qa_step"), {}) or {}
    platform = qa.get("platform") or next(iter(spec.get("platforms") or []), None)
    req = _qa_result(cur, task)
    reports = _reported(cur, task["id"], task["work_revision"])
    latest = reports[0] if reports else None
    counts = {"passed": 0, "failed": 0, "blocked": 0, "skipped": 0}
    failures, frames, scenarios = [], [], []
    if req and req.get("result"):
        result = _j(req["result"], {}) or {}
        for s in result.get("scenarios") or []:
            word = VERDICT.get(str(s.get("verdict") or "").lower(), "blocked" if s.get("verdict") else "skipped")
            counts[word] += 1
            ids = [str(x) for x in s.get("frame_ids") or []]
            scenarios.append({"name": s.get("name"), "verdict": word, "note": s.get("note"), "frame_ids": ids[:6]})
            frames.extend({"id": x, "caption": s.get("name") or ""} for x in ids[:2])
            if word in {"failed", "blocked"}:
                failures.append({"title": s.get("name"), "verdict": word,
                                 "reason": s.get("note") or ("No verdict came back." if word == "blocked" else ""),
                                 "frame_ids": ids[:3]})
        for f in result.get("findings") or []:
            if isinstance(f, dict):
                failures.append({"title": f.get("title"), "verdict": "finding", "severity": f.get("severity"),
                                 "reason": f.get("actual") or "", "frame_ids": [str(x) for x in f.get("frame_ids") or []][:3]})
    elif latest:
        # A dry run, or a person recorded the outcome: the report's own findings are the proof.
        for f in steps._load(latest.get("findings")) or []:
            failures.append({"title": f.get("text"), "verdict": "finding", "severity": f.get("severity"), "reason": ""})
        if latest["outcome_name"] in {"pass", "clear", "drafted"}:
            counts["passed"] = max(1, counts["passed"])
        elif latest["outcome_name"] in {"fail", "fix"}:
            counts["failed"] = max(1, len(failures))
    build = spec.get("build") or (_j(req.get("build")) if req else None)
    status = task["status"]
    word = (
        "not run" if task.get("route_state") == "not_selected" else
        "waiting" if status in {"pending", "not_ready"} else
        "running" if status in {"ready", "in_progress"} else
        "awaiting review" if status == "needs_verification" else
        {"pass": "passed", "fail": "failed", "clear": "clear", "fix": "fix sent back",
         "drafted": "drafted", "gaps": "gaps"}.get(latest["outcome_name"], latest["outcome_name"]) if latest
        else status.replace("_", " ")
    )
    return {
        "task_id": task["id"], "title": task["title"], "platform": platform,
        "scope": spec.get("scope"), "kind": qa.get("kind"), "status": status, "word": word,
        "outcome": latest["outcome_name"] if latest else None,
        "rounds": _rounds(cur, task["id"]),
        "build": build, "counts": counts, "failures": failures[:30], "scenarios": scenarios[:80],
        "frames": frames[:12], "request_id": str(req["id"]) if req else None,
        "request_status": req["status"] if req else None,
        "summary": (_j(req["result"], {}) or {}).get("summary") if req and req.get("result") else
        (latest["note"] if latest else None),
        "dry_run": bool(w.get("dry_run")),
    }


def coverage(cur, cid, platforms, threshold) -> list[dict]:
    out = []
    for p in platforms:
        if p == "api":
            continue
        cur.execute(
            "SELECT status, count(*) AS n FROM qa_scenarios WHERE container_id=%s AND platform=%s GROUP BY status",
            (cid, p),
        )
        by = {r["status"]: int(r["n"]) for r in cur.fetchall()}
        validated = by.get("validated", 0)
        out.append({"platform": p, "validated": validated, "draft": by.get("draft", 0),
                    "paused": by.get("paused", 0), "threshold": threshold,
                    "warn": threshold > 0 and validated < threshold})
    return out


def findings(cur, wid) -> dict:
    """Findings from this run's QA requests, with their fix lifecycle."""
    try:
        cur.execute(
            "SELECT f.id, f.title, f.severity, f.status, f.lifecycle, f.fixed_ref, f.frame_ids, r.platform "
            "FROM qa_findings f JOIN qa_requests r ON r.id=f.request_id "
            "WHERE r.source_workflow_id=%s ORDER BY f.created_at",
            (wid,),
        )
        rows = [dict(r) for r in cur.fetchall()]
    except Exception:  # noqa: BLE001 - the Quality schema may predate these joins
        rows = []
    def state(f):
        if f["status"] == "dismissed":
            return "dismissed"
        return f.get("lifecycle") or ("filed" if f["status"] == "filed" else "open")
    for f in rows:
        f["state"] = state(f)
        f["id"] = str(f["id"])
        f["frame_ids"] = [str(x) for x in (_j(f.get("frame_ids"), []) or [])][:4]
    tally = {}
    for f in rows:
        tally[f["state"]] = tally.get(f["state"], 0) + 1
    return {"items": rows[:100], "tally": tally}


def build(svc, wid, gate_tid: str | None = None) -> dict:
    """The release page's read model; with `gate_tid`, the proof pack that gate shows."""
    s = svc.snapshot(wid)
    w = s["workflow"]
    cur = svc.cur
    template = steps.template_of(w) or {}
    params = template.get("params") or {}
    tasks = list(s["tasks"].values())
    gate = s["tasks"].get(gate_tid) if gate_tid else None
    gate_spec = (steps.spec_of(gate) or {}).get("gate") if gate else None
    wanted = None
    if gate_spec and gate_spec.get("proof_steps"):
        wanted = set(gate_spec["proof_steps"])
    qa_tasks = [t for t in tasks if steps.kind_of(t) == "qa" and (_j(t.get("qa_step"), {}) or {}).get("kind") == "check"]
    if wanted:
        qa_tasks = [t for t in qa_tasks if (steps.spec_of(t) or {}).get("key") in wanted] or qa_tasks
    by_platform: dict[str, list] = {}
    for t in qa_tasks:
        view = qa_step_view(svc, w, t)
        by_platform.setdefault(view["platform"] or "other", []).append(view)
    platforms = params.get("platforms") or sorted(p for p in by_platform if p in PLATFORM_WORD)
    threshold = int(params.get("coverage_threshold") or 0)
    cover = {c["platform"]: c for c in coverage(cur, w["container_id"], platforms, threshold)}
    commits = {}
    pack = []
    for p in [*platforms, *[x for x in by_platform if x not in platforms]]:
        views = by_platform.get(p, [])
        full = [v for v in views if v["scope"] == "full"]
        headline = (full or views or [None])[0]
        totals = {"passed": 0, "failed": 0, "blocked": 0, "skipped": 0}
        for v in (full or views):
            for k in totals:
                totals[k] += v["counts"][k]
        for v in views:
            if v.get("build") and v["build"].get("commit"):
                commits.setdefault(v["build"]["commit"], []).append(v["title"])
        pack.append({
            "platform": p, "word": PLATFORM_WORD.get(p, p.title()), "steps": views,
            "headline": headline["word"] if headline else "no QA step",
            "totals": totals, "coverage": cover.get(p),
            "checked": bool(views),
        })
    unit_only = [
        {"task_id": t["id"], "title": t["title"]}
        for t in tasks
        if steps.kind_of(t) == "agent" and set((steps.spec_of(t) or {}).get("platforms") or []) & {"api"}
        and t.get("route_state") != "not_selected"
    ] if (gate_spec or {}).get("include_unit_only", True) else []
    decisions = [
        {"task_id": h["task_id"], "event": h["event"], "by": h["actor_alias"], "at": h["created_at"],
         "detail": _j(h["detail"], {})}
        for h in svc.rows(
            "SELECT * FROM workflow_history WHERE workflow_id=%s AND event IN "
            "('workflow_outcome_reported','workflow_route_applied','workflow_started','workflow_completed') "
            "ORDER BY created_at, id",
            (wid,),
        )
    ]
    watches = []
    for t in tasks:
        if steps.kind_of(t) == "watch":
            watches.append({"task_id": t["id"], "title": t["title"],
                            "platforms": (steps.spec_of(t) or {}).get("platforms") or [],
                            **steps.watch_view(cur, t)})
    warnings = []
    for p in pack:
        if p["coverage"] and p["coverage"]["warn"]:
            warnings.append(f"{p['word']} has {p['coverage']['validated']} validated scenarios, below {threshold}.")
        if not p["checked"] and p["platform"] != "api":
            warnings.append(f"{p['word']} has no QA step in this release.")
        if any(v["status"] != "completed" for v in p["steps"]):
            warnings.append(f"{p['word']}: a QA step hasn't finished.")
    if len(commits) > 1:
        warnings.append("QA ran on more than one commit: " + ", ".join(c[:10] for c in commits) + ".")
    last_go = svc.one(
        "SELECT created_at FROM workflow_history WHERE workflow_id=%s AND event='workflow_route_applied' "
        "AND task_id=%s ORDER BY created_at DESC LIMIT 1",
        (wid, gate_tid),
    ) if gate_tid else None
    changed = []
    if last_go:
        for r in svc.rows(
            "SELECT h.task_id, h.event, h.detail, t.title FROM workflow_history h JOIN tasks t ON t.id=h.task_id "
            "WHERE h.workflow_id=%s AND h.created_at>%s AND h.event='workflow_outcome_reported' ORDER BY h.created_at",
            (wid, last_go["created_at"]),
        ):
            changed.append({"task_id": r["task_id"], "title": r["title"],
                            "outcome": (_j(r["detail"], {}) or {}).get("outcome")})
    body = {
        "workflow_id": wid, "gate_task_id": gate_tid, "title": w["title"], "dry_run": bool(w.get("dry_run")),
        "params": {k: params.get(k) for k in ("version", "build", "release_type", "android_rollout",
                                              "qa_target_env", "platforms") if k in params},
        "platforms": pack, "findings": findings(cur, wid), "unit_only": unit_only,
        "watches": watches, "decisions": decisions[-60:], "warnings": warnings,
        "changed_since_last": changed, "commits": sorted(commits),
    }
    body["digest"] = hashlib.sha256(json.dumps(body, sort_keys=True, default=str).encode()).hexdigest()[:16]
    return body
