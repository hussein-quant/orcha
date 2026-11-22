import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";

const context = vi.hoisted(() => ({ cid: "project", bump: 0, connection: "live", snap: { agents: [] } }));
const authority = vi.hoisted(() => ({ human: { id: "owner", kind: "human", member_role: "owner" } }));
vi.mock("../../state/SnapshotProvider", async (original) => ({ ...await original<typeof import("../../state/SnapshotProvider")>(), useSnapshot: () => context, useActingAuthority: () => authority }));
import { ReleaseHome } from "./ReleaseHome";

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const inventory = {
  state: "ready", summary: "ios: 2 changes", read_at: new Date().toISOString(), cached: false, command: "python3 inv.py",
  data: {
    platforms: {
      ios: { last_release: { tag: "ios/1.0.1-7" }, live: { version: "1.0.1" }, in_flight: { state: "ready_for_sale" },
        changes: [{ sha: "a1", pr: 96, title: "Broker fee as a percentage" }], next: { version: "1.0.2", build: 8, reason: "next version" } },
      android: { last_release: { tag: "android/1.0.19-19" }, live: { version: "1.0.19" }, changes: [], next: { version: "1.0.20", build: 20 } },
    },
    open_prs: [{ number: 100, title: "Adapters", url: "https://example.test/100", draft: true, branch: "x", platforms: ["ios"] }],
    release_params: { platforms: ["ios", "android"], version: "1.0.2", build: "8", android_version: "1.0.20", android_version_code: "20", batch_summary: "#96 Broker fee" },
  },
};

it("shows what's live and what's next, asks only the iOS release type, and starts with the inventory's numbers", async () => {
  const posts: { url: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (init?.method === "POST") posts.push({ url, body });
    if (url.includes("/inventory")) return json(inventory);
    if (url.endsWith("/compile")) return json({ problems: [], ready: true, steps: [], stages: [], loops: [], parameters: [], values: { release_label: "iOS 1.0.2 (8) · Android 1.0.20 (20)" },
      roles: [{ key: "owner", label: "Owner", kind: "human" }, { key: "release", label: "Release", kind: "ai" }],
      people: [{ id: "owner", alias: "Owner", kind: "human", role: null }, { id: "rel", alias: "ReleaseEngineer", kind: "ai", role: null }], template: {} });
    if (url.endsWith("/from-template")) return json({ id: "run" });
    return json({});
  }));
  render(<MemoryRouter initialEntries={["/workflows/new?cid=project&template=mobile_app_release&home=1"]}><Routes>
    <Route path="/workflows/new" element={<ReleaseHome />} /><Route path="/workflows/:id" element={<p>run page</p>} />
  </Routes></MemoryRouter>);
  expect(await screen.findByText("1.0.1")).toBeVisible();
  expect(screen.getByText("Broker fee as a percentage")).toBeVisible();
  expect(screen.getByText("Adapters")).toBeVisible();
  const start = screen.getByRole("button", { name: /Start the release/ });
  await waitFor(() => expect(screen.getByText("Choose how iOS is released.")).toBeVisible());
  expect(start).toBeDisabled();
  expect(screen.getByLabelText("Release")).toHaveValue("rel"); // guessed from the agent's name
  fireEvent.click(screen.getByRole("radio", { name: "I release it by hand" }));
  await waitFor(() => expect(start).toBeEnabled());
  fireEvent.click(start);
  expect(await screen.findByText("run page")).toBeVisible();
  const create = posts.find((p) => p.url.endsWith("/from-template"))!;
  expect(create.body.params).toMatchObject({ version: "1.0.2", build: "8", android_version: "1.0.20", android_version_code: "20", release_type: "manual" });
  expect(create.body.roles).toMatchObject({ release: "rel", owner: "owner" });
});

it("says whether production and staging run the latest commit, and keeps a plain live badge when no commit is stamped", async () => {
  const withDeploys = { ...inventory, data: { ...inventory.data, platforms: { ...inventory.data.platforms,
    web: { last_release: { tag: "web/2026-11-21" }, changes: [],
      live: { url: "https://example.test/", build_id: "crPmX8RH_cGkRZPo28TCS", commit: "65cb32e65b25", behind: 0, deployed_at: "2026-11-21T18:15:00Z" },
      staging: { url: "https://staging.example.test/", build_id: "5KSQ78bqn9C", commit: "04a26816967017", behind: 3 } },
    api: { last_release: { tag: "api/2026-11-21" }, changes: [], live: null } } } };
  vi.stubGlobal("fetch", vi.fn(async (url: string) => url.includes("/inventory") ? json(withDeploys)
    : url.endsWith("/compile") ? json({ problems: [], ready: true, steps: [], stages: [], loops: [], parameters: [], values: {}, roles: [], people: [], template: {} }) : json({})));
  render(<MemoryRouter initialEntries={["/workflows/new?cid=project&template=mobile_app_release&home=1"]}><Routes>
    <Route path="/workflows/new" element={<ReleaseHome />} /></Routes></MemoryRouter>);
  const web = await screen.findByRole("article", { name: "Web" });
  expect(web).toHaveTextContent("Production");
  expect(web).toHaveTextContent("Up to date");
  expect(web).toHaveTextContent("65cb32e");
  expect(web).toHaveTextContent("3 behind main");
  expect(screen.getByRole("article", { name: "API" })).toHaveTextContent("Not checked yet");
  expect(screen.getByRole("article", { name: "iOS" })).toHaveTextContent("Last submission");
});
