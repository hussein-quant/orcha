/* Home page GitHub dashboard: the repo-binding row on the workspace context card and
   the Connect-repo modal. Mirrors the pairing modal (app-pairing.js): custom markup on
   the shared #__ov overlay, so backdrop-click + Escape dismissal come for free.
   Data: GET /api/github/repos (graceful {"available": false} when the GitHub App isn't
   wired) and PUT /api/containers/{cid}/github {"repo": "owner/name" | null}. */

/* The official GitHub mark, inline SVG + currentColor so it follows the theme. */
function ghMarkSVG(cls) {
  return `<svg class="${cls || "gh-mark"}" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>`;
}

/* ---- the repo row on the context card (renderCtx embeds this) --------- */
function ghRepoHtml(c) {
  const O = window.Orcha;
  if (c && c.github_repo) {
    const url = "https://github.com/" + c.github_repo;
    return `<div class="gh-row">
      <a class="tag gh" href="${O.esc(url)}" target="_blank" rel="noopener" title="Open ${O.esc(c.github_repo)} on GitHub">${ghMarkSVG()}<span>${O.esc(c.github_repo)}</span></a>
      <button class="gh-edit" type="button" data-gh-connect title="Change or unbind the repo">${O.icon("pencil", "gl")}</button>
    </div>`;
  }
  return `<div class="gh-row">
    <button class="tag gh gh-connect" type="button" data-gh-connect>${ghMarkSVG()}<span>Connect repo</span></button>
  </div>`;
}

/* ---- Connect-repo modal ----------------------------------------------- */
let ghSeq = 0;

function openRepoModal() {
  const O = window.Orcha;
  const c = window.ORCHA && window.ORCHA.container;
  if (!c) { O.toast("No Orcha container is loaded.", "danger"); return; }
  const ov = ensureOverlay();   // shared overlay (app-pairing.js): backdrop + Escape close
  ghWireOverlay(ov);
  ov.innerHTML = `<div class="modal gh-modal" role="dialog" aria-modal="true" aria-labelledby="ghTitle">
    <div class="pair-head">
      <span class="gh-badge">${ghMarkSVG("gh-badge-mark")}</span>
      <div class="grow">
        <h3 id="ghTitle">Connect a GitHub repo</h3>
        <p>Bind this workspace to a repository the Orcha GitHub App is installed on.</p>
      </div>
      <button class="iconbtn" id="ghClose" type="button" title="Close">${O.icon("x", "")}</button>
    </div>
    <div class="pair-content">
      <div id="ghBody"><div class="pair-loading">${O.icon("clock", "")}<span>Loading repositories...</span></div></div>
    </div>
  </div>`;
  ov.classList.add("show");
  const close = document.getElementById("ghClose");
  if (close) close.addEventListener("click", O.closeModal);
  ghLoadRepos();
}

/* one-time delegated click handling inside the shared overlay (survives re-renders) */
function ghWireOverlay(ov) {
  if (ov.__ghWired) return;
  ov.addEventListener("click", (e) => {
    const pick = e.target.closest("[data-gh-pick]");
    if (!pick) return;
    e.preventDefault();
    ghSaveBinding(pick.getAttribute("data-gh-pick") || null);
  });
  ov.__ghWired = true;
}

async function ghLoadRepos() {
  const seq = ++ghSeq;
  try {
    const r = await fetch("/api/github/repos");
    let data = null;
    try { data = await r.json(); } catch (e) {}
    if (seq !== ghSeq) return;
    if (!r.ok) { ghRenderOff({ detail: "Repo list failed (" + r.status + ")." }); return; }
    if (!data || !data.available) { ghRenderOff(data || {}); return; }
    ghRenderList(data.repos || []);
  } catch (e) {
    if (seq === ghSeq) ghRenderOff({ detail: "Could not reach the portal: " + e.message });
  }
}

/* graceful off state — self-hosters without the GitHub App land here, on purpose */
function ghRenderOff(data) {
  const host = document.getElementById("ghBody"); if (!host) return;
  const O = window.Orcha;
  host.innerHTML = `<div class="pair-warning">
    <div class="pair-warn-title">${O.icon("alert", "")}<span>The GitHub App isn't wired to this stack</span></div>
    <p>No installation token was found, so the portal can't list repositories. The host-side
    refresh timer keeps a short-lived token at <code>.orcha/github-token</code> once the Orcha
    GitHub App is set up — see <code>docs/github-dashboard.md</code> and the sandbox-mode
    companion, <code>deploy/README.md</code>.</p>
    ${data && data.detail ? `<p class="gh-detail">${O.esc(data.detail)}</p>` : ""}
    <p class="pair-foot">Self-hosting without the App is fully supported — everything else works; this dashboard simply stays off.</p>
  </div>`;
}

function ghRenderList(repos) {
  const host = document.getElementById("ghBody"); if (!host) return;
  const O = window.Orcha;
  const bound = ((window.ORCHA || {}).container || {}).github_repo || null;
  const rows = repos.map((r) => `<button class="lrow gh-repo-row${r.full_name === bound ? " sel" : ""}" type="button" data-gh-pick="${O.esc(r.full_name)}">
      ${ghMarkSVG("gh-row-mark")}
      <div class="grow">
        <div class="t1 mono">${O.esc(r.full_name)}${r.private ? '<span class="tag gh-private">private</span>' : ""}</div>
        ${r.description ? `<div class="t2">${O.esc(O.trunc(r.description, 96))}</div>` : ""}
      </div>
      ${r.full_name === bound ? O.icon("check", "gl gh-ck") : ""}
    </button>`).join("");
  host.innerHTML = `<div class="gh-list">${rows || '<div class="none">The App is installed, but on no repositories yet.</div>'}</div>
    ${bound ? `<div class="gh-unbind"><button class="btn sm ghost" type="button" data-gh-pick="">${O.icon("x", "")}Unbind ${O.esc(bound)}</button></div>` : ""}`;
}

async function ghSaveBinding(repo) {
  const O = window.Orcha;
  const c = window.ORCHA && window.ORCHA.container;
  if (!c) return;
  try {
    const r = await fetch("/api/containers/" + encodeURIComponent(c.id) + "/github", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repo: repo }),
    });
    let data = null;
    try { data = await r.json(); } catch (e) {}
    if (!r.ok) { O.toast("Saving repo binding failed (" + r.status + ")", "danger"); return; }
    c.github_repo = data ? data.repo : repo;   // update the card in place — no 3s-poll wait
    O.toast(c.github_repo ? "Repo connected — " + c.github_repo : "Repo unbound", "ok");
    O.closeModal();
    if (typeof renderCtx === "function") renderCtx();
  } catch (e) {
    O.toast("Saving repo binding failed: " + e.message, "danger");
  }
}

/* open the modal from either affordance; delegated so the 3s ctxbar repaint can't unwire it */
(function ghWireCtx() {
  const bar = document.getElementById("ctxbar");
  if (!bar || !bar.addEventListener) return;
  bar.addEventListener("click", (e) => {
    const b = e.target.closest && e.target.closest("[data-gh-connect]");
    if (!b) return;
    e.preventDefault();
    openRepoModal();
  });
})();
