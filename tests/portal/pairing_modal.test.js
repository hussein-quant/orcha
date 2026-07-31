/* ============================================================================
   Mobile pairing portal wiring.

   PART A  fallback shell (app.js standalone): Pair phone control + modal entry.
   PART B  identity-correct pairing (real modules/app-pairing.js): a trusted
           resolved identity pairs AS THAT USER — no "Pair as" selector, the
           payload fetch carries no human_agent_id, and the "Pairing as" line
           is the house GitHub chip (avatar + login).
   PART C  trust off (self-host): the >1-human selector contract is unchanged.
   PART D  honest network copy: cloud (https page / https payload) vs local
           Wi-Fi wording in the subtitle and footer.
   PART E  branded QR card + the expiry chip overflow fix (CSS contract).

   Dependency-free: loads the real sources in a small DOM harness.

   Run: node tests/portal/pairing_modal.test.js
   ========================================================================== */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const STATIC = path.join(
  __dirname, "..", "..",
  "orcha-cli", "orcha_cli", "templates", "portal", "static"
);
const read = (...p) => fs.readFileSync(path.join(STATIC, ...p), "utf8");
const APP_JS = path.join(STATIC, "app.js");
const SETTINGS_HTML = path.join(STATIC, "settings.html");
const SETTINGS_JS = path.join(STATIC, "settings.js");
const SRC = fs.readFileSync(APP_JS, "utf8");

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log("  ✓ " + msg);
  else { failures++; console.error("  ✗ " + msg); }
}
const flush = () => new Promise((resolve) => setImmediate(resolve));

function makeNode(id) {
  const n = {
    id: id || "", _class: "", _html: "", _listeners: {}, _children: {},
    get className() { return n._class; },
    set className(v) { n._class = v || ""; },
    get innerHTML() { return n._html; },
    set innerHTML(v) { n._html = v == null ? "" : String(v); },
    textContent: "",
    classList: {
      _set: () => new Set(n._class.split(/\s+/).filter(Boolean)),
      add: (c) => { const s = n.classList._set(); s.add(c); n._class = [...s].join(" "); },
      remove: (c) => { const s = n.classList._set(); s.delete(c); n._class = [...s].join(" "); },
      contains: (c) => n.classList._set().has(c),
      toggle: (c, on) => { const s = n.classList._set(); if (on) s.add(c); else s.delete(c); n._class = [...s].join(" "); },
    },
    setAttribute: () => {}, getAttribute: () => null,
    addEventListener: (ev, fn) => { (n._listeners[ev] = n._listeners[ev] || []).push(fn); },
    appendChild: () => {}, insertAdjacentElement: () => {}, focus: () => {}, blur: () => {},
    contains: () => false, querySelector: (sel) => n._children[sel] || null, querySelectorAll: () => [],
  };
  return n;
}

/* ---------------- PART A — fallback shell (app.js standalone) ------------ */
function makeSandbox() {
  const reg = {};
  ["sidebar", "topbar", "autTop", "attnPill", "themeBtn"].forEach((id) => { reg[id] = makeNode(id); });
  reg.attnPill._children[".n"] = makeNode("");

  const document = {
    documentElement: { setAttribute() {}, getAttribute() { return null; } },
    body: makeNode("body"),
    activeElement: null,
    addEventListener() {},
    createElement() {
      const el = makeNode("");
      Object.defineProperty(el, "id", {
        get() { return el._id || ""; },
        set(v) { el._id = v; reg[v] = el; },
      });
      return el;
    },
    getElementById(id) { return reg[id] || null; },
    querySelectorAll() { return []; },
  };
  const sandbox = {
    window: { matchMedia: () => ({ matches: false }) },
    document,
    localStorage: { getItem: () => null, setItem() {} },
    console,
    requestAnimationFrame: (fn) => fn(),
    setInterval: () => 1, clearInterval: () => {},
    setTimeout: () => 0, clearTimeout: () => {},
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({
      v: 1, kind: "orcha-pair", baseUrl: "http://192.168.1.24:8001",
      containerId: "c1", containerName: "openorcha", humanAgentId: "h1", humanAgentAlias: "Kedar",
      token: "t", shortCode: "ABCD-1234", expiresAt: "2099-01-01T00:00:00Z", qrSvg: "<svg></svg>",
    }) }),
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: "app.js" });
  return { Orcha: sandbox.window.Orcha, reg };
}

