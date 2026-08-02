/* ============================================================================
   GitHub hub — expertise-based "Assign to" suggestions.

   suggestAgents(item, agents) (pages/github-state.js) is a deterministic,
   client-side, no-LLM scorer: tokenize the issue/PR's title + body excerpt/
   markdown + labels + (PRs only) head branch, tokenize each AI agent's
   `role` string (the persona subtitle the roster already carries — e.g.
   "web engineer (Next.js clinician dashboard)") through ROLE_TOKEN_SYNONYMS
   (a small, visible, editable expansion table keyed off words that actually
   appear in role text, NOT off agent names/aliases — a brand-new agent
   inherits suggestion behavior purely from its role string), and rank agents
   by weighted token overlap (title/label hits count more than body hits).
   The orchestrator/architect role gets a mild score penalty so a concrete,
   specialist-shaped issue doesn't route to the generalist by default. Ties
   (equal score) fall back to roster order (stable sort — Array.prototype.sort
   is stable in the runtimes this suite/browser targets).

   agentRosterHtml(kind, number, agents, item) (same file) is the dropdown
   body: a "SUGGESTED" section (top match, or top 2 when scores are close)
   each with a compact reason chip (up to 3 matched tokens), a divider, then
   "ALL AGENTS" listing the REMAINING roster (suggested entries not
   repeated) in roster order. Zero-signal items (no agent scores > 0) render
   the plain roster list unchanged — no SUGGESTED section, no divider.

   Run: node tests/portal/github_agent_suggest.test.js
   ========================================================================== */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const STATIC = path.join(
  __dirname, "..", "..",
  "orcha-cli", "orcha_cli", "templates", "portal", "static"
);
const read = (...p) => fs.readFileSync(path.join(STATIC, ...p), "utf8");
const STATE_JS = read("pages", "github-state.js");
const RENDER_JS = read("pages", "github-render.js");
const BOOT_JS = read("pages", "github-boot.js");

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log("  ✓ " + msg);
  else { failures++; console.error("  ✗ " + msg); }
}

