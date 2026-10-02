package io.openorcha.mobile.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.openorcha.mobile.domain.MobileUx
import io.openorcha.mobile.domain.RequestsView
import io.openorcha.mobile.ui.OrchaUiState
import io.openorcha.mobile.ui.components.Banner
import io.openorcha.mobile.ui.components.BannerKind
import io.openorcha.mobile.ui.components.LAvatar
import io.openorcha.mobile.ui.components.LButton
import io.openorcha.mobile.ui.components.LButtonKind
import io.openorcha.mobile.ui.components.LCard
import io.openorcha.mobile.ui.components.LRow
import io.openorcha.mobile.ui.components.LSection
import io.openorcha.mobile.ui.components.LSpace
import io.openorcha.mobile.ui.components.LStatusGlyph
import io.openorcha.mobile.ui.components.LTag
import io.openorcha.mobile.ui.components.LType
import io.openorcha.mobile.ui.components.LinkifiedText
import io.openorcha.mobile.ui.components.ltype
import io.openorcha.mobile.ui.icons.OrchaIcons

/* Request detail body (Linear, mirrors ios RequestDetailScreen.swift): requester → you +
   type tag, the question as the title, actions on one row (Respond primary, Close ghost;
   answered-to-you: Resolve first + "Turn into a task"), then the Activity timeline. */

