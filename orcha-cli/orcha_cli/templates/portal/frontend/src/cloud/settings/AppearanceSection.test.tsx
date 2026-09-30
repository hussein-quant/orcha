/**
 * AppearanceSection (legacy settings key `appearance`) — Orcha V2 is
 * dark-only (parity P-12, intentional change):
 *  - the section renders the Interface content: no theme radios, no skin tiles;
 *  - bootAppearance() still runs the once-per-load /api/prefs sync but never
 *    applies data-skin / data-theme;
 *  - stored preferences (localStorage + server bag) are kept, never deleted,
 *    and are disclosed as "kept on file" when they differ from the V2 look.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as prefs from "../projects/prefs";
import { AppearanceSection, bootAppearance } from "./AppearanceSection";
import { legacyNote } from "../../pages/settings/InterfaceSection";

interface Call { url: string; method: string }

function stubFetch(serverPrefs: Record<string, string> | null): Call[] {
  const calls: Call[] = [];
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method || "GET" });
    return { ok: true, status: 200, json: async () => ({ prefs: serverPrefs }) } as unknown as Response;
  }) as unknown as typeof fetch;
  return calls;
}

describe("AppearanceSection — dark-only Interface (V2)", () => {
  beforeEach(() => {
    localStorage.clear();
    prefs._resetForTests();
    document.documentElement.removeAttribute("data-skin");
    document.documentElement.setAttribute("data-theme", "dark");
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("renders no theme or skin pickers and no Appearance non-setting group", () => {
    stubFetch(null);
    render(<AppearanceSection />);
    expect(screen.queryByText(/Orcha uses one dark appearance everywhere/)).toBeNull();
    expect(screen.queryByRole("heading", { name: "Appearance" })).toBeNull();
    expect(document.querySelector("#legacyAppearance")).toBeNull(); // nothing stored → no note
    expect(screen.queryByRole("radiogroup", { name: "Theme" })).toBeNull();
    expect(document.querySelector("#skinGrid")).toBeNull();
    expect(document.querySelector(".skin-tile")).toBeNull();
    expect(document.querySelector('.set-keys[aria-label="Keyboard shortcuts"]')).not.toBeNull();
    // no decorative swatches that read as unchecked checkboxes
    expect(document.querySelector(".set-swatch")).toBeNull();
    // dark-only is not a setting: no fake "Theme" row with a value
    expect(screen.queryByText("Dark (the only theme)")).toBeNull();
  });

  it("bootAppearance syncs /api/prefs but never applies a stored skin or theme", async () => {
    localStorage.setItem("orcha:skin", "gold");
    localStorage.setItem("orcha:theme", "light");
    const calls = stubFetch({ theme: "light", skin: "swiss" });
    bootAppearance();
    await prefs.sync();
    expect(calls.some((c) => c.url === "/api/prefs" && c.method === "GET")).toBe(true);
    expect(document.documentElement.hasAttribute("data-skin")).toBe(false);
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    // stored values are kept (server wins on sync), not deleted
    expect(localStorage.getItem("orcha:skin")).toBe("swiss");
    expect(localStorage.getItem("orcha:theme")).toBe("light");
  });

  it("discloses a stored non-default choice as kept on file", () => {
    stubFetch(null);
    localStorage.setItem("orcha:theme", "light");
    localStorage.setItem("orcha:skin", "gold");
    render(<AppearanceSection />);
    expect(screen.getByText(/light theme, Gold design\) is kept on file but no longer changes the look/)).toBeInTheDocument();
    // reading it did not mutate storage
    expect(localStorage.getItem("orcha:theme")).toBe("light");
    expect(localStorage.getItem("orcha:skin")).toBe("gold");
  });

  it("legacyNote: dark + classic (or nothing) needs no disclosure", () => {
    expect(legacyNote({ theme: "dark", skin: null })).toBeNull();
    expect(legacyNote({ theme: "dark", skin: "classic" })).toBeNull();
    expect(legacyNote({ theme: "auto", skin: null })).toMatch(/auto theme/);
    expect(legacyNote({ theme: "dark", skin: "swiss" })).toMatch(/Swiss design/);
  });
});
