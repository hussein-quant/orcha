"""Request contracts for Orcha Code Space (Phase 1 thread endpoints + Phase 1+2
local-binding working-tree editing: write/commit/push)."""

from typing import List, Optional

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


class WorktreeFileWrite(BaseModel):
    """PUT .../code/worktree/file body. `content` is intentionally an UNCONSTRAINED
    str (no Field max_length) — the 2MB cap is enforced in the route as an honest
    {ok:false, reason:"too_large"} payload, not a 422 validation error, matching
    this portal's "the write itself degrades, it doesn't fail the request" idiom.
    `base_hash` is the optimistic-concurrency token: null means "I'm creating a new
    file"; any other value must match the CURRENT worktree_file_hash() or the write
    is refused as drift."""

    path: str = Field(..., max_length=MAX_NAME_LEN)
    content: str
    base_hash: Optional[str] = None


class WorktreeCommitCreate(BaseModel):
    """POST .../code/worktree/commit body. `paths` are the repo-relative files to
    `git add -A -- <paths>` before committing — deliberately explicit (not "commit
    everything dirty") so an editor commit only ever touches the files the human
    actually reviewed. `author_name`/`author_email` are optional per-commit identity
    overrides (see local_git.stage_and_commit); when omitted, the repo/environment's
    own configured git identity is used unchanged."""

    paths: List[str] = Field(..., min_length=1)
    message: str = Field(..., max_length=MAX_PAYLOAD_LEN)
    author_name: Optional[str] = Field(default=None, max_length=MAX_NAME_LEN)
    author_email: Optional[str] = Field(default=None, max_length=MAX_NAME_LEN)
