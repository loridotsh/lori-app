import { act, fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PreviewResizeHandle, usePreviewWidth } from "./preview-resize";

const key = "lori.cloud.preview.width.v1";
const separator = () => screen.getByRole("separator", { name: "Resize preview" });
const width = () => Number(separator().getAttribute("aria-valuenow"));
function Panel() {
  const panel = useRef<HTMLElement>(null);
  const resize = usePreviewWidth(panel);
  return <div><aside ref={panel}><PreviewResizeHandle {...resize} /></aside></div>;
}
function drag() {
  const handle = separator();
  handle.setPointerCapture = vi.fn(); handle.hasPointerCapture = vi.fn(() => true); handle.releasePointerCapture = vi.fn();
  fireEvent.pointerDown(handle, { button: 0, isPrimary: true, pointerId: 1, clientX: 900 });
  return handle;
}
beforeEach(() => { localStorage.removeItem(key); vi.stubGlobal("innerWidth", 1440); });
afterEach(() => { localStorage.removeItem(key); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe("Preview resizing", () => {
  it("grows on leftward drag, persists on release and resets on double click", () => {
    render(<Panel />); const handle = drag();
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 800 }); expect(width()).toBe(620);
    expect(localStorage.getItem(key)).toBeNull();
    fireEvent.pointerUp(handle, { pointerId: 1 }); expect(localStorage.getItem(key)).toBe("620");
    expect(document.body.style.cursor).toBe("");
    fireEvent.doubleClick(handle); expect(width()).toBe(520);
  });
  it("supports keyboard resizing and clamps to leave room for the conversation", () => {
    render(<Panel />);
    fireEvent.keyDown(separator(), { key: "ArrowLeft", shiftKey: true }); expect(width()).toBe(552);
    fireEvent.keyDown(separator(), { key: "End" }); expect(width()).toBe(784);
    fireEvent.keyDown(separator(), { key: "ArrowLeft" }); expect(width()).toBe(784);
    fireEvent.keyDown(separator(), { key: "Home" }); expect(width()).toBe(360);
    fireEvent.keyDown(separator(), { key: "ArrowRight" }); expect(width()).toBe(360);
  });
  it.each(["escape", "cancel", "blur"])("cancels %s without persisting and restores selection", (reason) => {
    render(<Panel />); const handle = drag();
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 800 });
    if (reason === "escape") fireEvent.keyDown(handle, { key: "Escape" });
    else if (reason === "cancel") fireEvent.pointerCancel(handle, { pointerId: 1 });
    else fireEvent.blur(window);
    expect(width()).toBe(520); expect(localStorage.getItem(key)).toBeNull();
    expect(document.body.style.cursor).toBe(""); expect(document.body.style.userSelect).toBe("");
  });
  it("restores preference after viewport changes and cleans up during an active drag", () => {
    localStorage.setItem(key, "700"); const view = render(<Panel />); expect(width()).toBe(700);
    vi.stubGlobal("innerWidth", 1100); act(() => window.dispatchEvent(new Event("resize"))); expect(width()).toBe(444);
    vi.stubGlobal("innerWidth", 1440); act(() => window.dispatchEvent(new Event("resize"))); expect(width()).toBe(700);
    drag(); view.unmount(); expect(document.body.style.cursor).toBe(""); expect(document.body.style.userSelect).toBe("");
  });
});
