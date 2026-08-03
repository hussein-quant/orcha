"""Slack message-file handling (screenshots-from-Slack feature): selection filtering
(count cap, mimetype, size), the files:read-scope-missing degradation, and per-file
download failure isolation. Pure unit tests — no DB, no FastAPI client; `slack_files`
has no framework dependency of its own."""
import urllib.error

import pytest

from portal_backend import slack_files


def _file(name="shot.png", mimetype="image/png", size=1024, url="https://files.slack.com/x/download"):
    return {"name": name, "mimetype": mimetype, "size": size, "url_private_download": url}


# ------------------------- select_image_files: filtering -------------------------

def test_select_image_files_filters_non_image_mimetypes():
    files = [_file(mimetype="image/png"), _file(mimetype="application/pdf"),
             _file(mimetype="text/plain")]
    selected = slack_files.select_image_files(files)
    assert len(selected) == 1
    assert selected[0]["mimetype"] == "image/png"


def test_select_image_files_filters_oversize():
    ok = _file(size=slack_files.SLACK_IMAGE_MAX_BYTES)
    too_big = _file(size=slack_files.SLACK_IMAGE_MAX_BYTES + 1)
    selected = slack_files.select_image_files([ok, too_big])
    assert len(selected) == 1
    assert selected[0]["size"] == slack_files.SLACK_IMAGE_MAX_BYTES


def test_select_image_files_caps_at_five():
    files = [_file(name=f"shot{i}.png") for i in range(8)]
    selected = slack_files.select_image_files(files)
    assert len(selected) == slack_files.SLACK_IMAGE_MAX_COUNT == 5
    assert [f["name"] for f in selected] == [f"shot{i}.png" for i in range(5)]


def test_select_image_files_requires_download_url():
    files = [_file(url=None), _file(url="")]
    assert slack_files.select_image_files(files) == []


def test_select_image_files_ignores_non_dict_entries():
    assert slack_files.select_image_files([None, "not a file", 42, _file()]) == [_file()]


def test_select_image_files_empty_input():
    assert slack_files.select_image_files([]) == []
    assert slack_files.select_image_files(None) == []


def test_select_image_files_missing_size_field_not_filtered():
    # Slack SHOULD always send `size`, but a missing/non-int size must not crash the
    # filter — treat it as "unknown, don't reject on size" rather than raising.
    f = _file()
    del f["size"]
    assert slack_files.select_image_files([f]) == [f]


# ------------------------- download_slack_file: scope / failure shapes -------------------------

class _FakeHTTPError(urllib.error.HTTPError):
    def __init__(self, code):
        super().__init__("https://files.slack.com/x", code, "err", {}, None)


def test_download_slack_file_403_raises_scope_missing(monkeypatch):
    def fake_urlopen(request, timeout=None):
        raise _FakeHTTPError(403)

    monkeypatch.setattr(slack_files.urllib.request, "urlopen", fake_urlopen)
    with pytest.raises(slack_files.SlackFilesScopeMissing):
        slack_files.download_slack_file("https://files.slack.com/x", "xoxb-test")


def test_download_slack_file_401_raises_scope_missing(monkeypatch):
    def fake_urlopen(request, timeout=None):
        raise _FakeHTTPError(401)

    monkeypatch.setattr(slack_files.urllib.request, "urlopen", fake_urlopen)
    with pytest.raises(slack_files.SlackFilesScopeMissing):
        slack_files.download_slack_file("https://files.slack.com/x", "xoxb-test")


def test_download_slack_file_404_raises_plain_runtime_error(monkeypatch):
    def fake_urlopen(request, timeout=None):
        raise _FakeHTTPError(404)

    monkeypatch.setattr(slack_files.urllib.request, "urlopen", fake_urlopen)
    with pytest.raises(RuntimeError):
        slack_files.download_slack_file("https://files.slack.com/x", "xoxb-test")
    # NOT the scope-missing subtype for a 404.
    try:
        slack_files.download_slack_file("https://files.slack.com/x", "xoxb-test")
    except slack_files.SlackFilesScopeMissing:
        pytest.fail("404 must not raise SlackFilesScopeMissing")
    except RuntimeError:
        pass


def test_download_slack_file_sends_bearer_auth(monkeypatch):
    captured = {}

    class _Resp:
        def read(self, n=-1):
            return b"\x89PNG-bytes"

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    def fake_urlopen(request, timeout=None):
        captured["headers"] = dict(request.header_items())
        captured["url"] = request.full_url
        return _Resp()

    monkeypatch.setattr(slack_files.urllib.request, "urlopen", fake_urlopen)
    data = slack_files.download_slack_file("https://files.slack.com/x/download", "xoxb-secret")
    assert data == b"\x89PNG-bytes"
    assert captured["headers"]["Authorization"] == "Bearer xoxb-secret"
    assert captured["url"] == "https://files.slack.com/x/download"


