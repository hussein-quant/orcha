/* ============================================================================
   Web-chat send UX (fix/web-chat-send-ux) — the field bug: ONE user send painted
   TWO identical "you · just now" bubbles with the agent stuck on "thinking…".

   Two dup vectors, both pinned here against the REAL conversation bundle:
     #1 send() had no in-flight guard and only cleared the composer after the
        POST resolved — a second Enter / "did it go through?" click while the
        portal was slow re-POSTed the same text (two REAL turns server-side).
     #2 the 3s interval poll and the manual post-send poll() could overlap on
        the SAME after_seq cursor; both responses concat'd the same fresh turns
        (one turn painted twice client-side).

   PART A  dup-guard — a second click + Enter during flight is a no-op (1 POST);
           the Send button is down with a spinner; the composer clears
           optimistically and a pending "sending…" bubble paints.
   PART B  reconcile + overlap dedupe — the POSTed turn lands once (by id);
           an overlapped same-cursor poll replaying the turn cannot dup it,
           and a second poll() while one is in flight is skipped.
   PART C  failure → Retry — POST failure restores the composer, paints an
           inline danger note with Retry, never auto-reposts; Retry re-submits
           exactly once through the same guarded path.
   PART D  response-lost reconcile — the POST failed client-side but the turn
           DID land: the poll's identical author+content match (pending window)
           clears the failed bubble + restored text instead of inviting a dup.
   PART E  wakes-not-served — a portal-only project (no host workspace, so no
           notifier serves wakes) shows the persistent chat banner and a queued
           notice after sends — never fake thinking dots. Cold-start honesty:
           the first-ever reply says "starting the agent's session…".

   Dependency-free (mirrors project_switcher.test.js): the real portal modules
   in a vm sandbox over a tiny fake DOM.

   Run: node tests/portal/conversation_send.test.js
   ========================================================================== */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const STATIC = path.join(
  __dirname, "..", "..",
  "orcha-cli", "orcha_cli", "templates", "portal", "static"
);
const read = (...p) => fs.readFileSync(path.join(STATIC, ...p), "utf8");
const CONV_FILES = [
  ["modules", "conversation-state.js"],
  ["modules", "conversation-terminal-open.js"],
  ["modules", "conversation-terminal-state.js"],
  ["modules", "conversation-render.js"],
  ["modules", "conversation-composer.js"],
  ["modules", "conversation-lifecycle.js"],
  ["conversation.js"],
];

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log("  ✓ " + msg);
  else { failures++; console.error("  ✗ " + msg); }
}
const flush = () => new Promise((r) => setImmediate(r));
async function drain() { for (let i = 0; i < 15; i++) await flush(); }
const count = (hay, needle) => String(hay).split(needle).length - 1;

/* ---- tiny fake DOM ----------------------------------------------------- */
function mkEl(id) {
  const handlers = {};
  const el = {
    id: id || "", _html: "", className: "", style: {}, hidden: false, value: "",
    disabled: false, files: null, scrollHeight: 0, scrollTop: 0, clientHeight: 0, dataset: {},
    set innerHTML(v) { el._html = v == null ? "" : String(v); },
    get innerHTML() { return el._html; },
    addEventListener(ev, fn) { (handlers[ev] = handlers[ev] || []).push(fn); },
    removeEventListener() {},
    fire(ev, arg) { (handlers[ev] || []).slice().forEach((fn) => fn(arg || { preventDefault() {}, target: el })); },
    querySelectorAll() { return []; },
    querySelector() { return null; },
    focus() {}, scrollIntoView() {}, click() { el.fire("click"); },
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    getAttribute(k) { return el["_a_" + k] || null; }, setAttribute(k, v) { el["_a_" + k] = v; },
    appendChild() {}, removeChild() {},
  };
  return el;
}

