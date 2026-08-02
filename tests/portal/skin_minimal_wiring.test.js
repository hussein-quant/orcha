/* ============================================================================
   Minimalist skin (data-skin="minimal") — wiring pins.

   The Minimalist skin's CSS/fonts/stylesheet <link> are owned elsewhere (this
   test does not touch styles/*.css); this file pins the parts THIS task owns:

     PART A  modules/settings-appearance.js — the Appearance picker renders
             THREE tiles (Classic, Swiss, Minimalist), Minimalist carries the
             "clean · gold" subtitle, and clicking it stamps data-skin="minimal"
             on <html> immediately (no reload), writes localStorage
             "orcha:skin", and pokes OrchaPrefs.queuePut() — the same contract
             Classic/Swiss already use.
     PART B  the pre-paint <head> snippet (every shell page, settings.html
             pinned as the representative — PART C in user_prefs.test.js
             already checks all pages load app-prefs.js) — "minimal" is not
             rejected by the classic-only blocklist, so a fresh load with
             orcha:skin=minimal stamps data-skin="minimal" with no flash.
     PART C  modules/app-prefs.js applyServer() — a server prefs bag carrying
             skin:"minimal" applies data-skin="minimal" and mirrors it into
             localStorage, same as any other non-classic skin (no whitelist
             to extend — applyServer already branches only on "classic").
     PART D  server: portal_backend/user_pref_routes.py validates PREF KEYS
             (theme/skin/sidebar/default_cid), never skin VALUES — "minimal"
             already round-trips as a free-form scalar with zero backend
             changes. Grep-level assertion pins that contract so a future
             enum-lockdown would fail loudly here instead of silently
             breaking the skin.

   Each assertion below documents, in its message, what a targeted mutation
   would break (see the "Mutation:" comments) — flip that one thing locally
   and rerun to see the RED this test catches.

   Dependency-free (house vm-sandbox style, mirrors settings_tabs.test.js /
   user_prefs.test.js). Run:
     node tests/portal/skin_minimal_wiring.test.js
   ========================================================================== */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const STATIC = path.join(
  __dirname, "..", "..",
  "orcha-cli", "orcha_cli", "templates", "portal", "static"
);
const BACKEND = path.join(
  __dirname, "..", "..",
  "orcha-cli", "orcha_cli", "templates", "portal", "portal_backend"
);
const read = (...p) => fs.readFileSync(path.join(STATIC, ...p), "utf8");
const readBackend = (...p) => fs.readFileSync(path.join(BACKEND, ...p), "utf8");

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log("  ✓ " + msg);
  else { failures++; console.error("  ✗ " + msg); }
}

/* ---- tiny fake DOM: enough for renderSkins() (host + tile buttons) ------ *
 * Caches tile nodes per render (keyed by the current innerHTML) so
 * renderSkins()'s own internal querySelectorAll (which wires the click
 * listeners) and the test's later querySelectorAll (which drives a click)
 * return the SAME wired objects — mirrors project_switcher.test.js's _rows
 * caching idiom, invalidated only when innerHTML is reassigned. */
function makeNode() {
  const n = {
    _html: "", _attrs: {}, _listeners: {}, _tileCache: null,
    get innerHTML() { return n._html; },
    set innerHTML(v) { n._html = v == null ? "" : String(v); n._tileCache = null; },
    setAttribute: (k, v) => { n._attrs[k] = String(v); },
    getAttribute: (k) => (k in n._attrs ? n._attrs[k] : null),
    removeAttribute: (k) => { delete n._attrs[k]; },
    addEventListener: (ev, fn) => { (n._listeners[ev] = n._listeners[ev] || []).push(fn); },
    // parse out .skin-tile buttons from the rendered markup — just enough to
    // click one by data-skin, mirroring the real querySelectorAll(".skin-tile")
    // + per-tile addEventListener("click") wiring in renderSkins().
    querySelectorAll(sel) {
      if (sel !== ".skin-tile") return [];
      if (n._tileCache) return n._tileCache;
      const ids = [...n._html.matchAll(/data-skin="([\w-]+)"/g)].map((m) => m[1]);
      n._tileCache = ids.map((id) => {
        const tile = { _attrs: { "data-skin": id }, _listeners: {} };
        tile.getAttribute = (k) => (k in tile._attrs ? tile._attrs[k] : null);
        tile.addEventListener = (ev, fn) => { (tile._listeners[ev] = tile._listeners[ev] || []).push(fn); };
        tile.click = () => (tile._listeners.click || []).forEach((fn) => fn());
        return tile;
      });
      return n._tileCache;
    },
  };
  return n;
}

