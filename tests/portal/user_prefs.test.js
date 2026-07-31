/* ============================================================================
   Per-user cosmetic preferences (mig 040) — the frontend half.

   PART A  boot apply-order (REAL modules/app-prefs.js): /api/prefs non-null ⇒
           SERVER WINS — theme/skin/sidebar applied to <html> AND mirrored into
           localStorage (so the pre-paint script stays instant); prefs null ⇒
           the module deactivates: nothing applied, nothing mirrored, and no
           PUT can ever fire (self-host byte-identical).
   PART B  write-through: the REAL local writers (app-state.js applyTheme /
           cycleTheme) still write localStorage synchronously and call
           OrchaPrefs.queuePut; a burst of queuePut calls debounces into ONE
           PUT carrying the FULL local bag.
   PART C  static wiring: every shell page loads modules/app-prefs.js.
   PART D  the default star (REAL pages/projects-state.js + projects-boot.js
           wireDefStars): rendered only when server prefs are active, `on` for
           the marked cid, click toggles setDefaultCid (set → unset) and
           repaints in place.
   PART E  default_cid consumption (REAL data.js resolveCid): used ONLY at the
           last fallback — ?cid= and the saved switcher pick outrank it, and an
           absent/invalid star falls back to active/first unchanged.

   Dependency-free (house vm-sandbox style). Run:
     node tests/portal/user_prefs.test.js
   ========================================================================== */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const STATIC = path.join(
  __dirname, "..", "..",
  "orcha-cli", "orcha_cli", "templates", "portal", "static"
);
const read = (...p) => fs.readFileSync(path.join(STATIC, ...p), "utf8");

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log("  ✓ " + msg);
  else { failures++; console.error("  ✗ " + msg); }
}
const flush = () => new Promise((resolve) => setImmediate(resolve));

const esc = (s) => (s == null ? "" : String(s)).replace(/[&<>"']/g, (c) => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/* ---- shared sandbox scaffolding ---------------------------------------- */
function prefsSandbox(opts) {
  opts = opts || {};
  const store = Object.assign({}, opts.seed || {});
  const htmlAttrs = {};
  const fetches = [];       // {url, method, body}
  const timers = [];        // captured setTimeout callbacks (manual debounce firing)
  const sandbox = {
    window: {}, console, encodeURIComponent, JSON,
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; },
    },
    document: {
      documentElement: {
        setAttribute: (k, v) => { htmlAttrs[k] = v; },
        getAttribute: (k) => (k in htmlAttrs ? htmlAttrs[k] : null),
        removeAttribute: (k) => { delete htmlAttrs[k]; },
      },
      getElementById: () => null,
      addEventListener() {},
    },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].cancelled = true; },
    fetch: (url, init) => {
      fetches.push({ url: String(url), method: (init && init.method) || "GET",
        body: init && init.body ? JSON.parse(init.body) : null });
      if (!init || !init.method) {           // the boot GET
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ prefs: opts.serverPrefs }) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ prefs: {} }) });
    },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read("modules", "app-prefs.js"), sandbox, { filename: "app-prefs.js" });
  const fireTimers = () => {
    const due = timers.splice(0);
    due.forEach((t) => { if (!t.cancelled) t.fn(); });
  };
  return { sandbox, store, htmlAttrs, fetches, timers, fireTimers,
           Prefs: sandbox.window.OrchaPrefs };
}

