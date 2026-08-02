/* Orcha shared portal module: text formatting, markdown, links, and task references. */
/* ---- tiny utils ------------------------------------------------------ */
const esc = (s) => (s == null ? "" : String(s)).replace(/[&<>"']/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const trunc = (s, n) => { s = s || ""; return s.length > n ? s.slice(0, n - 1) + "…" : s; };
// ISS-82 (GH #223): agents cite tasks in free text by raw id — usually the 8-char SHORT
// prefix (e.g. `e4b77f3f`), sometimes the full UUID. Resolve such a token to the live task.
// Exact full-id wins; else a UNIQUE 8+ hex prefix. Ambiguous or absent → null (never guess),
// so request ids / message ids / commit shas simply don't resolve and are left untouched.
function taskByRef(token) {
  if (!token) return null;
  const tok = String(token).toLowerCase();
  const ts = tasks();
  const exact = ts.find((t) => String(t.id).toLowerCase() === tok);
  if (exact) return exact;
  if (tok.length >= 8 && tok.length < 36) {
    let hit = null, n = 0;
    for (const t of ts) { if (String(t.id).toLowerCase().startsWith(tok)) { hit = t; if (++n > 1) return null; } }
    if (n === 1) return hit;
  }
  return null;
}
// ISS-82: rewrite bare task-id tokens in ALREADY-ESCAPED/rendered HTML into linkified
// [task name] chips. Tag-aware (never edits the contents of a < > tag) AND anchor-aware
// (never rewrites the visible text of an existing <a>, so a task-id that happens to sit
// inside a URL stays intact). Only tokens that resolve to a real task are touched; every
// other id passes through verbatim. Callers run esc()/mdText first, so the input is trusted.
const TASK_REF_RE = /\b[0-9a-f]{8}(?:-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?\b/gi;
function taskRefs(html) {
  if (html == null) return "";
  let inAnchor = false;
  return String(html).split(/(<[^>]*>)/).map((seg) => {
    if (seg.charAt(0) === "<") {                 // a real tag (text has its < escaped to &lt;)
      const lt = seg.toLowerCase();
      if (lt.indexOf("<a") === 0) inAnchor = true;
      else if (lt.indexOf("</a") === 0) inAnchor = false;
      return seg;
    }
    if (inAnchor) return seg;                     // visible text inside an existing link — leave it
    return seg.replace(TASK_REF_RE, (tok) => {
      const t = taskByRef(tok);
      if (!t) return tok;
      return `<a class="tref" href="/tasks?task=${encodeURIComponent(t.id)}" title="task ${esc(tok)}">[${esc(t.title)}]</a>`;
    });
  }).join("");
}
// ISS-44: make URLs in authored text clickable. SAFETY: esc() FIRST (so the text can never
// inject HTML), THEN linkify the escaped string — only http(s):// URLs, emitting an anchor
// with target=_blank + rel=noopener noreferrer. Returns trusted HTML (already escaped).
// Trailing sentence punctuation / a closing bracket is left OUTSIDE the link, never swallowed.
// ISS-82: after URL-linkify, run taskRefs so bare task-id mentions become [task name] chips
// too (anchor-aware, so a task-id inside a linked URL is left alone).
const linkify = (s) => taskRefs(esc(s == null ? "" : String(s)).replace(/https?:\/\/[^\s<]+/g, (m) => {
  let tail = "";
  const t = m.match(/[)\].,;:!?]+$/);   // (text is escaped, so quotes/apostrophes are entities)
  if (t) { tail = m.slice(m.length - t[0].length); m = m.slice(0, m.length - t[0].length); }
  return `<a class="lnk" href="${m}" target="_blank" rel="noopener noreferrer">${m}</a>${tail}`;
}));
// Render SAFE markdown for agent-authored chat text — the full chat-scale subset:
// headings h1–h4, bold/italic, `code` + fenced blocks, ordered/unordered (nested) lists,
// blockquotes, [text](https://…) links + bare-URL autolink, --- rules, GFM pipe tables,
// and paragraphs/line breaks. SECURITY: esc() FIRST so authored text can never inject
// HTML — every pass below operates on the escaped string and only renderer-built tags
// are emitted. NO raw-html passthrough; images render as plain links (no <img>: remote
// fetches are a tracking/spoofing vector); link targets are http(s) ONLY, so
// javascript:/data: URLs stay literal text. Code spans/fences and anchors are stashed
// behind a NUL sentinel (stripped from the input first, so a forged sentinel can't
// address the stash) before emphasis runs, keeping their literal *_` and URLs intact.
// Output is BLOCK html — pair with the `md` container class (styles/markdown.css).
const mdText = (src) => {
  let s = esc(src == null ? "" : String(src)).replace(/\u0000/g, "");
  const stash = [];
  const Z = String.fromCharCode(0);   // sentinel — just stripped from the input, so it never collides
  const keep = (html) => { stash.push(html); return Z + (stash.length - 1) + Z; };
  const anchor = (url, text) => keep(`<a class="lnk" href="${url}" target="_blank" rel="noopener noreferrer">${text}</a>`);
  // fenced code block  ```lang\n…```  — contents verbatim (already escaped), never formatted
  s = s.replace(/```[^\n`]*\n?([\s\S]*?)```/g, (m, code) => keep(`<pre class="md-pre"><code>${code.replace(/\n+$/, "")}</code></pre>`));
  // inline code  `…`
  s = s.replace(/`([^`\n]+)`/g, (m, code) => keep(`<code class="md-code">${code}</code>`));
  // ![alt](url) images -> plain links, then [text](url) links — http(s) only
  s = s.replace(/!\[([^\]\n]*)\]\((https?:\/\/[^\s)]+)\)/g, (m, alt, url) => anchor(url, alt || url));
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (m, text, url) => anchor(url, text));
  // bare URLs — trailing sentence punctuation / a closing bracket stays OUTSIDE the link
  s = s.replace(/https?:\/\/[^\s<]+/g, (m) => {
    let tail = ""; const t = m.match(/[)\].,;:!?]+$/);
    if (t) { tail = m.slice(m.length - t[0].length); m = m.slice(0, m.length - t[0].length); }
    return anchor(m, m) + tail;
  });
  // bold (before italic, so ** isn't eaten by the single-* rule)
  s = s.replace(/\*\*(?!\s)([^\n]+?)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/__(?!\s)([^\n_]+?)__/g, "<strong>$1</strong>");
  // italic — non-space inner edges + word-boundary for _ so snake_case is left alone
  s = s.replace(/(^|[^*])\*(?!\s)([^*\n]+?)\*(?!\*)/g, "$1<em>$2</em>");
  s = s.replace(/(^|[^_\w])_(?!\s)([^_\n]+?)_(?![\w_])/g, "$1<em>$2</em>");

  /* ---- block pass: line groups -> tables/headings/hr/quotes/lists/paragraphs ---- */
  const SLOT_LINE = new RegExp("^" + Z + "(\\d+)" + Z + "$");
  const LIST_RE = /^(\s*)(?:([-*+])|(\d{1,9})[.)])\s+(\S.*)$/;
  const splitRow = (line) => line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
  const isDelim = (line) => line != null && /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)+\|?\s*$/.test(line);
  const cell = (c, tag, al) => `<${tag}${al ? ` style="text-align:${al}"` : ""}>${c}</${tag}>`;
  const blocks = (lines) => {
    const out = [], para = [];
    const flushP = () => { if (para.length) { out.push(`<div class="md-p">${para.join("<br>")}</div>`); para.length = 0; } };
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i];
      // GFM table: header row + |---|:--:| delimiter + data rows, rendered as ONE line.
      // Cells already carry inline formatting; code is stashed, so a `pipe|in|code`
      // span can't be mistaken for columns. Checked before hr so |---| isn't a rule.
      if (ln.indexOf("|") >= 0 && isDelim(lines[i + 1])) {
        flushP();
        const head = splitRow(ln);
        const aligns = splitRow(lines[i + 1]).map((c) => {
          const L = c.startsWith(":"), R = c.endsWith(":");
          return L && R ? "center" : R ? "right" : L ? "left" : "";
        });
        const rows = []; let j = i + 2;
        for (; j < lines.length && lines[j].indexOf("|") >= 0 && lines[j].trim() !== ""; j++) rows.push(splitRow(lines[j]));
        const thead = "<tr>" + head.map((c, k) => cell(c, "th", aligns[k])).join("") + "</tr>";
        const tbody = rows.map((r) => "<tr>" + head.map((_, k) => cell(r[k] == null ? "" : r[k], "td", aligns[k])).join("") + "</tr>").join("");
        out.push(`<table class="md-table"><thead>${thead}</thead><tbody>${tbody}</tbody></table>`);
        i = j - 1; continue;
      }
      if (!ln.trim()) { flushP(); continue; }                     // blank line = paragraph break
      const slot = ln.trim().match(SLOT_LINE);                    // a fenced block alone on its line
      if (slot && stash[+slot[1]].startsWith("<pre")) { flushP(); out.push(ln.trim()); continue; }
      const h = ln.match(/^\s{0,3}(#{1,6})\s+(.+)$/);             // headings — h5/h6 clamp to chat-scale h4
      if (h) { flushP(); const lvl = Math.min(h[1].length, 4); out.push(`<h${lvl}>${h[2].trim()}</h${lvl}>`); continue; }
      if (/^\s{0,3}(?:-{3,}|_{3,}|\*{3,})\s*$/.test(ln)) { flushP(); out.push("<hr>"); continue; }
      if (/^\s{0,3}&gt;/.test(ln)) {                              // blockquote run (a literal > is &gt; post-esc)
        flushP();
        const inner = [];
        while (i < lines.length && /^\s{0,3}&gt;/.test(lines[i])) { inner.push(lines[i].replace(/^\s{0,3}&gt;\s?/, "")); i++; }
        i--;
        out.push(`<blockquote class="md-quote">${blocks(inner)}</blockquote>`);
        continue;
      }
      if (LIST_RE.test(ln)) {                                     // list run — nested via 2-space indent steps
        flushP();
        const items = [];
        while (i < lines.length) {
          const im = lines[i].match(LIST_RE);
          if (!im) break;
          items.push({ ind: im[1].replace(/\t/g, "  ").length, ol: im[3] != null, num: im[3] ? +im[3] : 0, text: im[4].trim() });
          i++;
        }
        i--;
        const stack = []; let lh = "";
        const open = (it) => { lh += it.ol ? (it.num > 1 ? `<ol start="${it.num}">` : "<ol>") : "<ul>"; stack.push(it); };
        const close = () => { lh += stack.pop().ol ? "</ol>" : "</ul>"; };
        items.forEach((it) => {
          if (!stack.length || it.ind >= stack[stack.length - 1].ind + 2) open(it);
          else {
            while (stack.length > 1 && it.ind <= stack[stack.length - 1].ind - 2) close();
            if (stack[stack.length - 1].ol !== it.ol) { close(); open(it); }
          }
          lh += `<li>${it.text}</li>`;
        });
        while (stack.length) close();
        out.push(lh); continue;
      }
      para.push(ln);
    }
    flushP();
    return out.join("");
  };
  s = blocks(s.split("\n"));
  // ISS-82: linkify bare task-id refs last — code spans/fences and URLs are already stashed,
  // so they're protected; block/emphasis tags are skipped by taskRefs' tag-aware split.
  s = taskRefs(s);
  // un-stash (bounded loop: a markdown link's text may itself hold an inline-code slot)
  for (let g = 0; g < 5 && s.indexOf(Z) >= 0; g++) s = s.replace(new RegExp(Z + "(\\d+)" + Z, "g"), (m, i) => stash[+i]);
  return s;
};

