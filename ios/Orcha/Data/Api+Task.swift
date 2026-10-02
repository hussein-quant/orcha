import Foundation

/// Task-detail parity surface (web portal → Quorate iOS): proof-of-work evidence,
/// Verdikt runs, goal ancestry, the AI manager pre-review, "Make recurring…"
/// routines and reassign. Reads + the human writes the web shows to a person.
extension OrchaApiClient {

    // MARK: reads

    /// `GET /api/tasks/{tid}/evidence` — the evidence pack (DoD lines, tests, risk flags, changes).
    func taskEvidence(_ base: String, _ tid: String) async throws -> EvidencePackDto {
        try await get(base, "/api/tasks/\(tid)/evidence")
    }

    /// `GET /api/tasks/{tid}/verdikt/runs` — Verdikt settings + this task's run history.
    func verdiktRuns(_ base: String, _ tid: String) async throws -> VerdiktRunsResponse {
        try await get(base, "/api/tasks/\(tid)/verdikt/runs")
    }

    /// `GET /api/tasks/{tid}/goal-chain` — objective › parent(s) › this task.
    func goalChain(_ base: String, _ tid: String) async throws -> GoalChainDto {
        try await get(base, "/api/tasks/\(tid)/goal-chain")
    }

    /// The task-list rows for one status (`manager_review` rides these rows, not the
    /// shared `TaskDto`). Used to read the AI manager's pre-review for one task.
    func taskReviewExtras(_ base: String, _ cid: String, status: String) async throws -> [TaskReviewExtrasDto] {
        let response: TaskReviewExtrasPage = try await get(
            base,
            "/api/containers/\(cid)/tasks" + query(["status": status, "limit": "100"])
        )
        return response.tasks
    }

    /// `POST /api/containers/{cid}/routines/preview` — read-only schedule validation.
    func previewTaskRoutineSchedule(_ base: String, _ cid: String, cron: String, timezone: String) async throws -> TaskRoutinePreviewDto {
        try await postDecoding(base, "/api/containers/\(cid)/routines/preview", [
            "cron": cron, "timezone": timezone, "count": 3,
        ])
    }

    // MARK: writes (human actor)

    /// `POST /api/tasks/{tid}/verdikt/runs` — hand this task's definition of done to Verdikt.
    func triggerVerdikt(_ base: String, _ tid: String, actor: String) async throws -> VerdiktRunDto {
        try await postDecoding(base, "/api/tasks/\(tid)/verdikt/runs", ["actor_agent_id": actor])
    }

    /// `POST /api/tasks/{tid}/assign` with `reassign: true` — releases the prior assignee.
    func assignTaskToAgent(_ base: String, _ tid: String, actor: String, agentId: String) async throws -> AssignResultDto {
        try await postDecoding(base, "/api/tasks/\(tid)/assign", [
            "actor_agent_id": actor, "agent_id": agentId, "reassign": true,
        ])
    }

    /// `POST /api/containers/{cid}/routines` — a routine copied from a task (`origin_task_id`).
    func createRoutineFromTask(_ base: String, _ cid: String, actor: String, draft: TaskRoutineDraft) async throws -> TaskRoutineCreatedDto {
        try await postDecoding(base, "/api/containers/\(cid)/routines", [
            "actor_agent_id": actor,
            "title": draft.title,
            "description": draft.description,
            "definition_of_done": draft.definitionOfDone,
            "assignee_agent_id": draft.assigneeAgentId,
            "priority": draft.priority,
            "cron": draft.cron,
            "timezone": draft.timezone,
            "enabled": true,
            "skip_if_open": draft.skipIfOpen,
            "origin_task_id": draft.originTaskId,
        ])
    }
}

private struct TaskReviewExtrasPage: Decodable {
    var tasks: [TaskReviewExtrasDto] = []
}
