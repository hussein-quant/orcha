import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { stateOf, type FlowDetail, type FlowTask } from "./flowApi";
import { springKeyframes } from "./motion";

const context = vi.hoisted(() => ({ cid: "project", bump: 0, connection: "live", snap: { agents: [] } }));
const authority = vi.hoisted(() => ({ human: { id: "owner", kind: "human", member_role: "owner" } as null | { id: string; kind: string; member_role: string } }));
vi.mock("../../state/SnapshotProvider", async (original) => ({ ...await original<typeof import("../../state/SnapshotProvider")>(), useSnapshot: () => context, useActingAuthority: () => authority }));
import { Board } from "./Board";
import { Editor } from "./Editor";
import { Run } from "./Run";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
beforeEach(() => { authority.human = { id: "owner", kind: "human", member_role: "owner" }; });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

const summary = { key: "mobile_app_release", name: "Mobile App Release", version: 1, description: "Intake to live", icon: "rocket", tone: "amber", source: "builtin",
  stage_count: 2, step_count: 3, gates: 1, watches: 0, outward: 1, thread: [{ kind: "agent", outward: false, stage: "a" }, { kind: "gate", outward: false, stage: "b" }, { kind: "agent", outward: true, stage: "b" }] };

function task(over: Partial<FlowTask>): FlowTask {
  return { id: "t", title: "Step", definition_of_done: "done", status: "pending", work_revision: 1, preparation_state: "prepared", start_hold: false, human_hold_by: null,
    assignee_ids: [], depends_on: [], can_start: false, blockers: [], display_state: { label: "" }, outcomes: [], routes: [], ...over };
}

it("the board sorts a stalled workflow first, counts what waits for you, and folds finished ones", async () => {
  const fetch = vi.fn(async (url: string) => url.includes("workflow-board") ? json({
    workflows: [
      { id: "a", title: "Stalled release", status: "active", launch_enabled: true, template: { key: "mobile_app_release", name: "Mobile App Release" }, dry_run: false,
        thread: [{ id: "1", title: "x", kind: "gate", state: "asking", outward: false }], waiting_for_you: 1, stage: "Go / no-go", created_at: "2026-11-01T00:00:00Z",
        last_activity: "2026-11-01T00:00:00Z", stalled: { since: "2026-11-01T00:00:00Z", days: 20 }, finished: false, done: 0, total: 1 },
    ], finished_count: 4, stall_days: 3 }) : json({ templates: [summary] }));
  vi.stubGlobal("fetch", fetch);
  render(<MemoryRouter><Board /></MemoryRouter>);
  expect(await screen.findByText("Stalled release")).toBeVisible();
  expect(screen.getByText(/Stalled 20 days/)).toBeVisible();
  expect(screen.getByText("1 waiting for you")).toBeVisible();
  expect(screen.getByRole("button", { name: /4 finished/ })).toHaveAttribute("aria-expanded", "false");
  expect(String(fetch.mock.calls[0][0])).toContain("include_finished=false");
});

it("the editor shows problems inline, keeps Start off until the live check is clean, and starts in one click", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const compiled = (problems: unknown[]) => ({
    template: summary, stages: [{ key: "go", title: "Go / no-go" }], loops: [], roles: [{ key: "owner", label: "Owner", kind: "human" }],
    parameters: [{ key: "version", label: "Version", type: "text", required: true }], values: {}, people: [{ id: "owner", alias: "Owner", kind: "human", role: "owner" }],
    steps: [{ client_key: "gate", title: "Your go-ahead", kind: "gate", stage: "go", role: "owner", required: true, locked_reason: null, removed: false, platforms: [],
      irreversible: false, outward: null, done_when: "You chose", description: "", after: [], loop: null, branches: [], assignee_id: null, added: false }],
    problems, ready: !problems.length,
  });
  const posts: { url: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (init?.method === "POST") posts.push({ url, body });
    if (url.endsWith("/compile")) return json(compiled(body.params?.version ? [] : [{ code: "parameter_required", param: "version", message: "Choose version." }]));
    if (url.endsWith("/from-template")) return json({ id: "new-run" });
    return json({});
  }));
  render(<MemoryRouter initialEntries={["/workflows/new?cid=project&template=mobile_app_release"]}><Routes><Route path="/workflows/new" element={<Editor />} /><Route path="/workflows/:id" element={<p>run page</p>} /></Routes></MemoryRouter>);
  await act(async () => { await vi.advanceTimersByTimeAsync(700); });
  expect(await screen.findByText(/1 to fix before Start/)).toBeVisible();
  expect(screen.getByRole("button", { name: /^Start/ })).toBeDisabled();
  expect(screen.getByText("Required")).toBeVisible();
  fireEvent.change(screen.getByLabelText(/Version/), { target: { value: "1.0.2" } });
  await act(async () => { await vi.advanceTimersByTimeAsync(700); });
  await waitFor(() => expect(screen.getByRole("button", { name: /^Start/ })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: /^Start/ }));
  expect(await screen.findByText("run page")).toBeVisible();
  const start = posts.find((p) => p.url.endsWith("/from-template"))!;
  expect(start.body).toMatchObject({ key: "mobile_app_release", start: true, params: { version: "1.0.2" } });
});

