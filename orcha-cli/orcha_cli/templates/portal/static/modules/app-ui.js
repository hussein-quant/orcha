/* Orcha shared portal module: avatars, icons, status badges, links, and attention queries. */

/* ---- deterministic avatar gradient ----------------------------------- */
function hue(s) { let h = 0; for (const c of (s || "")) h = (h * 31 + c.charCodeAt(0)) % 360; return h; }
function avatar(alias, kind, size) {
  const h = hue(alias);
  const grad = `linear-gradient(140deg, hsl(${h} 70% 62%), hsl(${(h + 38) % 360} 72% 54%))`;
  const cls = "av" + (size ? " " + size : "") + (kind === "human" ? " human" : "");
  const init = (alias || "?").trim().charAt(0).toUpperCase();
  return `<span class="${cls}" style="background:${grad}">${esc(init)}</span>`;
}
// Collab v1: a GitHub member's avatar — the well-known github.com/<login>.png image
// over the SAME deterministic letter tile, which stays visible (onerror drops the img)
// when the login has no avatar / the viewer is offline. Circular via .av.human.
function ghAvatar(login, size) {
  const h = hue(login);
  const grad = `linear-gradient(140deg, hsl(${h} 70% 62%), hsl(${(h + 38) % 360} 72% 54%))`;
  const cls = "av gh" + (size ? " " + size : "") + " human";
  const init = (login || "?").trim().charAt(0).toUpperCase();
  return `<span class="${cls}" style="background:${grad}">${esc(init)}<img class="gh-face" ` +
    `src="https://github.com/${esc(encodeURIComponent(login || ""))}.png?size=96" alt="" ` +
    `loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()"></span>`;
}
// Portal-wide face convention (originally agentFace() in pages/agents-state.js, promoted
// here so every avatar surface — not just the Agents page — can share it): a HUMAN with a
// mapped GitHub identity (github_login) gets their real GitHub profile picture via
// ghAvatar(); every AI agent, and any unmapped human (no github_login yet), keeps the
// plain deterministic letter avatar(). Accepts any record shaped like an agent/actor —
// a full agent object, a task reviewer, a member row, etc. — as long as it carries
// `kind`/`github_login`/`alias` (or an alias-only record for the AI branch).
function face(rec, size) {
  rec = rec || {};
  return (rec.kind === "human" && rec.github_login)
    ? ghAvatar(rec.github_login, size)
    : avatar(rec.alias, rec.kind, size);
}

