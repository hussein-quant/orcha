/* ============================================================================
   Portal-wide PR/issue-link rewrite (Orcha.rewriteGithubLinks, modules/
   app-text.js) — part of the GitHub hub detail pages deliverable.

   Runs AFTER linkify()/mdText() on their TRUSTED output: an anchor
   (`<a class="lnk" href="...">`) pointing at the CONNECTED repo's
   github.com/<owner>/<repo>/pull/N or /issues/N is rewritten to the internal
   /github?pr=N (or ?issue=N) detail route, with a small "open on GitHub ↗"
   secondary link appended that preserves the original URL. A link to ANY
   OTHER repo is left completely untouched — rewriting it would silently
   point at the wrong container's task list.

   Applied on every surface that renders agent-authored text: task
   result/plan/protocol-notes/thread messages (tasks-detail.js), the home
   dashboard's live-activity feed (home-render.js), and request payload/
   answer/rejection-reason (requests-actions.js) — Part 2 below pins each
   call site by grep (mirrors github_hub.test.js's wiring-tests style for
   DOM-glue files).

   Dependency-free: the REAL modules/app-text.js in a vm sandbox (mirrors
   md_render.test.js's harness).
   Run: node tests/portal/github_link_rewrite.test.js
   ========================================================================== */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const STATIC = path.join(
  __dirname, "..", "..",
  "orcha-cli", "orcha_cli", "templates", "portal", "static"
);
const read = (...p) => fs.readFileSync(path.join(STATIC, ...p), "utf8");

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log("  ✓ " + msg);
  else { failures++; console.error("  ✗ " + msg); }
}

/* ---- sandbox: app-text.js only (no window -> the currentCid lookup must
   degrade to no ?cid= param, never throw) ---- */
const sandbox = { console };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext('var tasks = () => [];', sandbox);
vm.runInContext(read("modules", "app-text.js"), sandbox, { filename: "modules/app-text.js" });
const linkify = (s) => vm.runInContext("linkify(" + JSON.stringify(s) + ")", sandbox);
const mdText = (s) => vm.runInContext("mdText(" + JSON.stringify(s) + ")", sandbox);
const rewrite = (html, repo) => vm.runInContext(
  "rewriteGithubLinks(" + JSON.stringify(html) + ", " + JSON.stringify(repo) + ")", sandbox);

console.log("PART A — no-window safety (rewrite must never throw without a browser)\n");
{
  const html = linkify("see https://github.com/acme/orcha/pull/42");
  let threw = false;
  let out = "";
  try { out = rewrite(html, "acme/orcha"); } catch (e) { threw = true; }
  assert(!threw, "rewriteGithubLinks never throws when window/OrchaData is absent (falls back to no ?cid=)");
  assert(out.includes('href="/github?pr=42"'), "the rewrite still happens without window (cid simply omitted)");
  assert(!/[?&]cid=/.test(out), "no ?cid= param is appended when window.OrchaData isn't present");
}

console.log("\nPART B — connected-repo URLs rewritten\n");
{
  const pr = rewrite(linkify("see https://github.com/acme/orcha/pull/42 for details"), "acme/orcha");
  assert(pr.includes('href="/github?pr=42"'), "a connected-repo PULL url rewrites to /github?pr=N");
  assert(pr.includes('class="lnk gh-pr-link"'), "the rewritten internal link keeps the .lnk look (reads like any other authored link) plus a distinguishing class");

  const issue = rewrite(linkify("see https://github.com/acme/orcha/issues/7"), "acme/orcha");
  assert(issue.includes('href="/github?issue=7"'), "a connected-repo ISSUES url rewrites to /github?issue=N");

  // markdown [text](url) form, not just bare-URL autolink
  const mdLink = rewrite(mdText("Fixed in [PR #42](https://github.com/acme/orcha/pull/42)."), "acme/orcha");
  assert(mdLink.includes('href="/github?pr=42"'), "a markdown [text](url) link to the connected repo is rewritten too, not just bare-URL autolinks");
  assert(mdLink.includes(">PR #42<") || mdLink.includes("PR #42"), "the rewritten link keeps its ORIGINAL link text (e.g. \"PR #42\"), not the raw URL");

  // case-insensitivity (GitHub repo paths are case-insensitive in practice) and
  // a trailing path segment (e.g. #issuecomment-N) still resolves to the right number.
  const withFragment = rewrite(linkify("https://github.com/acme/orcha/pull/42#discussion_r123"), "acme/orcha");
  assert(withFragment.includes('href="/github?pr=42"'), "a PR url with a trailing fragment still extracts the correct PR number");
}

