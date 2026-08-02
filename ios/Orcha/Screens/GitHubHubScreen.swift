import SwiftUI

/// The GitHub hub list — the phone parity of the portal's GitHub hub page. Segmented
/// Issues | Pull requests tabs, Open / Mine filters, compact rows (type icon, number,
/// title, labels/reviewers, checks summary, merge state, relative time), and a Start
/// affordance per row (tap → unassigned; long-press / menu → agent picker). Start
/// returns the created task, which the screen surfaces as a navigable link. The whole
/// surface degrades to a friendly "connect a repo" state on `available:false` / 404.
struct GitHubHubScreen: View {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var p

    @State private var kind: GitHubHubKind = .pulls
    @State private var filter: GitHubHubFilter = .open
    /// The row the agent-picker sheet is open for.
    @State private var startPickerItem: StartTarget?
    /// The task id a Start just produced — drives the push to its TaskDetailScreen.
    @State private var startedTaskId: String?

    var body: some View {
        Group {
            switch kind {
            case .pulls: pullsContent
            case .issues: issuesContent
            }
        }
        .navigationTitle("GitHub")
        .navigationBarTitleDisplayMode(.inline)
        .safeAreaInset(edge: .top, spacing: 0) { header }
        .sheet(item: $startPickerItem) { target in
            GitHubStartPickerSheet(
                kind: target.kind, number: target.number,
                title: target.title, bodyExcerpt: target.bodyExcerpt, htmlUrl: target.htmlUrl
            ) { response in
                startedTaskId = response.taskId
            }
        }
        .navigationDestination(item: $startedTaskId) { taskId in
            TaskDetailScreen(taskId: taskId)
        }
        .task(id: kind) { await load() }
    }

    // MARK: header (segment + filter)

