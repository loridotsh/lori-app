import { useRef, useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ConversationFindBar, ConversationFindToggle } from "./ConversationFind";
import { useConversationFind } from "./useConversationFind";

beforeAll(() => {
  Object.defineProperty(Range.prototype, "getBoundingClientRect", { configurable: true, value: () => ({ top: 100, bottom: 120, left: 0, right: 40, height: 20, width: 40 }) });
});
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { cleanup(); vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

// Flush rendering between clock steps so pagination and MutationObserver work
// settle in order, independently of CPU contention in the complete test suite.
async function advance(milliseconds: number) {
  for (let elapsed = 0; elapsed < milliseconds; elapsed += 25) {
    await act(async () => { await vi.advanceTimersByTimeAsync(25); });
  }
}

function Harness({ scope = "one", enabled = true, more = false, paused = false, load = async () => true, text = "First match. Second MATCH." }: {
  scope?: string; enabled?: boolean; more?: boolean; paused?: boolean; load?: () => Promise<boolean>; text?: string;
}) {
  const viewport = useRef<HTMLDivElement>(null), container = useRef<HTMLDivElement>(null);
  const [pages, setPages] = useState(0);
  const find = useConversationFind({ scope, enabled, viewport, container, hasEarlier: more && pages < 2, historyKey: String(pages), loadingEarlier: false, historyPaused: paused,
    loadEarlier: async () => { const ok = await load(); if (ok) setPages(value => value + 1); return ok; }, onInspect: () => {} });
  return <div data-conversation-find-scope>
    <ConversationFindToggle find={find} /><ConversationFindBar find={find} />
    <div ref={viewport}><div ref={container}>
      {Array.from({ length: pages }, (_, index) => <article key={index} data-conversation-message={`older-${index}`}><p data-conversation-search-text="user">Older match</p></article>)}
      <article data-conversation-message="latest"><p data-conversation-search-text="answer">{text}</p></article>
    </div></div><textarea aria-label="Draft" defaultValue="Keep my draft" />
  </div>;
}
function search(query = "match") {
  fireEvent.click(screen.getByRole("button", { name: "Find in this conversation" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Search messages" }), { target: { value: query } });
}

describe("conversation find lifecycle", () => {
  it("waits for the scan before showing a clear empty-result state", async () => {
    render(<Harness />);
    search("missing word");
    expect(screen.queryByText("No matches")).toBeNull();
    await advance(125);
    expect(screen.getByText("No matches")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Next match" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByRole("textbox", { name: "Search messages" }), { target: { value: "" } });
    expect(screen.queryByText("No matches")).toBeNull();
  });
  it("opens with Cmd/Ctrl F, navigates with Enter/Shift Enter and closes with Escape", async () => {
    render(<Harness />);
    fireEvent.keyDown(document.body, { key: "f", ctrlKey: true });
    const input = screen.getByRole("textbox", { name: "Search messages" });
    fireEvent.change(input, { target: { value: "match" } });
    await advance(125); expect(screen.getByText("1/2")).toBeTruthy();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByText("2/2")).toBeTruthy();
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(screen.getByText("1/2")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Previous match" }));
    expect(screen.getByText("2/2")).toBeTruthy();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("search")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Find in this conversation" }));
    expect((screen.getByRole("textbox", { name: "Draft" }) as HTMLTextAreaElement).value).toBe("Keep my draft");
  });
  it("loads earlier pages sequentially and preserves the selected match as pages arrive", async () => {
    const load = vi.fn(async () => true);
    render(<Harness more load={load} />);
    search();
    await advance(125); expect(screen.getByText("1/2+")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Next match" }));
    await advance(600); expect(screen.getByText("4/4")).toBeTruthy();
    expect(load).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("Searching earlier messages…")).toBeNull();
  });
  it("keeps partial results and offers retry after a history failure", async () => {
    const load = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    render(<Harness more load={load} />);
    search();
    await advance(250); expect(screen.getByText("Could not finish searching earlier messages.")).toBeTruthy();
    expect(screen.getByText("1/2+")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await advance(600); expect(screen.getByText("3/4")).toBeTruthy();
  });
  it("waits for active operations and resumes older history when they finish", async () => {
    const load = vi.fn(async () => true);
    const view = render(<Harness more paused load={load} />);
    search();
    await advance(125); expect(screen.getByText("1/2+")).toBeTruthy();
    expect(load).not.toHaveBeenCalled();
    view.rerender(<Harness more load={load} />);
    await advance(600); expect(screen.getByText("3/4")).toBeTruthy();
  });
  it("clears query and results on navigation or revoked access", async () => {
    const view = render(<Harness />); search(); await advance(125); expect(screen.getByText("1/2")).toBeTruthy();
    view.rerender(<Harness scope="two" text="Private content" />);
    expect(screen.queryByRole("search")).toBeNull();
    search("Private"); await advance(125); expect(screen.getByText("1/1")).toBeTruthy();
    view.rerender(<Harness scope="two" enabled={false} />);
    expect(screen.queryByRole("search")).toBeNull();
    fireEvent.keyDown(document.body, { key: "f", metaKey: true });
    expect(screen.queryByRole("search")).toBeNull();
  });
  it("does not start another history request after closing during an in-flight page", async () => {
    let resolve!: (value: boolean) => void;
    const load = vi.fn(() => new Promise<boolean>(done => { resolve = done; }));
    render(<Harness more load={load} />); search();
    await advance(200); expect(load).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Close conversation search" }));
    await act(async () => { resolve(true); });
    await advance(250);
    expect(load).toHaveBeenCalledOnce();
  });
  it("updates results during streaming without resetting selection", async () => {
    const view = render(<Harness />); search(); await advance(125); expect(screen.getByText("1/2")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Next match" }));
    let ticks = 0;
    const timer = setInterval(() => view.rerender(<Harness text={`First match. Second MATCH. Third match.${".".repeat(++ticks)}`} />), 40);
    try { await advance(300); expect(screen.getByText("2/3")).toBeTruthy(); }
    finally { clearInterval(timer); }
  });
  it("leaves file and dialog shortcuts alone", () => {
    render(<><Harness /><aside data-conversation-find-ignore><button>File search</button></aside><div role="dialog"><input aria-label="Dialog input" /></div></>);
    fireEvent.keyDown(screen.getByText("File search"), { key: "f", metaKey: true });
    fireEvent.keyDown(screen.getByLabelText("Dialog input"), { key: "f", ctrlKey: true });
    expect(screen.queryByRole("search")).toBeNull();
  });
});