console.log("\nPART C — OTHER repos' URLs untouched\n");
{
  const otherRepo = rewrite(linkify("see https://github.com/someone-else/other-repo/pull/9"), "acme/orcha");
  assert(otherRepo.includes('href="https://github.com/someone-else/other-repo/pull/9"'),
    "a PR link to a DIFFERENT repo is left completely untouched");
  assert(!otherRepo.includes("/github?pr="), "no internal rewrite happens for another repo's link");
  assert(!otherRepo.includes("gh-pr-link") && !otherRepo.includes("gh-pr-ext"),
    "no rewrite chrome (internal link / ↗ affix) is added for another repo's link");

  // a github.com URL to the SAME owner but a DIFFERENT repo name is also untouched
  // (must match the full owner/name, not just the owner).
  const sameOwnerDiffRepo = rewrite(linkify("https://github.com/acme/other-project/pull/3"), "acme/orcha");
  assert(sameOwnerDiffRepo.includes('href="https://github.com/acme/other-project/pull/3"'),
    "a different repo under the SAME owner is untouched — the match is on the full owner/name, not just owner");

  // a non-PR/issue github.com link (e.g. the repo root, or a file blob) to the
  // CONNECTED repo is untouched too — only /pull/N and /issues/N paths qualify.
  const repoRoot = rewrite(linkify("https://github.com/acme/orcha"), "acme/orcha");
  assert(repoRoot.includes('href="https://github.com/acme/orcha"') && !repoRoot.includes("/github?"),
    "a bare repo-root link (not a PR/issue path) is left untouched");
  const blobLink = rewrite(linkify("https://github.com/acme/orcha/blob/main/README.md"), "acme/orcha");
  assert(!blobLink.includes("/github?"), "a file-blob link is left untouched (not a pull/issues path)");

  // no repo connected at all (repo is null/undefined) -> no rewriting, no crash.
  const noRepo = rewrite(linkify("https://github.com/acme/orcha/pull/1"), null);
  assert(noRepo.includes('href="https://github.com/acme/orcha/pull/1"') && !noRepo.includes("/github?"),
    "with no connected repo (null), nothing is rewritten and nothing crashes");
}

console.log("\nPART D — the ↗ external link is preserved (original GitHub URL stays one click away)\n");
{
  const out = rewrite(linkify("https://github.com/acme/orcha/pull/42"), "acme/orcha");
  assert(/<a class="gh-pr-ext" href="https:\/\/github\.com\/acme\/orcha\/pull\/42"/.test(out),
    "the secondary ↗ link preserves the EXACT original GitHub URL");
  assert(/target="_blank"/.test(out.match(/<a class="gh-pr-ext"[^>]*>/)[0]) && /rel="noopener noreferrer"/.test(out.match(/<a class="gh-pr-ext"[^>]*>/)[0]),
    "the ↗ link opens in a new tab safely (target=_blank rel=noopener noreferrer), same convention as every other outbound link");
  assert(out.includes("↗"), "the ↗ glyph itself is present as the secondary link's visible affordance");
  assert(out.indexOf('class="lnk gh-pr-link"') < out.indexOf('class="gh-pr-ext"'),
    "the internal link comes first, the ↗ external affix second — the primary action stays primary");
}

