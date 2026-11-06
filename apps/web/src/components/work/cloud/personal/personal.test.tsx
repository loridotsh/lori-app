import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudConversation, PersonalProject, PersonalProjectCapabilities, PersonalProjectDetail } from "@lori-enterprise/contracts";
import type * as CloudApiModule from "@/lib/cloud-work-api";
import { cloudApi } from "@/lib/cloud-work-api";
import { MoveConversationDialog } from "./move-conversation-dialog";
import { ProjectNavigation, type ProjectNavigationContext } from "../projects/project-navigation";
import type { PersonalRowHandlers } from "./personal-navigation";
import { PersonalProjectPanel } from "./personal-project-panel";

vi.mock("@/lib/cloud-work-api", async (original) => ({ ...(await original<typeof CloudApiModule>()), cloudApi: vi.fn() }));
// happy-dom has no <dialog> modal support for these assertions; the shared Dialog reflects `open`.
const project = (over: Partial<PersonalProject> = {}): PersonalProject => ({
  id: "p1", name: "Quarterly planning", description: "", status: "active", revision: 1,
  createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-02T00:00:00Z", archivedAt: null, deletedAt: null, purgeAfter: null,
  conversationCount: 0, referenceCount: 0, ...over,
});
const detail = (over: Partial<PersonalProjectDetail> = {}): PersonalProjectDetail => ({ ...project(), instructions: "Be brief.", ...over });
const chat = (n: number, over: Partial<CloudConversation> = {}): CloudConversation => ({
  id: `c${n}`, title: `Chat ${n}`, revision: 1, createdAt: "2026-10-01T00:00:00Z", updatedAt: `2026-10-0${n}T00:00:00Z`, personalProjectId: "p1", ...over,
});
const capabilities: PersonalProjectCapabilities = { version: 1, available: true, canCreate: true, source: "everyone", count: 1, limit: 100, canAdminister: false, recoveryDays: 30 };
const context = { conversationId: null, conversations: [], disabled: false, openConversation: vi.fn(), newConversation: vi.fn() };

const confirm = vi.fn();
beforeEach(() => {
  vi.resetAllMocks();
  Object.defineProperty(window, "confirm", { value: confirm, configurable: true, writable: true });
});
afterEach(cleanup);

function PersonalNavigation({ projects, context: ctx, onCreate, ...handlers }: PersonalRowHandlers & { projects: PersonalProject[]; context: ProjectNavigationContext; onCreate?: () => void }) {
  return <ProjectNavigation projects={[]} personal={{ projects, ...handlers }} selected={null} expanded={new Set()} onToggle={vi.fn()} context={ctx} onOpen={vi.fn()} onPrivate={vi.fn()}
    creation={onCreate ? { options: [{ kind: "personal", label: "Personal project", description: "" }], onChoose: onCreate } : undefined} />;
}

