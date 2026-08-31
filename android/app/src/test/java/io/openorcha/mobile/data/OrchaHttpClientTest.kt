package io.openorcha.mobile.data

import io.ktor.client.plugins.ResponseException
import io.ktor.client.request.get
import kotlinx.coroutines.runBlocking
import java.net.ServerSocket
import kotlin.concurrent.thread
import kotlin.test.Test
import kotlin.test.assertTrue

/**
 * Regression guard for the shared Ktor client's `expectSuccess` contract: several
 * call sites (device-token auth's [isAuthRequired], `GitHubHubActions`'
 * `statusOfGithubError`) catch `ResponseException` to read a failed response's
 * status code, which only happens if the client is configured to throw on a
 * non-2xx response -- Ktor 3.x's client-level default for this does NOT do that,
 * so `expectSuccess = true` in [createOrchaHttpClient] is load-bearing, not
 * redundant. Exercised against a real socket (not a fake engine) so a config
 * regression that silently disables this is caught here, not by a request that
 * quietly starts decoding an error page as a DTO instead of throwing.
 */
class OrchaHttpClientTest {
    @Test
    fun aNon2xxResponseThrowsResponseException() {
        val server = ServerSocket(0)
        val serverThread = thread {
            val socket = server.accept()
            socket.getInputStream().bufferedReader().readLine() // consume the request line, ignore rest
            socket.getOutputStream().write(
                "HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".toByteArray(),
            )
            socket.close()
        }
        try {
            val port = server.localPort
            val client = createOrchaHttpClient()
            var caught: ResponseException? = null
            runBlocking {
                try {
                    client.get("http://127.0.0.1:$port/api/containers")
                } catch (e: ResponseException) {
                    caught = e
                }
            }
            assertTrue(caught != null, "expected a ResponseException on a 401 response")
            assertTrue(isAuthRequired(caught), "isAuthRequired must recognize the thrown 401")
        } finally {
            serverThread.join(2_000)
            server.close()
        }
    }
}
