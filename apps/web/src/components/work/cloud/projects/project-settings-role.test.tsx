import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { CloudProjectDetail } from "@lori-enterprise/contracts";
import { ProjectSettings } from "./project-settings";
vi.mock("@/lib/cloud-work-api", () => ({ cloudApi: vi.fn(async (path: string) => path === "/capabilities" ? { providers: [] } : { plugins: [] }), cloudError: () => "Unavailable", cloudMutation: vi.fn() }));
vi.mock("./project-members", () => ({ ProjectMembers: () => <div>Access editor</div> }));
vi.mock("./project-memory", () => ({ ProjectMemoryPanel: () => <div>Project memory</div> }));
vi.mock("../cloud-extensions", () => ({ CloudExtensions: () => <div>Connection editor</div> }));
afterEach(cleanup);
const project = { id: "p", name: "Client project", description: "Shared brief", instructions: "Project instructions", status: "active", revision: 1, accessRevision: 1, createdAt: "2026-10-17", updatedAt: "2026-10-17", purgeAfter: null, access: { role: "viewer", actions: ["read"], audited: false, accessRevision: 1 }, policy: { memoryEnabled: true, forceAskMe: true, exportsAllowed: true, externalWritesAllowed: false, managersManageMembers: false, managersManageConnections: false, providerModels: [], pluginIds: [] } } satisfies CloudProjectDetail;
const callbacks = { onChanged: () => {}, onDirtyChange: () => {}, onBusyChange: () => {} };
it("shows shared details read-only to viewers without administrative controls", async () => {
  render(<ProjectSettings project={project} admin={false} {...callbacks} />);
  expect((await screen.findByLabelText("Name") as HTMLInputElement).readOnly).toBe(true);
  expect(screen.queryByRole("button", { name: "Save project" })).toBeNull();
  expect(screen.queryByRole("button", { name: "access" })).toBeNull();
  expect(screen.queryByText("Access editor")).toBeNull();
  expect(screen.queryByText("Connection editor")).toBeNull();
});
it("grants delegated access management without granting instruction editing", async () => {
  render(<ProjectSettings project={{ ...project, policy: { ...project.policy, managersManageMembers: true }, access: { ...project.access, role: "manager", actions: ["read", "members.manage"] } }} admin={false} {...callbacks} />);
  expect((await screen.findByLabelText("Name") as HTMLInputElement).readOnly).toBe(true);
  expect(screen.getByRole("button", { name: "access" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Save project" })).toBeNull();
  expect(screen.queryByRole("button", { name: "connections" })).toBeNull();
});