/* ---- icons ----------------------------------------------------------- */
const I = {
  home: '<path d="M3 9.5 10 4l7 5.5V17a1 1 0 0 1-1 1h-3v-5H7v5H4a1 1 0 0 1-1-1z"/>',
  agents: '<circle cx="7" cy="7.5" r="2.6"/><circle cx="13.5" cy="8" r="2.1"/><path d="M2.6 16c.4-2.4 2.2-3.8 4.4-3.8s4 1.4 4.4 3.8M12 12.5c2 .1 3.4 1.4 3.8 3.5"/>',
  tasks: '<rect x="3.2" y="3.2" width="13.6" height="13.6" rx="3"/><path d="M6.6 10l2.2 2.2 4.6-4.8"/>',
  requests: '<path d="M5 7h9l-2.4-2.4M15 13H6l2.4 2.4"/>',
  live: '<path d="M2.5 10h3l2-5 3 10 2-7 1.5 2h3.5"/>',
  search: '<circle cx="8.5" cy="8.5" r="5"/><path d="m13 13 3.5 3.5"/>',
  bell: '<path d="M6 9a4 4 0 0 1 8 0c0 3 1.2 4 1.8 4.6.3.3.1.9-.4.9H4.6c-.5 0-.7-.6-.4-.9C4.8 13 6 12 6 9z"/><path d="M8.4 17a1.8 1.8 0 0 0 3.2 0"/>',
  phone: '<rect x="6" y="2.5" width="8" height="15" rx="2"/><path d="M8.8 5h2.4M9.5 15.2h1"/>',
  alert: '<path d="M10 3 17 16H3z"/><path d="M10 7.2v4.2M10 14.2h.01"/>',
  sun: '<circle cx="10" cy="10" r="3.6"/><path d="M10 2.4v2M10 15.6v2M2.4 10h2M15.6 10h2M4.6 4.6l1.4 1.4M14 14l1.4 1.4M15.4 4.6 14 6M6 14l-1.4 1.4"/>',
  moon: '<path d="M15.5 11.5A6 6 0 0 1 8.5 4.5a6 6 0 1 0 7 7z"/>',
  chev: '<path d="M5 7.5 10 12l5-4.5"/>',
  copy: '<rect x="6.5" y="6.5" width="9" height="9" rx="2"/><path d="M4.5 12.5h-1a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h7a1 1 0 0 1 1 1v1"/>',
  check: '<path d="M4 10.5 8 14l8-8.5"/>',
  x: '<path d="M5 5l10 10M15 5 5 15"/>',
  arrow: '<path d="M4 10h11M11 6l4 4-4 4"/>',
  ext: '<path d="M8 5H5.5A1.5 1.5 0 0 0 4 6.5v8A1.5 1.5 0 0 0 5.5 16h8a1.5 1.5 0 0 0 1.5-1.5V12M11 4h5v5M16 4l-7 7"/>',
  person: '<circle cx="10" cy="7" r="3"/><path d="M4.5 16c.6-3 2.8-4.5 5.5-4.5s4.9 1.5 5.5 4.5"/>',
  spark: '<path d="M10 2.6 11.7 8 17 9.7 11.7 11.4 10 16.8 8.3 11.4 3 9.7 8.3 8z"/>',
  clock: '<circle cx="10" cy="10" r="7"/><path d="M10 6v4.2l2.8 1.8"/>',
  plus: '<path d="M10 4v12M4 10h12"/>',
  shield: '<path d="M10 2.6 16 5v4.5c0 4-2.6 6.6-6 7.9-3.4-1.3-6-3.9-6-7.9V5z"/>',
  link: '<path d="M8.5 11.5 11.5 8.5M7.5 12.5 6 14a2.5 2.5 0 0 1-3.5-3.5L4 9M12.5 7.5 14 6a2.5 2.5 0 0 0-3.5-3.5L9 4"/>',
  play: '<path d="M6 4.5 15 10l-9 5.5z"/>',
  flag: '<path d="M5 17V3M5 4h9l-2 3 2 3H5"/>',
  convert: '<path d="M4 7h8l-2-2M16 13H8l2 2"/><rect x="3" y="3" width="14" height="14" rx="3" opacity="0"/>',
  dot: '<circle cx="10" cy="10" r="3.5"/>',
  maximize: '<path d="M7 4H4v3M13 4h3v3M7 16H4v-3M13 16h3v-3"/>',
  minimize: '<path d="M4 7h3V4M16 7h-3V4M4 13h3v3M16 13h-3v3"/>',
  pencil: '<path d="M13.5 4.5l2 2M4 16l1-3.2 7.6-7.6 2 2L7 14.8z"/>',
  refresh: '<path d="M15.5 6.5A6 6 0 1 0 16 10M16 4v3h-3"/>',
  stop: '<rect x="5.5" y="5.5" width="9" height="9" rx="1.6"/>',
  // SPEC-SETTINGS §5: two slider tracks with knobs — reads as "per-use-case
  // settings," distinct from the gear cliché, consistent with the thin-stroke set.
  sliders: '<path d="M4 6h7M14 6h2M4 14h2M9 14h7"/><circle cx="12.5" cy="6" r="1.8"/><circle cx="7.5" cy="14" r="1.8"/>',
  // Metrics page: three columns off a baseline — reads as "usage over time,"
  // consistent with the thin-stroke set.
  metrics: '<path d="M3.5 16.5h13"/><path d="M6.2 12.8v3.7M10 8.2v8.3M13.8 10.6v5.9"/>',
  // GitHub hub nav entry: an octocat-ish silhouette redrawn in the same thin-stroke,
  // rounded-join idiom as the rest of I (never the official filled GitHub mark — that
  // one is ghMarkSVG() in pages/home-github.js, reused verbatim for repo chips/badges
  // so a real GitHub surface still reads as GitHub; this is only the sidebar glyph).
  github: '<path d="M10 3c-3.9 0-7 3.1-7 7 0 3.2 2 5.8 4.9 6.7.4.1.5-.2.5-.4v-1.4c-2 .4-2.5-.5-2.7-.9-.2-.3-.6-1-1-1.2-.4-.2-.9-.6 0-.6.8 0 1.4.8 1.6 1.1.9 1.5 2.3 1.1 2.9.8.1-.6.4-1.1.6-1.3-2.2-.2-4.4-1.1-4.4-4.7 0-1 .4-1.9 1-2.6-.1-.2-.4-1.2.1-2.5 0 0 .8-.3 2.7 1 .8-.2 1.6-.3 2.4-.3s1.6.1 2.4.3c1.9-1.3 2.7-1 2.7-1 .5 1.3.2 2.3.1 2.5.6.7 1 1.6 1 2.6 0 3.6-2.2 4.5-4.4 4.7.4.3.7.9.7 1.9v2.1c0 .2.1.5.6.4 2.9-1 4.9-3.5 4.9-6.7 0-3.9-3.1-7-7-7z"/>',
  // GitHub hub row-kind glyphs (github.css .gh-kind-ico): an open ring with a
  // solid center dot for an issue (mirrors octicon issue-opened), and a
  // two-node branch-plus-arrow for a pull request (mirrors octicon
  // git-pull-request), both redrawn in the shared thin-stroke idiom. The
  // solid dots use fill="currentColor" so they read filled against the
  // parent svg's fill="none" default; row tone (open green / draft grey)
  // rides currentColor via the surrounding .gh-kind-ico CSS class, not a
  // hardcoded fill here.
  issueDot: '<circle cx="10" cy="10" r="7"/><circle cx="10" cy="10" r="2.6" fill="currentColor" stroke="none"/>',
  pullArrow: '<circle cx="6" cy="5" r="2" fill="currentColor" stroke="none"/><circle cx="6" cy="15" r="2" fill="currentColor" stroke="none"/><circle cx="14" cy="8" r="2" fill="currentColor" stroke="none"/><path d="M6 7v6M14 10v3a2 2 0 0 1-2 2h-2M14 6V5"/><path d="M11.5 3.5 14 6l2.5-2.5"/>',
  // Checks chip "pending" glyph (github.css .tag.gh-checks.pend): a bare open
  // ring — the "○" the founder's spec called for — distinct from the clock
  // glyph (which reads as "waiting on time," not "in progress/undetermined").
  ring: '<circle cx="10" cy="10" r="6"/>',
  // Info-circle glyph (GitHub hub's PR "Fix" outstanding-items popover trigger,
  // github-state.js's fixInfoTriggerHtml): the classic "ⓘ" idiom — an open
  // ring with a dot (the "i"'s tittle) + a short vertical stroke (the "i"'s
  // stem), redrawn in the same thin-stroke set rather than a filled Unicode
  // glyph so it scales/recolors identically to every other icon here.
  info: '<circle cx="10" cy="10" r="7"/><circle cx="10" cy="6.6" r="0.9" fill="currentColor" stroke="none"/><path d="M10 9.6v4.4"/>',
};
const icon = (name, cls) => `<svg class="${cls || "ico"}" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${I[name] || ""}</svg>`;

