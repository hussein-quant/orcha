/**
 * GitHubPage — list rendering from the stubbed wire contract, the Start
 * mutation's exact POST body, the acting-human gate, and the pulls tab's
 * progressive checks fill. fetch is stubbed; the snapshot flows through the
 * real SnapshotProvider + mapSnapshot (foundation.test.ts / HomePage.test.tsx
 * harness style).
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui";
import { SnapshotProvider } from "../../state/SnapshotProvider";
import { GitHubPage } from "./GitHubPage";

interface Call { url: string; method: string; body: unknown }

const AGENTS_WITH_HUMAN = [
  { id: "h1", alias: "kedar", kind: "human", status: "idle" },
  { id: "a1", alias: "forge", kind: "ai", status: "idle", role: "web engineer (Next.js dashboard)" },
];
const AGENTS_AI_ONLY = [
  { id: "a1", alias: "forge", kind: "ai", status: "idle", role: "web engineer (Next.js dashboard)" },
];

const rawSnap = (agents: unknown[]) => ({
  container: { id: "c1", name: "Acme", status: "active", autonomy_level: "plan" },
  agents,
  tasks: [],
  requests: [],
});

const ISSUES = {
  available: true,
  repo: "acme/app",
  issues: [
    {
      number: 7,
      title: "Fix login bug",
      labels: [{ name: "bug", color: "d73a4a" }],
      assignee: null,
      updated_at: "2026-08-01T00:00:00Z",
      html_url: "https://github.com/acme/app/issues/7",
      body_excerpt: "login broken on the web dashboard",
      tracked_task_id: null,
    },
  ],
};

const PULLS = {
  available: true,
  repo: "acme/app",
  pulls: [
    {
      number: 12,
      title: "Add OAuth flow",
      head: "feat/oauth",
      draft: false,
      updated_at: "2026-08-01T00:00:00Z",
      html_url: "https://github.com/acme/app/pull/12",
      requested_reviewers: ["kedar"],
      checks: null, // ALWAYS null off the list endpoint — progressive fill
      mergeable_state: "clean",
      tracked_task_id: null,
    },
  ],
};

const CHECKS = { available: true, checks: { "12": { passed: 3, failing: 0, pending: 0, total: 3 } } };

function stubFetch(agents: unknown[]): Call[] {
  const calls: Call[] = [];
  const json = (data: unknown, status = 200) =>
    ({ ok: status < 400, status, json: async () => data }) as unknown as Response;
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      method: init?.method || "GET",
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    // order matters: the github routes share the /api/containers/c1 prefix
    if (url.startsWith("/api/containers/c1/github/issues")) return json(ISSUES);
    if (url.startsWith("/api/containers/c1/github/pulls")) return json(PULLS);
    if (url.startsWith("/api/containers/c1/github/checks")) return json(CHECKS);
    if (url.startsWith("/api/containers/c1/github/start")) return json({ task_id: "t-99", existing: false }, 201);
    if (url.startsWith("/api/me")) return json({ identity: { agent_id: "h1", github_login: "kedar" }, trusted: true });
    if (url.startsWith("/api/containers/c1")) return json(rawSnap(agents));
    if (url === "/api/containers") return json([{ id: "c1", status: "active" }]);
    return json({});
  }) as unknown as typeof fetch;
  return calls;
}

function mount(initialEntry = "/github") {
  return render(
    <ToastProvider>
      <SnapshotProvider>
        <MemoryRouter initialEntries={[initialEntry]}>
          <GitHubPage />
        </MemoryRouter>
      </SnapshotProvider>
    </ToastProvider>,
  );
}

describe("GitHubPage list (wire-contract render)", () => {
  beforeEach(() => { localStorage.clear(); });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("renders the issues list from the stubbed endpoints", async () => {
    const calls = stubFetch(AGENTS_WITH_HUMAN);
    mount();
    expect(await screen.findByText("Fix login bug")).toBeInTheDocument();
    expect(screen.getByText("#7")).toBeInTheDocument();
    expect(screen.getByText("bug")).toBeInTheDocument();
    expect(screen.getByText("Unassigned")).toBeInTheDocument();
    // the vanilla endpoint, verbatim
    expect(calls.some((c) => c.url === "/api/containers/c1/github/issues" && c.method === "GET")).toBe(true);
    // no "connect a repo" empty card once the repo payload landed
    expect(screen.queryByText("No GitHub repo connected")).not.toBeInTheDocument();
  });

  it("renders the vanilla column-header row above the list", async () => {
    stubFetch(AGENTS_WITH_HUMAN);
    mount();
    await screen.findByText("Fix login bug");
    const head = document.querySelector(".ghhead-row");
    expect(head).not.toBeNull();
    // ID | TITLE | REVIEWERS | CHECKS | MERGE | UPDATED, same cell classes as .ghrow
    expect(head!.querySelector(".ghh-num")!.textContent).toBe("ID");
    expect(head!.querySelector(".ghh-main")!.textContent).toBe("TITLE");
    expect(head!.querySelector(".ghh-reviewers")!.textContent).toBe("REVIEWERS");
    expect(head!.querySelector(".ghh-checks")!.textContent).toBe("CHECKS");
    expect(head!.querySelector(".ghh-merge")!.textContent).toBe("MERGE");
    expect(head!.querySelector(".ghh-updated")!.textContent).toBe("UPDATED");
    // pulls tab keeps the header and adds the / CONTEXT suffix to TITLE
    fireEvent.click(screen.getByText("Pull requests"));
    await screen.findByText("Add OAuth flow");
    expect(document.querySelector(".ghhead-row .ghh-main")!.textContent).toBe("TITLE / CONTEXT");
  });

  it("an issue row carries the empty reviewers/checks/merge columns and the updated cell (vanilla degrade)", async () => {
    stubFetch(AGENTS_WITH_HUMAN);
    mount();
    await screen.findByText("Fix login bug");
    const row = document.querySelector('[data-gh-row="issue:7"]');
    expect(row).not.toBeNull();
    // vanilla issueRowHtml leaves the three PR-only columns present but empty
    // so the shared header lines up over both tabs
    expect(row!.querySelector(".gh-reviewers-col")).not.toBeNull();
    expect(row!.querySelector(".gh-reviewers-col")!.innerHTML).toBe("");
    expect(row!.querySelector(".gh-checks-col")!.innerHTML).toBe("");
    expect(row!.querySelector(".gh-merge-col")!.innerHTML).toBe("");
    // updated relative time renders (never the raw ISO string)
    const updated = row!.querySelector(".gh-updated");
    expect(updated!.textContent).toBeTruthy();
    expect(updated!.textContent).not.toContain("2026-08-01");
  });

  it("pulls tab renders PR rows and progressively fills checks via the batch endpoint", async () => {
    const calls = stubFetch(AGENTS_WITH_HUMAN);
    mount();
    await screen.findByText("Fix login bug");
    fireEvent.click(screen.getByText("Pull requests"));
    expect(await screen.findByText("Add OAuth flow")).toBeInTheDocument();
    expect(screen.getByText("feat/oauth")).toBeInTheDocument();
    // checks:null -> batch GET .../github/checks?numbers=12 -> chip patched
    expect(await screen.findByText("3 passed")).toBeInTheDocument();
    expect(calls.some((c) => c.url === "/api/containers/c1/github/checks?numbers=12")).toBe(true);
    // PR dispatch button reads "Fix", clean mergeable_state shows "Checks passed"
    expect(screen.getByRole("button", { name: "Dispatch an agent to fix checks/review feedback on this PR" })).toBeInTheDocument();
    expect(screen.getByText("Checks passed")).toBeInTheDocument();
  });

  it("a PR row fills the reviewers/checks/merge/updated columns (vanilla pullRowHtml)", async () => {
    stubFetch(AGENTS_WITH_HUMAN);
    mount();
    await screen.findByText("Fix login bug");
    fireEvent.click(screen.getByText("Pull requests"));
    await screen.findByText("3 passed"); // progressive fill settled
    const row = document.querySelector('[data-gh-row="pull:12"]');
    expect(row).not.toBeNull();
    // REVIEWERS: requested_reviewers as overlapping avatars in the reviewers column
    const reviewers = row!.querySelector(".gh-reviewers-col .gh-reviewers");
    expect(reviewers).not.toBeNull();
    expect(reviewers!.querySelectorAll(".av").length).toBe(1); // ["kedar"]
    // CHECKS: the rollup chip (patched in by the batch endpoint) in its column
    const checks = row!.querySelector(".gh-checks-col .tag.gh-checks");
    expect(checks).not.toBeNull();
    expect(checks!.classList.contains("pass")).toBe(true);
    expect(checks!.textContent).toContain("3 passed");
    // MERGE: mergeable_state clean -> the green "Checks passed" merge chip
    const merge = row!.querySelector(".gh-merge-col .tag.gh-merge");
    expect(merge).not.toBeNull();
    expect(merge!.classList.contains("ok")).toBe(true);
    // UPDATED: relative time, never the raw ISO string
    const updated = row!.querySelector(".gh-updated");
    expect(updated!.textContent).toBeTruthy();
    expect(updated!.textContent).not.toContain("2026-08-01");
  });

  it("shows the OrchaSkeleton list shimmer while the list fetch is unsettled", async () => {
    // issues fetch never resolves -> after the 120ms show delay the vanilla
    // "list-rows" skeleton markup (shared skeleton.css classes) fills #ghlist
    const json = (data: unknown, status = 200) =>
      ({ ok: status < 400, status, json: async () => data }) as unknown as Response;
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/containers/c1/github/")) return new Promise<Response>(() => { /* never settles */ });
      if (url.startsWith("/api/me")) return json({ identity: { agent_id: "h1", github_login: "kedar" }, trusted: true });
      if (url.startsWith("/api/containers/c1")) return json(rawSnap(AGENTS_WITH_HUMAN));
      if (url === "/api/containers") return json([{ id: "c1", status: "active" }]);
      return json({});
    }) as unknown as typeof fetch;
    mount();
    await waitFor(() => {
      expect(document.querySelector("#ghlist .ork-sk-wrap .ork-sk-row")).not.toBeNull();
    });
  });
});

