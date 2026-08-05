/**
 * ORCHA CLOUD extension registry — the one open-frontend file Cloud owns.
 * Upstream sync contract: copy frontend/src/** from open Orcha verbatim
 * EXCEPT this file and src/cloud/**. Cloud premium pages register here;
 * a route sharing a path with an open page REPLACES it (access model:
 * CloudHome owns "/" — the vanilla home-boot redirect that sends a bare
 * multi-project "/" to the /projects landing, else renders the open HomePage).
 */
import type { ComponentType } from "react";
import { ProjectsPage } from "./cloud/projects/ProjectsPage";
import { CloudHome } from "./cloud/projects/homeGate";
import { MetricsPage } from "./cloud/metrics/MetricsPage";
import { GitHubPage } from "./cloud/github/GitHubPage";
import { DevicePage } from "./cloud/device/DevicePage";
import { MembersPage } from "./cloud/members/MembersPage";

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

export interface Extensions {
  routes: ExtensionRoute[];
  nav: ExtensionNavItem[];
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
};
