# Slack integration — trigger seam (dormant until credentials)

A thin Slack seam that lets a linked member **trigger** and **observe** Orcha from
Slack — start a task from a GitHub issue/PR, read the needs-attention summary, and get
a ping when a task parks at `needs_verification`. It follows Orcha's one integration
rule: **external systems TRIGGER and OBSERVE; the verification and merge gates stay in
Orcha.** A Slack `/orcha start ...` creates a task exactly the way the GitHub hub does —
it never completes or merges anything.

**Status: built, shipped OFF.** The endpoint is dark (HTTP 503) until BOTH
`SLACK_SIGNING_SECRET` and `SLACK_BOT_TOKEN` are set in the portal's environment. With
either unset there is no Slack behavior at all — no signature check, no commands, no
outbound. Turning it on is configuration, not code.

## What it does

**Inbound — `POST /api/slack/commands`** (a Slack slash command):

| Command | Effect |
|---|---|
| `/orcha start issue <N>` | Start an Orcha task from GitHub issue #N (same internals as the hub's Start button). |
| `/orcha start pr <N>` | Start an Orcha task from GitHub PR #N. |
| `/orcha tasks` | Ephemeral summary: tasks awaiting your verification, ready-unassigned work, open requests for you. |

Every command replies **ephemerally** (only the caller sees it), well within Slack's 3s
response contract — task creation is a single fast transaction, done inline (no queues).
A Slack-started task is byte-identical to a hub-started one: both call the one shared
`task_start_core.start_task_from_github` (single source of truth), so the title
(`GH #N: …`), the templated definition-of-done, and the audit trail match.

**Outbound — needs_verification ping**: when a task transitions to `needs_verification`
(the `plan`/`pr` autonomy default — an agent finished and a human must verify), and the
container has a `slack_webhook_url` configured, Orcha POSTs a compact Block Kit message
(task title + a "Verify in Orcha" button) to that webhook. This hangs off the SAME
after-commit hook that already emits the in-portal / push "needs you" state
(`task_done_routes.mark_done` → `slack_notify.notify_task_needs_verification`). It is
**non-fatal by construction**: a missing webhook, a dead URL, or a network error is
swallowed — the transition always lands identically whether or not Slack is reachable.

## Creating the Slack app (do this tomorrow)

1. **Create the app** at <https://api.slack.com/apps> → *Create New App* → *From
   scratch*. Name it (e.g. "Orcha"), pick your workspace.
2. **Bot token scopes** (*OAuth & Permissions* → *Scopes* → *Bot Token Scopes*):
   - `commands` — to register the slash command.
   - `chat:write` — for any bot-authored messages.
   Install the app to the workspace; copy the **Bot User OAuth Token** (`xoxb-…`) — this
   is `SLACK_BOT_TOKEN`.
3. **Signing secret** (*Basic Information* → *App Credentials* → *Signing Secret*) — this
   is `SLACK_SIGNING_SECRET`. It is what verifies every inbound request actually came
   from Slack.
4. **Slash command** (*Slash Commands* → *Create New Command*):
   - Command: `/orcha`
   - Request URL: `https://<your-portal-host>/api/slack/commands`
   - Short description / usage hint: `start issue <N> | start pr <N> | tasks`
5. **Paste the two secrets** into the portal's environment (the same channel other
   secrets ride — e.g. the compose env / stack config that already carries
   `ORCHA_LLM_API_KEY`), then restart the portal. `slack_routes._slack_enabled()` reads
   both from `os.environ`; both present flips the endpoint live.
6. **Outbound (optional)**: to receive needs_verification pings, create an *Incoming
   Webhook* for the target channel and store its URL as the container's
   `slack_webhook_url` (container-level setting, mig 044). No webhook ⇒ no outbound,
   silently.

## Linking members

An inbound slash command is only honored for a member whose Slack user id is linked to
their Orcha membership (`agents.slack_user_id`, mig 044). An unknown/unlinked caller
gets an ephemeral "link your Slack in Settings" reply and **never acts** — Slack can
trigger Orcha, but only on behalf of a known member. (The Settings UI for entering the
Slack user id is the frontend's surface; the column and the mapping are here.)

## Security model

- **Request signing.** Every inbound request is verified with Slack's v0 scheme:
  `HMAC-SHA256("v0:{timestamp}:{raw_body}", SLACK_SIGNING_SECRET)`, compared in constant
  time against the `X-Slack-Signature` header, with the `X-Slack-Request-Timestamp`
  required to be within **±300 s** (replay protection). A bad, missing, or stale
  signature is a `401` before any work is done.
- **Identity, not impersonation.** The command acts as the linked member (their
  `container_id`, their creator attribution) — a Slack caller can never act as a
  member they are not linked to. Unlinked ⇒ no action.
- **The gates stay in Orcha.** Slack can only start tasks and read summaries. It cannot
  verify, complete, or merge. The `needs_verification` gate and human merge authority
  are untouched.
- **Least privilege.** Only `commands` + `chat:write` are requested. The outbound path
  uses a channel Incoming Webhook, not broad posting scopes.
- **Fail safe.** With secrets unset the whole surface is a `503` no-op; the outbound
  hook is best-effort and never affects domain state.

## Files

- `portal_backend/slack_routes.py` — the flagged endpoint, signature verification,
  command parsing, member mapping.
- `portal_backend/slack_notify.py` — the non-fatal outbound Block Kit ping.
- `portal_backend/task_start_core.py` — the shared start internals (also used by the
  GitHub hub).
- `migrations/044_slack_integration.sql` — `agents.slack_user_id` +
  `containers.slack_webhook_url` (additive, nullable).
- Tests: `tests/test_slack_routes.py`.
