/* Orcha shared portal module: per-user cosmetic preferences (server-backed).
 *
 * Cross-device personalization for signed-in users. localStorage stays the
 * SOURCE the page paints from (the pre-paint <head> script is untouched and
 * instant); this module just keeps it in sync with GET/PUT /api/prefs:
 *
 *   boot   sync(): fetch /api/prefs ONCE (single-flight). prefs null — the
 *          self-host / trust-off / unmapped signal — deactivates the module
 *          entirely: pure-localStorage behavior, byte-identical to pre-040.
 *          prefs non-null: SERVER WINS — apply theme/skin/sidebar to <html>
 *          and mirror INTO localStorage, so the next load pre-paints right.
 *   write  queuePut(): the existing local writers (cycleTheme/applyTheme,
 *          applySkin, toggleSidebar, the default star) keep writing
 *          localStorage immediately, then call this; a debounced PUT mirrors
 *          the full local set up. Inactive ⇒ no-op (no network, ever).
 *
 * COSMETIC ONLY: nothing here (or server-side) gates behavior on prefs. The
 * one navigation-adjacent key, default_cid, is consumed exclusively by
 * data.js resolveCid's LAST fallback — where "/" would otherwise pick the
 * first project — never as a redirect. */
window.OrchaPrefs = (function () {
  const DEBOUNCE_MS = 800;
  const DEF_CID_KEY = "orcha:defaultCid";
  let _active = false;      // server prefs available (trusted + mapped)?
  let _syncPromise = null;  // single-flight guard for the boot fetch
  let _timer = null;

  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) {
    try {
      if (v == null) localStorage.removeItem(k);
      else localStorage.setItem(k, String(v));
    } catch (e) {}
  }

  // The full local cosmetic set — what a write-through PUTs (whole-bag replace
  // server-side, so omitting a key IS unsetting it).
  function localPrefs() {
    const p = {};
    const theme = lsGet("orcha:theme"); if (theme) p.theme = theme;
    const skin = lsGet("orcha:skin"); if (skin) p.skin = skin;
    const sidebar = lsGet("orcha:sidebar"); if (sidebar) p.sidebar = sidebar;
    const def = lsGet(DEF_CID_KEY); if (def) p.default_cid = def;
    return p;
  }

  // SERVER WINS: apply to <html> now (mirroring each page's pre-paint script,
  // same attribute contracts) and mirror into localStorage for the next load.
  function applyServer(prefs) {
    const d = document.documentElement;
    if (prefs.theme) {
      lsSet("orcha:theme", prefs.theme);
      d.setAttribute("data-theme", prefs.theme);
    }
    if (prefs.skin) {
      lsSet("orcha:skin", prefs.skin);
      if (prefs.skin === "classic") d.removeAttribute("data-skin");
      else d.setAttribute("data-skin", prefs.skin);
    }
    if (prefs.sidebar) {
      lsSet("orcha:sidebar", prefs.sidebar);
      if (prefs.sidebar === "collapsed") d.setAttribute("data-sidebar", "collapsed");
      else d.removeAttribute("data-sidebar");
    }
    if (prefs.default_cid != null) lsSet(DEF_CID_KEY, prefs.default_cid);
  }

  function sync() {
    if (_syncPromise) return _syncPromise;   // once per page load
    _syncPromise = fetch("/api/prefs")
      .then((r) => (r.ok ? r.json() : { prefs: null }))
      .then((d) => {
        const prefs = d && d.prefs;
        if (prefs == null) { _active = false; return null; }
        _active = true;
        applyServer(prefs);
        return prefs;
      })
      .catch(() => { _active = false; return null; });
    return _syncPromise;
  }

  function flush() {
    _timer = null;
    if (!_active) return;
    fetch("/api/prefs", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prefs: localPrefs() }),
    }).catch(() => {});   // cosmetic: a lost mirror self-heals on the next write
  }

  function queuePut() {
    if (!_active) return;                    // self-host/untrusted: localStorage only
    if (_timer) clearTimeout(_timer);
    _timer = setTimeout(flush, DEBOUNCE_MS);
  }

  /* default project star (the /projects hub) — toggleable, localStorage-first
   * like every other pref. null clears the mark. */
  function setDefaultCid(cid) {
    lsSet(DEF_CID_KEY, cid);
    queuePut();
  }
  function defaultCid() { return lsGet(DEF_CID_KEY); }
  function active() { return _active; }

  return { sync, queuePut, flush, setDefaultCid, defaultCid, active, localPrefs };
})();
