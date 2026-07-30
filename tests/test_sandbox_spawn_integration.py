# tests/test_sandbox_spawn_integration.py
"""spawn_headless in sandbox mode: wraps argv in docker run (dry-run seam),
fails loudly when preflight fails, stamps the container name into spawn_info."""
import json

from orcha_cli import notifier, sandbox


def _sandbox_project(tmp_path):
    (tmp_path / ".claude").mkdir()
    (tmp_path / ".claude" / "orcha.json").write_text(json.dumps({
        "api_base_url": "http://127.0.0.1:8000",
        "current_container_id": "CIDTEST",
        "sandbox": {"enabled": True},
    }))
    (tmp_path / ".orcha").mkdir()
    (tmp_path / ".orcha" / "docker-compose.yml").write_text("name: orcha-proj\n")
    return tmp_path


def test_dry_run_repr_shows_docker_wrap(tmp_path, monkeypatch):
    proj = _sandbox_project(tmp_path)
    monkeypatch.setattr(sandbox, "preflight", lambda cfg, ws: None)
    sent, repr_, proc = notifier.spawn_headless(str(proj), "do the task", None, True)
    assert sent is False and proc is None
    assert "docker run" in repr_ and "orcha-run-" in repr_


def test_preflight_failure_fails_wake_without_host_fallback(tmp_path, monkeypatch):
    proj = _sandbox_project(tmp_path)
    monkeypatch.setattr(sandbox, "preflight", lambda cfg, ws: "docker daemon unreachable")
    def _boom(*a, **k):
        raise AssertionError("must not spawn any process")
    monkeypatch.setattr(notifier.subprocess, "Popen", _boom)
    sent, repr_, proc = notifier.spawn_headless(str(proj), "do the task", None, False)
    assert sent is False and proc is None
    assert "sandbox unavailable" in repr_ and "docker daemon unreachable" in repr_


def test_spawn_info_carries_container_name(tmp_path, monkeypatch):
    proj = _sandbox_project(tmp_path)
    monkeypatch.setattr(sandbox, "preflight", lambda cfg, ws: None)
    info = {}
    sent, repr_, proc = notifier.spawn_headless(str(proj), "task", None, True,
                                                spawn_info=info)
    assert info["sandbox_container_id"].startswith("orcha-run-")


def test_sandbox_inner_argv_uses_bare_binary_name(tmp_path, monkeypatch):
    # Inside the runner image the binaries are `claude`/`codex` on PATH — an
    # absolute HOST path (e.g. an ORCHA_CLAUDE_EXEC override) is meaningless
    # in the container and must be replaced with the bare name.
    proj = _sandbox_project(tmp_path)
    monkeypatch.setattr(sandbox, "preflight", lambda cfg, ws: None)
    monkeypatch.setattr(notifier, "_resolve_runtime_executable",
                        lambda runtime: "/opt/host/bin/claude")
    captured = {}
    real_build = sandbox.build_docker_argv
    def _spy(inner_argv, **kw):
        captured["inner"] = list(inner_argv)
        return real_build(inner_argv, **kw)
    monkeypatch.setattr(sandbox, "build_docker_argv", _spy)
    notifier.spawn_headless(str(proj), "task", None, True)
    assert captured["inner"][0] == "claude"


def test_spawn_stamps_project_cid_label(tmp_path, monkeypatch):
    # C1 (Task-5 review): every sandbox spawn carries orcha.cid=<current_container_id>
    # (read from the project's .claude/orcha.json) so the reaper's orphan pass is
    # PROJECT-scoped — a host running two orcha stacks must never let one daemon
    # stop the other project's containers.
    proj = _sandbox_project(tmp_path)
    monkeypatch.setattr(sandbox, "preflight", lambda cfg, ws: None)
    captured = {}
    real_build = sandbox.build_docker_argv
    def _spy(inner_argv, **kw):
        captured["argv"] = real_build(inner_argv, **kw)
        return captured["argv"]
    monkeypatch.setattr(sandbox, "build_docker_argv", _spy)
    notifier.spawn_headless(str(proj), "task", None, True)
    joined = " ".join(captured["argv"])
    assert "--label orcha.cid=CIDTEST" in joined


