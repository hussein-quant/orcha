# Box bootstrap — dogfood / BYOC

Turn any Ubuntu-ish VM (Hetzner CX32, or a customer VPC box) into an
auth-fronted Orcha with sandboxed agent wakes. This is the manual v1 of what
the control plane will automate.

## 0. Prerequisites

- DNS A record: `orcha.<yourdomain>` → the box's IP
- GitHub OAuth app (Settings → Developer settings → OAuth Apps):
  callback `https://orcha.<yourdomain>/oauth2/callback`
- Firewall: allow 22, 80, 443 only (`ufw allow 22,80,443/tcp && ufw enable`)

## 1. Docker + orcha-cli

```bash
curl -fsSL https://get.docker.com | sh
```

**Private-repo clone via the GitHub App** (no PATs, no deploy keys). One-time:
copy the app credentials created by setup-github.py to the box and install the
app on the repo (app page → Install App → select `orcha-cloud`):

```bash
ssh <box> mkdir -p /opt/orcha-secrets
scp deploy/auth/github-app.pem deploy/auth/github-app.json <box>:/opt/orcha-secrets/
ssh <box> chmod 600 /opt/orcha-secrets/github-app.pem
scp deploy/github-app-token.py deploy/bootstrap-clone.sh <box>:/tmp/
ssh <box> 'sh /tmp/bootstrap-clone.sh'     # clones → /opt/orcha-cloud, installs orcha-cli
```

Re-run `bootstrap-clone.sh` anytime to pull + reinstall (tokens are minted
fresh, used once, and scrubbed from git config).

## 2. Project + sandbox mode

```bash
mkdir -p ~/work/myproj && cd ~/work/myproj
orcha init            # renders the stack; note the portal port (default 8000)
orcha sandbox on
orcha sandbox build-image
```

Provider credentials for sandbox wakes (choose one) — export in the
environment that starts the notifier daemon:

```bash
export ANTHROPIC_API_KEY=sk-ant-...          # API billing
# or, BYOC subscription auth (your own Claude Code subscription):
claude setup-token                            # one interactive mint
export CLAUDE_CODE_OAUTH_TOKEN=<token>
```

Then `orcha up`.

## 3. Auth perimeter

**Easy path (recommended)** — on your LAPTOP, one command + one GitHub click:

```bash
python3 deploy/setup-github.py \
  --domain orcha.<yourdomain> --acme-email you@example.com \
  --users <github-usernames> --stack-network orcha-<project>_default
scp deploy/auth/.env <box>:/opt/orcha-cloud/deploy/auth/.env
```

This creates a GitHub App via the manifest flow (sign-in now; repo access
credentials banked for later) and writes a complete .env — no manual OAuth-app
clicking, no secret copy-pasting.

**Manual path**:

```bash
cd orcha-cloud/deploy/auth
cp .env.example .env && $EDITOR .env          # domain, OAuth app, roster, tokens
# bind the portal to loopback (public entrance = Caddy only):
(cd ~/work/myproj/.orcha && docker compose -f docker-compose.yml \
   -f ~/orcha-cloud/deploy/auth/docker-compose.portal-local.yml up -d portal)
docker compose --env-file .env -f docker-compose.auth.yml up -d
```

Verify:

- Browser → `https://orcha.<yourdomain>` → GitHub sign-in → portal (allowlisted
  users only).
- Bearer lane: `curl -H "Authorization: Bearer $ORCHA_TEAM_TOKEN" https://orcha.<yourdomain>/api/containers` → JSON.
- No token, no session: `curl -sI https://orcha.<yourdomain>/api/containers` → 302 to sign-in.
- `curl -sI http://<box-ip>:8000` from outside → connection refused (loopback bind).

## 4. Phone

The iOS app must send `Authorization: Bearer <team token>` — that change rides
the iOS branch stack. Until it's installed, supervise from the browser.

## Agent repo access (sandboxed pull/push/PR as the app bot)

The app's PEM never enters a container. A systemd timer refreshes a 1-hour
installation token into each workspace, where sandboxes read it via the mount:

```bash
scp deploy/github-token-refresh.* <box>:/opt/orcha-cloud/deploy/
ssh <box> 'cp /opt/orcha-cloud/deploy/github-token-refresh.{service,timer} /etc/systemd/system/ \
  && systemctl daemon-reload && systemctl enable --now github-token-refresh.timer'
```

Then in a workspace repo (once, from the host or an agent task). The helper
resolves the token via `ORCHA_WORKSPACE_ROOT` (stamped by the sandbox, which
mounts the workspace path-identically) and falls back to walking up from
`$PWD` — so it also works from a git-worktree checkout and in host mode:

