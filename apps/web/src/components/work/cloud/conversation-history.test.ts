import type { CloudConversation } from "@lori-enterprise/contracts";
import { describe, expect, it } from "vitest";
import { mergeConversationHistory } from "./conversation-history";

const conversation = (id: string, day: number, revision = 1): CloudConversation => ({
  id, title: id, revision, createdAt: "2026-10-01T00:00:00Z",
  updatedAt: `2026-10-${String(day).padStart(2, "0")}T00:00:00Z`,
});
const ids = (items: CloudConversation[]) => items.map((item) => item.id);

describe("Conversation history recency", () => {
  it("does not promote a conversation simply because it was opened or refreshed", () => {
    const recent = conversation("recent", 13), old = conversation("old", 10);
    const original = [recent, old];
    expect(ids(mergeConversationHistory(original, [{ ...old }]))).toEqual(["recent", "old"]);
    expect(original).toEqual([recent, old]);
  });
  it("promotes genuine updates and inserts new conversations by saved update time", () => {
    const initial = [conversation("recent", 12), conversation("old", 10)];
    const updated = mergeConversationHistory(initial, [conversation("old", 13, 2)]);
    expect(ids(updated)).toEqual(["old", "recent"]);
    expect(ids(mergeConversationHistory(updated, [conversation("new", 14)]))).toEqual(["new", "old", "recent"]);
  });
  it("rejects stale detail or pagination responses after a rename or message", () => {
    const latest = { ...conversation("chat", 13, 3), title: "Renamed" };
    const merged = mergeConversationHistory([latest], [conversation("chat", 10, 2), conversation("older", 9)]);
    expect(merged).toEqual([latest, conversation("older", 9)]);
  });
  it("deduplicates overlapping pages and preserves server order for timestamp ties", () => {
    const a = conversation("a", 13), z = conversation("z", 13);
    expect(ids(mergeConversationHistory([a, z], [z, conversation("older", 11)]))).toEqual(["a", "z", "older"]);
  });
});
