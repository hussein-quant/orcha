# orcha-cli/orcha_cli/sandbox.py
"""Sandbox wake execution — spec docs/superpowers/specs/2026-07-29-orcha-cloud-remote-runner-design.md.

Pure functions that translate a headless wake's argv/env into `docker run`.
The notifier keeps its Popen contract untouched: the foreground `docker run`
client lives as long as the container and exits with its exit code.

HARD RULE (spec §3.2): if Docker is unavailable the wake FAILS with a visible
reason. There is no fallback to a host process.
"""
from __future__ import annotations

import datetime
import json
import pathlib
import re
import shutil
import subprocess
import uuid
from dataclasses import dataclass
from typing import Optional, Sequence

DEFAULT_IMAGE = "orcha/runner:0.5"
DEFAULT_MEMORY = "4g"
DEFAULT_CPUS = "2"
DEFAULT_PIDS = 512
DEFAULT_MAX_RUNTIME_SECS = 7200
MIN_FREE_DISK_GB = 5
LABEL_MANAGED = "orcha.managed=1"
# Task-5 REQUIREMENT (plan "Tracked follow-ups"): a drain sidecar's sandbox
# container carries this label. Sidecars own NO worker_runs row by design
# (Kedar-locked no-lease invariant), so the reaper's orphan pass must be able
# to tell them apart from a genuinely orphaned run container.
LABEL_SIDECAR = "orcha.sidecar=1"
# C1 (Task-5 review): the PROJECT-identity label key. Every sandbox spawn stamps
# `orcha.cid=<current_container_id>` so a host running several orcha stacks (the
# dev machine runs two!) never lets one daemon's orphan pass stop another
# project's live run containers — managed_containers() filters on it server-side.
LABEL_CID_KEY = "orcha.cid"

# Secrets and identity ride the CLIENT env (docker inherits `-e KEY` values from
# the client process), never argv — `ps` must not show tokens (spec §3.5).
ENV_PASSTHROUGH = (
    "ORCHA_ALIAS", "ORCHA_RUN_TOKEN", "ORCHA_AGENT_RUNTIME",
    "ORCHA_HEADLESS_WORKER", "ORCHA_CONVERSATION_WORKER",
    "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "ORCHA_LLM_API_KEY",
)


def _int_field(raw: dict, key: str, default: int) -> int:
    try:
        return int(raw.get(key, default))
    except (TypeError, ValueError):
        return default


@dataclass(frozen=True)
class SandboxConfig:
    enabled: bool = False
    image: str = DEFAULT_IMAGE
    memory: str = DEFAULT_MEMORY
    cpus: str = DEFAULT_CPUS
    pids_limit: int = DEFAULT_PIDS
    network: Optional[str] = None            # explicit override; else derived
    max_runtime_secs: int = DEFAULT_MAX_RUNTIME_SECS

    @staticmethod
    def load(project_dir: str | pathlib.Path) -> "SandboxConfig":
        cfg_path = pathlib.Path(project_dir) / ".claude" / "orcha.json"
        try:
            raw = json.loads(cfg_path.read_text()).get("sandbox") or {}
        except (OSError, ValueError, AttributeError):
            return SandboxConfig()
        if not isinstance(raw, dict):
            return SandboxConfig()
        image = str(raw.get("image", DEFAULT_IMAGE))
        if image.startswith("-"):
            # A leading-dash "image" would be parsed as a docker CLI flag —
            # argument injection from a repo-supplied orcha.json. Ignore it.
            image = DEFAULT_IMAGE
        return SandboxConfig(
            enabled=bool(raw.get("enabled", False)),
            image=image,
            memory=str(raw.get("memory", DEFAULT_MEMORY)),
            cpus=str(raw.get("cpus", DEFAULT_CPUS)),
            pids_limit=_int_field(raw, "pids_limit", DEFAULT_PIDS),
            network=str(raw["network"]) if raw.get("network") else None,
            max_runtime_secs=_int_field(raw, "max_runtime_secs", DEFAULT_MAX_RUNTIME_SECS),
        )


def compose_network(project_dir: str | pathlib.Path) -> Optional[str]:
    """The stack's default network: `<compose name>_default`, read from the
    `name:` line of .orcha/docker-compose.yml (rendered by `orcha init`)."""
    f = pathlib.Path(project_dir) / ".orcha" / "docker-compose.yml"
    try:
        for line in f.read_text().splitlines():
            if line.startswith("name:"):
                return line.split(":", 1)[1].strip() + "_default"
    except OSError:
        pass
    return None


def new_container_name() -> str:
    return "orcha-run-" + uuid.uuid4().hex[:12]


