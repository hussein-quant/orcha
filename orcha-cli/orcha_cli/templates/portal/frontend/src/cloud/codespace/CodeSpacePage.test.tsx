/**
 * CodeSpacePage — the full three-pane integration: gutter dots render on
 * annotated lines, clicking a gutter opens the Phase-1 composer pre-filled
 * with the clicked line's anchor, and deep-link ?path=/?line= seed the
 * viewer. fetch stubbed like GitHubPage.test.tsx; mounted through the real
 * SnapshotProvider + MemoryRouter.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui";
import { SnapshotProvider } from "../../state/SnapshotProvider";
import { CodeSpacePage } from "./CodeSpacePage";

const AGENTS = [
  { id: "h1", alias: "kedar", kind: "human", status: "idle" },
  { id: "a1", alias: "forge", kind: "ai", status: "idle", role: "engineer" },
];

const TREE_ROOT = {
  ref: "HEAD", path: "",
  entries: [{ name: "a.ts", path: "a.ts", type: "file" }, { name: "readme.md", path: "readme.md", type: "file" }],
};
const FILE_A = { ref: "HEAD", path: "a.ts", content: "const x = 1;\nconsole.log(x);\nexport default x;", size: 60 };
const FILE_MD = { ref: "HEAD", path: "readme.md", content: "# Title\n\nSome **bold** text.", size: 30 };
const THREADS_A = {
  threads: [
    { id: "t1", ref: "HEAD", sha: "abc1234def", path: "a.ts", start_line: 2, end_line: 2, kind: "question", status: "open", created_at: "now", updated_at: "now", blob_match: true },
  ],
};
const THREADS_MD = { threads: [] };

const SYMBOL_SEARCH_RESULT = {
  available: true, ref: "HEAD",
  results: [{ name: "x", kind: "var", path: "a.ts", line: 1 }],
};

function stubFetch() {
  const json = (data: unknown) => ({ ok: true, status: 200, json: async () => data }) as unknown as Response;
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("/api/containers/c1/github/browse/tree")) return json(TREE_ROOT);
    if (url.startsWith("/api/containers/c1/github/browse/file")) {
      if (url.includes("path=readme.md")) return json(FILE_MD);
      return json(FILE_A);
    }
    if (url.startsWith("/api/containers/c1/code/threads")) {
      if (url.includes("path=readme.md")) return json(THREADS_MD);
      return json(THREADS_A);
    }
    if (url.startsWith("/api/containers/c1/code/outline")) {
      return json({ available: true, ref: "HEAD", path: "a.ts", language: "typescript", symbols: [] });
    }
    if (url.startsWith("/api/containers/c1/code/symbols")) return json(SYMBOL_SEARCH_RESULT);
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

  it("renders a header symbol search input", async () => {
    stubFetch();
    mount();
    expect(await screen.findByPlaceholderText(/search symbols/i)).toBeInTheDocument();
  });

  it("clicking an identifier token in the code pane offers a symbol-search affordance, prefilled", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    stubFetch();
    mount();
    await screen.findByText("a.ts", { selector: ".rb-file-path" });
    const identTok = document.querySelectorAll(".cs-ident-tok");
    expect(identTok.length).toBeGreaterThan(0);
    const consoleTok = Array.from(identTok).find((el) => el.textContent === "console");
    expect(consoleTok).toBeTruthy();
    fireEvent.click(consoleTok as HTMLElement);
    const input = await screen.findByPlaceholderText(/search symbols/i) as HTMLInputElement;
    expect(input.value).toBe("console");
    await act(async () => { vi.advanceTimersByTime(300); });
    vi.useRealTimers();
  });
});

describe("CodeSpacePage — markdown Raw|Rendered toggle (item 1)", () => {
  beforeEach(() => { localStorage.clear(); });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("defaults a .md file to Rendered, rendering through the house Md component", async () => {
    stubFetch();
    mount("/code?path=readme.md");
    await screen.findByText("readme.md", { selector: ".rb-file-path" });
    expect(document.querySelector(".cs-md-rendered")).not.toBeNull();
    // esc-first house markdown (lib/format.ts's mdText): headings render as
    // <span class="md-h">, never raw #-prefixed text.
    expect(document.querySelector(".cs-md-rendered .md-h")).not.toBeNull();
    expect(document.querySelector(".cs-md-rendered strong")).not.toBeNull();
    // Rendered mode has no gutter lines to click/anchor a thread against.
    expect(document.querySelector(".cs-gutter")).toBeNull();
    const renderedBtn = screen.getByText("Rendered");
    expect(renderedBtn.className).toContain("on");
  });

  it("toggling to Raw shows plain code lines with working gutter selection", async () => {
    stubFetch();
    mount("/code?path=readme.md");
    await screen.findByText("readme.md", { selector: ".rb-file-path" });
    fireEvent.click(screen.getByText("Raw"));
    expect(document.querySelector(".cs-md-rendered")).toBeNull();
    const gutter1 = document.querySelector('[data-cs-line="1"] .cs-gutter') as HTMLElement;
    expect(gutter1).not.toBeNull();
    fireEvent.click(gutter1);
    expect(await screen.findByText(/line 1/i)).toBeInTheDocument();
  });

  it("toggling back to Rendered disables the gutter with an explanatory tooltip", async () => {
    stubFetch();
    mount("/code?path=readme.md");
    await screen.findByText("readme.md", { selector: ".rb-file-path" });
    fireEvent.click(screen.getByText("Raw"));
    fireEvent.click(screen.getByText("Rendered"));
    const rendered = document.querySelector(".cs-md-rendered");
    expect(rendered).not.toBeNull();
    expect(rendered!.getAttribute("title")).toMatch(/switch to raw to anchor a thread/i);
  });

  it("a non-.md file has no Raw|Rendered toggle at all", async () => {
    stubFetch();
    mount("/code?path=a.ts");
    await screen.findByText("a.ts", { selector: ".rb-file-path" });
    expect(screen.queryByText("Rendered")).not.toBeInTheDocument();
    expect(screen.queryByText("Raw")).not.toBeInTheDocument();
  });

  it("switching from a .md file to a non-.md file resets to Raw's plain gutter view", async () => {
    stubFetch();
    mount("/code?path=readme.md");
    await screen.findByText("readme.md", { selector: ".rb-file-path" });
    expect(document.querySelector(".cs-md-rendered")).not.toBeNull();

    fireEvent.click(screen.getByText("a.ts"));
    await screen.findByText("a.ts", { selector: ".rb-file-path" });
    expect(document.querySelector(".cs-md-rendered")).toBeNull();
    expect(document.querySelector('[data-cs-line="1"] .cs-gutter')).not.toBeNull();
  });
});
