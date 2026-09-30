/**
 * Settings › Interface (Orcha V2, arch §2.3 key `interface`, alias
 * `appearance`). V2 is DARK-ONLY: the theme (auto/dark/light) and skin
 * (classic/swiss/minimal/gold) pickers are retired. Stored preferences —
 * localStorage `orcha:theme` / `orcha:skin` and the `/api/prefs` bag — are
 * read here only to tell the user what their earlier choice was; they are
 * never applied, rewritten or deleted (rollback / older builds keep them).
 *
 * There is no Appearance group: one dark look is not a choice (review r2).
 * Everything shown is real: the keyboard shortcuts are the ones the V2 shell
 * binds (shell/chrome.tsx, components/primitives/List.tsx), and the sidebar
 * note describes the shell's persisted width / collapse behavior.
 */
import { useEffect, useState } from "react";
import { SettingRow, SettingRows, SettingsGroup } from "./settingsUi";
import * as prefs from "../../cloud/projects/prefs";
import { RAIL_TOGGLE_KEY } from "../../shell/nav";

const SKIN_NAMES: Record<string, string> = {
  classic: "Classic", swiss: "Swiss", minimal: "Minimalist", gold: "Gold",
};

/** The stored pre-V2 appearance choice, for disclosure only (never applied). */
export function legacyAppearance(): { theme: string; skin: string | null } {
  let skin: string | null = null;
  let theme = "";
  try {
    skin = localStorage.getItem("orcha:skin");
    theme = localStorage.getItem("orcha:theme") || ""; // "" = never chosen
  } catch { /* private mode */ }
  return { theme, skin };
}

/** Human copy for a stored choice that differs from the V2 look, else null. */
export function legacyNote(p: { theme: string; skin: string | null }): string | null {
  const parts: string[] = [];
  if (p.theme && p.theme !== "dark" && p.theme !== "auto") parts.push(`${p.theme} theme`);
  if (p.theme === "auto") parts.push("auto theme (follow system)");
  if (p.skin && p.skin !== "classic") parts.push(`${SKIN_NAMES[p.skin] || p.skin} design`);
  if (!parts.length) return null;
  return `Your earlier choice (${parts.join(", ")}) is kept on file but no longer changes the look.`;
}

const SHORTCUTS: [string, string][] = [
  ["⌘K / Ctrl+K", "Search and commands in this project (not inside code editors or terminals)"],
  ["/", "Open search when you are not typing in a field"],
  ["C", "Create a new task when you are not typing"],
  ["↑ ↓", "Move between rows in a list; Enter opens the focused row"],
  ["Esc", "Close the open dialog, menu or search and return focus"],
  [RAIL_TOGGLE_KEY, "Collapse or expand the sidebar when you are not typing"],
];

/**
 * Where the sidebar layout is kept (pure, tested; IF-RAIL-COLLAPSE). With
 * account prefs active (/api/prefs non-null) the collapsed/expanded state is
 * part of the synced bag (prefs.localPrefs "sidebar"); the drag width is not.
 */
export function sidebarStorageNote(accountPrefs: boolean): string {
  return accountPrefs ? "Collapse saved to your account · width in this browser" : "Saved in this browser";
}

export function InterfaceSection() {
  const note = legacyNote(legacyAppearance());
  const [accountPrefs, setAccountPrefs] = useState(prefs.active());
  useEffect(() => {
    let alive = true;
    void prefs.sync().then(() => { if (alive) setAccountPrefs(prefs.active()); });
    return () => { alive = false; };
  }, []);
  return (
    <>
      {/* Dark-only is not a setting, so there is no Appearance group (D12).
          The one truthful disclosure left is an older stored theme/skin that
          no longer applies — a single muted line, only when it exists. */}
      {note ? <p className="set-note set-legacy" id="legacyAppearance" data-settab="interface">{note}</p> : null}
      <SettingsGroup settab="interface" title="Sidebar" flush>
        <SettingRows>
          <SettingRow
            label="Width and collapse"
            desc="Drag the sidebar edge to resize, or collapse it to icons."
          >
            <span className="set-note" id="setSidebarStore">{sidebarStorageNote(accountPrefs)}</span>
          </SettingRow>
          <SettingRow label="Favorites" desc="Pinned projects and their order.">
            <span className="set-note">Saved in this browser</span>
          </SettingRow>
        </SettingRows>
      </SettingsGroup>
      <SettingsGroup settab="interface" title="Keyboard shortcuts" flush>
        <dl className="set-keys" aria-label="Keyboard shortcuts">
          {SHORTCUTS.map(([k, d]) => (
            <div className="set-key" key={k}>
              <dt>{k.split(" / ").map((part, i) => (
                <span key={part}>{i > 0 ? <span className="set-key-or">or</span> : null}<kbd>{part}</kbd></span>
              ))}</dt>
              <dd>{d}</dd>
            </div>
          ))}
        </dl>
      </SettingsGroup>
    </>
  );
}
