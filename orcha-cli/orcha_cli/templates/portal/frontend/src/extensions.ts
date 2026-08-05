/**
 * ORCHA CLOUD extension registry — the one open-frontend file Cloud owns.
 * Upstream sync contract: copy frontend/src/** from open Orcha verbatim
 * EXCEPT this file and src/cloud/**. Cloud premium pages register here;
 * a route sharing a path with an open page REPLACES it (access model:
 * CloudHome owns "/" — the vanilla home-boot redirect that sends a bare
 * multi-project "/" to the /projects landing, else renders the open HomePage).
 */
import type { ComponentType } from "react";
import { accountMenu, fetchIdentity } from "./cloud/identity";
import { ProjectsPage } from "./cloud/projects/ProjectsPage";
import { CloudHome } from "./cloud/projects/homeGate";
import { MetricsPage } from "./cloud/metrics/MetricsPage";
import { GitHubPage } from "./cloud/github/GitHubPage";
import { DevicePage } from "./cloud/device/DevicePage";
import { MembersPage } from "./cloud/members/MembersPage";
// Importing the appearance module also runs its module-level boot hook
// (restore the persisted data-skin + kick the /api/prefs sync) at app boot.
import { AppearanceSection } from "./cloud/settings/AppearanceSection";
import { ProviderKeysSection } from "./cloud/settings/ProviderKeysSection";
import { PairingButton, PairingSection } from "./cloud/settings/pairing";

export interface ExtensionRoute {
  path: string;
  element: ComponentType;
}

export interface ExtensionNavItem {
  key: string;
  href: string;
  ico: string;
  label: string;
  count?: (snap: import("./types").Snapshot | null) => number | null;
  attn?: boolean;
}

// Identity + account-menu seam. NOTE: these three declarations are being added
// to open Orcha's extensions.ts upstream in exactly this shape — added here
// ahead of the vendored copy so the next upstream sync is a no-op diff on the
// contract. Open's Shell does not consume them in this repo's copy yet, so
// they are inert until that sync.
export interface Identity {
  agent_id?: string | null;
  alias?: string | null;
  github_login?: string | null;
  member_role?: string | null;
  avatar_url?: string | null;
  grants?: string[] | null; // mig 039 per-member grants (owner implies all)
}

export interface AccountMenuItem {
  label: string;
  href?: string;
  onClick?: () => void;
  danger?: boolean;
}

// Settings-section + topbar-action seam. NOTE: like the identity seam above,
// these declarations match what open Orcha's extensions.ts carries upstream in
// EXACTLY this shape — added here ahead of the vendored copy so the next
// upstream sync is a no-op diff on the contract. The vendored SettingsPage/
// Shell in this repo may not consume them yet; they are inert until that sync.
export interface SettingsSection { key: string; element: ComponentType } // renders its own <div className="card">…

export interface Extensions {
  routes: ExtensionRoute[];
  nav: ExtensionNavItem[];
  identity?: (cid: string | null) => Promise<Identity | null>;
  accountMenu?: (identity: Identity | null) => AccountMenuItem[];
  settingsSections?: SettingsSection[];
  topbarActions?: ComponentType[];   // rendered in the topbar between the notification pill and the autonomy switch
}

export const extensions: Extensions = {
  routes: [
    { path: "/", element: CloudHome },
    { path: "/projects", element: ProjectsPage },
    { path: "/metrics", element: MetricsPage },
    { path: "/github", element: GitHubPage },
    { path: "/auth/device", element: DevicePage },   // matches the backend page route
    { path: "/members", element: MembersPage },
  ],
  nav: [
    { key: "projects", href: "/projects", ico: "home", label: "Projects" },
    { key: "metrics", href: "/metrics", ico: "live", label: "Metrics" },
    { key: "github", href: "/github", ico: "link", label: "GitHub" },
  ],
  // The /api/me layer + the sign-out account menu (src/cloud/identity.ts —
  // vanilla data.js fetchMe / app-shell.js actingMenuHtml, ported).
  identity: fetchIdentity,
  accountMenu,
  // Cloud settings cards (vanilla settings.html parity: appearance skin picker,
  // per-provider API keys, phone pairing) + the topbar pairing button.
  settingsSections: [
    { key: "appearance", element: AppearanceSection },
    { key: "provider-keys", element: ProviderKeysSection },
    { key: "pairing", element: PairingSection },
  ],
  topbarActions: [PairingButton],
};
