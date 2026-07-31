/* ============================================================================
   Seamless navigation (MPA, no SPA rewrite) — the four layers that remove the
   blank flash + make sidebar/tab clicks read as instant:

     PART A  pre-paint snippet — every shell page's <head> sets an inline
             bg/fg on <html> BEFORE any stylesheet link, with hardcoded colors
             that must match --bg/--text in styles/tokens.css (classic) and
             the Swiss skin token block; identical snippet on all 6 pages.
     PART B  self-hosted fonts — fonts.googleapis.com/gstatic gone from every
             page; /assets/styles/fonts.css linked instead; every @font-face
             src resolves to a real woff2 file (magic-checked) in static/fonts.
     PART C  speculation rules — every page carries a JSON-valid prerender
             document rule (moderate eagerness) with the non-page exclusions
             (/api/*, /assets/*).
     PART D  view transitions — tokens.css opts into cross-document view
             transitions (fast root cross-fade, none under reduced motion).
     PART E  primed shell — app-shell.js restores the cached sidebar/topbar
             markup synchronously at load (before the first snapshot round
             trip) and mountShell persists its render for the next page.

   Dependency-free: Node built-ins only; PART E runs the REAL app-shell.js in
   a vm sandbox over a tiny fake DOM (mirrors the other tests/portal suites).

   Run: node tests/portal/seamless_nav.test.js
   ========================================================================== */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const STATIC = path.join(
  __dirname, "..", "..",
  "orcha-cli", "orcha_cli", "templates", "portal", "static"
);
const read = (...p) => fs.readFileSync(path.join(STATIC, ...p), "utf8");

const PAGES = [
  "home.html", "agents.html", "tasks.html", "requests.html",
  "settings.html", "onboarding.html",
];
const heads = {};
for (const p of PAGES) heads[p] = read(p).split("</head>")[0];

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log("  ✓ " + msg);
  else { failures++; console.error("  ✗ " + msg); }
}

/* =====================================================================
   PART A — pre-paint: inline bg/fg before any CSS
   ===================================================================== */
console.log("PART A — pre-paint inline background before CSS");

