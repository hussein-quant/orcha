"""List, invite, re-role, and remove a container's human members (collab v1)."""

from typing import Optional

import psycopg
from fastapi import HTTPException, Request

from portal_backend.agent_profile_routes import retire_agent_record
from portal_backend.agent_status import log_event
from portal_backend.application import app
from portal_backend.database import db_cursor
from portal_backend.guards import require_container, valid_uuid
from portal_backend.identity_routes import require_owner
from portal_backend.schemas import MemberCreate, MemberRemove, MemberRoleUpdate

_MEMBER_FIELDS = (
    "id AS agent_id, alias, github_login, member_role, "
    # pending = invited (github_login set) but never yet active in the portal. Humans
    # don't run workers, so last_heartbeat_at IS the activity signal (the snapshot's
    # last_active GREATEST() adds only worker_runs on top of it).
    "(github_login IS NOT NULL AND last_heartbeat_at IS NULL) AS pending"
)


def _require_member(cur, cid, aid):
    """A live human member of the container, or 404."""
    cur.execute(
        f"""SELECT {_MEMBER_FIELDS} FROM agents
           WHERE id=%s AND container_id=%s AND kind='human' AND terminated_at IS NULL""",
        (aid, cid),
    )
    row = cur.fetchone()
    if not row:
        raise HTTPException(404, f"no live human member {aid} in container {cid}")
    return row


def _other_owner_exists(cur, cid, aid) -> bool:
    cur.execute(
        """SELECT 1 FROM agents
           WHERE container_id=%s AND kind='human' AND terminated_at IS NULL
             AND member_role='owner' AND id<>%s LIMIT 1""",
        (cid, aid),
    )
    return cur.fetchone() is not None


@app.get("/api/containers/{cid}/members")
def list_members(cid: str):
    """The container's live human members, founding-first (same order the binding
    rule and the owner backfill use), each with a `pending` invited-but-never-seen
    flag. Read-only and ungated — the roster is already public on the snapshot."""
    if not valid_uuid(cid):
        raise HTTPException(400, "container_id is not a valid UUID")
    with db_cursor() as (_, cur):
        require_container(cur, cid)
        cur.execute(
            f"""SELECT {_MEMBER_FIELDS} FROM agents
               WHERE container_id=%s AND kind='human' AND terminated_at IS NULL
               ORDER BY created_at ASC, id ASC""",
            (cid,),
        )
        return {"members": cur.fetchall()}


@app.post("/api/containers/{cid}/members", status_code=201)
def invite_member(cid: str, body: MemberCreate, request: Request):
    """Owner-only: invite a GitHub user as a human member (alias = the login).

    The invited row is a kind='human' agent with github_login pre-set, so the moment
    that user arrives through the proxy /api/me matches them directly (no binding-rule
    involvement — that rule only fires while NO human is mapped). NOTE the cloud
    PERIMETER allowlist is synced separately cloud-side; inviting here does not by
    itself open the front door. 409 when the login is already a member (the partial
    unique index backs this against races) or the alias is taken."""
    if not valid_uuid(cid):
        raise HTTPException(400, "container_id is not a valid UUID")
    with db_cursor() as (conn, cur):
        require_container(cur, cid)
        owner = require_owner(cur, request, cid, body.actor_agent_id)
        cur.execute(
            """SELECT 1 FROM agents
               WHERE container_id=%s AND lower(github_login)=lower(%s)
                 AND terminated_at IS NULL LIMIT 1""",
            (cid, body.github_login),
        )
        if cur.fetchone():
            raise HTTPException(
                409, f"GitHub user '{body.github_login}' is already a member"
            )
        try:
            cur.execute(
                f"""INSERT INTO agents
                       (container_id, alias, role, kind, github_login, member_role)
                   VALUES (%s, %s, 'collaborator', 'human', %s, %s)
                   RETURNING {_MEMBER_FIELDS}""",
                (cid, body.github_login, body.github_login, body.role),
            )
        except psycopg.errors.UniqueViolation:
            raise HTTPException(
                409,
                f"'{body.github_login}' is already a member "
                "(or the alias is taken) in this container",
            )
        member = cur.fetchone()
        log_event(
            cur,
            cid,
            "human",
            str(owner["id"]),
            "agent",
            str(member["agent_id"]),
            "member_invited",
            {"github_login": body.github_login, "role": body.role},
        )
        conn.commit()
    return member


@app.patch("/api/containers/{cid}/members/{aid}", status_code=200)
def update_member_role(cid: str, aid: str, body: MemberRoleUpdate, request: Request):
    """Owner-only: change a member's role. Demoting the LAST owner is refused (400) —
    a container without an owner could never manage itself again."""
    if not valid_uuid(cid):
        raise HTTPException(400, "container_id is not a valid UUID")
    if not valid_uuid(aid):
        raise HTTPException(400, "agent_id is not a valid UUID")
    with db_cursor() as (conn, cur):
        require_container(cur, cid)
        owner = require_owner(cur, request, cid, body.actor_agent_id)
        member = _require_member(cur, cid, aid)
        if (
            member["member_role"] == "owner"
            and body.role != "owner"
            and not _other_owner_exists(cur, cid, aid)
        ):
            raise HTTPException(400, "cannot demote the last owner")
        cur.execute(
            f"UPDATE agents SET member_role=%s WHERE id=%s RETURNING {_MEMBER_FIELDS}",
            (body.role, aid),
        )
        updated = cur.fetchone()
        log_event(
            cur,
            cid,
            "human",
            str(owner["id"]),
            "agent",
            aid,
            "member_role_changed",
            {"from": member["member_role"], "to": body.role},
        )
        conn.commit()
    return updated


@app.delete("/api/containers/{cid}/members/{aid}", status_code=200)
def remove_member(
    cid: str, aid: str, request: Request, body: Optional[MemberRemove] = None
):
    """Owner-only: remove a member — the existing agent-RETIRE semantics, never a hard
    delete (the audit trail and thread attribution keep pointing at the row). Removing
    the LAST owner is refused (400). Any task naming the removed member as its reviewer
    reverts to reviewer=anyone."""
    if not valid_uuid(cid):
        raise HTTPException(400, "container_id is not a valid UUID")
    if not valid_uuid(aid):
        raise HTTPException(400, "agent_id is not a valid UUID")
    with db_cursor() as (conn, cur):
        require_container(cur, cid)
        owner = require_owner(
            cur, request, cid, body.actor_agent_id if body else None
        )
        member = _require_member(cur, cid, aid)
        if member["member_role"] == "owner" and not _other_owner_exists(cur, cid, aid):
            raise HTTPException(400, "cannot remove the last owner")
        released = retire_agent_record(cur, aid)  # ISS-51 mechanics, reused
        cur.execute(
            "UPDATE tasks SET reviewer_agent_id=NULL "
            "WHERE container_id=%s AND reviewer_agent_id=%s RETURNING id",
            (cid, aid),
        )
        cleared_reviews = [str(r["id"]) for r in cur.fetchall()]
        log_event(
            cur,
            cid,
            "human",
            str(owner["id"]),
            "agent",
            aid,
            "member_removed",
            {
                "github_login": member["github_login"],
                "released_tasks": released,
                "cleared_reviewer_on": cleared_reviews,
            },
        )
        conn.commit()
    return {
        "agent_id": aid,
        "status": "terminated",
        "released_tasks": released,
        "cleared_reviewer_on": cleared_reviews,
    }
