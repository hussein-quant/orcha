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

    /// Load open PRs into `githubPullsPhase`. Same graceful-off contract as issues.
    func loadGithubPulls() async {
        guard let sel = selectedContainer else {
            githubPullsPhase = .failed("No workspace is open — close this and try again.")
            return
        }
        githubPullsPhase = .loading
        do {
            githubPullsPhase = GitHubHubUx.phase(from: try await api.githubPulls(sel.baseUrl, sel.id))
        } catch let error as OrchaApiError where error.status == 404 {
            githubPullsPhase = .unavailable(reason: "repo_not_connected", detail: nil)
        } catch {
            githubPullsPhase = .failed(friendly(error))
        }
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
