"""Pytest wrapper for the deploy/provision-projects.sh shell harness.

The real assertions live in tests/test_provision_projects.sh (stubbed portal,
PATH-shimmed git/orcha, stub token minter); this wrapper just runs it so the
provisioner rides the normal python suite. Requires only /bin/sh + python3 —
no docker, no network beyond loopback.
"""
import pathlib
import subprocess


def test_provision_projects_shell_harness():
    script = pathlib.Path(__file__).resolve().parent / "test_provision_projects.sh"
    result = subprocess.run(
        ["sh", str(script)], capture_output=True, text=True, timeout=120
    )
    assert result.returncode == 0, (
        f"shell harness failed (rc={result.returncode})\n"
        f"--- stdout ---\n{result.stdout}\n--- stderr ---\n{result.stderr}"
    )
    assert "OK: provision-projects shell harness passed" in result.stdout
