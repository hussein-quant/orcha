package io.openorcha.mobile.ui

import io.openorcha.mobile.data.AgentBudgetDto
import io.openorcha.mobile.data.OrchaApiClient
import io.openorcha.mobile.data.getContainerBudgets
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update

/**
 * Agent slice state that lives outside [OrchaUiState]: the self-loading agent sections
 * (budget, reporting line, live changes, live reply) read through one shared client —
 * bearer auth is global ([io.openorcha.mobile.data.BearerTokens]), so it authorises the
 * same way the view-model's client does.
 */
internal object AgentSliceStore {
    val api: OrchaApiClient by lazy { OrchaApiClient() }

    private val _budgets = MutableStateFlow<Map<String, AgentBudgetDto>>(emptyMap())

    /** Last-known budget status per agent id (agent ids are globally unique UUIDs). */
    val budgets: StateFlow<Map<String, AgentBudgetDto>> = _budgets

    fun put(agentId: String, budget: AgentBudgetDto) {
        _budgets.update { it + (agentId to budget) }
    }

    /** Best-effort refresh of every agent's budget in a project (Agents tab chips). */
    suspend fun refreshContainer(baseUrl: String, containerId: String) {
        val rows = runCatching { api.getContainerBudgets(baseUrl, containerId).agents }.getOrNull() ?: return
        _budgets.update { cur -> cur + rows.mapNotNull { r -> r.agentId?.let { it to r } } }
    }
}
