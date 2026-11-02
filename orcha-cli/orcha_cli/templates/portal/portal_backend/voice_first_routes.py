"""Talk to Orcha (GH #409): what the Embodent app's master chat needs from one project.

Routes (all under ``/api/containers/{cid}/voice-first``)
------------------------------------------------------
* ``GET  /status``            local speech (MLX) install/run state, models, cloud fallback
* ``POST /start``             start the per-Mac speech service and wait until it is warm
* ``POST /speak``             text → audio/wav (Kokoro, or the Mac's own voices; local service)
* ``POST /listen``            audio/wav → transcript with local MLX speech-to-text
* ``GET  /voices``            the voices replies can be read in
* ``GET  /context``           the Talk chat's view of this project (team, open work, what needs you)
* ``POST /propose``           one action the chat suggested → exact request + read-back, or a question
* ``POST /actions``           record a decision about to be made by voice (idempotent)
* ``GET/PATCH /actions/{id}`` read one / mark it undone or failed

The decision itself is NOT made here: the client sends it to the same route the portal's
buttons use (``/api/decisions``, ``/api/tasks/{id}/verify``, ``/api/requests/{id}/respond``)
with ``via: "voice"`` and the recorded id, so every human-only rule, autonomy setting and
workflow gate applies exactly as for a click (voice_actions.py).

Local speech runs on this Mac only (native mode, Apple Silicon); audio is sent to the local
service on 127.0.0.1 and never stored. Without it the portal falls back to the project's
cloud speech provider (``/voice/transcribe``) or on-screen text — never silently.
"""

from __future__ import annotations

import asyncio
from typing import Literal, Optional

from fastapi import HTTPException, Request, Response
from pydantic import BaseModel, Field

from portal_backend import voice_actions, voice_briefing, voice_conversation, voice_intent
from portal_backend.application import app
from portal_backend.database import db_cursor
from portal_backend.guards import require_container, require_kind, valid_uuid
from portal_backend.identity_routes import trusted_actor
from portal_backend.voice_routes import MAX_UPLOAD_BYTES, _key_status, _member_gate

try:
    from orcha_cli import voice_runtime
except ImportError:  # Docker portal: local speech is a Mac-only feature
    voice_runtime = None

MAX_SPEAK_CHARS = 2000


def _gate(cid: str, request: Request) -> None:
    if not valid_uuid(cid):
        raise HTTPException(400, "container_id is not a valid UUID")
    with db_cursor() as (_, cur):
        require_container(cur, cid)
        _member_gate(cur, request, cid)


def _local():
    if voice_runtime is None:
        raise HTTPException(409, {"code": "local_unavailable",
                                  "message": "Local speech runs only in the Mac app or a native project on a Mac."})
    return voice_runtime


def _voice_error(exc: Exception) -> HTTPException:
    return HTTPException(503, {"code": "local_unavailable", "message": str(exc)})


# --------------------------------------------------------------------------- status


@app.get("/api/containers/{cid}/voice-first/status", status_code=200,
         summary="Talk: local speech install/run state and the cloud speech fallback")
def voice_first_status(cid: str, request: Request):
    _gate(cid, request)
    with db_cursor() as (_, cur):
        cloud = any(s["configured"] for s in _key_status(cur, cid))
    if voice_runtime is None:
        local = {"apple_silicon": False, "installed": False, "running": False, "ready": False,
                 "models": [], "reason": "Local speech runs only in the Mac app or a native project on a Mac."}
    else:
        local = voice_runtime.status()
    return {
        "local": local,
        "cloud_stt_available": cloud,
        "confirm_required_for": list(voice_intent.CONFIRMABLE),
        "sensitive_pattern": "merge, deploy, publish, submit for review, app/play store, production",
        "audio_retention": "none",
    }


@app.post("/api/containers/{cid}/voice-first/start", status_code=200,
          summary="Start the local speech service and wait until it is warm")
async def voice_first_start(cid: str, request: Request):
    await asyncio.to_thread(_gate, cid, request)
    vr = _local()
    try:
        return await asyncio.to_thread(vr.start)
    except vr.VoiceError as exc:
        raise _voice_error(exc) from None


# --------------------------------------------------------------------------- speech


