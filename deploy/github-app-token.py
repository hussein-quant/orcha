#!/usr/bin/env python3
"""Mint a short-lived GitHub App installation token (stdlib + the openssl binary).

The app's private key NEVER leaves the host — sandboxes only ever see the
1-hour tokens this mints. Used by bootstrap-clone.sh (clone/install Orcha on a
fresh box) and by the github-token-refresh systemd timer (keep a fresh token in
each workspace so sandboxed agents can pull/push/PR as the app bot).

    python3 github-app-token.py --pem auth/github-app.pem --app-id 12345 \
        [--repo owner/name]        # scope the token to one repo
        [--installation-id N]      # skip auto-discovery

Prints the token to stdout; everything else goes to stderr.
App id lives in auth/github-app.json (key "id") after setup-github.py.
"""
from __future__ import annotations

import argparse
import base64
import json
import pathlib
import subprocess
import sys
import time
import urllib.error
import urllib.request

API = "https://api.github.com"


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def app_jwt(pem: pathlib.Path, app_id: str) -> str:
    now = int(time.time())
    header = b64url(json.dumps({"alg": "RS256", "typ": "JWT"}).encode())
    payload = b64url(json.dumps(
        {"iat": now - 60, "exp": now + 540, "iss": app_id}).encode())
    signing_input = f"{header}.{payload}".encode()
    sig = subprocess.run(
        ["openssl", "dgst", "-sha256", "-sign", str(pem)],
        input=signing_input, capture_output=True, check=True).stdout
    return f"{header}.{payload}.{b64url(sig)}"


def gh(path: str, jwt: str, method: str = "GET", body: dict | None = None) -> dict | list:
    req = urllib.request.Request(
        API + path, method=method,
        headers={"Authorization": f"Bearer {jwt}",
                 "Accept": "application/vnd.github+json",
                 "User-Agent": "orcha-cloud-token"},
        data=json.dumps(body).encode() if body is not None else None)
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--pem", required=True, type=pathlib.Path)
    ap.add_argument("--app-id", required=True)
    ap.add_argument("--installation-id", default=None)
    ap.add_argument("--repo", default=None, help="owner/name to scope the token to")
    args = ap.parse_args()

    jwt = app_jwt(args.pem, args.app_id)
    inst = args.installation_id
    if inst is None:
        installs = gh("/app/installations", jwt)
        if not installs:
            print("error: the app is installed on nothing — install it on your "
                  "repos first (the app's page → Install App).", file=sys.stderr)
            return 1
        inst = installs[0]["id"]
        if len(installs) > 1:
            print(f"note: {len(installs)} installations; using {inst} "
                  f"({installs[0].get('account', {}).get('login')}). "
                  f"Pass --installation-id to pick.", file=sys.stderr)
    body: dict = {}
    if args.repo:
        body = {"repositories": [args.repo.split("/", 1)[1]]}
    try:
        tok = gh(f"/app/installations/{inst}/access_tokens", jwt, "POST", body)
    except urllib.error.HTTPError as e:
        print(f"error: token mint failed ({e.code}): {e.read().decode()[:300]}",
              file=sys.stderr)
        return 1
    print(tok["token"])
    print(f"expires: {tok.get('expires_at')}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
