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
git clone https://github.com/hussein-quant/orcha-cloud.git && cd orcha-cloud
pipx install ./orcha-cli   # or: uv tool install ./orcha-cli
```

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

## Notes

- Agents and sandbox containers inside the box reach `portal:8000` over the
  compose network — the perimeter guards the outside only.
- Rotate the team token: edit `.env`, `docker compose up -d` (auth stack only).
- This directory is the BYOC bootstrap: same steps on a customer's VM.