class SpeakBody(BaseModel):
    text: str = Field(..., min_length=1, max_length=MAX_SPEAK_CHARS)
    voice: Optional[str] = Field(default=None, max_length=64)
    rate: Optional[int] = Field(default=None, ge=80, le=400, description="words per minute")


@app.post("/api/containers/{cid}/voice-first/speak", status_code=200,
          summary="Text to speech with the Mac's voices (returns audio/wav)",
          responses={200: {"content": {"audio/wav": {}}}})
async def voice_first_speak(cid: str, body: SpeakBody, request: Request):
    await asyncio.to_thread(_gate, cid, request)
    vr = _local()
    try:
        audio = await asyncio.to_thread(vr.speak, body.text, body.voice, body.rate)
    except vr.VoiceError as exc:
        raise _voice_error(exc) from None
    return Response(content=audio, media_type="audio/wav", headers={"Cache-Control": "no-store"})


@app.post("/api/containers/{cid}/voice-first/listen", status_code=200,
          summary="Speech to text with local MLX (body: audio/wav)",
          openapi_extra={"requestBody": {"required": True, "content": {
              "audio/wav": {"schema": {"type": "string", "format": "binary"}}}}})
async def voice_first_listen(cid: str, request: Request):
    ctype = (request.headers.get("content-type") or "").split(";")[0].strip().lower()
    if ctype not in ("audio/wav", "audio/x-wav", "audio/wave"):
        raise HTTPException(415, "send the recording as audio/wav")
    body = await request.body()
    if not body:
        raise HTTPException(400, "empty recording")
    if len(body) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, "recording too large (25 MB max)")
    await asyncio.to_thread(_gate, cid, request)
    vr = _local()
    try:
        doc = await asyncio.to_thread(vr.transcribe, body)
    except vr.VoiceError as exc:
        raise _voice_error(exc) from None
    return {"text": doc.get("text", ""), "ms": doc.get("ms"), "engine": "local"}


@app.get("/api/containers/{cid}/voice-first/voices", status_code=200,
         summary="The voices replies can be read in, with quality, and the one used when none is chosen")
async def voice_first_voices(cid: str, request: Request):
    await asyncio.to_thread(_gate, cid, request)
    vr = _local()
    try:
        return await asyncio.to_thread(vr.voices)
    except vr.VoiceError as exc:
        raise _voice_error(exc) from None


# --------------------------------------------------------------------------- talk (the app's master chat)


@app.get("/api/containers/{cid}/voice-first/context", status_code=200,
         summary="What the Talk chat's brain needs about this project: team, open work, what needs the owner")
def voice_first_context(cid: str, request: Request, actor_agent_id: Optional[str] = None,
                        watch: Optional[str] = None):
    """`actor` is who the chat acts as here: the given human, else the project's first human.
    `watch` = comma-separated task ids the chat is following (work it started): their current
    status comes back in `watched`, so the chat can tell the owner when one finishes."""
    if not valid_uuid(cid):
        raise HTTPException(400, "container_id is not a valid UUID")
    with db_cursor() as (_, cur):
        require_container(cur, cid)
        _member_gate(cur, request, cid)
        claimed = actor_agent_id or voice_conversation.owner(cur, cid)
        if not claimed:
            raise HTTPException(409, "this project has no human member to act as")
        who = _actor(cur, request, cid, claimed)
        ids = [i for i in (watch or "").split(",") if valid_uuid(i)][:50]
        return {"cid": cid, "actor": str(who), **voice_conversation.project_context(cur, cid, who),
                "watched": voice_conversation.watched(cur, cid, ids)}


class TalkProposeBody(BaseModel):
    actor_agent_id: str
    action: str = Field(..., max_length=40)
    args: dict = Field(default_factory=dict)


@app.post("/api/containers/{cid}/voice-first/propose", status_code=200,
          summary="One action the chat suggested → the exact request and a read-back, or a short question")
def voice_first_propose(cid: str, body: TalkProposeBody, request: Request):
    """`{proposal}` when it can run as asked (validated against this project), else `{say}`: what
    is missing or why it can't. Nothing is performed here."""
    if not valid_uuid(cid):
        raise HTTPException(400, "container_id is not a valid UUID")
    with db_cursor() as (_, cur):
        require_container(cur, cid)
        _member_gate(cur, request, cid)
        who = _actor(cur, request, cid, body.actor_agent_id)
        p = voice_conversation.build_proposal(cur, cid, str(who), body.action, body.args)
    if isinstance(p, str):
        return {"say": p}
    return {"proposal": p.as_dict()}


