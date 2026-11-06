import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { isConversationVisible, publishVisible, trackVisibleConversation, visibleInAnotherTab } from "./activity";
let release = () => {}, stop = () => {};
beforeEach(() => { localStorage.clear(); vi.spyOn(document, "hasFocus").mockReturnValue(true); vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible"); });
afterEach(() => { stop(); release(); vi.restoreAllMocks(); localStorage.clear(); });
it("recognizes a private conversation without relying on address-bar query parameters", () => {
  window.history.replaceState(null, "", "/work/cloud");
  release = trackVisibleConversation({ conversationId: "private", projectId: null });
  stop = publishVisible("account", "tab");
  expect(isConversationVisible("private", null)).toBe(true);
  expect(visibleInAnotherTab("account", "private", null)).toBe(true);
  expect(isConversationVisible("other", null)).toBe(false);
});
it("withdraws visibility when leaving the conversation or backgrounding the tab", () => {
  release = trackVisibleConversation({ conversationId: "project-chat", projectId: "project" });
  stop = publishVisible("account", "tab");
  vi.mocked(document.hasFocus).mockReturnValue(false);
  window.dispatchEvent(new Event("blur"));
  expect(isConversationVisible("project-chat", "project")).toBe(false);
  expect(visibleInAnotherTab("account", "project-chat", "project")).toBe(false);
  vi.mocked(document.hasFocus).mockReturnValue(true);
  release();
  expect(isConversationVisible("project-chat", "project")).toBe(false);
});
it("does not let an old unmount clear a newly mounted conversation", () => {
  const old = trackVisibleConversation({ conversationId: "old", projectId: null });
  release = trackVisibleConversation({ conversationId: "new", projectId: null });
  old(); expect(isConversationVisible("new", null)).toBe(true);
});
