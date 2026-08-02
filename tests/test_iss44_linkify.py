"""ISS-44 — URLs in authored text are clickable (shared linkify), safely.

Every body/payload/reason/result/thread/conversation surface used to render via esc()
as escaped plain text, so a PR/issue/doc link an agent or human posted couldn't be
clicked. This adds a shared `Orcha.linkify()` (esc FIRST, then linkify the escaped text;
ONLY http(s)://; emit target=_blank rel="noopener noreferrer") and applies it to the
full-text authored surfaces. The esc-first ordering is the security invariant — authored
text can never inject HTML.
"""
import pathlib
import shutil
import subprocess
import pytest
from portal_source import page_source, script_source, style_source, run_node

REPO = pathlib.Path(__file__).resolve().parent.parent
STATIC = REPO / "orcha-cli" / "orcha_cli" / "templates" / "portal" / "static"


def test_linkify_is_applied_to_authored_text_surfaces():
    app = script_source("app.js")
    assert "const linkify =" in app and "linkify," in app, "linkify not defined/exported"
    # the authored full-text surfaces render via mdText (feat/chat-markdown) — a superset
    # of linkify: same esc-first + http(s)-only autolink invariant, plus block markdown.
    # feat/github-hub-detail-ui: tasks.html/requests.html now wrap mdText's output in a
    # page-local mdGh() helper — the portal-wide PR/issue-link rewrite (modules/app-text.js
    # rewriteGithubLinks) that turns a mentioned github.com/<connected-repo>/pull|issues/N
    # URL into a clickable internal /github?pr=N|issue=N hop. mdGh calls TasO.mdText/
    # ReqO.mdText internally, so it's still the SAME renderer at the same call sites — the
    # sole difference from mdText() is the naming of the wrapper.
    reqs = page_source("requests.html")
    assert reqs.count("mdGh(") >= 3, "request payload/response/reason not md-rendered (via mdGh)"
    assert "ReqO.rewriteGithubLinks" in reqs, "requests.html's mdGh applies the PR-link rewrite"
    tasks = page_source("tasks.html")
    assert "mdGh(m.body)" in tasks, "task thread message not md-rendered (via mdGh)"
    assert "mdGh(isPlan" in tasks, "plan body / result not md-rendered (verification gate, via mdGh)"
    # BOTH task-result surfaces must render markdown: the verification-gate result AND the
    # normal task-detail Result block — and neither may regress back to bare esc().
    assert "mdGh(resultText(t.result))" in tasks, "normal task-detail Result not md-rendered (via mdGh)"
    assert "O.esc(t.result)" not in tasks, "a task-result surface regressed to bare esc()"
    assert "TasO.rewriteGithubLinks" in tasks, "tasks.html's mdGh applies the PR-link rewrite"
    conv = script_source("conversation.js")
    # conversation turns render via mdText (rich markdown), which still linkifies URLs —
    # so authored-link coverage is preserved (see test_rich_conversation_markdown for the link case).
    assert "O().mdText(t.content" in conv, "conversation turn content not rendered (mdText)"
    home = page_source("home.html")
    # the dashboard plan-approval card renders the FULL plan body → mdText (the last
    # full-text authored surface; "URLs clickable everywhere").
    assert "O.mdText(planText(t))" in home, "home dashboard plan-text not md-rendered"
    # feat/github-hub-detail-ui: the live-activity row NOW linkifies + PR-link-rewrites its
    # text too (portal-wide rewrite coverage) — this requires a REAL <a> inside .txt, which
    # would have nested inside the row's own <a class="act"> (invalid HTML, and the browser's
    # parser would break the outer link). So .act moved from a native <a href> to a clickable
    # <div onclick> (mirrors this same file's .kcard idiom), which is what makes a real inner
    # <a> safe. The old constraint this test used to pin ("activity text must stay esc() because
    # the row IS an anchor") no longer holds, because the row is no longer an anchor.
    assert 'class="act" onclick=' in home, "the activity row is now a clickable div, not a native <a> (enables safe nested links)"
    assert "HomO.rewriteGithubLinks(HomO.linkify(e.text)" in home, "activity-feed text is linkified + PR-link-rewritten"
    css = style_source()
    assert ".lnk" in css, "no link styling"


@pytest.mark.skipif(shutil.which("node") is None, reason="node not available to exercise client JS")
def test_linkify_behavior_is_safe_and_correct():
    app_js = script_source("app.js")
    harness = r"""
global.localStorage = { getItem: () => null, setItem: () => {} };
global.document = { documentElement:{setAttribute(){},classList:{add(){},remove(){}}}, addEventListener(){},
  getElementById:()=>null, querySelector:()=>null, querySelectorAll:()=>[],
  createElement:()=>({classList:{add(){},remove(){}},addEventListener(){},style:{},appendChild(){}}),
  body:{appendChild(){}} };
global.window = {}; global.location = { search: "" };
__APPJS__
const L = window.Orcha.linkify;
const A = (name, cond) => { if (!cond) { console.error("FAIL: " + name); process.exit(1); } };

// 1) esc-first: embedded HTML is neutralized, never emitted raw
let r = L('hi <b>bold</b> http://a.com/x?y=1&z=2 end');
A("escapes html", r.indexOf("<b>") === -1 && r.indexOf("&lt;b&gt;") !== -1);
A("links http", r.indexOf('<a class="lnk" href="http://a.com/x?y=1&amp;z=2" target="_blank" rel="noopener noreferrer">') !== -1);
A("query amp escaped in text too", r.indexOf('>http://a.com/x?y=1&amp;z=2</a>') !== -1);

// 2) https works; exactly one anchor for one url
r = L('see https://example.org/path');
A("links https", (r.match(/<a /g) || []).length === 1 && r.indexOf('href="https://example.org/path"') !== -1);

// 3) NON-http schemes are NOT linkified (no javascript:/ftp: anchors)
A("no javascript scheme", L('javascript:alert(1)').indexOf("<a ") === -1);
A("no ftp scheme", L('ftp://host/file').indexOf("<a ") === -1);

// 4) trailing sentence punctuation stays OUTSIDE the link
r = L('go http://a.com. now');
A("trailing dot outside", r.indexOf('>http://a.com</a>. now') !== -1);
r = L('(ref http://a.com)');
A("trailing paren outside", r.indexOf('>http://a.com</a>)') !== -1);

// 5) plain text without a url is just escaped, unchanged otherwise
A("plain text passes through", L('no links "here" & <ok>').indexOf("<a ") === -1);
A("plain text escaped", L('a & b').indexOf("a &amp; b") !== -1);

// 6) null/undefined safe
A("null safe", L(null) === "" && L(undefined) === "");

console.log("OK");
"""
    out = run_node(harness.replace("__APPJS__", app_js))
    assert out.returncode == 0, (out.stdout + out.stderr)
    assert out.stdout.strip().splitlines()[-1] == "OK", out.stdout
