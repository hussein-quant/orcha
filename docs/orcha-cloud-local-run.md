# Orcha Cloud — local run (design, 2026-08-06)

> Goal: the full Orcha Cloud experience — premium portal, projects, GitHub hub,
> repo browser, Code Space, members — running on **localhost** with one command,
> no VM, no domain, no GitHub App registration. The same mechanism serves two
> audiences: our own dev/dogfood loop, and self-hosting users. Every hosted-only
> dependency becomes **optional**, never silently broken.

## What already works locally (by design, verified)

- **The stack**: cloud's `orcha-cli` renders the complete cloud stack
  (`orcha init` → `.orcha/` → `orcha up`), portal + Postgres in Docker on any
  machine. The Hetzner box runs exactly this; a laptop runs it the same way.
- **Identity without OAuth**: the portal trusts `X-Auth-Request-User` ONLY
  under `ORCHA_TRUST_PROXY_USER=1`. Unset (the local default), `/api/me`
  returns `{identity: null, trusted: false}` and the frontend falls back to
  the local human — the documented self-host path. Members/permissions UI
  stays functional as a single-operator project.
- **Migrations, provider keys, agents, tasks, requests, terminal**: no hosted
  dependency at all.

## The three real gaps

### 1. GitHub access without the App → PAT token source

All GitHub calls resolve a token through ONE chokepoint
(`github_routes._read_token` / `_read_token_map`, mirrored by
`github_hub_routes._resolve_repo_token`). Today the sources are files
maintained by the box-side App-token refresh timer.

Add a third source, lowest precedence: **a personal access token**.

- Resolution order: per-owner token map → single token file → **PAT**
  (env `ORCHA_GITHUB_PAT`, else the DB-stored PAT). App installs keep
  winning where both exist.
- Storage: `PUT/GET(status)/DELETE /api/containers/{cid}/settings/github-pat`,
  sealed via `secret_box` exactly like provider keys (masked hint only,
  never returned; human-authority gated; audit-logged). Env overrides DB,
  same shadow semantics as provider keys.
- `…/settings/github-pat/test` → `GET /user` with the pasted token, returns
  `{ok, login|detail, scopes?}` before saving.
- **Repo listing fallback**: `GET /installation/repositories` is App-only.
  When the resolved token is a PAT (no App files present), list bindable
  repos via `GET /user/repos?per_page=100&sort=pushed` instead. Same response
  shape to the frontend; a `source: "pat" | "app"` field says which path fed it.
- Everything downstream (hub, browse, tarball snapshots, Code Space anchors,
  checks) works with a classic PAT with `repo` scope; fine-grained PATs work
  scoped to selected repos. App-only extras (check-runs *as* the app,
  webhooks) simply don't light up — degrade, never error.

### 2. Settings surface → GitHub access card

In cloud's Settings (src/cloud/settings), alongside the provider-key cards:
a **GitHub access** card showing the active source —
"App installation (managed)" (token files present) / "Personal access token"
(masked, with Replace/Remove/Test) / "Not configured" (paste field + scope
hint + link to the PAT creation page). Uses the provider-key card idiom.

### 3. One-command bring-up + optional auth → `deploy/local/`

- `deploy/local/README.md` — the canonical path:
  1. `uv tool install --from <repo>/orcha-cli orcha-cli`
  2. `mkdir myproj && cd myproj && orcha init && orcha up`
  3. open `http://localhost:<port>`, paste a PAT in Settings → done.
- `deploy/local/up.sh` — convenience wrapper for exactly those steps
  (idempotent re-run = `orcha up`).
- **Optional OAuth overlay** (real multi-user on localhost):
  `deploy/local/docker-compose.oauth.yml` runs oauth2-proxy on
  `http://localhost:4180` in front of the loopback-bound portal, with a
  user-created GitHub OAuth app (callback
  `http://localhost:4180/oauth2/callback`) and `ORCHA_TRUST_PROXY_USER=1`
  on the portal. Documented as the "enable OAuth later" path — default
  remains no-login local admin.

## Non-goals (v1)

- No license/entitlement enforcement (packaging decision, separate track).
- No webhooks/push-relay locally (box timers stay box-only; portal features
  that poll work unchanged).
- No changes to open-orcha — this is all cloud-side (`portal_backend` cloud
  modules + `src/cloud/**` + `deploy/local/`), so the open sync stays clean.

## Build plan

Contracts frozen by this doc; built by cheaper models in parallel
(backend PAT source + listing fallback + settings routes | settings card |
deploy/local docs + overlays), Fable reviews, integrates, and verifies by
actually running the stack locally end-to-end.
