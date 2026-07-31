#!/bin/sh
# Keep a fresh GitHub installation token in each Orcha workspace so SANDBOXED
# agents can pull/push/PR as the app bot. The app's PEM stays on the host —
# containers only ever see the 1-hour token via the workspace mount.
#
# Wired by a systemd timer (github-token-refresh.timer, every 40 min). Reads
# the workspace list from $ORCHA_WORKSPACES (space-separated project dirs).
#
# Inside a workspace's repo, agents authenticate through the standard git
# credential helper installed by setup (see deploy/README.md):
#   git config credential.helper \
#     '!f() { echo username=x-access-token; echo "password=$(cat /workspace/.orcha/github-token)"; }; f'
# and can open PRs with:  curl -H "Authorization: Bearer $(cat /workspace/.orcha/github-token)" ...
set -eu

SECRETS="${ORCHA_SECRETS_DIR:-/opt/orcha-secrets}"
APP_ID=$(python3 -c "import json;print(json.load(open('$SECRETS/github-app.json'))['id'])")
MINT="$(dirname "$0")/github-app-token.py"

for WS in ${ORCHA_WORKSPACES:-/opt/orcha-work/dogfood}; do
    [ -d "$WS/.orcha" ] || continue
    TOKEN=$(python3 "$MINT" --pem "$SECRETS/github-app.pem" --app-id "$APP_ID" 2>/dev/null) || {
        echo "warn: token mint failed for $WS (app not installed yet?)" >&2; continue; }
    TMP="$WS/.orcha/.github-token.tmp"
    printf "%s" "$TOKEN" > "$TMP"
    chown 1000:1000 "$TMP" 2>/dev/null || true
    chmod 640 "$TMP"
    mv "$TMP" "$WS/.orcha/github-token"
    echo "refreshed $WS/.orcha/github-token"
done
