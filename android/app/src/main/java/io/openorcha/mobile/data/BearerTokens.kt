package io.openorcha.mobile.data

import java.net.URI
import java.util.concurrent.ConcurrentHashMap

/**
 * Device-token auth (cloud unification): the in-memory host -> bearer-token registry
 * consulted by the single Ktor request seam in [createOrchaHttpClient] so the
 * credential rides on every call -- reads, writes, and streams alike -- for any
 * container paired behind the auth perimeter. iOS parity: `AppModel`'s `BearerTokens`
 * referenced from `OrchaApiClient.swift`'s `makeRequest`.
 *
 * Keyed by host (not the full base URL) since a container's `baseUrl` and
 * `remoteBaseUrl` failover pair share one token. Populated from
 * [ContainerStore.load] on app start and kept in sync by every call that persists
 * a token via [ContainerStore.setAccessToken] or a fresh pairing/connect.
 */
object BearerTokens {
    private val tokens = ConcurrentHashMap<String, String>()

    /** Register (or clear, `token = null`/blank) the token this base URL's host uses. */
    fun set(baseUrl: String, token: String?) {
        val host = hostOf(baseUrl) ?: return
        val normalized = token?.trim()?.takeIf { it.isNotEmpty() }
        if (normalized == null) tokens.remove(host) else tokens[host] = normalized
    }

    /** The registered token for this base URL's host, if any. */
    fun token(baseUrl: String): String? = hostOf(baseUrl)?.let { tokens[it] }

    /** Re-seed from every stored container -- call once at startup. */
    fun seed(containers: List<StoredContainer>) {
        containers.forEach { c ->
            set(c.baseUrl, c.accessToken)
            c.remoteBaseUrl?.let { set(it, c.accessToken) }
        }
    }

    private fun hostOf(baseUrl: String): String? =
        runCatching { URI(baseUrl).host?.lowercase() }.getOrNull()
}
