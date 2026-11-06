import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudMemoryNote } from "@lori-enterprise/contracts";
import { cloudApi } from "@/lib/cloud-work-api";
import { ClientApiError } from "@/lib/client-api";
import { CloudMemory } from "./cloud-memory";
vi.mock("@/lib/cloud-work-api", async (original) => ({
  ...(await original<object>()),
  cloudApi: vi.fn(),
}));
const note: CloudMemoryNote = {
  id: "note",
  scope: "personal",
  conversationId: null,
  topic: "Writing style",
  content: "Use concise prose",
  sensitive: false,
  revision: 3,
  provenance: "manual",
  sourceMessageId: null,
  createdAt: "2026-10-11T00:00:00Z",
  updatedAt: "2026-10-11T00:00:00Z",
};
let notes: CloudMemoryNote[];
let failure: unknown;
beforeEach(() => {
  notes = [note];
  failure = undefined;
  vi.mocked(cloudApi).mockImplementation(async (path, init) => {
    if (path === "/memory/settings") {
      if (init?.method) {
        if (failure) throw failure;
        return { enabled: true, allowed: true, revision: 2 };
      }
      return { enabled: false, allowed: true, revision: 1 };
    }
    if (path.startsWith("/memory?")) return { notes };
    if (failure) throw failure;
    if (init?.method === "DELETE") {
      notes = [];
      return undefined;
    }
    if (init?.method === "POST" || init?.method === "PATCH") return note;
    throw new Error(path);
  });
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
async function open() {
  render(
    <CloudMemory
      conversationId="conversation"
      conversationTitle="Report"
      onFailure={vi.fn()}
    />,
  );
  await screen.findByRole("heading", { name: "Writing style" });
}
describe("Settings-only cloud memory", () => {
  it("keeps manual management available while use is disabled and scopes search", async () => {
    await open();
    expect(
      screen
        .getByRole("switch", { name: "Use memory in Cloud Work" })
        .getAttribute("aria-checked"),
    ).toBe("false");
    fireEvent.change(screen.getByRole("textbox", { name: "Search memory" }), {
      target: { value: "writing" },
    });
    await waitFor(() =>
      expect(
        vi
          .mocked(cloudApi)
          .mock.calls.some(([path]) => path.includes("q=writing")),
      ).toBe(true),
    );
    fireEvent.change(screen.getByRole("combobox", { name: "Memory scope" }), {
      target: { value: "conversation" },
    });
    await waitFor(() =>
      expect(
        vi
          .mocked(cloudApi)
          .mock.calls.some(
            ([path]) =>
              path.includes("scope=conversation") &&
              path.includes("conversationId=conversation"),
          ),
      ).toBe(true),
    );
  });
  it("saves a manually marked sensitive note in the selected scope", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Add memory" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Topic" }), {
      target: { value: "Private preference" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Content" }), {
      target: { value: "Review manually" },
    });
    fireEvent.click(screen.getByRole("switch", { name: /Sensitive/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save memory" }));
    await waitFor(() =>
      expect(
        vi
          .mocked(cloudApi)
          .mock.calls.some(
            ([path, init]) => path === "/memory" && init?.method === "POST",
          ),
      ).toBe(true),
    );
    const call = vi
      .mocked(cloudApi)
      .mock.calls.find(
        ([path, init]) => path === "/memory" && init?.method === "POST",
      );
    expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({
      scope: "personal",
      topic: "Private preference",
      content: "Review manually",
      sensitive: true,
      requestId: expect.any(String),
    });
  });
  it("uses the reviewed revision for edits and confirms deletion", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Edit Writing style" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Content" }), {
      target: { value: "Use precise prose" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save memory" }));
    await waitFor(() =>
      expect(screen.queryByRole("textbox", { name: "Content" })).toBeNull(),
    );
    const patch = vi
      .mocked(cloudApi)
      .mock.calls.find(([, init]) => init?.method === "PATCH");
    expect(JSON.parse(String(patch?.[1]?.body))).toMatchObject({
      expectedRevision: 3,
      content: "Use precise prose",
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Delete Writing style" }),
    );
    expect(
      vi
        .mocked(cloudApi)
        .mock.calls.some(([, init]) => init?.method === "DELETE"),
    ).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Delete memory" }));
    await screen.findByText("No saved memory in this scope");
    expect(cloudApi).toHaveBeenCalledWith("/memory/note?expectedRevision=3", {
      method: "DELETE",
    });
  });
  it("keeps an uncertain note draft without replaying a mutation", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Edit Writing style" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Content" }), {
      target: { value: "Keep this draft" },
    });
    failure = new ClientApiError("offline", "Offline", 0);
    fireEvent.click(screen.getByRole("button", { name: "Save memory" }));
    await screen.findByRole("button", { name: "Reload saved memory" });
    expect(
      (screen.getByRole("textbox", { name: "Content" }) as HTMLTextAreaElement)
        .value,
    ).toBe("Keep this draft");
    failure = undefined;
    fireEvent.click(
      screen.getByRole("button", { name: "Reload saved memory" }),
    );
    await waitFor(() =>
      expect(
        vi
          .mocked(cloudApi)
          .mock.calls.filter(([, init]) => init?.method === "PATCH"),
      ).toHaveLength(1),
    );
    expect(
      screen
        .getByRole("button", { name: "Save memory" })
        .hasAttribute("disabled"),
    ).toBe(true);
  });
});
