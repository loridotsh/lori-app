import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type * as CloudApiModule from "@/lib/cloud-work-api";
import { cloudApi } from "@/lib/cloud-work-api";
import { ProjectMembers } from "./project-members";
vi.mock("@/lib/cloud-work-api", async original => ({ ...await original<typeof CloudApiModule>(), cloudApi: vi.fn() }));
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(16, 16, 320, 40));
  Object.defineProperty(document.documentElement, "clientWidth", { configurable: true, value: 1024 });
  Object.defineProperty(document.documentElement, "clientHeight", { configurable: true, value: 768 });
  vi.mocked(cloudApi).mockImplementation(async path => path.includes("directory") ? { members: [{ id: "owner", name: "Owner", email: "owner@example.test" }, { id: "member", name: "Alex", email: "alex@example.test" }], teams: [] } : { revision: 1, grants: [{ id: "g", kind: "member", subjectId: "owner", role: "manager", deniedActions: [] }], blocks: [] });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.mocked(cloudApi).mockReset(); Reflect.deleteProperty(document.documentElement, "clientWidth"); Reflect.deleteProperty(document.documentElement, "clientHeight"); });
it("searches and stages access changes without mutating permissions until Save", async () => {
  render(<ProjectMembers projectId="project" admin onSaved={() => {}} />);
  await waitFor(() => expect((screen.getByRole("combobox", { name: "Member or team" }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole("combobox", { name: "Member or team" }));
  const search = await screen.findByRole("combobox", { name: "Search member or team" });
  fireEvent.change(search, { target: { value: "alex@example.test" } });
  fireEvent.keyDown(search, { key: "Enter" });
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  await screen.findByRole("combobox", { name: "Role for Alex (alex@example.test)" });
  expect(vi.mocked(cloudApi).mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "Save access" }));
  await waitFor(() => expect(vi.mocked(cloudApi).mock.calls.some(([, init]) => init?.method === "PUT")).toBe(true));
  const mutation = vi.mocked(cloudApi).mock.calls.find(([, init]) => init?.method === "PUT")!;
  expect(JSON.parse(String(mutation[1]?.body))).toMatchObject({ expectedRevision: 1, grants: expect.arrayContaining([{ kind: "member", subjectId: "member", role: "contributor", deniedActions: [] }]) });
});
it("keeps already-assigned people visible but unavailable for duplicate grants", async () => {
  render(<ProjectMembers projectId="project" admin onSaved={() => {}} />);
  await waitFor(() => expect((screen.getByRole("combobox", { name: "Member or team" }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole("combobox", { name: "Member or team" }));
  const owner = await screen.findByRole("option", { name: /Owner Already added/ });
  expect(owner.getAttribute("aria-disabled")).toBe("true");
  fireEvent.click(owner);
  expect((screen.getByRole("button", { name: "Add" }) as HTMLButtonElement).disabled).toBe(true);
});

it("explains the last-manager rule to a delegated manager before allowing an invalid downgrade", async () => {
  render(<ProjectMembers projectId="project" admin={false} onSaved={() => {}} />);
  const role = await screen.findByRole("combobox", { name: "Role for Owner (owner@example.test)" });
  expect((screen.getByRole("button", { name: "Remove" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(role);
  expect((await screen.findByRole("option", { name: /Viewer Assign another direct manager first/ })).getAttribute("aria-disabled")).toBe("true");
  expect(screen.getByRole("option", { name: /Contributor Assign another direct manager first/ }).getAttribute("aria-disabled")).toBe("true");
});

it("lets organization admins leave a project without a delegated manager", async () => {
  render(<ProjectMembers projectId="project" admin onSaved={() => {}} />);
  await screen.findByRole("combobox", { name: "Role for Owner (owner@example.test)" });
  await waitFor(() => expect((screen.getByRole("button", { name: "Remove" }) as HTMLButtonElement).disabled).toBe(false));
});

it("explains effective project resources with their source and denial reasons", async () => {
  vi.mocked(cloudApi).mockImplementation(async path => path.includes("directory") ? { members: [{ id: "member", name: "Alex", email: "alex@example.test" }], teams: [] } : path.includes("/effective") ? {
    access: { role: "contributor", actions: ["read", "chat"], audited: false, accessRevision: 1, source: "grant" }, workEnabled: true, blocked: false, administrator: false, sources: [],
    resources: { providerMode: "assigned", pluginMode: "inherit", skillMode: "inherit",
      models: [{ id: "m1", name: "m1", providerId: "openai", providerName: "OpenAI", allowed: true, source: "project_assignment" }, { id: "m2", name: "m2", providerId: "openai", providerName: "OpenAI", allowed: false, reason: "not_approved" }],
      plugins: [{ id: "notion", name: "Notion", allowed: false, reason: "member_restricted" }], skills: [] },
  } : { revision: 1, grants: [], blocks: [] });
  render(<ProjectMembers projectId="project" admin onSaved={() => {}} />);
  fireEvent.click(await screen.findByText("Effective access"));
  fireEvent.click(screen.getByRole("combobox", { name: "Preview member access" }));
  fireEvent.click(await screen.findByRole("option", { name: /Alex/ }));
  expect(await screen.findByText("OpenAI · m1 (project)")).toBeTruthy();
  expect(screen.getByText("OpenAI · m2: not approved by the organization")).toBeTruthy();
  expect(screen.getByText("Notion: blocked for this member")).toBeTruthy();
});
