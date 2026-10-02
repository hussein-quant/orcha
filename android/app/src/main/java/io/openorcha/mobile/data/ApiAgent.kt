package io.openorcha.mobile.data

import io.ktor.client.call.body
import io.ktor.client.request.get
import io.ktor.client.request.put
import io.ktor.client.request.setBody
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.readRawBytes
import io.ktor.http.ContentType
import io.ktor.http.contentType
import io.ktor.http.encodeURLParameter
import kotlinx.coroutines.withTimeout

/*
 * Agent slice endpoints, as extensions on the shared client (same auth seam, base-URL
 * normalisation and tolerant JSON reader as every other Quorate call).
 */

suspend fun OrchaApiClient.getAgentBudget(baseUrl: String, agentId: String): AgentBudgetDto = withTimeout(8_000) {
    client.get("${baseUrl.endpoint()}/api/agents/$agentId/budget").body()
}

suspend fun OrchaApiClient.getContainerBudgets(baseUrl: String, containerId: String): ContainerBudgetsDto = withTimeout(8_000) {
    client.get("${baseUrl.endpoint()}/api/containers/$containerId/budgets").body()
}

/** Grant (or revoke) the one-time override that lifts the hard stop for the rest of the month. */
suspend fun OrchaApiClient.setBudgetOverride(
    baseUrl: String,
    agentId: String,
    actorId: String,
    grant: Boolean,
    note: String?,
): AgentBudgetDto = withTimeout(10_000) {
    val response: HttpResponse = client.put("${baseUrl.endpoint()}/api/agents/$agentId/budget") {
        contentType(ContentType.Application.Json)
        setBody(BudgetOverrideBody(actorId, if (grant) "grant" else "revoke", note?.trim()?.takeIf { it.isNotEmpty() }))
    }
    response.body()
}

suspend fun OrchaApiClient.getReportsTo(baseUrl: String, agentId: String): ReportsToDto = withTimeout(8_000) {
    client.get("${baseUrl.endpoint()}/api/agents/$agentId/reports-to").body()
}

suspend fun OrchaApiClient.getRunChanges(baseUrl: String, agentId: String, runId: String, since: String?): RunChangesDto =
    withTimeout(10_000) {
        val q = since?.let { "?since=${it.encodeURLParameter()}" }.orEmpty()
        client.get("${baseUrl.endpoint()}/api/agents/$agentId/runs/$runId/changes$q").body()
    }

suspend fun OrchaApiClient.getRunChangeDiff(baseUrl: String, agentId: String, runId: String, path: String): RunChangeDiffDto =
    withTimeout(10_000) {
        client.get("${baseUrl.endpoint()}/api/agents/$agentId/runs/$runId/changes/diff?path=${path.encodeURLParameter()}").body()
    }

/** Raw bytes of one side (`new` after the run, `old` before) of a changed file — image previews. */
suspend fun OrchaApiClient.getRunChangeRaw(
    baseUrl: String,
    agentId: String,
    runId: String,
    path: String,
    side: String = "new",
): ByteArray = withTimeout(15_000) {
    client.get("${baseUrl.endpoint()}/api/agents/$agentId/runs/$runId/changes/raw?path=${path.encodeURLParameter()}&side=$side")
        .readRawBytes()
}

/** The agent's recent runs, read for the chat's live reply (conversation lane fields kept). */
suspend fun OrchaApiClient.getChatRuns(baseUrl: String, agentId: String): ChatRunsResponse = withTimeout(8_000) {
    client.get("${baseUrl.endpoint()}/api/agents/$agentId/runs?limit=5").body()
}
