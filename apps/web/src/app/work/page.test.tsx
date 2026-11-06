import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import WorkPage from "./page";

const api = vi.hoisted(() => ({
  viewer: vi.fn(),
  policy: vi.fn(),
  catalog: vi.fn(),
  team: vi.fn(),
  member: vi.fn(),
  teamMember: vi.fn(),
  redirect: vi.fn(),
  cloud: vi.fn(),
}));
vi.mock("@/lib/server-api", () => ({
  getViewer: api.viewer,
  getWorkPolicy: api.policy,
  getWorkCatalog: api.catalog,
  getTeam: api.team,
  getMemberPolicy: api.member,
  getTeamMemberPolicy: api.teamMember,
  getCloudAvailability: api.cloud,
}));
vi.mock("next/navigation", () => ({
  redirect: api.redirect,
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock("@/components/app-shell", () => ({
  AppShell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/components/work/work-policy-editor", () => ({
  WorkPolicyEditor: ({
    mode,
    canManageConnections,
  }: {
    mode: string;
    canManageConnections: boolean;
  }) => (
    <div data-testid="editor">
      {mode}:{String(canManageConnections)}
    </div>
  ),
}));
const policy = {
  schemaVersion: 1,
  revision: 3,
  enabled: true,
  personalInstallations: { providers: true, plugins: true, skills: true },
  managedCatalog: [],
  providerModels: [],
  forceAskMe: false,
  memoryAllowed: true,
};
beforeEach(() => {
  vi.clearAllMocks();
  api.redirect.mockImplementation((url: string) => {
    throw new Error(`redirect:${url}`);
  });
  api.viewer.mockResolvedValue({
    status: 200,
    viewer: {
      role: "member",
      organization: { id: "org", name: "Company" },
      user: { id: "user", email: "member@example.test", name: "Member" },
    },
  });
  api.policy.mockResolvedValue({ status: 200, data: policy });
  api.catalog.mockResolvedValue({ status: 200, data: { items: [] } });
  api.cloud.mockResolvedValue({ status: 200, enabled: true });
});
afterEach(cleanup);
describe("Work page roles and recovery", () => {
  it("disables Open Cloud Work and explains why when Work is off", async () => {
    api.cloud.mockResolvedValue({ status: 200, enabled: false });
    render(await WorkPage({ searchParams: Promise.resolve({}) }));
    const open = screen.getByRole("button", { name: "Open Cloud Work" });
    expect(open.hasAttribute("disabled")).toBe(true);
    expect(screen.queryByRole("link", { name: "Open Cloud Work" })).toBeNull();
    expect(screen.getByText("Cloud Work is unavailable")).toBeTruthy();
    expect(screen.getByText(/Ask an administrator to turn it on/)).toBeTruthy();
  });
  it("shows the redirect notice even when availability cannot be read", async () => {
    api.cloud.mockResolvedValue({ status: 503, enabled: null });
    render(
      await WorkPage({ searchParams: Promise.resolve({ cloud: "off" }) }),
    );
    expect(screen.getByText("Cloud Work is unavailable")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Open Cloud Work" }),
    ).toBeTruthy();
  });
  it("keeps Open Cloud Work available when Work is on", async () => {
    render(await WorkPage({ searchParams: Promise.resolve({}) }));
    expect(screen.getByRole("link", { name: "Open Cloud Work" })).toBeTruthy();
    expect(screen.queryByText("Cloud Work is unavailable")).toBeNull();
  });
  it("presents a member's own access without administrator setup controls", async () => {
    render(await WorkPage({ searchParams: Promise.resolve({}) }));
    expect(
      screen.getByRole("heading", { name: "Your Work access" }),
    ).toBeTruthy();
    expect(screen.getByTestId("editor").textContent).toBe("viewer:false");
    expect(screen.queryByText(/Set member access/)).toBeNull();
  });
  it("keeps a temporary failure inside Work with a retry action", async () => {
    api.policy.mockResolvedValue({ status: 503, data: null });
    render(await WorkPage({ searchParams: Promise.resolve({}) }));
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(api.redirect).not.toHaveBeenCalled();
  });
  it("does not load another member's policy for an ordinary member", async () => {
    render(
      await WorkPage({ searchParams: Promise.resolve({ member: "other" }) }),
    );
    expect(screen.getByText(/You don’t have access/)).toBeTruthy();
    expect(api.member).not.toHaveBeenCalled();
    expect(api.policy).not.toHaveBeenCalled();
  });
  it("retains the Work destination when a session expires during loading", async () => {
    api.policy.mockResolvedValue({ status: 401, data: null });
    await expect(
      WorkPage({ searchParams: Promise.resolve({ section: "providers" }) }),
    ).rejects.toThrow("redirect:/sign-in?callback=");
    expect(api.redirect).toHaveBeenCalledWith(
      "/sign-in?callback=%2Fwork%3Fsection%3Dproviders",
    );
  });
  it("shows a missing-team recovery instead of an unrelated access-denied page", async () => {
    api.team.mockResolvedValue({ status: 404, team: null });
    render(
      await WorkPage({ searchParams: Promise.resolve({ team: "removed" }) }),
    );
    expect(
      screen.getByText("This access policy is no longer available"),
    ).toBeTruthy();
    expect(api.redirect).not.toHaveBeenCalled();
  });
});