def test_spawn_without_cid_omits_label_fails_safe(tmp_path, monkeypatch):
    # No current_container_id in orcha.json → no cid label. A cid-filtered orphan
    # pass then never SEES this container, so it can never stop it — fail-safe.
    proj = _sandbox_project(tmp_path)
    (proj / ".claude" / "orcha.json").write_text(json.dumps({
        "api_base_url": "http://127.0.0.1:8000", "sandbox": {"enabled": True}}))
    monkeypatch.setattr(sandbox, "preflight", lambda cfg, ws: None)
    captured = {}
    real_build = sandbox.build_docker_argv
    def _spy(inner_argv, **kw):
        captured["argv"] = real_build(inner_argv, **kw)
        return captured["argv"]
    monkeypatch.setattr(sandbox, "build_docker_argv", _spy)
    notifier.spawn_headless(str(proj), "task", None, True)
    assert "orcha.cid" not in " ".join(captured["argv"])


def test_sidecar_spawn_carries_sidecar_label(tmp_path, monkeypatch):
    # Task-5 REQUIREMENT: a drain-sidecar wake's container must carry the
    # orcha.sidecar=1 label (it owns no run row by design — the reaper's orphan
    # pass exempts it BY this label). A normal wake must NOT carry it.
    proj = _sandbox_project(tmp_path)
    monkeypatch.setattr(sandbox, "preflight", lambda cfg, ws: None)
    captured = {}
    real_build = sandbox.build_docker_argv
    def _spy(inner_argv, **kw):
        captured["argv"] = real_build(inner_argv, **kw)
        return captured["argv"]
    monkeypatch.setattr(sandbox, "build_docker_argv", _spy)
    notifier.spawn_headless(str(proj), "task", None, True, sandbox_sidecar=True)
    assert "orcha.sidecar=1" in captured["argv"]
    notifier.spawn_headless(str(proj), "task", None, True)
    assert "orcha.sidecar=1" not in captured["argv"]


def test_drain_sidecar_spawn_passes_sandbox_sidecar_flag(tmp_path, monkeypatch):
    # The wiring itself: _spawn_drain_sidecar (which records NO run row) must ask
    # spawn_headless for the sidecar label — otherwise the label exists but the
    # one caller that needs it never sets it.
    seen = {}
    class _Proc:
        pid = 4242
    def _spy_spawn(cwd, prompt, flags, dry_run, **kw):
        seen.update(kw)
        return True, "(spawned)", _Proc()
    monkeypatch.setattr(notifier, "spawn_headless", _spy_spawn)
    monkeypatch.setattr(notifier, "_build_persona", lambda api, aid: "persona")
    monkeypatch.setattr(notifier, "build_resident_sidecar_drain_prompt",
                        lambda alias, inbox, messages: "drain")
    r = {"agent_id": "A1", "alias": "medina", "base_cwd": str(tmp_path)}
    assert notifier._spawn_drain_sidecar("http://x", r, 3, quiet=True) is True
    assert seen.get("sandbox_sidecar") is True


def test_repr_never_leaks_prompt_or_persona(tmp_path, monkeypatch):
    # The repr lands in woke records and dry-run output — like the host-mode
    # reprs it must use a <prompt> placeholder, never the payload itself.
    proj = _sandbox_project(tmp_path)
    monkeypatch.setattr(sandbox, "preflight", lambda cfg, ws: None)
    secret = "XyLONGDISTINCTIVEPROMPTPAYLOADzz " * 5
    sent, repr_, proc = notifier.spawn_headless(
        str(proj), secret, None, True,
        system_prompt="PERSONAxDIGESTxPAYLOAD")
    assert "XyLONGDISTINCTIVEPROMPTPAYLOADzz" not in repr_
    assert "PERSONAxDIGESTxPAYLOAD" not in repr_
    assert "docker run" in repr_
    assert sandbox.DEFAULT_IMAGE in repr_
    assert "orcha-run-" in repr_


def test_dry_run_writes_nothing_into_project(tmp_path, monkeypatch):
    proj = _sandbox_project(tmp_path)
    before = {str(p) for p in proj.rglob("*")}
    monkeypatch.setattr(sandbox, "preflight", lambda cfg, ws: None)
    notifier.spawn_headless(str(proj), "task", None, True)
    assert not (proj / ".orcha" / "sandbox").exists()
    assert {str(p) for p in proj.rglob("*")} == before


