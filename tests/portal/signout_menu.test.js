/* ============================================================================
   Collab — the acting-as chip ACCOUNT MENU (sign out).

   Dependency-free (mirrors collab_members.test.js): loads the real shell
   modules (app-state/app-text/app-data/app-ui/app-shell) in a vm sandbox and
   pins:
     PART A  actingMenuHtml() — the pure builder: GitHub login header + the one
             "Sign out" action, a PLAIN <a> to /oauth2/sign_out?rd=%2Fwelcome
             (the oauth2-proxy owns the redirect — no fetch). Empty when the
             identity is null (self-host: no proxy session to clear).
     PART B  wireActingChip() + the shared floating menu — the chip becomes the
             menu trigger ONLY with a proxy-verified identity; click toggles,
             Escape / outside-click close, in-menu clicks don't.
     PART C  structural — mountShell wires the chip (id + wireActingChip call).

   Run: node tests/portal/signout_menu.test.js
   ========================================================================== */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const STATIC = path.join(
  __dirname, "..", "..",
  "orcha-cli", "orcha_cli", "templates", "portal", "static"
);
const read = (...p) => fs.readFileSync(path.join(STATIC, ...p), "utf8");
const SHELL_FILES = [
  ["modules", "app-state.js"], ["modules", "app-text.js"], ["modules", "app-data.js"],
  ["modules", "app-ui.js"], ["modules", "app-shell.js"],
];
const SHELL_SRC = read("modules", "app-shell.js");

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log("  ✓ " + msg);
  else { failures++; console.error("  ✗ " + msg); }
}

/* ---- tiny fake DOM --------------------------------------------------- */
function makeNode(id) {
  const n = {
    id: id || "", _class: "", _html: "", _attrs: {}, _listeners: {},
    style: {}, title: "", value: "",
    get innerHTML() { return n._html; },
    set innerHTML(v) { n._html = v == null ? "" : String(v); },
    get className() { return n._class; },
    set className(v) { n._class = v || ""; },
    classList: {
      _s: () => new Set(n._class.split(/\s+/).filter(Boolean)),
      add: (c) => { const s = n.classList._s(); s.add(c); n._class = [...s].join(" "); },
      remove: (c) => { const s = n.classList._s(); s.delete(c); n._class = [...s].join(" "); },
      contains: (c) => n.classList._s().has(c),
    },
    setAttribute: (k, v) => { n._attrs[k] = String(v); },
    getAttribute: (k) => (k in n._attrs ? n._attrs[k] : null),
    addEventListener: (ev, fn) => { (n._listeners[ev] = n._listeners[ev] || []).push(fn); },
    contains: () => false,
    querySelectorAll: () => [],
    appendChild: () => {},
  };
  return n;
}
function fire(node, ev, e) { (node._listeners[ev] || []).slice().forEach((fn) => fn(e || {})); }

