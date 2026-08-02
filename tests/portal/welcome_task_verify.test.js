/* ============================================================================
   Welcome-page chapter 3 — "task / verify" cinematic (the spine) — static +
   behavioral assertions.

   deploy/auth/welcome/sections/demo-task-verify.html is a self-contained
   fragment (own <style> + <script>, prefix tw-) assembled verbatim into
   index.html by build.py. It must stay fully self-contained: no external
   scripts/styles/fonts/images beyond the page's self-hosted fonts, no
   absolute links except the allowed GitHub App link, exactly five scenes,
   and a player that auto-advances, pauses on manual navigation, and resumes.

   Dependency-free, mirroring welcome_control_room.test.js / theme_cycle.test.js:
   the fragment's inline player script runs in a vm sandbox against a minimal
   DOM stub with a hand-cranked requestAnimationFrame clock.

   Run:  node tests/portal/welcome_task_verify.test.js
   ========================================================================== */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const FRAGMENT = path.join(__dirname, "..", "..", "deploy", "auth", "welcome", "sections", "demo-task-verify.html");
const HTML = fs.readFileSync(FRAGMENT, "utf8");

let failures = 0;
function assert(cond, msg) {
  if (cond) { console.log("  ✓ " + msg); }
  else { failures++; console.error("  ✗ " + msg); }
}

/* ---- static shape ---------------------------------------------------------
   Mutation note: delete any of the five `data-scene="N"` scene <div>s (or the
   matching STEPS[] entry in the script) and the scene-count / dots-vs-STEPS
   assertions below go RED. */
console.log("static:");

const SIZE_BYTES = Buffer.byteLength(HTML);
assert(SIZE_BYTES <= 38 * 1024, "fragment stays under the 38 KB budget (" + (SIZE_BYTES / 1024).toFixed(2) + " KB)");

assert(HTML.startsWith('<section id="task-verify" class="mk-section tw-root"'), "root section carries id=task-verify and class tw-root");

const sceneMatches = [...HTML.matchAll(/class="tw-scene[^"]*"\s+data-scene="(\d)"/g)];
assert(sceneMatches.length === 5, "exactly five tw-scene elements (found " + sceneMatches.length + ")");
assert(sceneMatches.map((m) => m[1]).join(",") === "0,1,2,3,4", "data-scene attrs are 0,1,2,3,4 in order");

// prefix isolation: every class token in the fragment is tw-*, mk-section (the
// shared shell class every fragment carries), or a bare SVG/util token — and
// no sibling chapter's prefix (cw-/aw-/rw-/mw-/fw-/dm-) leaks in.
const classTokens = new Set();
for (const m of HTML.matchAll(/class="([^"]*)"/g)) {
  m[1].split(/\s+/).filter(Boolean).forEach((t) => classTokens.add(t));
}
const nonTw = [...classTokens].filter((t) => t !== "mk-section" && !t.startsWith("tw-"));
assert(nonTw.length === 0, "every non-shell class is tw-prefixed (stray: " + nonTw.join(", ") + ")");
assert(HTML.includes("tw-root") && HTML.includes("tw-scene") && HTML.includes("tw-theater"), "tw- prefix present throughout");
for (const other of ["cw-", "aw-", "rw-", "mw-", "fw-", "dm-"]) {
  assert(!classTokens.has(other.slice(0, -1)) && ![...classTokens].some((t) => t.startsWith(other)), "no " + other + " (sibling chapter) classes present");
}

