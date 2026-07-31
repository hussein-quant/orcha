"""Resolve the acting human from the OAuth proxy's verified GitHub identity."""

import os

from fastapi import HTTPException, Request

from portal_backend.agent_status import log_event
from portal_backend.application import app
from portal_backend.database import db_cursor
from portal_backend.guards import require_container, require_kind, valid_uuid

# The cloud deployment fronts the portal with a GitHub OAuth proxy that forwards the
# VERIFIED username in this header. It is trustworthy ONLY because the portal is
# loopback-bound behind that proxy — so it is read exclusively when the operator opts in
# via ORCHA_TRUST_PROXY_USER=1 (compose passthrough). Self-hosters without a proxy leave
# the env unset and the header is ignored entirely.
TRUST_ENV = "ORCHA_TRUST_PROXY_USER"
PROXY_USER_HEADER = "X-Auth-Request-User"


def _proxy_trusted() -> bool:
    """Whether the operator opted in to trusting the proxy's identity header."""
    return (os.environ.get(TRUST_ENV) or "").strip() == "1"


def proxy_login(request: Request):
    """The proxy-verified GitHub username, or None when untrusted/absent/blank."""
    if not _proxy_trusted():
        return None
    login = (request.headers.get(PROXY_USER_HEADER) or "").strip()
    return login or None


def find_member_by_login(cur, container_id, login):
    """The container's live human agent mapped to a GitHub login (case-insensitive)."""
    cur.execute(
        """SELECT id, alias, github_login, member_role FROM agents
           WHERE container_id=%s AND kind='human' AND terminated_at IS NULL
             AND lower(github_login)=lower(%s)""",
        (container_id, login),
    )
    return cur.fetchone()


def bind_first_unmapped_human(cur, container_id, login):
    """The BINDING RULE: claim the container's founding human for an arriving GitHub user.

    When the container has humans but NONE carries a github_login yet (the fresh
    `orcha init` state — one human named after the unix user, e.g. "root"), the first
    verified GitHub user to arrive IS that human: set github_login, rename the alias to
    the login (this is what turns "ACTING AS root" into the GitHub name), and promote to
    owner. Single UPDATE with WHERE guards so the 3s-polling UI can race itself safely:
      - github_login IS NULL on the target row → a concurrent bind wins exactly once
        (READ COMMITTED re-checks the row qual after the lock, so the loser no-ops);
      - NOT EXISTS any mapped human → once anyone is mapped, arrivals stop binding and
        unmatched users resolve to no identity instead (invite-only from then on);
      - the alias only changes when no other agent in the container already uses the
        login as its alias (alias is UNIQUE per container — never trade a bind for a 500).
    Returns the bound row, or None when the rule doesn't apply.
    """
    cur.execute(
        """UPDATE agents SET
               github_login=%s,
               member_role='owner',
               alias=CASE WHEN EXISTS (SELECT 1 FROM agents dup
                                        WHERE dup.container_id=agents.container_id
                                          AND dup.alias=%s AND dup.id<>agents.id)
                          THEN agents.alias ELSE %s END
           WHERE id = (SELECT id FROM agents
                        WHERE container_id=%s AND kind='human' AND terminated_at IS NULL
                        ORDER BY created_at ASC, id ASC LIMIT 1)
             AND github_login IS NULL
             AND NOT EXISTS (SELECT 1 FROM agents m
                              WHERE m.container_id=%s AND m.kind='human'
                                AND m.terminated_at IS NULL
                                AND m.github_login IS NOT NULL)
           RETURNING id, alias, github_login, member_role""",
        (login, login, login, container_id, container_id),
    )
    return cur.fetchone()


