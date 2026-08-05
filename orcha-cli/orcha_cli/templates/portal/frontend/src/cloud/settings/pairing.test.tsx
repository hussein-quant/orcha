/**
 * Pairing entry points — the topbar PairingButton (topbarActions seam) and the
 * settings PairingSection both render their vanilla markup and open the shared
 * PairingModal against the loaded container. fetch is stubbed; snapshot flows
 * through the real SnapshotProvider, matching MembersPage.test.tsx style.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui";
import { SnapshotProvider } from "../../state/SnapshotProvider";
import { resetIdentity } from "../identity";
import { PairingButton, PairingSection } from "./pairing";

interface Call { url: string; method: string }

const rawSnap = {
  container: { id: "c1", name: "Orcha", status: "active", autonomy_level: "plan" },
  agents: [{ id: "h1", alias: "kedar", kind: "human", status: "idle" }],
  tasks: [],
  requests: [],
};

const payload = {
  baseUrl: "http://192.168.1.20:80",
  humanAgentId: "h1",
  humanAgentAlias: "kedar",
  qrSvg: "<svg></svg>",
  shortCode: "ABCD-1234",
  expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
};

function stubFetch(): Call[] {
  const calls: Call[] = [];
  const json = (data: unknown, status = 200) =>
    ({ ok: status < 400, status, json: async () => data }) as unknown as Response;
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method || "GET" });
    if (url === "/api/containers") return json([{ id: "c1", status: "active" }]);
    if (url.startsWith("/api/me")) return json({ identity: null, trusted: false });
    if (url.startsWith("/api/containers/c1/pairing")) return json(payload);
    if (url.startsWith("/api/containers/c1")) return json(rawSnap);
    return json({});
  }) as unknown as typeof fetch;
  return calls;
}

function mount(el: ReactElement) {
  return render(
    <ToastProvider>
      <SnapshotProvider>{el}</SnapshotProvider>
    </ToastProvider>,
  );
}

describe("pairing entry points (shared PairingModal reuse)", () => {
  beforeEach(() => { localStorage.clear(); resetIdentity(); });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("topbar button renders the vanilla markup and opens the modal (cid-scoped pairing GET)", async () => {
    const calls = stubFetch();
    mount(<PairingButton />);
    const btn = await screen.findByRole("button", { name: /Pair phone/ });
    expect(btn.id).toBe("pairPhoneBtn");
    expect(btn.className).toBe("btn sm subtle pair-top");
    expect(btn.getAttribute("title")).toBe("Pair a phone with this Orcha");
    // no modal until the button is pressed
    expect(screen.queryByText("Pair your phone")).not.toBeInTheDocument();
    // cid resolves async (SnapshotProvider) — wait for the loaded container
    await vi.waitFor(() => {
      fireEvent.click(btn);
      expect(screen.getByText("Pair your phone")).toBeInTheDocument();
    });
    // the payload comes from the PATH-cid pairing endpoint of the LOADED container
    expect(await screen.findByText("ABCD-1234")).toBeInTheDocument();
    expect(calls.some((c) => c.url === "/api/containers/c1/pairing")).toBe(true);
    // vanilla topbar open passes no opts.name — no "Project:" line
    expect(screen.queryByText(/Project:/)).not.toBeInTheDocument();
  });

  it("settings card renders the vanilla banner + hint and its button opens the same modal", async () => {
    stubFetch();
    mount(<PairingSection />);
    expect(await screen.findByText("Phone pairing")).toBeInTheDocument();
    expect(screen.getByText("Open the same pairing code that is available from the top bar.")).toBeInTheDocument();
    expect(screen.getByText("Your phone talks directly to this computer on your network. Nothing goes through the cloud.")).toBeInTheDocument();
    const btn = screen.getByRole("button", { name: /Pair phone/ });
    expect(btn.id).toBe("settingsPairPhone");
    await vi.waitFor(() => {
      fireEvent.click(btn);
      expect(screen.getByText("Pair your phone")).toBeInTheDocument();
    });
    expect(await screen.findByText("ABCD-1234")).toBeInTheDocument();
  });
});
