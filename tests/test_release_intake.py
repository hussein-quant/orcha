"""The intake: logging issues by talking them through with an agent. Its brief, screen
recordings turned into key frames with ffmpeg, and the report's images carried into a ticket.
"""

import io
import shutil
import subprocess
from uuid import uuid4

import pytest

from portal_backend import intake_routes as intake
from portal_backend import workflow_service as ws
from portal_backend import workflow_steps as steps
from portal_backend.attachment_references import conversation_attachments_dir, resolve_stored_attachment
from portal_backend.database import db_cursor

FFMPEG = intake._tool("ffmpeg") and intake._tool("ffprobe")


def uid():
    return str(uuid4())


@pytest.fixture(autouse=True)
def local_lane(monkeypatch):
    monkeypatch.setattr(ws, "WORKFLOWS_INTEGRATED", True)
    monkeypatch.delenv("ORCHA_TRUST_PROXY_USER", raising=False)
    monkeypatch.delenv("ORCHA_BIND", raising=False)
    monkeypatch.setattr(steps, "DRY_RUN_DELAY_S", 0)


class Project:
    def __init__(self, client):
        self.client = client
        self.cid, self.owner, self.eng, self.intake = uid(), uid(), uid(), uid()
        with db_cursor() as (_, cur):
            cur.execute("INSERT INTO containers(id,name) VALUES (%s,'Nyumbani')", (self.cid,))
            for aid, alias, kind in [(self.owner, "Owner", "human"), (self.eng, "Engineer", "ai"), (self.intake, "Intake", "ai")]:
                cur.execute(
                    "INSERT INTO agents(id,container_id,alias,role,kind,member_role,github_login) VALUES (%s,%s,%s,'test',%s,%s,%s)",
                    (aid, self.cid, alias, kind, "owner" if kind == "human" else "member", "owner" if kind == "human" else None),
                )
        self.headers = {"X-Orcha-Local-Actor": self.owner}

    async def call(self, method, path, body=None, expect=200, **kw):
        r = await self.client.request(method, path, json=body, headers=self.headers, **kw)
        assert r.status_code == expect, (path, r.status_code, r.text)
        return r.json()

    async def cycle(self):
        return await self.call("POST", f"/api/containers/{self.cid}/release-cycles", {
            "version": "1.0.3", "dry_run": True, "platforms": ["ios", "android", "web"],
            "roles": {"engineer": self.eng, "intake": self.intake}})

    async def conversation(self):
        out = await self.call("POST", f"/api/agents/{self.intake}/conversations", {"actor_agent_id": self.owner}, expect=201)
        return out["conversation"]["id"]


def test_key_frames_keep_the_ends_and_the_scene_changes_within_the_limit():
    assert intake.pick_times(0, []) == [0.0]
    t = intake.pick_times(10.0, [3.2, 3.4, 7.7])
    assert t[0] == 0.0 and t[-1] == 9.95 and 3.2 in t and 7.7 in t and 3.4 not in t  # 3.4 is within half a second
    assert len(t) <= intake.MAX_FRAMES
    many = intake.pick_times(120.0, [i * 1.3 for i in range(80)])
    assert len(many) == intake.MAX_FRAMES and many[0] == 0.0 and many[-1] == 119.95


@pytest.mark.asyncio
async def test_the_brief_names_the_release_its_platforms_and_whats_already_logged(client):
    p = Project(client)
    c = await p.cycle()
    await p.call("POST", f"/api/release-cycles/{c['id']}/tickets", {"title": "Login spinner", "platforms": ["ios"], "issue_number": 212})
    out = await p.call("GET", f"/api/release-cycles/{c['id']}/intake")
    assert out["agent_id"] == p.intake
    b = out["brief"]
    assert b.startswith("[[intake-brief]]") and b.endswith("[[/intake-brief]]")
    assert "release 1.0.3 of Nyumbani" in b and "iOS, Android, Web" in b and "- #212 Login spinner" in b
    assert "```orcha-ticket" in b and "Never log anything yourself" in b


@pytest.mark.skipif(not FFMPEG, reason="ffmpeg isn't installed")
@pytest.mark.asyncio
async def test_a_recording_becomes_key_frames_the_agent_can_read(client, tmp_path):
    p = Project(client)
    conv = await p.conversation()
    clip = tmp_path / "checkout-freeze.mp4"
    subprocess.run([intake._tool("ffmpeg"), "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
                    "testsrc=duration=4:size=320x240:rate=10", "-pix_fmt", "yuv420p", "-y", str(clip)], check=True)
    r = await p.client.post(f"/api/conversations/{conv}/videos", headers=p.headers,
                            files={"file": ("checkout-freeze.mp4", clip.read_bytes(), "video/mp4")})
    assert r.status_code == 201, r.text
    out = r.json()
    assert out["video"]["name"] == "checkout-freeze.mp4" and 3.5 < out["video"]["duration"] < 4.5
    frames = out["frames"]
    assert 2 <= len(frames) <= intake.MAX_FRAMES and all(f["kind"] == "image" for f in frames)
    assert frames[0]["name"] == "checkout-freeze-frame-01-at-0.0s.png" and out["sheet"]["name"] == "checkout-freeze-contact-sheet.png"
    # The frames go into the conversation like any screenshot.
    turn = await p.call("POST", f"/api/conversations/{conv}/turns", {
        "role": "human", "author_agent_id": p.owner, "content": "Checkout freezes, see the recording.",
        "attachments": [{"id": f["id"], "name": f["name"]} for f in frames[:3]]}, expect=201)
    assert len(turn["turn"]["attachments"]) == 3


@pytest.mark.asyncio
async def test_not_a_video_is_refused(client):
    p = Project(client)
    conv = await p.conversation()
    if not FFMPEG:
        pytest.skip("ffmpeg isn't installed")
    r = await p.client.post(f"/api/conversations/{conv}/videos", headers=p.headers,
                            files={"file": ("notes.txt", b"hello", "text/plain")})
    assert r.status_code == 400


@pytest.mark.asyncio
async def test_a_logged_ticket_carries_the_reports_images_to_its_agent(client):
    p = Project(client)
    c = await p.cycle()
    conv = await p.conversation()
    d = conversation_attachments_dir(conv)
    d.mkdir(parents=True, exist_ok=True)
    stored = f"{uuid4().hex}_receipt.png"
    shutil.copyfile(__file__, d / stored)  # any bytes: the store checks names, not pixels
    out = await p.call("POST", f"/api/release-cycles/{c['id']}/tickets", {
        "title": "Receipt shows the wrong month", "kind": "feature", "platforms": ["ios"],
        "body": "## Summary\nDecember shows November.",
        "attachments": [{"conversation_id": conv, "id": stored, "name": "receipt.png"},
                        {"conversation_id": conv, "id": "missing.png", "name": "missing.png"}]})
    t = next(x for x in out["tickets"] if x["id"] == out["added"])
    with db_cursor() as (_, cur):
        cur.execute("SELECT t.id, t.step_spec, m.attachments FROM task_messages m JOIN tasks t ON t.id=m.task_id "
                    "WHERE t.workflow_id=%s", (t["workflow_id"],))
        rows = cur.fetchall()
    keys = sorted((steps.spec_of(r) or {}).get("key") for r in rows)
    assert keys == ["implement", "spec"]  # the feature's spec step and its build step both see it
    for r in rows:
        refs = steps._load(r["attachments"])
        assert [a["name"] for a in refs] == ["receipt.png"]  # the missing one is skipped
        assert resolve_stored_attachment(str(r["id"]), stored) is not None
