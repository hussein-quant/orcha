# Slack integration — trigger seam (dormant until credentials)

A thin Slack seam that lets a linked member **trigger** and **observe** Orcha from
Slack — start a task from a GitHub issue/PR, file a new GitHub issue (from a slash
command OR a message shortcut, screenshots included), read the needs-attention
summary, and get a ping when a task parks at `needs_verification`. It follows Orcha's
one integration rule: **external systems TRIGGER and OBSERVE; the verification and
merge gates stay in Orcha.** A Slack `/orcha start ...` / `/orcha issue ...` / message
shortcut creates a task or issue exactly the way the GitHub hub does — it never
completes or merges anything.

**Status: built, shipped OFF.** Both endpoints (`/api/slack/commands` and
`/api/slack/interactions`) are dark (HTTP 503) until BOTH `SLACK_SIGNING_SECRET` and
`SLACK_BOT_TOKEN` are set in the portal's environment. With either unset there is no
Slack behavior at all — no signature check, no commands, no interactions, no outbound.
Turning it on is configuration, not code.

## What it does

**Inbound — `POST /api/slack/commands`** (a Slack slash command):

| Command | Effect |
|---|---|
| `/orcha start issue <N>` | Start an Orcha task from GitHub issue #N (same internals as the hub's Start button). |
| `/orcha start pr <N>` | Start an Orcha task from GitHub PR #N. |
| `/orcha issue <title> [-- <body>]` | File a NEW GitHub issue in the container's connected repo. Everything before an optional ` -- ` separator is the title; the rest is the body. |
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

**Inbound — `POST /api/slack/interactions`** (message shortcuts, modal submission,
button clicks) — see "Creating issues from Slack" below.

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

## Creating issues from Slack

Two ways to file a GitHub issue in the container's connected repo without leaving
Slack, both attributed to the linked member via a footer line on the issue body
("_Filed from Slack by \<github_login\> via Orcha_"):

### 1. Slash command — `/orcha issue <title> [-- <body>]`

Everything before an optional ` -- ` separator becomes the title; anything after
becomes the body. `/orcha issue Login button is misaligned -- happens only on Safari`
files an issue titled "Login button is misaligned" with that body line. The reply is
the same "📝 Issue filed" Block Kit card the message shortcut uses (below) — a link to
the new issue on GitHub, and a **real, clickable "Start Orcha task" button** (routed
through `POST /api/slack/interactions` as a `block_actions` click, driving the same
shared `task_start_core.start_task_from_github` every other dispatch path uses — not
just a hint to run another command). A 403 from GitHub (the App's installation lacks
`Issues: Read and write`) never surfaces as a raw error — it's a friendly "🔒 Can't
file that issue" card telling the member the App needs that permission.

### 2. Message shortcut — "Create GitHub issue" / "Create Orcha task"

Right-click (or use the "More actions" `⋯` menu on) any Slack message → one of two
shortcuts:

- **"Create GitHub issue"** opens a modal (title pre-filled from the message's first
  line, body pre-filled with the full message text + a "— from Slack conversation"
  provenance footer) → **File issue** creates the GitHub issue and DMs a confirmation
  card back.
