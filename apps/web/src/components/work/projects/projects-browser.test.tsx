import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type * as CloudApiModule from "@/lib/cloud-work-api";
import { cloudApi } from "@/lib/cloud-work-api";
import { ProjectsBrowser } from "./projects-browser";
vi.mock("@/lib/cloud-work-api", async original => ({ ...await original<typeof CloudApiModule>(), cloudApi: vi.fn() }));
vi.mock("@/components/work/cloud/projects/project-governance", () => ({ ProjectGovernance: () => <div>Organization governance controls</div> }));
vi.mock("@/components/work/cloud/projects/project-settings", () => ({ ProjectSettings: ({ admin }: { admin: boolean }) => <div>Member settings: {String(admin)}</div> }));
const project = { id: "p", name: "Client project", description: "Customer discovery", status: "active", revision: 1, access: { role: null, actions: [] } };
beforeEach(() => { vi.resetAllMocks(); window.history.replaceState(null, "", "/work/projects"); });
afterEach(cleanup);
it("shows parent project cards linked to dedicated detail pages without loading content", async () => {
  vi.mocked(cloudApi).mockResolvedValue({ projects: [project], nextCursor: null });
  render(<ProjectsBrowser admin />);
  const card = await screen.findByRole("link", { name: /Client project/ });
  expect(card.getAttribute("href")).toBe("/work/projects/p");
  expect(screen.queryByText("Organization governance controls")).toBeNull();
  expect(vi.mocked(cloudApi).mock.calls.every(([path]) => path.startsWith("/projects?admin=true"))).toBe(true);
});
it("shows admin governance without a temporary content-access request", async () => {
  vi.mocked(cloudApi).mockResolvedValue({ projects: [project], nextCursor: null });
  render(<ProjectsBrowser admin projectId="p" />);
  await screen.findByText("Organization governance controls");
  expect(screen.queryByText("Audited content access")).toBeNull();
  expect(screen.getByRole("link", { name: "All projects" }).getAttribute("href")).toBe("/work/projects");
  expect(screen.queryByRole("button", { name: "Open in Work" })).toBeNull();
});
it("lets an admin open a shared project directly when the server grants access", async () => {
  vi.mocked(cloudApi).mockResolvedValue({ projects: [{ ...project, access: { role: "manager", actions: ["read", "chat", "members.manage"], audited: false, accessRevision: 1, source: "organization_admin" } }], nextCursor: null });
  render(<ProjectsBrowser admin projectId="p" />);
  expect(await screen.findByRole("button", { name: "Open in Work" })).toBeTruthy();
});
it("lets members browse explicitly shared projects without showing administrative settings", async () => {
  vi.mocked(cloudApi).mockResolvedValue({ projects: [{ ...project, access: { role: "viewer", actions: ["read"] } }, { ...project, id: "denied", name: "Unavailable project" }], nextCursor: null });
  render(<ProjectsBrowser admin={false} />);
  await screen.findByRole("link", { name: /Client project/ });
  expect(screen.getByText("View access")).toBeTruthy();
  expect(screen.queryByRole("link", { name: /Unavailable project/ })).toBeNull();
  expect(screen.queryByText("Creation delegation")).toBeNull();
  expect(screen.queryByText("Organization governance controls")).toBeNull();
});
it("loads member detail with member permissions rather than admin governance", async () => {
  vi.mocked(cloudApi).mockImplementation(async path => path.startsWith("/projects?") ? { projects: [{ ...project, access: { role: "manager", actions: ["read", "members.manage"] } }], nextCursor: null } : { ...project, access: { role: "manager", actions: ["read", "members.manage"] } });
  render(<ProjectsBrowser admin={false} projectId="p" />);
  await screen.findByText("Member settings: false");
  expect(screen.queryByText("Organization governance controls")).toBeNull();
  expect(cloudApi).toHaveBeenCalledWith("/projects?admin=false", expect.any(Object));
});
it("does not request an ungranted project detail from a forged URL", async () => {
  vi.mocked(cloudApi).mockResolvedValue({ projects: [], nextCursor: null });
  render(<ProjectsBrowser admin={false} projectId="forged" />);
  await screen.findByText("This project is unavailable or you do not have access.");
  expect(vi.mocked(cloudApi).mock.calls.some(([path]) => path === "/projects/forged")).toBe(false);
});
it("uses the server's role decision for targeted management without promoting a delegate", async () => {
  vi.mocked(cloudApi).mockImplementation(async path => path.startsWith("/projects/management?") ? { projects: [{ ...project, access: { role: "manager", actions: ["read", "instructions.write"] } }], nextCursor: null, canAdminister: false, canCreate: false } : { ...project, access: { role: "manager", actions: ["read", "instructions.write"] } });
  render(<ProjectsBrowser admin projectId="p" management />);
  await screen.findByText("Member settings: false");
  expect(screen.queryByText("Organization governance controls")).toBeNull();
  expect(screen.queryByText("Audited content access")).toBeNull();
  expect(vi.mocked(cloudApi).mock.calls.some(([path]) => path === "/projects?admin=true")).toBe(false);
});
it("filters cards by name or description and explains an empty search", async () => {
  vi.mocked(cloudApi).mockResolvedValue({ projects: [project], nextCursor: null });
  render(<ProjectsBrowser admin />);
  await screen.findByRole("link", { name: /Client project/ });
  fireEvent.change(screen.getByRole("textbox", { name: "Find a project" }), { target: { value: "does not exist" } });
  expect(screen.queryByRole("link", { name: /Client project/ })).toBeNull();
  expect(screen.getByText("No projects match your search.")).toBeTruthy();
});
