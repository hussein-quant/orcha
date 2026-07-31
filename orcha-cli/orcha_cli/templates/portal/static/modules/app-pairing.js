/* Orcha shared portal module: phone pairing payloads, overlay, modal, and toast helpers. */
/* ---- mobile pairing modal --------------------------------------------- */
let pairingTimer = null;
let pairingSeq = 0;

function clearPairingTimer() {
  if (pairingTimer != null) clearInterval(pairingTimer);
  pairingTimer = null;
}

function ensureOverlay() {
  let ov = document.getElementById("__ov");
  if (!ov) {
    ov = document.createElement("div");
    ov.id = "__ov"; ov.className = "overlay";
    document.body.appendChild(ov);
  }
  if (!ov.__orchaWired) {
    ov.addEventListener("click", (e) => { if (e.target === ov) closeModal(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModal(); });
    ov.__orchaWired = true;
  }
  return ov;
}

function pairingHumanSelect(selectedId) {
  const hs = humans();
  if (hs.length <= 1) return "";
  return `<label class="pair-select"><span>Pair as</span><select id="pairHuman">
    ${hs.map((h) => `<option value="${esc(h.id)}"${String(h.id) === String(selectedId) ? " selected" : ""}>${esc(h.alias)} (human)</option>`).join("")}
  </select></label>`;
}

/* Identity-correct pairing: when the TRUSTED proxy lane resolved a signed-in
 * GitHub member, that member is the ONLY human a phone can pair as — no "Pair
 * as" selector, and the server enforces the same rule (mismatch → 403). The
 * typeof guards keep this module loadable in harnesses/embeddings that carry
 * no identity layer; every real page loads app-data.js first. */
function pairingTrustedLane() {
  try { return typeof identityTrusted === "function" && identityTrusted(); } catch (e) { return false; }
}
function pairingIdentity() {
  if (!pairingTrustedLane()) return null;
  try { return typeof identity === "function" ? identity() : null; } catch (e) { return null; }
}
/* The "Pairing as" line, house acting-chip style: GitHub avatar + login. */
function pairingIdentityChip(ident) {
  const av = typeof ghAvatar === "function" ? ghAvatar(ident.github_login, "sm") : "";
  return `<span class="pair-identity">${av}<span class="gh-login">${esc(ident.github_login)}</span></span>`;
}

/* Honest network copy: behind the cloud sign-in perimeter (https / non-local
 * payload URL) the phone connects from anywhere — the "same Wi-Fi" and
 * "nothing goes through the cloud" claims are only true for local self-host. */
function pairingCloudContext(baseUrl) {
  if (/^https:/i.test(baseUrl || "")) return true;
  try { return typeof location !== "undefined" && location.protocol === "https:"; } catch (e) { return false; }
}
function pairingScanCopy(cloud) {
  return cloud
    ? "Scan with the Orcha app — works from anywhere."
    : "Scan with the Orcha app on the same Wi-Fi network.";
}
function pairingFootCopy(cloud) {
  return cloud
    ? "Your phone connects securely over HTTPS through this Orcha's sign-in perimeter."
    : "Your phone talks directly to this computer on your network. Nothing goes through the cloud.";
}

/* The modal is CID-SCOPED: opts {cid, name} targets any project (the /projects
 * landing passes the card's project); default = the loaded container. The QR
 * payload itself is built by GET /api/containers/{cid}/pairing from the PATH cid,
 * so the phone always pairs against exactly the project whose button was pressed. */
let pairingCid = null;
function openPairingModal(opts) {
  opts = opts || {};
  const cid = opts.cid || (D.container && D.container.id);
  if (!cid) { toast("No Orcha container is loaded.", "danger"); return; }
  pairingCid = cid;
  // Trusted lane: the resolved identity IS the pairing human — no selector, the
  // server resolves (and enforces) the member from the verified login, so no
  // human_agent_id rides the request. Trust off (self-host): the human picker
  // only knows the LOADED project's roster; a foreign-cid open (landing page)
  // skips it — the server answers 400 choose_human, which renders its own
  // picker below.
  const trusted = pairingTrustedLane();
  const sameProject = !!(D.container && String(D.container.id) === String(cid));
  const hs = !trusted && sameProject ? humans() : [];
  const who = !trusted && sameProject ? (actingHuman() || hs[0] || null) : null;
  const selected = !trusted && who ? who.id : null;
  clearPairingTimer();

  const ov = ensureOverlay();
  ov.innerHTML = `<div class="modal pair-modal" role="dialog" aria-modal="true" aria-labelledby="pairTitle">
    <div class="pair-head">
      <span class="pair-mark">${orcaSVG()}</span>
      <div class="grow">
        <h3 id="pairTitle">Pair your phone</h3>
        <p>${esc(pairingScanCopy(pairingCloudContext()))}${opts.name ? " Project: <b>" + esc(opts.name) + "</b>." : ""}</p>
      </div>
      <button class="iconbtn" id="pairClose" type="button" title="Close">${icon("x", "")}</button>
    </div>
    <div class="pair-content">
      ${!trusted && sameProject ? pairingHumanSelect(selected) : ""}
      <div id="pairBody"><div class="pair-loading">${icon("clock", "")}<span>Preparing pairing code...</span></div></div>
    </div>
  </div>`;
  ov.classList.add("show");
  const close = document.getElementById("pairClose");
  if (close) close.addEventListener("click", closeModal);
  const sel = document.getElementById("pairHuman");
  if (sel) sel.addEventListener("change", () => loadPairing(sel.value));
  if (!trusted && sameProject && !hs.length) {
    renderPairingWarning({ title: "No human can pair this phone", message: "Add a human operator before pairing a phone." });
  } else {
    loadPairing(selected);
  }
}

function renderPairingWarning(info) {
  clearPairingTimer();
  const host = document.getElementById("pairBody");
  if (!host) return;
  info = info || {};
  if (typeof info === "string") info = { message: info };  // plain-string 403 details
  host.innerHTML = `<div class="pair-warning">
    <div class="pair-warn-title">${icon("alert", "")}<span>${esc(info.title || "Phones can't reach this Orcha yet")}</span></div>
    <p>${esc(info.message || "The server could not produce a phone-reachable network address.")}</p>
    ${info.remedy ? `<div class="pair-remedy">${pairingCopyWithCode(info.remedy)}</div>` : ""}
    <p class="pair-foot">Both devices must be on the same Wi-Fi. Some VPNs and corporate networks block phone-to-laptop traffic.</p>
  </div>`;
}

function pairingCopyWithCode(s) {
  return esc(s).replace(/`([^`]+)`/g, "<code>$1</code>");
}

function renderPairingLoading() {
  const host = document.getElementById("pairBody");
  if (host) host.innerHTML = `<div class="pair-loading">${icon("clock", "")}<span>Preparing pairing code...</span></div>`;
}

async function loadPairing(humanId) {
  const cid = pairingCid || (D.container && D.container.id);
  if (!cid) return;
  const seq = ++pairingSeq;
  clearPairingTimer();
  renderPairingLoading();
  let url = "/api/containers/" + encodeURIComponent(cid) + "/pairing";
  if (humanId) url += "?human_agent_id=" + encodeURIComponent(humanId);
  try {
    const r = await fetch(url);
    let data = null;
    try { data = await r.json(); } catch (e) {}
    if (seq !== pairingSeq) return;
    if (!r.ok) {
      const detail = data && data.detail;
      // Foreign-cid open (landing page) with several humans and no trusted
      // identity: the server answers 400 choose_human with the roster — render
      // its picker instead of a dead warning.
      if (detail && detail.reason === "choose_human" && Array.isArray(detail.humans)) {
        renderPairingChooser(detail.humans);
        return;
      }
      renderPairingWarning(detail || { message: "Pairing failed (" + r.status + ")." });
      return;
    }
    renderPairingPayload(data, humanId);
  } catch (e) {
    if (seq === pairingSeq) renderPairingWarning({ message: "Could not reach the local pairing endpoint: " + e.message });
  }
}

function renderPairingChooser(hs) {
  clearPairingTimer();
  const host = document.getElementById("pairBody");
  if (!host) return;
  host.innerHTML = `<div class="pair-warning">
    <div class="pair-warn-title">${icon("alert", "")}<span>Choose who to pair as</span></div>
    <label class="pair-select"><span>Pair as</span><select id="pairChoose">
      <option value="" selected disabled>Select a human…</option>
      ${hs.map((h) => `<option value="${esc(h.id)}">${esc(h.alias)} (human)</option>`).join("")}
    </select></label>
  </div>`;
  const sel = document.getElementById("pairChoose");
  if (sel) sel.addEventListener("change", () => loadPairing(sel.value));
}

function countdownText(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = String(total % 60).padStart(2, "0");
  return "expires in " + m + ":" + s + " — regenerates automatically";
}

function startPairingCountdown(data, humanId) {
  clearPairingTimer();
  const exp = Date.parse(data.expiresAt || "");
  const el = document.getElementById("pairCountText");
  if (!exp || !el) return;
  const tick = () => {
    const left = exp - Date.now();
    if (left <= 0) {
      clearPairingTimer();
      loadPairing(humanId);
    } else {
      el.textContent = countdownText(left);
    }
  };
  tick();
  pairingTimer = setInterval(tick, 1000);
}

function renderPairingPayload(data, humanId) {
  const host = document.getElementById("pairBody");
  if (!host) return;
  const ident = pairingIdentity();
  const human = data.humanAgentAlias || aliasFor(data.humanAgentId) || "selected human";
  const pairAs = ident && ident.github_login
    ? pairingIdentityChip(ident)
    : `${esc(human)} (human)`;
  host.innerHTML = `<div class="pair-grid">
    <div class="pair-card">
      <div class="pair-brand">${orcaSVG()}<span class="pair-wordmark">Orcha</span></div>
      <div class="pair-qr" role="img" aria-label="Orcha phone pairing QR code">${data.qrSvg || ""}</div>
      <div class="pair-scanline">Scan with the Orcha app</div>
      <div class="pair-url mono">${esc(data.baseUrl || "")}</div>
    </div>
    <div class="pair-meta">
      <div>
        <div class="pair-label">Pairing as</div>
        <div class="pair-value">${pairAs}</div>
      </div>
      <div>
        <div class="pair-label">Manual code</div>
        <div class="pair-code mono">${esc(data.shortCode || "")}</div>
      </div>
      <div class="pill s-warn pair-expiry" id="pairCountdown">${icon("clock", "gl")}<span id="pairCountText">expires soon</span></div>
      <div class="pair-foot">${esc(pairingFootCopy(pairingCloudContext(data.baseUrl)))}</div>
    </div>
  </div>`;
  startPairingCountdown(data, humanId || data.humanAgentId);
}

/* ---- modal ----------------------------------------------------------- */
function modal(cfg) {
  let ov = ensureOverlay();
  ov.innerHTML = `<div class="modal" role="dialog" aria-modal="true">
    <div class="mh"><h3>${esc(cfg.title)}</h3>${cfg.desc ? `<p>${esc(cfg.desc)}</p>` : ""}</div>
    <div class="mb">${cfg.body || ""}</div>
    <div class="mf">
      <button class="btn ghost" id="__mc">${esc(cfg.cancel || "Cancel")}</button>
      <button class="btn ${cfg.danger ? "danger" : cfg.approve ? "approve" : ""}" id="__mp">${esc(cfg.primary || "Confirm")}</button>
    </div></div>`;
  ov.classList.add("show");
  document.getElementById("__mc").addEventListener("click", closeModal);
  document.getElementById("__mp").addEventListener("click", () => { if (cfg.onPrimary) cfg.onPrimary(ov); else closeModal(); });
  if (cfg.onOpen) cfg.onOpen(ov);
}
function closeModal() { clearPairingTimer(); pairingCid = null; const ov = document.getElementById("__ov"); if (ov) ov.classList.remove("show"); }

/* ---- toast ----------------------------------------------------------- */
let toastT;
function toast(msg, kind) {
  let t = document.getElementById("__toast");
  if (!t) { t = document.createElement("div"); t.id = "__toast"; t.className = "toast"; document.body.appendChild(t); }
  t.className = "toast " + (kind || "");
  t.textContent = msg;
  requestAnimationFrame(() => t.classList.add("show"));
  clearTimeout(toastT);
  toastT = setTimeout(() => t.classList.remove("show"), 2600);
}

function copyText(s) { try { navigator.clipboard.writeText(s); toast("Copied", "ok"); } catch (e) {} }
