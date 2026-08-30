/**
 * Agents page port tests: roster renders from a stubbed snapshot, the ?agent=
 * deep link selects, and a human-gated mutation posts the exact vanilla body.
 */
import { cleanup, render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ToastProvider } from "../../components/ui";
import { SnapshotProvider } from "../../state/SnapshotProvider";
import { AgentsPage } from "./AgentsPage";

interface Call {
  url: string;
  init?: RequestInit;
}
let calls: Call[] = [];

const RAW_SNAPSHOT = {
  container: { id: "c1", name: "Orcha", status: "active", autonomy_level: "plan" },
  agents: [
    { id: "h1", alias: "kedar", kind: "human", role: "Founder", status: "idle" },
    {
      id: "a1", alias: "forge", kind: "ai", role: "Builder", status: "working",
      model: "claude-sonnet-4-6", wake_enabled: true, auto_wake_interval_secs: null,
      prompt_preview: "You are Forge.", embodiment: "idle",
    },
    { id: "a2", alias: "scout", kind: "ai", role: "Researcher", status: "idle", model: "claude-opus-4-8" },
  ],
  tasks: [],
  requests: [],
};

function jsonRes(data: unknown) {
  return { ok: true, status: 200, json: async () => data } as Response;
}

function stubFetch() {
  calls = [];
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    calls.push({ url, init });
    if (url === "/api/containers") return jsonRes([{ id: "c1", status: "active" }]);
    if (url.startsWith("/api/containers/c1")) return jsonRes(RAW_SNAPSHOT);
    if (url === "/api/models") return jsonRes({ models: [] }); // keep the seeded curated list
    if (url.includes("/digest")) return jsonRes({ digest: null });
    if (url.includes("/runs")) return jsonRes({ runs: [] });
    if (url.includes("/conversation")) return jsonRes({ conversation: null, turns: [] });
    if (url.includes("/persona")) return jsonRes({ system_prompt: "full prompt" });
    return jsonRes({});
  }) as unknown as typeof fetch;
}

function mount(initialPath = "/agents") {
  return render(
    <ToastProvider>
      <SnapshotProvider>
        <MemoryRouter initialEntries={[initialPath]}>
          <Routes>
            <Route path="/agents" element={<AgentsPage />} />
            <Route path="*" element={<AgentsPage />} />
          </Routes>
        </MemoryRouter>
      </SnapshotProvider>
    </ToastProvider>,
  );
}

describe("AgentsPage (vanilla agents.html parity)", () => {
  beforeEach(() => {
    stubFetch();
    localStorage.clear();
    sessionStorage.clear();
  });
  afterEach(() => {
    cleanup(); // vitest globals are off, so RTL's auto-cleanup never registers
    vi.restoreAllMocks();
  });

  it("renders the roster from a stubbed snapshot and selects the first AI agent", async () => {
    const { container } = mount();
    // roster header + all three agents
    await screen.findByText("Roster · 3");
    const roster = container.querySelector(".roster-card") as HTMLElement;
    expect(roster).toBeTruthy();
    expect(within(roster).getByText("kedar")).toBeInTheDocument();
    expect(within(roster).getByText("forge")).toBeInTheDocument();
    expect(within(roster).getByText("scout")).toBeInTheDocument();
    // default selection = first non-human agent (forge): roster row marked .sel
    const sel = roster.querySelector(".rrow.sel");
    expect(sel).toBeTruthy();
    expect(sel!.textContent).toContain("forge");
    // detail header shows the selected agent
    const h1 = container.querySelector(".ahead .who h1");
    expect(h1?.textContent).toContain("forge");
  });

  it("deep link ?agent= selects that agent (ISS-38)", async () => {
        const { container } = mount("/agents?agent=scout");
    await screen.findByText("Roster · 3");
    const roster = container.querySelector(".roster-card") as HTMLElement;
    const sel = roster.querySelector(".rrow.sel");
    expect(sel).toBeTruthy();
    expect(sel!.textContent).toContain("scout");
    const h1 = container.querySelector(".ahead .who h1");
    expect(h1?.textContent).toContain("scout");
  });

  it("roster click swaps the detail pane to the clicked agent", async () => {
    const { container } = mount();
    await screen.findByText("Roster · 3");
    const roster = container.querySelector(".roster-card") as HTMLElement;
    fireEvent.click(within(roster).getByText("scout"));
    await waitFor(() => {
      const h1 = container.querySelector(".ahead .who h1");
      expect(h1?.textContent).toContain("scout");
    });
    expect(roster.querySelector(".rrow.sel")?.textContent).toContain("scout");
  });

  it("model switch POSTs the exact vanilla body to /api/agents/{id}/model", async () => {
    mount();
    await screen.findByText("Roster · 3");
    // forge (a1) is selected; its model is sonnet — click the Opus chip
    const btn = await screen.findByTitle("Opus 4.8");
    fireEvent.click(btn);
    await waitFor(() => {
      const call = calls.find((c) => c.url === "/api/agents/a1/model" && c.init?.method === "POST");
      expect(call).toBeTruthy();
      expect(call!.init!.body).toBe(JSON.stringify({ model: "claude-opus-4-8" }));
    });
  });

  it("auto-wake PATCH carries the acting-human id (#300)", async () => {
    mount();
    await screen.findByText("Roster · 3");
    fireEvent.click(await screen.findByText("15m"));
    await waitFor(() => {
      const call = calls.find((c) => c.url === "/api/agents/a1/auto-wake" && c.init?.method === "PATCH");
      expect(call).toBeTruthy();
      expect(call!.init!.body).toBe(JSON.stringify({ actor_agent_id: "h1", interval_secs: 900 }));
    });
  });

  it("the live-terminal affordance is the REAL pairing control (classic fallback gone)", async () => {
    const { container } = mount();
    await screen.findByText("Roster · 3");
    const pair = container.querySelector("#convPair") as HTMLButtonElement;
    expect(pair).toBeTruthy();
    expect(pair.disabled).toBe(false); // live pairing, no longer a disabled stub
    expect(pair.title).toBe("Pair in a live terminal as forge");
    expect(pair.textContent).toContain("Pair in terminal");
    expect(screen.queryByText("Classic portal")).toBeNull(); // the vanilla-page pointer is deleted
  });
});
