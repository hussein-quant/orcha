package io.openorcha.mobile.ui.screens

/** Shared list chrome for the GitHub hub's Issues/Pulls segments: loading skeletons, the
 *  "connect a repo" off-state, the transport-failure retry panel, the empty-list card, and
 *  the Open/Mine filter pill. Split out of GitHubHubScreen.kt to keep that file lean. */

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.OpenInNew
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import io.openorcha.mobile.domain.GitHubHubUx
import io.openorcha.mobile.ui.OrchaUiState
import io.openorcha.mobile.ui.components.Banner
import io.openorcha.mobile.ui.components.BannerKind
import io.openorcha.mobile.ui.components.NeutralButton
import io.openorcha.mobile.ui.components.OrchaCard
import io.openorcha.mobile.ui.components.Skeleton
import io.openorcha.mobile.ui.components.StateLayout
import io.openorcha.mobile.ui.theme.Orcha

internal fun githubLoginOf(state: OrchaUiState): String? =
    state.snapshot?.agents?.firstOrNull { it.id == state.selectedContainer?.humanAgentId }?.githubLogin

@Composable
internal fun ListScroll(isEmpty: Boolean, emptyNoun: String, mine: Boolean, content: LazyListScope.() -> Unit) {
    val p = Orcha.palette
    LazyColumn(
        modifier = Modifier.fillMaxWidth(),
        contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        if (isEmpty) {
            item {
                OrchaCard {
                    Text(
                        if (mine) "Nothing here is assigned to you right now." else "No open $emptyNoun in this repository.",
                        color = p.muted,
                    )
                }
            }
        } else {
            content()
        }
    }
}

@Composable
internal fun GitHubLoadingList() {
    Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        repeat(4) { Skeleton(height = 92.dp) }
    }
}

@Composable
internal fun GitHubUnavailableState(reason: String?, detail: String?) {
    StateLayout(
        title = if (reason == "not_found") "Not on GitHub" else "GitHub isn't connected",
        sub = GitHubHubUx.unavailableCopy(reason, detail),
    )
}

@Composable
internal fun GitHubFailedState(message: String, onRetry: () -> Unit) {
    Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Banner(BannerKind.Danger, message)
        NeutralButton("Try again", onRetry)
    }
}

/** `.chip` filter pill (Open / Mine) — small toggle, accent when active. */
@Composable
internal fun GitHubFilterChip(label: String, on: Boolean, onClick: () -> Unit) {
    val p = Orcha.palette
    val fill = if (on) p.accentSoft else p.surface2
    val line = if (on) p.accentLine else p.border2
    Text(
        label,
        modifier = Modifier
            .background(fill, RoundedCornerShape(999.dp))
            .border(BorderStroke(1.dp, line), RoundedCornerShape(999.dp))
            .clickable(onClick = onClick)
            .padding(horizontal = 10.dp, vertical = 5.dp),
        style = MaterialTheme.typography.labelMedium,
        color = if (on) p.accent else p.muted,
    )
}

/** Shared "open on GitHub" row — launches the browser (iOS parity: a `Link` styled as a
 *  tonal action). Detail screens for both issues and PRs use this. */
@Composable
internal fun OpenOnGitHubLink(url: String) {
    val p = Orcha.palette
    val context = LocalContext.current
    Row(
        Modifier
            .fillMaxWidth()
            .background(p.surface2, RoundedCornerShape(12.dp))
            .border(BorderStroke(1.dp, p.border2), RoundedCornerShape(12.dp))
            .clickable { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) }
            .padding(horizontal = 14.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text("Open on GitHub", style = MaterialTheme.typography.bodyLarge.copy(fontWeight = FontWeight.W600), color = p.text)
        Spacer(Modifier.weight(1f))
        Icon(Icons.Rounded.OpenInNew, contentDescription = null, tint = p.text, modifier = Modifier.size(18.dp))
    }
}
