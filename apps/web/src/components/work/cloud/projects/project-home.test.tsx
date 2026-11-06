import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { PersonalWorkspaceBinding } from "../cloud-workspace";
import { useState, type ReactNode } from "react";
import type { ProjectNavigationContext } from "./project-navigation";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Viewer } from "@lori-enterprise/contracts";
import type * as CloudApiModule from "@/lib/cloud-work-api";
import { cloudApi } from "@/lib/cloud-work-api";
import { ClientApiError } from "@/lib/client-api";
import { ProjectWorkHome } from "./project-home";
vi.mock("@/lib/cloud-work-api", async original => ({ ...await original<typeof CloudApiModule>(), cloudApi: vi.fn() }));
const fixture = vi.hoisted(() => ({ navigation: false, canLeave: vi.fn(() => true), newConversation: vi.fn(() => true) }));
vi.mock("../cloud-workspace", () => ({ CloudWorkspace: function Fixture({ initialConversationId, project, onPrivateConversation, projectNavigation, personal }: { personal?: PersonalWorkspaceBinding; projectNavigation?: (guard: () => boolean, context: ProjectNavigationContext) => ReactNode; initialConversationId?: string; project?: { id: string }; onPrivateConversation?: () => void }) { const [draft, setDraft] = useState(""); return <>{personal?.panel ? <div>Personal project panel<textarea aria-label="Unsaved personal instructions" value={draft} onChange={e => setDraft(e.target.value)} /></div> : <textarea aria-label="Unsaved project draft" value={draft} onChange={e => setDraft(e.target.value)} />}<output aria-label="Requested conversation">{initialConversationId}</output><output aria-label="New chat project">{personal?.newChatProjectId}</output><output aria-label="Workspace scope">{project?.id ?? "private"}</output><button onClick={onPrivateConversation}>Open private</button>{fixture.navigation && projectNavigation?.(fixture.canLeave, { conversationId: null, conversations: [], disabled: false, openConversation: () => {}, newConversation: fixture.newConversation })}</>; } }));
const project = { id: "p", name: "Client project", updatedAt: "2026-10-01", revision: 1, policy: { providerModels: [] }, access: { actions: ["read", "chat"] } };
const workCapabilities = { contractVersion: 1, enabled: true, available: true, providers: [], features: { chat: true, files: true, tools: true, extensions: false, memory: true } };
beforeEach(() => {
  fixture.navigation = false;
  vi.resetAllMocks(); fixture.canLeave.mockReturnValue(true); fixture.newConversation.mockReturnValue(true); window.history.replaceState(null, "", "/work/cloud?project=p");
  vi.mocked(cloudApi).mockImplementation(async path => path === "/personal-projects/capabilities" ? { version: 1, available: false, canCreate: false, canAdminister: false, count: 0, limit: 100 } : path === "/capabilities" ? workCapabilities : path.endsWith("/files") ? { files: [] } : path === "/conversations/older-chat" ? { conversation: { id: "older-chat", projectId: "p", title: "Older", revision: 1, createdAt: "2026-10-17", updatedAt: "2026-10-17" }, messages: [], runs: [], files: [] } : path.includes("/conversations") ? { conversations: [], nextCursor: null } : path === "/projects/capabilities" ? { available: true, canCreate: false, canAdminister: false } : path.startsWith("/projects?") ? { projects: [project], nextCursor: null } : project);
});
afterEach(cleanup);
it("retains an unsaved editor behind the access lock during a temporary outage", async () => {
  render(<ProjectWorkHome viewer={{ role: "member" } as Viewer} />);
  await waitFor(() => expect(screen.getByLabelText("Unsaved project draft").closest("[inert]")).toBeNull());
  const draft = screen.getByLabelText("Unsaved project draft");
  fireEvent.change(draft, { target: { value: "Unsaved project notes" } });
  act(() => window.dispatchEvent(new Event("offline")));
  expect(screen.getByRole("alert").textContent).toContain("Connect to Enterprise");
  expect(draft.closest("[inert]")).not.toBeNull();
  act(() => window.dispatchEvent(new Event("online")));
  await waitFor(() => expect(draft.closest("[inert]")).toBeNull());
  expect((draft as HTMLTextAreaElement).value).toBe("Unsaved project notes");
});
it("withdraws the mounted editor when verification confirms revocation", async () => {
  render(<ProjectWorkHome viewer={{ role: "member" } as Viewer} />);
  await waitFor(() => expect(screen.getByLabelText("Unsaved project draft").closest("[inert]")).toBeNull());
  const draft = screen.getByLabelText("Unsaved project draft");
  fireEvent.change(draft, { target: { value: "No longer authorized" } });
  vi.mocked(cloudApi).mockRejectedValue(new ClientApiError("project_not_found", "Project was not found", 404));
  act(() => window.dispatchEvent(new Event("online")));
  await waitFor(() => expect(screen.queryByLabelText("Unsaved project draft")).toBeNull());
});