/* ---- status system --------------------------------------------------- */
const STAT = {
  working:            { l: "Working",      c: "s-working" },
  in_progress:        { l: "In progress",  c: "s-working" },
  idle:               { l: "Idle",         c: "s-idle" },
  pending:            { l: "Pending",      c: "s-idle" },
  ready:              { l: "Ready",        c: "s-ready" },
  blocked:            { l: "Blocked",      c: "s-bad" },
  awaiting_request:   { l: "Waiting",      c: "s-warn" },
  awaiting_human:     { l: "Needs human",  c: "s-warn" },
  needs_verification: { l: "Needs verify", c: "s-attn" },
  completed:          { l: "Completed",    c: "s-done" },
  cancelled:          { l: "Cancelled",    c: "s-idle" },
  failed:             { l: "Failed",       c: "s-bad" },
  terminated:         { l: "Terminated",   c: "s-bad" },
  open:               { l: "Open",         c: "s-warn" },
  accepted:           { l: "Accepted",     c: "s-ready" },
  rejected:           { l: "Rejected",     c: "s-bad" },
  answered:           { l: "Answered",     c: "s-ok" },
  converted_to_task:  { l: "Converted",    c: "s-acc" },
  closed:             { l: "Closed",       c: "s-idle" },
  escalated:          { l: "Escalated",    c: "s-bad" },
};
function glyph(cls) {
  const v = (b) => `<svg class="gl" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${b}</svg>`;
  switch (cls) {
    case "s-working": return '<svg class="gl" viewBox="0 0 12 12"><circle cx="6" cy="6" r="4.6" fill="none" stroke="currentColor" stroke-opacity=".4" stroke-width="1.3"/><circle class="core" cx="6" cy="6" r="2.3" fill="currentColor"/></svg>';
    case "s-ok": case "s-done": return v('<path d="M2.6 6.4 5 8.7 9.4 3.6"/>');
    case "s-ready": return '<svg class="gl" viewBox="0 0 12 12" fill="currentColor"><path d="M3.6 2.6 9.6 6l-6 3.4z"/></svg>';
    case "s-attn": case "s-warn": return '<svg class="gl" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round"><path d="M6 2 11 10.6H1z"/><path d="M6 5v2.2"/><circle cx="6" cy="9" r=".55" fill="currentColor" stroke="none"/></svg>';
    case "s-bad": return v('<path d="M3.3 3.3 8.7 8.7M8.7 3.3 3.3 8.7"/>');
    case "s-acc": return v('<path d="M2.6 6h6.8M6.4 3 9.4 6 6.4 9"/>');
    default: return '<svg class="gl" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="6" cy="6" r="3.6" stroke-opacity=".55"/><path d="M4.3 6h3.4" stroke-linecap="round"/></svg>';
  }
}
function pill(status, size) {
  const m = STAT[status] || { l: status || "unknown", c: "s-idle" };
  return `<span class="pill ${m.c}${size ? " " + size : ""}">${glyph(m.c)}${esc(m.l)}</span>`;
}
function statusClass(status) { return (STAT[status] || { c: "s-idle" }).c; }

