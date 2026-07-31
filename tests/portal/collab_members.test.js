/* ============================================================================
   Collab v1 portal wiring — the acting-as GitHub chip and the Members card.

   Dependency-free (mirrors github_repo_row.test.js): loads the real shell
   modules (app-state/app-text/app-data/app-ui/app-shell) to pin the topbar
   chip, and modules/settings-members.js in a small DOM harness to verify the
   member rows, owner-only affordances, and the invite/role/remove wiring.

   Run: node tests/portal/collab_members.test.js
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
const MEMBERS_JS = read("modules", "settings-members.js");

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log("  ✓ " + msg);
  else { failures++; console.error("  ✗ " + msg); }
}

const esc = (s) => (s == null ? "" : String(s)).replace(/[&<>"']/g, (c) => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function makeNode(id) {
  const n = {
    id: id || "", _class: "", _html: "", value: "", _listeners: {},
    get innerHTML() { return n._html; },
    set innerHTML(v) { n._html = v == null ? "" : String(v); },
    textContent: "",
    classList: { add() {}, remove() {}, contains: () => false },
    setAttribute() {}, getAttribute: () => null,
    addEventListener(ev, fn) { (n._listeners[ev] = n._listeners[ev] || []).push(fn); },
    appendChild() {}, contains: () => false,
    querySelector: () => null, querySelectorAll: () => [],
  };
  return n;
}

/* ---------------- part 1: the acting-as chip (topbar) ---------------- */
function shellSandbox() {
  const sandbox = {
    window: {},
    document: { documentElement: { setAttribute() {}, getAttribute: () => null } },
    localStorage: { getItem: () => null, setItem() {} },
    console, encodeURIComponent,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  SHELL_FILES.forEach((p) => vm.runInContext(read(...p), sandbox, { filename: p.join("/") }));
  return sandbox;
}

function chipTests() {
  console.log("acting-as chip (actingChipHtml)\n");
  const sb = shellSandbox();
  vm.runInContext(`window.ORCHA.agents = [{ id: "h1", alias: "root", kind: "human" }];`, sb);

  /* identity resolved → circular GitHub avatar + login, letter fallback beneath */
  vm.runInContext(`window.ORCHA.identity = { agent_id: "h1", alias: "octocat",
    github_login: "octocat", member_role: "owner", avatar_url: "https://github.com/octocat.png" };`, sb);
  const gh = vm.runInContext("actingChipHtml()", sb);
  assert(/av gh sm human/.test(gh), "identity renders the circular gh avatar chip (.av.gh.human)");
  assert(/src="https:\/\/github\.com\/octocat\.png/.test(gh), "avatar img points at github.com/<login>.png");
  assert(/onerror="this\.remove\(\)"/.test(gh), "img error drops to the letter tile (fallback kept)");
  assert(/>O<img/.test(gh), "the letter fallback is the login's initial");
  assert(/gh-login">octocat</.test(gh), "the github login is the chip text");

  /* identity resolved but the actor attribution also follows it */
  const actor = vm.runInContext("JSON.stringify(actingHuman())", sb);
  assert(JSON.parse(actor).id === "h1", "actingHuman() resolves to the /api/me agent (actor attribution)");

  /* identity null → the pre-collab fallback chip (local human) */
  vm.runInContext("window.ORCHA.identity = null;", sb);
  const local = vm.runInContext("actingChipHtml()", sb);
  assert(/>R</.test(local) && /root/.test(local), "no identity falls back to the picked local human");
  assert(!/gh-face/.test(local), "no GitHub avatar without an identity");

  /* no humans at all → the registered nudge */
  vm.runInContext("window.ORCHA.agents = [];", sb);
  const none = vm.runInContext("actingChipHtml()", sb);
  assert(/no human registered/.test(none), "no humans keeps the 'no human registered' fallback");
}

/* ---------------- part 2: the Members card (settings) ---------------- */
function membersSandbox(fetchImpl) {
  const reg = {};
  ["membersCard", "memLogin", "memRole", "memInvite"].forEach((id) => { reg[id] = makeNode(id); });
  const toasts = [];
  const modals = [];
  const sandbox = {
    window: {},
    document: {
      documentElement: { setAttribute() {}, getAttribute: () => null },
      body: makeNode("body"),
      getElementById: (id) => reg[id] || null,
      createElement: () => makeNode(""),
      addEventListener() {},
    },
    localStorage: { getItem: () => null, setItem() {} },
    console, encodeURIComponent,
    setInterval: () => 1, clearInterval() {},
    setTimeout: (fn) => { fn(); return 0; }, clearTimeout() {},
    fetch: fetchImpl,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  sandbox.window.Orcha = {
    esc,
    icon: (name, cls) => `<svg class="${cls || "ico"}" data-icon="${name}"></svg>`,
    avatar: (alias, kind, size) => `<span class="av ${size || ""} ${kind}">${esc((alias || "?").charAt(0).toUpperCase())}</span>`,
    patch: (el, html) => { el.innerHTML = html; return true; },
    toast: (m, k) => toasts.push({ m, k }),
    modal: (cfg) => modals.push(cfg),
    closeModal() {},
    actingOwner: () => sandbox.__owner !== false,
    actingHuman: () => ({ id: "h1", alias: "octocat" }),
    identity: () => ({ agent_id: "h1", alias: "octocat", github_login: "octocat", member_role: "owner" }),
  };
  // the shared gh avatar helper from app-ui.js rides the settings page too
  sandbox.ghAvatar = (login, size) => `<span class="av gh ${size || ""} human">${esc((login || "?").charAt(0).toUpperCase())}<img class="gh-face" src="https://github.com/${login}.png?size=96"></span>`;
  vm.runInContext(MEMBERS_JS, sandbox, { filename: "settings-members.js" });
  vm.runInContext('MEM_CID = "c1";', sandbox);
  return { sandbox, reg, toasts, modals };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

const ROSTER = {
  members: [
    { agent_id: "h1", alias: "octocat", github_login: "octocat", member_role: "owner", pending: false },
    { agent_id: "h2", alias: "hubot", github_login: "hubot", member_role: "member", pending: true },
    { agent_id: "h3", alias: "ada", github_login: null, member_role: "member", pending: false },
  ],
};

async function membersTests() {
  console.log("\nmembers card (settings-members.js)\n");

  /* ---- owner view: rows with avatar+login+role chip+pending, invite bar ---- */
  const calls = [];
  const owner = membersSandbox((url, init) => {
    calls.push({ url, init: init || {} });
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(ROSTER) });
  });
  vm.runInContext("loadMembers()", owner.sandbox);
  await flush(); await flush();
  assert(calls[0] && calls[0].url === "/api/containers/c1/members", "card fetches GET /members");
  const html = owner.reg.membersCard.innerHTML;
  assert(/mem-row/.test(html), "members render as rows");
  assert(/github\.com\/octocat\.png/.test(html) && /github\.com\/hubot\.png/.test(html),
    "mapped members carry the GitHub avatar image");
  assert(/tag role-owner">owner</.test(html) && /tag role-member">member</.test(html),
    "each row carries its role chip");
  assert(/tag mem-pending">pending</.test(html), "an invited-but-never-seen member shows the pending badge");
  assert(/mem-you">you</.test(html), "the acting identity's own row is marked 'you'");
  assert(/>ada</.test(html) && !/github\.com\/ada\.png/.test(html),
    "an unmapped local human renders with the letter avatar, no gh image");
  assert(/memLogin/.test(html) && /memInvite/.test(html) && /memRole/.test(html),
    "owners get the invite input + role select");
  assert(/data-mem-role="h2"/.test(html) && /data-mem-remove="h2"/.test(html),
    "owners get per-row role/remove controls");

  /* ---- invite wiring: POST with login+role+trust-off actor ---- */
  owner.reg.memLogin.value = "monalisa";
  owner.reg.memRole.value = "member";
  vm.runInContext("doInvite()", owner.sandbox);
  await flush(); await flush();
  const post = calls.find((c) => c.init.method === "POST");
  assert(!!post && post.url === "/api/containers/c1/members", "invite POSTs to /members");
  assert(post && post.init.body === '{"github_login":"monalisa","role":"member","actor_agent_id":"h1"}',
    "invite body carries github_login + role + the acting agent");
  assert(owner.toasts.some((t) => /monalisa/.test(t.m) && /pending/.test(t.m)),
    "invite success toast names the login and the pending state");

  /* ---- role wiring: PATCH member→owner ---- */
  vm.runInContext('doRole("h2", "owner")', owner.sandbox);
  await flush(); await flush();
  const patch = calls.find((c) => c.init.method === "PATCH");
  assert(!!patch && patch.url === "/api/containers/c1/members/h2", "role change PATCHes the member");
  assert(patch && patch.init.body === '{"role":"owner","actor_agent_id":"h1"}', "PATCH body carries role + actor");

  /* ---- remove wiring: confirm modal, then DELETE ---- */
  vm.runInContext('doRemove("h2")', owner.sandbox);
  const confirm = owner.modals[owner.modals.length - 1];
  assert(confirm && /Remove hubot\?/.test(confirm.title), "remove opens a confirm modal naming the member");
  assert(confirm && /reviewer reverts to anyone/i.test(confirm.desc), "confirm copy explains the reviewer reset");
  await confirm.onPrimary();
  await flush();
  const del = calls.find((c) => c.init.method === "DELETE");
  assert(!!del && del.url === "/api/containers/c1/members/h2", "confirming DELETEs the member");
  assert(del && del.init.body === '{"actor_agent_id":"h1"}', "DELETE body carries the trust-off actor");

  /* ---- 409 invite: a friendly already-a-member toast, not a failure ---- */
  const dup = membersSandbox((url, init) => (init && init.method === "POST"
    ? Promise.resolve({ ok: false, status: 409, json: () => Promise.resolve({ detail: "dup" }) })
    : Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(ROSTER) })));
  vm.runInContext("loadMembers()", dup.sandbox);
  await flush(); await flush();
  dup.reg.memLogin.value = "hubot";
  vm.runInContext("doInvite()", dup.sandbox);
  await flush(); await flush();
  assert(dup.toasts.some((t) => /already a member/.test(t.m)), "409 invite reads as already-a-member");

  /* ---- non-owner view: read-only list ---- */
  const viewer = membersSandbox(() =>
    Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(ROSTER) }));
  viewer.sandbox.__owner = false;
  vm.runInContext("loadMembers()", viewer.sandbox);
  await flush(); await flush();
  const ro = viewer.reg.membersCard.innerHTML;
  assert(/mem-row/.test(ro) && /tag role-owner/.test(ro), "non-owners still see the member list + roles");
  assert(!/memInvite/.test(ro) && !/data-mem-role=/.test(ro) && !/data-mem-remove=/.test(ro),
    "non-owners get NO invite bar and NO role/remove controls");
}

async function run() {
  console.log("collab_members.test.js\n");
  chipTests();
  await membersTests();
  console.log("\n" + (failures === 0 ? "ALL PASSED" : failures + " FAILED"));
  process.exit(failures === 0 ? 0 : 1);
}

run();