/* ---- controllable network ---------------------------------------------- */
// net.postMode: "ok" (resolve with net.turnFor), "reject" (network error), "hold"
const net = {
  postMode: "ok", posts: [], heldPosts: [],
  turnGets: 0, holdPoll: false, heldPolls: [], pollTurns: [],
  nextSeq: 1,
  turnFor(body) {
    const b = JSON.parse(body);
    return { id: "srv-" + net.nextSeq, seq: net.nextSeq++, role: b.role,
             author_agent_id: b.author_agent_id, content: b.content,
             attachments: b.attachments || [], created_at: "2026-07-31T00:00:00Z", run_id: null, meta: {} };
  },
};
function fakeFetch(url, init) {
  const u = String(url);
  const method = (init && init.method) || "GET";
  if (u.indexOf("/conversation?limit=") >= 0) {
    const aid = u.match(/\/api\/agents\/([^/]+)\//)[1];
    return Promise.resolve({ ok: true, json: () => Promise.resolve(
      { conversation: { id: "c-" + aid }, turns: [] }) });
  }
  if (/\/api\/agents\/[^/]+\/conversations$/.test(u) && method === "POST") {
    const aid = u.match(/\/api\/agents\/([^/]+)\//)[1];
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ conversation: { id: "c-" + aid } }) });
  }
  if (/\/turns$/.test(u) && method === "POST") {
    net.posts.push({ url: u, body: init.body });
    if (net.postMode === "reject") return Promise.reject(new Error("network down"));
    if (net.postMode === "hold") return new Promise((res) => net.heldPosts.push(
      () => res({ ok: true, json: () => Promise.resolve({ turn: net.turnFor(init.body) }) })));
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ turn: net.turnFor(init.body) }) });
  }
  if (u.indexOf("/turns?after_seq=") >= 0) {
    net.turnGets++;
    if (net.holdPoll) {
      return new Promise((res) => net.heldPolls.push(
        (turns) => res({ ok: true, json: () => Promise.resolve({ turns: turns || [] }) })));
    }
    const t = net.pollTurns; net.pollTurns = [];
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ turns: t }) });
  }
  // refreshPresence GET /api/conversations/{cid} — presence contract not live
  return Promise.resolve({ ok: true, json: () => Promise.resolve({ presence: null }) });
}

/* ---- sandbox ------------------------------------------------------------ */
const els = {};
["convInput", "convSend", "convList", "convPresence", "convSlash", "convAttach",
 "convAttachInput", "convTray", "convPair", "convMax", "convLock", "convPairWrap",
 "convTermSlot", "convWakes"].forEach((id) => { els[id] = mkEl(id); });
