/* ============================================================================
   GitHub dashboard portal wiring.

   Dependency-free (mirrors pairing_modal.test.js): loads the real
   modules/app-pairing.js (shared overlay) + pages/home-github.js +
   pages/home-state.js in a small DOM harness and verifies the context card's
   repo row, the Connect-repo modal states, and the PUT binding wiring.

   Run: node tests/portal/github_repo_row.test.js
   ========================================================================== */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const STATIC = path.join(
  __dirname, "..", "..",
  "orcha-cli", "orcha_cli", "templates", "portal", "static"
);
const PAIRING_JS = fs.readFileSync(path.join(STATIC, "modules", "app-pairing.js"), "utf8");
const GITHUB_JS = fs.readFileSync(path.join(STATIC, "pages", "home-github.js"), "utf8");
const HOME_STATE_JS = fs.readFileSync(path.join(STATIC, "pages", "home-state.js"), "utf8");

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log("  ✓ " + msg);
  else { failures++; console.error("  ✗ " + msg); }
}

function makeNode(id) {
  const n = {
    id: id || "", _class: "", _html: "", _listeners: {},
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
    },
    setAttribute: () => {}, getAttribute: () => null,
    addEventListener: (ev, fn) => { (n._listeners[ev] = n._listeners[ev] || []).push(fn); },
    appendChild: () => {}, contains: () => false,
    querySelector: () => null, querySelectorAll: () => [],
  };
  return n;
}

