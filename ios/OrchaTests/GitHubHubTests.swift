import Foundation
import Testing
@testable import Orcha

/// GitHub hub (cloud PRs #94 + #95) — the serialization contract for all four
/// endpoint shapes, the start-request body, and the pure hub logic (phase mapping,
/// Open/Mine filtering, checks-chip summary).

// MARK: - decoding fixtures

@Suite struct GitHubHubDecodeTests {
    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(type, from: Data(json.utf8))
    }

    // ---------- GET …/github/issues ----------

    @Test func issuesResponseDecodesTheAvailableShape() throws {
        let response = try decode(GitHubIssuesResponse.self, """
        {"available": true, "repo": "owner/name", "issues": [
            {"number": 7, "title": "Bug", "labels": ["bug", "p1"], "assignee": "octocat",
             "updated_at": "2026-07-01T00:00:00Z",
             "html_url": "https://github.com/owner/name/issues/7",
             "body_excerpt": "first 200 chars"}
        ]}
        """)
        #expect(response.available)
        #expect(response.repo == "owner/name")
        let issue = try #require(response.issues.first)
        #expect(issue.number == 7)
        #expect(issue.title == "Bug")
        #expect(issue.labels == ["bug", "p1"])
        #expect(issue.assignee == "octocat")
        #expect(issue.htmlUrl == "https://github.com/owner/name/issues/7")
        #expect(issue.bodyExcerpt == "first 200 chars")
    }

    @Test func issueRowToleratesNullAndAbsentOptionalFields() throws {
        // Unassigned issue with no labels/excerpt (a pre-triage item on a lean server).
        let response = try decode(GitHubIssuesResponse.self, """
        {"available": true, "repo": "o/n", "issues": [
            {"number": 3, "title": "Bare", "assignee": null}
        ]}
        """)
        let issue = try #require(response.issues.first)
        #expect(issue.assignee == nil)
        #expect(issue.labels.isEmpty)
        #expect(issue.bodyExcerpt == nil)
        #expect(issue.updatedAt == nil)
    }

    @Test(arguments: [
        #"{"available": false, "reason": "repo_not_connected", "detail": "no repo"}"#,
        #"{"available": false, "reason": "rate_limited", "detail": "GitHub 403", "repo": "o/n"}"#,
    ])
    func issuesResponseDecodesTheGracefulOffState(json: String) throws {
        let response = try decode(GitHubIssuesResponse.self, json)
        #expect(response.available == false)
        #expect(response.reason != nil)
        #expect(response.issues.isEmpty)
    }

    // ---------- GET …/github/pulls ----------

    @Test func pullsResponseDecodesChecksAndReviewers() throws {
        let response = try decode(GitHubPullsResponse.self, """
        {"available": true, "repo": "o/n", "pulls": [
            {"number": 12, "title": "Feature", "head": "feat/x", "draft": false,
             "updated_at": "2026-07-02T00:00:00Z", "html_url": "https://github.com/o/n/pull/12",
             "requested_reviewers": ["hubot"],
             "checks": {"passed": 3, "failing": 2, "pending": 2, "total": 7},
             "mergeable_state": "clean"}
        ]}
        """)
        let pull = try #require(response.pulls.first)
        #expect(pull.number == 12)
        #expect(pull.head == "feat/x")
        #expect(pull.draft == false)
        #expect(pull.requestedReviewers == ["hubot"])
        #expect(pull.checks.passed == 3)
        #expect(pull.checks.failing == 2)
        #expect(pull.checks.pending == 2)
        #expect(pull.checks.total == 7)
        #expect(pull.mergeableState == "clean")
    }

    @Test func draftPullWithEmptyReviewersAndNullMergeState() throws {
        // A freshly-pushed draft: no reviewers, checks not yet reported, null merge state
        // (the live server's actual shape for a just-opened PR).
        let response = try decode(GitHubPullsResponse.self, """
        {"available": true, "repo": "o/n", "pulls": [
            {"number": 221, "title": "WIP", "head": "wip/x", "draft": true,
             "requested_reviewers": [],
             "checks": {"passed": 0, "failing": 0, "pending": 0, "total": 0},
             "mergeable_state": null}
        ]}
        """)
        let pull = try #require(response.pulls.first)
        #expect(pull.draft)
        #expect(pull.requestedReviewers.isEmpty)
        #expect(pull.checks.total == 0)
        #expect(pull.mergeableState == nil)
    }

    @Test func pullRowToleratesEntirelyAbsentChecksBlock() throws {
        // An older server that predates the checks rollup — the row still decodes.
        let response = try decode(GitHubPullsResponse.self, """
        {"available": true, "repo": "o/n", "pulls": [{"number": 5, "title": "Old"}]}
        """)
        let pull = try #require(response.pulls.first)
        #expect(pull.checks.total == 0)
        #expect(pull.head.isEmpty)
    }

    // ---------- GET …/github/pulls/{number} ----------

    @Test func pullDetailDecodesFullShape() throws {
        let response = try decode(GitHubPullDetailResponse.self, """
        {"available": true, "repo": "o/n", "pull": {
            "number": 12, "title": "Add feature", "state": "open", "draft": false,
            "body_markdown": "## Why\\n...", "author_login": "octocat",
            "base": "main", "head": "feat/x",
            "updated_at": "2026-07-02T00:00:00Z", "created_at": "2026-07-01T00:00:00Z",
            "html_url": "https://github.com/o/n/pull/12", "mergeable_state": "clean",
            "assignees": ["octocat", "hubot"], "requested_reviewers": ["reviewer1"],
            "checks": {"passed": 2, "failing": 0, "pending": 1, "total": 3,
                       "runs": [{"name": "build", "status": "completed",
                                 "conclusion": "success", "html_url": "https://x"}]},
            "files": {"count": 2, "truncated": true, "items": [
                {"filename": "a.py", "additions": 10, "deletions": 2, "status": "modified"}
            ]},
            "comments_count": 3, "review_comments_count": 5
        }}
        """)
        let pull = try #require(response.pull)
        #expect(pull.bodyMarkdown == "## Why\n...")
        #expect(pull.base == "main")
        #expect(pull.head == "feat/x")
        #expect(pull.assignees == ["octocat", "hubot"])
        #expect(pull.checks.runs.count == 1)
        #expect(pull.checks.runs.first?.name == "build")
        #expect(pull.checks.runs.first?.conclusion == "success")
        #expect(pull.commentsCount == 3)
        #expect(pull.reviewCommentsCount == 5)
    }

    @Test func pullDetailFilesTruncatedFlag() throws {
        // truncated:true present exactly when count > items returned.
        let truncated = try decode(GitHubFiles.self,
            #"{"count": 120, "truncated": true, "items": [{"filename": "a", "additions": 1, "deletions": 0, "status": "added"}]}"#)
        #expect(truncated.count == 120)
        #expect(truncated.items.count == 1)
        #expect(truncated.truncated)

        // truncated omitted ⇒ false (the small-PR case).
        let whole = try decode(GitHubFiles.self,
            #"{"count": 1, "items": [{"filename": "a", "additions": 1, "deletions": 0, "status": "added"}]}"#)
        #expect(whole.truncated == false)
    }

    // ---------- GET …/github/issues/{number} ----------

    @Test func issueDetailDecodesCommentsOldestFirst() throws {
        let response = try decode(GitHubIssueDetailResponse.self, """
        {"available": true, "repo": "o/n", "issue": {
            "number": 7, "title": "Bug: crash", "state": "open",
            "body_markdown": "steps to repro", "author_login": "reporter",
            "labels": ["bug", "p1"], "assignee": "octocat",
            "assignees": ["octocat", "hubot"],
            "updated_at": "2026-07-03T00:00:00Z", "created_at": "2026-07-01T00:00:00Z",
            "html_url": "https://github.com/o/n/issues/7",
            "comments_count": 2, "comments": [
                {"author_login": "a", "body_markdown": "first (older)", "created_at": "2026-07-01T00:00:00Z"},
                {"author_login": "b", "body_markdown": "second (newer)", "created_at": "2026-07-02T00:00:00Z"}
            ]
        }}
        """)
        let issue = try #require(response.issue)
        #expect(issue.bodyMarkdown == "steps to repro")
        #expect(issue.labels == ["bug", "p1"])
        #expect(issue.assignee == "octocat")
        #expect(issue.assignees == ["octocat", "hubot"])
        #expect(issue.comments.map(\.bodyMarkdown) == ["first (older)", "second (newer)"])
        #expect(issue.comments.first?.authorLogin == "a")
    }

    @Test func issueDetailWithNoCommentsDecodesEmpty() throws {
        let response = try decode(GitHubIssueDetailResponse.self, """
        {"available": true, "repo": "o/n", "issue": {
            "number": 1, "title": "Quiet", "body_markdown": "", "comments_count": 0, "comments": []
        }}
        """)
        let issue = try #require(response.issue)
        #expect(issue.comments.isEmpty)
        #expect(issue.commentsCount == 0)
        #expect(issue.labels.isEmpty)
    }

    // ---------- detail off states ----------

    @Test(arguments: ["not_found", "rate_limited", "repo_not_connected"])
    func detailOffStateHasNoItem(reason: String) throws {
        let pull = try decode(GitHubPullDetailResponse.self,
            #"{"available": false, "reason": "\#(reason)", "detail": "…", "repo": "o/n"}"#)
        #expect(pull.available == false)
        #expect(pull.pull == nil)
        #expect(pull.reason == reason)

        let issue = try decode(GitHubIssueDetailResponse.self,
            #"{"available": false, "reason": "\#(reason)", "detail": "…", "repo": "o/n"}"#)
        #expect(issue.available == false)
        #expect(issue.issue == nil)
    }

    // ---------- POST …/github/start response ----------

    @Test func startResponseDecodesFreshAndExisting() throws {
        let fresh = try decode(GitHubStartResponse.self, #"{"task_id": "abc-123", "existing": false}"#)
        #expect(fresh.taskId == "abc-123")
        #expect(fresh.existing == false)

        let existing = try decode(GitHubStartResponse.self, #"{"task_id": "abc-123", "existing": true}"#)
        #expect(existing.existing)

        // `existing` absent ⇒ false (older server).
        let bare = try decode(GitHubStartResponse.self, #"{"task_id": "abc-123"}"#)
        #expect(bare.existing == false)
    }
}

// MARK: - start-request body encoding

@Suite struct GitHubStartBodyTests {
    @Test func bodyCarriesKindNumberAndAssignee() {
        let body = OrchaApiClient.startBody(
            kind: "issue", number: 7,
            title: "Bug", bodyExcerpt: "excerpt", htmlUrl: "https://x",
            assigneeAgentId: "agent-1", createdByAgentId: "human-1"
        )
        #expect(body["kind"] as? String == "issue")
        #expect(body["number"] as? Int == 7)
        #expect(body["assignee_agent_id"] as? String == "agent-1")
        #expect(body["created_by_agent_id"] as? String == "human-1")
        #expect(body["body_excerpt"] as? String == "excerpt")
        #expect(body["html_url"] as? String == "https://x")
    }

    @Test func unassignedStartCarriesNilAssignee() {
        // Bare Start (no agent) — the assignee key is present-but-nil so the JSON
        // layer drops it, yielding an unassigned `ready` task server-side.
        let body = OrchaApiClient.startBody(
            kind: "pull", number: 12,
            title: nil, bodyExcerpt: nil, htmlUrl: nil,
            assigneeAgentId: nil, createdByAgentId: "human-1"
        )
        #expect(body["kind"] as? String == "pull")
        // `Any?` stored explicitly nil: the value is `.some(nil)`.
        let assignee = body["assignee_agent_id"] ?? nil
        #expect(assignee == nil)
        // A real POST drops nil keys — proven by round-tripping through the same
        // compactMapValues the client uses.
        let cleaned = body.compactMapValues { $0 }
        #expect(cleaned["assignee_agent_id"] == nil)
        #expect(cleaned["title"] == nil)
        #expect(cleaned["kind"] as? String == "pull")
        #expect(cleaned["number"] as? Int == 12)
    }
}

// MARK: - phase mapping (loading / available:false / loaded)

@Suite struct GitHubHubPhaseTests {
    @Test func availableIssuesBecomeLoaded() {
        let response = GitHubIssuesResponse(available: true, repo: "o/n",
                                            issues: [GitHubIssueRow(number: 1, title: "A")])
        #expect(GitHubHubUx.phase(from: response) == .loaded(repo: "o/n", issues: [GitHubIssueRow(number: 1, title: "A")]))
    }

    @Test func unavailableIssuesBecomeOffState() {
        let response = GitHubIssuesResponse(available: false, reason: "repo_not_connected", detail: "no repo")
        #expect(GitHubHubUx.phase(from: response) == .unavailable(reason: "repo_not_connected", detail: "no repo"))
    }

    @Test func availablePullsBecomeLoaded() {
        let response = GitHubPullsResponse(available: true, repo: "o/n",
                                           pulls: [GitHubPullRow(number: 2, title: "P")])
        #expect(GitHubHubUx.phase(from: response) == .loaded(repo: "o/n", pulls: [GitHubPullRow(number: 2, title: "P")]))
    }

    @Test func availableButMissingItemFallsToOffState() {
        // available:true with no `pull` body (a malformed / partial server response)
        // must degrade to the off state, never crash.
        let response = GitHubPullDetailResponse(available: true, repo: "o/n", reason: nil, detail: nil, pull: nil)
        #expect(GitHubHubUx.phase(from: response) == .unavailable(reason: nil, detail: nil))
    }

    @Test func detailLoadedCarriesItem() {
        let pull = makePull(number: 9)
        let response = GitHubPullDetailResponse(available: true, repo: "o/n", reason: nil, detail: nil, pull: pull)
        #expect(GitHubHubUx.phase(from: response) == .loaded(repo: "o/n", pull: pull))
    }
}

// MARK: - Open / Mine filtering

@Suite struct GitHubHubFilterTests {
    private let issues = [
        GitHubIssueRow(number: 1, title: "mine", assignee: "octocat"),
        GitHubIssueRow(number: 2, title: "theirs", assignee: "hubot"),
        GitHubIssueRow(number: 3, title: "unassigned", assignee: nil),
    ]
    private let pulls = [
        GitHubPullRow(number: 10, title: "review me", requestedReviewers: ["octocat", "hubot"]),
        GitHubPullRow(number: 11, title: "not mine", requestedReviewers: ["hubot"]),
        GitHubPullRow(number: 12, title: "no reviewers", requestedReviewers: []),
    ]

    @Test func openFilterKeepsEverything() {
        #expect(GitHubHubUx.filterIssues(issues, filter: .open, login: "octocat").count == 3)
        #expect(GitHubHubUx.filterPulls(pulls, filter: .open, login: "octocat").count == 3)
    }

    @Test func mineIssuesMatchAssigneeCaseInsensitively() {
        let mine = GitHubHubUx.filterIssues(issues, filter: .mine, login: "OCTOCAT")
        #expect(mine.map(\.number) == [1])
    }

    @Test func minePullsMatchRequestedReviewer() {
        let mine = GitHubHubUx.filterPulls(pulls, filter: .mine, login: "octocat")
        #expect(mine.map(\.number) == [10])
    }

    @Test(arguments: [nil, "", "   "] as [String?])
    func mineWithNoKnownLoginFallsBackToFullList(login: String?) {
        // Self-host / unmapped: "Mine" can't be answered, so it shows everything.
        #expect(GitHubHubUx.filterIssues(issues, filter: .mine, login: login).count == 3)
        #expect(GitHubHubUx.filterPulls(pulls, filter: .mine, login: login).count == 3)
    }
}

// MARK: - checks-chip summary logic

@Suite struct GitHubChecksSummaryTests {
    @Test func noChecksIsTheEmptyPill() {
        let summary = GitHubHubUx.checksSummary(GitHubChecks(total: 0))
        #expect(summary.hasChecks == false)
        #expect(summary.verdict == .none)
        #expect(summary.label == "no checks")
    }

    @Test func anyFailingDominates() {
        let summary = GitHubHubUx.checksSummary(GitHubChecks(passed: 3, failing: 2, pending: 2, total: 7))
        #expect(summary.verdict == .failing)
        #expect(summary.label == "3✓ 2✗ 2•")
    }

    @Test func pendingBeatsPassedWhenNoneFailing() {
        let summary = GitHubHubUx.checksSummary(GitHubChecks(passed: 3, failing: 0, pending: 1, total: 4))
        #expect(summary.verdict == .pending)
    }

    @Test func allPassedIsPassing() {
        let summary = GitHubHubUx.checksSummary(GitHubChecks(passed: 4, failing: 0, pending: 0, total: 4))
        #expect(summary.verdict == .passing)
        #expect(summary.label == "4✓")
    }

    @Test func totalWithoutBreakdownStillReportsCount() {
        // total>0 but no per-bucket counts (a lean rollup) — the chip still shows it.
        let summary = GitHubHubUx.checksSummary(GitHubChecks(passed: 0, failing: 0, pending: 0, total: 3))
        #expect(summary.hasChecks)
        #expect(summary.label == "3 checks")
        #expect(summary.verdict == .none)
    }

    // ---------- per-run verdict ----------

    @Test(arguments: [
        ("completed", "success", GitHubHubUx.ChecksSummary.Verdict.passing),
        ("completed", "neutral", .passing),
        ("completed", "skipped", .passing),
        ("completed", "failure", .failing),
        ("completed", "timed_out", .failing),
        ("completed", "cancelled", .failing),
        ("in_progress", nil, .pending),
        ("queued", nil, .pending),
    ] as [(String, String?, GitHubHubUx.ChecksSummary.Verdict)])
    func runVerdictMapsStatusAndConclusion(status: String, conclusion: String?, expected: GitHubHubUx.ChecksSummary.Verdict) {
        let run = GitHubCheckRun(name: "x", status: status, conclusion: conclusion)
        #expect(GitHubHubUx.runVerdict(run) == expected)
    }

    // ---------- merge-state copy ----------

    @Test func mergeStateCopyMapsKnownStates() {
        #expect(GitHubHubUx.mergeStateLabel("clean") == "ready to merge")
        #expect(GitHubHubUx.mergeStateLabel("dirty") == "conflicts")
        #expect(GitHubHubUx.mergeStateLabel("blocked") == "blocked")
        #expect(GitHubHubUx.mergeStateLabel(nil) == nil)
        #expect(GitHubHubUx.mergeStateLabel("unknown") == nil)
        #expect(GitHubHubUx.mergeStateLabel("") == nil)
    }
}

// MARK: - fixtures

private func makePull(number: Int) -> GitHubPullDetail {
    let json = """
    {"number": \(number), "title": "P", "state": "open", "base": "main", "head": "feat",
     "body_markdown": "", "checks": {"total": 0}, "files": {"count": 0, "items": []}}
    """
    return try! JSONDecoder().decode(GitHubPullDetail.self, from: Data(json.utf8))
}
