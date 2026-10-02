import SwiftUI

/// Agent detail "Reports to" row (org chart parity): the direct manager, tappable,
/// plus the chain above them. Hidden for a top-level agent or an older server.
struct AgentReportsToRow: View {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var p
    let agentId: String

    @State private var line: ReportsToDto?

    var body: some View {
        // A stack, not a Group: an empty Group renders nothing, so `.task` would never
        // fire and the row could never load itself.
        VStack(spacing: 0) {
            if let line, let managerId = line.reportsToAgentId {
                NavigationLink(value: WorkspaceRoute.agent(managerId)) {
                    LCard {
                        HStack(spacing: LSpace.s) {
                            Image(systemName: "person.2.wave.2")
                                .font(.system(size: 12, weight: .semibold))
                                .foregroundStyle(p.text2)
                                .accessibilityHidden(true)
                            VStack(alignment: .leading, spacing: 2) {
                                Text("Reports to \(line.reportsToAlias ?? "a manager")")
                                    .ltype(.bodyEmph)
                                    .foregroundStyle(p.text)
                                if let chain = chainText(line) {
                                    Text(chain)
                                        .ltype(.meta)
                                        .foregroundStyle(p.muted)
                                        .lineLimit(2)
                                }
                            }
                            Spacer(minLength: 0)
                            Image(systemName: "chevron.right")
                                .font(.system(size: 11, weight: .semibold))
                                .foregroundStyle(p.faint)
                                .accessibilityHidden(true)
                        }
                        .frame(minHeight: 32)
                    }
                }
                .buttonStyle(.plain)
                .accessibilityHint("Opens \(line.reportsToAlias ?? "the manager")")
            }
        }
        .task(id: agentId) {
            guard let base = model.selectedContainer?.baseUrl else { return }
            line = try? await model.api.reportsTo(base, agentId)
        }
    }

    /// "atlas › lead › owner" — the chain from the direct manager upward, when it is
    /// longer than the manager alone.
    private func chainText(_ line: ReportsToDto) -> String? {
        let names = line.chain.compactMap(\.alias)
        guard names.count > 1 else { return nil }
        return "Chain: " + names.joined(separator: " › ")
    }
}
