package io.openorcha.mobile.domain

/**
 * The portal's safe inline-markdown subset (web `format.ts` `mdText`), as a pure
 * block/span parser — GitHub issue/PR bodies lean on exactly these forms. Rule
 * parity, in the web's application order: fenced code blocks, inline code, pipe
 * tables, bare URLs (trailing `)].,;:!?` stay outside the link), `**`/`__` bold,
 * `*`/`_` italics, 1–3 `#` headings (one visual level, like the web's `.md-h`),
 * task-list items before the generic bullet rule, `-`/`*` bullets, and `1.`/`1)`
 * ordered items. Anything else stays literal text — no HTML, no surprises.
 * Rendering lives in `ui/components/MarkdownText.kt`.
 */

/** One run of inline text with its formatting; [link] is an absolute http(s) URL. */
data class MdSpan(
    val text: String,
    val bold: Boolean = false,
    val italic: Boolean = false,
    val code: Boolean = false,
    val link: String? = null,
)

sealed class MdBlock {
    data class Code(val text: String) : MdBlock()
    data class Table(val header: List<String>, val aligns: List<String>, val rows: List<List<String>>) : MdBlock()
    data class Heading(val spans: List<MdSpan>) : MdBlock()
    data class Task(val checked: Boolean, val spans: List<MdSpan>) : MdBlock()
    data class Bullet(val spans: List<MdSpan>) : MdBlock()
    data class Ordered(val num: String, val spans: List<MdSpan>) : MdBlock()
    data class Para(val spans: List<MdSpan>) : MdBlock()
}

object MarkdownLite {

    private val FENCE = Regex("```[^\n`]*\n?([\\s\\S]*?)```")
    private val HEADING = Regex("^\\s{0,3}#{1,3}\\s+(.+)$")
    private val TASK = Regex("^\\s*[-*]\\s+\\[([ xX])\\]\\s+(.+)$")
    private val BULLET = Regex("^\\s*[-*]\\s+(.+)$")
    private val ORDERED = Regex("^\\s*(\\d{1,3})[.)]\\s+(.+)$")
    private val DELIM_ROW = Regex("^\\s*\\|?\\s*:?-{1,}:?\\s*(\\|\\s*:?-{1,}:?\\s*)+\\|?\\s*$")
    private val URL = Regex("https?://\\S+")
    private val TRAIL = Regex("[)\\].,;:!?]+$")
    private val CODE_SPAN = Regex("`([^`\n]+)`")
    private val BOLD_STAR = Regex("\\*\\*(?!\\s)([^\n]+?)\\*\\*")
    private val BOLD_UNDER = Regex("__(?!\\s)([^\n_]+?)__")
    private val EM_STAR = Regex("(^|[^*])\\*(?!\\s)([^*\n]+?)\\*(?!\\*)")
    private val EM_UNDER = Regex("(^|[^_\\w])_(?!\\s)([^_\n]+?)_(?![\\w_])")

    fun parse(src: String): List<MdBlock> {
        val blocks = mutableListOf<MdBlock>()
        var last = 0
        for (m in FENCE.findAll(src)) {
            parseLines(src.substring(last, m.range.first), blocks)
            blocks.add(MdBlock.Code(m.groupValues[1].trimEnd('\n')))
            last = m.range.last + 1
        }
        parseLines(src.substring(last), blocks)
        return blocks
    }

