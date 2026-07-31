/* Projects landing — boot + wiring (fetch, render, QR, new-project, theme). */

const Prj$ = (id) => document.getElementById(id);

async function projFetch(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(url + " → " + r.status);
  return r.json();
}

/* default-star click: toggle the mark (starred → unset), persist via OrchaPrefs
 * (localStorage immediately + debounced PUT), and repaint every star IN PLACE —
 * no refetch, the 15s refresh reconciles anything else. */
function wireDefStars(grid) {
  const stars = grid.querySelectorAll("[data-def-cid]");
  const paint = (def) => stars.forEach((s) => {
    const on = def != null && s.getAttribute("data-def-cid") === String(def);
    s.classList.toggle("on", on);
    s.setAttribute("aria-pressed", on ? "true" : "false");
    s.title = on ? "Default project — click to unset" : "Make this your default project";
    const svg = s.querySelector && s.querySelector("svg");
    if (svg) svg.setAttribute("fill", on ? "currentColor" : "none");
  });
  stars.forEach((b) => b.addEventListener("click", () => {
    const cid = b.getAttribute("data-def-cid");
    const cur = window.OrchaPrefs ? window.OrchaPrefs.defaultCid() : null;
    const next = cur != null && String(cur) === String(cid) ? null : cid;
    if (window.OrchaPrefs) window.OrchaPrefs.setDefaultCid(next);
    paint(next);
  }));
}

function wireProjGrid() {
  const grid = Prj$("projGrid");
  if (!grid || !grid.querySelectorAll) return;
  wireDefStars(grid);
  // Per-card QR: opens the EXISTING pairing modal scoped to THAT project's cid —
  // the payload/QR comes from GET /api/containers/<cid>/pairing (path-scoped).
  grid.querySelectorAll("[data-pair-cid]").forEach((b) => b.addEventListener("click", () =>
    PrjO.openPairingModal({
      cid: b.getAttribute("data-pair-cid"),
      name: b.getAttribute("data-pair-name") || "",
    })));
  const nw = Prj$("projNew");
  if (nw) {
    const open = () => openProjCreateModal();
    nw.addEventListener("click", open);
    nw.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
  }
}

/* New project from the hub: same POST additional=true contract as the switcher's
 * modal, but on success we land INSIDE the new project (its cid-carrying URL). */
function openProjCreateModal() {
  PrjO.modal({
    title: "New project",
    desc: "Adds another project to this stack. Portal-only until a host workspace is "
      + "bound to it — agents and tasks work, but nothing wakes agents yet.",
    body: `<label class="np-f"><span>Name</span>
        <input id="npName" maxlength="200" placeholder="e.g. api-gateway" spellcheck="false"></label>
      <label class="np-f"><span>Description</span>
        <textarea id="npDesc" class="ta" placeholder="What is this project about? (optional)"></textarea></label>`,
    primary: "Create project",
    onPrimary: () => {
      const name = ((Prj$("npName") || {}).value || "").trim();
      const desc = ((Prj$("npDesc") || {}).value || "").trim();
      if (!name) { PrjO.toast("A project name is required.", "danger"); return; }
      fetch("/api/containers", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name, description: desc || null, additional: true }),
      })
        .then((r) => r.json().then((d) => ({ ok: r.ok, status: r.status, d })).catch(() => ({ ok: r.ok, status: r.status, d: {} })))
        .then(({ ok, status, d }) => {
          if (!ok) {
            PrjO.toast("Create failed" + (d && d.detail ? ": " + d.detail : " (" + status + ")"), "danger");
            return;
          }
          PrjO.closeModal();
          try { localStorage.setItem("orcha:projNotice:" + d.container_id, "1"); } catch (e) {}
          try { localStorage.setItem("orcha:cid", String(d.container_id)); } catch (e) {}
          location.assign("/?cid=" + encodeURIComponent(d.container_id));
        })
        .catch((e) => PrjO.toast("Create failed: " + e.message, "danger"));
    },
  });
}

async function renderProjects() {
  // Per-user prefs (mig 040): kick the once-per-load /api/prefs sync alongside
  // the list fetch (single-flight — the 15s refresh re-await is instant). The
  // hub needs it settled before painting so the default stars render honestly
  // (and self-host, where prefs resolve null, paints NO stars at all).
  const prefsReady = window.OrchaPrefs ? window.OrchaPrefs.sync() : Promise.resolve(null);
  // Identity for the account chip: any project's cid works for /api/me; use the
  // first listed (or skip the chip on an empty stack).
  let list = [];
  try {
    const d = await projFetch("/api/containers");
    list = (d && d.containers) || [];
  } catch (e) {
    const grid = Prj$("projGrid");
    if (grid) grid.innerHTML = `<div class="proj-empty"><div class="t1">Couldn't load projects</div><div>${PrjO.esc(e.message)}</div></div>`;
    return;
  }
  let me = null;
  if (list.length) {
    try { me = await projFetch("/api/me?cid=" + encodeURIComponent(list[0].id)); } catch (e) {}
  }
  // Stash the trusted identity where the shared pairing modal reads it (D via
  // identity()/identityTrusted()), so a per-card QR shows the "Pairing as"
  // GitHub chip. The login/avatar are account-level (valid for every card);
  // the modal never sends the agent_id — the server resolves per project.
  if (me && PrjO.D) { PrjO.D.identity = me.identity || null; PrjO.D.identityTrusted = !!me.trusted; }
  const top = Prj$("projTop");
  if (top) {
    top.innerHTML = projTopHtml(me);
    const tb = Prj$("projTheme");
    if (tb) tb.addEventListener("click", PrjO.cycleTheme);
  }
  const sub = Prj$("projSub");
  if (sub) sub.textContent = list.length
    ? "Everything you're a member of on this Orcha."
    : "No memberships yet — create a project or ask an owner for an invite.";
  try { await prefsReady; } catch (e) {}
  const starOpts = window.OrchaPrefs && window.OrchaPrefs.active()
    ? { stars: true, defaultCid: window.OrchaPrefs.defaultCid() }
    : null;
  const grid = Prj$("projGrid");
  if (grid) grid.innerHTML = projectsGridHtml(list, starOpts);
  wireProjGrid();
}

if (typeof document !== "undefined" && document.getElementById && Prj$("projGrid")) {
  renderProjects();
  // Light refresh so counts/needs-you stay honest while the tab sits open.
  if (typeof setInterval !== "undefined") setInterval(renderProjects, 15000);
}
