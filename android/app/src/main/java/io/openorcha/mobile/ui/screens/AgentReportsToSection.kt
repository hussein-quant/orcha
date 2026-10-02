package io.openorcha.mobile.ui.screens

/** Agent detail "Reports to" (org chart): the direct manager plus the chain of command. */

import androidx.compose.foundation.layout.size
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import io.openorcha.mobile.data.ChainMemberDto
import io.openorcha.mobile.data.ReportsToDto
import io.openorcha.mobile.data.getReportsTo
import io.openorcha.mobile.ui.AgentSliceStore
import io.openorcha.mobile.ui.components.LAvatar
import io.openorcha.mobile.ui.components.LCard
import io.openorcha.mobile.ui.components.LDivider
import io.openorcha.mobile.ui.components.LRow
import io.openorcha.mobile.ui.components.LSection
import io.openorcha.mobile.ui.components.LSpace
import io.openorcha.mobile.ui.components.LType
import io.openorcha.mobile.ui.components.ltype
import io.openorcha.mobile.ui.icons.OrchaIcons
import io.openorcha.mobile.ui.theme.Orcha

/**
 * GET /api/agents/{aid}/reports-to. The nearest manager is the first row; higher managers
 * follow, each tappable (retired managers are listed but not navigable). Nobody above →
 * a single muted "Reports to nobody" row (web org page copy). Hidden on load failure.
 */
@Composable
internal fun AgentReportsToSection(baseUrl: String, agentId: String, onOpenAgent: ((String) -> Unit)?) {
    val p = Orcha.palette
    var data by remember(agentId) { mutableStateOf<ReportsToDto?>(null) }
    LaunchedEffect(baseUrl, agentId) {
        data = runCatching { AgentSliceStore.api.getReportsTo(baseUrl, agentId) }.getOrNull()
    }
    val d = data ?: return
    LSection("Reports to") {
        LCard(padding = 0.dp) {
            if (d.chain.isEmpty()) {
                LRow(title = "Nobody", subtitle = "Top of the org chart — no manager set")
            } else {
                d.chain.forEachIndexed { i, m ->
                    if (i > 0) LDivider(inset = LSpace.m)
                    ChainRow(m, depth = i, onOpenAgent = onOpenAgent)
                }
            }
        }
    }
}

@Composable
private fun ChainRow(m: ChainMemberDto, depth: Int, onOpenAgent: ((String) -> Unit)?) {
    val p = Orcha.palette
    val kind = if (m.kind == "human") "Human" else "AI agent"
    val where = if (depth == 0) "Direct manager" else "Manager · $depth level${if (depth == 1) "" else "s"} up"
    val subtitle = listOfNotNull(where, kind, if (m.terminated) "Retired" else null).joinToString(" · ")
    val canOpen = onOpenAgent != null && !m.terminated
    LRow(
        title = m.alias.ifBlank { "Unknown" },
        subtitle = subtitle,
        onClick = if (canOpen) ({ onOpenAgent?.invoke(m.id) }) else null,
        leading = { LAvatar(m.alias, isAI = m.kind != "human", size = 24.dp) },
        trailing = if (canOpen) {
            { Icon(OrchaIcons.ChevronRight, contentDescription = null, tint = p.faint, modifier = Modifier.size(16.dp)) }
        } else null,
    )
}