function fallbackTests() {
  console.log("PART A — fallback shell (app.js standalone)\n");

  const s = makeSandbox();
  s.Orcha.applySnapshot({
    container: { id: "c1", name: "openorcha", wakes_enabled: true },
    agents: [{ id: "h1", alias: "Kedar", kind: "human" }],
    tasks: [], requests: [],
  });
  s.Orcha.mountShell("home", { title: "Dashboard" });

  assert(/id="pairPhoneBtn"/.test(s.reg.topbar.innerHTML), "topbar includes the Pair phone button");
  assert(/Pair phone/.test(s.reg.topbar.innerHTML), "button text is visible");
  assert(typeof s.Orcha.openPairingModal === "function", "openPairingModal is exported for Settings");

  s.Orcha.openPairingModal();
  assert(s.reg.__ov && s.reg.__ov.classList.contains("show"), "pairing modal opens on the shared overlay");
  assert(/Pair your phone/.test(s.reg.__ov.innerHTML), "modal title is rendered");
  assert(/Preparing pairing code/.test(s.reg.__ov.innerHTML), "modal starts in a loading state before the QR payload arrives");

  const settingsHtml = fs.readFileSync(SETTINGS_HTML, "utf8");
  const settingsJs = fs.readFileSync(SETTINGS_JS, "utf8");
  assert(/id="pairingCard"/.test(settingsHtml), "Settings page has a phone pairing card host");
  assert(/settingsPairPhone/.test(settingsJs) && /openPairingModal/.test(settingsJs), "Settings card opens the same pairing modal");
}

/* ---------------- real-module harness ------------------------------------ */
function moduleSandbox(opts) {
  opts = opts || {};
  const reg = {};
  const fetches = [];
  const payload = Object.assign({
    v: 1, kind: "orcha-pair", baseUrl: "http://192.168.1.24:8001",
    containerId: "c1", containerName: "openorcha",
    humanAgentId: "h1", humanAgentAlias: "octocat",
    token: "t", shortCode: "ABCD-1234", expiresAt: "2099-01-01T00:00:00Z",
    qrSvg: '<svg data-qr="1"></svg>',
  }, opts.payload || {});
  const document = {
    documentElement: { setAttribute() {}, getAttribute: () => null },
    body: makeNode("body"),
    addEventListener() {},
    createElement() {
      const el = makeNode("");
      Object.defineProperty(el, "id", {
        get() { return el._id || ""; },
        set(v) { el._id = v; reg[v] = el; },
      });
      return el;
    },
    // lazily materialize ids so the module's nested renders (pairBody,
    // pairCountText) land on inspectable nodes
    getElementById: (id) => reg[id] || (reg[id] = makeNode(id)),
  };
  const sandbox = {
    window: {}, document, console, encodeURIComponent, Date,
    localStorage: { getItem: () => null, setItem() {} },
    setInterval: () => 1, clearInterval() {}, setTimeout: () => 0, clearTimeout() {},
    fetch: (url) => {
      fetches.push(String(url));
      if (opts.error) {
        return Promise.resolve({ ok: false, status: opts.error.status,
          json: () => Promise.resolve({ detail: opts.error.detail }) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve(payload) });
    },
  };
  if (opts.locationProtocol) sandbox.location = { protocol: opts.locationProtocol };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`
    var D = { container: { id: "c1", name: "openorcha" } };
    var __humans = ${JSON.stringify(opts.humans || [{ id: "h1", alias: "Kedar", kind: "human" }])};
    function humans() { return __humans; }
    function actingHuman() { return __humans[0] || null; }
    function aliasFor() { return null; }
    function esc(s) { return s == null ? "" : String(s); }
    function icon() { return "<svg></svg>"; }
    function orcaSVG() { return "<svg data-orca></svg>"; }
    function toast() {}
    function identityTrusted() { return ${!!opts.trusted}; }
    function identity() { return ${JSON.stringify(opts.identity || null)}; }
    function ghAvatar(login, size) { return '<span class="av gh human" data-gh="' + login + '"></span>'; }
  `, sandbox);
  vm.runInContext(read("modules", "app-pairing.js"), sandbox, { filename: "app-pairing.js" });
  return { sandbox, reg, fetches };
}

