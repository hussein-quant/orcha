/* Home page controller: activity feed, kanban, refresh loop, and boot wiring. */
function runLabel(ar) {
  if (!ar) return null;
  if (ar.has_conversation) return RUN_LABELS.conversation_turn;
  return RUN_LABELS[ar.wake_event] || (ar.wake_event ? ar.wake_event.replace(/_/g, " ") : "Working");
}
// #340 (scope sharpened, Kedar live-test): the Activity label is DRIVEN by the agent's LIVE
// worker run, NOT the persistent task-claim. current_task is an agent_tasks 'working' row
// cleared only on /orcha-done, so it diverges from live reality (a stale claim would show its
// task while the agent is actually answering a request / running a checkpoint, and a task-less
// conversation/drain run would show blank). So: a live run wins — its worked task's title when
// it IS a task, else a plain-language wake-event label; fall back to the persistent assigned
// task ONLY when no run is live; else em-dash. Returns {text, isTask} | null.
function activity(a) {
  const ar = a.active_run;
  if (ar) {
    if (ar.task_id) {
      const title = ar.task_title || (a.current_task && a.current_task.title) || "On a task";
      return { text: HomO.trunc(title, 32), isTask: true };
    }
    return { text: runLabel(ar), isTask: false };
  }
  const ct = a.current_task;
  if (ct && ct.task_id) return { text: HomO.trunc(ct.title || "", 32), isTask: true };
  return null;
}
function renderAgents() {
  const ags = HomO.agents();
  Hom$("agCount").textContent = `(${ags.length})`;
  HomO.patch(Hom$("agTbl"), `<thead><tr>
    <th>Agent</th><th>Status</th><th>Activity</th><th>Model</th><th>Wake</th><th>Active</th></tr></thead>
    <tbody>${ags.map((a) => {
      const act = activity(a);
      return `<tr class="clickable" onclick="location.href='/agents?agent=${encodeURIComponent(a.alias)}'">
        <td><div class="row">${HomO.face(a)}<div><div class="t1">${HomO.esc(a.alias)}</div><div class="t2">${HomO.esc(a.role || "—")}</div></div></div></td>
        <td>${HomO.pill(a.status)}</td>
        <td>${act ? (act.isTask
                ? `<span class="t1" style="font-weight:550;font-size:12.5px">${HomO.esc(act.text)}</span>`
                : `<span class="t2" style="font-style:italic">${HomO.esc(act.text)}</span>`)
              : '<span class="t2">—</span>'}</td>
        <td>${a.model ? `<span class="tag model">${HomO.esc(a.model)}</span>` : '<span class="t2">—</span>'}</td>
        <td>${a.kind === "human" ? '<span class="t2">—</span>' : (a.wake_enabled ? '<span class="tag wake-on">on</span>' : '<span class="tag wake-off">off</span>')}</td>
        <td class="t2 num">${HomO.relTime(a.last_active)}</td>
      </tr>`;
    }).join("")}</tbody>`);
}

/* ---- live activity (snapshot-derived: recent thread posts + request responses).
   /api/containers/{cid}/events is an SSE of escalations only, not a feed — so we
   synthesize from the data we already poll, friendly timestamps, newest first. ---- */
const TYC = { post: "var(--text)", decision: "var(--amber)", request: "var(--info)", answer: "var(--ok)" };
const TYBG = { post: "var(--surface-2)", decision: "var(--warn-soft)", request: "var(--info-soft)", answer: "var(--ok-soft)" };
function activityEvents() {
  const out = [];
  // ISS-68: the snapshot no longer ships full threads — synthesize task activity from each
  // task's message_summary.last (the most recent post per task), which is all a top-14
  // newest-first feed needs anyway. Falls back to an expanded thread if one is present.
  HomO.tasks().forEach((t) => {
    const thread = t.thread || [];
    if (thread.length) {
      thread.forEach((m) => out.push({
        who: m.is_human ? "human" : (m.from || "—"), kind: m.is_human ? "decision" : "post",
        text: HomO.trunc(m.body || "", 120), at: m.at, link: "/tasks?task=" + encodeURIComponent(t.id),
      }));
      return;
    }
    const last = t.message_summary && t.message_summary.last;
    if (last) out.push({
      who: last.is_human ? "human" : (last.author_alias || "—"), kind: last.is_human ? "decision" : "post",
      text: HomO.trunc(last.body || "", 120), at: last.created_at, link: "/tasks?task=" + encodeURIComponent(t.id),
    });
  });
  HomO.requests().forEach((r) => {
    out.push({ who: r.from, kind: "request", text: HomO.trunc(r.payload || "", 110), at: r.created_at, link: "/requests?req=" + encodeURIComponent(r.id) });
    if (r.responded_at) out.push({ who: r.to, kind: "answer", text: HomO.trunc(r.response || "", 110), at: r.responded_at, link: "/requests?req=" + encodeURIComponent(r.id) });
  });
  return out.filter((e) => e.at).sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, 14);
}
function renderActivity() {
  const evs = activityEvents();
  HomO.patch(Hom$("actList"), evs.length ? evs.map((e) => {
    // e.who is the roster alias when resolvable (task poster / request from-to), letting
    // the real member record (incl. github_login) drive the face; the "human" sentinel
    // (an anonymous is_human thread post — no specific member alias) has no such record
    // and correctly falls back to the plain letter avatar via face()'s own kind/login guard.
    const a = HomO.agentByAlias(e.who);
    return `<a class="act" href="${e.link}" style="color:inherit">
      ${HomO.face(a || { alias: e.who, kind: "human" }, "sm")}
      <div class="body">
        <div class="top"><span class="nm">${HomO.esc(e.who)}</span>
          <span class="ty" style="color:${TYC[e.kind]};background:${TYBG[e.kind]}">${HomO.esc(e.kind)}</span>
          <span class="when">${HomO.relTime(e.at)}</span></div>
        <div class="txt">${HomO.esc(e.text)}</div>
      </div></a>`;
  }).join("") : '<div class="none" style="padding:14px;font-size:12.5px">No activity yet.</div>');
}

