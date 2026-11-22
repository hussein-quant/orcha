import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { exampleWorkflow, writeCapability } from "../workflows/workflowTestFixtures";

const context = vi.hoisted(() => ({ cid: "project", bump: 0, connection: "live", identityPending: false,
  snap: { agents: [{ id: "owner", alias: "Owner", kind: "human", status: "active" }, { id: "eng", alias: "Engineer", kind: "ai", status: "active", role: "engineer" }] } }));
const authority = vi.hoisted(() => ({ human: { id: "owner", kind: "human", member_role: "owner" } }));
vi.mock("../../state/SnapshotProvider", async (original) => ({ ...await original<typeof import("../../state/SnapshotProvider")>(), useSnapshot: () => context, useActingAuthority: () => authority }));
import { Composer, planLines } from "./Composer";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const preview = { graph_revision: 1, preview_digest: "digest-1", selected_task_ids: [], required_task_ids: [], blockers: [] };

beforeEach(() => { try { localStorage.clear(); } catch { /* jsdom */ } });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

function mount(posts: { url: string; body: Record<string, unknown> }[]) {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (init?.method === "POST") posts.push({ url, body });
    if (url.endsWith("/capability")) return json({ ...writeCapability, flexible_workflows: true });
    if (url.endsWith("/preview")) return json(preview);
    if (url.endsWith("/launch")) return json({ id: "made" });
    if (url.endsWith("/workflows") && init?.method === "POST") return json(exampleWorkflow({ id: "made", container_id: "project", title: body.title }));
    return json({});
  }));
  render(<MemoryRouter initialEntries={["/workflows/new?cid=project&blank=1"]}><Routes>
    <Route path="/workflows/new" element={<Composer />} /><Route path="/workflows/:id" element={<p>run page</p>} />
  </Routes></MemoryRouter>);
}

it("reads a pasted plan one step per line, whatever the list marks", () => {
  expect(planLines("1. Draft the API\n- Update the app\n\n* [ ] Review\n2) Ship")).toEqual(["Draft the API", "Update the app", "Review", "Ship"]);
});

it("chains new steps, checks the draft with Orcha, and saves it through the classic create path", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const posts: { url: string; body: Record<string, unknown> }[] = [];
  mount(posts);
  expect(screen.getByText(/Name it, say what done looks like/)).toBeVisible();
  fireEvent.change(screen.getByLabelText("Workflow name"), { target: { value: "Tenant onboarding" } });
  fireEvent.change(screen.getByLabelText("Goal"), { target: { value: "Sign up in five minutes" } });
  const quick = screen.getByLabelText("Add a step");
  fireEvent.change(quick, { target: { value: "Design the flow" } });
  fireEvent.keyDown(quick, { key: "Enter" });
  fireEvent.change(quick, { target: { value: "Build the API" } });
  fireEvent.keyDown(quick, { key: "Enter" });
  expect(screen.getByLabelText("Step 1 name")).toHaveValue("Design the flow");
  expect(screen.getByLabelText("Step 2 name")).toHaveValue("Build the API");
  expect(screen.getByRole("button", { name: "Stop waiting for Design the flow" })).toBeVisible();
  // The only agent is picked for new steps; Start still waits for "done when".
  expect(screen.getByLabelText("Who does step 1")).toHaveValue("eng");
  await act(async () => { await vi.advanceTimersByTimeAsync(800); });
  await waitFor(() => expect(screen.getByText("Checked. Ready to save.")).toBeVisible());
  expect(screen.getByRole("button", { name: /Save and start/ })).toBeDisabled();
  expect(screen.getByText(/say when steps 1, 2 are done/)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Save as draft" }));
  expect(await screen.findByText("run page")).toBeVisible();
  const create = posts.find((p) => p.url === "/api/containers/project/workflows")!;
  expect(create.body.preview_digest).toBe("digest-1");
  const tasks = create.body.tasks as { client_key: string; title: string; depends_on: string[]; assignee_id: string }[];
  expect(tasks.map((t) => t.title)).toEqual(["Design the flow", "Build the API"]);
  expect(tasks[1].depends_on).toEqual([tasks[0].client_key]);
  expect(posts.some((p) => p.url.endsWith("/launch"))).toBe(false);
});

it("Save and start creates, then starts with the one Start", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const posts: { url: string; body: Record<string, unknown> }[] = [];
  mount(posts);
  fireEvent.change(screen.getByLabelText("Workflow name"), { target: { value: "Fix" } });
  fireEvent.change(screen.getByLabelText("Goal"), { target: { value: "Fixed" } });
  const quick = screen.getByLabelText("Add a step");
  fireEvent.change(quick, { target: { value: "Fix the bug" } });
  fireEvent.keyDown(quick, { key: "Enter" });
  fireEvent.change(screen.getByLabelText("Done when, step 1"), { target: { value: "The test passes" } });
  await act(async () => { await vi.advanceTimersByTimeAsync(800); });
  await waitFor(() => expect(screen.getByRole("button", { name: /Save and start/ })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: /Save and start/ }));
  expect(await screen.findByText("run page")).toBeVisible();
  expect(posts.map((p) => p.url)).toContain("/api/workflows/made/launch");
});

it("keeps the draft on this device and refuses nothing silently: problems show before saving", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  mount([]);
  const quick = screen.getByLabelText("Add a step");
  fireEvent.change(quick, { target: { value: "Only step" } });
  fireEvent.keyDown(quick, { key: "Enter" });
  expect(screen.getByText(/2 to fix before saving/)).toBeVisible();
  expect(screen.getByRole("button", { name: "Save as draft" })).toBeDisabled();
  expect(Object.keys(localStorage).some((k) => k.startsWith("orcha.flow.draft"))).toBe(true);
});

it("brings in existing tasks from the whole project, not a five-result search", async () => {
  const { TaskShelf } = await import("./TaskShelf");
  const tasks = [
    ...Array.from({ length: 8 }, (_, i) => ({ id: `open-${i}`, title: `Open task ${i}`, status: "ready", is_root: false, workflow_id: null })),
    { id: "done", title: "Shipped thing", status: "completed", is_root: false, workflow_id: null },
    { id: "taken", title: "In another workflow", status: "ready", is_root: false, workflow_id: "w" },
    { id: "review", title: "Under review", status: "needs_verification", is_root: false, workflow_id: null },
  ];
  (context.snap as unknown as { tasks: unknown[] }).tasks = tasks;
  const onChange = vi.fn();
  const onSelectedChoices = vi.fn();
  render(<TaskShelf selected={[]} onChange={onChange} onSelectedChoices={onSelectedChoices} onClose={() => {}} />);
  expect(screen.getAllByRole("checkbox")).toHaveLength(9); // 8 open + 1 finished; the two that can't join are folded
  fireEvent.click(screen.getByRole("button", { name: "Select all 8" }));
  expect(onChange).toHaveBeenLastCalledWith(tasks.slice(0, 8).map((t) => t.id));
  fireEvent.click(screen.getByRole("button", { name: /Can't join yet/ }));
  expect(screen.getByRole("checkbox", { name: /In another workflow/ })).toBeDisabled();
  expect(screen.getByRole("checkbox", { name: /Under review/ })).toBeDisabled();
  fireEvent.change(screen.getByLabelText("Filter tasks"), { target: { value: "shipped" } });
  expect(screen.getByRole("checkbox", { name: /Shipped thing/ })).toBeEnabled();
  expect(screen.queryByRole("checkbox", { name: /Open task 1/ })).toBeNull();
  (context.snap as unknown as { tasks?: unknown[] }).tasks = undefined;
});
