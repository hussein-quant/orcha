import Foundation

/// GitHub hub — the view-owned load/start surface on AppModel (the `AppModel+*`
/// per-feature extension pattern). Reads land in per-surface phase state (the same
/// `.loading / .unavailable / .loaded / .failed` machine `membersState` and
/// `RepoConnectPhase` use); `available:false` or a 404 on an older server both
/// resolve to `.unavailable` — never the app-wide error banner. Start rides the
/// shared `humanAction` guard and returns the task so the view can navigate.

extension AppModel {

    /// The container's currently-bound repo ("owner/name"), or nil — drives the
    /// hub entry point's visibility (no repo ⇒ the friendly connect state).
    var githubRepo: String? {
        snapshot?.container.githubRepo
    }

    /// The signed-in GitHub login used for the "Mine" filter, or nil (self-host /
    /// unmapped) — in which case "Mine" falls back to the full list.
    var githubLogin: String? {
        identity?.githubLogin
    }

    /// Live AI agents in this container — the Start assignee picker's roster
    /// (ReviewerPickerSheet lists humans; the hub assigns work to AI agents).
    var githubAssignableAgents: [AgentDto] {
        MobileUx.orderAgents((snapshot?.agents ?? []).filter { $0.kind == "ai" && $0.terminatedAt == nil })
    }

    // MARK: list loads (the graceful off state lives in the phase, not the banner)

    /// Load open issues into `githubIssuesPhase`. A decode of the hub's own
    /// `available:false` 200 becomes `.unavailable`; a transport / non-2xx / 404
    /// (older server without the surface) becomes `.unavailable` too — never `.failed`
    /// for the degrade-gracefully contract. Genuine transport failures land in `.failed`.
    func loadGithubIssues() async {
        guard let sel = selectedContainer else {
            githubIssuesPhase = .failed("No workspace is open — close this and try again.")
            return
        }
        githubIssuesPhase = .loading
        do {
            githubIssuesPhase = GitHubHubUx.phase(from: try await api.githubIssues(sel.baseUrl, sel.id))
        } catch let error as OrchaApiError where error.status == 404 {
            // Older self-host server without the hub surface — degrade, don't error.
            githubIssuesPhase = .unavailable(reason: "repo_not_connected", detail: nil)
        } catch {
            githubIssuesPhase = .failed(friendly(error))
        }
    }

    /// Load open PRs into `githubPullsPhase`, applying the Open|Mine control plus
    /// `githubPullsFilter` (author/involvement/q) as server-side params. Same
    /// graceful-off contract as issues. Always fetches page 1 — call this whenever
    /// the filter/Open-Mine state changes, not `loadMoreGithubPulls`.
    func loadGithubPulls(filter: GitHubHubFilter = .open) async {
        guard let sel = selectedContainer else {
            githubPullsPhase = .failed("No workspace is open — close this and try again.")
            return
        }
        githubPullsFilter = githubPullsFilter.resetToFirstPage()
        githubPullsPhase = .loading
        do {
            let response = try await fetchGithubPulls(sel, filter: filter, page: 1)
            githubInvolvementUnavailableDetail = GitHubHubUx.involvementUnavailableDetail(response)
            githubPullsPhase = GitHubHubUx.phase(from: response)
        } catch let error as OrchaApiError where error.status == 404 {
            githubPullsPhase = .unavailable(reason: "repo_not_connected", detail: nil)
        } catch {
            githubPullsPhase = .failed(friendly(error))
        }
    }

