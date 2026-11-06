import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import OverviewPage from "./page";
const usage = vi.hoisted(() => vi.fn());
vi.mock("@/lib/server-api", () => ({
  getSetupStatus: async () => ({ state: "ready" }),
  getViewer: async () => ({ viewer: { role: "admin", user: { name: "Test" }, organization: { name: "Company" }, usageAnalytics: { canView: true } }, status: 200 }),
  getDevices: async () => ({ devices: { devices: [] } }),
  getPeople: async () => ({ people: { members: [] } }),
  getPolicy: async () => ({ policy: null }),
  getTeams: async () => ({ teams: { teams: [] } }),
  getUsageAnalytics: usage,
}));
vi.mock("@/components/app-shell", () => ({ AppShell: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock("@/components/open-lori-control", () => ({ OpenLoriControl: () => null }));
it("includes Work independently of Code and keeps unpriced token totals visible", async () => {
  usage.mockImplementation(async (_admin, _from, _to, product) => ({ analytics: { totals: { totalTokens: product === "work" ? 1234 : 0, estimatedCostMicrousd: 0, costCoveragePercent: 0 } } }));
  render(await OverviewPage());
  expect(usage).toHaveBeenCalledWith(true, expect.any(String), expect.any(String), "work");
  expect(screen.getByText("1,234")).toBeTruthy();
  expect(screen.getByText("Estimated Work cost").parentElement?.textContent).toContain("Unavailable");
  expect(screen.getByRole("link", { name: "Open Work usage" }).getAttribute("href")).toBe("/work/usage");
});
