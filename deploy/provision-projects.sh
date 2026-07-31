#!/bin/sh
# Box-side project runtime provisioner — close the "portal-only project" gap.
#
# Projects created from the portal (POST /api/containers) exist ONLY in the stack
# DB: no workspace on disk, no notifier, so their agents never wake and chat never
# answers. This script (wired by provision-projects.timer, every 2 min) gives every
# portal container a runtime:
#
#   1. a workspace at $ORCHA_WORK_ROOT/<slug> (slug from the project name),
#      cloned from the bound GitHub repo when the container has one
#      (portal GET /api/containers → github_repo; token minted repo-scoped via
#      github-app-token.py, used once for the clone, then scrubbed from git
#      config — agents authenticate through the credential helper reading
#      .orcha/github-token, which github-token-refresh.timer keeps fresh);
#   2. <ws>/.claude/orcha.json binding the workspace to its container + the
#      loopback portal, sandbox ON with conservative caps
#      ($PROVISION_MEMORY/$PROVISION_CPUS, default 1536m / 1 cpu);
#   3. a registry line "<cid> <dir>" in $ORCHA_WORKSPACES_FILE
#      (default /opt/orcha-work/workspaces.list) — the box-wide source of truth
#      the other timers (github-token-refresh.sh) read instead of the legacy
#      $ORCHA_WORKSPACES env var;
#   4. a notifier daemon for the workspace (env sourced from $ORCHA_DAEMON_ENV,
#      then `cd <ws> && orcha notifier --ensure` — an idempotent singleton per
#      container: pidfile <ws>/.claude/.orcha-notifier.pid plus an atomic
#      per-container claim in ~/.orcha/notifier-<cid>.pid).
#
# Idempotent: re-runs skip registered containers, never touch existing
# workspaces, adopt pre-registry workspaces (e.g. the hand-built dogfood one)
# into the list, and re-ensure a notifier for every registered workspace each
# tick (self-healing after a reboot). One log line per action.
#
# Env (all optional):
#   ORCHA_PORTAL_URL       portal base            (default http://127.0.0.1:8001)
#   ORCHA_WORK_ROOT        workspace parent dir   (default /opt/orcha-work)
#   ORCHA_WORKSPACES_FILE  registry file          (default $ORCHA_WORK_ROOT/workspaces.list)
#   ORCHA_SECRETS_DIR      GitHub App secrets     (default /opt/orcha-secrets)
#   ORCHA_DAEMON_ENV       notifier env file      (default /root/.orcha-daemon-env)
#   ORCHA_MINT             token minter script    (default <this dir>/github-app-token.py)
#   PROVISION_MEMORY       sandbox memory cap     (default 1536m)
#   PROVISION_CPUS         sandbox cpu cap        (default 1)
set -eu

