import type { Device } from "@lori-enterprise/contracts";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DeviceManager } from "./device-manager";

const { clientApiMock, MockClientApiError } = vi.hoisted(() => ({
  clientApiMock: vi.fn(),
  MockClientApiError: class extends Error {
    public constructor(
      public readonly code: string,
      message: string,
      public readonly status: number,
    ) {
      super(message);
    }
  },
}));

vi.mock("@/lib/client-api", () => ({
  ClientApiError: MockClientApiError,
  clientApi: clientApiMock,
}));

const device: Device = {
  appVersion: "1.5.4",
  createdAt: "2026-07-31T00:00:00.000Z",
  currentPolicyRevision: 22,
  id: "device-1",
  inventory: {
    items: [
      {
        enabled: true,
        enabledAgents: ["claude", "codex"],
        id: "frontend-design",
        name: "Frontend Design",
        organizationManaged: false,
        type: "skill",
      },
      {
        enabled: false,
        enabledAgents: [],
        id: "security-review",
        name: "Security Review",
        organizationManaged: true,
        type: "skill",
      },
    ],
    policyRevision: 22,
    reportedAt: "2026-07-31T01:00:00.000Z",
    syncError: null,
    syncStatus: "synced",
  },
  lastSeenAt: "2026-07-31T01:00:00.000Z",
  name: "Lori on macOS",
  owner: {
    email: "ashish@example.com",
    name: "Ashish",
    userId: "user-1",
  },
  platform: "macos",
  status: "connected",
};

describe("DeviceManager inventory", () => {
  beforeEach(() => {
    clientApiMock.mockReset();
  });

  it("shows personal and organization-managed provenance with active tools", async () => {
    const user = userEvent.setup();
    render(
      <DeviceManager
        initialDevices={[device]}
        organizationWide
        publicUrl="https://lori.example.com"
      />,
    );

    await user.click(screen.getByText(/View installed access/));
    expect(screen.getByText("Frontend Design")).toBeTruthy();
    expect(screen.getByText("Personal install")).toBeTruthy();
    expect(screen.getByText("Claude, Codex")).toBeTruthy();
    expect(screen.getByText("Security Review")).toBeTruthy();
    expect(screen.getByText("Organization managed")).toBeTruthy();
    expect(screen.getByText("Removed from coding tools")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Open Lori" }).getAttribute("href"),
    ).toBe(
      "lori://connect?server=https%3A%2F%2Flori.example.com&protocol=1",
    );
    expect(screen.queryByText("https://lori.example.com")).toBeNull();
    expect(screen.queryByRole("button", { name: "Copy server URL" })).toBeNull();
  });

  it("explains when an older desktop has not reported inventory", () => {
    render(
      <DeviceManager
        initialDevices={[{ ...device, inventory: undefined }]}
        organizationWide
        publicUrl="https://lori.example.com"
      />,
    );
    expect(screen.getByText(/Inventory appears after the next desktop sync/)).toBeTruthy();
  });

  it("fails closed when the canonical organization origin is unavailable", () => {
    render(
      <DeviceManager
        initialDevices={[]}
        organizationWide={false}
        publicUrl=""
      />,
    );

    expect(screen.queryByRole("link", { name: /Open Lori/ })).toBeNull();
    expect(screen.getByText(/verify LORI_ADDRESS/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Copy server URL" })).toBeNull();
  });

  it("explains how to recover when Lori does not open", async () => {
    const user = userEvent.setup();
    render(
      <DeviceManager
        initialDevices={[device]}
        organizationWide={false}
        publicUrl="https://lori.example.com"
      />,
    );

    await user.click(screen.getByRole("link", { name: "Open Lori" }));
    expect(screen.getByText(/install or start Lori/i)).toBeTruthy();
    expect(
      screen.getByText(/new installation requires one browser approval/i),
    ).toBeTruthy();
  });

  it("routes a local Docker deployment to the running development app", async () => {
    const user = userEvent.setup();
    render(
      <DeviceManager
        initialDevices={[]}
        organizationWide={false}
        publicUrl="http://localhost:8180"
      />,
    );

    const links = screen.getAllByRole("link", { name: /Open Lori/i });
    expect(links[0]?.getAttribute("href")).toBe(
      "http://127.0.0.1:43891/connect?server=http%3A%2F%2Flocalhost%3A8180&protocol=1",
    );
    links[0]?.addEventListener("click", (event) => event.preventDefault());
    await user.click(links[0]!);
    expect(
      screen.getByRole("link", { name: "Open installed Lori" }).getAttribute("href"),
    ).toBe("lori://connect?server=http%3A%2F%2Flocalhost%3A8180&protocol=1");
  });

  it("keeps a device connected and exits confirmation when revocation fails", async () => {
    const user = userEvent.setup();
    clientApiMock.mockRejectedValueOnce(
      new MockClientApiError(
        "internal_error",
        "The server could not complete the request.",
        500,
      ),
    );
    render(
      <DeviceManager
        initialDevices={[device]}
        organizationWide
        publicUrl="https://lori.example.com"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Revoke access" }));
    await user.click(screen.getByRole("button", { name: "Confirm revoke" }));

    expect(
      await screen.findByText(/server could not revoke this device/i),
    ).toBeTruthy();
    expect(screen.getByText(/It remains connected/)).toBeTruthy();
    expect(screen.getByText("Connected")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Confirm revoke" }),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "Revoke access" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try refresh" })).toBeTruthy();
  });

  it("marks cached device status as stale when a background refresh fails", async () => {
    clientApiMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    render(
      <DeviceManager
        initialDevices={[device]}
        organizationWide={false}
        publicUrl="https://lori.example.com"
      />,
    );

    document.dispatchEvent(new Event("visibilitychange"));

    expect(
      await screen.findByText(/Live status is temporarily unavailable/),
    ).toBeTruthy();
    expect(screen.getByText("Connected")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    await waitFor(() => expect(clientApiMock).toHaveBeenCalledTimes(1));
  });

  it("offers sign-in recovery when the dashboard session expires", async () => {
    const user = userEvent.setup();
    clientApiMock.mockRejectedValueOnce(
      new MockClientApiError("unauthorized", "Authentication required.", 401),
    );
    render(
      <DeviceManager
        initialDevices={[device]}
        organizationWide={false}
        publicUrl="https://lori.example.com"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Refresh status" }));

    expect(await screen.findByText(/dashboard session expired/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Sign in" }).getAttribute("href"))
      .toBe("/sign-in");
    expect(screen.queryByRole("button", { name: "Try refresh" })).toBeNull();
  });
});