// Portal-wide PR/issue-link rewrite: run AFTER linkify()/mdText() on their
// trusted output — finds anchors this module's own renderer just emitted
// (`<a class="lnk" href="...">`) that point at the CONNECTED repo's
// github.com/<owner>/<repo>/pull/N or /issues/N, and rewrites them to the
// internal detail route (/github?pr=N or ?issue=N[&cid=...]), appending a
// small secondary "open on GitHub ↗" link that preserves the original URL —
// so an agent's "see PR #42" mention becomes a one-click hop into the portal's
// own PR detail page instead of always bouncing out to github.com, while the
// real GitHub link stays one click away. Only touches links to the CURRENT
// project's OWN repo (`repo`, "owner/name" — from the container snapshot,
// already in every page's state); a link to a DIFFERENT repo (a founder
// pasting a link to some other project's PR) is left completely alone, since
// rewriting it would silently point at the wrong container's task list.
// SAFETY: operates only on `href="..."` attribute values already produced by
// THIS module (mdText/linkify), never on raw untrusted text — no new HTML
// injection surface. Anchor-aware via the same tag-splitting idiom taskRefs
// uses, so it can't mis-rewrite something that merely LOOKS like a GitHub PR
// URL inside a code span (already stashed/protected upstream) or plain text.
function ghPrLinkHref(repo) {
  if (!repo) return null;
  const esc_ = repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp("^https?://github\\.com/" + esc_ + "/(pull|issues)/(\\d+)(?:[/?#][^\"\\s]*)?$", "i");
}
function rewriteGithubLinks(html, repo) {
  if (html == null) return "";
  const re = ghPrLinkHref(repo);
  if (!re) return String(html);
  const cid = (typeof window !== "undefined" && window.OrchaData && window.OrchaData.currentCid && window.OrchaData.currentCid()) || null;
  return String(html).replace(/<a\s+class="lnk"\s+href="([^"]+)"([^>]*)>([\s\S]*?)<\/a>/g, (whole, href, attrs, text) => {
    const m = href.match(re);
    if (!m) return whole;
    const kind = m[1] === "pull" ? "pr" : "issue";
    const number = m[2];
    let internal = "/github?" + kind + "=" + encodeURIComponent(number);
    if (cid) internal += "&cid=" + encodeURIComponent(cid);
    // onclick stopPropagation: some render surfaces (e.g. the home dashboard's
    // live-activity row) wrap the WHOLE line in a click-to-navigate container:
    // without this, a click on either link here would also fire the parent's
    // handler and race/override this link's own navigation.
    return `<a class="lnk gh-pr-link" href="${internal}" onclick="event.stopPropagation()">${text}</a>` +
      `<a class="gh-pr-ext" href="${href}" target="_blank" rel="noopener noreferrer" title="Open on GitHub" onclick="event.stopPropagation()">↗</a>`;
  });
}
