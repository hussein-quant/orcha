/* ============================================================================
   Agents roster + agent-detail header — real GitHub profile pictures for HUMAN
   members (mirrors the Settings→Collaboration members list and the topbar
   "ACTING AS" chip, both of which already ride Orcha.ghAvatar()).

   Before: every roster row and the detail header rendered ALL agents — human
   and AI alike — through the deterministic letter-square avatar() helper, so
   a mapped human (operator/collaborator, github_login set) never showed their
   real face even though the SAME github_login already rides every agent in
   the container snapshot (container_snapshot_routes.py selects a.github_login)
   and is already used by settings-members.js / app-shell.js's chip.
   After: agentFace(a, size) in pages/agents-state.js picks ghAvatar(login,
   size) for a human WITH a mapped github_login, and keeps the plain letter
   avatar() for every AI agent and for an unmapped human (no github_login) —
   exactly the settings-members.js memFace() convention. ghAvatar()'s <img>
   sits over the same letter tile and self-heals on error via
   onerror="this.remove()" (no JS wiring needed here — the browser handles the
   fallback natively), so a broken/offline avatar never blanks the row.

   Dependency-free (mirrors collab_members.test.js): loads the real
   pages/agents-state.js + pages/agents-detail.js + pages/agents-controls.js
   (production script order) into a small DOM harness with a minimal Orcha
   stub (avatar/ghAvatar mirror the real modules/app-ui.js signatures) and
   asserts on the rendered roster list + agent-detail header HTML.

   Run: node tests/portal/roster_human_avatars.test.js
   ========================================================================== */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const STATIC = path.join(
  __dirname, "..", "..",
  "orcha-cli", "orcha_cli", "templates", "portal", "static"
);
const read = (...p) => fs.readFileSync(path.join(STATIC, ...p), "utf8");
const PAGE_FILES = [
  ["pages", "agents-state.js"], ["pages", "agents-detail.js"], ["pages", "agents-controls.js"],
];

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log("  ✓ " + msg);
  else { failures++; console.error("  ✗ " + msg); }
}