def write_api_config(project_dir: str | pathlib.Path, name: str) -> str:
    """A sandbox-scoped copy of .claude/orcha.json with api_base_url rewritten
    to the in-network portal address. Bind-mounted read-only OVER the workspace
    copy so skills inside the container reach the portal without mutating any
    shared file (the host copy points at the host-published localhost port,
    which is unreachable from inside a container — spec §3.3b)."""
    project_dir = pathlib.Path(project_dir)
    cfg = json.loads((project_dir / ".claude" / "orcha.json").read_text())
    cfg["api_base_url"] = "http://portal:8000"
    out_dir = project_dir / ".orcha" / "sandbox"
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / f"{name}.json"
    out.write_text(json.dumps(cfg, indent=2))
    return str(out)


def build_docker_argv(inner_argv: "Sequence[str]", *, cfg: SandboxConfig, name: str,
                      workspace: str, network: Optional[str],
                      api_config_mount: str,
                      extra_labels: "Sequence[str]" = ()) -> "list[str]":
    argv = [
        "docker", "run",
        "--name", name,
        "--label", LABEL_MANAGED,
        "--label", f"orcha.container_name={name}",
    ]
    # e.g. LABEL_SIDECAR for a drain sidecar — the reaper's orphan exemption.
    for label in extra_labels:
        argv += ["--label", label]
    argv += [
        "--memory", cfg.memory,
        "--cpus", cfg.cpus,
        "--pids-limit", str(cfg.pids_limit),
        "-v", f"{workspace}:/workspace",
        "-v", f"{api_config_mount}:/workspace/.claude/orcha.json:ro",
        "-w", "/workspace",
    ]
    if network:
        argv += ["--network", network]
    for key in ENV_PASSTHROUGH:
        argv += ["-e", key]
    argv.append(cfg.image)
    argv.extend(inner_argv)
    return argv


def _free_disk_gb(path: str | pathlib.Path) -> float:
    try:
        usage = shutil.disk_usage(str(path))
    except OSError:
        # A vanished/unstatable workspace reads as 0 GiB free → the preflight
        # disk check fails loudly, which is the correct contract.
        return 0.0
    return usage.free / (1024 ** 3)


def _docker(args: list[str], timeout: int = 10) -> subprocess.CompletedProcess:
    """Run a docker CLI command; a hung daemon yields a FAILED result, never an
    exception — so `preflight` can only ever return a reason string."""
    try:
        return subprocess.run(["docker", *args], capture_output=True, text=True,
                              timeout=timeout)
    except subprocess.TimeoutExpired:
        return subprocess.CompletedProcess(args=["docker", *args], returncode=124,
                                           stdout="", stderr="timed out")
    except OSError as e:
        # docker binary missing/unexecutable. The reaper helpers below (probe /
        # stop / remove / managed_containers) run OUTSIDE preflight's which()
        # guard — every daemon tick, host-mode machines included — and must
        # observe "nothing", never raise.
        return subprocess.CompletedProcess(args=["docker", *args], returncode=127,
                                           stdout="", stderr=str(e))


def preflight(cfg: SandboxConfig, workspace: str) -> Optional[str]:
    """None = good to spawn; otherwise a human-readable reason. The caller
    MUST fail the wake on a reason — de-sandboxing is never an error path."""
    if shutil.which("docker") is None:
        return "docker CLI not installed on this host"
    info = _docker(["info", "--format", "{{.ServerVersion}}"])
    if info.returncode != 0:
        return f"docker daemon unreachable: {(info.stderr or '').strip()[:200]}"
    img = _docker(["image", "inspect", cfg.image, "--format", "ok"], timeout=15)
    if img.returncode == 124:
        # Tracked follow-up (Task 3 review): a HUNG daemon on image inspect is
        # not a missing image — `docker pull` advice would be actively wrong.
        return "docker daemon not responding (image inspect timed out)"
    if img.returncode != 0:
        return (f"runner image {cfg.image} not present — "
                f"run `docker pull {cfg.image}` (or `orcha sandbox build-image`)")
    if _free_disk_gb(workspace) < MIN_FREE_DISK_GB:
        return (f"insufficient disk: less than {MIN_FREE_DISK_GB} GiB free "
                f"on the workspace volume")
    return None


# ---------- Task 5: the reaper's sweep helpers (spec §3.3c + §3.5) ----------
# Containers run detached and OUTLIVE the daemon's Popen handle; these helpers
# are the notifier sweep's only view of them. None of them ever raises — a
# docker hiccup on one container must never abort the sweep for the rest.


@dataclass(frozen=True)
class SandboxState:
    running: bool
    exit_code: Optional[int]
    oom_killed: bool
    started_at: Optional[str]        # RFC3339 from docker inspect


