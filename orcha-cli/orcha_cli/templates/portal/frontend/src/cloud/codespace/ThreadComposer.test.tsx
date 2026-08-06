/**
 * ThreadComposer — the exact POST /api/containers/{cid}/code/threads body per
 * spec, template picks setting `kind` + a starter body, the @agent picker,
 * and the acting-human gate (mirrors postStart's gating in GitHubPage.test.tsx).
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui";
import { SnapshotProvider } from "../../state/SnapshotProvider";
import type { Agent } from "../../types";
import { ThreadComposer } from "./ThreadComposer";

interface Call { url: string; method: string; body: unknown }

const AGENTS: Agent[] = [
  { id: "h1", alias: "kedar", kind: "human", status: "idle" } as Agent,
  { id: "a1", alias: "forge", kind: "ai", status: "idle", role: "engineer" } as Agent,
];

function stubFetch(): Call[] {
  const calls: Call[] = [];
  const json = (data: unknown, status = 200) =>
    ({ ok: status < 400, status, json: async () => data }) as unknown as Response;
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method || "GET", body: init?.body ? JSON.parse(String(init.body)) : null });
    if (url.startsWith("/api/containers/c1/code/threads")) {
      return json({
        thread: { id: "t1", ref: "HEAD", sha: "abc1234", path: "a.ts", start_line: 3, end_line: 3, kind: "question", status: "open", created_at: "now", updated_at: "now" },
        message: { id: "m1", is_human: true, body: "hi", created_at: "now" },
      }, 201);
    }
    if (url.startsWith("/api/containers/c1")) {
      return json({
        container: { id: "c1", name: "Acme", status: "active", autonomy_level: "plan" },
        agents: AGENTS,
        tasks: [],
        requests: [],
      });
    }
    if (url === "/api/containers") return json([{ id: "c1", status: "active" }]);
    return json({});
  }) as unknown as typeof fetch;
  return calls;
}

function mount(props: Partial<Parameters<typeof ThreadComposer>[0]> = {}) {
  return render(
    <ToastProvider>
      <SnapshotProvider>
        <ThreadComposer
          cid="c1"
          gitRef="HEAD"
          path="a.ts"
          startLine={3}
          endLine={3}
          agents={AGENTS}
          {...props}
        />
      </SnapshotProvider>
    </ToastProvider>,
  );
}

describe("ThreadComposer", () => {
  beforeEach(() => { localStorage.clear(); });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("posts the exact spec body on submit", async () => {
    const calls = stubFetch();
    mount();
    await screen.findByText("Post"); // wait for snapshot/acting-human to settle
    fireEvent.change(screen.getByLabelText(/thread message/i), { target: { value: "How does auth work here?" } });
    fireEvent.click(screen.getByText("Post"));
    await Promise.resolve();
    const postCall = await waitForPost(calls);
    expect(postCall.url).toBe("/api/containers/c1/code/threads");
    expect(postCall.method).toBe("POST");
    expect(postCall.body).toEqual({
      ref: "HEAD",
      path: "a.ts",
      start_line: 3,
      end_line: 3,
      kind: "question",
      body: "How does auth work here?",
      tagged_agent_id: undefined,
      actor_agent_id: "h1",
    });
  });

  it("templates set kind and seed the starter body", async () => {
    stubFetch();
    mount();
    await screen.findByText("Post");
    const textarea = screen.getByLabelText(/thread message/i) as HTMLTextAreaElement;
    expect(textarea.value).toBe("How does this work?"); // default template (question)

    fireEvent.click(screen.getByText("Why this decision?"));
    expect(textarea.value).toBe("Why this decision?");
    fireEvent.click(screen.getByText("Teach me this concept"));
    expect(textarea.value).toBe("Teach me this concept.");
    fireEvent.click(screen.getByText("Note"));
    expect(textarea.value).toBe("");
  });

  it("sends the picked kind through to the POST body", async () => {
    const calls = stubFetch();
    mount();
    await screen.findByText("Post");
    fireEvent.click(screen.getByText("Why this decision?"));
    fireEvent.change(screen.getByLabelText(/thread message/i), { target: { value: "why though" } });
    fireEvent.click(screen.getByText("Post"));
    const postCall = await waitForPost(calls);
    expect(postCall.body).toMatchObject({ kind: "why", body: "why though" });
  });

  it("includes tagged_agent_id when an agent is picked", async () => {
    const calls = stubFetch();
    mount();
    await screen.findByText("Post");
    fireEvent.change(screen.getByLabelText(/tag an agent/i), { target: { value: "a1" } });
    fireEvent.change(screen.getByLabelText(/thread message/i), { target: { value: "tag test" } });
    fireEvent.click(screen.getByText("Post"));
    const postCall = await waitForPost(calls);
    expect(postCall.body).toMatchObject({ tagged_agent_id: "a1" });
  });

  it("raise-hand mode: pre-tags the agent, hides the template picker, shows the honesty caption", async () => {
    stubFetch();
    mount({ preTaggedAgentId: "a1" });
    await screen.findByText(/queued — the agent addresses this at its next checkpoint/i);
    expect(screen.queryByRole("group", { name: /question templates/i })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/tag an agent/i)).not.toBeInTheDocument();
    expect(screen.getByText("@forge")).toBeInTheDocument();
  });
});

async function waitForPost(calls: Call[]): Promise<Call> {
  for (let i = 0; i < 20; i++) {
    const found = calls.find((c) => c.method === "POST" && c.url.includes("/code/threads") && !c.url.includes("/messages"));
    if (found) return found;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("POST /code/threads never fired");
}
