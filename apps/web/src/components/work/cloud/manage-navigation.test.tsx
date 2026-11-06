import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { CloudProjectDetail, ProjectAction, ProjectCapabilities, Viewer } from "@lori-enterprise/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { CloudDestinations } from "./cloud-destinations";

afterEach(cleanup);
const viewer: Viewer = { role: "member", user: { id: "u", name: "Member", email: "member@example.com" }, organization: { id: "o", name: "Company" } };
const caps: ProjectCapabilities = { version: 1, available: true, canCreate: false, canAdminister: false, canManageProjects: false };
const project: CloudProjectDetail = {
  id: "00000000-0000-4000-8000-000000000001", name: "Project A", description: "", instructions: "", status: "active",
  revision: 1, accessRevision: 1, createdAt: "2026-10-26", updatedAt: "2026-10-26", purgeAfter: null,
  access: { role: "viewer", actions: ["read"], audited: false, accessRevision: 1 },
  policy: { memoryEnabled: true, forceAskMe: true, exportsAllowed: false, externalWritesAllowed: false, managersManageMembers: false, managersManageConnections: false, providerModels: [], pluginIds: [] },
};
const base = { view: "settings" as const, admin: false, viewer, capabilities: null, conversationId: null, onBack: vi.fn(), onSaved: vi.fn(), onFailure: vi.fn() };

it.each([
  ["member", viewer, caps, "Manage account", "/"],
  ["organization admin", { ...viewer, role: "admin" as const }, caps, "Manage organization", "/"],
  ["team admin", { ...viewer, teamAdmin: true }, caps, "Manage teams", "/teams"],
  ["delegated project manager", viewer, { ...caps, canManageProjects: true }, "Manage projects", "/work/projects"],
  ["project creator", viewer, { ...caps, canCreate: true }, "Manage projects", "/work/projects"],
  ["combined team and project admin", { ...viewer, teamAdmin: true }, { ...caps, canManageProjects: true }, "Manage teams", "/teams"],
  ["unavailable projects", viewer, { ...caps, available: false, canManageProjects: true }, "Manage account", "/"],
] as const)("routes %s to the existing authorized management surface", (_role, account, projectCapabilities, label, href) => {
  render(<CloudDestinations {...base} viewer={account} admin={account.role === "admin"} projectCapabilities={projectCapabilities} />);
  expect(screen.getByRole("link", { name: label }).getAttribute("href")).toBe(href);
  expect(screen.getAllByRole("link")).toHaveLength(1);
});

it.each(["viewer", "contributor", "manager"] as const)("does not infer project management from a %s role or team administration", role => {
  render(<CloudDestinations {...base} viewer={{ ...viewer, teamAdmin: true }} projectCapabilities={{ ...caps, canManageProjects: true }} project={{ ...project, access: { ...project.access, role, actions: ["read"] } }} />);
  expect(screen.queryByRole("link")).toBeNull();
});

it.each(["instructions.write", "members.manage", "connections.manage"] as ProjectAction[])("allows only the selected project with effective %s permission", action => {
  render(<CloudDestinations {...base} project={{ ...project, access: { ...project.access, role: "manager", actions: ["read", action] } }} />);
  expect(screen.getByRole("link", { name: "Manage project" }).getAttribute("href")).toBe(`/work/projects/${project.id}`);
  expect(screen.queryByRole("link", { name: "Manage account" })).toBeNull();
});

it("withdraws the entry immediately after effective management permission is revoked", () => {
  const { rerender } = render(<CloudDestinations {...base} project={{ ...project, access: { ...project.access, role: "manager", actions: ["read", "members.manage"] } }} />);
  expect(screen.getByRole("link", { name: "Manage project" })).toBeTruthy();
  rerender(<CloudDestinations {...base} project={{ ...project, access: { ...project.access, role: "manager", actions: [] } }} />);
  expect(screen.queryByRole("link")).toBeNull();
});

it("keeps archived project editing unavailable to members even with stale actions", () => {
  render(<CloudDestinations {...base} project={{ ...project, status: "archived", access: { ...project.access, actions: ["read", "instructions.write"] } }} />);
  expect(screen.queryByRole("link")).toBeNull();
});

it("keeps the organization administration entry in an audited project context", () => {
  render(<CloudDestinations {...base} viewer={{ ...viewer, role: "admin" }} admin project={{ ...project, status: "archived", access: { ...project.access, role: null, actions: ["read"], audited: true } }} />);
  expect(screen.getByRole("link", { name: "Manage organization" }).getAttribute("href")).toBe("/");
  expect(screen.queryByRole("link", { name: "Manage project" })).toBeNull();
});

it("preserves the unsaved-change guard for delegated team navigation", () => {
  const guard = vi.fn(() => false);
  render(<CloudDestinations {...base} viewer={{ ...viewer, teamAdmin: true }} beforeManageNavigate={guard} />);
  const event = new MouseEvent("click", { bubbles: true, cancelable: true });
  fireEvent(screen.getByRole("link", { name: "Manage teams" }), event);
  expect(guard).toHaveBeenCalledOnce();
  expect(event.defaultPrevented).toBe(true);
});

it("keeps the admin destination stable when moving from private Work into an active project", () => {
  const account = { ...viewer, role: "admin" as const };
  const { rerender } = render(<CloudDestinations {...base} viewer={account} admin />);
  expect(screen.getByRole("link", { name: "Manage organization" }).getAttribute("href")).toBe("/");
  rerender(<CloudDestinations {...base} viewer={account} admin project={{ ...project, access: { ...project.access, role: "manager", actions: ["read", "members.manage"] } }} />);
  expect(screen.getByRole("link", { name: "Manage organization" }).getAttribute("href")).toBe("/");
  expect(screen.queryByRole("link", { name: "Manage project" })).toBeNull();
});

it("does not promote a member to organization administration from a stale admin flag", () => {
  render(<CloudDestinations {...base} admin project={{ ...project, access: { ...project.access, role: "manager", actions: ["read", "members.manage"] } }} />);
  expect(screen.queryByRole("link", { name: "Manage organization" })).toBeNull();
  expect(screen.getByRole("link", { name: "Manage project" }).getAttribute("href")).toBe(`/work/projects/${project.id}`);
});
