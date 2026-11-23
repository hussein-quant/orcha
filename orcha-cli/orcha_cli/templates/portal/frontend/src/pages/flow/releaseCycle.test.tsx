import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";

const context = vi.hoisted(() => ({ cid: "project", bump: 0, connection: "live", snap: { agents: [] } }));
const authority = vi.hoisted(() => ({ human: { id: "owner", kind: "human", member_role: "owner" } }));
vi.mock("../../state/SnapshotProvider", async (original) => ({ ...await original<typeof import("../../state/SnapshotProvider")>(), useSnapshot: () => context, useActingAuthority: () => authority }));
import { ReleaseCycle } from "./ReleaseCycle";
import { ReleaseHome } from "./ReleaseHome";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const now = new Date().toISOString();
const ticket = (over: Record<string, unknown>) => ({
  id: "t", issue_number: null, issue_url: null, title: "", kind: "bug", platforms: ["ios"], source: "manual", state: "active",
  workflow_id: "w", rolled_from_cycle_id: null, created_at: now, word: "Building", tone: "running", merged: false, checked: false,
  needs_you: false, step: null, thread: [], done: 0, total: 4, workflow_status: "active", phase: "build", engineer: "Engineer", ...over,
});
const cycle = {
  id: "c1", container_id: "project", kind: "release", version: "1.0.3", branch: "release/1.0.3", base_branch: "main", milestone: "1.0.3", state: "open",
  platforms: ["ios", "android", "web", "api"], roles: { engineer: "eng" }, engineers: { ios: "iosdev" }, dry_run: false,
  branch_state: "created", branch_note: "release/1.0.3 was created on origin from main.", created_at: now, cut_at: null,
  release_workflow: null, next_cycle: null, previous_cycle: null,
  counts: { total: 3, merged: 1, checked: 1, needs_you: 1, building: 2 },
  cut: { ships: ["a"], rolls: ["b", "c"], platforms: ["ios"], unchecked: [], next_version: "1.0.4", next_branch: "release/1.0.4" },
  release_params: { source: "cycle", version: "1.0.3", release_branch: "release/1.0.3", next_release_branch: "release/1.0.4", platforms: ["ios"], batch_summary: "- #212 Login spinner (bug, iOS)" },
  tickets: [
    ticket({ id: "a", issue_number: 212, issue_url: "https://gh/212", title: "Login spinner", word: "Ready to ship", tone: "ok", merged: true, checked: true, workflow_id: "wa", phase: "ready", engineer: "IosEngineer" }),
    ticket({ id: "b", issue_number: 219, title: "Tenant referrals", kind: "feature", platforms: ["ios", "android", "api"], word: "Spec waiting for you", tone: "asking", needs_you: true, workflow_id: "wb", phase: "spec" }),
    ticket({ id: "c", title: "Back button closes the app", platforms: ["android"], word: "Building", workflow_id: "wc" }),
  ],
};
const people = [{ id: "owner", alias: "Owner", kind: "human", role: null }, { id: "eng", alias: "Engineer", kind: "ai", role: null }, { id: "iosdev", alias: "IosEngineer", kind: "ai", role: null }];
const compiled = { problems: [], ready: true, steps: [], stages: [], loops: [], parameters: [], values: { release_label: "1.0.3 (9)" }, roles: [], people, template: {} };

function mount(path: string) {
  render(<MemoryRouter initialEntries={[path]}><Routes>
    <Route path="/workflows/cycle" element={<ReleaseCycle />} /><Route path="/workflows/new" element={<ReleaseHome />} />
    <Route path="/workflows/:id" element={<p>run page</p>} />
  </Routes></MemoryRouter>);
}

it("shows the tickets on a board by stage; a card opens its run and links its GitHub issue", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.startsWith("/api/release-cycles/c1")) return json(cycle);
    if (url.endsWith("/compile")) return json(compiled);
    return json({});
  }));
  try { localStorage.removeItem("fl-cy-view"); } catch { /* none */ }
  mount("/workflows/cycle?cid=project&cycle=c1");
  const board = await screen.findByRole("list", { name: "Tickets by stage" });
  const col = (name: string) => within(within(board).getByRole("listitem", { name }));
  expect(col("Spec").getByText("Tenant referrals")).toBeVisible();
  expect(col("Building").getByText("Back button closes the app")).toBeVisible();
  expect(col("Ready to ship").getByText("Login spinner")).toBeVisible();
  expect(col("Waiting for your merge").getByText("Nothing here")).toBeVisible();
  expect(col("Ready to ship").getByText("IosEngineer")).toBeVisible();
  expect(col("Ready to ship").getByRole("link", { name: "Open #212 on GitHub" })).toHaveAttribute("href", "https://gh/212");
  fireEvent.click(col("Ready to ship").getByText("Login spinner"));
  expect(await screen.findByText("run page")).toBeVisible();
});

