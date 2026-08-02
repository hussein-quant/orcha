/* ============================================================================
   Welcome-page chapter 1 — "control room" cinematic — static + behavioral
   assertions.

   deploy/auth/welcome/sections/demo-control-room.html is a self-contained
   fragment (own <style> + <script>, prefix cw-) assembled verbatim into
   index.html by build.py. It must stay fully self-contained: no external
   scripts/styles/fonts/images beyond the page's self-hosted fonts, no
   absolute links except the allowed GitHub App link, exactly four scenes,
   and a player that auto-advances, pauses on manual navigation, and resumes.

   Dependency-free, mirroring welcome_demo.test.js / theme_cycle.test.js: the
   fragment's inline player script runs in a vm sandbox against a minimal DOM
   stub with a hand-cranked requestAnimationFrame clock.

   Run:  node tests/portal/welcome_control_room.test.js
   ========================================================================== */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const FRAGMENT = path.join(__dirname, "..", "..", "deploy", "auth", "welcome", "sections", "demo-control-room.html");
const HTML = fs.readFileSync(FRAGMENT, "utf8");

let failures = 0;
function assert(cond, msg) {
  if (cond) { console.log("  ✓ " + msg); }
  else { failures++; console.error("  ✗ " + msg); }
}

/* ---- static shape --------------------------------------------------------
   Mutation note: delete any of the four `data-scene="N"` scene <div>s (or the
   matching STEPS[] entry in the script) and the scene-count / dots-vs-STEPS
   assertions below go RED. */
console.log("static:");

const SIZE_BYTES = Buffer.byteLength(HTML);
assert(SIZE_BYTES <= 38 * 1024, "fragment stays under the 38 KB budget (" + (SIZE_BYTES / 1024).toFixed(2) + " KB)");

assert(HTML.startsWith('<section id="control-room" class="mk-section cw-root"'), "root section carries id=control-room and class cw-root");

