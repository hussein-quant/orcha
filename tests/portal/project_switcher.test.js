/* ============================================================================
   Multi-project (mig 037) — the sidebar PROJECT SWITCHER, the New-project flow,
   the orcha:cid data layer, and the "portal-only" dashboard notice.

   Dependency-free (mirrors collab_members.test.js): real portal sources in a vm
   sandbox over a tiny fake DOM. Pins:
     PART A  projSwitchHtml / projMenuHtml — pure builders (current highlighted,
             agents count, status dot, "+ New project" row, escaping).
     PART B  openProjectMenu — rows come FRESH from GET /api/containers; a row
             click hands off to OrchaData.switchProject; the current row is a
             no-op; fetch failure closes + toasts.
     PART C  openNewProjectModal / postNewProject — house modal → POST
             /api/containers {additional:true}; success flags the one-time
             notice + switches; 409 (duplicate name) toasts and keeps the modal.
     PART D  data.js — resolveCid precedence (?cid → saved orcha:cid → active/
             first) with STALE-CID fallback validated against the live list;
             switchProject persists + reloads the bare path.
     PART E  wakesServed — the notifier-binding stamp (containers.
             last_wake_scan_at) inside the 2-minute window; app.js standalone
             fallback reports served (no false alarms for embedders).
     PART F  renderProjNotice (home-state.js) — flagged + unserved shows the
             honest portal-only notice; dismissible; self-clears once a host
             daemon polls.

   Run: node tests/portal/project_switcher.test.js
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
const DATA_JS = read("data.js");
const APP_JS = read("app.js");
const HOME_STATE_JS = read("pages", "home-state.js");

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log("  ✓ " + msg);
  else { failures++; console.error("  ✗ " + msg); }
}
const flush = () => new Promise((resolve) => setImmediate(resolve));

/* ---- tiny fake DOM --------------------------------------------------- */
function makeNode(id) {
  const n = {
    id: id || "", _class: "", _html: "", _attrs: {}, _listeners: {}, _rows: {},
    style: {}, title: "", value: "",
    get innerHTML() { return n._html; },
    // like the real DOM, replacing the markup discards the old child nodes —
    // querySelectorAll after a re-render returns FRESH (unwired) rows.
    set innerHTML(v) { n._html = v == null ? "" : String(v); n._rows = {}; },
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
    appendChild: () => {},
    // enough querySelectorAll for wireProjMenuRows: derive row nodes from the
    // rendered markup, cached so re-queries return the SAME (wired) nodes.
    querySelectorAll: (sel) => {
      const mk = (key, attrs) => {
        if (!n._rows[key]) { const r = makeNode(""); r._attrs = attrs; n._rows[key] = r; }
        return n._rows[key];
      };
      if (sel === "[data-proj]") {
        return [...n._html.matchAll(/data-proj="([^"]+)"/g)]
          .map((m) => mk("p:" + m[1], { "data-proj": m[1] }));
      }
      if (sel === "[data-proj-new]") {
        return /data-proj-new/.test(n._html) ? [mk("new", { "data-proj-new": "1" })] : [];
      }
      return [];
    },
  };
  return n;
}
function fire(node, ev, e) { (node._listeners[ev] || []).slice().forEach((fn) => fn(e || {})); }

function shellSandbox(fetchImpl) {
  const reg = {};
  const toasts = [], modals = [], switches = [], closed = [];
  const store = {};
  const body = makeNode("body");
  body.appendChild = (child) => { if (child.id) reg[child.id] = child; };
  const sandbox = {
    window: { innerWidth: 1400 },
    document: {
      documentElement: { setAttribute() {}, getAttribute: () => null, removeAttribute() {} },
      body,
      getElementById: (id) => reg[id] || null,
      createElement: () => makeNode(""),
      addEventListener() {},
      activeElement: null,
    },
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; },
    },
    console, encodeURIComponent,
    fetch: fetchImpl || (() => Promise.reject(new Error("no fetch stubbed"))),
    // free identifiers app-shell resolves at CALL time (app-pairing.js in prod)
    toast: (m, k) => toasts.push({ m, k }),
    modal: (cfg) => modals.push(cfg),
    closeModal: () => closed.push(1),
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  SHELL_FILES.forEach((p) => vm.runInContext(read(...p), sandbox, { filename: p.join("/") }));
  sandbox.window.OrchaData = {
    currentCid: () => (sandbox.window.ORCHA.container || {}).id || null,
    switchProject: (cid) => switches.push(cid),
  };
  return { sandbox, reg, toasts, modals, switches, closed, store };
}

