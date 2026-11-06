import type { UsageAnalyticsResponse, Viewer } from "@lori-enterprise/contracts";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { UsageDashboard } from "./usage-dashboard";

const { clientApiMock, replaceMock } = vi.hoisted(() => ({
  clientApiMock: vi.fn(),
  replaceMock: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: replaceMock }),
  useSearchParams: () => new URLSearchParams("range=30d"),
}));

vi.mock("@/lib/client-api", () => ({
  ClientApiError: class extends Error {
    public constructor(
      public readonly code: string,
      message: string,
      public readonly status: number,
    ) { super(message); }
  },
  clientApi: clientApiMock,
}));

const analytics: UsageAnalyticsResponse = {
  agents: [{ estimatedCostMicrousd: 1_000_000, id: "codex", label: "Codex", totalTokens: 100, totalTurns: 2 }],
  collectionEnabled: true,
  freshness: { lastReceivedAt: "2026-08-11T10:00:00.000Z", stale: false },
  models: [{ estimatedCostMicrousd: 1_000_000, id: "gpt-test", label: "GPT Test", totalTokens: 100, totalTurns: 2 }],
  range: { from: "2026-08-01", granularity: "day", to: "2026-08-11" },
  scope: { name: "Acme", type: "organization" },
  series: [{ cacheReadTokens: 10, cacheWriteTokens: 10, estimatedCostMicrousd: 1_000_000, inputTokens: 40, label: "2026-08-11", outputTokens: 40, totalTokens: 100, totalTurns: 2 }],
  totals: { activeMembers: 1, cacheReadTokens: 10, cacheWriteTokens: 10, costCoveragePercent: 80, estimatedCostMicrousd: 1_000_000, inputTokens: 40, outputTokens: 40, totalTokens: 100, totalTurns: 2 },
};

const admin: Viewer = {
  organization: { id: "org-1", name: "Acme" },
  role: "admin",
  usageAnalytics: { canManage: true, canView: true },
  user: { email: "admin@example.com", id: "user-1", name: "Admin" },
};

describe("UsageDashboard", () => {
  it("ignores an older product response after navigating to Work usage", async () => {
    let resolveCode!: (value: UsageAnalyticsResponse) => void;
    clientApiMock.mockImplementation((path: string) => path.includes("product=code")
      ? new Promise<UsageAnalyticsResponse>(resolve => { resolveCode = resolve; })
      : Promise.resolve({ ...analytics, models: [{ ...analytics.models[0]!, label: "Current Work Model" }] }));
    const view = render(<UsageDashboard viewer={admin} />);
    await waitFor(() => expect(clientApiMock).toHaveBeenCalled());
    view.rerender(<UsageDashboard viewer={admin} product="work" />);
    await screen.findByText("Current Work Model");
    await act(async () => { resolveCode({ ...analytics, models: [{ ...analytics.models[0]!, label: "Stale Code Model" }] }); });
    expect(screen.queryByText("Stale Code Model")).toBeNull();
    expect(screen.getByText("Current Work Model")).toBeTruthy();
  });
  it("distinguishes free and unpriced models within partially covered Work usage", async () => {
    clientApiMock.mockResolvedValue({...analytics, models:[
      {id:"free",label:"Free model",totalTokens:50,totalTurns:1,estimatedCostMicrousd:0,costCoveragePercent:100},
      {id:"unknown",label:"Unpriced model",totalTokens:50,totalTurns:1,estimatedCostMicrousd:0,costCoveragePercent:0},
    ]});
    render(<UsageDashboard viewer={admin} product="work" />);
    expect(await screen.findByLabelText(/Unpriced model:.*estimated cost unavailable/)).toBeTruthy();
    expect(screen.getByLabelText(/Free model:.*estimated cost \$0/)).toBeTruthy();
  });
  beforeEach(() => {
    clientApiMock.mockReset();
    replaceMock.mockReset();
    clientApiMock.mockResolvedValue(analytics);
  });

  it("shows admin controls, explicit estimated-cost coverage, and accessible trend data", async () => {
    const { container } = render(<UsageDashboard viewer={admin} />);
    expect(await screen.findByText("Total tokens")).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Members" })).toBeTruthy();
    expect(screen.getByText(/Pricing covered 80.0%/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /2026: 100 tokens/ })).toBeTruthy();
    expect(
      container.querySelector('[data-slot="usage-chart-single-marker"]'),
    ).toBeTruthy();
    expect(
      screen.getAllByLabelText(/: 100 tokens, 2 turns, estimated cost/),
    ).toHaveLength(2);
    expect(screen.getByText("Usage data").closest("details")?.hasAttribute("open")).toBe(true);
    expect(screen.getByText("1 period")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Export CSV" }).getAttribute("href"),
    ).toContain("/api/v1/admin/usage/export.csv");
    await waitFor(() =>
      expect(clientApiMock).toHaveBeenCalledWith(
        expect.stringContaining("/v1/admin/usage?"),
        expect.anything(),
      ),
    );
  });

  it("keeps organization rankings and settings out of the member view", async () => {
    render(<UsageDashboard viewer={{ ...admin, role: "member", usageAnalytics: { canManage: false, canView: true } }} />);
    expect(await screen.findByText("Total tokens")).toBeTruthy();
    expect(screen.queryByRole("tab", { name: "Members" })).toBeNull();
    expect(screen.getByRole("link", { name: "Export CSV" }).getAttribute("href")).toContain("/api/v1/usage/export.csv");
    await waitFor(() => expect(clientApiMock).toHaveBeenCalledWith(expect.stringContaining("/v1/usage?"), expect.anything()));
  });

  it("preserves rapid URL filter changes before navigation settles", async () => {
    const user = userEvent.setup();
    render(<UsageDashboard viewer={admin} />);
    await screen.findByText("Total tokens");
    await user.click(screen.getByRole("button", { name: "Estimated cost" }));
    await user.click(screen.getByRole("button", { name: "Filters: All activity" }));
    await user.click(await screen.findByRole("menuitemradio", { name: "GPT Test" }));
    expect(replaceMock).toHaveBeenLastCalledWith(
      "/usage?range=30d&metric=cost&model=gpt-test",
      { scroll: false },
    );
  });
});
