"""Parser entries for the native runtime (GH #258 PR 6): `orcha serve` and `orcha logs`."""
from __future__ import annotations

from collections.abc import Callable


def register_native_commands(sub, handlers: dict[str, Callable]) -> None:
    serve = sub.add_parser(
        "serve",
        help="supervise a native-runtime project's portal, notifier and terminal bridge "
        "in the foreground (restarts crashed children; `orcha up` starts it for you)",
    )
    serve.add_argument("--project-dir", default=None, help="project root (default: the current directory)")
    serve.add_argument("--no-bridge", action="store_true", help="do not run the terminal bridge")
    serve.set_defaults(func=handlers["serve"])

    logs = sub.add_parser("logs", help="show a native-runtime project's logs (.orcha/logs/)")
    logs.add_argument("child", nargs="?", choices=("serve", "portal", "notifier", "bridge"),
                      help="one log (default: all that exist)")
    logs.add_argument("-f", "--follow", action="store_true", help="keep printing new lines")
    logs.add_argument("-n", "--lines", type=int, default=50, help="lines of history to print (default 50)")
    logs.add_argument("--project-dir", default=None, help="project root (default: the current directory)")
    logs.set_defaults(func=handlers["logs"])
