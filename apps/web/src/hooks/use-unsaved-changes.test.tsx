import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useUnsavedChanges } from "./use-unsaved-changes";

function Harness({ active }: { active: boolean }) {
  useUnsavedChanges(active);
  return <a href="/teams">Teams</a>;
}

describe("useUnsavedChanges", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("keeps same-origin navigation in place when the user rejects data loss", () => {
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    render(<Harness active />);
    const link = screen.getByRole("link", { name: "Teams" });

    expect(fireEvent.click(link)).toBe(false);
    expect(confirm).toHaveBeenCalledWith(
      "You have unsaved access changes. Leave without saving?",
    );
  });

  it("does not intercept navigation after changes are saved", () => {
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    render(<Harness active={false} />);

    expect(fireEvent.click(screen.getByRole("link", { name: "Teams" }))).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });

  it.each(["ctrlKey", "metaKey", "shiftKey", "altKey"])("does not prompt for a %s click that keeps the editing page open", (modifier) => {
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    render(<Harness active />);
    fireEvent.click(screen.getByRole("link", { name: "Teams" }), { [modifier]: true });
    expect(confirm).not.toHaveBeenCalled();
  });

  it("does not prompt for an anchor in the current document", () => {
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    render(<Harness active />);
    const link = screen.getByRole("link", { name: "Teams" });
    link.setAttribute("href", "#details");
    fireEvent.click(link);
    expect(confirm).not.toHaveBeenCalled();
  });
});
