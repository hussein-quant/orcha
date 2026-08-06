/**
 * ThreadRail — the Threads tab renders a file's thread list (with the
 * "outdated — pinned to <sha7>" honesty chip when blob_match=false), opening
 * a thread swaps in ThreadView, and switching tabs mounts Live/Learn.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui";
import { SnapshotProvider } from "../../state/SnapshotProvider";
import type { Agent } from "../../types";
import { ThreadRail } from "./ThreadRail";

const AGENTS: Agent[] = [
  { id: "h1", alias: "kedar", kind: "human", status: "idle" } as Agent,
  { id: "a1", alias: "forge", kind: "ai", status: "idle", role: "engineer" } as Agent,
];

const THREADS_PAYLOAD = {
  threads: [
    {
      id: "t1", ref: "HEAD", sha: "abc1234def", path: "a.ts", start_line: 3, end_line: 3,
      kind: "question", status: "open", created_at: "now", updated_at: "now", blob_match: false,
    },
    {
      id: "t2", ref: "HEAD", sha: "abc1234def", path: "a.ts", start_line: 10, end_line: 12,
      kind: "teach", status: "answered", created_at: "now", updated_at: "now", blob_match: true,
    },
  ],
};

function stubFetch() {
  const json = (data: unknown, status = 200) =>
    ({ ok: status < 400, status, json: async () => data }) as unknown as Response;
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("/api/containers/c1/code/threads")) return json(THREADS_PAYLOAD);
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
}

function mount(props: Partial<Parameters<typeof ThreadRail>[0]> = {}) {
  const defaultProps: Parameters<typeof ThreadRail>[0] = {
    cid: "c1",
    gitRef: "HEAD",
    path: "a.ts",
    agents: AGENTS,
    tab: "threads",
    onTabChange: vi.fn(),
    composerSelection: null,
    onComposerClose: vi.fn(),
    onJumpToLine: vi.fn(),
    openThreadId: null,
    onOpenThread: vi.fn(),
    raiseHand: null,
    onRaiseHandDone: vi.fn(),
    ...props,
  };
  return render(
    <ToastProvider>
      <SnapshotProvider>
        <ThreadRail {...defaultProps} />
      </SnapshotProvider>
    </ToastProvider>,
  );
}

describe("ThreadRail — Threads tab", () => {
  beforeEach(() => { localStorage.clear(); });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("renders the file's threads with kind tags and the outdated honesty chip", async () => {
    stubFetch();
    mount();
    expect(await screen.findByText("Question")).toBeInTheDocument();
    expect(screen.getByText("Teach")).toBeInTheDocument();
    expect(screen.getByText(/outdated — pinned to abc1234/i)).toBeInTheDocument();
    // the answered/non-outdated thread has no outdated chip on its own chip
    expect(screen.getAllByText(/outdated/i)).toHaveLength(1);
  });

  it("clicking a thread chip opens it", async () => {
    stubFetch();
    const onOpenThread = vi.fn();
    mount({ onOpenThread });
    const chip = await screen.findByText("Question");
    fireEvent.click(chip.closest(".cs-thread-chip") as HTMLElement);
    expect(onOpenThread).toHaveBeenCalledWith("t1");
  });

  it("clicking an anchor jumps to its line without opening the thread", async () => {
    stubFetch();
    const onOpenThread = vi.fn();
    const onJumpToLine = vi.fn();
    mount({ onOpenThread, onJumpToLine });
    const anchor = await screen.findByText(":3");
    fireEvent.click(anchor);
    expect(onJumpToLine).toHaveBeenCalledWith(3);
    expect(onOpenThread).not.toHaveBeenCalled();
  });

  it("shows an empty state when the file has no threads", async () => {
    global.fetch = vi.fn(async () =>
      ({ ok: true, status: 200, json: async () => ({ threads: [] }) }) as unknown as Response,
    ) as unknown as typeof fetch;
    mount();
    expect(await screen.findByText(/no threads on this file yet/i)).toBeInTheDocument();
  });

  it("shows the composer when composerSelection is set", async () => {
    stubFetch();
    mount({ composerSelection: { start: 5, end: 5 } });
    expect(await screen.findByText(/line 5/i)).toBeInTheDocument();
  });
});

describe("ThreadRail — tabs", () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("renders the Live tab's empty state when no agent is running", async () => {
    stubFetch();
    mount({ tab: "live" });
    expect(await screen.findByText(/no agents are running right now/i)).toBeInTheDocument();
  });

  it("renders the Learn tab", async () => {
    global.fetch = vi.fn(async () =>
      ({ ok: true, status: 200, json: async () => ({ threads: [] }) }) as unknown as Response,
    ) as unknown as typeof fetch;
    mount({ tab: "learn" });
    expect(await screen.findByText(/no teach\/why threads yet/i)).toBeInTheDocument();
  });

  it("renders an Outline tab button alongside Threads/Live/Learn", () => {
    stubFetch();
    mount();
    expect(screen.getByRole("tab", { name: "Outline" })).toBeInTheDocument();
  });

  it("renders the Outline tab's symbols for the open file", async () => {
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/containers/c1/code/outline")) {
        return {
          ok: true, status: 200,
          json: async () => ({
            available: true, ref: "HEAD", path: "a.ts", language: "typescript",
            symbols: [{ name: "helper", kind: "function", line: 3 }],
          }),
        } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
    }) as unknown as typeof fetch;
    mount({ tab: "outline" });
    expect(await screen.findByText("helper")).toBeInTheDocument();
  });
});