    private fun parseLines(chunk: String, out: MutableList<MdBlock>) {
        val lines = chunk.split("\n")
        var i = 0
        val para = StringBuilder()
        fun flushPara() {
            val text = para.toString().trim('\n')
            para.clear()
            // Blank-line-separated paragraphs; keep single newlines inside one Para
            // (the web renders them as line breaks in pre-wrap contexts).
            text.split(Regex("\n{2,}")).forEach { part ->
                if (part.isNotBlank()) out.add(MdBlock.Para(inline(part)))
            }
        }
        while (i < lines.size) {
            val line = lines[i]
            val next = lines.getOrNull(i + 1)
            when {
                line.contains("|") && next != null && DELIM_ROW.matches(next) -> {
                    flushPara()
                    val header = splitRow(line)
                    val aligns = splitRow(next).map { c ->
                        val l = c.startsWith(":"); val r = c.endsWith(":")
                        if (l && r) "center" else if (r) "right" else if (l) "left" else ""
                    }
                    val rows = mutableListOf<List<String>>()
                    var j = i + 2
                    while (j < lines.size && lines[j].contains("|") && lines[j].isNotBlank()) {
                        val cells = splitRow(lines[j])
                        rows.add(header.indices.map { k -> cells.getOrElse(k) { "" } })
                        j++
                    }
                    out.add(MdBlock.Table(header, aligns, rows))
                    i = j
                }
                TASK.matches(line) -> {
                    flushPara()
                    val m = TASK.find(line)!!
                    out.add(MdBlock.Task(m.groupValues[1].equals("x", ignoreCase = true), inline(m.groupValues[2])))
                    i++
                }
                HEADING.matches(line) -> {
                    flushPara()
                    out.add(MdBlock.Heading(inline(HEADING.find(line)!!.groupValues[1])))
                    i++
                }
                BULLET.matches(line) -> {
                    flushPara()
                    out.add(MdBlock.Bullet(inline(BULLET.find(line)!!.groupValues[1])))
                    i++
                }
                ORDERED.matches(line) -> {
                    flushPara()
                    val m = ORDERED.find(line)!!
                    out.add(MdBlock.Ordered(m.groupValues[1], inline(m.groupValues[2])))
                    i++
                }
                else -> {
                    para.append(line).append('\n')
                    i++
                }
            }
        }
        flushPara()
    }

    private fun splitRow(line: String): List<String> =
        line.trim().removePrefix("|").removeSuffix("|").split("|").map { it.trim() }

    /** Inline pass, web order: code spans are opaque; then links; then bold; then italics. */
    fun inline(text: String): List<MdSpan> {
        val spans = mutableListOf<MdSpan>()
        var last = 0
        for (m in CODE_SPAN.findAll(text)) {
            if (m.range.first > last) linkPass(text.substring(last, m.range.first), spans)
            spans.add(MdSpan(m.groupValues[1], code = true))
            last = m.range.last + 1
        }
        if (last < text.length) linkPass(text.substring(last), spans)
        return spans
    }

    private fun linkPass(text: String, out: MutableList<MdSpan>) {
        var last = 0
        for (m in URL.findAll(text)) {
            if (m.range.first > last) stylePass(text.substring(last, m.range.first), out)
            var url = m.value
            var tail = ""
            TRAIL.find(url)?.let { t -> tail = t.value; url = url.dropLast(t.value.length) }
            out.add(MdSpan(url, link = url))
            if (tail.isNotEmpty()) stylePass(tail, out)
            last = m.range.last + 1
        }
        if (last < text.length) stylePass(text.substring(last), out)
    }

    /** Bold then italics over one plain segment, web regex parity. */
    private fun stylePass(text: String, out: MutableList<MdSpan>) {
        var last = 0
        val bolds = (BOLD_STAR.findAll(text) + BOLD_UNDER.findAll(text)).sortedBy { it.range.first }
        for (m in bolds) {
            if (m.range.first < last) continue
            if (m.range.first > last) italicPass(text.substring(last, m.range.first), out)
            out.add(MdSpan(m.groupValues[1], bold = true))
            last = m.range.last + 1
        }
        if (last < text.length) italicPass(text.substring(last), out)
    }

    private fun italicPass(text: String, out: MutableList<MdSpan>) {
        var last = 0
        val ems = (EM_STAR.findAll(text) + EM_UNDER.findAll(text)).sortedBy { it.range.first }
        for (m in ems) {
            if (m.range.first < last) continue
            val lead = m.groupValues[1]
            val leadEnd = m.range.first + lead.length
            if (leadEnd > last) out.add(MdSpan(text.substring(last, leadEnd)))
            out.add(MdSpan(m.groupValues[2], italic = true))
            last = m.range.last + 1
        }
        if (last < text.length) out.add(MdSpan(text.substring(last)))
    }
}
