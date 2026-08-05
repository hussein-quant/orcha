"""GH#74 — a thread must not get stuck blank / on a perpetual spinner after a failed fetch.

A failed (network/non-200) fetch must surface a VISIBLE unavailable state instead of a
perpetual "Loading…" spinner, and a later successful fetch must recover in place (no full
page reload).

MIGRATED (portal React migration): the vanilla tasks.html maybeLoadThread error latch
(threadError / data-thread-retry / staleError) is retired with the static files. In the
React SPA the conversation thread lives in frontend/src/pages/agents/Conversation.tsx:
a failed load() latches the `unavailable` state (rendered as "Conversation unavailable.",
never an eternal "Loading conversation…"), the 3s poll() cadence keeps re-attempting the
load while no conversation id is known (so a transient failure self-heals in place), and
a successful load clears the latch. The tasks-page thread card (TasksPage.tsx) degrades
to the snapshot's message_summary with a single in-flight lazy fetch guarded by
threadLoadingRef (no overlapping hammering).

Behavioral cases (stubbed-fetch render) moved to Vitest:
frontend/src/pages/agents/Conversation.errorstate.test.tsx. The source-contract
guards below pin the wiring so a refactor can't silently drop the latch.
"""
import pathlib
import re

REPO = pathlib.Path(__file__).resolve().parent.parent
CONV = (REPO / "orcha-cli" / "orcha_cli" / "templates" / "portal" / "frontend"
        / "src" / "pages" / "agents" / "Conversation.tsx")


def _src() -> str:
    return CONV.read_text()


def test_failed_load_latches_a_visible_unavailable_state():
    src = _src()
    load = re.search(r"const load = useCallback\(.*?\n  \}, \[", src, re.S)
    assert load, "Conversation load() not found"
    body = load.group(0)
    # the catch must latch a visible error state (not leave the panel on the spinner) …
    assert "setUnavailable(true)" in body, "a failed conversation fetch doesn't latch the unavailable state"
    # … and must ALSO mark the load finished, or the render stays on 'Loading conversation…'
    assert body.index("setUnavailable(true)") < body.rindex("setLoaded(true)"), \
        "the error path doesn't leave the loading state (perpetual spinner)"
    # a successful load clears the latch — recovery happens in place, no page reload
    assert "setUnavailable(false)" in body, "a successful load doesn't clear the unavailable latch"


def test_render_prefers_unavailable_over_spinner_and_empty_state():
    src = _src()
    # the unavailable branch must be checked BEFORE the loading and empty branches,
    # so a latched error can never render as an eternal spinner or a fake-empty thread
    m = re.search(r"\{unavailable \?(.*?)\}\s*\n", src, re.S)
    assert m, "render doesn't branch on the unavailable latch"
    assert "Conversation unavailable." in src, "no visible copy for the unavailable state"
    assert src.index("unavailable ?") < src.index("Loading conversation…"), \
        "the error state doesn't take precedence over the loading spinner"
    # no regression: a healthy-but-empty thread still shows the empty state
    assert "No messages yet" in src, "empty-thread state lost"


def test_poll_cadence_retries_the_failed_load_in_place():
    """Recovery path: while no conversation id is resolved (the failed-load shape), the 3s
    poll() falls back to load() — a transient failure self-heals without a page reload,
    and the retry goes through the SAME load path that clears the latch on success."""
    src = _src()
    poll = re.search(r"const poll = useCallback\(.*?\n  \}, \[", src, re.S)
    assert poll, "Conversation poll() not found"
    body = poll.group(0)
    assert re.search(r"if \(!cid\) \{\s*void load\(\);", body), \
        "poll() no longer falls back to load() while the conversation is unresolved (a failed load would never recover)"
    # the poll's own transient failures never crash the panel
    assert "catch" in body, "poll() doesn't tolerate transient fetch failures"
