import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";

const context = vi.hoisted(() => ({ cid: "project", bump: 0, connection: "live", snap: { agents: [], container: { wakes_enabled: true } } }));
vi.mock("../../state/SnapshotProvider", async (original) => ({ ...await original<typeof import("../../state/SnapshotProvider")>(), useSnapshot: () => context, useActingAuthority: () => ({ human: { id: "owner" } }) }));
import { readReply, withoutBrief, type Cycle } from "./flowApi";
import { Intake } from "./Intake";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("reads the agent's proposed tickets out of its reply, and leaves its words", () => {
  const reply = 'Got it. Two things here.\n\n```orcha-ticket\n{"title": "Checkout freezes after a double tap", "kind": "bug", "platforms": ["android", "tv"], "body": "## Steps", "attachments": ["f1"]}\n```\n\n```orcha-ticket\nnot json\n```\nAnything else?';
  const { words, tickets } = readReply(reply);
  expect(tickets).toEqual([{ title: "Checkout freezes after a double tap", kind: "bug", platforms: ["android"], body: "## Steps", attachments: ["f1"] }]);
  expect(words).toContain("Got it. Two things here.");
  expect(words).toContain("not json"); // a block that isn't a ticket stays as written
  expect(words).not.toContain("Checkout freezes");
  expect(withoutBrief("[[intake-brief]]\nrules\n[[/intake-brief]]\n\nThe app crashes")).toBe("The app crashes");
});

const cycle = {
  id: "c1", container_id: "project", version: "1.0.3", branch: "release/1.0.3", base_branch: "main", milestone: "1.0.3", state: "open",
  platforms: ["ios", "android", "web"], roles: { engineer: "eng" }, engineers: {}, dry_run: false, branch_state: "created", branch_note: null,
  created_at: "2026-11-22T10:00:00Z", cut_at: null, release_workflow: null, next_cycle: null, previous_cycle: null,
  counts: { total: 0, merged: 0, checked: 0, needs_you: 0, building: 0 },
  cut: { ships: [], rolls: [], platforms: [], unchecked: [], next_version: "1.0.4", next_branch: "release/1.0.4" },
  release_params: { platforms: [], batch_summary: "" }, tickets: [],
} as unknown as Cycle;
const people = [{ id: "owner", alias: "Owner", kind: "human" as const, role: null }, { id: "eng", alias: "Engineer", kind: "ai" as const, role: null }, { id: "pm", alias: "ProductLead", kind: "ai" as const, role: null }];

it("talks it through: the brief goes with the first message only, and a proposed ticket is logged with its screenshot", async () => {
  const posts: { url: string; body: Record<string, unknown> }[] = [];
  let turns: unknown[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body && typeof init.body === "string" ? JSON.parse(init.body) : {};
    if (init?.method === "POST" || init?.method === "PATCH") posts.push({ url, body });
    if (url.endsWith("/intake")) return json({ agent_id: null, brief: "[[intake-brief]]\nBe the intake.\n[[/intake-brief]]", marker: ["[[intake-brief]]", "[[/intake-brief]]"] });
    if (url.endsWith("/conversations")) return json({ conversation: { id: "conv", status: "active" } }, 201);
    if (url.includes("/turns?")) return json({ turns });
    if (url.endsWith("/turns")) {
      turns = [{ id: "t1", conversation_id: "conv", seq: 1, role: "human", author_agent_id: "owner", content: body.content, attachments: [{ id: "shot.png", name: "shot.png", kind: "image" }], created_at: "" }];
      return json({ turn: turns[0] }, 201);
    }
    if (url.endsWith("/attachments")) return json({ id: "shot.png", name: "shot.png", kind: "image", url: "/x/shot.png" }, 201);
    if (url.endsWith("/tickets")) return json({ ...cycle, notice: null });
    if (url.startsWith("/api/release-cycles/c1")) return json(cycle);
    return json({});
  }));
  render(<MemoryRouter><Intake cycle={cycle} actor="owner" people={people} onLogged={() => undefined} onClose={() => undefined} /></MemoryRouter>);
  // A product agent is the guess for the intake, and the choice is kept on the cycle.
  await waitFor(() => expect(screen.getByLabelText("Talking with")).toHaveValue("pm"));
  await waitFor(() => expect(posts.some((p) => p.url.endsWith("/agents/pm/conversations"))).toBe(true));
  const box = screen.getByLabelText("Describe it");
  fireEvent.paste(box, { clipboardData: { files: [new File(["x"], "shot.png", { type: "image/png" })] } });
  await screen.findByText("shot.png");
  fireEvent.change(box, { target: { value: "Checkout freezes when I tap Pay twice" } });
  await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(posts.some((p) => p.url.endsWith("/turns"))).toBe(true));
  const sent = posts.find((p) => p.url.endsWith("/turns"))!.body;
  expect(String(sent.content)).toMatch(/^\[\[intake-brief\]\][\s\S]*\[\[\/intake-brief\]\]\n\nCheckout freezes when I tap Pay twice$/);
  expect(sent.attachments).toEqual([{ id: "shot.png", name: "shot.png" }]);
  // The brief is hidden; the agent's reply turns into a card.
  expect(await screen.findByText("Checkout freezes when I tap Pay twice")).toBeVisible();
  expect(screen.queryByText(/Be the intake/)).toBeNull();
  turns = [...turns, { id: "t2", conversation_id: "conv", seq: 2, role: "agent", author_agent_id: "pm", created_at: "",
    content: 'Which screen?\n```orcha-ticket\n{"title": "Checkout freezes after a double tap on Pay", "kind": "bug", "platforms": ["android"], "body": "## Steps\\n1. Tap Pay twice", "attachments": ["shot.png"]}\n```' }];
  const card = (await screen.findByDisplayValue("Checkout freezes after a double tap on Pay", {}, { timeout: 5000 })).closest("article")!;
  fireEvent.click(within(card).getByRole("checkbox", { name: "Also open it on GitHub" }));
  fireEvent.click(within(card).getByRole("button", { name: /Log it/ }));
  await waitFor(() => expect(posts.some((p) => p.url.endsWith("/tickets"))).toBe(true));
  expect(posts.find((p) => p.url.endsWith("/tickets"))!.body).toMatchObject({
    title: "Checkout freezes after a double tap on Pay", kind: "bug", platforms: ["android"], create_issue: true,
    body: "## Steps\n1. Tap Pay twice", attachments: [{ conversation_id: "conv", id: "shot.png", name: "shot.png" }],
  });
});
