/* ============================================================================
   Welcome-page demo section — ASSEMBLY test (post six-chapter refresh).

   Replaces the pre-refresh version of this file, which pinned the single
   9-scene ".scene"/.rstep" cinematic that sections/demo.html used to contain.
   That structure is gone: sections/demo.html is now a thin chapter shell
   (heading + chapter nav only) and the six chapter cinematics
   (demo-fleet / demo-control-room / demo-agent-chat / demo-task-verify /
   demo-requests-metrics / demo-team-mobile) are separate fragments the
   integrator wires into deploy/auth/welcome/index.template.html via their
   own @section markers, assembled by build.py into index.html. Per-chapter
   shape is covered by tests/portal/welcome_<chapter>.test.js; this file
   checks the ASSEMBLED page: chapter order, the chapter-nav chips, the
   self-containment guards, the oauth link shape, and a total-size budget.

   Dependency-free: plain assert() with a ✓/✗ log line per check, matching
   the house style of the per-chapter tests.

   Run:  node tests/portal/welcome_demo.test.js
   ========================================================================== */
const fs = require("fs");
const path = require("path");

const PAGE = path.join(__dirname, "..", "..", "deploy", "auth", "welcome", "index.html");
const HTML = fs.readFileSync(PAGE, "utf8");

let failures = 0;
function assert(cond, msg) {
  if (cond) { console.log("  ✓ " + msg); }
  else { failures++; console.error("  ✗ " + msg); }
}

/* ---- six chapters present, in order -------------------------------------
   Mutation note: reorder any two chapter <section>s (or delete one) and the
   ordering assertion below goes RED — "fleet=Overview" must lead, and the
   remaining five follow the chapter-nav order: control room -> chat ->
   the gate -> requests & cost -> team & mobile. */
console.log("assembly:");

const CHAPTERS = [
  { id: "demo-fleet", root: "fw-root" },
  { id: "control-room", root: "cw-root" },
  { id: "agent-chat", root: "aw-root" },
  { id: "task-verify", root: "tw-root" },
  { id: "demo-requests-metrics", root: "rw-root" },
  { id: "demo-team-mobile", root: "mw-root" },
];

assert(HTML.includes('id="demo"'), "the shell section (id=demo) is present");

const positions = CHAPTERS.map((c) => {
  const re = new RegExp('<section id="' + c.id + '"[^>]*class="[^"]*\\b' + c.root + '\\b');
  const m = HTML.match(re);
  assert(!!m, "chapter present: id=" + c.id + " with class " + c.root);
  return m ? m.index : -1;
});

const shellPos = HTML.indexOf('id="demo"');
assert(shellPos !== -1 && shellPos < positions[0], "shell (id=demo) precedes the first chapter (demo-fleet)");

let inOrder = true;
for (let i = 1; i < positions.length; i++) {
  if (positions[i] <= positions[i - 1]) inOrder = false;
}
assert(inOrder, "chapters appear in spec order: fleet(Overview), control-room, agent-chat, task-verify, requests-metrics, team-mobile");

/* ---- chapter-nav chips ---------------------------------------------------- */
console.log("chapter nav:");
assert(/<nav class="dm-chapternav"/.test(HTML), "chapter nav element present in the shell");
const navChips = [
  ['href="#demo-fleet"', "Overview"],
  ['href="#control-room"', "Control room"],
  ['href="#agent-chat"', "Chat"],
  ['href="#task-verify"', "The gate"],
  ['href="#demo-requests-metrics"', "Requests &amp; cost"],
  ['href="#demo-team-mobile"', "Team &amp; mobile"],
];
navChips.forEach(([href, label]) => {
  const re = new RegExp('<a class="dm-chip" ' + href.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + '>' + label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + '</a>');
  assert(re.test(HTML), "chapter-nav chip: " + href + " -> \"" + label + "\"");
});

/* ---- all six players' init guards present --------------------------------- */
console.log("players:");
["__fwInit", "__cwInit", "__awInit", "__twInit", "__rwInit", "__mwInit"].forEach((guard) => {
  assert(HTML.includes(guard), "self-init guard present: " + guard);
});

