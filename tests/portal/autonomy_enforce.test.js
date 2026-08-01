/* ============================================================================
   GH #207 (mig 034) — the "Enforce for all agents" lock chip beside the 3-level
   autonomy slider (#autTop). containers.autonomy_enforced:
     • unlit (default) — per-agent autonomy overrides APPLY;
     • lit "🔒 Enforced" — every override is IGNORED, the container level governs
       every agent. Clicking confirms → POST /autonomy with the UNCHANGED level +
       autonomy_enforced, optimistic + reconcile/revert (the setAutonomy shape).

   Same dependency-free harness as autonomy_switch.test.js: stub DOM + fetch, load
   the REAL portal app.js in a vm sandbox, drive the wired path. The seg regex is
   extended with data-enforce so the chip is addressable; the LEVEL count contract
   (exactly 3 data-level segs) is re-asserted here so the chip never masquerades
   as a fourth level.

   Run:  node tests/portal/autonomy_enforce.test.js
   ========================================================================== */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const APP_JS = path.join(
  __dirname, "..", "..",
  "orcha-cli", "orcha_cli", "templates", "portal", "static", "app.js"
);
const SRC = fs.readFileSync(APP_JS, "utf8");

let failures = 0;
function assert(cond, msg) {
  if (cond) { console.log("  ✓ " + msg); }
  else { failures++; console.error("  ✗ " + msg); }
}

// ---- tiny fake DOM (autonomy_switch harness + data-enforce awareness) ------
function makeNode(id) {
  const n = {
    id: id || "", _class: "", _html: "", _segs: null, _segHtml: null,
    dataset: {}, onclick: null, onkeydown: null,
    get className() { return n._class; },
    set className(v) { n._class = v || ""; },
    get innerHTML() { return n._html; },
    set innerHTML(v) { n._html = v == null ? "" : String(v); },
    classList: {
      _set: () => new Set(n._class.split(/\s+/).filter(Boolean)),
      toggle: (c, on) => { const s = n.classList._set(); if (on === undefined) { s.has(c) ? s.delete(c) : s.add(c); } else if (on) s.add(c); else s.delete(c); n._class = [...s].join(" "); },
      add: (c) => { const s = n.classList._set(); s.add(c); n._class = [...s].join(" "); },
      remove: (c) => { const s = n.classList._set(); s.delete(c); n._class = [...s].join(" "); },
      contains: (c) => n.classList._set().has(c),
    },
    setAttribute: () => {}, getAttribute: () => null,
    addEventListener: () => {}, insertAdjacentElement: () => {}, appendChild: () => {}, focus: () => {},
    _parseSegs: () => {
      if (n._segHtml !== n._html) {
        const segs = [];
        const re = /<span class="([^"]*)"\s+data-(notif|level|enforce)="([^"]*)"/g;
        let m;
        while ((m = re.exec(n._html))) {
          const seg = makeNode("");
          seg._class = m[1];
          seg.dataset = {}; seg.dataset[m[2]] = m[3];
          segs.push(seg);
        }
        n._segs = segs; n._segHtml = n._html;
      }
      return n._segs;
    },
    querySelector: (sel) => {
      if (!/seg/.test(sel)) return null;
      const segs = n._parseSegs();
      return segs.length ? segs[0] : null;
    },
    querySelectorAll: (sel) => {
      if (!/seg/.test(sel)) return [];
      return n._parseSegs();
    },
  };
  return n;
}

