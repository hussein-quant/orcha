/**
 * MetricsPage — renders the aggregate from GET /api/containers/{cid}/metrics
 * (stat tiles, daily bars, per-agent table) and re-fetches on the 7/30-day
 * range toggle. fetch is stubbed; snapshot flows through the real
 * SnapshotProvider, matching foundation.test.ts style.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { HashRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui";
import { SnapshotProvider } from "../../state/SnapshotProvider";
import { costCaption, fmtDuration, fmtTokens, fmtUsd, MetricsPage } from "./MetricsPage";

const rawSnap = {
  container: { id: "c1", name: "Orcha", status: "active", autonomy_level: "plan" },
  agents: [{ id: "h1", alias: "kedar", kind: "human", status: "idle" }],
  tasks: [],
  requests: [],
};

const payload7 = {
  days: 7,
  totals: {
    runs: 9, runs_with_cost: 6, est_cost_usd: 12.34, sandbox_seconds: 5400,
    tokens_in: 1500, tokens_out: 900, tasks_completed: 4, tasks_verified: 2,
  },
  daily: [
    { date: "2026-07-29", runs: 0, est_cost_usd: 0 },
    { date: "2026-07-30", runs: 4, est_cost_usd: 5.5 },
    { date: "2026-08-04", runs: 5, est_cost_usd: 6.84 },
  ],
  per_agent: [
    {
      agent_id: "a1", alias: "forge", model: "claude-sonnet", runs: 6, ok_runs: 5,
      failed_runs: 1, sandbox_seconds: 3600, tokens_in: 1200, tokens_out: 700,
      est_cost_usd: 10.0,
    },
    {
      agent_id: "a2", alias: "scout", model: null, runs: 3, ok_runs: 3,
      failed_runs: 0, sandbox_seconds: 1800, tokens_in: 300, tokens_out: 200,
      est_cost_usd: 2.34,
    },
  ],
};

function stubFetch(): string[] {
  const urls: string[] = [];
  const json = (data: unknown) =>
    ({ ok: true, status: 200, json: async () => data }) as unknown as Response;
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    if (url === "/api/containers") return json([{ id: "c1", status: "active" }]);
    if (url.includes("/metrics?days=30")) return json({ ...payload7, days: 30 });
    if (url.includes("/metrics?days=7")) return json(payload7);
    if (url.startsWith("/api/containers/c1")) return json(rawSnap);
    return json({});
  }) as unknown as typeof fetch;
  return urls;
}

function mount() {
  return render(
    <ToastProvider>
      <SnapshotProvider>
        <HashRouter>
          <MetricsPage />
        </HashRouter>
      </SnapshotProvider>
    </ToastProvider>,
  );
}

describe("MetricsPage (aggregate endpoint render)", () => {
  beforeEach(() => { localStorage.clear(); });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("fetches /api/containers/c1/metrics?days=7 and renders tiles, bars & table", async () => {
    const urls = stubFetch();
    mount();
    // KPI tiles
    expect(await screen.findByText("$12.34")).toBeInTheDocument();
    // caption appears twice: the Est. cost tile sub AND the agent-table card count
    expect(screen.getAllByText("estimated · 6 of 9 runs reported cost").length).toBe(2);
    expect(screen.getByText("1h 30m")).toBeInTheDocument(); // 5400s sandbox compute
    expect(screen.getByText("4 done")).toBeInTheDocument();
    expect(screen.getByText("2 human-verified")).toBeInTheDocument();
    expect(urls).toContain("/api/containers/c1/metrics?days=7");
    // daily bars: one column per day, honest zero bar (no .mx-bar for 0 runs)
    const cols = document.querySelectorAll(".mx-col");
    expect(cols.length).toBe(3);
    expect(cols[0].querySelector(".mx-bar")).toBeNull();
    expect(cols[2].querySelector(".mx-bar")).toBeTruthy();
    // per-agent table
    expect(screen.getByText("forge")).toBeInTheDocument();
    expect(screen.getByText("claude-sonnet")).toBeInTheDocument();
    expect(screen.getByText("1 failed")).toBeInTheDocument();
    expect(screen.getByText("$10.00")).toBeInTheDocument();
    const agentLink = screen.getByText("forge").closest("a");
    expect(agentLink?.getAttribute("href")).toBe("/agents?agent=forge");
  });

  it("range toggle re-fetches with days=30", async () => {
    const urls = stubFetch();
    mount();
    await screen.findByText("$12.34");
    fireEvent.click(screen.getByText("30 days"));
    await waitFor(() => expect(urls).toContain("/api/containers/c1/metrics?days=30"));
    expect(screen.getByText("last 30 days")).toBeInTheDocument();
  });
});

describe("metrics formatters (metrics-state.js parity)", () => {
  it("fmtUsd: sub-cent 4dp, sub-$1000 2dp, thousands rounded", () => {
    expect(fmtUsd(0)).toBe("$0.00");
    expect(fmtUsd(0.004)).toBe("$0.0040");
    expect(fmtUsd(12.345)).toBe("$12.35");
    expect(fmtUsd(1234.5)).toBe("$1,235");
  });
  it("fmtTokens: K/M with trailing .0 trimmed", () => {
    expect(fmtTokens(999)).toBe("999");
    expect(fmtTokens(1500)).toBe("1.5K");
    expect(fmtTokens(2000000)).toBe("2M");
  });
  it("fmtDuration ladders d/h/m/s", () => {
    expect(fmtDuration(0)).toBe("0s");
    expect(fmtDuration(59)).toBe("59s");
    expect(fmtDuration(150)).toBe("2m 30s");
    expect(fmtDuration(5400)).toBe("1h 30m");
    expect(fmtDuration(90000)).toBe("1d 1h");
  });
  it("costCaption is honest about coverage", () => {
    expect(costCaption({ runs: 0, runs_with_cost: 0 } as never)).toBe("no runs in this window");
    expect(costCaption({ runs: 1, runs_with_cost: 1 } as never)).toBe("estimated · 1 of 1 run reported cost");
  });
});