describe("Personal projects in the Projects list", () => {
  const props = { context, activeProjectId: null, panelProjectId: null, refreshKey: "0", onOpen: vi.fn(), onNew: vi.fn(), onSettings: vi.fn() };
  it("lists projects, loads a project's chats only when it is opened and opens one", async () => {
    vi.mocked(cloudApi).mockResolvedValue({ conversations: [chat(1), chat(2)], nextCursor: null });
    const onOpen = vi.fn();
    render(<PersonalNavigation {...props} projects={[project()]} onOpen={onOpen} />);
    expect(screen.getByRole("heading", { name: "Projects" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Personal projects" })).toBeNull();
    expect(cloudApi).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Expand Quarterly planning" }));
    fireEvent.click(await screen.findByRole("button", { name: "Chat 2" }));
    expect(cloudApi).toHaveBeenCalledWith("/personal-projects/p1/conversations?limit=6", expect.anything());
    expect(onOpen).toHaveBeenCalledWith("p1", "c2");
  });
  it("loads every cursor page and preserves expanded history on refresh", async () => {
    const chats = Array.from({ length: 112 }, (_, index) => chat(index + 1, { updatedAt: "2026-10-01T00:00:00Z" }));
    vi.mocked(cloudApi).mockImplementation(async path => {
      const query = new URL(path, "https://test.invalid").searchParams;
      const start = Number(query.get("cursor") ?? 0), limit = Number(query.get("limit"));
      return { conversations: chats.slice(start, start + limit), nextCursor: start + limit < chats.length ? String(start + limit) : null };
    });
    render(<PersonalNavigation {...props} projects={[project()]} />);
    fireEvent.click(screen.getByRole("button", { name: "Expand Quarterly planning" }));
    await screen.findByRole("button", { name: "Chat 6" });
    fireEvent.click(screen.getByRole("button", { name: "More conversations in Quarterly planning" }));
    await screen.findByRole("button", { name: "Chat 56" });
    fireEvent.click(screen.getByRole("button", { name: "More conversations in Quarterly planning" }));
    await screen.findByRole("button", { name: "Chat 106" });
    fireEvent.click(screen.getByRole("button", { name: "More conversations in Quarterly planning" }));
    await screen.findByRole("button", { name: "Chat 112" });
    expect(screen.queryByRole("button", { name: "More conversations in Quarterly planning" })).toBeNull();
    act(() => window.dispatchEvent(new Event("focus")));
    await waitFor(() => expect(vi.mocked(cloudApi).mock.calls.some(([path]) => path.includes("cursor=100"))).toBe(true));
    expect(screen.getByRole("button", { name: "Chat 112" })).toBeTruthy();
  });
  it("keeps earlier chats and retries the same cursor after a page fails", async () => {
    vi.mocked(cloudApi).mockResolvedValueOnce({ conversations: Array.from({ length: 6 }, (_, i) => chat(i + 1)), nextCursor: "older" })
      .mockRejectedValueOnce(new Error("Temporary failure"))
      .mockResolvedValueOnce({ conversations: [chat(7)], nextCursor: null });
    render(<PersonalNavigation {...props} projects={[project()]} />);
    fireEvent.click(screen.getByRole("button", { name: "Expand Quarterly planning" }));
    fireEvent.click(await screen.findByRole("button", { name: "More conversations in Quarterly planning" }));
    await screen.findByRole("alert");
    expect(screen.getByRole("button", { name: "Chat 1" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "More conversations in Quarterly planning" }));
    await screen.findByRole("button", { name: "Chat 7" });
    expect(vi.mocked(cloudApi).mock.calls.slice(1).every(([path]) => path.endsWith("cursor=older"))).toBe(true);
  });
  it("exposes deleted projects through recovery without offering chats", () => {
    const onSettings = vi.fn();
    render(<PersonalNavigation {...props} projects={[project({ status: "deleted" })]} onSettings={onSettings} />);
    fireEvent.click(screen.getByText("Deleted personal projects"));
    fireEvent.click(screen.getByRole("button", { name: "Recover Quarterly planning" }));
    expect(onSettings).toHaveBeenCalledWith("p1");
    expect(screen.queryByRole("button", { name: /New conversation in/ })).toBeNull();
  });
  it("starts a chat inside the project and opens its instructions and files", async () => {
    vi.mocked(cloudApi).mockResolvedValue({ conversations: [], nextCursor: null });
    const onNew = vi.fn(), onSettings = vi.fn();
    render(<PersonalNavigation {...props} projects={[project()]} onNew={onNew} onSettings={onSettings} />);
    fireEvent.click(screen.getByRole("button", { name: "New conversation in Quarterly planning" }));
    expect(onNew).toHaveBeenCalledWith("p1");
    fireEvent.click(screen.getByRole("button", { name: "Instructions and files for Quarterly planning" }));
    expect(onSettings).toHaveBeenCalledWith("p1");
    await screen.findByText("No conversations yet.");
  });
  it("offers no new chat in an archived project and says so", () => {
    render(<PersonalNavigation {...props} projects={[project({ status: "archived" })]} />);
    expect(screen.getByText("Archived")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /New conversation in/ })).toBeNull();
  });
  it("offers no creation control without permission, and explains the choice when the member can create", () => {
    const { rerender } = render(<PersonalNavigation {...props} projects={[]} />);
    expect(screen.queryByRole("button", { name: /^New / })).toBeNull();
    expect(screen.getByText("Projects shared with you will appear here.")).toBeTruthy();
    rerender(<PersonalNavigation {...props} projects={[]} onCreate={vi.fn()} />);
    expect(screen.getByText(/Personal projects are private to you; team projects are shared/)).toBeTruthy();
  });
  it("disables actions while the workspace is busy and filters by the sidebar search", async () => {
    vi.mocked(cloudApi).mockResolvedValue({ conversations: [chat(1), chat(2)], nextCursor: null });
    const { rerender } = render(<PersonalNavigation {...props} projects={[project()]} context={{ ...context, query: "chat 2" }} />);
    fireEvent.click(screen.getByRole("button", { name: "Expand Quarterly planning" }));
    await screen.findByRole("button", { name: "Chat 2" });
    expect(screen.queryByRole("button", { name: "Chat 1" })).toBeNull();
    rerender(<PersonalNavigation {...props} projects={[project()]} context={{ ...context, disabled: true }} />);
    expect((screen.getByRole("button", { name: "New conversation in Quarterly planning" }) as HTMLButtonElement).disabled).toBe(true);
  });
  it("shows a retry when loading fails", async () => {
    vi.mocked(cloudApi).mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ conversations: [chat(1)], nextCursor: null });
    render(<PersonalNavigation {...props} projects={[project()]} />);
    fireEvent.click(screen.getByRole("button", { name: "Expand Quarterly planning" }));
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    await screen.findByRole("button", { name: "Chat 1" });
  });
});

