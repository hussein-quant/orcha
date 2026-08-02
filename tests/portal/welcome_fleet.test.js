/* ============================================================================
   Welcome-page chapter 6 — "fleet-cinematic" (.fw- prefix) fragment tests.

   Dependency-free: loads sections/demo-fleet.html with fs and asserts its
   static shape (this fragment is not yet wired into index.html — the
   integrator owns assembly + the shell nav that will make it the hero demo).
   Mirrors welcome_team_mobile.test.js: plain assert() with a ✓/✗ log line
   per check, so a future `delete a scene` / `rename the prefix` mutation
   goes RED.

   Run:  node tests/portal/welcome_fleet.test.js
   ========================================================================== */
const fs = require("fs");
const path = require("path");

const FRAGMENT = path.join(__dirname, "..", "..", "deploy", "auth", "welcome", "sections", "demo-fleet.html");
const HTML = fs.readFileSync(FRAGMENT, "utf8");

let failures = 0;
function assert(cond, msg) {
  if (cond) { console.log("  ✓ " + msg); }
  else { failures++; console.error("  ✗ " + msg); }
}

console.log("shape:");

/* ---- scene count + data-scene attrs -------------------------------------- */
// Mutation note: delete any one <div class="fw-scene ..." data-scene="N"> block
// (or renumber the sequence) and this goes RED — the tightened 6-scene spine
// (dispatch -> sandbox -> work+diff -> PR+needs_verification -> verify+merge
// -> close) is the whole point of this chapter's rewrite.
const sceneEls = [...HTML.matchAll(/class="fw-scene[^"]*"\s+data-scene="(\d)"/g)];
assert(sceneEls.length === 6, "exactly six scenes (found " + sceneEls.length + ")");
assert(
  sceneEls.map((m) => m[1]).join(",") === "0,1,2,3,4,5",
  "data-scene attrs are 0..5 in order (" + sceneEls.map((m) => m[1]).join(",") + ")"
);
assert(/class="fw-scene fw-on" data-scene="0"/.test(HTML), "scene 0 starts in the on state");

/* ---- section id + heading -------------------------------------------------- */
assert(HTML.includes('id="demo-fleet"'), "section id is demo-fleet");
assert(HTML.includes('id="fw-title"'), "heading id is fw-title");

/* ---- class prefix hygiene --------------------------------------------------- */
// Mutation note: rename .fw- to anything else and the prefix-presence check
// goes RED; introduce another chapter's prefix and the isolation check goes RED.
assert(/class="[^"]*\bfw-root\b/.test(HTML), ".fw-root prefix class is present");
const classAttrs = [...HTML.matchAll(/class="([^"]+)"/g)].map((m) => m[1]);
const allClasses = new Set();
classAttrs.forEach((c) => c.split(/\s+/).forEach((cls) => cls && allClasses.add(cls)));
const nonFwClasses = [...allClasses].filter((c) => c !== "mk-section" && !c.startsWith("fw-"));
assert(nonFwClasses.length === 0, "every class is either mk-section or fw--prefixed (stray: " + nonFwClasses.join(", ") + ")");

const otherChapterPrefixes = ["dm-", "ph-", "cw-", "aw-", "tw-", "rw-", "mw-"];
const leaked = otherChapterPrefixes.filter((p) => [...allClasses].some((cls) => cls.startsWith(p)));
assert(leaked.length === 0, "no other chapter's class prefix present (found: " + leaked.join(", ") + ")");

