package io.openorcha.mobile.ui.screens

import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.openorcha.mobile.data.AgentDto
import io.openorcha.mobile.data.TaskDto
import io.openorcha.mobile.domain.MobileUx
import io.openorcha.mobile.ui.components.LAvatar
import io.openorcha.mobile.ui.components.LButton
import io.openorcha.mobile.ui.components.LButtonKind
import io.openorcha.mobile.ui.components.LDivider
import io.openorcha.mobile.ui.components.LEmptyState
import io.openorcha.mobile.ui.components.LPriorityGlyph
import io.openorcha.mobile.ui.components.LSearchField
import io.openorcha.mobile.ui.components.LSegmented
import io.openorcha.mobile.ui.components.LSize
import io.openorcha.mobile.ui.components.LSpace
import io.openorcha.mobile.ui.components.LStatusGlyph
import io.openorcha.mobile.ui.components.LTag
import io.openorcha.mobile.ui.components.LType
import io.openorcha.mobile.ui.components.ltype
import io.openorcha.mobile.ui.icons.OrchaIcons
import io.openorcha.mobile.ui.theme.Orcha

/* Tasks tab (flow 05 T1), Linear style — mirrors iOS TasksTabView: search + assignee
   lens, All / Active / Backlog / Done pills with counts, collapsible status groups
   (terminal groups start collapsed), and dense rows with priority bars, status glyph,
   title, mono short id + tags, assignee avatar and age. */

/** Web page size (issue 4): render cap + "Load more". */
private const val TASKS_PAGE = 30

/** The four top-level pills, mirroring the web Tasks page and iOS. */
internal enum class TaskScope(val label: String) {
    All("All"), Active("Active"), Backlog("Backlog"), Done("Done");

    companion object {
        fun of(status: String): TaskScope = when (status) {
            "pending", "not_ready", "backlog" -> Backlog
            "completed", "cancelled", "failed" -> Done
            else -> Active
        }
    }
}

/** Short, mono-friendly id like the web list ("a1b2c3"). */
internal val TaskDto.shortId: String get() = id.removePrefix("task-").take(6)

internal fun isPlanWaiting(task: TaskDto): Boolean =
    task.planMessage != null && task.planDecision == null && task.status == "in_progress"

/** An alias is AI unless the roster says it's a human. */
internal fun isAiAlias(alias: String, agents: List<AgentDto>): Boolean =
    agents.firstOrNull { it.alias == alias }?.kind != "human"

internal fun String.capitalizedFirst(): String = replaceFirstChar { it.uppercase() }

