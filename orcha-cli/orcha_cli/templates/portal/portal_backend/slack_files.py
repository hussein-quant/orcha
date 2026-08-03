"""Slack message-file handling for the create-issue/create-task shortcuts — download
image attachments from a Slack message so screenshots travel WITH the work: embedded as
markdown images in the filed GitHub issue, and (for the "Create Orcha task" shortcut)
landed on the created task's own attachment store so a sandboxed agent can see them the
same way it sees any other task attachment (task_message_routes' render_attachment_feed_line).

Requires the `files:read` OAuth scope (in ADDITION to `commands` + `chat:write` —
docs/slack-integration.md's scope list). Without it, Slack's file-info/download calls
403/401 and this module degrades gracefully: the issue/task is still created, just
without images, and the caller (slack_routes) reports how many were skipped and why —
never a hard failure over an attachment.

Selection rule (spec): at most the first 5 files on the message, `image/*` mimetypes
only, each ≤ SLACK_IMAGE_MAX_BYTES. Anything past the cap, of the wrong type, or over
size is silently excluded from the selection (not an error) — only a DOWNLOAD failure
of a file that WAS selected counts as a "skipped" file toward the honesty-count the
confirmation card reports.
"""

import concurrent.futures
import urllib.error
import urllib.request

SLACK_IMAGE_MAX_BYTES = 5 * 1024 * 1024
SLACK_IMAGE_MAX_COUNT = 5
SLACK_FILE_TIMEOUT_SECONDS = 15
# Bounded concurrent-download pool size for fetch_selected_images — mirrors
# github_hub_routes.py's CHECKS_POOL_SIZE pattern for the same class of problem (N
# blocking network calls fanned out from a sync context). At most SLACK_IMAGE_MAX_COUNT
# (5) images are ever selected, so this cap is really just a ceiling for future-proofing
# if that constant ever grows.
SLACK_IMAGE_FETCH_POOL_SIZE = 5


class SlackFilesScopeMissing(Exception):
    """Raised by `download_slack_file` when Slack's response indicates the bot token
    lacks `files:read` (401/403 on url_private_download) — distinct from a generic
    download failure so the caller can report the SPECIFIC fix (add the scope,
    reinstall) rather than a generic 'couldn't download' line."""


def select_image_files(files: list) -> list:
    """Filter a Slack message's `files[]` array down to what we'll attempt to fetch:
    first SLACK_IMAGE_MAX_COUNT files, `image/*` mimetype (Slack's `mimetype` field),
    each ≤ SLACK_IMAGE_MAX_BYTES (Slack's `size` field, in bytes — trusted for the
    PRE-download cap; the actual downloaded byte count is re-checked in
    `download_slack_file` since a reported size is not a guarantee). Pure — no network.
    Returns the raw Slack file dicts (not yet downloaded), in message order.
    """
    out = []
    for f in files or []:
        if not isinstance(f, dict):
            continue
        mimetype = str(f.get("mimetype") or "")
        if not mimetype.startswith("image/"):
            continue
        size = f.get("size")
        if isinstance(size, int) and size > SLACK_IMAGE_MAX_BYTES:
            continue
        if not f.get("url_private_download"):
            continue
        out.append(f)
        if len(out) >= SLACK_IMAGE_MAX_COUNT:
            break
    return out


def download_slack_file(url_private_download: str, bot_token: str) -> bytes:
    """GET a Slack file's bytes via `url_private_download`, authenticated with the bot
    token (Slack's file-serving domain accepts the SAME bearer token as the Web API,
    per Slack's documented file-download flow). Raises SlackFilesScopeMissing on a
    401/403 (missing `files:read`); RuntimeError on any other failure (timeout, 404,
    oversize-after-download). This is the ONE network leaf for file bytes; tests
    monkeypatch this function, never urllib directly.
    """
    request = urllib.request.Request(
        url_private_download,
        headers={"Authorization": f"Bearer {bot_token}", "User-Agent": "orcha-portal"},
    )
    try:
        with urllib.request.urlopen(request, timeout=SLACK_FILE_TIMEOUT_SECONDS) as response:
            data = response.read(SLACK_IMAGE_MAX_BYTES + 1)
    except urllib.error.HTTPError as exc:
        if exc.code in (401, 403):
            raise SlackFilesScopeMissing(f"slack file download forbidden ({exc.code})") from exc
        raise RuntimeError(f"slack_file_status:{exc.code}") from exc
    except Exception as exc:  # DNS, timeout, TLS — one graceful shape
        raise RuntimeError(f"slack_file_unreachable:{exc}") from exc
    if len(data) > SLACK_IMAGE_MAX_BYTES:
        raise RuntimeError("slack_file_oversize")
    if not data:
        raise RuntimeError("slack_file_empty")
    return data


def _fetch_one(f: dict, bot_token: str):
    """Download ONE selected file, returning (image_dict_or_None, skipped: bool,
    scope_missing: bool) — never raises (both failure branches of
    `download_slack_file` are caught here so `pool.map` can't propagate an exception
    from one file and abort the others)."""
    try:
        data = download_slack_file(f["url_private_download"], bot_token)
    except SlackFilesScopeMissing:
        return None, True, True
    except RuntimeError:
        return None, True, False
    image = {
        "name": f.get("name") or f.get("title") or "screenshot.png",
        "mimetype": f.get("mimetype") or "image/png",
        "data": data,
    }
    return image, False, False


def fetch_selected_images(files: list, bot_token: str) -> dict:
    """Download every image in `select_image_files(files)` CONCURRENTLY (bounded
    thread pool — mirrors github_hub_routes.py's established pattern for fanning out
    N blocking network calls from a sync context), isolating per-file failures (spec:
    "any per-file download/commit/attach failure skips that file and the confirmation
    card counts what made it"). At most SLACK_IMAGE_MAX_COUNT (5) files are ever
    selected, so worst case is ONE file's timeout, not N of them stacked serially.
    Returns {"images": [{"name": str, "mimetype": str, "data": bytes}, ...],
     "skipped": int, "scope_missing": bool} — `images` preserves the SOURCE message
    order (not completion order), since `_commit_images_to_repo` numbers files by
    that order.
    `scope_missing` is True iff AT LEAST ONE selected file failed specifically because
    of a missing files:read scope (so the caller can surface the specific "add
    files:read and reinstall" hint instead of a generic skip count).
    """
    selected = select_image_files(files)
    if not selected:
        return {"images": [], "skipped": 0, "scope_missing": False}
    with concurrent.futures.ThreadPoolExecutor(
            max_workers=min(SLACK_IMAGE_FETCH_POOL_SIZE, len(selected))) as pool:
        results = list(pool.map(lambda f: _fetch_one(f, bot_token), selected))
    images = [image for image, _skipped, _scope in results if image is not None]
    skipped = sum(1 for _image, skipped, _scope in results if skipped)
    scope_missing = any(scope for _image, _skipped, scope in results)
    return {"images": images, "skipped": skipped, "scope_missing": scope_missing}
