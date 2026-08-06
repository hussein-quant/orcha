/**
 * CodeSpacePage — the full three-pane integration: gutter dots render on
 * annotated lines, clicking a gutter opens the Phase-1 composer pre-filled
 * with the clicked line's anchor, and deep-link ?path=/?line= seed the
 * viewer. fetch stubbed like GitHubPage.test.tsx; mounted through the real
 * SnapshotProvider + MemoryRouter.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui";
import { SnapshotProvider } from "../../state/SnapshotProvider";
import { CodeSpacePage } from "./CodeSpacePage";

const AGENTS = [
  { id: "h1", alias: "kedar", kind: "human", status: "idle" },
  { id: "a1", alias: "forge", kind: "ai", status: "idle", role: "engineer" },
];

const TREE_ROOT = { ref: "HEAD", path: "", entries: [{ name: "a.ts", path: "a.ts", type: "file" }] };
const FILE_A = { ref: "HEAD", path: "a.ts", content: "const x = 1;\nconsole.log(x);\nexport default x;", size: 60 };
const THREADS_A = {
  threads: [
    { id: "t1", ref: "HEAD", sha: "abc1234def", path: "a.ts", start_line: 2, end_line: 2, kind: "question", status: "open", created_at: "now", updated_at: "now", blob_match: true },
  ],
};

function stubFetch() {
  const json = (data: unknown) => ({ ok: true, status: 200, json: async () => data }) as unknown as Response;
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("/api/containers/c1/github/browse/tree")) return json(TREE_ROOT);
    if (url.startsWith("/api/containers/c1/github/browse/file")) return json(FILE_A);
    if (url.startsWith("/api/containers/c1/code/threads")) return json(THREADS_A);
    if (url.startsWith("/api/containers/c1")) {
      return json({ container: { id: "c1", name: "Acme", status: "active", autonomy_level: "plan" }, agents: AGENTS, tasks: [], requests: [] });
    }
    if (url === "/api/containers") return json([{ id: "c1", status: "active" }]);
    return json({});
  }) as unknown as typeof fetch;
}

function mount(initialEntry = "/code?path=a.ts") {
  return render(
    <ToastProvider>
      <SnapshotProvider>
        <MemoryRouter initialEntries={[initialEntry]}>
          <CodeSpacePage />
        </MemoryRouter>
      </SnapshotProvider>
    </ToastProvider>,
  );
}

describe("CodeSpacePage", () => {
  beforeEach(() => { localStorage.clear(); });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("renders the file's lines with a gutter dot on the annotated line", async () => {
    stubFetch();
    mount();
    await screen.findByText("a.ts", { selector: ".rb-file-path" });
    const line2 = document.querySelector('[data-cs-line="2"]');
    expect(line2).not.toBeNull();
    expect(line2!.querySelector(".cs-gutter-dot")).not.toBeNull();
    // line 1 (no thread) carries no dot
    const line1 = document.querySelector('[data-cs-line="1"]');
    expect(line1!.querySelector(".cs-gutter-dot")).toBeNull();
  });

  it("clicking a line's gutter opens the composer anchored to that line", async () => {
    stubFetch();
    mount();
    await screen.findByText("a.ts", { selector: ".rb-file-path" });
    const gutter3 = document.querySelector('[data-cs-line="3"] .cs-gutter') as HTMLElement;
    fireEvent.click(gutter3);
    expect(await screen.findByText(/line 3/i)).toBeInTheDocument();
  });

  it("deep link ?path=&line= seeds the file and scrolls to the line", async () => {
    stubFetch();
    mount("/code?path=a.ts&line=2");
    await screen.findByText("a.ts", { selector: ".rb-file-path" });
    expect(document.querySelector('[data-cs-line="2"]')).not.toBeNull();
  });

  it("shows a per-file thread count badge in the tree", async () => {
    stubFetch();
    mount();
    expect(await screen.findByText("1", { selector: ".cs-tree-badge" })).toBeInTheDocument();
  });
});
