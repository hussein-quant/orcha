/* Home page controller: context, onboarding CTA, attention actions, and agents table. */
const HomO = window.Orcha;
const Hom$ = (id) => document.getElementById(id);
const HomD = () => window.ORCHA;
// P2: tasks acted on THIS session (plan approved/rejected, or verified). Suppress
// their action-queue cards immediately so the 3s repaint can't re-submit before the
// snapshot reflects the decision (mirrors B10's one-shot per-task cache). This set
// ONLY bridges the post-decision → snapshot-catches-up window: renderQueue() prunes
// an id the moment the task leaves the actionable set, so a later reject→rework cycle
// that returns the SAME id to needs_verification is NOT hidden forever (review P2:173).
// To re-decide a plan intentionally, use the full B10 gate on the Tasks page.
const d2Acted = new Set();

/* ---- context strip ---- */
function renderCtx() {
  const c = HomD().container; if (!c) return;
  const openReq = HomO.requests().filter((r) => r.status === "open").length;
  HomO.patch(Hom$("ctxbar"), `
    <div style="display:flex;align-items:center;gap:11px">${HomO.pill(c.status === "active" ? "working" : c.status, "lg")}</div>
    <div class="sep"></div>
    <div style="min-width:0">
      <div class="nm">${HomO.esc(c.name)}</div>
      <div class="desc">${HomO.esc(c.description || "—")}</div>
      ${typeof ghRepoHtml === "function" ? ghRepoHtml(c) : ""}
    </div>
    <div class="grow"></div>
    <div class="stat"><span class="n">${HomO.agents().length}</span><span class="l">Agents</span></div>
    <div class="sep"></div>
    <div class="stat"><span class="n">${HomO.tasks().length}</span><span class="l">Tasks</span></div>
    <div class="sep"></div>
    <div class="stat"><span class="n">${openReq}</span><span class="l">Open req</span></div>
    <div class="sep"></div>
    <div class="stat"><span class="n" style="color:${c.wakes_enabled === false ? "var(--danger)" : "var(--ok)"}">${c.wakes_enabled === false ? "Paused" : "Running"}</span><span class="l">Notifier</span></div>`);
}

/* ---- multi-project: one-time "portal-only" notice on a NEW project ---- */
// Flagged at creation (app-shell.postNewProject → localStorage orcha:projNotice:<cid>)
// and shown until dismissed — but ONLY while no host-side notifier serves this
// container (Orcha.wakesServed reads the daemon's wake-scan stamp, mig 037). Honest by
// construction: if host glue later binds a workspace and the daemon starts polling,
// the notice self-clears even without a dismiss. Never shown for the founding project
// (its flag is never set) or for self-host embedders (fallback wakesServed → true).
function projNoticeKey() {
  const c = HomD().container;
  return c ? "orcha:projNotice:" + c.id : null;
}
function renderProjNotice() {
  const host = Hom$("projNotice"); if (!host) return;
  const c = HomD().container;
  const key = projNoticeKey();
  let flagged = null;
  try { flagged = key && localStorage.getItem(key); } catch (e) {}
  const show = !!(flagged && c && !HomO.wakesServed(c));
  HomO.patch(host, show ? `<div class="proj-notice">
    ${HomO.icon("alert", "")}
    <div class="body">
      <div class="t1">Portal-only for now</div>
      <div class="t2">Agent wakes need a workspace on the host (<code>orcha init</code> binding);
        coming with the fleet provisioner. Agents, tasks and requests all work — nothing wakes agents yet.</div>
    </div>
    <button class="iconbtn" id="projNoticeX" type="button" title="Dismiss">${HomO.icon("x", "")}</button>
  </div>` : "");
  const x = Hom$("projNoticeX");
  if (x) x.onclick = () => {
    try { if (key) localStorage.removeItem(key); } catch (e) {}
    renderProjNotice();
  };
}

/* ---- first-run CTA: surface "Get started" when there are no AI agents yet
   (the human authority is registered, but no AI teammate exists). Links to the
   /onboarding wizard. Hidden the moment an AI agent exists — never breaks the
   populated dashboard. ---- */
function renderOnbCta() {
  const noAi = HomO.agents().filter((a) => a.kind !== "human").length === 0;
  HomO.patch(Hom$("onbCta"), noAi ? `<div class="onb-cta">
    <span class="oic">${HomO.icon("spark", "")}</span>
    <div class="body">
      <div class="t1">Get started — set up your workspace</div>
      <div class="t2">No AI agents yet. Create your first agent (or capture tasks) in the guided first-run flow.</div>
    </div>
    <a class="btn" href="/onboarding">${HomO.icon("arrow", "")}Get started</a>
  </div>` : "");
}

