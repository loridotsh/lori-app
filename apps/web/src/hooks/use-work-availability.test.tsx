import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClientApiError } from "@/lib/client-api";
import { workApi } from "@/lib/work-api";
import { WorkModeSwitch } from "@/components/work/cloud/work-mode-switch";
import {
  CloudWorkOffNotice,
  OpenCloudWorkButton,
} from "@/components/work/cloud-work-access";
import {
  notifyWorkAccessChanged,
  resetWorkAvailabilityCache,
  useWorkAvailability,
} from "./use-work-availability";

vi.mock("@/lib/work-api", () => ({ workApi: vi.fn() }));

function Probe({ skip = false }: { skip?: boolean }) {
  const value = useWorkAvailability(skip);
  return <p data-testid="value">{String(value)}</p>;
}

beforeEach(() => resetWorkAvailabilityCache());
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe("useWorkAvailability", () => {
  it("reports the server's answer", async () => {
    vi.mocked(workApi).mockResolvedValue({ contractVersion: 1, enabled: false });
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId("value").textContent).toBe("false"));
  });
  it("treats an explicit work_disabled refusal as off", async () => {
    vi.mocked(workApi).mockRejectedValue(
      new ClientApiError("work_disabled", "Work is disabled.", 403),
    );
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId("value").textContent).toBe("false"));
  });
  it("stays unknown (never disables controls) when availability cannot be read", async () => {
    vi.mocked(workApi).mockRejectedValue(new ClientApiError("network_unavailable", "Offline", 0));
    render(<Probe />);
    await waitFor(() => expect(workApi).toHaveBeenCalled());
    expect(screen.getByTestId("value").textContent).toBe("null");
  });
  it("ignores malformed responses", async () => {
    vi.mocked(workApi).mockResolvedValue({ enabled: "yes" });
    render(<Probe />);
    await waitFor(() => expect(workApi).toHaveBeenCalled());
    expect(screen.getByTestId("value").textContent).toBe("null");
  });
  it("does not fetch when skipped and shares one request between consumers", async () => {
    vi.mocked(workApi).mockResolvedValue({ enabled: true });
    render(<Probe skip />);
    expect(workApi).not.toHaveBeenCalled();
    cleanup();
    render(
      <>
        <Probe />
        <Probe />
      </>,
    );
    await waitFor(() => expect(screen.getAllByTestId("value")[1]!.textContent).toBe("true"));
    expect(workApi).toHaveBeenCalledTimes(1);
  });
  it("re-checks when the window regains focus after the cache goes stale", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(workApi).mockResolvedValueOnce({ enabled: true });
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId("value").textContent).toBe("true"));
    vi.mocked(workApi).mockResolvedValueOnce({ enabled: false });
    await act(async () => {
      vi.advanceTimersByTime(20_000);
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => expect(screen.getByTestId("value").textContent).toBe("false"));
    vi.useRealTimers();
  });
});

describe("WorkModeSwitch when Work is off", () => {
  it("renders Work as a disabled, explained control and never links to it", async () => {
    vi.mocked(workApi).mockResolvedValue({ enabled: false });
    render(<WorkModeSwitch mode="manage" />);
    await waitFor(() =>
      expect(
        screen.getByRole("link", { name: /Work/ }).getAttribute("aria-disabled"),
      ).toBe("true"),
    );
    const work = screen.getByRole("link", { name: /Work/ });
    expect(work.getAttribute("href")).toBeNull();
    expect(work.getAttribute("title")).toMatch(/turned off/);
    expect(screen.queryByRole("link", { name: "Manage" })).toBeNull();
  });
  it("keeps Work a normal link when it is on or unknown", async () => {
    vi.mocked(workApi).mockResolvedValue({ enabled: true });
    render(<WorkModeSwitch mode="manage" />);
    await waitFor(() => expect(workApi).toHaveBeenCalled());
    expect(screen.getByRole("link", { name: "Work" }).getAttribute("href")).toBe("/work/cloud");
  });
  it("does not query availability from inside Cloud Work", () => {
    render(<WorkModeSwitch mode="work" />);
    expect(workApi).not.toHaveBeenCalled();
  });
  it("makes the disabled Work item focusable so its explanation is reachable", async () => {
    vi.mocked(workApi).mockResolvedValue({ enabled: false });
    render(<WorkModeSwitch mode="manage" />);
    // The item is replaced when availability arrives, so query again rather than hold the first element.
    await waitFor(() =>
      expect(screen.getByRole("link", { name: /Work/ }).getAttribute("aria-disabled")).toBe("true"),
    );
    expect(screen.getByRole("link", { name: /Work/ }).getAttribute("tabindex")).toBe("0");
  });
});

describe("Work access entry points follow a saved change", () => {
  it("re-enables the Cloud Work button and clears the notice right after Work is turned on", async () => {
    vi.mocked(workApi).mockResolvedValue({ enabled: false });
    render(
      <>
        <CloudWorkOffNotice initial={false} redirected admin />
        <OpenCloudWorkButton initial={false} />
      </>,
    );
    expect(screen.getByText("Cloud Work is unavailable")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open Cloud Work" }).hasAttribute("disabled")).toBe(true);
    // An administrator saves Work access in the editor on this page.
    vi.mocked(workApi).mockResolvedValue({ enabled: true });
    act(() => notifyWorkAccessChanged());
    await waitFor(() =>
      expect(screen.getByRole("link", { name: "Open Cloud Work" }).getAttribute("href")).toBe("/work/cloud"),
    );
    expect(screen.queryByText("Cloud Work is unavailable")).toBeNull();
  });
  it("shows nothing when Work is on, and stays quiet until it is known after a redirect", async () => {
    vi.mocked(workApi).mockResolvedValue({ enabled: true });
    const { unmount } = render(<CloudWorkOffNotice initial redirected={false} admin={false} />);
    await waitFor(() => expect(workApi).toHaveBeenCalled());
    expect(screen.queryByText("Cloud Work is unavailable")).toBeNull();
    unmount();
    resetWorkAvailabilityCache();
    vi.mocked(workApi).mockRejectedValue(new ClientApiError("network_unavailable", "Offline", 0));
    render(<CloudWorkOffNotice initial={null} redirected admin={false} />);
    expect(screen.getByText(/Ask an administrator to turn it on/)).toBeTruthy();
  });
});
