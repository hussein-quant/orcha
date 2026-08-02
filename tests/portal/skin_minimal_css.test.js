/* ============================================================================
   Minimalist skin (data-skin="minimal") — CSS/fonts pins.

   This file owns exactly what skin_minimal_wiring.test.js explicitly
   disclaims: "the Minimalist skin's CSS/fonts/stylesheet <link>" (that test
   covers the Settings picker + prefs wiring in OTHER files — this one never
   touches settings-appearance.js, app-prefs.js, or the backend).

   Covers:
     PART A  skin-minimal.css exists and is <link>ed by every shell page
             (the pre-paint <head> block already proves "minimal" isn't
             blocklisted; this proves the stylesheet that actually renders
             it is wired in, right after responsive.css like the swiss
             precedent) and by the styles.css @import compatibility entrypoint.
     PART B  EVERY selector in skin-minimal.css is scoped under
             html[data-skin="minimal"] — parses the file's rule blocks (not a
             regex-per-line guess) so a stray unscoped selector that would
             leak into the classic/swiss skins fails loudly.
     PART C  both [data-theme="light"] and [data-theme="dark"] variants are
             present (plus the prefers-color-scheme "auto" branch), each
             defining the full token set (not a partial override).
     PART D  the gold accent hex matches the welcome page's token exactly
             (deploy/auth/welcome/index.template.html --gold /
             --accent-strong: #E7C368) in the dark variant, where the skin's
             --accent is the undimmed brand gold.
     PART E  fonts: Hanken Grotesk is declared with a LOCAL woff2 path only
             (no remote/Google Fonts URL), the file it points at exists on
             disk, and the skin's body font-family actually uses it.
     PART F  size budget: skin-minimal.css stays at or under 40KB.

   Each assertion documents, in its message or an adjacent comment, what a
   targeted mutation would break. Dependency-free (house vm-free style —
   this file is pure fs + a small hand-rolled CSS scanner, no vm needed
   since there's no JS under test). Run:
     node tests/portal/skin_minimal_css.test.js
   ========================================================================== */
const fs = require("fs");
const path = require("path");

const PORTAL_ROOT = path.join(__dirname, "..", "..", "orcha-cli", "orcha_cli", "templates", "portal");
const STATIC = path.join(PORTAL_ROOT, "static");
const STYLES = path.join(STATIC, "styles");
const FONTS = path.join(STATIC, "fonts");
const WELCOME_TEMPLATE = path.join(__dirname, "..", "..", "deploy", "auth", "welcome", "index.template.html");

const read = (p) => fs.readFileSync(p, "utf8");

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log("  ✓ " + msg);
  else { failures++; console.error("  ✗ " + msg); }
}

const SKIN_CSS_PATH = path.join(STYLES, "skin-minimal.css");

/* ---------------- PART A — file exists + is included everywhere ---------- */
function inclusionTests() {
  console.log("PART A — skin-minimal.css exists and is included\n");

  // Mutation: delete/rename the file → this fails (RED): nothing under
  // static/styles/ answers to the name every <link> below points at.
  assert(fs.existsSync(SKIN_CSS_PATH), "static/styles/skin-minimal.css exists");

  const PAGES = ["home.html", "projects.html", "agents.html", "onboarding.html",
    "metrics.html", "tasks.html", "requests.html", "settings.html"];
  for (const page of PAGES) {
    const html = read(path.join(STATIC, page));
    // Mutation: remove the <link> from one page (e.g. copy-paste miss on a
    // new page) → this fails (RED) for exactly that page — the skin would
    // silently not render there while working everywhere else.
    assert(/<link rel="stylesheet" href="\/assets\/styles\/skin-minimal\.css">/.test(html),
      page + " <link>s /assets/styles/skin-minimal.css");

    // Mutation: move the <link> above responsive.css → this fails (RED):
    // the swiss skin precedent (responsive.css) and this skin both override
    // tokens.css/shell.css/components.css, so ours must load LAST to win.
    const respIdx = html.indexOf('href="/assets/styles/responsive.css"');
    const minIdx = html.indexOf('href="/assets/styles/skin-minimal.css"');
    assert(respIdx !== -1 && minIdx !== -1 && minIdx > respIdx,
      page + " loads skin-minimal.css AFTER responsive.css (so its overrides win)");
  }

  // Mutation: drop the @import from the styles.css compatibility entrypoint
  // → this fails (RED): any caller still using the old single-file include
  // (onboarding.html does, via /assets/styles.css) never gets the skin.
  const stylesCss = read(path.join(STATIC, "styles.css"));
  assert(/@import url\("\/assets\/styles\/skin-minimal\.css"\);/.test(stylesCss),
    "styles.css compatibility entrypoint @imports skin-minimal.css");
}

