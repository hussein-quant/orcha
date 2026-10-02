import SwiftUI

/// Flow 09 A1 — Agents roster (Linear): "AI agents N" / "Humans N" muted captions over
/// roomy rows — round avatar, name, one meta line, status capsule on the right.
struct AgentsTabView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var p

    var body: some View {
        Group {
            if model.snapshot == nil {
                if model.loading { ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity) } else { UnreachableState() }
            } else {
                content
            }
        }
        .background(p.bg)
    }

    private var content: some View {
        let agents = model.snapshot?.agents ?? []
        let ai = MobileUx.orderAgents(agents.filter { $0.kind == "ai" })
        let humans = agents.filter { $0.kind == "human" }

        return ScrollView {
            LazyVStack(alignment: .leading, spacing: LSpace.xl) {
                ConnectionBanners()
                if !ai.isEmpty {
                    LSection("AI agents", count: ai.count) {
                        RosterList {
                            ForEach(ai) { agent in
                                NavigationLink(value: WorkspaceRoute.agent(agent.id)) {
                                    AgentRosterRow(agent: agent)
                                }
                                .buttonStyle(.plain)
                                if agent.id != ai.last?.id { LDivider().padding(.leading, 56) }
                            }
                        }
                    }
                }
                if !humans.isEmpty {
                    LSection("Humans", count: humans.count) {
                        RosterList {
                            ForEach(humans) { human in
                                HumanRosterRow(human: human)
                                if human.id != humans.last?.id { LDivider().padding(.leading, 56) }
                            }
                        }
                    }
                }
                if ai.isEmpty && humans.isEmpty {
                    LEmptyState(
                        icon: "person.2",
                        title: "No agents yet",
                        message: "Create agents from the portal's onboarding."
                    )
                }
            }
            .padding(.horizontal, LSpace.l)
            .padding(.vertical, LSpace.m)
        }
        .refreshable { await model.refresh() }
    }
}

/// A grouped panel holding roster rows — one hairline-bordered surface, rows divided.
private struct RosterList<Content: View>: View {
    @Environment(\.palette) private var p
    @ViewBuilder var content: Content

    var body: some View {
        VStack(spacing: 0) { content }
            .background(p.surface, in: RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(p.border, lineWidth: 1))
    }
}

/// AI agent row: avatar (✦ + presence), name, one meta line (current task with its
/// status glyph, or the role), status capsule.
private struct AgentRosterRow: View {
    @Environment(\.palette) private var p
    let agent: AgentDto

    private var dead: Bool { agent.status == "terminated" || agent.terminatedAt != nil }
    private var status: String { dead ? "retired" : (agent.status ?? "idle") }
    private var currentTitle: String? {
        agent.activeRun?.taskTitle ?? agent.currentTask?.title
    }

    var body: some View {
        HStack(spacing: LSpace.m) {
            LAvatar(name: agent.alias, isAI: true, size: 32, status: status)
            VStack(alignment: .leading, spacing: 2) {
                Text(agent.alias)
                    .ltype(.bodyEmph)
                    .foregroundStyle(p.text)
                    .lineLimit(1)
                metaLine
            }
            Spacer(minLength: LSpace.s)
            AgentStatusCapsule(status: status)
        }
        .padding(.horizontal, LSpace.m)
        .padding(.vertical, LSpace.m)
        .frame(minHeight: 60)
        .contentShape(Rectangle())
        .opacity(dead ? 0.55 : 1)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityText)
        .accessibilityAddTraits(.isButton)
    }

    @ViewBuilder
    private var metaLine: some View {
        if agent.status == "working", let title = currentTitle {
            HStack(spacing: 5) {
                LStatusGlyph(status: "in_progress", size: 11)
                Text(title)
                    .ltype(.meta)
                    .foregroundStyle(p.text2)
                    .lineLimit(1)
            }
        } else {
            Text([agent.role ?? "agent", MobileUx.agoLabel(agent.lastActive)].compactMap { $0 }.joined(separator: " · "))
                .ltype(.meta)
                .foregroundStyle(p.muted)
                .lineLimit(1)
        }
    }

    private var accessibilityText: String {
        var parts = [agent.alias, "AI agent", AgentStatusCapsule.label(for: status)]
        if agent.status == "working", let title = currentTitle { parts.append("working on \(title)") }
        else if let role = agent.role { parts.append(role) }
        return parts.joined(separator: ", ")
    }
}

/// Human member row — GitHub identity leads, role tag on the right.
private struct HumanRosterRow: View {
    @Environment(\.palette) private var p
    let human: AgentDto

    var body: some View {
        HStack(spacing: LSpace.m) {
            if human.githubLogin != nil {
                // Collab v1: GitHub members render their real avatar.
                AgentAvatar(alias: human.alias, human: true, githubLogin: human.githubLogin, size: 32)
            } else {
                LAvatar(name: human.alias, isAI: false, size: 32)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(human.githubLogin ?? human.alias)
                    .ltype(.bodyEmph)
                    .foregroundStyle(p.text)
                    .lineLimit(1)
                Text(subtitle)
                    .ltype(.meta)
                    .foregroundStyle(p.muted)
                    .lineLimit(1)
            }
            Spacer(minLength: LSpace.s)
            if let role = human.memberRole {
                LTag(role.capitalized, tint: role == "owner" ? p.violet : nil)
            }
        }
        .padding(.horizontal, LSpace.m)
        .padding(.vertical, LSpace.m)
        .frame(minHeight: 60)
        .accessibilityElement(children: .combine)
    }

    /// Collab v1 — a mapped member reads "alias · Human authority"; the GitHub
    /// login already leads the row, so the alias only repeats when it differs.
    private var subtitle: String {
        if let login = human.githubLogin, login != human.alias {
            return "\(human.alias) · Human authority"
        }
        return "Human authority"
    }
}

/// Compact agent status capsule ("Working", "Waiting", "Idle"…), tinted by state.
struct AgentStatusCapsule: View {
    @Environment(\.palette) private var p
    let status: String

    static func label(for status: String) -> String {
        switch status {
        case "working": "Working"
        case "waiting", "blocked", "awaiting_request": "Waiting"
        case "awaiting_human": "Needs you"
        case "idle": "Idle"
        case "offline": "Offline"
        case "retired", "terminated": "Retired"
        default: status.replacingOccurrences(of: "_", with: " ").capitalized
        }
    }

    private var tint: Color {
        switch status {
        case "working": p.accent
        case "waiting", "blocked": p.warn
        case "retired", "terminated", "offline": p.faint
        default: p.muted
        }
    }

    var body: some View {
        HStack(spacing: 5) {
            Circle().fill(tint).frame(width: 6, height: 6)
            Text(Self.label(for: status))
                .ltype(.micro)
                .foregroundStyle(status == "working" ? p.text : p.text2)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 3)
        .background(p.surface2, in: Capsule())
        .overlay(Capsule().strokeBorder(p.border, lineWidth: 1))
        .accessibilityHidden(true)
    }
}