function appearanceSandbox() {
  const store = {};
  const htmlAttrs = {};
  const toasts = [];
  const prefsPokes = [];
  const skinGrid = makeNode();

  const sandbox = {
    console,
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; },
    },
    document: {
      documentElement: {
        setAttribute: (k, v) => { htmlAttrs[k] = v; },
        getAttribute: (k) => (k in htmlAttrs ? htmlAttrs[k] : null),
        removeAttribute: (k) => { delete htmlAttrs[k]; },
      },
      getElementById: (id) => (id === "skinGrid" ? skinGrid : null),
    },
    window: {
      OrchaData: { start: () => {}, resolveCid: () => Promise.resolve("c1") },
      OrchaPrefs: { queuePut: () => { prefsPokes.push(Date.now()); } },
      ORCHA: null,
    },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  // real O / SetEsc / SetIcon, as settings-key-state.js defines them ahead of
  // settings-appearance.js on the real page (shared classic-<script> scope) —
  // stub Orcha.esc/icon/toast rather than loading the whole app-* chain.
  sandbox.window.Orcha = {
    esc: (s) => (s == null ? "" : String(s)).replace(/[&<>"']/g, (c) => (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])),
    icon: (name) => `<svg data-icon="${name}"></svg>`,
    toast: (msg, kind) => toasts.push({ msg, kind }),
  };
  vm.runInContext("const O = window.Orcha; const SetIcon = O.icon, SetEsc = O.esc;", sandbox);

  // settings-appearance.js also references renderPairingCard/renderKey/
  // renderProviderKeys/renderModels/CID from sibling modules, and calls
  // window.OrchaData.start(...) at load time — stub the callbacks it needs
  // and let start() just capture (never fire) the boot render.
  vm.runInContext(
    "var renderPairingCard=function(){}, renderKey=function(){}, " +
    "renderProviderKeys=function(){}, renderModels=function(){}, " +
    "loadKey=function(){}, loadProviderKeys=function(){}, loadModels=function(){}, CID=null, " +
    "keyState=function(){}, looksLikeKey=function(){}, maskOptimistic=function(){}, " +
    "modelsForProvider=function(){}, currentSel=function(){}, isOverride=function(){}, " +
    "rowDirty=function(){}, buildOverrides=function(){};",
    sandbox
  );

  vm.runInContext(read("modules", "settings-appearance.js"), sandbox, { filename: "settings-appearance.js" });

  return { sandbox, store, htmlAttrs, toasts, prefsPokes, skinGrid,
    renderSkins: () => vm.runInContext("renderSkins()", sandbox) };
}

/* ---------------- PART A — the Appearance picker (settings-appearance.js) */
function pickerTests() {
  console.log("PART A — Appearance picker renders + selects Minimalist\n");

  const s = appearanceSandbox();
  s.renderSkins();

  const html = s.skinGrid.innerHTML;
  // Mutation: drop the { id: "minimal", ... } entry from SKINS → this fails
  // (3 tiles → 2, no data-skin="minimal" button, no "Minimalist" label).
  assert((html.match(/class="skin-tile/g) || []).length === 3,
    "picker renders exactly THREE tiles (Classic, Swiss, Minimalist)");
  assert(/data-skin="minimal"/.test(html), "a tile carries data-skin=\"minimal\"");
  assert(/Minimalist/.test(html), "the Minimalist tile shows its name");
  // Mutation: change desc to something else → this fails (subtitle contract
  // from the task: "clean · gold").
  const minimalTile = html.slice(html.indexOf('data-skin="minimal"'));
  assert(/clean · gold/.test(minimalTile), "Minimalist's subtitle reads \"clean · gold\"");
  assert(/data-skin="classic"/.test(html) && /data-skin="swiss"/.test(html),
    "Classic and Swiss are still present (Minimalist is additive, not a replacement)");

  // default (no stored pick) → classic is selected, Minimalist tile is NOT .on
  assert(/class="skin-tile on" data-skin="classic"/.test(html),
    "with no stored pick, Classic starts selected (unchanged default)");
  assert(!/class="skin-tile on" data-skin="minimal"/.test(html),
    "…and Minimalist starts unselected");

  // click the Minimalist tile
  const tiles = s.skinGrid.querySelectorAll(".skin-tile");
  const minimalBtn = tiles.find((t) => t.getAttribute("data-skin") === "minimal");
  minimalBtn.click();

  // Mutation: in applySkin(), special-case "minimal" like "classic" (skip the
  // setAttribute branch) → this fails (no data-skin stamped).
  assert(s.htmlAttrs["data-skin"] === "minimal",
    "selecting Minimalist stamps data-skin=\"minimal\" on <html> immediately (no reload)");
  // Mutation: forget the localStorage.setItem call → this fails (no persistence
  // for the pre-paint script to read on the next load).
  assert(s.store["orcha:skin"] === "minimal",
    "…and persists the pick to localStorage \"orcha:skin\"");
  // Mutation: drop the `if (window.OrchaPrefs) window.OrchaPrefs.queuePut();`
  // line → this fails (per-user pref never syncs to the server).
  assert(s.prefsPokes.length === 1,
    "…and pokes OrchaPrefs.queuePut() to mirror the pick to the per-user pref");
  assert(s.toasts.length === 1 && s.toasts[0].msg === "Design · Minimalist" && s.toasts[0].kind === "ok",
    "…and toasts confirmation naming Minimalist, same as Classic/Swiss");

  // re-render reflects the new selection: Minimalist tile now carries .on,
  // Classic no longer does
  s.renderSkins();
  const html2 = s.skinGrid.innerHTML;
  assert(/class="skin-tile on" data-skin="minimal"/.test(html2),
    "after selection, the Minimalist tile re-renders as selected (.on + check icon)");
  assert(!/class="skin-tile on" data-skin="classic"/.test(html2),
    "…and Classic is no longer marked selected");

  // currentSkin() falls back to classic for a value outside the known set —
  // pins that "minimal" is now a recognized member, not a stray string that
  // would silently fall back.
  s.store["orcha:skin"] = "minimal";
  s.renderSkins();
  assert(/class="skin-tile on" data-skin="minimal"/.test(s.skinGrid.innerHTML),
    "currentSkin() recognizes \"minimal\" as a valid stored pick (survives reload, in-process)");
}

/* ---------------- PART B — pre-paint <head> snippet ---------------------- */
function prePaintTests() {
  console.log("\nPART B — pre-paint snippet accepts \"minimal\" (no flash)\n");

  const html = read("settings.html");
  const snippetMatch = html.match(/<script>\(function\(\)\{try\{var d=document\.documentElement[\s\S]*?<\/script>/);
  assert(!!snippetMatch, "settings.html carries the pre-paint <head> script");
  const snippet = snippetMatch[0];

  // Mutation: turn the classic-only blocklist into an explicit whitelist, e.g.
  // `if(s&&(s==='swiss'))d.setAttribute(...)` → this fails (RED): "minimal"
  // would no longer be stamped pre-paint, causing a flash of the wrong skin.
  assert(/if\(s&&s!=='classic'\)d\.setAttribute\('data-skin',s\)/.test(snippet),
    "the skin gate is a classic-only blocklist, not a name whitelist — \"minimal\" passes through");

  // Execute the real snippet in a sandbox seeded with orcha:skin=minimal and
  // confirm it stamps the attribute, exactly as a fresh page load would.
  const store = { "orcha:skin": "minimal" };
  const htmlAttrs = {};
  const styles = {};
  const sandbox = {
    document: {
      documentElement: {
        setAttribute: (k, v) => { htmlAttrs[k] = v; },
        style: new Proxy(styles, { set(t, k, v) { t[k] = v; return true; } }),
      },
      addEventListener: () => {},
    },
    localStorage: { getItem: (k) => (k in store ? store[k] : null) },
    window: { matchMedia: () => ({ matches: false }) },
  };
  sandbox.window.matchMedia = sandbox.window.matchMedia;
  sandbox.matchMedia = sandbox.window.matchMedia;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(snippet.replace(/^<script>/, "").replace(/<\/script>$/, ""), sandbox, { filename: "prepaint.js" });

  assert(htmlAttrs["data-skin"] === "minimal",
    "running the real pre-paint snippet with orcha:skin=minimal stamps data-skin=\"minimal\" on <html>");
  // Mutation: hardcode the flash-prevention background to the swiss/default
  // ternary only (drop the M=s==='minimal' branch) → this still passes the
  // attribute check above but the anti-flash color silently falls through to
  // the wrong palette; this assertion pins that minimal gets its OWN branch.
  assert(/M=s===['"]minimal['"]/.test(snippet),
    "the anti-flash background/text ternary has its own minimal branch (not silently sharing swiss's dark colors)");

  // every shell page must carry the identical patched snippet (PART C of
  // user_prefs.test.js already pins that every page loads app-prefs.js; this
  // pins the pre-paint <head> script itself is uniform across pages).
  const pages = ["home.html", "tasks.html", "requests.html", "agents.html",
    "metrics.html", "projects.html", "onboarding.html"];
  for (const p of pages) {
    const m = read(p).match(/<script>\(function\(\)\{try\{var d=document\.documentElement[\s\S]*?<\/script>/);
    assert(!!m && m[0] === snippet, p + " carries the identical pre-paint snippet (minimal included)");
  }
}

/* ---------------- PART C — app-prefs.js applyServer() -------------------- */
function serverWinsSandbox(serverPrefs) {
  const store = {};
  const htmlAttrs = {};
  const sandbox = {
    window: {}, console,
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; },
    },
    document: {
      documentElement: {
        setAttribute: (k, v) => { htmlAttrs[k] = v; },
        getAttribute: (k) => (k in htmlAttrs ? htmlAttrs[k] : null),
        removeAttribute: (k) => { delete htmlAttrs[k]; },
      },
    },
    setTimeout: () => 0, clearTimeout: () => {},
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({ prefs: serverPrefs }) }),
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read("modules", "app-prefs.js"), sandbox, { filename: "app-prefs.js" });
  return { sandbox, store, htmlAttrs, Prefs: sandbox.window.OrchaPrefs };
}

async function serverSyncTests() {
  console.log("\nPART C — OrchaPrefs applyServer() round-trips \"minimal\"\n");

  const s = serverSyncSandboxHelper();
  const applied = await s.Prefs.sync();

  // Mutation: change applyServer's skin branch to an explicit whitelist (e.g.
  // `if(prefs.skin==='swiss')...`) → this fails (RED): server-sent "minimal"
  // would never reach <html>, and cross-device sync would silently drop it.
  assert(applied && applied.skin === "minimal", "sync() resolves a server bag carrying skin:\"minimal\"");
  assert(s.htmlAttrs["data-skin"] === "minimal", "applyServer() stamps data-skin=\"minimal\" on <html>");
  assert(s.store["orcha:skin"] === "minimal",
    "…and mirrors it into localStorage (so the NEXT load's pre-paint script is instant)");
}
function serverSyncSandboxHelper() { return serverWinsSandbox({ skin: "minimal" }); }

/* ---------------- PART D — server-side prefs validation ------------------ */
function serverValidationTests() {
  console.log("\nPART D — server: user_prefs validates KEYS, not skin VALUES\n");

  const py = readBackend("user_pref_routes.py");

  // Mutation: add a per-value enum check, e.g.
  // `if prefs.get("skin") not in ("classic","swiss"): raise HTTPException(422,...)`
  // without adding "minimal" → this fails (RED), pinning that IF a value
  // whitelist is ever introduced, "minimal" must be added alongside it.
  assert(/ALLOWED_PREF_KEYS\s*=\s*\(\s*"theme",\s*"skin",\s*"sidebar",\s*"default_cid"\s*\)/.test(py),
    "ALLOWED_PREF_KEYS whitelists PREF KEYS only (theme/skin/sidebar/default_cid)");
  assert(!/["'](classic|swiss)["']\s*,?\s*["']?(classic|swiss)?["']?\s*\)/.test(
    py.replace(/ALLOWED_PREF_KEYS[^\n]*\n/, "")),
    "no separate allow-list of skin VALUES exists in the backend (free-form scalar, so \"minimal\" already round-trips)");
  assert(/isinstance\(value,\s*\(str,\s*int,\s*float,\s*bool\)\)/.test(py),
    "_validate_prefs only checks the VALUE TYPE (scalar) — a new skin id needs no server change");

  // simulate the same shape gate _validate_prefs enforces, to prove
  // {"skin": "minimal"} clears it (unknown-key + type + length + byte-size).
  const ALLOWED = ["theme", "skin", "sidebar", "default_cid"];
  const prefs = { skin: "minimal" };
  const unknownKeys = Object.keys(prefs).filter((k) => !ALLOWED.includes(k));
  assert(unknownKeys.length === 0, "{skin:\"minimal\"} has no unknown keys — passes the whitelist gate");
  assert(typeof prefs.skin === "string" && prefs.skin.length <= 500,
    "\"minimal\" is a scalar string under the 500-char cap — passes the type/length gate");
  assert(Buffer.byteLength(JSON.stringify(prefs), "utf8") <= 2048,
    "the payload is well under the 2048-byte cap — passes the size gate");
}

async function run() {
  console.log("skin_minimal_wiring.test.js\n");
  pickerTests();
  prePaintTests();
  await serverSyncTests();
  serverValidationTests();
  console.log("\n" + (failures === 0 ? "ALL PASSED" : failures + " FAILED"));
  process.exit(failures === 0 ? 0 : 1);
}

run();