function makeSandbox(opts) {
  opts = opts || {};
  const reg = {};
  ["notifTop", "autTop", "topbar", "pausebar", "resumeBtn", "__mc", "__mp"].forEach((id) => { reg[id] = makeNode(id); });

  const captured = { modalHandlers: [] };
  reg.__mp.addEventListener = (ev, fn) => { if (ev === "click") captured.modalHandlers.push(fn); };
  reg.__mc.addEventListener = () => {};

  const store = {};
  const localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  };
  const documentElement = { setAttribute: () => {}, getAttribute: () => null };
  const document = {
    documentElement, body: makeNode("body"),
    addEventListener: () => {},
    createElement: () => {
      const el = makeNode("");
      Object.defineProperty(el, "id", {
        get() { return el._id || ""; },
        set(v) { el._id = v; reg[v] = el; },
      });
      return el;
    },
    getElementById: (id) => (id in reg ? reg[id] : null),
    querySelectorAll: () => [],
  };
  const fetchCalls = [];
  const window = { matchMedia: () => ({ matches: false }) };
  const sandbox = {
    window, document, localStorage, console,
    requestAnimationFrame: (fn) => fn(), setTimeout: (fn) => (fn && fn(), 0), clearTimeout: () => {},
    fetch: (url, init) => {
      const body = init && init.body ? JSON.parse(init.body) : null;
      fetchCalls.push({ url, body });
      if (opts.failFetch) return Promise.reject(new Error("network"));
      // Route-aware echo: /autonomy returns the level + the (possibly flipped) enforce switch.
      const res = /\/autonomy$/.test(url)
        ? { container_id: "c1", autonomy_level: body.level,
            autonomy_enforced: body.autonomy_enforced === undefined ? false : body.autonomy_enforced }
        : { container_id: "c1", wakes_enabled: body.enabled };
      return Promise.resolve({ ok: true, json: () => Promise.resolve(res) });
    },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: "app.js" });
  return { Orcha: sandbox.window.Orcha, ORCHA: sandbox.window.ORCHA, reg, fetchCalls, captured, store };
}

const tick = () => new Promise((r) => setImmediate(r));
const enforceSeg = (s) => s.reg.autTop.querySelectorAll(".seg").find((x) => x.dataset.enforce);
const levelSegs = (s) => s.reg.autTop.querySelectorAll(".seg").filter((x) => x.dataset.level);