it("groups the tickets by what they wait for, and the cut says what ships and what rolls", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.startsWith("/api/release-cycles/c1")) return json(cycle);
    if (url.endsWith("/compile")) return json(compiled);
    return json({});
  }));
  mount("/workflows/cycle?cid=project&cycle=c1");
  expect(await screen.findByRole("heading", { name: /Release 1\.0\.3/ })).toBeVisible();
  fireEvent.click(screen.getByRole("radio", { name: "List" }));
  expect(screen.getByText("Branch created")).toBeVisible();
  const waiting = screen.getByRole("region", { name: "Waiting for you" });
  expect(within(waiting).getByText("Tenant referrals")).toBeVisible();
  expect(within(waiting).getByText("Spec waiting for you")).toBeVisible();
  expect(within(screen.getByRole("region", { name: "Being built" })).getByText("Back button closes the app")).toBeVisible();
  expect(within(screen.getByRole("region", { name: "In the branch" })).getByText("Login spinner")).toBeVisible();
  const bar = screen.getByRole("region", { name: "Cut the release" });
  expect(bar).toHaveTextContent("1 ticket ships on iOS · 2 move to 1.0.4");
  // The Android filter keeps only the tickets that touch Android.
  fireEvent.click(screen.getByRole("radio", { name: "Android" }));
  expect(screen.queryByText("Login spinner")).toBeNull();
  expect(screen.getByText("Back button closes the app")).toBeVisible();
  // A merged ticket can't be taken out; an unmerged one asks first.
  fireEvent.click(screen.getByRole("radio", { name: "All" }));
  expect(screen.queryByRole("button", { name: /Take #212 out/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /Take #219 out/ }));
  expect(screen.getByRole("button", { name: "Take it out" })).toBeVisible();
});

it("adds a ticket from its issue number with the platforms its labels name", async () => {
  const posts: { url: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") posts.push({ url, body: JSON.parse(String(init.body)) });
    if (url.includes("/github/issues/230")) return json({ number: 230, title: "Receipt shows the wrong month", body: "Dec shows Nov", url: "https://gh/230", labels: ["bug", "ios"], platforms: ["ios"], kind: "bug", kind_from_labels: true });
    if (url.endsWith("/tickets")) return json(cycle);
    if (url.startsWith("/api/release-cycles/c1")) return json(cycle);
    if (url.endsWith("/compile")) return json(compiled);
    return json({});
  }));
  mount("/workflows/cycle?cid=project&cycle=c1");
  fireEvent.click(await screen.findByRole("button", { name: /Add ticket/ }));
  fireEvent.change(screen.getByLabelText("GitHub issue"), { target: { value: "#230" } });
  fireEvent.click(screen.getByRole("button", { name: /Read/ }));
  await waitFor(() => expect(screen.getByLabelText("Title")).toHaveValue("Receipt shows the wrong month"));
  const add = within(screen.getByRole("region", { name: "Add a ticket" }));
  expect(add.getByRole("button", { name: "iOS" })).toHaveAttribute("aria-pressed", "true");
  await waitFor(() => expect(add.getByLabelText("Builds it")).toHaveValue("iosdev")); // the iOS engineer, for an iOS-only ticket
  fireEvent.click(add.getByRole("button", { name: /Add and start/ }));
  await waitFor(() => expect(posts.some((p) => p.url.endsWith("/tickets"))).toBe(true));
  const sent = posts.find((p) => p.url.endsWith("/tickets"))!.body;
  expect(sent).toMatchObject({ issue_number: 230, title: "Receipt shows the wrong month", platforms: ["ios"], kind: "bug", source: "github" });
});

it("cuts from the Release home: the cycle's branch and tickets, and Start is the cut", async () => {
  const posts: { url: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") posts.push({ url, body: JSON.parse(String(init.body)) });
    if (url.includes("/inventory")) return json({ state: "ready", summary: "", read_at: now, cached: false, command: "x",
      data: { platforms: { ios: { live: { version: "1.0.2" }, changes: [], next: { version: "1.0.3", build: 9 } } }, release_params: { platforms: ["ios", "web"], version: "1.0.3", build: "9" } } });
    if (url.endsWith("/cut")) return json({ cycle: { ...cycle, state: "cut" }, release_workflow_id: "rel", next_cycle_id: "c2" });
    if (url.startsWith("/api/release-cycles/c1")) return json(cycle);
    if (url.endsWith("/compile")) return json(compiled);
    return json({});
  }));
  mount("/workflows/new?cid=project&template=mobile_app_release&home=1&cycle=c1");
  expect(await screen.findByRole("heading", { name: "Cut release 1.0.3" })).toBeVisible();
  const ships = screen.getByRole("region", { name: "What release 1.0.3 ships" });
  expect(within(ships).getByText("Login spinner")).toBeVisible();
  expect(within(ships).getByText("Tenant referrals")).toBeVisible(); // under "Rolls to 1.0.4"
  expect(screen.queryByRole("button", { name: /Customize steps/ })).toBeNull();
  fireEvent.click(screen.getByRole("radio", { name: "I release it by hand" }));
  const start = screen.getByRole("button", { name: /Cut and start the release/ });
  await waitFor(() => expect(start).toBeEnabled());
  fireEvent.click(start);
  expect(await screen.findByText("run page")).toBeVisible();
  const cut = posts.find((p) => p.url.endsWith("/cut"))!.body as { params: Record<string, unknown> };
  // Only the platforms with merged tickets, from the branch, with the tickets as the batch.
  expect(cut.params).toMatchObject({ source: "cycle", release_branch: "release/1.0.3", platforms: ["ios"], release_type: "manual", build: "9" });
  expect(posts.some((p) => p.url.endsWith("/from-template"))).toBe(false);
});