def _stamp_presence(cur, agent_id) -> bool:
    """First-sign-in mark: set last_heartbeat_at once so the members list's `pending`
    flag (github_login set ∧ last_heartbeat_at IS NULL) means "invited but has never
    signed in" — humans never run workers, so without this a bound/invited user who
    only ever browsed would read pending forever.

    Reusing last_heartbeat_at (no new column) is safe by consumer audit:
      - bump_agent already stamps HUMANS on every message/request turn, so the column
        is a mixed human+AI "last activity" signal, not a worker-liveness channel;
      - the wake scan (wake_scan_queries.list_wake_agents) filters kind='ai', so a
        human heartbeat never makes it a wake candidate;
      - the orphan-lease reaper only considers rows holding a LIVE lease
        (orphan_lease_routes._reap_lane: w.<lease_col> > now()) — humans hold none;
      - pick_human (guards) prefers the freshest heartbeat, which a sign-in stamp
        makes MORE correct ("most recently active human"), and the snapshot's
        last_active/heartbeat_age_secs simply report the sign-in as activity.
    Guarded WHERE ... IS NULL: stamped exactly once; later activity is bump_agent's.
    Returns True when this call did the stamping (caller commits)."""
    cur.execute(
        "UPDATE agents SET last_heartbeat_at = now() "
        "WHERE id = %s AND last_heartbeat_at IS NULL",
        (agent_id,),
    )
    return cur.rowcount > 0


def require_owner(cur, request: Request, container_id, actor_agent_id):
    """Gate an owner-only write; returns the acting owner's agent row.

    With a trusted proxy identity the header IS the actor (match-only — no binding side
    effect here; /api/me owns that): a non-member or non-owner is refused. Without one
    (self-hosters, ORCHA_TRUST_PROXY_USER unset) fall back to the permissive
    actor_agent_id body param, the same convention every human-gated endpoint uses
    (require_kind) — plus the owner-role check, since these routes are owner-scoped.
    """
    login = proxy_login(request)
    if login:
        member = find_member_by_login(cur, container_id, login)
        if not member:
            raise HTTPException(
                403, f"GitHub user '{login}' is not a member of this project"
            )
        if member["member_role"] != "owner":
            raise HTTPException(403, "this action requires the owner role")
        return member
    require_kind(cur, actor_agent_id, ("human",))  # Orcha#30 convention
    cur.execute(
        """SELECT id, alias, github_login, member_role FROM agents
           WHERE id=%s AND container_id=%s AND terminated_at IS NULL""",
        (actor_agent_id, container_id),
    )
    row = cur.fetchone()
    if not row:
        raise HTTPException(403, "actor is not a live member of this container")
    if row["member_role"] != "owner":
        raise HTTPException(403, "this action requires the owner role")
    return row


def _identity_payload(member):
    login = member["github_login"]
    return {
        "agent_id": str(member["id"]),
        "alias": member["alias"],
        "github_login": login,
        "member_role": member["member_role"],
        # GitHub serves any user's avatar at this well-known URL — no API call needed.
        "avatar_url": f"https://github.com/{login}.png" if login else None,
    }


@app.get("/api/me")
def get_me(request: Request, cid: str):
    """Who is the acting human, per the trusted proxy identity? {"identity": {...}|null}.

    Resolution for the container: a live human with a matching github_login is the
    actor. Else the BINDING RULE runs as a side effect (see bind_first_unmapped_human) —
    this call is what flips a fresh container's "root" human into the GitHub user. Else
    (mapped humans exist but none match, or the header is untrusted/absent) identity is
    null — the perimeter allowlist stays the hard gate; endpoints decide what null means.
    Idempotent: re-polling returns the same identity without re-binding.
    """
    if not valid_uuid(cid):
        raise HTTPException(400, "container_id is not a valid UUID")
    login = proxy_login(request)
    with db_cursor() as (conn, cur):
        require_container(cur, cid)
        if not login:
            return {"identity": None}
        member = find_member_by_login(cur, cid, login)
        if member is None:
            member = bind_first_unmapped_human(cur, cid, login)
            if member is not None:
                log_event(
                    cur,
                    cid,
                    "human",
                    str(member["id"]),
                    "agent",
                    str(member["id"]),
                    "github_identity_bound",
                    {"github_login": member["github_login"], "alias": member["alias"]},
                )
                conn.commit()
            else:
                # Lost a concurrent bind for the SAME login? Re-read before giving up.
                member = find_member_by_login(cur, cid, login)
        # Both resolution paths (match AND bind) count as "signed in": clear the
        # invited-but-never-seen state the members list renders as `pending`.
        if member is not None and _stamp_presence(cur, member["id"]):
            conn.commit()
    if member is None:
        return {"identity": None}
    return {"identity": _identity_payload(member)}
