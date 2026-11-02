"""`orcha voice`: local speech for voice-first mode (GH #409).

    orcha voice install [--model parakeet-v3|whisper-turbo]   set up MLX speech (downloads once)
    orcha voice status                                         what is installed / running
    orcha voice start | stop                                   the per-Mac speech service
    orcha voice uninstall [--models-only]                      remove it (frees the disk space)

One service serves every project on this Mac; the portal starts it on demand while
voice-first mode is on. See voice_runtime.py.
"""

from __future__ import annotations

import argparse
import json
import sys

from . import voice_runtime as vr


def register(sub, handler) -> None:
    p = sub.add_parser(
        "voice",
        help="local speech for voice-first mode on Apple Silicon: install | status | start | stop | "
             "uninstall (one service for every project on this Mac; audio never leaves it)",
    )
    p.add_argument("action", choices=("install", "status", "start", "stop", "uninstall"))
    p.add_argument("--model", choices=tuple(vr.STT_MODELS), default=None,
                   help=f"install: the speech-to-text model (default {vr.DEFAULT_STT})")
    p.add_argument("--models-only", action="store_true",
                   help="uninstall: delete the downloaded models but keep the environment")
    p.add_argument("--json", action="store_true", help="machine-readable output (one JSON object)")
    p.set_defaults(func=handler)


def _gb(n: int) -> str:
    return f"{n / 1e9:.1f} GB" if n else "no download"


def _print_status(st: dict) -> None:
    print(f"Local speech: {'installed' if st['installed'] else 'not installed'}"
          + (f", {'ready' if st['ready'] else 'starting'} on 127.0.0.1:{st['port']}" if st["running"] else ""))
    if not st["apple_silicon"]:
        print("  This Mac has no Apple Silicon: use a cloud speech provider in Settings › Voice.")
    for m in st["models"]:
        mark = "✓" if m["downloaded"] else "·"
        sel = " (selected)" if m["selected"] else ""
        print(f"  {mark} {m['kind'].upper():3} {m['label']}{sel}: {_gb(m['size_bytes'])}, {m['note']}")
    print(f"  home: {st['home']}")
    if not st["installed"] and st["apple_silicon"]:
        print("  Set it up with: orcha voice install")


def cmd_voice(args: argparse.Namespace) -> None:
    out = (lambda s: print(s, file=sys.stderr)) if args.json else print
    try:
        if args.action == "install":
            st = vr.install(args.model or vr.DEFAULT_STT, out=out)
        elif args.action == "start":
            out("[orcha] starting the local speech service (the first start loads the model) …")
            st = vr.start()
        elif args.action == "stop":
            stopped = vr.stop()
            st = {**vr.status(), "stopped": stopped}
        elif args.action == "uninstall":
            vr.uninstall(models_only=args.models_only)
            st = vr.status()
        else:
            st = vr.status()
    except vr.VoiceError as exc:
        if args.json:
            print(json.dumps({"ok": False, "error": str(exc)}))
        else:
            print(f"[orcha] {exc}", file=sys.stderr)
        sys.exit(1)
    if args.json:
        print(json.dumps({"ok": True, **st}))
    else:
        if args.action == "stop":
            print("[orcha] stopped the local speech service" if st.get("stopped") else "[orcha] it was not running")
        _print_status(st)