def test_api_config_write_failure_fails_wake_without_popen(tmp_path, monkeypatch):
    proj = _sandbox_project(tmp_path)
    monkeypatch.setattr(sandbox, "preflight", lambda cfg, ws: None)
    def _oserr(*a, **k):
        raise OSError("read-only filesystem")
    monkeypatch.setattr(sandbox, "write_api_config", _oserr)
    def _boom(*a, **k):
        raise AssertionError("must not spawn any process")
    monkeypatch.setattr(notifier.subprocess, "Popen", _boom)
    sent, repr_, proc = notifier.spawn_headless(str(proj), "task", None, False)
    assert sent is False and proc is None
    assert "sandbox unavailable" in repr_ and "api config" in repr_


class _FakeProc:
    """Popen stand-in: poll() returns the exit code once exited (mirrors the
    daemon's reap detection)."""
    def __init__(self, exited=True):
        self.pid = 4321
        self.returncode = 0 if exited else None
    def poll(self):
        return self.returncode
    def kill(self):
        self.returncode = -9
    def wait(self, timeout=None):
        return self.returncode


def _sandbox_reap_fakes(monkeypatch):
    calls = {"remove": [], "remove_api_config": []}
    monkeypatch.setattr(notifier._sandbox, "remove",
                        lambda n, force=False: calls["remove"].append((n, force)))
    monkeypatch.setattr(notifier._sandbox, "remove_api_config",
                        lambda cwd, n: calls["remove_api_config"].append((str(cwd), n)))
    return calls


def test_completed_sandbox_wake_reaps_container_and_api_config(tmp_path, monkeypatch):
    # I4 (Task-5 review): the COMMON completion path — reap_workers poll()s the
    # docker-run client and stamps the row — must also remove the container
    # (spawned without --rm by design) and its per-run api-config, or every
    # completed sandbox wake leaks an exited container.
    calls = _sandbox_reap_fakes(monkeypatch)
    posts = []
    monkeypatch.setattr(notifier, "_post_json",
                        lambda u, b=None, **k: posts.append((u, b)) or {})
    live = {"agent-X": {"proc": _FakeProc(exited=True), "hard_deadline": 0,
                        "run_id": "RUN-1", "log_path": None, "worktree": None,
                        "base_cwd": str(tmp_path),
                        "sandbox_container_id": "orcha-run-w1"}}
    notifier.reap_workers("http://x", live, quiet=True)
    assert any("/runs/RUN-1/finish" in u for u, _ in posts)   # stamped...
    # ...then FORCE-removed (pre-dogfood fix 2: kill paths reach here with the
    # container possibly still running — plain rm would fail and leak it)
    assert calls["remove"] == [("orcha-run-w1", True)]
    assert calls["remove_api_config"] == [(str(tmp_path), "orcha-run-w1")]


def test_completed_host_wake_never_calls_docker_remove(tmp_path, monkeypatch):
    calls = _sandbox_reap_fakes(monkeypatch)
    monkeypatch.setattr(notifier, "_post_json", lambda u, b=None, **k: {})
    live = {"agent-X": {"proc": _FakeProc(exited=True), "hard_deadline": 0,
                        "run_id": "RUN-1", "log_path": None, "worktree": None}}
    notifier.reap_workers("http://x", live, quiet=True)
    assert calls["remove"] == [] and calls["remove_api_config"] == []


def test_completed_sandbox_wake_keeps_container_when_finish_post_fails(tmp_path, monkeypatch):
    # I5 x I4: the stamp did NOT land → the exited container is the only evidence
    # of the run's outcome. Do NOT remove it; the container sweep re-observes the
    # exited state and re-stamps next tick.
    calls = _sandbox_reap_fakes(monkeypatch)
    monkeypatch.setattr(notifier, "_post_json", lambda u, b=None, **k: None)
    live = {"agent-X": {"proc": _FakeProc(exited=True), "hard_deadline": 0,
                        "run_id": "RUN-1", "log_path": None, "worktree": None,
                        "base_cwd": str(tmp_path),
                        "sandbox_container_id": "orcha-run-w1"}}
    notifier.reap_workers("http://x", live, quiet=True)
    assert calls["remove"] == [] and calls["remove_api_config"] == []


def test_host_mode_untouched(tmp_path):
    (tmp_path / ".claude").mkdir()
    (tmp_path / ".claude" / "orcha.json").write_text(json.dumps(
        {"api_base_url": "http://127.0.0.1:8000"}))
    sent, repr_, proc = notifier.spawn_headless(str(tmp_path), "task", None, True)
    assert "docker run" not in repr_
