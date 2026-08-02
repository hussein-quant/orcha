/* ============================================================================
   Page skeleton loading states (modules/app-skeleton.js + styles/skeleton.css).

   Founder-reported "considerable lag" switching Agents → Tasks: the portal is
   an MPA (every sidebar click is a full navigation — orcha-design.md), so each
   page boots to an empty shell, fetches its snapshot (pages/<page>-state.js),
   then paints. The visible lag IS that empty gap. This suite pins the fix:
   a token-driven skeleton fills the gap after a short delay (never flashing on
   a fast load) and a gentle fade softens the real content landing.

   Dependency-free (house style — mirrors project_switcher.test.js /
   skin_minimal_css.test.js): real portal sources in a vm sandbox over a tiny
   fake DOM, plus a hand-rolled fake clock (no sinon) so the 120ms show delay
   can be cranked deterministically without a real sleep.

   Covers:
     PART A  OrchaSkeleton module API contract — show/swap/cancel exist, swap
             calls through to the render function and returns its result.
     PART B  120ms delay behavior — a fast swap() (before 120ms elapses) never
             paints skeleton markup; a slow swap() (clock advanced past 120ms
             first) shows it, then swap() replaces it.
     PART C  reduced motion — CSS branch disables the shimmer keyframe and the
             fade-in animation under prefers-reduced-motion: reduce.
     PART D  token-only colors — skeleton.css contains zero hex/rgb literals;
             every color comes from var(--...).
     PART E  every one of the 5 target pages' boot module wires OrchaSkeleton
             (grep-level: the .show(/.swap( calls are present in source).
     PART F  swap() removes the skeleton marker/state so a second show() on
             the same container after a swap schedules a fresh skeleton
             (nothing "stuck" showing).
     PART G  skeleton.css is <link>ed in all 8 page heads, immediately after
             skin-minimal.css (the established include-list pattern), and via
             the styles.css compatibility entrypoint.

   Each assertion's comment documents what a targeted mutation would break.
   Run: node tests/portal/page_skeletons.test.js
   ========================================================================== */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const STATIC = path.join(
  __dirname, "..", "..",
  "orcha-cli", "orcha_cli", "templates", "portal", "static"
);
const read = (...p) => fs.readFileSync(path.join(STATIC, ...p), "utf8");

const SKELETON_JS = read("modules", "app-skeleton.js");
const SKELETON_CSS_PATH = path.join(STATIC, "styles", "skeleton.css");
const SKELETON_CSS = fs.readFileSync(SKELETON_CSS_PATH, "utf8");

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log("  ✓ " + msg);
  else { failures++; console.error("  ✗ " + msg); }
}

/* ---- tiny fake DOM (enough for a container node: innerHTML, classList,
   attributes, offsetWidth for the reflow trick) ---------------------------- */
function makeNode(id) {
  const n = {
    id: id || "", _html: "", _attrs: {}, _classes: [],
    get innerHTML() { return n._html; },
    set innerHTML(v) { n._html = v == null ? "" : String(v); },
    offsetWidth: 0,
    setAttribute: (k, v) => { n._attrs[k] = String(v); },
    getAttribute: (k) => (k in n._attrs ? n._attrs[k] : null),
    removeAttribute: (k) => { delete n._attrs[k]; },
    classList: {
      add: (c) => { if (n._classes.indexOf(c) === -1) n._classes.push(c); },
      remove: (c) => { n._classes = n._classes.filter((x) => x !== c); },
      contains: (c) => n._classes.indexOf(c) !== -1,
    },
  };
  return n;
}

/* ---- hand-rolled fake clock: a drop-in setTimeout/clearTimeout that never
   actually sleeps — advance(ms) runs every timer whose deadline has passed,
   in deadline order. No dependency (no sinon/jest fake timers). ------------ */
function makeClock() {
  let now = 0, nextId = 1;
  const timers = new Map();
  function fakeSetTimeout(fn, delay) {
    const id = nextId++;
    timers.set(id, { at: now + (delay || 0), fn });
    return id;
  }
  function fakeClearTimeout(id) { timers.delete(id); }
  function advance(ms) {
    now += ms;
    // run due timers in deadline order; a timer's own callback won't itself
    // schedule something due at/before `now` in these tests, so one pass over
    // a fixed snapshot of due ids is sufficient (matches this module's usage:
    // one-shot show() timers, never rescheduling themselves).
    const due = [...timers.entries()].filter(([, t]) => t.at <= now).sort((a, b) => a[1].at - b[1].at);
    for (const [id] of due) {
      const t = timers.get(id);
      if (!t) continue;   // cancelled by an earlier callback in this batch
      timers.delete(id);
      t.fn();
    }
  }
  return { setTimeout: fakeSetTimeout, clearTimeout: fakeClearTimeout, advance, pendingCount: () => timers.size };
}