/* ---- each chapter's class prefix appears (and mobile's ph- survives) ------ */
["dm-", "fw-", "cw-", "aw-", "tw-", "rw-", "mw-", "ph-"].forEach((prefix) => {
  assert(new RegExp('class="[^"]*\\b' + prefix + 'root\\b').test(HTML), "prefix present: ." + prefix + "root");
});

/* ---- nav tabs unchanged ----------------------------------------------------- */
console.log("nav / links:");
const NAV_TABS = ['#demo', '#product', '#mobile', '#deploy', '#themes', '#opensource'];
NAV_TABS.forEach((href) => {
  assert(new RegExp('<a class="mk-tab" role="listitem" href="' + href + '"').test(HTML), "top nav tab unchanged: " + href);
});

/* ---- sign-in links exact shape ---------------------------------------------- */
const oauthLinks = HTML.match(/href="\/oauth2\/start[^"]*"/g) || [];
assert(oauthLinks.length > 0, "at least one sign-in link present");
assert(oauthLinks.every((h) => h === 'href="/oauth2/start?rd=%2F"'), "every sign-in link is exactly /oauth2/start?rd=%2F (" + [...new Set(oauthLinks)].join(", ") + ")");

/* ---- self-containment: only external link is github.com/open-orcha/orcha --- */
const absRefs = (HTML.match(/(?:src|href)="https?:\/\/[^"]+"/g) || []).filter(
  (h) => !h.startsWith('href="https://github.com/open-orcha/orcha')
);
assert(absRefs.length === 0, "no absolute URLs beyond the GitHub link (" + absRefs.join(", ") + ")");
assert((HTML.match(/href="https:\/\/github\.com\/open-orcha\/orcha/g) || []).length > 0, "the allowed GitHub link is present");
assert(!/<link[^>]+rel="stylesheet"/.test(HTML), "no external stylesheets");
assert(!/<script[^>]+src=/.test(HTML), "no external <script src>");
assert(!/url\(\s*['"]?https?:/.test(HTML), "no remote url() resources");
assert(!/@import/.test(HTML), "no CSS @import");
// data: URIs are allowed only for the inlined SVG favicon.
const dataUris = HTML.match(/(?:src|href)="data:[a-z]+\/[a-z+.-]+[^"]*"/gi) || [];
assert(dataUris.every((u) => u.startsWith('href="data:image/svg+xml')), "the only data: URIs are the inline SVG favicon (" + dataUris.length + " found)");

/* ---- fonts block intact ------------------------------------------------------ */
console.log("fonts:");
assert((HTML.match(/@font-face/g) || []).length === 4, "all four @font-face declarations present (Fraunces x2, Hanken Grotesk, Geist Mono)");
["fraunces-var.woff2", "fraunces-italic-var.woff2", "hanken-var.woff2", "geistmono-var.woff2"].forEach((f) => {
  assert(HTML.includes("/welcome/fonts/" + f), "self-hosted font referenced: " + f);
});

/* ---- no duplicate ids across the assembled page ------------------------------ */
console.log("hygiene:");
const ids = [...HTML.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
const idCounts = {};
ids.forEach((id) => { idCounts[id] = (idCounts[id] || 0) + 1; });
const dupIds = Object.keys(idCounts).filter((id) => idCounts[id] > 1);
assert(dupIds.length === 0, "no duplicate element ids in the assembled page (dupes: " + dupIds.join(", ") + ")");

/* ---- total-size budget: measured assembled size + 10% headroom ------------- */
// Mutation note: bloating any fragment (or re-adding an external asset) past
// the budget below goes RED. Budget = measured assembled size at refresh time
// (384,056 bytes) + 10% headroom, i.e. ceil(384056 * 1.10) = 422,462 bytes.
console.log("size:");
const MEASURED_AT_REFRESH = 384056;
const BUDGET = Math.ceil(MEASURED_AT_REFRESH * 1.10);
const bytes = Buffer.byteLength(HTML);
assert(bytes <= BUDGET, "assembled page stays within budget: " + bytes + " <= " + BUDGET + " bytes (" + (bytes / 1024).toFixed(1) + " KB / " + (BUDGET / 1024).toFixed(1) + " KB budget)");

console.log("\n" + (bytes / 1024).toFixed(1) + " KB total (index.html)");

if (failures) { console.error("\n" + failures + " failure(s)"); process.exit(1); }
console.log("\nall assertions passed");