/* ---- action queue (THE hero): plans to approve + tasks to verify + escalations ---- */
function planText(t) {  // ISS-68: thread-free via plan_message; thread fallback if expanded
  if (t.plan_message) return t.plan_message.body || "";
  const m = (t.thread || []).filter((x) => !x.is_human);
  return m.length ? m[0].body : "";
}
function planAuthor(t) {
  if (t.plan_message) return t.plan_message.author_alias || (t.assignees || [])[0];
  const m = (t.thread || []).filter((x) => !x.is_human);
  return m.length ? (m[0].from || (t.assignees || [])[0]) : (t.assignees || [])[0];
}
function renderQueue() {
  const aq = HomO.attnItems();
  // Prune suppression: drop any acted id the snapshot no longer shows as actionable
  // (its decision/status has landed). Keeps the suppression scoped to the stale window,
  // never permanent — so a reworked task returning to the queue reappears (review P2:173).
  const actionable = new Set([...aq.plans, ...aq.verifs].map((t) => t.id));
  for (const id of [...d2Acted]) if (!actionable.has(id)) d2Acted.delete(id);
  const plans = aq.plans.filter((t) => !d2Acted.has(t.id));
  const verifs = aq.verifs.filter((t) => !d2Acted.has(t.id));
  Hom$("aqBadge").textContent = plans.length + verifs.length + aq.escs.length;
  const cards = [];
  plans.forEach((t) => {
    const who = planAuthor(t), a = HomO.agentByAlias(who) || {};
    // P1: show the FULL plan body in the scrollable .ctx — a human must review the
    // whole proposal before approving (B10 invariant), not a 600-char summary.
    cards.push(`<div class="aq plan">
      <span class="type">${HomO.icon("shield", "")}Plan approval</span>
      <div class="ttl">${HomO.esc(t.title)}</div>
      <div class="who">${HomO.agentLink(who)}<span>·</span><span class="tag model">${HomO.esc(a.model || "—")}</span></div>
      <div class="ctx"><span class="lbl">Proposed plan — full text</span>${HomO.linkify(planText(t))}</div>
      <div class="acts" data-kind="plan" data-task="${HomO.esc(t.id)}" data-author="${HomO.esc((HomO.agentByAlias(who) || {}).id || "")}">
        <button class="btn sm approve" data-act="approve" ${actDisabledAttr()}>${HomO.icon("shield", "")}Approve plan</button>
        <button class="btn sm danger" data-act="reject" ${actDisabledAttr()}>Reject…</button>
        <a class="btn sm ghost" href="/tasks?task=${encodeURIComponent(t.id)}">Open task</a>
      </div></div>`);
  });
  verifs.forEach((t) => {
    const who = (t.assignees || [])[0], a = HomO.agentByAlias(who) || {};
    // Collab v1: a task with an owner-assigned reviewer is SOMEONE's review. The
    // assigned reviewer (or any owner, or anyone when no identity resolved — trust
    // off) sees the card normally; everyone else gets it de-emphasized + labeled.
    // Frontend-only: the backend verify gate stays permissive (any human CAN verify).
    const ident = HomD().identity || null;
    const theirs = !!(t.reviewer && ident
      && String(ident.agent_id) !== String(t.reviewer.agent_id)
      && ident.member_role !== "owner");
    const revTag = theirs
      ? `<span class="tag review-for">review: ${HomO.esc(t.reviewer.github_login || t.reviewer.alias)}</span>` : "";
    cards.push(`<div class="aq verify${theirs ? " other-review" : ""}">
      <span class="type">${HomO.icon("check", "")}Verify task${revTag}</span>
      <div class="ttl">${HomO.esc(t.title)}</div>
      <div class="who">${who ? HomO.agentLink(who) : "—"}<span>·</span><span class="tag model">${HomO.esc(a.model || "—")}</span><span>·</span><span>${HomO.relTime(t.started_at)}</span></div>
      <div class="ctx"><span class="lbl">Definition of done</span>${HomO.esc(t.definition_of_done || "—")}</div>
      <div class="acts" data-kind="verify" data-task="${HomO.esc(t.id)}">
        <button class="btn sm approve" data-act="approve" ${actDisabledAttr()}>${HomO.icon("check", "")}Accept</button>
        <button class="btn sm danger" data-act="reject" ${actDisabledAttr()}>Reject…</button>
        <a class="btn sm ghost" href="/tasks?task=${encodeURIComponent(t.id)}">Open task</a>
      </div></div>`);
  });
  aq.escs.forEach((r) => {
    cards.push(`<div class="aq esc">
      <span class="type">${HomO.icon("flag", "")}Escalation</span>
      <div class="ttl">${HomO.esc(HomO.trunc(r.payload || "", 96))}</div>
      <div class="who">${HomO.agentLink(r.from)}<span>${HomO.icon("arrow", "")}</span><span>you</span><span>·</span><span>${HomO.relTime(r.created_at)}</span></div>
      <div class="ctx"><span class="lbl">Blocks</span>${r.task_link ? HomO.esc(r.task_link.title || "—") : "—"}</div>
      <div class="acts">
        <a class="btn sm" href="/requests?req=${encodeURIComponent(r.id)}">${HomO.icon("arrow", "")}Resolve</a>
        <a class="btn sm ghost" href="/requests?req=${encodeURIComponent(r.id)}">Open request</a>
      </div></div>`);
  });
  HomO.patch(Hom$("aqGrid"), cards.length ? cards.join("") : '<div class="aq-empty">✓ Nothing needs you right now.</div>');
}

