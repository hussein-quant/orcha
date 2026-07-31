/* ============================================================================
   Projects landing (/projects) — the post-login hub.

   PART A  projects.html static structure (grid host, page assets).
   PART B  pure builders (pages/projects-state.js): card fields — name, repo
           chip, agents/tasks counts, needs-you badge, member avatars vs the
           roster-privacy count, Open href, per-card Pair-phone button — plus
           the + New project card and the empty state.
   PART C  QR scoping: the card button opens the REAL pairing modal
           (modules/app-pairing.js) against THAT project's cid — the payload
           fetch hits /api/containers/<that cid>/pairing, never the loaded
           container's.
   PART D  the "/" landing redirect (pages/home-render.js boot): bare / with
           N≠1 visible projects replaces to /projects; ?cid= deep links and the
           single-project case stay on the dashboard.

   Dependency-free (mirrors collab_members.test.js). Run:
     node tests/portal/projects_landing.test.js
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

const LIST = [
  {
    id: "c1", name: "Website revamp", description: "Marketing site & <b>docs</b>",
    status: "active", github_repo: "acme/site", agents: 3, tasks: 12, needs_you: 2,
    member_count: 2,
    members: [
      { alias: "octocat", github_login: "octocat", member_role: "owner" },
      { alias: "hubot", github_login: "hubot", member_role: "member" },
    ],
  },
  {
    id: "c2", name: "Beta", description: null, status: "paused",
    github_repo: null, agents: 1, tasks: 0, needs_you: 0,
    member_count: 4, members: null,   // roster privacy: count only
  },
];

/* ---------------- PART A — static structure ----------------------------- */
function staticTests() {
  console.log("PART A — projects.html static structure\n");
  const html = read("projects.html");
  assert(/id="projGrid"/.test(html), "the page carries the #projGrid host");
  assert(/id="projTop"/.test(html), "the page carries the #projTop chrome host");
  assert(/\/assets\/pages\/projects-state\.js/.test(html)
    && /\/assets\/pages\/projects-boot\.js/.test(html), "page assets are loaded");
  assert(/\/assets\/pages\/projects\.css/.test(html), "page css is loaded");
  assert(/\/assets\/modules\/app-pairing\.js/.test(html),
    "the pairing module rides along (per-card QR)");
}