/* ---------------- PART B — trusted identity: no selector, house chip ----- */
async function trustedIdentityTests() {
  console.log("\nPART B — trusted identity pairs AS THAT USER (no selector)\n");
  const s = moduleSandbox({
    trusted: true,
    identity: { agent_id: "h1", alias: "octocat", github_login: "octocat", member_role: "owner", grants: [] },
    humans: [
      { id: "h1", alias: "octocat", kind: "human" },
      { id: "h2", alias: "Dana", kind: "human" },
    ],
  });
  vm.runInContext("openPairingModal()", s.sandbox);
  await flush(); await flush();

  assert(!/id="pairHuman"/.test(s.reg.__ov.innerHTML),
    "no 'Pair as' selector even with several humans — identity IS the pairing human");
  assert(s.fetches.length === 1 && s.fetches[0] === "/api/containers/c1/pairing",
    "the payload fetch carries NO human_agent_id (the server resolves + enforces)");
  const body = s.reg.pairBody._html;
  assert(/pair-identity/.test(body) && /data-gh="octocat"/.test(body),
    "the 'Pairing as' line is the house GitHub chip (avatar + login)");
  assert(/gh-login">octocat</.test(body), "…showing the login");
  assert(!/octocat \(human\)/.test(body), "…not the roster '(alias) (human)' text");
  vm.runInContext("closeModal()", s.sandbox);
}

/* ---------------- PART C — trust off: selector contract unchanged -------- */
async function trustOffTests() {
  console.log("\nPART C — trust off (self-host): selector contract unchanged\n");
  const multi = moduleSandbox({
    trusted: false, identity: null,
    humans: [
      { id: "h1", alias: "Kedar", kind: "human" },
      { id: "h2", alias: "Dana", kind: "human" },
    ],
    payload: { humanAgentAlias: "Kedar" },
  });
  vm.runInContext("openPairingModal()", multi.sandbox);
  await flush(); await flush();
  assert(/id="pairHuman"/.test(multi.reg.__ov.innerHTML),
    ">1 human still renders the 'Pair as' selector");
  assert(/Kedar \(human\)/.test(multi.reg.__ov.innerHTML) && /Dana \(human\)/.test(multi.reg.__ov.innerHTML),
    "…listing the roster");
  assert(multi.fetches[0] === "/api/containers/c1/pairing?human_agent_id=h1",
    "the fetch still carries the selected human");
  assert(/Kedar \(human\)/.test(multi.reg.pairBody._html),
    "the 'Pairing as' line keeps the alias text (no GitHub chip without identity)");
  assert(!/pair-identity/.test(multi.reg.pairBody._html),
    "…and no identity chip renders");

  const solo = moduleSandbox({ trusted: false, identity: null,
    humans: [{ id: "h1", alias: "Kedar", kind: "human" }] });
  vm.runInContext("openPairingModal()", solo.sandbox);
  await flush(); await flush();
  assert(!/id="pairHuman"/.test(solo.reg.__ov.innerHTML), "a single human auto-selects (no selector)");
}

/* ---------------- PART D — honest network copy --------------------------- */
async function copyTests() {
  console.log("\nPART D — cloud-true vs local-first copy\n");

  const local = moduleSandbox({ trusted: false, identity: null });
  vm.runInContext("openPairingModal()", local.sandbox);
  await flush(); await flush();
  assert(/same Wi-Fi network/.test(local.reg.__ov.innerHTML),
    "http/local page keeps the Wi-Fi subtitle");
  assert(/Nothing goes through the cloud/.test(local.reg.pairBody._html),
    "…and the local-first footer (http payload URL)");
  assert(!/works from anywhere/.test(local.reg.__ov.innerHTML), "…with no cloud wording");

  const cloud = moduleSandbox({
    trusted: true,
    identity: { agent_id: "h1", alias: "octocat", github_login: "octocat" },
    locationProtocol: "https:",
    payload: { baseUrl: "https://orcha.example.dev" },
  });
  vm.runInContext("openPairingModal()", cloud.sandbox);
  await flush(); await flush();
  assert(/works from anywhere/.test(cloud.reg.__ov.innerHTML),
    "https page: the subtitle says the phone works from anywhere");
  assert(!/same Wi-Fi network/.test(cloud.reg.__ov.innerHTML), "…dropping the Wi-Fi claim");
  assert(/sign-in perimeter/.test(cloud.reg.pairBody._html),
    "…and the footer is cloud-true (HTTPS through the sign-in perimeter)");
  assert(!/Nothing goes through the cloud/.test(cloud.reg.pairBody._html),
    "…never claiming 'nothing goes through the cloud'");

  // honest even when the PAGE is http but the payload URL is https (proxy edge)
  const mixed = moduleSandbox({ trusted: false, identity: null,
    payload: { baseUrl: "https://orcha.example.dev" } });
  vm.runInContext("openPairingModal()", mixed.sandbox);
  await flush(); await flush();
  assert(/sign-in perimeter/.test(mixed.reg.pairBody._html),
    "an https payload URL alone flips the footer cloud-true");

  // warnings: the Wi-Fi troubleshooting foot is local-only; string 403 details render
  const denied = moduleSandbox({
    trusted: true, identity: null, locationProtocol: "https:",
    error: { status: 403, detail: "your GitHub account ('mallory') is not a member of this project — ask an owner for an invite" },
  });
  vm.runInContext("openPairingModal()", denied.sandbox);
  await flush(); await flush();
  assert(/not a member of this project/.test(denied.reg.pairBody._html),
    "a plain-string 403 detail renders as the warning message");
  assert(!/same Wi-Fi/.test(denied.reg.pairBody._html),
    "…without the local Wi-Fi troubleshooting foot in cloud context");

  const localWarn = moduleSandbox({ trusted: false, identity: null,
    error: { status: 409, detail: { title: "Phones can't reach this Orcha yet", message: "localhost only" } } });
  vm.runInContext("openPairingModal()", localWarn.sandbox);
  await flush(); await flush();
  assert(/same Wi-Fi/.test(localWarn.reg.pairBody._html),
    "local warnings keep the Wi-Fi troubleshooting foot");
}

/* ---------------- PART E — branded card + expiry chip overflow fix ------- */
async function brandAndOverflowTests() {
  console.log("\nPART E — branded QR card + expiry chip (overflow fix)\n");
  const s = moduleSandbox({ trusted: false, identity: null });
  vm.runInContext("openPairingModal()", s.sandbox);
  await flush(); await flush();
  const body = s.reg.pairBody._html;

  assert(/class="pair-card"/.test(body), "the QR sits inside the branded card");
  assert(/pair-wordmark">Orcha</.test(body) && /data-orca/.test(body),
    "…with the orca mark + Orcha wordmark");
  assert(/pair-scanline">Scan with the Orcha app</.test(body),
    "…and the scan caption inside the card");
  assert(/data-qr="1"/.test(body), "the server-styled QR SVG is embedded as-is");
  assert(/pair-url mono">http:\/\/192\.168\.1\.24:8001</.test(body),
    "the URL line is kept beneath the code");

  assert(/class="pill s-warn pair-expiry" id="pairCountdown"/.test(body),
    "the expiry chip carries the pair-expiry wrap class");
  assert(/<span id="pairCountText">/.test(body),
    "the countdown ticks into a span (the glyph survives re-ticks)");
  assert(/regenerates automatically/.test(s.reg.pairCountText.textContent),
    "the countdown text renders into the chip");

  const overlays = read("styles", "overlays.css");
  const expiry = (overlays.match(/\.pair-expiry \{[^}]*\}/) || [""])[0];
  assert(/white-space: normal/.test(expiry) && /max-width: 100%/.test(expiry),
    "overlays.css lets the sentence-length chip WRAP inside its border (.pill is nowrap)");
  assert(/\.pair-card \{/.test(overlays) && /\.pair-wordmark \{/.test(overlays)
    && /\.pair-scanline \{/.test(overlays), "the branded card is styled with tokens");
  assert(/\.pair-identity \{[^}]*inline-flex/.test(overlays), "the identity chip style exists");

  // overlays.css OWNS the pairing modal styles — the #191 duplicate tail must
  // not creep back into conversation.css (it loads after and would win)
  const conv = read("styles", "conversation.css").replace(/\/\*[\s\S]*?\*\//g, "");
  assert(!/\.pair-(qr|grid|card|remedy)/.test(conv),
    "conversation.css carries no duplicated pairing rules (overlays.css owns them)");
  assert(/\.pair-card \{ width: min\(296px/.test(overlays),
    "the narrow-viewport pairing rules live in overlays.css");
}

async function run() {
  console.log("pairing_modal.test.js\n");
  fallbackTests();
  await trustedIdentityTests();
  await trustOffTests();
  await copyTests();
  await brandAndOverflowTests();
  console.log("\n" + (failures === 0 ? "ALL PASSED" : failures + " FAILED"));
  process.exit(failures === 0 ? 0 : 1);
}

run();