```bash
git config credential.helper \
  '!f() { d="${ORCHA_WORKSPACE_ROOT:-$PWD}"; while [ -n "$d" ] && [ "$d" != "/" ] && [ ! -f "$d/.orcha/github-token" ]; do d=$(dirname "$d"); done; echo username=x-access-token; echo "password=$(cat "$d/.orcha/github-token")"; }; f'
```

**Bot commit identity**: the provisioner also sets workspace-local git config on
cloned repos so commits are authored by the app bot, never a human account —
`user.name orcha-cloud-app[bot]`, `user.email
<APP_ID>+orcha-cloud-app[bot]@users.noreply.github.com` (APP_ID and slug come
from `github-app.json`). Pre-existing workspaces don't get a migration pass —
apply it manually once per workspace:

```bash
cd <ws> && git config user.name 'orcha-cloud-app[bot]' \
  && git config user.email "$(python3 -c "import json;print(json.load(open('/opt/orcha-secrets/github-app.json'))['id'])")+orcha-cloud-app[bot]@users.noreply.github.com"
```

Agents clone/pull/push over https as the app bot, and open PRs with the `gh`
CLI baked into the runner image (its `/usr/local/bin/gh` wrapper re-reads the
rotating token on every invocation, so auth is always fresh). Install the app
on every target repo. Note: commits/PRs are attributed to the app bot; the
human PR review remains the authority gate, same as the Orcha task flow. Full
story: `docs/agent-prs.md`.

**Multi-org**: install the app on each org/user whose repos Orcha should reach
(app page → Install App, once per org). The refresh timer discovers all
installations automatically: a workspace whose container is bound to a repo
(portal `GET /api/containers/{cid}/github`) gets its `github-token` minted from
the matching owner's installation, scoped to that repo; unbound workspaces keep
getting the first installation's token. The timer also writes
`<ws>/.orcha/github-tokens.json` (`{"<owner-lowercase>": "<token>"}` for every
installation) which the portal reads to list repos across all orgs in the
Connect-repo modal. `github-app-token.py --list-installations` prints the
installations; `--repo owner/name` auto-selects the owner's installation.

## Project runtime provisioning (portal-created projects get a real runtime)

A project created from the portal (POST /api/containers) starts as a DB row
only — no workspace, no notifier, so its agents never wake. The
`provision-projects` timer (2-min) closes that gap on the box:

```bash
scp deploy/provision-projects.* <box>:/opt/orcha-cloud/deploy/
ssh <box> 'cp /opt/orcha-cloud/deploy/provision-projects.{service,timer} /etc/systemd/system/ \
  && systemctl daemon-reload && systemctl enable --now provision-projects.timer'
```

Each tick, for every container the portal lists that has no workspace yet, it:

1. creates `/opt/orcha-work/<slug>` (slug from the project name). If the
   container is **bound to a GitHub repo** (the portal's Connect-repo modal, or
   `orcha init`'s auto-bind), the repo is cloned via a repo-scoped App token —
   minted once for the clone, scrubbed from git config after, with the
   credential helper wired to `.orcha/github-token` exactly like the section
   above. Unbound projects get an empty workspace with a README saying so.
2. writes `<ws>/.claude/orcha.json` — `current_container_id`, the loopback
   portal as `api_base_url`, and sandbox ON with conservative caps
   (`PROVISION_MEMORY`/`PROVISION_CPUS` env on the service, default 1536m / 1).
3. chowns the workspace to uid 1000 (the sandbox user) and registers it in
   **`/opt/orcha-work/workspaces.list`** (lines `<cid> <dir>`) — the box-wide
   workspace registry. `github-token-refresh.sh` reads this file now (the
   `$ORCHA_WORKSPACES` env var on its unit remains as fallback for boxes that
   pre-date the registry), so freshly provisioned projects join the token
   refresh automatically.
4. starts a notifier for the workspace (`orcha notifier --ensure`, env sourced
   from `/root/.orcha-daemon-env` — override with `ORCHA_DAEMON_ENV`). The
   ensure is a per-container idempotent singleton (workspace pidfile + an
   atomic `~/.orcha/notifier-<cid>.pid` claim), and it re-runs for every
   registered workspace each tick, so notifiers also self-heal after a reboot.

Idempotent throughout: registered containers are skipped, existing workspaces
are never touched (a hand-built pre-registry workspace like `dogfood` is
*adopted* into the list on the first run), and a failed clone/mint is retried
on the next tick rather than leaving a half-provisioned workspace behind.

## Notes

- Agents and sandbox containers inside the box reach `portal:8000` over the
  compose network — the perimeter guards the outside only.
- Rotate the team token: edit `.env`, `docker compose up -d` (auth stack only).
- This directory is the BYOC bootstrap: same steps on a customer's VM.
