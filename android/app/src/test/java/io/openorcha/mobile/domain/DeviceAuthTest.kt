package io.openorcha.mobile.domain

import java.net.URI
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The GitHub device-token callback URI contract. Mirrors iOS's `DeviceAuthTests.swift`.
 */
class DeviceAuthTest {

    @Test
    fun startUrlAppendsAuthDevicePath() {
        assertEquals(
            "https://orcha.example.com/auth/device",
            DeviceAuth.startUrl("https://orcha.example.com"),
        )
    }

    @Test
    fun startUrlTrimsTrailingSlash() {
        assertEquals(
            "https://orcha.example.com/auth/device",
            DeviceAuth.startUrl("https://orcha.example.com/"),
        )
    }

    @Test
    fun startUrlIsNullForBlankBase() {
        assertNull(DeviceAuth.startUrl(""))
        assertNull(DeviceAuth.startUrl("   "))
    }

    @Test
    fun isAuthCallbackTrueForOrchaAuthScheme() {
        assertTrue(DeviceAuth.isAuthCallback(URI("orcha://auth/callback?host=h&token=t")))
    }

    @Test
    fun isAuthCallbackFalseForOtherSchemeOrHost() {
        assertFalse(DeviceAuth.isAuthCallback(URI("https://auth/callback")))
        assertFalse(DeviceAuth.isAuthCallback(URI("orcha://needs/some-container-id")))
    }

    @Test
    fun parseCallbackReadsHostAndToken() {
        val callback = DeviceAuth.parseCallback("orcha://auth/callback?host=orcha.example.com&token=abc123")
        assertEquals(DeviceAuth.Callback("orcha.example.com", "abc123"), callback)
    }

    @Test
    fun parseCallbackDecodesPercentEncoding() {
        val callback = DeviceAuth.parseCallback("orcha://auth/callback?host=orcha.example.com&token=a%2Bb%2Fc")
        assertEquals("a+b/c", callback?.token)
    }

    @Test
    fun parseCallbackNullForWrongPath() {
        assertNull(DeviceAuth.parseCallback("orcha://auth/other?host=h&token=t"))
    }

    @Test
    fun parseCallbackNullForWrongScheme() {
        assertNull(DeviceAuth.parseCallback("https://auth/callback?host=h&token=t"))
    }

    @Test
    fun parseCallbackNullForMissingToken() {
        assertNull(DeviceAuth.parseCallback("orcha://auth/callback?host=h"))
    }

    @Test
    fun parseCallbackNullForMissingHost() {
        assertNull(DeviceAuth.parseCallback("orcha://auth/callback?token=t"))
    }

    @Test
    fun parseCallbackNullForEmptyValues() {
        assertNull(DeviceAuth.parseCallback("orcha://auth/callback?host=&token=t"))
        assertNull(DeviceAuth.parseCallback("orcha://auth/callback?host=h&token="))
    }

    @Test
    fun parseCallbackNullForMalformedUri() {
        assertNull(DeviceAuth.parseCallback("not a uri at all"))
    }

    @Test
    fun callbackMatchesBareHost() {
        val callback = DeviceAuth.Callback(host = "orcha.example.com", token = "t")
        assertTrue(DeviceAuth.callbackMatchesBase(callback, "https://orcha.example.com"))
    }

    @Test
    fun callbackMatchesHostPort() {
        val callback = DeviceAuth.Callback(host = "orcha.example.com:443", token = "t")
        assertTrue(DeviceAuth.callbackMatchesBase(callback, "https://orcha.example.com"))
    }

    @Test
    fun callbackMatchesFullUrlForm() {
        val callback = DeviceAuth.Callback(host = "https://orcha.example.com", token = "t")
        assertTrue(DeviceAuth.callbackMatchesBase(callback, "https://orcha.example.com"))
    }

    @Test
    fun callbackIsCaseInsensitive() {
        val callback = DeviceAuth.Callback(host = "ORCHA.Example.com", token = "t")
        assertTrue(DeviceAuth.callbackMatchesBase(callback, "https://orcha.example.com"))
    }

    @Test
    fun callbackDoesNotMatchDifferentHost() {
        val callback = DeviceAuth.Callback(host = "evil.example.com", token = "t")
        assertFalse(DeviceAuth.callbackMatchesBase(callback, "https://orcha.example.com"))
    }

    @Test
    fun callbackDoesNotMatchWhenBaseIsUnparseable() {
        val callback = DeviceAuth.Callback(host = "orcha.example.com", token = "t")
        assertFalse(DeviceAuth.callbackMatchesBase(callback, ""))
    }
}