const LIST = { containers: [
  { id: "c1", name: "Website revamp", status: "active", agents: 3, last_wake_scan_at: "2026-07-30T12:00:00Z" },
  { id: "c2", name: "api <b>", status: "active", agents: 1, last_wake_scan_at: null },
  { id: "c3", name: "old-thing", status: "completed", last_wake_scan_at: null },
] };

/* ---------------- PART A — pure builders ------------------------------- */
function builderTests() {
  console.log("PART A — projSwitchHtml / projMenuHtml (pure builders)\n");
  const { sandbox: sb } = shellSandbox();

  vm.runInContext('window.ORCHA.container = { id: "c1", name: "Website revamp", status: "active" };', sb);
  const btn = vm.runInContext("projSwitchHtml()", sb);
  assert(/id="projSwitch"/.test(btn) && /class="proj-switch"/.test(btn),
    "switcher renders as the sidebar #projSwitch button");
  assert(/"pname">Website revamp</.test(btn), "switcher names the CURRENT project");
  assert(/pdot on/.test(btn), "an active project lights the status dot");
  assert(/aria-haspopup="true"/.test(btn) && /switch project/.test(btn),
    "announced as a popup trigger, titled as the switcher");

  vm.runInContext('window.ORCHA.container = { id: "c1", name: "Website revamp", status: "paused" };', sb);
  assert(!/pdot on/.test(vm.runInContext("projSwitchHtml()", sb)),
    "a non-active project keeps the dot unlit");
  vm.runInContext("window.ORCHA.container = null;", sb);
  assert(/"pname">—</.test(vm.runInContext("projSwitchHtml()", sb)),
    "no snapshot yet → an em-dash placeholder, never undefined");

  vm.runInContext("window.__list = " + JSON.stringify(LIST.containers) + ";", sb);
  const menu = vm.runInContext('projMenuHtml(window.__list, "c1")', sb);
  assert(/pm-head plain">Projects</.test(menu), "menu opens with the Projects header");
  assert(/pm-row proj on"[^>]*data-proj="c1"/.test(menu), "the CURRENT project row is highlighted");
  assert((menu.match(/class="chk"/g) || []).length === 1, "exactly one row carries the current check");
  assert(/pm-row proj"[^>]*data-proj="c2"/.test(menu), "other projects render un-highlighted");
  assert(/active · 3 agents/.test(menu) && /active · 1 agent</.test(menu),
    "rows carry status + live-agent count (singular/plural)");
  assert(/>completed</.test(menu) && !/completed · /.test(menu),
    "a row without an agents count shows status alone");
  assert(/api &lt;b&gt;/.test(menu), "project names are HTML-escaped");
  assert(/data-proj-new="1"/.test(menu) && /New project/.test(menu),
    "the menu ends with the + New project row");
  assert(/class="pm-row all" href="\/projects"/.test(menu) && /All projects/.test(menu),
    "the menu links to the /projects landing (All projects)");
}

/* ---------------- PART B — openProjectMenu flow ------------------------ */
async function menuFlowTests() {
  console.log("\nPART B — openProjectMenu (fresh list → pick → switch)\n");
  const calls = [];
  const ctx = shellSandbox((url) => {
    calls.push(String(url));
    return Promise.resolve({ ok: true, json: () => Promise.resolve(LIST) });
  });
  const { sandbox: sb, reg, switches } = ctx;
  reg.projSwitch = makeNode("projSwitch");
  vm.runInContext('window.ORCHA.container = { id: "c1", name: "Website revamp", status: "active" };', sb);

  vm.runInContext('openProjectMenu(document.getElementById("projSwitch"))', sb);
  assert(/Loading…/.test(reg.psFloat._html), "menu opens instantly with a loading row");
  await flush(); await flush();
  assert(calls[0] === "/api/containers", "rows come FRESH from GET /api/containers on open");
  assert(/data-proj="c1"/.test(reg.psFloat._html) && /data-proj="c2"/.test(reg.psFloat._html),
    "the loaded menu lists every project");
  assert(/pm-row proj on"[^>]*data-proj="c1"/.test(reg.psFloat._html),
    "the active cid's row is the highlighted one");

  const rows = reg.psFloat.querySelectorAll("[data-proj]");
  fire(rows.find((r) => r.getAttribute("data-proj") === "c2"), "click");
  assert(switches.length === 1 && switches[0] === "c2",
    "picking another project hands off to OrchaData.switchProject(cid)");
  assert(!vm.runInContext('menuIsOpen("psFloat")', sb), "the menu closes on pick");

  vm.runInContext('openProjectMenu(document.getElementById("projSwitch"))', sb);
  await flush(); await flush();
  fire(reg.psFloat.querySelectorAll("[data-proj]").find((r) => r.getAttribute("data-proj") === "c1"), "click");
  assert(switches.length === 1, "picking the CURRENT project is a no-op (no reload)");
  assert(!vm.runInContext('menuIsOpen("psFloat")', sb), "…but still closes the menu");

  vm.runInContext('openProjectMenu(document.getElementById("projSwitch"))', sb);
  await flush(); await flush();
  fire(reg.psFloat.querySelectorAll("[data-proj-new]")[0], "click");
  assert(ctx.modals.length === 1 && ctx.modals[0].title === "New project",
    "+ New project opens the house modal");
  assert(!vm.runInContext('menuIsOpen("psFloat")', sb), "the menu closes behind the modal");

  /* failure path: list unreachable */
  const bad = shellSandbox(() => Promise.reject(new Error("boom")));
  bad.reg.projSwitch = makeNode("projSwitch");
  vm.runInContext('openProjectMenu(document.getElementById("projSwitch"))', bad.sandbox);
  await flush(); await flush();
  assert(bad.toasts.some((t) => /Could not load projects/.test(t.m) && t.k === "danger"),
    "a failed list fetch toasts danger");
  assert(!vm.runInContext('menuIsOpen("psFloat")', bad.sandbox), "…and closes the stub menu");
}

/* ------------- PART C — New-project modal → POST /api/containers ------- */
async function newProjectTests() {
  console.log("\nPART C — openNewProjectModal / postNewProject\n");
  const calls = [];
  const ctx = shellSandbox((url, init) => {
    calls.push({ url: String(url), init: init || {} });
    return Promise.resolve({
      ok: true, status: 201,
      json: () => Promise.resolve({ container_id: "c9", root_task_id: "t9", name: "api-gateway", human_agent_id: "h9" }),
    });
  });
  const { sandbox: sb, reg, toasts, modals, switches, closed, store } = ctx;
  vm.runInContext('window.ORCHA.container = { id: "c1", name: "Website revamp", status: "active" };', sb);

  vm.runInContext("openNewProjectModal()", sb);
  const cfg = modals[0];
  assert(cfg && cfg.title === "New project" && cfg.primary === "Create project",
    "house modal: 'New project' with a Create primary");
  assert(/id="npName"/.test(cfg.body) && /id="npDesc"/.test(cfg.body),
    "modal body carries the name + description fields");
  assert(/Portal-only until a host workspace is bound/.test(cfg.desc),
    "modal copy is honest: portal-only until a host workspace binds");

  /* empty name → validation toast, no POST */
  reg.npName = makeNode("npName"); reg.npDesc = makeNode("npDesc");
  reg.npName.value = "   ";
  cfg.onPrimary();
  await flush();
  assert(toasts.some((t) => /name is required/.test(t.m) && t.k === "danger") && calls.length === 0,
    "an empty name toasts and never POSTs");

  /* happy path → POST {additional:true} → flag notice → switch */
  reg.npName.value = "api-gateway"; reg.npDesc.value = "Edge service";
  cfg.onPrimary();
  await flush(); await flush();
  const post = calls[0];
  assert(post && post.url === "/api/containers" && post.init.method === "POST",
    "create POSTs /api/containers");
  assert(post && post.init.body === '{"name":"api-gateway","description":"Edge service","additional":true}',
    "body carries name + description + additional:true (the multi-project opt-in)");
  assert(closed.length === 1, "success closes the modal");
  assert(store["orcha:projNotice:c9"] === "1",
    "success flags the one-time portal-only notice for the NEW cid");
  assert(toasts.some((t) => /Project created/.test(t.m) && t.k === "ok"), "success toasts");
  assert(switches[switches.length - 1] === "c9", "…and switches the portal to the new project");

  /* blank description travels as null */
  reg.npDesc.value = "";
  cfg.onPrimary();
  await flush(); await flush();
  assert(calls[1] && calls[1].init.body === '{"name":"api-gateway","description":null,"additional":true}',
    "a blank description is sent as null, not empty-string");

  /* 409 duplicate name → toast with the server detail, modal stays up */
  const dup = shellSandbox(() => Promise.resolve({
    ok: false, status: 409,
    json: () => Promise.resolve({ detail: "a project named 'api-gateway' already exists in this stack" }),
  }));
  vm.runInContext('window.ORCHA.container = { id: "c1", name: "w", status: "active" };', dup.sandbox);
  vm.runInContext("openNewProjectModal()", dup.sandbox);
  dup.reg.npName = makeNode("npName"); dup.reg.npDesc = makeNode("npDesc");
  dup.reg.npName.value = "api-gateway";
  dup.modals[0].onPrimary();
  await flush(); await flush();
  assert(dup.toasts.some((t) => /already exists/.test(t.m) && t.k === "danger"),
    "a 409 duplicate name surfaces the server detail as a danger toast");
  assert(dup.closed.length === 0 && dup.switches.length === 0,
    "…keeping the modal open (rename and retry), no switch");
}

/* ---------------- PART D — data.js: orcha:cid resolution ---------------- */
function dataSandbox(opts) {
  opts = opts || {};
  const assigns = [];
  const store = Object.assign({}, opts.store);
  const sandbox = {
    window: {},
    location: { search: opts.search || "", pathname: opts.path || "/", assign: (u) => assigns.push(u) },
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; },
    },
    fetch: opts.fetch || (() => Promise.reject(new Error("unreachable"))),
    console, URLSearchParams, encodeURIComponent,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(DATA_JS, sandbox, { filename: "data.js" });
  return { sandbox, assigns, store };
}
const listFetch = (containers) => () =>
  Promise.resolve({ ok: true, json: () => Promise.resolve({ containers }) });
const CIDS = [
  { id: "c1", name: "founding", status: "active" },
  { id: "c2", name: "second", status: "active" },
];

async function dataLayerTests() {
  console.log("\nPART D — data.js resolveCid / switchProject (orcha:cid)\n");

  let d = dataSandbox({ fetch: listFetch(CIDS), store: { "orcha:cid": "c2" } });
  assert(await d.sandbox.window.OrchaData.resolveCid() === "c2",
    "a persisted orcha:cid that still exists wins");

  d = dataSandbox({ fetch: listFetch(CIDS), store: { "orcha:cid": "gone" } });
  assert(await d.sandbox.window.OrchaData.resolveCid() === "c1" && d.store["orcha:cid"] === "c1",
    "a STALE persisted cid falls back to the first/active container and re-persists");

  d = dataSandbox({ fetch: listFetch(CIDS), search: "?cid=c2", store: { "orcha:cid": "c1" } });
  assert(await d.sandbox.window.OrchaData.resolveCid() === "c2" && d.store["orcha:cid"] === "c2",
    "an explicit ?cid= deep-link beats the persisted pick (and persists)");

  d = dataSandbox({ fetch: listFetch(CIDS), search: "?cid=gone", store: { "orcha:cid": "gone2" } });
  assert(await d.sandbox.window.OrchaData.resolveCid() === "c1",
    "a stale ?cid= AND a stale saved cid both fall back to the first container");

  d = dataSandbox({
    fetch: listFetch([{ id: "c1", name: "done", status: "completed" }, { id: "c2", name: "live", status: "active" }]),
  });
  assert(await d.sandbox.window.OrchaData.resolveCid() === "c2",
    "with no picks, the ACTIVE container beats an earlier completed one");

  d = dataSandbox({ store: { "orcha:cid": "c2" } });                    // fetch unreachable
  assert(await d.sandbox.window.OrchaData.resolveCid() === "c2",
    "list unreachable → trust the persisted pick (no false fallback)");
  d = dataSandbox({ search: "?cid=c7" });
  assert(await d.sandbox.window.OrchaData.resolveCid() === "c7",
    "list unreachable → trust the explicit ?cid=");

  d = dataSandbox({ path: "/tasks", search: "?task=t1" });
  d.sandbox.window.OrchaData.switchProject("c3");
  assert(d.store["orcha:cid"] === "c3", "switchProject persists the new cid");
  assert(d.assigns.length === 1 && d.assigns[0] === "/tasks?cid=c3",
    "…and reloads the SAME page with ?cid=<new> (old deep-link params dropped; "
    + "an explicit cid keeps the bare '/' reserved for the /projects landing)");
}

/* ---------------- PART E — wakesServed (notifier-binding stamp) --------- */
function wakesServedTests() {
  console.log("\nPART E — wakesServed (containers.last_wake_scan_at)\n");
  const { sandbox: sb } = shellSandbox();
  const at = (ms) => new Date(Date.now() - ms).toISOString();

  assert(vm.runInContext(`wakesServed({ last_wake_scan_at: "${at(30 * 1000)}" })`, sb) === true,
    "a wake-scan stamp seconds old ⇒ a host daemon serves this project");
  assert(vm.runInContext(`wakesServed({ last_wake_scan_at: "${at(10 * 60 * 1000)}" })`, sb) === false,
    "a stamp 10 minutes stale ⇒ NOT served (daemon gone)");
  assert(vm.runInContext("wakesServed({ last_wake_scan_at: null })", sb) === false,
    "NULL stamp (never polled) ⇒ portal-only");
  assert(vm.runInContext("wakesServed({})", sb) === false && vm.runInContext("wakesServed(null)", sb) === false,
    "missing field / no container ⇒ false, never throws");

  /* app.js standalone fallback: embedders without the modules must never
     see a false "portal-only" alarm */
  const fb = {
    window: {},
    document: { documentElement: { setAttribute() {}, getAttribute: () => null } },
    localStorage: { getItem: () => null, setItem() {} },
    console,
  };
  fb.globalThis = fb;
  vm.createContext(fb);
  vm.runInContext(APP_JS, fb, { filename: "app.js" });
  assert(fb.window.Orcha.wakesServed() === true,
    "app.js standalone fallback reports wakes as served (no false alarms)");
}

/* -------- PART F — renderProjNotice (home-state.js, dashboard) ---------- */
function homeSandbox() {
  const reg = { projNotice: makeNode("projNotice"), aqGrid: makeNode("aqGrid") };
  const store = {};
  const sandbox = {
    window: {},
    document: {
      documentElement: { setAttribute() {}, getAttribute: () => null },
      getElementById: (id) => {
        if (id === "projNoticeX") {                       // exists only while rendered
          if (!/projNoticeX/.test(reg.projNotice._html)) return null;
          if (!reg.projNoticeX) reg.projNoticeX = makeNode("projNoticeX");
          return reg.projNoticeX;
        }
        return reg[id] || null;
      },
    },
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; },
    },
    console,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  sandbox.window.ORCHA = { container: { id: "c9", name: "api-gateway", status: "active" }, agents: [], tasks: [], requests: [] };
  sandbox.window.Orcha = {
    patch: (el, html) => { if (el) el.innerHTML = html; return true; },
    icon: (name) => `<svg data-icon="${name}"></svg>`,
    esc: (s) => (s == null ? "" : String(s)),
    wakesServed: () => !!sandbox.__wakes,
  };
  vm.runInContext(HOME_STATE_JS, sandbox, { filename: "pages/home-state.js" });
  return { sandbox, reg, store };
}

function noticeTests() {
  console.log("\nPART F — renderProjNotice (the portal-only dashboard notice)\n");
  const { sandbox: sb, reg, store } = homeSandbox();
  const host = reg.projNotice;

  /* not flagged (founding project) → nothing */
  vm.runInContext("renderProjNotice()", sb);
  assert(host._html === "", "an unflagged project (the founding one) shows NO notice");

  /* flagged + no notifier serving → the honest notice */
  store["orcha:projNotice:c9"] = "1";
  sb.__wakes = false;
  vm.runInContext("renderProjNotice()", sb);
  assert(/Portal-only for now/.test(host._html), "flagged + unserved ⇒ the portal-only notice");
  assert(/orcha init/.test(host._html) && /fleet provisioner/.test(host._html),
    "copy names the host binding gap and what's coming — honest, not fake");
  assert(/nothing wakes agents yet/.test(host._html), "copy states the real limitation");
  assert(/data-icon="alert"/.test(host._html), "warn-toned: the alert glyph");
  assert(/id="projNoticeX"/.test(host._html), "the notice is dismissible");

  /* dismiss → flag cleared, notice gone */
  vm.runInContext("renderProjNotice()", sb);                 // re-render wires onclick
  reg.projNoticeX.onclick();
  assert(!("orcha:projNotice:c9" in store), "dismiss clears the one-time flag");
  assert(host._html === "", "…and the notice unrenders immediately");

  /* flagged but a daemon now polls → self-clears without a dismiss */
  store["orcha:projNotice:c9"] = "1";
  sb.__wakes = true;
  vm.runInContext("renderProjNotice()", sb);
  assert(host._html === "", "once a host daemon serves wakes, the notice self-clears");

  /* structural: the dashboard render loop + host div exist */
  assert(/renderProjNotice\(\);/.test(read("pages", "home-render.js")),
    "home-render.js paints the notice each render");
  assert(/id="projNotice"/.test(read("home.html")), "home.html carries the #projNotice host");
}

(async function run() {
  console.log("project_switcher.test.js\n");
  builderTests();
  await menuFlowTests();
  await newProjectTests();
  await dataLayerTests();
  wakesServedTests();
  noticeTests();
  console.log("\n" + (failures === 0 ? "ALL PASSED" : failures + " FAILED"));
  process.exit(failures === 0 ? 0 : 1);
})();
