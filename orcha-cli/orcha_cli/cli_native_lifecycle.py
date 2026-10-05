"""Native-runtime branches of `orcha up/down/status` (GH #258 PR 6, plan Part 5 R2).

A native project has no compose file to drive: `orcha serve` owns the portal, notifier and
terminal bridge, so `up` starts (or finds) that one supervisor, `down` stops it, and
`status` reads its `.orcha/state.json`. The service-unit branches (launchd/systemd) arrive
with R3; until then `up` spawns `serve` detached the same way `ensure_daemon` does.
"""
from __future__ import annotations

import os
import pathlib
import signal
import subprocess
import sys
import time

from orcha_cli import cli_runtime_mode, cli_serve, cli_serve_support, cli_stacks_registry

PORTAL_WAIT_SECS = 30.0
STOP_WAIT_SECS = 15.0  # serve itself gives each child up to 8 s before SIGKILL
POLL_SECS = 0.25
DB_SUFFIXES = ("", "-wal", "-shm")


def _api_base(cfg: dict) -> str:
    return cfg.get("api_base_url") or f"http://localhost:{cfg.get('api_port')}"


def _project_name(root: pathlib.Path, cfg: dict) -> str:
    return cfg.get("project_name") or root.name


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except (ProcessLookupError, PermissionError, OverflowError):
        return False
    return True


def _wait_until(pred, timeout: float, sleep=time.sleep, clock=time.monotonic) -> bool:
    deadline = clock() + timeout
    while clock() < deadline:
        if pred():
            return True
        sleep(POLL_SECS)
    return pred()


def up(root: pathlib.Path, *, popen=subprocess.Popen, http_ok=cli_serve_support.http_ok,
       wait_secs: float = PORTAL_WAIT_SECS) -> None:
    cfg = cli_runtime_mode.read_config(root)
    api = _api_base(cfg)
    pid = cli_serve.serve_running(root)
    if pid and http_ok(f"{api}/"):
        print(f"[orcha] already running (orcha serve pid {pid}) — {api}/")
        return
    if pid:
        print(f"[orcha] orcha serve is running (pid {pid}); waiting for the portal ...")
    else:
        log = cli_serve_support.log_path(root, "serve")
        log.parent.mkdir(parents=True, exist_ok=True)
        with open(log, "ab") as out:
            proc = popen(
                [sys.executable, "-m", "orcha_cli", "serve", "--project-dir", str(root)],
                cwd=str(root), stdin=subprocess.DEVNULL, stdout=out, stderr=subprocess.STDOUT,
                start_new_session=True,
            )
        print(f"[orcha] started orcha serve (pid {proc.pid}); log: {log}")
    if _wait_until(lambda: http_ok(f"{api}/"), wait_secs):
        print(f"[orcha] ✓ portal up at {api}/")
    else:
        print(f"[orcha] warn: portal did not answer within {int(wait_secs)} s; "
              "check `orcha status` and `orcha logs portal`")


def _confirm_db_delete(db: pathlib.Path, yes: bool) -> None:
    if yes:
        return
    if not sys.stdin.isatty():
        sys.exit(f"error: `orcha down -v` deletes the database ({db}); "
                 "pass --yes to confirm when not running in a terminal.")
    answer = input(f"Delete the database {db} and all its data? [y/N] ").strip().lower()
    if answer not in ("y", "yes"):
        sys.exit("[orcha] aborted; nothing deleted.")


def down(root: pathlib.Path, *, volumes: bool = False, yes: bool = False,
         kill=os.kill, stop_secs: float = STOP_WAIT_SECS) -> None:
    cfg = cli_runtime_mode.read_config(root)
    db = cli_runtime_mode.db_path(root, cfg)
    if volumes:
        _confirm_db_delete(db, yes)  # ask before stopping anything
    pid = cli_serve.serve_running(root)
    if pid:
        kill(pid, signal.SIGTERM)
        if not _wait_until(lambda: not _alive(pid), stop_secs):
            kill(pid, signal.SIGKILL)
        print(f"[orcha] stopped orcha serve (pid {pid})")
    else:
        print("[orcha] orcha serve is not running")
    cli_stacks_registry.unregister(_project_name(root, cfg))
    if volumes:
        removed = [p for p in (db.with_name(db.name + s) for s in DB_SUFFIXES) if p.exists()]
        for p in removed:
            p.unlink()
        print(f"[orcha] deleted {', '.join(str(p) for p in removed)}" if removed
              else f"[orcha] no database file at {db}")


def _size(path: pathlib.Path) -> str:
    try:
        n = float(path.stat().st_size)
    except OSError:
        return "missing"
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024
    return ""


def status(root: pathlib.Path, cfg: dict) -> None:
    state = cli_serve_support.read_state(root)
    pid = cli_serve.serve_running(root)
    db = cli_runtime_mode.db_path(root, cfg)
    print("runtime:              native")
    print(f"bind:                 {cfg.get('bind') or state.get('bind') or 'loopback'}")
    print(f"bridge port:          {cfg.get('bridge_port', '?')}")
    print(f"orcha serve:          {f'running (pid {pid})' if pid else 'stopped'}")
    for name, child in (state.get("children") or {}).items() if pid else ():
        restarts = child.get("restarts", 0)
        print(f"  {name:<19} {child.get('status', '?')} (pid {child.get('pid') or '-'}, "
              f"restarts {restarts})")
    print(f"database:             {db} ({_size(db)})")
    print(f"logs:                 {cli_serve_support.logs_dir(root)}  (`orcha logs -f`)")
