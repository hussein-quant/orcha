/* ============================================================================
   open-orcha#209 — task results render as "[object Object]" when structured.

   tasks.result is JSONB and /done accepts any JSON for `result`, but the task
   detail page (Result field + the verification-gate "Result claimed by" block)
   string-interpolated it. An agent posting {"result": "PR #203 opened…"} showed
   the verifying human "[object Object]" on the exact surface used to decide
   verify/reject. Fix under test: resultText() in pages/tasks-detail.js
   normalizes every shape to text at BOTH render sites.

   Dependency-free: loads the REAL tasks-detail.js source, extracts resultText
   via a vm sandbox, and greps both render sites for the wrapper. No npm.

   Run:  node tests/portal/task_result_render.test.js
   ========================================================================== */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const PORTAL = path.join(__dirname, "..", "..", "orcha-cli", "orcha_cli",
  "templates", "portal", "static");
const SRC = fs.readFileSync(path.join(PORTAL, "pages", "tasks-detail.js"), "utf8");

let failures = 0;
function assert(cond, msg) {
  if (cond) { console.log("  ✓ " + msg); }
  else { failures++; console.error("  ✗ " + msg); }
}

/* ---- extract the real resultText() ---- */
const m = SRC.match(/function resultText\([\s\S]*?\n\}/);
assert(!!m, "resultText() exists in tasks-detail.js (mutation: delete it → RED)");
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(m[0] + "; this.resultText = resultText;", sandbox);
const resultText = sandbox.resultText;

/* ---- shape matrix ---- */
assert(resultText("PR opened: https://x") === "PR opened: https://x",
  "string passes through untouched");
assert(resultText(null) === "" && resultText(undefined) === "",
  "null/undefined → empty (caller supplies the em-dash)");
assert(resultText({ result: "PR #203 opened" }) === "PR #203 opened",
  'field shape {"result": "..."} yields the inner text (the field-observed bug shape)');
assert(resultText({ summary: "did the thing" }) === "did the thing",
  "summary field honored");
assert(resultText({ result: "  " , text: "fallback wins" }) === "fallback wins",
  "blank conventional field skipped in favor of the next non-empty one");
const pretty = resultText({ pr: 203, files: ["a.md", "b.md"] });
assert(pretty.includes('"pr": 203') && pretty.includes('"a.md"'),
  "arbitrary object → pretty-printed JSON, keys and values readable");
assert(!String(resultText({})).includes("[object Object]") &&
       !String(resultText({ nested: { x: 1 } })).includes("[object Object]"),
  "no shape ever coerces to [object Object] (mutation: revert either render "
  + "site to raw t.result → the site-grep below goes RED)");
assert(resultText(42) === "42", "non-object primitives stringified");

/* ---- both render sites go through the wrapper ---- */
const resultField = SRC.match(/class="lbl">Result<\/div>[\s\S]{0,120}/);
assert(resultField && /resultText\(t\.result\)/.test(resultField[0]),
  "Result field renders resultText(t.result), not raw t.result");
const gate = SRC.match(/max-height:300px;overflow-y:auto[\s\S]{0,160}/);
assert(gate && /resultText\(t\.result\)/.test(gate[0]),
  "verification-gate claimed-result block renders resultText(t.result)");
assert(!/linkify\(t\.result\)/.test(SRC) && !/linkify\(isPlan[^)]*t\.result \|\| "—"/.test(SRC),
  "no render site passes t.result to linkify unwrapped");

process.exit(failures ? 1 : 0);