/* ---- sandbox: load the real app-skeleton.js against a fake clock + a
   matchMedia stub the tests can flip for the reduced-motion assertions. ---- */
function skeletonSandbox(opts) {
  opts = opts || {};
  const clock = makeClock();
  let reduced = !!opts.reducedMotion;
  const sandbox = {
    window: {
      matchMedia: (q) => ({ matches: /reduce/.test(q) ? reduced : false }),
    },
    console,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    WeakMap: typeof WeakMap !== "undefined" ? WeakMap : undefined,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SKELETON_JS, sandbox, { filename: "modules/app-skeleton.js" });
  return {
    sandbox, clock,
    setReducedMotion: (v) => { reduced = v; },
    Skeleton: sandbox.window.OrchaSkeleton,
  };
}

/* ---------------- PART A — module API contract ------------------------- */
function apiContractTests() {
  console.log("PART A — OrchaSkeleton module API contract\n");
  const { Skeleton } = skeletonSandbox();

  // Mutation: rename/drop any of these exports → every page's boot wiring
  // (which calls OrchaSkeleton.show/.swap by name) breaks silently at runtime.
  assert(typeof Skeleton === "object" && Skeleton !== null, "window.OrchaSkeleton is published as an object");
  assert(typeof Skeleton.show === "function", "OrchaSkeleton.show is a function");
  assert(typeof Skeleton.swap === "function", "OrchaSkeleton.swap is a function");
  assert(typeof Skeleton.cancel === "function", "OrchaSkeleton.cancel is a function");

  // Mutation: change the numeric delay constant to anything other than 120 →
  // this fails (RED) — the brief's exact "appears only after a 120ms delay".
  assert(Skeleton.SHOW_DELAY_MS === 120, "the show delay is exactly 120ms (never flashes on a fast load)");

  // swap() with no container must not throw and must still return renderFn()'s
  // value — pages sometimes call swap() defensively before a container exists
  // (e.g. a deep-linked page missing an optional region).
  let ran = false;
  const result = Skeleton.swap(null, () => { ran = true; return "R"; });
  assert(ran === true && result === "R", "swap(null, renderFn) still calls renderFn and returns its value (never throws)");

  // swap() calls renderFn exactly once and forwards its return value — pages
  // rely on this to keep e.g. `OrchaSkeleton.swap(el, renderList)` a drop-in
  // replacement for a bare `renderList()` call.
  const el = makeNode("x");
  let calls = 0;
  const r2 = Skeleton.swap(el, () => { calls++; return 42; });
  assert(calls === 1 && r2 === 42, "swap(container, renderFn) calls renderFn exactly once and returns its value");

  // Mutation: typo a kind string somewhere in a page's boot file (e.g.
  // "list-row" instead of "list-rows") → show() must fail loudly at the call
  // site instead of silently rendering nothing, so the typo is caught in dev.
  let threw = false;
  try { Skeleton.show(makeNode("y"), "not-a-real-kind"); } catch (e) { threw = true; }
  assert(threw, "show() with an unknown kind throws immediately (a typo'd kind fails loudly, not silently)");
}

