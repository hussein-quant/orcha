/**
 * ChangesTab — the working-tree "what have agents changed" list: dirty rows
 * with status badges + counts, summary header, empty/clean state, the
 * github_source degrade, click-to-open, and the dirty-count callback the
 * ThreadRail badge relies on. Stubs `fetchWorktreeChanges`'s underlying
 * `fetch` directly (matches ThreadRail.test.tsx's own stubFetch idiom).
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChangesTab } from "./ChangesTab";

function stubFetch(payload: unknown) {
  global.fetch = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => payload,
  })) as unknown as typeof fetch;
}

describe("ChangesTab", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("shows the clean-tree empty state", async () => {
    stubFetch({ available: true, dirty: false, files: [], summary: { files: 0, additions: 0, deletions: 0 } });
    render(<ChangesTab cid="c1" onOpenChange={vi.fn()} />);
    expect(await screen.findByText(/working tree clean/i)).toBeInTheDocument();
  });

  it("renders dirty rows with status badges, counts, and the summary header", async () => {
    stubFetch({
      available: true,
      dirty: true,
      files: [
        { path: "src/a.ts", status: "M", additions: 3, deletions: 1 },
        { path: "src/new.ts", status: "??", additions: 5, deletions: 0 },
        { path: "src/gone.ts", status: "D", additions: 0, deletions: 8 },
      ],
      summary: { files: 3, additions: 8, deletions: 9 },
    });
    render(<ChangesTab cid="c1" onOpenChange={vi.fn()} />);
    expect(await screen.findByText("src/a.ts")).toBeInTheDocument();
    expect(screen.getByText("src/new.ts")).toBeInTheDocument();
    expect(screen.getByText("src/gone.ts")).toBeInTheDocument();
    expect(screen.getByText("3 files changed")).toBeInTheDocument();
    expect(screen.getByText("+8")).toBeInTheDocument();
    expect(screen.getByText("−9")).toBeInTheDocument();
  });

  it("clicking a row calls onOpenChange with that path", async () => {
    stubFetch({
      available: true,
      dirty: true,
      files: [{ path: "src/a.ts", status: "M", additions: 1, deletions: 0 }],
      summary: { files: 1, additions: 1, deletions: 0 },
    });
    const onOpenChange = vi.fn();
    render(<ChangesTab cid="c1" onOpenChange={onOpenChange} />);
    const row = await screen.findByText("src/a.ts");
    fireEvent.click(row.closest(".cs-changes-row") as HTMLElement);
    expect(onOpenChange).toHaveBeenCalledWith("src/a.ts");
  });

  it("renders the github_source degrade honestly", async () => {
    stubFetch({ available: false, reason: "github_source", detail: "needs a local repository" });
    render(<ChangesTab cid="c1" onOpenChange={vi.fn()} />);
    expect(await screen.findByText(/using a\s*\n?\s*connected GitHub repo|needs a local repository/i)).toBeTruthy();
  });

  it("reports the dirty count via onDirtyCountChange", async () => {
    stubFetch({
      available: true,
      dirty: true,
      files: [
        { path: "a.ts", status: "M", additions: 1, deletions: 0 },
        { path: "b.ts", status: "A", additions: 2, deletions: 0 },
      ],
      summary: { files: 2, additions: 3, deletions: 0 },
    });
    const onDirtyCountChange = vi.fn();
    render(<ChangesTab cid="c1" onOpenChange={vi.fn()} onDirtyCountChange={onDirtyCountChange} />);
    await waitFor(() => expect(onDirtyCountChange).toHaveBeenCalledWith(2));
  });

  it("reports zero when the tree is clean", async () => {
    stubFetch({ available: true, dirty: false, files: [], summary: { files: 0, additions: 0, deletions: 0 } });
    const onDirtyCountChange = vi.fn();
    render(<ChangesTab cid="c1" onOpenChange={vi.fn()} onDirtyCountChange={onDirtyCountChange} />);
    await waitFor(() => expect(onDirtyCountChange).toHaveBeenCalledWith(0));
  });

  it("highlights the currently-selected path", async () => {
    stubFetch({
      available: true,
      dirty: true,
      files: [{ path: "src/a.ts", status: "M", additions: 1, deletions: 0 }],
      summary: { files: 1, additions: 1, deletions: 0 },
    });
    render(<ChangesTab cid="c1" selectedPath="src/a.ts" onOpenChange={vi.fn()} />);
    const row = await screen.findByText("src/a.ts");
    expect(row.closest(".cs-changes-row")).toHaveClass("on");
  });

  it("renders a binary marker when counts are null", async () => {
    stubFetch({
      available: true,
      dirty: true,
      files: [{ path: "img.png", status: "M", additions: null, deletions: null }],
      summary: { files: 1, additions: 0, deletions: 0 },
    });
    render(<ChangesTab cid="c1" onOpenChange={vi.fn()} />);
    expect(await screen.findByText("binary")).toBeInTheDocument();
  });
});
