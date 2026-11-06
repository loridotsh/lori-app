import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SetupTokenGuide } from "./setup-token-guide";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("SetupTokenGuide", () => {
  it("keeps operator instructions collapsed so the setup form comes first", () => {
    const { container } = render(<SetupTokenGuide guidance={{ source: "docker_compose" }} />);
    expect(screen.getByText("Get your setup token")).toBeTruthy();
    expect(container.querySelector("details")?.open).toBe(false);
    expect(screen.getByText("docker compose --profile tools run --rm --no-deps -T setup-token")).toBeTruthy();
    expect(screen.getByText(/Use the same Compose files and project name/)).toBeTruthy();
  });

  it("updates a token's remaining lifetime and expiry while the page stays open", () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-28T12:00:00Z"));
    render(<SetupTokenGuide guidance={{ source: "docker_compose", expiresAt: "2026-10-28T12:01:00Z" }} />);
    expect(screen.getByText("Token expires in 1 minute.")).toBeTruthy();
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(screen.getByText(/Your setup token has expired/)).toBeTruthy();
  });

  it("offers manual copying when clipboard permission is denied", async () => {
    vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) } });
    render(<SetupTokenGuide guidance={{ source: "local_development", developmentToken: "synthetic-test-token" }} />);
    fireEvent.click(screen.getByText("Local development token"));
    fireEvent.click(screen.getByRole("button", { name: "Copy command: Copy the development token" }));
    expect(await screen.findByText("Could not copy. Select the command and copy it manually.")).toBeTruthy();
  });
});