/* ---- sandbox: real shell modules over the fake DOM -------------------- */
function shellSandbox() {
  const reg = {};
  const docListeners = {};
  const body = makeNode("body");
  body.appendChild = (child) => { if (child.id) reg[child.id] = child; };
  const sandbox = {
    window: { innerWidth: 1400 },
    document: {
      documentElement: { setAttribute() {}, getAttribute: () => null, removeAttribute() {} },
      body,
      getElementById: (id) => reg[id] || null,
      createElement: () => makeNode(""),
      addEventListener: (ev, fn) => { (docListeners[ev] = docListeners[ev] || []).push(fn); },
      activeElement: null,
    },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    console, encodeURIComponent,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  SHELL_FILES.forEach((p) => vm.runInContext(read(...p), sandbox, { filename: p.join("/") }));
  return { sandbox, reg, docListeners };
}
const docFire = (ls, ev, e) => (ls[ev] || []).slice().forEach((fn) => fn(e || {}));

/* ---------------- PART A — actingMenuHtml (pure builder) --------------- */
function builderTests() {
  console.log("PART A — actingMenuHtml (pure builder)\n");
  const { sandbox: sb } = shellSandbox();

  assert(vm.runInContext("SIGN_OUT_HREF", sb) === "/oauth2/sign_out?rd=%2Fwelcome",
    "SIGN_OUT_HREF is the proxy sign-out with rd back to /welcome");

  vm.runInContext(`window.ORCHA.identity = { agent_id: "h1", alias: "octocat",
    github_login: "octocat", member_role: "owner" };`, sb);
  const html = vm.runInContext("actingMenuHtml()", sb);
  assert(/pm-head/.test(html) && /github\.com\/octocat\.png/.test(html),
    "menu header carries the GitHub avatar");
  assert(/"t1">octocat</.test(html), "menu header names the signed-in login");
  assert(/"t2">owner · GitHub</.test(html), "menu header shows the member role · GitHub");
  assert(/<a class="pm-row signout" href="\/oauth2\/sign_out\?rd=%2Fwelcome">/.test(html),
    "sign out is a PLAIN <a> to /oauth2/sign_out?rd=%2Fwelcome (the proxy owns the redirect)");
  assert(/<span>Sign out<\/span>/.test(html), "the action reads 'Sign out'");
  assert(!/fetch\(/.test(html), "no scripted sign-out — navigation only");

  vm.runInContext(`window.ORCHA.identity = { agent_id: "h1", alias: "ada",
    github_login: "ada", member_role: null };`, sb);
  assert(/"t2">member · GitHub</.test(vm.runInContext("actingMenuHtml()", sb)),
    "a null member_role falls back to 'member'");

  vm.runInContext("window.ORCHA.identity = null;", sb);
  assert(vm.runInContext("actingMenuHtml()", sb) === "",
    "identity null (self-host) builds NO menu — nothing to sign out of");

  vm.runInContext('window.ORCHA.identity = { agent_id: "h1", alias: "local" };', sb);
  assert(vm.runInContext("actingMenuHtml()", sb) === "",
    "an identity without a github_login builds no menu either");
}

/* ------------- PART B — wireActingChip + the floating menu ------------- */
function wiringTests() {
  console.log("\nPART B — wireActingChip (chip → account menu)\n");

  /* identity null → the chip stays informational, untouched */
  {
    const { sandbox: sb, reg } = shellSandbox();
    reg.actingChip = makeNode("actingChip");
    vm.runInContext("window.ORCHA.identity = null;", sb);
    vm.runInContext("wireActingChip()", sb);
    assert(!reg.actingChip.classList.contains("menu-trigger") && !reg.actingChip._listeners.click,
      "no identity → chip is NOT a trigger (no class, no click handler)");
  }

  /* identity present → interactive chip; click toggles the amFloat menu */
  const { sandbox: sb, reg, docListeners } = shellSandbox();
  const chip = reg.actingChip = makeNode("actingChip");
  vm.runInContext(`window.ORCHA.identity = { agent_id: "h1", alias: "octocat",
    github_login: "octocat", member_role: "owner" };`, sb);
  vm.runInContext("wireActingChip()", sb);
  assert(chip.classList.contains("menu-trigger"), "identity → chip gets .menu-trigger");
  assert(chip._attrs.role === "button" && chip._attrs["aria-haspopup"] === "true",
    "chip is announced as a button with a popup");

  fire(chip, "click");
  const float = reg.amFloat;
  assert(!!float && float.classList.contains("show") && vm.runInContext('menuIsOpen("amFloat")', sb),
    "click opens the floating account menu");
  assert(/Sign out/.test(float._html) && /\/oauth2\/sign_out\?rd=%2Fwelcome/.test(float._html),
    "the open menu carries the sign-out link");

  fire(chip, "click");
  assert(!float.classList.contains("show") && !vm.runInContext('menuIsOpen("amFloat")', sb),
    "a second chip click closes it (toggle)");

  fire(chip, "click");
  docFire(docListeners, "keydown", { key: "Escape" });
  assert(!vm.runInContext('menuIsOpen("amFloat")', sb), "Escape closes the open menu");

  fire(chip, "click");
  docFire(docListeners, "click", { target: {} });
  assert(!vm.runInContext('menuIsOpen("amFloat")', sb), "an outside click closes the open menu");

  fire(chip, "click");
  const inMenu = {};
  float.contains = (t) => t === inMenu;
  docFire(docListeners, "click", { target: inMenu });
  assert(vm.runInContext('menuIsOpen("amFloat")', sb),
    "a click INSIDE the menu (the sign-out row) does not close it early");
}

/* --------------- PART C — mountShell wiring (structural) --------------- */
function structuralTests() {
  console.log("\nPART C — mountShell wiring (structural)\n");
  assert(/id="actingChip"/.test(SHELL_SRC), "the topbar acting chip carries id=actingChip");
  assert(/^\s*wireActingChip\(\);/m.test(SHELL_SRC), "mountShell calls wireActingChip() on every paint");
}

builderTests();
wiringTests();
structuralTests();
console.log("\n" + (failures === 0 ? "ALL PASSED" : failures + " FAILED"));
process.exit(failures === 0 ? 0 : 1);
