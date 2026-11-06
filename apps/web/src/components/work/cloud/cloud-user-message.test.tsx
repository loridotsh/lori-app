import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UserMessageText } from "./cloud-user-message";

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("UserMessageText", () => {
  it("temporarily reveals a collapsed message for conversation search", () => {
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(560);
    const text = "Long content ".repeat(100);
    const view = render(<UserMessageText text={text} />);
    const paragraph = view.container.querySelector('[data-conversation-search-text="user"]')!;
    view.rerender(<UserMessageText text={text} revealForSearch />);
    expect(paragraph.className).not.toContain("line-clamp-");
    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
    view.rerender(<UserMessageText text={text} />);
    expect(paragraph.className).toContain("line-clamp-");
  });
  it("shows a short message in full with no toggle", () => {
    render(<UserMessageText text="hey" />);
    expect(screen.getByText("hey")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });
  it("collapses a long paste and reveals it on request, keeping every character", () => {
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(560);
    const text = "filler ".repeat(500);
    render(<UserMessageText text={text} />);
    const toggle = screen.getByRole("button", { name: /Show more/ });
    expect(toggle.textContent).toBe("Show more");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    const paragraph = document.getElementById(toggle.getAttribute("aria-controls")!)!;
    expect(paragraph.className).toContain("line-clamp-");
    // The full text is in the DOM even while clamped, so find-in-page and copy still work.
    expect(paragraph.textContent).toBe(text);
    fireEvent.click(toggle);
    expect(screen.getByRole("button", { name: "Show less" }).getAttribute("aria-expanded")).toBe("true");
    expect(paragraph.className).not.toContain("line-clamp-");
    fireEvent.click(screen.getByRole("button", { name: "Show less" }));
    expect(paragraph.className).toContain("line-clamp-");
  });
  it("also collapses many short lines", () => {
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(840);
    render(<UserMessageText text={Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n")} />);
    expect(screen.getByRole("button", { name: /Show more/ })).toBeTruthy();
  });
  it("highlights mentions of real files and plugins, and nothing else", () => {
    const { container } = render(
      <UserMessageText
        text="Compare @notes/plan.md with @GitHub issues. Email me@plan.com or @nobody."
        mentionable={["notes/plan.md", "GitHub"]}
      />,
    );
    const marked = [...container.querySelectorAll("span.text-primary")].map((node) => node.textContent);
    expect(marked).toEqual(["@notes/plan.md", "@GitHub"]);
    expect(container.textContent).toBe("Compare @notes/plan.md with @GitHub issues. Email me@plan.com or @nobody.");
  });
  it("keeps whitespace and leaves a medium message alone", () => {
    render(<UserMessageText text={"a\n  b"} />);
    expect(screen.queryByRole("button")).toBeNull();
  });
  it("uses rendered wrapping rather than a character threshold and responds to pane resizing", () => {
    let height = 168;
    let resized!: () => void;
    const disconnect = vi.fn();
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(() => height);
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: () => void) { resized = callback; }
      observe() {}
      disconnect = disconnect;
    });
    const view = render(<UserMessageText text="A message that wraps to six lines in a narrow pane." />);
    expect(screen.getByRole("button", { name: "Show more" })).toBeTruthy();
    height = 140;
    act(() => resized());
    expect(screen.queryByRole("button")).toBeNull();
    height = 196;
    act(() => resized());
    expect(screen.getByRole("button", { name: "Show more" })).toBeTruthy();
    view.unmount();
    expect(disconnect).toHaveBeenCalled();
  });
  it("resets expansion for a changed message and preserves mention highlighting", () => {
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(280);
    const view = render(<UserMessageText text="Read @notes.md and explain everything." mentionable={["notes.md"]} />);
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    expect(screen.getByText("@notes.md").className).toContain("text-primary");
    view.rerender(<UserMessageText text="Another long message" />);
    expect(screen.getByRole("button", { name: "Show more" }).getAttribute("aria-expanded")).toBe("false");
  });
});