/* ---------------- PART B — 120ms delay behavior ------------------------- */
function delayTests() {
  console.log("\nPART B — 120ms delay: no flash on fast loads, shows on slow ones\n");

  // Fast path: swap() arrives before the 120ms timer fires.
  {
    const { Skeleton, clock } = skeletonSandbox();
    const el = makeNode("tlist");
    Skeleton.show(el, "list-rows");
    clock.advance(80);   // well under 120ms
    // Mutation: remove the timer-pending guard in cancel()/swap() → this
    // still passes today by luck (the render already replaced innerHTML with
    // real content) but the NEXT assertion (pendingCount) would catch a timer
    // left dangling after a fast swap.
    assert(!/ork-sk-wrap/.test(el.innerHTML), "80ms < 120ms: no skeleton markup was ever painted");
    Skeleton.swap(el, () => { el.innerHTML = "<div class=\"real\">content</div>"; });
    assert(/class="real"/.test(el.innerHTML), "the real content rendered");
    assert(clock.pendingCount() === 0, "swap() cancelled the pending 120ms timer — it can never fire late and clobber the real content");
  }

  // Slow path: the clock crosses 120ms BEFORE swap() is called.
  {
    const { Skeleton, clock } = skeletonSandbox();
    const el = makeNode("tlist");
    Skeleton.show(el, "list-rows");
    clock.advance(120);   // exactly at the threshold — the brief says "after a 120ms delay"
    // Mutation: change the setTimeout delay to e.g. 20ms → this assertion
    // would already be true at t=80ms above (PART B's first case), so the
    // two cases together pin the exact 120ms boundary.
    assert(/ork-sk-wrap/.test(el.innerHTML), "120ms elapsed with no swap(): the skeleton painted");
    assert(el.getAttribute("data-orcha-skeleton") === "1", "the container is marked while a skeleton is showing");
    Skeleton.swap(el, () => { el.innerHTML = "<div class=\"real\">content</div>"; });
    assert(/class="real"/.test(el.innerHTML) && !/ork-sk-wrap/.test(el.innerHTML),
      "swap() replaces the skeleton markup with the real render");
    assert(el.getAttribute("data-orcha-skeleton") === null, "swap() clears the skeleton marker");
  }

  // show() called twice on the same container before it fires is a no-op
  // (one timer, one paint) — a page's boot script + a stray re-boot call must
  // never double-schedule.
  {
    const { Skeleton, clock } = skeletonSandbox();
    const el = makeNode("roster");
    Skeleton.show(el, "roster");
    Skeleton.show(el, "roster");   // second call while the first is still pending
    assert(clock.pendingCount() === 1, "a second show() while one is already pending schedules no extra timer");
  }

  // cancel() before the timer fires means the skeleton never paints at all —
  // used when a page unmounts a region before its first tick.
  {
    const { Skeleton, clock } = skeletonSandbox();
    const el = makeNode("detailMain");
    Skeleton.show(el, "detail-pane");
    Skeleton.cancel(el);
    clock.advance(500);   // well past 120ms
    // Mutation: forget to actually clearTimeout inside cancel() → this fails
    // (RED): the stale timer still fires and paints skeleton markup nobody
    // asked for anymore.
    assert(el.innerHTML === "", "cancel() before the delay stops the skeleton from ever painting");
  }
}