const esc = (s) => (s == null ? "" : String(s)).replace(/[&<>"']/g, (c) => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function makeSandbox(fetchImpl, opts) {
  const reg = {};
  // static hosts the pages expect (home.html) + the modal body host, pre-registered so
  // getElementById can resolve nodes the real DOM would create from innerHTML.
  ["ctxbar", "aqGrid", "aqBadge", "onbCta", "agCount", "agTbl", "actList", "kanban", "ghBody"]
    .forEach((id) => { reg[id] = makeNode(id); });

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
  const toasts = [];
  const sandbox = {
    window: {},
    document,
    localStorage: { getItem: () => null, setItem() {} },
    console,
    setInterval: () => 1, clearInterval: () => {},
    setTimeout: (fn) => { fn(); return 0; }, clearTimeout: () => {},
    fetch: fetchImpl,
    encodeURIComponent,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(PAIRING_JS, sandbox, { filename: "app-pairing.js" });
  vm.runInContext(GITHUB_JS, sandbox, { filename: "home-github.js" });
  // minimal Orcha surface the github module + renderCtx read (app.js assembles this in prod)
  sandbox.window.ORCHA = (opts && opts.snapshot) || { container: null, agents: [], tasks: [], requests: [] };
  sandbox.window.Orcha = {
    esc,
    icon: (name, cls) => `<svg class="${cls || "ico"}" data-icon="${name}"></svg>`,
    trunc: (s, n) => ((s || "").length > n ? (s || "").slice(0, n - 1) + "..." : (s || "")),
    pill: () => '<span class="pill"></span>',
    patch: (el, html) => { el.innerHTML = html; return true; },
    agents: () => sandbox.window.ORCHA.agents || [],
    tasks: () => sandbox.window.ORCHA.tasks || [],
    requests: () => sandbox.window.ORCHA.requests || [],
    toast: (m, k) => toasts.push({ m, k }),
    closeModal: sandbox.closeModal,
  };
  if (opts && opts.homeState) vm.runInContext(HOME_STATE_JS, sandbox, { filename: "home-state.js" });
  return { sandbox, reg, toasts };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

async function run() {
  console.log("github_repo_row.test.js\n");

  /* ---- context-card repo row (renderCtx embeds ghRepoHtml) ---- */
  const bound = makeSandbox(() => Promise.reject(new Error("no fetch")), {
    homeState: true,
    snapshot: { container: { id: "c1", name: "openorcha", status: "active", github_repo: "acme/site" }, agents: [], tasks: [], requests: [] },
  });
  bound.sandbox.renderCtx();
  const ctx = bound.reg.ctxbar.innerHTML;
  assert(/gh-row/.test(ctx), "bound container renders the repo row on the context card");
  assert(/https:\/\/github\.com\/acme\/site/.test(ctx), "repo tag links to the repo on github.com");
  assert(/acme\/site</.test(ctx), "owner/name is visible");
  assert(/M8 0C3\.58 0 0 3\.58/.test(ctx), "the GitHub mark is inlined (currentColor SVG path)");
  assert(/data-gh-connect/.test(ctx), "bound state still offers a change affordance");

  const unbound = makeSandbox(() => Promise.reject(new Error("no fetch")), {
    homeState: true,
    snapshot: { container: { id: "c1", name: "openorcha", status: "active", github_repo: null }, agents: [], tasks: [], requests: [] },
  });
  unbound.sandbox.renderCtx();
  assert(/Connect repo/.test(unbound.reg.ctxbar.innerHTML), "unbound container shows the Connect repo affordance");

  /* ---- modal: repo list with current binding pre-selected + Unbind ---- */
  const listCalls = [];
  const listing = makeSandbox((url, init) => {
    listCalls.push({ url, init });
    return Promise.resolve({ ok: true, json: () => Promise.resolve({
      available: true,
      repos: [
        { full_name: "acme/site", private: true, description: "The site", html_url: "https://github.com/acme/site" },
        { full_name: "acme/docs", private: false, description: null, html_url: "https://github.com/acme/docs" },
      ],
    }) });
  }, { snapshot: { container: { id: "c1", name: "openorcha", github_repo: "acme/site" }, agents: [], tasks: [], requests: [] } });
  listing.sandbox.openRepoModal();
  assert(listing.reg.__ov && listing.reg.__ov.classList.contains("show"), "Connect-repo modal opens on the shared overlay");
  assert(/Connect a GitHub repo/.test(listing.reg.__ov.innerHTML), "modal title is rendered");
  assert(/Loading repositories/.test(listing.reg.__ov.innerHTML), "modal starts in a loading state");
  await flush(); await flush();
  assert(listCalls[0] && listCalls[0].url === "/api/github/repos", "modal fetches /api/github/repos");
  const body = listing.reg.ghBody.innerHTML;
  assert(/data-gh-pick="acme\/docs"/.test(body), "repos render as selectable rows");
  assert(/gh-repo-row sel/.test(body) && /data-gh-pick="acme\/site"/.test(body), "current binding is pre-selected");
  assert(/gh-private/.test(body), "private repos carry a private badge");
  assert(/The site/.test(body), "repo description one-liner is shown");
  assert(/Unbind acme\/site/.test(body), "an Unbind option is offered while bound");

  /* ---- modal: graceful off state when the GitHub App isn't wired ---- */
  const off = makeSandbox(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ available: false, repos: [] }) }),
    { snapshot: { container: { id: "c1", name: "openorcha", github_repo: null }, agents: [], tasks: [], requests: [] } });
  off.sandbox.openRepoModal();
  await flush(); await flush();
  assert(/GitHub App isn't wired/.test(off.reg.ghBody.innerHTML), "available:false renders the not-wired empty state");
  assert(/github-token/.test(off.reg.ghBody.innerHTML), "empty state names the token file dependency");
  assert(/deploy\/README\.md/.test(off.reg.ghBody.innerHTML), "empty state points at the companion doc");

  /* ---- PUT wiring: selecting persists and updates the card in place ---- */
  const putCalls = [];
  const saving = makeSandbox((url, init) => {
    if (init && init.method === "PUT") {
      putCalls.push({ url, init });
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ repo: JSON.parse(init.body).repo }) });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ available: true, repos: [] }) });
  }, { homeState: true, snapshot: { container: { id: "c1", name: "openorcha", status: "active", github_repo: null }, agents: [], tasks: [], requests: [] } });
  await saving.sandbox.ghSaveBinding("acme/docs");
  assert(putCalls.length === 1 && putCalls[0].url === "/api/containers/c1/github", "selecting PUTs to the container's github binding");
  assert(putCalls[0].init.body === '{"repo":"acme/docs"}', "PUT body carries the owner/name");
  assert(saving.sandbox.window.ORCHA.container.github_repo === "acme/docs", "the snapshot container is updated in place");
  assert(/acme\/docs/.test(saving.reg.ctxbar.innerHTML), "the context card repaints with the new binding");
  await saving.sandbox.ghSaveBinding(null);
  assert(putCalls[1] && putCalls[1].init.body === '{"repo":null}', "Unbind PUTs repo:null");
  assert(saving.sandbox.window.ORCHA.container.github_repo === null, "unbind clears the in-place binding");

  console.log("\n" + (failures === 0 ? "ALL PASSED" : failures + " FAILED"));
  process.exit(failures === 0 ? 0 : 1);
}

run();