@OptIn(ExperimentalLayoutApi::class)
/** Builds request identity, title/payload, answer, actions (one row), and the Activity timeline. */
internal fun androidx.compose.foundation.lazy.LazyListScope.RequestDetailContent(
    state: OrchaUiState,
    req: io.openorcha.mobile.data.RequestDto,
    agents: List<io.openorcha.mobile.data.AgentDto>,
    humanId: String?,
    palette: io.openorcha.mobile.ui.theme.OrchaPalette,
    fromAlias: String?,
    toAlias: String?,
    isRequester: Boolean,
    isTarget: Boolean,
    onSheet: (RequestSheet) -> Unit,
    onConfirmOwnerClose: () -> Unit,
    onAcceptTask: (String?) -> Unit,
    onOpenTask: (String) -> Unit,
) {
    val p = palette
    val escalated = RequestsView.isEscalatedOpen(req, agents)
    val fromHuman = isRequester || RequestsView.kindFor(agents, req.requesterId) == "human"
    val toHuman = isTarget || RequestsView.kindFor(agents, req.targetId) == "human"
    val knownTasks = state.snapshot?.tasks.orEmpty()
    val lines = req.payload.trim().lines()
    val title = lines.firstOrNull { it.isNotBlank() }?.trim() ?: req.payload
    val rest = lines.dropWhile { it.isBlank() }.drop(1).joinToString("\n").trim()

    // ── requester → you · type tag · status ──
    item(key = "req-head") {
        Column(verticalArrangement = Arrangement.spacedBy(LSpace.xs)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(LSpace.s)) {
                RequestAvatarPair(
                    from = fromAlias ?: "?", fromHuman = fromHuman,
                    to = if (req.targetId == null) "Human" else toAlias ?: "A", toHuman = toHuman, size = 24,
                )
                Text(
                    "${if (isRequester) "You" else fromAlias ?: "agent"} → ${if (isTarget) "you" else toAlias ?: "agent"}",
                    style = ltype(LType.Meta), color = p.text2, maxLines = 1, overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f, fill = false),
                )
                LTag(if (req.type == "task") "Task" else "Question")
                if (req.chainDepth > 0) LTag("↳ chain")
                Spacer(Modifier.weight(1f))
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    LStatusGlyph(requestGlyphStatus(req.status, escalated))
                    Text(
                        if (escalated) "To a human" else MobileUx.statusCopy(req.status).replaceFirstChar { it.uppercase() },
                        style = ltype(LType.Meta), color = p.text2, maxLines = 1,
                    )
                }
            }
            MobileUx.agoLabel(req.createdAt)?.let {
                Text("Opened $it", style = ltype(LType.Meta), color = p.faint)
            }
        }
    }
    // ── title + any body beyond the first line ──
    item(key = "req-title") {
        Column(verticalArrangement = Arrangement.spacedBy(LSpace.s)) {
            LinkifiedText(
                title, knownTasks, onOpenTask,
                modifier = Modifier.semantics { heading() },
                style = ltype(LType.Title), color = p.text,
            )
            if (rest.isNotBlank()) LinkifiedText(rest, knownTasks, onOpenTask, style = ltype(LType.Body), color = p.text2)
        }
    }
    req.taskLink?.taskId?.let { tid ->
        item(key = "req-spawned") {
            LRow(
                title = req.taskLink.title ?: tid,
                subtitle = "Spawned task",
                onClick = { onOpenTask(tid) },
                leading = { LStatusGlyph("ready") },
                trailing = { Icon(OrchaIcons.ChevronRight, null, tint = p.faint, modifier = Modifier.size(16.dp)) },
            )
        }
    }
    req.response?.let { answer ->
        item(key = "req-answer") {
            LSection("Answer") {
                LCard {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(LSpace.s)) {
                        LAvatar(toAlias ?: "?", isAI = !toHuman, size = 20.dp)
                        Text(if (isTarget) "You" else toAlias ?: "agent", style = ltype(LType.BodyEmph), color = p.text)
                        MobileUx.agoLabel(req.respondedAt)?.let { Text(it, style = ltype(LType.Meta), color = p.faint) }
                    }
                    LinkifiedText(answer, knownTasks, onOpenTask, style = ltype(LType.Body), color = p.text)
                }
            }
        }
    }
    req.rejectionReason?.let { reason ->
        item(key = "req-rejection") {
            LSection("Rejected") {
                LCard { LinkifiedText(reason, knownTasks, onOpenTask, style = ltype(LType.Body), color = p.text2) }
            }
        }
    }
    // ── actions: role-specific first, then the operator tier (flow 07a) — one row ──
    item(key = "req-actions") {
        val ops = RequestsView.operatorActions(req, humanId)
        val busy = state.actionInFlight
        val answeredMine = isRequester && req.status == "answered"
        Column(verticalArrangement = Arrangement.spacedBy(LSpace.s)) {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(LSpace.s), verticalArrangement = Arrangement.spacedBy(LSpace.s)) {
                if (req.status == "open" && isTarget && req.type == "info") {
                    LButton("Respond", { onSheet(RequestSheet.Respond) }, icon = OrchaIcons.Send, kind = LButtonKind.Primary, enabled = !busy)
                }
                if (req.status == "open" && isTarget && req.type == "task") {
                    LButton("Accept task", { onAcceptTask(null) }, icon = OrchaIcons.Check, kind = LButtonKind.Primary, enabled = !busy)
                    LButton("Reject…", { onSheet(RequestSheet.Reject) }, kind = LButtonKind.Secondary, enabled = !busy)
                }
                if (answeredMine) {
                    LButton("Resolve", { onConfirmOwnerClose() }, icon = OrchaIcons.Check, kind = LButtonKind.Primary, enabled = !busy)
                    LButton("Turn into a task", { onSheet(RequestSheet.Convert) }, icon = OrchaIcons.Checklist, kind = LButtonKind.Secondary, enabled = !busy)
                }
                if (ops.showNudge) {
                    LButton("Nudge", { onSheet(RequestSheet.Nudge) }, kind = LButtonKind.Secondary, enabled = !busy)
                }
                if (ops.showClose && !answeredMine) {
                    LButton(
                        "Close",
                        { if (ops.closeNeedsReason) onSheet(RequestSheet.CloseWithReason) else onConfirmOwnerClose() },
                        icon = OrchaIcons.Close,
                        kind = LButtonKind.Ghost,
                        enabled = !busy,
                    )
                }
            }
            if (ops.showOperatorNote) {
                Text(
                    "Acting as operator (${state.selectedContainer?.humanAlias ?: "you"}). Closing another agent's request needs a reason — it's sent to the owner.",
                    style = ltype(LType.Meta), color = p.muted,
                )
            }
        }
    }
    item(key = "req-activity") {
        LSection("Activity") {
            Column {
                TimelineDot("Created", req.createdAt, true)
                if (req.status in setOf("accepted", "answered", "closed", "converted_to_task") && req.type == "task") TimelineDot("Accepted", null, true)
                if (req.respondedAt != null || req.status in setOf("answered", "closed", "converted_to_task")) TimelineDot("Answered", req.respondedAt, true)
                if (req.closedAt != null || req.status in setOf("closed", "rejected", "converted_to_task")) {
                    TimelineDot(MobileUx.statusCopy(req.status).replaceFirstChar { it.uppercase() }, req.closedAt, true)
                }
            }
        }
    }
    state.error?.let { item { Banner(BannerKind.Danger, it) } }
}
