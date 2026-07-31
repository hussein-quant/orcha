/* ============================================================================
   Settings page tabs — regrouping chrome over the grown settings page.

   Part 1 (static): settings.html carries the #setTabs pill bar and every
   .set-card is tagged into a group (Workspace = keys + models, Collaboration =
   members + phone pairing, Appearance = skins) WITHOUT reordering the cards —
   the Anthropic key card must stay the page's FIRST .lead (settings_key
   Case 15 regexes it).

   Part 2 (behavior): loads the REAL modules/settings-tabs.js in a tiny vm DOM
   and pins tab selection, the #tab=<name> deep link (load + hashchange), the
   hash rewrite on click, and the unknown-hash fallback.

   Run: node tests/portal/settings_tabs.test.js
   ========================================================================== */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const STATIC = path.join(
  __dirname, "..", "..",
  "orcha-cli", "orcha_cli", "templates", "portal", "static"
);
const HTML = fs.readFileSync(path.join(STATIC, "settings.html"), "utf8");
const TABS_JS = fs.readFileSync(path.join(STATIC, "modules", "settings-tabs.js"), "utf8");
const CSS = fs.readFileSync(path.join(STATIC, "pages", "settings.css"), "utf8");

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log("  ✓ " + msg);
  else { failures++; console.error("  ✗ " + msg); }
}

/* ---------------- part 1: static settings.html structure ---------------- */
function staticTests() {
  console.log("static structure (settings.html + settings.css)\n");

  assert(/id="setTabs"[^>]*role="tablist"/.test(HTML), "the page carries a #setTabs tablist");
  ["workspace", "collaboration", "appearance"].forEach((t) => {
    assert(new RegExp('class="seg[^"]*"[^>]*data-tab="' + t + '"').test(HTML),
      "tab pill exists for " + t + " (topbar .seg idiom)");
  });
  assert(/<script src="\/assets\/modules\/settings-tabs\.js"><\/script>/.test(HTML),
    "settings-tabs.js is loaded");

  // each card block is tagged into its group, content untouched
  const cards = HTML.split('<div class="card set-card"').slice(1).map((chunk) => ({
    tab: (chunk.match(/^ data-settab="([\w-]+)">/) || [])[1] || null,
    chunk,
  }));
  const groupOf = (hostId) => {
    const hit = cards.find((c) => c.chunk.indexOf(hostId) !== -1);
    return hit ? hit.tab : null;
  };
  assert(cards.length === 6 && cards.every((c) => c.tab), "all six cards carry a data-settab group");
  assert(groupOf('id="keyCard"') === "workspace", "Anthropic key card sits under Workspace");
  assert(groupOf('id="providerKeys"') === "workspace", "xAI key card sits under Workspace");
  assert(groupOf('id="modelRows"') === "workspace", "model selection sits under Workspace");
  assert(groupOf('id="membersCard"') === "collaboration", "Members sits under Collaboration");
  assert(groupOf('id="pairingCard"') === "collaboration", "Phone pairing sits under Collaboration");
  assert(groupOf('id="skinGrid"') === "appearance", "Appearance card sits under Appearance");

  // Case 15's contract survives the tabs: DOM order unchanged, the FIRST .lead
  // is still the Anthropic-key copy (tabs hide via CSS, never reorder).
  const firstLead = (HTML.match(/<div class="lead">[\s\S]*?<\/div>/) || [""])[0];
  assert(/ORCHA_LLM_API_KEY/.test(firstLead) && /takes\s+precedence/i.test(firstLead),
    "the FIRST .lead in DOM order is still the Anthropic key copy (Case 15 intact)");

  // hiding is CSS keyed on .set-wrap[data-tab] — absent attr (no JS) hides nothing
  assert(/\.set-wrap\[data-tab="workspace"\] \.set-card\[data-settab\]:not\(\[data-settab="workspace"\]\)/.test(CSS),
    "settings.css hides non-active groups via .set-wrap[data-tab]");
}

/* ---------------- part 2: behavior (modules/settings-tabs.js) ------------ */
function tabNode(name, on) {
  const n = { _attrs: { "data-tab": name }, _class: on ? "seg on" : "seg", _listeners: {} };
  n.getAttribute = (k) => (k in n._attrs ? n._attrs[k] : null);
  n.setAttribute = (k, v) => { n._attrs[k] = String(v); };
  n.classList = {
    toggle: (c, force) => {
      const set = new Set(n._class.split(/\s+/).filter(Boolean));
      const want = force === undefined ? !set.has(c) : !!force;
      want ? set.add(c) : set.delete(c);
      n._class = Array.from(set).join(" ");
      return want;
    },
    contains: (c) => n._class.split(/\s+/).indexOf(c) !== -1,
  };
  n.addEventListener = (ev, fn) => { (n._listeners[ev] = n._listeners[ev] || []).push(fn); };
  n.click = () => (n._listeners.click || []).forEach((fn) => fn());
  return n;
}

