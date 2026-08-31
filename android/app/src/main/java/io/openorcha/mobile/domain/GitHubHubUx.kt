package io.openorcha.mobile.domain

/**
 * The GitHub hub's binding-state machine + pure selectors — Android parity of iOS's
 * `GitHubHub.swift` (phase enums) + `GitHubHubUx.swift` (pure selectors). Kept out of
 * Compose so it's unit-testable. A response (or its failure) maps straight to what the
 * list renders: loading → off / list / error.
 */

import io.openorcha.mobile.data.GitHubChecks
import io.openorcha.mobile.data.GitHubCheckRun
import io.openorcha.mobile.data.GitHubIssueDetail
import io.openorcha.mobile.data.GitHubIssueDetailResponse
import io.openorcha.mobile.data.GitHubIssueRow
import io.openorcha.mobile.data.GitHubIssuesResponse
import io.openorcha.mobile.data.GitHubPullDetail
import io.openorcha.mobile.data.GitHubPullDetailResponse
import io.openorcha.mobile.data.GitHubPullRow
import io.openorcha.mobile.data.GitHubPullsResponse

/** Which segment the list is showing. */
enum class GitHubHubKind(val title: String, val startKind: String) {
    Issues("Issues", "issue"),
    Pulls("Pull requests", "pull"),
}

/** Open / Mine filter over a list. "Mine" = assigned to (issues) or review-requested
 *  from (PRs) the signed-in GitHub login; with no known login it falls back to Open. */
enum class GitHubHubFilter(val label: String) {
    Open("Open"),
    Mine("Mine"),
}

/** The list's loading → available:false → loaded machine for issues. */
sealed class GitHubIssuesPhase {
    object Idle : GitHubIssuesPhase()
    object Loading : GitHubIssuesPhase()
    /** `available:false` (unbound / rate-limited / GitHub error) OR the endpoint 404'd
     *  on an older server — the friendly "connect a repo" off state. */
    data class Unavailable(val reason: String?, val detail: String?) : GitHubIssuesPhase()
    data class Loaded(val repo: String?, val issues: List<GitHubIssueRow>) : GitHubIssuesPhase()
    /** The request itself failed (network / auth perimeter / non-2xx outside the
     *  hub's own 200-off contract). */
    data class Failed(val message: String) : GitHubIssuesPhase()
}

/** The PR list's machine (same shape, distinct payload). */
sealed class GitHubPullsPhase {
    object Idle : GitHubPullsPhase()
    object Loading : GitHubPullsPhase()
    data class Unavailable(val reason: String?, val detail: String?) : GitHubPullsPhase()
    data class Loaded(val repo: String?, val pulls: List<GitHubPullRow>) : GitHubPullsPhase()
    data class Failed(val message: String) : GitHubPullsPhase()
}

/** Detail machines (PR / issue), same graceful-off contract. */
sealed class GitHubPullDetailPhase {
    object Loading : GitHubPullDetailPhase()
    data class Unavailable(val reason: String?, val detail: String?) : GitHubPullDetailPhase()
    data class Loaded(val repo: String?, val pull: GitHubPullDetail) : GitHubPullDetailPhase()
    data class Failed(val message: String) : GitHubPullDetailPhase()
}

sealed class GitHubIssueDetailPhase {
    object Loading : GitHubIssueDetailPhase()
    data class Unavailable(val reason: String?, val detail: String?) : GitHubIssueDetailPhase()
    data class Loaded(val repo: String?, val issue: GitHubIssueDetail) : GitHubIssueDetailPhase()
    data class Failed(val message: String) : GitHubIssueDetailPhase()
}

/** The compact "n passed / m failing / k pending" summary a checks chip shows, plus the
 *  one-glance verdict color the chip tints itself with. */
data class ChecksSummary(
    /** A short chip label, e.g. "3✓ 2✗ 2•" or "no checks". */
    val label: String,
    /** The dominant state: failing beats pending beats passed beats none. */
    val verdict: Verdict,
    /** Whether any checks exist at all (total > 0). */
    val hasChecks: Boolean,
) {
    enum class Verdict { Failing, Pending, Passing, None }
}

/** Pure selectors for the GitHub hub — response→phase mapping, Open/Mine filtering, and
 *  the checks-chip summary. No Compose here so it's all unit-testable. */
object GitHubHubUx {

    // ---------- response → phase ----------

    fun phase(response: GitHubIssuesResponse): GitHubIssuesPhase =
        if (response.available) {
            GitHubIssuesPhase.Loaded(response.repo, response.issues)
        } else {
            GitHubIssuesPhase.Unavailable(response.reason, response.detail)
        }

    fun phase(response: GitHubPullsResponse): GitHubPullsPhase =
        if (response.available) {
            GitHubPullsPhase.Loaded(response.repo, response.pulls)
        } else {
            GitHubPullsPhase.Unavailable(response.reason, response.detail)
        }

