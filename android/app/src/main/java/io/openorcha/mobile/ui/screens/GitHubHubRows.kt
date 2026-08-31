package io.openorcha.mobile.ui.screens

/** GitHub hub list rows — compact PR/issue cards (Android parity of iOS
 *  `GitHubPullRowCard` / `GitHubIssueRowCard` in GitHubHubScreen.swift). Each card
 *  navigates to its detail on tap; the Start affordance opens the agent picker or
 *  starts unassigned directly. */

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.RemoveRedEye
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.openorcha.mobile.data.GitHubIssueRow
import io.openorcha.mobile.data.GitHubPullRow
import io.openorcha.mobile.domain.MobileUx
import io.openorcha.mobile.ui.components.Avatar
import io.openorcha.mobile.ui.components.AvatarSize
import io.openorcha.mobile.ui.components.ChecksChip
import io.openorcha.mobile.ui.components.GitHubLabelChip
import io.openorcha.mobile.ui.components.MergeStateChip
import io.openorcha.mobile.ui.components.MetaTag
import io.openorcha.mobile.ui.components.OrchaCard
import io.openorcha.mobile.ui.components.TonalButton
import io.openorcha.mobile.ui.theme.Orcha

/** Compact PR row: type icon + #number + title, head branch, reviewers, checks + merge
 *  chips, relative time, and a Start affordance. */
@Composable
fun GitHubPullRowCard(pull: GitHubPullRow, onClick: () -> Unit, onStart: () -> Unit) {
    val p = Orcha.palette
    OrchaCard(onClick = onClick) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("#${pull.number}", style = numberStyle, color = p.faint)
            if (pull.draft) MetaTag("draft")
            Spacer(Modifier.weight(1f))
            GitHubStartRowButton(onStart)
        }
        Text(
            pull.title, style = MaterialTheme.typography.titleSmall.copy(fontWeight = FontWeight.W600, fontSize = 15.sp),
            color = p.text, maxLines = 2, overflow = TextOverflow.Ellipsis,
        )
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            if (pull.head.isNotEmpty()) {
                Text(
                    pull.head, style = MaterialTheme.typography.labelSmall.copy(fontFamily = FontFamily.Monospace, fontSize = 10.5.sp),
                    color = p.text2, maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
            }
            Spacer(Modifier.weight(1f))
            ChecksChip(pull.checks)
            MergeStateChip(pull.mergeableState)
        }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            if (pull.requestedReviewers.isNotEmpty()) {
                Icon(Icons.Rounded.RemoveRedEye, contentDescription = null, tint = p.muted, modifier = Modifier.size(12.dp))
                Text(
                    pull.requestedReviewers.joinToString(", "), style = MaterialTheme.typography.labelMedium, color = p.muted,
                    maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
            }
            Spacer(Modifier.weight(1f))
            Text(
                MobileUx.agoLabel(pull.updatedAt)?.let { "updated $it" } ?: "",
                style = MaterialTheme.typography.labelMedium, color = p.faint,
            )
        }
    }
}

/** Compact issue row: type icon + #number + title, labels, assignee, relative time, and
 *  the same Start affordance. */
@Composable
fun GitHubIssueRowCard(issue: GitHubIssueRow, onClick: () -> Unit, onStart: () -> Unit) {
    val p = Orcha.palette
    OrchaCard(onClick = onClick) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("#${issue.number}", style = numberStyle, color = p.faint)
            Spacer(Modifier.weight(1f))
            GitHubStartRowButton(onStart)
        }
        Text(
            issue.title, style = MaterialTheme.typography.titleSmall.copy(fontWeight = FontWeight.W600, fontSize = 15.sp),
            color = p.text, maxLines = 2, overflow = TextOverflow.Ellipsis,
        )
        if (issue.labels.isNotEmpty()) {
            val scroll = rememberScrollState()
            Row(Modifier.horizontalScroll(scroll), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                issue.labels.forEach { GitHubLabelChip(it) }
            }
        }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            val assignee = issue.assignee
            if (assignee != null) {
                Avatar(assignee, human = true, size = AvatarSize.Sm)
                Text(assignee, style = MaterialTheme.typography.labelMedium, color = p.text2)
            } else {
                Text("unassigned", style = MaterialTheme.typography.labelMedium, color = p.faint)
            }
            Spacer(Modifier.weight(1f))
            Text(
                MobileUx.agoLabel(issue.updatedAt)?.let { "updated $it" } ?: "",
                style = MaterialTheme.typography.labelMedium, color = p.faint,
            )
        }
    }
}

private val numberStyle = androidx.compose.ui.text.TextStyle(
    fontFamily = FontFamily.Monospace, fontWeight = FontWeight.W700, fontSize = 12.sp,
)

/** The per-row Start control — a single tap starts an unassigned task (the picker sheet
 *  handles agent assignment from the caller). */
@Composable
private fun GitHubStartRowButton(onStart: () -> Unit) {
    TonalButton("Start", onStart, small = true)
}
