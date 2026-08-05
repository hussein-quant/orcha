/**
 * ProviderKeysSection — masked render from the provider-keys GET (Anthropic
 * filtered out) and the exact human-gated mutation bodies against the
 * provider-scoped routes. fetch is stubbed; snapshot flows through the real
 * SnapshotProvider + mapSnapshot, matching MembersPage.test.tsx style.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui";
import { SnapshotProvider } from "../../state/SnapshotProvider";
import { resetIdentity } from "../identity";
import { ProviderKeysSection } from "./ProviderKeysSection";

interface Call { url: string; method: string; body: unknown }

const rawSnap = {
  container: { id: "c1", name: "Orcha", status: "active", autonomy_level: "plan" },
  agents: [
    { id: "h1", alias: "kedar", kind: "human", status: "idle" },
    { id: "a1", alias: "forge", kind: "ai", status: "working" },
  ],
  tasks: [],
  requests: [],
};

const keys = {
  keys: [
    { provider: "anthropic", name: "Anthropic", configured: true, masked: "sk-...zzzz", source: "db" },
    { provider: "xai", name: "xAI (Grok)", configured: true, masked: "sk-...abcd", source: "db" },
  ],
};

function stubFetch(overrides: { keys?: unknown } = {}): Call[] {
  const calls: Call[] = [];
  const json = (data: unknown, status = 200) =>
    ({ ok: status < 400, status, json: async () => data }) as unknown as Response;
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      method: init?.method || "GET",
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    if (url === "/api/containers") return json([{ id: "c1", status: "active" }]);
    if (url.startsWith("/api/me")) return json({ identity: null, trusted: false });
    if (url === "/api/containers/c1/settings/provider-keys") return json(overrides.keys ?? keys);
    if (url.startsWith("/api/containers/c1/settings/provider-keys/")) return json({ ok: true });
    if (url.startsWith("/api/containers/c1")) return json(rawSnap);
    return json({});
  }) as unknown as typeof fetch;
  return calls;
}

function mount() {
  return render(
    <ToastProvider>
      <SnapshotProvider>
        <ProviderKeysSection />
      </SnapshotProvider>
    </ToastProvider>,
  );
}

describe("ProviderKeysSection (wire-contract render)", () => {
  beforeEach(() => { localStorage.clear(); resetIdentity(); });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("renders the masked DB key from GET …/settings/provider-keys and filters Anthropic out", async () => {
    stubFetch();
    mount();
    // db-mode banner: masked form straight from the GET
    expect(await screen.findByText("sk-...abcd")).toBeInTheDocument();
    expect(screen.getByText("xAI (Grok) API key configured")).toBeInTheDocument();
    // Anthropic keeps its own dedicated card — never rendered here
    expect(screen.queryByText("sk-...zzzz")).not.toBeInTheDocument();
    expect(document.querySelectorAll(".pk-card").length).toBe(1);
    expect(document.querySelector(".pk-card")!.getAttribute("data-provider")).toBe("xai");
    // db mode affordances: replace + test + remove, input in replace mode
    expect(screen.getByPlaceholderText("Paste a new key to replace…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Replace key/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Remove/ })).toBeInTheDocument();
  });

  it("unset provider renders the warn banner and Save affordance", async () => {
    stubFetch({ keys: { keys: [{ provider: "xai", name: "xAI (Grok)", configured: false, masked: null, source: null }] } });
    mount();
    expect(await screen.findByText("No xAI (Grok) API key configured.")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Paste xAI (Grok) API key…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Save key/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Remove/ })).not.toBeInTheDocument();
  });

  it("Save PUTs {api_key, actor_agent_id} to …/settings/provider-keys/xai (byte-exact body)", async () => {
    const calls = stubFetch();
    mount();
    await screen.findByText("sk-...abcd");
    fireEvent.change(screen.getByPlaceholderText("Paste a new key to replace…"), {
      target: { value: "sk-xai-new-123" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Replace key/ }));
    await waitFor(() => {
      const put = calls.find(
        (c) => c.url === "/api/containers/c1/settings/provider-keys/xai" && c.method === "PUT",
      );
      expect(put).toBeTruthy();
      // exact vanilla body (actor = trust-off fallback human via memActor)
      expect(put!.body).toEqual({ api_key: "sk-xai-new-123", actor_agent_id: "h1" });
    });
    // success path reloads the key list from the server
    await waitFor(() => {
      const gets = calls.filter(
        (c) => c.url === "/api/containers/c1/settings/provider-keys" && c.method === "GET",
      );
      expect(gets.length).toBeGreaterThan(1);
    });
  });

  it("Test POSTs to …/provider-keys/xai/test — pasted key rides in the body, stored key omits api_key", async () => {
    const calls = stubFetch();
    mount();
    await screen.findByText("sk-...abcd");
    // no typed value + configured key: Test fires with actor only (server tests the stored key)
    fireEvent.click(screen.getByRole("button", { name: /^Test$/ }));
    await waitFor(() => {
      const post = calls.find(
        (c) => c.url === "/api/containers/c1/settings/provider-keys/xai/test" && c.method === "POST",
      );
      expect(post).toBeTruthy();
      expect(post!.body).toEqual({ actor_agent_id: "h1" });
    });
    expect(await screen.findByText("Key is valid — xAI (Grok) accepted it.")).toBeInTheDocument();
  });
});