describe("MoveConversationDialog", () => {
  const base = { open: true, projects: [project(), project({ id: "p2", name: "Archive box", status: "archived" })], onClose: vi.fn(), onMoved: vi.fn() };
  it("moves an unfiled chat into an active project with a stable request id", async () => {
    const moved = chat(1);
    vi.mocked(cloudApi).mockResolvedValue(moved);
    const onMoved = vi.fn(), onClose = vi.fn();
    render(<MoveConversationDialog {...base} onMoved={onMoved} onClose={onClose} conversation={{ id: "c1", title: "Chat 1", revision: 3 }} />);
    expect(screen.queryByLabelText("Archive box")).toBeNull();
    expect((screen.getByRole("button", { name: "Move" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByLabelText("Quarterly planning"));
    fireEvent.click(screen.getByRole("button", { name: "Move" }));
    await waitFor(() => expect(onMoved).toHaveBeenCalledWith(moved));
    const [path, init] = vi.mocked(cloudApi).mock.calls[0]!;
    expect(path).toBe("/conversations/c1/personal-project");
    expect(init?.method).toBe("PUT");
    expect(JSON.parse(String(init?.body))).toMatchObject({ personalProjectId: "p1", expectedRevision: 3 });
    expect(onClose).toHaveBeenCalled();
  });
  it("moves a filed chat out and reports a failure without closing", async () => {
    vi.mocked(cloudApi).mockRejectedValueOnce(Object.assign(new Error("changed"), { code: "cloud_revision_conflict" }));
    const onClose = vi.fn();
    render(<MoveConversationDialog {...base} onClose={onClose} conversation={{ id: "c1", title: "Chat 1", revision: 3, personalProjectId: "p1" }} />);
    fireEvent.click(screen.getByLabelText("No project (Conversations)"));
    fireEvent.click(screen.getByRole("button", { name: "Move" }));
    await screen.findByRole("alert");
    expect(onClose).not.toHaveBeenCalled();
    expect(JSON.parse(String(vi.mocked(cloudApi).mock.calls[0]![1]?.body))).toMatchObject({ personalProjectId: null });
  });
});

describe("PersonalProjectPanel", () => {
  const references = { references: [{ id: "r1", projectId: "p1", name: "style.md", mimeType: "text/markdown", sizeBytes: 12, sha256: "a".repeat(64), version: 1, createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z" }] };
  const route = (extra: (path: string, init?: RequestInit) => unknown = () => undefined) =>
    vi.mocked(cloudApi).mockImplementation(async (path: string, init?: RequestInit) => {
      const custom = extra(path, init);
      if (custom !== undefined) return custom as never;
      if (path.endsWith("/references")) return references as never;
      if (path === "/personal-projects/p1") return detail() as never;
      throw new Error(`unexpected ${path}`);
    });
  const mount = (over: Partial<Parameters<typeof PersonalProjectPanel>[0]> = {}) => {
    const handlers = { onChanged: vi.fn(), onDirtyChange: vi.fn(), onBusyChange: vi.fn(), onClose: vi.fn() };
    render(<PersonalProjectPanel projectId="p1" capabilities={capabilities} {...handlers} {...over} />);
    return handlers;
  };
  it("restores a deleted project and reloads its references", async () => {
    let restored = false;
    route(path => {
      if (path.endsWith("/lifecycle")) { restored = true; return detail({ revision: 3 }); }
      if (path === "/personal-projects/p1") return restored ? detail({ revision: 3 }) : detail({ status: "deleted", revision: 2, purgeAfter: "2026-11-01T00:00:00Z" });
      return undefined;
    });
    const handlers = mount();
    const restore = await screen.findByRole("button", { name: "Restore" });
    expect(screen.getByText(/Recovery is available until/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Archive" })).toBeNull();
    fireEvent.click(restore);
    await screen.findByText("style.md");
    expect(handlers.onChanged).toHaveBeenCalledWith(expect.objectContaining({ status: "active", revision: 3 }));
    const init = vi.mocked(cloudApi).mock.calls.find(([path]) => path.endsWith("/lifecycle"))![1];
    expect(JSON.parse(String(init?.body))).toMatchObject({ status: "active", expectedRevision: 2 });
    expect(handlers.onClose).not.toHaveBeenCalled();
  });
  it("keeps recovery available after a failed restore", async () => {
    route(path => {
      if (path.endsWith("/lifecycle")) throw new Error("Restore failed. Try again.");
      if (path === "/personal-projects/p1") return detail({ status: "deleted" });
      return undefined;
    });
    const handlers = mount();
    fireEvent.click(await screen.findByRole("button", { name: "Restore" }));
    await screen.findByRole("alert");
    expect(screen.getByRole("button", { name: "Restore" })).toHaveProperty("disabled", false);
    expect(handlers.onChanged).not.toHaveBeenCalled();
  });
  it("loads instructions and references, saves edits with the revision and reports unsaved changes", async () => {
    route((path, init) => (init?.method === "PATCH" && path === "/personal-projects/p1" ? detail({ revision: 2, instructions: "Be formal." }) : undefined));
    const handlers = mount();
    const field = (await screen.findByLabelText(/Instructions/)) as HTMLTextAreaElement;
    expect(field.value).toBe("Be brief.");
    expect(screen.getByText("style.md")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Save changes" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(field, { target: { value: "Be formal." } });
    await waitFor(() => expect(handlers.onDirtyChange).toHaveBeenLastCalledWith(true));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByText(/Saved\. New messages use these instructions/);
    const patch = vi.mocked(cloudApi).mock.calls.find(([, init]) => init?.method === "PATCH")!;
    expect(JSON.parse(String(patch[1]?.body))).toMatchObject({ expectedRevision: 1, instructions: "Be formal." });
    expect(handlers.onChanged).toHaveBeenCalled();
    await waitFor(() => expect(handlers.onDirtyChange).toHaveBeenLastCalledWith(false));
  });
  it("uploads a reference with the file name, a request id and octet-stream", async () => {
    route((path, init) => (init?.method === "POST" && path.includes("/references?") ? { ...references.references[0], id: "r2", name: "notes.txt" } : undefined));
    mount();
    await screen.findByText("style.md");
    const input = screen.getByLabelText("Add a reference file") as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(["hello"], "notes.txt", { type: "text/plain" })] } });
    await screen.findByText("notes.txt");
    const call = vi.mocked(cloudApi).mock.calls.find(([path]) => path.includes("/references?"))!;
    expect(call[0]).toMatch(/\/personal-projects\/p1\/references\?name=notes\.txt&requestId=[0-9a-f-]{36}&mimeType=text%2Fplain/);
    expect((call[1]?.headers as Record<string, string>)["content-type"]).toBe("application/octet-stream");
  });
  it("refuses an oversized reference before sending it", async () => {
    route();
    mount();
    await screen.findByText("style.md");
    const huge = new File(["x"], "huge.bin");
    Object.defineProperty(huge, "size", { value: 21 * 1024 * 1024 });
    fireEvent.change(screen.getByLabelText("Add a reference file"), { target: { files: [huge] } });
    await screen.findByText("Reference files are limited to 20 MiB.");
    expect(vi.mocked(cloudApi).mock.calls.some(([path]) => path.includes("/references?"))).toBe(false);
  });
  it("removes a reference only after confirmation, bound to its version and hash", async () => {
    route((path, init) => (init?.method === "DELETE" ? null : undefined));
    confirm.mockReturnValueOnce(false).mockReturnValueOnce(true);
    mount();
    await screen.findByText("style.md");
    fireEvent.click(screen.getByRole("button", { name: "Remove style.md" }));
    expect(vi.mocked(cloudApi).mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Remove style.md" }));
    await waitFor(() => expect(screen.queryByText("style.md")).toBeNull());
    const del = vi.mocked(cloudApi).mock.calls.find(([, init]) => init?.method === "DELETE")!;
    expect(del[0]).toContain(`expectedVersion=1&expectedHash=${"a".repeat(64)}`);
  });
  it("previews a text reference in place", async () => {
    route((path) => (path.endsWith("/text?limit=200") ? { text: "# Style\nShort.", truncated: false } : undefined));
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Preview style.md" }));
    await screen.findByText(/Short\./);
  });
  it("archives, restores and deletes with a recovery warning; a deleted project closes the panel", async () => {
    const statuses: string[] = [];
    route((path, init) => {
      if (init?.method === "POST" && path === "/personal-projects/p1/lifecycle") {
        const status = JSON.parse(String(init.body)).status as PersonalProject["status"];
        statuses.push(status);
        return detail({ status, revision: statuses.length + 1, archivedAt: status === "archived" ? "2026-10-03T00:00:00Z" : null });
      }
      return undefined;
    });
    confirm.mockReturnValue(true);
    const handlers = mount();
    fireEvent.click(await screen.findByRole("button", { name: "Archive" }));
    await screen.findByRole("button", { name: "Restore" });
    expect((screen.getByLabelText(/Instructions/) as HTMLTextAreaElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Add file" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    await screen.findByRole("button", { name: "Archive" });
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(handlers.onClose).toHaveBeenCalled());
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("restore it for 30 days"));
    expect(statuses).toEqual(["archived", "active", "deleted"]);
  });
  it("shows a retry when the project cannot be loaded", async () => {
    vi.mocked(cloudApi).mockRejectedValueOnce(new Error("offline"));
    route();
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    await screen.findByLabelText(/Instructions/);
  });
});
