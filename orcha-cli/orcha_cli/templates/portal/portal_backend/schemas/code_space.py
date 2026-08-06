"""Request contracts for Orcha Code Space (Phase 1 thread endpoints)."""

from typing import Optional

from pydantic import BaseModel, Field

from portal_backend.limits import MAX_NAME_LEN, MAX_PAYLOAD_LEN


class CodeThreadCreate(BaseModel):
    actor_agent_id: str
    ref: str = Field(default="", max_length=MAX_NAME_LEN)  # "" -> the repo's default branch
    path: str = Field(..., max_length=MAX_NAME_LEN)
    start_line: int = Field(..., ge=1)
    end_line: int = Field(..., ge=1)
    kind: str = Field(default="note", pattern="^(question|why|teach|note)$")
    body: str = Field(..., max_length=MAX_PAYLOAD_LEN)
    tagged_agent_id: Optional[str] = None  # set -> a directed request wakes this agent


class CodeThreadMessageCreate(BaseModel):
    actor_agent_id: str
    body: str = Field(..., max_length=MAX_PAYLOAD_LEN)
    resolve: bool = False  # human-only: flips the thread straight to 'resolved'
