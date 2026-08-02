/* ============================================================================
   Welcome-page chapter 4 · requests-metrics ("Agents ask. You decide. Every
   run priced.") — static + behavioral assertions on the standalone fragment.

   This fragment (deploy/auth/welcome/sections/demo-requests-metrics.html) is
   assembled by build.py into the pre-auth landing page, which is served by
   Caddy's file_server with no build step: it must stay fully self-contained
   (no external scripts/styles/fonts/images), scope every rule under the
   .rw- prefix, and stay inside its size budget.

   Dependency-free, mirroring welcome_demo.test.js: the fragment's inline
   player script runs in a vm sandbox against a minimal DOM stub with a
   hand-cranked requestAnimationFrame clock.

   Run:  node tests/portal/welcome_requests_metrics.test.js
   ========================================================================== */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const FRAGMENT = path.join(__dirname, "..", "..", "deploy", "auth", "welcome", "sections", "demo-requests-metrics.html");
const HTML = fs.readFileSync(FRAGMENT, "utf8");
const SIZE_BYTES = Buffer.byteLength(HTML);
const BUDGET_BYTES = 38 * 1024;

let failures = 0;
function assert(cond, msg) {
  if (cond) { console.log("  ✓ " + msg); }
  else { failures++; console.error("  ✗ " + msg); }
}

/* ---- static shape ------------------------------------------------------- */
console.log("static:");

// Mutation note: delete any <div class="rw-scene" data-scene="N"> block below
// and this count assertion goes RED.
const sceneEls = HTML.match(/class="rw-scene[ "]/g) || [];
assert(sceneEls.length === 5, "exactly five rw- scenes (found " + sceneEls.length + ")");

const dataScenes = [...HTML.matchAll(/data-scene="(\d)"/g)].map((m) => m[1]);
assert(dataScenes.length === 5, "five data-scene attrs present");
assert(JSON.stringify(dataScenes) === JSON.stringify(["0", "1", "2", "3", "4"]), "data-scene values are 0..4 in order (" + dataScenes.join(",") + ")");

assert(SIZE_BYTES < BUDGET_BYTES, "fragment stays under 38 KB budget (" + (SIZE_BYTES / 1024).toFixed(2) + " KB)");