@Composable
internal fun TasksTab(tasks: List<TaskDto>, agents: List<AgentDto>, onOpenTask: (String) -> Unit) {
    val p = Orcha.palette
    var filter by rememberSaveable { mutableStateOf("All") }
    var scopeName by rememberSaveable { mutableStateOf(TaskScope.All.name) }
    val scope = TaskScope.valueOf(scopeName)
    var query by rememberSaveable { mutableStateOf("") }
    var collapsed by rememberSaveable { mutableStateOf(listOf("completed", "cancelled")) }
    var shown by rememberSaveable { mutableStateOf(TASKS_PAGE) }
    var lensOpen by rememberSaveable { mutableStateOf(false) }
    val aiAgents = agents.filter { it.kind == "ai" }
    LaunchedEffect(filter, query, scopeName) { shown = TASKS_PAGE }

    val lensScoped = when (filter) {
        "All" -> tasks
        "Needs me" -> MobileUx.needsMe(tasks)
        else -> tasks.filter { it.assignees.contains(filter) || it.ownerAlias == filter }
    }
    val lensed = if (query.isBlank()) lensScoped else lensScoped.filter {
        it.title.contains(query, ignoreCase = true) ||
            (it.description ?: "").contains(query, ignoreCase = true) ||
            it.id.contains(query, ignoreCase = true)
    }
    val counts = lensed.groupingBy { TaskScope.of(it.status) }.eachCount()
    val filtered = if (scope == TaskScope.All) lensed else lensed.filter { TaskScope.of(it.status) == scope }
    // issue 4: cap the flat status/priority-ordered list, then group that slice (web mechanism)
    val ordered = filtered.sortedWith(
        compareBy<TaskDto> { MobileUx.taskGroupRank(it.status) }
            .thenBy { it.priority ?: 100 }
            .thenByDescending { it.createdAt ?: "" },
    )
    val visible = ordered.take(shown)
    val groups = visible.groupBy { it.status }.toList().sortedBy { MobileUx.taskGroupRank(it.first) }
    val options = TaskScope.entries.map { s ->
        s to "${s.label} ${if (s == TaskScope.All) lensed.size else counts[s] ?: 0}"
    }

    LazyColumn(
        modifier = Modifier.fillMaxSize().background(p.bg),
        contentPadding = PaddingValues(vertical = LSpace.s),
    ) {
        item(key = "search") {
            Row(
                Modifier.fillMaxWidth().padding(horizontal = LSpace.l, vertical = LSpace.xs),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(LSpace.xs),
            ) {
                LSearchField(query, { query = it }, placeholder = "Search tasks", modifier = Modifier.weight(1f))
                Box {
                    IconButton(onClick = { lensOpen = true }) {
                        Icon(
                            OrchaIcons.Checklist,
                            contentDescription = "Filter by assignee: ${if (filter == "All") "Everyone" else filter}",
                            tint = if (filter == "All") p.muted else p.accent,
                        )
                    }
                    DropdownMenu(expanded = lensOpen, onDismissRequest = { lensOpen = false }, containerColor = p.raised) {
                        val lensOptions = listOf("All" to "Everyone", "Needs me" to "Needs me · ${MobileUx.needsMe(tasks).size}") +
                            aiAgents.map { it.alias to it.alias }
                        lensOptions.forEach { (value, label) ->
                            DropdownMenuItem(
                                text = { Text(label, style = ltype(LType.Body), color = if (value == filter) p.accent else p.text) },
                                onClick = { filter = value; lensOpen = false },
                            )
                        }
                    }
                }
            }
        }
        item(key = "pills") {
            LSegmented(
                options = options,
                selection = scope,
                onSelect = { scopeName = it.name },
                modifier = Modifier.padding(horizontal = LSpace.l, vertical = LSpace.xs),
            )
        }
        if (filter != "All") {
            item(key = "lens") {
                Row(
                    Modifier.fillMaxWidth().padding(horizontal = LSpace.l),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        if (filter == "Needs me") "Showing tasks that need you" else "Showing $filter's tasks",
                        style = ltype(LType.Meta), color = p.text2, modifier = Modifier.weight(1f),
                    )
                    LButton("Clear", { filter = "All" }, kind = LButtonKind.Ghost, size = LSize.Small)
                }
            }
        }
        groups.forEach { (status, rows) ->
            val isCollapsed = status in collapsed
            item(key = "h-$status") {
                TaskGroupHeader(status, rows.size, isCollapsed) {
                    collapsed = if (isCollapsed) collapsed - status else collapsed + status
                }
            }
            if (!isCollapsed) {
                items(rows, key = { it.id }) { task ->
                    Column(Modifier.animateItem()) {
                        TaskRow(task, onOpenTask, agents)
                        LDivider(Modifier.padding(start = 56.dp, end = LSpace.l))
                    }
                }
            }
        }
        if (ordered.size > visible.size) {
            item(key = "tasks-load-more") {
                Text(
                    "Load more · ${visible.size} of ${ordered.size}",
                    style = ltype(LType.BodyEmph),
                    color = p.accent,
                    modifier = Modifier
                        .fillMaxWidth()
                        .clickable { shown += TASKS_PAGE }
                        .heightIn(min = 48.dp)
                        .padding(vertical = 14.dp),
                    textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                )
            }
        }
        if (filtered.isEmpty()) {
            item(key = "empty") {
                LEmptyState(
                    icon = OrchaIcons.Checklist,
                    title = if (query.isBlank()) "No tasks here" else "No matches",
                    message = if (query.isBlank()) "Nothing in this view yet. Create a task with the plus button to get an agent moving."
                    else "Nothing matches “$query”.",
                    modifier = Modifier.padding(LSpace.l),
                )
            }
        }
        item { Spacer(Modifier.height(72.dp)) }
    }
}