console.log("\nPART E — safety / escaping\n");
{
  // rewriteGithubLinks only ever touches href values already produced by
  // THIS module's own linkify/mdText (never raw untrusted text) — feeding it
  // arbitrary non-<a> html must be a no-op, not a new injection surface.
  const untouched = rewrite("<div>plain text, no anchors here</div>", "acme/orcha");
  assert(untouched === "<div>plain text, no anchors here</div>", "html with no matching anchors passes through unchanged");
  assert(rewrite(null, "acme/orcha") === "", "null input is handled safely (empty string, no throw)");
  assert(rewrite(undefined, "acme/orcha") === "", "undefined input is handled safely (empty string, no throw)");

  // a regex-special character in the repo name (e.g. a "." in the repo name,
  // legal on GitHub) must not corrupt the match or escape the pattern.
  const dotRepo = rewrite(linkify("https://github.com/acme/orcha.js/pull/5"), "acme/orcha.js");
  assert(dotRepo.includes('href="/github?pr=5"'), "a repo name containing regex-special characters (e.g. '.') is escaped correctly, not misinterpreted as a wildcard");
  const dotRepoNoFalseMatch = rewrite(linkify("https://github.com/acmeXorcha/pull/5"), "acme.orcha");
  assert(!dotRepoNoFalseMatch.includes("/github?pr="),
    "an UNESCAPED '.' in the repo pattern would wildcard-match any character — this proves it does NOT (acmeXorcha must not match acme.orcha)");
}

/* ---------------- Part 2: wiring — every render surface applies the rewrite ---- */
function wiringTests() {
  console.log("\nwiring (call sites: tasks-detail.js, home-render.js, requests-actions.js)\n");
  const TASKS_JS = read("pages", "tasks-detail.js");
  const HOME_JS = read("pages", "home-render.js");
  const REQUESTS_JS = read("pages", "requests-actions.js");
  const APP_JS = read("app.js");

  assert(/rewriteGithubLinks/.test(APP_JS), "rewriteGithubLinks is exported on window.Orcha (app.js)");

  // tasks-detail.js: result / plan-gate / protocol notes / thread messages
  assert(/function mdGh\(/.test(TASKS_JS) && /TasO\.rewriteGithubLinks/.test(TASKS_JS),
    "tasks-detail.js wraps mdText output with rewriteGithubLinks (mdGh helper)");
  const tasksJsWithoutMdGhDef = TASKS_JS.replace(/function mdGh\([^)]*\)\s*\{[^}]*\}/, "");
  assert(!/\bTasO\.mdText\(/.test(tasksJsWithoutMdGhDef),
    "every former direct TasO.mdText(...) call site in tasks-detail.js now goes through mdGh (no bypass left, outside mdGh's own definition)");
  assert((TASKS_JS.match(/mdGh\(/g) || []).length >= 4,
    "mdGh is applied at all four task-detail markdown surfaces (result, plan/verify gate body, protocol notes, thread messages)");

  // home-render.js: live activity feed
  assert(/HomO\.rewriteGithubLinks/.test(HOME_JS), "home-render.js's live-activity feed applies rewriteGithubLinks");
  assert(/HomO\.linkify/.test(HOME_JS), "the activity feed linkifies its text BEFORE rewriting (rewrite operates on linkify's anchor output)");
  assert(!/<a class="act" href/.test(HOME_JS),
    "the activity row is no longer a native <a> wrapper (would create invalid nested anchors once .txt can carry its own real link)");

  // requests-actions.js: payload / answer / rejection reason
  assert(/function mdGh\(/.test(REQUESTS_JS) && /ReqO\.rewriteGithubLinks/.test(REQUESTS_JS),
    "requests-actions.js wraps mdText output with rewriteGithubLinks (mdGh helper)");
  assert((REQUESTS_JS.match(/mdGh\(/g) || []).length >= 3,
    "mdGh is applied at all three request surfaces (payload, answer, rejection reason)");
}

function run() {
  wiringTests();
  if (failures) { console.error("\n" + failures + " failure(s)"); process.exit(1); }
  console.log("\nall github link-rewrite tests passed");
}

run();
