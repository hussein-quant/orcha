# Agent → PR: sandboxed agents open pull requests as the app bot

Sandboxed Orcha agents can branch, commit, push, and open GitHub pull requests
— always as the **`orcha-cloud-app[bot]`** GitHub App installation, never as a
human's account. A PR is a *proposal*: merging is always a human decision, the
same authority gate as the Orcha task flow's `needs_verification` stop.

## The pieces

### Bot identity (who authors the commits)

`deploy/provision-projects.sh` sets **workspace-local** git config on every
repo it clones:

- `user.name` → `orcha-cloud-app[bot]` (the slug from
  `/opt/orcha-secrets/github-app.json`, falling back to `orcha-cloud-app`)
- `user.email` → `<APP_ID>+orcha-cloud-app[bot]@users.noreply.github.com`
  (APP_ID from the same secrets file)

So commits and PRs are attributed to the App bot on GitHub, and no human
credential ever enters a container. Workspaces provisioned **before** this
landed don't get a migration pass — apply the config once by hand (exact
commands in `deploy/README.md`, "Bot commit identity").

### Token rotation (how the bot authenticates)

The App's private key (PEM) stays on the host. A systemd timer
(`deploy/github-token-refresh.sh`, every 40 min) mints a **1-hour installation
token** into each workspace at `<workspace-root>/.orcha/github-token`. The
sandbox mounts the workspace **path-identically** (same absolute path inside
the container) and stamps `ORCHA_WORKSPACE_ROOT=<root>` into the container
env, so the token file is at the same path everywhere — including from a git
worktree spawn, whose own `.orcha` is the repo's committed dir, not the
runtime one. Repo-bound workspaces get a token minted from the
**owner-matched installation, scoped to that repo**.

Two consumers read it, both at *use time* so rotation never strands them:

- **git** — the credential helper the provisioner installs:
  `password=$(cat "$d/.orcha/github-token")` where `d` is
  `$ORCHA_WORKSPACE_ROOT`, falling back to walking up from `$PWD` — evaluated
  per operation.
- **gh** — the runner image ships `/usr/local/bin/gh`, a tiny POSIX-sh wrapper
  that shadows the real `/usr/bin/gh` via PATH order and resolves
  `$ORCHA_WORKSPACE_ROOT/.orcha/github-token` (same `$PWD` walk-up fallback)
  into `GH_TOKEN` on **every invocation**. A resident session that lives for
  hours never holds a stale token, and the token never appears in argv or on
  screen.

The `gh` binary itself comes from GitHub's official apt repo
(`templates/runner/Dockerfile`); nothing is pinned beyond the repo.

### What agents do

Agents get a standing "Working with the repository" block in their wake
persona (`REPO_WORKFLOW_GUIDANCE` in `orcha_cli/notifier_persona.py`), gated
on the workspace actually carrying a git checkout **and** the token file:

1. never commit to the default branch;
2. branch per piece of work: `git checkout -b orcha/<task-slug>`;
3. commit (the bot identity is preconfigured), `git push -u origin <branch>`;
4. `gh pr create --title ... --body ...` — the body ends with a reference to
   the Orcha work log (task/thread) and a note that a human reviews it.

### What humans do

Review and merge. Nothing in this pipeline can self-approve: the bot has no
review authority over itself, agents are instructed that merge is always
human, and the Orcha-side work stops at `needs_verification` regardless.

## Limits

- **Repo reach = the App installation's repository selection.** Agents can
  only touch repos the `orcha-cloud-app` App is installed on (install it per
  org/user; the refresh timer discovers all installations automatically —
  see "Multi-org" in `deploy/README.md`).
- Tokens live 1 hour and are scoped to the bound repo where a binding exists.
- The wrapper reads the token fresh but cannot conjure one: a workspace the
  timers don't know about has no `.orcha/github-token` and `gh` runs
  unauthenticated.

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| `<workspace-root>/.orcha/github-token` absent | The workspace isn't in `/opt/orcha-work/workspaces.list`, or the refresh timer isn't running: `systemctl status github-token-refresh.timer`, then check `journalctl -u github-token-refresh`. |
| `gh` says "not logged in" / 401 | Empty or stale token file → same timer checks as above. Also confirm the App is **installed on the target repo** (app page → Install App). |
| Push rejected (403) on a repo the agent can read | Token is repo-scoped to the *bound* repo; pushing elsewhere needs that repo in the App installation and (for scoping) a binding. |
| Commits attributed to a human | Workspace predates the provisioner change — apply the "Bot commit identity" one-liner from `deploy/README.md`. |
| `gh` works interactively but a long resident session 401s | You're not using the image wrapper (`which gh` should print `/usr/local/bin/gh`). Rebuild the runner image: `orcha sandbox build-image`. |