function boot(startHash, orcha) {
  const tabs = [tabNode("workspace", true), tabNode("collaboration", false), tabNode("appearance", false)];
  const wrap = {
    _attrs: {},
    setAttribute(k, v) { this._attrs[k] = String(v); },
    getAttribute(k) { return k in this._attrs ? this._attrs[k] : null; },
  };
  const replaced = [];
  const winListeners = {};
  const sandbox = {
    window: {
      location: { hash: startHash || "" },
      addEventListener: (ev, fn) => { winListeners[ev] = fn; },
      Orcha: orcha,
    },
    document: {
      querySelector: (sel) => (sel === ".set-wrap" ? wrap : null),
      getElementById: (id) => (id === "setTabs" ? { querySelectorAll: () => tabs } : null),
    },
    history: { replaceState: (a, b, url) => replaced.push(url) },
    console,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(TABS_JS, sandbox, { filename: "settings-tabs.js" });
  return { tabs, wrap, replaced, winListeners, sandbox };
}

function behaviorTests() {
  console.log("\nbehavior (settings-tabs.js)\n");

  // default: no hash → first tab (workspace) selected, wrap keyed for CSS
  const d = boot("");
  assert(d.wrap.getAttribute("data-tab") === "workspace", "no hash defaults to the Workspace tab");
  assert(d.tabs[0].classList.contains("on") && !d.tabs[1].classList.contains("on"),
    "only the active pill carries .on");
  assert(d.tabs[0].getAttribute("aria-selected") === "true"
    && d.tabs[1].getAttribute("aria-selected") === "false", "aria-selected mirrors the selection");
  assert(d.replaced.length === 0, "loading writes NO hash (deep links only on user action)");

  // deep link: #tab=collaboration selects the tab on load
  const c = boot("#tab=collaboration");
  assert(c.wrap.getAttribute("data-tab") === "collaboration", "#tab=collaboration deep-links to Collaboration");
  assert(c.tabs[1].classList.contains("on") && !c.tabs[0].classList.contains("on"),
    "the deep-linked pill is the lit one");

  // unknown hash falls back to the first tab instead of blanking the page
  const u = boot("#tab=nonsense");
  assert(u.wrap.getAttribute("data-tab") === "workspace", "an unknown #tab falls back to Workspace");

  // clicking a pill selects it and rewrites the hash (replaceState)
  d.tabs[2].click();
  assert(d.wrap.getAttribute("data-tab") === "appearance", "clicking Appearance selects it");
  assert(d.replaced[d.replaced.length - 1] === "#tab=appearance", "the hash is rewritten to #tab=appearance");

  // hashchange (back/forward, manual edit) re-selects without a reload
  d.sandbox.window.location.hash = "#tab=collaboration";
  d.winListeners.hashchange();
  assert(d.wrap.getAttribute("data-tab") === "collaboration", "hashchange re-selects the tab");

  // access model: a trusted identity WITHOUT manage_keys loses the Workspace tab
  // (keys + models) — server still enforces; this just removes a dead tab.
  const g = boot("", {
    identity: () => ({ member_role: "member", grants: [] }),
    actingGrant: () => false,
  });
  assert(g.tabs[0].classList.contains("hidden"), "no manage_keys → the Workspace pill hides");
  assert(g.wrap.getAttribute("data-tab") === "collaboration",
    "…and the selection falls to the first visible tab (Collaboration)");
  const g2 = boot("#tab=workspace", {
    identity: () => ({ member_role: "member", grants: [] }),
    actingGrant: () => false,
  });
  assert(g2.wrap.getAttribute("data-tab") === "collaboration",
    "a #tab=workspace deep link cannot resurrect the hidden tab");

  // holding the grant (or being an owner) keeps every tab
  const k = boot("", {
    identity: () => ({ member_role: "member", grants: ["manage_keys"] }),
    actingGrant: (x) => x === "manage_keys",
  });
  assert(!k.tabs[0].classList.contains("hidden") && k.wrap.getAttribute("data-tab") === "workspace",
    "manage_keys (or owner) keeps the Workspace tab + default selection");

  // trust off / no identity: self-host sees every tab, unchanged
  const t = boot("", { identity: () => null, actingGrant: () => false });
  assert(!t.tabs[0].classList.contains("hidden") && t.wrap.getAttribute("data-tab") === "workspace",
    "no identity (trust off) hides nothing");
}

console.log("settings_tabs.test.js\n");
staticTests();
behaviorTests();
console.log("\n" + (failures === 0 ? "ALL PASSED" : failures + " FAILED"));
process.exit(failures === 0 ? 0 : 1);
