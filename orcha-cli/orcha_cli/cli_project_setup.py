"""Provide filesystem, network, secret, and Compose setup primitives for projects."""

from __future__ import annotations

import ipaddress
import os
import pathlib
import re
import secrets
import shutil
import socket
import subprocess
from typing import Callable, Optional


MASTER_KEY_ENV = "ORCHA_SECRET_KEY"
PAIRING_HOST_ENV = "ORCHA_PAIRING_HOST"

# GitHub auto-bind (project-runtime epic): recognise origin remotes that point at
# github.com in every shape git writes them — https (with optional creds/`.git`),
# scp-style ssh (git@github.com:o/r.git), and ssh://git@github.com/o/r. The captured
# owner/name must satisfy the portal's ContainerGithubBinding pattern
# (^[\w.-]+/[\w.-]+$), so the segments here use the same character class.
_GITHUB_ORIGIN_RE = re.compile(r"github\.com[:/]([\w.-]+)/([\w.-]+?)(?:\.git)?/?$")


def parse_github_origin(url: str) -> Optional[str]:
    """Return ``owner/name`` when a git remote URL points at github.com, else None."""
    match = _GITHUB_ORIGIN_RE.search((url or "").strip())
    if not match:
        return None
    owner, name = match.group(1), match.group(2)
    return f"{owner}/{name}" if owner and name else None