    private var header: some View {
        VStack(spacing: 8) {
            Picker("Kind", selection: $kind) {
                ForEach(GitHubHubKind.allCases, id: \.self) { k in
                    Text(k.title).tag(k)
                }
            }
            .pickerStyle(.segmented)

            HStack(spacing: 8) {
                ForEach(GitHubHubFilter.allCases, id: \.self) { f in
                    FilterChip(label: f.label, on: filter == f) { filter = f }
                }
                Spacer()
                if let repo = boundRepo {
                    Text(repo)
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(p.faint)
                        .lineLimit(1)
                        .truncationMode(.head)
                }
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .background(.bar)
    }

    private var boundRepo: String? {
        switch kind {
        case .pulls:
            if case let .loaded(repo, _) = model.githubPullsPhase { return repo }
        case .issues:
            if case let .loaded(repo, _) = model.githubIssuesPhase { return repo }
        }
        return model.githubRepo
    }

    // MARK: pulls

    @ViewBuilder
    private var pullsContent: some View {
        switch model.githubPullsPhase {
        case .idle, .loading:
            loadingList
        case let .unavailable(reason, detail):
            unavailableState(reason: reason, detail: detail)
        case let .failed(message):
            failedState(message)
        case let .loaded(_, pulls):
            let visible = GitHubHubUx.filterPulls(pulls, filter: filter, login: model.githubLogin)
            listScroll(isEmpty: visible.isEmpty, emptyNoun: "pull requests") {
                ForEach(visible) { pull in
                    NavigationLink(value: WorkspaceRoute.githubPull(pull.number)) {
                        GitHubPullRowCard(
                            pull: pull,
                            onStartUnassigned: { startUnassigned(for: pull) },
                            onStartWithAgent: { startTarget(for: pull) }
                        )
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    // MARK: issues

    @ViewBuilder
    private var issuesContent: some View {
        switch model.githubIssuesPhase {
        case .idle, .loading:
            loadingList
        case let .unavailable(reason, detail):
            unavailableState(reason: reason, detail: detail)
        case let .failed(message):
            failedState(message)
        case let .loaded(_, issues):
            let visible = GitHubHubUx.filterIssues(issues, filter: filter, login: model.githubLogin)
            listScroll(isEmpty: visible.isEmpty, emptyNoun: "issues") {
                ForEach(visible) { issue in
                    NavigationLink(value: WorkspaceRoute.githubIssue(issue.number)) {
                        GitHubIssueRowCard(
                            issue: issue,
                            onStartUnassigned: { startUnassigned(for: issue) },
                            onStartWithAgent: { startTarget(for: issue) }
                        )
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    // MARK: shared list chrome

    private func listScroll<Rows: View>(
        isEmpty: Bool, emptyNoun: String, @ViewBuilder rows: () -> Rows
    ) -> some View {
        ScrollView {
            VStack(spacing: 10) {
                if isEmpty {
                    OrchaCard {
                        Text(filter == .mine
                             ? "Nothing here is assigned to you right now."
                             : "No open \(emptyNoun) in this repository.")
                            .foregroundStyle(p.muted)
                    }
                } else {
                    rows()
                }
            }
            .padding(16)
        }
        .refreshable { await load() }
    }

    private var loadingList: some View {
        ScrollView {
            VStack(spacing: 10) {
                ForEach(0..<4, id: \.self) { _ in SkeletonBlock(height: 92) }
            }
            .padding(16)
        }
    }

    // MARK: empty / error / unavailable states

    private func unavailableState(reason: String?, detail: String?) -> some View {
        ScrollView {
            StateLayout(
                title: "GitHub isn't connected",
                sub: GitHubHubUx.unavailableCopy(reason: reason, detail: detail)
            ) {
                GitHubMark()
                    .frame(width: 34, height: 34)
                    .foregroundStyle(p.muted)
            } actions: {
                EmptyView()
            }
            .padding(.top, 40)
        }
        .refreshable { await load() }
    }

    private func failedState(_ message: String) -> some View {
        ScrollView {
            VStack(spacing: 12) {
                Banner(kind: .danger, text: message)
                KitButton(title: "Try again", role: .neutral) {
                    Task { await load() }
                }
                .frame(maxWidth: 220)
            }
            .padding(16)
        }
        .refreshable { await load() }
    }

    // MARK: loading + start plumbing

    private func load() async {
        switch kind {
        case .pulls: await model.loadGithubPulls()
        case .issues: await model.loadGithubIssues()
        }
    }

    private func startTarget(for pull: GitHubPullRow) {
        startPickerItem = StartTarget(
            kind: .pulls, number: pull.number, title: pull.title,
            bodyExcerpt: nil, htmlUrl: pull.htmlUrl
        )
    }

    private func startTarget(for issue: GitHubIssueRow) {
        startPickerItem = StartTarget(
            kind: .issues, number: issue.number, title: issue.title,
            bodyExcerpt: issue.bodyExcerpt, htmlUrl: issue.htmlUrl
        )
    }

    /// Bare Start — POST straight through with no assignee, then push the resulting
    /// (or already-tracked) task. The picker path is `startTarget`.
    private func startUnassigned(for pull: GitHubPullRow) {
        Task {
            if let response = await model.startGithubItem(
                kind: .pulls, number: pull.number, title: pull.title,
                bodyExcerpt: nil, htmlUrl: pull.htmlUrl, assigneeAgentId: nil
            ) {
                startedTaskId = response.taskId
            }
        }
    }

    private func startUnassigned(for issue: GitHubIssueRow) {
        Task {
            if let response = await model.startGithubItem(
                kind: .issues, number: issue.number, title: issue.title,
                bodyExcerpt: issue.bodyExcerpt, htmlUrl: issue.htmlUrl, assigneeAgentId: nil
            ) {
                startedTaskId = response.taskId
            }
        }
    }
}

/// The row the Start picker is open for.
private struct StartTarget: Identifiable {
    let kind: GitHubHubKind
    let number: Int
    let title: String
    let bodyExcerpt: String?
    let htmlUrl: String?

    var id: String { "\(kind.startKind)#\(number)" }
}

// MARK: - rows

/// Compact PR row: type icon + #number + title, head branch, reviewers, checks +
/// merge chips, relative time, and a Start affordance (tap = unassigned; the menu
/// picks an agent). The card itself navigates to the PR detail.
struct GitHubPullRowCard: View {
    @Environment(\.palette) private var p
    let pull: GitHubPullRow
    /// Bare Start (unassigned) and the agent-picker path.
    let onStartUnassigned: () -> Void
    let onStartWithAgent: () -> Void

    var body: some View {
        OrchaCard {
            HStack(spacing: 8) {
                Image(systemName: pull.draft ? "arrow.triangle.pull" : "arrow.triangle.branch")
                    .font(p.uiFont(13))
                    .foregroundStyle(pull.draft ? p.muted : p.accent)
                Text("#\(pull.number)")
                    .font(.system(size: 12, weight: .bold, design: .monospaced))
                    .foregroundStyle(p.faint)
                if pull.draft { MetaTag(text: "draft") }
                Spacer()
                StartRowButton(onStartUnassigned: onStartUnassigned, onStartWithAgent: onStartWithAgent)
            }
            Text(pull.title)
                .font(p.uiFont(15, .semibold))
                .foregroundStyle(p.text)
                .lineLimit(2)
                .multilineTextAlignment(.leading)
            HStack(spacing: 6) {
                if !pull.head.isEmpty {
                    Label(pull.head, systemImage: "point.3.connected.trianglepath.dotted")
                        .labelStyle(.titleAndIcon)
                        .font(.system(size: 10.5, design: .monospaced))
                        .foregroundStyle(p.text2)
                        .lineLimit(1)
                }
                Spacer()
                ChecksChip(checks: pull.checks)
                MergeStateChip(mergeableState: pull.mergeableState)
            }
            HStack(spacing: 6) {
                if !pull.requestedReviewers.isEmpty {
                    Image(systemName: "eye")
                        .font(.system(size: 10))
                        .foregroundStyle(p.muted)
                    Text(pull.requestedReviewers.joined(separator: ", "))
                        .font(p.uiFont(11))
                        .foregroundStyle(p.muted)
                        .lineLimit(1)
                }
                Spacer()
                Text(MobileUx.agoLabel(pull.updatedAt).map { "updated \($0)" } ?? "")
                    .font(p.uiFont(11))
                    .foregroundStyle(p.faint)
            }
        }
    }
}

/// Compact issue row: type icon + #number + title, labels, assignee, relative time,
/// and the same Start affordance. Navigates to the issue detail.
struct GitHubIssueRowCard: View {
    @Environment(\.palette) private var p
    let issue: GitHubIssueRow
    let onStartUnassigned: () -> Void
    let onStartWithAgent: () -> Void

    var body: some View {
        OrchaCard {
            HStack(spacing: 8) {
                Image(systemName: "smallcircle.filled.circle")
                    .font(p.uiFont(13))
                    .foregroundStyle(p.ok)
                Text("#\(issue.number)")
                    .font(.system(size: 12, weight: .bold, design: .monospaced))
                    .foregroundStyle(p.faint)
                Spacer()
                StartRowButton(onStartUnassigned: onStartUnassigned, onStartWithAgent: onStartWithAgent)
            }
            Text(issue.title)
                .font(p.uiFont(15, .semibold))
                .foregroundStyle(p.text)
                .lineLimit(2)
                .multilineTextAlignment(.leading)
            if !issue.labels.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(issue.labels, id: \.self) { GitHubLabelChip(label: $0) }
                    }
                }
            }
            HStack(spacing: 6) {
                if let assignee = issue.assignee {
                    AgentAvatar(alias: assignee, human: true, githubLogin: assignee, size: 22)
                    Text(assignee)
                        .font(p.uiFont(11))
                        .foregroundStyle(p.text2)
                } else {
                    Text("unassigned")
                        .font(p.uiFont(11))
                        .foregroundStyle(p.faint)
                }
                Spacer()
                Text(MobileUx.agoLabel(issue.updatedAt).map { "updated \($0)" } ?? "")
                    .font(p.uiFont(11))
                    .foregroundStyle(p.faint)
            }
        }
    }
}

/// The per-row Start control: a bare tap starts unassigned; the menu (long-press or
/// the disclosure) offers the agent picker. Both live on one control so a row has a
/// single, discoverable Start affordance (the menu is the long-press equivalent).
private struct StartRowButton: View {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var p
    /// Bare Start — an unassigned task, one tap.
    let onStartUnassigned: () -> Void
    /// The agent picker.
    let onStartWithAgent: () -> Void

    var body: some View {
        Menu {
            Button("Start — unassigned", systemImage: "play.fill", action: onStartUnassigned)
            Button("Start with an agent…", systemImage: "person.badge.plus", action: onStartWithAgent)
        } label: {
            HStack(spacing: 4) {
                Image(systemName: "play.fill")
                    .font(.system(size: 10, weight: .bold))
                Text("Start")
                    .font(p.uiFont(12, .bold))
            }
            .foregroundStyle(p.accent)
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .background(p.accentSoft, in: Capsule())
            .overlay(Capsule().strokeBorder(p.accentLine, lineWidth: 1))
        } primaryAction: {
            onStartUnassigned()
        }
        .disabled(model.actionInFlight)
        .accessibilityLabel("Start")
        .accessibilityHint("Starts an unassigned task; press and hold to pick an agent")
    }
}
