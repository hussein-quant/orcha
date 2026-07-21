package io.openorcha.mobile.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.ChevronRight
import androidx.compose.material.icons.rounded.ExpandMore
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import io.openorcha.mobile.domain.DiffFile
import io.openorcha.mobile.domain.DiffLine
import io.openorcha.mobile.domain.DiffParser
import io.openorcha.mobile.ui.theme.MonoStyle
import io.openorcha.mobile.ui.theme.Orcha

// A real unified-diff viewer (GitHub-app anatomy) — the Compose twin of the iOS
// DiffViewer: changes summary, one collapsible section per file, hunk headers,
// dual line-number gutters with the darker add/del shade, full-width row tints,
// and per-file horizontal scrolling with the gutters riding along. Token colors
// only, so every theme just works.

private const val COLLAPSE_OVER_LINES = 800
private const val MAX_ROW_CHARS = 400

@Composable
fun DiffViewer(diff: String, modifier: Modifier = Modifier) {
    val p = Orcha.palette
    val files = remember(diff) { DiffParser.parse(diff) }

    if (files.isEmpty()) {
        OrchaCard(modifier) { Text("No net change (empty diff).", color = p.muted) }
        return
    }
    val totalAdds = files.sumOf { it.adds }
    val totalDels = files.sumOf { it.dels }

    Column(modifier, verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Text(
                "${files.size} file${if (files.size == 1) "" else "s"} changed",
                color = p.text,
                fontWeight = FontWeight.W700,
            )
            if (totalAdds > 0) Text("+$totalAdds", style = MonoStyle.copy(fontWeight = FontWeight.W700), color = p.ok)
            if (totalDels > 0) Text("−$totalDels", style = MonoStyle.copy(fontWeight = FontWeight.W700), color = p.danger)
        }
        files.forEach { file -> DiffFileSection(file) }
    }
}

@Composable
private fun DiffFileSection(file: DiffFile) {
    val p = Orcha.palette
    val lineCount = remember(file) { file.hunks.sumOf { it.lines.size } }
    var expanded by remember(file) { mutableStateOf(lineCount <= COLLAPSE_OVER_LINES) }
    val shape = RoundedCornerShape(12.dp)

    Column(
        Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(p.surface)
            .border(1.dp, p.border, shape),
    ) {
        Row(
            Modifier
                .fillMaxWidth()
                .background(p.surface2)
                .clickable { expanded = !expanded }
                .padding(horizontal = 12.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Icon(
                if (expanded) Icons.Rounded.ExpandMore else Icons.Rounded.ChevronRight,
                contentDescription = if (expanded) "Collapse" else "Expand",
                tint = p.faint,
                modifier = Modifier.width(16.dp),
            )
            Text(
                file.path,
                style = MonoStyle.copy(fontWeight = FontWeight.W600),
                color = p.text,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            if (file.adds > 0) Text("+${file.adds}", style = MonoStyle.copy(fontWeight = FontWeight.W700), color = p.ok)
            if (file.dels > 0) Text("−${file.dels}", style = MonoStyle.copy(fontWeight = FontWeight.W700), color = p.danger)
        }
        when {
            expanded && file.isBinary ->
                Text("Binary file — no textual diff.", color = p.muted, modifier = Modifier.padding(12.dp))
            expanded -> DiffFileBody(file)
            !file.isBinary ->
                Text(
                    "$lineCount lines — tap to expand",
                    color = p.faint,
                    style = MonoStyle,
                    modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
                )
        }
    }
}

/// One horizontal scroller carries gutters + code so they stay aligned; every
/// row is padded to the widest (capped) line so the add/del tints span the full
/// scrollable width.
@Composable
private fun DiffFileBody(file: DiffFile) {
    val p = Orcha.palette
    val measurer = rememberTextMeasurer()
    val density = LocalDensity.current
    val codeWidth: Dp = remember(file) {
        val maxChars = file.hunks.flatMap { it.lines }.fold(60) { acc, l -> maxOf(acc, l.text.length + 2) }
        val capped = minOf(maxChars, MAX_ROW_CHARS)
        val charPx = measurer.measure(AnnotatedString("M"), style = MonoStyle).size.width
        with(density) { (charPx * capped).toDp() + 16.dp }
    }
    val gutterWidth = 40.dp

    Column(Modifier.horizontalScroll(rememberScrollState())) {
        file.hunks.forEach { hunk ->
            Text(
                hunk.header,
                style = MonoStyle,
                color = p.info,
                maxLines = 1,
                modifier = Modifier
                    .width(gutterWidth * 2 + codeWidth)
                    .background(p.infoSoft)
                    .padding(horizontal = 10.dp, vertical = 5.dp),
            )
            hunk.lines.forEach { line ->
                DiffLineRow(line, codeWidth, gutterWidth)
            }
        }
    }
}

@Composable
private fun DiffLineRow(line: DiffLine, codeWidth: Dp, gutterWidth: Dp) {
    val p = Orcha.palette
    val rowBg = when (line.kind) {
        DiffLine.Kind.Add -> p.okSoft
        DiffLine.Kind.Del -> p.dangerSoft
        else -> androidx.compose.ui.graphics.Color.Transparent
    }
    // The gutter carries a stronger shade of the row tint (GitHub's darker
    // number column) — the *Line tokens already encode that heavier alpha.
    val gutterBg = when (line.kind) {
        DiffLine.Kind.Add -> p.okLine
        DiffLine.Kind.Del -> p.dangerLine
        else -> p.surface2.copy(alpha = 0.6f)
    }
    val marker = when (line.kind) {
        DiffLine.Kind.Add -> "+"
        DiffLine.Kind.Del -> "−"
        DiffLine.Kind.Context -> " "
        DiffLine.Kind.Meta -> ""
    }
    val markerColor = when (line.kind) {
        DiffLine.Kind.Add -> p.ok
        DiffLine.Kind.Del -> p.danger
        else -> p.faint
    }

    Row {
        Gutter(line.oldNo, gutterWidth, gutterBg)
        Gutter(line.newNo, gutterWidth, gutterBg)
        Row(
            Modifier
                .width(codeWidth)
                .background(rowBg)
                .padding(horizontal = 8.dp, vertical = 1.5.dp),
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Text(marker, style = MonoStyle.copy(fontWeight = FontWeight.W700), color = markerColor, maxLines = 1)
            Text(
                line.text.ifEmpty { " " },
                style = MonoStyle,
                color = if (line.kind == DiffLine.Kind.Meta) p.faint else p.text,
                maxLines = 1,
                softWrap = false,
            )
        }
    }
}

@Composable
private fun Gutter(number: Int?, width: Dp, bg: androidx.compose.ui.graphics.Color) {
    val p = Orcha.palette
    Box(Modifier.width(width).background(bg).padding(end = 6.dp, top = 1.5.dp, bottom = 1.5.dp)) {
        Text(
            number?.toString() ?: "",
            style = MonoStyle.copy(fontSize = MonoStyle.fontSize * 0.85),
            color = p.faint,
            maxLines = 1,
            modifier = Modifier.align(Alignment.CenterEnd),
        )
    }
}