/* ---------------- PART B — pure builders -------------------------------- */
function builderSandbox() {
  const sandbox = {
    window: {},
    console, encodeURIComponent,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  sandbox.window.Orcha = {
    esc,
    icon: (name, cls) => `<svg class="${cls || "ico"}" data-icon="${name}"></svg>`,
    avatar: (alias, kind, size) => `<span class="av ${size || ""} ${kind}">${esc((alias || "?").charAt(0).toUpperCase())}</span>`,
    ghAvatar: (login, size) => `<span class="av gh ${size || ""} human">${esc((login || "?").charAt(0).toUpperCase())}<img class="gh-face" src="https://github.com/${login}.png?size=96"></span>`,
    orcaSVG: () => "<svg></svg>",
  };
  vm.runInContext(read("pages", "projects-state.js"), sandbox, { filename: "projects-state.js" });
  vm.runInContext("window.__list = " + JSON.stringify(LIST) + ";", sandbox);
  return sandbox;
}

function builderTests() {
  console.log("\nPART B — projectCardHtml / projectsGridHtml (pure builders)\n");
  const sb = builderSandbox();

  const grid = vm.runInContext("projectsGridHtml(window.__list)", sb);
  assert(/data-proj-card="c1"/.test(grid) && /data-proj-card="c2"/.test(grid),
    "one card per project");
  assert(/"pname">Website revamp</.test(grid), "cards carry the project name");
  assert(/Marketing site &amp; &lt;b&gt;docs&lt;\/b&gt;/.test(grid), "descriptions are HTML-escaped");
  assert(/No description yet\./.test(grid), "a null description gets the honest placeholder");
  assert(/prepo[^>]*title="acme\/site"/.test(grid) && />acme\/site</.test(grid.replace(/<svg[^>]*><\/svg>/g, "")) || /acme\/site/.test(grid),
    "the GitHub repo chip renders when bound");
  assert(/<b>3<\/b> agents/.test(grid) && /<b>1<\/b> agent</.test(grid),
    "agents count (singular/plural)");
  assert(/<b>12<\/b> tasks/.test(grid) && /<b>0<\/b> tasks/.test(grid), "tasks count");
  assert(/Needs you · 2/.test(grid), "a nonzero needs_you renders the badge");
  assert(!/Needs you · 0/.test(grid), "a zero needs_you renders NO badge");
  assert(/github\.com\/octocat\.png/.test(grid) && /github\.com\/hubot\.png/.test(grid),
    "a visible roster renders member avatars");
  const c2 = grid.slice(grid.indexOf('data-proj-card="c2"'));
  assert(!/gh-face/.test(c2) && /4 members/.test(c2),
    "roster privacy: members:null renders the COUNT, never avatars (c2)");
  assert(/href="\/\?cid=c1"/.test(grid) && /href="\/\?cid=c2"/.test(grid),
    "Open navigates to the project dashboard with ?cid=");
  assert(/data-pair-cid="c1"/.test(grid) && /data-pair-cid="c2"/.test(grid),
    "every card carries its own cid-scoped Pair-phone button");
  assert(/data-pair-name="Beta"/.test(c2), "the pair button carries the project name for the modal");
  assert(/id="projNew"/.test(grid) && /New project/.test(grid), "the grid ends with + New project");
  assert(/pdot on/.test(grid), "an active project lights the status dot");

  const empty = vm.runInContext("projectsGridHtml([])", sb);
  assert(/proj-empty/.test(empty) && /No projects yet/.test(empty),
    "an empty list renders the empty state");
  assert(/id="projNew"/.test(empty), "…still offering + New project");

  const top = vm.runInContext(
    'projTopHtml({ identity: { github_login: "octocat", member_role: "owner" } })', sb);
  assert(/github\.com\/octocat\.png/.test(top) && /octocat/.test(top),
    "the top chrome shows the signed-in identity");
  assert(/id="projTheme"/.test(top), "…and the theme toggle");
  assert(!/gh-face/.test(vm.runInContext("projTopHtml(null)", sb)),
    "no identity → no account chip (trust off)");
}

/* ---------------- PART C — cid-scoped pairing QR ------------------------ */
function makeNode(id) {
  const n = {
    id: id || "", _class: "", _html: "", _listeners: {},
    get innerHTML() { return n._html; },
    set innerHTML(v) { n._html = v == null ? "" : String(v); },
    classList: {
      add(c) { if (n._class.indexOf(c) < 0) n._class += " " + c; },
      remove() {}, contains: (c) => n._class.indexOf(c) >= 0,
    },
    setAttribute() {}, getAttribute: () => null,
    addEventListener(ev, fn) { (n._listeners[ev] = n._listeners[ev] || []).push(fn); },
    appendChild() {}, contains: () => false,
    querySelector: () => null, querySelectorAll: () => [],
  };
  return n;
}

async function pairingScopeTests() {
  console.log("\nPART C — per-card QR is cid-scoped (real app-pairing.js)\n");
  const reg = {};
  const fetches = [];
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
    getElementById: (id) => reg[id] || null,
  };
  const sandbox = {
    window: {}, document, console, encodeURIComponent,
    localStorage: { getItem: () => null, setItem() {} },
    setInterval: () => 1, clearInterval() {}, setTimeout: () => 0, clearTimeout() {},
    Date, // countdown parsing
    fetch: (url) => {
      fetches.push(String(url));
      return Promise.resolve({ ok: true, json: () => Promise.resolve({
        baseUrl: "http://x", humanAgentAlias: "octocat", shortCode: "AAAA-1111",
        expiresAt: "2099-01-01T00:00:00Z", qrSvg: "<svg data-qr></svg>",
      }) });
    },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  // module deps: the pairing module reads these shell globals
  vm.runInContext(`
    var D = { container: { id: "c1", name: "Website revamp" } };
    function humans() { return [{ id: "h1", alias: "octocat", kind: "human" }]; }
    function actingHuman() { return { id: "h1", alias: "octocat" }; }
    function aliasFor() { return "octocat"; }
    function esc(s) { return s == null ? "" : String(s); }
    function icon() { return "<svg></svg>"; }
    function orcaSVG() { return "<svg></svg>"; }
    function toast() {}
  `, sandbox);
  vm.runInContext(read("modules", "app-pairing.js"), sandbox, { filename: "app-pairing.js" });

  // Foreign-cid open (a landing card): the fetch targets THAT project's cid.
  vm.runInContext('openPairingModal({ cid: "c2", name: "Beta" })', sandbox);
  await flush(); await flush();
  assert(fetches.length === 1 && fetches[0] === "/api/containers/c2/pairing",
    "openPairingModal({cid:'c2'}) fetches /api/containers/c2/pairing — the card's project");
  assert(/Project: <b>Beta<\/b>/.test(reg.__ov.innerHTML),
    "the modal names the project it pairs against");
  assert(!/pairHuman/.test(reg.__ov.innerHTML),
    "a foreign-cid open skips the local-roster picker (server resolves/asks)");
  vm.runInContext("closeModal()", sandbox);

  // Default open (topbar): unchanged — the LOADED container's cid.
  vm.runInContext("openPairingModal()", sandbox);
  await flush(); await flush();
  assert(fetches[fetches.length - 1].indexOf("/api/containers/c1/pairing") === 0,
    "openPairingModal() still targets the loaded container (c1)");
}

/* ---------------- PART D — the "/" landing redirect --------------------- */
function homeBootSandbox(listCount, search) {
  const replaced = [];
  const started = [];
  const sandbox = {
    window: {
      Orcha: new Proxy({}, { get: () => () => null }),  // home-state top-level refs
      OrchaData: { start: (fn, ms) => started.push(ms) },
    },
    document: { getElementById: () => makeNode(""), addEventListener() {} },
    location: { search: search || "", hash: "", replace: (u) => replaced.push(u) },
    localStorage: { getItem: () => null, setItem() {} },
    console, encodeURIComponent,
    setInterval: () => 1, clearInterval() {}, setTimeout: (fn) => 0, clearTimeout() {},
    fetch: () => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({
        containers: Array.from({ length: listCount }, (_, i) => ({ id: "c" + (i + 1) })),
      }),
    }),
  };
  sandbox.globalThis = sandbox;
  sandbox.window.ORCHA = { container: null, agents: [], tasks: [], requests: [] };
  vm.createContext(sandbox);
  vm.runInContext(read("pages", "home-state.js"), sandbox, { filename: "home-state.js" });
  vm.runInContext(read("pages", "home-render.js"), sandbox, { filename: "home-render.js" });
  return { replaced, started };
}

