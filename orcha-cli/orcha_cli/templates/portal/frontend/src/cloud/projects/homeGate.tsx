/**
 * CloudHome — the access-model home gate, reproducing the vanilla home-boot
 * redirect (pages/home-render.js homeBoot): a BARE "/" (no ?cid deep link)
 * belongs to the /projects hub unless this stack is the single-project case —
 * the post-login proxy redirect and typed-in visits land on the hub; every
 * in-project link carries ?cid= so project navigation never bounces. 0 projects
 * also goes to the hub (its empty state + New project beats a load-error
 * toast). The list is already membership-filtered server-side, so the count is
 * the VIEWER's project count, not the stack's. On fetch failure the open
 * HomePage renders (vanilla .catch(start) parity).
 */
import { useEffect, useState } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { HomePage } from "../../pages/home/HomePage";

export function CloudHome() {
  const location = useLocation();
  const hasCid = /[?&]cid=/.test(location.search || "");
  // "home" renders the open HomePage; "projects" bounces; null = still deciding.
  const [dest, setDest] = useState<"home" | "projects" | null>(hasCid ? "home" : null);

  useEffect(() => {
    if (hasCid) return; // cid-carrying URL: never bounce (deep links stay put)
    let alive = true;
    fetch("/api/containers")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { containers?: unknown[] } | null) => {
        if (!alive) return;
        const n = d && Array.isArray(d.containers) ? d.containers.length : null;
        setDest(n != null && n !== 1 ? "projects" : "home");
      })
      .catch(() => { if (alive) setDest("home"); });
    return () => { alive = false; };
  }, [hasCid]);

  if (dest === "projects") return <Navigate to="/projects" replace />;
  if (dest === "home") return <HomePage />;
  return null; // deciding — one containers round-trip, same as the vanilla boot
}