const inventoryFor = (over: Record<string, unknown> = {}) => ({
  state: "ready", summary: "", read_at: now, cached: false, command: "x",
  data: { platforms: { ios: { last_release: { tag: "ios/1.0.1-7" }, changes: [] }, android: { last_release: { tag: "android/1.0.19-19" }, changes: [] } },
    release_params: { version: "1.0.2", platforms: [] }, ...over },
});

it("opens with the next version filled in, and you can change it", async () => {
  const posts: { url: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST" && !url.endsWith("/compile")) posts.push({ url, body: JSON.parse(String(init.body)) });
    if (url.startsWith("/api/release-cycles/")) return json({ ...cycle, id: "new" });
    if (url.includes("/release-cycles") && init?.method !== "POST") return json({ cycles: [], open: null, open_dry_run: null, open_hotfix: null, open_hotfix_dry_run: null, suggested: { version: null, branch: null } });
    if (url.includes("/inventory")) return json(inventoryFor());
    if (url.endsWith("/compile")) return json(compiled);
    if (url.endsWith("/release-cycles")) return json({ ...cycle, id: "new" });
    return json({});
  }));
  mount("/workflows/cycle?cid=project");
  await waitFor(() => expect(screen.getByRole("textbox", { name: /^Version/ })).toHaveValue("1.0.2"));
  expect(screen.getByLabelText("Branch")).toHaveValue("release/1.0.2");
  expect(screen.getByLabelText("GitHub milestone")).toHaveValue("1.0.2");
  fireEvent.change(screen.getByRole("textbox", { name: /^Version/ }), { target: { value: "1.1.0" } });
  expect(screen.getByLabelText("Branch")).toHaveValue("release/1.1.0"); // follows until you type one
  expect(screen.getByRole("button", { name: "1.0.2" })).toBeVisible(); // the suggestion, one click back
  await waitFor(() => expect(screen.getByLabelText("Engineer")).toHaveAttribute("data-value", "eng"));
  fireEvent.click(screen.getByRole("button", { name: /Open the cycle/ }));
  await waitFor(() => expect(posts.length).toBe(1));
  expect(posts[0].body).toMatchObject({ kind: "release", version: "1.1.0", branch: "release/1.1.0", base_branch: "main", milestone: "1.1.0" });
});

it("a hotfix starts one patch up from what's live, cut from its release tag, and says the planned release moves up", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.includes("/release-cycles")) return json({ cycles: [{ ...cycle, id: "c1", version: "1.0.2", branch: "release/1.0.2" }], open: "c1", open_dry_run: null, open_hotfix: null, open_hotfix_dry_run: null, suggested: { version: "1.0.3", branch: null } });
    if (url.includes("/inventory")) return json(inventoryFor());
    if (url.endsWith("/compile")) return json(compiled);
    return json({});
  }));
  mount("/workflows/cycle?cid=project&kind=hotfix");
  expect(await screen.findByRole("heading", { name: "Start a hotfix" })).toBeVisible();
  await waitFor(() => expect(screen.getByRole("textbox", { name: /^Version/ })).toHaveValue("1.0.2"));
  expect(screen.getByLabelText("Branch")).toHaveValue("hotfix/1.0.2");
  const cut = screen.getByLabelText("Cut from");
  expect(cut).toHaveAttribute("data-value", "ios/1.0.1-7");
  // The tags in a picker of our own, with their platform; choosing one changes where it's cut from.
  fireEvent.click(cut);
  const list = screen.getByRole("listbox", { name: "Cut from" });
  expect(within(list).getAllByRole("option").map((o) => o.textContent)).toEqual(["ios/1.0.1-7The last release tagiOS", "android/1.0.19-19The last release tagAndroid"]);
  fireEvent.click(within(list).getByText("android/1.0.19-19"));
  expect(cut).toHaveAttribute("data-value", "android/1.0.19-19");
  expect(screen.getByText(/Release 1\.0\.2 moves to 1\.0\.3/)).toBeVisible();
});