def detect_github_repo(project_root: pathlib.Path) -> Optional[str]:
    """Read the checkout's ``origin`` remote and map it to owner/name (None if not GitHub).

    Any failure — not a git repo, no origin remote, git missing — resolves to None:
    auto-bind is best-effort sugar, never a reason for `orcha init` to fail.
    """
    try:
        result = subprocess.run(
            ["git", "-C", str(project_root), "remote", "get-url", "origin"],
            capture_output=True,
            text=True,
            timeout=5.0,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if result.returncode != 0:
        return None
    return parse_github_origin(result.stdout)


def find_free_port(start: int, span: int = 100) -> int:
    """Return the first loopback port that can be bound in the requested range."""
    for port in range(start, start + span):
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
                sock.bind(("127.0.0.1", port))
                return port
        except OSError:
            continue
    raise SystemExit(f"error: no free port in range {start}..{start + span}")


def copy_tree(src, dst: pathlib.Path) -> None:
    """Recursively copy an importlib Traversable into a filesystem directory."""
    dst.mkdir(parents=True, exist_ok=True)
    for item in src.iterdir():
        if item.name == "node_modules":   # frontend dev deps — never part of a stack
            continue
        target = dst / item.name
        if item.is_dir():
            copy_tree(item, target)
        else:
            target.write_bytes(item.read_bytes())


def install_skill_templates(
    project_root: pathlib.Path,
    templates,
    codex_skill_body: Callable[[str, str], str],
) -> tuple[pathlib.Path, pathlib.Path]:
    """Install packaged Orcha commands for both Claude Code and Codex."""
    claude_commands = project_root / ".claude" / "commands"
    codex_skills = project_root / ".agents" / "skills"
    claude_commands.mkdir(parents=True, exist_ok=True)
    codex_skills.mkdir(parents=True, exist_ok=True)
    for md_file in (templates / "skills").iterdir():
        if not md_file.name.endswith(".md"):
            continue
        command_md = md_file.read_text()
        skill_name = md_file.name[:-3]
        (claude_commands / md_file.name).write_text(command_md)
        skill_dir = codex_skills / skill_name
        skill_dir.mkdir(parents=True, exist_ok=True)
        (skill_dir / "SKILL.md").write_text(codex_skill_body(skill_name, command_md))
    return claude_commands, codex_skills


def install_project_preferences(project_root: pathlib.Path, templates) -> Optional[pathlib.Path]:
    """Backfill packaged project preferences without replacing local edits."""
    prefs_path = project_root / "docs" / "orcha-project-preferences.md"
    if prefs_path.exists():
        return None
    prefs_path.parent.mkdir(parents=True, exist_ok=True)
    prefs_path.write_text((templates / "project-preferences.md").read_text())
    return prefs_path


def ensure_secret_key(
    orcha_dir: pathlib.Path,
    read_env_value: Callable[[pathlib.Path, str], Optional[str]],
    append_env_value: Callable[[pathlib.Path, str, str], None],
    tighten_env_file: Callable[[pathlib.Path], None],
) -> None:
    """Ensure Compose inherits a stable secret-box master key."""
    if os.environ.get(MASTER_KEY_ENV):
        return
    env_file = orcha_dir / ".env"
    persisted = read_env_value(env_file, MASTER_KEY_ENV)
    if persisted:
        os.environ[MASTER_KEY_ENV] = persisted
        tighten_env_file(env_file)
        return
    key = secrets.token_urlsafe(32)
    try:
        append_env_value(env_file, MASTER_KEY_ENV, key)
        print(
            f"[orcha] generated a secret_box master key ({MASTER_KEY_ENV}) and persisted it to "
            f"{env_file} (0600) — encrypted at-rest storage of per-container LLM keys is enabled."
        )
    except OSError as exc:
        print(
            f"[orcha] WARNING: could not persist {MASTER_KEY_ENV} to {env_file} ({exc}); using an "
            "ephemeral key for this run only — stored LLM keys won't survive a restart."
        )
    os.environ[MASTER_KEY_ENV] = key


def usable_pairing_ip(value: str) -> Optional[str]:
    """Return a phone-reachable address, excluding local-only address classes."""
    try:
        ip = ipaddress.ip_address((value or "").strip())
    except ValueError:
        return None
    if ip.is_loopback or ip.is_unspecified or ip.is_multicast or ip.is_link_local:
        return None
    if ip.version == 4 and str(ip).startswith("169.254."):
        return None
    return str(ip)


def discover_pairing_host() -> Optional[str]:
    """Best-effort discovery of a host address reachable from a paired phone."""
    supplied = usable_pairing_ip(os.environ.get(PAIRING_HOST_ENV, ""))
    if supplied:
        return supplied
    candidates: list[str] = []
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.settimeout(0.2)
            sock.connect(("1.1.1.1", 80))
            candidates.append(sock.getsockname()[0])
    except OSError:
        pass
    try:
        infos = socket.getaddrinfo(socket.gethostname(), None)
        candidates.extend(
            address[0]
            for family, _typ, _proto, _canon, address in infos
            if family == socket.AF_INET and address
        )
    except OSError:
        pass
    for candidate in candidates:
        reachable = usable_pairing_ip(candidate)
        if reachable:
            return reachable
    return None


def export_pairing_host(discover: Callable[[], Optional[str]]) -> None:
    """Expose a discovered host address for Compose unless the operator supplied one."""
    if os.environ.get(PAIRING_HOST_ENV):
        return
    host = discover()
    if host:
        os.environ[PAIRING_HOST_ENV] = host


def export_gh_token() -> None:
    """Local run: ride the developer's existing `gh` login for GitHub features.

    The portal runs in a container and can't reach the host keyring, but the
    host CLI can — mint the token gh already holds and pass it through the
    compose env as ORCHA_GITHUB_PAT (lowest-precedence token source; App
    installation tokens still win). An explicit ORCHA_GITHUB_PAT, a missing
    gh, or a logged-out gh all leave the env untouched — the Settings →
    GitHub access card remains the fallback. Never raises."""
    if (os.environ.get("ORCHA_GITHUB_PAT") or "").strip():
        return
    if not shutil.which("gh"):
        return
    try:
        probe = subprocess.run(
            ["gh", "auth", "token"], capture_output=True, text=True, timeout=10
        )
    except (OSError, subprocess.TimeoutExpired):
        return
    token = (probe.stdout or "").strip()
    if probe.returncode == 0 and token:
        os.environ["ORCHA_GITHUB_PAT"] = token
        print("[orcha] GitHub: using your `gh` CLI login for the portal's GitHub features")


def compose(
    orcha_dir: pathlib.Path,
    *args: str,
    check: bool = True,
    capture: bool = False,
    ensure_key: Callable[[pathlib.Path], None],
    export_host: Callable[[], None],
) -> subprocess.CompletedProcess:
    """Run Docker Compose after preparing host-owned writable and secret state."""
    if "up" in args:
        for relative in (".orcha-wakes", ".orcha-attachments"):
            try:
                (orcha_dir.parent / ".claude" / relative).mkdir(parents=True, exist_ok=True)
            except OSError:
                pass
        ensure_key(orcha_dir)
        export_host()
        export_gh_token()
    command = ["docker", "compose", "-f", str(orcha_dir / "docker-compose.yml"), *args]
    return subprocess.run(command, check=check, capture_output=capture, text=capture)