function gateRun(): FlowDetail {
  const gate = task({ id: "g", title: "Your go-ahead", status: "ready", step: { kind: "gate", key: "gate", stage: "go", stage_title: "Go / no-go", gate: { choices: ["go", "no_go", "send_back"] } },
    outcomes: [{ name: "go", kind: "success" }, { name: "no_go", kind: "failure" }, { name: "send_back", kind: "changes" }] });
  const build = task({ id: "b", title: "Archive iOS", status: "completed", step: { kind: "agent", stage: "builds", stage_title: "Release builds" } });
  const submit = task({ id: "s", title: "Submit for App Review", depends_on: ["g"], step: { kind: "agent", irreversible: true, outward: "App Store", stage: "ship", stage_title: "Ship" },
    blockers: [{ code: "gate_required", message: "Waiting for the go-ahead in this run." }] });
  return { id: "w", container_id: "project", title: "Release 1.0.2 (8)", goal: "", owner_human_id: "owner", status: "active", launch_enabled: true, revision: 3,
    tasks: [build, gate, submit], progress: { accepted: 1, total: 3, percent: 33 }, completion: { can_finish: false, blockers: [] },
    repeat_groups: [{ id: "lg", name: "Approval loop", member_tasks: ["b", "g"], review_task: "g", max_rounds: 3, current_round: 1, state: "open" }],
    template: { key: "mobile_app_release", version: 1, name: "Mobile App Release", params: {}, removed: [] }, dry_run: true };
}
const proof = { workflow_id: "w", gate_task_id: "g", title: "Release", dry_run: true, params: {}, digest: "abc123",
  platforms: [{ platform: "ios", word: "iOS", checked: true, headline: "passed", totals: { passed: 31, failed: 0, blocked: 0, skipped: 0 },
    coverage: { platform: "ios", validated: 31, draft: 0, paused: 0, threshold: 10, warn: false },
    steps: [{ task_id: "q", title: "Full regression on iOS", platform: "ios", scope: "full", kind: "check", status: "completed", word: "passed", outcome: "pass", rounds: 1,
      build: { type: "debug", version: "1.0.2" }, counts: { passed: 31, failed: 0, blocked: 0, skipped: 0 }, failures: [], scenarios: [], frames: [], request_id: null, summary: null, dry_run: true }] },
  { platform: "android", word: "Android", checked: true, headline: "passed", totals: { passed: 1, failed: 0, blocked: 0, skipped: 0 },
    coverage: { platform: "android", validated: 1, draft: 0, paused: 0, threshold: 10, warn: true }, steps: [] }],
  findings: { items: [], tally: {} }, unit_only: [{ task_id: "api", title: "Deploy the API" }], watches: [], decisions: [],
  warnings: ["Android has 1 validated scenarios, below 10."], changed_since_last: [], commits: [] };

it("the gate shows the proof and needs a reason to send back; Go answers in place", async () => {
  const posts: { url: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") { posts.push({ url, body: JSON.parse(String(init.body)) }); return json({ ...gateRun(), revision: 4, tasks: gateRun().tasks.map((t) => t.id === "g" ? { ...t, status: "completed", reported_outcome: { outcome: "go" } } : t) }); }
    if (url.includes("/proof")) return json(proof);
    return json(gateRun());
  }));
  render(<MemoryRouter initialEntries={["/workflows/w?cid=project"]}><Routes><Route path="/workflows/:workflowId" element={<Run />} /></Routes></MemoryRouter>);
  expect(await screen.findByText(/Your go-ahead: Go, No-go or Send back/)).toBeVisible();
  expect(await screen.findByText("Android has 1 validated scenarios, below 10.")).toBeVisible();
  expect(screen.getByText("Deploy the API")).toBeVisible();
  expect(screen.getByText("App Store")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: /Send back/ }));
  const send = screen.getByRole("button", { name: "Send back" });
  expect(send).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  fireEvent.click(screen.getByRole("button", { name: /^Go$/ }));
  expect(await screen.findByText(/Go\. Submit for App Review runs now\./)).toBeVisible();
  expect(posts[0].url).toBe("/api/workflows/w/steps/g/decide");
  expect(posts[0].body).toMatchObject({ choice: "go", proof_digest: "abc123" });
});

it("words a step from the person's side, and a not-selected step is skipped", () => {
  expect(stateOf(task({ status: "ready", step: { kind: "gate" } }))).toBe("asking");
  expect(stateOf(task({ status: "ready", step: { kind: "watch" } }))).toBe("running");
  expect(stateOf(task({ status: "completed", route_state: "not_selected" }))).toBe("skipped");
  expect(stateOf(task({ status: "completed", awaiting_loop_decision: "ask_owner" }))).toBe("asking");
  expect(stateOf(task({ status: "completed", reported_outcome: { outcome: "fail" }, outcomes: [{ name: "fail", kind: "failure" }], routes: [{ outcome: "fail", destination: "next" }] }))).toBe("done");
});

it("the reorder spring settles exactly at rest", () => {
  const frames = springKeyframes(120);
  expect(frames.at(-1)).toEqual({ transform: "translateY(0px)" });
  expect(frames.length).toBe(31);
});
