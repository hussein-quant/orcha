/**
 * GH#74 — thread error state (pytest pointer: tests/test_gh74_thread_error_state.py).
 *
 * A failed conversation fetch must surface the VISIBLE "Conversation unavailable."
 * state — never a perpetual "Loading conversation…" spinner, never a blank panel —
 * and the panel must recover in place once the endpoint heals (the 3s poll cadence
 * re-runs load() while no conversation id is resolved), without a full page reload.
 */
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui";
import { SnapshotProvider } from "../../state/SnapshotProvider";
import type { Agent } from "../../types";
import { Conversation } from "./Conversation";

const RAW_SNAPSHOT = {
  container: { id: "c1", name: "Orcha", status: "active", autonomy_level: "plan" },
  agents: [
    { id: "h1", alias: "kedar", kind: "human", role: "Founder", status: "idle" },
    // Conversation keeps a module-level per-agent cache — each test uses a
    // cache-cold agent id so a previous test's turns can't leak in.
    { id: "e1", alias: "Flaky", kind: "ai", role: "Builder", status: "idle" },
    { id: "e2", alias: "Heals", kind: "ai", role: "Builder", status: "idle" },
  ],
  tasks: [],
  requests: [],
};
const AGENT_FAIL = RAW_SNAPSHOT.agents[1] as unknown as Agent;
const AGENT_HEAL = RAW_SNAPSHOT.agents[2] as unknown as Agent;

const jsonRes = (data: unknown) => ({ ok: true, status: 200, json: async () => data }) as Response;
const errRes = () => ({ ok: false, status: 500, json: async () => ({}) }) as Response;

// convFails: while true, the per-agent conversation fetch 500s; flip it off to heal.
const state = { convFails: true };

function stubFetch() {
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    if (url === "/api/containers") return jsonRes([{ id: "c1", status: "active" }]);
    if (url.startsWith("/api/containers/c1")) return jsonRes(RAW_SNAPSHOT);
    if (url.includes("/conversation?limit=")) {
      if (state.convFails) return errRes();
      return jsonRes({
        conversation: { id: "cH", status: "active" },
        turns: [{ seq: 1, role: "agent", content: "back online", created_at: "2026-08-01T00:00:00Z" }],
      });
    }
    return jsonRes({});
  }) as unknown as typeof fetch;
}

function mount(agent: Agent) {
  return render(
    <ToastProvider>
      <SnapshotProvider>
        <Conversation key={agent.id} agent={agent} />
      </SnapshotProvider>
    </ToastProvider>,
  );
}

describe("GH#74 conversation thread error state", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    state.convFails = true;
    stubFetch();
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("a failed fetch surfaces 'Conversation unavailable.' — not a perpetual spinner, not a blank panel", async () => {
    const { container } = mount(AGENT_FAIL);
    await waitFor(() => expect(container.textContent).toContain("Conversation unavailable."));
    // the latch REPLACES the spinner (the exact GH#74 bug shape was an eternal spinner)
    expect(container.textContent).not.toContain("Loading conversation…");
    // …and it's an honest error, never a fake-empty thread
    expect(container.textContent).not.toContain("No messages yet");
    // the panel fails open: the composer is still mounted (not a dead screen)
    expect(container.querySelector("#convInput")).toBeTruthy();
  });

  it(
    "recovers in place on the poll cadence once the endpoint heals — no page reload",
    async () => {
      const { container } = mount(AGENT_HEAL);
      await waitFor(() => expect(container.textContent).toContain("Conversation unavailable."));

      state.convFails = false; // the backend heals; the 3s poll() falls back to load()
      await waitFor(() => expect(container.textContent).toContain("back online"), { timeout: 4500 });
      // the latch cleared with it
      expect(container.textContent).not.toContain("Conversation unavailable.");
    },
    10_000,
  );
});