assert(!/<script[^>]+src=/.test(HTML), "no external <script src>");
assert(!/<link[^>]/.test(HTML), "no external stylesheet/asset <link>");
assert(!/<img[^>]/.test(HTML), "no <img> elements");
assert(!/url\(\s*['"]?data:/.test(HTML), "no data URIs");
assert(!/url\(\s*['"]?https?:/.test(HTML), "no remote url() resources");
assert(!/@import/.test(HTML), "no CSS @import");
const absRefs = (HTML.match(/(?:src|href)="https?:\/\/[^"]+"/g) || []).filter((h) => !h.startsWith('href="https://github.com/'));
assert(absRefs.length === 0, "no non-navigational absolute URLs (" + absRefs.join(", ") + ")");
assert(!/:root\s*\{/.test(HTML), "no :root additions (fragment scopes tokens under .tw-root)");

/* ---- key copy strings (real Tasks screen recreation, spec fiction rule) --- */
console.log("copy:");
const copyStrings = [
  "acme-health",
  "IN PROGRESS (4)",
  "READY (6)",
  "CRITICAL: tenant eligibility gate bypassed by raw data router",
  "IN PROGRESS",
  "Priority 1",
  "Forge",
  "reviewer sam-dev",
  "Definition of done",
  "The eligibility checks are enforced on EVERY authenticated path",
  "pending, suspended, and inactive tenant receives a generic 403",
  "PR opened,",
  "fresh-session review run, NOT merged without human review",
  "Protocol",
  "open PR only; never merge; stop for human review",
  "REVIEW CHAIN",
  "fresh-session review, then human (you)",
  "final approver",
  "AUTONOMY",
  "pytest tests/tenant_gate",
  "3 failed",
  "214 passed",
  "code diff",
  "module_guard.ts",
  "checkEligibility",
  "Forge opened PR #41 as the app bot",
  "needs_verification",
  "Agents stop here",
  "never self-certify",
  "fresh-session review: gate enforced on all 6 paths",
  "sam-dev",
  "approved",
  "Merge pull request",
  "Merged by you",
  "verified",
  "$0.87",
  "11m",
  "reaped",
  "The merge was yours",
];
for (const s of copyStrings) {
  assert(HTML.includes(s), "contains copy: " + JSON.stringify(s));
}
// fiction rule: no real customer/project names or production fixtures leak in
for (const forbidden of ["quantal-labs/orcha", "orcha-cloud[bot]", "dana-okafor", "hussein"]) {
  assert(!HTML.includes(forbidden), "does not leak sibling-fixture/production name: " + forbidden);
}

/* ---- player behavior -------------------------------------------------------
   Mutation note: change a STEPS[].ms dwell to 0 or remove the setScene()
   wrap-around modulo and the auto-advance / loop assertions below go RED. */
const scripts = [...HTML.matchAll(/<script>([\s\S]*?)<\/script>/g)];
assert(scripts.length === 1, "exactly one inline <script> block");
const SRC = scripts[0][1];
assert(SRC.includes("STEPS"), "found the inline player script");
assert(SRC.includes("window.__twInit"), "self-init guard present so multiple chapter players can coexist");

function makeEl(over) {
  const classes = new Set();
  const attrs = {};
  const el = {
    style: {},
    textContent: "",
    innerHTML: "",
    offsetWidth: 0,
    classList: {
      add: (...c) => c.forEach((x) => classes.add(x)),
      remove: (...c) => c.forEach((x) => classes.delete(x)),
      toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)),
      contains: (c) => classes.has(c),
    },
    setAttribute: (k, v) => { attrs[k] = v; },
    getAttribute: (k) => attrs[k],
    addEventListener: function (t, fn) { (this._h[t] = this._h[t] || []).push(fn); },
    _h: {},
    fire: function (t, ev) { (this._h[t] || []).forEach((fn) => fn(ev || {})); },
    getBoundingClientRect: () => ({ top: 100, bottom: 500 }),
    querySelector: () => null,
    querySelectorAll: () => [],
    appendChild: () => {},
    scrollIntoView: () => {},
    has: (c) => classes.has(c),
  };
  return Object.assign(el, over);
}

function makeSandbox() {
  const scenes = [];
  for (let i = 0; i < 5; i++) scenes.push(makeEl());
  const els = {
    "task-verify": makeEl(),
    "tw-theater": makeEl(),
    "tw-stage": makeEl({ querySelectorAll: (s) => (s === ".tw-scene" ? scenes : []) }),
    "tw-cap": makeEl(),
    "tw-count": makeEl(),
    "tw-play": makeEl(),
    "tw-prev": makeEl(),
    "tw-next": makeEl(),
    "tw-track-fill": makeEl(),
    "tw-dots": makeEl(),
  };
  const dots = [];
  els["tw-dots"].appendChild = () => {};
  let rafQ = [];
  const sandbox = {
    window: null,
    document: {
      getElementById: (id) => els[id],
      createElement: (tag) => {
        const node = makeEl();
        if (tag === "button") dots.push(node);
        return node;
      },
      addEventListener: () => {},
      hidden: false,
    },
    location: { search: "" },
    URLSearchParams,
    IntersectionObserver: class {
      constructor(cb) { this.cb = cb; }
      observe() { this.cb([{ isIntersecting: true }]); } // theater starts on screen
      disconnect() {}
    },
    requestAnimationFrame: (fn) => { rafQ.push(fn); return rafQ.length; },
    setTimeout: (fn) => { fn(); return 0; },
    clearTimeout: () => {},
  };
  sandbox.window = Object.assign(Object.create(null), {
    matchMedia: () => ({ matches: false }),
    addEventListener: () => {},
    innerHeight: 900,
  });
  sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);
  return {
    els, scenes, ctx,
    dots: () => dots,
    pump(t) { const q = rafQ; rafQ = []; q.forEach((fn) => fn(t)); },
    active() { return dots.findIndex((b) => b.getAttribute("aria-current") === "true"); },
  };
}

console.log("player:");
const sb = makeSandbox();
vm.runInContext(SRC, sb.ctx);

assert(sb.dots().length === 5, "builds five dot-stepper buttons (one per STEPS entry)");
assert(sb.active() === 0, "starts on scene 1");
assert(sb.scenes[0].has("tw-on") && sb.scenes[0].has("tw-play"), "scene 1 is on stage and playing");
assert(sb.els["tw-play"].getAttribute("aria-pressed") === "true", "autoplay is on");

// crank the clock past scene 1's dwell (7.4s)
for (let t = 0; sb.active() === 0 && t <= 8500; t += 100) sb.pump(t);
assert(sb.active() === 1, "auto-advances to scene 2 after the dwell");
assert(sb.scenes[0].has("tw-on") === false, "scene 1 left the stage");
assert(sb.scenes[1].has("tw-on") && sb.scenes[1].has("tw-play"), "scene 2 is on stage and playing");
assert(sb.els["tw-count"].textContent === "02 / 05", "counter follows (02 / 05)");

// manual jump pauses autoplay
sb.dots()[4].fire("click");
assert(sb.active() === 4, "clicking a dot jumps to that scene");
assert(sb.els["tw-play"].getAttribute("aria-pressed") === "false", "manual jump pauses autoplay");
sb.pump(20000); sb.pump(40000);
assert(sb.active() === 4, "no auto-advance while paused");

// prev/next are manual controls
sb.els["tw-prev"].fire("click");
assert(sb.active() === 3, "prev goes back");
sb.els["tw-next"].fire("click");
assert(sb.active() === 4, "next advances");

// play resumes, and the loop wraps 5 -> 1
sb.els["tw-play"].fire("click");
assert(sb.els["tw-play"].getAttribute("aria-pressed") === "true", "play resumes autoplay");
const t0 = 100000;
for (let t = t0; sb.active() === 4 && t <= t0 + 7500; t += 100) sb.pump(t);
assert(sb.active() === 0, "after scene 5 the loop wraps back to scene 1");

if (failures) { console.error("\n" + failures + " failure(s)"); process.exit(1); }
console.log("\nall assertions passed");
