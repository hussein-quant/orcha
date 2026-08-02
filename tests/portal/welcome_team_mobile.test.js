/* ============================================================================
   Welcome-page chapter 5 — "team-mobile" (.mw- prefix) fragment tests.

   Dependency-free: loads sections/demo-team-mobile.html with fs and asserts
   its static shape only (this fragment is not yet wired into index.html —
   the integrator owns assembly). Mirrors the pattern used across the other
   welcome_*.test.js chapter tests: plain assert() with a ✓/✗ log line per
   check, so a future `delete a scene` / `rename the prefix` mutation goes RED.

   Run:  node tests/portal/welcome_team_mobile.test.js
   ========================================================================== */
const fs = require("fs");
const path = require("path");

const FRAGMENT = path.join(__dirname, "..", "..", "deploy", "auth", "welcome", "sections", "demo-team-mobile.html");
const HTML = fs.readFileSync(FRAGMENT, "utf8");

let failures = 0;
function assert(cond, msg) {
  if (cond) { console.log("  ✓ " + msg); }
  else { failures++; console.error("  ✗ " + msg); }
}

console.log("shape:");

/* ---- scene count + data-scene attrs -------------------------------------- */
// Mutation note: delete any one <div class="fw-scene ..." data-scene="N"> block
// (or renumber the sequence) and this goes RED.
const sceneEls = [...HTML.matchAll(/class="mw-scene[^"]*"\s+data-scene="(\d)"/g)];
assert(sceneEls.length === 5, "exactly five scenes (found " + sceneEls.length + ")");
assert(
  sceneEls.map((m) => m[1]).join(",") === "0,1,2,3,4",
  "data-scene attrs are 0..4 in order (" + sceneEls.map((m) => m[1]).join(",") + ")"
);
assert(/class="mw-scene mw-on" data-scene="0"/.test(HTML), "scene 0 starts in the on state");

/* ---- section id + heading ------------------------------------------------- */
assert(HTML.includes('id="demo-team-mobile"'), "section id is demo-team-mobile");
assert(HTML.includes('id="mw-title"'), "heading id is mw-title");

/* ---- class prefix hygiene -------------------------------------------------- */
// Mutation note: rename .mw- to anything else and the prefix-presence check
// goes RED; introduce a bare "dm-"/"ph-"/"cw-"/"aw-"/"tw-"/"rw-"/"fw-" class
// (another chapter's prefix) and the isolation check goes RED.
assert(/class="[^"]*\bmw-root\b/.test(HTML), ".mw-root prefix class is present");
const classAttrs = [...HTML.matchAll(/class="([^"]+)"/g)].map((m) => m[1]);
const allClasses = new Set();
classAttrs.forEach((c) => c.split(/\s+/).forEach((cls) => cls && allClasses.add(cls)));
const nonMwClasses = [...allClasses].filter((c) => c !== "mk-section" && !c.startsWith("mw-"));
assert(nonMwClasses.length === 0, "every class is either mk-section or mw--prefixed (stray: " + nonMwClasses.join(", ") + ")");

// Check actual class TOKENS (split on whitespace), not substrings, so this
// chapter's own "mw-ph-*" (phone-mockup) classes don't false-positive against
// chapter 5's phone-hardware namesake "ph-" prefix used by mobile.html.
const otherChapterPrefixes = ["dm-", "ph-", "cw-", "aw-", "tw-", "rw-", "fw-"];
const leaked = otherChapterPrefixes.filter((p) => [...allClasses].some((cls) => cls.startsWith(p)));
assert(leaked.length === 0, "no other chapter's class prefix present (found: " + leaked.join(", ") + ")");

// CSS rules should also be scoped: every selector-looking token starting with
// a bare element or :root is disallowed; every rule lives under .mw-.
const styleMatch = HTML.match(/<style>([\s\S]*?)<\/style>/);
assert(!!styleMatch, "fragment carries its own <style> block");
const css = styleMatch[1];
assert(!/:root/.test(css), "no :root additions in the fragment's CSS");
assert(!/^\s*(html|body)\s*\{/m.test(css), "no bare html/body element selectors");

/* ---- key copy strings (spec S1-S5) ----------------------------------------- */
assert(HTML.includes("Who&rsquo;s on this project"), "S1: members panel heading");
assert(
  /Members map verified GitHub identities to this workspace;\s*owners\s*can invite collaborators, change roles, and assign task reviewers/.test(HTML),
  "S1: members blurb"
);
assert(HTML.includes("sam-dev"), "S1: collaborator sam-dev present");
assert(HTML.includes("GitHub username to invite"), "S1: invite placeholder copy");
assert(HTML.includes("Invited members appear as pending until they first sign in"), "S1: fine print");
assert(HTML.includes("perimeter allowlist"), "S1: fine print mentions perimeter allowlist");
assert(HTML.includes("jamie-ml"), "S2: invited username jamie-ml");
assert(HTML.includes("pending"), "S2: pending status present");
assert(HTML.includes("Roles + fine-grained grants"), "S2: roles/grants caption");
assert(HTML.includes("Pair the Orcha mobile app with this workspace"), "S3: pairing panel heading");
assert(HTML.includes("Needs you: verify task 41"), "S4: push notification copy");
assert(HTML.includes("needs_verification"), "S4: needs_verification chip text");
assert(HTML.includes("verified"), "S4: verified chip text");
assert(HTML.includes("Your whole team, web and pocket"), "S5: close line");
assert(HTML.includes("Same queue, same gates, same theme"), "S5: close subline");

/* ---- fiction rule ----------------------------------------------------------- */
assert(!/quantal-labs\/orcha|dana-okafor|hussein\b/i.test(HTML), "no leftover names from the old demo.html fiction set");

/* ---- no external refs except the allowed GitHub link ----------------------- */
const absRefs = (HTML.match(/(?:src|href)="https?:\/\/[^"]+"/g) || []).filter(
  (h) => !h.startsWith('href="https://github.com/open-orcha/orcha')
);
assert(absRefs.length === 0, "no non-navigational absolute URLs (" + absRefs.join(", ") + ")");
assert(!/<link[^>]+rel="stylesheet"/.test(HTML), "no external stylesheets");
assert(!/<script[^>]+src=/.test(HTML), "no external <script src>");
assert(!/url\(\s*['"]?https?:/.test(HTML), "no remote url() resources");
assert(!/@import/.test(HTML), "no CSS @import");
assert(!/data:[a-z]+\/[a-z]/i.test(HTML), "no data: URIs");

/* ---- player pattern --------------------------------------------------------- */
assert(HTML.includes("IntersectionObserver"), "uses IntersectionObserver for autoplay-on-view");
assert(HTML.includes("prefers-reduced-motion"), "respects prefers-reduced-motion");
assert(HTML.includes("__mwInit"), "has a self-init guard so multiple players can coexist");
assert(HTML.includes('id="mw-dots"'), "has a dot step rail");
assert(HTML.includes('id="mw-play"') && HTML.includes('id="mw-prev"') && HTML.includes('id="mw-next"'), "has play/prev/next controls");

/* ---- size budget ------------------------------------------------------------- */
const bytes = Buffer.byteLength(HTML);
assert(bytes <= 38 * 1024, "fragment stays ≤ 38 KB (" + (bytes / 1024).toFixed(2) + " KB)");

console.log("\n" + (Buffer.byteLength(HTML) / 1024).toFixed(2) + " KB total");

if (failures) { console.error("\n" + failures + " failure(s)"); process.exit(1); }
console.log("\nall assertions passed");
