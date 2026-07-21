import Foundation
import FoundationModels

/// Decision Assist — on-device compression of what the human has to read
/// before deciding, on the iOS 26 FoundationModels stack (Apple Intelligence's
/// local LLM). Two hard rules, both product ethos:
///   1. It compresses and structures; it NEVER recommends approve/reject —
///      the human decides (the workspace's "never self-certify" rule applies
///      to this model too).
///   2. Fully on-device: no cloud, silently absent when Apple Intelligence
///      is off — the full original text is always the primary surface.
@available(iOS 26, *)
enum DecisionAssist {

    /// Structured read of a proposed plan — guided generation, so the model
    /// fills a schema instead of free-writing prose. The schema is shaped for
    /// the approval decision: who does what concretely, and what gates what.
    @Generable
    struct PlanBrief: Equatable {
        @Guide(description: "One sentence, max 24 words: who proposes what, and the plan's overall shape — e.g. \"Atlas proposes a 5-step gated pipeline: design spec approval first, then build, test, deploy\".")
        var tldr: String
        @Guide(description: "The plan's steps in order, at most 6.")
        var steps: [Step]
        @Guide(description: "Approval/ordering dependencies the plan states — who or what must sign off before which step proceeds, e.g. \"Nothing builds until the human approves the design spec\". Empty if none.")
        var gates: [String]
        @Guide(description: "Destructive or irreversible actions only (production deploys, migrations, deletions, force-pushes). Empty if none.")
        var risks: [String]

        @Generable
        struct Step: Equatable {
            @Guide(description: "The agent or person the plan assigns this step to, exactly as named (e.g. \"Muse\"). Empty string when the plan names nobody.")
            var owner: String
            @Guide(description: "What this step concretely does, 6–14 words using the plan's own specific nouns — NEVER a bare category label like \"Build\" or \"Tests\".")
            var what: String
        }
    }

    /// Structured read of a finished worker run's log.
    @Generable
    struct RunDigest: Equatable {
        @Guide(description: "What the worker actually did, as 2 to 4 short past-tense bullet phrases of at most 12 words.")
        var didPoints: [String]
        @Guide(description: "One short sentence on how the run ended (completed what, blocked on what, or failed how).")
        var outcome: String
    }

    static var isAvailable: Bool {
        if case .available = SystemLanguageModel.default.availability { return true }
        return false
    }

    // Small session-lifetime caches: re-opening the same sheet must not re-run
    // the model.
    @MainActor private static var planCache: [Int: PlanBrief] = [:]
    @MainActor private static var runCache: [Int: RunDigest] = [:]

    @MainActor
    static func planBrief(for text: String) async throws -> PlanBrief {
        let key = text.hashValue
        if let hit = planCache[key] { return hit }
        let session = LanguageModelSession(instructions: """
            You brief a human supervisor deciding whether to APPROVE this plan. \
            Write so they can reconstruct the plan's shape without reading it: \
            keep the plan's concrete nouns, name the acting agent for each step \
            when the plan names one, and surface what gates what — approval \
            dependencies are the most decision-relevant facts. Be faithful: \
            never invent steps, never advise whether to approve. The plan is \
            the AGENT'S OWN account: attribute assertions ("claims", "reports", \
            "proposes") — the human has verified nothing yet.
            """)
        let response = try await session.respond(
            to: "Summarize this plan:\n\n\(clip(text))",
            generating: PlanBrief.self
        )
        planCache[key] = response.content
        return response.content
    }

    @MainActor
    static func runDigest(for feed: [RunFeedRow]) async throws -> RunDigest {
        // The log is already classified — feed only the meaningful rows
        // (narration, decisions, errors, completion), which keeps a small
        // model on the rails far better than raw log text would.
        let meaningful = feed
            .filter { ["narrate", "decision", "error", "done"].contains($0.type) }
            .map { row in row.type == "narrate" ? row.text : "[\(row.type)] \(row.text)" }
            .joined(separator: "\n")
        let key = meaningful.hashValue
        if let hit = runCache[key] { return hit }
        let session = LanguageModelSession(instructions: """
            You digest an AI coding agent's work log for a human supervisor. \
            Report only what the log shows, past tense, no judgement, no advice.
            """)
        let response = try await session.respond(
            to: "Digest this worker run log:\n\n\(clip(meaningful))",
            generating: RunDigest.self
        )
        runCache[key] = response.content
        return response.content
    }

    /// Cap model input; when over budget keep the head and tail — openings
    /// state intent, endings state outcomes, the middle is usually detail.
    private static func clip(_ text: String, budget: Int = 6000) -> String {
        guard text.count > budget else { return text }
        let head = text.prefix(budget * 2 / 3)
        let tail = text.suffix(budget / 3)
        return head + "\n[…]\n" + tail
    }
}
