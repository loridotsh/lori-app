import { describe, expect, it } from "vitest";
import { mergeHistoryPage } from "./history-page";
import type { CloudConversationDetail } from "@lori-enterprise/contracts";
const detail = (id: string, cursor: string | null): CloudConversationDetail => ({ conversation: { id: "chat", title: "Chat", revision: 1, createdAt: "now", updatedAt: "now" }, runs: [], messages: [{ id, runId: id, role: "user", runStatus: "completed", text: id, createdAt: "same rounded timestamp" }], historyCursor: cursor });
describe("loaded history retention", () => {
  it("prepends earlier pages, preserves current state and retains the cursor through refresh", () => {
    const recent = detail("recent", "cursor");
    const older = detail("older", "earliest");
    older.conversation.revision = 0;
    const loaded = mergeHistoryPage(recent, older, true);
    expect(loaded.messages.map(m => m.id)).toEqual(["older", "recent"]);
    expect(loaded.conversation.revision).toBe(1);
    const updated = mergeHistoryPage(loaded, detail("latest", "cursor"));
    expect(updated.messages.map(m => m.id)).toEqual(["older", "recent", "latest"]);
    expect(updated.historyCursor).toBe("earliest");
  });
  it("reconciles optimistic IDs by immutable role/run and fresh terminal runs override stale ones", () => {
    const optimistic = detail("local", null);
    const durable = detail("server", null);
    durable.messages[0]!.runId = "local";
    const run = { id: "local", status: "running", conversationId: "chat" } as CloudConversationDetail["runs"][number];
    optimistic.runs = [run]; durable.runs = [{ ...run, status: "completed" }];
    const merged = mergeHistoryPage(optimistic, durable);
    expect(merged.messages).toHaveLength(1);
    expect(merged.messages[0]!.id).toBe("server");
    expect(merged.runs[0]!.status).toBe("completed");
  });
});