assert(!/<script[^>]+src=/.test(HTML), "no external <script src>");
assert(!/<link[^>]+rel="stylesheet"/.test(HTML), "no external stylesheets");
assert(!/url\(\s*['"]?https?:/.test(HTML), "no remote url() resources");
assert(!/@import/.test(HTML), "no CSS @import");
assert(!/<img\b/i.test(HTML), "no <img> tags (no data URIs / external images)");

// the only allowed absolute link target is the GitHub project link
const absRefs = (HTML.match(/(?:src|href)="https?:\/\/[^"]+"/g) || []).filter((h) => !h.startsWith('href="https://github.com/'));
assert(absRefs.length === 0, "no non-navigational absolute URLs" + (absRefs.length ? " (" + absRefs.join(", ") + ")" : ""));

assert(HTML.includes("prefers-reduced-motion"), "respects prefers-reduced-motion");

/* ---- prefix scoping ------------------------------------------------------ */
console.log("\nprefix scoping:");

// Mutation note: rename any .rw- class to something else (or drop the "rw-"
// prefix) and this goes RED — the chapter must own a unique, fully-scoped
// class namespace so sibling chapter fragments can't collide.
const rwClassCount = (HTML.match(/\brw-[a-z0-9-]+/g) || []).length;
assert(rwClassCount > 20, "the .rw- prefix is used pervasively (" + rwClassCount + " occurrences)");

const OTHER_PREFIXES = ["cw-", "aw-", "tw-", "mw-", "fw-"];
OTHER_PREFIXES.forEach((p) => {
  const re = new RegExp('class="[^"]*\\b' + p, "g");
  assert(!re.test(HTML), "no other chapter's prefix (" + p + ") appears in a class attribute");
});

// id/js hooks also carry the rw- namespace (avoids collisions with sibling players)
["rw-theater", "rw-stage", "rw-cap", "rw-count", "rw-play", "rw-prev", "rw-next", "rw-dots", "rw-track-fill"].forEach((id) => {
  assert(HTML.includes('id="' + id + '"'), "id=\"" + id + "\" present");
});

/* ---- key copy strings (fiction rule + spec fidelity) ---------------------- */
console.log("\ncopy fidelity:");

// Mutation note: edit/delete any of these verbatim strings and the
// corresponding assertion goes RED.
const REQUIRED_STRINGS = [
  "Agents ask. You decide.",
  "Every run priced.",
  "REQUESTS",
  "1 OPEN",
  "info request",
  "Priority 10",
  "Infra blocker, separate from the drafting question",
  "my assigned worktree is owned by root",
  "uid 1000",
  "I have",
  "NOT",
  "worked around it",
  "Answer",
  "Fixed — real bug, good catch",
  "chowned every existing tree",
  "Retry your work",
  "CLOSED",
  "$175.35",
  "estimated · 71 of 301 runs reported cost",
  "301",
  "1d 20h",
  "22 done",
  "10 human-verified",
  "Cost &amp; activity by agent",
  "Forge",
  "claude-sonnet-5",
  "6 ok · 3 failed",
  "8h 22m",
  "$51.88",
  "Warden",
  "19 ok",
  "$31.66",
  "Atlas",
  "claude-fable-5",
  "$28.60",
  "Lex",
  "claude-opus-5",
  "$20.32",
  "Escalations answered in one click",
  "Every dollar attributed to an agent",
];
REQUIRED_STRINGS.forEach((s) => {
  assert(HTML.includes(s), "contains " + JSON.stringify(s));
});

// honesty: dollar figures must read as estimates, not absolutes
assert(/estimated/i.test(HTML), "cost figures are qualified as \"estimated\"");
// failure counts render in a distinct (red/danger) class, not folded into the ok count
assert(/rw-fail/.test(HTML), "failure counts use a dedicated rw-fail (red) style hook");
assert(/class="rw-fail"[^>]*>\(6 ok · 3 failed\)/.test(HTML) || HTML.includes('<span class="rw-fail">(6 ok · 3 failed)</span>'), "Forge's 3 failed runs are wrapped in the red failure style");

// fiction rule: fictional project naming only ("acme-health"), no leaked internal codenames
assert(HTML.includes("acme-health"), "uses the fictional project name acme-health");
assert(!/\bquantal-health\b/i.test(HTML), "no leaked internal project codename");

/* ---- player behavior ------------------------------------------------------ */
console.log("\nplayer:");

const scripts = [...HTML.matchAll(/<script>([\s\S]*?)<\/script>/g)];
const SRC = scripts[scripts.length - 1][1];
assert(SRC.includes("STEPS"), "found the inline player script");
assert(SRC.includes("__rwInit"), "self-init guard present (multiple chapter players can coexist)");

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
  const N = 5;
  const scenes = [];
  for (let i = 0; i < N; i++) scenes.push(makeEl());
  const dotsWrap = makeEl({ appendChild: () => {} });
  const els = {
    "demo-requests-metrics": makeEl(),
    "rw-theater": makeEl(),
    "rw-stage": makeEl({ querySelectorAll: (s) => (s === ".rw-scene" ? scenes : []) }),
    "rw-cap": makeEl(),
    "rw-count": makeEl(),
    "rw-play": makeEl(),
    "rw-track-fill": makeEl(),
    "rw-dots": dotsWrap,
    "rw-prev": makeEl(),
    "rw-next": makeEl(),
  };
  let rafQ = [];
  const sandbox = {
    window: null,
    document: {
      getElementById: (id) => els[id],
      createElement: () => makeEl(),
      querySelector: () => makeEl(),
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
    setTimeout: (fn) => { fn(); return 0; }, // caption swap / bye cleanup run inline
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
    pump(t) { const q = rafQ; rafQ = []; q.forEach((fn) => fn(t)); },
  };
}

const sb = makeSandbox();
vm.runInContext(SRC, sb.ctx);

assert(sb.scenes[0].has("rw-on") && sb.scenes[0].has("rw-play"), "scene 1 is on stage and playing");
assert(sb.els["rw-play"].getAttribute("aria-pressed") === "true", "autoplay is on");
assert(sb.els["rw-count"].textContent === "01 / 05", "counter starts at 01 / 05");

// crank the clock past scene 1's dwell (7.2s)
for (let t = 0; sb.scenes[0].has("rw-on") && t <= 8000; t += 100) sb.pump(t);
assert(sb.scenes[0].has("rw-on") === false, "scene 1 leaves the stage after its dwell");
assert(sb.scenes[1].has("rw-on") && sb.scenes[1].has("rw-play"), "scene 2 is on stage and playing");
assert(sb.els["rw-count"].textContent === "02 / 05", "counter follows (02 / 05)");

// manual next/prev
sb.els["rw-next"].fire("click");
assert(sb.scenes[2].has("rw-on"), "next advances to scene 3");
assert(sb.els["rw-play"].getAttribute("aria-pressed") === "false", "manual jump pauses autoplay");
sb.els["rw-prev"].fire("click");
assert(sb.scenes[1].has("rw-on"), "prev goes back to scene 2");

// paused: no auto-advance
sb.pump(50000); sb.pump(90000);
assert(sb.scenes[1].has("rw-on"), "no auto-advance while paused");

// resume and let it wrap scene 5 -> scene 1
sb.els["rw-play"].fire("click");
assert(sb.els["rw-play"].getAttribute("aria-pressed") === "true", "play resumes autoplay");
let t0 = 100000;
for (let t = t0; sb.scenes[1].has("rw-on") && t <= t0 + 8000; t += 100) sb.pump(t);
assert(sb.scenes[2].has("rw-on"), "resumed autoplay advances to scene 3");
t0 = 200000;
for (let t = t0; sb.scenes[2].has("rw-on") && t <= t0 + 8000; t += 100) sb.pump(t);
assert(sb.scenes[3].has("rw-on"), "advances to scene 4");
t0 = 300000;
for (let t = t0; sb.scenes[3].has("rw-on") && t <= t0 + 8500; t += 100) sb.pump(t);
assert(sb.scenes[4].has("rw-on"), "advances to scene 5 (close)");
t0 = 400000;
for (let t = t0; sb.scenes[4].has("rw-on") && t <= t0 + 7500; t += 100) sb.pump(t);
assert(sb.scenes[0].has("rw-on"), "after scene 5 the loop wraps back to scene 1");

if (failures) { console.error("\n" + failures + " failure(s)"); process.exit(1); }
console.log("\nall assertions passed");