/* ---------------- PART C — reduced motion (CSS) -------------------------- */
function reducedMotionCssTests() {
  console.log("\nPART C — reduced motion disables shimmer + fade animations\n");

  // Mutation: delete the reduced-motion block for .ork-sk → the shimmer
  // sweep would keep animating for users who opted out of motion.
  const skMatch = SKELETON_CSS.match(/@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}\s*\n\s*\/\* ---- content swap/);
  assert(!!skMatch, "a prefers-reduced-motion: reduce block exists before the content-swap section");
  assert(skMatch && /\.ork-sk\s*\{[^}]*animation:\s*none/.test(skMatch[1]),
    "under reduced motion, .ork-sk sets animation: none (the shimmer sweep stops)");

  // Mutation: remove/typo the .ork-fade-in reduced-motion override → the
  // swap fade would keep translating/opacity-animating under reduced motion.
  const fadeReduced = SKELETON_CSS.match(/@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.ork-fade-in\s*\{\s*animation:\s*none;?\s*\}\s*\}/);
  assert(!!fadeReduced, ".ork-fade-in { animation: none } is scoped under its own reduced-motion block");

  // The base (motion-on) rules must still declare real animations — otherwise
  // the reduced-motion checks above would be trivially true (nothing to reduce).
  assert(/@keyframes ork-shimmer/.test(SKELETON_CSS), "a real ork-shimmer keyframe exists (there is motion to reduce)");
  assert(/@keyframes ork-fade-in/.test(SKELETON_CSS), "a real ork-fade-in keyframe exists (there is motion to reduce)");
  assert(/\.ork-sk\s*\{[\s\S]*?animation:\s*ork-shimmer/.test(SKELETON_CSS), ".ork-sk's default (motion-on) rule animates with ork-shimmer");
  assert(/\.ork-fade-in\s*\{\s*animation:\s*ork-fade-in/.test(SKELETON_CSS), ".ork-fade-in's default (motion-on) rule animates with ork-fade-in");

  // JS side: reducedMotion() must actually gate swap()'s class toggle (the
  // CSS rule alone is not enough if JS unconditionally adds .ork-fade-in —
  // this pins that JS reads prefers-reduced-motion and skips the class).
  {
    const { Skeleton, sandbox } = skeletonSandbox({ reducedMotion: true });
    const el = makeNode("x");
    sandbox.document = undefined;   // ensure nothing but classList is touched
    Skeleton.swap(el, () => {});
    // Mutation: remove the `if (!reducedMotion())` guard around the classList
    // calls in swap() → this fails (RED): the fade class would be added even
    // though the OS/browser asked for no motion.
    assert(!el.classList.contains("ork-fade-in"), "under reduced motion, swap() never adds the .ork-fade-in class");
  }
  {
    const { Skeleton } = skeletonSandbox({ reducedMotion: false });
    const el = makeNode("x");
    Skeleton.swap(el, () => {});
    assert(el.classList.contains("ork-fade-in"), "with motion allowed, swap() adds .ork-fade-in so the content eases in");
  }
}

/* ---------------- PART D — token-only colors (no hex literals) ---------- */
function tokenOnlyColorTests() {
  console.log("\nPART D — skeleton.css uses design tokens only, no hex/rgb literals\n");

  // Strip comments first so a comment mentioning a color in prose (there are
  // none today, but this keeps the check honest) can't produce a false RED.
  const css = SKELETON_CSS.replace(/\/\*[\s\S]*?\*\//g, "");

  // Mutation: hardcode any color (e.g. `background: #1c2532;` instead of
  // `var(--surface-2)`) anywhere in this file → this fails (RED) — the brief
  // requires the skeleton to look right in EVERY skin (classic/swiss/minimal)
  // purely via the token layer, with zero skin-specific overrides.
  const hexHits = css.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
  assert(hexHits.length === 0,
    "no hex color literals anywhere in skeleton.css" + (hexHits.length ? " — found: " + JSON.stringify(hexHits) : ""));

  // rgb()/rgba() would be an equally hardcoded escape hatch around the token
  // layer (tokens.css itself only uses rgba() INSIDE its own var() bodies,
  // never in a consuming stylesheet like this one).
  const rgbHits = css.match(/\brgba?\(/g) || [];
  assert(rgbHits.length === 0,
    "no rgb()/rgba() color literals anywhere in skeleton.css" + (rgbHits.length ? " — " + rgbHits.length + " found" : ""));

  // Positive check: the file actually USES the token layer for its visible
  // surfaces (a file with zero colors at all would trivially pass the two
  // checks above without doing anything).
  for (const tok of ["--surface-2", "--surface-3", "--border", "--surface"]) {
    assert(css.indexOf("var(" + tok + ")") !== -1, "skeleton.css consumes var(" + tok + ") at least once");
  }
}

/* ---------------- PART E — every target page's boot wires it (grep) ------ */
function bootWiringTests() {
  console.log("\nPART E — every target page's boot/render path wires OrchaSkeleton\n");

  const PAGES = [
    { label: "tasks", file: ["pages", "tasks-boot.js"], kinds: ["list-rows", "detail-pane"] },
    { label: "agents", file: ["pages", "agents-boot.js"], kinds: ["roster", "detail-pane"] },
    { label: "home/dashboard", file: ["pages", "home-render.js"], kinds: ["list-rows"] },
    { label: "requests", file: ["pages", "requests-actions.js"], kinds: ["list-rows", "detail-pane"] },
    { label: "metrics", file: ["pages", "metrics-render.js"], kinds: ["stat-cards"] },
    { label: "github", file: ["pages", "github-boot.js"], kinds: ["list-rows"] },
  ];

  for (const p of PAGES) {
    const src = read(...p.file);
    // Mutation: delete the `if (window.OrchaSkeleton) { OrchaSkeleton.show(...) }`
    // block from any one page → this fails (RED) for exactly that page, since
    // OrchaSkeleton.show/.swap wouldn't appear in its source at all anymore.
    assert(/OrchaSkeleton\.show\(/.test(src), p.label + "'s boot path calls OrchaSkeleton.show(...)");
    assert(/OrchaSkeleton\.swap\(/.test(src), p.label + "'s render path calls OrchaSkeleton.swap(...)");
    for (const kind of p.kinds) {
      assert(src.indexOf('"' + kind + '"') !== -1, p.label + ' uses the "' + kind + '" skeleton kind');
    }
    // Mutation: call OrchaSkeleton.show/.swap unconditionally (no feature
    // guard) → an embedder/test harness that never loads app-skeleton.js
    // would throw on first render instead of degrading to a plain render.
    assert(/window\.OrchaSkeleton/.test(src), p.label + " guards the calls behind `window.OrchaSkeleton` (safe if the module isn't loaded)");
  }

  // The module itself must actually be wired into each of the 5 pages' <head>
  // script list (not just referenced from the *-boot.js source, which would
  // still 404 at runtime without the <script> tag).
  const PAGE_HTML = ["tasks.html", "agents.html", "home.html", "requests.html", "metrics.html"];
  for (const html of PAGE_HTML) {
    const src = read(html);
    // Mutation: remove the <script src="/assets/modules/app-skeleton.js">
    // tag from one page's <head>/<body> script list → OrchaSkeleton stays
    // undefined at runtime on exactly that page, silently degrading to "no
    // skeleton, no fade" there only.
    assert(/<script src="\/assets\/modules\/app-skeleton\.js"><\/script>/.test(src),
      html + " loads /assets/modules/app-skeleton.js");
  }
}

/* ---------------- PART F — swap() clears state so a re-show works -------- */
function reshowAfterSwapTests() {
  console.log("\nPART F — swap() leaves no stuck skeleton state behind\n");

  const { Skeleton, clock } = skeletonSandbox();
  const el = makeNode("tlist");

  Skeleton.show(el, "list-rows");
  clock.advance(200);
  assert(/ork-sk-wrap/.test(el.innerHTML), "sanity: the skeleton is showing before the swap");

  Skeleton.swap(el, () => { el.innerHTML = "<div class=\"real\">A</div>"; });
  assert(el.getAttribute("data-orcha-skeleton") === null, "after swap(), the skeleton marker is gone");

  // A second show()/advance()/swap() cycle on the SAME container (e.g. a page
  // that re-shows a skeleton for a filter change) must behave identically to
  // the first — nothing left over from the prior cycle should short-circuit it.
  // Mutation: forget to clear the per-container state map entry in cancel()
  // → the second show() would see a stale {showing:true} and no-op forever,
  // leaving the container stuck on its FIRST swap's content.
  Skeleton.show(el, "list-rows");
  clock.advance(200);
  assert(/ork-sk-wrap/.test(el.innerHTML), "a fresh show() after a prior swap() paints a skeleton again (state was fully cleared)");
  Skeleton.swap(el, () => { el.innerHTML = "<div class=\"real\">B</div>"; });
  assert(/class="real">B/.test(el.innerHTML), "the second swap() lands its own content");
}

/* ---------------- PART G — <link> inclusion across all 8 page heads ------ */
function cssInclusionTests() {
  console.log("\nPART G — skeleton.css is <link>ed in every page head\n");

  assert(fs.existsSync(SKELETON_CSS_PATH), "static/styles/skeleton.css exists");

  const PAGES = ["home.html", "projects.html", "agents.html", "onboarding.html",
    "metrics.html", "tasks.html", "requests.html", "settings.html", "github.html"];
  for (const page of PAGES) {
    const html = read(page);
    // Mutation: remove the <link> from one page (copy-paste miss on a new
    // page) → fails (RED) for exactly that page — same convention
    // skin_minimal_css.test.js pins for skin-minimal.css.
    assert(/<link rel="stylesheet" href="\/assets\/styles\/skeleton\.css">/.test(html),
      page + " <link>s /assets/styles/skeleton.css");

    // Mirrors the skin-minimal precedent this brief explicitly follows:
    // "immediately visible in each page's head" — right after skin-minimal.css.
    const skinIdx = html.indexOf('href="/assets/styles/skin-minimal.css"');
    const skelIdx = html.indexOf('href="/assets/styles/skeleton.css"');
    assert(skinIdx !== -1 && skelIdx !== -1 && skelIdx > skinIdx && skelIdx - skinIdx < 120,
      page + " loads skeleton.css immediately after skin-minimal.css");
  }

  // The styles.css compatibility @import entrypoint (still used by at least
  // one page's include list) must carry it too, mirroring skin-minimal.css's
  // own @import line there.
  const stylesCss = read("styles.css");
  assert(/@import url\("\/assets\/styles\/skeleton\.css"\);/.test(stylesCss),
    "styles.css compatibility entrypoint @imports skeleton.css");
}

function run() {
  console.log("page_skeletons.test.js\n");
  apiContractTests();
  delayTests();
  reducedMotionCssTests();
  tokenOnlyColorTests();
  bootWiringTests();
  reshowAfterSwapTests();
  cssInclusionTests();
  console.log("\n" + (failures === 0 ? "ALL PASSED" : failures + " FAILED"));
  process.exit(failures === 0 ? 0 : 1);
}

run();
