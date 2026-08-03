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
| `/orcha tasks` | Ephemeral "Needs you": up to 5 needs_verification tasks (linked), open-request and ready-unassigned counts. |

Every command replies **ephemerally** (only the caller sees it) as a small Block Kit
message — header, mrkdwn section(s), a muted context line, and a button where a link
belongs — well within Slack's 3s response contract. A Slack-started task is
byte-identical to a hub-started one: both call the one shared
`task_start_core.start_task_from_github` (single source of truth), so the title
(`GH #N: <the real GitHub title>`), the templated definition-of-done, and the audit
trail match. The Slack seam does the ONE extra live GitHub fetch (issue/PR title +
html_url + body excerpt) the hub gets for free from its frontend's already-loaded list
row — a bare Slack number has no title to pass otherwise. If that fetch fails (repo
not bound, no installation token, GitHub unreachable/rate-limited), the command still
succeeds and degrades to the bare `#N` title rather than erroring the dispatch.

**Outbound — needs_verification ping**: when a task transitions to `needs_verification`
(the `plan`/`pr` autonomy default — an agent finished and a human must verify), and the
container has a `slack_webhook_url` configured, Orcha POSTs a compact Block Kit message
("🛡️ Needs your verification" header, the task title as a link, a project/agent context
line, and a "Verify in Orcha" button) to that webhook — ONE message, no channel noise.
This hangs off the SAME after-commit hook that already emits the in-portal / push
"needs you" state (`task_done_routes.mark_done` →
`slack_notify.notify_task_needs_verification`). It is **non-fatal by construction**: a
missing webhook, a dead URL, or a network error is swallowed — the transition always
lands identically whether or not Slack is reachable.

**Outbound — GitHub round-trip comment**: every FRESH task start (hub Start/Fix button
OR Slack `/orcha start` — never a `{existing:true}` re-click) also posts a short
comment back on the source GitHub issue/PR: "🤖 Orcha started task `<id8>` for this —
assigned to **<alias>**" (or "unassigned — the orchestrator routes it"), plus a line
noting work arrives as a PR and a human verifies before anything merges. Posted from
`task_start_core.start_task_from_github` itself (the shared core), so every dispatch
path gets it exactly once, never duplicated. Same non-fatal contract as the Slack
ping: no bound repo, no installation token, or any GitHub failure is caught and
swallowed — a dead comment never breaks task creation. Requires the GitHub App's
`Issues: Read and write` permission (already required for `gh issue create` — see
`docs/byoc-guide.md`'s permission table); PR comments ride the same
`issues/{number}/comments` endpoint GitHub uses for both issues and PRs.

**Block Kit design language** (all Slack-facing messages, `slack_notify.py`): a header
line with an emoji glyph, mrkdwn sections, muted context lines, and buttons where a
link belongs — absolute portal URLs, since Slack buttons must be externally reachable
(`ORCHA_PORTAL_BASE_URL`, the same config-based source both the outbound ping and the
inbound replies read through `slack_notify.portal_base_url()`/`portal_task_link()`; a
button deep-links to the extensionless `/tasks?cid=...&task=...` route the portal
actually serves — never a `/tasks.html` path, which 404s). Every composer is a small
pure function (`blocks_start_success`, `blocks_already_tracked`, `blocks_unlinked_user`,
`blocks_usage_help`, `blocks_tasks_summary`, `blocks_needs_verification`) returning a
block array; mrkdwn-unsafe characters (`<`, `>`, `&`) in a task/issue title are always
escaped (`_mrkdwn_escape`) before landing in a block.

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

## Cross-seam consistency: the hub also knows about a Slack start

Because a Slack start and a hub start share the same `task_start_core` internals, the
GitHub hub's issue/PR list and detail endpoints (`github_hub_routes.py`) carry a
`tracked_task_id` field on every row/item — computed fresh on every request from the
SAME open-task lookup (`task_start_core.find_open_gh_tasks`) the idempotency check
uses. So an issue started via `/orcha start issue 232` shows as tracked on the hub's
NEXT page load, not only after a hub click (which would itself just bounce off
`{existing:true}`). This is deliberately NOT Slack-specific plumbing — it is the
general "any dispatch path is visible from any other surface" property the shared
core exists to guarantee.

## Files

- `portal_backend/slack_routes.py` — the flagged endpoint, signature verification,
  command parsing, member mapping, the live GitHub title fetch for `/orcha start`.
- `portal_backend/slack_notify.py` — the Block Kit composers (inbound ephemeral
  replies AND the outbound ping) + the non-fatal outbound webhook POST.
- `portal_backend/task_start_core.py` — the shared start internals (also used by the
  GitHub hub): task creation/idempotency, the batched `find_open_gh_tasks` tracked-
  state lookup, and the non-fatal GitHub round-trip comment.
- `portal_backend/github_hub_routes.py` — `tracked_task_id` on the issues/pulls list
  and detail endpoints (`_with_tracked_list`/`_with_tracked_one`).
- `static/pages/github-render.js` — `startedOf()` reads the server's
  `tracked_task_id` (any dispatch path, any session) ahead of the page's own
  in-session Start-click cache.
- `migrations/044_slack_integration.sql` — `agents.slack_user_id` +
  `containers.slack_webhook_url` (additive, nullable).
- Tests: `tests/test_slack_routes.py`, `tests/test_task_start_core.py`,
  `tests/test_github_hub_routes.py`, `tests/portal/github_hub_live_defects.test.js`.
