import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SHIMMER_MS, ShimmerText } from "./shimmer-text";

const delayOf = (node: HTMLElement) => node.style.getPropertyValue("--shimmer-delay");

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("ShimmerText", () => {
  it("renders the real text with the shimmer class and the shared duration", () => {
    render(<ShimmerText className="truncate">Thinking</ShimmerText>);
    const node = screen.getByText("Thinking");
    expect(node.classList.contains("text-shimmer")).toBe(true);
    expect(node.classList.contains("truncate")).toBe(true);
    expect(node.style.getPropertyValue("--shimmer-dur")).toBe(`${SHIMMER_MS}ms`);
  });
  it("is plain text, with no animation hooks, when inactive", () => {
    render(
      <ShimmerText active={false} className="truncate" title="Waiting">
        Waiting for your approval
      </ShimmerText>,
    );
    const node = screen.getByText("Waiting for your approval");
    expect(node.classList.contains("text-shimmer")).toBe(false);
    expect(node.getAttribute("title")).toBe("Waiting");
    expect(node.style.getPropertyValue("--shimmer-dur")).toBe("");
    expect(delayOf(node)).toBe("");
  });
  it("starts every shimmer on the same wall-clock phase, whenever it mounts", () => {
    vi.setSystemTime(new Date("2026-10-13T10:00:00.700Z"));
    const first = render(<ShimmerText>First</ShimmerText>);
    const early = delayOf(screen.getByText("First"));
    // Mounted 1.3s later: its delay differs, but the phase it lands on does not.
    act(() => vi.setSystemTime(new Date("2026-10-13T10:00:02.000Z")));
    first.rerender(
      <>
        <ShimmerText>First</ShimmerText>
        <ShimmerText>Second</ShimmerText>
      </>,
    );
    const late = delayOf(screen.getByText("Second"));
    // Where each animation is in its cycle at one common instant: time since mount, shifted by its delay.
    const now = Date.parse("2026-10-13T10:00:05.000Z");
    const phaseNow = (delay: string, mountedAt: string) =>
      (((now - Date.parse(mountedAt) - Number.parseFloat(delay)) % SHIMMER_MS) + SHIMMER_MS) % SHIMMER_MS;
    expect(Number.parseFloat(early)).toBeLessThanOrEqual(0);
    expect(Number.parseFloat(late)).toBeLessThanOrEqual(0);
    expect(early).not.toBe(late);
    expect(phaseNow(early, "2026-10-13T10:00:00.700Z")).toBe(
      phaseNow(late, "2026-10-13T10:00:02.000Z"),
    );
  });
  it("re-syncs when it switches back on, and keeps its caller's own style", () => {
    vi.setSystemTime(new Date("2026-10-13T10:00:00.000Z"));
    const view = render(
      <ShimmerText active={false} style={{ maxWidth: "10rem" }}>
        Reconnecting
      </ShimmerText>,
    );
    expect(delayOf(screen.getByText("Reconnecting"))).toBe("");
    act(() => vi.setSystemTime(new Date("2026-10-13T10:00:01.000Z")));
    view.rerender(<ShimmerText style={{ maxWidth: "10rem" }}>Reconnecting</ShimmerText>);
    const node = screen.getByText("Reconnecting");
    expect(node.classList.contains("text-shimmer")).toBe(true);
    expect(delayOf(node)).not.toBe("");
    expect(node.style.maxWidth).toBe("10rem");
  });
});