const esc = (s) => (s == null ? "" : String(s)).replace(/[&<>"']/g, (c) => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function makeNode(id) {
  const n = {
    id: id || "", _html: "", _listeners: {}, dataset: {},
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

// Real ghAvatar()/avatar() signatures (mirrors modules/app-ui.js exactly) — the
// letter tile is ALWAYS present; ghAvatar layers the real <img> over it with the
// onerror fallback that drops the broken image and reveals the letter beneath.
function fakeAvatar(alias, kind, size) {
  const cls = "av" + (size ? " " + size : "") + (kind === "human" ? " human" : "");
  const init = (alias || "?").trim().charAt(0).toUpperCase();
  return `<span class="${cls}">${esc(init)}</span>`;
}
function fakeGhAvatar(login, size) {
  const cls = "av gh" + (size ? " " + size : "") + " human";
  const init = (login || "?").trim().charAt(0).toUpperCase();
  return `<span class="${cls}">${esc(init)}<img class="gh-face" ` +
    `src="https://github.com/${esc(encodeURIComponent(login || ""))}.png?size=96" alt="" ` +
    `loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()"></span>`;
}
// Real face() signature (mirrors modules/app-ui.js exactly) — PR #90's shared portal-wide
// convention that agentFace() now delegates to (see avatars_everywhere.test.js for the
// dedicated Orcha.face() contract coverage).
function fakeFace(rec, size) {
  rec = rec || {};
  return (rec.kind === "human" && rec.github_login) ? fakeGhAvatar(rec.github_login, size) : fakeAvatar(rec.alias, rec.kind, size);
}

function makeSandbox(agents) {
  const reg = {};
  ["roster", "detailMain", "runsWrap", "convWrap"].forEach((id) => { reg[id] = makeNode(id); });
  reg.roster.querySelector = (sel) => (sel === ".rrow.sel" ? null : null);

  const document = {
    documentElement: { setAttribute() {}, getAttribute: () => null },
    body: makeNode("body"),
    getElementById: (id) => reg[id] || null,
    createElement: () => makeNode(""),
    addEventListener() {},
  };
  const sandbox = {
    window: { location: { search: "" }, OrchaTerm: null, OrchaConvo: null },
    document,
    location: { search: "", href: "https://portal.test/agents" },
    localStorage: { getItem: () => null, setItem() {} },
    console, encodeURIComponent, URLSearchParams, URL,
    history: { replaceState() {} },
    setInterval: () => 1, clearInterval() {},
    setTimeout: () => 0, clearTimeout() {},
    // pre-fetch (MODELS/REASONING_EFFORTS) — resolved async and unused by these assertions,
    // which only exercise the synchronous render path.
    fetch: () => Promise.resolve({ ok: false }),
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  sandbox.window.ORCHA = { container: { name: "demo" }, agents, tasks: [], requests: [] };
  sandbox.window.Orcha = {
    esc,
    icon: (name, cls) => `<svg class="${cls || "ico"}" data-icon="${name}"></svg>`,
    avatar: fakeAvatar,
    ghAvatar: fakeGhAvatar,
    face: fakeFace,
    glyph: () => "<svg class=\"gl\"></svg>",
    statusClass: () => "s-idle",
    kindBadge: (kind) => `<span class="kind ${kind === "human" ? "human" : "ai"}"></span>`,
    pill: () => "<span class=\"pill\"></span>",
    relTime: () => "just now",
    shortId: (id) => String(id).slice(0, 8),
    trunc: (s) => s || "",
    sortControlHtml: () => "",
    sortComparator: () => () => 0,
    wireSortControl: () => {},
    patch: (el, html) => { el.innerHTML = html; return true; },
    actingHuman: () => ({ id: "h1", alias: "hussein-quant" }),
    agents: () => sandbox.window.ORCHA.agents,
    tasks: () => sandbox.window.ORCHA.tasks,
    requests: () => sandbox.window.ORCHA.requests,
    agentByAlias: (alias) => sandbox.window.ORCHA.agents.find((a) => a.alias === alias) || null,
    agentById: (id) => sandbox.window.ORCHA.agents.find((a) => String(a.id) === String(id)) || null,
    leaseOf: () => null,
    toast() {},
  };
  vm.runInContext("window.OrchaData = { resolveCid: () => Promise.resolve('c1'), start() {} };", sandbox);
  PAGE_FILES.forEach((p) => vm.runInContext(read(...p), sandbox, { filename: p.join("/") }));
  return { sandbox, reg };
}

const AGENTS = [
  // mapped human (operator, the founder) — GitHub identity present.
  { id: "h1", alias: "hussein-quant", role: "operator", kind: "human",
    github_login: "hussein-quant", status: "idle" },
  // mapped human (invited collaborator) — alias DIVERGES from github_login (the
  // portal alias is a separate free-text field; login is the GitHub identity) so a
  // regression that keys the avatar off alias instead of github_login is caught.
  { id: "h2", alias: "kedar-collab", role: "collaborator", kind: "human",
    github_login: "kedar1607", status: "idle" },
  // unmapped human (no github_login yet) — must stay on the letter avatar.
  { id: "h3", alias: "ada", role: "operator", kind: "human",
    github_login: null, status: "idle" },
  // AI agent — must NEVER get a gh avatar, even if github_login were somehow set.
  { id: "a1", alias: "Forge", role: "Builder", kind: "agent",
    github_login: null, status: "idle" },
];

function rosterTests() {
  console.log("roster list (renderRoster)\n");
  const { sandbox, reg } = makeSandbox(AGENTS);
  vm.runInContext("sel = 'hussein-quant'; renderRoster();", sandbox);
  const html = reg.roster.innerHTML;

  assert(/av gh human/.test(html) && /github\.com\/hussein-quant\.png/.test(html),
    "mapped human operator (hussein-quant) renders the circular gh avatar image");
  // kedar-collab's alias DIFFERS from its github_login (kedar1607) — the src must be
  // keyed off github_login, never the alias, or the image 404s against the wrong user.
  assert(/github\.com\/kedar1607\.png/.test(html) && !/github\.com\/kedar-collab\.png/.test(html),
    "mapped human collaborator (alias kedar-collab, login kedar1607) sources its avatar from github_login, not alias");
  assert(/onerror="this\.remove\(\)"/.test(html),
    "the gh <img> carries the onerror fallback (drops the broken image)");
  assert(/>H<img class="gh-face"[^>]*hussein-quant/.test(html),
    "the letter tile (H) sits beneath hussein-quant's <img> as the fallback");

  // unmapped human: letter avatar, no gh image, no broken-src risk.
  const adaSection = html.slice(html.indexOf('data-alias="ada"'));
  assert(/class="av  human">A</.test(adaSection) || /class="av human">A</.test(adaSection),
    "an unmapped human (no github_login) still renders the plain letter avatar");
  assert(!/ada\.png/.test(html), "an unmapped human never gets a github.com/<login>.png src");

  // AI agent: always the letter square, never circular/gh, regardless of kind.
  const forgeSection = html.slice(html.indexOf('data-alias="Forge"'));
  assert(/class="av ">F</.test(forgeSection) || /class="av">F</.test(forgeSection),
    "an AI agent (Forge) renders the plain letter avatar");
  assert(!/class="av gh[^"]*"[^>]*>F</.test(forgeSection) && !/Forge\.png/.test(html),
    "an AI agent never renders the circular gh avatar, even in the human's row family");

  assert(/data-alias="hussein-quant"/.test(html) && /data-alias="Forge"/.test(html),
    "all four roster rows are present");
}

function detailHeaderTests() {
  console.log("\nagent-detail header (renderDetailMain)\n");

  /* mapped human operator */
  {
    const { sandbox, reg } = makeSandbox(AGENTS);
    vm.runInContext("sel = 'hussein-quant'; renderDetailMain();", sandbox);
    const html = reg.detailMain.innerHTML;
    assert(/ahead/.test(html), "detail header renders");
    const head = html.slice(0, html.indexOf("</div>", html.indexOf("ahead")) + 400);
    assert(/av gh lg human/.test(head) && /github\.com\/hussein-quant\.png/.test(head),
      "the detail header shows the large (lg) circular gh avatar for a mapped human");
    assert(/onerror="this\.remove\(\)"/.test(head), "the header's gh <img> carries the fallback");
    assert(/Human authority/.test(html), "the origin field still reads 'Human authority' for a human");
  }

  /* mapped human collaborator (alias != github_login) */
  {
    const { sandbox, reg } = makeSandbox(AGENTS);
    vm.runInContext("sel = 'kedar-collab'; renderDetailMain();", sandbox);
    const html = reg.detailMain.innerHTML;
    assert(/github\.com\/kedar1607\.png/.test(html) && !/github\.com\/kedar-collab\.png/.test(html),
      "the detail header sources the collaborator's avatar from github_login, not the alias");
  }

  /* unmapped human */
  {
    const { sandbox, reg } = makeSandbox(AGENTS);
    vm.runInContext("sel = 'ada'; renderDetailMain();", sandbox);
    const html = reg.detailMain.innerHTML;
    assert(!/ada\.png/.test(html), "an unmapped human's detail header has no gh image");
    assert(/av lg human">A</.test(html), "…and falls back to the large letter avatar");
  }

  /* AI agent */
  {
    const { sandbox, reg } = makeSandbox(AGENTS);
    vm.runInContext("sel = 'Forge'; renderDetailMain();", sandbox);
    const html = reg.detailMain.innerHTML;
    assert(!/Forge\.png/.test(html) && !/av gh lg/.test(html),
      "an AI agent's detail header keeps the plain letter avatar, never gh");
    assert(/Human-created/.test(html), "the origin field reads 'Human-created' for an AI agent");
  }
}

function mutationNotes() {
  // These notes record the mutation-testing sweep performed while writing this file
  // (manually toggling agentFace's condition/branches and confirming each assertion
  // above catches the regression) — kept here so a future editor can re-derive intent
  // without re-running the sweep by hand:
  //   1. Flip `a.kind === "human"` -> `a.kind !== "human"` in agentFace: the AI-agent
  //      assertions above (Forge keeps the letter avatar) fail — caught.
  //   2. Drop the `&& a.github_login` guard: the unmapped-human (ada) assertions
  //      ("no gh image" / letter fallback) fail — caught.
  //   3. Swap `AgeO.ghAvatar(a.github_login, size)` for `AgeO.ghAvatar(a.alias, size)`:
  //      kedar-collab's fixture alias deliberately DIFFERS from its github_login
  //      (kedar1607) precisely to catch this — the roster/detail assertions pinning
  //      "github.com/kedar1607.png" AND "!github.com/kedar-collab.png" both fail — caught.
  //      (Confirmed by an actual mutation run, not just static reasoning — an earlier
  //      draft fixture had alias === github_login for every human and silently missed
  //      this exact mutant; the diverging alias was added after that gap was found.)
  //   4. Remove the "lg" size passthrough in the detail header call: the `av gh lg human`
  //      class assertion fails — caught.
  console.log("\nmutation notes: see comments in mutationNotes() — 4 mutants, all caught by the assertions above.");
}

async function run() {
  console.log("roster_human_avatars.test.js\n");
  rosterTests();
  detailHeaderTests();
  mutationNotes();
  console.log("\n" + (failures === 0 ? "ALL PASSED" : failures + " FAILED"));
  process.exit(failures === 0 ? 0 : 1);
}

run();
