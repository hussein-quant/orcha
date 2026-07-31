#!/bin/sh
# Sync the portal's member roster into the OAuth perimeter allowlist.
# The portal is the source of truth for WHO is a member (owners invite via the
# Members UI); the proxy allowlist is the hard door. This bridges them: read
# members (bearer lane), rewrite ALLOWED_GITHUB_USERS in deploy/auth/.env, and
# restart oauth2-proxy only when the roster actually changed.
# Wired by sync-members.timer (every 2 min). Env:
#   ORCHA_PORTAL_URL   (default http://127.0.0.1:8001)
#   ORCHA_AUTH_DIR     (default /opt/orcha-cloud/deploy/auth)
set -eu

PORTAL="${ORCHA_PORTAL_URL:-http://127.0.0.1:8001}"
AUTH="${ORCHA_AUTH_DIR:-/opt/orcha-cloud/deploy/auth}"

CID=$(curl -sf "$PORTAL/api/containers" | python3 -c "import json,sys;print(json.load(sys.stdin)[\"containers\"][0][\"id\"])")
LOGINS=$(curl -sf "$PORTAL/api/containers/$CID/members" | python3 -c "
import json,sys
ms=json.load(sys.stdin)[\"members\"]
print(\",\".join(sorted({m[\"github_login\"].lower() for m in ms if m.get(\"github_login\")})))")
[ -z "$LOGINS" ] && { echo "no member logins yet — leaving allowlist untouched"; exit 0; }

CURRENT=$(grep "^ALLOWED_GITHUB_USERS=" "$AUTH/.env" | cut -d= -f2- || true)
if [ "$CURRENT" = "$LOGINS" ]; then
    exit 0
fi
sed -i "s|^ALLOWED_GITHUB_USERS=.*|ALLOWED_GITHUB_USERS=$LOGINS|" "$AUTH/.env"
cd "$AUTH" && docker compose --env-file .env -f docker-compose.auth.yml -f oauth2-proxy-host.yml up -d oauth2-proxy >/dev/null 2>&1
echo "allowlist updated: $LOGINS"
