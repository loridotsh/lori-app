import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Viewer } from "@lori-enterprise/contracts";
import type * as AccountMenuModule from "@/components/account-menu";
import { AppShell } from "./app-shell";
import { WorkRouteShell } from "./work/work-route-shell";
import { cloudApi } from "@/lib/cloud-work-api";
import { useWorkAvailability } from "@/hooks/use-work-availability";
vi.mock("@/lib/cloud-work-api", () => ({ cloudApi: vi.fn() }));
vi.mock("@/hooks/use-work-availability", () => ({ useWorkAvailability: vi.fn() }));
vi.mock("@/components/account-menu", async (importOriginal) => ({ ...(await importOriginal<typeof AccountMenuModule>()), AccountMenu: () => null }));
vi.mock("@/components/theme-toggle", () => ({ ThemeToggle: () => null }));
vi.mock("@/components/work/cloud/work-mode-switch", () => ({ WorkModeSwitch: () => null }));
const route = vi.hoisted(() => ({ pathname: "/work" }));
vi.mock("next/navigation", () => ({ usePathname: () => route.pathname, useRouter: () => ({ refresh: vi.fn() }) }));
const viewer = { organization: { id: "org", name: "Company" }, role: "member", user: { id: "u", name: "Member", email: "m@test.invalid" } } as Viewer;
beforeEach(() => { vi.mocked(useWorkAvailability).mockReturnValue(true); });
afterEach(() => { cleanup(); vi.resetAllMocks(); });
it("preserves the navigation DOM across management routes and loading content", async () => {
  vi.mocked(cloudApi).mockResolvedValue({ available: true, canAdminister: true });
  route.pathname = "/work";
  const { rerender } = render(<WorkRouteShell viewer={viewer}><AppShell current="work" viewer={viewer}>Settings</AppShell></WorkRouteShell>);
  const sidebar = screen.getByRole("complementary");
  await screen.findAllByRole("link", { name: "Projects" });
  route.pathname = "/work/projects";
  rerender(<WorkRouteShell viewer={viewer}><p role="status">Loading projects</p></WorkRouteShell>);
  expect(screen.getByRole("complementary")).toBe(sidebar);
  rerender(<WorkRouteShell viewer={viewer}><AppShell current="projects" viewer={viewer}>Project cards</AppShell></WorkRouteShell>);
  expect(screen.getByRole("complementary")).toBe(sidebar);
  expect(screen.getAllByRole("complementary")).toHaveLength(1);
  route.pathname = "/organization";
  rerender(<WorkRouteShell viewer={viewer}><AppShell current="organization" viewer={viewer}>Access settings</AppShell></WorkRouteShell>);
  expect(screen.getByRole("complementary")).toBe(sidebar);
});
it("names the signed-in member in the sidebar footer, not the organization", async () => {
  vi.mocked(cloudApi).mockResolvedValue({ available: false, canAdminister: false, canManageProjects: false, canCreate: false });
  const piyush = { ...viewer, organization: { id: "org", name: "Ashish" }, user: { id: "p", name: "Piyush Sharma", email: "piyush@test.invalid" } } as Viewer;
  render(<AppShell current="organization" viewer={piyush}>Overview</AppShell>);
  await waitFor(() => expect(cloudApi).toHaveBeenCalled());
  const footers = screen.getAllByTitle("Piyush Sharma (piyush@test.invalid) · Ashish");
  expect(footers.map(footer => footer.textContent)).toEqual(footers.map(() => "Piyush SharmaMember"));
  expect(footers.length).toBeGreaterThan(0);
});
it("hides Projects when neither grants nor creation permission are available", async () => {
  vi.mocked(cloudApi).mockImplementation(async path => path === "/projects/capabilities" ? { available: true, canAdminister: false, canManageProjects: false, canCreate: false } : { projects: [] });
  render(<AppShell current="work" viewer={viewer}>Work</AppShell>);
  await waitFor(() => expect(cloudApi).toHaveBeenCalledWith("/projects?limit=50", expect.any(Object)));
  expect(screen.queryAllByRole("link", { name: "Projects" })).toHaveLength(0);
});
it("shows the nested Work Projects destination for a member with an explicit project grant", async () => {
  vi.mocked(cloudApi).mockImplementation(async path => path === "/projects/capabilities" ? { available: true, canAdminister: false, canManageProjects: false, canCreate: false } : { projects: [{ id: "allowed" }] });
  render(<AppShell current="work" viewer={viewer}>Work</AppShell>);
  const links = await screen.findAllByRole("link", { name: "Projects" });
  expect(links[0]!.getAttribute("href")).toBe("/work/projects");
});
it("hides the destination when Projects are disabled even for a project manager", async () => {
  vi.mocked(cloudApi).mockResolvedValue({ available: false, canAdminister: false, canManageProjects: true, canCreate: false });
  render(<AppShell current="work" viewer={viewer}>Work</AppShell>);
  await waitFor(() => expect(cloudApi).toHaveBeenCalled());
  expect(screen.queryAllByRole("link", { name: "Projects" })).toHaveLength(0);
});

it("continues past a filtered page before deciding that no project is visible", async () => {
  vi.mocked(cloudApi).mockImplementation(async path => path === "/projects/capabilities" ? { available: true, canAdminister: false, canManageProjects: false, canCreate: false } : path.includes("cursor=") ? { projects: [{ id: "allowed" }], nextCursor: null } : { projects: [], nextCursor: "next-page" });
  render(<AppShell current="work" viewer={viewer}>Work</AppShell>);
  await screen.findAllByRole("link", { name: "Projects" });
  expect(cloudApi).toHaveBeenCalledWith("/projects?limit=50&cursor=next-page", expect.any(Object));
});

it("keeps a single management entry without duplicating the existing Work tabs", async () => {
  vi.mocked(cloudApi).mockResolvedValue({ available: true, canAdminister: true });
  render(<AppShell current="work" viewer={{ ...viewer, role: "admin" }}>Providers</AppShell>);
  expect(screen.getByRole("link", { name: "Manage Work" }).getAttribute("href")).toBe("/work");
  expect(screen.getByRole("link", { name: "Manage Work" }).getAttribute("aria-current")).toBe("page");
  for (const name of ["Access & policy", "Providers & models", "Plugins & skills", "Work usage", "Open workspace"])
    expect(screen.queryByRole("link", { name })).toBeNull();
  const group = screen.getByRole("button", { name: "Work", expanded: true });
  fireEvent.click(group);
  expect(screen.queryByRole("link", { name: "Manage Work" })).toBeNull();
  fireEvent.click(group);
  expect(screen.getByRole("link", { name: "Manage Work" })).toBeTruthy();
});

it("keeps personal access discoverable while Work execution is disabled", async () => {
  vi.mocked(useWorkAvailability).mockReturnValue(false);
  vi.mocked(cloudApi).mockResolvedValue({ available: true, canManageProjects: true });
  render(<AppShell current="work" viewer={viewer}>Access</AppShell>);
  expect(screen.getByRole("link", { name: "My Work access" }).getAttribute("href")).toBe("/work");
  expect(screen.queryByRole("link", { name: "Open workspace" })).toBeNull();
  await waitFor(() => expect(cloudApi).toHaveBeenCalled());
  expect(screen.queryByRole("link", { name: "Projects" })).toBeNull();
});
