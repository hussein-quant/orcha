package io.openorcha.mobile.domain

import io.openorcha.mobile.data.AgentBudgetDto
import io.openorcha.mobile.data.BudgetUsage
import io.openorcha.mobile.data.TurnDto
import java.time.Instant
import java.time.OffsetDateTime
import java.time.YearMonth
import java.time.ZoneOffset
import java.time.format.TextStyle
import java.util.Locale
import kotlin.math.roundToInt
import kotlin.math.roundToLong

/** Pure helpers for the agent slice (budgets, chat "Worked for", live changes). Unit-tested. */
object AgentInsights {

    // ---------------- time ----------------

    fun parseInstant(iso: String?): Instant? {
        if (iso.isNullOrBlank()) return null
        return runCatching { OffsetDateTime.parse(iso).toInstant() }.getOrNull()
            ?: runCatching { Instant.parse(if (iso.endsWith("Z")) iso else iso + "Z") }.getOrNull()
    }

    /**
     * "Worked for 47 sec" / "Worked for 3 min" / "Worked for 1 h 5 min" — null for gaps under
     * a second or over two hours (a reply that late isn't an honest work span). iOS
     * `ConversationView.workedForLabel` parity.
     */
    fun workedForLabel(secs: Double): String? {
        if (secs < 1 || secs >= 7200) return null
        val s = secs.roundToInt()
        if (s < 60) return "Worked for $s sec"
        val m = s / 60
        return if (m < 60) "Worked for $m min" else "Worked for ${m / 60} h ${m % 60} min"
    }

    /**
     * seq → "Worked for …" for each agent reply: the time since the human turn it answers
     * (iOS `withDayDividers`). Only the FIRST agent reply after a human turn gets one.
     */
    fun workedFor(turns: List<TurnDto>, humanId: String?): Map<Int, String> {
        val out = HashMap<Int, String>()
        var latestHuman: Instant? = null
        for (turn in turns) {
            val mine = turn.role == "human" || (humanId != null && turn.authorAgentId == humanId)
            if (mine) {
                latestHuman = parseInstant(turn.createdAt)
                continue
            }
            if (turn.role == "system") continue // system notes never carry a footer
            val start = latestHuman
            if (start != null) {
                val end = parseInstant(turn.createdAt)
                if (end != null) {
                    workedForLabel((end.toEpochMilli() - start.toEpochMilli()) / 1000.0)?.let { out[turn.seq] = it }
                }
            }
            latestHuman = null
        }
        return out
    }

    /** Live "Working · 12s" elapsed label. */
    fun elapsedLabel(secs: Long): String = when {
        secs < 60 -> "${secs.coerceAtLeast(0)}s"
        secs < 3600 -> "${secs / 60}m ${secs % 60}s"
        else -> "${secs / 3600}h ${(secs % 3600) / 60}m"
    }

    // ---------------- budgets (web budgetModel.ts parity) ----------------

    fun fmtUsd(v: Double?): String {
        val cents = ((v ?: 0.0) * 100).roundToLong()
        val whole = cents / 100
        val frac = (cents % 100).toString().padStart(2, '0')
        return "$" + String.format(Locale.US, "%,d", whole) + "." + frac
    }

    fun fmtTok(v: Long?): String {
        val n = (v ?: 0).toDouble()
        fun compact(x: Double, big: Boolean): String =
            if (big) x.roundToLong().toString() else String.format(Locale.US, "%.1f", x).removeSuffix(".0")
        return when {
            n >= 1_000_000 -> compact(n / 1_000_000, n >= 10_000_000) + "M"
            n >= 1_000 -> compact(n / 1_000, n >= 10_000) + "k"
            else -> n.roundToLong().toString()
        }
    }

    fun pctLabel(ratio: Double?): String = when {
        ratio == null -> ""
        ratio >= 9.99 -> ">999%"
        else -> "${(ratio * 100).roundToInt()}%"
    }

    /** Bar fill 0..1 (an overspend reads as a full bar). */
    fun meterFraction(ratio: Double?): Float = when {
        ratio == null -> 0f
        ratio.isNaN() || ratio.isInfinite() -> 1f
        else -> ratio.coerceIn(0.0, 1.0).toFloat()
    }

    enum class Tone { Ok, Warn, Over }

    fun meterTone(ratio: Double?): Tone = when {
        ratio == null -> Tone.Ok
        ratio >= 1 -> Tone.Over
        ratio >= 0.8 -> Tone.Warn
        else -> Tone.Ok
    }

    /** Nothing metered but runs happened: the dollar figure is unknown, never $0. */
    fun spendUnknown(u: BudgetUsage): Boolean = u.meteredRuns == 0 && u.unmeteredRuns > 0

    /** "Nov 1" — the UTC day the budget month resets. */
    fun fmtReset(iso: String?): String {
        val d = parseInstant(iso)?.atOffset(ZoneOffset.UTC) ?: return "next month"
        return d.month.getDisplayName(TextStyle.SHORT, Locale.US) + " " + d.dayOfMonth
    }

    /** "October 2026" from the 'YYYY-MM' period key. */
    fun fmtPeriod(period: String?): String {
        val ym = runCatching { YearMonth.parse(period ?: "") }.getOrNull() ?: return period.orEmpty()
        return ym.month.getDisplayName(TextStyle.FULL, Locale.US) + " " + ym.year
    }

    /** Verdict chip copy from the real state, never a default "On track". */
    fun healthLabel(b: AgentBudgetDto): String? = when (b.state) {
        "ok" -> "Within budget"
        "warning" -> "Near limit"
        "exceeded" -> if (b.paused) "Paused" else "Over · override"
        else -> null
    }

    fun pausedTitle(b: AgentBudgetDto): String =
        if (b.blockedBy == "project") "Paused for new runs — project budget reached" else "Paused for new runs"

    /** Only the agent's own budget can be overridden here; the project cap lives on the web. */
    fun canGrantOverride(b: AgentBudgetDto, memberRole: String?): Boolean =
        b.paused && b.blockedBy == "agent" && !b.override.active && memberRole?.lowercase() != "viewer"

    // ---------------- live changes ----------------

    private val imageExtensions = setOf("png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "heic", "heif")

    /** Image files the app can decode and preview (BitmapFactory formats; no SVG). */
    fun isPreviewableImage(path: String?): Boolean {
        val ext = path?.substringAfterLast('/')?.substringAfterLast('.', "")?.lowercase() ?: return false
        return ext in imageExtensions
    }

    fun changeStatusLabel(status: String): String = when (status) {
        "A", "??" -> "Added"
        "D" -> "Deleted"
        "R" -> "Renamed"
        else -> "Modified"
    }

    fun changeReasonCopy(reason: String?, detail: String?): String = when (reason) {
        null -> detail ?: "Changes aren't available for this run."
        "no_checkout", "missing_worktree", "worktree_missing" -> "The run's checkout isn't on this machine any more."
        else -> detail ?: "Changes aren't available for this run."
    }
}