const state = { retryBtn: null };
// renderList wires Retry via list.querySelector("[data-retrysend]") — surface it
els.convList.querySelector = (sel) => {
  if (sel === "[data-retrysend]" && els.convList._html.indexOf("data-retrysend") >= 0) {
    state.retryBtn = mkEl("retry");
    return state.retryBtn;
  }
  return null;
};
const WAKES = { on: true };
const orchaStub = {
  esc: (s) => String(s == null ? "" : s), linkify: (s) => String(s == null ? "" : s),
  mdText: (s) => String(s == null ? "" : s), icon: (n) => "<svg data-ic=\"" + n + "\"></svg>",
  avatar: (n) => "<av>" + n + "</av>", relTime: () => "just now", toast: () => {},
  actingHuman: () => ({ id: "h" }), leaseOf: () => "idle",
  startRunStream: () => (() => {}),
  agentById: (id) => id === "h" ? { id: "h", alias: "kedar", kind: "human" }
                                : { id, alias: "Frame", kind: "ai", status: "idle" },
  wakesServed: () => WAKES.on,
  D: { container: { id: "proj-1" } },
};
function makeSandbox() {
  const documentObj = {
    getElementById: (id) => els[id] || null,
    createElement: () => mkEl(),
    addEventListener() {}, removeEventListener() {},
    documentElement: { setAttribute() {} }, body: { appendChild() {} },
  };
  const sandbox = {
    window: { Orcha: orchaStub }, document: documentObj, console,
    fetch: fakeFetch,
    setInterval: () => 1, clearInterval() {},
    setTimeout: (fn) => { if (fn) fn(); return 0; }, clearTimeout() {},
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  CONV_FILES.forEach((p) => vm.runInContext(read(...p), sandbox, { filename: p.join("/") }));
  return sandbox;
}
const sb = makeSandbox();
const run = (code) => vm.runInContext(code, sb);
const mountHost = mkEl("host");
mountHost.querySelector = () => null;

/* ---------------- PART A — dup-guard + optimistic pending ---------------- */
async function partA() {
  console.log("\nPART A — dup-guard: one user action, ONE turn\n");
  run('window.OrchaConvo.mount(__host, "a1")');
  await drain();
  net.postMode = "hold"; net.posts = [];
  els.convInput.value = "hello agent";
  els.convSend.fire("click");
  await flush();
  // second click + Enter (and a held-key repeat would be more of the same) during flight
  els.convSend.fire("click");
  els.convInput.fire("keydown", { key: "Enter", shiftKey: false, preventDefault() {}, target: els.convInput });
  els.convInput.fire("keydown", { key: "Enter", shiftKey: false, preventDefault() {}, target: els.convInput });
  await drain();
  assert(net.posts.length === 1, "a second submit during flight is a NO-OP (exactly one POST /turns)");
  // even NEW text + Enter during flight is ignored (the optimistic clear alone wouldn't stop
  // this one — it needs the `sending` guard; the typed text stays put, nothing is lost)
  els.convInput.value = "typed during flight";
  els.convInput.fire("keydown", { key: "Enter", shiftKey: false, preventDefault() {}, target: els.convInput });
  await drain();
  assert(net.posts.length === 1, "Enter with new text during flight is ignored (in-flight guard, not just the cleared input)");
  assert(els.convInput.value === "typed during flight", "…and the typed text is untouched");
  els.convInput.value = "";
  assert(run("sending") === true, "the in-flight guard is up");
  assert(els.convSend.disabled === true, "the Send button is disabled while the POST is in flight");
  assert(els.convSend._html.indexOf("spin") >= 0, "…and shows a spinner");
  assert(els.convInput.value === "", "the composer cleared optimistically");
  assert(els.convList._html.indexOf("sending…") >= 0 && count(els.convList._html, "hello agent") === 1,
    "a single pending bubble paints with the 'sending…' state");
  assert(els.convList._html.indexOf("conv-thinking") < 0, "no reply indicator while the send is unsettled");
  // the POST settles → reconcile by returned turn id
  net.heldPosts.splice(0).forEach((release) => release());
  await drain();
  assert(net.posts.length === 1, "settling did not re-POST");
  assert(run("sending") === false && els.convSend.disabled === false, "the guard + button release on success");
  assert(run("turns.length") === 1 && run("pendingLocal") === null,
    "the optimistic bubble reconciled into the ONE durable turn (by returned id)");
  assert(count(els.convList._html, "hello agent") === 1, "the message renders exactly once");
  assert(els.convList._html.indexOf("conv-thinking") >= 0, "the awaiting-reply indicator is up after success");
  assert(els.convList._html.indexOf("starting the agent’s session") >= 0
      && els.convList._html.indexOf("starting…") >= 0,
    "cold start (no agent turn yet) says 'starting the agent's session…', not bare thinking dots");
}

/* ---------------- PART B — poll overlap cannot duplicate ------------------ */
async function partB() {
  console.log("\nPART B — overlapped same-cursor polls cannot dup a turn\n");
  const gets = net.turnGets;
  net.holdPoll = true;
  run("poll()");
  run("poll()");   // the 3s tick firing while the first fetch is still in flight
  await flush();
  assert(net.turnGets === gets + 1, "a second poll() while one is in flight is skipped (no same-cursor stacking)");
  // a stale response replaying the ALREADY-LANDED turn (same id/seq) must be dropped
  const dup = { id: "srv-1", seq: 1, role: "human", author_agent_id: "h",
                content: "hello agent", attachments: [], created_at: "2026-07-31T00:00:00Z", run_id: null, meta: {} };
  net.heldPolls.splice(0).forEach((release) => release([dup]));
  net.holdPoll = false;
  await drain();
  assert(run("turns.length") === 1, "the replayed turn was deduped by id/seq (turns still 1)");
  assert(count(els.convList._html, "hello agent") === 1, "…and the bubble still paints exactly once");
  // a genuinely NEW turn still lands through the same filter
  net.pollTurns = [{ id: "srv-agent-1", seq: 2, role: "agent", author_agent_id: "a1",
                     content: "hi kedar", attachments: [], created_at: "2026-07-31T00:00:01Z", run_id: null, meta: {} }];
  run("poll()");
  await drain();
  assert(run("turns.length") === 2 && count(els.convList._html, "hi kedar") === 1,
    "a genuinely new (agent) turn still appends once");
  assert(els.convList._html.indexOf("conv-thinking") < 0, "the reply landed → indicator cleared");
}

/* ---------------- PART C — failure → restore + Retry ---------------------- */
async function partC() {
  console.log("\nPART C — POST failure: composer restored, inline Retry, no auto-dup\n");
  run('window.OrchaConvo.mount(__host, "a2")');
  await drain();
  net.postMode = "reject"; net.posts = [];
  els.convInput.value = "retry me";
  els.convSend.fire("click");
  await drain();
  assert(net.posts.length === 1, "the failed send POSTed once (and did NOT auto-retry)");
  assert(run("sending") === false && els.convSend.disabled === false, "the guard releases on failure");
  assert(els.convInput.value === "retry me", "the composer text was RESTORED — nothing silently lost");
  assert(els.convList._html.indexOf("conv-sendfail") >= 0 && els.convList._html.indexOf("data-retrysend") >= 0,
    "an inline danger note with Retry paints on the failed bubble");
  assert(els.convList._html.indexOf("not sent") >= 0, "the failed bubble is labeled 'not sent'");
  // Retry re-submits exactly the failed content through the same guarded path
  net.postMode = "ok";
  state.retryBtn.fire("click");
  await drain();
  assert(net.posts.length === 2, "Retry re-POSTed exactly once");
  assert(els.convInput.value === "", "Retry took the restored text back out of the composer");
  assert(run("pendingLocal") === null && count(els.convList._html, "retry me") === 1,
    "the retried turn reconciled into ONE bubble");
  assert(els.convList._html.indexOf("conv-sendfail") < 0, "the failure note cleared");
}

/* ---------------- PART D — POST response lost, poll reconciles ------------ */
async function partD() {
  console.log("\nPART D — POST landed but its response was lost: the poll reconciles, no dup\n");
  run('window.OrchaConvo.mount(__host, "a3")');
  await drain();
  net.postMode = "reject"; net.posts = [];
  els.convInput.value = "ghost turn";
  els.convSend.fire("click");
  await drain();
  assert(els.convList._html.indexOf("conv-sendfail") >= 0 && els.convInput.value === "ghost turn",
    "the send looks failed client-side (note + restored composer)");
  // …but the server DID persist it — the poll returns the identical author+content turn
  net.pollTurns = [{ id: "durable-1", seq: 1, role: "human", author_agent_id: "h",
                     content: "ghost turn", attachments: [], created_at: "2026-07-31T00:00:02Z", run_id: null, meta: {} }];
  run("poll()");
  await drain();
  assert(run("pendingLocal") === null, "identical author+content within the pending window reconciled the failed bubble");
  assert(count(els.convList._html, "ghost turn") === 1 && els.convList._html.indexOf("conv-sendfail") < 0,
    "ONE durable bubble remains — no failure note");
  assert(els.convInput.value === "", "the failure-restored composer text was taken back (a habit-Retry can't dup it)");
  assert(net.posts.length === 1, "no extra POST was ever issued");
}

/* ---------------- PART E — wakes-not-served banner + honest queued -------- */
async function partE() {
  console.log("\nPART E — portal-only project: banner + queued notice, never fake dots\n");
  WAKES.on = false;
  run('window.OrchaConvo.mount(__host, "a4")');
  await drain();
  assert(els.convWakes._html.indexOf("conv-wakes") >= 0
      && els.convWakes._html.indexOf("no agent runtime yet") >= 0
      && els.convWakes._html.indexOf("workspace binds on the host") >= 0,
    "the persistent warn banner is up in the chat (same signal as the dashboard notice)");
  net.postMode = "ok"; net.posts = [];
  els.convInput.value = "anyone home?";
  els.convSend.fire("click");
  await drain();
  assert(els.convList._html.indexOf("conv-queued") >= 0
      && els.convList._html.indexOf("no agent runtime yet") >= 0,
    "after a send the indicator is the honest QUEUED notice with the no-runtime copy");
  assert(els.convList._html.indexOf("conv-thinking") < 0,
    "the typing indicator is NOT shown when nothing serves wakes");
  // host glue binds a workspace later → the daemon polls → the banner self-clears
  WAKES.on = true;
  run("renderPresence()");
  assert(els.convWakes._html === "", "the banner self-clears once wakes are served");
  run("renderList()");
  assert(els.convList._html.indexOf("conv-queued") < 0 || els.convList._html.indexOf("no agent runtime yet") < 0,
    "…and the no-runtime queued copy stops rendering");
}

(async () => {
  sb.__host = mountHost;
  await partA();
  await partB();
  await partC();
  await partD();
  await partE();
  console.log("");
  if (failures) { console.error(failures + " FAILURE(S)"); process.exit(1); }
  console.log("ALL PASS");
})().catch((e) => { console.error("HARNESS ERROR", (e && e.stack) || e); process.exit(2); });