const styleMatch = HTML.match(/<style>([\s\S]*?)<\/style>/);
assert(!!styleMatch, "fragment carries its own <style> block");
const css = styleMatch[1];
assert(!/:root/.test(css), "no :root additions in the fragment's CSS");
assert(!/^\s*(html|body)\s*\{/m.test(css), "no bare html/body element selectors");

/* ---- key copy strings (spec S1-S6, incl. verbatim lines kept from demo.html) */
assert(HTML.includes("acme-labs/acme-ehr"), "fiction project repo acme-labs/acme-ehr");
assert(HTML.includes("#41"), "task/PR number #41 (small, per fiction rule)");
assert(HTML.includes("fresh container") && HTML.includes("capped") && HTML.includes(">non-root<") && HTML.includes("reaped after run"), "S2: sandbox chips fresh container / capped / non-root / reaped");
assert(
  HTML.includes("Every agent wake runs in a <b>fresh Docker container</b> — capped, non-root, reaped after the run."),
  "S2: kept verbatim line about fresh Docker containers"
);
assert(HTML.includes("orcha-cloud[bot]"), "S4: bot identity orcha-cloud[bot]");
assert(
  HTML.includes("Agents push as the app bot — <b>zero human credentials in the container</b>. Tokens last one hour and auto-rotate."),
  "S4: kept verbatim line about zero human credentials"
);
assert(HTML.includes("needs_verification"), "S4: needs_verification chip text");
assert(HTML.includes("never self-certify"), "S4/S5: never self-certify language present");
assert(
  HTML.includes("Agents stop at <b>needs_verification</b> and <b>never self-certify</b> — the merge is always a human decision."),
  "S5: kept verbatim line about needs_verification / human merge decision"
);
assert(HTML.includes("The merge was yours"), "S6: close line 'The merge was yours'");
assert(/\$0\.87/.test(HTML), "S6: cost metric $0.87");
assert(/\b11m\b/.test(HTML), "S6: duration metric 11m");
assert(HTML.includes("reaped"), "S6: sandbox reaped metric");

/* ---- fiction rule ------------------------------------------------------------ */
assert(!/quantal-labs\/orcha|dana-okafor|\bhussein\b|session_test\.py/i.test(HTML), "no leftover names/paths from the old 9-scene demo.html fiction set");

/* ---- no external refs except the allowed GitHub link ------------------------ */
const absRefs = (HTML.match(/(?:src|href)="https?:\/\/[^"]+"/g) || []).filter(
  (h) => !h.startsWith('href="https://github.com/open-orcha/orcha')
);
assert(absRefs.length === 0, "no non-navigational absolute URLs (" + absRefs.join(", ") + ")");
assert(!/<link[^>]+rel="stylesheet"/.test(HTML), "no external stylesheets");
assert(!/<script[^>]+src=/.test(HTML), "no external <script src>");
assert(!/url\(\s*['"]?https?:/.test(HTML), "no remote url() resources");
assert(!/@import/.test(HTML), "no CSS @import");
assert(!/data:[a-z]+\/[a-z]/i.test(HTML), "no data: URIs");

/* ---- player pattern ----------------------------------------------------------- */
assert(HTML.includes("IntersectionObserver"), "uses IntersectionObserver for autoplay-on-view");
assert(HTML.includes("prefers-reduced-motion"), "respects prefers-reduced-motion");
assert(HTML.includes("__fwInit"), "has a self-init guard so multiple players can coexist");
assert(HTML.includes('id="fw-dots"'), "has a dot step rail");
assert(HTML.includes('id="fw-play"') && HTML.includes('id="fw-prev"') && HTML.includes('id="fw-next"'), "has play/prev/next controls");
assert(/<use href="#fw-i-(check|propen|prmerged)"\/>/.test(HTML), "reuses a local <symbol>/<use> icon sprite (self-contained, no external refs)");

/* ---- size budget --------------------------------------------------------------- */
const bytes = Buffer.byteLength(HTML);
assert(bytes <= 38 * 1024, "fragment stays ≤ 38 KB (" + (bytes / 1024).toFixed(2) + " KB)");

console.log("\n" + (Buffer.byteLength(HTML) / 1024).toFixed(2) + " KB total");

if (failures) { console.error("\n" + failures + " failure(s)"); process.exit(1); }
console.log("\nall assertions passed");
