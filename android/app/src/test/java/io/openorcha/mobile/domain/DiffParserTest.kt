package io.openorcha.mobile.domain

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * The Kotlin twin of the iOS DiffParserTests — same fixtures, same contract:
 * files/hunks/line-number reconstruction, count-driven hunk consumption (so
 * content starting with "+++" can't be mistaken for a file header), and the
 * empty/binary edges.
 */
class DiffParserTest {
    private val twoFiles = """
        diff --git a/src/app.py b/src/app.py
        index 3f9c2e1..b7a41d9 100644
        --- a/src/app.py
        +++ b/src/app.py
        @@ -12,3 +12,4 @@ def charge(amount):
             if amount <= 0:
        -        return None
        +        raise InvalidAmount(amount)
        +    log.info("charging")
             return ok
        diff --git a/README.md b/README.md
        new file mode 100644
        --- /dev/null
        +++ b/README.md
        @@ -0,0 +1,2 @@
        +# Title
        +Body
    """.trimIndent()

    @Test
    fun parsesFilesHunksAndCounts() {
        val files = DiffParser.parse(twoFiles)
        assertEquals(2, files.size)
        assertEquals("src/app.py", files[0].path)
        assertEquals(2, files[0].adds)
        assertEquals(1, files[0].dels)
        assertEquals(1, files[0].hunks.size)
        assertEquals("README.md", files[1].path)
        assertEquals(2, files[1].adds)
        assertEquals(0, files[1].dels)
    }

    @Test
    fun lineNumbersFollowHunkHeader() {
        val lines = DiffParser.parse(twoFiles)[0].hunks[0].lines
        assertEquals(DiffLine.Kind.Context, lines[0].kind)
        assertEquals(12, lines[0].oldNo)
        assertEquals(12, lines[0].newNo)
        assertEquals(DiffLine.Kind.Del, lines[1].kind)
        assertEquals(13, lines[1].oldNo)
        assertEquals(null, lines[1].newNo)
        assertEquals(DiffLine.Kind.Add, lines[2].kind)
        assertEquals(null, lines[2].oldNo)
        assertEquals(13, lines[2].newNo)
        assertEquals(14, lines[3].newNo)
    }

    @Test
    fun contentStartingWithPlusPlusPlusStaysContent() {
        val diff = """
            diff --git a/x b/x
            --- a/x
            +++ b/x
            @@ -1,1 +1,2 @@
             keep
            ++++x
        """.trimIndent()
        val files = DiffParser.parse(diff)
        assertEquals(1, files.size)
        assertEquals(1, files[0].adds)
        assertEquals("+++x", files[0].hunks[0].lines.last().text)
    }

    @Test
    fun trailingNoNewlineMarkerStaysInHunk() {
        val diff = """
            diff --git a/x b/x
            --- a/x
            +++ b/x
            @@ -1,1 +1,1 @@
            -old
            +new
            \ No newline at end of file
        """.trimIndent()
        val lines = DiffParser.parse(diff)[0].hunks[0].lines
        assertEquals(DiffLine.Kind.Meta, lines.last().kind)
        assertEquals("\\ No newline at end of file", lines.last().text)
    }

    @Test
    fun emptyAndBinaryDiffs() {
        assertTrue(DiffParser.parse("").isEmpty())
        val bin = DiffParser.parse(
            """
            diff --git a/img.png b/img.png
            Binary files a/img.png and b/img.png differ
            """.trimIndent(),
        )
        assertEquals(1, bin.size)
        assertTrue(bin[0].isBinary)
    }
}
