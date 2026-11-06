import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type * as ApiModule from "@/lib/cloud-work-api";
import { cloudApi } from "@/lib/cloud-work-api";
import { ClientApiError } from "@/lib/client-api";
import { ManagedProjectsBrowser } from "./managed-projects-browser";
vi.mock("@/lib/cloud-work-api", async original => ({ ...await original<typeof ApiModule>(), cloudApi: vi.fn() }));
vi.mock("./creation/creation-access", () => ({ CreationAccess: () => <div>Organization creation delegation</div> }));
const project = { id: "p", name: "Administrative project", description: "Existing shared workspace", status: "active", access: { role: "manager", actions: ["read", "instructions.write"] } };
const adminPage = { projects: [{ ...project, assignments: { teams: [{ id: "team", name: "Delivery", role: "contributor" }], members: [{ id: "member", name: "Alex", role: "contributor", blocked: false }], teamCount: 1, directMemberCount: 1, blockedMemberCount: 0 } }], nextCursor: null, canCreate: true, canAdminister: true, total: 1, activeCount: 1 };
beforeEach(() => vi.resetAllMocks()); afterEach(cleanup);
it("shows org-admin creation and assignments with links to management", async () => {
  vi.mocked(cloudApi).mockResolvedValue(adminPage);
  render(<ManagedProjectsBrowser />);
  await screen.findByText("Delivery");
  expect(screen.getByRole("button", { name: "Create project" })).toBeTruthy();
  expect(screen.queryByText("Organization creation delegation")).toBeNull();
  expect(screen.getByRole("tab", { name: "All projects" }).getAttribute("aria-selected")).toBe("true");
  expect(screen.getByRole("link", { name: "Administrative project" }).getAttribute("href")).toBe("/work/projects/p");
  expect(vi.mocked(cloudApi).mock.calls.every(([path]) => (path.startsWith("/projects/management?") || path === "/personal-projects/capabilities"))).toBe(true);
});
it("gives administrators a dedicated Creation access tab that loads on first use and can be deep-linked", async () => {
  vi.mocked(cloudApi).mockResolvedValue(adminPage);
  render(<ManagedProjectsBrowser />);
  await screen.findByText("Delivery");
  fireEvent.click(screen.getByRole("tab", { name: "Creation access" }));
  expect(screen.getByText("Organization creation delegation")).toBeTruthy();
  expect(screen.getByRole("tab", { name: "Creation access" }).getAttribute("aria-selected")).toBe("true");
  expect(new URL(window.location.href).searchParams.get("tab")).toBe("creation");
  fireEvent.click(screen.getByRole("tab", { name: "All projects" }));
  expect(new URL(window.location.href).searchParams.get("tab")).toBeNull();
  expect(screen.getByRole("link", { name: "Administrative project" })).toBeTruthy();
});
it("opens on the Creation access tab when the link asks for it", async () => {
  vi.mocked(cloudApi).mockResolvedValue(adminPage);
  render(<ManagedProjectsBrowser initialTab="creation" />);
  await screen.findByText("Delivery");
  expect(screen.getByRole("tab", { name: "Creation access" }).getAttribute("aria-selected")).toBe("true");
  expect(screen.getByText("Organization creation delegation")).toBeTruthy();
});
it("keeps organization controls and assignment filters out of delegated-manager views", async () => {
  vi.mocked(cloudApi).mockResolvedValue({ projects: [project], nextCursor: null, canCreate: false, canAdminister: false });
  render(<ManagedProjectsBrowser />); await screen.findByRole("link", { name: "Administrative project" });
  expect(screen.queryByRole("button", { name: "Create project" })).toBeNull();
  expect(screen.queryByRole("tab")).toBeNull();
  expect(screen.queryByText("Organization creation delegation")).toBeNull();
  expect(screen.queryByText("Filter by assignments")).toBeNull();
  expect(screen.getByText(/Assignment management is not delegated/)).toBeTruthy();
});
it("withdraws management metadata and controls when authority is revoked", async () => {
  vi.mocked(cloudApi).mockResolvedValue(adminPage);
  render(<ManagedProjectsBrowser />); await screen.findByRole("link", { name: "Administrative project" });
  vi.mocked(cloudApi).mockRejectedValue(new ClientApiError("project_action_denied", "Management access changed", 403));
  act(() => window.dispatchEvent(new Event("focus")));
  await screen.findByRole("alert");
  expect(screen.queryByText("Administrative project")).toBeNull();
  expect(screen.queryByRole("button", { name: "Create project" })).toBeNull();
});
it("searches through empty encrypted-summary pages and supports cancellation", async () => {
  vi.mocked(cloudApi).mockImplementation(async path => path.includes("query=needle") ? path.includes("cursor=next") ? { ...adminPage, projects: [{ ...project, name: "Needle project" }], nextCursor: null } : { ...adminPage, projects: [], nextCursor: "next" } : adminPage);
  render(<ManagedProjectsBrowser />); await screen.findByRole("link", { name: "Administrative project" });
  fireEvent.change(screen.getByRole("textbox", { name: "Find a managed project" }), { target: { value: "needle" } });
  await screen.findByRole("link", { name: "Needle project" });
  await waitFor(() => expect(vi.mocked(cloudApi).mock.calls.some(([path]) => path.includes("cursor=next") && path.includes("query=needle"))).toBe(true));
});

it.each(["project_disabled", "project_keys_unavailable"])("keeps personal creation administration reachable with %s", async code => {
  vi.mocked(cloudApi).mockImplementation(async path => {
    if (path === "/personal-projects/capabilities") return { version: 1, available: true, canCreate: true, canAdminister: true, count: 0, limit: 100 };
    throw new ClientApiError(code, "Team projects unavailable", 503);
  });
  render(<ManagedProjectsBrowser initialTab="creation" />);
  expect(await screen.findByRole("tab", { name: "Creation access" })).toBeTruthy();
  expect(screen.getByText("Organization creation delegation")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Create project" })).toBeNull();
  vi.mocked(cloudApi).mockRejectedValue(new ClientApiError("admin_required", "Access revoked", 403));
  act(() => window.dispatchEvent(new Event("focus")));
  await waitFor(() => expect(screen.queryByRole("tab", { name: "Creation access" })).toBeNull());
});