/* ---------------- PART A — boot apply-order ------------------------------ */
async function bootApplyTests() {
  console.log("PART A — boot: server wins, mirrors to localStorage\n");

  // trusted+mapped: server prefs beat stale local picks
  let s = prefsSandbox({
    seed: { "orcha:theme": "dark", "orcha:sidebar": "expanded" },
    serverPrefs: { theme: "light", skin: "swiss", sidebar: "collapsed", default_cid: "c9" },
  });
  const applied = await s.Prefs.sync();
  assert(applied && applied.theme === "light", "sync() resolves the server bag");
  assert(s.htmlAttrs["data-theme"] === "light",
    "server theme wins over the localStorage pick (applied to <html>)");
  assert(s.htmlAttrs["data-skin"] === "swiss", "server skin applied");
  assert(s.htmlAttrs["data-sidebar"] === "collapsed", "server sidebar applied");
  assert(s.store["orcha:theme"] === "light" && s.store["orcha:skin"] === "swiss"
    && s.store["orcha:sidebar"] === "collapsed",
    "…and every value is mirrored INTO localStorage (pre-paint stays instant)");
  assert(s.store["orcha:defaultCid"] === "c9", "default_cid mirrors too");
  assert(s.Prefs.active() === true, "the module reports active");
  const n = s.fetches.length;
  await s.Prefs.sync();
  assert(s.fetches.length === n, "sync() is single-flight — one GET per page load");

  // 'classic' skin clears the attribute (same contract as applySkin)
  s = prefsSandbox({ serverPrefs: { skin: "classic" } });
  s.htmlAttrs["data-skin"] = "swiss";
  await s.Prefs.sync();
  assert(!("data-skin" in s.htmlAttrs), "skin 'classic' removes data-skin");

  // self-host / untrusted / unmapped: null deactivates everything
  s = prefsSandbox({ seed: { "orcha:theme": "dark" }, serverPrefs: null });
  const nul = await s.Prefs.sync();
  assert(nul === null && s.Prefs.active() === false,
    "prefs:null → inactive (the stay-on-localStorage signal)");
  assert(s.store["orcha:theme"] === "dark" && !("data-theme" in s.htmlAttrs),
    "…nothing applied, nothing mirrored — localStorage untouched");
  s.Prefs.queuePut(); s.fireTimers();
  assert(s.fetches.filter((f) => f.method === "PUT").length === 0,
    "…and queuePut can never PUT (self-host byte-identical)");
}

/* ---------------- PART B — write-through debounce ------------------------ */
async function writeThroughTests() {
  console.log("\nPART B — write-through: localStorage now, ONE debounced PUT\n");

  const s = prefsSandbox({ serverPrefs: { theme: "dark" } });
  await s.Prefs.sync();

  // load the REAL app-state.js on top so its applyTheme/cycleTheme run against
  // the same sandbox (toast/syncThemeLabel need stubs)
  vm.runInContext("function toast(){}\nfunction syncThemeLabel(){}", s.sandbox);
  vm.runInContext(read("modules", "app-state.js"), s.sandbox, { filename: "app-state.js" });

  vm.runInContext('cycleTheme()', s.sandbox);
  assert(s.store["orcha:theme"] === "light",
    "cycleTheme still writes localStorage synchronously (dark → light)");
  assert(s.timers.length === 1, "…and queues the debounced PUT");
  vm.runInContext('cycleTheme()', s.sandbox);   // flip again inside the window
  assert(s.store["orcha:theme"] === "dark", "second flip lands locally too");
  const puts = () => s.fetches.filter((f) => f.method === "PUT");
  assert(puts().length === 0, "no PUT before the debounce window closes");
  s.fireTimers();
  assert(puts().length === 1, "a burst of toggles coalesces into ONE PUT");
  assert(puts()[0].url === "/api/prefs" && puts()[0].body.prefs.theme === "dark",
    "…carrying the FULL current local bag (final theme wins)");

  // the star writer shares the same pipe
  s.Prefs.setDefaultCid("c2");
  assert(s.store["orcha:defaultCid"] === "c2", "setDefaultCid mirrors locally first");
  s.fireTimers();
  assert(puts().length === 2 && puts()[1].body.prefs.default_cid === "c2",
    "star toggle PUTs through the same debounced pipe");
  s.Prefs.setDefaultCid(null);
  assert(!("orcha:defaultCid" in s.store), "setDefaultCid(null) clears the mark");
  s.fireTimers();
  assert(!("default_cid" in puts()[2].body.prefs),
    "…and the whole-bag PUT omits the key — server-side unset");
}

