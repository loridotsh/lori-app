import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { StrictMode, useLayoutEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useConversationScroll } from "./use-conversation-scroll";

let height: number;
let resized: () => void;
const disconnected = vi.fn();
const beforePaint: number[] = [];
const sameMessages = {};
function Transcript({ id, version = sameMessages, text = "", visible = true, searching = false }: { id: string; version?: object; text?: string; visible?: boolean; searching?: boolean }) {
  const scroll = useConversationScroll(id, version, text);
  scroll.paused.current = searching;
  useLayoutEffect(() => { if (scroll.messages.current) beforePaint.push(scroll.messages.current.scrollTop); });
  return visible ? <div role="log" ref={scroll.messages} onScroll={scroll.onScroll}><div ref={scroll.content}>{text}</div></div> : null;
}
beforeEach(() => {
  height = 2000; beforePaint.length = 0;
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(() => height);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: () => void) { resized = callback; }
    observe() {}
    disconnect = disconnected;
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.clearAllMocks(); });
const readAt = (top: number) => { const log = screen.getByRole("log"); log.scrollTop = top; fireEvent.scroll(log); };

describe("Conversation scroll restoration", () => {
  it("keeps a search match still even near the bottom while streaming grows", () => {
    const view = render(<Transcript id="a" />);
    view.rerender(<Transcript id="a" searching />);
    readAt(1380);
    height = 2400;
    view.rerender(<Transcript id="a" searching text="Another chunk" />);
    act(() => resized());
    expect(screen.getByRole("log").scrollTop).toBe(1380);
    view.rerender(<Transcript id="a" />);
    expect(screen.getByRole("log").scrollTop).toBe(1380);
  });
  it("starts at the bottom before paint and restores independent positions even with equal message counts", () => {
    const view = render(<Transcript id="a" />);
    expect(beforePaint).toEqual([1400]);
    readAt(240);
    height = 1200; view.rerender(<Transcript id="b" />);
    expect(screen.getByRole("log").scrollTop).toBe(600);
    readAt(100);
    height = 2000; view.rerender(<Transcript id="a" />);
    expect(screen.getByRole("log").scrollTop).toBe(240);
    expect(beforePaint.at(-1)).toBe(240);
    height = 1200; view.rerender(<Transcript id="b" />);
    expect(screen.getByRole("log").scrollTop).toBe(100);
  });
  it("does not move someone reading history during snapshots, streaming, or layout changes", () => {
    const view = render(<Transcript id="a" />);
    readAt(200);
    height = 2400; view.rerender(<Transcript id="a" version={{}} text="more live text" />);
    act(() => resized());
    expect(screen.getByRole("log").scrollTop).toBe(200);
  });
  it("keeps a bottom-following transcript pinned as content settles and grows", () => {
    const view = render(<Transcript id="a" />);
    height = 2400; view.rerender(<Transcript id="a" text="new tokens" />);
    expect(screen.getByRole("log").scrollTop).toBe(1800);
    height = 2500; act(() => resized());
    expect(screen.getByRole("log").scrollTop).toBe(1900);
  });
  it("restores reading position after the transcript unmounts for Settings", () => {
    const view = render(<Transcript id="a" />);
    readAt(300);
    view.rerender(<Transcript id="a" visible={false} />);
    view.rerender(<Transcript id="a" />);
    expect(screen.getByRole("log").scrollTop).toBe(300);
  });
  it("clamps saved positions when a conversation becomes shorter", () => {
    const view = render(<Transcript id="a" />);
    readAt(500); view.rerender(<Transcript id="b" />);
    height = 800; view.rerender(<Transcript id="a" />);
    expect(screen.getByRole("log").scrollTop).toBe(200);
  });
  it("reconnects size observation under Strict Mode and cleans up on unmount", () => {
    const view = render(<StrictMode><Transcript id="a" /></StrictMode>);
    height = 2600; act(() => resized());
    expect(screen.getByRole("log").scrollTop).toBe(2000);
    view.unmount(); expect(disconnected).toHaveBeenCalled();
  });
});