# --------------------------------------------------------------------------- actions


class VoiceActionCreate(BaseModel):
    actor_agent_id: str
    idempotency_key: str = Field(..., min_length=8, max_length=200)
    kind: Literal["plan", "verify", "request", "task"]
    item_id: Optional[str] = Field(default=None, description="none for create_task")
    action: str = Field(..., max_length=40)
    transcript: str = Field(..., max_length=voice_actions.MAX_TRANSCRIPT)
    text: Optional[str] = Field(default=None, max_length=voice_intent.MAX_TEXT)


class VoiceActionFinish(BaseModel):
    actor_agent_id: str
    status: Literal["undone", "failed", "done"]
    reason: Optional[str] = Field(default=None, max_length=500)
    result: Optional[dict] = Field(default=None, description="done: what the route returned (task actions only)")


def _actor(cur, request: Request, cid: str, claimed: str) -> str:
    actor = trusted_actor(cur, request, cid, claimed)
    require_kind(cur, actor, ("human",))
    return actor


@app.post("/api/containers/{cid}/voice-first/actions", status_code=200,
          summary="Record a decision about to be made by voice (same key → same row)")
def voice_first_record(cid: str, body: VoiceActionCreate, request: Request):
    if not valid_uuid(cid):
        raise HTTPException(400, "container_id is not a valid UUID")
    if body.kind == "task":
        if body.action not in voice_conversation.WORK_ACTIONS:
            raise HTTPException(422, f"'{body.action}' is not a task action")
    elif body.action not in voice_intent.DECISIONS.get(body.kind, ()):
        raise HTTPException(422, f"'{body.action}' is not a decision for a {body.kind} item")
    with db_cursor() as (conn, cur):
        require_container(cur, cid)
        _member_gate(cur, request, cid)
        actor = _actor(cur, request, cid, body.actor_agent_id)
        if body.kind != "task":
            voice_briefing.load_item(cur, cid, body.kind, body.item_id)  # still pending, in this project
        row, created = voice_actions.record(
            cur, cid, actor, idempotency_key=body.idempotency_key, item_kind=body.kind,
            item_id=body.item_id, action=body.action, transcript=body.transcript,
            intent={"action": body.action, "text": body.text},
        )
        conn.commit()
    return {**row, "created": created}


@app.get("/api/containers/{cid}/voice-first/actions/{vid}", status_code=200, summary="One voice action")
def voice_first_action(cid: str, vid: str, request: Request):
    _gate(cid, request)
    with db_cursor() as (_, cur):
        row = voice_actions.get(cur, cid, vid)
    if not row:
        raise HTTPException(404, "voice action not found")
    return row


@app.patch("/api/containers/{cid}/voice-first/actions/{vid}", status_code=200,
           summary="Mark a pending voice action undone (undo window) or failed")
def voice_first_finish(cid: str, vid: str, body: VoiceActionFinish, request: Request):
    if not valid_uuid(cid):
        raise HTTPException(400, "container_id is not a valid UUID")
    with db_cursor() as (conn, cur):
        require_container(cur, cid)
        _member_gate(cur, request, cid)
        actor = _actor(cur, request, cid, body.actor_agent_id)
        row = voice_actions.get(cur, cid, vid)
        if not row:
            raise HTTPException(404, "voice action not found")
        cur.execute("SELECT actor_agent_id FROM voice_actions WHERE id=%s", (vid,))
        if str(cur.fetchone()["actor_agent_id"]) != str(actor):
            raise HTTPException(403, "this voice action was recorded for another person")
        if body.status == "done" and row["action"] not in voice_conversation.WORK_ACTIONS:
            raise HTTPException(409, "a voice decision is marked done by its own route")
        voice_actions.finish(cur, vid, body.status, body.result if body.status == "done" else
                             ({"reason": body.reason} if body.reason else None))
        conn.commit()
        return voice_actions.get(cur, cid, vid)