/** Muted caption group header: chevron, status glyph, label, count. Tapping collapses. */
@Composable
private fun TaskGroupHeader(status: String, count: Int, collapsed: Boolean, onToggle: () -> Unit) {
    val p = Orcha.palette
    val rotation by animateFloatAsState(if (collapsed) 0f else 90f, label = "chevron")
    val label = MobileUx.statusCopy(status).capitalizedFirst()
    Row(
        Modifier
            .fillMaxWidth()
            .background(p.bg)
            .clickable(onClick = onToggle)
            .heightIn(min = 48.dp)
            .padding(horizontal = LSpace.l)
            .padding(top = LSpace.m)
            .semantics(mergeDescendants = true) {
                heading()
                contentDescription = "$label, $count tasks"
                stateDescription = if (collapsed) "Collapsed" else "Expanded"
            },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(LSpace.s),
    ) {
        Icon(OrchaIcons.ChevronRight, null, tint = p.faint, modifier = Modifier.size(14.dp).rotate(rotation))
        LStatusGlyph(status, size = 13.dp)
        Text(label, style = ltype(LType.Meta), color = p.text2)
        Text("$count", style = ltype(LType.Meta), color = p.faint)
    }
}

/** Linear list row: priority · status glyph · title / id + tags … avatar · age. */
@Composable
fun TaskRow(task: TaskDto, onOpenTask: (String) -> Unit, agents: List<AgentDto> = emptyList()) {
    val p = Orcha.palette
    val assignee = task.assignees.firstOrNull() ?: task.ownerAlias
    val ago = MobileUx.agoLabel(task.startedAt ?: task.createdAt)
    val a11y = buildList {
        add(task.title); add(MobileUx.statusCopy(task.status))
        add("priority ${io.openorcha.mobile.ui.components.priorityLabel(task.priority)}")
        if (isPlanWaiting(task)) add("plan waiting")
        add(assignee?.let { "assigned to $it" } ?: "unassigned")
        ago?.let { add("updated $it") }
    }.joinToString(", ")
    Row(
        Modifier
            .fillMaxWidth()
            .clickable { onOpenTask(task.id) }
            .heightIn(min = 52.dp)
            .padding(horizontal = LSpace.l, vertical = 10.dp)
            .animateContentSize()
            .semantics(mergeDescendants = true) { contentDescription = a11y },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        LPriorityGlyph(task.priority, size = 14.dp)
        LStatusGlyph(task.status, size = 15.dp)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text(task.title, style = ltype(LType.Body), color = p.text, maxLines = 2, overflow = TextOverflow.Ellipsis)
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(task.shortId, style = ltype(LType.Mono), color = p.faint, maxLines = 1)
                if (isPlanWaiting(task)) LTag("Plan waiting", tint = p.violet, dot = true)
                if (task.status == "needs_verification") LTag("Review", tint = p.ok, dot = true)
                if (task.dependsOn.isNotEmpty()) LTag("Waits on ${task.dependsOn.size}", tint = p.warn)
                if (task.isRoot) LTag("Root")
            }
        }
        Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(4.dp)) {
            if (assignee != null) {
                LAvatar(assignee, isAI = isAiAlias(assignee, agents), size = 20.dp)
            } else {
                Box(Modifier.width(20.dp))
            }
            Text(ago?.removeSuffix(" ago") ?: "", style = ltype(LType.Micro), color = p.faint, maxLines = 1)
        }
    }
}
