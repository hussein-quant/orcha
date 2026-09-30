/**
 * ORCHA CLOUD — the settings section registered under the legacy key
 * `appearance` (extensions.settingsSections). Orcha V2 is DARK-ONLY, so it
 * now renders the shared Interface section (pages/settings/InterfaceSection):
 * no theme or skin pickers.
 *
 * Stored-preference contract (docs/orcha-v2-design-system.md §2.2):
 *  - localStorage `orcha:theme` / `orcha:skin` and the per-user `/api/prefs`
 *    bag (mig 040) keep their values — read-tolerant, never deleted, still
 *    mirrored by src/cloud/projects/prefs.ts — but are never APPLIED.
 *  - bootAppearance() (run at import; this module is imported from
 *    extensions.ts) only kicks the once-per-load /api/prefs sync so the
 *    default-project star and sidebar pref keep working. It no longer sets
 *    data-skin on <html> (V2 CSS ignores it; index.html/initTheme strip it).
 */
import * as prefs from "../projects/prefs";
import { InterfaceSection } from "../../pages/settings/InterfaceSection";
import "./settings-cards.css";

export function bootAppearance(): void {
  try { void prefs.sync(); } catch { /* no fetch (harness) — localStorage only */ }
}
bootAppearance();

export function AppearanceSection() {
  return <InterfaceSection />;
}
