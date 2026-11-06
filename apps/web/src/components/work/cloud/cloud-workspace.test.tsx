import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type {
  CloudCapabilities,
  CloudConversation,
  CloudConversationDetail,
  CloudRun,
} from "@lori-enterprise/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cloudApi, readCloudEvents } from "@/lib/cloud-work-api";
import { ClientApiError } from "@/lib/client-api";
import userEvent from "@testing-library/user-event";
import { CloudWorkspace, type PersonalWorkspaceBinding } from "./cloud-workspace";
vi.mock("./find/textMatches", async importOriginal => ({ ...await importOriginal<object>(), revealMatch: vi.fn() }));

vi.mock("@/lib/cloud-work-api", async (original) => ({
  ...(await original<object>()),
  cloudApi: vi.fn(),
  readCloudEvents: vi.fn(),
}));
const capabilities: CloudCapabilities = {
  contractVersion: 1,
  enabled: true,
  available: true,
  providers: [
    {
      gatewayId: "gateway",
      providerId: "openai",
      name: "Company AI",
      modelIds: ["model-a", "model-b"],
    },
  ],
  features: {
    chat: true,
    files: false,
    tools: false,
    memory: false,
    extensions: false,
  },
};
const conversation: CloudConversation = {
  id: "conversation",
  title: "First conversation",
  revision: 1,
  createdAt: "2026-10-11T00:00:00Z",
  updatedAt: "2026-10-11T00:00:00Z",
};
const run: CloudRun = {
  id: "run",
  conversationId: conversation.id,
  status: "running",
  gatewayId: "gateway",
  modelId: "model-a",
  createdAt: conversation.createdAt,
  updatedAt: conversation.updatedAt,
  lastSequence: 2,
  errorCode: null,
};
let detail: CloudConversationDetail;
let sendFailure: unknown;
let calls: { path: string; init?: RequestInit }[];
it.each([false, true])("finds earlier matches and preserves the draft and live run (streaming=%s)", async live => {
  const recent = { id: "recent", runId: "recent-run", runStatus: "completed" as const, role: "assistant" as const, text: "Recent needle", createdAt: conversation.createdAt };
  detail = { conversation, messages: [recent], runs: live ? [run] : [], historyCursor: "recent" };
  const original = vi.mocked(cloudApi).getMockImplementation()!;
  vi.mocked(cloudApi).mockImplementation(async (path, init) => {
    if (path === "/conversations/conversation?before=recent") return { ...detail, historyCursor: null, messages: [{ ...recent, id: "older", runId: "older-run", text: "Older needle" }] };
    return original(path, init);
  });
  render(<CloudWorkspace admin={false} initialConversations={{ conversations: [conversation], nextCursor: null }} bootstrap={{ capabilities, detail, files: [] }} />);
  fireEvent.change(screen.getByRole("textbox", { name: "Message" }), { target: { value: "Keep my draft" } });
  fireEvent.click(screen.getByRole("button", { name: "Find in this conversation" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Search messages" }), { target: { value: "needle" } });
  await screen.findByText("2/2");
  expect(screen.getByText("Older needle")).toBeTruthy();
  expect(screen.getByText("Recent needle")).toBeTruthy();
  expect((screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement).value).toBe("Keep my draft");
  if (live) expect((screen.getByRole("button", { name: "Stop response" }) as HTMLButtonElement).disabled).toBe(false);
});
it("withdraws the workspace on a confirmed project-not-found response", async () => {
  const revoked = vi.fn();
  vi.mocked(cloudApi).mockRejectedValue(new ClientApiError("project_not_found", "Project unavailable", 404));
  render(<CloudWorkspace admin={false} onProjectAccessLost={revoked}
    initialConversations={{ conversations: [conversation], nextCursor: null }}
    bootstrap={{ capabilities, detail: { conversation, messages: [], runs: [] }, files: [] }} />);
  await waitFor(() => expect(revoked).toHaveBeenCalled());
  expect(screen.queryByRole("heading", { name: "First conversation" })).toBeNull();
});
it("does not restore sidebar scroll again during ordinary renders", async () => {
  const savedScroll = { current: 12 };
  render(<CloudWorkspace admin={false} sidebarScroll={savedScroll}
    initialConversations={{ conversations: [conversation], nextCursor: null }}
    bootstrap={{ capabilities, detail: { conversation, messages: [], runs: [] }, files: [] }} />);
  const history = screen.getByRole("region", { name: "Conversation history" });
  expect(history.scrollTop).toBe(12);
  history.scrollTop = 40;
  fireEvent.change(screen.getByRole("textbox", { name: "Search conversations" }), { target: { value: "First" } });
  expect(history.scrollTop).toBe(40);
  await waitFor(() => expect(cloudApi).toHaveBeenCalled());
});
it("opens a prepared destination without an intermediate empty or loading workspace", async () => {
  render(<CloudWorkspace admin={false} initialConversationId={conversation.id}
    initialConversations={{ conversations: [conversation], nextCursor: null }}
    bootstrap={{ capabilities, detail: { conversation, messages: [], runs: [] }, files: [] }} />);
  expect(screen.getByRole("heading", { name: "First conversation" })).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "New conversation" })).toBeNull();
  expect(screen.queryByText("Loading Cloud Work…")).toBeNull();
  await waitFor(() => expect(cloudApi).toHaveBeenCalled());
  expect(screen.queryByText("Loading Cloud Work…")).toBeNull();
});
beforeEach(() => {
  vi.clearAllMocks();
  calls = [];
  sendFailure = undefined;
  detail = { conversation, messages: [], runs: [] };
  vi.mocked(cloudApi).mockImplementation(async (path, init) => {
    calls.push({ path, init });
    if (path === "/capabilities") return capabilities;
    if (path === "/memory/settings")
      return { enabled: false, allowed: true, revision: 1 };
    if (path.startsWith("/memory?")) return { notes: [] };
    if (path === "/settings")
      return { enabled: true, retentionDays: 90, revision: 1 };
    if (path === "/conversations" && !init?.method)
      return { conversations: [conversation], nextCursor: null };
    if (path === "/conversations" && init?.method === "POST")
      return conversation;
    if (path === "/conversations/conversation/messages") {
      if (sendFailure) throw sendFailure;
      detail = {
        ...detail,
        conversation: { ...conversation, revision: 2 },
        messages: [
          {
            id: "message",
            runId: "run",
            runStatus: "running",
            role: "user",
            text: "Keep this draft",
            createdAt: conversation.createdAt,
          },
        ],
        runs: [run],
      };
      return { conversation: detail.conversation, run };
    }
    if (path === "/conversations/conversation") return detail;
    if (path === "/runs/run") return { run, assistantText: "Saved partial" };
    if (path === "/runs/run/cancel") {
      detail = {
        ...detail,
        runs: [{ ...run, status: "cancelled" }],
        messages: [
          {
            id: "partial",
            runId: "run",
            runStatus: "cancelled",
            role: "assistant",
            text: "Partial response",
            createdAt: conversation.createdAt,
          },
        ],
      };
      return { run: detail.runs[0] };
    }
    throw new Error(`Unexpected path ${path}`);
  });
  vi.mocked(readCloudEvents).mockImplementation(
    async (_id, _cursor, signal) => {
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
    },
  );
});

