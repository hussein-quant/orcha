import Foundation

/// Task-detail parity — the view-owned load/act surface on AppModel (the `AppModel+*`
/// per-feature extension pattern). Reads return their value to the calling view, which
/// owns the state (evidence, Verdikt, goal chain, manager pre-review); a failed read is
/// shown in place, never the app-wide banner. Writes follow the shared human-action
/// contract: `actionInFlight`, `error`, and a success `toast`.
extension AppModel {

    /// The selected project's base URL and id (nil when no project is open).
    private var taskSliceTarget: (base: String, cid: String)? {
        selectedContainer.map { ($0.baseUrl, $0.id) }
    }

    // MARK: reads

    func fetchEvidence(_ taskId: String) async throws -> EvidencePackDto? {
        guard let t = taskSliceTarget else { return nil }
        return try await api.taskEvidence(t.base, taskId)
    }

    func fetchVerdiktRuns(_ taskId: String) async throws -> VerdiktRunsResponse? {
        guard let t = taskSliceTarget else { return nil }
        return try await api.verdiktRuns(t.base, taskId)
    }

    func fetchGoalChain(_ taskId: String) async throws -> GoalChainDto? {
        guard let t = taskSliceTarget else { return nil }
        return try await api.goalChain(t.base, taskId)
    }

    /// The AI manager's pre-review for one task (nil when none / older server).
    func fetchManagerReview(_ task: TaskDto) async -> ManagerReviewDto? {
        guard let t = taskSliceTarget else { return nil }
        let rows = try? await api.taskReviewExtras(t.base, t.cid, status: task.status)
        return rows?.first { $0.id == task.id }?.managerReview
    }

    func previewTaskRoutine(cron: String, timezone: String) async -> TaskRoutinePreviewDto? {
        guard let t = taskSliceTarget else { return nil }
        return try? await api.previewTaskRoutineSchedule(t.base, t.cid, cron: cron, timezone: timezone)
    }

    /// Absolute URL for a portal-relative link (Verdikt report / "Open in Verdikt").
    func portalURL(_ path: String) -> URL? {
        if path.hasPrefix("http") { return URL(string: path) }
        guard let base = selectedContainer?.baseUrl else { return nil }
        return URL(string: base + path)
    }

    // MARK: writes

    /// Run the shared human-action contract for this slice's writes.
    private func taskSliceAction<T>(
        _ success: (T) -> String,
        _ block: (String, String, String) async throws -> T
    ) async -> T? {
        guard let sel = selectedContainer else { return nil }
        guard let actor = sel.humanAgentId else {
            error = "Pairing is missing the human identity. Reconnect this Quorate first."
            return nil
        }
        actionInFlight = true
        error = nil
        defer { actionInFlight = false }
        do {
            let value = try await block(sel.baseUrl, sel.id, actor)
            toast = success(value)
            return value
        } catch {
            self.error = friendly(error)
            return nil
        }
    }

    /// Reassign: releases the current assignee and wakes the new one.
    func reassignTask(_ taskId: String, to agentId: String) async -> Bool {
        let result = await taskSliceAction({ (r: AssignResultDto) in
            "Reassigned to \(r.alias ?? "the agent")"
        }) { base, _, actor in
            let r = try await api.assignTaskToAgent(base, taskId, actor: actor, agentId: agentId)
            await refresh()
            return r
        }
        return result != nil
    }

    /// "Make recurring…" — the task itself is never changed.
    func makeTaskRecurring(_ draft: TaskRoutineDraft) async -> Bool {
        let result = await taskSliceAction({ (r: TaskRoutineCreatedDto) in
            "Routine created — \(r.scheduleText ?? "on schedule"). The task is unchanged."
        }) { base, cid, actor in
            try await api.createRoutineFromTask(base, cid, actor: actor, draft: draft)
        }
        return result != nil
    }

    /// Hand the task's definition of done to Verdikt now (manual trigger).
    func runVerdikt(_ taskId: String) async -> VerdiktRunDto? {
        await taskSliceAction({ (_: VerdiktRunDto) in "Sent to Verdikt" }) { base, _, actor in
            try await api.triggerVerdikt(base, taskId, actor: actor)
        }
    }
}