describe("GitHubPage Start flow (human-gated mutation)", () => {
  beforeEach(() => { localStorage.clear(); });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("Start posts the exact body and swaps the row to the task chip", async () => {
    const calls = stubFetch(AGENTS_WITH_HUMAN);
    mount();
    await screen.findByText("Fix login bug");
    fireEvent.click(screen.getByRole("button", { name: "Dispatch an agent to work on this issue" }));
    await waitFor(() => {
      const post = calls.find((c) => c.url === "/api/containers/c1/github/start");
      expect(post).toBeTruthy();
      expect(post!.method).toBe("POST");
      // assignee_agent_id omitted on a bare Start (JSON.stringify drops undefined);
      // created_by_agent_id carries the acting human (trust-off attribution)
      expect(post!.body).toEqual({ kind: "issue", number: 7, created_by_agent_id: "h1" });
    });
    expect(await screen.findByText("t-99")).toBeInTheDocument();
    expect(await screen.findByText("Task created")).toBeInTheDocument();
  });

  it("warns and does not POST when no acting human exists", async () => {
    const calls = stubFetch(AGENTS_AI_ONLY);
    mount();
    await screen.findByText("Fix login bug");
    fireEvent.click(screen.getByRole("button", { name: "Dispatch an agent to work on this issue" }));
    expect(await screen.findByText("Pick an acting human first")).toBeInTheDocument();
    expect(calls.some((c) => c.url === "/api/containers/c1/github/start")).toBe(false);
  });
});
