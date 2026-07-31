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

Then in a workspace repo (once, from the host or an agent task):

```bash
git config credential.helper \
  '!f() { echo username=x-access-token; echo "password=$(cat /workspace/.orcha/github-token)"; }; f'
```

Agents clone/pull/push over https as the app bot, and open PRs with
`curl -H "Authorization: Bearer $(cat /workspace/.orcha/github-token)" -X POST
.../repos/<owner>/<repo>/pulls`. Install the app on every target repo. Note:
commits/PRs are attributed to the app bot; the human PR review remains the
authority gate, same as the Orcha task flow.

## Notes

- Agents and sandbox containers inside the box reach `portal:8000` over the
  compose network — the perimeter guards the outside only.
- Rotate the team token: edit `.env`, `docker compose up -d` (auth stack only).
- This directory is the BYOC bootstrap: same steps on a customer's VM.
