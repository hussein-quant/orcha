"""Logging issues by talking them through: the intake of a release cycle.

A person describes bugs and feature requests to one of the project's agents in its ordinary
conversation (text, dictation, screenshots, screen recordings). The agent asks until each item is
clear and proposes tickets in `orcha-ticket` blocks; the person confirms each one, which adds it to
the cycle (release_cycle_routes.add_ticket) with the screenshots carried over to the ticket's agent.

Here: the brief the agent gets with the first message, and screen recordings. A recording is
stored beside the conversation's attachments and ffmpeg pulls its key frames (scene changes and
even spacing, each named with its time) plus a contact sheet. The frames are ordinary image
attachments of the conversation, so the agent reads the recording frame by frame.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import subprocess
import uuid

from fastapi import File, HTTPException, Request, UploadFile

from portal_backend import release_cycle_routes as cycles
from portal_backend import workflow_templates as templates
from portal_backend.application import app
from portal_backend.attachment_references import conv_attachment_ref, conversation_attachments_dir
from portal_backend.attachment_storage import contained_path, sanitize_attachment_name
from portal_backend.database import db_cursor
from portal_backend.guards import require_container_active, valid_uuid
from portal_backend.identity_routes import trusted_actor

VIDEO_EXT = {"mp4", "mov", "m4v", "webm", "mkv"}
MAX_VIDEO_BYTES = int(os.environ.get("ORCHA_MAX_VIDEO_BYTES", str(300 * 1024 * 1024)))
MAX_FRAMES = 8
FFMPEG_TIMEOUT_S = 120
BRIEF_START, BRIEF_END = "[[intake-brief]]", "[[/intake-brief]]"


def _tool(name: str) -> str | None:
    """ffmpeg/ffprobe on PATH, or where Homebrew and most Linux installs put them."""
    found = shutil.which(name)
    if found:
        return found
    for d in ("/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"):
        p = os.path.join(d, name)
        if os.path.isfile(p) and os.access(p, os.X_OK):
            return p
    return None


def _probe(ffprobe: str, path: str) -> dict:
    proc = subprocess.run(
        [ffprobe, "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height:format=duration",
         "-of", "json", path], capture_output=True, text=True, timeout=FFMPEG_TIMEOUT_S,
    )
    if proc.returncode != 0:
        raise HTTPException(422, f"That file isn't a video ffmpeg can read: {(proc.stderr or '').strip()[-200:]}")
    data = json.loads(proc.stdout or "{}")
    stream = (data.get("streams") or [{}])[0]
    duration = float((data.get("format") or {}).get("duration") or 0)
    return {"duration": duration, "width": stream.get("width"), "height": stream.get("height")}


def _scene_times(ffmpeg: str, path: str) -> list[float]:
    """When the picture changes a lot: the moments a recording is about."""
    proc = subprocess.run(
        [ffmpeg, "-hide_banner", "-nostats", "-i", path, "-an", "-vf", "select='gt(scene,0.12)',showinfo",
         "-f", "null", "-"], capture_output=True, text=True, timeout=FFMPEG_TIMEOUT_S,
    )
    return [float(m) for m in re.findall(r"pts_time:([0-9.]+)", proc.stderr or "")]


def pick_times(duration: float, scenes: list[float], limit: int = MAX_FRAMES) -> list[float]:
    """At most `limit` moments: the first and last frames, then the scene changes, then even
    spacing to fill what's left, never two within half a second."""
    if duration <= 0:
        return [0.0]
    end = round(max(0.0, duration - 0.05), 2)

    def far(t, picked):
        return all(abs(t - o) >= 0.5 for o in picked)

    picked = [0.0] + ([end] if end >= 0.5 else [])
    cuts = []
    for t in sorted(set(round(min(max(t, 0.0), end), 2) for t in scenes)):
        if far(t, picked + cuts):
            cuts.append(t)
    room = limit - len(picked)
    if len(cuts) > room:
        # More changes than room: keep them spread over the recording.
        cuts = [cuts[round(i * (len(cuts) - 1) / max(1, room - 1))] for i in range(room)]
    picked += cuts
    steps = max(1, limit - 1)
    for t in (round(duration * i / steps, 2) for i in range(1, steps)):
        if len(picked) >= limit:
            break
        if far(t, picked):
            picked.append(t)
    return sorted(set(picked))


