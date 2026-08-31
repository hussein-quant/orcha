package io.openorcha.mobile.ui

/**
 * GitHub hub — the view-owned load/start surface on [OrchaViewModel], Android parity of
 * iOS's `AppModel+GitHubHub.swift`. Reads land in per-surface phase state (the same
 * loading / unavailable / loaded / failed machine the rest of the app uses);
 * `available:false` or a 404 on an older server both resolve to `Unavailable` — never
 * the app-wide error banner. Start rides the shared action-in-flight guard and returns
 * the task so the caller can navigate.
 */

import io.ktor.client.plugins.ClientRequestException
import io.openorcha.mobile.data.githubIssueDetail
import io.openorcha.mobile.data.githubIssues
import io.openorcha.mobile.data.githubPullDetail
import io.openorcha.mobile.data.githubPulls
import io.openorcha.mobile.data.startGithubItem
import io.openorcha.mobile.domain.GitHubHubFilter
import io.openorcha.mobile.domain.GitHubHubKind
import io.openorcha.mobile.domain.GitHubHubUx
import io.openorcha.mobile.domain.GitHubIssueDetailPhase
import io.openorcha.mobile.domain.GitHubIssuesPhase
import io.openorcha.mobile.domain.GitHubPullDetailPhase
import io.openorcha.mobile.domain.GitHubPullsPhase
import io.openorcha.mobile.domain.MobileUx
import kotlinx.coroutines.launch

/** Owns the GitHub hub's lists, detail screens, and the Start-as-a-task write. */
internal interface GitHubHubActions : OrchaViewModelAccess {

    /** Live AI agents in this container — the Start assignee picker's roster (the hub
     *  assigns work to AI agents, not humans). */
    fun githubAssignableAgents() =
        MobileUx.orderAgents((_uiState.value.snapshot?.agents ?: emptyList()).filter { it.kind == "ai" && it.terminatedAt == null })

    /** The signed-in GitHub login used for the "Mine" filter, or null. */
    fun githubLogin(): String? =
        _uiState.value.snapshot?.agents?.firstOrNull { it.id == _uiState.value.selectedContainer?.humanAgentId }?.githubLogin

    fun showGithubHub() {
        _uiState.update { it.copy(route = AppRoute.GitHubHub, error = null) }
        loadGithubIssues()
        loadGithubPulls()
    }

    fun selectGithubHubKind(kind: GitHubHubKind) {
        _uiState.update { it.copy(githubHubKind = kind) }
    }

    fun selectGithubHubFilter(filter: GitHubHubFilter) {
        _uiState.update { it.copy(githubHubFilter = filter) }
    }

    /** A decode of the hub's own `available:false` 200 becomes Unavailable; a transport /
     *  non-2xx / 404 (older server without the surface) becomes Unavailable too — never
     *  Failed, for the degrade-gracefully contract. Genuine transport failures land in Failed. */
    fun loadGithubIssues() {
        val selected = _uiState.value.selectedContainer ?: run {
            _uiState.update { it.copy(githubIssuesPhase = GitHubIssuesPhase.Failed("No workspace is open — close this and try again.")) }
            return
        }
        _uiState.update { it.copy(githubIssuesPhase = GitHubIssuesPhase.Loading) }
        scope.launch {
            runCatching { api.githubIssues(selected.baseUrl, selected.id) }
                .onSuccess { response -> _uiState.update { it.copy(githubIssuesPhase = GitHubHubUx.phase(response)) } }
                .onFailure { err -> _uiState.update { it.copy(githubIssuesPhase = githubIssuesFailure(err)) } }
        }
    }

    fun loadGithubPulls() {
        val selected = _uiState.value.selectedContainer ?: run {
            _uiState.update { it.copy(githubPullsPhase = GitHubPullsPhase.Failed("No workspace is open — close this and try again.")) }
            return
        }
        _uiState.update { it.copy(githubPullsPhase = GitHubPullsPhase.Loading) }
        scope.launch {
            runCatching { api.githubPulls(selected.baseUrl, selected.id) }
                .onSuccess { response -> _uiState.update { it.copy(githubPullsPhase = GitHubHubUx.phase(response)) } }
                .onFailure { err -> _uiState.update { it.copy(githubPullsPhase = githubPullsFailure(err)) } }
        }
    }

    fun openGithubIssue(number: Int) {
        _uiState.update {
            it.copy(route = AppRoute.GitHubIssueDetail, githubIssueNumber = number, githubIssueDetailPhase = GitHubIssueDetailPhase.Loading)
        }
        loadGithubIssueDetail()
    }

