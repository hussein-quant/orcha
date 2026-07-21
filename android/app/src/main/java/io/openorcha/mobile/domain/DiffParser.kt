package io.openorcha.mobile.domain

// Unified git-diff parser — the Kotlin twin of the iOS DiffParser (DiffViewer.swift),
// feeding the GitHub-style Changes pane. Hunk content is consumed by the declared
// old/new line counts, so content lines that happen to start with "---"/"+++" are
// never mistaken for file headers.

data class DiffLine(
    val kind: Kind,
    val oldNo: Int?,
    val newNo: Int?,
    val text: String,
) {
    enum class Kind { Add, Del, Context, Meta }
}

data class DiffHunk(
    val header: String,
    val lines: List<DiffLine>,
)

data class DiffFile(
    val path: String,
    val isBinary: Boolean = false,
    val adds: Int = 0,
    val dels: Int = 0,
    val hunks: List<DiffHunk> = emptyList(),
)

object DiffParser {

    private class FileBuilder(var path: String) {
        var isBinary = false
        var adds = 0
        var dels = 0
        val hunks = mutableListOf<DiffHunk>()
        fun build() = DiffFile(path, isBinary, adds, dels, hunks.toList())
    }

    fun parse(raw: String): List<DiffFile> {
        val files = mutableListOf<DiffFile>()
        var current: FileBuilder? = null
        var header = ""
        var hunkLines: MutableList<DiffLine>? = null
        var oldNo = 0
        var newNo = 0
        var oldRemain = 0
        var newRemain = 0

        fun closeHunk() {
            val lines = hunkLines
            if (lines != null && current != null) current!!.hunks.add(DiffHunk(header, lines.toList()))
            hunkLines = null
        }

        fun closeFile() {
            closeHunk()
            current?.let { files.add(it.build()) }
            current = null
        }

        for (line in raw.lineSequence()) {
            val inHunk = hunkLines != null && (oldRemain > 0 || newRemain > 0)

            if (!inHunk) {
                when {
                    line.startsWith("diff --git") -> {
                        closeFile()
                        current = FileBuilder(gitPath(line))
                    }
                    line.startsWith("+++ ") -> {
                        val p = strippedPath(line)
                        if (current == null) current = FileBuilder(p ?: "changes")
                        else if (p != null) current!!.path = p
                    }
                    line.startsWith("--- ") || line.startsWith("index ") || line.startsWith("new file") ||
                        line.startsWith("deleted file") || line.startsWith("old mode") || line.startsWith("new mode") ||
                        line.startsWith("similarity") || line.startsWith("rename ") || line.startsWith("copy ") -> Unit
                    line.startsWith("Binary files") -> {
                        if (current == null) current = FileBuilder("binary")
                        current!!.isBinary = true
                    }
                    line.startsWith("@@") -> {
                        closeHunk()
                        val (o, oc, n, nc) = hunkNumbers(line)
                        oldNo = o; newNo = n; oldRemain = oc; newRemain = nc
                        if (current == null) current = FileBuilder("changes")
                        header = line
                        hunkLines = mutableListOf()
                    }
                    else -> Unit // prose between files (commit text etc.)
                }
                continue
            }

            // inside a hunk — classify by prefix, count down the declared sizes
            val lines = hunkLines!!
            when {
                line.startsWith("+") -> {
                    newRemain -= 1
                    current!!.adds += 1
                    lines.add(DiffLine(DiffLine.Kind.Add, null, newNo, line.drop(1)))
                    newNo += 1
                }
                line.startsWith("-") -> {
                    oldRemain -= 1
                    current!!.dels += 1
                    lines.add(DiffLine(DiffLine.Kind.Del, oldNo, null, line.drop(1)))
                    oldNo += 1
                }
                line.startsWith("\\") -> lines.add(DiffLine(DiffLine.Kind.Meta, null, null, line))
                else -> {
                    oldRemain -= 1
                    newRemain -= 1
                    lines.add(DiffLine(DiffLine.Kind.Context, oldNo, newNo, if (line.isEmpty()) "" else line.drop(1)))
                    oldNo += 1
                    newNo += 1
                }
            }
        }
        closeFile()
        return files
    }

    private fun gitPath(line: String): String {
        // "diff --git a/x b/y" → y
        val idx = line.indexOf(" b/")
        return if (idx >= 0) line.substring(idx + 3) else line.removePrefix("diff --git ")
    }

    private fun strippedPath(line: String): String? {
        val p = line.drop(4)
        if (p == "/dev/null") return null
        return if (p.startsWith("b/") || p.startsWith("a/")) p.drop(2) else p
    }

    private data class HunkNums(val o: Int, val oc: Int, val n: Int, val nc: Int)

    private fun hunkNumbers(header: String): HunkNums {
        // "@@ -a[,b] +c[,d] @@ …"
        var o = 1; var oc = 1; var n = 1; var nc = 1
        for (token in header.split(" ")) {
            if (token.startsWith("-") && token.length > 1) {
                val parts = token.drop(1).split(",")
                o = parts.getOrNull(0)?.toIntOrNull() ?: 1
                oc = if (parts.size > 1) parts[1].toIntOrNull() ?: 1 else 1
            } else if (token.startsWith("+") && token.length > 1) {
                val parts = token.drop(1).split(",")
                n = parts.getOrNull(0)?.toIntOrNull() ?: 1
                nc = if (parts.size > 1) parts[1].toIntOrNull() ?: 1 else 1
            }
        }
        return HunkNums(o, oc, n, nc)
    }
}
