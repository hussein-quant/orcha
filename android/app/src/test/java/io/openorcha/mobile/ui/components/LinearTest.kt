package io.openorcha.mobile.ui.components

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import io.openorcha.mobile.ui.theme.OrchaLinearDarkPalette
import io.openorcha.mobile.ui.theme.OrchaLinearLightPalette
import io.openorcha.mobile.ui.theme.OrchaSwissDarkPalette
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/** Pure-logic coverage for the Linear kit (`Linear.kt`) — mirrors iOS `LinearTests`. */
class LinearTest {

    @Test
    fun priorityBucketsMatchTheWeb() {
        assertEquals("No priority", priorityLabel(null))
        assertEquals("Urgent", priorityLabel(0))
        assertEquals("Urgent", priorityLabel(5))
        assertEquals("High", priorityLabel(6))
        assertEquals("High", priorityLabel(20))
        assertEquals("Normal", priorityLabel(21))
        assertEquals("Normal", priorityLabel(100))
        assertEquals("Low", priorityLabel(101))
        assertEquals(4, lPriorityLevel(1))
        assertEquals(0, lPriorityLevel(null))
    }

    @Test
    fun priorityBarsLitByLevel() {
        assertEquals(1, levelBars(1))
        assertEquals(2, levelBars(2))
        assertEquals(3, levelBars(3))
    }

    @Test
    fun statusKindsCoverTheContractStatuses() {
        assertEquals(LStatusKind.Backlog, lStatusKind("pending"))
        assertEquals(LStatusKind.Backlog, lStatusKind("backlog"))
        assertEquals(LStatusKind.Todo, lStatusKind("ready"))
        assertEquals(LStatusKind.Todo, lStatusKind("todo"))
        assertEquals(LStatusKind.Progress, lStatusKind("in_progress"))
        assertEquals(LStatusKind.Progress, lStatusKind("IN_PROGRESS"))
        assertEquals(LStatusKind.Blocked, lStatusKind("blocked"))
        assertEquals(LStatusKind.Review, lStatusKind("needs_verification"))
        assertEquals(LStatusKind.Done, lStatusKind("completed"))
        assertEquals(LStatusKind.Cancelled, lStatusKind("cancelled"))
        assertEquals(LStatusKind.Failed, lStatusKind("failed"))
        assertEquals(LStatusKind.Todo, lStatusKind("something_new"))
        assertEquals("Needs verification", lStatusLabel("needs_verification"))
        assertEquals("In progress", lStatusLabel("in_progress"))
    }

    @Test
    fun requestStatusesMapOntoGlyphs() {
        assertEquals(LStatusKind.Todo, lStatusKind(requestGlyphStatus("open")))
        assertEquals(LStatusKind.Progress, lStatusKind(requestGlyphStatus("accepted")))
        assertEquals(LStatusKind.Review, lStatusKind(requestGlyphStatus("answered")))
        assertEquals(LStatusKind.Cancelled, lStatusKind(requestGlyphStatus("rejected")))
        assertEquals(LStatusKind.Done, lStatusKind(requestGlyphStatus("closed")))
        assertEquals(LStatusKind.Blocked, lStatusKind(requestGlyphStatus("escalated")))
    }

    @Test
    fun avatarHueIsDeterministicAndMatchesIosDjb2() {
        assertEquals(355f / 360f, lAvatarHue("alice"))
        assertEquals(355f / 360f, lAvatarHue("ALICE"))
        assertEquals(259f / 360f, lAvatarHue("Claude"))
        assertEquals(341f / 360f, lAvatarHue(""))
        for (n in listOf("a", "bob", "agent-42", "✦ unicode")) {
            val h = lAvatarHue(n)
            assertTrue(h in 0f..1f)
            assertEquals(h, lAvatarHue(n))
        }
    }

    @Test
    fun avatarInitialAndPresence() {
        assertEquals("A", avatarInitial("  alice"))
        assertEquals("?", avatarInitial("   "))
        assertEquals(null, presenceKind(null))
        assertEquals(null, presenceKind(""))
        assertEquals(0, presenceKind("working"))
        assertEquals(1, presenceKind("awaiting_request"))
        assertEquals(3, presenceKind("idle"))
        assertEquals(2, presenceKind("blocked"))
        assertEquals(3, presenceKind("terminated"))
    }

    @Test
    fun typeScaleMatchesTheContract() {
        fun check(t: LType, size: Float, weight: FontWeight) {
            val s = ltypeStyle(t)
            assertEquals(size.sp, s.fontSize, "$t size")
            assertEquals(weight, s.fontWeight, "$t weight")
        }
        check(LType.Display, 26f, FontWeight.SemiBold)
        check(LType.Title, 20f, FontWeight.SemiBold)
        check(LType.Headline, 16f, FontWeight.SemiBold)
        check(LType.Body, 15f, FontWeight.Normal)
        check(LType.BodyEmph, 15f, FontWeight.Medium)
        check(LType.Meta, 13f, FontWeight.Normal)
        check(LType.Mono, 12f, FontWeight.Normal)
        check(LType.Micro, 11f, FontWeight.Medium)
        assertEquals(FontFamily.Monospace, ltypeStyle(LType.Mono).fontFamily)
    }

    @Test
    fun primaryFillUsesTheIndigoFillOnLinearAndAccentElsewhere() {
        assertEquals(Color(0xFF5E6AD2), OrchaLinearDarkPalette.lPrimaryFill)
        assertEquals(Color.White, OrchaLinearDarkPalette.lPrimaryText)
        assertEquals(Color(0xFF5E6AD2), OrchaLinearLightPalette.lPrimaryFill)
        assertEquals(OrchaSwissDarkPalette.accent, OrchaSwissDarkPalette.lPrimaryFill)
        assertEquals(OrchaSwissDarkPalette.accentInk, OrchaSwissDarkPalette.lPrimaryText)
    }
}
