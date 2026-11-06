import { createRef } from "react";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationFindHighlights } from "./ConversationFind";
import type { ConversationFind } from "./useConversationFind";
import { findTextMatches } from "./textMatches";

afterEach(() => { cleanup(); document.querySelector('[data-highlight-fixture]')?.remove(); vi.unstubAllGlobals(); });
function fixture() {
  const root = document.createElement("div");
  root.dataset.highlightFixture = "";
  root.innerHTML = '<p data-conversation-search-text="answer">One match</p>';
  document.body.append(root);
  const matches = findTextMatches(root, "match").matches;
  const viewport = createRef<HTMLDivElement>(); viewport.current = root;
  return { viewport, find: { searching: true, matches, current: matches[0] } as ConversationFind };
}
describe("conversation highlights", () => {
  it("registers independent current/all ranges and removes them when search closes", () => {
    const registry = new Map();
    vi.stubGlobal("CSS", { highlights: registry });
    vi.stubGlobal("Highlight", class extends Set { priority = 0; });
    const props = fixture();
    const view = render(<ConversationFindHighlights {...props} />);
    expect(registry.get("work-find").size).toBe(1);
    expect(registry.get("work-find-current").priority).toBe(1);
    view.rerender(<ConversationFindHighlights {...props} find={{ ...props.find, searching: false }} />);
    expect(registry.size).toBe(0);
  });
  it("renders a non-interactive fallback without changing message markup", async () => {
    vi.stubGlobal("Highlight", undefined);
    const props = fixture();
    const root = props.viewport.current!;
    const html = root.innerHTML;
    root.getBoundingClientRect = () => ({ top: 0, left: 0, bottom: 100, right: 100, width: 100, height: 100 }) as DOMRect;
    props.find.matches[0]!.range.getClientRects = () => [{ top: 10, left: 10, bottom: 25, right: 50, width: 40, height: 15 }] as unknown as DOMRectList;
    const view = render(<ConversationFindHighlights {...props} />);
    await waitFor(() => expect(document.querySelector('.pointer-events-none.fixed span')).toBeTruthy());
    expect(root.innerHTML).toBe(html);
    view.unmount();
    expect(document.querySelector('.pointer-events-none.fixed')).toBeNull();
  });
});