/* ---- tasks by status kanban ---- */
const COLS = [
  { key: "needs", label: "Needs verify", cls: "s-attn", match: (t) => t.status === "needs_verification" },
  { key: "work", label: "In progress", cls: "s-working", match: (t) => t.status === "in_progress" },
  { key: "ready", label: "Ready", cls: "s-ready", match: (t) => t.status === "ready" || t.status === "pending" },
  { key: "blocked", label: "Blocked", cls: "s-bad", match: (t) => t.status === "blocked" || t.status === "failed" },
  { key: "done", label: "Done", cls: "s-done", match: (t) => t.status === "completed" || t.status === "cancelled" },
];
function renderKanban() {
  HomO.patch(Hom$("kanban"), COLS.map((col) => {
    const items = HomO.tasks().filter(col.match).filter((t) => !t.is_root);
    return `<div class="kcol">
      <div class="kh"><span class="pill ${col.cls}" style="border:0;background:transparent;padding:0;gap:7px">${HomO.glyph(col.cls)}<span style="font-size:12.5px;font-weight:650;color:var(--text)">${col.label}</span></span><span class="ct">${items.length}</span></div>
      <div class="kb">${items.length ? items.map((t) => {
        const who = (t.assignees || [])[0], a = HomO.agentByAlias(who);
        return `<div class="kcard" onclick="location.href='/tasks?task=${encodeURIComponent(t.id)}'">
          <div class="kt">${HomO.esc(t.title)}</div>
          <div class="kf">${who ? HomO.avatar(who, a ? a.kind : "ai", "sm") : ""}<span class="t2" style="font-size:11.5px">${HomO.esc(who || "unassigned")}</span>
            <span class="prio ${t.priority <= 20 ? "p-hi" : t.priority <= 40 ? "p-md" : ""}">P${HomO.esc(t.priority)}</span></div>
        </div>`;
      }).join("") : '<div class="none" style="padding:14px;font-size:12px">None</div>'}</div>
    </div>`;
  }).join(""));
}

/* ---- boot: live snapshot on the 3s cadence; every section repaints via Orcha.patch
   (scroll + text-selection safe). ---- */
// Perceived-lag fix: the portal is an MPA — this page boots empty until the
// first snapshot tick lands (render() returns early until then). Show a
// skeleton over the hero "needs your attention" grid right away
// (OrchaSkeleton.show is delayed 120ms, so a fast local snapshot never
// flashes one), then swap() it for the real render on the FIRST successful
// tick only — the rest of the dashboard (ctx bar, table, kanban) renders
// normally throughout, same as before.
if (window.OrchaSkeleton) OrchaSkeleton.show(Hom$("aqGrid"), "list-rows");
let booted = false;
function render() {
  if (!HomD() || !HomD().container) return;
  HomO.mountShell("home", { title: "Dashboard", ctx: HomD().container.name });
  renderProjNotice(); renderOnbCta(); renderCtx();
  if (!booted && window.OrchaSkeleton) {
    booted = true;
    OrchaSkeleton.swap(Hom$("aqGrid"), renderQueue);
  } else {
    renderQueue();
  }
  renderAgents(); renderActivity(); renderKanban();
}
/* Multi-project landing: a BARE "/" (no ?cid deep link) belongs to the /projects hub
 * unless this stack is the single-project case — the post-login proxy redirect and
 * typed-in visits land on the hub; every in-project link (sidebar, switcher, cards)
 * carries ?cid= (app-shell.withCid / data.switchProject) so project navigation never
 * bounces. 0 projects also goes to the hub (its empty state + New project beats a
 * load-error toast). The list is already membership-filtered server-side, so the
 * count is the VIEWER's project count, not the stack's. */
(function homeBoot() {
  const qs = (typeof location !== "undefined" && location.search) || "";
  const start = () => window.OrchaData.start(render, 3000);
  if (/[?&]cid=/.test(qs) || typeof fetch === "undefined") { start(); return; }
  fetch("/api/containers")
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => {
      const n = d && Array.isArray(d.containers) ? d.containers.length : null;
      if (n != null && n !== 1) { location.replace("/projects"); return; }
      start();
    })
    .catch(start);
})();