def probe(name: str) -> Optional[SandboxState]:
    """State of one managed container; None if docker errors or it's gone."""
    out = _docker(["inspect", name], timeout=10)
    if out.returncode != 0:
        return None
    try:
        state = json.loads(out.stdout)[0]["State"]
    except (ValueError, KeyError, IndexError, TypeError):
        return None
    if not isinstance(state, dict):
        return None
    return SandboxState(
        running=state.get("Status") == "running",
        exit_code=None if state.get("Status") == "running" else state.get("ExitCode"),
        oom_killed=bool(state.get("OOMKilled")),
        started_at=state.get("StartedAt"),
    )


def _parse_started_at(ts: str) -> Optional[datetime.datetime]:
    """RFC3339 from docker inspect → aware datetime, or None. I3 (Task-5 review):
    docker emits NANOSECOND fractions (9 digits, e.g. .123456789Z); Python ≤3.10's
    fromisoformat accepts only 3/6 digits, so the deadline would silently never
    fire — truncate the fraction to microseconds before parsing."""
    ts = ts.replace("Z", "+00:00")
    m = re.match(r"^(.*T\d{2}:\d{2}:\d{2})\.(\d+)(.*)$", ts)
    if m:
        ts = f"{m.group(1)}.{m.group(2)[:6]}{m.group(3)}"
    try:
        parsed = datetime.datetime.fromisoformat(ts)
    except ValueError:
        return None
    if parsed.tzinfo is None:                    # offset-less input → assume UTC
        parsed = parsed.replace(tzinfo=datetime.timezone.utc)
    return parsed


def past_deadline(state: Optional[SandboxState], *, max_runtime_secs: int) -> bool:
    """Runaway check (spec §3.5): a RUNNING container older than the workspace's
    max-runtime deadline. Exited/gone/unparseable states are never past-deadline
    (there is nothing left to stop)."""
    if state is None or not state.running or not state.started_at:
        return False
    started = _parse_started_at(state.started_at)
    if started is None:
        return False
    age = (datetime.datetime.now(datetime.timezone.utc) - started).total_seconds()
    return age > max_runtime_secs


def stop(name: str) -> None:
    _docker(["stop", "--time", "20", name], timeout=40)


def remove(name: str, force: bool = False) -> None:
    # NEVER pass -v: workspace volumes are durable state (spec §3.5).
    # `force` → `docker rm -f` (SIGKILL + rm): for callers whose container may
    # still be RUNNING with nothing left to preserve — a killed drain sidecar is
    # row-less AND orphan-exempt, so a plain rm failing there would leak an
    # immortal running container that nothing else ever stops. Only safe
    # post-stamp or for row-less sidecars; the sweep's exited path stays plain.
    _docker(["rm", "-f", name] if force else ["rm", name], timeout=15)


def remove_api_config(project_dir: str | pathlib.Path, name: str) -> None:
    """Reap the per-run api-config file write_api_config left behind (plan
    follow-up: one .orcha/sandbox/<name>.json per wake accretes forever)."""
    try:
        (pathlib.Path(project_dir) / ".orcha" / "sandbox" / f"{name}.json").unlink(missing_ok=True)
    except OSError:
        pass


def daemon_reachable() -> bool:
    """C2 (Task-5 review): the sweep's per-tick docker-daemon gate — one cheap
    `docker info` (mirroring preflight's call). When this is False, a probe's None
    means UNKNOWN, not vanished: the sweep must reconcile nothing that tick, or a
    daemon outage mass-kills every in-flight sandbox run as 'vanished'."""
    return _docker(["info", "--format", "{{.ServerVersion}}"], timeout=10).returncode == 0


def managed_containers(cid: str) -> "list[str]":
    """Names of THIS project's live managed run containers — scoped by the
    `orcha.cid=<cid>` label (C1: a host running several orcha stacks must never
    let one daemon's orphan pass stop another project's runs) and EXCLUDING drain
    sidecars (they own no worker_runs row by design — the Kedar-locked no-lease
    invariant — and must never be treated as orphans). `docker ps` has no negative
    label filter, so list managed+cid containers WITH their labels and drop
    sidecar lines client-side."""
    out = _docker(["ps", "--filter", f"label={LABEL_MANAGED}",
                   "--filter", f"label={LABEL_CID_KEY}={cid}",
                   "--format", "{{.Names}}\t{{.Labels}}"], timeout=10)
    if out.returncode != 0:
        return []
    names: list[str] = []
    for line in out.stdout.splitlines():
        if not line.strip():
            continue
        name, _, labels = line.partition("\t")
        if LABEL_SIDECAR in labels.split(","):
            continue
        if name.strip():
            names.append(name.strip())
    return names
