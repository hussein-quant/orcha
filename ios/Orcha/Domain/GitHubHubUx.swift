import Foundation

/// The GitHub hub's binding-state machine + pure selectors — kept out of the views
/// for testing, mirroring `RepoConnect`. A response (or its failure) maps straight
/// to what the list renders: loading → off / list / error.

/// Which segment the list is showing.
enum GitHubHubKind: String, CaseIterable, Equatable {
    case issues
    case pulls

    var title: String {
        switch self {
        case .issues: "Issues"
        case .pulls: "Pull requests"
        }
    }

    /// The `POST /start` `kind` value (contract: "issue" | "pull").
    var startKind: String {
        switch self {
        case .issues: "issue"
        case .pulls: "pull"
        }
    }
}

/// Open / Mine filter over a list. "Mine" = assigned to (issues) or review-requested
/// from (PRs) the signed-in GitHub login; with no known login it falls back to Open.
enum GitHubHubFilter: String, CaseIterable, Equatable {
    case open
    case mine

    var label: String {
        switch self {
        case .open: "Open"
        case .mine: "Mine"
        }
    }
}

/// The list's loading → available:false → loaded machine for issues.
enum GitHubIssuesPhase: Equatable {
    case idle
    case loading
    /// `available:false` (unbound / rate-limited / GitHub error) OR the endpoint
    /// 404'd on an older server — the friendly "connect a repo" off state.
    case unavailable(reason: String?, detail: String?)
    case loaded(repo: String?, issues: [GitHubIssueRow])
    /// The request itself failed (network / auth perimeter / non-2xx that isn't the
    /// hub's own 200-off contract).
    case failed(String)
}

/// The PR list's machine (same shape, distinct payload).
enum GitHubPullsPhase: Equatable {
    case idle
    case loading
    case unavailable(reason: String?, detail: String?)
    case loaded(repo: String?, pulls: [GitHubPullRow])
    case failed(String)
}

/// Detail machines (PR / issue), same graceful-off contract.
enum GitHubPullDetailPhase: Equatable {
    case loading
    case unavailable(reason: String?, detail: String?)
    case loaded(repo: String?, pull: GitHubPullDetail)
    case failed(String)
}

enum GitHubIssueDetailPhase: Equatable {
    case loading
    case unavailable(reason: String?, detail: String?)
    case loaded(repo: String?, issue: GitHubIssueDetail)
    case failed(String)
}

/// Pure selectors for the GitHub hub — response→phase mapping, Open/Mine filtering,
/// and the checks-chip summary. No SwiftUI here so it's all unit-testable.
enum GitHubHubUx {

    // MARK: response → phase

    static func phase(from response: GitHubIssuesResponse) -> GitHubIssuesPhase {
        response.available
            ? .loaded(repo: response.repo, issues: response.issues)
            : .unavailable(reason: response.reason, detail: response.detail)
    }

    static func phase(from response: GitHubPullsResponse) -> GitHubPullsPhase {
        response.available
            ? .loaded(repo: response.repo, pulls: response.pulls)
            : .unavailable(reason: response.reason, detail: response.detail)
    }

    static func phase(from response: GitHubPullDetailResponse) -> GitHubPullDetailPhase {
        if response.available, let pull = response.pull {
            return .loaded(repo: response.repo, pull: pull)
        }
        return .unavailable(reason: response.reason, detail: response.detail)
    }

    static func phase(from response: GitHubIssueDetailResponse) -> GitHubIssueDetailPhase {
        if response.available, let issue = response.issue {
            return .loaded(repo: response.repo, issue: issue)
        }
        return .unavailable(reason: response.reason, detail: response.detail)
    }

    // MARK: Open / Mine filtering

    /// Issues assigned to `login` (matched against the primary assignee). A blank
    /// login yields the full list — "Mine" can't be answered, so it shows everything.
    static func filterIssues(_ issues: [GitHubIssueRow], filter: GitHubHubFilter, login: String?) -> [GitHubIssueRow] {
        guard filter == .mine, let login = normalizedLogin(login) else { return issues }
        return issues.filter { normalizedLogin($0.assignee) == login }
    }