it("keeps the docked Files pane open until its dispatched save settles", async () => {
  const viewport = vi
    .spyOn(window, "matchMedia")
    .mockImplementation((query) => ({
      matches: true,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
  const file = {
    id: "file",
    conversationId: conversation.id,
    path: "notes.txt",
    mimeType: "text/plain",
    version: 1,
    sha256: "a".repeat(64),
    sizeBytes: 8,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
  };
  const saved = { ...file, version: 2, sha256: "b".repeat(64) };
  detail = { ...detail, files: [file] };
  let finishSave!: (value: typeof saved) => void;
  let acknowledged = false;
  const original = vi.mocked(cloudApi).getMockImplementation()!;
  vi.mocked(cloudApi).mockImplementation(async (path, init) => {
    if (path === "/capabilities")
      return {
        ...capabilities,
        features: { ...capabilities.features, files: true },
      };
    if (path.startsWith("/files/file/text?"))
      return { file, text: "Original", truncated: false, nextOffset: null };
    if (path === "/files/file" && init?.method === "PATCH")
      return new Promise<typeof saved>((resolve) => {
        finishSave = (value) => {
          acknowledged = true;
          resolve(value);
        };
      });
    if (path === "/conversations/conversation/files")
      return { files: [acknowledged ? saved : file] };
    return original(path, init);
  });
  try {
    await open();
    fireEvent.click(screen.getByRole("button", { name: "First conversation" }));
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: "Conversation actions" })
          .hasAttribute("disabled"),
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole("button", { name: "Files" }));
    const input = await screen.findByRole("textbox", { name: "File content" });
    fireEvent.change(input, { target: { value: "Edited" } });
    fireEvent.blur(input);
    await waitFor(() => expect(finishSave).toBeTypeOf("function"));
    const toggle = screen.getByRole("button", { name: "Files" });
    expect(toggle.hasAttribute("disabled")).toBe(true);
    fireEvent.click(toggle);
    expect(screen.getByRole("textbox", { name: "File content" })).toBe(input);
    await act(async () => {
      finishSave(saved);
    });
    await waitFor(() => expect(toggle.hasAttribute("disabled")).toBe(false));
    fireEvent.click(toggle);
    expect(screen.queryByRole("textbox", { name: "File content" })).toBeNull();
  } finally {
    viewport.mockRestore();
  }
});
afterEach(cleanup);
async function open() {
  render(<CloudWorkspace admin={false} />);
  await screen.findByRole("button", { name: "First conversation" });
}
describe("Cloud Work workspace", () => {
  it("opens management from Settings without a primary Manage link", async () => {
    await open();
    expect(screen.queryByRole("link", { name: "Manage" })).toBeNull();
    expect(screen.queryByRole("navigation", { name: "Application mode" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByRole("link", { name: "Manage account" }).getAttribute("href")).toBe("/");
    expect(screen.queryByRole("tablist", { name: "Settings sections" })).toBeNull();
    expect(screen.queryByRole("link", { name: /^People/ })).toBeNull();
  });
  it("keeps a newer history request busy when an invalidated earlier request settles", async () => {
    const cursor = "00000000-0000-4000-8000-000000000001";
    const recent = { id: "recent", runId: "recent-run", runStatus: "completed" as const, role: "assistant" as const, text: "Latest response", createdAt: conversation.createdAt };
    detail = { ...detail, historyCursor: cursor, messages: [recent] };
    const original = vi.mocked(cloudApi).getMockImplementation()!;
    const finish: ((value: CloudConversationDetail) => void)[] = [];
    vi.mocked(cloudApi).mockImplementation((path, init) => path.includes("?before=") ? new Promise(resolve => finish.push(resolve)) : original(path, init));
    await open(); fireEvent.click(screen.getByRole("button", { name: "First conversation" }));
    fireEvent.click(await screen.findByRole("button", { name: "Load earlier messages" }));
    await waitFor(() => expect(finish).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "First conversation" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Load earlier messages" }).hasAttribute("disabled")).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Load earlier messages" }));
    await waitFor(() => expect(finish).toHaveLength(2));
    await act(async () => finish[0]!({ ...detail, historyCursor: null, messages: [{ ...recent, id: "stale", runId: "stale", text: "Stale earlier response" }] }));
    expect(screen.getByRole("button", { name: "Loading earlier messages…" }).hasAttribute("disabled")).toBe(true);
    expect(screen.queryByText("Stale earlier response")).toBeNull();
    await act(async () => finish[1]!({ ...detail, historyCursor: null, messages: [{ ...recent, id: "older", runId: "older", text: "Current earlier response" }] }));
    await screen.findByText("Current earlier response");
  });
  it("retains prior response activity after a new send whose immediate history refresh fails", async () => {
    detail = { ...detail, messages: [{ id: "prior-message", runId: "prior", runStatus: "completed", role: "assistant", text: "Earlier response", createdAt: conversation.createdAt }], toolInvocations: [{ id: "prior-tool", runId: "prior", roundId: "round", callId: "call", name: "read_file", arguments: { path: "earlier.md" }, actionHash: "hash", status: "completed", output: { text: "Data" }, createdAt: conversation.createdAt, updatedAt: conversation.createdAt }] };
    const original = vi.mocked(cloudApi).getMockImplementation()!;
    let sent = false;
    vi.mocked(cloudApi).mockImplementation(async (path, init) => {
      if (path.endsWith("/messages")) { sent = true; return { conversation: { ...conversation, revision: 2 }, run }; }
      if (sent && path === "/conversations/conversation") throw new ClientApiError("service_unavailable", "Temporary history failure", 503);
      return original(path, init);
    });
    await open(); fireEvent.click(screen.getByRole("button", { name: "First conversation" }));
    await screen.findByText("earlier.md");
    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), { target: { value: "Follow up" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByText("Saved partial");
    expect(screen.getByText("earlier.md")).toBeTruthy();
    expect(screen.getByText("Earlier response")).toBeTruthy();
  });

  it("loads an earlier history page without replacing the current transcript", async () => {
    const cursor = "00000000-0000-4000-8000-000000000001";
    const recent = { id: "recent", runId: "recent-run", runStatus: "completed" as const, role: "assistant" as const, text: "Latest history response", createdAt: conversation.createdAt };
    detail = { ...detail, historyCursor: cursor, messages: [recent] };
    const original = vi.mocked(cloudApi).getMockImplementation()!;
    vi.mocked(cloudApi).mockImplementation(async (path, init) => path === `/conversations/conversation?before=${cursor}` ? { ...detail, historyCursor: null, messages: [{ ...recent, id: "older", runId: "older-run", text: "Earlier history response" }] } : original(path, init));
    await open(); fireEvent.click(screen.getByRole("button", { name: "First conversation" }));
    await screen.findByText("Latest history response");
    fireEvent.click(screen.getByRole("button", { name: "Load earlier messages" }));
    await screen.findByText("Earlier history response");
    expect(screen.getByText("Latest history response")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Load earlier messages" })).toBeNull();
  });

  it("selects an older session without moving it above a more recently updated session", async () => {
    const recent = { ...conversation, id: "recent", title: "Recently updated", updatedAt: "2026-10-13T00:00:00Z" };
    const original = vi.mocked(cloudApi).getMockImplementation()!;
    vi.mocked(cloudApi).mockImplementation((path, init) =>
      path === "/conversations" && !init?.method
        ? Promise.resolve({ conversations: [recent, conversation], nextCursor: null })
        : original(path, init));
    await open();
    const order = () => [...screen.getByRole("navigation", { name: "Cloud conversations" }).querySelectorAll("button")].map((button) => button.textContent);
    expect(order()).toEqual(["Recently updated", "First conversation"]);
    fireEvent.click(screen.getByRole("button", { name: "First conversation" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "First conversation" }).getAttribute("aria-current")).toBe("page"));
    expect(order()).toEqual(["Recently updated", "First conversation"]);
  });
  it("keeps malformed server responses recoverable", async () => {
    vi.mocked(cloudApi).mockResolvedValue({ contractVersion: 1 });
    render(<CloudWorkspace admin={false} />);
    await screen.findByRole("alert");
    expect(screen.getByRole("button", { name: "Load again" })).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "Message" })).toBeNull();
  });
  it("stops explicitly and reloads the authoritative partial response", async () => {
    detail = { ...detail, runs: [run] };
    await open();
    fireEvent.click(screen.getByRole("button", { name: "First conversation" }));
    const stop = await screen.findByRole("button", { name: "Stop response" });
    await waitFor(() => expect(stop.hasAttribute("disabled")).toBe(false));
    fireEvent.click(stop);
    await screen.findByText("Partial response");
    expect(
      calls.find((call) => call.path === "/runs/run/cancel")?.init?.method,
    ).toBe("POST");
    expect(screen.queryByRole("button", { name: "Stop response" })).toBeNull();
  });
  it("shows opt-in off without exposing chat or unsupported file/tool controls", async () => {
    vi.mocked(cloudApi).mockResolvedValue({ ...capabilities, enabled: false });
    render(<CloudWorkspace admin={false} />);
    await screen.findByRole("heading", { name: "Cloud Work is turned off" });
    expect(screen.queryByRole("textbox", { name: "Message" })).toBeNull();
    expect(screen.queryByText("Cloud Work settings")).toBeNull();
    expect(calls.some((call) => call.path === "/conversations")).toBe(false);
  });
  it("keeps conversation drafts when navigating away and back", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: "First conversation" }));
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: "Conversation actions" })
          .hasAttribute("disabled"),
      ).toBe(false),
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), {
      target: { value: "Unsent draft" },
    });
    fireEvent.click(screen.getByRole("button", { name: "New conversation" }));
    expect(
      (screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement)
        .value,
    ).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "First conversation" }));
    await waitFor(() =>
      expect(
        (
          screen.getByRole("textbox", {
            name: "Message",
          }) as HTMLTextAreaElement
        ).value,
      ).toBe("Unsent draft"),
    );
  });
  it("preserves unknown submissions and retries only the exact original request", async () => {
    sendFailure = new ClientApiError("network_unavailable", "Offline", 0);
    await open();
    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), {
      target: { value: "Keep this draft" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByRole("button", { name: "Retry saved request" });
    const attempt = calls.find((call) => call.path.endsWith("/messages"));
    expect(
      (screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement)
        .value,
    ).toBe("Keep this draft");
    expect(
      calls.filter((call) => call.path.endsWith("/messages")),
    ).toHaveLength(1);
    sendFailure = undefined;
    fireEvent.click(
      screen.getByRole("button", { name: "Retry saved request" }),
    );
    await screen.findByRole("button", { name: "Stop response" });
    expect(
      calls.filter((call) => call.path.endsWith("/messages"))[1]?.init?.body,
    ).toBe(attempt?.init?.body);
    expect(
      screen.queryByRole("button", { name: "Retry saved request" }),
    ).toBeNull();
    await screen.findByText("Saved partial");
    expect(readCloudEvents).toHaveBeenCalledWith(
      "run",
      2,
      expect.any(AbortSignal),
      expect.any(Function),
    );
  });
  it("restores the real Files toggle after dismissing the narrow overlay and blocks background shortcuts", async () => {
    detail = { ...detail, files: [{ id: "file", conversationId: conversation.id, path: "notes.txt", mimeType: "text/plain", sizeBytes: 4, sha256: "a".repeat(64), version: 1, createdAt: conversation.createdAt, updatedAt: conversation.updatedAt }] };
    const original = vi.mocked(cloudApi).getMockImplementation()!;
    vi.mocked(cloudApi).mockImplementation(async (path, init) =>
      path === "/capabilities"
        ? {
            ...capabilities,
            features: { ...capabilities.features, files: true },
          }
        : original(path, init),
    );
    await open();
    fireEvent.click(screen.getByRole("button", { name: "First conversation" }));
    await screen.findByRole("button", { name: "Files" });
    const toggle = screen.getByRole("button", { name: "Files" });
    toggle.focus();
    fireEvent.click(toggle);
    const close = await screen.findByRole("button", { name: "Close preview" });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(window, { key: "n", metaKey: true });
    expect(
      screen.getByRole("dialog", { name: "File preview" }),
    ).toBeTruthy();
    fireEvent.keyDown(close, { key: "Escape" });
    expect(
      screen.queryByRole("dialog", { name: "File preview" }),
    ).toBeNull();
    expect(document.activeElement).toBe(toggle);
  });
  it("uploads a conversation attachment and sends only its server file ID", async () => {
    const original = vi.mocked(cloudApi).getMockImplementation()!;
    const file = {
      id: "uploaded-file",
      conversationId: conversation.id,
      path: "notes.txt",
      mimeType: "text/plain",
      sizeBytes: 5,
      sha256: "hash",
      version: 1,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
    };
    vi.mocked(cloudApi).mockImplementation(async (path, init) => {
      if (path === "/capabilities")
        return {
          ...capabilities,
          features: { ...capabilities.features, files: true },
        };
      if (path.startsWith("/conversations/conversation/files?")) {
        calls.push({ path, init });
        return file;
      }
      return original(path, init);
    });
    await open();
    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), {
      target: { value: "Summarize my notes" },
    });
    const uploaded = new File(["notes"], "notes.txt", { type: "text/plain" });
    fireEvent.change(screen.getByLabelText("Attach files"), {
      target: { files: [uploaded] },
    });
    await screen.findByRole("button", { name: "Remove attachment notes.txt" });
    expect(
      (screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement)
        .value,
    ).toBe("Summarize my notes");
    const upload = calls.find((call) => call.path.includes("/files?"));
    expect(upload?.init?.body).toBe(uploaded);
    expect(upload?.init?.headers).toEqual({
      "content-type": "application/octet-stream",
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(calls.some((call) => call.path.endsWith("/messages"))).toBe(true),
    );
    const send = calls.find((call) => call.path.endsWith("/messages"));
    expect(JSON.parse(String(send?.init?.body))).toMatchObject({
      text: "Summarize my notes",
      attachmentIds: ["uploaded-file"],
    });
  });
  describe("adding files", () => {
    function withFiles() {
      const original = vi.mocked(cloudApi).getMockImplementation()!;
      let counter = 0;
      vi.mocked(cloudApi).mockImplementation(async (path, init) => {
        if (path === "/capabilities")
          return { ...capabilities, features: { ...capabilities.features, files: true, extensions: false } };
        if (path.startsWith("/conversations/conversation/files?")) {
          calls.push({ path, init });
          const query = new URL(`http://x${path}`).searchParams;
          counter++;
          return {
            id: `file-${counter}`, conversationId: conversation.id, path: query.get("path"),
            mimeType: query.get("mimeType") ?? "application/octet-stream",
            sizeBytes: (init?.body as File).size, sha256: `hash-${counter}`, version: 1,
            createdAt: conversation.createdAt, updatedAt: conversation.updatedAt,
          };
        }
        return original(path, init);
      });
    }
    const uploads = () => calls.filter((call) => call.path.includes("/files?"));
    const dropTarget = () => screen.getByRole("group", { name: "Message composer" });
    const drop = (files: File[], items: unknown[] = []) =>
      fireEvent.drop(dropTarget(), { dataTransfer: { types: ["Files"], files, items } });

    it("uploads several picked files one after another with clean names and media types", async () => {
      withFiles();
      await open();
      const a = new File(["aaaa"], "notes.txt", { type: "text/plain" });
      const b = new File(["bbbb"], "chart.png", { type: "image/png" });
      fireEvent.change(screen.getByLabelText("Attach files"), { target: { files: [a, b] } });
      await screen.findByRole("button", { name: "Remove attachment chart.png" });
      expect(screen.getByRole("button", { name: "Remove attachment notes.txt" })).toBeTruthy();
      expect(uploads()).toHaveLength(2);
      expect(uploads()[0]!.path).toContain("path=notes.txt");
      expect(uploads()[0]!.path).toContain("mimeType=text%2Fplain");
      expect(uploads()[1]!.path).toContain("path=chart.png");
      expect(uploads()[0]!.init?.body).toBe(a);
      // Both land in the same conversation, not one each.
      expect(new Set(uploads().map((call) => call.path.split("/files?")[0])).size).toBe(1);
    });
    it("uploads files dropped on the conversation and explains skipped folders", async () => {
      withFiles();
      await open();
      const dropped = new File(["x"], "report.pdf", { type: "application/pdf" });
      drop([dropped], [
        { kind: "file", getAsFile: () => dropped, webkitGetAsEntry: () => ({ isDirectory: false }) },
        { kind: "file", getAsFile: () => null, webkitGetAsEntry: () => ({ isDirectory: true }) },
      ]);
      await screen.findByRole("button", { name: "Remove attachment report.pdf" });
      expect(uploads()).toHaveLength(1);
      expect(screen.getByText(/A folder was skipped/)).toBeTruthy();
    });
    it("shows the overlay while files are dragged over, and hides it when they leave or drop", async () => {
      withFiles();
      await open();
      expect(screen.queryByText("Drop files to attach")).toBeNull();
      fireEvent.dragEnter(dropTarget(), { dataTransfer: { types: ["Files"] } });
      expect(screen.getByText("Drop files to attach")).toBeTruthy();
      fireEvent.dragLeave(dropTarget(), { dataTransfer: { types: ["Files"] } });
      expect(screen.queryByText("Drop files to attach")).toBeNull();
      // Dragging text or a link is not a file drag and is left alone.
      fireEvent.dragEnter(dropTarget(), { dataTransfer: { types: ["text/plain"] } });
      expect(screen.queryByText("Drop files to attach")).toBeNull();
    });
    it("always cancels a file drag so the browser never opens the dropped file", async () => {
      withFiles();
      await open();
      const allowed = fireEvent.dragOver(dropTarget(), { dataTransfer: { types: ["Files"] } });
      expect(allowed).toBe(false); // preventDefault was called
    });
    it("explains instead of uploading when files cannot be added", async () => {
      await open(); // the default capabilities have files turned off
      drop([new File(["x"], "a.txt")]);
      await screen.findByText("File uploads are not available in this workspace.");
      expect(uploads()).toHaveLength(0);
    });
    it("turns a pasted screenshot into an attachment but leaves pasted text alone", async () => {
      withFiles();
      await open();
      const shot = new File(["png"], "image.png", { type: "image/png" });
      const box = screen.getByRole("textbox", { name: "Message" });
      const notPrevented = fireEvent.paste(box, { clipboardData: { files: [], getData: () => "hello" } });
      expect(notPrevented).toBe(true);
      expect(uploads()).toHaveLength(0);
      const prevented = fireEvent.paste(box, { clipboardData: { files: [shot], getData: () => "" } });
      expect(prevented).toBe(false);
      await waitFor(() => expect(uploads()).toHaveLength(1));
      expect(uploads()[0]!.path).toMatch(/path=pasted-image-\d{8}-\d{6}\.png/);
    });
    it("pastes the text when a copied table arrives with a picture of itself, but still attaches real files", async () => {
      withFiles();
      await open();
      const box = screen.getByRole("textbox", { name: "Message" });
      const picture = new File(["png"], "image.png", { type: "image/png" });
      const textWins = fireEvent.paste(box, { clipboardData: { files: [picture], getData: () => "a\tb\n1\t2" } });
      expect(textWins).toBe(true);
      expect(uploads()).toHaveLength(0);
      const document = new File(["x"], "report.pdf", { type: "application/pdf" });
      expect(fireEvent.paste(box, { clipboardData: { files: [document], getData: () => "report.pdf" } })).toBe(false);
      await waitFor(() => expect(uploads()).toHaveLength(1));
    });
    it("rejects empty and oversize files with a reason and still uploads the rest", async () => {
      withFiles();
      await open();
      const big = new File(["x"], "big.zip");
      Object.defineProperty(big, "size", { value: 21 * 1024 * 1024 });
      fireEvent.change(screen.getByLabelText("Attach files"), {
        target: { files: [new File([], "empty.txt"), big, new File(["ok"], "good.txt")] },
      });
      await screen.findByRole("button", { name: "Remove attachment good.txt" });
      expect(uploads()).toHaveLength(1);
      expect(screen.getByText(/empty\.txt is empty\. big\.zip is larger than 20 MB\./)).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
      expect(screen.queryByText(/is empty/)).toBeNull();
    });
    it("keeps both files when two share a name", async () => {
      withFiles();
      await open();
      fireEvent.change(screen.getByLabelText("Attach files"), {
        target: { files: [new File(["1"], "data.csv"), new File(["2"], "data.csv")] },
      });
      await screen.findByRole("button", { name: "Remove attachment data (2).csv" });
      expect(uploads().map((call) => new URL(`http://x${call.path}`).searchParams.get("path"))).toEqual(["data.csv", "data (2).csv"]);
    });
    it("stops after an uncertain upload and tells the member what was not sent", async () => {
      const original = vi.mocked(cloudApi).getMockImplementation()!;
      vi.mocked(cloudApi).mockImplementation(async (path, init) => {
        if (path === "/capabilities")
          return { ...capabilities, features: { ...capabilities.features, files: true } };
        if (path.startsWith("/conversations/conversation/files?")) {
          calls.push({ path, init });
          throw new ClientApiError("network_unavailable", "Offline", 0);
        }
        return original(path, init);
      });
      await open();
      fireEvent.change(screen.getByLabelText("Attach files"), {
        target: { files: [new File(["1"], "one.txt"), new File(["2"], "two.txt"), new File(["3"], "three.txt")] },
      });
      await screen.findByRole("button", { name: "Check saved upload" });
      // Only the first was attempted; nothing is retried automatically.
      expect(uploads()).toHaveLength(1);
      expect(screen.getByText(/2 more files were not uploaded/)).toBeTruthy();
    });
  });
  it("unlocks an uncertain draft after a definitive retry rejection", async () => {
    sendFailure = new ClientApiError("network_unavailable", "Offline", 0);
    await open();
    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), {
      target: { value: "Keep this draft" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByRole("button", { name: "Retry saved request" });
    sendFailure = new ClientApiError("revision_conflict", "Changed", 409);
    fireEvent.click(
      screen.getByRole("button", { name: "Retry saved request" }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Retry saved request" }),
      ).toBeNull(),
    );
    const input = screen.getByRole("textbox", {
      name: "Message",
    }) as HTMLTextAreaElement;
    expect(input.value).toBe("Keep this draft");
    expect(input.disabled).toBe(false);
    expect(
      screen
        .getByRole("button", { name: "New conversation" })
        .hasAttribute("disabled"),
    ).toBe(false);
  });
  it("withdraws cached conversations and drafts on mutation access denial", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: "First conversation" }));
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: "Conversation actions" })
          .hasAttribute("disabled"),
      ).toBe(false),
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), {
      target: { value: "Private draft" },
    });
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Conversation actions" }));
    await userEvent
      .setup()
      .click(
        await screen.findByRole("menuitem", { name: "Rename conversation" }),
      );
    const original = vi.mocked(cloudApi).getMockImplementation()!;
    vi.mocked(cloudApi).mockImplementation(async (path, init) => {
      if (init?.method === "PATCH")
        throw new ClientApiError("access_denied", "Denied", 403);
      return original(path, init);
    });
    fireEvent.change(
      screen.getByRole("textbox", { name: "Conversation title" }),
      { target: { value: "Changed" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Save name" }));
    await screen.findByText(
      "Your organization has not granted you Cloud Work access.",
    );
    expect(
      screen.queryByRole("button", { name: "First conversation" }),
    ).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Message" })).toBeNull();
    expect(
      screen
        .getByRole("button", { name: "Load again" })
        .hasAttribute("disabled"),
    ).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Load again" }));
    await screen.findByRole("textbox", { name: "Message" });
    expect(
      (screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement)
        .value,
    ).toBe("");
  });
  it("keeps the conversation draft while visiting providers and returning", async () => {
    await open();
    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), {
      target: { value: "Draft for later" },
    });
    fireEvent.click(screen.getByRole("button", { name: "LLM Providers" }));
    await screen.findByRole("heading", { name: "Company AI" });
    expect(screen.getByText("model-a")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Back to conversation" }),
    );
    expect(
      (screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement)
        .value,
    ).toBe("Draft for later");
  });
  it("announces the saved completed response outside the token log", async () => {
    detail = {
      ...detail,
      runs: [{ ...run, status: "completed" }],
      messages: [
        {
          id: "answer",
          role: "assistant",
          runId: run.id,
          runStatus: "completed",
          text: "Finished answer",
          createdAt: conversation.createdAt,
        },
      ],
    };
    await open();
    fireEvent.click(screen.getByRole("button", { name: "First conversation" }));
    const announcement = await screen.findByText("Lori response completed.");
    expect(announcement.getAttribute("aria-live")).toBe("polite");
    expect(screen.getByRole("log").contains(announcement)).toBe(false);
  });
  it("renders administrator enablement and the current retention revision", async () => {
    render(<CloudWorkspace admin />);
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    const retention = await screen.findByRole("textbox", {
      name: "Conversation retention in days",
    });
    await waitFor(() =>
      expect((retention as HTMLInputElement).value).toBe("90"),
    );
    // Availability is owned by Work access, so there is no separate enable switch.
    expect(screen.queryByRole("checkbox", { name: /Enable Cloud Work/ })).toBeNull();
    fireEvent.change(retention, { target: { value: "30" } });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() =>
      expect(
        calls.some(
          (call) => call.path === "/settings" && call.init?.method === "PATCH",
        ),
      ).toBe(true),
    );
    const patch = calls.find((call) => call.init?.method === "PATCH");
    expect(JSON.parse(String(patch?.init?.body))).toEqual({
      retentionDays: 30,
      expectedRevision: 1,
    });
  });
  it("leaves for Work access and disables every control when Work is off", async () => {
    vi.mocked(cloudApi).mockImplementation(async (path, init) => {
      calls.push({ path, init });
      if (path === "/capabilities")
        return { ...capabilities, enabled: false, features: { ...capabilities.features, memory: true } };
      // Mirror the real API: runtime data is forbidden while Work is off.
      throw new ClientApiError("work_disabled", "Work is disabled.", 403);
    });
    const onWorkOff = vi.fn();
    render(<CloudWorkspace admin onWorkOff={onWorkOff} />);
    await screen.findByRole("heading", { name: "Cloud Work is turned off" });
    await waitFor(() => expect(onWorkOff).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("link", { name: "Manage Work access" }).getAttribute("href")).toBe("/work");
    for (const name of ["New conversation", "LLM Providers", "Plugins", "Settings"])
      expect(screen.getByRole("button", { name }).hasAttribute("disabled")).toBe(true);
    expect(screen.queryByRole("button", { name: "Files" })).toBeNull();
    expect(calls.some((call) => call.path.startsWith("/memory"))).toBe(false);
    expect(calls.some((call) => call.path === "/conversations")).toBe(false);
  });
  it("redirects once when Work is turned off while the page is open", async () => {
    let enabled = true;
    vi.mocked(cloudApi).mockImplementation(async (path, init) => {
      calls.push({ path, init });
      if (path === "/capabilities") return { ...capabilities, enabled };
      if (path === "/conversations") return { conversations: [], nextCursor: null };
      throw new Error(path);
    });
    const onWorkOff = vi.fn();
    render(<CloudWorkspace admin onWorkOff={onWorkOff} />);
    await screen.findByRole("textbox", { name: "Message" });
    expect(onWorkOff).not.toHaveBeenCalled();
    enabled = false;
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => expect(onWorkOff).toHaveBeenCalledTimes(1));
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(onWorkOff).toHaveBeenCalledTimes(1);
  });
  it("never mistakes a server without a worker for Work being off, so it cannot loop between pages", async () => {
    vi.mocked(cloudApi).mockImplementation(async (path, init) => {
      calls.push({ path, init });
      if (path === "/capabilities") return { ...capabilities, enabled: true };
      // The real API refuses with cloud_disabled when no worker secret is configured.
      throw new ClientApiError("cloud_disabled", "Enterprise Cloud access is unavailable.", 403);
    });
    const onWorkOff = vi.fn();
    render(<CloudWorkspace admin onWorkOff={onWorkOff} />);
    await screen.findByText(/worker is not configured/);
    expect(onWorkOff).not.toHaveBeenCalled();
    expect(screen.queryByRole("heading", { name: "Cloud Work is turned off" })).toBeNull();
    // Navigation stays usable so an administrator can read the explanation in Settings.
    expect(screen.getByRole("button", { name: "Settings" }).hasAttribute("disabled")).toBe(false);
  });
  it("keeps the conversation list when only one feature is refused", async () => {
    vi.mocked(cloudApi).mockImplementation(async (path, init) => {
      calls.push({ path, init });
      if (path === "/capabilities") return { ...capabilities, enabled: true, features: { ...capabilities.features, memory: true } };
      if (path === "/conversations")
        return { conversations: [{ id: "c1", title: "Keep me", revision: 1, createdAt: "2026-10-11T00:00:00Z", updatedAt: "2026-10-11T00:00:00Z" }], nextCursor: null };
      if (path === "/settings") return { enabled: true, retentionDays: 90, revision: 1 };
      if (path === "/memory/settings")
        throw new ClientApiError("cloud_memory_disabled", "Denied", 403);
      throw new Error(path);
    });
    const onWorkOff = vi.fn();
    render(<CloudWorkspace admin onWorkOff={onWorkOff} />);
    await screen.findByRole("button", { name: "Keep me" });
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    await screen.findAllByText(/memory is disabled/);
    expect(screen.getByRole("button", { name: "Keep me" })).toBeTruthy();
    expect(onWorkOff).not.toHaveBeenCalled();
  });
  it("treats a work_disabled response during use as Work being off", async () => {
    vi.mocked(cloudApi).mockImplementation(async (path, init) => {
      calls.push({ path, init });
      if (path === "/capabilities") return { ...capabilities, enabled: true };
      if (path === "/conversations")
        throw new ClientApiError("work_disabled", "Work is disabled.", 403);
      throw new Error(path);
    });
    const onWorkOff = vi.fn();
    render(<CloudWorkspace admin={false} onWorkOff={onWorkOff} />);
    await waitFor(() => expect(onWorkOff).toHaveBeenCalledTimes(1));
    expect(screen.getByText(/Ask an administrator to enable it/)).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Manage Work access" })).toBeNull();
  });
  it("deduplicates replayed deltas after the durable snapshot", async () => {
    detail = { ...detail, runs: [run], messages: [{ id: "previous", runId: "old-run", runStatus: "completed", role: "assistant", text: "Earlier answer", createdAt: conversation.createdAt }],
      toolInvocations: [{ id: "old-tool", runId: "old-run", roundId: "round", callId: "call", name: "read_file", arguments: { path: "earlier.md" }, actionHash: "hash", status: "completed", createdAt: conversation.createdAt, updatedAt: conversation.updatedAt }] };
    let receive: Parameters<typeof readCloudEvents>[3] | undefined;
    vi.mocked(readCloudEvents).mockImplementation(
      async (_id, _cursor, signal, onEvent) => {
        receive = onEvent;
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
      },
    );
    await open();
    fireEvent.click(screen.getByRole("button", { name: "First conversation" }));
    await screen.findByText("Saved partial");
    act(() => {
      const event = {
        sequence: 3,
        type: "assistant.delta" as const,
        data: { text: " more" },
        createdAt: conversation.createdAt,
      };
      receive?.(event);
      receive?.(event);
    });
    expect(screen.getByText("Saved partial more")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Read earlier.md, Done/ })).toBeTruthy();
  });
  it("updates approval status immediately and ignores replayed approval events", async () => {
    detail = { ...detail, runs: [run] };
    let receive: Parameters<typeof readCloudEvents>[3] | undefined;
    vi.mocked(readCloudEvents).mockImplementation(async (_id, _cursor, signal, onEvent) => {
      receive = onEvent;
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    });
    await open();
    fireEvent.click(screen.getByRole("button", { name: "First conversation" }));
    await screen.findByText("Saved partial");
    const invocation = { id: "t", runId: "run", roundId: "round", callId: "call", name: "edit_file",
      arguments: { path: "a.md", oldText: "old", newText: "new" }, actionHash: "hash", status: "pendingApproval" as const,
      createdAt: conversation.createdAt, updatedAt: conversation.updatedAt };
    const approval = { id: "a", runId: "run", invocationId: "t", actionHash: "hash", status: "pending" as const, createdAt: conversation.createdAt };
    const requested = { sequence: 3, type: "approval.requested" as const, data: { invocation, approval }, createdAt: conversation.createdAt };
    act(() => receive?.(requested));
    expect(screen.getByText("Waiting for your approval")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Editing a.md, Needs approval/ }).getAttribute("aria-expanded")).toBe("false");
    act(() => {
      receive?.({ sequence: 4, type: "approval.decided", data: { invocation: { ...invocation, status: "completed" }, approval: { ...approval, status: "approved" } }, createdAt: conversation.createdAt });
      receive?.(requested);
    });
    expect(screen.queryByText("Waiting for your approval")).toBeNull();
    expect(screen.queryByRole("button", { name: "Apply change" })).toBeNull();
  });
  it("keeps uncertain uploads in their original conversation until explicitly checked", async () => {
    const original = vi.mocked(cloudApi).getMockImplementation()!;
    vi.mocked(cloudApi).mockImplementation(async (path, init) => {
      if (path === "/capabilities")
        return {
          ...capabilities,
          features: { ...capabilities.features, files: true },
        };
      if (path.startsWith("/conversations/conversation/files?"))
        throw new ClientApiError("request_timeout", "Timed out", 0);
      return original(path, init);
    });
    await open();
    fireEvent.change(screen.getByLabelText("Attach files"), {
      target: { files: [new File(["notes"], "notes.txt")] },
    });
    await screen.findByRole("button", { name: "Check saved upload" });
    expect(
      screen
        .getByRole("button", { name: "New conversation" })
        .hasAttribute("disabled"),
    ).toBe(true);
    fireEvent.keyDown(window, { key: "n", metaKey: true });
    expect(
      screen.getByRole("button", { name: "Conversation actions" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "First conversation" }),
    ).toBeTruthy();
  });
  it("does not submit or restore a late conversation creation after access is withdrawn", async () => {
    const original = vi.mocked(cloudApi).getMockImplementation()!;
    let finishCreate!: (value: CloudConversation) => void;
    vi.mocked(cloudApi).mockImplementation(async (path, init) => {
      if (path === "/conversations" && init?.method === "POST")
        return new Promise<CloudConversation>((resolve) => {
          finishCreate = resolve;
        });
      if (path === "/memory/settings")
        throw new ClientApiError("access_denied", "Denied", 403);
      if (path === "/capabilities")
        return { ...capabilities, features: { ...capabilities.features, memory: true } };
      return original(path, init);
    });
    await open();
    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), {
      target: { value: "Private message" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(finishCreate).toBeTypeOf("function"));
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    await screen.findByText(
      "Your organization has not granted you Cloud Work access.",
    );
    await act(async () => {
      finishCreate(conversation);
    });
    expect(calls.some((call) => call.path.endsWith("/messages"))).toBe(false);
    expect(
      screen.queryByRole("button", { name: "First conversation" }),
    ).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Message" })).toBeNull();
  });
  it("preserves generative UI exploration through streamed deltas, replay and durable reconciliation", async () => {
    const visual = { version: 1, title: "Synthetic comparison", summary: "Illustrative only", blocks: [{ type: "calculator", title: "Estimate", inputs: [{ id: "seats", label: "Seats", min: 1, max: 20, step: 1, value: 5 }], outputs: [{ label: "Total", expression: "seats*10" }] }] };
    const invocation = { id: "visual", runId: run.id, roundId: "round", callId: "call", name: "present_visual", actionHash: "hash", arguments: visual, textOffset: 0, status: "completed" as const, output: { kind: "cloud_visual", presented: true }, createdAt: run.createdAt, updatedAt: run.updatedAt };
    detail = { ...detail, runs: [run], toolInvocations: [invocation], messages: [{ id: "user", runId: run.id, runStatus: "running", role: "user", text: "Compare", createdAt: run.createdAt }] };
    const original = vi.mocked(cloudApi).getMockImplementation()!;
    vi.mocked(cloudApi).mockImplementation(async (path, init) => path === "/runs/run" ? { run, assistantText: "", toolInvocations: [invocation] } : original(path, init));
    let receive: Parameters<typeof readCloudEvents>[3] | undefined;
    vi.mocked(readCloudEvents).mockImplementation(async (_id, _cursor, signal, onEvent) => {
      receive = onEvent;
      await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
    });
    await open();
    fireEvent.click(screen.getByRole("button", { name: "First conversation" }));
    const control = await screen.findByRole("spinbutton", { name: "Seats" });
    fireEvent.change(control, { target: { value: "12" } });
    expect(screen.getByLabelText("Total").textContent).toBe("120");
    await waitFor(() => expect(receive).toBeDefined());
    act(() => {
      const event = { sequence: 3, type: "tool.completed" as const, data: { invocation: structuredClone(invocation) }, createdAt: run.createdAt };
      receive!(event); receive!(event);
      receive!({ sequence: 4, type: "assistant.delta", data: { text: "Done." }, createdAt: run.createdAt });
    });
    expect(screen.getAllByRole("spinbutton", { name: "Seats" })).toHaveLength(1);
    expect(screen.getByRole("spinbutton", { name: "Seats" })).toBe(control);
    detail = { ...detail, runs: [{ ...run, status: "completed" }], messages: [...detail.messages, { id: "saved", runId: run.id, role: "assistant", runStatus: "completed", text: "Done.", createdAt: run.createdAt }] };
    act(() => receive!({ sequence: 5, type: "run.completed", data: {}, createdAt: run.createdAt }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Stop response" })).toBeNull());
    expect(screen.getByRole("spinbutton", { name: "Seats" })).toBe(control);
    expect((control as HTMLInputElement).value).toBe("12");
    expect(screen.getByLabelText("Total").textContent).toBe("120");
  });
  it.each(["event", "snapshot"])("retries terminal %s reconciliation until durable messages load", async (terminalSource) => {
    detail = { ...detail, runs: [run] };
    const original = vi.mocked(cloudApi).getMockImplementation()!;
    let reads = 0;
    const completed = {
      ...detail,
      runs: [{ ...run, status: "completed" as const }],
      messages: [{ id: "durable", runId: run.id, runStatus: "completed" as const, role: "assistant" as const, text: "Durable final reply", createdAt: conversation.createdAt }],
    };
    vi.mocked(cloudApi).mockImplementation(async (path, init) => {
      if (path === "/conversations/conversation") {
        reads++;
        if (reads === 2 || reads === 3) throw new ClientApiError("service_unavailable", "Temporary outage", 503);
        if (reads >= 4) return completed;
      }
      if (path === "/runs/run" && terminalSource === "snapshot")
        return { run: completed.runs[0], assistantText: "Saved partial" };
      return original(path, init);
    });
    vi.mocked(readCloudEvents).mockImplementation(async (_id, _cursor, _signal, onEvent) => {
      onEvent({ sequence: 3, type: "run.completed", data: {}, createdAt: conversation.createdAt });
    });
    await open();
    fireEvent.click(screen.getByRole("button", { name: /^First conversation/ }));
    await screen.findByText("Saved partial");
    await waitFor(() => expect(reads).toBe(2));
    expect(screen.getByRole("button", { name: "Stop response" })).toBeTruthy();
    await screen.findByText("Durable final reply", {}, { timeout: 6500 });
    expect(reads).toBe(4);
    expect(screen.queryByText("Saved partial")).toBeNull();
    expect(screen.queryByRole("button", { name: "Stop response" })).toBeNull();
    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), { target: { value: "Next question" } });
    expect(screen.getByRole("button", { name: "Send" }).hasAttribute("disabled")).toBe(false);
    expect(vi.mocked(readCloudEvents)).toHaveBeenCalledTimes(terminalSource === "event" ? 1 : 0);
  }, 10000);
  it.each(["navigation", "access", "unmount"])("stops terminal reconciliation on %s changes", async (change) => {
    detail = { ...detail, runs: [run] };
    const original = vi.mocked(cloudApi).getMockImplementation()!;
    let reads = 0;
    vi.mocked(cloudApi).mockImplementation(async (path, init) => {
      if (path === "/conversations/conversation" && ++reads > 1)
        throw new ClientApiError(change === "access" ? "access_denied" : "service_unavailable", "Unavailable", change === "access" ? 403 : 503);
      return original(path, init);
    });
    vi.mocked(readCloudEvents).mockImplementation(async (_id, _cursor, _signal, onEvent) => {
      onEvent({ sequence: 3, type: "run.completed", data: {}, createdAt: conversation.createdAt });
    });
    await open();
    fireEvent.click(screen.getByRole("button", { name: /^First conversation/ }));
    await waitFor(() => expect(reads).toBe(2));
    if (change === "navigation") fireEvent.click(screen.getByRole("button", { name: "New conversation" }));
    if (change === "unmount") cleanup();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 2300)); });
    expect(reads).toBe(2);
    expect(screen.queryByText("Saved partial")).toBeNull();
  });
  it("does not let a terminal stream refresh strand explicit conversation loading", async () => {
    detail = { ...detail, runs: [run] };
    let receive: Parameters<typeof readCloudEvents>[3] | undefined;
    vi.mocked(readCloudEvents).mockImplementation(
      async (_id, _cursor, signal, onEvent) => {
        receive = onEvent;
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
      },
    );
    await open();
    fireEvent.click(
      screen.getByRole("button", { name: /^First conversation/ }),
    );
    await screen.findByText("Saved partial");
    const original = vi.mocked(cloudApi).getMockImplementation()!;
    let finishLoad!: (value: CloudConversationDetail) => void;
    vi.mocked(cloudApi).mockImplementation(async (path, init) => {
      if (path === "/conversations/conversation")
        return new Promise<CloudConversationDetail>((resolve) => {
          finishLoad = resolve;
        });
      return original(path, init);
    });
    fireEvent.click(
      screen.getByRole("button", { name: /^First conversation/ }),
    );
    await waitFor(() => expect(finishLoad).toBeTypeOf("function"));
    await act(async () => {
      receive?.({
        sequence: 3,
        type: "run.completed",
        data: {},
        createdAt: conversation.createdAt,
      });
    });
    await act(async () => {
      finishLoad({ ...detail, runs: [{ ...run, status: "completed" }] });
    });
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: "New conversation" })
          .hasAttribute("disabled"),
      ).toBe(false),
    );
    expect(screen.queryByRole("button", { name: "Stop response" })).toBeNull();
  });

  it("shows a recoverable error for malformed conversation history", async () => {
    const original = vi.mocked(cloudApi).getMockImplementation()!;
    vi.mocked(cloudApi).mockImplementation(async (path, init) =>
      path === "/conversations" && !init?.method ? {} : original(path, init),
    );
    render(<CloudWorkspace admin={false} />);
    await screen.findByRole("alert");
    expect(screen.getByRole("button", { name: "Load again" })).toBeTruthy();
  });
  it("preserves the draft and request when a successful send response is malformed", async () => {
    const original = vi.mocked(cloudApi).getMockImplementation()!;
    vi.mocked(cloudApi).mockImplementation(async (path, init) => {
      if (path.endsWith("/messages")) {
        calls.push({ path, init });
        return {};
      }
      return original(path, init);
    });
    await open();
    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), {
      target: { value: "Keep this draft" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByRole("button", { name: "Retry saved request" });
    expect(
      (screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement)
        .value,
    ).toBe("Keep this draft");
    expect(
      calls.filter((call) => call.path.endsWith("/messages")),
    ).toHaveLength(1);
  });

  it("guards unsaved organization settings when navigating back to a conversation", async () => {
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    try {
      render(<CloudWorkspace admin />);
      await screen.findByRole("button", { name: "First conversation" });
      fireEvent.click(screen.getByRole("button", { name: "Settings" }));
      const retention = await screen.findByRole("textbox", {
        name: "Conversation retention in days",
      });
      await waitFor(() =>
        expect((retention as HTMLInputElement).disabled).toBe(false),
      );
      fireEvent.change(retention, { target: { value: "30" } });
      const link = screen.getByRole("link", { name: "Manage organization" });
      expect(link.getAttribute("href")).toBe("/");
      const click = new MouseEvent("click", { bubbles: true, cancelable: true });
      fireEvent(link, click);
      expect(click.defaultPrevented).toBe(true);
      expect(confirm).toHaveBeenCalledWith("Leave Work and discard your unsaved changes?");
      expect((screen.getByRole("textbox", { name: "Conversation retention in days" }) as HTMLInputElement).value).toBe("30");
      fireEvent.click(
        screen.getByRole("button", { name: "Back to conversation" }),
      );
      expect(confirm).toHaveBeenCalledWith("Discard your unsaved changes?");
      expect((retention as HTMLInputElement).value).toBe("30");
      expect(screen.queryByRole("textbox", { name: "Message" })).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

it.each(["Settings", "LLM Providers", "Plugins"])("activates an opened or created personal panel from %s", async destination => {
  const personal: PersonalWorkspaceBinding = { panelProjectId: null, newChatProjectId: null, projects: [], panel: null, onClosePanel: vi.fn(), onNewConversation: vi.fn(), onConversationChanged: vi.fn() };
  const { rerender } = render(<CloudWorkspace admin personal={personal} />);
  await screen.findByRole("button", { name: "First conversation" });
  fireEvent.click(screen.getByRole("button", { name: destination }));
  expect(screen.queryByRole("textbox", { name: "Message" })).toBeNull();
  rerender(<CloudWorkspace admin personal={{ ...personal, panelProjectId: "mine", panel: () => <div>My personal instructions</div> }} />);
  expect(await screen.findByText("My personal instructions")).toBeTruthy();
  expect(screen.queryByRole("textbox", { name: "Message" })).toBeNull();
});
it("keeps the live stream connected when personal-project callbacks change", async () => {
  detail = { conversation: { ...conversation, personalProjectId: "mine" }, messages: [], runs: [run] };
  const personal: PersonalWorkspaceBinding = { panelProjectId: null, newChatProjectId: null, projects: [], panel: null, onClosePanel: vi.fn(), onNewConversation: vi.fn(), onConversationChanged: vi.fn() };
  const { rerender } = render(<CloudWorkspace admin personal={personal} bootstrap={{ capabilities, detail, files: [] }} />);
  await waitFor(() => expect(readCloudEvents).toHaveBeenCalled());
  const count = vi.mocked(readCloudEvents).mock.calls.length;
  const snapshots = calls.filter(call => call.path === "/runs/run").length;
  rerender(<CloudWorkspace admin personal={{ ...personal, onConversationChanged: vi.fn() }} bootstrap={{ capabilities, detail, files: [] }} />);
  await act(async () => {});
  expect(vi.mocked(readCloudEvents).mock.calls).toHaveLength(count);
  expect(calls.filter(call => call.path === "/runs/run")).toHaveLength(snapshots);
});
