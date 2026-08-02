/* ============================================================================
   Welcome-page chapter 2 — "agent-chat" cinematic (prefix .aw-).

   Recreates the real Agents screen: roster (12) + chat pane with Atlas. This
   chapter owns exactly one fragment (deploy/auth/welcome/sections/
   demo-agent-chat.html) and this test file; the assembled index.html is
   built and swept separately by the integrator.

   Dependency-free, mirroring welcome_demo.test.js: static shape assertions
   plus a vm-sandboxed run of the inline player script against a minimal DOM
   stub with a hand-cranked requestAnimationFrame clock.

   Run:  node tests/portal/welcome_agent_chat.test.js
   ========================================================================== */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const FRAGMENT = path.join(__dirname, "..", "..", "deploy", "auth", "welcome", "sections", "demo-agent-chat.html");
const HTML = fs.readFileSync(FRAGMENT, "utf8");

let failures = 0;
function assert(cond, msg) {
  if (cond) { console.log("  ✓ " + msg); }
  else { failures++; console.error("  ✗ " + msg); }
}

/* ---- static shape --------------------------------------------------------
   Mutation note: delete any <div class="aw-scene" data-scene="N"> block (or
   drop its data-scene attr) and the scene-count / data-scene-attrs
   assertions below go RED.
   ---------------------------------------------------------------------- */
console.log("static:");

const KB = Buffer.byteLength(HTML) / 1024;
assert(KB <= 38, "fragment stays within the 38 KB budget (" + KB.toFixed(2) + " KB)");

assert(HTML.includes('id="agent-chat"'), "section root carries id=\"agent-chat\"");
assert(/class="[^"]*\baw-root\b[^"]*"/.test(HTML), "section root carries the aw-root chapter class");

const sceneMatches = [...HTML.matchAll(/class="aw-scene[^"]*"\s+data-scene="(\d)"/g)];
assert(sceneMatches.length === 4, "exactly four scenes (" + sceneMatches.length + " found)");
const sceneIds = sceneMatches.map((m) => m[1]).sort();
assert(JSON.stringify(sceneIds) === JSON.stringify(["0", "1", "2", "3"]), "scenes are numbered data-scene 0-3 with no gaps");

// prefix isolation: every class token in the fragment is aw- or the shared
// mk- base classes (mk-section / mk-section-alt), and no OTHER chapter's
// prefix (cw- control-room, tw- task-verify, rw- requests-metrics,
// mw- team-mobile, fw- fleet-cinematic, dm- the legacy demo cinematic) leaks in.
const classTokens = new Set();
for (const m of HTML.matchAll(/class="([^"]+)"/g)) {
  m[1].split(/\s+/).forEach((c) => c && classTokens.add(c));
}
const foreign = [...classTokens].filter((c) => /^(cw|tw|rw|mw|fw|dm)-/.test(c));
assert(foreign.length === 0, "no other chapter's class prefix present (found: " + foreign.join(", ") + ")");
const nonAwCount = [...classTokens].filter((c) => !c.startsWith("aw-") && !c.startsWith("mk-")).length;
assert(nonAwCount === 0, "every non-shared class carries the aw- prefix");
assert(classTokens.has("aw-root") && [...classTokens].some((c) => c.startsWith("aw-")), "aw- prefix present");

// CSS rules: no bare element selectors, no :root additions (scan the <style> block only)
const styleBlock = (HTML.match(/<style>([\s\S]*?)<\/style>/) || [, ""])[1];
assert(!/:root/.test(styleBlock), "no :root additions in the fragment's stylesheet");
const bareSelectors = [...styleBlock.matchAll(/(?:^|\})\s*([a-z][a-z0-9]*)\s*\{/gm)].filter((m) => m[1] !== "to" && m[1] !== "from");
assert(bareSelectors.length === 0, "no bare element selectors in CSS (found: " + bareSelectors.map((m) => m[1]).join(", ") + ")");

/* ---- roster fidelity ------------------------------------------------------
   Mutation note: renaming/removing a roster row's name, role subtitle, or
   Forge's task chip flips these RED.
   ---------------------------------------------------------------------- */
