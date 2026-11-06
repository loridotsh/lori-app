import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CloudConversation, CloudProject } from "@lori-enterprise/contracts";
import type * as CloudApiModule from "@/lib/cloud-work-api";
import { cloudApi } from "@/lib/cloud-work-api";
import { ProjectNavigation, type ProjectNavigationContext } from "./project-navigation";
vi.mock("@/lib/cloud-work-api", async original => ({ ...await original<typeof CloudApiModule>(), cloudApi: vi.fn() }));
const project = { id: "p", name: "Client launch", status: "active", accessRevision: 1, access: { actions: ["read", "chat"] } } as CloudProject;
const chat = (n: number): CloudConversation => ({ id: `c${n}`, projectId: "p", title: `Conversation ${n}`, revision: 1, createdAt: "2026-01-01", updatedAt: `2026-10-${String(30-n).padStart(2, "0")}` });
const onPrivate = vi.fn(), onOpen = vi.fn(), openConversation = vi.fn(), newConversation = vi.fn();
function Fixture({ active = false, context: overrides = {} }: { active?: boolean; context?: Partial<ProjectNavigationContext> }) {
  const [expanded, setExpanded] = useState(new Set<string>());
  return <ProjectNavigation projects={[project]} selected={active ? "p" : null} expanded={expanded} onToggle={id => setExpanded(old => old.has(id) ? new Set() : new Set([id]))} context={{ conversationId: null, conversations: [], disabled: false, openConversation, newConversation, ...overrides }} onOpen={onOpen} onPrivate={onPrivate} />;
}
beforeEach(() => { vi.resetAllMocks(); vi.mocked(cloudApi).mockImplementation(async path => path === "/conversations" ? { conversations: [], nextCursor: null } : { conversations: [1,2,3,4,5].map(chat), nextCursor: "c5" }); });
afterEach(cleanup);
it("keeps conversation rows mounted during focus revalidation", async () => {
  render(<Fixture />);
  fireEvent.click(screen.getByRole("button", { name: "Expand Client launch" }));
  const row = await screen.findByRole("button", { name: "Conversation 1" });
  let finish!: (value: unknown) => void;
  vi.mocked(cloudApi).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  act(() => window.dispatchEvent(new Event("focus")));
  expect(screen.getByRole("button", { name: "Conversation 1" })).toBe(row);
  await act(async () => finish({ conversations: [{ ...chat(1), latestRunStatus: "awaitingApproval" }], nextCursor: null }));
  expect(screen.getByRole("button", { name: "Conversation 1 Waiting for approval" })).toBe(row);
});
it("loads only on expansion and shows five recent conversations before More", async () => {
  render(<Fixture />);
  expect(cloudApi).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Expand Client launch" }));
  await screen.findByRole("button", { name: "Conversation 5" });
  expect(screen.getAllByRole("button", { name: /^Conversation \d+$/ })).toHaveLength(5);
  expect(cloudApi).toHaveBeenCalledWith("/projects/p/conversations?limit=5", expect.objectContaining({ signal: expect.any(AbortSignal) }));
  vi.mocked(cloudApi).mockResolvedValue({ conversations: [6,7].map(chat), nextCursor: null });
  fireEvent.click(screen.getByRole("button", { name: "More conversations in Client launch" }));
  await screen.findByRole("button", { name: "Conversation 7" });
  expect(onOpen).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Show less" }));
  expect(screen.queryByRole("button", { name: "Conversation 7" })).toBeNull();
});
it("opens an inactive project's conversation with both scope identifiers", async () => {
  render(<Fixture />); fireEvent.click(screen.getByRole("button", { name: "Expand Client launch" }));
  fireEvent.click(await screen.findByRole("button", { name: "Conversation 2" }));
  expect(onOpen).toHaveBeenCalledWith("p", "c2"); expect(openConversation).not.toHaveBeenCalled();
});
it("uses the current workspace navigation and selected marker for the active project", async () => {
  render(<Fixture active context={{ conversationId: "c2" }} />); fireEvent.click(screen.getByRole("button", { name: "Expand Client launch" }));
  const selected = await screen.findByRole("button", { name: "Conversation 2" }); expect(selected.getAttribute("aria-current")).toBe("page");
  fireEvent.click(selected); expect(openConversation).toHaveBeenCalledWith("c2"); expect(onOpen).not.toHaveBeenCalled();
});
it("discards delayed results on collapse and reauthorizes reopening", async () => {
  let finish!: (value: unknown) => void;
  vi.mocked(cloudApi).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  render(<Fixture />); fireEvent.click(screen.getByRole("button", { name: "Expand Client launch" }));
  fireEvent.click(screen.getByRole("button", { name: "Collapse Client launch" }));
  await act(async () => finish({ conversations: [chat(1)], nextCursor: null }));
  expect(screen.queryByRole("button", { name: "Conversation 1" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Expand Client launch" }));
  await screen.findByRole("button", { name: "Conversation 1" }); expect(cloudApi).toHaveBeenCalledTimes(2);
});
it("offers recovery without pretending a failed request is an empty project", async () => {
  vi.mocked(cloudApi).mockRejectedValueOnce(new Error("Offline")); render(<Fixture />);
  fireEvent.click(screen.getByRole("button", { name: "Expand Client launch" }));
  await screen.findByRole("alert"); expect(screen.queryByText("No conversations yet.")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Conversation 1" })).toBeTruthy());
});
it("withdraws loaded project titles while offline and verifies on reconnect", async () => {
  render(<Fixture />); fireEvent.click(screen.getByRole("button", { name: "Expand Client launch" }));
  await screen.findByRole("button", { name: "Conversation 1" });
  act(() => window.dispatchEvent(new Event("offline")));
  expect(screen.queryByRole("button", { name: "Conversation 1" })).toBeNull();
  act(() => window.dispatchEvent(new Event("online")));
  await screen.findByRole("button", { name: "Conversation 1" });
  expect(cloudApi).toHaveBeenCalledTimes(2);
});
it("keeps an older selected chat visible within the five-row preview", async () => {
  render(<Fixture active context={{ conversationId: "c7", conversations: [1,2,3,4,5,6,7].map(chat) }} />);
  fireEvent.click(screen.getByRole("button", { name: "Expand Client launch" }));
  expect((await screen.findByRole("button", { name: "Conversation 7" })).getAttribute("aria-current")).toBe("page");
  expect(screen.getAllByRole("button", { name: /^Conversation \d+$/ })).toHaveLength(5);
});

it("toggles from the project title without opening or creating a conversation", async () => {
  render(<Fixture />);
  fireEvent.click(screen.getByText("Client launch"));
  await screen.findByRole("button", { name: "Conversation 1" });
  fireEvent.click(screen.getByText("Client launch"));
  expect(screen.queryByRole("button", { name: "Conversation 1" })).toBeNull();
  expect(onOpen).not.toHaveBeenCalled(); expect(newConversation).not.toHaveBeenCalled();
});

it("keeps normal conversations outside project groups while a project is selected", async () => {
  vi.mocked(cloudApi).mockImplementation(async path => path === "/conversations" ? { conversations: [{ ...chat(99), projectId: undefined, title: "My normal chat" }], nextCursor: null } : { conversations: [chat(1)], nextCursor: null });
  render(<Fixture active />);
  const normal = await screen.findByRole("button", { name: "My normal chat" });
  fireEvent.click(normal);
  expect(onPrivate).toHaveBeenCalledWith("c99");
  expect(onOpen).not.toHaveBeenCalled();
  expect(cloudApi).toHaveBeenCalledWith("/conversations", expect.objectContaining({ signal: expect.any(AbortSignal) }));
});