/* ---------------- PART B — every rule is scoped under the skin ----------- */
// Minimal, purpose-built CSS scanner: strips comments, then walks the file
// tracking brace depth. Every top-level "selector-list { … }" block's
// selector list is captured; @media blocks recurse one level (their inner
// rule selectors are the ones that matter — the @media prelude itself is
// not a selector). This is intentionally simple (no attribute-value colons,
// no nested @supports) because skin-minimal.css only uses plain rules and
// one top-level @media (prefers-color-scheme: light) block, matching the
// same shape as the existing swiss skin block in responsive.css.
function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}
// Walks a brace stack so we know, at every "{", whether we're opening a
// SELECTOR block (top level, or nested directly inside an @media prelude —
// its header goes in `selectors`) or a DECLARATION block (nested inside a
// selector block — its body is `prop: value;` pairs, never a selector, and
// must NOT be scanned for text to treat as one). `buf` is reset on both "{"
// and "}" so leftover declaration text from a just-closed block can never
// bleed into the next selector header.
function extractRuleSelectors(css) {
  const src = stripComments(css);
  const selectors = [];
  const stack = []; // entries: "media" | "rule"
  let buf = "";
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") {
      const header = buf.trim();
      buf = "";
      const parent = stack[stack.length - 1];
      const collectingSelectors = stack.length === 0 || parent === "media";
      if (collectingSelectors) {
        if (header.startsWith("@media")) {
          stack.push("media");
        } else {
          if (header.length) selectors.push(header);
          stack.push("rule");
        }
      } else {
        // inside a declaration block already — nothing at this depth is a
        // selector (skin-minimal.css has no nested rules); just track depth.
        stack.push("rule");
      }
    } else if (ch === "}") {
      stack.pop();
      buf = "";
    } else {
      buf += ch;
    }
  }
  return selectors;
}

function scopingTests() {
  console.log("\nPART B — every selector is scoped under [data-skin=\"minimal\"]\n");

  const css = read(SKIN_CSS_PATH);
  const selectors = extractRuleSelectors(css);

  assert(selectors.length > 20,
    "sanity: the scanner actually found a substantial number of rule blocks (" + selectors.length + ")");

  const offenders = [];
  for (const header of selectors) {
    // A selector LIST can have multiple comma-separated selectors, each of
    // which must carry the scope (a bare `.card, .foo` with only one scoped
    // arm would still leak `.foo` into every other skin).
    const arms = header.split(",").map((s) => s.trim()).filter(Boolean);
    for (const arm of arms) {
      if (!/\[data-skin="minimal"\]/.test(arm)) offenders.push(arm);
    }
  }

  // Mutation: add ANY rule like `.card { border-radius: 18px; }` without the
  // html[data-skin="minimal"] prefix → this fails (RED) and prints exactly
  // which selector arm leaked, since that rule would silently apply to the
  // classic AND swiss skins too.
  assert(offenders.length === 0,
    "no unscoped selector arms leak outside [data-skin=\"minimal\"]" +
    (offenders.length ? " — offenders: " + JSON.stringify(offenders.slice(0, 5)) : ""));

  // Every scoped selector's root is specifically `html[data-skin="minimal"]`
  // (not just containing the attribute selector somewhere deep, which could
  // still under-scope a descendant combinator typo like
  // `body [data-skin="minimal"] .card`). Mutation: swap the anchor from
  // `html[data-skin="minimal"]` to a bare `[data-skin="minimal"]` → still
  // passes PART B's leak check but this stricter assertion catches the
  // drift from the file's own documented convention.
  const nonHtmlAnchored = selectors
    .flatMap((h) => h.split(",").map((s) => s.trim()))
    .filter((arm) => /\[data-skin="minimal"\]/.test(arm) && !/^html\[data-skin="minimal"\]/.test(arm));
  assert(nonHtmlAnchored.length === 0,
    "every scoped selector is anchored at html[data-skin=\"minimal\"] (not a bare/descendant match)" +
    (nonHtmlAnchored.length ? " — offenders: " + JSON.stringify(nonHtmlAnchored.slice(0, 5)) : ""));
}