async function redirectTests() {
  console.log("\nPART D — bare / belongs to /projects (home boot redirect)\n");

  let d = homeBootSandbox(2, "");
  await flush(); await flush();
  assert(d.replaced.length === 1 && d.replaced[0] === "/projects",
    "bare / with 2 projects replaces to /projects");
  assert(d.started.length === 0, "…and never boots the dashboard poll");

  d = homeBootSandbox(0, "");
  await flush(); await flush();
  assert(d.replaced[0] === "/projects",
    "bare / with 0 visible projects goes to the hub (empty state beats an error toast)");

  d = homeBootSandbox(1, "");
  await flush(); await flush();
  assert(d.replaced.length === 0 && d.started.length === 1,
    "the single-project case stays on the dashboard (self-host unchanged)");

  d = homeBootSandbox(5, "?cid=c3");
  await flush(); await flush();
  assert(d.replaced.length === 0 && d.started.length === 1,
    "?cid= deep links always stay — in-project nav carries cid and never bounces");
}

async function run() {
  console.log("projects_landing.test.js\n");
  staticTests();
  builderTests();
  await pairingScopeTests();
  await redirectTests();
  console.log("\n" + (failures === 0 ? "ALL PASSED" : failures + " FAILED"));
  process.exit(failures === 0 ? 0 : 1);
}

run();