it("passes the requested conversation into the verified project workspace", async () => {
  window.history.replaceState(null, "", "/work/cloud?project=p&conversation=older-chat");
  render(<ProjectWorkHome viewer={{ role: "member" } as Viewer} />);
  await screen.findByLabelText("Unsaved project draft");
  await waitFor(() => expect(screen.getByLabelText("Requested conversation").textContent).toBe("older-chat"));
});

it("keeps the current workspace mounted until destination navigation is authorized", async () => {
  render(<ProjectWorkHome viewer={{ role: "member" } as Viewer} />);
  await waitFor(() => expect(screen.getByLabelText("Workspace scope").textContent).toBe("p"));
  const current = screen.getByLabelText("Unsaved project draft");
  let resolve!: (value: unknown) => void;
  vi.mocked(cloudApi).mockImplementation(path => path.startsWith("/conversations") ? new Promise(done => { resolve = done; }) : Promise.resolve(workCapabilities));
  fireEvent.click(screen.getByRole("button", { name: "Open private" }));
  expect(screen.getByLabelText("Unsaved project draft")).toBe(current);
  expect(current.closest("[inert]")).not.toBeNull();
  expect(screen.getByLabelText("Workspace scope").textContent).toBe("p");
  await waitFor(() => expect(resolve).toBeDefined());
  await act(async () => resolve({ conversations: [], nextCursor: null }));
  expect(screen.getByLabelText("Workspace scope").textContent).toBe("private");
  expect(screen.getByLabelText("Unsaved project draft")).not.toBe(current);
});

it("leaves the current scope intact when destination authorization fails", async () => {
  render(<ProjectWorkHome viewer={{ role: "member" } as Viewer} />);
  await waitFor(() => expect(screen.getByLabelText("Workspace scope").textContent).toBe("p"));
  const current = screen.getByLabelText("Unsaved project draft");
  vi.mocked(cloudApi).mockRejectedValue(new ClientApiError("unavailable", "Connection unavailable", 503));
  fireEvent.click(screen.getByRole("button", { name: "Open private" }));
  await screen.findByRole("alert");
  expect(screen.getByLabelText("Unsaved project draft")).toBe(current);
  expect(screen.getByLabelText("Workspace scope").textContent).toBe("p");
  expect(current.closest("[inert]")).toBeNull();
});

it("sends a manager of another project to the authorized inventory, not the selected read-only project", async () => {
  fixture.navigation = true;
  const original = vi.mocked(cloudApi).getMockImplementation()!;
  vi.mocked(cloudApi).mockImplementation((path, init) => path === "/projects/capabilities"
    ? Promise.resolve({ available: true, canCreate: false, canAdminister: false, canManageProjects: true })
    : original(path, init));
  const assign = vi.spyOn(window.location, "assign").mockImplementation(() => {});
  try {
    render(<ProjectWorkHome viewer={{ role: "member" } as Viewer} />);
    await waitFor(() => expect(screen.getByLabelText("Workspace scope").textContent).toBe("p"));
    fireEvent.click(await screen.findByRole("button", { name: "Manage projects" }));
    expect(assign).toHaveBeenCalledWith("/work/projects");
  } finally { assign.mockRestore(); }
});

