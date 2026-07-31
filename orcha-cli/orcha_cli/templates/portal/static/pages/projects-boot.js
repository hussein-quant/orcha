/* Projects landing — boot + wiring (fetch, render, QR, new-project, theme). */

const Prj$ = (id) => document.getElementById(id);

async function projFetch(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(url + " → " + r.status);
  return r.json();
}

function wireProjGrid() {
  const grid = Prj$("projGrid");
  if (!grid || !grid.querySelectorAll) return;
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
  const grid = Prj$("projGrid");
  if (grid) grid.innerHTML = projectsGridHtml(list);
  wireProjGrid();
}

if (typeof document !== "undefined" && document.getElementById && Prj$("projGrid")) {
  renderProjects();
  // Light refresh so counts/needs-you stay honest while the tab sits open.
  if (typeof setInterval !== "undefined") setInterval(renderProjects, 15000);
}