def test_download_slack_file_empty_body_raises(monkeypatch):
    class _Resp:
        def read(self, n=-1):
            return b""

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    monkeypatch.setattr(slack_files.urllib.request, "urlopen", lambda r, timeout=None: _Resp())
    with pytest.raises(RuntimeError):
        slack_files.download_slack_file("https://files.slack.com/x", "xoxb-test")


# ------------------------- fetch_selected_images: end-to-end + isolation -------------------------

def test_fetch_selected_images_happy_path(monkeypatch):
    files = [_file(name="a.png"), _file(name="b.png")]
    monkeypatch.setattr(slack_files, "download_slack_file", lambda url, token: b"bytes")
    result = slack_files.fetch_selected_images(files, "xoxb-test")
    assert len(result["images"]) == 2
    assert result["skipped"] == 0
    assert result["scope_missing"] is False
    assert {i["name"] for i in result["images"]} == {"a.png", "b.png"}


def test_fetch_selected_images_per_file_failure_isolated(monkeypatch):
    """One bad download must not take down the others — only the failing one is
    excluded/counted as skipped. Downloads run CONCURRENTLY (a bounded thread pool —
    see fetch_selected_images' docstring), so the fake leaf identifies "which file"
    by its OWN url/name, never by call order (order is not guaranteed across
    threads)."""
    files = [
        _file(name="good.png", url="https://files.slack.com/good"),
        _file(name="bad.png", url="https://files.slack.com/bad"),
        _file(name="also-good.png", url="https://files.slack.com/also-good"),
    ]

    def flaky_by_url(url, token):
        if url == "https://files.slack.com/bad":
            raise RuntimeError("boom")
        return b"bytes"

    monkeypatch.setattr(slack_files, "download_slack_file", flaky_by_url)
    result = slack_files.fetch_selected_images(files, "xoxb-test")
    assert len(result["images"]) == 2
    assert {i["name"] for i in result["images"]} == {"good.png", "also-good.png"}
    assert result["skipped"] == 1
    assert result["scope_missing"] is False


def test_fetch_selected_images_preserves_source_message_order(monkeypatch):
    """images[] must come back in the SOURCE message's order, not completion order —
    _commit_images_to_repo numbers committed files by this order (00-, 01-, 02-...)."""
    files = [_file(name=f"img{i}.png", url=f"https://files.slack.com/{i}") for i in range(5)]

    def slow_for_first(url, token):
        # Make the FIRST file's "download" the slowest, so if results were ordered by
        # completion (not input order) it would land last instead of first.
        if url.endswith("/0"):
            import time
            time.sleep(0.05)
        return f"bytes-{url}".encode()

    monkeypatch.setattr(slack_files, "download_slack_file", slow_for_first)
    result = slack_files.fetch_selected_images(files, "xoxb-test")
    assert [i["name"] for i in result["images"]] == [f"img{i}.png" for i in range(5)]


def test_fetch_selected_images_scope_missing_counts_all_as_skipped(monkeypatch):
    files = [_file(name="a.png"), _file(name="b.png")]

    def denied(url, token):
        raise slack_files.SlackFilesScopeMissing("403")

    monkeypatch.setattr(slack_files, "download_slack_file", denied)
    result = slack_files.fetch_selected_images(files, "xoxb-test")
    assert result["images"] == []
    assert result["skipped"] == 2
    assert result["scope_missing"] is True


def test_fetch_selected_images_no_files_returns_empty(monkeypatch):
    result = slack_files.fetch_selected_images([], "xoxb-test")
    assert result == {"images": [], "skipped": 0, "scope_missing": False}


def test_fetch_selected_images_respects_cap_and_type_filter(monkeypatch):
    files = [_file(name=f"img{i}.png") for i in range(6)] + [_file(name="doc.pdf", mimetype="application/pdf")]
    monkeypatch.setattr(slack_files, "download_slack_file", lambda url, token: b"bytes")
    result = slack_files.fetch_selected_images(files, "xoxb-test")
    # Only the first 5 PNGs are attempted at all — the PDF is never selected, and the
    # 6th PNG never makes it into the selection either.
    assert len(result["images"]) == 5
    assert all(i["name"].endswith(".png") for i in result["images"])