/* ---------------- PART C — static wiring --------------------------------- */
function staticWiringTests() {
  console.log("\nPART C — every shell page loads app-prefs.js\n");
  const pages = ["home.html", "tasks.html", "requests.html", "agents.html",
    "settings.html", "metrics.html", "projects.html", "onboarding.html"];
  for (const p of pages) {
    assert(/\/assets\/modules\/app-prefs\.js/.test(read(p)), p + " loads modules/app-prefs.js");
  }
}

/* ---------------- PART D — the default star ------------------------------ */
function starSandbox() {
  const sandbox = { window: {}, console, encodeURIComponent };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  sandbox.window.Orcha = {
    esc,
    icon: (name, cls) => `<svg class="${cls || "ico"}" data-icon="${name}"></svg>`,
    avatar: () => "<span></span>", ghAvatar: () => "<span></span>",
    orcaSVG: () => "<svg></svg>",
  };
  vm.runInContext(read("pages", "projects-state.js"), sandbox, { filename: "projects-state.js" });
  return sandbox;
}

const STAR_LIST = [
  { id: "c1", name: "Alpha", status: "active", agents: 1, tasks: 0, needs_you: 0 },
  { id: "c2", name: "Beta", status: "active", agents: 1, tasks: 0, needs_you: 3 },
];

function starRenderTests() {
  console.log("\nPART D — default-star render (pure builders)\n");
  const sb = starSandbox();
  vm.runInContext("window.__list = " + JSON.stringify(STAR_LIST) + ";", sb);

  const off = vm.runInContext("projectsGridHtml(window.__list, null)", sb);
  assert(!/defstar/.test(off),
    "no opts (self-host / prefs null) renders NO star markup at all");

  const on = vm.runInContext(
    'projectsGridHtml(window.__list, { stars: true, defaultCid: "c1" })', sb);
  assert((on.match(/data-def-cid=/g) || []).length === 2,
    "stars mode renders one star per card");
  const c1 = on.slice(0, on.indexOf('data-proj-card="c2"'));
  const c2 = on.slice(on.indexOf('data-proj-card="c2"'));
  assert(/defstar on/.test(c1) && /aria-pressed="true"/.test(c1),
    "the marked card's star is ON (aria-pressed)");
  assert(!/defstar on/.test(c2) && /aria-pressed="false"/.test(c2),
    "the other card's star is off");
  assert(/click to unset/.test(c1) && /Make this your default project/.test(c2),
    "titles state the toggle semantics both ways");

  const none = vm.runInContext(
    "projectsGridHtml(window.__list, { stars: true, defaultCid: null })", sb);
  assert(!/defstar on/.test(none), "no mark yet → every star off");
}