    fun loadGithubIssueDetail() {
        val selected = _uiState.value.selectedContainer ?: return
        val number = _uiState.value.githubIssueNumber ?: return
        scope.launch {
            runCatching { api.githubIssueDetail(selected.baseUrl, selected.id, number) }
                .onSuccess { response -> _uiState.update { it.copy(githubIssueDetailPhase = GitHubHubUx.phase(response)) } }
                .onFailure { err ->
                    val phase = if (statusOfGithubError(err) == 404) {
                        GitHubIssueDetailPhase.Unavailable(reason = "not_found", detail = null)
                    } else {
                        GitHubIssueDetailPhase.Failed(friendlyConnectionError(err))
                    }
                    _uiState.update { it.copy(githubIssueDetailPhase = phase) }
                }
        }
    }

    fun openGithubPull(number: Int) {
        _uiState.update {
            it.copy(route = AppRoute.GitHubPullDetail, githubPullNumber = number, githubPullDetailPhase = GitHubPullDetailPhase.Loading)
        }
        loadGithubPullDetail()
    }

    fun loadGithubPullDetail() {
        val selected = _uiState.value.selectedContainer ?: return
        val number = _uiState.value.githubPullNumber ?: return
        scope.launch {
            runCatching { api.githubPullDetail(selected.baseUrl, selected.id, number) }
                .onSuccess { response -> _uiState.update { it.copy(githubPullDetailPhase = GitHubHubUx.phase(response)) } }
                .onFailure { err ->
                    val phase = if (statusOfGithubError(err) == 404) {
                        GitHubPullDetailPhase.Unavailable(reason = "not_found", detail = null)
                    } else {
                        GitHubPullDetailPhase.Failed(friendlyConnectionError(err))
                    }
                    _uiState.update { it.copy(githubPullDetailPhase = phase) }
                }
        }
    }

    /** `POST …/github/start` — create (or return the already-tracked) task for a GitHub
     *  item. Returns via `githubStarted` in state so the caller can navigate to the task
     *  and distinguish a fresh start from an idempotent `existing:true` re-tap. The acting
     *  human is the task's creator (the grant model mirrors task creation exactly). */
    fun startGithubItem(
        kind: GitHubHubKind,
        number: Int,
        title: String?,
        bodyExcerpt: String?,
        htmlUrl: String?,
        assigneeAgentId: String?,
    ) {
        val selected = _uiState.value.selectedContainer ?: return
        val actor = selected.humanAgentId ?: run {
            _uiState.update { it.copy(error = "Pairing is missing the human identity. Reconnect this Orcha first.") }
            return
        }
        val assigneeName = assigneeAgentId?.let { id -> githubAssignableAgents().firstOrNull { it.id == id }?.alias }
        scope.launch {
            _uiState.update { it.copy(actionInFlight = true, error = null) }
            runCatching {
                api.startGithubItem(
                    selected.baseUrl, selected.id,
                    kind = kind.startKind, number = number,
                    title = title, bodyExcerpt = bodyExcerpt, htmlUrl = htmlUrl,
                    assigneeAgentId = assigneeAgentId, createdByAgentId = actor,
                )
            }.onSuccess { response ->
                val toast = if (response.existing) {
                    "Already tracked — opening the existing task"
                } else {
                    assigneeName?.let { "Started · assigned to $it" } ?: "Started — parked as a task"
                }
                _uiState.update { it.copy(actionInFlight = false, toast = toast, githubStarted = response) }
                refreshSelected()
            }.onFailure { err ->
                _uiState.update { it.copy(actionInFlight = false, error = friendlyConnectionError(err)) }
            }
        }
    }

    /** Consumes the pending start result once the caller has navigated to it. */
    fun clearGithubStarted() {
        _uiState.update { it.copy(githubStarted = null) }
    }

    fun githubIssuesFailure(err: Throwable) =
        if (statusOfGithubError(err) == 404) GitHubIssuesPhase.Unavailable(reason = "repo_not_connected", detail = null)
        else GitHubIssuesPhase.Failed(friendlyConnectionError(err))

    fun githubPullsFailure(err: Throwable) =
        if (statusOfGithubError(err) == 404) GitHubPullsPhase.Unavailable(reason = "repo_not_connected", detail = null)
        else GitHubPullsPhase.Failed(friendlyConnectionError(err))
}

/** The HTTP status of a Ktor client error, or null when [err] isn't one — lets a 404
 *  (older self-host server without the GitHub surface) degrade instead of erroring. */
private fun statusOfGithubError(err: Throwable): Int? = (err as? ClientRequestException)?.response?.status?.value
