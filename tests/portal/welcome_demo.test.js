/* ============================================================================
   Welcome-page cinematic demo — static + behavioral assertions.

   The pre-auth landing page (deploy/auth/welcome/index.html) is served by
   Caddy's file_server with no build step, so it must stay fully
   self-contained: no external scripts/styles/fonts/images, exactly six
   demo steps, and a player that auto-advances, pauses on manual navigation,
   and resumes.

   Dependency-free, mirroring theme_cycle.test.js: the page's inline player
   script runs in a vm sandbox against a minimal DOM stub with a hand-cranked
   requestAnimationFrame clock.

   Run:  node tests/portal/welcome_demo.test.js
   ========================================================================== */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const PAGE = path.join(__dirname, "..", "..", "deploy", "auth", "welcome", "index.html");
const HTML = fs.readFileSync(PAGE, "utf8");

let failures = 0;
function assert(cond, msg) {
  if (cond) { console.log("  ✓ " + msg); }
  else { failures++; console.error("  ✗ " + msg); }
}

/* ---- static shape ------------------------------------------------------- */
console.log("static:");
assert(Buffer.byteLength(HTML) < 300 * 1024, "page stays under 300 KB (" + (Buffer.byteLength(HTML) / 1024).toFixed(1) + " KB)");
assert((HTML.match(/class="scene[ "]/g) || []).length === 6, "exactly six demo scenes");
assert((HTML.match(/class="rstep"/g) || []).length === 6, "exactly six rail steps");
assert(!/<script[^>]+src=/.test(HTML), "no external <script src>");
assert(!/<link[^>]+rel="stylesheet"/.test(HTML), "no external stylesheets");
assert(!/url\(\s*['"]?https?:/.test(HTML), "no remote url() resources");
assert(!/@import/.test(HTML), "no CSS @import");
// the only allowed absolute link targets are navigational (GitHub footer link)
const absRefs = (HTML.match(/(?:src|href)="https?:\/\/[^"]+"/g) || []).filter((h) => !h.startsWith('href="https://github.com/'));
assert(absRefs.length === 0, "no non-navigational absolute URLs (" + absRefs.join(", ") + ")");
assert(HTML.includes('href="/oauth2/start?rd=%2F"'), "sign-in CTA still points at /oauth2/start");
assert(HTML.includes("prefers-reduced-motion"), "respects prefers-reduced-motion");
assert(HTML.includes("prefers-color-scheme"), "light/dark scheme aware");
assert(HTML.includes("orcha-cloud-app"), "keeps the GitHub App fine print");

/* ---- player behavior ---------------------------------------------------- */
// Extract the inline player (the last <script> block).
const scripts = [...HTML.matchAll(/<script>([\s\S]*?)<\/script>/g)];
const SRC = scripts[scripts.length - 1][1];
assert(SRC.includes("STEPS"), "found the inline player script");

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
    scrollIntoView: () => {},
    has: (c) => classes.has(c),
  };
  return Object.assign(el, over);
}

function makeSandbox() {
  const fills = [], rsteps = [], scenes = [];
  for (let i = 0; i < 6; i++) {
    const fill = makeEl();
    fills.push(fill);
    rsteps.push(makeEl({ querySelector: (s) => (s === ".fill" ? fill : null) }));
    scenes.push(makeEl());
  }
  const els = {
    how: makeEl(),
    theater: makeEl(),
    stage: makeEl({ querySelectorAll: (s) => (s === ".scene" ? scenes : []) }),
    rail: makeEl({ querySelectorAll: (s) => (s === ".rstep" ? rsteps : []) }),
    cap: makeEl(),
    count: makeEl(),
    play: makeEl(),
    prev: makeEl(),
    next: makeEl(),
  };
  let rafQ = [];
  const sandbox = {
    window: null,
    document: {
      getElementById: (id) => els[id],
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
    setTimeout: (fn) => { fn(); return 0; },  // caption swap / bye cleanup run inline
    clearTimeout: () => {},
  };
  sandbox.window = Object.assign(Object.create(null), {
    matchMedia: () => ({ matches: false }),
    addEventListener: () => {},
    innerHeight: 900,
  });
  sandbox.globalThis = sandbox;
  // Hand-cranked clock: run pending rAF callbacks at timestamp t.
  const ctx = vm.createContext(sandbox);
  return {
    els, fills, rsteps, scenes, ctx,
    pump(t) { const q = rafQ; rafQ = []; q.forEach((fn) => fn(t)); },
    active() { return rsteps.findIndex((b) => b.getAttribute("aria-pressed") === "true"); },
  };
}

console.log("player:");
const sb = makeSandbox();
vm.runInContext(SRC, sb.ctx);

assert(sb.active() === 0, "starts on step 1");
assert(sb.scenes[0].has("on") && sb.scenes[0].has("play"), "scene 1 is on stage and playing");
assert(sb.els.play.getAttribute("aria-pressed") === "true", "autoplay is on");

// crank the clock past step 1's dwell (7.2 s)
for (let t = 0; sb.active() === 0 && t <= 8000; t += 100) sb.pump(t);
assert(sb.active() === 1, "auto-advances to step 2 after the dwell");
assert(sb.scenes[0].has("on") === false, "scene 1 left the stage");
assert(sb.scenes[1].has("on") && sb.scenes[1].has("play"), "scene 2 is on stage and playing");
assert(sb.els.count.textContent === "02 / 06", "counter follows (02 / 06)");

// manual jump pauses autoplay
sb.rsteps[4].fire("click");
assert(sb.active() === 4, "clicking a rail step jumps to it");
assert(sb.els.play.getAttribute("aria-pressed") === "false", "manual jump pauses autoplay");
sb.pump(20000); sb.pump(40000);
assert(sb.active() === 4, "no auto-advance while paused");

// prev/next are manual controls
sb.els.next.fire("click");
assert(sb.active() === 5, "next advances");
sb.els.prev.fire("click");
assert(sb.active() === 4, "prev goes back");

// play resumes, and the loop wraps 6 -> 1
sb.els.play.fire("click");
assert(sb.els.play.getAttribute("aria-pressed") === "true", "play resumes autoplay");
let t0 = 100000;
for (let t = t0; sb.active() === 4 && t <= t0 + 9000; t += 100) sb.pump(t);
assert(sb.active() === 5, "resumed autoplay advances to step 6");
t0 = 200000;
for (let t = t0; sb.active() === 5 && t <= t0 + 9000; t += 100) sb.pump(t);
assert(sb.active() === 0, "after step 6 the loop wraps back to step 1");

if (failures) { console.error("\n" + failures + " failure(s)"); process.exit(1); }
console.log("\nall assertions passed");