def _stamp(t: float) -> str:
    return f"{int(t // 60)}m{t % 60:04.1f}s" if t >= 60 else f"{t:.1f}s"


def extract_frames(path: str, base: str, out_dir, *, ffmpeg: str, ffprobe: str) -> dict:
    info = _probe(ffprobe, path)
    times = pick_times(info["duration"], _scene_times(ffmpeg, path))
    frames = []
    for i, t in enumerate(times, 1):
        name = f"{uuid.uuid4().hex}_{base}-frame-{i:02d}-at-{_stamp(t)}.png"
        dest = contained_path(out_dir, name)
        proc = subprocess.run(
            [ffmpeg, "-hide_banner", "-loglevel", "error", "-ss", f"{t:.2f}", "-i", path, "-frames:v", "1",
             "-vf", "scale='min(1280,iw)':-2", "-y", str(dest)], capture_output=True, text=True, timeout=FFMPEG_TIMEOUT_S,
        )
        if proc.returncode == 0 and dest.exists() and dest.stat().st_size:
            frames.append({"stored": name, "display": f"{base}-frame-{i:02d}-at-{_stamp(t)}.png", "t": t, "path": dest})
    sheet = None
    if info["duration"] > 0:
        n = 12
        name = f"{uuid.uuid4().hex}_{base}-contact-sheet.png"
        dest = contained_path(out_dir, name)
        proc = subprocess.run(
            [ffmpeg, "-hide_banner", "-loglevel", "error", "-i", path, "-vf",
             f"fps={n}/{max(info['duration'], 0.1):.3f},scale=360:-2,tile=4x3", "-frames:v", "1", "-y", str(dest)],
            capture_output=True, text=True, timeout=FFMPEG_TIMEOUT_S,
        )
        if proc.returncode == 0 and dest.exists() and dest.stat().st_size:
            sheet = {"stored": name, "display": f"{base}-contact-sheet.png", "path": dest}
    return {**info, "frames": frames, "sheet": sheet}


@app.post("/api/conversations/{conv_id}/videos", status_code=201)
async def upload_video(conv_id: str, request: Request, file: UploadFile = File(...)):
    """A screen recording for this conversation: stored, then turned into up to eight key frames
    and a contact sheet, each an image attachment of the conversation ready to send in a turn."""
    if not valid_uuid(conv_id):
        raise HTTPException(400, "conversation_id is not a valid UUID")
    with db_cursor() as (_, cur):
        cur.execute("SELECT container_id FROM conversations WHERE id=%s", (conv_id,))
        row = cur.fetchone()
        if not row:
            raise HTTPException(404, "conversation not found")
        trusted_actor(cur, request, str(row["container_id"]))
        require_container_active(cur, str(row["container_id"]), None)
    ffmpeg, ffprobe = _tool("ffmpeg"), _tool("ffprobe")
    if not ffmpeg or not ffprobe:
        raise HTTPException(422, "ffmpeg isn't installed on this machine, so recordings can't be read. Install it (brew install ffmpeg) and try again.")
    display = sanitize_attachment_name(file.filename or "recording.mp4")
    ext = display.rsplit(".", 1)[-1].lower() if "." in display else ""
    if ext not in VIDEO_EXT:
        raise HTTPException(400, "A recording is an mp4, mov, m4v, webm or mkv file.")
    out_dir = conversation_attachments_dir(conv_id) / "recordings"
    out_dir.mkdir(parents=True, exist_ok=True)
    stored = uuid.uuid4().hex + "_" + display
    dest = contained_path(out_dir, stored)
    if dest is None:
        raise HTTPException(400, "invalid file name")
    size = 0
    with open(dest, "wb") as out:
        while True:
            chunk = await file.read(1024 * 1024)
            if not chunk:
                break
            size += len(chunk)
            if size > MAX_VIDEO_BYTES:
                out.close()
                dest.unlink(missing_ok=True)
                raise HTTPException(413, f"The recording is too large (max {MAX_VIDEO_BYTES // (1024 * 1024)} MiB).")
            out.write(chunk)
    if not size:
        dest.unlink(missing_ok=True)
        raise HTTPException(400, "empty file")
    base = re.sub(r"[^A-Za-z0-9_-]+", "-", display.rsplit(".", 1)[0])[:40].strip("-") or "recording"
    frames_dir = conversation_attachments_dir(conv_id)
    try:
        got = await asyncio.to_thread(extract_frames, str(dest), base, frames_dir, ffmpeg=ffmpeg, ffprobe=ffprobe)
    except subprocess.TimeoutExpired:
        raise HTTPException(422, "ffmpeg took too long on that recording. Try a shorter clip.")
    refs = [{**conv_attachment_ref(conv_id, f["stored"], f["display"], f["path"].stat().st_size, f["path"]), "t": f["t"]}
            for f in got["frames"]]
    sheet = got["sheet"]
    return {
        "video": {"name": display, "size": size, "duration": got["duration"], "width": got["width"], "height": got["height"]},
        "frames": refs,
        "sheet": conv_attachment_ref(conv_id, sheet["stored"], sheet["display"], sheet["path"].stat().st_size, sheet["path"]) if sheet else None,
    }


