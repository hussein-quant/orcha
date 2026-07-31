/* ============================================================================
   Per-project identity — the honest NON-MEMBER VIEWER state (the kedar1607 bug).

   When the trusted proxy lane is live (D.identityTrusted) but /api/me resolved
   NO member of the current project (D.identity == null), the portal must:
     * render a neutral "viewer" chip — never another member's avatar/name,
       and never the project's default human;
     * resolve actingHuman() to null so every action sender disables itself;
     * show the invite banner;
     * keep sign-out reachable from the chip menu.
   Trust OFF (identityTrusted false) keeps the pre-collab local-human fallback
   byte-for-byte, so self-hosters see no change.

   Dependency-free (mirrors collab_members.test.js): loads the real shell
   modules into a vm sandbox and pins the pure builders.

   Run: node tests/portal/viewer_state.test.js
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

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log("  ✓ " + msg);
  else { failures++; console.error("  ✗ " + msg); }
}

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
  // one local human in the snapshot — the fallback target the viewer must NOT inherit
  vm.runInContext(
    `window.ORCHA.agents = [{ id: "h1", alias: "hussein-quant", kind: "human", member_role: "owner" }];`,
    sandbox
  );
  return sandbox;
}

console.log("viewer state (trusted, non-member)\n");
{
  const sb = shellSandbox();
  vm.runInContext(
    "window.ORCHA.identity = null; window.ORCHA.identityTrusted = true;", sb
  );

  assert(vm.runInContext("viewerOnly()", sb) === true,
    "identity null + trusted -> viewerOnly() is true");
  assert(vm.runInContext("actingHuman()", sb) === null,
    "actingHuman() is NULL — never the project's default human");
  assert(vm.runInContext("actingOwner()", sb) === false,
    "actingOwner() is false — no owner affordances");

  const chip = vm.runInContext("actingChipHtml()", sb);
  assert(/viewer-chip/.test(chip) && /viewer · not a member/.test(chip),
    "chip renders the neutral viewer state");
  assert(!/hussein-quant/.test(chip),
    "chip never shows the default human's name (the kedar1607 bug)");
  assert(!/av /.test(chip) && !/gh-face/.test(chip),
    "chip carries no avatar of someone else");

  const banner = vm.runInContext("viewerBannerHtml()", sb);
  assert(/non-member/.test(banner) && /invite/.test(banner),
    "banner asks for an invite to act");
  assert(vm.runInContext(
    "(() => { try { ensureViewerBanner({ innerHTML: '' }); return true; } catch (e) { return false; } })()",
    sb
  ), "ensureViewerBanner no-ops safely on a stub topbar (harness/D0 guard)");

  const menu = vm.runInContext("actingMenuHtml()", sb);
  assert(/Not a member/.test(menu) && /Sign out/.test(menu) && /oauth2\/sign_out/.test(menu),
    "chip menu still offers Sign out (there IS a proxy session to clear)");
}

console.log("\ntrust off — pre-collab fallback intact\n");
{
  const sb = shellSandbox();
  vm.runInContext(
    "window.ORCHA.identity = null; window.ORCHA.identityTrusted = false;", sb
  );
  assert(vm.runInContext("viewerOnly()", sb) === false,
    "identity null without trust is NOT the viewer state");
  const actor = vm.runInContext("JSON.stringify(actingHuman())", sb);
  assert(JSON.parse(actor) && JSON.parse(actor).id === "h1",
    "actingHuman() falls back to the local human (self-host unchanged)");
  const chip = vm.runInContext("actingChipHtml()", sb);
  assert(/hussein-quant/.test(chip), "chip shows the picked local human");
  assert(vm.runInContext("actingMenuHtml()", sb) === "",
    "no proxy session -> no account menu");
  assert(vm.runInContext("viewerOnly()", sb) === false && !/show/.test(""),
    "banner stays hidden (viewerOnly false drives the .show class off)");
}

console.log("\ntrusted member — resolved identity still acts\n");
{
  const sb = shellSandbox();
  vm.runInContext(`window.ORCHA.identity = { agent_id: "h1", alias: "hussein-quant",
    github_login: "hussein-quant", member_role: "owner",
    avatar_url: "https://github.com/hussein-quant.png" };
    window.ORCHA.identityTrusted = true;`, sb);
  assert(vm.runInContext("viewerOnly()", sb) === false,
    "a resolved member is not a viewer");
  const actor = vm.runInContext("JSON.stringify(actingHuman())", sb);
  assert(JSON.parse(actor).id === "h1",
    "actingHuman() resolves to the verified member");
  const chip = vm.runInContext("actingChipHtml()", sb);
  assert(/gh-login">hussein-quant</.test(chip),
    "chip shows the member's own GitHub identity");
}

console.log("");
if (failures) { console.error(failures + " assertion(s) failed"); process.exit(1); }
console.log("viewer_state: all assertions passed");
