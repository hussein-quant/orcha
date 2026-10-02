import SwiftUI

enum AgentsRosterMode: Hashable {
    case roster, org
}

/// Agents tab "Org" view — the reporting lines as a simple indented tree (web `/org`
/// parity, read-only). One read of the snapshot's `reports_to` per appearance.
struct AgentsOrgView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var p
    let agents: [AgentDto]
    let budgets: [String: AgentBudgetDto]

    @State private var managerOf: [String: String] = [:]
    @State private var loaded = false

    private var nodes: [AgentOrgUx.Node] {
        let humans = agents.filter { $0.kind == "human" }.map(\.id)
        let ai = MobileUx.orderAgents(agents.filter { $0.kind == "ai" }).map(\.id)
        return AgentOrgUx.flatten(order: humans + ai, managerOf: managerOf)
    }

    var body: some View {
        let byId = Dictionary(agents.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        VStack(alignment: .leading, spacing: LSpace.s) {
            if loaded && managerOf.isEmpty {
                Text("No reporting lines yet — set who each agent reports to from the web portal's Org page.")
                    .ltype(.meta)
                    .foregroundStyle(p.muted)
                    .padding(.horizontal, 4)
            }
            VStack(spacing: 0) {
                ForEach(nodes) { node in
                    if let agent = byId[node.id] {
                        if node.id != nodes.first?.id { LDivider().padding(.leading, 56) }
                        row(agent, depth: node.depth)
                    }
                }
            }
            .background(p.surface, in: RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(p.border, lineWidth: 1))
        }
        .task(id: model.selectedContainer?.id) {
            guard let sel = model.selectedContainer,
                  let org = try? await model.api.orgLines(sel.baseUrl, sel.id) else { loaded = true; return }
            managerOf = Dictionary(org.agents.compactMap { r in r.reportsTo.map { (r.id, $0) } }, uniquingKeysWith: { a, _ in a })
            loaded = true
        }
    }

    @ViewBuilder
    private func row(_ agent: AgentDto, depth: Int) -> some View {
        let indent = CGFloat(min(depth, 4)) * 18
        if agent.kind == "ai" {
            NavigationLink(value: WorkspaceRoute.agent(agent.id)) {
                AgentRosterRow(agent: agent, budget: budgets[agent.id])
                    .padding(.leading, indent)
            }
            .buttonStyle(.plain)
            .accessibilityHint(depth > 0 ? "Reports to \(managerAlias(agent.id) ?? "a manager")" : "")
        } else {
            HStack(spacing: LSpace.m) {
                AgentAvatar(alias: agent.alias, human: true, githubLogin: agent.githubLogin, size: 32)
                VStack(alignment: .leading, spacing: 2) {
                    Text(agent.githubLogin ?? agent.alias).ltype(.bodyEmph).foregroundStyle(p.text).lineLimit(1)
                    Text(agent.memberRole?.capitalized ?? "Human authority").ltype(.meta).foregroundStyle(p.muted)
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, LSpace.m)
            .padding(.vertical, LSpace.m)
            .padding(.leading, indent)
            .frame(minHeight: 60)
            .accessibilityElement(children: .combine)
        }
    }

    private func managerAlias(_ id: String) -> String? {
        guard let m = managerOf[id] else { return nil }
        return agents.first { $0.id == m }?.alias
    }
}

/// "Paused · budget" — replaces the status capsule when the budget hard stop is on.
struct BudgetPausedCapsule: View {
    @Environment(\.palette) private var p

    var body: some View {
        HStack(spacing: 5) {
            Image(systemName: "pause.fill")
                .font(.system(size: 7, weight: .bold))
                .foregroundStyle(p.danger)
            Text("Paused · budget")
                .ltype(.micro)
                .foregroundStyle(p.text)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 3)
        .background(p.dangerSoft, in: Capsule())
        .overlay(Capsule().strokeBorder(p.dangerLine, lineWidth: 1))
        .accessibilityHidden(true)
    }
}