console.log("roster fidelity:");
assert(/ROSTER\s*<span class="aw-grow"><\/span><span class="aw-mono aw-faint">12<\/span>/.test(HTML), "roster header reads ROSTER · 12");
assert(HTML.includes(">you<") && HTML.includes("operator"), "roster lists you / operator");
assert(HTML.includes("sam-dev") && HTML.includes("collaborator"), "roster lists sam-dev / collaborator");
assert(HTML.includes(">Atlas<") && HTML.includes("orchestrator") && HTML.includes("system architect"), "roster lists Atlas / orchestrator · system architect");
assert(HTML.includes(">Forge<") && HTML.includes("backend engineer"), "roster lists Forge / backend engineer");
assert(HTML.includes(">Warden<") && HTML.includes("security &amp; compliance reviewer"), "roster lists Warden / security & compliance reviewer");
assert(HTML.includes(">Sentry<") && HTML.includes("QA &amp; release verification"), "roster lists Sentry / QA & release verification");
assert(HTML.includes(">Muse<") && HTML.includes("UX"), "roster lists Muse / UX design system");
assert(/aw-chip aw-chip-task">&#9632; task</.test(HTML), "Forge carries the amber task chip");

/* ---- chat header + composer ----------------------------------------------
   Mutation note: changing the header title/status or the composer's typed
   copy string flips these RED.
   ---------------------------------------------------------------------- */
console.log("chat pane:");
assert(HTML.includes("Atlas</b><span class=\"aw-faint\">orchestrator / system architect</span>"), "chat header reads Atlas — orchestrator / system architect");
assert(HTML.includes("&#8862; idle"), "chat header shows idle status");
assert(HTML.includes("Pair in terminal"), "chat header offers Pair in terminal");
assert(HTML.includes("How should we split the payments work between Forge and Sentry?"), "composer types the operator's question verbatim");
assert(HTML.includes("Message Atlas") && HTML.includes("type / for skills"), "composer placeholder matches the real portal copy");

/* ---- S2: streamed structured reply ---------------------------------------
   Mutation note: flattening the <ol> plan or dropping the work-log chip
   flips these RED.
   ---------------------------------------------------------------------- */
console.log("scene 2 — structured reply:");
assert(/<ol class="aw-plan">/.test(HTML), "reply renders as a numbered plan (ordered list)");
assert(HTML.includes("<b>Split by seam.</b>"), "plan leads with the real 'Split by seam' texture");
assert(HTML.includes("Forge owns the API + migration") && HTML.includes("Sentry owns the regression harness"), "plan assigns Forge the API/migration seam and Sentry the regression harness");
assert(HTML.includes("work log &middot; 6b0a84ba") || HTML.includes("work log · 6b0a84ba"), "work-log disclosure chip shows the run hash 6b0a84ba");
assert(HTML.includes("&#9679; working") || HTML.includes("● working"), "chat header flips to working while Atlas streams");

/* ---- S3: chat becomes tasks ------------------------------------------------
   Mutation note: removing either inline task chip or the caption string
   flips these RED.
   ---------------------------------------------------------------------- */
console.log("scene 3 — chat becomes tasks:");
assert(/aw-tid">task 41</.test(HTML), "inline task chip for task 41");
assert(/aw-tid">task 42</.test(HTML), "inline task chip for task 42");
assert(HTML.includes(">Forge</span></span>") || (HTML.includes("task 41") && HTML.includes("Forge")), "task 41 routes to Forge");
assert(HTML.includes("task 42") && HTML.includes("Sentry"), "task 42 routes to Sentry");
assert(HTML.includes("Chat becomes work: <b>Atlas files the tasks</b>, assignment wakes the agents."), "S3 caption matches spec verbatim");

/* ---- S4: footer / close copy ---------------------------------------------- */
console.log("scene 4 — close:");
assert(HTML.includes("Turn-based: Atlas wakes, works, and replies."), "footer note matches spec verbatim");
assert(HTML.includes("Every agent is a colleague you can brief, question, and redirect &mdash; in plain language.") ||
       HTML.includes("Every agent is a colleague you can brief, question, and redirect — in plain language."),
       "close line matches spec verbatim");

/* ---- fiction rule + link safety -------------------------------------------
   Mutation note: introducing a real customer name or a non-GitHub absolute
   URL flips these RED.
   ---------------------------------------------------------------------- */
console.log("fiction + links:");
assert(!/acme-ehr|acme-labs/i.test(HTML), "no project/repo name bleeds into this chapter (out of scope for agent-chat)");
const absRefs = (HTML.match(/(?:src|href)="https?:\/\/[^"]+"/g) || []).filter((h) => !h.startsWith('href="https://github.com/'));
assert(absRefs.length === 0, "no non-GitHub absolute URLs (" + absRefs.join(", ") + ")");
assert(!/<script[^>]+src=/.test(HTML), "no external <script src>");
assert(!/<link[^>]+rel="stylesheet"/.test(HTML), "no external stylesheets");
assert(!/url\(\s*['"]?https?:/.test(HTML), "no remote url() resources");
assert(!/@import/.test(HTML), "no CSS @import");
assert(!/data:(image|font)/.test(HTML), "no data URIs");

/* ---- player behavior -------------------------------------------------------
   Extract the inline player (the fragment's own <script> block) and run it
   in a vm sandbox against a minimal DOM stub, same technique as
   welcome_demo.test.js.
   ---------------------------------------------------------------------- */
console.log("player:");
const scripts = [...HTML.matchAll(/<script>([\s\S]*?)<\/script>/g)];
assert(scripts.length === 1, "fragment carries exactly one inline <script> block");
const SRC = scripts[scripts.length - 1][1];
assert(SRC.includes("STEPS"), "found the inline player script");
assert(SRC.includes("__awInit"), "player carries the aw- self-init guard so it coexists with sibling chapter players");

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
  const dotsWrap = makeEl({ appendChild: () => {} });
  const els = {
    "agent-chat": makeEl(),
    "aw-theater": makeEl(),
    "aw-stage": makeEl({ querySelectorAll: (s) => (s === ".aw-scene" ? scenes : []) }),
    "aw-cap": makeEl(),
    "aw-count": makeEl(),
    "aw-play": makeEl(),
    "aw-track-fill": makeEl(),
    "aw-dots": dotsWrap,
    "aw-prev": makeEl(),
    "aw-next": makeEl(),
  };
  let rafQ = [];
  const sandbox = {
    window: null,
    document: {
      getElementById: (id) => els[id],
      createElement: () => makeEl(),
      addEventListener: () => {},
      hidden: false,
    },
    location: { search: "" },
    URLSearchParams,
    IntersectionObserver: class {
      constructor(cb) { this.cb = cb; }
      observe() { this.cb([{ isIntersecting: true }]); }
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
    pump(t) { const q = rafQ; rafQ = []; q.forEach((fn) => fn(t)); },
    active() { return els["aw-count"].textContent; },
  };
}

const sb = makeSandbox();
sb.ctx.window.__awInit = false;
vm.runInContext(SRC, sb.ctx);

assert(sb.scenes[0].has("aw-on") && sb.scenes[0].has("aw-play"), "scene 1 is on stage and playing");
assert(sb.els["aw-play"].getAttribute("aria-pressed") === "true", "autoplay is on");
assert(sb.els["aw-count"].textContent === "01 / 04", "counter starts at 01 / 04");

// crank the clock past scene 1's dwell (6.6s)
for (let t = 0; sb.scenes[0].has("aw-on") && t <= 7500; t += 100) sb.pump(t);
assert(sb.scenes[0].has("aw-on") === false, "scene 1 leaves the stage after its dwell");
assert(sb.scenes[1].has("aw-on") && sb.scenes[1].has("aw-play"), "scene 2 is on stage and playing");
assert(sb.els["aw-count"].textContent === "02 / 04", "counter follows (02 / 04)");

// manual jump (prev/next) pauses autoplay
sb.els["aw-next"].fire("click");
assert(sb.els["aw-count"].textContent === "03 / 04", "next control jumps to scene 3");
assert(sb.els["aw-play"].getAttribute("aria-pressed") === "false", "manual jump pauses autoplay");
sb.pump(50000); sb.pump(60000);
assert(sb.els["aw-count"].textContent === "03 / 04", "no auto-advance while paused");

sb.els["aw-next"].fire("click");
assert(sb.els["aw-count"].textContent === "04 / 04", "next advances to the closing scene");
sb.els["aw-prev"].fire("click");
assert(sb.els["aw-count"].textContent === "03 / 04", "prev goes back");

// resume autoplay: loop wraps 4 -> 1
sb.els["aw-play"].fire("click");
assert(sb.els["aw-play"].getAttribute("aria-pressed") === "true", "play resumes autoplay");
let t0 = 100000;
for (let t = t0; sb.els["aw-count"].textContent === "03 / 04" && t <= t0 + 8000; t += 100) sb.pump(t);
assert(sb.els["aw-count"].textContent === "04 / 04", "resumed autoplay advances to scene 4");
t0 = 200000;
for (let t = t0; sb.els["aw-count"].textContent === "04 / 04" && t <= t0 + 7000; t += 100) sb.pump(t);
assert(sb.els["aw-count"].textContent === "01 / 04", "after scene 4 the loop wraps back to scene 1");

if (failures) { console.error("\n" + failures + " failure(s)"); process.exit(1); }
console.log("\nall assertions passed");