    /// Fetch the next page and append it onto the rows already on screen. A no-op
    /// unless the phase is currently `.loaded` with `hasMore` — there is no page to
    /// load more of from `.idle`/`.loading`/`.unavailable`/`.failed`, and calling
    /// this mid-flight (already `.loadingMore`) would race two in-flight fetches.
    func loadMoreGithubPulls(filter: GitHubHubFilter = .open) async {
        guard let sel = selectedContainer,
              case let .loaded(repo, pulls, page) = githubPullsPhase,
              page.hasMore
        else { return }
        let nextPage = page.page + 1
        githubPullsPhase = .loadingMore(repo: repo, pulls: pulls, page: page)
        do {
            let response = try await fetchGithubPulls(sel, filter: filter, page: nextPage)
            githubInvolvementUnavailableDetail = GitHubHubUx.involvementUnavailableDetail(response)
            let (merged, info) = GitHubHubUx.accumulate(existing: pulls, incoming: response)
            githubPullsFilter.page = info.page
            githubPullsPhase = response.available
                ? .loaded(repo: response.repo ?? repo, pulls: merged, page: info)
                : .unavailable(reason: response.reason, detail: response.detail)
        } catch let error as OrchaApiError where error.status == 404 {
            // Restore the page the user was already looking at rather than
            // dropping it behind a friendly-off screen for a load-more hiccup.
            githubPullsPhase = .loaded(repo: repo, pulls: pulls, page: page)
        } catch {
            githubPullsPhase = .loaded(repo: repo, pulls: pulls, page: page)
            self.error = friendly(error) // surfaces via the app-wide error banner, list stays put
        }
    }

    /// Shared param-building + network call for both the first page and load-more.
    private func fetchGithubPulls(
        _ sel: StoredContainer, filter: GitHubHubFilter, page: Int
    ) async throws -> GitHubPullsResponse {
        let params = GitHubHubUx.pullsQueryParams(filter: filter, state: githubPullsFilter, login: githubLogin)
        return try await api.githubPulls(
            sel.baseUrl, sel.id,
            author: params.author,
            involvement: params.involvement,
            q: params.q,
            page: page,
            perPage: 30
        )
    }

    // MARK: detail loads (owned by the detail screens, phase returned)

    func loadGithubPullDetail(_ number: Int) async -> GitHubPullDetailPhase {
        guard let sel = selectedContainer else {
            return .failed("No workspace is open — close this and try again.")
        }
        do {
            return GitHubHubUx.phase(from: try await api.githubPullDetail(sel.baseUrl, sel.id, number))
        } catch let error as OrchaApiError where error.status == 404 {
            return .unavailable(reason: "not_found", detail: nil)
        } catch {
            return .failed(friendly(error))
        }
    }

    func loadGithubIssueDetail(_ number: Int) async -> GitHubIssueDetailPhase {
        guard let sel = selectedContainer else {
            return .failed("No workspace is open — close this and try again.")
        }
        do {
            return GitHubHubUx.phase(from: try await api.githubIssueDetail(sel.baseUrl, sel.id, number))
        } catch let error as OrchaApiError where error.status == 404 {
            return .unavailable(reason: "not_found", detail: nil)
        } catch {
            return .failed(friendly(error))
        }
    }

    // MARK: start

    /// `POST …/github/start` — create (or return the already-tracked) task for a GitHub
    /// item. Rides `humanAction` (retry-guard + toast + friendly error). Returns the
    /// server response so the caller can navigate to the task and distinguish a fresh
    /// start from an idempotent `existing:true` re-tap. The acting human is the task's
    /// creator (the grant model mirrors task creation exactly).
    func startGithubItem(
        kind: GitHubHubKind, number: Int,
        title: String?, bodyExcerpt: String?, htmlUrl: String?,
        assigneeAgentId: String?
    ) async -> GitHubStartResponse? {
        guard let sel = selectedContainer else { return nil }
        guard let actor = sel.humanAgentId else {
            error = "Pairing is missing the human identity. Reconnect this Orcha first."
            return nil
        }
        let assigneeName = assigneeAgentId.flatMap { id in
            githubAssignableAgents.first { $0.id == id }?.alias
        }
        actionInFlight = true
        error = nil
        defer { actionInFlight = false }
        do {
            let response = try await api.startGithubItem(
                sel.baseUrl, sel.id,
                kind: kind.startKind, number: number,
                title: title, bodyExcerpt: bodyExcerpt, htmlUrl: htmlUrl,
                assigneeAgentId: assigneeAgentId, createdByAgentId: actor
            )
            // `existing:true` — an OPEN `GH #N:` task already tracked this item; no
            // duplicate was created. Reflect that honestly instead of "Started".
            toast = response.existing
                ? "Already tracked — opening the existing task"
                : assigneeName.map { "Started · assigned to \($0)" } ?? "Started — parked as a task"
            await refresh()
            return response
        } catch {
            self.error = friendly(error)
            return nil
        }
    }
}