async function starWiringTests() {
  console.log("\nPART D2 — star click wiring (real projects-boot.js)\n");
  const reg = {};
  const setCalls = [];
  let def = "c1";
  function node(id, attrs) {
    const n = {
      _id: id, _attrs: attrs || {}, _listeners: {}, _class: "",
      title: "",
      getAttribute: (k) => (k in n._attrs ? n._attrs[k] : null),
      setAttribute(k, v) { n._attrs[k] = String(v); },
      classList: {
        toggle(c, force) {
          const has = n._class.indexOf(c) >= 0;
          const want = force !== undefined ? !!force : !has;
          if (want && !has) n._class += " " + c;
          if (!want && has) n._class = n._class.replace(" " + c, "");
        },
        add() {}, remove() {}, contains: (c) => n._class.indexOf(c) >= 0,
      },
      addEventListener(ev, fn) { (n._listeners[ev] = n._listeners[ev] || []).push(fn); },
      click() { (n._listeners.click || []).forEach((f) => f()); },
      querySelector: () => null, querySelectorAll: () => [],
    };
    if (id) reg[id] = n;
    return n;
  }
  const s1 = node("s1", { "data-def-cid": "c1" });
  const s2 = node("s2", { "data-def-cid": "c2" });
  const grid = node("projGrid");
  grid.querySelectorAll = (sel) => (sel === "[data-def-cid]" ? [s1, s2] : []);

  const sandbox = {
    window: {
      Orcha: new Proxy({}, { get: () => () => "" }),
      OrchaPrefs: {
        defaultCid: () => def,
        setDefaultCid: (v) => { setCalls.push(v); def = v; },
        sync: () => Promise.resolve({}), active: () => true,
      },
    },
    console, encodeURIComponent,
    document: { getElementById: (id) => reg[id] || null, addEventListener() {} },
    localStorage: { getItem: () => null, setItem() {} },
    location: { assign() {} },
    setInterval: () => 1, clearInterval() {}, setTimeout: () => 0, clearTimeout() {},
    // boot's renderProjects fires on load; a rejecting fetch sends it down the
    // early-return error path so only wireDefStars (called directly) matters
    fetch: () => Promise.reject(new Error("offline")),
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext("const PrjO = window.Orcha;", sandbox);   // projects-state's global
  vm.runInContext(read("pages", "projects-boot.js"), sandbox, { filename: "projects-boot.js" });

  sandbox.__grid = grid;
  vm.runInContext("wireDefStars(__grid)", sandbox);

  s2.click();   // mark Beta (was Alpha)
  assert(setCalls.length === 1 && setCalls[0] === "c2",
    "clicking an unmarked star sets THAT cid as default");
  assert(s2.classList.contains("on") && !s1.classList.contains("on"),
    "…and repaints in place — new star on, old star off");
  s2.click();   // toggle off
  assert(setCalls[1] === null, "clicking the marked star UNSETS the default");
  assert(!s2.classList.contains("on"), "…and the star dims");
}

/* ---------------- PART E — resolveCid uses the star LAST ----------------- */
function cidSandbox(opts) {
  const store = Object.assign({}, opts.seed || {});
  const sandbox = {
    window: {}, console, encodeURIComponent, URLSearchParams, Date, JSON,
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; },
    },
    location: { pathname: "/", search: opts.search || "", assign() {} },
    setInterval: () => 1, clearInterval() {}, setTimeout: () => 0, clearTimeout() {},
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({
      containers: opts.containers }) }),
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read("data.js"), sandbox, { filename: "data.js" });
  return { sandbox, store };
}

async function defaultCidTests() {
  console.log("\nPART E — resolveCid: ?cid= > switcher pick > star > active/first\n");
  const CONT = [
    { id: "c1", status: "active" }, { id: "c2", status: "active" },
    { id: "c3", status: "paused" },
  ];

  let s = cidSandbox({ containers: CONT, seed: { "orcha:defaultCid": "c2" } });
  let cid = await s.sandbox.window.OrchaData.resolveCid();
  assert(cid === "c2", "no ?cid, no saved pick → the starred default wins over first");

  s = cidSandbox({ containers: CONT,
    seed: { "orcha:defaultCid": "c2", "orcha:cid": "c3" } });
  cid = await s.sandbox.window.OrchaData.resolveCid();
  assert(cid === "c3", "the browser's own switcher pick outranks the star");

  s = cidSandbox({ containers: CONT, search: "?cid=c1",
    seed: { "orcha:defaultCid": "c2", "orcha:cid": "c3" } });
  cid = await s.sandbox.window.OrchaData.resolveCid();
  assert(cid === "c1", "an explicit ?cid= outranks everything");

  s = cidSandbox({ containers: CONT, seed: { "orcha:defaultCid": "gone" } });
  cid = await s.sandbox.window.OrchaData.resolveCid();
  assert(cid === "c1", "a stale star (project deleted) falls back to active/first");

  s = cidSandbox({ containers: CONT });
  cid = await s.sandbox.window.OrchaData.resolveCid();
  assert(cid === "c1", "no star at all (self-host): active/first — unchanged");
}

async function run() {
  console.log("user_prefs.test.js\n");
  await bootApplyTests();
  await writeThroughTests();
  staticWiringTests();
  starRenderTests();
  await starWiringTests();
  await defaultCidTests();
  console.log("\n" + (failures === 0 ? "ALL PASSED" : failures + " FAILED"));
  process.exit(failures === 0 ? 0 : 1);
}

run();