    /// PRs whose review is requested from `login`. Same blank-login fallback.
    static func filterPulls(_ pulls: [GitHubPullRow], filter: GitHubHubFilter, login: String?) -> [GitHubPullRow] {
        guard filter == .mine, let login = normalizedLogin(login) else { return pulls }
        return pulls.filter { pull in
            pull.requestedReviewers.contains { normalizedLogin($0) == login }
        }
    }

    private static func normalizedLogin(_ login: String?) -> String? {
        guard let value = login?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
              value.isEmpty == false else { return nil }
        return value
    }

    // MARK: checks chip summary

    /// The compact "n passed / m failing / k pending" summary a checks chip shows,
    /// plus the one-glance verdict color the chip tints itself with.
    struct ChecksSummary: Equatable {
        /// A short chip label, e.g. "3✓ 2✗ 2•" or "no checks".
        let label: String
        /// The dominant state: failing beats pending beats passed beats none.
        let verdict: Verdict
        /// Whether any checks exist at all (total > 0).
        let hasChecks: Bool

        enum Verdict: Equatable {
            case failing   // at least one failing → red
            case pending   // none failing, some pending → amber
            case passing   // all resolved, at least one passed → green
            case none      // no checks reported → neutral
        }
    }

    /// Roll the four counts up into a chip summary. The dominant verdict follows the
    /// portal: any failing → failing; else any pending → pending; else any passed →
    /// passing; else none. `total == 0` (older server or no CI) → the "no checks" pill.
    static func checksSummary(_ checks: GitHubChecks) -> ChecksSummary {
        guard checks.total > 0 else {
            return ChecksSummary(label: "no checks", verdict: .none, hasChecks: false)
        }
        var parts: [String] = []
        if checks.passed > 0 { parts.append("\(checks.passed)✓") }
        if checks.failing > 0 { parts.append("\(checks.failing)✗") }
        if checks.pending > 0 { parts.append("\(checks.pending)•") }
        let label = parts.isEmpty ? "\(checks.total) checks" : parts.joined(separator: " ")

        let verdict: ChecksSummary.Verdict =
            checks.failing > 0 ? .failing :
            checks.pending > 0 ? .pending :
            checks.passed > 0 ? .passing : .none
        return ChecksSummary(label: label, verdict: verdict, hasChecks: true)
    }

    /// Per-run status glyph for the detail checks list. Maps GitHub's status +
    /// conclusion onto one of the four verdict families.
    static func runVerdict(_ run: GitHubCheckRun) -> ChecksSummary.Verdict {
        guard run.status == "completed" else { return .pending }
        switch run.conclusion {
        case "success", "neutral", "skipped": return .passing
        case "failure", "timed_out", "action_required", "cancelled", "stale", "startup_failure": return .failing
        default: return .pending
        }
    }

    // MARK: mergeable-state chip copy

    /// Human copy for GitHub's raw `mergeable_state`. nil / unknown → no chip.
    static func mergeStateLabel(_ state: String?) -> String? {
        switch state {
        case "clean": "ready to merge"
        case "dirty": "conflicts"
        case "blocked": "blocked"
        case "behind": "behind base"
        case "unstable": "unstable"
        case "has_hooks": "checks running"
        case "draft": "draft"
        case "unknown", "", nil: nil
        default: state?.replacingOccurrences(of: "_", with: " ")
        }
    }

    /// A short human line for an `available:false` reason — the empty-state copy.
    static func unavailableCopy(reason: String?, detail: String?) -> String {
        switch reason {
        case "repo_not_connected":
            return "No GitHub repository is connected to this Orcha yet. Connect one from the Home tab to see its issues and pull requests here."
        case "rate_limited":
            return "GitHub is rate-limiting requests right now. This will clear on its own — try again in a few minutes."
        case "not_found":
            return "That item no longer exists on GitHub, or the repository binding changed."
        case "unreachable":
            return "Couldn't reach GitHub from this Orcha. Check the server's connection and try again."
        case "github_error":
            return detail ?? "GitHub returned an error. Try again shortly."
        default:
            return detail ?? "The GitHub surface isn't available for this Orcha right now."
        }
    }
}