    fun phase(response: GitHubPullDetailResponse): GitHubPullDetailPhase {
        val pull = response.pull
        return if (response.available && pull != null) {
            GitHubPullDetailPhase.Loaded(response.repo, pull)
        } else {
            GitHubPullDetailPhase.Unavailable(response.reason, response.detail)
        }
    }

    fun phase(response: GitHubIssueDetailResponse): GitHubIssueDetailPhase {
        val issue = response.issue
        return if (response.available && issue != null) {
            GitHubIssueDetailPhase.Loaded(response.repo, issue)
        } else {
            GitHubIssueDetailPhase.Unavailable(response.reason, response.detail)
        }
    }

    // ---------- Open / Mine filtering ----------

    /** Issues assigned to [login] (matched against the primary assignee). A blank login
     *  yields the full list — "Mine" can't be answered, so it shows everything. */
    fun filterIssues(issues: List<GitHubIssueRow>, filter: GitHubHubFilter, login: String?): List<GitHubIssueRow> {
        val normalized = normalizedLogin(login) ?: return issues
        if (filter != GitHubHubFilter.Mine) return issues
        return issues.filter { normalizedLogin(it.assignee) == normalized }
    }

    /** PRs whose review is requested from [login]. Same blank-login fallback. */
    fun filterPulls(pulls: List<GitHubPullRow>, filter: GitHubHubFilter, login: String?): List<GitHubPullRow> {
        val normalized = normalizedLogin(login) ?: return pulls
        if (filter != GitHubHubFilter.Mine) return pulls
        return pulls.filter { pull -> pull.requestedReviewers.any { normalizedLogin(it) == normalized } }
    }

    private fun normalizedLogin(login: String?): String? {
        val value = login?.trim()?.lowercase()
        return if (value.isNullOrEmpty()) null else value
    }

    // ---------- checks chip summary ----------

    /** Roll the four counts up into a chip summary. The dominant verdict follows the
     *  portal: any failing → failing; else any pending → pending; else any passed →
     *  passing; else none. `total == 0` (older server or no CI) → the "no checks" pill. */
    fun checksSummary(checks: GitHubChecks): ChecksSummary {
        if (checks.total <= 0) {
            return ChecksSummary(label = "no checks", verdict = ChecksSummary.Verdict.None, hasChecks = false)
        }
        val parts = buildList {
            if (checks.passed > 0) add("${checks.passed}✓")
            if (checks.failing > 0) add("${checks.failing}✗")
            if (checks.pending > 0) add("${checks.pending}•")
        }
        val label = if (parts.isEmpty()) "${checks.total} checks" else parts.joinToString(" ")
        val verdict = when {
            checks.failing > 0 -> ChecksSummary.Verdict.Failing
            checks.pending > 0 -> ChecksSummary.Verdict.Pending
            checks.passed > 0 -> ChecksSummary.Verdict.Passing
            else -> ChecksSummary.Verdict.None
        }
        return ChecksSummary(label = label, verdict = verdict, hasChecks = true)
    }

    /** Per-run status glyph for the detail checks list. Maps GitHub's status + conclusion
     *  onto one of the four verdict families. */
    fun runVerdict(run: GitHubCheckRun): ChecksSummary.Verdict {
        if (run.status != "completed") return ChecksSummary.Verdict.Pending
        return when (run.conclusion) {
            "success", "neutral", "skipped" -> ChecksSummary.Verdict.Passing
            "failure", "timed_out", "action_required", "cancelled", "stale", "startup_failure" -> ChecksSummary.Verdict.Failing
            else -> ChecksSummary.Verdict.Pending
        }
    }

    // ---------- mergeable-state chip copy ----------

    /** Human copy for GitHub's raw `mergeable_state`. null / unknown → no chip. */
    fun mergeStateLabel(state: String?): String? = when (state) {
        "clean" -> "ready to merge"
        "dirty" -> "conflicts"
        "blocked" -> "blocked"
        "behind" -> "behind base"
        "unstable" -> "unstable"
        "has_hooks" -> "checks running"
        "draft" -> "draft"
        "unknown", "", null -> null
        else -> state.replace("_", " ")
    }

    /** A short human line for an `available:false` reason — the empty-state copy. */
    fun unavailableCopy(reason: String?, detail: String?): String = when (reason) {
        "repo_not_connected" ->
            "No GitHub repository is connected to this Orcha yet. Connect one from the Home tab to see its issues and pull requests here."
        "rate_limited" ->
            "GitHub is rate-limiting requests right now. This will clear on its own — try again in a few minutes."
        "not_found" ->
            "That item no longer exists on GitHub, or the repository binding changed."
        "unreachable" ->
            "Couldn't reach GitHub from this Orcha. Check the server's connection and try again."
        "github_error" -> detail ?: "GitHub returned an error. Try again shortly."
        else -> detail ?: "The GitHub surface isn't available for this Orcha right now."
    }
}
