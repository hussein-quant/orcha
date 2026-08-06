/**
 * Downstream extension registry — the ONE file a distribution (e.g. Orcha
 * Cloud) replaces to add premium pages without forking the open frontend.
 *
 * Contract (docs/orcha-portal-react-migration-plan.md → SDK seam):
 *  - Open Orcha ships this file EMPTY. Everything else under src/ is
 *    upstream-owned: a downstream sync copies frontend/src/** verbatim
 *    EXCEPT this file and the src/cloud/** namespace it may import from.
 *  - `routes` mount extra top-level pages; `nav` adds sidebar entries under
 *    the "Control room" group (same shape the shell's own items use).
 *  - `identity` is the auth seam: a downstream points it at its /api/me so
 *    the shell knows WHO is looking. SnapshotProvider calls it once per
 *    resolved cid and feeds the result into the acting-human resolution
 *    (see state/SnapshotProvider.tsx `actingIdentityHuman`). Open Orcha
 *    leaves it unset — the portal keeps its trusted local-operator model.
 *  - `accountMenu` turns the topbar acting-as chip into a dropdown (sign
 *    out, profile, …). Unset → the chip stays a plain label.
 *  - Components registered here render INSIDE the providers (snapshot, toast,
 *    router) and should wrap themselves in <Shell> like the open pages do.
 */
import type { ComponentType } from "react";

export interface ExtensionRoute {
  path: string; // e.g. "/metrics"
  element: ComponentType;
}

export interface ExtensionNavItem {
  key: string; // Shell active-page key — match the route's page key
  href: string; // e.g. "/metrics"
  ico: string; // an Icon name from components/ui
  label: string;
  count?: (snap: import("./types").Snapshot | null) => number | null;
  attn?: boolean;
}

/** The signed-in viewer, as the downstream identity endpoint reports it. */
export interface Identity {
  agent_id?: string | null;      // the viewer's own agent row id (member) — null when not a member
  alias?: string | null;
  github_login?: string | null;
  member_role?: string | null;   // owner|member|viewer
  grants?: string[] | null;      // mig 039: the viewer's own permission grants (/api/me)
  avatar_url?: string | null;
}

export interface AccountMenuItem { label: string; href?: string; onClick?: () => void; danger?: boolean }

/** A card injected into the open Settings page, after the open cards. */
export interface SettingsSection {
  key: string; // stable key
  title: string; // tab label on the settings tab strip
  element: ComponentType; // renders its own <div className="card">…
}

export interface Extensions {
  routes: ExtensionRoute[];
  nav: ExtensionNavItem[];
  identity?: (cid: string | null) => Promise<Identity | null>; // downstream: GET /api/me
  accountMenu?: (identity: Identity | null) => AccountMenuItem[];
  settingsSections?: SettingsSection[];
  /** Which open cards the General tab keeps (default both). A downstream can
   *  relocate a card into one of its sections (SettingsPage exports KeyCard/
   *  ModelsCard for composition). */
  settingsGeneral?: { key?: boolean; models?: boolean };
  /** Rendered in the topbar between the notification pill and the autonomy switch. */
  topbarActions?: ComponentType[];
}

export const extensions: Extensions = {
  routes: [],
  nav: [],
};