const snippetOf = (head) => {
  const m = head.match(/<script>\(function\(\)\{try\{var d=document\.documentElement[\s\S]*?<\/script>/);
  return m ? m[0] : null;
};
const refSnippet = snippetOf(heads["home.html"]);
assert(!!refSnippet, "home.html head carries the pre-paint snippet");

for (const p of PAGES) {
  const head = heads[p], snip = snippetOf(head);
  assert(snip === refSnippet, p + ": snippet present and byte-identical to home.html");
  if (!snip) continue;
  // line-anchored: the snippet's own explanatory comment mentions the literal
  // string <link rel="stylesheet">, so a plain indexOf would find the comment.
  const firstCss = head.search(/^<link rel="stylesheet"/m);
  assert(firstCss > -1 && head.indexOf(snip) < firstCss,
    p + ": snippet sits BEFORE the first stylesheet link (else it can't beat slow CSS to first paint)");
}

// the snippet's mechanics
assert(refSnippet.includes("d.style.backgroundColor="), "snippet sets an inline background-color on <html>");
assert(refSnippet.includes("d.style.color="), "snippet sets an inline color on <html>");
assert(refSnippet.includes("prefers-color-scheme: light"), "snippet resolves 'auto' via prefers-color-scheme (mirrors the CSS dark default)");
assert(/DOMContentLoaded/.test(refSnippet) && refSnippet.includes("d.style.backgroundColor=''"),
  "snippet clears the inline override once real CSS is live (DOMContentLoaded)");
assert(refSnippet.includes("data-theme") && refSnippet.includes("data-skin") && refSnippet.includes("data-sidebar"),
  "snippet still stamps data-theme / data-skin / data-sidebar (pre-existing contract)");

// hardcoded colors must match the token files (source of truth)
const tokensCss = read("styles", "tokens.css");
// the Swiss skin block lives in the shared skin sheets; parse it from wherever
// it currently sits (conversation.css today, responsive.css once the #191
// split-fragment repair moves it) so this suite doesn't pin a file layout.
const skinCss = read("styles", "responsive.css") + "\n" + read("styles", "conversation.css");
function tokenIn(block, name) {
  const m = block.match(new RegExp("--" + name + ":\\s*(#[0-9a-fA-F]{3,8})"));
  return m ? m[1].toLowerCase() : null;
}
function blockOf(css, selRe) {
  const m = css.match(new RegExp(selRe + "[^{]*\\{([\\s\\S]*?)(?:\\n\\}|$)"));
  return m ? m[1] : "";
}
const expect = {
  classicDark: { bg: tokenIn(blockOf(tokensCss, ':root,\\n\\[data-theme="dark"\\]'), "bg"),
                 fg: tokenIn(blockOf(tokensCss, ':root,\\n\\[data-theme="dark"\\]'), "text") },
  classicLight: { bg: tokenIn(blockOf(tokensCss, '\\n\\[data-theme="light"\\]'), "bg"),
                  fg: tokenIn(blockOf(tokensCss, '\\n\\[data-theme="light"\\]'), "text") },
  swissDark: { bg: tokenIn(blockOf(skinCss, 'html\\[data-skin="swiss"\\],'), "bg"),
               fg: tokenIn(blockOf(skinCss, 'html\\[data-skin="swiss"\\],'), "text") },
  swissLight: { bg: tokenIn(blockOf(skinCss, 'html\\[data-skin="swiss"\\]\\[data-theme="light"\\]'), "bg"),
                fg: tokenIn(blockOf(skinCss, 'html\\[data-skin="swiss"\\]\\[data-theme="light"\\]'), "text") },
};
assert(expect.classicDark.bg && expect.classicLight.bg && expect.swissDark.bg && expect.swissLight.bg,
  "parsed all four --bg values out of the token sheets");
const lower = refSnippet.toLowerCase();
for (const [label, pair] of Object.entries(expect)) {
  assert(pair.bg && lower.includes("'" + pair.bg + "'"), `snippet hardcodes the ${label} --bg (${pair.bg})`);
  assert(pair.fg && lower.includes("'" + pair.fg + "'"), `snippet hardcodes the ${label} --text (${pair.fg})`);
}

/* =====================================================================
   PART B — self-hosted fonts
   ===================================================================== */
console.log("PART B — self-hosted fonts, Google origins gone");

for (const p of PAGES) {
  const html = read(p);
  assert(!/fonts\.googleapis\.com|fonts\.gstatic\.com/.test(html), p + ": no fonts.googleapis/gstatic reference");
  assert(html.includes('<link rel="stylesheet" href="/assets/styles/fonts.css">'), p + ": links /assets/styles/fonts.css");
  const head = heads[p];
  assert(head.indexOf("/assets/styles/fonts.css") < head.indexOf("/assets/styles/tokens.css"),
    p + ": fonts.css loads before tokens.css (tokens references the families)");
}

const fontsCss = read("styles", "fonts.css");
for (const fam of ["Inter", "JetBrains Mono", "Space Grotesk"]) {
  assert(fontsCss.includes(`font-family: "${fam}"`), `fonts.css declares @font-face for ${fam}`);
}
const faces = fontsCss.split("@font-face").slice(1);
assert(faces.length >= 6 && faces.every((f) => /font-display:\s*swap/.test(f)),
  "every @font-face uses font-display: swap (text stays visible while fonts stream)");
const srcs = [...fontsCss.matchAll(/url\("(\/assets\/fonts\/[^"]+\.woff2)"\)/g)].map((m) => m[1]);
assert(srcs.length >= 6, "fonts.css references at least 6 woff2 files (latin + latin-ext x 3 families), found " + srcs.length);
for (const src of srcs) {
  const file = path.join(STATIC, src.replace("/assets/", ""));
  const ok = fs.existsSync(file) && fs.readFileSync(file).slice(0, 4).toString("latin1") === "wOF2";
  assert(ok, src + " exists in static/ and has the woff2 magic");
}

/* =====================================================================
   PART C — speculation rules (prerender)
   ===================================================================== */
console.log("PART C — speculation rules on every page");

for (const p of PAGES) {
  const head = heads[p];
  const m = head.match(/<script type="speculationrules">\s*([\s\S]*?)\s*<\/script>/);
  assert(!!m, p + ": carries a speculationrules script in <head>");
  if (!m) continue;
  let rules = null;
  try { rules = JSON.parse(m[1]); } catch (e) {}
  assert(!!rules, p + ": speculationrules payload is valid JSON");
  if (!rules) continue;
  const rule = (rules.prerender || [])[0] || {};
  assert(rule.eagerness === "moderate", p + ": prerender eagerness is 'moderate' (hover/pointer-down)");
  const and = (rule.where && rule.where.and) || [];
  assert(and.some((c) => c.href_matches === "/*"), p + ": document rule matches same-origin links incl. ?cid= queries");
  for (const excl of ["/api/*", "/assets/*"]) {
    assert(and.some((c) => c.not && c.not.href_matches === excl), p + `: excludes ${excl} from prerender`);
  }
}

/* =====================================================================
   PART D — cross-document view transitions
   ===================================================================== */
console.log("PART D — view transitions in tokens.css");

assert(/@view-transition\s*\{\s*navigation:\s*auto;?\s*\}/.test(tokensCss),
  "tokens.css opts into cross-document view transitions (navigation: auto)");
assert(/::view-transition-old\(root\),\s*\n?::view-transition-new\(root\)\s*\{\s*animation-duration:\s*120ms/.test(tokensCss),
  "root cross-fade is fast (120ms) — a nav aid, not an animation showcase");
assert(/@media \(prefers-reduced-motion: reduce\)\s*\{\s*@view-transition\s*\{\s*navigation:\s*none;?\s*\}/.test(tokensCss),
  "prefers-reduced-motion gets navigation: none (instant swap)");
for (const p of PAGES) {
  assert(heads[p].includes("/assets/styles/tokens.css"), p + ": loads tokens.css (so the opt-in applies on both nav endpoints)");
}

/* =====================================================================
   PART E — primed shell (real app-shell.js in a vm sandbox)
   ===================================================================== */
console.log("PART E — primeShell restores cached chrome before data");

const APP_STATE_JS = read("modules", "app-state.js");
const APP_SHELL_JS = read("modules", "app-shell.js");
assert(/saveShellCache\(\);\s*\}/.test(APP_SHELL_JS.slice(APP_SHELL_JS.indexOf("function mountShell"))),
  "mountShell persists its render via saveShellCache()");

function makeNode(id) {
  const n = {
    id: id || "", _html: "", _listeners: {}, style: {},
    get innerHTML() { return n._html; },
    set innerHTML(v) { n._html = v == null ? "" : String(v); },
    get firstChild() { return n._html ? {} : null; },
    setAttribute: () => {}, getAttribute: () => null,
    addEventListener: (ev, fn) => { (n._listeners[ev] = n._listeners[ev] || []).push(fn); },
    appendChild: () => {},
    classList: { add: () => {}, remove: () => {}, toggle: () => {} },
  };
  return n;
}
function makeSandbox({ store = {}, pathname = "/tasks", search = "?cid=proj1", ids = {} } = {}) {
  const byId = {};
  for (const [k, v] of Object.entries(ids)) byId[k] = v;
  const documentElement = makeNode("html");
  const document = {
    documentElement, body: makeNode("body"),
    getElementById: (id) => byId[id] || null,
    createElement: () => makeNode(""),
    addEventListener: () => {},
  };
  const localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  };
  const sandbox = {
    window: { matchMedia: () => ({ matches: false }) },
    document, localStorage, console, URLSearchParams,
    location: { pathname, search },
    setTimeout: () => 0, clearTimeout: () => {}, fetch: () => Promise.resolve({ ok: false }),
  };
  sandbox.globalThis = sandbox;
  sandbox.window.document = document;
  sandbox.window.localStorage = localStorage;
  vm.createContext(sandbox);
  vm.runInContext(APP_STATE_JS, sandbox);
  vm.runInContext(APP_SHELL_JS, sandbox);
  return { sandbox, store, byId };
}

// E1: cached chrome for this (cid, page) is restored synchronously at load
{
  const side = makeNode("sidebar"), top = makeNode("topbar"), sbT = makeNode("sbToggle");
  const cached = JSON.stringify({ side: "<nav>cached-side</nav>", top: "<div>cached-top</div>" });
  const { } = makeSandbox({
    store: { "orcha:shellHtml:proj1:tasks": cached },
    ids: { sidebar: side, topbar: top, sbToggle: sbT },
  });
  assert(side.innerHTML === "<nav>cached-side</nav>", "sidebar markup restored from the cache at script load");
  assert(top.innerHTML === "<div>cached-top</div>", "topbar markup restored from the cache at script load");
  assert((sbT._listeners.click || []).length === 1, "collapse toggle is wired pre-data (browser-local state only)");
}

// E2: no cache -> chrome untouched, no crash (first-ever visit behaves as before)
{
  const side = makeNode("sidebar"), top = makeNode("topbar");
  makeSandbox({ store: {}, ids: { sidebar: side, topbar: top } });
  assert(side.innerHTML === "" && top.innerHTML === "", "no cache: sidebar/topbar stay empty until the real mount");
}

// E3: an already-mounted shell is never clobbered by the primer
{
  const side = makeNode("sidebar"), top = makeNode("topbar");
  side.innerHTML = "<nav>live</nav>"; top.innerHTML = "<div>live</div>";
  makeSandbox({
    store: { "orcha:shellHtml:proj1:tasks": JSON.stringify({ side: "stale", top: "stale" }) },
    ids: { sidebar: side, topbar: top },
  });
  assert(side.innerHTML === "<nav>live</nav>", "primer never overwrites an already-rendered sidebar");
}

// E4: cache key is per (cid, page) — another container's cache never leaks in
{
  const side = makeNode("sidebar"), top = makeNode("topbar");
  makeSandbox({
    store: { "orcha:shellHtml:OTHER:tasks": JSON.stringify({ side: "wrong-cid", top: "wrong-cid" }) },
    ids: { sidebar: side, topbar: top },
  });
  assert(side.innerHTML === "", "a different container's cached chrome is not restored");
}

// E5: saveShellCache writes the current chrome under the derived key
{
  const side = makeNode("sidebar"), top = makeNode("topbar");
  const { sandbox, store } = makeSandbox({ store: {}, ids: { sidebar: side, topbar: top } });
  side.innerHTML = "<nav>fresh</nav>"; top.innerHTML = "<div>fresh</div>";
  vm.runInContext("saveShellCache()", sandbox);
  const saved = JSON.parse(store["orcha:shellHtml:proj1:tasks"] || "null");
  assert(!!saved && saved.side === "<nav>fresh</nav>" && saved.top === "<div>fresh</div>",
    "saveShellCache persists sidebar+topbar under orcha:shellHtml:<cid>:<page>");
}

// E6: bare "/" maps to the home cache key (pathname -> page normalisation)
{
  const side = makeNode("sidebar"), top = makeNode("topbar");
  makeSandbox({
    pathname: "/", search: "?cid=proj1",
    store: { "orcha:shellHtml:proj1:home": JSON.stringify({ side: "home-side", top: "home-top" }) },
    ids: { sidebar: side, topbar: top },
  });
  assert(side.innerHTML === "home-side", "'/' primes from the home cache entry");
}

/* ---- summary --------------------------------------------------------- */
if (failures) { console.error(`\n${failures} assertion(s) FAILED`); process.exit(1); }
console.log("\nAll seamless-nav assertions passed.");
