package io.openorcha.mobile.ui.screens

import io.openorcha.mobile.ui.theme.SkinMode
import io.openorcha.mobile.ui.theme.ThemeMode
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** Linear redesign helpers for Settings, the GitHub hub off-state and pairing. */
class SettingsGitHubPairingLinearTest {

    @Test
    fun executionSummaryShowsPausedOrAutonomyLabel() {
        assertEquals("Paused", executionSummary(false, "full"))
        assertEquals("Plan-only", executionSummary(true, null))
        assertEquals("Plan-only", executionSummary(null, "plan"))
        assertEquals("Build to PR", executionSummary(true, "pr"))
        assertEquals("Full", executionSummary(true, "full"))
    }

    @Test
    fun themeOptionsCallAutoSystem() {
        assertEquals(listOf("System", "Light", "Dark"), THEME_OPTIONS.map { it.second })
        assertEquals(ThemeMode.Auto, THEME_OPTIONS.first().first)
    }

    @Test
    fun skinOptionsPutLinearFirst() {
        assertEquals(SkinMode.Classic, SKIN_OPTIONS.first().first)
        assertEquals("Linear", SKIN_OPTIONS.first().second)
        assertEquals(SkinMode.entries.size, SKIN_OPTIONS.size)
    }

    @Test
    fun missingGitHubAppGetsFriendlyCopyWithoutJargon() {
        val (title, message) = githubUnavailableCopy("no_token", "No GitHub installation token is wired")
        assertEquals("GitHub isn't connected on this server", title)
        assertEquals("An admin can install the Quorate GitHub App from the portal under Settings › GitHub.", message)
        assertFalse(message.contains("token", ignoreCase = true))
        assertFalse(message.contains("wired", ignoreCase = true))
        // Unknown reason but a jargon detail is still the missing-app case.
        assertTrue(isGitHubAppMissing(null, "installation token missing"))
    }

    @Test
    fun otherUnavailableReasonsKeepTheirMeaning() {
        assertFalse(isGitHubAppMissing("repo_not_connected", null))
        assertEquals("No repository connected", githubUnavailableCopy("repo_not_connected", null).first)
        assertTrue(githubUnavailableCopy("rate_limited", null).second.contains("rate-limiting"))
        assertFalse(githubUnavailableCopy("unreachable", null).second.contains("Orcha"))
    }

    @Test
    fun pairingStepperHasThreeSteps() {
        assertEquals(listOf("Address", "Sign in", "Connected"), PairingStep.entries.map { it.title })
        assertEquals("Your agents, approvals and reviews — in your pocket.", PAIRING_TAGLINE)
    }
}
