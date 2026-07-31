"""Agent registration schemas and its optional initial-task contract."""

from typing import Literal, Optional

from pydantic import BaseModel, Field

from portal_backend.limits import (
    MAX_DESC_LEN,
    MAX_DOD_LEN,
    MAX_NAME_LEN,
    MAX_PROMPT_LEN,
)


class InitialTask(BaseModel):
    title: str = Field(..., max_length=MAX_NAME_LEN)
    description: Optional[str] = Field(default=None, max_length=MAX_DESC_LEN)
    definition_of_done: str = Field(..., max_length=MAX_DOD_LEN)
    priority: int = 100


class AgentCreate(BaseModel):
    alias: str = Field(..., max_length=64)
    role: str = Field(..., max_length=200)
    prompt: Optional[str] = Field(
        default=None,
        description=(
            "System prompt that defines this agent "
            "(required for kind='ai'; omit for 'human')"
        ),
        max_length=MAX_PROMPT_LEN,
    )
    kind: str = Field(default="ai", pattern="^(ai|human)$")
    model: Optional[str] = Field(default=None, max_length=64)
    initial_task: Optional[InitialTask] = None


class AgentCreateResponse(BaseModel):
    agent_id: str
    alias: str
    container_id: str
    initial_task: Optional[dict] = None


# GitHub usernames: alphanumeric + inner hyphens, max 39 chars (github.com rules).
_GITHUB_LOGIN_PATTERN = r"^[A-Za-z0-9](?:-?[A-Za-z0-9]){0,38}$"


class MemberCreate(BaseModel):
    """POST /api/containers/{cid}/members — owner invites a GitHub user (collab v1).

    `actor_agent_id` is the trust-off fallback actor (see identity_routes.require_owner);
    with a trusted proxy identity it may be omitted — the header IS the actor."""

    github_login: str = Field(
        ...,
        pattern=_GITHUB_LOGIN_PATTERN,
        max_length=39,
        description="GitHub username to invite (matched case-insensitively)",
    )
    role: Literal["owner", "member"] = Field(
        default="member", description="project role for the invited member"
    )
    actor_agent_id: Optional[str] = Field(
        default=None,
        description="acting human's UUID when no trusted proxy identity is present",
    )


class MemberRoleUpdate(BaseModel):
    """PATCH /api/containers/{cid}/members/{aid} — owner changes a member's role."""

    role: Literal["owner", "member"]
    actor_agent_id: Optional[str] = Field(
        default=None,
        description="acting human's UUID when no trusted proxy identity is present",
    )


class MemberRemove(BaseModel):
    """Optional actor-only body for DELETE .../members/{aid} (trust-off fallback)."""

    actor_agent_id: Optional[str] = Field(
        default=None,
        description="acting human's UUID when no trusted proxy identity is present",
    )
