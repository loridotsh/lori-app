import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ResizableWorkSidebar } from "./resizable-work-sidebar";

const key = "lori.cloud.sidebar.width.v1";
const separator = () =>
  screen.getByRole("separator", { name: "Resize sidebar" });
const currentWidth = () => Number(separator().getAttribute("aria-valuenow"));
function mount(collapsed = false) {
  return render(
    <ResizableWorkSidebar collapsed={collapsed}>
      <button>Conversation</button>
    </ResizableWorkSidebar>,
  );
}
function startDrag() {
  const handle = separator();
  handle.setPointerCapture = vi.fn();
  handle.hasPointerCapture = vi.fn().mockReturnValue(true);
  handle.releasePointerCapture = vi.fn();
  fireEvent.pointerDown(handle, {
    button: 0,
    isPrimary: true,
    pointerId: 1,
    clientX: 256,
  });
  return handle;
}
beforeEach(() => {
  localStorage.removeItem(key);
  vi.stubGlobal("innerWidth", 1440);
});
afterEach(() => {
  localStorage.removeItem(key);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Work sidebar resizing", () => {
  it("resizes with the keyboard, clamps both bounds, and restores the saved width", () => {
    const view = mount();
    fireEvent.keyDown(separator(), { key: "ArrowRight", shiftKey: true });
    expect(currentWidth()).toBe(288);
    expect(localStorage.getItem(key)).toBe("288");
    view.unmount();
    mount();
    expect(currentWidth()).toBe(288);
    fireEvent.keyDown(separator(), { key: "End" });
    fireEvent.keyDown(separator(), { key: "ArrowRight" });
    expect(currentWidth()).toBe(384);
    fireEvent.keyDown(separator(), { key: "Home" });
    fireEvent.keyDown(separator(), { key: "ArrowLeft" });
    expect(currentWidth()).toBe(224);
  });
  it("commits a drag only on release and resets with a double-click", () => {
    mount();
    const handle = startDrag();
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 330 });
    expect(currentWidth()).toBe(330);
    expect(localStorage.getItem(key)).toBeNull();
    fireEvent.pointerUp(handle, { pointerId: 1 });
    expect(localStorage.getItem(key)).toBe("330");
    expect(document.body.style.cursor).toBe("");
    fireEvent.doubleClick(handle);
    expect(currentWidth()).toBe(256);
    expect(localStorage.getItem(key)).toBe("256");
  });
  it.each(["escape", "cancel", "blur"])(
    "cancels a drag on %s and restores text selection",
    (reason) => {
      document.body.style.userSelect = "text";
      mount();
      const handle = startDrag();
      fireEvent.pointerMove(handle, { pointerId: 1, clientX: 360 });
      expect(currentWidth()).toBe(360);
      if (reason === "escape") fireEvent.keyDown(handle, { key: "Escape" });
      else if (reason === "cancel")
        fireEvent.pointerCancel(handle, { pointerId: 1 });
      else fireEvent.blur(window);
      expect(currentWidth()).toBe(256);
      expect(document.body.style.userSelect).toBe("text");
      expect(document.body.style.cursor).toBe("");
      expect(localStorage.getItem(key)).toBeNull();
      document.body.style.userSelect = "";
    },
  );
  it("keeps space for content at narrower desktop widths and preserves width through collapse", () => {
    localStorage.setItem(key, "384");
    const view = mount();
    vi.stubGlobal("innerWidth", 800);
    act(() => window.dispatchEvent(new Event("resize")));
    expect(currentWidth()).toBe(320);
    expect(separator().getAttribute("aria-valuemax")).toBe("320");
    view.rerender(
      <ResizableWorkSidebar collapsed>
        <button>Conversation</button>
      </ResizableWorkSidebar>,
    );
    expect(screen.queryByRole("separator")).toBeNull();
    expect(screen.getByRole("complementary").style.width).toBe("56px");
    view.rerender(
      <ResizableWorkSidebar collapsed={false}>
        <button>Conversation</button>
      </ResizableWorkSidebar>,
    );
    expect(currentWidth()).toBe(320);
    vi.stubGlobal("innerWidth", 1440);
    act(() => window.dispatchEvent(new Event("resize")));
    expect(currentWidth()).toBe(384);
  });
  it("cleans up an active drag on unmount and tolerates blocked storage", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("Blocked");
    });
    const view = mount();
    fireEvent.keyDown(separator(), { key: "ArrowRight" });
    expect(currentWidth()).toBe(264);
    startDrag();
    view.unmount();
    expect(document.body.style.cursor).toBe("");
    expect(document.body.style.userSelect).toBe("");
  });
});