function kindBadge(kind) {
  if (kind === "human") return `<span class="kind human">${icon("person", "")}Human</span>`;
  return `<span class="kind ai">${icon("spark", "")}AI</span>`;
}

/* ---- deeplinks (read live agents/tasks; never a dead-end) ------------- */
function agentLink(alias, opts) {
  const a = agentByAlias(alias);
  if (!a) return esc(alias || "—");
  if (opts && opts.plain) return `<a class="dlink" href="/agents?agent=${encodeURIComponent(alias)}"><span>${esc(alias)}</span></a>`;
  return `<a class="dlink" href="/agents?agent=${encodeURIComponent(alias)}">${avatar(alias, a.kind, "")}<span>${esc(alias)}</span></a>`;
}
function taskLink(id, label) {
  const t = taskById(id);
  return `<a class="dlink" href="/tasks?task=${encodeURIComponent(id)}">${esc(label || (t ? t.title : id))}</a>`;
}
function requestLink(id, label) {
  return `<a class="dlink" href="/requests?req=${encodeURIComponent(id)}">${esc(label || id)}</a>`;
}

/* ---- action queue: what needs the human right now -------------------- */
// a task needs PLAN approval when it's in progress, its agent has posted a plan
// (an opening non-human thread message), and no plan_approval decision exists yet.
function planMessageOf(t) {
  // ISS-68: the snapshot ships `plan_message` (latest agent note) instead of the full thread,
  // so the plan gate no longer needs the thread embedded. Fall back to the thread for any
  // legacy/expanded payload that still carries it.
  if (t && t.plan_message) return { body: t.plan_message.body, from: t.plan_message.author_alias || null, at: t.plan_message.at, is_human: false };
  const m = (t.thread || []).filter((x) => !x.is_human);
  return m.length ? m[0] : null;
}
function pendingPlan(t) {
  return t.status === "in_progress" && !t.plan_decision && !!planMessageOf(t);
}
// #367: which human-gate cards are shown is driven by the engine autonomy LEVEL
// (containers.autonomy_level, read via autLevel()), NOT by task state alone:
//   • plan   — Plan-only: agents stop at the plan gate, so a pending-plan handoff
//              renders a Plan card. After approve→PR→completion the verify gate is live.
//   • pr     — Build-to-PR: agents go straight to a PR, so there is NO plan card; a
//              completed-PR handoff lands at needs_verification → Verify card only.
//   • full   — agents carry approved work to its terminal state, so NEITHER a plan card
//              NOR a verify card is shown (under Full /done auto-completes; this also
//              defensively suppresses any task that still reaches needs_verification).
// This is the single fix for the two #367 bugs — Full no longer shows an approval card,
// and a completed-PR handoff at pr/full can never be mislabeled as a "Proposed plan".
// Escalations are an explicit agent→human blocker (orthogonal to autonomy) and are
// never suppressed — stranding a genuinely-blocked agent at Full would be worse, not safer.
function attnItems() {
  const lvl = autLevel();
  const plans = lvl === "plan" ? tasks().filter(pendingPlan) : [];
  const verifs = lvl === "full" ? [] : tasks().filter((t) => t.status === "needs_verification");
  const escs = requests().filter((r) => r.status === "open" && isToHuman(r));
  return { plans, verifs, escs, count: plans.length + verifs.length + escs.length };
}

/* ---- the Orcha mark (orca) ------------------------------------------- */
function orcaSVG() {
  return `<svg viewBox="0 0 100 100" fill="none" aria-label="Orcha">
    <path d="M27,83 C28,55 33,32 45.5,22.5 C51.5,18 57.5,19.5 60,27 C64.5,46 70.5,67 73,83 Z" fill="#f3fbfb"/>
    <g stroke="#06171c" stroke-width="2.4" stroke-linecap="round">
      <line x1="49" y1="38" x2="40" y2="62"/><line x1="49" y1="38" x2="56" y2="62"/><line x1="49" y1="38" x2="50" y2="74"/></g>
    <g fill="#06171c"><circle cx="39" cy="64" r="4"/><circle cx="57" cy="64" r="4"/><circle cx="50" cy="76" r="4"/></g>
    <circle cx="49" cy="35" r="6" fill="#1fc7cd"/>
    <path d="M13,86 C28,82 38,82 50,82.5 C62,82 72,82 87,86" stroke="#1fc7cd" stroke-width="5" stroke-linecap="round" fill="none"/>
  </svg>`;
}