// inline approve/reject (delegated — survives the 3s patch). Reuses the B0 decision
// contract for plans and the verify endpoint for tasks; both require the acting human.
async function postJSON(url, body) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  let j = null; try { j = await r.json(); } catch (e) {}
  return { ok: r.ok, status: r.status, body: j };
}
// Per-project identity: no possible actor -> the queue's buttons render disabled.
// For a trusted non-member the tooltip says exactly why (never a silent no-op,
// never an action attributed to someone else's identity).
function actDisabledAttr() {
  if (HomO.actingHuman()) return "";
  return HomO.viewerOnly && HomO.viewerOnly()
    ? 'disabled title="Not a member of this project"'
    : 'disabled title="No acting human"';
}
function actorOrWarn() {
  const h = HomO.actingHuman();
  if (!h) {
    HomO.toast(HomO.viewerOnly && HomO.viewerOnly()
      ? "You're not a member of this project — ask an owner for an invite."
      : "Pick who you are (top-right) first.", "danger");
    return null;
  }
  return h;
}
function doPlan(taskId, authorId, approve) {
  const h = actorOrWarn(); if (!h) return;
  const send = (reason) => postJSON("/api/decisions", {
    subject_type: "plan_approval", subject_id: taskId, decision: approve ? "approve" : "reject",
    reason: reason || undefined, actor_agent_id: h.id, target_agent_id: authorId || undefined,
  }).then((res) => {
    HomO.toast(res.ok ? (approve ? "Plan approved — routed to the agent." : "Plan rejected — reason sent.")
                   : "Failed (" + res.status + ")", res.ok ? "ok" : "danger");
    if (res.ok) { d2Acted.add(taskId); renderQueue(); }   // P2: suppress this card now
  });
  if (approve) {
    // ISS-59: approving may carry an OPTIONAL answer/guidance that reaches the agent — the
    // decision `reason` is routed to its next wake + posted to the task thread (ISS-48).
    HomO.modal({ title: "Approve plan", desc: "Optionally answer the agent's questions or add guidance — it's sent to the agent with the approval.", primary: "Approve plan", approve: true,
      body: '<textarea id="ans" class="ta" placeholder="Answer / additional info for the agent (optional)"></textarea>',
      onPrimary: () => { const v = (document.getElementById("ans") || {}).value || ""; send(v).then(HomO.closeModal); } });
    return;
  }
  HomO.modal({ title: "Reject plan", desc: "Your reason routes to the agent.", primary: "Confirm reject", danger: true,
    body: '<textarea id="rzn" class="ta" placeholder="Why are you rejecting? (required)"></textarea>',
    onPrimary: () => { const v = (document.getElementById("rzn") || {}).value || "";
      if (!v.trim()) { HomO.toast("A reason is required to reject.", "danger"); return; }
      send(v).then(HomO.closeModal); } });
}
function doVerify(taskId, approve) {
  const h = actorOrWarn(); if (!h) return;
  const send = (feedback) => postJSON("/api/tasks/" + encodeURIComponent(taskId) + "/verify", {
    approve, actor_agent_id: h.id, feedback: approve ? undefined : (feedback || ""),
  }).then((res) => {
    HomO.toast(res.ok ? (approve ? "Accepted — task completed." : "Rejected — sent back with feedback.")
                   : "Failed (" + res.status + ")", res.ok ? "ok" : "danger");
    if (res.ok) { d2Acted.add(taskId); renderQueue(); }   // P2: suppress this card now
  });
  if (approve) return send();
  HomO.modal({ title: "Reject task", desc: "Feedback is posted to the task and pushed to the agent.", primary: "Confirm reject", danger: true,
    body: '<textarea id="rzn" class="ta" placeholder="What needs fixing? (required)"></textarea>',
    onPrimary: () => { const v = (document.getElementById("rzn") || {}).value || "";
      if (!v.trim()) { HomO.toast("A reason is required to reject.", "danger"); return; }
      send(v).then(HomO.closeModal); } });
}
Hom$("aqGrid").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-act]"); if (!b) return;
  const acts = b.closest(".acts"); if (!acts) return;
  const approve = b.getAttribute("data-act") === "approve";
  if (acts.getAttribute("data-kind") === "plan") doPlan(acts.getAttribute("data-task"), acts.getAttribute("data-author"), approve);
  else doVerify(acts.getAttribute("data-task"), approve);
});

/* ---- agents at a glance ---- */
// #340: friendly, plain-language label for a live worker run that carries no 'working'
// task row (conversation turn / inbox drain). Keyed on wake_event; humanizes any
// unmapped event so a new wake reason still reads as words, not a raw enum.
const RUN_LABELS = {
  conversation_turn: "In conversation", request_answered: "Handling a reply",
  request_created: "Handling a request", request_closed: "Wrapping up a request",
  task_message: "On a task thread", checkpoint_respawn: "Checking in",
  auto_wake: "Auto-wake check", task_request_accepted: "Picked up a task",
  task_verified: "Verifying a task", live_terminal: "Live terminal",
  task_assigned: "Starting a task", decision_made: "Acting on a decision", prompt: "Working",
};