- **"Create Orcha task"** opens the SAME modal plus an optional **Assignee** picker
  (the container's live AI agents, or "Let the orchestrator route it" for unassigned)
  → **Create task** does the FULL pipeline: creates the GitHub issue (same footer),
  then immediately starts an Orcha task from it through the shared
  `task_start_core` path (passing the chosen assignee, if any) — which also fires the
  existing non-fatal dispatch comment on the fresh issue. The confirmation card is
  "🚀 Task created" with links to BOTH the GitHub issue and the Orcha task. If the
  issue is created but starting the task fails, the card says so honestly (issue link
  + "starting the Orcha task failed — run `/orcha start issue <N>` to retry") — it
  never silently half-succeeds by showing a task link that doesn't resolve.

Both shortcuts share one modal layout (`slack_notify.build_create_issue_modal`);
`view_submission` routes on the submitted view's own callback_id to either just file
the issue, or file it AND start the task.

**Screenshots travel with the work.** If the source message carries images (the first
5, `image/*` mimetypes only, each ≤5MB), they're downloaded and:
  - Committed into the connected repo under
    `.github/orcha-attachments/<issue-slug>/` via the GitHub Contents API and embedded
    as markdown images in the issue body (`### Screenshots` + one `![name](url)` per
    landed file) — **private repo, so visibility follows the repo's own access**, same
    as every other file in it.
  - For the "Create Orcha task" shortcut ONLY, the same downloaded images are *also*
    attached to the created task via the portal's existing task-attachments machinery
    — the same store `POST /api/tasks/{tid}/attachments` writes to — so a sandboxed
    agent working the task can fetch and actually look at the screenshot (the whole
    point: the AI reviews the image, not just a link to it).

Downloading a Slack file requires the **`files:read`** OAuth scope (see the updated
scope list below) — **without it, the issue/task is still filed, just without
images**, and the confirmation card says so explicitly (e.g. "2 screenshots skipped —
add the files:read scope and reinstall the App"). Any per-image failure (download,
GitHub commit, or task-attach) is isolated to that one file — one bad screenshot never
fails the whole issue/task creation — and the confirmation card's screenshot count is
always honest about how many actually landed (e.g. "2/3 screenshots attached").

### App-config steps for the message shortcuts

1. **Interactivity & Shortcuts** (left sidebar of your app at
   <https://api.slack.com/apps>) → toggle **Interactivity** ON.
2. **Request URL**: `https://<your-portal-host>/api/slack/interactions`
3. **Create New Shortcut** → **On messages** → name it **"Create GitHub issue"** →
   callback_id **`create_github_issue`** → **Create**.
4. **Create New Shortcut** again → **On messages** → name it **"Create Orcha task"** →
   callback_id **`create_orcha_task`** → **Create**. (Both shortcuts share the one
   Interactivity Request URL from step 2 — no separate endpoint per shortcut.)
5. Save changes; if Slack prompts to **reinstall the app** to your workspace, do it —
   new shortcuts/scopes only take effect after reinstall.

The `/api/slack/*` prefix (both `/api/slack/commands` and `/api/slack/interactions`)
bypasses the portal's OAuth reverse-proxy perimeter (`deploy/auth/Caddyfile` /
`docs/byoc-guide.md`'s host-Caddy reference block) — Slack's servers can't complete a
browser OAuth flow or carry a bearer token, so the app-level Slack v0 signature check
is the real gate for this prefix, not the proxy. No further Caddy change is needed
once that bypass is in place.

**Caddy note:** the `/api/slack/*` bypass block referenced above ships in this same
change — a prior version of this doc assumed it already existed on deployed boxes; it
did not, and Slack's real (unauthenticated) traffic to `/api/slack/commands` would
previously have been redirected into the browser sign-in flow by the perimeter's
catch-all. Existing self-hosted boxes running the `docs/byoc-guide.md` host-Caddy
reference block need to hand-add the equivalent `handle /api/slack/* { reverse_proxy
127.0.0.1:8001 }` block (ahead of the catch-all) and `systemctl reload caddy`.

## Block Kit design language

All Slack-facing messages live in `slack_notify.py`: a header line with an emoji
glyph, mrkdwn sections, muted context lines, and buttons where a link belongs —
absolute portal URLs, since Slack buttons must be externally reachable
(`ORCHA_PORTAL_BASE_URL`, the same config-based source both the outbound ping and the
inbound replies read through `slack_notify.portal_base_url()`/`portal_task_link()`; a
button deep-links to the extensionless `/tasks?cid=...&task=...` route the portal
actually serves — never a `/tasks.html` path, which 404s). Every composer is a small
pure function (`blocks_start_success`, `blocks_already_tracked`, `blocks_unlinked_user`,
`blocks_usage_help`, `blocks_tasks_summary`, `blocks_needs_verification`,
`blocks_issue_filed`, `blocks_task_created`, `blocks_github_permission_error`,
`blocks_github_unreachable_error`, `blocks_issue_usage_help`,
`build_create_issue_modal`, `build_unlinked_user_modal`) returning a block/view
structure; mrkdwn-unsafe characters (`<`, `>`, `&`) in a task/issue title are always
escaped (`_mrkdwn_escape`) before landing in a block.

## Creating the Slack app (do this tomorrow)

1. **Create the app** at <https://api.slack.com/apps> → *Create New App* → *From
   scratch*. Name it (e.g. "Orcha"), pick your workspace.
2. **Bot token scopes** (*OAuth & Permissions* → *Scopes* → *Bot Token Scopes*):
   - `commands` — to register the slash command.
   - `chat:write` — for any bot-authored messages (including the modal-submission
     confirmation DMs).
   - `files:read` — **new**, required to download image attachments (screenshots) off
     a Slack message for the "Creating issues from Slack" flow. Without it, issue/task
     creation still works — images are simply skipped and the confirmation card says
     so ("N screenshots skipped — add the files:read scope and reinstall the App").
   Install the app to the workspace; copy the **Bot User OAuth Token** (`xoxb-…`) — this
   is `SLACK_BOT_TOKEN`.
3. **Signing secret** (*Basic Information* → *App Credentials* → *Signing Secret*) — this
   is `SLACK_SIGNING_SECRET`. It is what verifies every inbound request actually came
   from Slack (both `/api/slack/commands` and `/api/slack/interactions` use it).
4. **Slash command** (*Slash Commands* → *Create New Command*):
   - Command: `/orcha`
   - Request URL: `https://<your-portal-host>/api/slack/commands`
   - Short description / usage hint: `start issue <N> | start pr <N> | issue <title> [-- <body>] | tasks`
5. **Interactivity & Shortcuts** (for the two message shortcuts) — see "Creating
   issues from Slack" → "App-config steps for the message shortcuts" above for the
   exact click-by-click steps (Interactivity Request URL, both shortcuts' names and
   callback_ids).
6. **Reinstall the app** to the workspace if Slack prompts you to (adding scopes or
   shortcuts after the initial install always requires this — new permissions/shortcuts
   don't take effect until you do).
7. **Paste the two secrets** into the portal's environment (the same channel other
   secrets ride — e.g. the compose env / stack config that already carries
   `ORCHA_LLM_API_KEY`), then restart the portal. `slack_routes._slack_enabled()` reads
   both from `os.environ`; both present flips BOTH endpoints live.
8. **Caddy**: confirm the box's reverse-proxy config has the `/api/slack/*` bypass
   block (ships in `deploy/auth/Caddyfile` as of this change; self-hosted boxes on the
   `docs/byoc-guide.md` host-Caddy reference block need to hand-add it — see the note
   above). Without it, Slack's requests never reach the app-level signature check at
   all.
9. **Outbound (optional)**: to receive needs_verification pings, create an *Incoming
   Webhook* for the target channel and store its URL as the container's
   `slack_webhook_url` (container-level setting, mig 044). No webhook ⇒ no outbound,
   silently.

## Linking members

An inbound slash command OR interaction (shortcut, modal submission, button click) is
only honored for a member whose Slack user id is linked to their Orcha membership
(`agents.slack_user_id`, mig 044). An unknown/unlinked caller gets an ephemeral "link
your Slack in Settings" reply (slash commands / block_actions) or a small "Not linked"
modal (message shortcuts — `views.open` is the only ack mechanism available for that
payload type, so a small informational modal stands in for the ephemeral reply) and
**never acts** — Slack can trigger Orcha, but only on behalf of a known member. A
`view_submission` re-validates the linked member from the modal's `private_metadata`
(set at open time) before doing anything, so a modal can't be reused past a member
being unlinked mid-flow. (The Settings UI for entering the Slack user id is the
frontend's surface; the column and the mapping are here.)

## Security model

- **Request signing.** Every inbound request — both `/api/slack/commands` and
  `/api/slack/interactions` — is verified with Slack's v0 scheme:
  `HMAC-SHA256("v0:{timestamp}:{raw_body}", SLACK_SIGNING_SECRET)`, compared in constant
  time against the `X-Slack-Signature` header, with the `X-Slack-Request-Timestamp`
  required to be within **±300 s** (replay protection). A bad, missing, or stale
  signature is a `401` before any work is done.
- **Identity, not impersonation.** The command/interaction acts as the linked member
  (their `container_id`, their creator attribution) — a Slack caller can never act as a
  member they are not linked to. Unlinked ⇒ no action.
- **The gates stay in Orcha.** Slack can start tasks, file GitHub issues, and read
  summaries. It cannot verify, complete, or merge. The `needs_verification` gate and
  human merge authority are untouched.
- **Least privilege.** `commands` + `chat:write` + `files:read` are the only bot
  scopes requested — no broad `channels:history`/`groups:history` scope is needed
  since shortcuts deliver the SOURCE message inline in the payload itself. GitHub-side,
  issue creation and screenshot commits ride the App's existing `Issues: Read and
  write` / `Contents: Read and write` installation permissions — no new GitHub
  permission beyond what the round-trip comment already required. The outbound
  needs_verification ping uses a channel Incoming Webhook, not a broad posting scope.
- **Fail safe.** With secrets unset the whole surface (`/commands` AND
  `/interactions`) is a `503` no-op; the outbound webhook ping is best-effort and never
  affects domain state; a missing `files:read` scope degrades screenshot handling
  gracefully rather than failing issue/task creation.
- **Reverse-proxy bypass, not an open door.** `/api/slack/*` is exempted from the
  portal's OAuth perimeter (Caddy) because Slack can't complete that flow — but every
  request landing there still must pass the app-level signature check above before any
  work happens; the bypass only lets that check run at all.

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

- `portal_backend/slack_routes.py` — both flagged endpoints (`/commands`,
  `/interactions`), signature verification, command parsing (`/orcha start`, `/orcha
  issue`), member mapping, the live GitHub title fetch for `/orcha start`, GitHub
  issue creation (`create_github_issue`, `_gh_post_issue`), the Contents-API
  screenshot commit (`_gh_put_contents`, `_commit_images_to_repo`,
  `_embed_images_markdown`), the shortcut/modal/view_submission/block_actions
  handlers, and task-attachment landing (`_land_images_on_task`).
- `portal_backend/slack_notify.py` — the Block Kit composers (inbound ephemeral
  replies, modal views, and the outbound ping) + the non-fatal outbound webhook POST +
  `call_slack_api` (the authenticated Slack Web API leaf for `views.open`/
  `views.update`/`chat.postMessage`).
- `portal_backend/slack_files.py` — Slack message-file selection (count/mimetype/size
  filtering) and download (`files:read`-gated, with the scope-missing degradation
  path).
- `portal_backend/task_start_core.py` — the shared start internals (also used by the
  GitHub hub and the "Create Orcha task" shortcut): task creation/idempotency, the
  batched `find_open_gh_tasks` tracked-state lookup, and the non-fatal GitHub
  round-trip comment.
- `portal_backend/github_hub_routes.py` — `tracked_task_id` on the issues/pulls list
  and detail endpoints (`_with_tracked_list`/`_with_tracked_one`).
- `portal_backend/attachment_references.py` / `attachment_storage.py` — the existing
  task-attachment store/ref machinery the screenshot-landing path reuses in-process
  (same store `POST /api/tasks/{tid}/attachments` writes to).
- `static/pages/github-render.js` — `startedOf()` reads the server's
  `tracked_task_id` (any dispatch path, any session) ahead of the page's own
  in-session Start-click cache.
- `migrations/044_slack_integration.sql` — `agents.slack_user_id` +
  `containers.slack_webhook_url` (additive, nullable).
- `deploy/auth/Caddyfile` / `docs/byoc-guide.md` — the `/api/slack/*` OAuth-perimeter
  bypass block.
- Tests: `tests/test_slack_routes.py`, `tests/test_slack_files.py`,
  `tests/test_task_start_core.py`, `tests/test_github_hub_routes.py`,
  `tests/portal/github_hub_live_defects.test.js`.
