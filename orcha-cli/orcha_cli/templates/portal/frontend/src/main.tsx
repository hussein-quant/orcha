import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { ToastProvider } from "./components/ui";
import { SnapshotProvider } from "./state/SnapshotProvider";
import { initTheme } from "./shell/Shell";
import { AppRoutes } from "./shell/routes";

// Routing: react-router BrowserRouter over clean URLs (/tasks?task=…). Every
// page URL is served by an explicit FastAPI page route that returns the built
// SPA shell (portal_backend/dashboard_routes.py), so a hard reload of any
// route works. (GAP-08: an older comment here claimed hash routing.)
// The shared token layer (static/styles.css, served at /assets/styles.css) is
// linked at runtime: an href in index.html would get base-prefixed by Vite.
if (!document.querySelector('link[href="/assets/styles.css"]')) {
  // fallback only — the build injects a blocking <link> (vite sharedCssPlugin)
  const l = document.createElement("link");
  l.rel = "stylesheet";
  l.href = "/assets/styles.css";
  document.head.appendChild(l);
}
// V2 is dark-only: pin <html data-theme="dark"> before the first React render
// (index.html already did it pre-paint; this covers any other entry).
initTheme();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ToastProvider>
      <SnapshotProvider>
        <BrowserRouter>
          <AppRoutes />
        </BrowserRouter>
      </SnapshotProvider>
    </ToastProvider>
  </React.StrictMode>,
);