PORTAL="${ORCHA_PORTAL_URL:-http://127.0.0.1:8001}"
WORK_ROOT="${ORCHA_WORK_ROOT:-/opt/orcha-work}"
REGISTRY="${ORCHA_WORKSPACES_FILE:-$WORK_ROOT/workspaces.list}"
SECRETS="${ORCHA_SECRETS_DIR:-/opt/orcha-secrets}"
DAEMON_ENV="${ORCHA_DAEMON_ENV:-/root/.orcha-daemon-env}"
MINT="${ORCHA_MINT:-$(dirname "$0")/github-app-token.py}"
MEMORY="${PROVISION_MEMORY:-1536m}"
CPUS="${PROVISION_CPUS:-1}"
# The stack network sandboxes must join. A cloned repo can carry its OWN
# .orcha/docker-compose.yml, making network derivation target a nonexistent
# network (wakes die 125) — so pin it explicitly. Auto-detect from the running
# portal container; PROVISION_NETWORK overrides.
NETWORK="${PROVISION_NETWORK:-}"
if [ -z "$NETWORK" ]; then
    PORTAL_CTR=$(docker ps --filter name=portal --format '{{.Names}}' | head -n 1)
    [ -n "$PORTAL_CTR" ] && NETWORK=$(docker inspect "$PORTAL_CTR"         --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' 2>/dev/null | awk '{print $1}')
fi

# uv-installed `orcha` lives in ~/.local/bin, which systemd's default PATH lacks.
export PATH="${HOME:-/root}/.local/bin:$PATH"

mkdir -p "$WORK_ROOT"
[ -f "$REGISTRY" ] || : > "$REGISTRY"

registered() { # registered <cid> → 0 iff the container already has a registry line
    grep -q "^$1 " "$REGISTRY" 2>/dev/null
}

# ---- adopt pass: pre-registry workspaces (e.g. the hand-built dogfood one) ----
# Any $WORK_ROOT/<dir> carrying .claude/orcha.json with a container id joins the
# registry as-is, so the timers see it and the provision pass never shadows it.
for DIR in "$WORK_ROOT"/*/; do
    [ -f "${DIR}.claude/orcha.json" ] || continue
    CID=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1])).get('current_container_id') or '')" \
          "${DIR}.claude/orcha.json" 2>/dev/null) || CID=""
    [ -n "$CID" ] || continue
    registered "$CID" && continue
    printf '%s %s\n' "$CID" "${DIR%/}" >> "$REGISTRY"
    echo "adopted existing workspace ${DIR%/} (container $CID)"
done

# ---- fetch the stack's containers: "<cid>\t<slug>\t<repo>" per line ----
CONTAINERS=$(python3 - "$PORTAL" <<'PYEOF'
import json, re, sys, urllib.request
portal = sys.argv[1]
try:
    with urllib.request.urlopen(f"{portal}/api/containers", timeout=10) as r:
        rows = json.loads(r.read()).get("containers") or []
except Exception as e:
    print(f"warn: portal unreachable at {portal} ({e}) — nothing to provision", file=sys.stderr)
    rows = []
for c in rows:
    cid = c.get("id") or ""
    if not cid:
        continue
    slug = re.sub(r"-+", "-", re.sub(r"[^a-z0-9]+", "-", (c.get("name") or "").lower())).strip("-")
    slug = slug or f"project-{cid[:8]}"
    print(f"{cid}\t{slug}\t{c.get('github_repo') or ''}")
PYEOF
) || CONTAINERS=""

# install_token_file <dest> <content> — the 0640/uid-1000 contract sandboxes expect
# (same idiom as github-token-refresh.sh).
install_token_file() {
    TMP="$1.tmp"
    printf "%s" "$2" > "$TMP"
    chown 1000:1000 "$TMP" 2>/dev/null || true
    chmod 640 "$TMP"
    mv "$TMP" "$1"
}

provision_one() { # provision_one <cid> <slug> <repo-or-empty>
    P_CID=$1; P_SLUG=$2; P_REPO=$3
    WS="$WORK_ROOT/$P_SLUG"
    # Existing dir that ISN'T this container's (the adopt pass would have registered
    # a matching one): disambiguate with a cid prefix rather than ever touching it.
    if [ -e "$WS" ]; then
        WS="$WORK_ROOT/$P_SLUG-$(printf '%s' "$P_CID" | cut -c1-8)"
    fi
    if [ -e "$WS" ]; then
        echo "warn: $WS exists but is not registered to $P_CID — skipping" >&2
        return 0
    fi

    if [ -n "$P_REPO" ]; then
        APP_ID=$(python3 -c "import json;print(json.load(open('$SECRETS/github-app.json'))['id'])" 2>/dev/null) || {
            echo "warn: no GitHub App credentials in $SECRETS — cannot clone $P_REPO for $P_CID (retry next tick)" >&2
            return 0
        }
        TOKEN=$(python3 "$MINT" --pem "$SECRETS/github-app.pem" --app-id "$APP_ID" \
                --repo "$P_REPO" 2>/dev/null) || TOKEN=""
        if [ -z "$TOKEN" ]; then
            echo "warn: token mint for $P_REPO failed (app installed on the repo?) — retry next tick" >&2
            return 0
        fi
        if ! git clone -q "https://x-access-token:${TOKEN}@github.com/${P_REPO}.git" "$WS"; then
            echo "warn: clone of $P_REPO failed — retry next tick" >&2
            rm -rf "$WS"
            return 0
        fi
        git -C "$WS" remote set-url origin "https://github.com/${P_REPO}.git"  # never persist the token
        # Sandboxed agents authenticate through the refreshed token file (deploy/README.md).
        # shellcheck disable=SC2016  # the $(cat ...) must expand at CREDENTIAL time, not now
        git -C "$WS" config credential.helper \
            '!f() { echo username=x-access-token; echo "password=$(cat /workspace/.orcha/github-token)"; }; f'
        mkdir -p "$WS/.orcha"
        # Seed the token we already minted so agents work before the first refresh tick.
        install_token_file "$WS/.orcha/github-token" "$TOKEN"
    else
        mkdir -p "$WS/.orcha"
        cat > "$WS/README.md" <<EOF
# $P_SLUG

Orcha workspace for portal project "$P_SLUG" (container $P_CID).

No GitHub repository is bound to this project yet — this workspace starts
empty. Connect a repo from the portal's GitHub panel; the box-side timers
mint and refresh its access token automatically.
EOF
    fi

    mkdir -p "$WS/.claude"
    python3 - "$WS/.claude/orcha.json" "$P_CID" "$PORTAL" "$P_SLUG" "$MEMORY" "$CPUS" "$NETWORK" <<'PYEOF'
import json, sys
path, cid, portal, slug, memory, cpus, network = sys.argv[1:8]
sandbox = {"enabled": True, "memory": memory, "cpus": cpus}
if network:
    sandbox["network"] = network
with open(path, "w") as fh:
    json.dump({
        "api_base_url": portal,
        "project_name": slug,
        "current_container_id": cid,
        "sandbox": sandbox,
    }, fh, indent=2)
    fh.write("\n")
PYEOF
    chown -R 1000:1000 "$WS" 2>/dev/null || true
    printf '%s %s\n' "$P_CID" "$WS" >> "$REGISTRY"
    echo "provisioned $WS (container $P_CID${P_REPO:+, repo $P_REPO})"
}

# ---- provision pass: every portal container missing from the registry ----
printf '%s\n' "$CONTAINERS" | while IFS="$(printf '\t')" read -r CID SLUG REPO; do
    [ -n "$CID" ] || continue
    registered "$CID" && continue
    provision_one "$CID" "$SLUG" "$REPO" || echo "warn: provisioning $CID failed" >&2
done

# ---- notifier pass: one idempotent-singleton daemon per registered workspace ----
# `orcha notifier --ensure` no-ops when that container's daemon is alive (local
# pidfile + per-container claim in ~/.orcha), so this doubles as reboot recovery.
while read -r CID WS; do
    [ -n "${WS:-}" ] && [ -d "$WS" ] || continue
    (
        # shellcheck disable=SC1090
        [ -f "$DAEMON_ENV" ] && . "$DAEMON_ENV" || true
        cd "$WS" && orcha notifier --ensure --quiet
    ) || echo "warn: notifier --ensure failed for $WS" >&2
done < "$REGISTRY"
