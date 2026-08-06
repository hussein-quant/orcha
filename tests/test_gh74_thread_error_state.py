"""GH#74 — task thread must not get stuck blank / on 'Loading thread…' after a failed fetch.

A failed (network/non-200) thread fetch, OR a fetch that returns no messages while the snapshot
says count>0, must surface a visible "couldn't load — retry" affordance instead of a perpetual
spinner. A failing fetch must NOT be auto-retried on every 3s repaint (it latches until the user
retries). An explicit retry refetches without a full page reload.

Phase 7: the vanilla static/tasks.html is retired; the React port lives in
frontend/src/pages/tasks/TasksPage.tsx. Behavioral coverage (latch semantics, retry
refetch, cached-messages-preserved-on-failed-refresh) runs in Vitest against the real
component: frontend/src/pages/tasks/TasksPage.thread-retry.test.tsx. This file pins the
source contract so the affordance can't be silently dropped.
"""
import pathlib

REPO = pathlib.Path(__file__).resolve().parent.parent
TASKS_TSX = (
    REPO / "orcha-cli" / "orcha_cli" / "templates" / "portal"
    / "frontend" / "src" / "pages" / "tasks" / "TasksPage.tsx"
)


def test_thread_fetch_error_latches_and_surfaces_retry():
    src = TASKS_TSX.read_text()
    # a per-task latch exists and the loader consults it (no refetch-hammering each poll tick)
    assert "threadErrorRef" in src, "no latched thread-error state"
    assert "threadErrorRef.current[tid]" in src, "loader doesn't consult the latch"
    # an empty fetch while the snapshot expects messages is treated as a failure
    assert "want > 0" in src or "want >" in src, \
        "an empty fetch with summary count>0 isn't treated as an inconsistency"


def test_render_shows_retry_affordance_and_is_wired():
    src = TASKS_TSX.read_text()
    # render path offers a retry button (not blank, not perpetual "Loading thread…")
    assert "data-thread-retry" in src, "no retry affordance rendered for a failed thread fetch"
    assert "onRetry" in src, "retry button isn't wired to a refetch"
    # no regression: a task with zero real messages still shows the empty state
    assert "No messages yet." in src, "empty-thread state lost"


def test_failed_refresh_over_cached_messages_still_offers_retry():
    """Review blocker: a refresh that fails while cached messages are shown must still surface a
    retry control — otherwise the latch silently freezes the thread stale until a full page
    refresh. The React ThreadCard renders a distinct cached-but-stale branch."""
    src = TASKS_TSX.read_text()
    assert "Couldn&#39;t refresh" in src, "no stale-refresh notice for cached-messages-present failures"
    # both the empty-error and the cached-stale branches carry the retry control
    assert src.count("data-thread-retry") >= 2, \
        "retry button isn't rendered alongside cached messages on a failed refresh"