/* ---------------- PART C — both theme variants present ------------------- */
function themeVariantTests() {
  console.log("\nPART C — both [data-theme] variants are present\n");

  const css = read(SKIN_CSS_PATH);

  // Mutation: delete the html[data-skin="minimal"][data-theme="light"] block
  // → this fails (RED): the skin brief requires BOTH themes to work, not
  // just dark-by-default.
  assert(/html\[data-skin="minimal"\]\[data-theme="light"\]\s*\{/.test(css),
    "a html[data-skin=\"minimal\"][data-theme=\"light\"] token block exists");
  assert(/html\[data-skin="minimal"\],\s*\n\s*html\[data-skin="minimal"\]\[data-theme="dark"\]\s*\{/.test(css),
    "a html[data-skin=\"minimal\"] (+ explicit [data-theme=\"dark\"]) token block exists");
  // Mutation: drop the prefers-color-scheme auto branch → this fails (RED):
  // data-theme="auto" (the app default) would render with dark tokens even
  // on a light-preference OS, unlike every other skin.
  assert(/@media \(prefers-color-scheme: light\)\s*\{\s*html\[data-skin="minimal"\]\[data-theme="auto"\]/.test(css),
    "the [data-theme=\"auto\"] branch flips to light tokens under prefers-color-scheme: light");

  // Each variant defines a FULL token set, not a partial override that would
  // leave some component reading a leftover classic/swiss value. Spot-check
  // the tokens every downstream component rule in this file depends on.
  const REQUIRED_TOKENS = ["--bg", "--surface", "--text", "--muted", "--border",
    "--accent", "--accent-ink", "--accent-soft", "--accent-line", "--accent-glow",
    "--ok", "--warn", "--danger", "--diff-add", "--diff-del", "--shadow-sm", "--ring"];
  function blockFor(theme) {
    const re = theme === "dark"
      ? /html\[data-skin="minimal"\],\s*\nhtml\[data-skin="minimal"\]\[data-theme="dark"\]\s*\{([\s\S]*?)\n\}/
      : /html\[data-skin="minimal"\]\[data-theme="light"\]\s*\{([\s\S]*?)\n\}/;
    const m = css.match(re);
    return m ? m[1] : "";
  }
  for (const theme of ["dark", "light"]) {
    const block = blockFor(theme);
    assert(block.length > 0, theme + " token block body was located for token completeness check");
    for (const tok of REQUIRED_TOKENS) {
      // Mutation: remove any single token (e.g. --diff-del) from one theme
      // block → this fails (RED) for that exact token/theme pair, catching
      // a partial override before a component silently falls back to the
      // classic skin's color in just one theme.
      assert(new RegExp("(^|\\s)" + tok + ":").test(block),
        theme + " block defines " + tok);
    }
  }
}

/* ---------------- PART D — gold accent matches the welcome page ---------- */
function goldAccentTests() {
  console.log("\nPART D — gold accent hex matches the welcome page token\n");

  const welcome = read(WELCOME_TEMPLATE);
  // Pull the dark-mode --gold value straight from the welcome page's :root
  // block (the founder-approved source of truth named in the task brief),
  // rather than hardcoding the expected hex — if the welcome page's brand
  // gold ever changes, this test re-derives the target instead of silently
  // comparing against a stale constant.
  const goldMatch = welcome.match(/--gold:\s*#([0-9A-Fa-f]{6})/);
  assert(!!goldMatch, "deploy/auth/welcome/index.template.html defines --gold in its :root token block");
  const welcomeGold = goldMatch[1].toLowerCase();
  assert(welcomeGold === "e7c368", "the welcome page's --gold is #E7C368 (sanity pin on the source-of-truth value)");

  const css = read(SKIN_CSS_PATH);
  const darkBlock = css.match(/html\[data-skin="minimal"\],\s*\nhtml\[data-skin="minimal"\]\[data-theme="dark"\]\s*\{([\s\S]*?)\n\}/);
  assert(!!darkBlock, "dark token block located for accent check");

  // Mutation: change --accent in the dark block to any other hex (e.g. a
  // slightly-off gold, or teal from the classic skin) → this fails (RED).
  // The dark variant is the one that should carry the undimmed brand gold —
  // light legitimately darkens it for AA contrast (mirroring the welcome
  // page's own --gold-vs-accent-text split), so only dark is compared 1:1.
  const accentMatch = darkBlock[1].match(/--accent:\s*#([0-9A-Fa-f]{6})/);
  assert(!!accentMatch, "dark block defines --accent as a hex color");
  assert(accentMatch[1].toLowerCase() === welcomeGold,
    "skin-minimal.css dark --accent (#" + (accentMatch && accentMatch[1]) + ") matches the welcome page's --gold (#" + welcomeGold + ")");

  // --amber (the secondary "human/attention" tone reused across the portal)
  // is documented in the brief as "ONE accent" — pin that amber isn't a
  // second competing hue but the same gold.
  const amberMatch = darkBlock[1].match(/--amber:\s*#([0-9A-Fa-f]{6})/);
  assert(!!amberMatch && amberMatch[1].toLowerCase() === welcomeGold,
    "dark --amber also resolves to the same single gold accent, not a second hue");
}

/* ---------------- PART E — fonts: local woff2 only ------------------------ */
function fontTests() {
  console.log("\nPART E — Hanken Grotesk declared with local woff2 paths only\n");

  const fontsCss = read(path.join(STYLES, "fonts.css"));

  // Mutation: point src at fonts.googleapis.com or any http(s) URL → this
  // fails (RED): the whole point of self-hosting (fonts.css's own file
  // header) is zero third-party font requests at runtime.
  const faceMatch = fontsCss.match(/@font-face\s*\{\s*font-family:\s*"Hanken Grotesk"[\s\S]*?\}/);
  assert(!!faceMatch, "fonts.css declares an @font-face for \"Hanken Grotesk\"");
  const face = faceMatch[0];
  assert(/src:\s*url\("\/assets\/fonts\/[\w.-]+\.woff2"\)\s*format\("woff2"\)/.test(face),
    "the @font-face src is a local /assets/fonts/*.woff2 path");
  assert(!/https?:\/\//.test(face), "no remote (http/https) URL appears anywhere in the @font-face rule");
  assert(!/fonts\.googleapis\.com|fonts\.gstatic\.com/.test(face),
    "no Google Fonts CDN reference in the @font-face rule");
  assert(/font-display:\s*swap/.test(face), "font-display: swap, matching every other face in this file");

  // The @font-face src path must resolve to a real file on disk under
  // static/fonts/ (the /assets/fonts/ URL prefix maps to that directory).
  const srcMatch = face.match(/url\("\/assets\/fonts\/([\w.-]+\.woff2)"\)/);
  assert(!!srcMatch, "extracted the referenced woff2 filename from the @font-face src");
  const fontFile = srcMatch && srcMatch[1];
  // Mutation: delete/rename static/fonts/hanken-grotesk-var.woff2 without
  // updating fonts.css → this fails (RED): a 404'd font silently falls back
  // to the system sans, contradicting the "Hanken Grotesk as the UI face"
  // requirement with no visible error anywhere else.
  assert(fontFile && fs.existsSync(path.join(FONTS, fontFile)),
    "the referenced font file (" + fontFile + ") exists under static/fonts/");

  // License text ships alongside the binary (SIL OFL requirement + repo's
  // own convention of keeping self-hosted fonts license-accompanied).
  assert(fs.existsSync(path.join(FONTS, "OFL-hanken-grotesk.txt")),
    "static/fonts/OFL-hanken-grotesk.txt (SIL OFL license text) is present");
  const license = read(path.join(FONTS, "OFL-hanken-grotesk.txt"));
  assert(/SIL OPEN FONT LICENSE/.test(license), "the license file is the real SIL OFL text, not a stub");

  // The skin actually USES the font it declares — otherwise PART E above
  // would be dead weight (a face nothing applies).
  const skinCss = read(SKIN_CSS_PATH);
  // Mutation: change the body font-family in skin-minimal.css to anything
  // else (e.g. leave it as Inter) → this fails (RED): the founder-requested
  // "font like is used in most modern UIs" swap silently wouldn't apply.
  assert(/html\[data-skin="minimal"\] body\s*\{\s*\n\s*font-family:\s*"Hanken Grotesk"/.test(skinCss),
    "skin-minimal.css sets html[data-skin=\"minimal\"] body { font-family: \"Hanken Grotesk\" … }");

  // The mono stack for code/terminal is explicitly UNCHANGED by this skin —
  // pin that skin-minimal.css never redefines the code/kbd/.mono font-family
  // (only line-height), so JetBrains Mono keeps rendering code/ids/terminal.
  const monoFamilyOverride = /html\[data-skin="minimal"\]\s+(code|kbd|\.mono)[^{]*\{[^}]*font-family/.test(skinCss);
  assert(!monoFamilyOverride,
    "skin-minimal.css does not redefine code/kbd/.mono font-family (mono stack stays JetBrains Mono)");
}

/* ---------------- PART F — size budget ------------------------------------ */
function sizeBudgetTests() {
  console.log("\nPART F — size budget\n");

  const bytes = fs.statSync(SKIN_CSS_PATH).size;
  const kb = bytes / 1024;
  // Mutation: keep pasting per-page selector overrides into this file until
  // it crosses 40KB → this fails (RED), pinning the brief's explicit budget
  // ("≤ 40KB") so the skin stays a token-level override, not per-page
  // selector surgery sprawl.
  assert(bytes <= 40 * 1024,
    "skin-minimal.css is " + kb.toFixed(1) + "KB, at or under the 40KB budget");
  assert(bytes > 0, "skin-minimal.css is non-empty");
}

function run() {
  console.log("skin_minimal_css.test.js\n");
  inclusionTests();
  scopingTests();
  themeVariantTests();
  goldAccentTests();
  fontTests();
  sizeBudgetTests();
  console.log("\n" + (failures === 0 ? "ALL PASSED" : failures + " FAILED"));
  process.exit(failures === 0 ? 0 : 1);
}

run();