const sceneMatches = [...HTML.matchAll(/class="cw-scene[^"]*"\s+data-scene="(\d)"/g)];
assert(sceneMatches.length === 4, "exactly four cw-scene elements (found " + sceneMatches.length + ")");
assert(sceneMatches.map((m) => m[1]).join(",") === "0,1,2,3", "data-scene attrs are 0,1,2,3 in order");

// prefix isolation: every class token in the fragment is cw-*, mk-section (the
// shared shell class every fragment carries), or a bare SVG/util token — and
// no sibling chapter's prefix (aw-/tw-/rw-/mw-/fw-/dm-) leaks in.
const classTokens = new Set();
for (const m of HTML.matchAll(/class="([^"]*)"/g)) {
  m[1].split(/\s+/).filter(Boolean).forEach((t) => classTokens.add(t));
}
const nonCw = [...classTokens].filter((t) => t !== "mk-section" && !t.startsWith("cw-"));
assert(nonCw.length === 0, "every non-shell class is cw-prefixed (stray: " + nonCw.join(", ") + ")");
assert(HTML.includes("cw-root") && HTML.includes("cw-scene") && HTML.includes("cw-theater"), "cw- prefix present throughout");
for (const other of ["aw-", "tw-", "rw-", "mw-", "fw-", "dm-"]) {
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
assert(!/:root\s*\{/.test(HTML), "no :root additions (fragment scopes tokens under .cw-root)");

/* ---- key copy strings (real Dashboard recreation, spec fiction rule) ----- */
console.log("copy:");
const copyStrings = [
  "acme-health",
  "acme-labs/acme-ehr",
  "AGENTS",
  "TASKS",
  "OPEN REQ",
  "Running NOTIFIER",
  "Needs your attention",
  "Nothing needs you right now",
  "Agents at a glance (12)",
  "sam-dev",
  "Atlas",
  "orchestrator",
  "system architect",
  "Forge",
  "backend engineer",
  "Warden",
  "security &amp; compliance reviewer",
  "Sentry",
  "QA &amp; release verification",
  "Muse",
  "UX &amp; design system",
  "claude-fable-5",
  "claude-sonnet-5",
  "POST",
  "plan posted for approval",
  "PR opened: acme-labs/acme-ehr#41",
  "eligibility gate enforced on every PHI path",
  "review posted",
  "suite green",
  "214 passed",
  "One control room",
  "queue of what needs",
];
for (const s of copyStrings) {
  assert(HTML.includes(s), "contains copy: " + JSON.stringify(s));
}
// fiction rule: no real customer/project names from production
for (const forbidden of ["quantal-labs/orcha", "orcha-cloud[bot]", "dana-okafor"]) {
  assert(!HTML.includes(forbidden), "does not leak sibling-fixture/production name: " + forbidden);
}

/* ---- player behavior ------------------------------------------------------
   Mutation note: change a STEPS[].ms dwell to 0 or remove the setScene()
   wrap-around modulo and the auto-advance / loop assertions below go RED. */
const scripts = [...HTML.matchAll(/<script>([\s\S]*?)<\/script>/g)];
assert(scripts.length === 1, "exactly one inline <script> block");
const SRC = scripts[0][1];
assert(SRC.includes("STEPS"), "found the inline player script");
assert(SRC.includes("window.__cwInit"), "self-init guard present so multiple chapter players can coexist");

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
  for (let i = 0; i < 4; i++) scenes.push(makeEl());
  const els = {
    "control-room": makeEl(),
    "cw-theater": makeEl(),
    "cw-stage": makeEl({ querySelectorAll: (s) => (s === ".cw-scene" ? scenes : []) }),
    "cw-cap": makeEl(),
    "cw-count": makeEl(),
    "cw-play": makeEl(),
    "cw-prev": makeEl(),
    "cw-next": makeEl(),
    "cw-track-fill": makeEl(),
    "cw-dots": makeEl(),
  };
  const dots = [];
  els["cw-dots"].appendChild = () => {};
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

assert(sb.dots().length === 4, "builds four dot-stepper buttons (one per STEPS entry)");
assert(sb.active() === 0, "starts on scene 1");
assert(sb.scenes[0].has("cw-on") && sb.scenes[0].has("cw-play"), "scene 1 is on stage and playing");
assert(sb.els["cw-play"].getAttribute("aria-pressed") === "true", "autoplay is on");

// crank the clock past scene 1's dwell (6.6s)
for (let t = 0; sb.active() === 0 && t <= 7500; t += 100) sb.pump(t);
assert(sb.active() === 1, "auto-advances to scene 2 after the dwell");
assert(sb.scenes[0].has("cw-on") === false, "scene 1 left the stage");
assert(sb.scenes[1].has("cw-on") && sb.scenes[1].has("cw-play"), "scene 2 is on stage and playing");
assert(sb.els["cw-count"].textContent === "02 / 04", "counter follows (02 / 04)");

// manual jump pauses autoplay
sb.dots()[3].fire("click");
assert(sb.active() === 3, "clicking a dot jumps to that scene");
assert(sb.els["cw-play"].getAttribute("aria-pressed") === "false", "manual jump pauses autoplay");
sb.pump(20000); sb.pump(40000);
assert(sb.active() === 3, "no auto-advance while paused");

// prev/next are manual controls
sb.els["cw-prev"].fire("click");
assert(sb.active() === 2, "prev goes back");
sb.els["cw-next"].fire("click");
assert(sb.active() === 3, "next advances");

// play resumes, and the loop wraps 4 -> 1
sb.els["cw-play"].fire("click");
assert(sb.els["cw-play"].getAttribute("aria-pressed") === "true", "play resumes autoplay");
const t0 = 100000;
for (let t = t0; sb.active() === 3 && t <= t0 + 7000; t += 100) sb.pump(t);
assert(sb.active() === 0, "after scene 4 the loop wraps back to scene 1");

if (failures) { console.error("\n" + failures + " failure(s)"); process.exit(1); }
console.log("\nall assertions passed");