async function run() {
  console.log("autonomy_enforce.test.js — GH #207 (enforce-for-all lock chip)\n");

  const human = { id: "h1", alias: "Op", kind: "human" };

  // --- Case 1: default render — chip present, unlit; 3 levels untouched ------
  {
    console.log("Case 1: default snapshot → enforce chip rendered UNLIT beside exactly 3 level segs");
    const s = makeSandbox();
    s.Orcha.applySnapshot({ container: { id: "c1", wakes_enabled: true, autonomy_level: "plan" }, agents: [human], tasks: [], requests: [] });
    const chip = enforceSeg(s);
    assert(!!chip, "the enforce chip renders in the autonomy host");
    assert(/\block\b/.test(chip._class), "chip carries the .lock class (not .lvl)");
    assert(!/\bon\b/.test(chip._class), "chip is unlit by default (mig-034 default: not enforced)");
    assert(levelSegs(s).length === 3, "still exactly 3 data-level segs (the chip is NOT a 4th level)");
  }

  // --- Case 2: enforced snapshot → chip lit with the lock glyph --------------
  {
    console.log("\nCase 2: autonomy_enforced=true in the snapshot → chip lit '🔒 Enforced'");
    const s = makeSandbox();
    s.Orcha.applySnapshot({ container: { id: "c1", wakes_enabled: true, autonomy_level: "pr", autonomy_enforced: true }, agents: [human], tasks: [], requests: [] });
    const chip = enforceSeg(s);
    assert(/\bon\b/.test(chip._class), "chip lit while enforced");
    assert(/🔒/.test(s.reg.autTop.innerHTML), "lock glyph shown while enforced");
  }

  // --- Case 3: click (off) → confirm → POST {level unchanged, enforced:true} -
  {
    console.log("\nCase 3: click Enforce (off) → confirm → POST carries the UNCHANGED level + autonomy_enforced:true, optimistic + reconcile");
    const s = makeSandbox();
    s.Orcha.applySnapshot({ container: { id: "c1", wakes_enabled: true, autonomy_level: "pr" }, agents: [human], tasks: [], requests: [] });
    enforceSeg(s).onclick();
    assert(s.fetchCalls.length === 0, "no POST before confirm");
    assert(/Enforce autonomy for all agents\?/.test(s.reg.__ov.innerHTML), "confirm modal asks to enforce");
    s.captured.modalHandlers.forEach((fn) => fn());
    assert(s.ORCHA.container.autonomy_enforced === true, "optimistic: switch flips on immediately");
    assert(s.fetchCalls.length === 1, "exactly one POST fired");
    assert(/\/api\/containers\/c1\/autonomy$/.test(s.fetchCalls[0].url), "POST hits the SAME /autonomy route");
    assert(s.fetchCalls[0].body.autonomy_enforced === true, "body.autonomy_enforced === true");
    assert(s.fetchCalls[0].body.level === "pr", "body re-sends the UNCHANGED level (a flip never moves the slider)");
    assert(s.fetchCalls[0].body.actor_agent_id === "h1", "body carries the acting human id");
    await tick();
    assert(s.ORCHA.container.autonomy_enforced === true, "reconciled from response (still enforced)");
    assert(s.ORCHA.container.autonomy_level === "pr", "level untouched by the enforce flip");
  }

  // --- Case 4: click (on) → confirm → POST {enforced:false} ------------------
  {
    console.log("\nCase 4: click Enforced (on) → confirm → POST {autonomy_enforced:false} re-honors overrides");
    const s = makeSandbox();
    s.Orcha.applySnapshot({ container: { id: "c1", wakes_enabled: true, autonomy_level: "plan", autonomy_enforced: true }, agents: [human], tasks: [], requests: [] });
    enforceSeg(s).onclick();
    assert(/Stop enforcing the container level\?/.test(s.reg.__ov.innerHTML), "confirm modal asks to stop enforcing");
    s.captured.modalHandlers.forEach((fn) => fn());
    await tick();
    assert(s.fetchCalls.length === 1 && s.fetchCalls[0].body.autonomy_enforced === false, "POST {autonomy_enforced:false} fired");
    assert(s.ORCHA.container.autonomy_enforced === false, "switch reconciled off");
  }

  // --- Case 5: failed POST reverts the optimistic flip -----------------------
  {
    console.log("\nCase 5: enforce POST failure reverts the optimistic flip");
    const s = makeSandbox({ failFetch: true });
    s.Orcha.applySnapshot({ container: { id: "c1", wakes_enabled: true, autonomy_level: "plan" }, agents: [human], tasks: [], requests: [] });
    enforceSeg(s).onclick();
    s.captured.modalHandlers.forEach((fn) => fn());
    assert(s.ORCHA.container.autonomy_enforced === true, "optimistic flip applied");
    await tick();
    assert(s.ORCHA.container.autonomy_enforced === false, "reverted after the POST failed");
  }

  // --- Case 6: no acting human → click is a no-op ----------------------------
  {
    console.log("\nCase 6: no acting human → clicking the chip POSTs nothing, opens nothing");
    const s = makeSandbox();
    s.Orcha.applySnapshot({ container: { id: "c1", wakes_enabled: true, autonomy_level: "plan" }, agents: [], tasks: [], requests: [] });
    enforceSeg(s).onclick();
    assert(s.fetchCalls.length === 0, "no POST without an acting human");
    assert(!s.reg.__ov, "no confirm modal without an acting human");
  }

  // --- Case 7: poll reconcile — an external flip repaints the chip -----------
  {
    console.log("\nCase 7: a later snapshot (poll) repaints the enforce chip");
    const s = makeSandbox();
    s.Orcha.applySnapshot({ container: { id: "c1", wakes_enabled: true, autonomy_level: "plan" }, agents: [human], tasks: [], requests: [] });
    assert(!/\bon\b/.test(enforceSeg(s)._class), "starts unlit");
    s.Orcha.applySnapshot({ container: { id: "c1", wakes_enabled: true, autonomy_level: "plan", autonomy_enforced: true }, agents: [human], tasks: [], requests: [] });
    assert(/\bon\b/.test(enforceSeg(s)._class), "poll flip → chip lit");
  }

  // --- Case 8: enforce is orthogonal to the level click path ------------------
  {
    console.log("\nCase 8: setting a LEVEL never flips the enforce switch (orthogonal fields)");
    const s = makeSandbox();
    s.Orcha.applySnapshot({ container: { id: "c1", wakes_enabled: true, autonomy_level: "plan", autonomy_enforced: true }, agents: [human], tasks: [], requests: [] });
    const pr = levelSegs(s).find((x) => x.dataset.level === "pr");
    pr.onclick();
    s.captured.modalHandlers.forEach((fn) => fn());
    await tick();
    assert(s.ORCHA.container.autonomy_level === "pr", "level moved to 'pr'");
    assert(s.fetchCalls.length === 1 && s.fetchCalls[0].body.autonomy_enforced === undefined, "level POST omits autonomy_enforced (partial update)");
    assert(s.ORCHA.container.autonomy_enforced === true, "enforce switch untouched by a level change");
  }

  console.log("\n" + (failures === 0 ? "ALL PASSED ✅" : failures + " FAILED ❌"));
  process.exit(failures === 0 ? 0 : 1);
}

run();