def brief(cur, cycle: dict) -> str:
    """What the intake agent is asked to do, sent with the first message of a session."""
    cur.execute("SELECT name FROM containers WHERE id=%s", (cycle["container_id"],))
    project = (cur.fetchone() or {}).get("name") or "this project"
    platforms = ", ".join(templates.PLATFORM_WORD[p] for p in cycles._load(cycle["platforms"], []))
    tickets = [t for t in cycles._tickets(cur, cycle["id"]) if t["state"] != "dropped"]
    logged = "\n".join(f"- {('#' + str(t['issue_number']) + ' ') if t['issue_number'] else ''}{t['title']}" for t in tickets[:60]) or "- none yet"
    return f"""{BRIEF_START}
You're the intake for release {cycle['version']} of {project} (branch {cycle['branch']}). I'll describe bugs and feature requests the way they come to me: typed, dictated, screenshots, and frames from screen recordings (each frame is named with its time in the recording; the contact sheet shows the whole recording at a glance).

Your job:
1. Understand exactly what I mean. Look at the code, and at the project's open GitHub issues, when that helps you ask a better question. Ask short, specific questions, one or two at a time, until each item is clear:
   - a bug: where it happens (screen, platform, account or role), the steps to reproduce, what I expected, what happened instead, how often, and anything in the screenshots or frames that shows it;
   - a feature: who it's for and what they're trying to do, the behaviour on each platform, edge cases, and what's out of scope.
   Don't guess what I haven't said; ask. Point at what you see in the images when it matters.
2. Never log anything yourself and never change code. When an item is clear, propose it as one ticket in a fenced block, exactly like this:
```orcha-ticket
{{"title": "Short, specific title", "kind": "bug", "platforms": ["ios"], "labels": ["area: profile", "severity: major"], "body": "## Summary\\n...\\n## Steps to reproduce\\n1. ...\\n## Expected\\n...\\n## Actual\\n...\\n## Acceptance criteria\\n- ...", "attachments": ["<the attachment ids that show it>"]}}
```
   kind is bug or feature; platforms are some of: ios, android, web, api (an API change also gets checked on every app). labels help find it on GitHub later: always the area of the product it's in (area: …), a severity for a bug (severity: critical, major or minor), and anything else that would help someone filter for it (for example regression, crash, ui, performance, payments). The release, kind, platform and "embodent" labels are added for you. Use the feature sections for a feature (Goal, Behaviour, Edge cases, Out of scope, Acceptance criteria). Split unrelated problems into separate tickets. I confirm each one in Embodent; if I ask for changes, propose it again.
3. This project ships on: {platforms}. Already in this release (don't log these again; say so if I describe one):
{logged}
{BRIEF_END}"""


@app.get("/api/release-cycles/{cycle_id}/intake", tags=["release cycles"])
def intake(cycle_id: str, request: Request):
    """The intake's brief and agent for this cycle."""
    with db_cursor(readonly=True) as (_, cur):
        c = cycles._readable(cur, request, cycle_id)
        return {"agent_id": cycles._load(c["roles"], {}).get("intake"), "brief": brief(cur, c),
                "marker": [BRIEF_START, BRIEF_END]}