it("does not expose project management just because the member is a team admin", async () => {
  fixture.navigation = true;
  render(<ProjectWorkHome viewer={{ role: "member", teamAdmin: true } as Viewer} />);
  await waitFor(() => expect(screen.getByLabelText("Workspace scope").textContent).toBe("p"));
  expect(screen.queryByRole("button", { name: "Manage projects" })).toBeNull();
});

it("checks the workspace guard before replacing a private editor with personal settings", async () => {
  fixture.navigation = true;
  window.history.replaceState(null, "", "/work/cloud");
  const original = vi.mocked(cloudApi).getMockImplementation()!;
  vi.mocked(cloudApi).mockImplementation((path, init) => {
    if (path === "/personal-projects/capabilities") return Promise.resolve({ version: 1, available: true, canCreate: true, canAdminister: false, count: 1, limit: 100 });
    if (path.startsWith("/personal-projects?")) return Promise.resolve({ projects: path.includes("status=active") ? [{ id: "mine", name: "My notes", status: "active", revision: 1, conversationCount: 0, referenceCount: 0, updatedAt: "2026-10-01" }] : [], nextCursor: null });
    return original(path, init);
  });
  render(<ProjectWorkHome viewer={{ role: "member" } as Viewer} />);
  const settings = await screen.findByRole("button", { name: "Instructions and files for My notes" });
  const editor = screen.getByLabelText("Unsaved project draft");
  fireEvent.change(editor, { target: { value: "Keep this file edit" } });
  fixture.canLeave.mockReturnValue(false);
  fireEvent.click(settings);
  expect(fixture.canLeave).toHaveBeenCalledOnce();
  expect(screen.queryByText("Personal project panel")).toBeNull();
  expect(editor).toHaveProperty("value", "Keep this file edit");
  fixture.canLeave.mockReturnValue(true);
  fireEvent.click(settings);
  expect(screen.getByText("Personal project panel")).toBeTruthy();
  expect(vi.mocked(cloudApi).mock.calls.some(([path]) => path.includes("status=deleted"))).toBe(true);
});

it("keeps unsaved personal instructions mounted during refresh outages and withdraws on revocation", async () => {
  fixture.navigation = true;
  window.history.replaceState(null, "", "/work/cloud");
  const original = vi.mocked(cloudApi).getMockImplementation()!;
  let failure: Error | null = null;
  vi.mocked(cloudApi).mockImplementation((path, init) => {
    if (path === "/personal-projects/capabilities") return failure ? Promise.reject(failure) : Promise.resolve({ version: 1, available: true, canCreate: true, canAdminister: false, count: 1, limit: 100 });
    if (path.startsWith("/personal-projects?")) return Promise.resolve({ projects: path.includes("status=active") ? [{ id: "mine", name: "My notes", status: "active", revision: 1, conversationCount: 0, referenceCount: 0, updatedAt: "2026-10-01" }] : [], nextCursor: null });
    return original(path, init);
  });
  render(<ProjectWorkHome viewer={{ role: "member" } as Viewer} />);
  fireEvent.click(await screen.findByRole("button", { name: "Instructions and files for My notes" }));
  const editor = screen.getByLabelText("Unsaved personal instructions");
  fireEvent.change(editor, { target: { value: "Keep my instructions" } });
  failure = new ClientApiError("unavailable", "Temporary outage", 503);
  act(() => window.dispatchEvent(new Event("focus")));
  await screen.findByRole("alert");
  expect(screen.getByLabelText("Unsaved personal instructions")).toBe(editor);
  expect(editor).toHaveProperty("value", "Keep my instructions");
  failure = null;
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  expect(editor).toHaveProperty("value", "Keep my instructions");
  fixture.newConversation.mockReturnValue(false);
  fireEvent.click(screen.getByRole("button", { name: "New conversation in My notes" }));
  expect(screen.getByLabelText("New chat project").textContent).toBe("");
  failure = new ClientApiError("forbidden", "Access revoked", 403);
  act(() => window.dispatchEvent(new Event("focus")));
  await waitFor(() => expect(screen.queryByLabelText("Unsaved personal instructions")).toBeNull());
});