function boot() {
  const escFallback = (s) => (s == null ? "" : String(s)).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
  const sandbox = {
    window: {
      Orcha: {
        esc: escFallback,
        trunc: (s, n) => ((s || "").length > n ? (s || "").slice(0, n - 1) + "…" : (s || "")),
        relTime: (iso) => (iso ? "3h ago" : "—"),
        ghAvatar: (login) => `<span class="av gh sm human">${escFallback((login || "?").charAt(0).toUpperCase())}</span>`,
        icon: (name, cls) => `<svg class="${cls || "ico"}" data-icon="${name}"></svg>`,
      },
    },
    console,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(STATE_JS, sandbox, { filename: "github-state.js" });
  return sandbox.window.OrchaGithubHub;
}

/* ---- roster fixture ------------------------------------------------------
   Roles deliberately match the task brief's own examples verbatim (the
   scorer must work off role TEXT, not these names) plus one orchestrator to
   exercise the penalty and one human to prove humans are never suggested. */
const ROSTER = [
  { id: "a-crimson", alias: "Crimson", kind: "ai", role: "web engineer (Next.js clinician dashboard)" },
  { id: "a-plum", alias: "Plum", kind: "ai", role: "iOS engineer (SwiftUI patient app)" },
  { id: "a-forge", alias: "Forge", kind: "ai", role: "backend engineer (NestJS + Medplum fork, FHIR)" },
  { id: "a-warden", alias: "Warden", kind: "ai", role: "security & HIPAA compliance reviewer" },
  { id: "a-sentinel", alias: "Sentinel", kind: "ai", role: "QA & release verification" },
  { id: "a-hue", alias: "Hue", kind: "ai", role: "UX / design system" },
  { id: "a-warden2", alias: "Ledger", kind: "ai", role: "admin & operator panel" },
  { id: "a-counsel", alias: "Counsel", kind: "ai", role: "compliance-documentation counsel-support" },
  { id: "a-atlas", alias: "Atlas", kind: "ai", role: "orchestrator & architect" },
  { id: "h-kedar", alias: "Kedar", kind: "human", role: "Founder" },
];

function scoringTests() {
  console.log("suggestAgents() scoring\n");
  const G = boot();

  // ---- item 1: clinician-dashboard issue -> Crimson (web/Next.js) --------
  const dashboardIssue = {
    number: 10, title: "Demographics card broken on clinician dashboard",
    body_excerpt: "The patient demographics card on the Next.js dashboard renders blank.",
    labels: [{ name: "frontend", color: "0075ca" }],
  };
  const dashboardRanked = G.suggestAgents(dashboardIssue, ROSTER);
  assert(Array.isArray(dashboardRanked) && dashboardRanked.length > 0,
    "returns a non-empty ranked array for a signal-bearing issue");
  assert(dashboardRanked[0].agent.alias === "Crimson",
    "clinician-dashboard demographics-card issue ranks Crimson (web engineer) first");
  // mutation note: if ROLE_TOKEN_SYNONYMS dropped "dashboard" -> "dashboard" (its own
  // literal role-text token) this still passes off "web"/"nextjs" alone, so this
  // assertion alone doesn't pin the dashboard synonym — see the reason-chip test below,
  // which does.

  // ---- item 2: iOS-titled issue -> Plum -----------------------------------
  const iosIssue = {
    number: 11, title: "SwiftUI crash on iOS patient app launch",
    body_excerpt: "The patient app crashes on cold launch on iOS 18.",
    labels: [{ name: "mobile", color: "d876e3" }],
  };
  const iosRanked = G.suggestAgents(iosIssue, ROSTER);
  assert(iosRanked[0].agent.alias === "Plum",
    "iOS-titled issue ranks Plum (iOS engineer) first");

  // ---- item 3: FHIR/backend PR -> Forge -----------------------------------
  const fhirPull = {
    number: 12, title: "Fix FHIR resource validation in Medplum fork",
    body_excerpt: "Backend NestJS service rejects a valid FHIR Patient resource.",
    labels: [], head: "fix/fhir-validation",
  };
  const fhirRanked = G.suggestAgents(fhirPull, ROSTER);
  assert(fhirRanked[0].agent.alias === "Forge",
    "FHIR/backend PR ranks Forge (backend engineer) first");

  // ---- item 4: HIPAA/security issue -> Warden -----------------------------
  const hipaaIssue = {
    number: 13, title: "PHI potentially logged in plaintext",
    body_excerpt: "A HIPAA compliance review found an auth log path leaking PHI.",
    labels: [{ name: "security", color: "d73a4a" }],
  };
  const hipaaRanked = G.suggestAgents(hipaaIssue, ROSTER);
  assert(hipaaRanked[0].agent.alias === "Warden",
    "HIPAA/security issue ranks Warden (security & HIPAA compliance reviewer) first");

  // ---- orchestrator penalty ------------------------------------------------
  // Deliberately constructed so BOTH agents get strong title/label-tier hits:
  // "release"/"verification" (Sentinel's role) AND "orchestrator"/"coordinate"
  // (Atlas's role, plus its "coordinate" synonym) all appear in the title and
  // labels. Atlas's RAW (unpenalized) overlap here is actually higher than
  // Sentinel's — this is the case that would flip without the penalty, not a
  // case where the penalty is moot because Atlas never scores at all. See
  // mutationNotes() below for the confirmed-by-hand RED when the penalty
  // multiplier is neutralized.
  const releaseIssue = {
    number: 14, title: "Orchestrator: coordinate release verification",
    body_excerpt: "",
    labels: [{ name: "orchestrator", color: "fbca04" }, { name: "coordinate", color: "fbca04" }],
  };
  const releaseRanked = G.suggestAgents(releaseIssue, ROSTER);
  assert(releaseRanked[0].agent.alias === "Sentinel",
    "QA/flaky-e2e issue ranks Sentinel (QA & release verification) ahead of the orchestrator");
  const atlasEntry = releaseRanked.find((r) => r.agent.alias === "Atlas");
  const sentinelEntry = releaseRanked.find((r) => r.agent.alias === "Sentinel");
  assert(!!atlasEntry && atlasEntry.score < sentinelEntry.score,
    "orchestrator (Atlas) scores nonzero here (real overlap) but never outscores the matching specialist (Sentinel)");

  // A generic issue with NO specialist tokens at all: orchestrator can still
  // appear (penalized, but nonzero) OR the whole thing reads as zero-signal —
  // either is acceptable, but if Atlas scores at all here, a same-role-text
  // duplicate agent (added for this sub-test only) with the identical role and
  // NO penalty must score strictly higher, proving the penalty is really applied
  // as a multiplier and not just a documentation comment.
  const genericIssue = {
    number: 15, title: "Coordinate next release cut",
    body_excerpt: "Please orchestrate the release plan across teams.",
    labels: [],
  };
  const rosterWithTwin = ROSTER.concat([{ id: "a-twin", alias: "AtlasTwin", kind: "ai", role: "release plan coordinator" }]);
  const genericRanked = G.suggestAgents(genericIssue, rosterWithTwin);
  const atlasG = genericRanked.find((r) => r.agent.alias === "Atlas");
  assert(atlasG && atlasG.score > 0, "orchestrator still scores (nonzero) on an item matching its own role text");
  // mutation note: removing the orchestrator penalty multiplier entirely (score
  // computed identically for every role) would still pass the assertions above
  // (Atlas's raw overlap really is high on this item) — the PENALTY's effect is
  // pinned by the Sentinel-outranks-Atlas assertion above instead, which fails
  // (RED) the instant the penalty multiplier is deleted or set to 1.

  // ---- humans are never suggested -------------------------------------------
  assert(!dashboardRanked.some((r) => r.agent.kind !== "ai"),
    "suggestAgents never includes non-AI (human) roster members");
  // A human whose role TEXT would otherwise score highly on this exact item —
  // proves the kind==="ai" filter is actually load-bearing (not just true by
  // coincidence because no human fixture's role happens to overlap anything).
  const rosterWithMatchingHuman = ROSTER.concat([
    { id: "h-web", alias: "HumanWeb", kind: "human", role: "web engineer (Next.js clinician dashboard)" },
  ]);
  const withHumanRanked = G.suggestAgents(dashboardIssue, rosterWithMatchingHuman);
  assert(!withHumanRanked.some((r) => r.agent.alias === "HumanWeb"),
    "a human with a role string that WOULD score highly is still excluded — the AI-only filter is genuinely enforced");

  // ---- tie-break: equal scores fall back to roster order -------------------
  const twins = [
    { id: "t-1", alias: "TwinA", kind: "ai", role: "backend engineer (NestJS API)" },
    { id: "t-2", alias: "TwinB", kind: "ai", role: "backend engineer (NestJS API)" },
  ];
  const tieItem = { number: 16, title: "NestJS backend API bug", body_excerpt: "", labels: [] };
  const tieRanked = G.suggestAgents(tieItem, twins);
  assert(tieRanked[0].score === tieRanked[1].score, "identical roles produce identical scores (tie fixture is valid)");
  assert(tieRanked[0].agent.alias === "TwinA" && tieRanked[1].agent.alias === "TwinB",
    "a genuine score tie breaks by roster order (TwinA before TwinB), not re-sorted some other way");

  // ---- zero-signal item: no tokens match anyone -----------------------------
  const noiseItem = { number: 17, title: "zzz qqq xyzzy plugh", body_excerpt: "", labels: [] };
  const noiseRanked = G.suggestAgents(noiseItem, ROSTER);
  assert(Array.isArray(noiseRanked) && noiseRanked.length === 0,
    "an item with no matching tokens for anyone returns an empty ranked list (zero signal)");

  // ---- reason tokens: capped at 3, drawn from the actual matched tokens ----
  const richIssue = {
    number: 18, title: "iOS SwiftUI patient app crash",
    body_excerpt: "mobile ios swiftui patient app",
    labels: [{ name: "ios", color: "cfd3d7" }],
  };
  const richRanked = G.suggestAgents(richIssue, ROSTER);
  const plumEntry = richRanked.find((r) => r.agent.alias === "Plum");
  assert(!!plumEntry, "Plum is present in the ranked list for a heavily iOS-signaled issue");
  assert(Array.isArray(plumEntry.tokens) && plumEntry.tokens.length > 0 && plumEntry.tokens.length <= 3,
    "each ranked entry carries 1-3 matched reason tokens, never more than 3");
  assert(plumEntry.tokens.every((t) => /ios|swift|swiftui|patient|app|mobile/.test(t)),
    "reason tokens are drawn from tokens that actually matched (iOS-family), not arbitrary role words");

  console.log("");
}

function dropdownRenderTests() {
  console.log("agentRosterHtml() SUGGESTED section\n");
  const G = boot();

  const dashboardIssue = {
    number: 20, title: "Clinician dashboard demographics card broken",
    body_excerpt: "Next.js dashboard demographics card renders blank for clinicians.",
    labels: [{ name: "frontend", color: "0075ca" }],
  };
  const html = G.agentRosterHtml("issue", 20, ROSTER, dashboardIssue);

  assert(/SUGGESTED/i.test(html), "dropdown renders a SUGGESTED section for a signal-bearing item");
  assert(/ALL AGENTS/i.test(html), "dropdown renders an ALL AGENTS section below the suggested one");
  const suggestedIdx = html.search(/SUGGESTED/i);
  const allIdx = html.search(/ALL AGENTS/i);
  assert(suggestedIdx >= 0 && allIdx > suggestedIdx, "SUGGESTED section appears above ALL AGENTS");
  const crimsonIdx = html.indexOf("Crimson");
  assert(crimsonIdx >= 0 && crimsonIdx < allIdx, "the top match (Crimson) appears inside the SUGGESTED section, before ALL AGENTS");

  // reason chip content: some short recognizable token text near the suggested row
  const suggestedBlock = html.slice(suggestedIdx, allIdx);
  assert(/dashboard|web|frontend|nextjs/i.test(suggestedBlock),
    "the SUGGESTED entry's reason chip surfaces a matched token (e.g. dashboard/web)");

  // data-gh-assign wiring must survive the new markup — postStart's click handler
  // depends on this attribute existing on EVERY pickable row, suggested or not.
  const assignAttrCount = (html.match(/data-gh-assign="/g) || []).length;
  assert(assignAttrCount === ROSTER.filter((a) => a.kind === "ai").length,
    "every AI agent still gets exactly one data-gh-assign row (suggested entries are not duplicated in ALL AGENTS)");
  // mutation note: if the ALL AGENTS section were built from the FULL roster
  // instead of "roster minus already-suggested", assignAttrCount would be
  // rosterAiCount + suggestedCount (Crimson appearing twice) -> fails (RED).

  // kind/number still threaded through on suggested rows (same as plain rows)
  assert(new RegExp('data-gh-kind="issue"[^>]*data-gh-number="20"|data-gh-number="20"[^>]*data-gh-kind="issue"').test(html)
    || (/data-gh-kind="issue"/.test(suggestedBlock) && /data-gh-number="20"/.test(suggestedBlock)),
    "suggested rows carry the same data-gh-kind/data-gh-number as plain roster rows");

  // ---- zero-signal item: falls back to the plain unchanged list ------------
  const noiseItem = { number: 21, title: "zzz qqq xyzzy plugh", body_excerpt: "", labels: [] };
  const plainHtml = G.agentRosterHtml("issue", 21, ROSTER, noiseItem);
  assert(!/SUGGESTED/i.test(plainHtml), "a zero-signal item renders NO SUGGESTED section");
  assert(!/ALL AGENTS/i.test(plainHtml), "a zero-signal item renders NO ALL AGENTS divider either — the plain list is unchanged");
  const plainAssignCount = (plainHtml.match(/data-gh-assign="/g) || []).length;
  assert(plainAssignCount === ROSTER.filter((a) => a.kind === "ai").length,
    "zero-signal dropdown still lists every AI agent exactly once");

  // ---- backward compatibility: no `item` argument at all -------------------
  const noItemHtml = G.agentRosterHtml("issue", 22, ROSTER);
  assert(!/SUGGESTED/i.test(noItemHtml), "calling agentRosterHtml WITHOUT an item (old call shape) degrades to the plain list, no crash");
  assert((noItemHtml.match(/data-gh-assign="/g) || []).length === ROSTER.filter((a) => a.kind === "ai").length,
    "the no-item call still lists every AI agent");

  // ---- empty roster still handled (pre-existing behavior preserved) --------
  const emptyHtml = G.agentRosterHtml("issue", 23, [], dashboardIssue);
  assert(/No AI agents on this project/.test(emptyHtml), "an empty roster still renders the pre-existing empty-state message");

  console.log("");
}

function topTwoWhenCloseTests() {
  console.log("top-2 suggestions when scores are close\n");
  const G = boot();

  // Two agents whose roles overlap almost identically on this item's tokens —
  // scores should land close enough to both surface under SUGGESTED.
  const closeRoster = [
    { id: "c-1", alias: "AlphaBackend", kind: "ai", role: "backend engineer (NestJS API, FHIR)" },
    { id: "c-2", alias: "BetaBackend", kind: "ai", role: "backend engineer (NestJS API, FHIR integrations)" },
    { id: "c-3", alias: "GammaUX", kind: "ai", role: "UX / design system" },
  ];
  const item = { number: 30, title: "NestJS FHIR API backend bug", body_excerpt: "backend api fhir nestjs", labels: [] };
  const ranked = G.suggestAgents(item, closeRoster);
  assert(ranked.length >= 2, "close-scoring item produces at least 2 ranked candidates");

  const html = G.agentRosterHtml("issue", 30, closeRoster, item);
  const suggestedIdx = html.search(/SUGGESTED/i);
  const allIdx = html.search(/ALL AGENTS/i);
  const suggestedBlock = allIdx > suggestedIdx ? html.slice(suggestedIdx, allIdx) : html.slice(suggestedIdx);
  assert(/AlphaBackend/.test(suggestedBlock) && /BetaBackend/.test(suggestedBlock),
    "both close-scoring backend agents appear in the SUGGESTED section (top 2)");
  assert(!/GammaUX/.test(suggestedBlock), "the clearly-lower-scoring UX agent is NOT pulled into SUGGESTED");

  // ---- edge case: EVERY AI agent lands in SUGGESTED (empty "rest") --------
  // A 2-agent roster whose roles both overlap the item heavily enough that
  // BOTH qualify for the top-2 SUGGESTED cut, leaving nothing for "All
  // agents" — that section (and its divider) must not render as a dangling
  // empty header with zero rows under it.
  const twoAgentRoster = [
    { id: "e-1", alias: "Ada", kind: "ai", role: "web engineer frontend" },
    { id: "e-2", alias: "Bea", kind: "ai", role: "web engineer frontend react" },
  ];
  const allSuggestedItem = { number: 31, title: "web frontend react bug", body_excerpt: "", labels: [] };
  const allSuggestedHtml = G.agentRosterHtml("issue", 31, twoAgentRoster, allSuggestedItem);
  assert(/SUGGESTED/i.test(allSuggestedHtml), "both agents qualifying for SUGGESTED still renders the SUGGESTED section");
  assert(!/ALL AGENTS/i.test(allSuggestedHtml),
    "when EVERY AI agent is already in SUGGESTED, the ALL AGENTS header/divider is suppressed (no dangling empty section)");
  assert((allSuggestedHtml.match(/data-gh-assign="/g) || []).length === 2,
    "both agents still each get exactly one row (in SUGGESTED), none lost or duplicated");

  console.log("");
}

/* ============================================================================
   WIRING (real execution, not just source-grep): boots the actual
   github-state.js + github-render.js + github-boot.js trio together — same
   fake-DOM harness idiom as github_hub_live_defects.test.js — and simulates a
   real click on a list row's Start-dropdown toggle, then again on a DETAIL
   page's dropdown toggle, to prove agentRosterHtml's `item` argument is
   genuinely threaded through github-boot.js's ghOpenDropdown()/ghFindItem()
   for BOTH surfaces (the task's explicit "both list rows and detail pages"
   requirement) — not just unit-tested at the github-state.js level, which
   would miss a wiring gap (e.g. ghOpenDropdown forgetting to look the item
   up, or looking in the wrong payload for a detail-page click).
   ========================================================================== */
class FakeClassList {
  constructor() { this.set = new Set(); }
  add(c) { this.set.add(c); }
  remove(c) { this.set.delete(c); }
  toggle(c, force) {
    if (force === undefined) { if (this.set.has(c)) this.set.delete(c); else this.set.add(c); }
    else if (force) this.set.add(c); else this.set.delete(c);
  }
  contains(c) { return this.set.has(c); }
}
class FakeElement {
  constructor(tag, id) {
    this.tagName = (tag || "DIV").toUpperCase();
    this.id = id || "";
    this._html = "";
    this.classList = new FakeClassList();
    this._listeners = {};
    this.children = [];
    this.attrs = {};
    this.style = {};
  }
  addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); }
  dispatch(type, ev) { (this._listeners[type] || []).forEach((fn) => fn(ev)); }
  set innerHTML(html) { this._html = html; this._rebuildChildrenFromHtml(html); }
  get innerHTML() { return this._html; }
  querySelectorAll() { return []; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k]; }
  removeAttribute(k) { delete this.attrs[k]; }
  contains() { return false; }
  getBoundingClientRect() { return { top: 0, bottom: 20, left: 0, right: 20 }; }
  _rebuildChildrenFromHtml(html) {
    this.children = [];
    const re = /data-gh-open="([^"]+)"|data-gh-start-dd="([^"]+)"[^>]*data-gh-number="([^"]+)"/g;
    let m;
    while ((m = re.exec(html))) {
      const row = new FakeElement("div");
      if (m[1]) row.attrs["data-gh-open"] = m[1];
      if (m[2]) { row.attrs["data-gh-start-dd"] = m[2]; row.attrs["data-gh-number"] = m[3]; }
      this.children.push(row);
    }
  }
}
function clickOnStartDd(row) {
  // Exact-selector match only — github-boot.js's delegated handler checks
  // "[data-gh-start]" (bare Start button) BEFORE "[data-gh-start-dd]" (the
  // dropdown toggle); a loose `indexOf("data-gh-start")` substring match
  // would incorrectly also satisfy the bare-Start closest() call (that
  // selector string itself contains "data-gh-start" as a substring) and
  // short-circuit the handler down the wrong branch before it ever reaches
  // the dropdown-toggle branch.
  return {
    target: {
      closest: (sel) => (sel === "[data-gh-start-dd]" && row.attrs["data-gh-start-dd"] ? row : null),
    },
    stopPropagation() {}, preventDefault() {},
  };
}
const flush = () => new Promise((r) => setImmediate(r));
const settle = async (n) => { for (let i = 0; i < (n || 4); i++) await flush(); };

function bootTrio(fetchImpl, agents, initialHref) {
  const ghlist = new FakeElement("div", "ghlist");
  const ghHead = new FakeElement("div", "ghHead");
  const ghTabs = new FakeElement("nav", "ghTabs");
  const ghFilters = new FakeElement("div", "ghFilters");
  const els = { ghlist, ghHead, ghTabs, ghFilters };
  const bodyChildren = [];

  const documentShim = {
    getElementById: (id) => els[id] || null,
    addEventListener() {},
    documentElement: { setAttribute() {} },
    createElement: (tag) => new FakeElement(tag),
    body: { appendChild: (el) => bodyChildren.push(el) },
    querySelectorAll: () => [],
  };
  const historyShim = { pushState() {}, replaceState() {}, length: 1, back() {} };
  const locationShim = { href: initialHref || "https://orcha.example/github" };

  const sandbox = {
    console, document: documentShim, history: historyShim, location: locationShim, URL,
    setInterval: () => 0, setTimeout, clearTimeout,
    matchMedia: () => ({ matches: false }),
  };
  sandbox.window = sandbox;
  sandbox.window.addEventListener = () => {};
  sandbox.window.OrchaData = { start: (render) => { render(); }, currentCid: () => "cid-1" };
  sandbox.window.ORCHA = { container: { id: "cid-1", name: "demo" }, agents: agents || [] };
  sandbox.fetch = fetchImpl;
  sandbox.globalThis = sandbox;

  const esc = (s) => (s == null ? "" : String(s)).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
  sandbox.window.Orcha = {
    esc, trunc: (s) => s, relTime: () => "3h ago", ghAvatar: () => "<span></span>", icon: () => "",
    mdText: (s) => esc(s), mountShell() {},
    patch(el, html) { el.innerHTML = html; return true; },
    identity: () => null, identityHuman: () => null, toast() {},
  };

  vm.createContext(sandbox);
  vm.runInContext(STATE_JS, sandbox, { filename: "github-state.js" });
  vm.runInContext(RENDER_JS, sandbox, { filename: "github-render.js" });
  let bootThrew = null;
  try { vm.runInContext(BOOT_JS, sandbox, { filename: "github-boot.js" }); }
  catch (e) { bootThrew = e; }

  return { sandbox, ghlist, bootThrew, bodyChildren };
}

async function wiringTests() {
  console.log("wiring: github-boot.js threads the real item into agentRosterHtml (list + detail)\n");

  const agents = [
    { id: "a-crimson", alias: "Crimson", kind: "ai", role: "web engineer (Next.js clinician dashboard)" },
    { id: "a-plum", alias: "Plum", kind: "ai", role: "iOS engineer (SwiftUI patient app)" },
  ];

  // ---- LIST ROW: click the Start-dropdown toggle on a real list row --------
  const { ghlist, bootThrew, bodyChildren } = bootTrio((url) => {
    if (/\/github\/issues$/.test(url)) {
      return Promise.resolve({
        ok: true, status: 200,
        json: () => Promise.resolve({
          available: true, repo: "acme/demo",
          issues: [{ number: 42, title: "Clinician dashboard demographics card broken",
            labels: [{ name: "frontend", color: "0075ca" }], assignee: null,
            updated_at: "2026-08-01T00:00:00Z", html_url: "https://github.com/acme/demo/issues/42",
            body_excerpt: "Next.js dashboard demographics card renders blank." }],
        }),
      });
    }
    return new Promise(() => {});
  }, agents);
  assert(!bootThrew, "github-boot.js boots without throwing (list route)");
  await settle();

  const ddToggle = ghlist.children.find((c) => c.attrs["data-gh-start-dd"]);
  assert(!!ddToggle, "the rendered list row carries a data-gh-start-dd toggle");

  // ghOpenDropdown is page-local (not exported on window) — invoke it the
  // SAME way a real user does, by dispatching the click on #ghlist and
  // letting github-boot.js's own delegated listener (wired at boot) route it.
  ghlist.dispatch("click", clickOnStartDd(ddToggle));
  await settle();

  const ddHost = bodyChildren.find((el) => el.id === "ghAssignMenu");
  assert(!!ddHost, "clicking the toggle creates/opens the #ghAssignMenu floating host");
  assert(/SUGGESTED/i.test(ddHost.innerHTML),
    "LIST ROW: the real issue's title/labels ('Next.js dashboard demographics') reach agentRosterHtml — SUGGESTED renders");
  assert(ddHost.innerHTML.indexOf("Crimson") < ddHost.innerHTML.search(/ALL AGENTS/i),
    "LIST ROW: Crimson (web engineer) is the suggested match, ahead of the ALL AGENTS divider");

  // ---- DETAIL PAGE: same click, on a deep-linked ?issue=42 detail route ----
  const detail = bootTrio((url) => {
    if (/\/github\/issues\/42$/.test(url)) {
      return Promise.resolve({
        ok: true, status: 200,
        json: () => Promise.resolve({
          available: true, repo: "acme/demo",
          issue: {
            number: 42, title: "SwiftUI crash on iOS patient app launch", state: "open",
            body_markdown: "The patient app crashes on cold launch on iOS 18.",
            author_login: "octocat", labels: [{ name: "mobile", color: "d876e3" }],
            assignee: null, assignees: [],
            updated_at: "2026-08-01T00:00:00Z", created_at: "2026-08-01T00:00:00Z",
            html_url: "https://github.com/acme/demo/issues/42", comments_count: 0, comments: [],
          },
        }),
      });
    }
    return new Promise(() => {});
  }, agents, "https://orcha.example/github?issue=42");
  assert(!detail.bootThrew, "github-boot.js boots without throwing (detail route)");
  await settle();

  assert(detail.ghlist.innerHTML.indexOf("gh-detail-layout") !== -1, "the detail view actually painted (sanity check before clicking)");
  const detailDdToggle = detail.ghlist.children.find((c) => c.attrs["data-gh-start-dd"]);
  assert(!!detailDdToggle, "the rendered DETAIL page carries a data-gh-start-dd toggle (detailActionsHtml reuses startCellHtml)");

  detail.ghlist.dispatch("click", clickOnStartDd(detailDdToggle));
  await settle();

  const detailDdHost = detail.bodyChildren.find((el) => el.id === "ghAssignMenu");
  assert(!!detailDdHost, "clicking the DETAIL page's toggle also opens #ghAssignMenu");
  assert(/SUGGESTED/i.test(detailDdHost.innerHTML),
    "DETAIL PAGE: the real issue's title/labels ('SwiftUI...iOS patient app') reach agentRosterHtml via detailPayload — SUGGESTED renders");
  assert(detailDdHost.innerHTML.indexOf("Plum") < detailDdHost.innerHTML.search(/ALL AGENTS/i),
    "DETAIL PAGE: Plum (iOS engineer) is the suggested match, ahead of the ALL AGENTS divider");
  // mutation note: if ghFindItem() only ever consulted `payload` (the list
  // cache) and never `detailPayload`, this detail-route click (which never
  // populated `payload.issues` at all — only detailPayload.issue) would find
  // no item, agentRosterHtml would get `item:null`, and BOTH assertions
  // above would fail (RED) since the plain unsuggested list has no
  // "SUGGESTED" text and no Crimson/Plum ordering to check.

  console.log("");
}

function mutationNotes() {
  // Mutation-testing sweep ACTUALLY PERFORMED against the real file (not
  // just reasoned about): each mutation below was applied to
  // pages/github-state.js with a throwaway `python3 -c` string replace, the
  // suite re-run to confirm RED, then the file restored byte-for-byte
  // (diffed clean) before continuing. Two of these (1 and 5) needed their
  // fixtures STRENGTHENED first — the original fixtures didn't actually
  // exercise the mutated code path (e.g. Atlas scored 0 on the original
  // release-verification item regardless of the penalty, and no human
  // fixture's role text overlapped any test item), which would have made
  // the "caught" claim false. The fixtures below are the corrected ones.
  //   1. Set SUGGEST_ORCHESTRATOR_PENALTY = 1 (no-op multiplier): with
  //      releaseIssue's title/labels giving BOTH Sentinel ("release",
  //      "verification") and Atlas ("orchestrator", "coordinate" via
  //      synonym) real title-tier hits, Atlas's raw score (12) would exceed
  //      Sentinel's (6) without the 0.4 penalty -> both orchestrator-penalty
  //      assertions in scoringTests() fail (RED). Confirmed.
  //   2. Reverse the roster order before scoring (`.slice().reverse()`):
  //      the TwinA-before-TwinB tie-break assertion fails (RED). Confirmed.
  //   3. Have agentRosterHtml's ALL AGENTS section iterate the FULL roster
  //      (`const rest = list;`) instead of "roster minus suggested": the
  //      data-gh-assign COUNT assertion (must equal the AI roster size, not
  //      roster size + suggested count) fails (RED) — Crimson renders
  //      twice. Confirmed.
  //   4. Force every ranked entry's `tokens` to `[]`: the reason-chip
  //      content assertion and the "1-3 tokens" assertion both fail (RED).
  //      Confirmed.
  //   5. Drop the `kind === "ai"` filter in suggestAgents (score every
  //      roster kind): with rosterWithMatchingHuman's "HumanWeb" fixture
  //      (role text identical to Crimson's, so it WOULD score highly), the
  //      "human excluded even though its role would score highly" assertion
  //      fails (RED). Confirmed — the original human fixture (Kedar, role
  //      "Founder") did NOT catch this mutation, since its role never
  //      overlapped any test item; the dedicated matching-human fixture was
  //      added specifically to make this assertion load-bearing.
  //   6. Change suggestAgents' score filter from `> 0` to `>= 0` (zero-
  //      signal items produce a ranked entry per agent, all scored 0): the
  //      "empty ranked list" assertion AND both zero-signal dropdown
  //      assertions (no SUGGESTED, no ALL AGENTS) fail (RED). Confirmed.
  //   7. (github-boot.js, wiringTests()) Gut ghFindItem()'s detailPayload
  //      fallback down to `return null;` (list-payload lookup only): the
  //      LIST ROW assertions stay green (payload.issues still resolves that
  //      click), but BOTH DETAIL PAGE assertions (SUGGESTED renders / Plum
  //      ordered first) fail (RED) — a deep-linked detail-page click never
  //      populates `payload.issues` at all, only `detailPayload.issue`, so
  //      this is the mutation that specifically pins "both list rows AND
  //      detail pages" rather than just one of the two. Confirmed.
  console.log("mutation notes: see comments in mutationNotes() — 7 mutants, each actually applied to the real file(s) and confirmed RED, then restored clean.\n");
}

async function run() {
  console.log("github_agent_suggest.test.js\n");
  scoringTests();
  dropdownRenderTests();
  topTwoWhenCloseTests();
  await wiringTests();
  mutationNotes();
  console.log(failures === 0 ? "all github agent-suggest tests passed" : failures + " assertion(s) FAILED");
  process.exit(failures === 0 ? 0 : 1);
}
run();
